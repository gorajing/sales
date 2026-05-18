import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schemaMod from '../../db/schema';

vi.mock('@/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schemaModInner = await import('../../db/schema');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const _dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: schemaModInner });
  migrate(db, { migrationsFolder: path.resolve(_dirname, '../../db/migrations') });
  return { db, schema: schemaModInner };
});

import { db } from '@/db';
import { newId } from '../../lib/id';
import { POST } from '../../app/api/engagement/route';

const ENV = { ...process.env };
beforeEach(() => {
  db.delete(schemaMod.engagementEvents).run();
  db.delete(schemaMod.touchRevisions).run();
  db.delete(schemaMod.touches).run();
  db.delete(schemaMod.sequences).run();
  db.delete(schemaMod.contacts).run();
  db.delete(schemaMod.accounts).run();
  delete process.env.ENGAGEMENT_WEBHOOK_SECRET;
});
afterEach(() => { process.env = { ...ENV }; });

function setupTouch(): { touchId: string; contactId: string } {
  const accountId = newId('account');
  db.insert(schemaMod.accounts).values({ id: accountId, name: 'Acme', domain: 'acme.com' }).run();
  const contactId = newId('contact');
  db.insert(schemaMod.contacts).values({
    id: contactId, accountId, fullName: 'X', email: 'x@acme.com',
  }).run();
  const sequenceId = newId('sequence');
  db.insert(schemaMod.sequences).values({ id: sequenceId, accountId }).run();
  const touchId = newId('touch');
  db.insert(schemaMod.touches).values({
    id: touchId, sequenceId, position: 1, channel: 'email',
  }).run();
  return { touchId, contactId };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://x/api/engagement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// --------------------------------------------------------------------------
// Happy path + idempotency
// --------------------------------------------------------------------------

describe('POST /api/engagement — ingest + idempotency', () => {
  it('creates an engagement event attached to a known touch', async () => {
    const { touchId, contactId } = setupTouch();
    const res = await POST(post({
      touchId, contactId, event_type: 'opened',
      external_id: 'sg_123', occurred_at: '2026-05-06T12:00:00.000Z',
    }));
    expect(res.status).toBe(200);
    const rows = db.select().from(schemaMod.engagementEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('opened');
    expect(rows[0].touchId).toBe(touchId);
  });

  it('is idempotent on duplicate external_id (webhook redelivery)', async () => {
    const { touchId, contactId } = setupTouch();
    const body = {
      touchId, contactId, event_type: 'opened',
      external_id: 'sg_dup', occurred_at: '2026-05-06T12:00:00.000Z',
    };
    const r1 = await POST(post(body));
    const r2 = await POST(post(body));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((await r1.json()).deduped).toBe(false);
    expect((await r2.json()).deduped).toBe(true);
    expect(db.select().from(schemaMod.engagementEvents).all()).toHaveLength(1);
  });

  it('attaches to a known CONTACT alone (no touch) — contact is a valid attach point', async () => {
    const { contactId } = setupTouch();
    const res = await POST(post({
      contactId, event_type: 'replied', occurred_at: '2026-05-06T12:00:00.000Z',
    }));
    expect(res.status).toBe(200);
    expect(db.select().from(schemaMod.engagementEvents).all()).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// Attach-or-fail (contract: must resolve to a known touch OR contact)
// --------------------------------------------------------------------------

describe('POST /api/engagement — attach-or-fail', () => {
  it('rejects an event with NEITHER touchId nor contactId (orphan, 400 not silent)', async () => {
    const res = await POST(post({
      event_type: 'opened', occurred_at: '2026-05-06T12:00:00.000Z',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/touch|contact|attach/i);
    expect(db.select().from(schemaMod.engagementEvents).all()).toHaveLength(0);
  });

  it('rejects a NONEXISTENT touchId clearly (400, not a 500 FK error)', async () => {
    const res = await POST(post({
      touchId: 'touch_does_not_exist', event_type: 'opened',
      occurred_at: '2026-05-06T12:00:00.000Z',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    // Codebase convention: { error: <stable machine code>, detail:
    // <human> }. Pin BOTH — a stable code AND a human detail that
    // names the offending touch (clear failure, not an opaque 500).
    expect(body.error).toBe('unattached_event');
    expect(body.detail).toMatch(/touch|not found|unknown/i);
    expect(db.select().from(schemaMod.engagementEvents).all()).toHaveLength(0);
  });

  it('rejects a NONEXISTENT contactId clearly (400)', async () => {
    const res = await POST(post({
      contactId: 'contact_nope', event_type: 'replied',
      occurred_at: '2026-05-06T12:00:00.000Z',
    }));
    expect(res.status).toBe(400);
    expect(db.select().from(schemaMod.engagementEvents).all()).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Timestamp contract — same canonical UTC-Z policy as evidence.captured_at
// --------------------------------------------------------------------------

describe('POST /api/engagement — timestamp contract', () => {
  it('normalizes a non-Z offset occurred_at to UTC-Z at the write boundary', async () => {
    const { touchId } = setupTouch();
    const res = await POST(post({
      touchId, event_type: 'clicked',
      // 05:00 at -07:00 == 12:00:00.000Z
      occurred_at: '2026-05-06T05:00:00.000-07:00',
    }));
    expect(res.status).toBe(200);
    const row = db.select().from(schemaMod.engagementEvents).all()[0];
    expect(row.occurredAt).toBe('2026-05-06T12:00:00.000Z');
  });

  it('rejects a far-future occurred_at (same skew guard as captured_at)', async () => {
    const { touchId } = setupTouch();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const res = await POST(post({
      touchId, event_type: 'opened', occurred_at: future,
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_payload');
  });

  it('rejects a date-only / offset-less occurred_at (shared ISO_DATETIME_WITH_OFFSET)', async () => {
    const { touchId } = setupTouch();
    for (const bad of ['2026-05-06', '2026-05-06T12:00:00']) {
      const res = await POST(post({
        touchId, event_type: 'opened', occurred_at: bad,
      }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_payload');
    }
  });
});

// --------------------------------------------------------------------------
// Webhook hardening — mirrors /api/signals
// --------------------------------------------------------------------------

describe('POST /api/engagement — webhook hardening', () => {
  it('unset secret in dev → permissive (200)', async () => {
    const { touchId } = setupTouch();
    const res = await POST(post({
      touchId, event_type: 'sent', occurred_at: '2026-05-06T12:00:00.000Z',
    }));
    expect(res.status).toBe(200);
  });

  it('secret set + missing/wrong X-Webhook-Secret → 401 (timing-safe compare)', async () => {
    process.env.ENGAGEMENT_WEBHOOK_SECRET = 'sekret';
    const { touchId } = setupTouch();
    const res = await POST(post(
      { touchId, event_type: 'sent', occurred_at: '2026-05-06T12:00:00.000Z' },
      { 'x-webhook-secret': 'wrong' },
    ));
    expect(res.status).toBe(401);
    expect(db.select().from(schemaMod.engagementEvents).all()).toHaveLength(0);
  });

  it('secret set + correct X-Webhook-Secret → 200', async () => {
    process.env.ENGAGEMENT_WEBHOOK_SECRET = 'sekret';
    const { touchId } = setupTouch();
    const res = await POST(post(
      { touchId, event_type: 'sent', occurred_at: '2026-05-06T12:00:00.000Z' },
      { 'x-webhook-secret': 'sekret' },
    ));
    expect(res.status).toBe(200);
  });

  it('invalid JSON → 400', async () => {
    const res = await POST(post('{not json'));
    expect(res.status).toBe(400);
  });

  it('wrong Content-Type → 415', async () => {
    const { touchId } = setupTouch();
    const res = await POST(new Request('http://x/api/engagement', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ touchId, event_type: 'sent', occurred_at: '2026-05-06T12:00:00.000Z' }),
    }));
    expect(res.status).toBe(415);
  });

  it('ZodError → 400 with issues (path+code), no .message leak', async () => {
    const { touchId } = setupTouch();
    const res = await POST(post({
      touchId, event_type: 'not_a_real_event', occurred_at: '2026-05-06T12:00:00.000Z',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues[0]).toHaveProperty('code');
    // No `.message` / `.received` reflection of user input.
    expect(JSON.stringify(body)).not.toMatch(/not_a_real_event/);
  });
});
