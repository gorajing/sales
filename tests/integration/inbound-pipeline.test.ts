import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '../../db/schema';

// Force renderAlertText() to fall back to its deterministic template
// instead of shelling out to the Claude CLI. Integration tests must not
// depend on local Claude auth and must complete in milliseconds, not the
// 30s timeout window spawnClaude carries for real LLM calls. The
// deterministic fallback produces the same text shape every time, which
// is what these tests assert against (substrings + structure, not the
// LLM's specific wording).
vi.mock('../../lib/claude/run', () => ({
  spawnClaude: vi.fn(() => Promise.reject(new Error('test mock — force deterministic fallback'))),
  RateLimitError: class extends Error {},
  ClaudeError: class extends Error {},
}));

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

  // Delete in FK-dependency order: alerts → routing_assignments →
  // lead_scores → evidence → contacts → accounts. With alerts now
  // referencing accounts (Task 2.2 wiring), deleting accounts first
  // hits a FOREIGN KEY constraint and aborts beforeEach.
  const { db, schema: s } = await import('@/db');
  db.delete(s.alerts).run();
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
    expect(body.alerts).toBeInstanceOf(Array);
    // Task 2.2 wires alert dispatch. One intent signal → R1@20 → warm tier.
    // First-ever non-cold score → tier_promotion alert. Specific assertions
    // about alert dispatch behavior live in the "alert dispatch" suite below;
    // the happy path just verifies the field is the right shape.
    for (const a of body.alerts as Array<unknown>) {
      expect(a).toMatchObject({
        trigger: expect.any(String),
        alertId: expect.any(String),
        channelsSent: expect.any(Array),
      });
    }
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

  it('does NOT crash when the thrown error has a cyclic .cause chain', async () => {
    // Regression guard: formatError walks err.cause recursively to preserve
    // log context. Without a cycle check, `err.cause === err` (or any
    // back-reference) would infinite-recurse → stack overflow → handler
    // crashes BEFORE the catch fires, and the client sees a process-level
    // error instead of a clean 500. Verify the handler still returns the
    // sanitized 500 even with a worst-case cause cycle.
    const { db, schema: s } = await import('@/db');
    db.insert(s.accounts).values({ id: 'acc_cyc', name: 'Acme', domain: 'acme.com' }).run();

    const cyclic: Error & { cause?: unknown } = new Error('outer');
    cyclic.cause = cyclic;

    const scoreMod = await import('../../lib/scoring/score');
    vi.spyOn(scoreMod, 'computeScore').mockRejectedValueOnce(cyclic);

    const rec = await postRecompute(postRec({ accountId: 'acc_cyc' }));
    expect(rec.status).toBe(500);
    const body = await rec.json();
    expect(body.error).toBe('internal');
  });
});

// ============================================================================
// Task 2.2: alert dispatch integration. The dispatcher logic is unit-tested
// in tests/unit/alert-dispatch.test.ts; these tests verify the orchestrator
// correctly invokes the dispatchers, returns honest per-channel disposition
// in the response payload, and never lets an alert failure corrupt the
// score/routing recompute path.
// ============================================================================

