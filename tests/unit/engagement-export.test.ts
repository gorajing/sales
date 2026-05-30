import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory DB — replaces @/db for all imports in this file.
// NOTE: vi.mock is hoisted — do NOT reference module-level vars (dirname, etc.)
// inside the factory; re-derive them inline instead. (Mirrors
// tests/unit/engagement-record.test.ts.)
// ---------------------------------------------------------------------------
vi.mock('@/db', async () => {
  const _path = await import('node:path');
  const _url = await import('node:url');
  const _schema = await import('../../db/schema');
  const _Database = (await import('better-sqlite3')).default;
  const { drizzle: _drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate: _migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const _dirname = _path.dirname(_url.fileURLToPath(import.meta.url));
  const sqlite = new _Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = _drizzle(sqlite, { schema: _schema });
  _migrate(db, { migrationsFolder: _path.resolve(_dirname, '../../db/migrations') });
  return { db, schema: _schema };
});

// Imports under test — must come AFTER vi.mock so the mock is active.
import { buildEngagementFeedback } from '../../lib/engagement/export';
import { recordEngagementEvent } from '../../lib/engagement/record';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const NOW = '2026-05-30T12:00:00.000Z';
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function getDb() {
  const { db, schema: s } = await import('@/db');
  return { db, s };
}

async function seedHandoff(routerDealId: string, accountId: string, name: string) {
  const { db, s } = await getDb();
  db.insert(s.accounts).values({ id: accountId, name }).run();
  db.insert(s.gtmHandoffImports).values({
    routerDealId,
    accountId,
    schemaVersion: 'gtm-ops-router.sales-handoff.v1',
    generatedAt: NOW,
    accountName: name,
    routeKind: 'human_assisted',
    amountUsd: 10000,
    sourceChannel: 'outbound',
    researchBrief: 'brief',
    suggestedEvidenceQuestionsJson: [],
    payloadJson: '{}',
  }).run();
}

async function seedBase() {
  // Two routed deals across two accounts so coverage scanning is testable.
  await seedHandoff('deal_abc', 'acc_1', 'Acme Corp');
  await seedHandoff('deal_xyz', 'acc_2', 'Globex');

  const { db, s } = await getDb();
  // Sequences + touches for acc_1 so `sent` side-effects in record.ts are valid.
  db.insert(s.sequences).values({ id: 'sq_1', accountId: 'acc_1' }).run();
  db.insert(s.touches).values({
    id: 'to_1', sequenceId: 'sq_1', position: 1, channel: 'email', status: 'ready',
  }).run();
  db.insert(s.touches).values({
    id: 'to_2', sequenceId: 'sq_1', position: 2, channel: 'linkedin', status: 'ready',
  }).run();
}

// Insert an engagement event row directly (bypassing record.ts side-effects),
// giving full control over kind/source/payload/occurredAt/eventId/touchId.
async function insertEvent(row: {
  id: string;
  accountId: string;
  routerDealId: string;
  touchId?: string | null;
  kind:
    | 'sent' | 'replied' | 'meeting_booked' | 'bounced'
    | 'no_response' | 'opportunity_created';
  eventId: string;
  occurredAt: string;
  source: 'sales_observed' | 'sales_window_evaluator' | 'sales_reported';
  payloadJson: Record<string, unknown>;
}) {
  const { db, s } = await getDb();
  db.insert(s.engagementEvents).values({
    id: row.id,
    accountId: row.accountId,
    routerDealId: row.routerDealId,
    touchId: row.touchId ?? null,
    kind: row.kind,
    eventId: row.eventId,
    occurredAt: row.occurredAt,
    source: row.source,
    payloadJson: row.payloadJson,
  }).run();
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------
beforeEach(async () => {
  const { db, s } = await getDb();
  db.delete(s.engagementEvents).run();
  db.delete(s.touches).run();
  db.delete(s.sequences).run();
  db.delete(s.gtmHandoffImports).run();
  db.delete(s.accounts).run();
  await seedBase();
});

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------
describe('buildEngagementFeedback — envelope', () => {
  it('emits the frozen schemaVersion, source, and generatedAt', () => {
    const fb = buildEngagementFeedback({ generatedAt: NOW });
    expect(fb.schemaVersion).toBe('sales.engagement-feedback.v1');
    expect(fb.generatedAt).toBe(NOW);
    expect(fb.source.system).toBe('sales');
    expect(typeof fb.source.purpose).toBe('string');
    expect(fb.source.purpose.length).toBeGreaterThan(0);
  });

  it('uses the supplied purpose when provided', () => {
    const fb = buildEngagementFeedback({ generatedAt: NOW, purpose: 'custom purpose' });
    expect(fb.source.purpose).toBe('custom purpose');
  });
});

// ---------------------------------------------------------------------------
// Events: a deal with sent + replied + meeting_booked
// ---------------------------------------------------------------------------
describe('buildEngagementFeedback — events shape & ordering', () => {
  it('groups three events in time order with exact contract shape (no column leakage)', async () => {
    await insertEvent({
      id: 'ee_1', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'sent', eventId: 'evt_sent', occurredAt: '2026-05-30T09:00:00.000Z',
      source: 'sales_observed', payloadJson: { touchId: 'to_1', channel: 'email' },
    });
    await insertEvent({
      id: 'ee_2', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'replied', eventId: 'evt_reply', occurredAt: '2026-05-30T10:00:00.000Z',
      source: 'sales_reported', payloadJson: { touchId: 'to_1', replyIntent: 'positive' },
    });
    await insertEvent({
      id: 'ee_3', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'meeting_booked', eventId: 'evt_meet', occurredAt: '2026-05-30T11:00:00.000Z',
      source: 'sales_reported',
      payloadJson: { touchId: 'to_1', meetingAt: '2026-06-10T14:00:00.000Z' },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    const deal = fb.deals.find((d) => d.routerDealId === 'deal_abc')!;
    expect(deal).toBeDefined();
    expect(deal.trace).toEqual({
      sourceSystem: 'sales',
      boundary: 'observed_engagement_not_router_truth',
    });
    expect(deal.events).toHaveLength(3);
    expect(deal.events.map((e) => e.kind)).toEqual(['sent', 'replied', 'meeting_booked']);

    // Exact shape: kind, eventId, occurredAt, ...payloadJson — no source/id/accountId.
    expect(deal.events[0]).toEqual({
      kind: 'sent',
      eventId: 'evt_sent',
      occurredAt: '2026-05-30T09:00:00.000Z',
      touchId: 'to_1',
      channel: 'email',
    });
    expect(deal.events[1]).toEqual({
      kind: 'replied',
      eventId: 'evt_reply',
      occurredAt: '2026-05-30T10:00:00.000Z',
      touchId: 'to_1',
      replyIntent: 'positive',
    });
    expect(deal.events[2]).toEqual({
      kind: 'meeting_booked',
      eventId: 'evt_meet',
      occurredAt: '2026-05-30T11:00:00.000Z',
      touchId: 'to_1',
      meetingAt: '2026-06-10T14:00:00.000Z',
    });

    // No DB-only columns leak into the emitted events.
    for (const e of deal.events) {
      expect(e).not.toHaveProperty('source');
      expect(e).not.toHaveProperty('id');
      expect(e).not.toHaveProperty('accountId');
      expect(e).not.toHaveProperty('routerDealId');
      expect(e).not.toHaveProperty('createdAt');
    }
  });

  it('emits bounced and no_response with the correct fields', async () => {
    await insertEvent({
      id: 'ee_b', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'bounced', eventId: 'evt_bounce', occurredAt: '2026-05-30T08:00:00.000Z',
      source: 'sales_observed', payloadJson: { touchId: 'to_1', reason: 'mailbox_full' },
    });
    await insertEvent({
      id: 'ee_n', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'no_response', eventId: 'evt_noresp', occurredAt: '2026-05-30T09:00:00.000Z',
      source: 'sales_window_evaluator',
      payloadJson: { asOf: NOW, windowDays: 7, lastTouchId: 'to_1', derived: true },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    const deal = fb.deals.find((d) => d.routerDealId === 'deal_abc')!;
    expect(deal.events[0]).toEqual({
      kind: 'bounced',
      eventId: 'evt_bounce',
      occurredAt: '2026-05-30T08:00:00.000Z',
      touchId: 'to_1',
      reason: 'mailbox_full',
    });
    expect(deal.events[1]).toEqual({
      kind: 'no_response',
      eventId: 'evt_noresp',
      occurredAt: '2026-05-30T09:00:00.000Z',
      asOf: NOW,
      windowDays: 7,
      lastTouchId: 'to_1',
      derived: true,
    });
  });
});

// ---------------------------------------------------------------------------
// CommercialSignals: opportunity_created lands in its own array
// ---------------------------------------------------------------------------
describe('buildEngagementFeedback — commercialSignals', () => {
  it('routes opportunity_created into commercialSignals, NOT events', async () => {
    await insertEvent({
      id: 'ee_sent', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'sent', eventId: 'evt_sent', occurredAt: '2026-05-30T09:00:00.000Z',
      source: 'sales_observed', payloadJson: { touchId: 'to_1', channel: 'email' },
    });
    await insertEvent({
      id: 'ee_opp', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: null,
      kind: 'opportunity_created', eventId: 'evt_opp',
      occurredAt: '2026-05-30T12:00:00.000Z',
      source: 'sales_reported', payloadJson: { amountUsd: 50000, crmRef: 'SF-001' },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    const deal = fb.deals.find((d) => d.routerDealId === 'deal_abc')!;

    expect(deal.events.map((e) => e.kind)).toEqual(['sent']);
    expect(deal.commercialSignals).toBeDefined();
    expect(deal.commercialSignals).toHaveLength(1);
    expect(deal.commercialSignals![0]).toEqual({
      kind: 'opportunity_created',
      eventId: 'evt_opp',
      occurredAt: '2026-05-30T12:00:00.000Z',
      amountUsd: 50000,
      crmRef: 'SF-001',
    });
  });

  it('leaves commercialSignals undefined when a deal has none', async () => {
    await insertEvent({
      id: 'ee_sent', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'sent', eventId: 'evt_sent', occurredAt: '2026-05-30T09:00:00.000Z',
      source: 'sales_observed', payloadJson: { touchId: 'to_1', channel: 'email' },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    const deal = fb.deals.find((d) => d.routerDealId === 'deal_abc')!;
    expect(deal.commercialSignals).toBeUndefined();
    expect('commercialSignals' in deal).toBe(false);
  });

  it('accepts null amountUsd / crmRef on an opportunity_created signal', async () => {
    await insertEvent({
      id: 'ee_opp', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: null,
      kind: 'opportunity_created', eventId: 'evt_opp',
      occurredAt: '2026-05-30T12:00:00.000Z',
      source: 'sales_reported', payloadJson: { amountUsd: null, crmRef: null },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    const deal = fb.deals.find((d) => d.routerDealId === 'deal_abc')!;
    expect(deal.events).toHaveLength(0);
    expect(deal.commercialSignals![0]).toEqual({
      kind: 'opportunity_created',
      eventId: 'evt_opp',
      occurredAt: '2026-05-30T12:00:00.000Z',
      amountUsd: null,
      crmRef: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------
describe('buildEngagementFeedback — coverage', () => {
  it('reports complete:false when only some routed deals have feedback', async () => {
    // 2 handoffs seeded; only deal_abc has an event.
    await insertEvent({
      id: 'ee_1', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'sent', eventId: 'evt_sent', occurredAt: '2026-05-30T09:00:00.000Z',
      source: 'sales_observed', payloadJson: { touchId: 'to_1', channel: 'email' },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    expect(fb.coverage.scanned).toBe(2);
    expect(fb.coverage.emitted).toBe(1);
    expect(fb.coverage.complete).toBe(false);
    expect(fb.coverage.since).toBeNull();
    expect(fb.deals).toHaveLength(1);
  });

  it('reports complete:true when every routed deal has feedback', async () => {
    await insertEvent({
      id: 'ee_1', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'sent', eventId: 'evt_a', occurredAt: '2026-05-30T09:00:00.000Z',
      source: 'sales_observed', payloadJson: { touchId: 'to_1', channel: 'email' },
    });
    await insertEvent({
      id: 'ee_2', accountId: 'acc_2', routerDealId: 'deal_xyz', touchId: null,
      kind: 'replied', eventId: 'evt_b', occurredAt: '2026-05-30T09:30:00.000Z',
      source: 'sales_reported', payloadJson: { touchId: 'tx', replyIntent: 'neutral' },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    expect(fb.coverage.scanned).toBe(2);
    expect(fb.coverage.emitted).toBe(2);
    expect(fb.coverage.complete).toBe(true);
  });

  it('emits no deals and complete:true against an empty handoff set', async () => {
    const { db, s } = await getDb();
    db.delete(s.engagementEvents).run();
    db.delete(s.touches).run();
    db.delete(s.sequences).run();
    db.delete(s.gtmHandoffImports).run();
    db.delete(s.accounts).run();

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    expect(fb.deals).toEqual([]);
    expect(fb.coverage).toEqual({ complete: true, scanned: 0, emitted: 0, since: null });
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
describe('buildEngagementFeedback — determinism', () => {
  it('sorts deals by routerDealId ascending', async () => {
    await insertEvent({
      id: 'ee_x', accountId: 'acc_2', routerDealId: 'deal_xyz', touchId: null,
      kind: 'replied', eventId: 'evt_x', occurredAt: NOW,
      source: 'sales_reported', payloadJson: { touchId: 't', replyIntent: 'neutral' },
    });
    await insertEvent({
      id: 'ee_a', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'sent', eventId: 'evt_a', occurredAt: NOW,
      source: 'sales_observed', payloadJson: { touchId: 'to_1', channel: 'email' },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    expect(fb.deals.map((d) => d.routerDealId)).toEqual(['deal_abc', 'deal_xyz']);
  });

  it('sorts events by occurredAt asc, then eventId asc (seed out of order)', async () => {
    // Insert out of chronological order; two share an occurredAt to exercise the
    // eventId tiebreak.
    await insertEvent({
      id: 'ee_3', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'replied', eventId: 'evt_b', occurredAt: '2026-05-30T10:00:00.000Z',
      source: 'sales_reported', payloadJson: { touchId: 'to_1', replyIntent: 'neutral' },
    });
    await insertEvent({
      id: 'ee_1', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'bounced', eventId: 'evt_a', occurredAt: '2026-05-30T10:00:00.000Z',
      source: 'sales_observed', payloadJson: { touchId: 'to_1', reason: 'x' },
    });
    await insertEvent({
      id: 'ee_2', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'sent', eventId: 'evt_z', occurredAt: '2026-05-30T08:00:00.000Z',
      source: 'sales_observed', payloadJson: { touchId: 'to_1', channel: 'email' },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    const deal = fb.deals.find((d) => d.routerDealId === 'deal_abc')!;
    // 08:00 (evt_z) first, then the two 10:00 entries ordered by eventId: evt_a, evt_b.
    expect(deal.events.map((e) => e.eventId)).toEqual(['evt_z', 'evt_a', 'evt_b']);
  });

  it('sorts commercialSignals by occurredAt asc, then eventId asc', async () => {
    await insertEvent({
      id: 'eo_2', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: null,
      kind: 'opportunity_created', eventId: 'evt_b', occurredAt: '2026-05-30T10:00:00.000Z',
      source: 'sales_reported', payloadJson: { amountUsd: 1, crmRef: null },
    });
    await insertEvent({
      id: 'eo_1', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: null,
      kind: 'opportunity_created', eventId: 'evt_a', occurredAt: '2026-05-30T10:00:00.000Z',
      source: 'sales_reported', payloadJson: { amountUsd: 2, crmRef: null },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });
    const deal = fb.deals.find((d) => d.routerDealId === 'deal_abc')!;
    expect(deal.commercialSignals!.map((s) => s.eventId)).toEqual(['evt_a', 'evt_b']);
  });
});

// ---------------------------------------------------------------------------
// generatedAt validation
// ---------------------------------------------------------------------------
describe('buildEngagementFeedback — generatedAt validation', () => {
  it('throws on a non-canonical generatedAt (date only)', () => {
    expect(() => buildEngagementFeedback({ generatedAt: '2026-01-15' })).toThrow(/canonical UTC/);
  });

  it('throws on a +offset generatedAt', () => {
    expect(() =>
      buildEngagementFeedback({ generatedAt: '2026-01-15T08:30:00.000+09:00' }),
    ).toThrow(/canonical UTC/);
  });
});

// ---------------------------------------------------------------------------
// Every emitted timestamp is canonical UTC and round-trips
// ---------------------------------------------------------------------------
describe('buildEngagementFeedback — canonical timestamps everywhere', () => {
  it('every timestamp in the payload is canonical and round-trips', async () => {
    await insertEvent({
      id: 'ee_1', accountId: 'acc_1', routerDealId: 'deal_abc', touchId: 'to_1',
      kind: 'meeting_booked', eventId: 'evt_meet', occurredAt: '2026-05-30T09:00:00.000Z',
      source: 'sales_reported',
      payloadJson: { touchId: 'to_1', meetingAt: '2026-06-10T14:00:00.000Z' },
    });
    await insertEvent({
      id: 'ee_2', accountId: 'acc_2', routerDealId: 'deal_xyz', touchId: null,
      kind: 'opportunity_created', eventId: 'evt_opp', occurredAt: '2026-05-30T11:00:00.000Z',
      source: 'sales_reported', payloadJson: { amountUsd: 1, crmRef: 'X' },
    });

    const fb = buildEngagementFeedback({ generatedAt: NOW });

    const timestamps: string[] = [fb.generatedAt];
    for (const deal of fb.deals) {
      for (const e of deal.events) {
        timestamps.push(e.occurredAt);
        if (e.kind === 'meeting_booked') timestamps.push(e.meetingAt);
        if (e.kind === 'no_response') timestamps.push(e.asOf);
      }
      for (const sig of deal.commercialSignals ?? []) {
        timestamps.push(sig.occurredAt);
      }
    }

    for (const ts of timestamps) {
      expect(ts).toMatch(CANONICAL_UTC_RE);
      expect(new Date(ts).toISOString()).toBe(ts);
    }
  });
});
