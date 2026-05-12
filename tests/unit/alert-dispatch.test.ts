import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schemaMod from '../../db/schema';

// Force renderAlertText() to fall back to its deterministic template
// instead of shelling out to the Claude CLI. The dispatcher's tests are
// about reservation / cooldown / channel honesty — not LLM output — and
// real LLM calls would make the test slow and dependent on local auth.
vi.mock('../../lib/claude/run', () => ({
  spawnClaude: vi.fn(() => Promise.reject(new Error('test mock — force deterministic fallback'))),
  RateLimitError: class extends Error {},
  ClaudeError: class extends Error {},
}));

// node:fs is mocked with importActual so the channel modules' file fallback
// uses the real fs by default, but specific tests can override
// writeFileSync (or mkdirSync) per-test via vi.mocked(...).mockImplementationOnce
// to simulate disk-failure paths. ESM module namespaces aren't directly
// spyable; vi.mock is the only reliable approach.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});

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
import {
  detectTierPromotion,
  dispatchTierPromotion,
  dispatchEngagementSpike,
} from '../../lib/alerts/dispatch';

const ENV = process.env as Record<string, string | undefined>;
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  SAVED_ENV.SLACK_WEBHOOK_URL = ENV.SLACK_WEBHOOK_URL;
  SAVED_ENV.GENERIC_WEBHOOK_URL = ENV.GENERIC_WEBHOOK_URL;
  delete ENV.SLACK_WEBHOOK_URL;  // force file-fallback by default
  delete ENV.GENERIC_WEBHOOK_URL;

  db.delete(schemaMod.alerts).run();
  db.delete(schemaMod.evidence).run();
  db.delete(schemaMod.leadScores).run();
  db.delete(schemaMod.accounts).run();
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete ENV[k]; else ENV[k] = v;
  }
  vi.restoreAllMocks();
});

function insAccount(name = 'Acme'): string {
  const id = newId('account');
  db.insert(schemaMod.accounts).values({ id, name }).run();
  return id;
}

function insScore(accountId: string, score: number, tier: 'cold' | 'warm' | 'hot' | 'on_fire'): string {
  const id = newId('leadScore');
  db.insert(schemaMod.leadScores).values({
    id, accountId, score, tier, fingerprint: `fp_${id}`, rationaleJson: [],
  }).run();
  return id;
}

// ============================================================================
// detectTierPromotion — pure function
// ============================================================================

describe('detectTierPromotion', () => {
  it('returns null when prior tier equals new tier', () => {
    expect(detectTierPromotion('warm', 'warm')).toBeNull();
    expect(detectTierPromotion('cold', 'cold')).toBeNull();
    expect(detectTierPromotion('on_fire', 'on_fire')).toBeNull();
  });

  it('returns the new tier when promoted', () => {
    expect(detectTierPromotion('cold', 'warm')).toBe('warm');
    expect(detectTierPromotion('warm', 'hot')).toBe('hot');
    expect(detectTierPromotion('hot', 'on_fire')).toBe('on_fire');
    expect(detectTierPromotion('cold', 'on_fire')).toBe('on_fire');
  });

  it('returns null on demotion', () => {
    expect(detectTierPromotion('hot', 'warm')).toBeNull();
    expect(detectTierPromotion('on_fire', 'cold')).toBeNull();
    expect(detectTierPromotion('warm', 'cold')).toBeNull();
  });

  it('returns the new tier when prior is undefined and not cold (first-ever non-cold score)', () => {
    expect(detectTierPromotion(undefined, 'warm')).toBe('warm');
    expect(detectTierPromotion(undefined, 'hot')).toBe('hot');
    expect(detectTierPromotion(undefined, 'on_fire')).toBe('on_fire');
  });

  it('returns null on first-ever cold score (nothing to announce)', () => {
    expect(detectTierPromotion(undefined, 'cold')).toBeNull();
  });
});

// ============================================================================
// dispatchTierPromotion — reserve-then-send + cooldown + channel honesty
// ============================================================================