describe('POST /api/scoring/recompute — alert dispatch (best-effort)', () => {
  it('dispatches a tier_promotion alert when score crosses thresholds', async () => {
    // 4 distinct intent signals → 4 × R1@20 (intent_data + signal_type=intent)
    // = 80 → on_fire tier. The recompute should fire a tier_promotion alert
    // because the account's first-ever score is non-cold.
    let accId = '';
    for (let i = 0; i < 4; i++) {
      const res = await postSig({
        source: 'intent_data', account_domain: 'on-fire.com',
        signal_type: 'intent', fact: `surge ${i}`,
        source_url: `https://bombora.example/${i}`,
        snippet: `surge ${i} weekly score 87`,
        captured_at: nowIso(),
      });
      accId = (await res.json()).accountId;
    }
    const rec = await postRecompute(postRec({ accountId: accId }));
    const body = await rec.json();
    expect(body.tier).toBe('on_fire');
    const tps = (body.alerts as Array<{ trigger: string }>)
      .filter((a) => a.trigger === 'tier_promotion');
    expect(tps).toHaveLength(1);
  });

  it('does NOT dispatch a duplicate tier_promotion on identical recompute', async () => {
    let accId = '';
    for (const s of ['a', 'b', 'c', 'd']) {
      accId = (await (await postSig({
        source: 'intent_data', account_domain: 'noop.com',
        signal_type: 'intent', fact: `evt ${s}`,
        source_url: `https://x.example/${s}`,
        snippet: `${s}-snippet identifying`,
        captured_at: nowIso(),
      })).json()).accountId;
    }
    const r1 = await (await postRecompute(postRec({ accountId: accId }))).json();
    const r2 = await (await postRecompute(postRec({ accountId: accId }))).json();
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);

    // r1 should have a tier_promotion alert. r2 should NOT — same scoreId,
    // same cooldown key → dispatcher returns null. Engagement-spike per-day
    // cooldown also prevents repeats, so r2.alerts is empty.
    const r1tp = (r1.alerts as Array<{ trigger: string }>)
      .filter((a) => a.trigger === 'tier_promotion');
    const r2tp = (r2.alerts as Array<{ trigger: string }>)
      .filter((a) => a.trigger === 'tier_promotion');
    expect(r1tp).toHaveLength(1);
    expect(r2tp).toHaveLength(0);
  });

  it('does NOT dispatch tier_promotion when first-ever score is cold', async () => {
    // We want a signal that ingests cleanly through the webhook (so we
    // can drive the full pipeline from the public boundary) but produces
    // a SCORE of 0 (cold tier). The trick: use a trusted source whose
    // signal_type doesn't match any scoring rule's signal_type clause.
    // `intent_data` + signal_type `engagement` is verified-eligible but
    // R1 only fires for signal_type `intent`. No other rule matches a
    // bare intent_data. Result: score=0, tier=cold, score row inserted.
    const sigRes = await postSig({
      source: 'intent_data', account_domain: 'cold-only.example',
      signal_type: 'engagement', fact: 'noise',
      source_url: 'https://bombora.example/noise',
      snippet: 'noise signal that no rule matches',
      captured_at: nowIso(),
    });
    if (sigRes.status !== 200) {
      throw new Error(`signal ingest failed: ${sigRes.status} ${JSON.stringify(await sigRes.json())}`);
    }
    const accId = (await sigRes.json()).accountId;
    const recRes = await postRecompute(postRec({ accountId: accId }));
    if (recRes.status !== 200) {
      throw new Error(`recompute failed: ${recRes.status} ${JSON.stringify(await recRes.json())}`);
    }
    const r = await recRes.json();
    expect(r.score).toBe(0);
    expect(r.tier).toBe('cold');
    expect(r.inserted).toBe(true);
    // CRITICAL: first-ever cold must NOT fire tier_promotion. This is the
    // detectTierPromotion(undefined, 'cold') → null contract from Task 2.1.
    const tps = (r.alerts as Array<{ trigger: string }>)
      .filter((a) => a.trigger === 'tier_promotion');
    expect(tps).toEqual([]);
  });

  it('fires engagement_spike when ≥3 engagement signals arrive even if score fingerprint did not change', async () => {
    // Regression guard: alert dispatch must NOT be gated by
    // score.inserted for engagement_spike. We arrange the second
    // recompute to have inserted=false (score did not change) and still
    // fire the spike — proving we're not relying on score-state as the
    // trigger.
    //
    // We use `source: intent_data` + `signal_type: engagement` so the
    // signals (a) ingest cleanly through the webhook (intent_data is a
    // webhook-eligible source, not connector-only), (b) land as
    // `verified` (intent_data is in TRUSTED_SOURCES and we're
    // authenticated), and (c) don't match any scoring rule (R1 needs
    // signal_type='intent', the others need different source types).
    // Net: score stays 0 across recomputes; signals still count toward
    // the engagement spike (signal_type='engagement' is in
    // ENGAGEMENT_LIKE_SIGNAL_TYPES).
    const seed = await (await postSig({
      source: 'intent_data', account_domain: 'engagement-spike.example',
      contact_email: 'c0@engagement-spike.example',
      signal_type: 'engagement', fact: 'seed signal',
      source_url: 'https://bombora.example/event/seed',
      snippet: 'id=seed type=email_open',
      captured_at: nowIso(),
    })).json();
    const accId = seed.accountId;

    // Seed recompute — first row, cold (no scoring rule matched).
    // MUST NOT fire tier_promotion (first-ever cold). MUST NOT fire
    // spike yet (only 1 signal in window; threshold is 3).
    const seedRecompute = await (await postRecompute(postRec({ accountId: accId }))).json();
    expect(seedRecompute.inserted).toBe(true);
    expect(seedRecompute.score).toBe(0);
    expect(seedRecompute.tier).toBe('cold');
    expect((seedRecompute.alerts as Array<{ trigger: string }>)
      .filter((a) => a.trigger === 'tier_promotion')).toEqual([]);
    expect((seedRecompute.alerts as Array<{ trigger: string }>)
      .filter((a) => a.trigger === 'engagement_spike')).toEqual([]);

    // Post 2 more (totaling 3 in the 24h spike window). Each has a
    // unique snippet/source_url so dedupe-key doesn't merge them.
    for (const i of [1, 2]) {
      await postSig({
        source: 'intent_data', account_domain: 'engagement-spike.example',
        contact_email: `c${i}@engagement-spike.example`,
        signal_type: 'engagement', fact: `signal ${i}`,
        source_url: `https://bombora.example/event/${i}`,
        snippet: `id=${i} type=email_open distinct snippet`,
        captured_at: nowIso(),
      });
    }

    const r = await (await postRecompute(postRec({ accountId: accId }))).json();
    expect(r.inserted).toBe(false);  // same fingerprint (no rule matched any signal)
    expect(r.score).toBe(0);
    const spikes = (r.alerts as Array<{ trigger: string }>)
      .filter((a) => a.trigger === 'engagement_spike');
    expect(spikes).toHaveLength(1);
  });

  it('serializes concurrent recomputes — same scoreId, at most one tier_promotion across responses', async () => {
    const accId = (await (await postSig({
      source: 'intent_data', account_domain: 'race-recompute.com',
      signal_type: 'intent', fact: 'race',
      source_url: 'https://x.example/race',
      snippet: 'race-snippet-recompute',
      captured_at: nowIso(),
    })).json()).accountId;
    const recompute = () => postRecompute(postRec({ accountId: accId }));
    const [a, b, c] = await Promise.all([recompute(), recompute(), recompute()]);
    const ja = await a.json();
    const jb = await b.json();
    const jc = await c.json();
    expect(new Set([ja.scoreId, jb.scoreId, jc.scoreId]).size).toBe(1);
    const totalTps = [ja, jb, jc]
      .flatMap((j) => (j.alerts as Array<{ trigger: string }>) ?? [])
      .filter((a) => a.trigger === 'tier_promotion');
    expect(totalTps.length).toBeLessThanOrEqual(1);
  });

  it('best-effort: alert dispatch throw does NOT fail recompute (score/route still committed, alerts: [])', async () => {
    // The user's risk #2 codified as a regression test. Mock
    // dispatchTierPromotion to throw (e.g. simulating a SQLITE_BUSY on the
    // reserve step). The recompute MUST still return 200 with score +
    // routing committed; the alerts array is empty; the score row exists.
    const accId = (await (await postSig({
      source: 'intent_data', account_domain: 'flaky-alerts.com',
      signal_type: 'intent', fact: 'a',
      source_url: 'https://x.example/a',
      snippet: 'flaky-alert-snippet',
      captured_at: nowIso(),
    })).json()).accountId;
    // Add 3 more so we're definitely on_fire (would normally fire alert).
    for (let i = 1; i < 4; i++) {
      await postSig({
        source: 'intent_data', account_domain: 'flaky-alerts.com',
        signal_type: 'intent', fact: `b${i}`,
        source_url: `https://x.example/b${i}`,
        snippet: `flaky-alert-snippet-${i}`,
        captured_at: nowIso(),
      });
    }
    const alertsMod = await import('../../lib/alerts/dispatch');
    vi.spyOn(alertsMod, 'dispatchTierPromotion').mockRejectedValueOnce(
      new Error('SIMULATED dispatch failure'),
    );
    vi.spyOn(alertsMod, 'dispatchEngagementSpike').mockRejectedValueOnce(
      new Error('SIMULATED dispatch failure'),
    );

    const rec = await postRecompute(postRec({ accountId: accId }));
    expect(rec.status).toBe(200);
    const body = await rec.json();
    expect(body.tier).toBe('on_fire');
    expect(body.assignmentId).toBeTruthy();
    expect(body.alerts).toEqual([]);  // both dispatches threw → dropped

    // Score row is committed regardless of alert failure.
    const { db, schema: s } = await import('@/db');
    const scores = db.select().from(s.leadScores).all();
    expect(scores.some((r) => r.accountId === accId)).toBe(true);
  });

  it('response carries per-channel disposition (channel="file" when no env vars set)', async () => {
    // Risk #6: response payload must NOT overstate alert success. With
    // SLACK_WEBHOOK_URL unset (the default in beforeEach), the channel
    // function falls back to file delivery and records channel='file'.
    // The response should reflect that.
    let accId = '';
    for (let i = 0; i < 4; i++) {
      accId = (await (await postSig({
        source: 'intent_data', account_domain: 'channel-honesty.com',
        signal_type: 'intent', fact: `s${i}`,
        source_url: `https://x.example/${i}`,
        snippet: `channel-honesty-snippet-${i}`,
        captured_at: nowIso(),
      })).json()).accountId;
    }
    const r = await (await postRecompute(postRec({ accountId: accId }))).json();
    const tps = (r.alerts as Array<{ trigger: string; channelsSent: Array<{ channel: string; ok: boolean }> }>)
      .filter((a) => a.trigger === 'tier_promotion');
    expect(tps).toHaveLength(1);
    expect(tps[0].channelsSent.length).toBeGreaterThan(0);
    // No env vars set → every delivery is 'file', not 'slack'.
    expect(tps[0].channelsSent.every((c) => c.channel === 'file')).toBe(true);
  });
});
