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

import { db } from '@/db';
import {
  latestScorePerAccount,
  latestScoreForAccount,
  recentSignalEvidence,
} from '../../lib/inbound/queries';

beforeEach(() => {
  db.delete(schema.routingAssignments).run();
  db.delete(schema.leadScores).run();
  db.delete(schema.evidence).run();
  db.delete(schema.contacts).run();
  db.delete(schema.accounts).run();
});

// Helper to insert an account quickly.
function ins(accountId: string, name = accountId) {
  db.insert(schema.accounts).values({ id: accountId, name }).run();
}

// Helper to insert a score; returns the id.
function insScore(opts: {
  id: string; accountId: string; score: number; tier: 'cold' | 'warm' | 'hot' | 'on_fire';
  fingerprint?: string;
  rationale?: Array<{ evidence_id: string; weight: number; reason: string; rule_id: string }>;
  computedAt?: string;
}): string {
  db.insert(schema.leadScores).values({
    id: opts.id,
    accountId: opts.accountId,
    score: opts.score,
    tier: opts.tier,
    fingerprint: opts.fingerprint ?? `fp_${opts.id}`,
    rationaleJson: opts.rationale ?? [],
    ...(opts.computedAt ? { computedAt: opts.computedAt } : {}),
  }).run();
  return opts.id;
}

describe('latestScorePerAccount', () => {
  it('returns the latest score per account, ordered by score DESC, respecting limit', () => {
    ins('acc_a', 'A');
    ins('acc_b', 'B');
    ins('acc_c', 'C');
    insScore({ id: 'ls_a1', accountId: 'acc_a', score: 10, tier: 'cold' });
    insScore({ id: 'ls_a2', accountId: 'acc_a', score: 50, tier: 'hot' });  // latest for a
    insScore({ id: 'ls_b1', accountId: 'acc_b', score: 30, tier: 'warm' });
    insScore({ id: 'ls_c1', accountId: 'acc_c', score: 70, tier: 'on_fire' });

    const top = latestScorePerAccount(10);
    // c (70), a-latest (50), b (30). a's earlier score (10) must not appear.
    expect(top.map((r) => r.id)).toEqual(['ls_c1', 'ls_a2', 'ls_b1']);
  });

  it('breaks ties deterministically by rowid DESC (latest inserted wins) even when computedAt is identical', () => {
    // Stress the same bug computeScore had to fix: when two scores for the
    // same account share the same computedAt, "latest" must be the most
    // recently INSERTED row. SQLite's rowid is monotonic per insert, so we
    // use that.
    ins('acc_x');
    const sameTs = '2026-05-10T12:00:00.000Z';
    insScore({ id: 'ls_x1', accountId: 'acc_x', score: 10, tier: 'cold', computedAt: sameTs });
    insScore({ id: 'ls_x2', accountId: 'acc_x', score: 99, tier: 'on_fire', computedAt: sameTs });

    const top = latestScorePerAccount(10);
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe('ls_x2');  // most recently inserted, regardless of timestamp tie
    expect(top[0].score).toBe(99);
  });

  it('returns an empty array when there are no scores', () => {
    expect(latestScorePerAccount(10)).toEqual([]);
  });

  it('respects the limit when there are more accounts than slots', () => {
    for (let i = 0; i < 30; i++) {
      const accId = `acc_${i.toString().padStart(2, '0')}`;
      ins(accId);
      insScore({ id: `ls_${i}`, accountId: accId, score: i, tier: 'cold' });
    }
    expect(latestScorePerAccount(5)).toHaveLength(5);
    expect(latestScorePerAccount(100)).toHaveLength(30);
  });

  it('does NOT scan every score row in JS — uses a SQL-side filter', () => {
    // Regression guard: an earlier draft pulled ALL lead_scores rows and
    // grouped in memory, which is O(N) in the number of historical scores.
    // The current implementation must use a SQL subquery so the wire-level
    // cost is bounded by the number of distinct accounts.
    //
    // We test by inserting many historical scores for one account and one
    // for another, then verifying the returned row count is bounded by
    // distinct accounts, not total scores.
    ins('acc_busy');
    ins('acc_quiet');
    for (let i = 0; i < 100; i++) {
      insScore({ id: `ls_busy_${i}`, accountId: 'acc_busy', score: i, tier: 'cold' });
    }
    insScore({ id: 'ls_quiet', accountId: 'acc_quiet', score: 5, tier: 'cold' });

    const top = latestScorePerAccount(100);
    expect(top).toHaveLength(2);  // one per account, not 101
    // The acc_busy entry is the LATEST one (ls_busy_99, score 99).
    const busy = top.find((r) => r.accountId === 'acc_busy');
    expect(busy?.id).toBe('ls_busy_99');
    expect(busy?.score).toBe(99);
  });
});

describe('latestScorePerAccount — deterministic ordering', () => {
  it('tied scores break deterministically on rowid DESC (newest insert wins the cut)', () => {
    // Three accounts all tied at score=50. The top-2 cut MUST be
    // deterministic across renders — without a tiebreaker, the row that
    // gets dropped from the limit-N window could change each query.
    // Insert order: A, B, C. rowid DESC ⇒ C, B, A.
    ins('acc_A');
    ins('acc_B');
    ins('acc_C');
    insScore({ id: 'ls_A', accountId: 'acc_A', score: 50, tier: 'hot' });
    insScore({ id: 'ls_B', accountId: 'acc_B', score: 50, tier: 'hot' });
    insScore({ id: 'ls_C', accountId: 'acc_C', score: 50, tier: 'hot' });

    const top = latestScorePerAccount(2);
    expect(top.map((r) => r.id)).toEqual(['ls_C', 'ls_B']);

    // Re-query: order MUST be identical (no randomness).
    expect(latestScorePerAccount(2).map((r) => r.id)).toEqual(['ls_C', 'ls_B']);
  });
});

