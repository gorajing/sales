import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { SignalPayload, SIGNAL_SOURCE, SIGNAL_TYPE, CAPTURED_BY, TRUSTED_SOURCES } from '../../lib/signals/types';
import * as schema from '../../db/schema';

// In-memory DB mock for ingestSignal tests. The schema/contract tests above
// don't import from '@/db', so this mock only affects the ingestSignal block.
vi.mock('@/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schemaMod = await import('../../db/schema');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const _dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: schemaMod });
  migrate(db, { migrationsFolder: path.resolve(_dirname, '../../db/migrations') });
  return { db, schema: schemaMod };
});

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

// =============================================================================
// ingestSignal — the actual function. Uses the in-memory DB mock above.
// =============================================================================

describe('ingestSignal', () => {
  // Lazy import inside beforeEach so the mocked '@/db' is in place.
  let ingestSignal: typeof import('../../lib/signals/ingest').ingestSignal;
  let db: typeof import('@/db').db;
  let s: typeof schema;

  beforeEach(async () => {
    const ingestMod = await import('../../lib/signals/ingest');
    ingestSignal = ingestMod.ingestSignal;
    const dbMod = await import('@/db');
    db = dbMod.db;
    s = dbMod.schema;
    db.delete(s.evidence).run();
    db.delete(s.contacts).run();
    db.delete(s.accounts).run();
  });

  function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      source: 'intent_data',
      account_domain: 'newco.io',
      signal_type: 'intent',
      fact: 'spike in vector-db keywords',
      source_url: 'https://bombora.example/x',
      snippet: 'Surge: vector database, weekly score 87',
      captured_at: '2026-05-06T12:00:00.000Z',
      ...overrides,
    };
  }

  // ---- account/contact resolution -----------------------------------------

  it('creates a new account when account_domain is unknown', async () => {
    const result = await ingestSignal(basePayload());
    expect(result.accountId).toMatch(/^acc_/);
    expect(result.evidenceId).toMatch(/^ev_/);
    const accounts = db.select().from(s.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].domain).toBe('newco.io');
    expect(result.deduped).toBe(false);
  });

  it('reuses existing account by domain (no duplicate account)', async () => {
    // Pre-existing account
    db.insert(s.accounts).values({
      id: 'acc_existing', name: 'Acme', domain: 'acme.com',
    }).run();
    await ingestSignal(basePayload({
      account_domain: 'acme.com', source: 'web_traffic', signal_type: 'engagement',
      snippet: 'visit_id=abc, page=/pricing',
    }));
    const accounts = db.select().from(s.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('acc_existing');
  });

  it('normalizes domain casing to lowercase before storage and resolution', async () => {
    // First call with mixed case
    const a = await ingestSignal(basePayload({ account_domain: 'NewCo.IO' }));
    // Second call with lower case — must resolve to same account
    const b = await ingestSignal(basePayload({
      account_domain: 'newco.io',
      source: 'web_traffic', signal_type: 'engagement',
      snippet: 'different snippet to avoid dedupe',
    }));
    expect(a.accountId).toBe(b.accountId);
    const accounts = db.select().from(s.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].domain).toBe('newco.io');  // stored lowercased
  });

  it('resolves contact by email when email exists under same account', async () => {
    // Pre-existing account + contact with email
    db.insert(s.accounts).values({ id: 'acc_existing', name: 'Acme', domain: 'acme.com' }).run();
    db.insert(s.contacts).values({
      id: 'ct_existing', accountId: 'acc_existing',
      fullName: 'Jane Doe', email: 'jane@acme.com',
    }).run();
    const result = await ingestSignal(basePayload({
      source: 'form_fill', signal_type: 'engagement',
      account_domain: 'acme.com', contact_email: 'jane@acme.com',
      snippet: 'jane@acme.com submitted demo-request',
      source_url: 'https://acme.com/contact',
    }));
    expect(result.contactId).toBe('ct_existing');
    const contacts = db.select().from(s.contacts).all();
    expect(contacts).toHaveLength(1);  // no duplicate
  });

  it('creates a new contact when email is unknown under any account', async () => {
    const result = await ingestSignal(basePayload({
      source: 'form_fill', signal_type: 'engagement',
      account_domain: 'newco.io', contact_email: 'jane@newco.io',
      snippet: 'jane@newco.io submitted demo-request',
      source_url: 'https://newco.io/contact',
    }));
    expect(result.contactId).toMatch(/^ct_/);
    const contacts = db.select().from(s.contacts).all();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].email).toBe('jane@newco.io');
  });

  it('SECURITY: leaves evidence.contactId NULL when email belongs to a different account', async () => {
    // Pre-existing: jane@target.com under target.com
    db.insert(s.accounts).values({ id: 'acc_target', name: 'Target', domain: 'target.com' }).run();
    db.insert(s.contacts).values({
      id: 'ct_target_jane', accountId: 'acc_target',
      fullName: 'Jane Target', email: 'jane@target.com',
    }).run();

    // Attacker submits a signal claiming jane@target.com under evil.com
    const result = await ingestSignal(basePayload({
      source: 'form_fill', signal_type: 'engagement',
      account_domain: 'evil.com', contact_email: 'jane@target.com',
      snippet: 'jane@target.com filled form on evil.com',
      source_url: 'https://evil.com/form',
    }));

    // The new account is created for evil.com
    const acc = db.select().from(s.accounts).all();
    expect(acc).toHaveLength(2);
    expect(acc.find((a) => a.domain === 'evil.com')).toBeDefined();

    // But the evidence is NOT linked to the existing target.com contact —
    // contactId is null. Cross-account contact poisoning is blocked.
    expect(result.contactId).toBeNull();
    const ev = db.select().from(s.evidence).where(eq(s.evidence.id, result.evidenceId)).get();
    expect(ev?.contactId).toBeNull();

    // No new contact was created either (would have hit unique email index).
    expect(db.select().from(s.contacts).all()).toHaveLength(1);
  });

  it('normalizes email casing to lowercase before storage', async () => {
    // Note: Zod's .email() validator rejects leading/trailing whitespace at
    // parse time, so ingest never sees a raw '  jane@x.com  '. Casing is the
    // only normalization ingest needs to perform — RFC 5321 says local-parts
    // are case-sensitive but in practice mailbox lookups treat them
    // case-insensitively, and the unique-email index relies on lowercased
    // storage to do its job.
    const result = await ingestSignal(basePayload({
      source: 'form_fill', signal_type: 'engagement',
      account_domain: 'acme.com', contact_email: 'Jane@ACME.COM',
      snippet: 'demo request',
      source_url: 'https://acme.com/contact',
    }));
    const contact = db.select().from(s.contacts).where(eq(s.contacts.id, result.contactId!)).get();
    expect(contact?.email).toBe('jane@acme.com');
  });

  // ---- trust model ---------------------------------------------------------

  it('marks trusted-source + authenticated-sender signals as verified', async () => {
    const result = await ingestSignal(basePayload(), { trustedSender: true });
    const ev = db.select().from(s.evidence).where(eq(s.evidence.id, result.evidenceId)).get();
    expect(ev?.extractionStatus).toBe('verified');
  });

  it('keeps trusted-source signals as pending_audit when sender is not authenticated', async () => {
    const result = await ingestSignal(basePayload());  // no trustedSender
    const ev = db.select().from(s.evidence).where(eq(s.evidence.id, result.evidenceId)).get();
    expect(ev?.extractionStatus).toBe('pending_audit');
  });

  it('marks untrusted-source signals as pending_audit even when authenticated', async () => {
    const result = await ingestSignal(basePayload({
      source: 'social_post', signal_type: 'trigger_event',
    }), { trustedSender: true });
    const ev = db.select().from(s.evidence).where(eq(s.evidence.id, result.evidenceId)).get();
    expect(ev?.extractionStatus).toBe('pending_audit');
  });

  // ---- provenance ----------------------------------------------------------

  it('defaults capturedBy to "webhook" when not set', async () => {
    const result = await ingestSignal(basePayload());
    expect(result.capturedBy).toBe('webhook');
    const ev = db.select().from(s.evidence).where(eq(s.evidence.id, result.evidenceId)).get();
    expect(ev?.capturedBy).toBe('webhook');
  });

  it('preserves connector provenance when captured_by is set', async () => {
    const result = await ingestSignal(basePayload({
      source: 'crm_record', signal_type: 'firmographic',
      account_domain: 'acme.com',
      source_url: 'https://salesforce.example/Contact/003xx',
      snippet: 'Id=003xx Email=alice@acme.com',
      captured_by: 'connector_salesforce',
    }), { trustedSender: true });
    const ev = db.select().from(s.evidence).where(eq(s.evidence.id, result.evidenceId)).get();
    expect(ev?.capturedBy).toBe('connector_salesforce');
    expect(result.capturedBy).toBe('connector_salesforce');
  });

  // ---- idempotency ---------------------------------------------------------

  it('is idempotent on duplicate payload (same dedupe key returns same evidenceId)', async () => {
    const payload = basePayload({
      source: 'form_fill', signal_type: 'engagement',
      account_domain: 'acme.com',
      source_url: 'https://acme.com/contact',
      snippet: 'name=Jane,email=jane@acme.com,form=demo-request',
    });
    const a = await ingestSignal(payload);
    const b = await ingestSignal(payload);
    expect(a.evidenceId).toBe(b.evidenceId);
    expect(b.deduped).toBe(true);
    expect(db.select().from(s.evidence).all()).toHaveLength(1);
  });

  it('produces SEPARATE evidence rows for the same snippet under different accounts (cross-account scoping)', async () => {
    // Same snippet, source_url, capturedBy — but different account_domain.
    // The dedupe key includes account_domain, so these must NOT collide.
    const a = await ingestSignal(basePayload({
      account_domain: 'acme.com',
      source_url: 'https://shared-press-release.example/x',
      snippet: 'Press release names Acme and Globex as customers',
    }));
    const b = await ingestSignal(basePayload({
      account_domain: 'globex.com',
      source_url: 'https://shared-press-release.example/x',
      snippet: 'Press release names Acme and Globex as customers',
    }));
    expect(a.evidenceId).not.toBe(b.evidenceId);
    expect(db.select().from(s.evidence).all()).toHaveLength(2);
  });

  it('handles concurrent duplicate calls without creating duplicates', async () => {
    // Better-sqlite3 is single-writer; this validates the catch-and-reselect
    // pattern handles JS-level concurrency races correctly.
    const payload = basePayload({
      source: 'form_fill', signal_type: 'engagement',
      account_domain: 'race.com',
      contact_email: 'duplicate@race.com',
      source_url: 'https://race.com/x',
      snippet: 'race-snippet',
    });
    const [a, b, c] = await Promise.all([
      ingestSignal(payload),
      ingestSignal(payload),
      ingestSignal(payload),
    ]);
    expect(new Set([a.evidenceId, b.evidenceId, c.evidenceId]).size).toBe(1);
    expect(db.select().from(s.accounts).all()).toHaveLength(1);
    expect(db.select().from(s.contacts).all()).toHaveLength(1);
    expect(db.select().from(s.evidence).all()).toHaveLength(1);
  });

  // ---- atomicity / contract enforcement -----------------------------------

  it('rejects a Zod-invalid payload without writing any rows', async () => {
    await expect(
      ingestSignal({ source: 'tarot_reading', account_domain: 'foo' } as any)
    ).rejects.toThrow();
    expect(db.select().from(s.accounts).all()).toHaveLength(0);
    expect(db.select().from(s.contacts).all()).toHaveLength(0);
    expect(db.select().from(s.evidence).all()).toHaveLength(0);
  });

  it('rejects a payload that would skip the source/captured_by matrix without writing rows', async () => {
    // Webhook caller trying to claim connector_salesforce on intent_data.
    await expect(
      ingestSignal(basePayload({ captured_by: 'connector_salesforce' }), { trustedSender: true })
    ).rejects.toThrow();
    expect(db.select().from(s.accounts).all()).toHaveLength(0);
    expect(db.select().from(s.evidence).all()).toHaveLength(0);
  });

  // ---- dedupe upgrade behavior --------------------------------------------

  it('upgrades pending_audit → verified on re-ingest with stronger authentication', async () => {
    // Codex round 1 BLOCKER: an unauthenticated webhook hit followed by an
    // authenticated retry would silently keep the row at pending_audit. The
    // dedupe path now upgrades the existing row's status when the new call
    // would yield 'verified'.
    const payload = basePayload();  // intent_data, in TRUSTED_SOURCES
    const a = await ingestSignal(payload);  // unauthenticated → pending_audit
    expect(db.select().from(s.evidence).where(eq(s.evidence.id, a.evidenceId)).get()?.extractionStatus)
      .toBe('pending_audit');
    const b = await ingestSignal(payload, { trustedSender: true });
    expect(b.evidenceId).toBe(a.evidenceId);
    expect(b.deduped).toBe(true);
    expect(db.select().from(s.evidence).where(eq(s.evidence.id, a.evidenceId)).get()?.extractionStatus)
      .toBe('verified');
  });

  it('does NOT downgrade a verified row when re-ingested without trustedSender', async () => {
    const payload = basePayload();
    const a = await ingestSignal(payload, { trustedSender: true });
    expect(db.select().from(s.evidence).where(eq(s.evidence.id, a.evidenceId)).get()?.extractionStatus)
      .toBe('verified');
    await ingestSignal(payload);  // unauthenticated retry
    expect(db.select().from(s.evidence).where(eq(s.evidence.id, a.evidenceId)).get()?.extractionStatus)
      .toBe('verified');  // unchanged
  });

  it('does NOT touch a disputed row on re-ingest (audit verdict is sticky)', async () => {
    const payload = basePayload();
    const a = await ingestSignal(payload);
    // Simulate the audit critic marking it disputed.
    db.update(s.evidence).set({ extractionStatus: 'disputed' })
      .where(eq(s.evidence.id, a.evidenceId)).run();
    // Re-ingest with trustedSender — must NOT promote disputed → verified.
    await ingestSignal(payload, { trustedSender: true });
    expect(db.select().from(s.evidence).where(eq(s.evidence.id, a.evidenceId)).get()?.extractionStatus)
      .toBe('disputed');
  });

  // ---- case-insensitive resolution (defense in depth) ---------------------

  // Coverage note: the post-insert catch-and-reselect branches in ingestSignal
  // are reachable only under true write-side concurrency between two
  // transactions. With one in-memory better-sqlite3 connection and synchronous
  // Drizzle transactions, those races cannot be deterministically reproduced
  // without test-only seams in production code or fragile internal-API spies.
  // The branches are short, structurally mirror the SELECT path, and apply the
  // same trust-upgrade helper (maybeUpgradeTrust) — verified by inspection
  // rather than execution. Any future refactor should preserve that mirror.

  it('resolves a pre-existing mixed-case domain via lower() lookup', async () => {
    // A future code path that bypasses normalization could insert a mixed-case
    // domain. The case-insensitive index allows it; ingest's lower() lookup
    // must find it without falling through to a unique-violating insert.
    db.insert(s.accounts).values({
      id: 'acc_mixed', name: 'Acme', domain: 'Acme.COM',
    }).run();
    const result = await ingestSignal(basePayload({ account_domain: 'acme.com' }));
    expect(result.accountId).toBe('acc_mixed');
    expect(db.select().from(s.accounts).all()).toHaveLength(1);
  });

  it('resolves a pre-existing mixed-case email via lower() lookup', async () => {
    db.insert(s.accounts).values({ id: 'acc_1', name: 'Acme', domain: 'acme.com' }).run();
    db.insert(s.contacts).values({
      id: 'ct_mixed', accountId: 'acc_1',
      fullName: 'Jane', email: 'JANE@Acme.COM',
    }).run();
    const result = await ingestSignal(basePayload({
      source: 'form_fill', signal_type: 'engagement',
      account_domain: 'acme.com', contact_email: 'jane@acme.com',
      snippet: 'jane@acme.com filled form',
      source_url: 'https://acme.com/contact',
    }));
    expect(result.contactId).toBe('ct_mixed');
    expect(db.select().from(s.contacts).all()).toHaveLength(1);
  });

  // ----------------------------------------------------------------------
  // captured_at normalization — defends against the "Zod accepts but
  // SQLite strftime returns NULL" mismatch for offsets outside ±14:00.
  // ----------------------------------------------------------------------

  it('normalizes captured_at to UTC-Z form regardless of input offset', async () => {
    // Input with a -07:00 offset (Pacific). Stored value must be the
    // equivalent UTC-Z form, NOT the original offset string.
    const result = await ingestSignal(basePayload({
      account_domain: 'pst.example',
      captured_at: '2026-05-10T05:00:00.000-07:00',  // = 12:00 UTC
    }));
    const row = db.select().from(s.evidence)
      .where(eq(s.evidence.id, result.evidenceId)).get();
    expect(row?.capturedAt).toBe('2026-05-10T12:00:00.000Z');
  });

  it('normalizes captured_at preserves UTC-Z input unchanged', async () => {
    const result = await ingestSignal(basePayload({
      account_domain: 'utc.example',
      captured_at: '2026-05-10T12:00:00.000Z',
    }));
    const row = db.select().from(s.evidence)
      .where(eq(s.evidence.id, result.evidenceId)).get();
    expect(row?.capturedAt).toBe('2026-05-10T12:00:00.000Z');
  });
});
