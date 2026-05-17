import { fileURLToPath } from 'node:url';
import type { SignalConnector, ConnectorPayload } from './types';
import { loadFixtureSince } from './fixture-loader';

/**
 * Shape of a row in `tests/fixtures/connectors/outreach/engagement.json`.
 * Outreach engagement events are person-level interactions (opens,
 * replies, clicks) — they carry both a contact and an account.
 */
interface OutreachEvent {
  id: string;
  type: string;
  contactEmail: string;
  accountDomain: string;
  occurredAt: string;
  subject: string;
}

/**
 * Fixture-backed Outreach stub connector.
 *
 * Emits `source: 'engagement_event'` / `captured_by:
 * 'connector_outreach'` — the third (source, producer) pair in the
 * connector matrix, distinct from the two `crm_record` producers.
 * Keeping engagement events on their own source label (vs.
 * `crm_record`) is deliberate: it prevents Outreach activity from
 * accidentally matching CRM-firmographic scoring rules.
 *
 * Fixture-only in v1; default path anchored via `import.meta.url`
 * (cwd-independent — see the Salesforce stub's class doc).
 */
export class OutreachConnector implements SignalConnector {
  readonly name = 'outreach';
  private readonly fixturePath: string;

  constructor(
    fixturePath: string = fileURLToPath(
      new URL('../../tests/fixtures/connectors/outreach/engagement.json', import.meta.url),
    ),
  ) {
    this.fixturePath = fixturePath;
  }

  async fetchSince(since: Date): Promise<ConnectorPayload[]> {
    const events = loadFixtureSince<OutreachEvent>(
      this.fixturePath,
      (e) => e.occurredAt,
      since,
      this.name,
    );
    return events.map((e) => ({
      source: 'engagement_event' as const,
      captured_by: 'connector_outreach' as const,
      account_domain: e.accountDomain,
      contact_email: e.contactEmail,
      signal_type: 'engagement' as const,
      fact: `Outreach engagement: ${e.type} on "${e.subject}"`,
      source_url: `https://outreach.example/event/${e.id}`,
      snippet: `id=${e.id} type=${e.type} subject=${e.subject} contact=${e.contactEmail}`,
      captured_at: e.occurredAt,
      metadata: { outreach_event_id: e.id, type: e.type },
    }));
  }
}
