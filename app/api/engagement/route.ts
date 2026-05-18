import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  timingSafeStringEqual,
  parseMediaType,
  readBoundedBody,
} from '@/lib/alerts/http';
import { ingestEngagement, EngagementRejectedError } from '@/lib/engagement/ingest';

/**
 * POST /api/engagement — third-party outreach-provider webhook
 * (Outreach, SendGrid, …). Engagement events are FACTS for the
 * feedback loop, never scoring evidence.
 *
 * Hardening mirrors `/api/signals` exactly (it's the same threat
 * model: a public webhook taking untrusted third-party JSON), using
 * the shared `lib/alerts/http.ts` primitives:
 *   - `ENGAGEMENT_WEBHOOK_SECRET` unset in production → 503 fail-safe
 *   - secret set + missing/wrong `X-Webhook-Secret` → 401
 *     (timing-safe compare — NOT the `got !== expected` the plan
 *     draft used, which codex rejected in Task 3.4)
 *   - wrong Content-Type → 415; oversized body → 413 (stream-bounded)
 *   - invalid JSON → 400
 *   - ZodError → 400 `invalid_payload` with `{path,code}` only — NO
 *     `.message`/`.received` (Zod messages reflect user-controlled
 *     input → reflection oracle)
 *   - EngagementRejectedError (attach-or-fail) → 400 with its
 *     message — a clear, deterministic caller/data failure, NOT a 500
 *   - anything else → 500 `internal`, raw error logged server-side
 *
 * No `trustedSender` concept: engagement events aren't trust-gated
 * for scoring (they're not evidence). The secret only authenticates
 * the webhook source.
 */

// Matches /api/signals. Provider event payloads are small; the cap is
// a DoS bound, not a functional limit.
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request) {
  // (1) Production-config guard.
  const expectedSecret = process.env.ENGAGEMENT_WEBHOOK_SECRET;
  if (!expectedSecret && process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error: 'misconfigured',
        detail: 'ENGAGEMENT_WEBHOOK_SECRET must be set in production. ' +
                'Permissive mode is local-dev only.',
      },
      { status: 503 },
    );
  }

  // (2) Auth — timing-safe.
  if (expectedSecret) {
    const presented = req.headers.get('x-webhook-secret');
    if (presented === null || !timingSafeStringEqual(presented, expectedSecret)) {
      return NextResponse.json(
        { error: 'unauthorized', detail: 'missing or invalid X-Webhook-Secret' },
        { status: 401 },
      );
    }
  }

  // (3) Content-Type / Content-Length pre-checks.
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

  // (4) Stream-bounded body read, then JSON.parse.
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
  let raw: unknown;
  try {
    raw = JSON.parse(readResult.text);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // (5) Ingest.
  try {
    const result = await ingestEngagement(raw);
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
    if (err instanceof EngagementRejectedError) {
      // Deterministic attach-or-fail rejection — clear 400, not 500.
      return NextResponse.json(
        { error: 'unattached_event', detail: err.message },
        { status: 400 },
      );
    }
    console.error('[/api/engagement] ingest failed:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
