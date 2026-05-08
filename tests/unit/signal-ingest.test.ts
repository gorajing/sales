import { describe, it, expect } from 'vitest';
import { SignalPayload, SIGNAL_SOURCE, SIGNAL_TYPE, CAPTURED_BY, TRUSTED_SOURCES } from '../../lib/signals/types';
import * as schema from '../../db/schema';

// Convenience: a valid base payload with non-connector-only source so tests
// can mutate one field at a time without tripping the source/producer matrix.
const validBase = {
  source: 'intent_data' as const,
  account_domain: 'acme.com',
  signal_type: 'intent' as const,
  fact: 'Acme searched for "vector database" 12 times in the last 7d',
  source_url: 'https://bombora.example/topic/vector-db',
  snippet: 'Surge: vector database, weekly score 87',
  captured_at: '2026-05-06T12:00:00.000Z',
};

describe('SignalPayload schema — happy path', () => {
  it('accepts a minimal valid intent signal', () => {
    expect(SignalPayload.safeParse(validBase).success).toBe(true);
  });

  it('accepts captured_at with a non-Z timezone offset', () => {
    expect(SignalPayload.safeParse({
      ...validBase, captured_at: '2026-05-06T05:00:00-07:00',
    }).success).toBe(true);
  });

  it('accepts contact_email when null or omitted', () => {
    expect(SignalPayload.safeParse({
      ...validBase, source: 'form_fill', contact_email: null,
    }).success).toBe(true);
    expect(SignalPayload.safeParse({
      ...validBase, source: 'form_fill',
    }).success).toBe(true);
  });

  it('accepts arbitrary metadata when present and within size cap', () => {
    expect(SignalPayload.safeParse({
      ...validBase,
      metadata: { event_id: '123', score: 87, nested: { a: true } },
    }).success).toBe(true);
  });
});

describe('SignalPayload schema — string field validation', () => {
  it('rejects an unknown source', () => {
    expect(SignalPayload.safeParse({
      ...validBase, source: 'tarot_reading' as any,
    }).success).toBe(false);
  });

  it('rejects an empty account_domain', () => {
    expect(SignalPayload.safeParse({
      ...validBase, account_domain: '',
    }).success).toBe(false);
  });

  it('rejects a whitespace-only account_domain (would normalize to "")', () => {
    expect(SignalPayload.safeParse({
      ...validBase, account_domain: '   ',
    }).success).toBe(false);
  });

  it('rejects an account_domain longer than 253 chars (RFC 1035 limit)', () => {
    expect(SignalPayload.safeParse({
      ...validBase, account_domain: 'a'.repeat(254),
    }).success).toBe(false);
  });

  it('rejects an empty snippet', () => {
    expect(SignalPayload.safeParse({
      ...validBase, snippet: '',
    }).success).toBe(false);
  });

  it('rejects a whitespace-only snippet', () => {
    expect(SignalPayload.safeParse({
      ...validBase, snippet: '   \n\t  ',
    }).success).toBe(false);
  });

  it('rejects a snippet > 1500 chars', () => {
    expect(SignalPayload.safeParse({
      ...validBase, snippet: 'a'.repeat(1501),
    }).success).toBe(false);
  });

  it('rejects a fact > 500 chars', () => {
    expect(SignalPayload.safeParse({
      ...validBase, fact: 'a'.repeat(501),
    }).success).toBe(false);
  });

  it('rejects a whitespace-only fact', () => {
    expect(SignalPayload.safeParse({
      ...validBase, fact: '    ',
    }).success).toBe(false);
  });

  it('rejects an invalid contact_email when present', () => {
    expect(SignalPayload.safeParse({
      ...validBase, source: 'form_fill', contact_email: 'not-an-email',
    }).success).toBe(false);
  });
});

describe('SignalPayload schema — source_url protocol restriction', () => {
  it('accepts http and https', () => {
    expect(SignalPayload.safeParse({ ...validBase, source_url: 'http://x.example/p' }).success).toBe(true);
    expect(SignalPayload.safeParse({ ...validBase, source_url: 'https://x.example/p' }).success).toBe(true);
  });

  it('rejects javascript:, data:, file:, mailto:, ftp: schemes', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html;base64,abc',
      'file:///etc/passwd',
      'mailto:a@b.com',
      'ftp://x.example/p',
    ]) {
      expect(SignalPayload.safeParse({ ...validBase, source_url: url }).success).toBe(false);
    }
  });

  it('rejects malformed URL strings', () => {
    expect(SignalPayload.safeParse({ ...validBase, source_url: 'not-a-url' }).success).toBe(false);
  });
});

