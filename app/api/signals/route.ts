import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
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
 *   - If `SIGNAL_WEBHOOK_SECRET` is set, the request must present a matching
 *     `X-Webhook-Secret` header. Missing/wrong → 401 with no DB writes.
 *     Correct → `trustedSender = true` flows into `ingestSignal`, which then
 *     applies the trust two-factor (`TRUSTED_SOURCES.has(source) AND
 *     trustedSender`) to decide whether to mark the row `verified`.
 *
 * Producer identity is also forced here: this route never trusts a
 * `captured_by` value from the request body. Connectors that legitimately
 * produce `connector_*` rows call `ingestSignal` directly from in-process
 * code (e.g. the connector poll path); they never reach this HTTP boundary.
 * A webhook payload with `captured_by` set is rejected with a 400 explaining
 * why — explicit refusal beats silent stripping for operator debuggability.
 *
 * Order of checks matters and is deliberate:
 *   1. Auth (401 short-circuit).
 *   2. JSON parse (400 on malformed).
 *   3. captured_by-presence reject (400 with auditable error).
 *   4. ingestSignal — Zod validates inside (400 on schema fail), the rest is
 *      atomic via the in-function transaction.
 */
export async function POST(req: Request) {
  // (1) Auth.
  const expectedSecret = process.env.SIGNAL_WEBHOOK_SECRET;
  let trustedSender = false;
  if (expectedSecret) {
    const presented = req.headers.get('x-webhook-secret');
    if (presented !== expectedSecret) {
      return NextResponse.json(
        { error: 'unauthorized', detail: 'missing or invalid X-Webhook-Secret' },
        { status: 401 },
      );
    }
    trustedSender = true;
  }
  // If the secret is unset we stay permissive but `trustedSender` remains
  // false — TRUSTED_SOURCES alone cannot grant 'verified' without auth.

  // (2) Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // (3) Refuse any captured_by from external callers. Connectors call
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

  // (4) Ingest. Zod errors → 400; transactional failures → 500.
  try {
    const result = await ingestSignal(body, { trustedSender });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: 'invalid_payload', issues: err.issues },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: 'internal', detail: (err as Error).message },
      { status: 500 },
    );
  }
}
