# Connectors

A **connector** pulls signal events from one upstream source (GitHub, Outreach, Salesforce, etc.) and emits them as `SignalPayload`-shaped objects for the existing `ingestSignal(...)` pipeline to validate and persist. The contract is defined in `lib/connectors/types.ts`; this document is the human-facing version with the rationale.

## The non-negotiable: every signal lands via `ingestSignal`

Connectors never write to the database directly. Whether a signal arrived via `POST /api/signals` (a webhook) or a connector poll, it goes through the **same** Zod validation, the **same** `captured_at` normalization to UTC-Z, the **same** `dedupe_key` uniqueness check, and the **same** trust resolution. There is no "trusted bulk import" path that connectors can use to shortcut these.

This is the contract that lets us reason about the evidence spine: every row in `evidence` has the same provenance shape, the same audit status discipline, and the same de-duplication semantics. A future connector that decides "but my source is reliable, let me skip the audit critic" is not allowed — `trustedSender: true` already means "skip the LLM audit critic for sources in `TRUSTED_SOURCES`," and that's the only mechanism. New sources gain trust by being added to `TRUSTED_SOURCES` in `lib/signals/types.ts` plus the matching `connector_*` value in the source/producer matrix, not by inventing a new ingest path.

## The trust model

Connectors run in-process. They're configured at deploy time — fixture paths, API tokens, polling cadence — by the operator. That's why the orchestrator passes `{ trustedSender: true }` when calling `ingestSignal(...)` for connector output: the connector itself is trusted, just like a connector poll would be in a real CRM-integrated v1.5 deployment.

The trust boundary is layered, and the two enforcement layers (TypeScript + Zod) compose into a stronger guarantee than either alone:

