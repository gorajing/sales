import { db, schema } from '@/db';
import { sql } from 'drizzle-orm';

/**
 * Alerts-page data queries.
 *
 * Single concern: load the alert feed for `/alerts` with bounded,
 * deterministic ordering. Same lessons as `lib/inbound/queries.ts`:
 *
 *   1. **Bounded at the SQL layer**, not by JS slicing. `LIMIT N`
 *      hits the wire; the page renders exactly N rows regardless of
 *      how many alerts the table holds.
 *
 *   2. **Deterministic ordering with a real tiebreaker.** `createdAt`
 *      is millisecond-resolution ISO-8601 (`strftime('%Y-%m-%dT%H:%M:%fZ',
 *      'now')` in the column default), so two alerts in the same
 *      millisecond would sort by `createdAt DESC` non-deterministically.
 *      `rowid DESC` is SQLite's monotonic insert-order primitive — the
 *      same tiebreaker the scoring + inbound layers use — so the
 *      top-N cut is stable across renders.
 */

/**
 * Most recent alerts, ordered by `createdAt DESC` with `rowid DESC` as a
 * stable tiebreaker, limited to `limit` rows.
 */
export function recentAlerts(limit: number) {
  return db.select().from(schema.alerts)
    .orderBy(sql`${schema.alerts.createdAt} DESC, rowid DESC`)
    .limit(limit)
    .all();
}
