import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { eq } from 'drizzle-orm';
import type { SignalConnector, ConnectorPayload } from '../../lib/connectors/types';
import { ConnectorError } from '../../lib/connectors/types';
import { pollConnectors, recomputeAffectedAccounts } from '../../lib/connectors/poll';

beforeEach(() => {
  // Children before parents (FK order). pollConnectors itself never
  // creates lead_scores/routing_assignments/alerts, but deleting them
  // first keeps this cleanup robust if a future test wires recompute.
  db.delete(schemaMod.alerts).run();
  db.delete(schemaMod.routingAssignments).run();
  db.delete(schemaMod.leadScores).run();
  db.delete(schemaMod.evidence).run();
  db.delete(schemaMod.contacts).run();
  db.delete(schemaMod.accounts).run();
  db.delete(schemaMod.connectorPollState).run();
});

// A valid ConnectorPayload that ingestSignal accepts AND (crm_record ∈
// TRUSTED_SOURCES + trustedSender) lands as verified evidence.
function validPayload(domain: string, id: string): ConnectorPayload {
  return {
    source: 'crm_record',
    captured_by: 'connector_salesforce',
    account_domain: domain,
    signal_type: 'firmographic',
    fact: `seed ${id}`,
    source_url: `https://salesforce.example/Contact/${id}`,
    snippet: `Id=${id} domain=${domain}`,
    captured_at: '2026-05-10T00:00:00.000Z',
    metadata: { sf_contact_id: id },
  };
}

/** Minimal injectable connector. */
function fakeConnector(
  name: string,
  fetchSince: (since: Date) => Promise<ConnectorPayload[]>,
): SignalConnector {
  return { name, fetchSince };
}

// --------------------------------------------------------------------------
// pollConnectors — per-connector isolation & response honesty
// --------------------------------------------------------------------------

