import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as schemaMod from '../../db/schema';

// Same in-memory-sqlite mock as connectors-contract.test.ts. The
// pure helper/connector describe blocks never touch the DB; only the
// "lands as verified evidence" contract-pipe block does. Module-level
// vi.mock is hoisted and applies file-wide — harmless for the pure
// tests, which simply never call ingestSignal.
vi.mock('@/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schemaModInner = await import('../../db/schema');
  const path = await import('node:path');
  const { fileURLToPath: f } = await import('node:url');
  const _dirname = path.dirname(f(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: schemaModInner });
  migrate(db, { migrationsFolder: path.resolve(_dirname, '../../db/migrations') });
  return { db, schema: schemaModInner };
});

import { db } from '@/db';
import { loadFixtureSince } from '../../lib/connectors/fixture-loader';
import { SalesforceConnector } from '../../lib/connectors/salesforce';
import { HubSpotConnector } from '../../lib/connectors/hubspot';
import { OutreachConnector } from '../../lib/connectors/outreach';
import { ConnectorError } from '../../lib/connectors/types';
import { ingestSignal } from '../../lib/signals/ingest';

function fixture(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/connectors/${rel}`, import.meta.url));
}

// --------------------------------------------------------------------------
// Shared fixture loader
//
// All three stub connectors route their load + since-filter through
// `loadFixtureSince`. Testing the helper once, thoroughly, proves the
// boundary/error semantics for all three (the per-connector blocks
// then only need to assert mapping shape).
// --------------------------------------------------------------------------

describe('loadFixtureSince', () => {
  type Row = { id: string; ts: string };
  const getTs = (r: Row) => r.ts;

  it('includes rows at or after `since` (boundary is INCLUSIVE, matching the 3.2 connector contract)', () => {
    // contacts.json has rows at 2026-05-01 (before), 2026-05-10
    // (exactly at), 2026-05-12 (after). With since=2026-05-10 the
    // boundary row MUST be kept — strict-after would silently lose
    // an event sharing the boundary timestamp; the evidence
    // dedupe_key is the re-emit safety net.
    const rows = loadFixtureSince<{ LastModifiedDate: string }>(
      fixture('salesforce/contacts.json'),
      (r) => r.LastModifiedDate,
      new Date('2026-05-10T00:00:00.000Z'),
      'salesforce',
    );
    expect(rows).toHaveLength(2);
  });

  it('excludes everything when `since` is in the future', () => {
    const rows = loadFixtureSince<{ LastModifiedDate: string }>(
      fixture('salesforce/contacts.json'),
      (r) => r.LastModifiedDate,
      new Date('2030-01-01T00:00:00.000Z'),
      'salesforce',
    );
    expect(rows).toHaveLength(0);
  });

  it('throws a plain Error (NOT ConnectorError) on a malformed timestamp', () => {
    // A malformed timestamp in a CONTROLLED fixture is a data bug,
    // not a transient upstream failure. ConnectorError signals
    // "retry with backoff" to the orchestrator — retrying can't fix
    // a rotted fixture, so signalling transient would be a lie.
    // Plain Error => "programming bug, surface in logs" per the
    // SignalConnector contract.
    let caught: unknown;
    try {
      loadFixtureSince<Row>(
        fixture('_fixture-helper/malformed-ts.json'),
        getTs,
        new Date('2026-01-01T00:00:00.000Z'),
        'helper-test',
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ConnectorError);
    // Message must be debuggable: name the context and the bad value.
    expect((caught as Error).message).toMatch(/helper-test/);
    expect((caught as Error).message).toMatch(/not-a-date/);
  });

  it('throws on a non-string timestamp (number/null slip the finite guard → silent loss)', () => {
    // codex 3.3 r1 blocker: `new Date(1715299200000)` is a finite
    // ms value and `new Date(null)` is epoch 0 — both pass
    // Number.isFinite, so without the explicit string requirement a
    // numeric/null timestamp would be SILENTLY filtered out as
    // "before 1970" instead of failing loud. nonstring-ts.json's
    // first row has a numeric ts; the loader must throw before it
    // reaches the finite check.
    let caught: unknown;
    try {
      loadFixtureSince<{ ts: unknown }>(
        fixture('_fixture-helper/nonstring-ts.json'),
        (r) => r.ts,
        new Date('2026-01-01T00:00:00.000Z'),
        'helper-test',
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ConnectorError);
    expect((caught as Error).message).toMatch(/non-string or blank/i);
    expect((caught as Error).message).toMatch(/helper-test/);
  });

  it('wraps a malformed (null) row with context instead of a raw TypeError', () => {
    // null-row.json is `[null]`. The getter `(r) => r.ts` throws
    // "Cannot read properties of null" — a raw TypeError with no
    // connector/path/index. The loader must catch and re-throw with
    // context so the operator can find the bad row.
    let caught: unknown;
    try {
      loadFixtureSince<{ ts: unknown }>(
        fixture('_fixture-helper/null-row.json'),
        (r) => r.ts,
        new Date(0),
        'helper-test',
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ConnectorError);
    expect((caught as Error).message).toMatch(/helper-test/);
    expect((caught as Error).message).toMatch(/row 0/);
    expect((caught as Error).message).toMatch(/malformed/i);
  });

  it('throws when the fixture JSON is not an array', () => {
    expect(() =>
      loadFixtureSince(
        fixture('_fixture-helper/not-array.json'),
        (r: { ts: string }) => r.ts,
        new Date(0),
        'helper-test',
      ),
    ).toThrow(/array/i);
  });

  it('throws a clear error when the fixture file is missing', () => {
    expect(() =>
      loadFixtureSince(
        fixture('does/not/exist.json'),
        (r: { ts: string }) => r.ts,
        new Date(0),
        'helper-test',
      ),
    ).toThrow(/helper-test/);
  });
});

// --------------------------------------------------------------------------
// Per-connector mapping shape
// --------------------------------------------------------------------------

describe('SalesforceConnector', () => {
  it('maps contacts to crm_record / connector_salesforce ConnectorPayloads, since-filtered', async () => {
    const c = new SalesforceConnector(fixture('salesforce/contacts.json'));
    const payloads = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    expect(payloads).toHaveLength(2);  // boundary + after; stale excluded
    const p = payloads.find((x) => x.contact_email === 'alice@globex.com')!;
    expect(p.source).toBe('crm_record');
    expect(p.captured_by).toBe('connector_salesforce');
    expect(p.signal_type).toBe('firmographic');
    expect(p.account_domain).toBe('globex.com');
    expect(p.fact).toContain('Alice Park');
    expect(p.source_url).toBe('https://salesforce.example/Contact/003bnd0000002');
    expect(p.captured_at).toBe('2026-05-10T00:00:00.000Z');
    expect(p.metadata).toMatchObject({ sf_contact_id: '003bnd0000002' });
  });

  it('uses a cwd-independent default fixture path (no-arg constructor works)', async () => {
    // The default fixture path is anchored to the connector module
    // via import.meta.url, NOT process.cwd() — the cwd brittleness
    // codex flagged in 3.2 round 2. Constructing with no arg must
    // resolve regardless of where vitest was invoked from.
    const c = new SalesforceConnector();
    const payloads = await c.fetchSince(new Date('2000-01-01T00:00:00.000Z'));
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    expect(payloads.every((p) => p.captured_by === 'connector_salesforce')).toBe(true);
  });
});

describe('HubSpotConnector', () => {
  it('maps accounts to crm_record / connector_hubspot ConnectorPayloads, since-filtered', async () => {
    const c = new HubSpotConnector(fixture('hubspot/accounts.json'));
    const payloads = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    expect(payloads).toHaveLength(2);
    const p = payloads.find((x) => x.account_domain === 'initech.io')!;
    expect(p.source).toBe('crm_record');
    expect(p.captured_by).toBe('connector_hubspot');
    expect(p.signal_type).toBe('firmographic');
    expect(p.fact).toContain('Initech');
    expect(p.source_url).toBe('https://hubspot.example/company/1001');
    expect(p.metadata).toMatchObject({ hs_company_id: '1001' });
    // HubSpot accounts have no contact — contact_email must be absent
    // or nullish, never an empty string (Zod email() would reject '').
    expect(p.contact_email == null).toBe(true);
  });
});

describe('OutreachConnector', () => {
  it('maps engagements to engagement_event / connector_outreach ConnectorPayloads, since-filtered', async () => {
    const c = new OutreachConnector(fixture('outreach/engagement.json'));
    const payloads = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    expect(payloads).toHaveLength(2);
    const p = payloads.find((x) => x.metadata?.outreach_event_id === 'eng_1')!;
    expect(p.source).toBe('engagement_event');
    expect(p.captured_by).toBe('connector_outreach');
    expect(p.signal_type).toBe('engagement');
    expect(p.account_domain).toBe('umbrella.co');
    expect(p.contact_email).toBe('bob@umbrella.co');
    expect(p.fact).toContain('email_open');
    expect(p.source_url).toBe('https://outreach.example/event/eng_1');
  });
});

// --------------------------------------------------------------------------
// The contract: stub output piped through ingestSignal lands as
// verified evidence under the SAME trust + matrix semantics as a
// webhook. This is the connectors-contract.test.ts pattern applied
// per-connector, and it specifically proves each (source, captured_by)
// pair passes the Zod source/producer matrix — testing only one
// crm_record producer wouldn't prove the other is accepted.
// --------------------------------------------------------------------------

describe('stub connector contract — output lands as verified evidence', () => {
  beforeEach(() => {
    db.delete(schemaMod.evidence).run();
    db.delete(schemaMod.contacts).run();
    db.delete(schemaMod.accounts).run();
  });

  it('Salesforce: EVERY returned payload lands as verified crm_record evidence', async () => {
    // codex 3.3 r1: ingest ALL payloads, not just the first — a bad
    // second fixture row would otherwise slip through unverified.
    const c = new SalesforceConnector(fixture('salesforce/contacts.json'));
    const payloads = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    for (const p of payloads) {
      const result = await ingestSignal(p, { trustedSender: true });
      expect(result.deduped).toBe(false);
    }
    const rows = db.select().from(schemaMod.evidence).all();
    expect(rows).toHaveLength(payloads.length);
    expect(rows.every((r) => r.extractionStatus === 'verified')).toBe(true);
    expect(rows.every((r) => r.sourceType === 'crm_record')).toBe(true);
    expect(rows.every((r) => r.capturedBy === 'connector_salesforce')).toBe(true);
    expect(rows.every((r) => r.dedupeKey)).toBeTruthy();
  });

  it('HubSpot: every payload verified AND the contactless crm_record path creates NO contact row', async () => {
    // Proves (a) the OTHER crm_record producer (connector_hubspot)
    // passes the source/producer matrix, and (b) a HubSpot company
    // (no contact_email) does NOT spawn a phantom contact —
    // evidence.contactId stays null. codex 3.3 r1 asked to pin this.
    const c = new HubSpotConnector(fixture('hubspot/accounts.json'));
    const payloads = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    for (const p of payloads) {
      const result = await ingestSignal(p, { trustedSender: true });
      expect(result.deduped).toBe(false);
    }
    const rows = db.select().from(schemaMod.evidence).all();
    expect(rows).toHaveLength(payloads.length);
    expect(rows.every((r) => r.extractionStatus === 'verified')).toBe(true);
    expect(rows.every((r) => r.capturedBy === 'connector_hubspot')).toBe(true);
    // The contactless invariant: no contacts created, every evidence
    // row's contactId is null.
    expect(rows.every((r) => r.contactId === null)).toBe(true);
    expect(db.select().from(schemaMod.contacts).all()).toHaveLength(0);
  });

  it('Outreach: every payload lands as verified engagement_event evidence', async () => {
    const c = new OutreachConnector(fixture('outreach/engagement.json'));
    const payloads = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    for (const p of payloads) {
      const result = await ingestSignal(p, { trustedSender: true });
      expect(result.deduped).toBe(false);
    }
    const rows = db.select().from(schemaMod.evidence).all();
    expect(rows).toHaveLength(payloads.length);
    expect(rows.every((r) => r.extractionStatus === 'verified')).toBe(true);
    expect(rows.every((r) => r.sourceType === 'engagement_event')).toBe(true);
    expect(rows.every((r) => r.capturedBy === 'connector_outreach')).toBe(true);
  });

  it('two fetchSince polls produce byte-identical dedupe material (Date.now advanced between)', async () => {
    // codex 3.3 r1: re-ingesting the SAME object only proved
    // ingestSignal dedupes identical input. To prove the CONNECTOR
    // is deterministic across polls, fetch twice with Date.now
    // advanced — if any mapper injected Date.now() into snippet/url,
    // the two polls would diverge. The stubs use only the fixture's
    // own fields, so they MUST be identical. Then re-ingest the
    // second poll and assert it dedupes against the first.
    const c = new OutreachConnector(fixture('outreach/engagement.json'));
    const realNow = Date.now;
    let a, b;
    try {
      Date.now = () => new Date('2026-05-15T00:00:00.000Z').getTime();
      [a] = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
      Date.now = () => new Date('2026-05-15T00:05:00.000Z').getTime();
      [b] = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    } finally {
      Date.now = realNow;
    }
    expect(a.captured_by).toBe(b.captured_by);
    expect(a.source).toBe(b.source);
    expect(a.account_domain).toBe(b.account_domain);
    expect(a.source_url).toBe(b.source_url);
    expect(a.snippet).toBe(b.snippet);
    expect(a.captured_at).toBe(b.captured_at);
    const r1 = await ingestSignal(a, { trustedSender: true });
    const r2 = await ingestSignal(b, { trustedSender: true });
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(true);
    expect(db.select().from(schemaMod.evidence).all()).toHaveLength(1);
  });
});
