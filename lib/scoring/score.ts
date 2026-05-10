import { createHash } from 'node:crypto';
import { db, schema } from '@/db';
import { eq, and, desc } from 'drizzle-orm';
import { newId } from '../id';
import { parseScoringRules, evalPredicate, scoreToTier, type Tier } from './rules';
import { linearDecayWeight } from './decay';

/**
 * Per-rule contribution to a score, retained alongside the score row so
 * operators can answer "why is this account a 60?" without re-running the
 * scoring pass.
 *
 * `weight` is the decayed contribution at the time of compute — fractional,
 * not pre-rounded. The final score sum IS rounded for integer storage, but
 * the per-rule values stay as floats so:
 *   - the rounded score equals the rounded sum of fractional weights, AND
 *   - the rationale is faithful to the math (no per-rule rounding bias).
 */
export interface ScoreRationaleItem {
  evidence_id: string;
  rule_id: string;
  weight: number;
  reason: string;
}

export interface ScoreResult {
  scoreId: string;
  accountId: string;
  /** Final clamped + rounded integer score. */
  score: number;
  tier: Tier;
  /** Tier of the previous (if any) latest score — used downstream for promotion alerts. */
  priorTier: Tier | undefined;
  rationale: ScoreRationaleItem[];
  /** True if a new lead_scores row was written; false if the recompute was a no-op. */
  inserted: boolean;
}

const MAX_SCORE = 100;

/**
 * Stable hash over score + tier + rationale identity + rules-MD hash.
 *
 * Two recomputes that produce the same score+tier from the same rationale
 * under the same rules MUST yield the same fingerprint — that's how
 * idempotency works (the leadScores table has a UNIQUE index on
 * (accountId, fingerprint), and we short-circuit when the latest row's
 * fingerprint matches the new one).
 *
 * Including the rules-MD hash means *any* rule edit (threshold, predicate,
 * weight, window) invalidates the fingerprint and forces a new insert and
 * downstream alert evaluation. Without that, a threshold-only edit would
 * leave the same fingerprint and silently suppress the promotion alert.
 *
 * Including `tier` lets the consumer rely on "fingerprint match → tier
 * unchanged" without recomputing tier separately.
 */
function fingerprint(
  score: number,
  tier: Tier,
  rationale: ScoreRationaleItem[],
  rulesMd: string,
): string {
  const norm = rationale
    .map((r) => `${r.rule_id}:${r.evidence_id}:${r.weight}`)
    .sort()
    .join('|');
  const rulesHash = createHash('sha256').update(rulesMd).digest('hex').slice(0, 16);
  return createHash('sha256')
    .update(`${score}::${tier}::${norm}::${rulesHash}`)
    .digest('hex').slice(0, 16);
}

function isUniqueViolation(err: unknown): boolean {
  // Narrow to UNIQUE / PRIMARY KEY constraint violations only. FK / NOT NULL /
  // CHECK violations are real bugs and must propagate.
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/**
 * Compute the current score for an account from its verified evidence and
 * the supplied rules markdown. Persists a new `lead_scores` row when the
 * fingerprint differs from the latest row; otherwise short-circuits and
 * returns the existing row.
 *
 * Pipeline:
 *   1. Parse rules + tier thresholds.
 *   2. Pull `verified` evidence for the account (pending/disputed cannot
 *      contribute — prevents an attacker from forging a tier promotion by
 *      spamming the webhook).
 *   3. For each (evidence, rule) pair where the predicate matches, decay
 *      the rule's weight by elapsed time and append a rationale item.
 *      Sum is fractional; round at the end for integer storage.
 *   4. Compute the fingerprint over (score, tier, rationale, rules-md).
 *   5. If the latest row for this account has the same fingerprint,
 *      return it (deduped). Otherwise insert; on unique-index race, catch
 *      and re-select the winner.
 *
 * `now` is injectable for tests so date-driven decay is deterministic.
 */
export async function computeScore(
  accountId: string,
  rulesMd: string,
  now: Date = new Date(),
): Promise<ScoreResult> {
  const { rules, thresholds } = parseScoringRules(rulesMd);

  const evidenceRows = db.select().from(schema.evidence)
    .where(and(
      eq(schema.evidence.accountId, accountId),
      eq(schema.evidence.extractionStatus, 'verified'),
    )).all();

  const rationale: ScoreRationaleItem[] = [];
  let total = 0;

  for (const ev of evidenceRows) {
    for (const rule of rules) {
      // evalPredicate returns false on malformed predicates (with a warn) so
      // one bad rule doesn't poison the recompute.
      if (!evalPredicate(rule.predicate, ev)) continue;
      const t = new Date(ev.capturedAt);
      const w = linearDecayWeight(rule.weight, t, now, rule.windowDays);
      // Skip zero-weight contributions (decay window expired or
      // baseWeight=0). Negative weights from penalty rules DO contribute.
      if (w === 0) continue;
      rationale.push({
        evidence_id: ev.id,
        rule_id: rule.id,
        weight: w,
        reason: `${rule.id} matched (predicate=${rule.predicate})`,
      });
      total += w;
    }
  }

  // Clamp upper bound only. Negative scores from penalty rules are allowed
  // and map to `cold` via scoreToTier. Round at the very end so per-rule
  // fractional precision survives until storage.
  const score = Math.round(Math.min(MAX_SCORE, total));
  const tier = scoreToTier(score, thresholds);
  const fp = fingerprint(score, tier, rationale, rulesMd);

  // Latest existing score for this account — used both for the prior-tier
  // report (so downstream alerts know what the tier transitioned from) and
  // for the fingerprint short-circuit.
  const latest = db.select().from(schema.leadScores)
    .where(eq(schema.leadScores.accountId, accountId))
    .orderBy(desc(schema.leadScores.computedAt))
    .limit(1).get();

  if (latest && latest.fingerprint === fp) {
    return {
      scoreId: latest.id,
      accountId,
      score: latest.score,
      tier: latest.tier,
      priorTier: latest.tier,  // dedupe: prior was the matched row itself
      rationale,
      inserted: false,
    };
  }

  const scoreId = newId('leadScore');
  try {
    db.insert(schema.leadScores).values({
      id: scoreId,
      accountId,
      score,
      tier,
      rationaleJson: rationale,
      fingerprint: fp,
      computedAt: now.toISOString(),
    }).run();
    return {
      scoreId,
      accountId,
      score,
      tier,
      priorTier: latest?.tier,  // first-ever score → undefined
      rationale,
      inserted: true,
    };
  } catch (err) {
    // Concurrent recompute: another caller wrote the same (account,
    // fingerprint) first. Re-select that row instead of inserting a duplicate.
    if (!isUniqueViolation(err)) throw err;
    const winner = db.select().from(schema.leadScores)
      .where(and(
        eq(schema.leadScores.accountId, accountId),
        eq(schema.leadScores.fingerprint, fp),
      )).get();
    if (!winner) throw err;
    return {
      scoreId: winner.id,
      accountId,
      score: winner.score,
      tier: winner.tier,
      priorTier: latest?.tier,
      rationale,
      inserted: false,
    };
  }
}
