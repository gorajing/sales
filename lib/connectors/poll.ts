import { sql, eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { ingestSignal } from '../signals/ingest';
import { formatError } from '../alerts/http';
import { computeScore } from '../scoring/score';
import { route as routeAccount, EMAIL_SHAPE } from '../routing/route';
import { parseRoutingRules, RoutingRuleParseError } from '../routing/rules';
import { dispatchTierPromotion, dispatchEngagementSpike } from '../alerts/dispatch';
import type { SignalConnector } from './types';

/**
 * Connector poll orchestration (Task 3.4).
 *
 * Two exported units, deliberately separate:
 *
 *   - `pollConnectors` — fetch + ingest + watermark, with PER-CONNECTOR
 *     isolation. The pure connector-orchestration core. No recompute.
 *   - `recomputeAffectedAccounts` — the score → route → best-effort
 *     alert step for the accounts that received new evidence. Mirrors
 *     the gating AND the config-before-mutation invariant in
 *     `/api/scoring/recompute/route.ts` (routing-rules.md validated
 *     BEFORE any computeScore writes; tier_promotion gated on
 *     `score.inserted`; engagement_spike always attempted; alert
 *     failures never fail the recompute).
 *
 * # Why not share the recompute core with /api/scoring/recompute?
 *
 * Honest accounting (corrected after codex 3.4 r3): an earlier
 * version of this comment claimed the recompute route had "no
 * route-level test," making a shared-core extraction unsafe. That
 * was FALSE — `tests/integration/inbound-pipeline.test.ts` covers
 * the route end to end, including its config-before-mutation
 * no-side-effect case. So a unification IS feasible with a safety
 * net; the deferral is a deliberate SCOPE decision, not a capability
 * gap:
 *
 *   - Task 3.4 was explicitly scoped to "connector polling endpoint
 *     + scheduler." Refactoring `/api/scoring/recompute`'s ~150-line
 *     hardened HTTP handler to extract a shared core is a separate
 *     change with its own review surface (status-code distinctions,
 *     body bounding, the 404/503 ordering) — folding it in here
 *     would balloon this task's blast radius into converged code the
 *     task doesn't otherwise touch.
 *   - The gating + config-before-mutation invariant live HERE in one
 *     place (used by the endpoint AND the scheduler — no triplication
 *     within 3.4's surface) and parity with the route is pinned by
 *     tests on BOTH sides.
 *
 * Unifying the two into one `recomputeAccount` core is a clean,
 * now-feasible follow-up — recorded as a deferred seam in the plan
 * (Phase 3 open decisions) and docs/connectors.md, NOT a hidden
 * limitation.
 *
 * # Connectors never write the DB
 *
 * Connectors are pure data sources; this orchestrator owns
 * `ingestSignal`. The layered-trust model (docs/connectors.md) holds:
 * every signal goes through the same Zod validation + dedupe + trust
 * resolution whether it arrived via webhook or connector poll.
 */

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Response-safe error string: the message only, never the
 * stack/cause-chain/absolute paths `formatError` produces. The full
 * `formatError` detail is logged server-side. This endpoint is
 * internal + auth-gated so a leak is low-severity, but the codebase's
 * established pattern (see /api/scoring/recompute) is "actionable
 * message in the body, full detail in the logs" — keep it consistent.
 */
function safeMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface PerConnectorResult {
  connector: string;
  /** True IFF the connector's ENTIRE lifecycle (watermark read,
   *  fetch, every payload ingest, watermark advance) completed
   *  without error. A partial ingest is NOT a success — this is the
   *  "do not overstate" contract. */
  ok: boolean;
  /** The effective `since` used (ISO-8601), for operator visibility. */
  since: string;
  fetched: number;
  ingested: number;
  deduped: number;
  failed: number;
  /** Present only when ok === false; the connector-level error
   *  message or a summary of per-payload ingest failures. Never
   *  swallowed, never a leaked stack. */
  error?: string;
}

export interface PollSummary {
  /** Poll-start instant (ISO-8601). Watermarks advance to THIS, not
   *  poll-end, so events created mid-poll are caught next time; the
   *  inclusive [since, now] boundary + dedupe_key absorb the overlap. */
  pollStartedAt: string;
  connectors: PerConnectorResult[];
  /** Accounts that received at least one NON-deduped ingest, deduped
   *  across connectors. Feed this to recomputeAffectedAccounts.
   *  Populated even for a connector that later failed its watermark
   *  advance — those accounts DID get evidence and must recompute. */
  affectedAccountIds: string[];
  /** True IFF every polled connector is ok. Does not overstate. */
  ok: boolean;
}

export interface PollConnectorsOptions {
  connectors: SignalConnector[];
  /** Operator override / backfill. When set, used for ALL connectors
   *  and the stored watermark is ignored (but still advanced on
   *  success). When unset, each connector's stored watermark (else
   *  now-24h) is used. */
  since?: Date;
  /** Injectable clock — the poll-start time. Defaults to `new Date()`. */
  now?: Date;
}

function readWatermark(connectorName: string): Date | null {
  const row = db.select().from(schema.connectorPollState)
    .where(eq(schema.connectorPollState.connectorName, connectorName)).get();
  return row ? new Date(row.lastPolledAt) : null;
}

/**
 * Advance the watermark monotonically, in a SINGLE atomic statement.
 *
 * `ON CONFLICT DO UPDATE SET last_polled_at = max(<stored>,
 * excluded.last_polled_at)` — SQLite evaluates this within the one
 * UPSERT, so two overlapping polls can't interleave a read and a
 * write to move the watermark backwards (the racy read-then-write an
 * earlier version had — codex 3.4 r2). `max()` over TEXT is a
 * lexical comparison; watermarks are always
 * `new Date().toISOString()` (fixed-width `…Z`), so lexical order ==
 * chronological order. Backwards movement was only benign refetch
 * churn (dedupe-safe), but doing it atomically makes the guarantee
 * real instead of overstated.
 */
function advanceWatermark(connectorName: string, pollStartedAtIso: string): void {
  db.insert(schema.connectorPollState)
    .values({ connectorName, lastPolledAt: pollStartedAtIso })
    .onConflictDoUpdate({
      target: schema.connectorPollState.connectorName,
      set: {
        lastPolledAt: sql`max(connector_poll_state.last_polled_at, excluded.last_polled_at)`,
      },
    })
    .run();
}

/**
 * Poll ONE connector through its entire lifecycle. Designed not to
 * throw: every expected failure (watermark read DB error, fetchSince
 * throw, per-payload ingest throw, watermark advance DB error) is
 * caught and folded into the returned `PerConnectorResult`. The only
 * theoretical escape is the error logger/formatter itself throwing
 * inside the catch (formatError is cycle/depth-safe by construction,
 * so this is practically unreachable). `pollConnectors` ALSO wraps
 * the call defensively, so the loop-level "one connector cannot
 * abort the others" guarantee is unconditional regardless
 * (codex 3.4 r1 blocker: watermark calls were previously outside the
 * per-connector boundary; r2: made the guarantee absolute).
 *
 * `affected` accounts are collected as ingestion happens and returned
 * even on a later failure — an account that got evidence must be
 * recomputed regardless of whether the watermark advance then failed.
 */
async function pollOne(
  connector: SignalConnector,
  since: Date | undefined,
  pollStartedAt: Date,
): Promise<{ result: PerConnectorResult; affected: string[] }> {
  const pollStartedAtIso = pollStartedAt.toISOString();
  const fallbackSince = new Date(pollStartedAt.getTime() - DEFAULT_LOOKBACK_MS);
  const affected: string[] = [];
  let sinceIso = fallbackSince.toISOString();
  let fetched = 0;
  let ingested = 0;
  let deduped = 0;
  let failed = 0;

  try {
    // `since` precedence: explicit override > stored watermark >
    // now-24h fallback. readWatermark is INSIDE the try so a DB
    // error here is isolated to this connector, not fatal to the loop.
    const effectiveSince = since ?? readWatermark(connector.name) ?? fallbackSince;
    sinceIso = effectiveSince.toISOString();

    const payloads = await connector.fetchSince(effectiveSince);
    fetched = payloads.length;
    const ingestErrors: string[] = [];
    for (const p of payloads) {
      try {
        // Connectors are in-process configured code → trusted.
        const r = await ingestSignal(p, { trustedSender: true });
        if (r.deduped) {
          deduped++;
        } else {
          ingested++;
          affected.push(r.accountId);
        }
      } catch (err) {
        // Per-payload isolation: one bad payload must not abort the
        // connector's other payloads.
        failed++;
        ingestErrors.push(safeMessage(err));
        console.error(
          `[poll] ${connector.name} payload ingest failed:`,
          formatError(err),
        );
      }
    }

    const ok = failed === 0;
    // Advance ONLY on a fully clean poll. A connector with any
    // per-payload failure keeps its old watermark so the next poll
    // retries the window — at-least-once, made safe by dedupe_key.
    // advanceWatermark is INSIDE the try (codex 3.4 r1 blocker).
    if (ok) advanceWatermark(connector.name, pollStartedAtIso);

    const error = ok
      ? undefined
      : `${failed} of ${fetched} payload(s) failed to ingest: ` +
        ingestErrors.slice(0, 3).join(' | ') +
        (ingestErrors.length > 3 ? ` (+${ingestErrors.length - 3} more)` : '');

    return {
      result: {
        connector: connector.name, ok, since: sinceIso,
        fetched, ingested, deduped, failed,
        ...(error ? { error } : {}),
      },
      affected,
    };
  } catch (err) {
    // ANY connector-level failure (watermark read, fetchSince throw —
    // incl. GitHub's documented all-or-nothing ConnectorError —, a
    // watermark-advance DB error after successful ingest, etc.).
    // Surfaced as THIS connector's ok:false + message, NEVER a
    // swallowed warning, NEVER a reason to skip the others. `affected`
    // is still returned: accounts that ingested before the failure
    // must recompute.
    console.error(`[poll] ${connector.name} failed:`, formatError(err));
    return {
      result: {
        connector: connector.name, ok: false, since: sinceIso,
        fetched, ingested, deduped, failed,
        error: safeMessage(err),
      },
      affected,
    };
  }
}

export async function pollConnectors(opts: PollConnectorsOptions): Promise<PollSummary> {
  const pollStartedAt = opts.now ?? new Date();
  const results: PerConnectorResult[] = [];
  const affected = new Set<string>();

  for (const connector of opts.connectors) {
    // Defensive outer wrapper: pollOne is designed not to throw, but
    // wrapping its call too makes "one connector cannot abort the
    // others" an UNCONDITIONAL guarantee — even a hypothetical
    // pollOne bug (or a throw from its own catch-block logger)
    // becomes that connector's ok:false, never a loop abort.
    try {
      const { result, affected: connectorAffected } = await pollOne(
        connector, opts.since, pollStartedAt,
      );
      results.push(result);
      for (const id of connectorAffected) affected.add(id);
    } catch (err) {
      results.push({
        connector: connector.name,
        ok: false,
        since: new Date(pollStartedAt.getTime() - DEFAULT_LOOKBACK_MS).toISOString(),
        fetched: 0, ingested: 0, deduped: 0, failed: 0,
        error: safeMessage(err),
      });
    }
  }

  return {
    pollStartedAt: pollStartedAt.toISOString(),
    connectors: results,
    affectedAccountIds: [...affected],
    ok: results.every((r) => r.ok),
  };
}

// --------------------------------------------------------------------------
// recomputeAffectedAccounts
// --------------------------------------------------------------------------

export interface RecomputeConfig {
  scoringMd: string;
  routingMd: string;
  defaultOwner: string;
}

export interface RecomputeSummary {
  attempted: number;
  succeeded: number;
  failed: Array<{ accountId: string; error: string }>;
}

/**
 * Injectable so the parity with `/api/scoring/recompute`'s gating can
 * be unit-tested without seeding the whole scoring pipeline. Defaults
 * are the real implementations — the endpoint and scheduler get real
 * behavior; tests pass spies.
 */
export interface RecomputeDeps {
  computeScore: typeof computeScore;
  route: typeof routeAccount;
  dispatchTierPromotion: typeof dispatchTierPromotion;
  dispatchEngagementSpike: typeof dispatchEngagementSpike;
}

const realRecomputeDeps: RecomputeDeps = {
  computeScore,
  route: routeAccount,
  dispatchTierPromotion,
  dispatchEngagementSpike,
};

export async function recomputeAffectedAccounts(
  accountIds: string[],
  cfg: RecomputeConfig,
  deps: RecomputeDeps = realRecomputeDeps,
): Promise<RecomputeSummary> {
  // CONFIG-BEFORE-MUTATION invariant — parity with
  // /api/scoring/recompute. computeScore writes a lead_scores row, so
  // ANY known-bad recompute config must fail EVERY account up front,
  // with ZERO computeScore calls — otherwise a config failure leaves
  // dangling score rows with no assignment. This helper is the
  // SINGLE enforcement point for the whole invariant (routing rules
  // AND default owner); callers (endpoint, scheduler) do NOT each
  // re-implement the check — that caller-duplicated-invariant shape
  // is the drift bug class. codex 3.4 r1 closed routing; r2 caught
  // that defaultOwner had the SAME drift (route() validates it and
  // throws, but only AFTER computeScore already wrote the row).
  const configError = ((): string | null => {
    try {
      parseRoutingRules(cfg.routingMd);
    } catch (err) {
      if (err instanceof RoutingRuleParseError) return 'routing-rules.md is invalid';
      throw err; // unexpected parser bug — propagate, don't mask
    }
    // Mirror route()'s own normalization + EMAIL_SHAPE check (the
    // shared regex is exported from lib/routing/route.ts so this
    // can't drift from what route() actually enforces).
    const owner = cfg.defaultOwner.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(owner)) return 'DEFAULT_OWNER_EMAIL is invalid';
    return null;
  })();
  if (configError) {
    return {
      attempted: accountIds.length,
      succeeded: 0,
      failed: accountIds.map((accountId) => ({ accountId, error: configError })),
    };
  }

  const failed: RecomputeSummary['failed'] = [];
  let succeeded = 0;

  for (const accountId of accountIds) {
    try {
      const score = await deps.computeScore(accountId, cfg.scoringMd);
      await deps.route(accountId, score.scoreId, cfg.routingMd, cfg.defaultOwner);

      // tier_promotion is gated on score.inserted — a dedupe-path
      // recompute (inserted=false) can't represent a tier transition.
      // Mirrors /api/scoring/recompute exactly.
      if (score.inserted) {
        try {
          await deps.dispatchTierPromotion(
            accountId, score.priorTier, score.tier, score.scoreId,
          );
        } catch (err) {
          // Alerts are a side effect, not the work. A Slack/disk
          // outage must not fail a recompute whose score+routing
          // already committed.
          console.error(
            `[poll-recompute] tier_promotion dispatch threw for ${accountId}; ` +
            `recompute continues without this alert.`,
            formatError(err),
          );
        }
      }

      // engagement_spike is NOT gated on inserted — engagement-like
      // signals often don't move the score fingerprint but ARE the
      // signal this alert exists for. The dispatcher's per-day
      // cooldown key dedupes.
      try {
        await deps.dispatchEngagementSpike(accountId);
      } catch (err) {
        console.error(
          `[poll-recompute] engagement_spike dispatch threw for ${accountId}; ` +
          `recompute continues without this alert.`,
          formatError(err),
        );
      }

      succeeded++;
    } catch (err) {
      // One account's score/route failure is isolated; the rest still
      // recompute. Surfaced in the summary, never swallowed.
      console.error(`[poll-recompute] ${accountId} failed:`, formatError(err));
      failed.push({ accountId, error: safeMessage(err) });
    }
  }

  return { attempted: accountIds.length, succeeded, failed };
}
