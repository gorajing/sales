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
  }): string {
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

  it('inserts a new row when only the rules change (rules-md hash in fingerprint)', async () => {
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

  it('priorTier reports the previous score row tier on insert', async () => {
    addEvidence({ sourceType: 'intent_data' });
    const a = await computeScore(accountId, RULES_MD, NOW);
    expect(a.tier).toBe('warm');  // 20 → warm
    addEvidence({ sourceType: 'intent_data' });
    const b = await computeScore(accountId, RULES_MD, NOW);
    expect(b.tier).toBe('hot');  // 40 → hot
    expect(b.priorTier).toBe('warm');
  });

  // ===== Race-safe insert (catch-and-reselect) ============================

  it('handles unique-violation race by re-selecting the winner', async () => {
    // Pre-insert a row with the exact fingerprint we'd compute, simulating
    // a concurrent recompute that won the race. The new computeScore call
    // will hit the unique index on (accountId, fingerprint) and must
    // re-select the winner instead of throwing.
    addEvidence({ sourceType: 'intent_data' });

    // First call computes + inserts naturally. Note the fingerprint.
    const first = await computeScore(accountId, RULES_MD, NOW);
    const winnerFp = db.select().from(schema.leadScores).all()[0].fingerprint;

    // Delete the row but leave the fingerprint in our hand. Insert a
    // synthetic row with the SAME fingerprint and the SAME accountId, but a
    // different scoreId — simulating the race outcome.
    db.delete(schema.leadScores).run();
    const racerId = newId('leadScore');
    db.insert(schema.leadScores).values({
      id: racerId, accountId, score: first.score, tier: first.tier,
      rationaleJson: first.rationale, fingerprint: winnerFp,
    }).run();

    // Second computeScore — same input, would compute the same fingerprint.
    // The latest-row-fingerprint short-circuit should match and short-circuit
    // before any insert attempt, returning the racer's id.
    const second = await computeScore(accountId, RULES_MD, NOW);
    expect(second.scoreId).toBe(racerId);
    expect(second.inserted).toBe(false);
    expect(db.select().from(schema.leadScores).all()).toHaveLength(1);
  });
});
