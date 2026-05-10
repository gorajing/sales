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

const SIGNAL_SECRET = 'test-signal-secret';

// Env preserved-and-restored per test so cases don't bleed.
const SAVED_ENV: Record<string, string | undefined> = {};

// Next.js types mark process.env.NODE_ENV as readonly; bracket-assignment
// through an unknown index sidesteps that without disabling type-checking
// for the whole file. Same pattern as tests/integration/signals-api.test.ts.
const ENV = process.env as Record<string, string | undefined>;

beforeEach(async () => {
  SAVED_ENV.SIGNAL_WEBHOOK_SECRET = ENV.SIGNAL_WEBHOOK_SECRET;
  SAVED_ENV.DEFAULT_OWNER_EMAIL = ENV.DEFAULT_OWNER_EMAIL;
  SAVED_ENV.INTERNAL_API_SECRET = ENV.INTERNAL_API_SECRET;
  SAVED_ENV.NODE_ENV = ENV.NODE_ENV;
  ENV.SIGNAL_WEBHOOK_SECRET = SIGNAL_SECRET;
  ENV.DEFAULT_OWNER_EMAIL = 'fallback@example.com';
  delete ENV.INTERNAL_API_SECRET;
  delete ENV.NODE_ENV;

  const { db, schema: s } = await import('@/db');
  db.delete(s.routingAssignments).run();
  db.delete(s.leadScores).run();
  db.delete(s.evidence).run();
  db.delete(s.contacts).run();
  db.delete(s.accounts).run();
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete ENV[k]; else ENV[k] = v;
  }
  vi.restoreAllMocks();
});

import { POST as postSignal } from '../../app/api/signals/route';
import { POST as postRecompute } from '../../app/api/scoring/recompute/route';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTING_PATH = resolve(process.cwd(), 'data/routing-rules.md');

function nowIso(): string { return new Date().toISOString(); }

function postSig(body: object) {
  return postSignal(new Request('http://x/api/signals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SIGNAL_SECRET },
    body: JSON.stringify(body),
  }));
}

function postRec(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://x/api/scoring/recompute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/scoring/recompute — happy path', () => {
  it('end-to-end: signal → recompute returns score, tier, and routing decision', async () => {
    const sig = await postSig({
      source: 'intent_data', account_domain: 'acme.com',
      signal_type: 'intent', fact: 'spike',
      source_url: 'https://bombora.example/x',
      // Snippet must verbatim contain the fact (substring validator runs at
      // ingest); fact is included in the snippet.
      snippet: 'Surge for acme: spike in vector-db intent (weekly 87)',
      // Relative timestamp so decay windows don't make this test brittle.
      captured_at: nowIso(),
    });
    expect(sig.status).toBe(200);
    const { accountId } = await sig.json();

    const rec = await postRecompute(postRec({ accountId }));
    expect(rec.status).toBe(200);
    const body = await rec.json();
    expect(body.scoreId).toBeTruthy();
    expect(body.score).toBeGreaterThan(0);
    expect(['cold', 'warm', 'hot', 'on_fire']).toContain(body.tier);
    expect(body.ownerEmail).toBeTruthy();
    expect(['rule_match', 'fallback_default']).toContain(body.reason);
    expect(body.rationale).toBeInstanceOf(Array);
    expect(body.alerts).toEqual([]);  // populated in Task 2.2
    expect(body.inserted).toBe(true);  // first recompute writes a new score row
  });

  it('is idempotent: same call twice returns the same scoreId and assignmentId', async () => {
    const sig = await postSig({
      source: 'intent_data', account_domain: 'acme.com',
      signal_type: 'intent', fact: 'spike',
      source_url: 'https://bombora.example/x',
      snippet: 'Surge: spike in vector-db keywords',
      captured_at: nowIso(),
    });
    const { accountId } = await sig.json();

    const a = await (await postRecompute(postRec({ accountId }))).json();
    const b = await (await postRecompute(postRec({ accountId }))).json();
    expect(b.scoreId).toBe(a.scoreId);
    expect(b.assignmentId).toBe(a.assignmentId);
    expect(b.inserted).toBe(false);  // short-circuited on fingerprint match
  });
});

