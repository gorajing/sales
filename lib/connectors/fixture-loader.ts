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
 * @param getTimestamp pulls the timestamp off a row. Returns
 *   `unknown` deliberately: the row is untrusted fixture data, so
 *   the TS type can't promise the field is a string. The loader
 *   validates it's a non-blank string before `new Date(...)` —
 *   without that, `new Date(null)` → epoch `0` and
 *   `new Date(<number>)` → a finite ms value both slip the
 *   `Number.isFinite` guard and get SILENTLY filtered as "older
 *   than since" instead of failing loud (codex 3.3 round 1).
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
      );
    }

    // Require a non-blank STRING before `new Date(...)`. This is the
    // load-bearing guard: `new Date(null)` is epoch `0` and
    // `new Date(<number>)` is a finite ms value — both are
    // `Number.isFinite`, so a number/null/missing timestamp would
    // otherwise pass the finiteness check and be silently filtered
    // out by `>= sinceMs` (it's "before 1970"). For controlled
    // fixture data that silent loss is a defect; throw instead.
    if (typeof tsRaw !== 'string' || tsRaw.trim() === '') {
      throw new Error(
        `${context} fixture row ${i} has a non-string or blank ` +
        `timestamp ${JSON.stringify(tsRaw)} — expected an ISO-8601 ` +
        `string (${fixturePath})`,
      );
    }

    const ts = new Date(tsRaw).getTime();
    // Catches malformed strings (`new Date('not-a-date')` → NaN).
    // ISO-format/offset validity beyond "parses to a finite instant"
    // is ingestSignal's Zod `.datetime({offset:true})` job, not the
    // loader's — the loader only needs a usable instant to filter on.
    if (!Number.isFinite(ts)) {
      throw new Error(
        `${context} fixture row ${i} has an unparseable timestamp ` +
        `${JSON.stringify(tsRaw)} (${fixturePath})`,
      );
    }
    if (ts >= sinceMs) kept.push(rows[i]);
  }

  return kept;
}
