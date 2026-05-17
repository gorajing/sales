import { fileURLToPath } from 'node:url';
import type { SignalConnector, ConnectorPayload } from './types';
import { loadFixtureSince } from './fixture-loader';

/**
 * Shape of a row in `tests/fixtures/connectors/hubspot/accounts.json`.
 * HubSpot "company" objects are account-level, not contact-level —
 * there is no person here, so the emitted payload has no
 * `contact_email` (see the note in `fetchSince`).
 */
interface HubSpotCompany {
  id: string;
  domain: string;
  name: string;
  industry: string;
  size: string;
  lastModifiedAt: string;
}

/**
 * Fixture-backed HubSpot stub connector.
 *
 * Like the Salesforce stub, this emits `source: 'crm_record'` — but
 * with `captured_by: 'connector_hubspot'`. Both producers are valid
 * for `crm_record` per the `CONNECTOR_ONLY_SOURCES` matrix in
 * `lib/signals/types.ts`. The per-connector contract test
 * specifically pipes BOTH through `ingestSignal` to prove the matrix
 * accepts each producer — testing only one would leave the other's
 * source/producer pairing unverified.
 *
 * Fixture-only in v1; default path anchored via `import.meta.url`
 * (cwd-independent — see the Salesforce stub's class doc for the
 * rationale).
 */
export class HubSpotConnector implements SignalConnector {
  readonly name = 'hubspot';
  private readonly fixturePath: string;

  constructor(
    fixturePath: string = fileURLToPath(
      new URL('../../tests/fixtures/connectors/hubspot/accounts.json', import.meta.url),
    ),
  ) {
    this.fixturePath = fixturePath;
  }

  async fetchSince(since: Date): Promise<ConnectorPayload[]> {
    const companies = loadFixtureSince<HubSpotCompany>(
      this.fixturePath,
      (a) => a.lastModifiedAt,
      since,
      this.name,
    );
    return companies.map((a) => ({
      source: 'crm_record' as const,
      captured_by: 'connector_hubspot' as const,
      account_domain: a.domain,
      // Intentionally NO contact_email — a HubSpot company is an
      // account, not a person. Emitting `contact_email: ''` would
      // be rejected by SignalPayload's `z.string().email()`; omitting
      // the key keeps it `undefined`, which the schema allows
      // (`.nullable().optional()`).
      signal_type: 'firmographic' as const,
      fact: `HubSpot company: ${a.name} (${a.industry}, ${a.size})`,
      source_url: `https://hubspot.example/company/${a.id}`,
      snippet: `id=${a.id} name=${a.name} industry=${a.industry} size=${a.size}`,
      captured_at: a.lastModifiedAt,
      metadata: { hs_company_id: a.id },
    }));
  }
}
