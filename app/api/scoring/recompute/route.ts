import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { computeScore } from '@/lib/scoring/score';
import { route as routeAccount } from '@/lib/routing/route';
import { parseRoutingRules, RoutingRuleParseError } from '@/lib/routing/rules';

/**
 * POST /api/scoring/recompute — recompute score + routing for one account.
 *
 * Given an existing accountId, pulls verified evidence, runs the scoring
 * pipeline against `data/scoring-rules.md`, runs the routing pipeline
 * against `data/routing-rules.md` and `DEFAULT_OWNER_EMAIL`, and returns
 * the resulting score/tier/owner. Signal ingestion is a *separate*
 * endpoint (`/api/signals`) — this one only consumes already-ingested
 * evidence.
 *
 * The hardening here mirrors `/api/signals` because both endpoints are
 * HTTP entry points to an evidence/scoring pipeline that can mutate
 * scoring + routing state. Two differences from /api/signals:
 *
 *   - This is an INTERNAL endpoint: callers are cron jobs, dashboards,
 *     and operator scripts, not the public internet. Auth uses
 *     `INTERNAL_API_SECRET` and an `X-Internal-Secret` header.
 *
 *   - The body is small and well-typed (`{accountId: string}`), but we
 *     still use a streaming bounded reader (matching /api/signals)
 *     because a naive `req.text()` would buffer the whole body before
 *     the length check and `String#length` measures UTF-16 code units,
 *     not bytes — that lets a multi-byte payload bypass the cap.
 *
 * Status codes are deliberately distinguished:
 *
 *   - 400: caller-side validation (bad JSON, missing/empty accountId)
 *   - 401: auth missing/wrong
 *   - 404: accountId doesn't exist. **Under the documented single-
 *          process SQLite invariant** (see docs/architecture.md), the
 *          existence check is effectively atomic with the rest of the
 *          handler — concurrent deletes can't race past it. In a
 *          multi-process deployment the 404 would become "best effort
 *          at request-start time" and downstream FK checks would still
 *          catch a deleted account, just with a 500 instead of a 404.
 *   - 413: body too large (streaming reader bails at the cap)
 *   - 415: wrong Content-Type
 *   - 500: unexpected internal error; body is `{error: 'internal'}` only
 *          (no `.message` leak — the message could be derived from
 *          attacker input). Stack + cause logged server-side.
 *   - 503: configuration error (production guard, missing/bad
 *          DEFAULT_OWNER_EMAIL, unreadable rules files, malformed
 *          routing-rules.md). All config-shaped failures map here so
 *          the operator immediately knows "fix env / files," not
 *          "investigate code."
 *
 * Alert dispatch is intentionally NOT wired here. The dispatcher comes
 * online in Task 2.1 and the wiring lands in Task 2.2 by editing this
 * file. Phase 1 verifies score+route compute correctly; alerts are
 * Phase 2.
 */

/** Body size cap. The body is `{accountId: string}` — even a long
 *  account id fits well under 4 KB. Measured in bytes, not UTF-16
 *  code units (see readBoundedBody). */
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

/**
 * Read up to `maxBytes` from the request body, bailing on the first chunk
 * that crosses the cap. Caps peak allocation at roughly (maxBytes + one
 * chunk) regardless of whether Content-Length is present or honest — a
 * stronger DoS guarantee than buffering the whole body and checking after.
 *
 * Duplicated from app/api/signals/route.ts. The two HTTP boundaries share
 * this byte-accurate streaming pattern; if a third caller wants the same
 * primitive, extract to a shared `lib/http/body.ts`. Until then the
 * duplication is small and the surface area each route's logic is
 * different enough that a shared module would feel premature.
 */
async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: 'too_large' | 'read_error' }> {
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, text: '' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'read_error' };
  }
  return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
}

/**
 * Format an unknown thrown value into a server-side log line that preserves
 * stack + cause when present and is robust to non-Error throws. Never used
 * for response bodies — those stay sanitized to `{error: 'internal'}`.
 */
function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
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

  // (4) Stream-bounded body read: bail on the first chunk that crosses
  // the cap so peak allocation is bounded even when Content-Length is
  // absent or lies. THEN JSON.parse. Byte-accurate (not UTF-16 code
  // units), which is what the cap actually means.
  const readResult = await readBoundedBody(req, MAX_BODY_BYTES);
  if (!readResult.ok) {
    if (readResult.reason === 'too_large') {
      return NextResponse.json(
        { error: 'payload_too_large', detail: `body exceeds ${MAX_BODY_BYTES} bytes` },
        { status: 413 },
      );
    }
    return NextResponse.json({ error: 'read_error' }, { status: 400 });
  }
  let raw: unknown;
  try { raw = JSON.parse(readResult.text); } catch {
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
    console.error('[recompute] failed to read rules files:', formatError(err));
    return NextResponse.json(
      { error: 'misconfigured', detail: 'rules files unreadable' },
      { status: 503 },
    );
  }

  // (7) Validate routing-rules.md *content* upfront. Without this, a
  // malformed file would only surface inside route()'s parseRoutingRules
  // call — AFTER computeScore had already written a lead_scores row.
  // That side effect violates the "config validation before any state
  // mutation" invariant the rest of the handler establishes. Catching
  // here means a bad rules file is a clean no-op 503. scoring-rules.md
  // is intentionally NOT pre-validated because parseScoringRules is
  // permissive (skips malformed rules with a warn) — there's no
  // "valid vs invalid" binary to pre-check.
  try {
    parseRoutingRules(routingMd);
  } catch (err) {
    if (err instanceof RoutingRuleParseError) {
      console.error('[recompute] routing-rules.md invalid:', err.message);
      return NextResponse.json(
        { error: 'misconfigured', detail: 'routing-rules.md is invalid' },
        { status: 503 },
      );
    }
    // Unexpected error inside parser → 500.
    console.error('[recompute] parseRoutingRules threw non-RoutingRuleParseError:', formatError(err));
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }

  // (8) Account existence — 404 vs deep-pipeline 500. Without this,
  // an unknown accountId would propagate to computeScore (which
  // returns an empty rationale and score 0) and then to route()
  // (which throws "account not found"). The operator would see a
  // 500 and have to dig. 404 is the unambiguous signal — but the
  // check is only effectively atomic with the pipeline under the
  // single-process SQLite invariant (see docs/architecture.md).
  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  if (!account) {
    return NextResponse.json({ error: 'account_not_found' }, { status: 404 });
  }

  // (9) Orchestrate. The routing-rules.md pre-check at step 7 already
  // eliminated the RoutingRuleParseError path; route()'s internal
  // parseRoutingRules call here is redundant work, kept because
  // routing rules are small and re-parsing keeps route()'s API
  // self-contained. If we measure perf pressure later, route() could
  // accept pre-parsed rules.
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
      // Should be unreachable thanks to step 7, but keep the safety net
      // so a future refactor doesn't silently regress.
      console.error('[recompute] late RoutingRuleParseError (should be unreachable):', err.message);
      return NextResponse.json(
        { error: 'misconfigured', detail: 'routing-rules.md is invalid' },
        { status: 503 },
      );
    }
    console.error('[recompute] internal error:', formatError(err));
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
