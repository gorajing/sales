import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { newId } from '../id';
import { ISO_DATETIME_WITH_OFFSET, FUTURE_SKEW_MS } from '../signals/types';

/**
 * Engagement ingest (Phase 4.2).
 *
 * Engagement events are FACTS from outreach providers (Outreach,
 * SendGrid), not scoring evidence. This path NEVER writes `evidence`
 * and the events never enter the lead score — they exist only for the
 * feedback loop (4.3 attribution → advisory drafter context).
 *
 * Contract (see the Phase 4 contract):
 *   - Identity/dedupe: `external_id` UNIQUE is the webhook-redelivery
 *     idempotency key. SELECT-then-INSERT with the UNIQUE constraint
 *     as the concurrent-double-delivery backstop — the exact pattern
 *     `ingestSignal` uses.
 *   - Attach-or-fail: the event MUST resolve to an EXISTING touch or
 *     contact. An orphan (neither id, or an id that doesn't exist) is
 *     rejected with a clear `EngagementRejectedError` (→ HTTP 400),
 *     NOT a 500 FK error and NOT a silently-stored orphan.
 *   - Timestamp: `occurred_at` is validated by the SHARED
 *     `ISO_DATETIME_WITH_OFFSET` + the SHARED `FUTURE_SKEW_MS` (same
 *     canonical policy as `evidence.captured_at`), then NORMALIZED to
 *     UTC-Z at the write boundary (`new Date(x).toISOString()`),
 *     identical to how `ingestSignal` canonicalizes `captured_at`.
 */

/**
 * Thrown when an engagement event cannot be attached to a known
 * touch/contact. Distinct from `ZodError` (malformed payload) so the
 * route can map it to a clear 400 with its own message. NOT a 500 —
 * it's a caller/data problem, deterministically reproducible, "fail
 * clearly" per the contract.
 */
export class EngagementRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngagementRejectedError';
  }
}

export const EngagementPayload = z.object({
  touchId: z.string().min(1).nullable().optional(),
  contactId: z.string().min(1).nullable().optional(),
  event_type: z.enum([
    'sent', 'delivered', 'opened', 'clicked', 'replied',
    'bounced', 'unsubscribed', 'meeting_booked',
  ]),
  external_id: z.string().min(1).optional(),
  // SHARED format rule (same as evidence.captured_at) + SHARED skew
  // policy. Not a re-hand-rolled z.string().datetime — single source
  // of truth, can't drift from what the rest of the pipeline accepts.
  occurred_at: ISO_DATETIME_WITH_OFFSET.refine(
    (iso) => new Date(iso).getTime() <= Date.now() + FUTURE_SKEW_MS,
    { message: `occurred_at cannot be more than ${FUTURE_SKEW_MS / 60000} minutes in the future` },
  ),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type EngagementPayload = z.infer<typeof EngagementPayload>;

function isUniqueViolation(err: unknown): boolean {
  // UNIQUE / PRIMARY KEY only — FK / NOT NULL / CHECK must propagate.
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export async function ingestEngagement(
  raw: unknown,
): Promise<{ id: string; deduped: boolean }> {
  const p = EngagementPayload.parse(raw);

  // -- attach-or-fail -----------------------------------------------------
  // Resolve each provided reference against the real row. A provided
  // id that doesn't exist is a clear rejection (not a 500 FK error).
  // Then require at least ONE resolved attach point — an event that
  // attaches to nothing is unattributable noise.
  const touchId = p.touchId ?? null;
  const contactId = p.contactId ?? null;

  if (touchId !== null) {
    const t = db.select().from(schema.touches)
      .where(eq(schema.touches.id, touchId)).get();
    if (!t) {
      throw new EngagementRejectedError(`unknown touchId: ${touchId}`);
    }
  }
  if (contactId !== null) {
    const c = db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, contactId)).get();
    if (!c) {
      throw new EngagementRejectedError(`unknown contactId: ${contactId}`);
    }
  }
  if (touchId === null && contactId === null) {
    throw new EngagementRejectedError(
      'engagement event must attach to a known touch or contact ' +
      '(both touchId and contactId are absent)',
    );
  }

  // -- idempotency (SELECT-then-INSERT + UNIQUE race backstop) ------------
  if (p.external_id) {
    const dup = db.select().from(schema.engagementEvents)
      .where(eq(schema.engagementEvents.externalId, p.external_id)).get();
    if (dup) return { id: dup.id, deduped: true };
  }

  // Canonicalize occurred_at to UTC-Z at the write boundary — same
  // normalization ingestSignal applies to captured_at, so storage is
  // consistent regardless of the offset the provider sent.
  const occurredAtIso = new Date(p.occurred_at).toISOString();

  const id = newId('engagementEvent');
  try {
    db.insert(schema.engagementEvents).values({
      id,
      touchId,
      contactId,
      eventType: p.event_type,
      metadataJson: p.metadata ?? {},
      occurredAt: occurredAtIso,
      externalId: p.external_id ?? null,
    }).run();
    return { id, deduped: false };
  } catch (err) {
    // Concurrent duplicate posts can both pass the SELECT; the loser
    // hits the UNIQUE(external_id) constraint and re-resolves to the
    // winner. Any non-unique error (FK, NOT NULL) is a real bug.
    if (!isUniqueViolation(err) || !p.external_id) throw err;
    const winner = db.select().from(schema.engagementEvents)
      .where(eq(schema.engagementEvents.externalId, p.external_id)).get();
    if (!winner) throw err;
    return { id: winner.id, deduped: true };
  }
}
