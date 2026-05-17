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

  it('Salesforce (crm_record + connector_salesforce) → verified evidence', async () => {
    const c = new SalesforceConnector(fixture('salesforce/contacts.json'));
    const [first] = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    const result = await ingestSignal(first, { trustedSender: true });
    const row = db.select().from(schemaMod.evidence).all()[0];
    expect(row.extractionStatus).toBe('verified');
    expect(row.sourceType).toBe('crm_record');
    expect(row.capturedBy).toBe('connector_salesforce');
    expect(row.dedupeKey).toBeTruthy();
    expect(result.deduped).toBe(false);
  });

  it('HubSpot (crm_record + connector_hubspot) → verified evidence (proves the OTHER crm_record producer passes the matrix)', async () => {
    const c = new HubSpotConnector(fixture('hubspot/accounts.json'));
    const [first] = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    const result = await ingestSignal(first, { trustedSender: true });
    const row = db.select().from(schemaMod.evidence).all()[0];
    expect(row.extractionStatus).toBe('verified');
    expect(row.sourceType).toBe('crm_record');
    expect(row.capturedBy).toBe('connector_hubspot');
    expect(result.deduped).toBe(false);
  });

  it('Outreach (engagement_event + connector_outreach) → verified evidence', async () => {
    const c = new OutreachConnector(fixture('outreach/engagement.json'));
    const [first] = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    const result = await ingestSignal(first, { trustedSender: true });
    const row = db.select().from(schemaMod.evidence).all()[0];
    expect(row.extractionStatus).toBe('verified');
    expect(row.sourceType).toBe('engagement_event');
    expect(row.capturedBy).toBe('connector_outreach');
    expect(result.deduped).toBe(false);
  });

  it('re-ingesting the same stub payload dedupes (idempotent across polls)', async () => {
    const c = new OutreachConnector(fixture('outreach/engagement.json'));
    const [first] = await c.fetchSince(new Date('2026-05-10T00:00:00.000Z'));
    const r1 = await ingestSignal(first, { trustedSender: true });
    const r2 = await ingestSignal(first, { trustedSender: true });
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(true);
    expect(db.select().from(schemaMod.evidence).all()).toHaveLength(1);
  });
});
