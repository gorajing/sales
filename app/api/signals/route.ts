import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ingestSignal } from '@/lib/signals/ingest';
import {
  timingSafeStringEqual,
  parseMediaType,
  readBoundedBody,
} from '@/lib/alerts/http';

/**
 * POST /api/signals — the webhook ingest boundary.
 *
 * The trust model lives here, not in the request body:
 *
 *   - If `SIGNAL_WEBHOOK_SECRET` is unset, we run permissive (local dev).
 *     Requests succeed but `trustedSender` is `false`, so even payloads with
 *     a TRUSTED_SOURCES `source` land as `pending_audit`. Operators can audit
 *     them through the Extraction Audit critic before they ever influence
 *     scoring/routing.
 *
 *     **Production guard:** when `NODE_ENV === 'production'`, permissive
 *     mode is refused. If the secret isn't set in prod, the route returns
 *     503 with a configuration-error response instead of accepting
 *     unauthenticated writes — fail safe, not fail open.
 *
 *   - If `SIGNAL_WEBHOOK_SECRET` is set, the request must present a matching
 *     `X-Webhook-Secret` header. Comparison is timing-safe (SHA-256 + equal-
 *     length compare) to avoid leaking secret length/prefix to remote
 *     attackers via response-time analysis. Missing/wrong → 401 with no DB
 *     writes. Correct → `trustedSender = true` flows into `ingestSignal`,
 *     which then applies the trust two-factor (`TRUSTED_SOURCES.has(source)
 *     AND trustedSender`) to decide whether to mark the row `verified`.
 *
 * Producer identity is also forced here: this route never trusts a
 * `captured_by` value from the request body. Connectors that legitimately
 * produce `connector_*` rows call `ingestSignal` directly from in-process
 * code (e.g. the connector poll path); they never reach this HTTP boundary.
 *
 * Operational hardening NOT done here:
 *   - **Rate limiting / replay throttling.** Dedupe-key idempotency only
 *     covers exact duplicates; a valid sender flooding distinct payloads is
 *     a gateway concern. Put a reverse proxy / API gateway in front of this
 *     route in any non-trivial deployment.
 *
 * Order of checks is deliberate:
 *   1. Production-config guard (503 if misconfigured).
 *   2. Auth (401 short-circuit; happens BEFORE body read).
 *   3. Content-Type and Content-Length pre-checks (415, 413).
 *   4. Body read + JSON parse (400 on malformed).
 *   5. captured_by-presence reject (400 with auditable error).
 *   6. ingestSignal — Zod validates inside (400 on schema fail), the rest is
 *      atomic via the in-function transaction.
 */

/** Hard cap on raw request body size. The 8KB metadata cap + 1500-char
 * snippet + 500-char fact + small fixed fields fit well under 64KB.
 *
 * `timingSafeStringEqual`, `parseMediaType`, and `readBoundedBody` are
 * imported from `lib/alerts/http.ts` (project-wide shared HTTP helpers;
 * the `alerts/` path is historical — see that module's header). The
 * inline auth flow stays here because /api/signals' "permissive in
 * dev, trustedSender=false" semantics is specific to this route and
 * not generalizable to the shared `requireInternalSecret` helper. */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request) {
  // (1) Production-config guard.
  const expectedSecret = process.env.SIGNAL_WEBHOOK_SECRET;
  if (!expectedSecret && process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error: 'misconfigured',
        detail: 'SIGNAL_WEBHOOK_SECRET must be set in production. ' +
                'Permissive mode is local-dev only.',
      },
      { status: 503 },
    );
  }

  // (2) Auth.
  let trustedSender = false;
  if (expectedSecret) {
    const presented = req.headers.get('x-webhook-secret');
    if (presented === null || !timingSafeStringEqual(presented, expectedSecret)) {
      return NextResponse.json(
        { error: 'unauthorized', detail: 'missing or invalid X-Webhook-Secret' },
        { status: 401 },
      );
    }
    trustedSender = true;
  }
  // If the secret is unset and NODE_ENV !== 'production', stay permissive but
  // `trustedSender` remains false — TRUSTED_SOURCES alone cannot grant
  // 'verified' without auth.

  // (3) Content-Type and Content-Length pre-checks.
  const mediaType = parseMediaType(req.headers.get('content-type'));
  if (mediaType !== null && mediaType !== 'application/json') {
    return NextResponse.json(
      { error: 'unsupported_media_type', detail: 'expected application/json' },
      { status: 415 },
    );
  }
  const declaredLength = req.headers.get('content-length');
  if (declaredLength !== null) {
    const n = parseInt(declaredLength, 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: 'payload_too_large', detail: `body exceeds ${MAX_BODY_BYTES} bytes` },
        { status: 413 },
      );
    }
  }

  // (4) Stream-bounded body read: bail on the first chunk that crosses the
  // cap so peak allocation is bounded even when Content-Length is missing
  // or lies. THEN JSON.parse.
  const readResult = await readBoundedBody(req, MAX_BODY_BYTES);
  if (!readResult.ok) {
    if (readResult.reason === 'too_large') {
      return NextResponse.json(
        { error: 'payload_too_large', detail: `body exceeds ${MAX_BODY_BYTES} bytes` },
        { status: 413 },
      );
    }
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  let body: unknown;
  try {
    body = JSON.parse(readResult.text);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // (5) Refuse any captured_by from external callers. Connectors call
  // ingestSignal directly; the HTTP boundary forces producer = 'webhook'.
  if (body !== null && typeof body === 'object' && 'captured_by' in body) {
    return NextResponse.json(
      {
        error: 'captured_by_not_allowed',
        detail:
          'captured_by is not accepted on webhook payloads. Connectors call ' +
          'the ingest layer directly to set producer identity; webhook ingest ' +
          'always records captured_by="webhook".',
      },
      { status: 400 },
    );
  }

  // (6) Ingest. Zod errors → 400 with { path, code } only — no .received
  // (user values) and no .message (which echoes user-controlled key names
  // for `unrecognized_keys`). Clients can map codes to user-facing messages.
  // Other errors → 500 with generic { error: 'internal' }; raw err is
  // logged server-side via console.error so operators can debug without
  // the response body becoming a reflection oracle.
  try {
    const result = await ingestSignal(body, { trustedSender });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
      }));
      return NextResponse.json(
        { error: 'invalid_payload', issues },
        { status: 400 },
      );
    }
    console.error('[/api/signals] ingest failed:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
