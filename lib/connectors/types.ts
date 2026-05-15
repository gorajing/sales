import type { SignalPayload, CapturedBy } from '../signals/types';

/**
 * `captured_by` values that identify an in-process connector (as
 * opposed to a webhook or manual paste). Derived from the canonical
 * `CapturedBy` union — a future addition to `CAPTURED_BY` in
 * `lib/signals/types.ts` named `connector_*` automatically becomes a
 * valid connector producer; adding e.g. `webhook2` does not. The
 * `${string}` template extracts only the connector_* branches.
 */
export type ConnectorCapturedBy = Extract<CapturedBy, `connector_${string}`>;

/**
 * The exact payload shape a `SignalConnector` is allowed to emit.
 *
 * This is `SignalPayload` with **two TypeScript-level tightenings**
 * that lift connector-trust enforcement from "orchestrator
 * discipline" to "type-level invariant":
 *
 *   1. `captured_by` is REQUIRED (the schema makes it optional;
 *      webhook callers omit it). A connector that forgets to set
 *      it doesn't compile.
 *   2. `captured_by` is narrowed to `connector_*` only. A
 *      connector that emits `captured_by: 'webhook'` or omits the
 *      field — both of which would silently bypass the
 *      source/producer `.refine()` for non-CONNECTOR_ONLY sources
 *      — doesn't compile.
 *
 * The Zod-level `.refine()` in `SignalPayload` is still the runtime
 * safety net (a misconfigured connector that lies about source vs.
 * captured_by hits it), but this type prevents the most common
 * trust-laundering mistake — "I forgot to set captured_by and my
 * source happened to be a non-connector one, so ingest accepted
 * it" — from compiling at all.
 */
export type ConnectorPayload = Omit<SignalPayload, 'captured_by'> & {
  captured_by: ConnectorCapturedBy;
};

/**
 * SignalConnector — produces signal events from an external source
 * (GitHub, Outreach, Salesforce, Hubspot, etc.) ready for
 * `ingestSignal(...)` to validate, normalize, and persist.
 *
 * # The contract: connectors NEVER bypass ingestSignal
 *
 * All connector output MUST terminate in the existing
 * `ingestSignal(raw, { trustedSender: true })` call. A connector
 * implementation may not write directly to `evidence`/`accounts`,
 * skip `SignalPayload` Zod validation, bypass `captured_at`
 * normalization to UTC-Z, or short-circuit the `dedupe_key`
 * uniqueness check. The poll orchestrator (Task 3.4) is the only
 * code path that drives this loop; connectors are pure data sources.
 *
 * This invariant prevents the connector layer from becoming a
 * second "trusted ingest path" with its own subtly different
 * semantics. Every signal — whether from a public webhook or an
 * in-process connector — goes through the same validation,
 * dedupe, and trust-resolution code.
 *
 * # Trust model
 *
 * Connectors run in-process and are configured by the operator at
 * deploy time (API keys, fixture paths, etc.), so they are
 * trusted by definition — the orchestrator calls
 * `ingestSignal(event, { trustedSender: true })`. The trust
 * boundary is layered, and the two layers compose into a stronger
 * guarantee than either alone:
 *
 *   - TypeScript level: `ConnectorPayload` (below) requires
 *     `captured_by` (the schema's optional field becomes required)
 *     and narrows it to the `connector_*` subset. A connector that
 *     omits `captured_by` or sets it to `'webhook'` / `'manual'`
 *     doesn't compile.
 *   - Zod level: `SignalPayload`'s `.strict().refine(...)` runs for
 *     EVERY source, in two branches:
 *       a. For CONNECTOR_ONLY_SOURCES (github_event, crm_record,
 *          engagement_event): captured_by MUST be one of the matching
 *          connector_* values for that source (e.g. connector_github
 *          for github_event). Mismatched producers (github_event +
 *          connector_outreach) fail.
 *       b. For all OTHER sources (intent_data, web_traffic, etc.):
 *          captured_by MUST be undefined or `'webhook'`. ANY explicit
 *          connector_* value fails — non-connector-only sources can
 *          never legitimately claim a connector producer.
 *
 * The two layers compose: TypeScript forces every `ConnectorPayload`
 * to carry a `connector_*` captured_by, and Zod's branch (b)
 * forbids `connector_*` for non-connector-only sources. So a
 * SignalConnector that tries to emit `source: 'intent_data'` will
 * fail Zod no matter which connector_* it picks. The only sources a
 * connector can successfully emit are the ones in
 * CONNECTOR_ONLY_SOURCES, paired with their matching producer.
 *
 *   - Runtime level: the `source` field must also be in
 *     `TRUSTED_SOURCES` for the row to land as `verified` rather
 *     than `pending_audit`. All current CONNECTOR_ONLY_SOURCES are
 *     in TRUSTED_SOURCES today, but a future source added to
 *     CONNECTOR_ONLY_SOURCES without being added to
 *     TRUSTED_SOURCES would persist as `pending_audit` even via
 *     a connector with `trustedSender: true` — the trust check is
 *     orthogonal to the producer matrix.
 *
 * # Idempotency
 *
 * Implementations should fetch the slice (`since`, now] and emit
 * all events captured in that window. Overlapping calls with
 * overlapping windows are SAFE — `evidence.dedupe_key` is the
 * cross-process safety net — but should be avoided to spare
 * upstream API budget. Each connector is expected to track its
 * own high-water mark (per-account, per-installation, etc.); the
 * poll orchestrator persists the watermark in a future
 * `connector_state` table or connector-specific columns (not yet
 * added; for v1 prototypes in-memory state in a long-lived
 * process is acceptable).
 *
 * # Time
 *
 * `captured_at` should be the upstream's event time, formatted as
 * ISO 8601 in any offset shape (Z, ±HH:MM). ingestSignal normalizes
 * to UTC-Z at write time — connectors do NOT need to pre-normalize.
 *
 * # Errors
 *
 * Transient upstream failures (5xx, rate limits, network glitches)
 * should throw `ConnectorError` so the poll orchestrator can apply
 * backoff. Any other thrown error is treated as a programming bug
 * and propagates uncaught to surface in logs.
 */
