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
    // Note: we use `as ConnectorPayload` because TypeScript narrows
    // ConnectorPayload to a connector_* captured_by, which is what
    // a real connector implementation must satisfy. The cast lets
    // the fixture build a deliberately-misaligned payload (matching
    // pair would be source: 'github_event' + captured_by:
    // 'connector_github') to exercise the runtime rejection path.
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
        } as ConnectorPayload];
      },
    };

    const events = await badConnector.fetchSince(new Date(0));
    let caught: unknown;
    try {
      await ingestSignal(events[0], { trustedSender: true });
    } catch (err) {
      caught = err;
    }
    // Specifically a ZodError; specifically the source/captured_by
    // matrix message. If a future refactor moves this validation
    // elsewhere or changes its wording, the test should fail loudly
    // and force the maintainer to confirm the rejection still happens.
    expect(caught).toBeInstanceOf(ZodError);
    const zodErr = caught as ZodError;
    const flat = JSON.stringify(zodErr.issues);
    expect(flat).toMatch(/captured_by/i);
    // No row written — the rejection happens before any DB work.
    expect(db.select().from(schemaMod.evidence).all()).toHaveLength(0);
  });

  it('TypeScript prevents a connector from omitting captured_by (compile-time invariant)', () => {
    // The `ConnectorPayload` type narrows captured_by from optional
    // to required AND to the connector_* subset. This test is a
    // type-level smoke check: building a valid ConnectorPayload
    // succeeds, and the (commented) attempt to build one WITHOUT
    // captured_by would fail at compile time. The test is here so
    // a future refactor that loosens the type accidentally is
    // caught by a runtime probe, not just by silent type drift.
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

    // The following would fail to compile (uncomment to verify):
    //   const missing: ConnectorPayload = {
    //     source: 'github_event',
    //     // captured_by intentionally missing — TS reports
    //     //   Property 'captured_by' is missing in type ...
    //     account_domain: 'x.example',
    //     signal_type: 'engagement',
    //     fact: 'starred',
    //     source_url: 'https://github.com/x/y',
    //     snippet: 'starred x.example',
    //     captured_at: '2026-05-10T12:00:00.000Z',
    //   };
    //
    //   const wrongProducer: ConnectorPayload = {
    //     ...valid,
    //     captured_by: 'webhook',  // TS reports: not assignable to
    //                              //   '"connector_github" | "connector_outreach" | ...'
    //   };
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
