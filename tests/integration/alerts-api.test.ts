import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '../../db/schema';

vi.mock('@/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schemaMod = await import('../../db/schema');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const _dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: schemaMod });
  migrate(db, { migrationsFolder: path.resolve(_dirname, '../../db/migrations') });
  return { db, schema: schemaMod };
});

const ENV = process.env as Record<string, string | undefined>;
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(async () => {
  SAVED_ENV.INTERNAL_API_SECRET = ENV.INTERNAL_API_SECRET;
  SAVED_ENV.NODE_ENV = ENV.NODE_ENV;
  delete ENV.INTERNAL_API_SECRET;
  delete ENV.NODE_ENV;

  const { db, schema: s } = await import('@/db');
  db.delete(s.alerts).run();
  db.delete(s.accounts).run();
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete ENV[k]; else ENV[k] = v;
  }
  vi.restoreAllMocks();
});

import { POST as ackPost } from '../../app/api/alerts/[id]/ack/route';
import { GET as alertsGet } from '../../app/api/alerts/route';
import { newId } from '../../lib/id';

async function seed(): Promise<{ accountId: string; alertId: string }> {
  const { db, schema: s } = await import('@/db');
  const accountId = newId('account');
  db.insert(s.accounts).values({ id: accountId, name: 'Acme' }).run();
  const alertId = newId('alert');
  db.insert(s.alerts).values({
    id: alertId, accountId, trigger: 'tier_promotion', severity: 'priority',
    payloadJson: { fromTier: 'warm', toTier: 'hot' },
    channelsSentJson: [{ channel: 'file', ok: true, sent_at: '2026-05-10T12:00:00.000Z' }],
  }).run();
  return { accountId, alertId };
}

