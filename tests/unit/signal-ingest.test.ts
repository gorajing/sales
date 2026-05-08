import { describe, it, expect } from 'vitest';
import { SignalPayload } from '../../lib/signals/types';

describe('SignalPayload schema', () => {
  it('accepts a minimal valid intent signal', () => {
    const ok = SignalPayload.safeParse({
      source: 'intent_data',
      account_domain: 'acme.com',
      signal_type: 'intent',
      fact: 'Acme searched for "vector database" 12 times in the last 7d',
      source_url: 'https://bombora.example/topic/vector-db',
      snippet: 'Surge: vector database, weekly score 87',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an unknown source', () => {
    const fail = SignalPayload.safeParse({
      source: 'tarot_reading',
      account_domain: 'acme.com',
      signal_type: 'intent',
      fact: 'x', source_url: 'https://x.example', snippet: 'x',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(fail.success).toBe(false);
  });

  it('rejects a snippet > 1500 chars', () => {
    const fail = SignalPayload.safeParse({
      source: 'web_traffic',
      account_domain: 'acme.com', signal_type: 'engagement',
      fact: 'x', source_url: 'https://x.example',
      snippet: 'a'.repeat(1501),
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(fail.success).toBe(false);
  });

  it('requires captured_at to be ISO8601', () => {
    const fail = SignalPayload.safeParse({
      source: 'web_traffic',
      account_domain: 'acme.com', signal_type: 'engagement',
      fact: 'x', source_url: 'https://x.example', snippet: 'x',
      captured_at: 'yesterday',
    });
    expect(fail.success).toBe(false);
  });

  it('accepts captured_at with a non-Z timezone offset', () => {
    const ok = SignalPayload.safeParse({
      source: 'web_traffic',
      account_domain: 'acme.com', signal_type: 'engagement',
      fact: 'x', source_url: 'https://x.example', snippet: 'x',
      captured_at: '2026-05-06T05:00:00-07:00',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an empty account_domain', () => {
    const fail = SignalPayload.safeParse({
      source: 'intent_data',
      account_domain: '',
      signal_type: 'intent',
      fact: 'x', source_url: 'https://x.example', snippet: 'x',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(fail.success).toBe(false);
  });

  it('rejects an invalid source_url', () => {
    const fail = SignalPayload.safeParse({
      source: 'intent_data',
      account_domain: 'acme.com',
      signal_type: 'intent',
      fact: 'x', source_url: 'not-a-url', snippet: 'x',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(fail.success).toBe(false);
  });

  it('rejects an invalid contact_email when present', () => {
    const fail = SignalPayload.safeParse({
      source: 'form_fill',
      account_domain: 'acme.com',
      contact_email: 'not-an-email',
      signal_type: 'engagement',
      fact: 'x', source_url: 'https://x.example', snippet: 'x',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(fail.success).toBe(false);
  });

  it('accepts contact_email when null or omitted', () => {
    const a = SignalPayload.safeParse({
      source: 'form_fill', account_domain: 'acme.com',
      contact_email: null,
      signal_type: 'engagement',
      fact: 'x', source_url: 'https://x.example', snippet: 'x',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    const b = SignalPayload.safeParse({
      source: 'form_fill', account_domain: 'acme.com',
      signal_type: 'engagement',
      fact: 'x', source_url: 'https://x.example', snippet: 'x',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
  });

  it('rejects a fact > 500 chars', () => {
    const fail = SignalPayload.safeParse({
      source: 'web_traffic', account_domain: 'acme.com',
      signal_type: 'engagement',
      fact: 'a'.repeat(501),
      source_url: 'https://x.example', snippet: 'x',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(fail.success).toBe(false);
  });

  it('rejects an empty snippet', () => {
    const fail = SignalPayload.safeParse({
      source: 'web_traffic', account_domain: 'acme.com',
      signal_type: 'engagement',
      fact: 'x', source_url: 'https://x.example', snippet: '',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(fail.success).toBe(false);
  });

  it('rejects an unknown captured_by', () => {
    const fail = SignalPayload.safeParse({
      source: 'github_event', account_domain: 'github.com/alice',
      signal_type: 'engagement',
      fact: 'x', source_url: 'https://x.example', snippet: 'x',
      captured_at: '2026-05-06T12:00:00.000Z',
      captured_by: 'connector_unknown',
    });
    expect(fail.success).toBe(false);
  });

  it('accepts known captured_by values', () => {
    for (const cb of ['webhook', 'connector_github', 'connector_salesforce',
                      'connector_hubspot', 'connector_outreach']) {
      const ok = SignalPayload.safeParse({
        source: 'github_event', account_domain: 'github.com/alice',
        signal_type: 'engagement',
        fact: 'x', source_url: 'https://x.example', snippet: 'x',
        captured_at: '2026-05-06T12:00:00.000Z',
        captured_by: cb,
      });
      expect(ok.success).toBe(true);
    }
  });

  it('accepts arbitrary metadata when present', () => {
    const ok = SignalPayload.safeParse({
      source: 'intent_data', account_domain: 'acme.com',
      signal_type: 'intent',
      fact: 'x', source_url: 'https://x.example', snippet: 'x',
      captured_at: '2026-05-06T12:00:00.000Z',
      metadata: { event_id: '123', score: 87, nested: { a: true } },
    });
    expect(ok.success).toBe(true);
  });
});

describe('TRUSTED_SOURCES contract', () => {
  it('contains the allowlisted sources for skip-audit-when-authenticated', async () => {
    const { TRUSTED_SOURCES } = await import('../../lib/signals/types');
    // Trusted: producer-vouched (intent vendors, form fills) + locally-configured connectors.
    expect(TRUSTED_SOURCES.has('intent_data')).toBe(true);
    expect(TRUSTED_SOURCES.has('form_fill')).toBe(true);
    expect(TRUSTED_SOURCES.has('crm_record')).toBe(true);
    expect(TRUSTED_SOURCES.has('engagement_event')).toBe(true);
    expect(TRUSTED_SOURCES.has('github_event')).toBe(true);
  });

  it('excludes scraped / inferential sources that need audit', async () => {
    const { TRUSTED_SOURCES } = await import('../../lib/signals/types');
    // Untrusted: anything where the snippet's relationship to the fact is the
    // model's inference (audit critic must verify).
    expect(TRUSTED_SOURCES.has('web_traffic')).toBe(false);
    expect(TRUSTED_SOURCES.has('social_post')).toBe(false);
    expect(TRUSTED_SOURCES.has('press_release')).toBe(false);
    expect(TRUSTED_SOURCES.has('earnings_call')).toBe(false);
  });
});
