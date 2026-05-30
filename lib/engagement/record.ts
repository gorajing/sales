import { eq, and } from 'drizzle-orm';
import { db, schema } from '@/db';
import { newId } from '@/lib/id';

// ---------------------------------------------------------------------------
// Canonical UTC timestamp: YYYY-MM-DDTHH:mm:ss.sssZ
// ---------------------------------------------------------------------------
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertCanonicalUtc(occurredAt: string): void {
  if (!CANONICAL_UTC_RE.test(occurredAt)) {
    throw new Error(
      `occurredAt must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ), got: ${occurredAt}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Kind-specific payload shapes
// ---------------------------------------------------------------------------
export type SentPayload = { touchId: string; channel: 'email' | 'linkedin' };
export type RepliedPayload = { touchId: string; replyIntent: 'positive' | 'neutral' | 'negative' };
export type MeetingBookedPayload = { touchId: string; meetingAt: string };
export type BouncedPayload = { touchId: string; reason: string };
export type NoResponsePayload = {
  asOf: string;
  windowDays: number;
  lastTouchId: string;
  derived: true;
};
export type OpportunityCreatedPayload = {
  amountUsd: number | null;
  crmRef: string | null;
};

type EventKindMap = {
  sent: SentPayload;
  replied: RepliedPayload;
  meeting_booked: MeetingBookedPayload;
  bounced: BouncedPayload;
  no_response: NoResponsePayload;
  opportunity_created: OpportunityCreatedPayload;
};

export type EngagementEventKind = keyof EventKindMap;

// ---------------------------------------------------------------------------
// Input type — discriminated union so payloadJson is always correct for kind
// ---------------------------------------------------------------------------
export type RecordEngagementEventInput<K extends EngagementEventKind = EngagementEventKind> = {
  kind: K;
  payload: EventKindMap[K];
  occurredAt: string;
  source: 'sales_observed' | 'sales_window_evaluator' | 'sales_reported';
  /**
   * Supply accountId directly.  If omitted, routerDealId must be supplied
   * and accountId will be resolved from gtmHandoffImports.
   */
  accountId?: string;
  /**
   * The router's deal identifier.  Supply directly or let it be resolved from
   * gtmHandoffImports by accountId.
   */
  routerDealId?: string;
  /** Idempotency key within (routerDealId, kind).  Auto-generated if omitted. */
  eventId?: string;
};

export interface RecordEngagementEventResult {
  id: string;
  eventId: string;
  routerDealId: string;
  accountId: string;
}

// ---------------------------------------------------------------------------
// Derive touchId from payload when applicable
// ---------------------------------------------------------------------------
function touchIdFromPayload(kind: EngagementEventKind, payload: Record<string, unknown>): string | undefined {
  if (
    kind === 'sent' ||
    kind === 'replied' ||
    kind === 'meeting_booked' ||
    kind === 'bounced'
  ) {
    return payload.touchId as string | undefined;
  }
  if (kind === 'no_response') {
    return payload.lastTouchId as string | undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main recorder
// ---------------------------------------------------------------------------
export function recordEngagementEvent<K extends EngagementEventKind>(
  input: RecordEngagementEventInput<K>,
): RecordEngagementEventResult {
  assertCanonicalUtc(input.occurredAt);

  let { accountId, routerDealId } = input;

  // --- Ground the (accountId, routerDealId) pair in gtmHandoffImports. ---
  // routerDealId is the canonical key (it is the table's primary key, so the
  // lookup is unambiguous); accountId is always verified against it. Resolving
  // the reverse direction (accountId → routerDealId) is only safe when the
  // account owns exactly one handoff — otherwise the deal is genuinely
  // ambiguous and the caller must name it explicitly.
  if (routerDealId) {
    const handoff = db
      .select({ accountId: schema.gtmHandoffImports.accountId })
      .from(schema.gtmHandoffImports)
      .where(eq(schema.gtmHandoffImports.routerDealId, routerDealId))
      .get();
    if (!handoff) {
      throw new Error(`No gtmHandoffImport found for routerDealId: ${routerDealId}`);
    }
    if (accountId && accountId !== handoff.accountId) {
      throw new Error(
        `accountId ${accountId} does not match routerDealId ${routerDealId} ` +
          `(linked to account ${handoff.accountId})`,
      );
    }
    accountId = handoff.accountId;
  } else if (accountId) {
    const handoffs = db
      .select({ routerDealId: schema.gtmHandoffImports.routerDealId })
      .from(schema.gtmHandoffImports)
      .where(eq(schema.gtmHandoffImports.accountId, accountId))
      .all();
    if (handoffs.length === 0) {
      throw new Error(`No gtmHandoffImport found for accountId: ${accountId}`);
    }
    if (handoffs.length > 1) {
      throw new Error(
        `accountId ${accountId} maps to multiple router deals ` +
          `(${handoffs.map((h) => h.routerDealId).join(', ')}); supply routerDealId explicitly`,
      );
    }
    routerDealId = handoffs[0]!.routerDealId;
  } else {
    throw new Error('Must supply at least one of accountId or routerDealId');
  }

  const eventId = input.eventId ?? newId('engagementEvent');
  const id = newId('engagementEvent');
  const touchId = touchIdFromPayload(input.kind, input.payload as Record<string, unknown>);

  db.transaction((tx) => {
    tx.insert(schema.engagementEvents).values({
      id,
      accountId,
      routerDealId: routerDealId!,
      touchId,
      kind: input.kind,
      eventId,
      occurredAt: input.occurredAt,
      source: input.source,
      payloadJson: input.payload as Record<string, unknown>,
    }).run();

    // Side-effect: for a `sent` event tied to a touch, mark it sent.
    if (input.kind === 'sent' && touchId) {
      // The touch must belong to this event's account (touch → sequence →
      // account). A `sent` event carrying another account's touchId is
      // malformed — reject it loudly rather than silently flipping a foreign
      // touch to `sent`. (The throw rolls back the engagement insert above.)
      const owner = tx
        .select({ accountId: schema.sequences.accountId })
        .from(schema.touches)
        .innerJoin(schema.sequences, eq(schema.touches.sequenceId, schema.sequences.id))
        .where(eq(schema.touches.id, touchId))
        .get();
      if (owner && owner.accountId !== accountId) {
        throw new Error(
          `sent event touch ${touchId} does not belong to account ${accountId} ` +
            `(belongs to ${owner.accountId})`,
        );
      }
      tx
        .update(schema.touches)
        .set({ status: 'sent', sentAt: input.occurredAt })
        .where(
          and(
            eq(schema.touches.id, touchId),
            // Only update if not already sent — idempotent on re-record.
            eq(schema.touches.status, 'ready'),
          ),
        )
        .run();
    }
  });

  return { id, eventId, routerDealId: routerDealId!, accountId };
}
