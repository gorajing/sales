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
import type { SignalConnector } from '../../lib/connectors/types';
import { ConnectorError } from '../../lib/connectors/types';
import { ingestSignal } from '../../lib/signals/ingest';
import type { SignalPayload } from '../../lib/signals/types';

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
      async fetchSince(): Promise<SignalPayload[]> {
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

  it('a connector that emits a mismatched source/captured_by is REJECTED by ingestSignal', async () => {
    // The point of the rejection: the Zod source/producer matrix on
    // SignalPayload runs INSIDE ingestSignal. A connector that
    // tries to claim a connector_github producer for an
    // intent_data source (or vice versa) hits the validation wall
    // — there's no connector-specific bypass.
    const badConnector: SignalConnector = {
      name: 'fixture-bad',
      async fetchSince(): Promise<SignalPayload[]> {
        return [{
          source: 'intent_data',                  // webhook-eligible source
          captured_by: 'connector_github',        // claims to be a connector
          account_domain: 'fixture.example',
          signal_type: 'intent',
          fact: 'forged claim',
          source_url: 'https://bombora.example/x',
          snippet: 'forged claim — connector pretending to be a source it is not',
          captured_at: '2026-05-10T12:00:00.000Z',
        }];
      },
    };

    const events = await badConnector.fetchSince(new Date(0));
    await expect(
      ingestSignal(events[0], { trustedSender: true }),
    ).rejects.toThrow();  // ZodError from .refine() — exact message is ingest's concern

    // No row written — the rejection happens before any DB work.
    expect(db.select().from(schemaMod.evidence).all()).toHaveLength(0);
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
