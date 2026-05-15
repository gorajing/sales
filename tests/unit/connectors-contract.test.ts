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

import { ZodError } from 'zod';
import { db } from '@/db';
import type { SignalConnector, ConnectorPayload } from '../../lib/connectors/types';
import { ConnectorError } from '../../lib/connectors/types';
import { ingestSignal } from '../../lib/signals/ingest';

beforeEach(() => {
  db.delete(schemaMod.evidence).run();
  db.delete(schemaMod.contacts).run();
  db.delete(schemaMod.accounts).run();
});

/**
 * The contract test for Task 3.1.
 *
 * The point of the SignalConnector interface is that connector output
 * piped through `ingestSignal` produces valid `evidence` rows under
 * the existing trust + dedupe + normalization semantics — no
 * connector-specific bypass path. This test is the structural proof
 * that the contract is intact: build a tiny fixture connector, run
 * its output through ingestSignal, and assert that the persisted row
 * looks exactly like a webhook-ingested row would (verified status,
 * UTC-Z captured_at, dedupe_key set).
 *
 * Future connector implementations (Tasks 3.2+) should add their own
 * end-to-end tests against their fixture data, but they share THIS
 * contract.
 */
describe('SignalConnector contract', () => {
  it('output piped through ingestSignal lands as verified evidence with normalized captured_at', async () => {
    // Tiny fixture connector. Emits a single github_event payload
    // with a non-Z offset to prove the orchestrator-side UTC
    // normalization survives the connector boundary.
    const fixtureConnector: SignalConnector = {
      name: 'fixture-github',
      async fetchSince(): Promise<ConnectorPayload[]> {
        return [{
          source: 'github_event',
          captured_by: 'connector_github',  // satisfies the source/producer matrix
          account_domain: 'fixture.example',
          signal_type: 'engagement',
          fact: 'fixture starred a competitor repo',
          source_url: 'https://github.com/foo/bar/stargazers',
          snippet: 'fixture.example user starred foo/bar — fixture starred a competitor repo',
          // Non-Z offset: ingest must normalize to UTC-Z.
          captured_at: '2026-05-10T05:00:00.000-07:00',
        }];
      },
    };

    const events = await fixtureConnector.fetchSince(new Date(0));
    expect(events).toHaveLength(1);

    // The orchestrator's job. Connector output → ingestSignal with
    // trustedSender=true (connectors are trusted by configuration).
    const result = await ingestSignal(events[0], { trustedSender: true });

    // Persisted row reflects the canonical ingest contract:
    //   - status='verified' because github_event ∈ TRUSTED_SOURCES + trustedSender=true
    //   - captured_at normalized to UTC-Z (the round-trip from -07:00 input)
    //   - dedupe_key set (any non-null value; exact format is ingest's concern)
    //   - captured_by preserved from connector
    const row = db.select().from(schemaMod.evidence).all()[0];
    expect(row.extractionStatus).toBe('verified');
    expect(row.capturedAt).toBe('2026-05-10T12:00:00.000Z');  // = UTC for 05:00-07:00
    expect(row.dedupeKey).toBeTruthy();
    expect(row.capturedBy).toBe('connector_github');
    expect(result.deduped).toBe(false);  // first ingest of this dedupe_key
  });

  it('a connector that emits a mismatched source/captured_by is REJECTED specifically by the source/producer matrix', async () => {
    // The point of the rejection: the Zod source/producer matrix on
    // SignalPayload runs INSIDE ingestSignal. A connector that
    // tries to claim a connector_outreach producer for a
    // github_event source hits the validation wall — there's no
    // connector-specific bypass.
    //
    // Test specificity matters: a generic `.rejects.toThrow()` would
    // pass if a future unrelated validator (e.g. a new field check)
    // rejected this payload for a different reason. We want to pin
    // the rejection to the matrix in particular, so the regression
    // guard remains the right shape under future schema evolution.
    //
    // No type cast — github_event + connector_outreach is a valid
    // ConnectorPayload at the TS level (both are connector_* values,
    // captured_by is set, source is valid). The runtime matrix is
    // what catches the mismatch. Removing the cast keeps the test
    // honest: if ConnectorPayload tightens further (e.g. a future
    // discriminated union pairing source to producer at the type
    // level), this fixture would correctly fail to compile and force
    // the maintainer to update.
    const badConnector: SignalConnector = {
      name: 'fixture-bad',
      async fetchSince(): Promise<ConnectorPayload[]> {
        return [{
          source: 'github_event',                  // CONNECTOR_ONLY source
          captured_by: 'connector_outreach',       // wrong connector for this source
          account_domain: 'fixture.example',
          signal_type: 'engagement',
          fact: 'mismatched producer',
          source_url: 'https://github.com/foo/bar/stargazers',
          snippet: 'mismatched producer — github_event source but connector_outreach captured_by',
          captured_at: '2026-05-10T12:00:00.000Z',
        }];
      },
    };

    const events = await badConnector.fetchSince(new Date(0));
    let caught: unknown;
    try {
      await ingestSignal(events[0], { trustedSender: true });
    } catch (err) {
      caught = err;
    }
    // Specifically a ZodError, AND specifically the source/captured_by
    // matrix message. If a future refactor moves this validation
    // elsewhere or changes its wording, the test should fail loudly
    // and force the maintainer to confirm the rejection still happens
    // — and through this code path, not via some unrelated validator.
    expect(caught).toBeInstanceOf(ZodError);
    const zodErr = caught as ZodError;
    const flat = JSON.stringify(zodErr.issues);
    expect(flat).toMatch(/captured_by/i);
    expect(flat).toMatch(/source\/captured_by mismatch/i);
    // No row written — the rejection happens before any DB work.
    expect(db.select().from(schemaMod.evidence).all()).toHaveLength(0);
  });

  it('TypeScript prevents omitting captured_by or using a non-connector producer (compile-time invariant)', () => {
    // Real negative compile-time assertions via @ts-expect-error. If
    // ConnectorPayload is ever loosened back to optional captured_by,
    // or widened past `connector_*`, these directives stop suppressing
    // anything and TypeScript reports "Unused '@ts-expect-error'
    // directive" — the typecheck fails, the test fails, the regression
    // is caught.
    //
    // The runtime `expect` after each assignment is incidental; the
    // value of this test is the typecheck behavior on the surrounding
    // assignments.
    const valid: ConnectorPayload = {
      source: 'github_event',
      captured_by: 'connector_github',
      account_domain: 'x.example',
      signal_type: 'engagement',
      fact: 'starred',
      source_url: 'https://github.com/x/y',
      snippet: 'starred x.example',
      captured_at: '2026-05-10T12:00:00.000Z',
    };
    expect(valid.captured_by).toBe('connector_github');

    // @ts-expect-error — captured_by is REQUIRED on ConnectorPayload.
    // If this directive ever has nothing to suppress, ConnectorPayload
    // has been loosened — fail loud.
    const missingCapturedBy: ConnectorPayload = {
      source: 'github_event',
      account_domain: 'x.example',
      signal_type: 'engagement',
      fact: 'starred',
      source_url: 'https://github.com/x/y',
      snippet: 'starred x.example',
      captured_at: '2026-05-10T12:00:00.000Z',
    };
    expect(missingCapturedBy.source).toBe('github_event');

    // @ts-expect-error — captured_by 'webhook' is NOT a connector_*
    // value, so it's not assignable to ConnectorCapturedBy. If this
    // ever stops suppressing, the narrowing is broken.
    const webhookProducer: ConnectorPayload = { ...valid, captured_by: 'webhook' };
    expect(webhookProducer.source).toBe('github_event');

    // @ts-expect-error — 'manual' is in CapturedBy but not connector_*.
    const manualProducer: ConnectorPayload = { ...valid, captured_by: 'manual' };
    expect(manualProducer.source).toBe('github_event');
  });

  it('ConnectorError carries the cause and identifies as a typed connector failure', () => {
    // The orchestrator (Task 3.4) will distinguish connector failures
    // from other thrown errors. Pin the typed-error contract so that
    // distinction stays sound.
    const upstream = new Error('HTTP 429: rate limited');
    const err = new ConnectorError('GitHub poll failed', upstream);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ConnectorError');
    expect(err.message).toBe('GitHub poll failed');
    expect(err.cause).toBe(upstream);
  });
});
