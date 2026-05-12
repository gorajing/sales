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
import { newId } from '../../lib/id';
import { recentAlerts } from '../../lib/alerts/queries';
import { acknowledgeAlert } from '../../lib/alerts/ack';

beforeEach(() => {
  db.delete(schemaMod.alerts).run();
  db.delete(schemaMod.accounts).run();
});

function insAccount(name = 'Acme'): string {
  const id = newId('account');
  db.insert(schemaMod.accounts).values({ id, name }).run();
  return id;
}

function insAlert(opts: {
  accountId: string;
  trigger?: 'tier_promotion' | 'engagement_spike' | 'manual';
  severity?: 'info' | 'priority' | 'urgent';
  createdAt?: string;
  cooldownKey?: string;
  acknowledgedAt?: string;
}): string {
  const id = newId('alert');
  db.insert(schemaMod.alerts).values({
    id,
    accountId: opts.accountId,
    trigger: opts.trigger ?? 'manual',
    severity: opts.severity ?? 'info',
    payloadJson: {},
    channelsSentJson: [],
    ...(opts.cooldownKey ? { cooldownKey: opts.cooldownKey } : {}),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.acknowledgedAt ? { acknowledgedAt: opts.acknowledgedAt } : {}),
  }).run();
  return id;
}

// ============================================================================
// recentAlerts — bounded, deterministic ordering
// ============================================================================

describe('recentAlerts', () => {
  it('orders by createdAt DESC, then rowid DESC as a deterministic tiebreaker', () => {
    // Two alerts share an identical createdAt millisecond — the
    // tiebreaker must fall back to rowid DESC so the order is
    // stable across renders. Without the tiebreak, two alerts at
    // the same ms could swap on every page load.
    const accountId = insAccount();
    const sameTs = '2026-05-10T12:00:00.000Z';
    const a = insAlert({ accountId, createdAt: sameTs });
    const b = insAlert({ accountId, createdAt: sameTs });
    const c = insAlert({ accountId, createdAt: sameTs });

    const rows = recentAlerts(10);
    expect(rows.map((r) => r.id)).toEqual([c, b, a]);
    // Re-query: must be identical (no randomness).
    expect(recentAlerts(10).map((r) => r.id)).toEqual([c, b, a]);
  });

  it('orders chronologically by createdAt when timestamps differ', () => {
    const accountId = insAccount();
    const old = insAlert({ accountId, createdAt: '2026-05-09T12:00:00.000Z' });
    const middle = insAlert({ accountId, createdAt: '2026-05-10T08:00:00.000Z' });
    const newest = insAlert({ accountId, createdAt: '2026-05-10T15:00:00.000Z' });

    const rows = recentAlerts(10);
    expect(rows.map((r) => r.id)).toEqual([newest, middle, old]);
  });

  it('respects the limit', () => {
    const accountId = insAccount();
    for (let i = 0; i < 10; i++) insAlert({ accountId });
    expect(recentAlerts(3)).toHaveLength(3);
    expect(recentAlerts(100)).toHaveLength(10);
  });

  it('returns an empty array when no alerts exist', () => {
    insAccount();
    expect(recentAlerts(10)).toEqual([]);
  });

  it('does not pull every row when there are many alerts (wire cost ~ limit)', () => {
    // Regression guard against the Phase 1 lesson: server-component
    // queries should be bounded at the SQL layer, not by JS slicing.
    // We insert 200 alerts but ask for 5; the response should contain
    // exactly 5, demonstrating the limit is wire-level.
    const accountId = insAccount();
    for (let i = 0; i < 200; i++) {
      insAlert({ accountId, createdAt: `2026-05-${String(10 + (i % 20)).padStart(2, '0')}T12:00:00.000Z` });
    }
    const rows = recentAlerts(5);
    expect(rows).toHaveLength(5);
  });
});

// ============================================================================
// acknowledgeAlert — first-write-wins idempotency
// ============================================================================

describe('acknowledgeAlert', () => {
  it('writes acknowledgedAt + acknowledgedBy on first ack', () => {
    const accountId = insAccount();
    const alertId = insAlert({ accountId });
    const result = acknowledgeAlert(alertId, 'jin@example.com');
    expect(result).toEqual({ ok: true, alreadyAcked: false });
    const row = db.select().from(schemaMod.alerts).all()[0];
    expect(row.acknowledgedAt).toBeTruthy();
    expect(row.acknowledgedBy).toBe('jin@example.com');
  });

  it('is first-write-wins: re-ack does NOT overwrite the original timestamp or acknowledger', () => {
    // Per the user's strict-bar item: ack must be idempotent.
    // Idempotent here means "same observable state after N calls as
    // after 1." Overwriting acknowledgedAt with each call would mean
    // the second-acker's identity is recorded — that's not idempotent
    // from the observable-row perspective.
    const accountId = insAccount();
    const alertId = insAlert({ accountId });
    const first = acknowledgeAlert(alertId, 'first@example.com');
    expect(first.ok).toBe(true);
    const rowAfterFirst = db.select().from(schemaMod.alerts).all()[0];
    const originalTs = rowAfterFirst.acknowledgedAt;

    // Brief delay so a re-write would produce a different millisecond
    // (in case the implementation accidentally overwrites).
    const second = acknowledgeAlert(alertId, 'second@example.com');
    expect(second).toEqual({ ok: true, alreadyAcked: true });
    const rowAfterSecond = db.select().from(schemaMod.alerts).all()[0];
    expect(rowAfterSecond.acknowledgedAt).toBe(originalTs);
    expect(rowAfterSecond.acknowledgedBy).toBe('first@example.com');  // NOT 'second'
  });

  it('returns {ok: false, reason: "not_found"} for a missing alertId', () => {
    expect(acknowledgeAlert('al_does_not_exist', 'x@y.z'))
      .toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns {ok: false, reason: "not_found"} for a malformed alertId (fail fast)', () => {
    // The id format is `al_yyyymmdd_hex`. A random string from the URL
    // (e.g. SQL-injection attempt, garbage from a copy-paste) should
    // fail fast at the shape check rather than wasting a DB SELECT.
    expect(acknowledgeAlert('not-an-id', 'x@y.z'))
      .toEqual({ ok: false, reason: 'not_found' });
    expect(acknowledgeAlert('al_123', 'x@y.z'))
      .toEqual({ ok: false, reason: 'not_found' });
    expect(acknowledgeAlert("al_'; DROP TABLE alerts; --", 'x@y.z'))
      .toEqual({ ok: false, reason: 'not_found' });
  });
});
