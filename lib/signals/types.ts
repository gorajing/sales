import { z } from 'zod';

/**
 * Source label for an inbound signal. Mirrors the `evidence.source_type` enum
 * in `db/schema.ts` for the subset of values that ingest paths can produce.
 *
 * Naming conventions:
 *   - `intent_data` / `web_traffic` / `form_fill` — first-party or vendor-pushed
 *     events about prospect behavior on owned surfaces or via intent providers.
 *   - `github_event` — public GitHub activity (stars, issues, PR merges).
 *   - `earnings_call` / `press_release` / `social_post` — public-channel events
 *     summarized by the Claude CLI; relationship of snippet to fact is inferred,
 *     so these go through extraction audit before scoring/routing.
 *   - `crm_record` / `engagement_event` — connector-originated rows from CRMs
 *     (Salesforce, HubSpot) and sales engagement platforms (Outreach). Distinct
 *     from `form_fill` so scoring rules can distinguish CRM upserts from genuine
 *     demo-request submissions.
 */
export const SIGNAL_SOURCE = [
  'intent_data', 'web_traffic', 'form_fill', 'github_event',
  'earnings_call', 'press_release', 'social_post',
  'crm_record', 'engagement_event',
] as const;
export type SignalSource = typeof SIGNAL_SOURCE[number];

/**
 * Coarse classification of what the signal *means*. Distinct from `source`
 * (where it came from) so the same source type can carry different semantic
 * shapes — e.g. a `github_event` star is `engagement`, but a competitor-repo
 * star is a `trigger_event`.
 */
export const SIGNAL_TYPE = [
  'intent', 'engagement', 'firmographic',
  'technographic', 'trigger_event',
] as const;
export type SignalType = typeof SIGNAL_TYPE[number];

/**
 * Producer identity for an evidence row. Mirrors a subset of the
 * `evidence.captured_by` enum — specifically the values that webhook and
 * connector ingest paths produce. Connector implementations MUST set the
 * matching `connector_*` value so downstream scoring/routing rules can
 * distinguish a CRM upsert from an inbound webhook of the same `source` type.
 */
export const CAPTURED_BY = [
  'webhook',
  'connector_github', 'connector_salesforce',
  'connector_hubspot', 'connector_outreach',
] as const;
export type CapturedBy = typeof CAPTURED_BY[number];

/**
 * Source/producer matrix.
 *
 * Some sources are CONNECTOR-ONLY: they only have a meaningful provenance
 * story when emitted from a configured local connector. If a webhook caller
 * supplies one of these sources, they must also supply the matching
 * `captured_by` — and the webhook route layer (Task 1.4) refuses any
 * `captured_by` from external callers, so in practice the connector path is
 * the only way these sources reach ingest.
 *
 * Other sources are WEBHOOK-OR-OMITTED: they may carry no `captured_by`, or
 * the explicit value `'webhook'`. They can never carry a `connector_*` value
 * (that would be provenance fraud — a webhook claiming to be a connector).
 */
const CONNECTOR_ONLY_SOURCES: Readonly<Record<string, ReadonlyArray<CapturedBy>>> = {
  github_event: ['connector_github'],
  crm_record: ['connector_salesforce', 'connector_hubspot'],
  engagement_event: ['connector_outreach'],
};

/**
 * Sources that an authenticated sender is trusted to vouch for, allowing the
 * ingested evidence row to skip the extraction audit critic and go straight
 * to `extractionStatus = 'verified'`.
 *
 * Trust is a TWO-FACTOR property — it's only granted when BOTH:
 *   (1) the source label is in this set, AND
 *   (2) `ingestSignal` was called with `{ trustedSender: true }` (which the
 *       webhook route only sets when the shared-secret check passed; the
 *       connector poll path sets it because in-process configured code is
 *       trusted by definition).
 *
 * Without authentication, even `intent_data` lands as `pending_audit`. This
 * blocks an attacker who reaches an open webhook from forging a trusted-
 * source label and bypassing audit.
 *
 * The schema also enforces the source/producer matrix above, so an
 * authenticated webhook can't claim a connector source without supplying
 * matching connector provenance, AND the webhook route refuses any
 * `captured_by` from external callers — so the connector-only sources here
 * are reachable only via the in-process connector poll path in practice.
 */
export const TRUSTED_SOURCES: ReadonlySet<SignalSource> = new Set([
  // Producer-vouched: vendor APIs and form fills carry their own snippet
  // verbatim from a known-trusted upstream.
  'intent_data', 'form_fill',
  // Locally-configured connectors: trust comes from the operator's choice
  // of fixtures / repos / API tokens, not the source label alone.
  'crm_record', 'engagement_event', 'github_event',
] satisfies SignalSource[]);

// Internal helpers ---------------------------------------------------------

