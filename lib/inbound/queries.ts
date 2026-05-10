import { db, schema } from '@/db';
import { desc, eq, sql } from 'drizzle-orm';

/**
 * Inbound-page data queries.
 *
 * Two correctness properties are baked into both helpers:
 *
 *   1. **SQL-side filtering, not in-memory grouping.** An earlier draft of
 *      the inbound page pulled every `lead_scores` row and group-by'd in
 *      JS to find the latest per account. That's O(N) in the *history*
 *      of scores, not in the number of distinct accounts. As recompute
 *      runs accumulate, the JS approach OOMs the page render. Both
 *      helpers here push the "latest per account" filter into SQL via a
 *      correlated subquery on SQLite's `rowid`, so wire-level cost is
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
 */

/**
 * Top scored accounts, with one row per account (the most recently
 * inserted `lead_scores` row for each), ordered by score DESC. Limited.
 */
export function latestScorePerAccount(limit: number) {
  // Correlated subquery: keep only rows whose rowid matches MAX(rowid) for
  // their account. Single SQL round trip; uses the existing index on
  // (account_id, …) for the inner aggregate. Outer ORDER BY score DESC
  // sorts the (at most one-per-account) candidates.
  return db.select().from(schema.leadScores)
    .where(sql`${schema.leadScores.id} IN (
      SELECT id FROM lead_scores ls
      WHERE ls.rowid = (
        SELECT MAX(rowid) FROM lead_scores WHERE account_id = ls.account_id
      )
    )`)
    .orderBy(desc(schema.leadScores.score))
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
