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

  it('enforces unique (accountId, fingerprint) on leadScores', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'X' }).run();
    db.insert(schema.leadScores).values({
      id: 'ls_1', accountId: 'acc_1', score: 10, tier: 'cold',
      fingerprint: 'fp_dup', rationaleJson: [],
    }).run();
    expect(() =>
      db.insert(schema.leadScores).values({
        id: 'ls_2', accountId: 'acc_1', score: 10, tier: 'cold',
        fingerprint: 'fp_dup', rationaleJson: [],
      }).run()
    ).toThrow();
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

  it('enforces partial unique on accounts.domain (case where set, multi-null OK)', () => {
    const { db } = freshDb();
    // Two NULL domains are fine.
    db.insert(schema.accounts).values({ id: 'acc_a', name: 'A' }).run();
    db.insert(schema.accounts).values({ id: 'acc_b', name: 'B' }).run();
    // First non-null domain inserts cleanly.
    db.insert(schema.accounts).values({ id: 'acc_c', name: 'C', domain: 'shared.example' }).run();
    // Duplicate non-null domain fails.
    expect(() =>
      db.insert(schema.accounts).values({
        id: 'acc_d', name: 'D', domain: 'shared.example',
      }).run()
    ).toThrow();
  });

  it('enforces partial unique on contacts.email (case where set, multi-null OK)', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'X' }).run();
    db.insert(schema.contacts).values({
      id: 'ct_a', accountId: 'acc_1', fullName: 'A',
    }).run();
    db.insert(schema.contacts).values({
      id: 'ct_b', accountId: 'acc_1', fullName: 'B',
    }).run();
    db.insert(schema.contacts).values({
      id: 'ct_c', accountId: 'acc_1', fullName: 'C', email: 'shared@example.com',
    }).run();
    expect(() =>
      db.insert(schema.contacts).values({
        id: 'ct_d', accountId: 'acc_1', fullName: 'D', email: 'shared@example.com',
      }).run()
    ).toThrow();
  });
});
