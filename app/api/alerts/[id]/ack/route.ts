import { NextResponse } from 'next/server';
import { z } from 'zod';
import { acknowledgeAlert } from '@/lib/alerts/ack';
import { requireInternalSecret, parseMediaType, formatError } from '@/lib/alerts/http';

/**
 * POST /api/alerts/:id/ack — mark an alert as acknowledged.
 *
 * Same hardening pattern as /api/signals + /api/scoring/recompute:
 *
 *   - Production guard: 503 if INTERNAL_API_SECRET unset in
 *     NODE_ENV=production.
 *   - Auth: when secret is set, request must present X-Internal-Secret;
 *     timing-safe compare.
 *   - Content-Type + body cap (4KB; body is `{by: string}`).
 *   - Sanitized 400 (Zod path+code only).
 *   - Sanitized 500.
 *
 * Distinguished status codes:
 *
 *   - 200: ack recorded (or already recorded — body carries
 *     `alreadyAcked: boolean` so callers can distinguish first ack
 *     from re-ack without a second DB round-trip).
 *   - 400: invalid JSON / missing `by` / wrong content-type's payload.
 *   - 401: auth missing/wrong.
 *   - 404: alert id doesn't exist OR is malformed (the ack helper
 *     rejects malformed ids at the regex level, so SQL-injection-shaped
 *     URLs return 404 immediately without a DB probe).
 *   - 415: wrong Content-Type.
 *   - 500: unexpected internal error (sanitized).
 *   - 503: configuration error (production guard).
 *
 * The /alerts page's server action calls `acknowledgeAlert()` directly
 * rather than round-tripping through this endpoint — that path is
 * gated by the page's deploy-time auth (reverse proxy, SSO). This
 * endpoint stays available for external integrations (Phase 6 demo,
 * Slack interactivity, etc.).
 */

const MAX_BODY_BYTES = 4 * 1024;
const Body = z.object({ by: z.string().min(1) }).strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = requireInternalSecret(req);
  if (gate) return gate;

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

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ error: 'read_error' }, { status: 400 });
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }
  let raw: unknown;
  try { raw = JSON.parse(bodyText); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    // Echo only path + code (no .message — Zod messages can echo
    // user-controlled keys via unrecognized_keys / invalid_union, which
    // gives attackers a reflection oracle).
    const issues = parsed.error.issues.map((i) => ({
      path: i.path, code: i.code,
    }));
    return NextResponse.json({ error: 'invalid_body', issues }, { status: 400 });
  }

  const { id } = await params;
  try {
    const result = acknowledgeAlert(id, parsed.data.by);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 404 });
    }
    return NextResponse.json(
      { ok: true, alreadyAcked: result.alreadyAcked },
      { status: 200 },
    );
  } catch (err) {
    console.error('[alerts/ack] internal error:', formatError(err));
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
