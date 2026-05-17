import { readFileSync } from 'node:fs';

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
 * @param getTimestamp pulls the ISO-8601 timestamp string off a row
 * @param since inclusive lower bound — rows with timestamp >= since
 *   are kept (matches the inclusive `[since, now]` boundary the
 *   GitHub connector and `docs/connectors.md` settled on; the
 *   `evidence.dedupe_key` UNIQUE index is the re-emit safety net)
 * @param context short connector label for error messages
 *   (e.g. 'salesforce')
 */
export function loadFixtureSince<T>(
  fixturePath: string,
  getTimestamp: (row: T) => string,
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
    const tsRaw = getTimestamp(rows[i]);
    const ts = new Date(tsRaw).getTime();
    // `new Date('not-a-date').getTime()` is NaN; NaN compares false
    // against everything, so without this guard a bad row would be
    // SILENTLY dropped by the `>= sinceMs` filter (the exact silent-
    // loss class codex flagged on the GitHub connector). For a
    // controlled fixture we want the opposite of silent — throw.
    if (!Number.isFinite(ts)) {
      throw new Error(
        `${context} fixture row ${i} has an invalid timestamp ` +
        `${JSON.stringify(tsRaw)} (${fixturePath})`,
      );
    }
    if (ts >= sinceMs) kept.push(rows[i]);
  }

  return kept;
}