describe('POST /api/scoring/recompute — input validation', () => {
  it('returns 400 on invalid JSON body', async () => {
    const rec = await postRecompute(postRec('{ not json'));
    expect(rec.status).toBe(400);
    const body = await rec.json();
    expect(body.error).toBe('invalid_json');
  });

  it('returns 400 with sanitized issue list on missing accountId', async () => {
    const rec = await postRecompute(postRec({}));
    expect(rec.status).toBe(400);
    const body = await rec.json();
    expect(body.error).toBe('invalid_body');
    // Each issue contains only { path, code } — no user-controlled message
    // string echoed back.
    expect(body.issues).toBeInstanceOf(Array);
    for (const issue of body.issues) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
    }
  });

  it('returns 400 when accountId is empty string', async () => {
    const rec = await postRecompute(postRec({ accountId: '' }));
    expect(rec.status).toBe(400);
  });

  it('returns 404 when accountId does not exist', async () => {
    const rec = await postRecompute(postRec({ accountId: 'acc_missing_xyz' }));
    expect(rec.status).toBe(404);
    const body = await rec.json();
    expect(body.error).toBe('account_not_found');
  });

  it('returns 415 on unsupported content-type', async () => {
    const req = new Request('http://x/api/scoring/recompute', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'plain text',
    });
    const rec = await postRecompute(req);
    expect(rec.status).toBe(415);
  });

  it('returns 413 when declared Content-Length exceeds cap', async () => {
    const req = new Request('http://x/api/scoring/recompute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(10 * 1024 * 1024),  // 10MB declared
      },
      body: JSON.stringify({ accountId: 'acc_x' }),
    });
    const rec = await postRecompute(req);
    expect(rec.status).toBe(413);
  });
});

describe('POST /api/scoring/recompute — auth + production guard', () => {
  it('returns 401 when INTERNAL_API_SECRET is set but header missing', async () => {
    ENV.INTERNAL_API_SECRET = 'secret-xyz';
    const rec = await postRecompute(postRec({ accountId: 'acc_x' }));
    expect(rec.status).toBe(401);
  });

  it('returns 401 when INTERNAL_API_SECRET is set but header wrong', async () => {
    ENV.INTERNAL_API_SECRET = 'secret-xyz';
    const rec = await postRecompute(postRec({ accountId: 'acc_x' }, {
      'X-Internal-Secret': 'wrong-secret',
    }));
    expect(rec.status).toBe(401);
  });

  it('accepts correct INTERNAL_API_SECRET via X-Internal-Secret header', async () => {
    ENV.INTERNAL_API_SECRET = 'secret-xyz';
    const sig = await postSig({
      source: 'intent_data', account_domain: 'acme.com',
      signal_type: 'intent', fact: 'spike',
      source_url: 'https://bombora.example/x',
      snippet: 'Surge: spike in vector-db',
      captured_at: nowIso(),
    });
    const { accountId } = await sig.json();
    const rec = await postRecompute(postRec({ accountId }, {
      'X-Internal-Secret': 'secret-xyz',
    }));
    expect(rec.status).toBe(200);
  });

  it('refuses with 503 when NODE_ENV=production and INTERNAL_API_SECRET unset', async () => {
    ENV.NODE_ENV = 'production';
    delete ENV.INTERNAL_API_SECRET;
    const rec = await postRecompute(postRec({ accountId: 'acc_x' }));
    expect(rec.status).toBe(503);
    const body = await rec.json();
    expect(body.error).toBe('misconfigured');
  });

  it('refuses with 503 when DEFAULT_OWNER_EMAIL is unset', async () => {
    delete ENV.DEFAULT_OWNER_EMAIL;
    const rec = await postRecompute(postRec({ accountId: 'acc_x' }));
    expect(rec.status).toBe(503);
    const body = await rec.json();
    expect(body.error).toBe('misconfigured');
  });

  it('refuses with 503 when DEFAULT_OWNER_EMAIL is malformed (not an email)', async () => {
    ENV.DEFAULT_OWNER_EMAIL = 'not-an-email';
    const rec = await postRecompute(postRec({ accountId: 'acc_x' }));
    expect(rec.status).toBe(503);
  });
});

