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
import { computeScore } from '../../lib/scoring/score';

const RULES_MD = `
## R1 — Intent
- predicate: \`source_type == 'intent_data'\`
- weight: 20
- window_days: 7

## R2 — Pricing
- predicate: \`source_type == 'web_traffic' AND snippet CONTAINS '/pricing'\`
- weight: 15
- window_days: 3

## Tier thresholds

- cold: 0–14
- warm: 15–34
- hot: 35–59
- on_fire: 60+
`;

describe('computeScore', () => {
  let accountId: string;
  const NOW = new Date('2026-05-06T12:00:00.000Z');

  beforeEach(() => {
    db.delete(schema.leadScores).run();
    db.delete(schema.evidence).run();
    db.delete(schema.contacts).run();
    db.delete(schema.accounts).run();
    accountId = newId('account');
    db.insert(schema.accounts).values({
      id: accountId, name: 'Acme', domain: 'acme.com',
    }).run();
  });

  function addEvidence(opts: {
    sourceType?: string;
    signalType?: string;
    snippet?: string;
    capturedAt?: string;
    extractionStatus?: 'pending_audit' | 'verified' | 'disputed';
  } = {}): string {
    const id = newId('evidence');
    db.insert(schema.evidence).values({
      id,
      accountId,
      sourceUrl: 'https://x.example',
      sourceType: (opts.sourceType ?? 'manual') as any,
      signalType: (opts.signalType ?? 'none') as any,
      snippet: opts.snippet ?? 'x',
      extractedFact: 'y',
      extractionStatus: opts.extractionStatus ?? 'verified',
      capturedAt: opts.capturedAt ?? NOW.toISOString(),
      capturedBy: 'webhook',
    }).run();
    return id;
  }

  // ===== Basic happy path =================================================

  it('returns 0 / cold for an account with no signals', async () => {
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(0);
    expect(r.tier).toBe('cold');
    expect(r.rationale).toEqual([]);
    expect(r.priorTier).toBeUndefined();
    expect(r.inserted).toBe(true);  // even a 0/cold result writes the first row
  });

  it('sums matching rules at full weight at t=0', async () => {
    addEvidence({ sourceType: 'intent_data' });
    addEvidence({ sourceType: 'web_traffic', snippet: '/pricing visit' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(35);
    expect(r.tier).toBe('hot');
    expect(r.rationale).toHaveLength(2);
  });

  // ===== Verified-only filter (security) ==================================

  it('skips disputed evidence', async () => {
    addEvidence({ sourceType: 'intent_data', extractionStatus: 'disputed' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(0);
  });

  it('skips pending_audit evidence (only verified contributes)', async () => {
    // Use a source that DOES match R1 — only the pending_audit status should
    // exclude it. Otherwise the test would pass for the wrong reason (no rule
    // matched social_post anyway).
    addEvidence({ sourceType: 'intent_data', extractionStatus: 'pending_audit' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(0);
    expect(r.rationale).toEqual([]);
  });

  // ===== Decay integration ================================================

  it('decays old signals (4d-old web_traffic past R2 3d window → 0)', async () => {
    addEvidence({
      sourceType: 'web_traffic', snippet: '/pricing',
      capturedAt: '2026-05-02T12:00:00.000Z',  // 4 days before NOW
    });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(0);
  });

  it('rationale weight reflects the decayed (fractional) value, not the base rule weight', async () => {
    // 3.5 days old → R1 (7-day window) decays to half weight: 20 * 0.5 = 10.
    // This locks the integration with lib/scoring/decay.ts's fractional return.
    // If decay regressed to integer rounding, this would catch it.
    addEvidence({
      sourceType: 'intent_data',
      capturedAt: '2026-05-03T00:00:00.000Z',  // 3.5 days before NOW
    });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.rationale[0].weight).toBeCloseTo(10, 3);
    // Final score is rounded for storage (integer column). Half-window of 20 = 10 exactly.
    expect(r.score).toBe(10);
  });

  it('rounds the final score for integer storage when sum is fractional', async () => {
    // 75% through R2's 3-day window: 15 * 0.25 = 3.75. Math.round → 4.
    addEvidence({
      sourceType: 'web_traffic', snippet: '/pricing',
      capturedAt: new Date(NOW.getTime() - 0.75 * 3 * 24 * 3600 * 1000).toISOString(),
    });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(4);
    expect(r.rationale[0].weight).toBeCloseTo(3.75, 3);
  });

  // ===== Multi-match scenarios ===========================================

  it('one evidence row matching multiple rules produces multiple rationale entries', async () => {
    // Custom rules: R1 matches intent_data, R2 also matches intent_data.
    const rulesBoth = `
## R1 — A
- predicate: \`source_type == 'intent_data'\`
- weight: 10
- window_days: 7

## R2 — B
- predicate: \`signal_type == 'intent'\`
- weight: 5
- window_days: 7

## Tier thresholds
- cold: 0–14
- warm: 15–34
- hot: 35–59
- on_fire: 60+
`;
    addEvidence({ sourceType: 'intent_data', signalType: 'intent' });
    const r = await computeScore(accountId, rulesBoth, NOW);
    expect(r.rationale).toHaveLength(2);
    expect(r.score).toBe(15);
  });

  it('one rule matched by multiple evidence rows produces multiple rationale entries', async () => {
    addEvidence({ sourceType: 'intent_data' });
    addEvidence({ sourceType: 'intent_data' });
    addEvidence({ sourceType: 'intent_data' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.rationale).toHaveLength(3);
    expect(r.score).toBe(60);  // 3 × 20
  });

  // ===== Score clamping ==================================================

  it('clamps score to 100 when sum exceeds maximum', async () => {
    for (let i = 0; i < 10; i++) addEvidence({ sourceType: 'intent_data' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(100);  // 10 × 20 = 200, clamped to 100
  });

  it('does not floor at 0 — penalty rules can produce negative score', async () => {
    // Rule with negative weight. Single evidence at full weight = -10.
    const penaltyRules = `
## R1 — Stale signal penalty
- predicate: \`source_type == 'intent_data'\`
- weight: -10
- window_days: 7

## Tier thresholds
- cold: 0–14
- warm: 15–34
- hot: 35–59
- on_fire: 60+
`;
    addEvidence({ sourceType: 'intent_data' });
    const r = await computeScore(accountId, penaltyRules, NOW);
    expect(r.score).toBe(-10);
    expect(r.tier).toBe('cold');  // negatives map to cold
  });

  // ===== Persistence + idempotency =======================================

  it('writes a leadScores row with rationale citing evidence ids', async () => {
    addEvidence({ sourceType: 'intent_data' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    const stored = db.select().from(schema.leadScores).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].score).toBe(r.score);
    expect(stored[0].rationaleJson[0].evidence_id).toMatch(/^ev_/);
    expect(stored[0].rationaleJson[0].rule_id).toBe('R1');
    expect(r.inserted).toBe(true);
    expect(r.priorTier).toBeUndefined();
  });

  it('stores fingerprint on the row (used by unique index for idempotency)', async () => {
    addEvidence({ sourceType: 'intent_data' });
    await computeScore(accountId, RULES_MD, NOW);
    const stored = db.select().from(schema.leadScores).all()[0];
    expect(stored.fingerprint).toBeTruthy();
    expect(typeof stored.fingerprint).toBe('string');
  });

  it('is idempotent — same evidence + rules → no new row', async () => {
    addEvidence({ sourceType: 'intent_data' });
    const a = await computeScore(accountId, RULES_MD, NOW);
    const b = await computeScore(accountId, RULES_MD, NOW);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.scoreId).toBe(a.scoreId);
    expect(db.select().from(schema.leadScores).all()).toHaveLength(1);
  });

  it('inserts a new row when the rationale changes', async () => {
    addEvidence({ sourceType: 'intent_data' });
    const a = await computeScore(accountId, RULES_MD, NOW);
    addEvidence({ sourceType: 'web_traffic', snippet: '/pricing' });
    const b = await computeScore(accountId, RULES_MD, NOW);
    expect(b.inserted).toBe(true);
    expect(b.scoreId).not.toBe(a.scoreId);
    expect(b.priorTier).toBe(a.tier);
    expect(db.select().from(schema.leadScores).all()).toHaveLength(2);
  });

  it('inserts a new row when only the rules change (parsed-rules hash in fingerprint)', async () => {
    // Same evidence, same NOW — but a threshold tweak in the rules markdown
    // should still invalidate the fingerprint (so downstream tier-promotion
    // alerts can fire when an operator edits thresholds).
    addEvidence({ sourceType: 'intent_data' });
    const a = await computeScore(accountId, RULES_MD, NOW);
    const tweaked = RULES_MD.replace('cold: 0–14', 'cold: 0–10').replace('warm: 15–34', 'warm: 11–34');
    const b = await computeScore(accountId, tweaked, NOW);
    expect(b.inserted).toBe(true);
    expect(b.scoreId).not.toBe(a.scoreId);
  });

  it('does NOT invalidate fingerprint on comment-only or whitespace-only edits to the rules file', async () => {
    // The fingerprint hashes the PARSED rules + thresholds, not the raw
    // markdown. So editing comments or formatting (which don't affect rule
    // semantics) shouldn't churn every account's score row. Critical for
    // operators iterating on the rules file.
    addEvidence({ sourceType: 'intent_data' });
    const a = await computeScore(accountId, RULES_MD, NOW);
    const cosmetic = `# Scoring rules\n\nFootnote comment here.\n\n` + RULES_MD;
    const b = await computeScore(accountId, cosmetic, NOW);
    expect(b.inserted).toBe(false);
    expect(b.scoreId).toBe(a.scoreId);
  });

  it('dedupes across calls with different `now` (within-window time-of-day stability)', async () => {
    // The whole reason fingerprint hashes pair-set + rounded score (NOT
    // raw decayed weights): two recomputes seconds apart with the same
    // evidence-vs-rule matches must dedupe. Without this fix, every
    // recompute with default `now` would write a fresh row.
    addEvidence({ sourceType: 'intent_data' });
    const a = await computeScore(accountId, RULES_MD, NOW);
    // Recompute 5 seconds later — still well within R1's 7-day window,
    // weight is fractionally different but rounded score is the same.
    const slightlyLater = new Date(NOW.getTime() + 5000);
    const b = await computeScore(accountId, RULES_MD, slightlyLater);
    expect(b.inserted).toBe(false);
    expect(b.scoreId).toBe(a.scoreId);
  });

  it('priorTier reports the previous score row tier on insert', async () => {
    addEvidence({ sourceType: 'intent_data' });
    const a = await computeScore(accountId, RULES_MD, NOW);
    expect(a.tier).toBe('warm');  // 20 → warm
    addEvidence({ sourceType: 'intent_data' });
    const b = await computeScore(accountId, RULES_MD, NOW);
    expect(b.tier).toBe('hot');  // 40 → hot
    expect(b.priorTier).toBe('warm');
  });

  // ===== Idempotency + dedupe ============================================

  it('SELECT-hit dedupe returns the matched scoreId without inserting', async () => {
    // The latest-fingerprint-match short-circuit. With single-process
    // SQLite and synchronous transactions, this is the only dedupe path —
    // the prior unique-index catch-and-reselect was removed because it
    // blocked legitimate state recurrence (see test below).
    addEvidence({ sourceType: 'intent_data' });
    const first = await computeScore(accountId, RULES_MD, NOW);
    const second = await computeScore(accountId, RULES_MD, NOW);
    expect(second.scoreId).toBe(first.scoreId);
    expect(second.inserted).toBe(false);
    expect(second.priorTier).toBe(first.tier);
    expect(db.select().from(schema.leadScores).all()).toHaveLength(1);
  });

  it('state recurrence: cold → warm → cold inserts THREE rows even though fingerprints recur', async () => {
    // Regression test for codex-flagged bug: when (accountId, fingerprint)
    // had a unique index, an account that returned to a prior state (e.g.
    // signal decayed back to 0/cold after a warm peak) would silently
    // collide with the older row instead of writing a new one. Now the
    // index is non-unique; recurrence works correctly.

    // (1) Genesis cold (no signals)
    const a = await computeScore(accountId, RULES_MD, NOW);
    expect(a.tier).toBe('cold');

    // (2) Add a signal → warm
    const evId = addEvidence({ sourceType: 'intent_data' });
    const b = await computeScore(accountId, RULES_MD, NOW);
    expect(b.tier).toBe('warm');
    expect(b.scoreId).not.toBe(a.scoreId);

    // (3) Remove the signal (simulates audit critic disputing it, or
    // operator deletion) → back to cold. Same fingerprint as step 1, but
    // logically a new transition warm → cold.
    db.delete(schema.evidence)
      .where(eq(schema.evidence.id, evId)).run();
    const c = await computeScore(accountId, RULES_MD, NOW);
    expect(c.tier).toBe('cold');
    expect(c.scoreId).not.toBe(a.scoreId);  // NOT collapsed onto the older cold
    expect(c.scoreId).not.toBe(b.scoreId);
    expect(c.priorTier).toBe('warm');  // came from warm
    expect(db.select().from(schema.leadScores).all()).toHaveLength(3);
  });

  it('on dedupe, returns the STORED rationale (not a freshly-computed one with different weights)', async () => {
    // After fingerprint stopped including raw weights, a same-state recompute
    // at a different `now` would have the same fingerprint but different
    // per-rule decay weights. Result must reflect the persisted row.
    addEvidence({ sourceType: 'intent_data' });
    const first = await computeScore(accountId, RULES_MD, NOW);
    const storedWeight = first.rationale[0].weight;

    // Recompute 2 hours later — still in window; weight is fractionally
    // different but the rounded score is the same → fingerprint matches.
    const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    const second = await computeScore(accountId, RULES_MD, later);
    expect(second.inserted).toBe(false);
    // The returned rationale weight matches the STORED weight (from the
    // first call), not what we'd compute fresh at `later`.
    expect(second.rationale[0].weight).toBe(storedWeight);
  });

  it('orders latest by SQLite rowid DESC (monotonic insert order, immune to id/computedAt collisions)', async () => {
    // Earlier draft used (computedAt DESC, id DESC) as the tie-breaker, but
    // both can collide: tests inject the same `now`, and our text-prefixed
    // ids are random-hex-suffixed so lex-order is non-monotonic vs insert
    // order. Switched to ORDER BY rowid DESC, which SQLite guarantees is
    // monotonically increasing per insert.
    const t = '2026-05-06T12:00:00.000Z';
    // Insert ls_zzzz FIRST (lex-greater id) and ls_aaaa SECOND (lex-smaller).
    // With (id DESC) tie-break the "latest" would be ls_zzzz; with (rowid
    // DESC) it's ls_aaaa (the actually-newer row).
    db.insert(schema.leadScores).values({
      id: 'ls_zzzz_first', accountId, score: 99, tier: 'on_fire',
      fingerprint: 'fp_z', rationaleJson: [],
      computedAt: t,
    }).run();
    db.insert(schema.leadScores).values({
      id: 'ls_aaaa_second', accountId, score: 5, tier: 'cold',
      fingerprint: 'fp_a', rationaleJson: [],
      computedAt: t,
    }).run();

    addEvidence({ sourceType: 'intent_data' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    // priorTier should be 'cold' (tier of ls_aaaa_second, the actually-
    // most-recently-inserted row), NOT 'on_fire' (tier of ls_zzzz_first
    // which would be picked by id-DESC tie-break).
    expect(r.priorTier).toBe('cold');
  });
});
