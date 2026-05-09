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

// Save and restore the SIGNAL_WEBHOOK_SECRET env between tests so secret-on
// and secret-off cases don't bleed into each other.
let savedSecret: string | undefined;

beforeEach(async () => {
  savedSecret = process.env.SIGNAL_WEBHOOK_SECRET;
  const { db, schema: s } = await import('@/db');
  db.delete(s.evidence).run();
  db.delete(s.contacts).run();
  db.delete(s.accounts).run();
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.SIGNAL_WEBHOOK_SECRET;
  else process.env.SIGNAL_WEBHOOK_SECRET = savedSecret;
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
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    // First post WITHOUT secret → 401, nothing written. Switch to permissive.
    delete process.env.SIGNAL_WEBHOOK_SECRET;
    const a = await POST(postReq(basePayload()));
    expect(a.status).toBe(200);
    const aBody = await a.json();
    let { evidence } = await dbState();
    expect(evidence[0].extractionStatus).toBe('pending_audit');

    // Now turn auth on and re-post the same payload. Trust upgrade kicks in.
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