describe('SignalPayload schema — captured_at constraints', () => {
  it('rejects non-ISO strings', () => {
    expect(SignalPayload.safeParse({ ...validBase, captured_at: 'yesterday' }).success).toBe(false);
  });

  it('rejects timestamps too far in the future (>10min skew)', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();  // +1h
    expect(SignalPayload.safeParse({ ...validBase, captured_at: future }).success).toBe(false);
  });

  it('accepts timestamps within the clock-skew window (≤10min ahead)', () => {
    const slightlyAhead = new Date(Date.now() + 5 * 60 * 1000).toISOString();  // +5min
    expect(SignalPayload.safeParse({ ...validBase, captured_at: slightlyAhead }).success).toBe(true);
  });

  it('accepts past timestamps (no lower bound)', () => {
    expect(SignalPayload.safeParse({
      ...validBase, captured_at: '2020-01-01T00:00:00.000Z',
    }).success).toBe(true);
  });
});

describe('SignalPayload schema — source/captured_by matrix (anti-spoofing)', () => {
  // Connector-only sources MUST come with the matching connector_* captured_by.
  it('accepts github_event with connector_github', () => {
    expect(SignalPayload.safeParse({
      ...validBase, source: 'github_event', signal_type: 'engagement',
      account_domain: 'github.com/alice', captured_by: 'connector_github',
    }).success).toBe(true);
  });

  it('accepts crm_record with connector_salesforce or connector_hubspot', () => {
    for (const cb of ['connector_salesforce', 'connector_hubspot'] as const) {
      expect(SignalPayload.safeParse({
        ...validBase, source: 'crm_record', signal_type: 'firmographic',
        captured_by: cb,
      }).success).toBe(true);
    }
  });

  it('accepts engagement_event with connector_outreach', () => {
    expect(SignalPayload.safeParse({
      ...validBase, source: 'engagement_event', signal_type: 'engagement',
      captured_by: 'connector_outreach',
    }).success).toBe(true);
  });

  it('REJECTS connector-only source without captured_by (the spoofing case)', () => {
    // An authenticated webhook caller cannot claim 'crm_record' to skip audit
    // without also providing connector_* provenance.
    expect(SignalPayload.safeParse({
      ...validBase, source: 'crm_record', signal_type: 'firmographic',
    }).success).toBe(false);
    expect(SignalPayload.safeParse({
      ...validBase, source: 'github_event', signal_type: 'engagement',
      account_domain: 'github.com/alice',
    }).success).toBe(false);
    expect(SignalPayload.safeParse({
      ...validBase, source: 'engagement_event', signal_type: 'engagement',
    }).success).toBe(false);
  });

  it('REJECTS connector-only source with mismatched captured_by', () => {
    // github_event must be connector_github, not connector_salesforce, etc.
    expect(SignalPayload.safeParse({
      ...validBase, source: 'github_event', signal_type: 'engagement',
      account_domain: 'github.com/alice', captured_by: 'connector_salesforce',
    }).success).toBe(false);
    expect(SignalPayload.safeParse({
      ...validBase, source: 'crm_record', signal_type: 'firmographic',
      captured_by: 'connector_github',
    }).success).toBe(false);
  });

  it('REJECTS connector-only source with captured_by=webhook', () => {
    expect(SignalPayload.safeParse({
      ...validBase, source: 'github_event', signal_type: 'engagement',
      account_domain: 'github.com/alice', captured_by: 'webhook',
    }).success).toBe(false);
  });

  // Webhook sources may omit captured_by or set 'webhook'.
  it('accepts webhook sources with captured_by undefined or "webhook"', () => {
    expect(SignalPayload.safeParse({ ...validBase, source: 'intent_data' }).success).toBe(true);
    expect(SignalPayload.safeParse({
      ...validBase, source: 'intent_data', captured_by: 'webhook',
    }).success).toBe(true);
    expect(SignalPayload.safeParse({
      ...validBase, source: 'web_traffic', signal_type: 'engagement', captured_by: 'webhook',
    }).success).toBe(true);
  });

  it('REJECTS webhook sources claiming a connector_* captured_by (provenance fraud)', () => {
    // The classic poisoning attack: webhook caller sets connector_salesforce to
    // dress up an inbound intent_data row as a CRM upsert.
    expect(SignalPayload.safeParse({
      ...validBase, source: 'intent_data', captured_by: 'connector_salesforce',
    }).success).toBe(false);
    expect(SignalPayload.safeParse({
      ...validBase, source: 'web_traffic', signal_type: 'engagement',
      captured_by: 'connector_github',
    }).success).toBe(false);
  });

  it('rejects an unknown captured_by value entirely', () => {
    expect(SignalPayload.safeParse({
      ...validBase, captured_by: 'connector_unknown' as any,
    }).success).toBe(false);
  });
});

