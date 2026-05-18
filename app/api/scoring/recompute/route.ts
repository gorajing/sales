import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { parseRoutingRules, RoutingRuleParseError } from '@/lib/routing/rules';
import { recomputeAccount } from '@/lib/recompute';
import {
  requireInternalSecret,
  parseMediaType,
  readBoundedBody,
  formatError,
} from '@/lib/alerts/http';

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
 *
 * After score and routing commit, this route invokes the alert
 * dispatchers (`dispatchTierPromotion`, `dispatchEngagementSpike` from
 * `lib/alerts/dispatch.ts`) as a best-effort side effect. Dispatch
 * failures are caught + logged and never affect the response status —
 * alerts are a side effect, not the work. Each dispatched alert's
 * per-channel disposition is surfaced in the response body so callers
 * can distinguish "alert reserved" from "alert reserved AND delivered."
 */

/** Body size cap. The body is `{accountId: string}` — even a long
 *  account id fits well under 4 KB. Measured in bytes, not UTF-16
 *  code units (see `readBoundedBody` in lib/alerts/http.ts). */
const MAX_BODY_BYTES = 4 * 1024;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const Body = z.object({ accountId: z.string().min(1) }).strict();

// `requireInternalSecret`, `parseMediaType`, `readBoundedBody`, and
// `formatError` live in lib/alerts/http.ts (project-wide shared HTTP
// helpers; the `alerts/` path is historical — see that module's
// header). This route's local copies were promoted there so future
// HTTP boundaries get the byte-accurate cap + timing-safe compare +
// production guard + cycle/depth-safe error formatting without
// reintroducing already-fixed bugs.

export async function POST(req: Request) {
  // (1) Production-config guard + auth, in one. requireInternalSecret
  // returns a 503 when NODE_ENV=production AND INTERNAL_API_SECRET is
  // unset (fail safe), a 401 when the secret is set but the request
  // doesn't present a matching X-Internal-Secret (timing-safe compare),
  // and null when permissive-dev or correctly authenticated. See
  // lib/alerts/http.ts for the shared implementation also used by
  // /api/alerts/[id]/ack and /api/alerts.
  const gate = requireInternalSecret(req);
  if (gate) return gate;

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

  // (9) Orchestrate via the SHARED recompute core (lib/recompute.ts).
  // computeScore → route → best-effort tier_promotion (gated on
  // score.inserted) → best-effort engagement_spike (always) lives in
  // ONE place now, shared with the connector poll path so the two
  // cannot drift (the Task 3.4 config-before-mutation blockers were
  // exactly that drift). This route keeps its OWN pre-validation
  // (steps 5–8 above: 503/404) and its OWN response shaping below —
  // those are HTTP-boundary concerns the core deliberately doesn't
  // own. The response body is byte-identical to the pre-extraction
  // shape (same keys; `alerts` is the same {trigger,alertId,
  // channelsSent}[]). The step-7 routing-rules pre-check already
  // eliminated the RoutingRuleParseError path; the catch below keeps
  // the safety net so a future refactor can't silently regress it.
  try {
    const { score, assignment, alerts } = await recomputeAccount(
      accountId, { scoringMd, routingMd, defaultOwner },
    );

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
      alerts,
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