describe('dispatchTierPromotion — reserve-then-send', () => {
  it('returns null and writes nothing when there is no promotion (warm → warm)', async () => {
    const accountId = insAccount();
    const scoreId = insScore(accountId, 30, 'warm');
    const r = await dispatchTierPromotion(accountId, 'warm', 'warm', scoreId);
    expect(r).toBeNull();
    expect(db.select().from(schemaMod.alerts).all()).toHaveLength(0);
  });

  it('returns null on demotion', async () => {
    const accountId = insAccount();
    const scoreId = insScore(accountId, 10, 'cold');
    const r = await dispatchTierPromotion(accountId, 'hot', 'cold', scoreId);
    expect(r).toBeNull();
    expect(db.select().from(schemaMod.alerts).all()).toHaveLength(0);
  });

  it('inserts alert row FIRST, then sends; concurrent calls dispatch only once', async () => {
    // Per the user's strict-bar item: reserve-before-send means the alert
    // row exists before any external delivery. Concurrent dispatches for
    // the same (account, scoreId) must produce exactly ONE row, with the
    // losers returning null (skip; the unique cooldownKey rejected them).
    //
    // Note: under single-process synchronous better-sqlite3, Promise.all
    // doesn't truly interleave the inserts — it serializes them on the
    // event loop. The test still verifies the contract: if the loser sees
    // the winner's committed row, the unique-violation catch fires and
    // returns null. See docs/architecture.md "Deployment assumptions" for
    // multi-process behavior.
    const accountId = insAccount('Race Co');
    const scoreId = insScore(accountId, 80, 'on_fire');

    const results = await Promise.all([
      dispatchTierPromotion(accountId, 'warm', 'on_fire', scoreId),
      dispatchTierPromotion(accountId, 'warm', 'on_fire', scoreId),
      dispatchTierPromotion(accountId, 'warm', 'on_fire', scoreId),
    ]);
    const wins = results.filter((r) => r !== null);
    expect(wins).toHaveLength(1);

    const rows = db.select().from(schemaMod.alerts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe('tier_promotion');
    expect(rows[0].severity).toBe('urgent');  // on_fire → urgent
    expect(rows[0].cooldownKey).toBe(`tier_promotion:${accountId}:${scoreId}`);
  });

  it('uses severity=priority for non-on_fire promotions', async () => {
    const accountId = insAccount();
    const scoreId = insScore(accountId, 40, 'hot');
    const r = await dispatchTierPromotion(accountId, 'warm', 'hot', scoreId);
    expect(r).not.toBeNull();
    const rows = db.select().from(schemaMod.alerts).all();
    expect(rows[0].severity).toBe('priority');
  });

  it('records channel="file" when SLACK_WEBHOOK_URL is unset (fallback honesty)', async () => {
    const accountId = insAccount();
    const scoreId = insScore(accountId, 50, 'hot');
    const r = await dispatchTierPromotion(accountId, 'warm', 'hot', scoreId);
    expect(r).not.toBeNull();
    const channels = r!.channelsSent;
    expect(channels).toHaveLength(1);
    // SLACK_WEBHOOK_URL is unset → channel must be 'file', NOT pretend
    // to be 'slack'. This is the user's "fallback channel honesty" bar.
    expect(channels[0].channel).toBe('file');
    expect(channels[0].ok).toBe(true);

    // Persisted row reflects the same.
    const rows = db.select().from(schemaMod.alerts).all();
    expect(rows[0].channelsSentJson[0].channel).toBe('file');
  });

  it('records channel="slack" when SLACK_WEBHOOK_URL is set and fetch succeeds', async () => {
    ENV.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/services/xxx';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const accountId = insAccount();
    const scoreId = insScore(accountId, 50, 'hot');
    const r = await dispatchTierPromotion(accountId, 'warm', 'hot', scoreId);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://hooks.slack.test/services/xxx');
    expect(init?.method).toBe('POST');

    const channels = r!.channelsSent;
    expect(channels[0].channel).toBe('slack');
    expect(channels[0].ok).toBe(true);
  });

  it('records ok=false when Slack endpoint returns non-2xx (and still recorded in DB)', async () => {
    ENV.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/services/broken';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429 }),
    );

    const accountId = insAccount();
    const scoreId = insScore(accountId, 50, 'hot');
    const r = await dispatchTierPromotion(accountId, 'warm', 'hot', scoreId);

    expect(r!.channelsSent[0].channel).toBe('slack');
    expect(r!.channelsSent[0].ok).toBe(false);
    expect(r!.channelsSent[0].detail).toMatch(/429/);

    // Failed delivery still writes the row — operator must SEE the
    // failure on /alerts, not have it silently disappear.
    const rows = db.select().from(schemaMod.alerts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].channelsSentJson[0].ok).toBe(false);
  });

  it('records channel="slack" + ok=false when fetch() rejects (network/DNS error)', async () => {
    // Network-layer failure — fetch throws instead of resolving with a
    // non-2xx response. The dispatcher's per-channel try/catch must
    // capture this as { channel: 'slack', ok: false } so the audit row
    // shows where the failure actually happened. NOT 'file' — we never
    // tried the file path; the URL was set.
    ENV.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/dead';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connect ETIMEDOUT 127.0.0.1:443'),
    );

    const accountId = insAccount();
    const scoreId = insScore(accountId, 50, 'hot');
    const r = await dispatchTierPromotion(accountId, 'warm', 'hot', scoreId);

    expect(r!.channelsSent[0].channel).toBe('slack');
    expect(r!.channelsSent[0].ok).toBe(false);
    expect(r!.channelsSent[0].detail).toMatch(/ETIMEDOUT/);
    // Row persisted with the honest failure.
    const rows = db.select().from(schemaMod.alerts).all();
    expect(rows[0].channelsSentJson[0]).toMatchObject({ channel: 'slack', ok: false });
  });

  it('records channel="file" + ok=false when the file fallback write throws (NOT "slack")', async () => {
    // SLACK_WEBHOOK_URL is unset → channel function tries file
    // fallback. If writeFileSync throws (disk full, perms), the
    // disposition MUST be channel: 'file' + ok: false — not
    // channel: 'slack', which would lie about a network call that
    // was never even attempted. The fix lives inside each channel
    // function so the dispatcher's catch can never misattribute.
    const fs = await import('node:fs');
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    const accountId = insAccount();
    const scoreId = insScore(accountId, 50, 'hot');
    const r = await dispatchTierPromotion(accountId, 'warm', 'hot', scoreId);

    expect(r!.channelsSent[0].channel).toBe('file');
    expect(r!.channelsSent[0].ok).toBe(false);
    expect(r!.channelsSent[0].detail).toMatch(/ENOSPC/);
    // Honest delivery state survives to the DB.
    const rows = db.select().from(schemaMod.alerts).all();
    expect(rows[0].channelsSentJson[0]).toMatchObject({ channel: 'file', ok: false });
  });

  it('on_fire fires BOTH slack and email channels (severity=urgent escalation)', async () => {
    const accountId = insAccount();
    const scoreId = insScore(accountId, 90, 'on_fire');
    const r = await dispatchTierPromotion(accountId, 'hot', 'on_fire', scoreId);
    expect(r!.channelsSent.length).toBe(2);
    // No env vars set → both fall back to 'file'.
    expect(r!.channelsSent.every((c) => c.channel === 'file')).toBe(true);
  });

  it('on_fire email file-write failure is honestly recorded (channel="file" + ok=false)', async () => {
    // Email has no v1 SMTP; the file fallback is the only path. If
    // writeFileSync fails (perms, disk), the email channel function
    // owns the catch and returns channel='file', ok=false — same
    // honesty contract as the slack file-fallback path. Mock the second
    // writeFileSync call (slack succeeds, email fails).
    const fs = await import('node:fs');
    vi.mocked(fs.writeFileSync)
      .mockImplementationOnce(() => undefined)  // slack OK
      .mockImplementationOnce(() => { throw new Error('EROFS: read-only file system'); });
    const accountId = insAccount();
    const scoreId = insScore(accountId, 95, 'on_fire');
    const r = await dispatchTierPromotion(accountId, 'hot', 'on_fire', scoreId);
    expect(r!.channelsSent).toHaveLength(2);
    expect(r!.channelsSent[0]).toMatchObject({ channel: 'file', ok: true });  // slack
    expect(r!.channelsSent[1]).toMatchObject({ channel: 'file', ok: false }); // email
    expect(r!.channelsSent[1].detail).toMatch(/EROFS/);
  });

  it('persists rendered text into payloadJson after delivery (so /alerts can show it)', async () => {
    const accountId = insAccount('Acme Corp');
    const scoreId = insScore(accountId, 50, 'hot');
    await dispatchTierPromotion(accountId, 'warm', 'hot', scoreId);
    const row = db.select().from(schemaMod.alerts).all()[0];
    expect(row.payloadJson).toMatchObject({ scoreId, toTier: 'hot' });
    // Rendered text added on the post-send update step. The mock makes
    // renderAlertText fall through to its deterministic template.
    expect((row.payloadJson as Record<string, unknown>).text).toMatch(/Acme Corp/);
  });
});

