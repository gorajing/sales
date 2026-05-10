import { db, schema } from '@/db';
import { eq, ne, sql } from 'drizzle-orm';

/**
 * Inbound-page data queries.
 *
 * Three correctness properties are baked in:
 *
 *   1. **SQL-side filtering, not in-memory grouping.** An earlier draft of
 *      the inbound page pulled every `lead_scores` row and group-by'd in
 *      JS to find the latest per account. That's O(N) in the *history*
 *      of scores, not in the number of distinct accounts. As recompute
 *      runs accumulate, the JS approach OOMs the page render. The
 *      helpers below push the "latest per account" filter into SQL via
 *      a correlated subquery on SQLite's `rowid`, so wire-level cost is
 *      bounded by the number of distinct accounts.
 *
 *   2. **Latest-row ordering uses `rowid DESC`, not `computedAt DESC`.**
 *      Same reasoning as `lib/scoring/score.ts`: when two scores share
 *      the same `computedAt` (test injection, or two recomputes in the
 *      same millisecond), `id` is a random hex suffix and breaks ties
 *      non-monotonically. SQLite's `rowid` is monotonic per insert and
 *      reflects actual insert order, which is the semantic the inbound
 *      view wants. See docs/architecture.md "Deployment assumptions"
 *      for the multi-process caveat.
 *
 *   3. **Display sorts are deterministic, with stable tiebreakers.**
 *      `desc(score)` alone leaves tied scores at the limit-25 boundary
 *      free to swap on each render — the operator sees a jittery
 *      "top accounts" list. We append `rowid DESC` so equal-score rows
 *      sort by insert recency, matching the latest-per-account picker.
 *      Likewise for `recentSignals`: `captured_at` is stored as the
 *      raw ISO string the producer sent (which may carry any offset,
 *      e.g. `+01:00`), so lexicographic DESC on the text column is
 *      not chronological across mixed offsets. We normalize to UTC
 *      via SQLite's `strftime('%Y-%m-%dT%H:%M:%fZ', ...)` before
 *      comparing, then break millisecond ties on `rowid DESC`.
 */

/**
 * Top scored accounts, with one row per account (the most recently
 * inserted `lead_scores` row for each), ordered by score DESC. Limited.
 *
 * Stable: tied scores break on `rowid DESC` so the top-N cut is
 * deterministic across renders.
 */
export function latestScorePerAccount(limit: number) {
  // Correlated subquery: keep only rows whose rowid matches MAX(rowid) for
  // their account. Single SQL round trip; uses the existing index on
  // (account_id, …) for the inner aggregate. Outer ORDER BY sorts the
  // (at most one-per-account) candidates by score, then rowid for tied
  // scores.
  return db.select().from(schema.leadScores)
    .where(sql`${schema.leadScores.id} IN (
      SELECT id FROM lead_scores ls
      WHERE ls.rowid = (
        SELECT MAX(rowid) FROM lead_scores WHERE account_id = ls.account_id
      )
    )`)
    .orderBy(sql`${schema.leadScores.score} DESC, rowid DESC`)
    .limit(limit)
    .all();
}

/**
 * The most recently inserted `lead_scores` row for one account, or
 * `undefined` if the account has no scores. Used by the account detail
 * page's Score panel.
 */
export function latestScoreForAccount(accountId: string) {
  return db.select().from(schema.leadScores)
    .where(eq(schema.leadScores.accountId, accountId))
    .orderBy(sql`rowid DESC`)
    .limit(1)
    .get();
}

/**
 * Most recent N signal-bearing evidence rows, ordered chronologically
 * by UTC-normalized `captured_at` (NEWest first), with `rowid DESC` as
 * the millisecond-tie tiebreaker.
 *
 * Filter: `signal_type != 'none'`. The column is `NOT NULL DEFAULT 'none'`
 * (see db/schema.ts), so non-signal evidence — including pre-v2 manual
 * paste rows that didn't supply a signal_type — sits at `'none'` and is
 * excluded by this single check. No `IS NOT NULL` guard is needed
 * because the schema forbids null values for this column.
 *
 * Ordering uses `strftime(...)` to normalize stored ISO offsets to UTC
 * before compare. Lexicographic compare on the raw text column would
 * misorder equivalent UTC moments written with different offsets
 * (e.g. `12:00:00Z` vs `13:00:00+01:00`).
 */
export function recentSignalEvidence(limit: number) {
  return db.select({
    id: schema.evidence.id,
    capturedAt: schema.evidence.capturedAt,
    sourceType: schema.evidence.sourceType,
    signalType: schema.evidence.signalType,
    snippet: schema.evidence.snippet,
    accountId: schema.evidence.accountId,
  }).from(schema.evidence)
    .where(ne(schema.evidence.signalType, 'none'))
    .orderBy(sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.evidence.capturedAt}) DESC, rowid DESC`)
    .limit(limit)
    .all();
}
