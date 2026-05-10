import { createHash } from 'node:crypto';
import { db, schema } from '@/db';
import { eq, and, sql } from 'drizzle-orm';
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
 * Stable hash over the *persisted semantics* of a score row.
 *
 * Two recomputes that produce the same logical state — same rounded score,
 * same tier, same set of (evidence_id, rule_id) matches, same parsed rules
 * — must yield the same fingerprint. The latest-row short-circuit in
 * `computeScore` uses this to skip an insert when nothing has changed.
 *
 * What's hashed (and why):
 *   - **rounded score** (integer): captures the magnitude as it will be
 *     stored. Fractional weights from time-decay are deliberately NOT in
 *     the hash — they vary millisecond-to-millisecond with `now`, which
 *     would defeat dedupe on every default-`now` call.
 *   - **tier**: lets consumers rely on "fingerprint match → tier unchanged"
 *     without recomputing.
 *   - **sorted (evidence_id, rule_id) pairs**: captures *which* matches
 *     produced the score, distinguishing e.g. "score 15 from one rule" from
 *     "score 15 from three rules with offsetting weights."
 *   - **parsed-rules canonical hash**: any rule semantics change
 *     (threshold edit, predicate edit, weight, window) invalidates. But
 *     comment-only or whitespace-only edits to the markdown DON'T — the
 *     hash is over the parsed object, not the raw file.
 *
 * Same fingerprint after an intervening different state IS expected (state
 * recurrence: cold → warm → cold). The DB column is a non-unique index;
 * recurrence appends a new row and the latest-fingerprint short-circuit
 * still works because it compares against the LATEST row only.
 */
function fingerprint(
  score: number,
  tier: Tier,
  rationale: ScoreRationaleItem[],
  parsedRulesCanonical: string,
): string {
  // Pair-set captures matches without per-pair float weights (those vary
  // with `now` and would prevent same-state dedupe across calls).
  const pairs = rationale
    .map((r) => `${r.rule_id}:${r.evidence_id}`)
    .sort()
    .join('|');
  const rulesHash = createHash('sha256').update(parsedRulesCanonical).digest('hex').slice(0, 16);
  return createHash('sha256')
    .update(`${score}::${tier}::${pairs}::${rulesHash}`)
    .digest('hex').slice(0, 16);
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
  // fractional precision survives until storage. Tier is derived from the
  // ROUNDED score so the displayed score and tier agree (an operator
  // looking at "Score: 15" should see the tier consistent with 15, not
  // some pre-rounded 14.6).
  const score = Math.round(Math.min(MAX_SCORE, total));
  const tier = scoreToTier(score, thresholds);
  // Hash the parsed rules + thresholds (canonical form) instead of the raw
  // markdown text so comment-only and whitespace-only edits don't
  // invalidate every account's fingerprint.
  const parsedRulesCanonical = JSON.stringify({ rules, thresholds });
  const fp = fingerprint(score, tier, rationale, parsedRulesCanonical);

  // Latest existing score for this account — used both for the prior-tier
  // report (so downstream alerts know what the tier transitioned from) and
  // for the fingerprint short-circuit. Order by SQLite's `rowid` DESC: it's
  // monotonically incrementing per table, guaranteed unique, and reflects
  // actual insert order — unlike (computedAt, id), which can tie when
  // tests inject the same `now` and where text-id tie-break is non-
  // monotonic (random hex suffix).
  const latest = db.select().from(schema.leadScores)
    .where(eq(schema.leadScores.accountId, accountId))
    .orderBy(sql`rowid DESC`)
    .limit(1).get();

  if (latest && latest.fingerprint === fp) {
    // State unchanged since latest write — return the persisted row exactly.
    // Critically, return the STORED rationale (rationaleJson) rather than
    // the freshly-computed `rationale`: now that fingerprint excludes raw
    // decayed weights, a same-state recompute at a slightly different
    // `now` produces different per-rule weights even though the matched
    // (evidence_id, rule_id) set is identical. Returning the stored
    // rationale keeps the result coherent with what's on disk.
    return {
      scoreId: latest.id,
      accountId,
      score: latest.score,
      tier: latest.tier,
      priorTier: latest.tier,  // dedupe: prior was the matched row itself
      rationale: latest.rationaleJson,
      inserted: false,
    };
  }

  // No unique constraint on (accountId, fingerprint): state recurrence
  // (e.g. cold → warm → cold via signal decay) inserts a fresh row even
  // when the new fingerprint matches a non-latest historical row. The
  // single-process SQLite serialization means two concurrent computeScores
  // in this Node process serialize their transactions; one sees the other's
  // committed row in its SELECT and short-circuits via the path above.
  // Multi-process SQLite would need a different concurrency story (sequence
  // column or chain indicator in the fingerprint); deliberately not built
  // for v2.
  const scoreId = newId('leadScore');
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
}
