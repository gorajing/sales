# Connectors

A **connector** pulls signal events from one upstream source (GitHub, Outreach, Salesforce, etc.) and emits them as `SignalPayload`-shaped objects for the existing `ingestSignal(...)` pipeline to validate and persist. The contract is defined in `lib/connectors/types.ts`; this document is the human-facing version with the rationale.

## The non-negotiable: every signal lands via `ingestSignal`

Connectors never write to the database directly. Whether a signal arrived via `POST /api/signals` (a webhook) or a connector poll, it goes through the **same** Zod validation, the **same** `captured_at` normalization to UTC-Z, the **same** `dedupe_key` uniqueness check, and the **same** trust resolution. There is no "trusted bulk import" path that connectors can use to shortcut these.

This is the contract that lets us reason about the evidence spine: every row in `evidence` has the same provenance shape, the same audit status discipline, and the same de-duplication semantics. A future connector that decides "but my source is reliable, let me skip the audit critic" is not allowed — `trustedSender: true` already means "skip the LLM audit critic for sources in `TRUSTED_SOURCES`," and that's the only mechanism. New sources gain trust by being added to `TRUSTED_SOURCES` in `lib/signals/types.ts` plus the matching `connector_*` value in the source/producer matrix, not by inventing a new ingest path.

## The trust model

Connectors run in-process. They're configured at deploy time — fixture paths, API tokens, polling cadence — by the operator. That's why the orchestrator passes `{ trustedSender: true }` when calling `ingestSignal(...)` for connector output: the connector itself is trusted, just like a connector poll would be in a real CRM-integrated v1.5 deployment. But the *event* still has to satisfy the source/producer matrix. A connector that emits `source: 'intent_data'` with `captured_by: 'connector_github'` fails Zod validation inside `ingestSignal` — same code path as a misconfigured webhook. Connectors can't manufacture trust by claiming a source they don't have.

The matrix lives in `lib/signals/types.ts` (`CONNECTOR_ONLY_SOURCES`); update it when adding a new connector, and update the test suite at the same time so a future drop of the source label can't silently pass type-checking.

## Idempotency and watermarks

Each `fetchSince(since)` call returns events from `(since, now]`. The orchestrator advances `since` after each successful drain. If two calls run with overlapping windows (a restart, a retry, two operators triggering a poll), the `evidence.dedupe_key` UNIQUE index catches duplicates — no double-count. Connectors should still track their own watermark to avoid burning upstream API budget on already-seen events; the design intent is "dedupe is the safety net, not the primary mechanism."

For implementations that need persistent state beyond a single process invocation (last cursor token, last seen ID), Phase 3 will add either a dedicated `connector_state` table or per-connector columns; for v1 prototypes, holding the watermark in memory is acceptable when the process is long-lived.

## Time

`captured_at` should be the upstream's own event timestamp, in ISO 8601 with any offset format. `ingestSignal` normalizes to UTC-Z at the write boundary (`new Date(captured_at).toISOString()`), so connectors don't need to pre-normalize and shouldn't introduce their own normalization that could disagree with the canonical one. If the upstream returns Unix epoch seconds, convert to ISO once at the connector boundary.

## Fixtures vs. real APIs

Each connector under `lib/connectors/<name>` should ship with a fixture-backed mode for tests and demos — typically a `<name>-fixtures.json` file under `tests/fixtures/connectors/`. The interface is identical (`fetchSince(since)`); only the data source differs. This is important for the test suite: real-API tests would require live credentials, hit rate limits, and produce flaky CI. The fixture-mode connector exercises the same code path, validates against the same `SignalPayload` schema, and runs in milliseconds. Real-API connectors should be exercised via a separate integration suite gated behind an explicit `RUN_REAL_CONNECTORS=1` env var.

## Secrets

API tokens and webhook signing keys live in environment variables (`GITHUB_TOKEN`, `OUTREACH_API_KEY`, etc.) and are documented in `.env.local.example`. Connectors must never log secret values or echo them to error messages. The poll orchestrator's logging layer is responsible for redacting secrets if a `ConnectorError` carries an upstream response body.

## Rate limits

Respecting upstream rate limits is the connector's responsibility, not the orchestrator's. Implementations should expose a `pollIntervalSec` (or read it from env) tuned to the upstream's documented limits. On a 429 / `Retry-After`, throw `ConnectorError` with the upstream response as the `cause` — the orchestrator will back off and retry. Don't loop internally on transient failures; that's the orchestrator's job.

## Adding a new connector

1. Create `lib/connectors/<name>/index.ts` exporting a class or factory that implements `SignalConnector`.
2. Add `<name>` to `CONNECTOR_ONLY_SOURCES` in `lib/signals/types.ts` (if it's a connector-only source) and to `TRUSTED_SOURCES`.
3. Add a `<name>` value to the `CAPTURED_BY` enum in the same file.
4. Add fixtures under `tests/fixtures/connectors/<name>/`.
5. Add a unit test that drives `fetchSince(...)` against the fixtures, then pipes the output through `ingestSignal` and asserts the resulting rows.
6. Document the env var(s) in `.env.local.example`.

The schema changes in steps 2 and 3 are deliberate friction — they force the maintainer to acknowledge "this is a new trust boundary" rather than slipping a new source label past the compiler.
