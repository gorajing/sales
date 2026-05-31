import { db, schema } from '@/db';
import { recordEngagementEvent, type RecordEngagementEventInput } from './record';

// ---------------------------------------------------------------------------
// Deterministic engagement demo.
//
// This seeds the sales DB so the REAL producer (buildEngagementFeedback) emits
// exactly the engagement feedback the router consumes — closing the loop with
// no hand-authored payload. The fixtures mirror the router's
// DEMO_ENGAGEMENT_DEAL_SPECS (same routerDealIds, eventIds, touchIds,
// timestamps, kinds) so `pnpm gen:engagement-sample` reproduces the router's
// committed data/engagement-feedback.sample.json byte-for-byte.
//
// Events are written through recordEngagementEvent (the real boundary), not
// raw inserts — the demo exercises the same validation, idempotency, and touch
// side-effects as production.
// ---------------------------------------------------------------------------

type DemoEvent = Omit<RecordEngagementEventInput, 'routerDealId' | 'accountId'>;

interface DemoDeal {
  routerDealId: string;
  accountId: string;
  accountName: string;
  sequenceId: string;
  /** touchId → channel for the touch rows this deal's events reference. */
  touches: Array<{ id: string; channel: 'email' | 'linkedin' }>;
  events: DemoEvent[];
}

// Four routed deals that have observed engagement (emitted in the sample).
const DEMO_DEALS: DemoDeal[] = [
  {
    // Case 1a: full positive funnel + commercial signal.
    routerDealId: 'D-fb65c15017ef',
    accountId: 'demo-acc-ryder',
    accountName: 'Ryder Digital',
    sequenceId: 'demo-sq-ryder',
    touches: [{ id: 'ryder-touch-1', channel: 'email' }],
    events: [
      {
        kind: 'sent',
        eventId: 'ca9a3665-fb7f-4299-8b4b-236a3c365630',
        occurredAt: '2026-05-01T09:00:00.000Z',
        source: 'sales_observed',
        payload: { touchId: 'ryder-touch-1', channel: 'email' },
      },
      {
        kind: 'replied',
        eventId: 'b9a9fc2a-d3e6-4629-924b-3d70904f70d5',
        occurredAt: '2026-05-02T14:30:00.000Z',
        source: 'sales_observed',
        payload: { touchId: 'ryder-touch-1', replyIntent: 'positive' },
      },
      {
        kind: 'meeting_booked',
        eventId: '3e1821ca-b04b-4f83-a64a-80630351a07e',
        occurredAt: '2026-05-03T10:00:00.000Z',
        source: 'sales_reported',
        payload: { touchId: 'ryder-touch-1', meetingAt: '2026-05-06T15:00:00.000Z' },
      },
      {
        kind: 'opportunity_created',
        eventId: '97b5e44a-c6e9-4cba-a64a-b2c1c6323cfb',
        occurredAt: '2026-05-06T16:00:00.000Z',
        source: 'sales_reported',
        payload: { amountUsd: 120000, crmRef: 'HUB-RYDER-001' },
      },
    ],
  },
  {
    // Case 1b: bounced outreach.
    routerDealId: 'D-cdea8ac45022',
    accountId: 'demo-acc-cargo',
    accountName: 'Cargo Loop',
    sequenceId: 'demo-sq-cargo',
    touches: [{ id: 'cargo-touch-1', channel: 'linkedin' }],
    events: [
      {
        kind: 'sent',
        eventId: '4526557d-0757-42ce-acb5-e4691670462d',
        occurredAt: '2026-05-01T09:15:00.000Z',
        source: 'sales_observed',
        payload: { touchId: 'cargo-touch-1', channel: 'linkedin' },
      },
      {
        kind: 'bounced',
        eventId: '3a7f9eee-3a6e-4bd5-bfed-b36a51e5385b',
        occurredAt: '2026-05-01T09:16:00.000Z',
        source: 'sales_observed',
        payload: { touchId: 'cargo-touch-1', reason: 'mailbox_full' },
      },
    ],
  },
  {
    // Case 2: no_response only (window evaluator verdict).
    routerDealId: 'D-8eb789ad84fc',
    accountId: 'demo-acc-acme',
    accountName: 'Acme Retail',
    sequenceId: 'demo-sq-acme',
    touches: [{ id: 'acme-touch-1', channel: 'email' }],
    events: [
      {
        kind: 'no_response',
        eventId: '189bd461-e464-464e-b7ed-5c0e7cfa6063',
        occurredAt: '2026-05-08T00:00:00.000Z',
        source: 'sales_window_evaluator',
        payload: { asOf: '2026-05-08T00:00:00.000Z', windowDays: 7, lastTouchId: 'acme-touch-1', derived: true },
      },
    ],
  },
  {
    // Case 5: LATE-REPLY — no_response(T1) then replied(T2 > T1).
    routerDealId: 'D-a2ff6592e43f',
    accountId: 'demo-acc-globex',
    accountName: 'Globex Foods',
    sequenceId: 'demo-sq-globex',
    touches: [{ id: 'mystery-touch-1', channel: 'email' }],
    events: [
      {
        kind: 'no_response',
        eventId: 'c3e634f0-882f-42bf-b807-7259f3a6f374',
        occurredAt: '2026-05-05T00:00:00.000Z',
        source: 'sales_window_evaluator',
        payload: { asOf: '2026-05-05T00:00:00.000Z', windowDays: 7, lastTouchId: 'mystery-touch-1', derived: true },
      },
      {
        kind: 'replied',
        eventId: '5c265423-2d60-4ff2-944c-092877d807b9',
        occurredAt: '2026-05-14T11:00:00.000Z',
        source: 'sales_observed',
        payload: { touchId: 'mystery-touch-1', replyIntent: 'neutral' },
      },
    ],
  },
];