export interface SignalConnector {
  /** Stable connector identifier. Used for log lines, env-var
   *  lookup (`<NAME>_API_KEY`, etc.), and the URL slug if/when a
   *  connector-poll HTTP endpoint is added. Lower-case, no
   *  whitespace. Examples: 'github', 'outreach', 'salesforce'. */
  readonly name: string;

  /**
   * Pull signals captured strictly after `since` from the upstream
   * source and return them as `ConnectorPayload`-shaped events. The
   * orchestrator will pass each event through `ingestSignal(event,
   * { trustedSender: true })` — implementations should NOT call
   * ingestSignal directly.
   *
   * The `ConnectorPayload` return type (vs. raw `SignalPayload`)
   * enforces at compile time that every emitted event names its
   * connector via `captured_by: connector_*`. This blocks the
   * "forgot to set captured_by and source was a non-connector one"
   * trust-laundering path that the Zod `.refine()` doesn't catch.
   *
   * Implementations MUST:
   *   - Emit `source` ∈ `TRUSTED_SOURCES` (from `lib/signals/types.ts`).
   *   - Emit `captured_by` matching the source/producer matrix
   *     for connector-only sources (e.g. `connector_github` for
   *     `source: 'github_event'`). The type system enforces that
   *     captured_by is a `connector_*` value, not undefined.
   *   - Emit `captured_at` as ISO 8601 (offset OK; ingest normalizes).
   *   - Throw `ConnectorError` on upstream failures so the
   *     orchestrator can back off without crashing the poller.
   *
   * The orchestrator handles iteration, watermark advancement,
   * and dispatching to ingestSignal. Connectors are otherwise pure.
   */
  fetchSince(since: Date): Promise<ConnectorPayload[]>;
}

/**
 * Thrown by a connector implementation when an upstream call fails
 * (HTTP 5xx, rate-limit hit, malformed response, transient network
 * error). The poll orchestrator catches this to apply backoff;
 * other thrown errors propagate as unexpected bugs.
 */
export class ConnectorError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConnectorError';
  }
}
