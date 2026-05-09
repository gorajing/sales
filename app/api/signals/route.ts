import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ingestSignal } from '@/lib/signals/ingest';

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
 * snippet + 500-char fact + small fixed fields fit well under 64KB. */
const MAX_BODY_BYTES = 64 * 1024;

function timingSafeStringEqual(a: string, b: string): boolean {
  // Hash both inputs to fixed-length 32-byte digests so timingSafeEqual's
  // equal-length precondition is met regardless of secret/presented lengths.
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

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
  const contentType = req.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
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

  // (4) Read body as text first so we can apply the size cap even when the
  // sender omits/lies about Content-Length, then JSON.parse.
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: 'payload_too_large', detail: `body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
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

  // (6) Ingest. Zod errors → 400 with sanitized issue list (no echo of user
  // input via .received). Other errors → 500 with generic detail; the raw
  // error is logged server-side for operators.
  try {
    const result = await ingestSignal(body, { trustedSender });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
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