describe('POST /api/scoring/recompute — body cap is bytes-based and streaming', () => {
  it('rejects bodies that exceed MAX_BODY_BYTES even when Content-Length is omitted', async () => {
    // A 64KB payload buried inside a JSON object. Content-Length header is
    // intentionally omitted to verify the streaming reader catches the
    // overflow rather than buffering the whole body first.
    const huge = 'x'.repeat(64 * 1024);
    const req = new Request('http://x/api/scoring/recompute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },  // no Content-Length
      body: JSON.stringify({ accountId: 'acc_x', filler: huge }),
    });
    const rec = await postRecompute(req);
    expect(rec.status).toBe(413);
  });
});

describe('POST /api/scoring/recompute — config validation is BEFORE account lookup', () => {
  // Persist a malformed routing-rules.md, ensure the handler returns 503
  // even when the account doesn't exist AND no lead_scores row is written.
  // Restoration runs in finally so a test crash doesn't leave a broken file.
  const ORIGINAL = readFileSync(ROUTING_PATH, 'utf8');
  afterEach(() => writeFileSync(ROUTING_PATH, ORIGINAL, 'utf8'));

  it('returns 503 (not 404) when routing-rules.md is malformed and accountId is unknown', async () => {
    writeFileSync(ROUTING_PATH, '## RR1 — broken\n- priority: 10\n', 'utf8');
    const rec = await postRecompute(postRec({ accountId: 'acc_missing' }));
    expect(rec.status).toBe(503);
    const body = await rec.json();
    expect(body.error).toBe('misconfigured');
  });

  it('writes no leadScore row when routing-rules.md is malformed even if account exists', async () => {
    const { db, schema: s } = await import('@/db');
    db.insert(s.accounts).values({ id: 'acc_real', name: 'Real Co' }).run();
    writeFileSync(ROUTING_PATH, '## RR1 — broken\n- priority: 10\n', 'utf8');
    const rec = await postRecompute(postRec({ accountId: 'acc_real' }));
    expect(rec.status).toBe(503);
    // Config validation must fire BEFORE computeScore, so no side effects:
    expect(db.select().from(s.leadScores).all()).toHaveLength(0);
    expect(db.select().from(s.routingAssignments).all()).toHaveLength(0);
  });
});

describe('POST /api/scoring/recompute — internal errors are sanitized', () => {
  it('returns 500 with no detail when an unexpected error throws inside the pipeline', async () => {
    // Account exists so we get past the 404 check, but mock computeScore to
    // throw an unexpected error. The handler must NOT echo the error message
    // in the response body — that would leak internals and would let an
    // attacker probe by passing inputs that influence the message.
    const { db, schema: s } = await import('@/db');
    db.insert(s.accounts).values({ id: 'acc_ok', name: 'Acme', domain: 'acme.com' }).run();

    const scoreMod = await import('../../lib/scoring/score');
    vi.spyOn(scoreMod, 'computeScore').mockRejectedValueOnce(
      new Error('SECRET DB FAILURE — should not appear in response'),
    );

    const rec = await postRecompute(postRec({ accountId: 'acc_ok' }));
    expect(rec.status).toBe(500);
    const body = await rec.json();
    expect(body.error).toBe('internal');
    expect(JSON.stringify(body)).not.toMatch(/SECRET DB FAILURE/);
  });
});
