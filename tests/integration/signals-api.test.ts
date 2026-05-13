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

// Save and restore env between tests so secret-on/off and prod/dev cases
// don't bleed into each other.
const SAVED_ENV: Record<string, string | undefined> = {};
beforeEach(async () => {
  SAVED_ENV.SIGNAL_WEBHOOK_SECRET = process.env.SIGNAL_WEBHOOK_SECRET;
  SAVED_ENV.NODE_ENV = process.env.NODE_ENV;
  const { db, schema: s } = await import('@/db');
  db.delete(s.evidence).run();
  db.delete(s.contacts).run();
  db.delete(s.accounts).run();
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

import { POST } from '../../app/api/signals/route';

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'intent_data',
    account_domain: 'acme.com',
    signal_type: 'intent',
    fact: 'spike in vector-db keywords',
    source_url: 'https://bombora.example/x',
    snippet: 'Surge: vector database, weekly score 87',
    captured_at: '2026-05-06T12:00:00.000Z',
    ...overrides,
  };
}

function postReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://x/api/signals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function dbState() {
  const { db, schema: s } = await import('@/db');
  return {
    accounts: db.select().from(s.accounts).all(),
    contacts: db.select().from(s.contacts).all(),
    evidence: db.select().from(s.evidence).all(),
  };
}

// =============================================================================
// Auth: derive trustedSender from server-side state, never from request JSON.
// =============================================================================

describe('POST /api/signals — auth', () => {
  it('permissive mode (no SIGNAL_WEBHOOK_SECRET set): 200 but trustedSender=false', async () => {
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    const res = await POST(postReq(basePayload()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evidenceId).toMatch(/^ev_/);
    // Even though source is intent_data (in TRUSTED_SOURCES), unauthenticated
    // ingest cannot grant 'verified' — the trust two-factor requires both.
    const { evidence } = await dbState();
    expect(evidence[0].extractionStatus).toBe('pending_audit');
  });

  it('secret set + matching X-Webhook-Secret: 200 and trustedSender=true → verified for trusted source', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload(), { 'X-Webhook-Secret': 'shh' }));
    expect(res.status).toBe(200);
    const { evidence } = await dbState();
    expect(evidence[0].extractionStatus).toBe('verified');
  });

  it('secret set + missing header: 401 and no writes', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload()));
    expect(res.status).toBe(401);
    const { accounts, contacts, evidence } = await dbState();
    expect(accounts).toHaveLength(0);
    expect(contacts).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it('secret set + wrong header: 401 and no writes', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload(), { 'X-Webhook-Secret': 'wrong' }));
    expect(res.status).toBe(401);
    const { accounts, evidence } = await dbState();
    expect(accounts).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it('secret set + correct header is the ONLY way to get verified for a trusted source', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    // No header → 401
    const a = await POST(postReq(basePayload()));
    expect(a.status).toBe(401);
    // Wrong header → 401
    const b = await POST(postReq(basePayload(), { 'X-Webhook-Secret': 'guess' }));
    expect(b.status).toBe(401);
    // Right header → 200 + verified
    const c = await POST(postReq(basePayload(), { 'X-Webhook-Secret': 'shh' }));
    expect(c.status).toBe(200);
    const { evidence } = await dbState();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].extractionStatus).toBe('verified');
  });

  it('untrusted source remains pending_audit even when authenticated (trust two-factor)', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload({
      source: 'social_post', signal_type: 'trigger_event',
    }), { 'X-Webhook-Secret': 'shh' }));
    expect(res.status).toBe(200);
    const { evidence } = await dbState();
    expect(evidence[0].extractionStatus).toBe('pending_audit');
  });
});

// =============================================================================
// Body validation: invalid payloads, malformed JSON, captured_by impersonation.
// =============================================================================

