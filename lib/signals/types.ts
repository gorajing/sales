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
 * Sources that an authenticated sender is trusted to vouch for, allowing the
 * ingested evidence row to skip the extraction audit critic and go straight
 * to `extractionStatus = 'verified'`.
 *
 * Trust here is a TWO-FACTOR property — it's only granted when BOTH:
 *   (1) the source label is in this set, AND
 *   (2) `ingestSignal` was called with `{ trustedSender: true }` (which the
 *       webhook route only sets when the shared-secret check passed; the
 *       connector poll path sets it because in-process configured code is
 *       trusted by definition).
 *
 * Without authentication, even `intent_data` lands as `pending_audit`. This
 * blocks an attacker who reaches an open webhook from forging a trusted-
 * source label and bypassing audit.
 */
export const TRUSTED_SOURCES: ReadonlySet<SignalSource> = new Set([
  // Producer-vouched: vendor APIs and form fills carry their own snippet
  // verbatim from a known-trusted upstream.
  'intent_data', 'form_fill',
  // Locally-configured connectors: trust comes from the operator's choice
  // of fixtures / repos / API tokens, not the source label alone.
  'crm_record', 'engagement_event', 'github_event',
] satisfies SignalSource[]);

/**
 * The contract that every ingested signal — webhook or connector — must
 * satisfy. Validation happens at the ingest boundary (`ingestSignal`) so
 * downstream code can rely on these invariants.
 *
 * Field notes:
 *   - `account_domain` is required and non-empty. `ingestSignal` lowercases
 *     it for the partial unique index on `accounts.domain`.
 *   - `contact_email` is optional / nullable; when present, ingest creates
 *     or resolves the contact under the account.
 *   - `fact` is capped at 500 chars to keep human-readable summaries short
 *     and printable; the verbatim `snippet` (≤1500) carries the longer text.
 *   - `captured_at` accepts ISO 8601 with offset (`Z` or `±HH:MM`) so
 *     third-party webhooks that emit local-zone timestamps are accepted.
 *   - `captured_by` is optional. Webhook ingests omit it; connectors MUST
 *     set it. The default in `ingestSignal` is `'webhook'`.
 *   - `metadata` is a free-form JSON bag for connector-specific provenance
 *     (event IDs, classification labels, etc.).
 */
export const SignalPayload = z.object({
  source: z.enum(SIGNAL_SOURCE),
  account_domain: z.string().min(1),
  contact_email: z.string().email().nullable().optional(),
  signal_type: z.enum(SIGNAL_TYPE),
  fact: z.string().min(1).max(500),
  source_url: z.string().url(),
  snippet: z.string().min(1).max(1500),
  captured_at: z.string().datetime({ offset: true }),
  captured_by: z.enum(CAPTURED_BY).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SignalPayload = z.infer<typeof SignalPayload>;