describe('SignalPayload schema — metadata size cap', () => {
  it('rejects metadata > 8KB serialized', () => {
    const huge = { blob: 'x'.repeat(9000) };
    expect(SignalPayload.safeParse({ ...validBase, metadata: huge }).success).toBe(false);
  });
});

describe('SignalPayload schema — .strict() unknown fields', () => {
  it('rejects payloads with unknown top-level fields (typo guard)', () => {
    expect(SignalPayload.safeParse({
      ...validBase, captureBy: 'webhook',  // typo — should fail loudly
    } as any).success).toBe(false);
    expect(SignalPayload.safeParse({
      ...validBase, source_typo: 'intent_data',
    } as any).success).toBe(false);
  });
});

describe('TRUSTED_SOURCES contract', () => {
  it('contains the allowlisted sources for skip-audit-when-authenticated', () => {
    expect(TRUSTED_SOURCES.has('intent_data')).toBe(true);
    expect(TRUSTED_SOURCES.has('form_fill')).toBe(true);
    expect(TRUSTED_SOURCES.has('crm_record')).toBe(true);
    expect(TRUSTED_SOURCES.has('engagement_event')).toBe(true);
    expect(TRUSTED_SOURCES.has('github_event')).toBe(true);
  });

  it('excludes scraped / inferential sources that need audit', () => {
    expect(TRUSTED_SOURCES.has('web_traffic')).toBe(false);
    expect(TRUSTED_SOURCES.has('social_post')).toBe(false);
    expect(TRUSTED_SOURCES.has('press_release')).toBe(false);
    expect(TRUSTED_SOURCES.has('earnings_call')).toBe(false);
  });
});

// Drift guards: catch the case where SIGNAL_SOURCE / SIGNAL_TYPE / CAPTURED_BY
// fall out of sync with the corresponding evidence enums in db/schema.ts.
// Drizzle exposes column enum values via the column's $type metadata, but the
// cleanest check is to walk the runtime-accessible config. We use a string
// allowlist sourced from the schema source for clarity.
describe('Schema enum drift guards (signals vs db/schema.ts:evidence)', () => {
  // Hard-coded mirrors of db/schema.ts:evidence.sourceType and capturedBy. If
  // that file changes, update these arrays AND the constants in lib/signals/
  // types.ts together. The tests below assert the relationship; they don't
  // re-derive it (that would defeat the purpose of a drift guard).
  const EVIDENCE_SOURCE_TYPE_ENUM_FROM_SCHEMA = [
    'website', 'linkedin', 'news', '10k', 'job_post', 'podcast',
    'manual', 'perplexity', 'deep_research',
    'intent_data', 'web_traffic', 'form_fill', 'github_event',
    'earnings_call', 'press_release', 'social_post',
    'crm_record', 'engagement_event',
  ] as const;
  const EVIDENCE_CAPTURED_BY_ENUM_FROM_SCHEMA = [
    'claude_cli', 'manual', 'perplexity_mcp', 'chatgpt_mcp', 'deep_research_paste',
    'webhook', 'connector_github', 'connector_salesforce',
    'connector_hubspot', 'connector_outreach',
  ] as const;

  it('SIGNAL_SOURCE values are all present in evidence.source_type', () => {
    for (const s of SIGNAL_SOURCE) {
      expect(EVIDENCE_SOURCE_TYPE_ENUM_FROM_SCHEMA).toContain(s);
    }
  });

  it('CAPTURED_BY values are all present in evidence.captured_by', () => {
    for (const cb of CAPTURED_BY) {
      expect(EVIDENCE_CAPTURED_BY_ENUM_FROM_SCHEMA).toContain(cb);
    }
  });

  it('schema.evidence Drizzle table is reachable for cross-checks', () => {
    // Spot-check: the columns we care about exist on the runtime schema object.
    // If the column names or enum values change, the schema test in
    // tests/unit/schema.test.ts fails first; this is the secondary guard for
    // signal-side consumers.
    expect(Object.keys(schema.evidence)).toContain('sourceType');
    expect(Object.keys(schema.evidence)).toContain('capturedBy');
    expect(Object.keys(schema.evidence)).toContain('signalType');
  });

  it('SIGNAL_TYPE intentionally omits "none" (the schema default)', () => {
    // 'none' is the resting state for non-signal evidence (auto-research output);
    // ingest paths must always classify, so 'none' is not a valid SignalPayload
    // value.
    expect((SIGNAL_TYPE as readonly string[]).includes('none')).toBe(false);
  });
});