1. **TypeScript-level**: `ConnectorPayload` (in `lib/connectors/types.ts`) requires `captured_by` (the schema's optional field becomes required) and narrows it to the `connector_*` subset of `CAPTURED_BY`. A connector that omits `captured_by` or sets it to `'webhook'` / `'manual'` doesn't compile.

2. **Zod-level**: `SignalPayload`'s `.strict().refine(...)` runs for **every** source, in two branches:
   - For `CONNECTOR_ONLY_SOURCES` (currently `github_event`, `crm_record`, `engagement_event`): `captured_by` MUST be one of the matching `connector_*` values for that source. A connector that emits `source: 'github_event'` with `captured_by: 'connector_outreach'` (mismatched) fails.
   - For all OTHER sources (`intent_data`, `web_traffic`, `form_fill`, etc.): `captured_by` MUST be undefined or `'webhook'`. ANY explicit `connector_*` value fails — non-connector-only sources can never legitimately claim a connector producer.

The two layers compose: TypeScript forces every `ConnectorPayload` to carry a `connector_*` captured_by, and Zod branch (b) forbids `connector_*` for non-connector-only sources. So a `SignalConnector` that tries to emit `source: 'intent_data'` will fail Zod no matter which connector_* it picks. **The only sources a connector can successfully emit are the ones in `CONNECTOR_ONLY_SOURCES`, paired with their matching producer.** Adding a new connector means adding both the source label AND the producer label, atomically — it's a single trust-boundary expansion, not two.

3. **Runtime-level**: the `source` field must also be in `TRUSTED_SOURCES` for the row to land as `verified`. All current `CONNECTOR_ONLY_SOURCES` are in `TRUSTED_SOURCES` today, but a future source added to `CONNECTOR_ONLY_SOURCES` without being added to `TRUSTED_SOURCES` would persist as `pending_audit` even via a connector with `trustedSender: true` — the trust check is orthogonal to the producer matrix.

The matrix lives in `lib/signals/types.ts` (`CONNECTOR_ONLY_SOURCES`); update it when adding a new connector, and update the test suite at the same time so a future drop of the source label can't silently pass type-checking.

## Idempotency and watermarks

Each `fetchSince(since)` call returns events from `[since, now]` — inclusive on the left. A boundary event (one whose `captured_at` equals `since`) is RE-EMITTED on the next poll if the orchestrator stores `since = max(captured_at)`; the `evidence.dedupe_key` UNIQUE index drops the duplicate. Inclusive boundary is the safer choice — strict-after-`since` would silently lose any event with the same timestamp as the boundary (rare upstream-side bursts at the same second) and would drop the boundary event itself if the orchestrator's watermark advance uses `max(captured_at)`. The pattern is "dedupe is the safety net for the boundary, not a license to over-poll" — connectors should still track their own watermark to avoid burning upstream API budget re-fetching old slices.

For implementations that need persistent state beyond a single process invocation (last cursor token, last seen ID), Phase 3 will add either a dedicated `connector_state` table or per-connector columns; for v1 prototypes, holding the watermark in memory is acceptable when the process is long-lived.

## Time

`captured_at` should be the upstream's own event timestamp, in ISO 8601 with any offset format. `ingestSignal` normalizes to UTC-Z at the write boundary (`new Date(captured_at).toISOString()`), so connectors don't need to pre-normalize and shouldn't introduce their own normalization that could disagree with the canonical one. If the upstream returns Unix epoch seconds, convert to ISO once at the connector boundary.

## Fixtures vs. real APIs

Each connector under `lib/connectors/<name>` should ship with a fixture-backed mode for tests and demos — a `<file>.json` under `tests/fixtures/connectors/<name>/`. The interface is identical (`fetchSince(since)`); only the data source differs. This is important for the test suite: real-API tests would require live credentials, hit rate limits, and produce flaky CI. The fixture-mode connector exercises the same code path, validates against the same `SignalPayload` schema, and runs in milliseconds. Real-API connectors should be exercised via a separate integration suite gated behind an explicit `RUN_REAL_CONNECTORS=1` env var.

### Two malformed-data philosophies — pick the right one

As of Task 3.3 there are two connector shapes, and they deliberately handle bad input differently. A new connector author must pick consciously:

- **Real upstream (uncontrolled), e.g. `GitHubConnector`.** A single weird event (null actor, null/garbage timestamp) is *expected noise* from a third party. **Skip the bad event and continue** — one malformed event must not poison the batch. Genuine transport failures (5xx, 429, network) throw `ConnectorError` so the orchestrator backs off and retries.
- **Fixture-backed stub (controlled), e.g. Salesforce/HubSpot/Outreach via `loadFixtureSince`.** The data is *our committed repo content*. A malformed row is a *defect*, not noise. **Throw a plain `Error` (NOT `ConnectorError`)** — fail loud. `ConnectorError` signals "transient, retry with backoff"; retrying cannot fix a rotted fixture, so signalling transient would lie to the orchestrator and make it spin. This mirrors `parseWatchList`'s fail-the-whole-file stance for operator-edited config.

The rule of thumb: **uncontrolled input degrades gracefully; controlled input fails loudly.** `ConnectorError` is reserved exclusively for *transient upstream* conditions the orchestrator can sensibly retry.

### `loadFixtureSince` is not a production template

The shared `lib/connectors/fixture-loader.ts` helper exists for the v1 *stub* connectors only. It validates each row's timestamp against `ISO_DATETIME_WITH_OFFSET` — the single exported source of truth for timestamp format (`lib/signals/types.ts`), the exact rule `ingestSignal` enforces on `captured_at`. Reusing that shared schema (rather than a hand-rolled `new Date()` check) is the load-bearing decision: any gap between what a producer accepts and what ingest accepts is a silent-loss or move-the-failure bug. A future real-API Salesforce/HubSpot/Outreach connector should **not** treat `loadFixtureSince` as its template — it needs its own API client + pagination + `ConnectorError` seam (the `GitHubConnector` shape), while still validating timestamps against the same `ISO_DATETIME_WITH_OFFSET` schema.

## Secrets

API tokens and webhook signing keys live in environment variables (`GITHUB_TOKEN`, `OUTREACH_API_KEY`, etc.) and MUST be documented in `.env.local.example` when each connector is introduced. As of Task 3.2 the only real connector env var is `GITHUB_TOKEN` (PAT with `public_repo` scope for the GitHub connector); future connectors add theirs per task. Connectors must never log secret values or echo them to error messages. The poll orchestrator's logging layer is responsible for redacting secrets if a `ConnectorError` carries an upstream response body.

## Rate limits

Respecting upstream rate limits is the connector's responsibility, not the orchestrator's. Implementations should expose a `pollIntervalSec` (or read it from env) tuned to the upstream's documented limits. On a 429 / `Retry-After`, throw `ConnectorError` with the upstream response as the `cause` — the orchestrator will back off and retry. Don't loop internally on transient failures; that's the orchestrator's job.

## Adding a new connector

Three distinct labels are involved per connector — use the right one in each slot:

- **Connector name** (e.g. `github`): the directory and `SignalConnector.name` value. Lower-case, lab-internal.
- **Signal source label** (e.g. `github_event`): the upstream-recognized source category, stored in `evidence.source_type`. Goes in `SIGNAL_SOURCE`.
- **Producer label** (e.g. `connector_github`): the `captured_by` value identifying *this connector code* as the producer. Goes in `CAPTURED_BY`.

The steps:

1. Create `lib/connectors/<connector-name>/index.ts` exporting a class or factory that implements `SignalConnector`. Set `name` to `<connector-name>`.
2. In `lib/signals/types.ts`:
   - Add the new signal source label (e.g. `'github_event'`) to `SIGNAL_SOURCE`.
   - Add it to `TRUSTED_SOURCES` if the connector's events should land as `verified` rather than `pending_audit`.
   - Add the new producer label (e.g. `'connector_github'`) to `CAPTURED_BY`. The TypeScript `ConnectorCapturedBy` derivation in `lib/connectors/types.ts` will pick it up automatically — `Extract<CapturedBy, 'connector_${string}'>`.
   - Add the source → producer mapping to `CONNECTOR_ONLY_SOURCES` if the source can ONLY be ingested by this connector (i.e. external callers shouldn't be able to claim it via the webhook).
3. Drizzle schema regeneration: the `evidence.source_type` and `evidence.captured_by` columns are `text` with no enum constraint at the SQL level — no migration needed. The Zod schema is the source of truth.
4. Add fixtures under `tests/fixtures/connectors/<connector-name>/`.
5. Add a unit test that drives `fetchSince(...)` against the fixtures, then pipes the output through `ingestSignal` and asserts the resulting rows. The `tests/unit/connectors-contract.test.ts` pattern is the template.
6. Document the env var(s) (API token, webhook secret, polling cadence) in `.env.local.example`.

Steps 2 and 5 are deliberate friction — they force the maintainer to acknowledge "this is a new trust boundary" rather than slipping a new source label past the compiler.
