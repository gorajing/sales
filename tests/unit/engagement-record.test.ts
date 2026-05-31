import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// In-memory DB — replaces @/db for all imports in this file.
// NOTE: vi.mock is hoisted — do NOT reference module-level vars (dirname, etc.)
// inside the factory; re-derive them inline instead.
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

// Import under test — must come AFTER vi.mock so the mock is active.
import { recordEngagementEvent } from '../../lib/engagement/record';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const NOW = '2026-05-30T12:00:00.000Z';

async function getDb() {
  const { db, schema: s } = await import('@/db');
  return { db, s };
}

async function seedBase() {
  const { db, s } = await getDb();
  db.insert(s.accounts).values({ id: 'acc_1', name: 'Acme Corp' }).run();
  db.insert(s.gtmHandoffImports).values({
    routerDealId: 'deal_abc',
    accountId: 'acc_1',
    schemaVersion: 'gtm-ops-router.sales-handoff.v1',
    generatedAt: NOW,
    accountName: 'Acme Corp',
    routeKind: 'human_assisted',
    amountUsd: 10000,
    sourceChannel: 'outbound',
    researchBrief: 'brief',
    suggestedEvidenceQuestionsJson: [],
    payloadJson: '{}',
  }).run();
  db.insert(s.sequences).values({ id: 'sq_1', accountId: 'acc_1' }).run();
  db.insert(s.touches).values({
    id: 'to_1', sequenceId: 'sq_1', position: 1, channel: 'email', status: 'ready',
  }).run();
  db.insert(s.touches).values({
    id: 'to_2', sequenceId: 'sq_1', position: 2, channel: 'linkedin', status: 'ready',
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
// Tests: recording each kind
// ---------------------------------------------------------------------------
describe('recordEngagementEvent — kind: sent', () => {
  it('inserts a sent event and marks the touch as sent', async () => {
    const result = recordEngagementEvent({
      kind: 'sent',
      payload: { touchId: 'to_1', channel: 'email' },
      occurredAt: NOW,
      source: 'sales_observed',
      accountId: 'acc_1',
      routerDealId: 'deal_abc',
    });

    expect(result.routerDealId).toBe('deal_abc');
    expect(result.accountId).toBe('acc_1');

    const { db, s } = await getDb();
    const events = db.select().from(s.engagementEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('sent');
    expect(events[0].touchId).toBe('to_1');
    expect(events[0].occurredAt).toBe(NOW);
    expect(events[0].source).toBe('sales_observed');
    expect(events[0].payloadJson).toMatchObject({ touchId: 'to_1', channel: 'email' });

    // Side-effect: touch should be marked sent
    const touch = db.select().from(s.touches).where(
      (await import('drizzle-orm')).eq(s.touches.id, 'to_1')
    ).get();
    expect(touch?.status).toBe('sent');
    expect(touch?.sentAt).toBe(NOW);
  });
});

describe('recordEngagementEvent — kind: replied', () => {
  it('inserts a replied event', async () => {
    recordEngagementEvent({
      kind: 'replied',
      payload: { touchId: 'to_1', replyIntent: 'positive' },
      occurredAt: NOW,
      source: 'sales_reported',
      accountId: 'acc_1',
      routerDealId: 'deal_abc',
    });

    const { db, s } = await getDb();
    const ev = db.select().from(s.engagementEvents).all()[0];
    expect(ev.kind).toBe('replied');
    expect(ev.payloadJson).toMatchObject({ replyIntent: 'positive' });
  });
});

describe('recordEngagementEvent — kind: meeting_booked', () => {
  it('inserts a meeting_booked event', async () => {
    recordEngagementEvent({
      kind: 'meeting_booked',
      payload: { touchId: 'to_1', meetingAt: '2026-06-10T14:00:00.000Z' },
      occurredAt: NOW,
      source: 'sales_reported',
      accountId: 'acc_1',
      routerDealId: 'deal_abc',
    });

    const { db, s } = await getDb();
    const ev = db.select().from(s.engagementEvents).all()[0];
    expect(ev.kind).toBe('meeting_booked');
    expect(ev.payloadJson).toMatchObject({ meetingAt: '2026-06-10T14:00:00.000Z' });
  });
});

describe('recordEngagementEvent — kind: bounced', () => {
  it('inserts a bounced event', async () => {
    recordEngagementEvent({
      kind: 'bounced',
      payload: { touchId: 'to_1', reason: 'mailbox_full' },
      occurredAt: NOW,
      source: 'sales_observed',
      accountId: 'acc_1',
      routerDealId: 'deal_abc',
    });

    const { db, s } = await getDb();
    const ev = db.select().from(s.engagementEvents).all()[0];
    expect(ev.kind).toBe('bounced');
    expect(ev.payloadJson).toMatchObject({ reason: 'mailbox_full' });
  });
});

describe('recordEngagementEvent — kind: no_response', () => {
  it('inserts a no_response event (derived)', async () => {
    recordEngagementEvent({
      kind: 'no_response',
      payload: { asOf: NOW, windowDays: 7, lastTouchId: 'to_1', derived: true },
      occurredAt: NOW,
      source: 'sales_window_evaluator',
      accountId: 'acc_1',
      routerDealId: 'deal_abc',
    });

    const { db, s } = await getDb();
    const ev = db.select().from(s.engagementEvents).all()[0];
    expect(ev.kind).toBe('no_response');
    expect(ev.payloadJson).toMatchObject({ windowDays: 7, derived: true });
    // no_response uses lastTouchId as the touch reference
    expect(ev.touchId).toBe('to_1');
  });
});

describe('recordEngagementEvent — kind: opportunity_created', () => {
  it('inserts an opportunity_created event (no touchId)', async () => {
    recordEngagementEvent({
      kind: 'opportunity_created',
      payload: { amountUsd: 50000, crmRef: 'SF-001' },
      occurredAt: NOW,
      source: 'sales_reported',
      accountId: 'acc_1',
      routerDealId: 'deal_abc',
    });

    const { db, s } = await getDb();
    const ev = db.select().from(s.engagementEvents).all()[0];
    expect(ev.kind).toBe('opportunity_created');
    expect(ev.touchId).toBeNull();
    expect(ev.payloadJson).toMatchObject({ amountUsd: 50000, crmRef: 'SF-001' });
  });
});

// ---------------------------------------------------------------------------
// Touch sent/sentAt side-effect
// ---------------------------------------------------------------------------
describe('sent side-effect', () => {
  it('does not double-mark a touch already sent', async () => {
    const firstAt = '2026-05-30T09:00:00.000Z';
    const secondAt = '2026-05-30T10:00:00.000Z';

    recordEngagementEvent({
      kind: 'sent',
      payload: { touchId: 'to_1', channel: 'email' },
      occurredAt: firstAt,
      source: 'sales_observed',
      accountId: 'acc_1',
      routerDealId: 'deal_abc',
    });

    // Second call with same touch (different eventId) should not overwrite sentAt.
    recordEngagementEvent({
      kind: 'sent',
      payload: { touchId: 'to_1', channel: 'email' },
      occurredAt: secondAt,
      source: 'sales_observed',
      accountId: 'acc_1',
      routerDealId: 'deal_abc',
      // different eventId so uniqueness constraint is not hit
      eventId: 'evt_second',
    });

    const { db, s } = await getDb();
    const { eq } = await import('drizzle-orm');
    const touch = db.select().from(s.touches).where(eq(s.touches.id, 'to_1')).get();
    // sentAt should remain the FIRST value because the status guard (status='ready')
    // prevents overwriting a touch already marked 'sent'.
    expect(touch?.sentAt).toBe(firstAt);
  });

  it('sets sentAt on a linkedin touch', async () => {
    recordEngagementEvent({
      kind: 'sent',
      payload: { touchId: 'to_2', channel: 'linkedin' },
      occurredAt: NOW,
      source: 'sales_observed',
      accountId: 'acc_1',
      routerDealId: 'deal_abc',
    });

    const { db, s } = await getDb();
    const { eq } = await import('drizzle-orm');
    const touch = db.select().from(s.touches).where(eq(s.touches.id, 'to_2')).get();
    expect(touch?.status).toBe('sent');
    expect(touch?.sentAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// routerDealId resolution via gtmHandoffImports
// ---------------------------------------------------------------------------
describe('routerDealId resolution', () => {
  it('resolves routerDealId when only accountId is provided', async () => {
    const result = recordEngagementEvent({
      kind: 'opportunity_created',
      payload: { amountUsd: null, crmRef: null },
      occurredAt: NOW,
      source: 'sales_reported',
      accountId: 'acc_1',
      // routerDealId intentionally omitted
    });

    expect(result.routerDealId).toBe('deal_abc');
  });

  it('resolves accountId when only routerDealId is provided', async () => {
    const result = recordEngagementEvent({
      kind: 'opportunity_created',
      payload: { amountUsd: null, crmRef: null },
      occurredAt: NOW,
      source: 'sales_reported',
      routerDealId: 'deal_abc',
      // accountId intentionally omitted
    });

    expect(result.accountId).toBe('acc_1');
  });

  it('throws when routerDealId does not exist in gtmHandoffImports', () => {
    expect(() =>
      recordEngagementEvent({
        kind: 'opportunity_created',
        payload: { amountUsd: null, crmRef: null },
        occurredAt: NOW,
        source: 'sales_reported',
        routerDealId: 'deal_missing',
      }),
    ).toThrow(/gtmHandoffImport/);
  });

  it('throws when neither accountId nor routerDealId is provided', () => {
    expect(() =>
      recordEngagementEvent({
        kind: 'opportunity_created',
        payload: { amountUsd: null, crmRef: null },
        occurredAt: NOW,
        source: 'sales_reported',
      }),
    ).toThrow(/accountId or routerDealId/);
  });
});

// ---------------------------------------------------------------------------
// Canonical UTC validation
// ---------------------------------------------------------------------------
describe('canonical UTC validation', () => {
  it('accepts a valid canonical UTC string', () => {
    expect(() =>
      recordEngagementEvent({
        kind: 'opportunity_created',
        payload: { amountUsd: null, crmRef: null },
        occurredAt: '2026-01-15T08:30:00.000Z',
        source: 'sales_reported',
        accountId: 'acc_1',
        routerDealId: 'deal_abc',
      }),
    ).not.toThrow();
  });

  it('rejects a date-only string', () => {
    expect(() =>
      recordEngagementEvent({
        kind: 'opportunity_created',
        payload: { amountUsd: null, crmRef: null },
        occurredAt: '2026-01-15',
        source: 'sales_reported',
        accountId: 'acc_1',
        routerDealId: 'deal_abc',
      }),
    ).toThrow(/canonical UTC/);
  });

  it('rejects a timestamp missing milliseconds', () => {
    expect(() =>
      recordEngagementEvent({
        kind: 'opportunity_created',
        payload: { amountUsd: null, crmRef: null },
        occurredAt: '2026-01-15T08:30:00Z',
        source: 'sales_reported',
        accountId: 'acc_1',
        routerDealId: 'deal_abc',
      }),
    ).toThrow(/canonical UTC/);
  });

  it('rejects a local ISO string with +offset', () => {
    expect(() =>
      recordEngagementEvent({
        kind: 'opportunity_created',
        payload: { amountUsd: null, crmRef: null },
        occurredAt: '2026-01-15T08:30:00.000+09:00',
        source: 'sales_reported',
        accountId: 'acc_1',
        routerDealId: 'deal_abc',
      }),
    ).toThrow(/canonical UTC/);
  });
});

// ---------------------------------------------------------------------------
// Unique index: same (routerDealId, kind, eventId) is rejected
// ---------------------------------------------------------------------------
describe('idempotency key uniqueness', () => {
  it('throws on duplicate (routerDealId, kind, eventId)', () => {
    const sharedEventId = 'evt_idempotent';
    recordEngagementEvent({
      kind: 'replied',
      payload: { touchId: 'to_1', replyIntent: 'neutral' },
      occurredAt: NOW,
      source: 'sales_reported',
      accountId: 'acc_1',
      routerDealId: 'deal_abc',
      eventId: sharedEventId,
    });

    expect(() =>
      recordEngagementEvent({
        kind: 'replied',
        payload: { touchId: 'to_1', replyIntent: 'positive' },
        occurredAt: NOW,
        source: 'sales_reported',
        accountId: 'acc_1',
        routerDealId: 'deal_abc',
        eventId: sharedEventId,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Identifier consistency: the (accountId, routerDealId) pair and the touch a
// `sent` event writes to must be grounded in gtmHandoffImports / the account.
// ---------------------------------------------------------------------------
describe('identifier consistency guards', () => {
  it('throws when supplied accountId and routerDealId are not linked in gtmHandoffImports', async () => {
    const { db, s } = await getDb();
    // deal_def belongs to acc_2 — NOT to acc_1.
    db.insert(s.accounts).values({ id: 'acc_2', name: 'Globex' }).run();
    db.insert(s.gtmHandoffImports).values({
      routerDealId: 'deal_def', accountId: 'acc_2',
      schemaVersion: 'gtm-ops-router.sales-handoff.v1', generatedAt: NOW,
      accountName: 'Globex', routeKind: 'human_assisted', amountUsd: 5000,
      sourceChannel: 'outbound', researchBrief: 'brief',
      suggestedEvidenceQuestionsJson: [], payloadJson: '{}',
    }).run();

    expect(() =>
      recordEngagementEvent({
        kind: 'opportunity_created',
        payload: { amountUsd: null, crmRef: null },
        occurredAt: NOW,
        source: 'sales_reported',
        accountId: 'acc_1', // linked to deal_abc...
        routerDealId: 'deal_def', // ...but deal_def belongs to acc_2
      }),
    ).toThrow(/does not match/);
  });

  it('throws when accountId maps to multiple router deals and routerDealId is omitted', async () => {
    const { db, s } = await getDb();
    // acc_1 now owns a second handoff — accountId→routerDealId is ambiguous.
    db.insert(s.gtmHandoffImports).values({
      routerDealId: 'deal_def', accountId: 'acc_1',
      schemaVersion: 'gtm-ops-router.sales-handoff.v1', generatedAt: NOW,
      accountName: 'Acme Corp', routeKind: 'human_assisted', amountUsd: 7000,
      sourceChannel: 'outbound', researchBrief: 'brief',
      suggestedEvidenceQuestionsJson: [], payloadJson: '{}',
    }).run();

    expect(() =>
      recordEngagementEvent({
        kind: 'opportunity_created',
        payload: { amountUsd: null, crmRef: null },
        occurredAt: NOW,
        source: 'sales_reported',
        accountId: 'acc_1', // maps to deal_abc AND deal_def
      }),
    ).toThrow(/multiple router deals/);
  });

  it('rejects a sent event whose touch belongs to another account, writing nothing', async () => {
    const { db, s } = await getDb();
    // acc_2 owns sequence sq_2 / touch to_3 (ready).
    db.insert(s.accounts).values({ id: 'acc_2', name: 'Globex' }).run();
    db.insert(s.sequences).values({ id: 'sq_2', accountId: 'acc_2' }).run();
    db.insert(s.touches).values({
      id: 'to_3', sequenceId: 'sq_2', position: 1, channel: 'email', status: 'ready',
    }).run();

    expect(() =>
      recordEngagementEvent({
        kind: 'sent',
        payload: { touchId: 'to_3', channel: 'email' }, // acc_2's touch
        occurredAt: NOW,
        source: 'sales_observed',
        accountId: 'acc_1', // event is for acc_1
        routerDealId: 'deal_abc',
      }),
    ).toThrow(/does not belong to account/);

    const { eq } = await import('drizzle-orm');
    // The cross-account touch is untouched and the whole transaction rolled back.
    const touch = db.select().from(s.touches).where(eq(s.touches.id, 'to_3')).get();
    expect(touch?.status).toBe('ready');
    const events = db.select().from(s.engagementEvents).all();
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Canonical UTC validation must round-trip (not just match the shape) and must
// cover the payload's own timestamps, so the DB never holds a value the router
// contract would later reject.
// ---------------------------------------------------------------------------
describe('canonical UTC round-trip validation', () => {
  it('rejects an occurredAt that matches the shape but is not a real date', () => {
    expect(() =>
      recordEngagementEvent({
        kind: 'bounced',
        payload: { touchId: 'to_1', reason: 'x' },
        occurredAt: '2026-99-99T00:00:00.000Z',
        source: 'sales_observed',
        accountId: 'acc_1',
        routerDealId: 'deal_abc',
      }),
    ).toThrow(/canonical UTC/);
  });

  it('rejects a meeting_booked whose meetingAt is shape-valid but not a real date', () => {
    expect(() =>
      recordEngagementEvent({
        kind: 'meeting_booked',
        payload: { touchId: 'to_1', meetingAt: '2026-99-99T00:00:00.000Z' },
        occurredAt: NOW,
        source: 'sales_reported',
        accountId: 'acc_1',
        routerDealId: 'deal_abc',
      }),
    ).toThrow(/canonical UTC/);
  });

  it('rejects a no_response whose asOf is shape-valid but not a real date', () => {
    expect(() =>
      recordEngagementEvent({
        kind: 'no_response',
        payload: { asOf: '2026-99-99T00:00:00.000Z', windowDays: 7, lastTouchId: 'to_1', derived: true },
        occurredAt: NOW,
        source: 'sales_window_evaluator',
        accountId: 'acc_1',
        routerDealId: 'deal_abc',
      }),
    ).toThrow(/canonical UTC/);
  });
});
