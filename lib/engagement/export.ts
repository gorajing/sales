import { db, schema } from '@/db';

// ---------------------------------------------------------------------------
// Canonical UTC timestamp: YYYY-MM-DDTHH:mm:ss.sssZ
// (Same rule as lib/engagement/record.ts — kept local on purpose; the producer
// and recorder validate the boundary independently.)
// ---------------------------------------------------------------------------
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertCanonicalUtc(value: string): void {
  if (!CANONICAL_UTC_RE.test(value)) {
    throw new Error(
      `generatedAt must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ), got: ${value}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The frozen `sales.engagement-feedback.v1` contract — the router validates the
// emitted payload with Zod; this TypeScript mirror describes the same shape.
// We do NOT import the router's schema (separate repo); we just produce the
// correct shape.
// ---------------------------------------------------------------------------
export const ENGAGEMENT_FEEDBACK_SCHEMA_VERSION = 'sales.engagement-feedback.v1';

const DEFAULT_PURPOSE =
  'Observed front-funnel engagement exported for router measurement.';

export type EngagementEvent =
  | { kind: 'sent'; eventId: string; occurredAt: string; touchId: string; channel: 'email' | 'linkedin' }
  | { kind: 'replied'; eventId: string; occurredAt: string; touchId: string; replyIntent: 'positive' | 'neutral' | 'negative' }
  | { kind: 'meeting_booked'; eventId: string; occurredAt: string; touchId: string; meetingAt: string }
  | { kind: 'bounced'; eventId: string; occurredAt: string; touchId: string; reason: string }
  | { kind: 'no_response'; eventId: string; occurredAt: string; asOf: string; windowDays: number; lastTouchId: string; derived: true };

export type CommercialSignal = {
  kind: 'opportunity_created';
  eventId: string;
  occurredAt: string;
  amountUsd: number | null;
  crmRef: string | null;
};

export interface EngagementFeedbackDeal {
  routerDealId: string;
  trace: { sourceSystem: 'sales'; boundary: 'observed_engagement_not_router_truth' };
  events: EngagementEvent[];
  commercialSignals?: CommercialSignal[];
}

export interface EngagementFeedback {
  schemaVersion: typeof ENGAGEMENT_FEEDBACK_SCHEMA_VERSION;
  generatedAt: string;
  source: { system: 'sales'; purpose: string };
  coverage: {
    complete: boolean;
    scanned: number;
    emitted: number;
    since: string | null;
  };
  deals: EngagementFeedbackDeal[];
}

// ---------------------------------------------------------------------------
// Reconstruct an emitted object as { kind, eventId, occurredAt, ...payloadJson }.
// The DB-only columns (id, accountId, routerDealId, touchId column, source,
// createdAt) must NOT appear in the emitted object. touchId reappears for the
// kinds that carry it — but via payloadJson, not the column copy.
// ---------------------------------------------------------------------------
function emit(row: {
  kind: string;
  eventId: string;
  occurredAt: string;
  payloadJson: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    kind: row.kind,
    eventId: row.eventId,
    occurredAt: row.occurredAt,
    ...row.payloadJson,
  };
}

// Stable order: occurredAt ascending, then eventId ascending.
function byOccurredThenEventId(
  a: { occurredAt: string; eventId: string },
  b: { occurredAt: string; eventId: string },
): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
  return 0;
}

export function buildEngagementFeedback(opts: {
  generatedAt: string;
  purpose?: string;
}): EngagementFeedback {
  assertCanonicalUtc(opts.generatedAt);

  const rows = db
    .select({
      routerDealId: schema.engagementEvents.routerDealId,
      kind: schema.engagementEvents.kind,
      eventId: schema.engagementEvents.eventId,
      occurredAt: schema.engagementEvents.occurredAt,
      payloadJson: schema.engagementEvents.payloadJson,
    })
    .from(schema.engagementEvents)
    .all();

  // scanned = every routed deal sales knows about (all gtmHandoffImports rows).
  const scanned = db.select({ routerDealId: schema.gtmHandoffImports.routerDealId })
    .from(schema.gtmHandoffImports)
    .all().length;

  // Group rows by routerDealId.
  const grouped = new Map<string, { events: EngagementEvent[]; signals: CommercialSignal[] }>();
  for (const row of rows) {
    let group = grouped.get(row.routerDealId);
    if (!group) {
      group = { events: [], signals: [] };
      grouped.set(row.routerDealId, group);
    }
    if (row.kind === 'opportunity_created') {
      group.signals.push(emit(row) as unknown as CommercialSignal);
    } else {
      group.events.push(emit(row) as unknown as EngagementEvent);
    }
  }

  const deals: EngagementFeedbackDeal[] = [];
  for (const routerDealId of [...grouped.keys()].sort()) {
    const group = grouped.get(routerDealId)!;
    group.events.sort(byOccurredThenEventId);
    group.signals.sort(byOccurredThenEventId);

    const deal: EngagementFeedbackDeal = {
      routerDealId,
      trace: { sourceSystem: 'sales', boundary: 'observed_engagement_not_router_truth' },
      events: group.events,
    };
    // Optional field: omit entirely (leave undefined) when there are no signals.
    if (group.signals.length > 0) {
      deal.commercialSignals = group.signals;
    }
    deals.push(deal);
  }

  const emitted = deals.length;

  return {
    schemaVersion: ENGAGEMENT_FEEDBACK_SCHEMA_VERSION,
    generatedAt: opts.generatedAt,
    source: { system: 'sales', purpose: opts.purpose ?? DEFAULT_PURPOSE },
    coverage: {
      complete: emitted === scanned,
      scanned,
      emitted,
      since: null,
    },
    deals,
  };
}
