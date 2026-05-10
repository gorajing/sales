import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as schema from '../../db/schema';

vi.mock('@/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schemaMod = await import('../../db/schema');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const _dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: schemaMod });
  migrate(db, { migrationsFolder: path.resolve(_dirname, '../../db/migrations') });
  return { db, schema: schemaMod };
});

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { newId } from '../../lib/id';
import { route } from '../../lib/routing/route';
import { RoutingRuleParseError } from '../../lib/routing/rules';

const RULES_MD = `
## RR1 — Hot enterprise
- priority: 10
- predicate: \`tier IN ['hot', 'on_fire'] AND firmographic_size == 'enterprise'\`
- owner_email: ae@x.com

## RR2 — Warm
- priority: 20
- predicate: \`tier == 'warm'\`
- owner_email: sdr@x.com
`;

describe('route', () => {
  let accountId: string;
  let scoreId: string;

  beforeEach(() => {
    db.delete(schema.routingAssignments).run();
    db.delete(schema.leadScores).run();
    db.delete(schema.accounts).run();
    accountId = newId('account');
    db.insert(schema.accounts).values({
      id: accountId, name: 'Acme', domain: 'acme.com', size: 'enterprise',
    }).run();
    scoreId = newId('leadScore');
    db.insert(schema.leadScores).values({
      id: scoreId, accountId, score: 70, tier: 'on_fire',
      fingerprint: 'fp_test_70', rationaleJson: [],
    }).run();
  });

  it('matches the highest-priority rule and writes assignment', async () => {
    const r = await route(accountId, scoreId, RULES_MD, 'fallback@x.com');
    expect(r.ownerEmail).toBe('ae@x.com');
    expect(r.reason).toBe('rule_match');
    expect(r.matchedRuleKey).toBe('RR1');

    const stored = db.select().from(schema.routingAssignments).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].matchedRuleKey).toBe('RR1');
    expect(stored[0].ownerEmail).toBe('ae@x.com');
    expect(stored[0].reason).toBe('rule_match');
    expect(stored[0].routingRulesHash).toBe(r.routingRulesHash);
  });

  it('falls through to default when no rule matches', async () => {
    db.delete(schema.leadScores).where(eq(schema.leadScores.id, scoreId)).run();
    const sid = newId('leadScore');
    db.insert(schema.leadScores).values({
      id: sid, accountId, score: 5, tier: 'cold',
      fingerprint: 'fp_cold', rationaleJson: [],
    }).run();
    const r = await route(accountId, sid, RULES_MD, 'fallback@x.com');
    expect(r.ownerEmail).toBe('fallback@x.com');
    expect(r.reason).toBe('fallback_default');
    expect(r.matchedRuleKey).toBeNull();
  });

  it('is idempotent on repeated route() for the same (scoreId, rulesHash)', async () => {
    const a = await route(accountId, scoreId, RULES_MD, 'fallback@x.com');
    const b = await route(accountId, scoreId, RULES_MD, 'fallback@x.com');
    expect(b.assignmentId).toBe(a.assignmentId);
    expect(b.ownerEmail).toBe(a.ownerEmail);
    expect(db.select().from(schema.routingAssignments).all()).toHaveLength(1);
  });

  it('rejects when score.accountId does not match the passed accountId', async () => {
    const otherId = newId('account');
    db.insert(schema.accounts).values({ id: otherId, name: 'Other' }).run();
    await expect(route(otherId, scoreId, RULES_MD, 'fallback@x.com')).rejects.toThrow(
      /belongs to account/,
    );
  });

  it('rejects when scoreId does not exist', async () => {
    await expect(
      route(accountId, 'ls_does_not_exist', RULES_MD, 'fallback@x.com'),
    ).rejects.toThrow(/leadScore not found/);
    expect(db.select().from(schema.routingAssignments).all()).toHaveLength(0);
  });

  it('creates a fresh assignment when routing rules change (different hash)', async () => {
    const a = await route(accountId, scoreId, RULES_MD, 'fallback@x.com');
    const edited = RULES_MD.replace('ae@x.com', 'senior-ae@x.com');
    const b = await route(accountId, scoreId, edited, 'fallback@x.com');
    expect(b.ownerEmail).toBe('senior-ae@x.com');
    expect(b.assignmentId).not.toBe(a.assignmentId);
    expect(b.routingRulesHash).not.toBe(a.routingRulesHash);
    expect(db.select().from(schema.routingAssignments).all()).toHaveLength(2);
  });

  it('does NOT create a new assignment when only whitespace/comments change', async () => {
    const a = await route(accountId, scoreId, RULES_MD, 'fallback@x.com');
    const cosmetic = `# Routing rules\n\nSome operator note added here.\n\n${RULES_MD.replace(/\n/g, '\n\n')}`;
    const b = await route(accountId, scoreId, cosmetic, 'fallback@x.com');
    expect(b.assignmentId).toBe(a.assignmentId);
    expect(b.routingRulesHash).toBe(a.routingRulesHash);
    expect(db.select().from(schema.routingAssignments).all()).toHaveLength(1);
  });

  it('tie-breaks equal-priority matches deterministically by numeric id ASC', async () => {
    // Two rules with the same priority, both matching on_fire.
    // The first listed in the file (in authoring order) is RR2; tie-break
    // must still pick RR1 because we sort by (priority, numericIdSuffix).
    const TIED_MD = `
## RR2 — Same priority B
- priority: 10
- predicate: \`tier == 'on_fire'\`
- owner_email: b@x.com

## RR1 — Same priority A
- priority: 10
- predicate: \`tier == 'on_fire'\`
- owner_email: a@x.com
`;
    const r = await route(accountId, scoreId, TIED_MD, 'fallback@x.com');
    expect(r.matchedRuleKey).toBe('RR1');
    expect(r.ownerEmail).toBe('a@x.com');
  });

  it('propagates RoutingRuleParseError without writing any assignment', async () => {
    const BROKEN_MD = `
## RR1 — typo
- priority: 10
- predicate: \`firmographic_sze == 'enterprise'\`
- owner_email: ae@x.com
`;
    await expect(route(accountId, scoreId, BROKEN_MD, 'fallback@x.com'))
      .rejects.toThrow(RoutingRuleParseError);
    expect(db.select().from(schema.routingAssignments).all()).toHaveLength(0);
  });

  it('rejects malformed default owner email up-front', async () => {
    await expect(
      route(accountId, scoreId, RULES_MD, 'not-an-email'),
    ).rejects.toThrow(/default.*owner.*email/i);
    expect(db.select().from(schema.routingAssignments).all()).toHaveLength(0);
  });

  it('normalizes default owner email (case + whitespace)', async () => {
    db.delete(schema.leadScores).where(eq(schema.leadScores.id, scoreId)).run();
    const sid = newId('leadScore');
    db.insert(schema.leadScores).values({
      id: sid, accountId, score: 5, tier: 'cold',
      fingerprint: 'fp_cold', rationaleJson: [],
    }).run();
    const r = await route(accountId, sid, RULES_MD, '  Triage@Example.COM  ');
    expect(r.ownerEmail).toBe('triage@example.com');
  });

  it('changing defaultOwnerEmail produces a fresh fallback assignment (NOT sticky to the old default)', async () => {
    // Cold-tier account: no rule matches RULES_MD (RR1 needs hot/on_fire,
    // RR2 needs warm). The first route() call falls through to fallback-a.
    // The second call with fallback-b MUST produce a new row whose owner is
    // fallback-b — otherwise a DEFAULT_OWNER_EMAIL change would silently
    // never propagate to existing cold-tier accounts.
    db.delete(schema.leadScores).where(eq(schema.leadScores.id, scoreId)).run();
    const sid = newId('leadScore');
    db.insert(schema.leadScores).values({
      id: sid, accountId, score: 5, tier: 'cold',
      fingerprint: 'fp_cold', rationaleJson: [],
    }).run();
    const a = await route(accountId, sid, RULES_MD, 'fallback-a@x.com');
    const b = await route(accountId, sid, RULES_MD, 'fallback-b@x.com');
    expect(a.ownerEmail).toBe('fallback-a@x.com');
    expect(b.ownerEmail).toBe('fallback-b@x.com');
    expect(b.assignmentId).not.toBe(a.assignmentId);
    expect(b.routingRulesHash).not.toBe(a.routingRulesHash);
    expect(db.select().from(schema.routingAssignments).all()).toHaveLength(2);
  });
});