// Five additional routed deals with NO engagement. They make coverage honest:
// the sales side scanned 9 routed deals but only emitted feedback for 4
// (coverage.complete = false).
const FILLER_DEAL_IDS = [
  'D-000000000001',
  'D-000000000002',
  'D-000000000003',
  'D-000000000004',
  'D-000000000005',
];

function insertHandoff(routerDealId: string, accountId: string, accountName: string): void {
  db.insert(schema.accounts).values({ id: accountId, name: accountName }).run();
  db.insert(schema.gtmHandoffImports).values({
    routerDealId,
    accountId,
    schemaVersion: 'gtm-ops-router.sales-handoff.v1',
    generatedAt: '2026-05-29T07:00:00.000Z',
    accountName,
    routeKind: 'human_assisted',
    amountUsd: 10000,
    sourceChannel: 'outbound',
    researchBrief: 'demo',
    suggestedEvidenceQuestionsJson: [],
    payloadJson: '{}',
  }).run();
}

/**
 * Seed the deterministic engagement demo into the current DB. Intended to run
 * against a throwaway database (see scripts/gen-engagement-sample.ts). Clears
 * the engagement-related tables first so it is idempotent on re-run.
 */
export function seedEngagementDemo(): void {
  db.delete(schema.engagementEvents).run();
  db.delete(schema.touches).run();
  db.delete(schema.sequences).run();
  db.delete(schema.gtmHandoffImports).run();
  db.delete(schema.accounts).run();

  // Five routed-but-silent deals (scanned corpus, no feedback emitted).
  FILLER_DEAL_IDS.forEach((routerDealId, i) => {
    insertHandoff(routerDealId, `demo-acc-fill-${i + 1}`, `Filler ${i + 1}`);
  });

  // Four routed deals with observed engagement.
  for (const deal of DEMO_DEALS) {
    insertHandoff(deal.routerDealId, deal.accountId, deal.accountName);
    db.insert(schema.sequences).values({ id: deal.sequenceId, accountId: deal.accountId }).run();
    deal.touches.forEach((touch, i) => {
      db.insert(schema.touches).values({
        id: touch.id,
        sequenceId: deal.sequenceId,
        position: i + 1,
        channel: touch.channel,
        status: 'ready',
      }).run();
    });
    for (const event of deal.events) {
      recordEngagementEvent({ ...event, routerDealId: deal.routerDealId });
    }
  }
}
