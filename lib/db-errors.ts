/**
 * Shared DB-error classification.
 *
 * Extracted (codex Phase 4 r1) after the SAME predicate accreted four
 * byte-identical copies — `lib/signals/ingest.ts`,
 * `lib/routing/route.ts`, `lib/alerts/dispatch.ts`,
 * `lib/engagement/ingest.ts`. That is the exact duplicated-helper
 * drift class flagged repeatedly in Phase 3 (HTTP helpers,
 * `ISO_DATETIME_WITH_OFFSET`, `EMAIL_SHAPE`, the recompute core).
 * Single source of truth so a future Postgres port (different error
 * codes) is a one-file change, not a four-file hunt.
 */

/**
 * True only for UNIQUE / PRIMARY KEY constraint violations — the
 * recoverable "someone else won the race, re-resolve to the winner"
 * case in the SELECT-then-INSERT idempotency pattern.
 *
 * FK / NOT NULL / CHECK violations are real bugs (a missing parent
 * row, a contract breach) and MUST propagate uncaught — narrowing to
 * exactly the two UNIQUE/PK codes is load-bearing, not cosmetic.
 *
 * SQLite-specific. See docs/architecture.md "Deployment assumptions"
 * for what changes when porting to Postgres (the codes differ; this
 * is the one place that would change).
 */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}