describe('pollConnectors — isolation', () => {
  it('one connector throwing does NOT block the others; the failure is reported, not swallowed', async () => {
    const good = fakeConnector('good', async () => [validPayload('globex.com', 'g1')]);
    const bad = fakeConnector('bad', async () => {
      throw new ConnectorError('upstream 502');
    });
    const alsoGood = fakeConnector('also-good', async () => [validPayload('initech.io', 'a1')]);

    const r = await pollConnectors({
      connectors: [good, bad, alsoGood],
      since: new Date('2026-05-01T00:00:00.000Z'),
      now: new Date('2026-05-15T00:00:00.000Z'),
    });

    const byName = Object.fromEntries(r.connectors.map((c) => [c.connector, c]));
    expect(byName.good.ok).toBe(true);
    expect(byName.good.ingested).toBe(1);
    expect(byName['also-good'].ok).toBe(true);
    expect(byName['also-good'].ingested).toBe(1);
    // The failing connector is reported with ok:false + its error
    // string — NOT a swallowed warning (decision #2: GitHub-style
    // all-or-nothing surfaces as the connector's own failure).
    expect(byName.bad.ok).toBe(false);
    expect(byName.bad.error).toMatch(/upstream 502/);
    expect(byName.bad.ingested).toBe(0);
    // Top-level ok does NOT overstate: one connector failed → ok:false.
    expect(r.ok).toBe(false);
    // The two good connectors' accounts are still affected (they ingested).
    expect(r.affectedAccountIds.length).toBe(2);
    // Both good accounts actually persisted as verified evidence.
    const rows = db.select().from(schemaMod.evidence).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.extractionStatus === 'verified')).toBe(true);
  });

  it('a single bad payload is isolated; the connector still ingests its good payloads but reports ok:false', async () => {
    // One payload has a non-http(s) source_url → ingestSignal's Zod
    // rejects it. The connector returned 2 payloads; the good one
    // must still land, the bad one counted as failed, and the
    // connector's ok must be false (does not overstate: a partial
    // ingest is not a success).
    const partial = fakeConnector('partial', async () => [
      validPayload('globex.com', 'ok1'),
      { ...validPayload('globex.com', 'bad1'), source_url: 'ftp://not-http' },
    ]);
    const r = await pollConnectors({
      connectors: [partial],
      since: new Date('2026-05-01T00:00:00.000Z'),
      now: new Date('2026-05-15T00:00:00.000Z'),
    });
    const c = r.connectors[0];
    expect(c.fetched).toBe(2);
    expect(c.ingested).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(db.select().from(schemaMod.evidence).all()).toHaveLength(1);
  });

  it('isolation holds for a NON-ConnectorError throw (broad catch, not ConnectorError-specific)', async () => {
    // codex 3.4 r1 blocker context: the per-connector boundary must
    // catch ANY throw (plain Error, a DB error from the watermark
    // path, etc.), not just ConnectorError. A connector throwing a
    // bare Error must still be isolated and the others must proceed.
    const boom = fakeConnector('boom', async () => {
      throw new Error('not a ConnectorError');
    });
    const good = fakeConnector('good', async () => [validPayload('globex.com', 'g1')]);
    const r = await pollConnectors({
      connectors: [boom, good],
      since: new Date('2026-05-01T00:00:00.000Z'),
      now: new Date('2026-05-15T00:00:00.000Z'),
    });
    const byName = Object.fromEntries(r.connectors.map((c) => [c.connector, c]));
    expect(byName.boom.ok).toBe(false);
    expect(byName.boom.error).toMatch(/not a ConnectorError/);
    expect(byName.good.ok).toBe(true);
    expect(byName.good.ingested).toBe(1);
    expect(r.ok).toBe(false);
    // The good connector's account still flows to recompute even
    // though a sibling threw a non-typed error.
    expect(r.affectedAccountIds).toHaveLength(1);
  });

  it('all connectors succeeding → top-level ok:true and affectedAccountIds deduped across connectors', async () => {
    const a = fakeConnector('a', async () => [validPayload('shared.com', 's1')]);
    const b = fakeConnector('b', async () => [validPayload('shared.com', 's2')]);
    const r = await pollConnectors({
      connectors: [a, b],
      since: new Date('2026-05-01T00:00:00.000Z'),
      now: new Date('2026-05-15T00:00:00.000Z'),
    });
    expect(r.ok).toBe(true);
    // Both ingested onto the SAME account (shared.com) → affected set
    // is deduped to one accountId.
    expect(r.affectedAccountIds).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// pollConnectors — watermark (connector_poll_state)
// --------------------------------------------------------------------------

describe('pollConnectors — watermark', () => {
  it('first poll (no stored state) falls back to now-24h, then persists last_polled_at = poll-start', async () => {
    const seen: Date[] = [];
    const c = fakeConnector('wm', async (since) => {
      seen.push(since);
      return [validPayload('globex.com', 'w1')];
    });
    const now = new Date('2026-05-15T12:00:00.000Z');
    await pollConnectors({ connectors: [c], now });

    // No explicit since, no stored row → since = now - 24h.
    expect(seen[0].toISOString()).toBe('2026-05-14T12:00:00.000Z');
    // Watermark persisted at poll-START (= now), only because the
    // connector succeeded.
    const row = db.select().from(schemaMod.connectorPollState)
      .where(eq(schemaMod.connectorPollState.connectorName, 'wm')).get();
    expect(row?.lastPolledAt).toBe(now.toISOString());
  });

  it('second poll with no explicit since uses the stored watermark', async () => {
    const seen: Date[] = [];
    const c = fakeConnector('wm', async (since) => {
      seen.push(since);
      return [validPayload('globex.com', `w${seen.length}`)];
    });
    await pollConnectors({ connectors: [c], now: new Date('2026-05-15T12:00:00.000Z') });
    await pollConnectors({ connectors: [c], now: new Date('2026-05-16T12:00:00.000Z') });
    // Second poll's since = first poll's stored watermark.
    expect(seen[1].toISOString()).toBe('2026-05-15T12:00:00.000Z');
  });

  it('a failed connector does NOT advance its watermark (retries the same window next poll)', async () => {
    let attempt = 0;
    const flaky = fakeConnector('flaky', async () => {
      attempt++;
      if (attempt === 1) throw new ConnectorError('transient');
      return [validPayload('globex.com', 'f1')];
    });
    await pollConnectors({ connectors: [flaky], now: new Date('2026-05-15T12:00:00.000Z') });
    // First poll failed → no watermark row.
    expect(
      db.select().from(schemaMod.connectorPollState)
        .where(eq(schemaMod.connectorPollState.connectorName, 'flaky')).get(),
    ).toBeUndefined();
    // Second poll succeeds → watermark now written.
    await pollConnectors({ connectors: [flaky], now: new Date('2026-05-16T12:00:00.000Z') });
    expect(
      db.select().from(schemaMod.connectorPollState)
        .where(eq(schemaMod.connectorPollState.connectorName, 'flaky')).get()?.lastPolledAt,
    ).toBe('2026-05-16T12:00:00.000Z');
  });

  it('explicit `since` overrides the stored watermark (operator backfill)', async () => {
    const seen: Date[] = [];
    const c = fakeConnector('wm', async (since) => {
      seen.push(since);
      return [];
    });
    // Seed a watermark.
    await pollConnectors({ connectors: [c], now: new Date('2026-05-15T12:00:00.000Z') });
    // Explicit since must win over the stored 2026-05-15 watermark.
    await pollConnectors({
      connectors: [c],
      since: new Date('2020-01-01T00:00:00.000Z'),
      now: new Date('2026-05-16T12:00:00.000Z'),
    });
    expect(seen[1].toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('re-polling the same window is idempotent (dedupe); evidence count is stable', async () => {
    const c = fakeConnector('idem', async () => [validPayload('globex.com', 'x1')]);
    const opts = {
      connectors: [c],
      since: new Date('2026-05-01T00:00:00.000Z'),
      now: new Date('2026-05-15T12:00:00.000Z'),
    };
    const r1 = await pollConnectors(opts);
    const r2 = await pollConnectors(opts);
    expect(r1.connectors[0].ingested).toBe(1);
    expect(r1.connectors[0].deduped).toBe(0);
    expect(r2.connectors[0].ingested).toBe(0);
    expect(r2.connectors[0].deduped).toBe(1);
    expect(db.select().from(schemaMod.evidence).all()).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// recomputeAffectedAccounts — shared recompute step (parity with the
// /api/scoring/recompute route's gating, in ONE place)
// --------------------------------------------------------------------------

describe('recomputeAffectedAccounts', () => {
  const cfg = { scoringMd: '# scoring', routingMd: '# routing', defaultOwner: 'a@b.com' };

  function deps(over: Partial<Parameters<typeof recomputeAffectedAccounts>[2]> = {}) {
    return {
      computeScore: vi.fn(async (accountId: string) => ({
        scoreId: `score_${accountId}`, accountId, score: 50,
        tier: 'hot' as const, priorTier: 'warm' as const,
        rationale: [], inserted: true,
      })),
      route: vi.fn(async (accountId: string, scoreId: string) => ({
        assignmentId: `asg_${accountId}`, accountId, scoreId,
        ownerEmail: 'a@b.com', matchedRuleKey: 'RR1',
        reason: 'rule_match' as const,
        // RouteResult requires this — the dep is typed `typeof
        // routeAccount` on purpose so a real signature change breaks
        // this fake loudly rather than the parity silently drifting.
        routingRulesHash: `hash_${accountId}`,
      })),
      dispatchTierPromotion: vi.fn(async () => ({ alertId: 'al_tp', channelsSent: [] })),
      dispatchEngagementSpike: vi.fn(async () => ({ alertId: 'al_sp', channelsSent: [] })),
      ...over,
    };
  }

  it('recomputes each account; tier_promotion gated on score.inserted, engagement_spike ALWAYS attempted', async () => {
    const d = deps();
    const summary = await recomputeAffectedAccounts(['acc_1', 'acc_2'], cfg, d);
    expect(summary.attempted).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(d.computeScore).toHaveBeenCalledTimes(2);
    expect(d.dispatchTierPromotion).toHaveBeenCalledTimes(2);   // both inserted
    expect(d.dispatchEngagementSpike).toHaveBeenCalledTimes(2); // always
  });

  it('does NOT dispatch tier_promotion when score.inserted is false (dedupe path)', async () => {
    const d = deps({
      computeScore: vi.fn(async (accountId: string) => ({
        scoreId: `score_${accountId}`, accountId, score: 50,
        tier: 'hot' as const, priorTier: 'hot' as const,
        rationale: [], inserted: false,
      })),
    });
    await recomputeAffectedAccounts(['acc_1'], cfg, d);
    expect(d.dispatchTierPromotion).not.toHaveBeenCalled();
    expect(d.dispatchEngagementSpike).toHaveBeenCalledTimes(1); // still always
  });

  it('an alert dispatch throwing does NOT fail the account recompute (best-effort side effect)', async () => {
    const d = deps({
      dispatchTierPromotion: vi.fn(async () => { throw new Error('slack down'); }),
    });
    const summary = await recomputeAffectedAccounts(['acc_1'], cfg, d);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toEqual([]);
  });

  it('malformed routing-rules.md fails EVERY account WITHOUT calling computeScore (config-before-mutation parity)', async () => {
    // codex 3.4 r1 BLOCKER: /api/scoring/recompute pre-validates
    // routing-rules.md before computeScore writes a lead_scores row.
    // recomputeAffectedAccounts must do the same — a known-bad
    // routing config must fail all accounts up front, NOT write
    // score rows then fail on route(). A rule-shaped section whose
    // heading isn't RR\d+ makes parseRoutingRules throw
    // RoutingRuleParseError.
    const badRoutingMd = [
      '## notarule',
      '- priority: 1',
      "- predicate: tier == 'hot'",
      '- owner_email: x@y.com',
    ].join('\n');
    const d = deps();
    const summary = await recomputeAffectedAccounts(
      ['acc_1', 'acc_2'],
      { scoringMd: '# scoring', routingMd: badRoutingMd, defaultOwner: 'a@b.com' },
      d,
    );
    expect(summary.attempted).toBe(2);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed.map((f) => f.accountId).sort()).toEqual(['acc_1', 'acc_2']);
    expect(summary.failed.every((f) => /routing-rules\.md is invalid/.test(f.error))).toBe(true);
    // The load-bearing assertion: NO score row was written for ANY
    // account — computeScore was never called.
    expect(d.computeScore).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
  });

  it('an invalid defaultOwner fails EVERY account WITHOUT calling computeScore (same config-before-mutation invariant as routing)', async () => {
    // codex 3.4 r2 BLOCKER: r1 closed the routing-rules.md drift but
    // left the SAME drift for defaultOwner — route() validates it and
    // throws, but only AFTER computeScore wrote a lead_scores row.
    // recomputeAffectedAccounts must reject a bad owner up front,
    // zero computeScore calls. This is the parity twin of the
    // malformed-routing test.
    const d = deps();
    const summary = await recomputeAffectedAccounts(
      ['acc_1', 'acc_2'],
      { scoringMd: '# scoring', routingMd: '# routing', defaultOwner: 'not-an-email' },
      d,
    );
    expect(summary.succeeded).toBe(0);
    expect(summary.failed.map((f) => f.accountId).sort()).toEqual(['acc_1', 'acc_2']);
    expect(summary.failed.every((f) => /DEFAULT_OWNER_EMAIL is invalid/.test(f.error))).toBe(true);
    expect(d.computeScore).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
  });

  it('a valid owner with surrounding whitespace/case is normalized (matches route() behavior)', async () => {
    // route() does `.trim().toLowerCase()` then EMAIL_SHAPE. The
    // pre-check must normalize identically or it would reject a
    // value route() would accept (false config failure) — pin parity.
    const d = deps();
    const summary = await recomputeAffectedAccounts(
      ['acc_1'],
      { scoringMd: '# scoring', routingMd: '# routing', defaultOwner: '  Triage@Example.COM  ' },
      d,
    );
    expect(summary.succeeded).toBe(1);
    expect(d.computeScore).toHaveBeenCalledTimes(1);
  });

  it('one account recompute throwing is isolated; other accounts still recompute', async () => {
    const d = deps({
      computeScore: vi.fn(async (accountId: string) => {
        if (accountId === 'bad') throw new Error('score blew up');
        return {
          scoreId: `score_${accountId}`, accountId, score: 1,
          tier: 'cold' as const, priorTier: undefined,
          rationale: [], inserted: true,
        };
      }),
    });
    const summary = await recomputeAffectedAccounts(['good', 'bad', 'good2'], cfg, d);
    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].accountId).toBe('bad');
    expect(summary.failed[0].error).toMatch(/score blew up/);
  });
});
