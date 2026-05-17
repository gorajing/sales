import { readFileSync } from 'node:fs';
import { ISO_DATETIME_WITH_OFFSET } from '../signals/types';

/**
 * Shared fixture loader for the fixture-backed stub connectors
 * (Salesforce / HubSpot / Outreach). The three stubs are otherwise
 * near-identical: read a JSON array, drop rows older than `since`,
 * map survivors to a `ConnectorPayload`. This helper owns the
 * load + parse + since-filter so the per-connector code is just the
 * mapping function — three hand-rolled copies of this plumbing was
 * the real drift risk for Task 3.3 (see the corrected "[TASK 3.3
 * KICKOFF]" note in the plan; the original note guessed
 * `classificationToSignalType`, but stubs have no classification —
 * the duplication is here).
 *
 * # Failure philosophy: fixtures are CONTROLLED data, so fail loud
 *
 * Deliberately asymmetric with `GitHubConnector`, which SKIPS a
 * malformed event (GitHub is an uncontrolled upstream — one weird
 * event shouldn't poison the batch). A fixture is OUR committed
 * data; a malformed timestamp / missing file / non-array JSON is a
 * defect in our repo, not expected upstream noise. So this helper
 * THROWS — and throws a plain `Error`, NOT `ConnectorError`.
 *
 * The `ConnectorError` distinction matters: per the `SignalConnector`
 * contract, `ConnectorError` tells the poll orchestrator "transient,
 * retry with backoff." Retrying cannot fix a rotted fixture, so
 * signalling transient would be a lie that makes the orchestrator
 * spin. A plain `Error` is "programming/data bug — surface in logs
 * uncaught," which is the correct treatment. This mirrors
 * `parseWatchList`'s "controlled config fails the whole file loud"
 * stance from Task 3.2.
 *
 * Throws on the FIRST malformed row rather than collecting all (as
 * `parseWatchList` does for operator-edited config). Fixtures are
 * developer-authored and the failure is rare; first-failure with a
 * context + index + offending-value message is debuggable in
 * seconds and keeps the helper simple. Documented as a deliberate
 * simplicity choice, not an oversight.
 *
 * @param fixturePath absolute path to the JSON fixture (an array)
 * @param getTimestamp pulls the timestamp off a row. Returns
 *   `unknown` deliberately: the row is untrusted fixture data, so
 *   the TS type can't promise the field is a string. The loader
 *   validates the value against `ISO_DATETIME_WITH_OFFSET` — the
 *   exact format rule `ingestSignal` enforces on `captured_at` —
 *   so the loader accepts precisely what ingest accepts. Earlier
 *   ad-hoc guards (`typeof !== 'string'`, then `Number.isFinite`)
 *   each closed only part of the silent-loss class: `new Date(null)`
 *   → epoch 0, `new Date(<number>)` → finite ms, and
 *   `new Date("2026-05-12")` → finite-but-Zod-invalid all slipped
 *   through (codex 3.3 rounds 1 & 2).
 * @param since inclusive lower bound — rows with timestamp >= since
 *   are kept (matches the inclusive `[since, now]` boundary the
 *   GitHub connector and `docs/connectors.md` settled on; the
 *   `evidence.dedupe_key` UNIQUE index is the re-emit safety net)
 * @param context short connector label for error messages
 *   (e.g. 'salesforce')
 */
export function loadFixtureSince<T>(
  fixturePath: string,
  getTimestamp: (row: T) => unknown,
  since: Date,
  context: string,
): T[] {
  let raw: string;
  try {
    raw = readFileSync(fixturePath, 'utf8');
  } catch (err) {
    throw new Error(
      `${context} fixture unreadable at ${fixturePath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${context} fixture is not valid JSON (${fixturePath}): ${(err as Error).message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `${context} fixture must be a JSON array, got ${typeof parsed} (${fixturePath})`,
    );
  }

  const rows = parsed as T[];
  const sinceMs = since.getTime();
  const kept: T[] = [];

  for (let i = 0; i < rows.length; i++) {
    // The row itself may be null / a primitive (a malformed fixture).
    // `getTimestamp` (e.g. `(c) => c.LastModifiedDate`) would throw a
    // raw TypeError with no context in that case — wrap it so the
    // operator sees the connector + path + row index, not a bare
    // "Cannot read properties of null".
    let tsRaw: unknown;
    try {
      tsRaw = getTimestamp(rows[i]);
    } catch (err) {
      throw new Error(
        `${context} fixture row ${i} is malformed (cannot read its ` +
        `timestamp field): ${(err as Error).message} (${fixturePath})`,
        { cause: err },
      );
    }

    // Validate against the EXACT format rule ingestSignal enforces
    // on `captured_at` (`ISO_DATETIME_WITH_OFFSET`, the single
    // source of truth in lib/signals/types.ts). An earlier version
    // used `new Date(x); Number.isFinite` — but `new Date("2026-05-12")`
    // and `new Date("2026-05-12T00:00:00")` are FINITE yet Zod
    // rejects them (no time / no offset). That left a "Date-parseable
    // but contract-invalid" gap: such a row was either silently
    // filtered out by `>= since` or emitted only to be rejected at
    // ingest (move-the-failure). Validating with the shared schema
    // closes the gap — the loader accepts exactly what ingest
    // accepts, no more, no less. Whitespace-padded strings are
    // rejected (not trimmed) because Zod rejects them too.
    const parsed = ISO_DATETIME_WITH_OFFSET.safeParse(tsRaw);
    if (!parsed.success) {
      throw new Error(
        `${context} fixture row ${i} has an invalid timestamp ` +
        `${JSON.stringify(tsRaw)} — must be ISO-8601 with offset ` +
        `(e.g. 2026-05-12T00:00:00.000Z), the same rule ingestSignal ` +
        `enforces on captured_at (${fixturePath})`,
      );
    }

    const ts = new Date(parsed.data).getTime();
    if (ts >= sinceMs) kept.push(rows[i]);
  }

  return kept;
}