describe('POST /api/signals — validation', () => {
  it('returns 400 on malformed JSON', async () => {
    const res = await POST(postReq('not-valid-json{', {}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_json');
    const { accounts, evidence } = await dbState();
    expect(accounts).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it('returns 400 on Zod-invalid payload (unknown source) and writes nothing', async () => {
    const res = await POST(postReq(basePayload({ source: 'tarot_reading' })));
    expect(res.status).toBe(400);
    const { accounts, evidence } = await dbState();
    expect(accounts).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it('returns 400 if request body sets captured_by (webhook callers cannot impersonate connectors)', async () => {
    const res = await POST(postReq(basePayload({ captured_by: 'connector_salesforce' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('captured_by_not_allowed');
    expect(body.detail).toMatch(/connector/i);
    const { accounts, evidence } = await dbState();
    expect(accounts).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it('returns 400 if request body sets captured_by="webhook" too (no captured_by allowed at all)', async () => {
    // Even setting captured_by to its eventual ingest value isn't allowed —
    // the route is the authority on producer identity.
    const res = await POST(postReq(basePayload({ captured_by: 'webhook' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('captured_by_not_allowed');
  });

  it('rejects connector-only source via the schema matrix (after captured_by stripping fails)', async () => {
    // Webhook caller cannot send source: 'crm_record' because the matrix in
    // SignalPayload requires a matching connector_* captured_by, but the
    // route refuses to accept any captured_by from external callers. So
    // crm_record from a webhook fails the matrix → 400.
    const res = await POST(postReq(basePayload({
      source: 'crm_record', signal_type: 'firmographic',
    })));
    expect(res.status).toBe(400);
    const { accounts, evidence } = await dbState();
    expect(accounts).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it('rejects whitespace-only account_domain (schema guard)', async () => {
    const res = await POST(postReq(basePayload({ account_domain: '   ' })));
    expect(res.status).toBe(400);
    const { accounts } = await dbState();
    expect(accounts).toHaveLength(0);
  });

  it('rejects javascript: URL in source_url (schema guard)', async () => {
    const res = await POST(postReq(basePayload({ source_url: 'javascript:alert(1)' })));
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// Behavior: happy paths, idempotency, and the IngestResult shape.
// =============================================================================

describe('POST /api/signals — behavior', () => {
  it('returns the IngestResult shape on success', async () => {
    const res = await POST(postReq(basePayload()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      accountId: expect.stringMatching(/^acc_/),
      contactId: null,
      evidenceId: expect.stringMatching(/^ev_/),
      capturedBy: 'webhook',
      deduped: false,
    });
  });

  it('is idempotent on duplicate POST (returns deduped: true)', async () => {
    const a = await POST(postReq(basePayload()));
    const b = await POST(postReq(basePayload()));
    const aBody = await a.json();
    const bBody = await b.json();
    expect(b.status).toBe(200);
    expect(bBody.evidenceId).toBe(aBody.evidenceId);
    expect(bBody.deduped).toBe(true);
    const { evidence } = await dbState();
    expect(evidence).toHaveLength(1);
  });

  it('upgrades pending_audit → verified across an unauthenticated then authenticated POST', async () => {
    // Step 1: post in permissive mode (secret unset) — lands as pending_audit.
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    const a = await POST(postReq(basePayload()));
    expect(a.status).toBe(200);
    const aBody = await a.json();
    let { evidence } = await dbState();
    expect(evidence[0].extractionStatus).toBe('pending_audit');

    // Step 2: turn auth on, re-post the same payload. Dedupe hit + trust upgrade.
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const b = await POST(postReq(basePayload(), { 'X-Webhook-Secret': 'shh' }));
    expect(b.status).toBe(200);
    const bBody = await b.json();
    expect(bBody.evidenceId).toBe(aBody.evidenceId);  // dedupe hit
    expect(bBody.deduped).toBe(true);

    ({ evidence } = await dbState());
    expect(evidence[0].extractionStatus).toBe('verified');  // upgraded in-place
  });

  it('the captured_by stored on the row is always "webhook" for this route, regardless of source', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload({
      source: 'web_traffic', signal_type: 'engagement',
      snippet: 'pricing page visit',
    }), { 'X-Webhook-Secret': 'shh' }));
    expect(res.status).toBe(200);
    const { evidence } = await dbState();
    expect(evidence[0].capturedBy).toBe('webhook');
  });
});

// =============================================================================
// Order: auth-before-parse-before-write must hold even when later checks would
// also reject. Locks the policy so a future refactor can't accidentally let an
// unauthenticated 400 leak about body shape.
// =============================================================================

describe('POST /api/signals — check order', () => {
  it('returns 401 (not 400) for malformed JSON when auth is missing', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq('not-valid-json{', {}));
    expect(res.status).toBe(401);
  });

  it('returns 401 (not 400) when body has captured_by but auth is missing', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload({ captured_by: 'connector_salesforce' })));
    expect(res.status).toBe(401);
    const { evidence } = await dbState();
    expect(evidence).toHaveLength(0);
  });

  it('returns 401 (not 400) for Zod-invalid payload when auth is missing', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload({ source: 'tarot_reading' })));
    expect(res.status).toBe(401);
  });

  it('returns 401 (not 415) for wrong content type when auth is missing', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload(), { 'Content-Type': 'text/plain' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 (not 413) for oversized body when auth is missing', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload(), {
      'Content-Length': '999999',
    }));
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// Production-config guard, content-type, body-size, header case-insensitivity.
// =============================================================================

describe('POST /api/signals — operational hardening', () => {
  // Next.js types mark process.env.NODE_ENV as readonly; bracket-assignment
  // through an unknown index sidesteps that without disabling type-checking
  // for the whole file.
  const setNodeEnv = (v: string | undefined) => {
    if (v === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string | undefined>).NODE_ENV = v;
  };

  it('refuses to serve in production when SIGNAL_WEBHOOK_SECRET is unset (503, fail safe)', async () => {
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    setNodeEnv('production');
    const res = await POST(postReq(basePayload()));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('misconfigured');
    const { accounts, evidence } = await dbState();
    expect(accounts).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it('serves permissively in non-production when SIGNAL_WEBHOOK_SECRET is unset', async () => {
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    setNodeEnv('test');  // anything not 'production'
    const res = await POST(postReq(basePayload()));
    expect(res.status).toBe(200);
  });

  it('rejects non-JSON content type with 415', async () => {
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    const res = await POST(postReq(basePayload(), { 'Content-Type': 'text/plain' }));
    expect(res.status).toBe(415);
  });

  it('accepts content-type with charset suffix (application/json; charset=utf-8)', async () => {
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    const res = await POST(postReq(basePayload(), {
      'Content-Type': 'application/json; charset=utf-8',
    }));
    expect(res.status).toBe(200);
  });

  it('rejects oversized body via Content-Length precheck (413)', async () => {
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    const res = await POST(postReq(basePayload(), { 'Content-Length': '99999999' }));
    expect(res.status).toBe(413);
  });

  it('rejects oversized body even when Content-Length is missing/wrong (post-read cap)', async () => {
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    // Build a body > 64KB by stuffing a long string into the snippet … wait,
    // the schema caps snippet at 1500 chars. Use a metadata blob that's
    // SCHEMA-valid (under the 8KB cap) padded with fake fields. Easier: send
    // raw bytes with no Content-Length header.
    const huge = 'a'.repeat(70_000);
    const req = new Request('http://x/api/signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' /* no content-length */ },
      body: huge,
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it('treats X-Webhook-Secret as case-insensitive (Fetch standard)', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload(), { 'x-webhook-secret': 'shh' }));
    expect(res.status).toBe(200);
  });

  it('uses timing-safe comparison: a wrong header of equal length still 401s', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const res = await POST(postReq(basePayload(), { 'X-Webhook-Secret': 'xxx' }));
    expect(res.status).toBe(401);
  });

  it('400 invalid_payload response includes path + code, NEVER user-echoed fields', async () => {
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    const res = await POST(postReq(basePayload({ source: 'tarot_reading' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
    expect(Array.isArray(body.issues)).toBe(true);
    for (const issue of body.issues) {
      expect(typeof issue.path).toBe('string');
      expect(typeof issue.code).toBe('string');
      // Critical: no fields that echo back user input.
      // .received echoes the rejected value; .message can echo bad key names
      // for unrecognized_keys ('Unrecognized key: "user_supplied_key"').
      expect('received' in issue).toBe(false);
      expect('input' in issue).toBe(false);
      expect('message' in issue).toBe(false);
    }
  });

  it('400 invalid_payload does not echo unrecognized key names from .strict()', async () => {
    // The classic reflection oracle: send an unknown field with a
    // suspicious name and confirm the route does not bounce it back.
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    const res = await POST(postReq({
      ...basePayload(),
      attacker_supplied_key_name: 'leak-me-back',
    }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('attacker_supplied_key_name');
    expect(text).not.toContain('leak-me-back');
  });

  it('rejects content-type that smuggles application/json after a primary type', async () => {
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    // 'text/plain; application/json' — a permissive .includes() check would
    // pass this; strict media-type parsing must not.
    const res = await POST(postReq(basePayload(), {
      'Content-Type': 'text/plain; application/json',
    }));
    expect(res.status).toBe(415);
  });

  it('streaming body cap: large payload is rejected before full buffer (413)', async () => {
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    // 200KB body, no honest Content-Length declared. The streaming reader
    // bails on the first chunk that crosses the 64KB cap.
    const huge = 'x'.repeat(200_000);
    const req = new Request('http://x/api/signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' /* no content-length */ },
      body: huge,
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it('body cap counts BYTES not UTF-16 code units (multi-byte payload)', async () => {
    // Regression guard against the bug class fixed in Task 2.3 round
    // 1 on the ack route — a `bodyText.length` check would let a
    // multi-byte payload through if the char count was under cap.
    // Build a body where UTF-8 bytes EXCEED 64KB but JS string
    // length stays under 64KB to prove the streaming reader counts
    // bytes. '日' is 3 bytes UTF-8 / 1 UTF-16 code unit, so 30000
    // chars → 90000 bytes UTF-8, ~30000 UTF-16 code units.
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    const multiByte = '日'.repeat(30_000);
    expect(multiByte.length).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(multiByte, 'utf8')).toBeGreaterThan(64 * 1024);
    const req = new Request('http://x/api/signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' /* no content-length */ },
      body: multiByte,
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });
});