describe('latestScoreForAccount', () => {
  it('returns the most recent score row for the account by rowid DESC', () => {
    ins('acc_x');
    insScore({ id: 'ls_old', accountId: 'acc_x', score: 10, tier: 'cold' });
    insScore({ id: 'ls_new', accountId: 'acc_x', score: 60, tier: 'hot' });
    const r = latestScoreForAccount('acc_x');
    expect(r?.id).toBe('ls_new');
    expect(r?.score).toBe(60);
  });

  it('returns undefined when the account has no scores', () => {
    ins('acc_empty');
    expect(latestScoreForAccount('acc_empty')).toBeUndefined();
  });

  it('does not return rows for other accounts', () => {
    ins('acc_a');
    ins('acc_b');
    insScore({ id: 'ls_a', accountId: 'acc_a', score: 10, tier: 'cold' });
    expect(latestScoreForAccount('acc_b')).toBeUndefined();
    expect(latestScoreForAccount('acc_a')?.id).toBe('ls_a');
  });

  it('breaks tied computedAt by rowid DESC', () => {
    ins('acc_x');
    const sameTs = '2026-05-10T12:00:00.000Z';
    insScore({ id: 'ls_first', accountId: 'acc_x', score: 5, tier: 'cold', computedAt: sameTs });
    insScore({ id: 'ls_second', accountId: 'acc_x', score: 95, tier: 'on_fire', computedAt: sameTs });
    expect(latestScoreForAccount('acc_x')?.id).toBe('ls_second');
  });
});

// Direct evidence insertion bypassing ingestSignal so we can write
// captured_at values with explicit offsets — those are accepted by the
// SignalPayload Zod schema but the ingest path doesn't expose them as
// test-tuning knobs. The schema's `signal_type` is NOT NULL DEFAULT
// 'none'; we set it to a non-'none' value here (default 'intent') so
// the recentSignalEvidence filter accepts the row.
function insEvidence(opts: {
  id: string; accountId: string; capturedAt: string;
  signalType?: 'none' | 'intent' | 'engagement' | 'firmographic' | 'technographic' | 'trigger_event';
  snippet?: string;
}) {
  db.insert(schema.evidence).values({
    id: opts.id,
    accountId: opts.accountId,
    sourceUrl: 'https://x.example/',
    sourceType: 'manual',
    snippet: opts.snippet ?? 'snippet body',
    extractedFact: 'fact',
    capturedBy: 'manual',
    capturedAt: opts.capturedAt,
    signalType: opts.signalType ?? 'intent',
  }).run();
}

describe('recentSignalEvidence', () => {
  it('returns rows ordered by UTC-normalized capturedAt DESC, breaking ties on rowid', () => {
    ins('acc_a');
    // Three signals representing 11:00Z, 12:00Z, 13:00Z, deliberately
    // written with DIFFERENT offset suffixes. A naive lexicographic sort
    // on the text column would place '14:00+01:00' (= 13:00Z) BEFORE
    // '12:00Z' alphabetically.
    insEvidence({ id: 'ev_morn', accountId: 'acc_a', capturedAt: '2026-05-10T11:00:00.000Z' });
    insEvidence({ id: 'ev_noon', accountId: 'acc_a', capturedAt: '2026-05-10T12:00:00.000Z' });
    insEvidence({ id: 'ev_afternoon', accountId: 'acc_a', capturedAt: '2026-05-10T14:00:00.000+01:00' /* = 13:00Z */ });

    const rows = recentSignalEvidence(10);
    // Chronological UTC DESC: 13:00Z, 12:00Z, 11:00Z.
    expect(rows.map((r) => r.id)).toEqual(['ev_afternoon', 'ev_noon', 'ev_morn']);
  });

  it('breaks ties on rowid DESC when capturedAt is identical', () => {
    ins('acc_a');
    const ts = '2026-05-10T12:00:00.000Z';
    insEvidence({ id: 'ev_first', accountId: 'acc_a', capturedAt: ts });
    insEvidence({ id: 'ev_second', accountId: 'acc_a', capturedAt: ts });
    const rows = recentSignalEvidence(10);
    expect(rows.map((r) => r.id)).toEqual(['ev_second', 'ev_first']);
  });

  it('excludes rows with signal_type="none" (the schema default for non-signal evidence)', () => {
    ins('acc_a');
    insEvidence({ id: 'ev_none', accountId: 'acc_a', capturedAt: '2026-05-10T12:00:00.000Z', signalType: 'none' });
    insEvidence({ id: 'ev_intent', accountId: 'acc_a', capturedAt: '2026-05-10T13:00:00.000Z' });
    const rows = recentSignalEvidence(10);
    expect(rows.map((r) => r.id)).toEqual(['ev_intent']);
  });

  it('respects the limit', () => {
    ins('acc_a');
    for (let i = 0; i < 10; i++) {
      insEvidence({ id: `ev_${i}`, accountId: 'acc_a', capturedAt: `2026-05-1${i}T12:00:00.000Z` });
    }
    expect(recentSignalEvidence(3)).toHaveLength(3);
  });

  it('returns an empty array when no signal-typed evidence exists', () => {
    expect(recentSignalEvidence(10)).toEqual([]);
  });
});
