import { fileURLToPath } from 'node:url';
import type { SignalConnector, ConnectorPayload } from './types';
import { loadFixtureSince } from './fixture-loader';

/**
 * Shape of a row in `tests/fixtures/connectors/salesforce/contacts.json`.
 * Mirrors the Salesforce REST `Contact` SObject subset we use. The
 * `Account.Domain` key is dotted (Salesforce relationship-field
 * notation) so it needs a quoted property + bracket access.
 */
interface SalesforceContact {
  Id: string;
  Email: string;
  Name: string;
  Title: string;
  'Account.Domain': string;
  LastModifiedDate: string;
}

/**
 * Fixture-backed Salesforce stub connector.
 *
 * v1 is fixture-only — there is no live Salesforce integration. The
 * stub exists so the scoring/routing pipeline can be demoed end-to-end
 * with CRM-shaped signals, and so the `SignalConnector` contract is
 * exercised by a second source type (`crm_record`) beyond GitHub.
 *
 * Emits `ConnectorPayload[]` (NOT `SignalPayload[]` as the original
 * plan draft showed) so TypeScript enforces `captured_by` is a
 * `connector_*` value at compile time — the same Task 3.1 narrowing
 * the GitHub connector uses.
 *
 * The default fixture path is anchored to THIS module via
 * `import.meta.url`, not `process.cwd()`. A cwd-relative default is
 * the brittleness codex flagged in Task 3.2 round 2 (breaks under
 * `vitest --root`, IDE runners, etc.). The lib→tests/fixtures
 * coupling is inherent to "stub": the fixture IS this connector's
 * data source in v1. A real-API mode is a future task and would
 * read from env/config instead.
 */
export class SalesforceConnector implements SignalConnector {
  readonly name = 'salesforce';
  private readonly fixturePath: string;

  constructor(
    fixturePath: string = fileURLToPath(
      new URL('../../tests/fixtures/connectors/salesforce/contacts.json', import.meta.url),
    ),
  ) {
    this.fixturePath = fixturePath;
  }

  async fetchSince(since: Date): Promise<ConnectorPayload[]> {
    const contacts = loadFixtureSince<SalesforceContact>(
      this.fixturePath,
      (c) => c.LastModifiedDate,
      since,
      this.name,
    );
    return contacts.map((c) => ({
      source: 'crm_record' as const,
      captured_by: 'connector_salesforce' as const,
      account_domain: c['Account.Domain'],
      contact_email: c.Email,
      signal_type: 'firmographic' as const,
      fact: `Salesforce contact: ${c.Name} (${c.Title}) at ${c['Account.Domain']}`,
      source_url: `https://salesforce.example/Contact/${c.Id}`,
      snippet: `Id=${c.Id} Email=${c.Email} Name=${c.Name} Title=${c.Title}`,
      captured_at: c.LastModifiedDate,
      metadata: { sf_contact_id: c.Id },
    }));
  }
}
