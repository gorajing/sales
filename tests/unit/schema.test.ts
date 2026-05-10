import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

function freshDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(dirname, '../../db/migrations') });
  return { db, sqlite };
}

describe('schema', () => {
  it('creates and queries an account', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
    const rows = db.select().from(schema.accounts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Acme');
  });

  it('defaults contact.archetype to unknown', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
    db.insert(schema.contacts).values({
      id: 'ct_1', accountId: 'acc_1', fullName: 'Jane',
    }).run();
    const row = db.select().from(schema.contacts).all()[0];
    expect(row.archetype).toBe('unknown');
  });

  it('enforces FK from evidence to account', () => {
    const { db } = freshDb();
    expect(() =>
      db.insert(schema.evidence).values({
        id: 'ev_1', accountId: 'acc_missing',
        sourceUrl: 'https://x', sourceType: 'manual',
        snippet: 's', extractedFact: 'f', capturedBy: 'manual',
      }).run()
    ).toThrow();
  });
});

describe('schema v2 (signals/scoring/routing)', () => {
  it('extends evidence with signalType and dedupeKey', () => {
    const cols = Object.keys(schema.evidence);
    expect(cols).toContain('signalType');
    expect(cols).toContain('dedupeKey');
  });

  it('exports leadScores with fingerprint for idempotent recompute', () => {
    expect(schema.leadScores).toBeDefined();
    const cols = Object.keys(schema.leadScores);
    for (const c of ['id', 'accountId', 'score', 'tier', 'rationaleJson',
                     'fingerprint', 'computedAt', 'expiresAt']) {
      expect(cols).toContain(c);
    }
  });

  it('exports routingAssignments with matchedRuleKey (not FK) and routingRulesHash', () => {
    expect(schema.routingAssignments).toBeDefined();
    const cols = Object.keys(schema.routingAssignments);
    expect(cols).toContain('matchedRuleKey');
    expect(cols).toContain('routingRulesHash');
    expect(cols).not.toContain('ruleId');
  });

  it('rejects routing_assignments with NULL scoreId at the column level', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'X' }).run();
    expect(() =>
      db.insert(schema.routingAssignments).values({
        id: 'ra_null', accountId: 'acc_1', ownerEmail: 'x@x.com',
        reason: 'manual_override', routingRulesHash: 'rh_x',
        scoreId: null as any,
      }).run()
    ).toThrow();
  });

  it('exports alerts with cooldownKey for dedupe', () => {
    expect(schema.alerts).toBeDefined();
    const cols = Object.keys(schema.alerts);
    expect(cols).toContain('cooldownKey');
  });

  it('migration applies cleanly and the new tables are queryable', () => {
    const { db } = freshDb();
    // Insert a parent account so FK constraints are satisfied.
    db.insert(schema.accounts).values({
      id: 'acc_1', name: 'Acme', domain: 'acme.example',
    }).run();
    // Smoke: insert one row into each new table; anything malformed throws.
    db.insert(schema.leadScores).values({
      id: 'ls_1', accountId: 'acc_1', score: 42, tier: 'warm',
      fingerprint: 'fp_test', rationaleJson: [],
    }).run();
    db.insert(schema.routingAssignments).values({
      id: 'ra_1', accountId: 'acc_1', ownerEmail: 'sdr@example.com',
      reason: 'fallback_default', routingRulesHash: 'rh_test', scoreId: 'ls_1',
    }).run();
    db.insert(schema.alerts).values({
      id: 'al_1', accountId: 'acc_1', trigger: 'manual', severity: 'info',
      payloadJson: {}, channelsSentJson: [], cooldownKey: 'k_test',
    }).run();
    expect(db.select().from(schema.leadScores).all()).toHaveLength(1);
    expect(db.select().from(schema.routingAssignments).all()).toHaveLength(1);
    expect(db.select().from(schema.alerts).all()).toHaveLength(1);
  });

  it('allows duplicate (accountId, fingerprint) on leadScores (state recurrence)', () => {
    // The earlier UNIQUE (accountId, fingerprint) index was dropped in
    // migration 0006 because it blocked legitimate state recurrence
    // (cold → warm → cold returning to cold should NOT collide with the
    // initial cold row). Now it's a non-unique index for query speed only.
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'X' }).run();
    db.insert(schema.leadScores).values({
      id: 'ls_1', accountId: 'acc_1', score: 10, tier: 'cold',
      fingerprint: 'fp_dup', rationaleJson: [],
    }).run();
    // Same (accountId, fingerprint) on a second row succeeds.
    db.insert(schema.leadScores).values({
      id: 'ls_2', accountId: 'acc_1', score: 10, tier: 'cold',
      fingerprint: 'fp_dup', rationaleJson: [],
    }).run();
    expect(db.select().from(schema.leadScores).all()).toHaveLength(2);
  });

  it('enforces unique (accountId, scoreId, routingRulesHash) on routingAssignments', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'X' }).run();
    db.insert(schema.leadScores).values({
      id: 'ls_1', accountId: 'acc_1', score: 10, tier: 'cold',
      fingerprint: 'fp_a', rationaleJson: [],
    }).run();
    db.insert(schema.routingAssignments).values({
      id: 'ra_1', accountId: 'acc_1', ownerEmail: 'a@x.com',
      reason: 'rule_match', matchedRuleKey: 'RR1',
      routingRulesHash: 'rh_a', scoreId: 'ls_1',
    }).run();
    expect(() =>
      db.insert(schema.routingAssignments).values({
        id: 'ra_2', accountId: 'acc_1', ownerEmail: 'b@x.com',
        reason: 'rule_match', matchedRuleKey: 'RR1',
        routingRulesHash: 'rh_a', scoreId: 'ls_1',
      }).run()
    ).toThrow();
  });

  it('enforces unique cooldownKey on alerts', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'X' }).run();
    db.insert(schema.alerts).values({
      id: 'al_1', accountId: 'acc_1', trigger: 'manual', severity: 'info',
      payloadJson: {}, channelsSentJson: [], cooldownKey: 'k_dup',
    }).run();
    expect(() =>
      db.insert(schema.alerts).values({
        id: 'al_2', accountId: 'acc_1', trigger: 'manual', severity: 'info',
        payloadJson: {}, channelsSentJson: [], cooldownKey: 'k_dup',
      }).run()
    ).toThrow();
  });

  it('enforces unique evidence.dedupeKey when set', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'X' }).run();
    db.insert(schema.evidence).values({
      id: 'ev_1', accountId: 'acc_1',
      sourceUrl: 'https://x', sourceType: 'manual',
      snippet: 's', extractedFact: 'f', capturedBy: 'manual',
      dedupeKey: 'dk_1',
    }).run();
    expect(() =>
      db.insert(schema.evidence).values({
        id: 'ev_2', accountId: 'acc_1',
        sourceUrl: 'https://x', sourceType: 'manual',
        snippet: 's', extractedFact: 'f', capturedBy: 'manual',
        dedupeKey: 'dk_1',
      }).run()
    ).toThrow();
  });

  it('enforces partial unique on accounts.domain — NULLs and empty strings allowed; case-insensitive', () => {
    const { db } = freshDb();
    // Two NULL domains are fine.
    db.insert(schema.accounts).values({ id: 'acc_a', name: 'A' }).run();
    db.insert(schema.accounts).values({ id: 'acc_b', name: 'B' }).run();
    // Two empty-string domains are fine (excluded from the partial index).
    db.insert(schema.accounts).values({ id: 'acc_e1', name: 'E1', domain: '' }).run();
    db.insert(schema.accounts).values({ id: 'acc_e2', name: 'E2', domain: '' }).run();
    // First non-null domain inserts cleanly.
    db.insert(schema.accounts).values({ id: 'acc_c', name: 'C', domain: 'shared.example' }).run();
    // Same domain different case — must collide via lower().
    expect(() =>
      db.insert(schema.accounts).values({
        id: 'acc_d', name: 'D', domain: 'SHARED.example',
      }).run()
    ).toThrow();
    expect(() =>
      db.insert(schema.accounts).values({
        id: 'acc_d2', name: 'D2', domain: 'shared.example',
      }).run()
    ).toThrow();
  });

  it('enforces partial unique on contacts.email — NULLs and empty allowed; case-insensitive', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'X' }).run();
    db.insert(schema.contacts).values({ id: 'ct_a', accountId: 'acc_1', fullName: 'A' }).run();
    db.insert(schema.contacts).values({ id: 'ct_b', accountId: 'acc_1', fullName: 'B' }).run();
    db.insert(schema.contacts).values({
      id: 'ct_e1', accountId: 'acc_1', fullName: 'E1', email: '',
    }).run();
    db.insert(schema.contacts).values({
      id: 'ct_e2', accountId: 'acc_1', fullName: 'E2', email: '',
    }).run();
    db.insert(schema.contacts).values({
      id: 'ct_c', accountId: 'acc_1', fullName: 'C', email: 'shared@example.com',
    }).run();
    expect(() =>
      db.insert(schema.contacts).values({
        id: 'ct_d', accountId: 'acc_1', fullName: 'D', email: 'Shared@Example.COM',
      }).run()
    ).toThrow();
  });
});
