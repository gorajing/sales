import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { isId } from '../id';

/**
 * Acknowledge-alert helper, shared between the HTTP route and the
 * /alerts page's server action.
 *
 * Two contracts the helper enforces:
 *
 *   1. **First-write-wins idempotency.** If `acknowledgedAt` is already
 *      set, the row is left UNTOUCHED — the original acknowledger and
 *      timestamp are preserved. Returns `{ok: true, alreadyAcked: true}`
 *      so the caller can render "already acknowledged by X at Y" without
 *      a second DB round-trip. This is the meaning of "idempotent" the
 *      user's strict-bar item codifies: same observable state after N
 *      calls as after 1.
 *
 *      The previous draft (`.set({acknowledgedAt: now, acknowledgedBy: by})`
 *      unconditionally) overwrote both fields on every call — a
 *      re-ack would advance the timestamp and replace the original
 *      acknowledger, losing the audit trail of who actually first
 *      saw the alert.
 *
 *   2. **Fail fast on malformed id.** The id format is set by
 *      `newId('alert')`; this validates the WHOLE string via the
 *      shared `isId('alert', …)` (single-sourced in `lib/id.ts`, so
 *      no local regex can drift from `newId`). Anything else can't be
 *      a real alert id — reject before a DB SELECT so a probe-URL
 *      doesn't generate a `not_found` query log line per request.
 *      Defense in depth against URL-tampering where the route handler
 *      is gated behind a shared secret but the server action is not.
 */

export type AckResult =
  | { ok: true; alreadyAcked: boolean }
  | { ok: false; reason: 'not_found' };

export function acknowledgeAlert(id: string, by: string): AckResult {
  if (!isId('alert', id)) {
    // Malformed id can't be a real alert — return not_found without a
    // DB round-trip. This is functionally indistinguishable from
    // "alert doesn't exist" but skips the wire cost of probing.
    return { ok: false, reason: 'not_found' };
  }
  const existing = db.select().from(schema.alerts)
    .where(eq(schema.alerts.id, id)).get();
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.acknowledgedAt != null) {
    // Already acked — first-write-wins, do not overwrite. The caller
    // can render "Acknowledged by X at Y" from `existing` if it needs
    // the values.
    return { ok: true, alreadyAcked: true };
  }
  db.update(schema.alerts).set({
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: by,
  }).where(eq(schema.alerts.id, id)).run();
  return { ok: true, alreadyAcked: false };
}