// ============================================================================
// dispatchEngagementSpike — windowed detection + day-bucket cooldown
// ============================================================================

function insSignal(accountId: string, capturedAt: string, signalType: 'intent' | 'engagement' | 'trigger_event' = 'engagement') {
  db.insert(schemaMod.evidence).values({
    id: newId('evidence'),
    accountId,
    sourceUrl: 'https://x.example/',
    sourceType: 'manual',
    snippet: 'test signal',
    extractedFact: 'engagement event',
    capturedBy: 'manual',
    capturedAt,
    extractionStatus: 'verified',  // only verified evidence counts
    signalType,
  }).run();
}

describe('dispatchEngagementSpike', () => {
  it('returns null below threshold (default: 3 in 24h)', async () => {
    const accountId = insAccount();
    const now = new Date('2026-05-10T12:00:00.000Z');
    insSignal(accountId, '2026-05-10T11:00:00.000Z');
    insSignal(accountId, '2026-05-10T10:00:00.000Z');
    const r = await dispatchEngagementSpike(accountId, now);
    expect(r).toBeNull();
    expect(db.select().from(schemaMod.alerts).all()).toHaveLength(0);
  });

  it('fires at threshold (3 engagement-like signals in window)', async () => {
    const accountId = insAccount();
    const now = new Date('2026-05-10T12:00:00.000Z');
    insSignal(accountId, '2026-05-10T11:00:00.000Z');
    insSignal(accountId, '2026-05-10T10:00:00.000Z');
    insSignal(accountId, '2026-05-10T09:00:00.000Z');
    const r = await dispatchEngagementSpike(accountId, now);
    expect(r).not.toBeNull();
    const rows = db.select().from(schemaMod.alerts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe('engagement_spike');
    expect(rows[0].severity).toBe('priority');
  });

  it('ignores non-engagement signal types', async () => {
    const accountId = insAccount();
    const now = new Date('2026-05-10T12:00:00.000Z');
    // firmographic signals: not "engagement-like," should NOT count.
    insSignal(accountId, '2026-05-10T11:00:00.000Z', 'engagement');
    db.insert(schemaMod.evidence).values({
      id: newId('evidence'), accountId,
      sourceUrl: 'https://x.example/', sourceType: 'manual',
      snippet: 'firmographic', extractedFact: 'company size update',
      capturedBy: 'manual', capturedAt: '2026-05-10T10:00:00.000Z',
      extractionStatus: 'verified', signalType: 'firmographic',
    }).run();
    db.insert(schemaMod.evidence).values({
      id: newId('evidence'), accountId,
      sourceUrl: 'https://x.example/', sourceType: 'manual',
      snippet: 'firmographic', extractedFact: 'company size update',
      capturedBy: 'manual', capturedAt: '2026-05-10T09:00:00.000Z',
      extractionStatus: 'verified', signalType: 'firmographic',
    }).run();
    const r = await dispatchEngagementSpike(accountId, now);
    expect(r).toBeNull();
  });

  it('ignores unverified signals (extraction_status != verified)', async () => {
    const accountId = insAccount();
    const now = new Date('2026-05-10T12:00:00.000Z');
    insSignal(accountId, '2026-05-10T11:00:00.000Z');
    // Pending: should not count toward spike threshold.
    db.insert(schemaMod.evidence).values({
      id: newId('evidence'), accountId,
      sourceUrl: 'https://x.example/', sourceType: 'manual',
      snippet: 'pending', extractedFact: 'fact',
      capturedBy: 'manual', capturedAt: '2026-05-10T10:00:00.000Z',
      extractionStatus: 'pending_audit', signalType: 'engagement',
    }).run();
    db.insert(schemaMod.evidence).values({
      id: newId('evidence'), accountId,
      sourceUrl: 'https://x.example/', sourceType: 'manual',
      snippet: 'pending', extractedFact: 'fact',
      capturedBy: 'manual', capturedAt: '2026-05-10T09:00:00.000Z',
      extractionStatus: 'pending_audit', signalType: 'engagement',
    }).run();
    const r = await dispatchEngagementSpike(accountId, now);
    expect(r).toBeNull();
  });

  it('ignores signals outside the time window', async () => {
    const accountId = insAccount();
    const now = new Date('2026-05-10T12:00:00.000Z');
    // 25 hours ago — outside 24h window.
    insSignal(accountId, '2026-05-09T10:00:00.000Z');
    insSignal(accountId, '2026-05-10T11:00:00.000Z');
    insSignal(accountId, '2026-05-10T10:00:00.000Z');
    const r = await dispatchEngagementSpike(accountId, now);
    expect(r).toBeNull();  // only 2 in window
  });

  it('respects cooldown: same day → second dispatch returns null', async () => {
    const accountId = insAccount();
    const now = new Date('2026-05-10T12:00:00.000Z');
    insSignal(accountId, '2026-05-10T11:00:00.000Z');
    insSignal(accountId, '2026-05-10T10:00:00.000Z');
    insSignal(accountId, '2026-05-10T09:00:00.000Z');
    const a = await dispatchEngagementSpike(accountId, now);
    const b = await dispatchEngagementSpike(accountId, new Date('2026-05-10T23:00:00.000Z'));
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(db.select().from(schemaMod.alerts).all()).toHaveLength(1);
  });

  it('day rollover: next UTC day → fresh alert allowed', async () => {
    const accountId = insAccount();
    insSignal(accountId, '2026-05-10T11:00:00.000Z');
    insSignal(accountId, '2026-05-10T10:00:00.000Z');
    insSignal(accountId, '2026-05-10T09:00:00.000Z');
    // Day 1: fire.
    const a = await dispatchEngagementSpike(accountId, new Date('2026-05-10T12:00:00.000Z'));
    expect(a).not.toBeNull();
    // Day 2: add a fresh batch in the new 24h window, fire again.
    insSignal(accountId, '2026-05-11T00:00:00.000Z');
    insSignal(accountId, '2026-05-11T01:00:00.000Z');
    insSignal(accountId, '2026-05-11T02:00:00.000Z');
    const b = await dispatchEngagementSpike(accountId, new Date('2026-05-11T03:00:00.000Z'));
    expect(b).not.toBeNull();
    expect(db.select().from(schemaMod.alerts).all()).toHaveLength(2);
  });

  it('records channel="file" when SLACK_WEBHOOK_URL is unset', async () => {
    const accountId = insAccount();
    const now = new Date('2026-05-10T12:00:00.000Z');
    insSignal(accountId, '2026-05-10T11:00:00.000Z');
    insSignal(accountId, '2026-05-10T10:00:00.000Z');
    insSignal(accountId, '2026-05-10T09:00:00.000Z');
    const r = await dispatchEngagementSpike(accountId, now);
    expect(r!.channelsSent[0].channel).toBe('file');
  });

  it('records channel="slack" + ok=false when fetch rejects during engagement_spike dispatch', async () => {
    // Engagement-spike has its own SEND catch (separate from
    // dispatchTierPromotion); the fetch-throws coverage on
    // tier_promotion doesn't exercise it. Mock fetch to reject under
    // spike conditions and verify the delivery records the network
    // failure honestly.
    ENV.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/dead';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const accountId = insAccount();
    const now = new Date('2026-05-10T12:00:00.000Z');
    insSignal(accountId, '2026-05-10T11:00:00.000Z');
    insSignal(accountId, '2026-05-10T10:00:00.000Z');
    insSignal(accountId, '2026-05-10T09:00:00.000Z');
    const r = await dispatchEngagementSpike(accountId, now);
    expect(r!.channelsSent[0]).toMatchObject({ channel: 'slack', ok: false });
    expect(r!.channelsSent[0].detail).toMatch(/ECONNREFUSED/);
  });

  it('records channel="file" + ok=false when engagement_spike file fallback throws', async () => {
    // Mirror the tier-promotion test, for the engagement-spike branch.
    const fs = await import('node:fs');
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    const accountId = insAccount();
    const now = new Date('2026-05-10T12:00:00.000Z');
    insSignal(accountId, '2026-05-10T11:00:00.000Z');
    insSignal(accountId, '2026-05-10T10:00:00.000Z');
    insSignal(accountId, '2026-05-10T09:00:00.000Z');
    const r = await dispatchEngagementSpike(accountId, now);
    expect(r!.channelsSent[0]).toMatchObject({ channel: 'file', ok: false });
    expect(r!.channelsSent[0].detail).toMatch(/EACCES/);
  });

  it('correctly windows mixed-offset captured_at timestamps (UTC normalization)', async () => {
    // Regression guard against the BLOCKER 1 fix. A signal at
    // 2026-05-09T01:00:00-12:00 is UTC = 2026-05-09T13:00:00.000Z —
    // within a 24h window ending at 2026-05-10T12:00:00.000Z. A naive
    // lex compare against the UTC since-cutoff (2026-05-09T12:00:00Z)
    // would WRONGLY exclude it because '2026-05-09T01:...' < the
    // cutoff string. The fix normalizes via strftime() before compare.
    const accountId = insAccount();
    const now = new Date('2026-05-10T12:00:00.000Z');
    insSignal(accountId, '2026-05-09T01:00:00.000-12:00');  // UTC = 13:00Z, in window
    insSignal(accountId, '2026-05-10T11:00:00.000Z');
    insSignal(accountId, '2026-05-10T10:00:00.000Z');
    const r = await dispatchEngagementSpike(accountId, now);
    expect(r).not.toBeNull();  // 3 signals in window if normalization is correct
  });
});
