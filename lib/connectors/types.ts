import type { SignalPayload } from '../signals/types';

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
 * `ingestSignal(event, { trustedSender: true })`. But each
 * connector's emitted `source` still has to be in `TRUSTED_SOURCES`
 * (`lib/signals/types.ts`) AND the matching `captured_by` value
 * must satisfy the source/producer matrix on `SignalPayload`'s
 * `.strict().refine(...)`. A connector that lies about either
 * (e.g. emits `source: 'intent_data'` with
 * `captured_by: 'connector_github'`) fails Zod validation inside
 * ingestSignal, exactly as a misconfigured webhook would.
 *
 * # Idempotency
 *
 * Implementations should fetch the slice (`since`, now] and emit
 * all events captured in that window. Overlapping calls with
 * overlapping windows are SAFE — `evidence.dedupe_key` is the
 * cross-process safety net — but should be avoided to spare
 * upstream API budget. Each connector is expected to track its
 * own high-water mark (per-account, per-installation, etc.) in
 * whatever schema makes sense; the poll orchestrator persists
 * the watermark in `engagement_events` or a connector-specific
 * table introduced in Phase 3.
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
   * source and return them as `SignalPayload`-shaped events. The
   * orchestrator will pass each event through `ingestSignal(event,
   * { trustedSender: true })` — implementations should NOT call
   * ingestSignal directly.
   *
   * Implementations MUST:
   *   - Emit `source` ∈ `TRUSTED_SOURCES` (from `lib/signals/types.ts`).
   *   - Emit `captured_by` matching the source/producer matrix
   *     (e.g. `connector_github` for `source: 'github_event'`).
   *   - Emit `captured_at` as ISO 8601 (offset OK; ingest normalizes).
   *   - Throw `ConnectorError` on upstream failures so the
   *     orchestrator can back off without crashing the poller.
   *
   * The orchestrator handles iteration, watermark advancement,
   * and dispatching to ingestSignal. Connectors are otherwise pure.
   */
  fetchSince(since: Date): Promise<SignalPayload[]>;
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
