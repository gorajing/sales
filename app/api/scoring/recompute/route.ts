import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { computeScore } from '@/lib/scoring/score';
import { route as routeAccount } from '@/lib/routing/route';
import { RoutingRuleParseError } from '@/lib/routing/rules';

/**
 * POST /api/scoring/recompute — orchestrate signal → score → route for one account.
 *
 * The hardening here mirrors `/api/signals` because both endpoints are
 * HTTP entry points to an evidence/scoring pipeline that can mutate the
 * scoring + routing state. Two differences:
 *
 *   - This is an INTERNAL endpoint: callers are cron jobs, dashboards,
 *     and operator scripts, not the public internet. Auth uses
 *     `INTERNAL_API_SECRET` and an `X-Internal-Secret` header.
 *
 *   - The body is small and well-typed (`{accountId: string}`), so the
 *     streaming bounded-reader from `/api/signals` is overkill — a
 *     `req.text()` with a small post-buffer check is sufficient. The
 *     `Content-Length` pre-check still rejects oversized declared
 *     payloads cheaply.
 *
 * Status codes are deliberately distinguished:
 *
 *   - 400: caller-side validation (bad JSON, missing/empty accountId)
 *   - 401: auth missing/wrong
 *   - 404: accountId doesn't exist (resolves the otherwise-confusing
 *          "500 from FK violation deep in route()" → operator gets a
 *          clear "you asked about an account that doesn't exist")
 *   - 413: declared body too large
 *   - 415: wrong Content-Type
 *   - 500: unexpected internal error; body is `{error: 'internal'}` only
 *          (no `.message` leak — the message could be derived from
 *          attacker input)
 *   - 503: configuration error (production guard, missing/bad rules
 *          files, missing/bad DEFAULT_OWNER_EMAIL). Distinguished from
 *          500 so the operator immediately knows "fix env / files,"
 *          not "investigate code."
 *
 * Alert dispatch is intentionally NOT wired here. The dispatcher comes
 * online in Task 2.1 and the wiring lands in Task 2.2 by editing this
 * file. Phase 1 verifies score+route compute correctly; alerts are
 * Phase 2.
 */

/** Body size cap. The body is `{accountId: string}` — even a long
 *  account id fits well under 4 KB. */
const MAX_BODY_BYTES = 4 * 1024;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const Body = z.object({ accountId: z.string().min(1) }).strict();

function timingSafeStringEqual(a: string, b: string): boolean {
  // Equal-length precondition met via SHA-256 digest so the comparator
  // doesn't reveal secret length via a fast-fail. Same pattern as
  // /api/signals.
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

function parseMediaType(header: string | null): string | null {
  if (header === null) return null;
  return header.split(';')[0].trim().toLowerCase();
}

export async function POST(req: Request) {
  // (1) Production-config guard. Mirror /api/signals: in prod, the
  // operator must have explicitly set INTERNAL_API_SECRET — we refuse
  // rather than silently allowing unauthenticated internal traffic.
  const expectedSecret = process.env.INTERNAL_API_SECRET;
  if (!expectedSecret && process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error: 'misconfigured',
        detail: 'INTERNAL_API_SECRET must be set in production. ' +
                'Unauthenticated mode is local-dev only.',
      },
      { status: 503 },
    );
  }

  // (2) Auth. When the secret is set, the request MUST present a
  // matching X-Internal-Secret. Comparison is timing-safe.
  if (expectedSecret) {
    const presented = req.headers.get('x-internal-secret');
    if (presented === null || !timingSafeStringEqual(presented, expectedSecret)) {
      return NextResponse.json(
        { error: 'unauthorized', detail: 'missing or invalid X-Internal-Secret' },
        { status: 401 },
      );
    }
  }

  // (3) Content-Type and Content-Length pre-checks. Content-Type is
  // tolerated when absent (some HTTP clients omit it on small bodies)
  // but rejected when present and wrong, so a misconfigured client
  // doesn't accidentally tunnel non-JSON through.
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

  // (4) Body read + parse. We use req.text() instead of a streaming
  // bounded reader because the body is small and well-typed; the
  // post-buffer length check still bounds peak allocation at
  // ~MAX_BODY_BYTES + one TLS chunk.
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
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
    // Echo only path + code (no .message — Zod messages can echo user-
    // controlled keys via unrecognized_keys / invalid_union, which would
    // give attackers a reflection oracle for probing internal types).
    const issues = parsed.error.issues.map((i) => ({
      path: i.path, code: i.code,
    }));
    return NextResponse.json({ error: 'invalid_body', issues }, { status: 400 });
  }
  const { accountId } = parsed.data;

  // (5) DEFAULT_OWNER_EMAIL — must be present and well-shaped at the
  // boundary. route() validates it again as defense-in-depth, but
  // catching here gives us a clean 503 rather than message-sniffing
  // route()'s thrown Error. Config validation happens BEFORE account
  // lookup so a broken config produces the same 503 regardless of
  // which accountId the caller passed — predictable diagnosis.
  const defaultOwnerRaw = process.env.DEFAULT_OWNER_EMAIL ?? '';
  const defaultOwner = defaultOwnerRaw.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(defaultOwner)) {
    return NextResponse.json(
      {
        error: 'misconfigured',
        detail: 'DEFAULT_OWNER_EMAIL must be set to a valid email',
      },
      { status: 503 },
    );
  }

  // (6) Load rules files from disk. Failure here is a config error,
  // not a server error. Same "before account lookup" reasoning.
  let scoringMd: string;
  let routingMd: string;
  try {
    const root = process.cwd();
    scoringMd = readFileSync(resolve(root, 'data/scoring-rules.md'), 'utf8');
    routingMd = readFileSync(resolve(root, 'data/routing-rules.md'), 'utf8');
  } catch (err) {
    console.error('[recompute] failed to read rules files:', (err as Error).message);
    return NextResponse.json(
      { error: 'misconfigured', detail: 'rules files unreadable' },
      { status: 503 },
    );
  }

  // (7) Account existence — 404 vs deep-pipeline 500. Without this,
  // an unknown accountId would propagate to computeScore (which
  // returns an empty rationale and score 0) and then to route()
  // (which throws "account not found"). The operator would see a
  // 500 and have to dig. 404 is the unambiguous signal.
  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  if (!account) {
    return NextResponse.json({ error: 'account_not_found' }, { status: 404 });
  }

  // (8) Orchestrate. Typed errors → 503 (config); everything else → 500
  // (sanitized — no .message in response).
  try {
    const score = await computeScore(accountId, scoringMd);
    const assignment = await routeAccount(accountId, score.scoreId, routingMd, defaultOwner);
    return NextResponse.json({
      scoreId: score.scoreId,
      score: score.score,
      tier: score.tier,
      priorTier: score.priorTier ?? null,
      inserted: score.inserted,
      rationale: score.rationale,
      assignmentId: assignment.assignmentId,
      ownerEmail: assignment.ownerEmail,
      matchedRuleKey: assignment.matchedRuleKey,
      reason: assignment.reason,
      alerts: [],  // populated in Task 2.2
    }, { status: 200 });
  } catch (err) {
    if (err instanceof RoutingRuleParseError) {
      console.error('[recompute] routing-rules.md invalid:', err.message);
      return NextResponse.json(
        { error: 'misconfigured', detail: 'routing-rules.md is invalid' },
        { status: 503 },
      );
    }
    console.error('[recompute] internal error:', (err as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