const HTTP_PROTOCOL_RE = /^https?:\/\//i;
const MAX_DOMAIN_LEN = 253;          // RFC 1035 §3.1
const MAX_FACT_CHARS = 500;
const MAX_SNIPPET_CHARS = 1500;
const MAX_METADATA_BYTES = 8 * 1024; // serialized JSON cap; keeps payloads sane
const FUTURE_SKEW_MS = 10 * 60 * 1000; // 10 minutes of permitted clock skew

const nonBlank = (msg: string) =>
  z.string().refine((s) => s.trim().length > 0, { message: msg });

// --------------------------------------------------------------------------

/**
 * The contract that every ingested signal — webhook or connector — must
 * satisfy. Validation happens at the ingest boundary (`ingestSignal`) so
 * downstream code can rely on these invariants.
 *
 * Field notes:
 *   - `account_domain` is required, non-blank-after-trim, ≤253 chars.
 *     `ingestSignal` lowercases it for the partial unique index on
 *     `accounts.domain`. Whitespace-only would otherwise normalize to ''
 *     and bypass the index that excludes empty strings.
 *   - `contact_email` is optional / nullable; when present, ingest creates
 *     or resolves the contact under the account.
 *   - `fact` and `snippet` are non-blank after trim and bounded.
 *   - `source_url` must be http(s). Zod's `.url()` accepts `javascript:`,
 *     `data:`, `file:`, `mailto:`, `ftp:` etc.; this evidence is rendered
 *     as an anchor in the UI and may later be fetched by audit, so we
 *     restrict the protocol set explicitly.
 *   - `captured_at` accepts ISO 8601 with offset (`Z` or `±HH:MM`) and
 *     rejects values too far in the future (clock-skew guard against
 *     misconfigured producers distorting decay windows / cooldown keys).
 *   - `captured_by` is optional. Webhook ingests omit it; connectors MUST
 *     set the matching value. The `.strict()` on the object plus the
 *     refinement below enforce the source/producer matrix.
 *   - `metadata` is a free-form JSON bag for connector-specific provenance
 *     (event IDs, classification labels, etc.), capped at 8KB serialized.
 *   - `.strict()` rejects unknown fields so producer typos surface loudly.
 */
export const SignalPayload = z.object({
  source: z.enum(SIGNAL_SOURCE),
  account_domain: nonBlank('account_domain cannot be empty or whitespace-only')
    .max(MAX_DOMAIN_LEN, 'account_domain exceeds 253 chars'),
  contact_email: z.string().email().nullable().optional(),
  signal_type: z.enum(SIGNAL_TYPE),
  fact: nonBlank('fact cannot be empty or whitespace-only')
    .max(MAX_FACT_CHARS, `fact exceeds ${MAX_FACT_CHARS} chars`),
  source_url: z.string().url()
    .refine((u) => HTTP_PROTOCOL_RE.test(u), {
      message: 'source_url must use http or https',
    }),
  snippet: nonBlank('snippet cannot be empty or whitespace-only')
    .max(MAX_SNIPPET_CHARS, `snippet exceeds ${MAX_SNIPPET_CHARS} chars`),
  captured_at: z.string().datetime({ offset: true })
    .refine((iso) => {
      const t = new Date(iso).getTime();
      return t <= Date.now() + FUTURE_SKEW_MS;
    }, { message: `captured_at cannot be more than ${FUTURE_SKEW_MS / 60000} minutes in the future` }),
  captured_by: z.enum(CAPTURED_BY).optional(),
  metadata: z.record(z.string(), z.unknown())
    .refine((m) => {
      // Use UTF-8 byte length, not String.length (which is UTF-16 code units).
      // A 4-byte emoji is `length === 2` in JS but `4` bytes encoded — without
      // this, the cap silently allows ~2× the stated limit for non-ASCII.
      try { return Buffer.byteLength(JSON.stringify(m), 'utf8') <= MAX_METADATA_BYTES; }
      catch { return false; }
    }, { message: `metadata exceeds ${MAX_METADATA_BYTES} bytes serialized (UTF-8)` })
    .optional(),
}).strict()
  .refine((p) => {
    // Source/producer matrix enforcement.
    const allowed = CONNECTOR_ONLY_SOURCES[p.source];
    if (allowed) {
      // Connector-only source: captured_by must be one of the matching values.
      return p.captured_by !== undefined && allowed.includes(p.captured_by);
    }
    // Webhook source: captured_by must be undefined or 'webhook'.
    return p.captured_by === undefined || p.captured_by === 'webhook';
  }, {
    message:
      'source/captured_by mismatch — connector-only sources (github_event, ' +
      'crm_record, engagement_event) require matching connector_* captured_by; ' +
      'all other sources allow only undefined or "webhook"',
    path: ['captured_by'],
  });
export type SignalPayload = z.infer<typeof SignalPayload>;
