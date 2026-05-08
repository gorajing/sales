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
  it('rejects metadata > 8KB serialized (ASCII case)', () => {
    const huge = { blob: 'x'.repeat(9000) };
    expect(SignalPayload.safeParse({ ...validBase, metadata: huge }).success).toBe(false);
  });

  it('rejects metadata > 8KB by UTF-8 bytes even when JS .length is shorter', () => {
    // Multi-byte chars: each '🙂' is 4 bytes UTF-8 but 2 chars in JS .length.
    // This payload is ~6KB by .length but ~12KB by UTF-8 bytes — must reject.
    const huge = { blob: '🙂'.repeat(3000) };
    expect(SignalPayload.safeParse({ ...validBase, metadata: huge }).success).toBe(false);
  });

  it('accepts metadata under the cap', () => {
    const fits = { blob: 'x'.repeat(7000) };  // ~7KB serialized, under the 8KB cap
    expect(SignalPayload.safeParse({ ...validBase, metadata: fits }).success).toBe(true);
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

// Drift guards: assert directly against Drizzle's runtime `enumValues` so the
// test fails the moment db/schema.ts diverges from the signal layer constants.
// No hardcoded mirrors — this catches drift the same day it lands.
describe('Schema enum drift guards (signals vs db/schema.ts:evidence)', () => {
  const evidenceSourceTypeEnum = (schema.evidence.sourceType as any).enumValues as readonly string[];
  const evidenceCapturedByEnum = (schema.evidence.capturedBy as any).enumValues as readonly string[];
  const evidenceSignalTypeEnum = (schema.evidence.signalType as any).enumValues as readonly string[];

  it('exposes evidence.sourceType.enumValues at runtime', () => {
    expect(Array.isArray(evidenceSourceTypeEnum)).toBe(true);
    expect(evidenceSourceTypeEnum.length).toBeGreaterThan(0);
  });

  it('SIGNAL_SOURCE is a subset of evidence.source_type', () => {
    for (const s of SIGNAL_SOURCE) {
      expect(evidenceSourceTypeEnum).toContain(s);
    }
  });

  it('CAPTURED_BY is a subset of evidence.captured_by', () => {
    for (const cb of CAPTURED_BY) {
      expect(evidenceCapturedByEnum).toContain(cb);
    }
  });

  it('SIGNAL_TYPE is a subset of evidence.signal_type minus "none"', () => {
    // evidence.signal_type includes 'none' (the resting state for non-signal
    // evidence — e.g. rows from auto-research). Ingest paths must always
    // classify, so SIGNAL_TYPE excludes 'none'. This test asserts both
    // directions: every SIGNAL_TYPE value is in the schema enum, and the
    // schema enum minus 'none' equals SIGNAL_TYPE.
    for (const t of SIGNAL_TYPE) {
      expect(evidenceSignalTypeEnum).toContain(t);
    }
    expect(evidenceSignalTypeEnum).toContain('none');
    expect((SIGNAL_TYPE as readonly string[])).not.toContain('none');
    const schemaSignalTypesMinusNone = evidenceSignalTypeEnum.filter((v) => v !== 'none').sort();
    const signalTypeSorted = [...SIGNAL_TYPE].sort();
    expect(schemaSignalTypesMinusNone).toEqual(signalTypeSorted);
  });
});