function ackReq(alertId: string, by: string, headers: Record<string, string> = {}) {
  return new Request(`http://x/api/alerts/${alertId}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ by }),
  });
}

// ============================================================================
// POST /api/alerts/[id]/ack
// ============================================================================

describe('POST /api/alerts/:id/ack — happy path', () => {
  it('marks the alert as acknowledged and returns 200 with the row state', async () => {
    const { alertId } = await seed();
    const res = await ackPost(ackReq(alertId, 'jin@example.com'), {
      params: Promise.resolve({ id: alertId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const { db, schema: s } = await import('@/db');
    const row = db.select().from(s.alerts).all()[0];
    expect(row.acknowledgedAt).toBeTruthy();
    expect(row.acknowledgedBy).toBe('jin@example.com');
  });

  it('is idempotent: re-ack does not overwrite the original timestamp/acker', async () => {
    const { alertId } = await seed();
    const first = await ackPost(ackReq(alertId, 'first@example.com'), {
      params: Promise.resolve({ id: alertId }),
    });
    expect(first.status).toBe(200);

    const { db, schema: s } = await import('@/db');
    const originalRow = db.select().from(s.alerts).all()[0];
    const originalTs = originalRow.acknowledgedAt;

    const second = await ackPost(ackReq(alertId, 'second@example.com'), {
      params: Promise.resolve({ id: alertId }),
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.alreadyAcked).toBe(true);

    const after = db.select().from(s.alerts).all()[0];
    expect(after.acknowledgedAt).toBe(originalTs);
    expect(after.acknowledgedBy).toBe('first@example.com');
  });
});

describe('POST /api/alerts/:id/ack — error responses', () => {
  it('404s when alert is missing', async () => {
    const res = await ackPost(
      ackReq('al_20260510_aaaabbbbcc', 'x@y.z'),
      { params: Promise.resolve({ id: 'al_20260510_aaaabbbbcc' }) },
    );
    expect(res.status).toBe(404);
  });

  it('404s when alert id is malformed (fails fast, no DB probe)', async () => {
    const res = await ackPost(
      ackReq('definitely-not-an-id', 'x@y.z'),
      { params: Promise.resolve({ id: 'definitely-not-an-id' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 with sanitized issue list on missing/empty by field', async () => {
    const { alertId } = await seed();
    const req = new Request(`http://x/api/alerts/${alertId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await ackPost(req, { params: Promise.resolve({ id: alertId }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    // Sanitized — issues carry only path + code, no .message echo that
    // could reflect user-controlled keys back through Zod's
    // unrecognized_keys error.
    for (const issue of body.issues) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
    }
  });

  it('returns 400 on invalid JSON', async () => {
    const { alertId } = await seed();
    const req = new Request(`http://x/api/alerts/${alertId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid json',
    });
    const res = await ackPost(req, { params: Promise.resolve({ id: alertId }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_json');
  });

  it('returns 415 on wrong Content-Type', async () => {
    const { alertId } = await seed();
    const req = new Request(`http://x/api/alerts/${alertId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'plain text',
    });
    const res = await ackPost(req, { params: Promise.resolve({ id: alertId }) });
    expect(res.status).toBe(415);
  });

  it('returns 413 when body exceeds MAX_BODY_BYTES even without Content-Length', async () => {
    // Regression guard for the round-1 BLOCKER: the original ack route
    // used `req.text()` + UTF-16 length check, which would buffer the
    // entire payload before noticing the cap. The fix swapped to the
    // streaming `readBoundedBody` helper that bails on the first chunk
    // that crosses the byte cap. Verify by sending a 64KB body with
    // Content-Length omitted (the cap should still fire).
    const { alertId } = await seed();
    const huge = 'x'.repeat(64 * 1024);
    const req = new Request(`http://x/api/alerts/${alertId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },  // no Content-Length
      body: JSON.stringify({ by: 'jin@example.com', noise: huge }),
    });
    const res = await ackPost(req, { params: Promise.resolve({ id: alertId }) });
    expect(res.status).toBe(413);
  });
});

describe('POST /api/alerts/:id/ack — auth + production guard', () => {
  it('401 when INTERNAL_API_SECRET is set but header missing', async () => {
    ENV.INTERNAL_API_SECRET = 'secret';
    const { alertId } = await seed();
    const res = await ackPost(
      ackReq(alertId, 'x@y.z'),
      { params: Promise.resolve({ id: alertId }) },
    );
    expect(res.status).toBe(401);
  });

  it('401 when INTERNAL_API_SECRET is set but header wrong', async () => {
    ENV.INTERNAL_API_SECRET = 'secret';
    const { alertId } = await seed();
    const res = await ackPost(
      ackReq(alertId, 'x@y.z', { 'x-internal-secret': 'wrong' }),
      { params: Promise.resolve({ id: alertId }) },
    );
    expect(res.status).toBe(401);
  });

  it('accepts correct INTERNAL_API_SECRET via X-Internal-Secret header', async () => {
    ENV.INTERNAL_API_SECRET = 'secret';
    const { alertId } = await seed();
    const res = await ackPost(
      ackReq(alertId, 'x@y.z', { 'x-internal-secret': 'secret' }),
      { params: Promise.resolve({ id: alertId }) },
    );
    expect(res.status).toBe(200);
  });

  it('refuses 503 when NODE_ENV=production and INTERNAL_API_SECRET unset (fail safe)', async () => {
    ENV.NODE_ENV = 'production';
    delete ENV.INTERNAL_API_SECRET;
    const { alertId } = await seed();
    const res = await ackPost(
      ackReq(alertId, 'x@y.z'),
      { params: Promise.resolve({ id: alertId }) },
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('misconfigured');
  });
});

// ============================================================================
// GET /api/alerts
// ============================================================================

describe('GET /api/alerts', () => {
  it('returns recent alerts ordered newest first, limited and deterministic', async () => {
    const { db, schema: s } = await import('@/db');
    const accountId = newId('account');
    db.insert(s.accounts).values({ id: accountId, name: 'Acme' }).run();
    const ids: string[] = [];
    // 3 alerts at distinct millisecond timestamps
    for (let i = 0; i < 3; i++) {
      const id = newId('alert');
      db.insert(s.alerts).values({
        id, accountId, trigger: 'manual', severity: 'info',
        payloadJson: {}, channelsSentJson: [],
        createdAt: `2026-05-10T12:00:0${i}.000Z`,
      }).run();
      ids.push(id);
    }
    const res = await alertsGet(new Request('http://x/api/alerts'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerts).toHaveLength(3);
    // Newest first.
    expect(body.alerts.map((a: { id: string }) => a.id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it('filters open=1 to unacknowledged only', async () => {
    const { db, schema: s } = await import('@/db');
    const accountId = newId('account');
    db.insert(s.accounts).values({ id: accountId, name: 'Acme' }).run();
    const opened = newId('alert');
    const acked = newId('alert');
    db.insert(s.alerts).values({
      id: opened, accountId, trigger: 'manual', severity: 'info',
      payloadJson: {}, channelsSentJson: [],
      createdAt: '2026-05-10T12:00:00.000Z',
    }).run();
    db.insert(s.alerts).values({
      id: acked, accountId, trigger: 'manual', severity: 'info',
      payloadJson: {}, channelsSentJson: [],
      acknowledgedAt: '2026-05-10T12:00:01.000Z',
      acknowledgedBy: 'op@x.com',
      createdAt: '2026-05-10T12:00:00.000Z',
    }).run();
    const res = await alertsGet(new Request('http://x/api/alerts?open=1'));
    const body = await res.json();
    expect(body.alerts.map((a: { id: string }) => a.id)).toEqual([opened]);
  });

  it('filters accountId param to that account only', async () => {
    const { db, schema: s } = await import('@/db');
    const a = newId('account');
    const b = newId('account');
    db.insert(s.accounts).values({ id: a, name: 'A' }).run();
    db.insert(s.accounts).values({ id: b, name: 'B' }).run();
    const alertA = newId('alert');
    const alertB = newId('alert');
    db.insert(s.alerts).values({
      id: alertA, accountId: a, trigger: 'manual', severity: 'info',
      payloadJson: {}, channelsSentJson: [],
    }).run();
    db.insert(s.alerts).values({
      id: alertB, accountId: b, trigger: 'manual', severity: 'info',
      payloadJson: {}, channelsSentJson: [],
    }).run();
    const res = await alertsGet(new Request(`http://x/api/alerts?accountId=${a}`));
    const body = await res.json();
    expect(body.alerts.map((alert: { id: string }) => alert.id)).toEqual([alertA]);
  });

  it('401 when INTERNAL_API_SECRET set but header missing', async () => {
    ENV.INTERNAL_API_SECRET = 'secret';
    const res = await alertsGet(new Request('http://x/api/alerts'));
    expect(res.status).toBe(401);
  });

  it('503 when NODE_ENV=production and INTERNAL_API_SECRET unset', async () => {
    ENV.NODE_ENV = 'production';
    const res = await alertsGet(new Request('http://x/api/alerts'));
    expect(res.status).toBe(503);
  });
});
