import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { ingestSignal } from '../signals/ingest';
import { formatError } from '../alerts/http';
import { computeScore } from '../scoring/score';
import { route as routeAccount } from '../routing/route';
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
 * That route's orchestration is entangled with HTTP-boundary concerns
 * (body bounding, 404 vs 500 vs 503 status distinctions) and — the
 * decisive point — has NO route-level test to refactor against
 * safely. Extracting a shared core from converged, hardened,
 * untested-at-the-route-level code mid-Task-3.4 is the
 * refactor-without-a-safety-net anti-pattern. The gating + the
 * config-before-mutation invariant live HERE in one place (used by
 * the endpoint AND the scheduler — no triplication within 3.4's
 * surface) and parity with the route is pinned by tests. Unifying
 * the two is a deliberate future seam — see docs/connectors.md.
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
 * Advance the watermark, MONOTONICALLY. If a stored value already
 * exists that is >= the new instant (two cron fires overlapping and
 * an older poll finishing last), keep the newer stored value rather
 * than moving the watermark backwards. Backwards movement is only a
 * benign extra-refetch (dedupe-safe), but the guard is one comparison
 * and removes pointless churn under the concurrent-poll scenario.
 */
function advanceWatermark(connectorName: string, pollStartedAtIso: string): void {
  const existing = readWatermark(connectorName);
  if (existing && existing.getTime() >= new Date(pollStartedAtIso).getTime()) {
    return;
  }
  db.insert(schema.connectorPollState)
    .values({ connectorName, lastPolledAt: pollStartedAtIso })
    .onConflictDoUpdate({
      target: schema.connectorPollState.connectorName,
      set: { lastPolledAt: pollStartedAtIso },
    })
    .run();
}

/**
 * Poll ONE connector through its entire lifecycle. This function
 * NEVER throws — every failure (watermark read DB error, fetchSince
 * throw, per-payload ingest throw, watermark advance DB error,
 * formatting) is caught and folded into the returned
 * `PerConnectorResult`. That total-isolation guarantee is what makes
 * `pollConnectors`'s loop unable to let one connector abort the
 * others (codex 3.4 r1 blocker: the watermark calls were previously
 * outside the per-connector boundary).
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
    // pollOne never throws — the loop structurally cannot be aborted
    // by one connector.
    const { result, affected: connectorAffected } = await pollOne(
      connector, opts.since, pollStartedAt,
    );
    results.push(result);
    for (const id of connectorAffected) affected.add(id);
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
  // /api/scoring/recompute step 7. Validate routing-rules.md ONCE up
  // front; if it's malformed, fail EVERY account WITHOUT calling
  // computeScore for any (computeScore writes a lead_scores row, so
  // running it before a known-bad routing config would leave dangling
  // score rows with no assignment). codex 3.4 r1 blocker: the earlier
  // version wrote scores then failed on bad routing — real drift from
  // the route, not just an HTTP status difference.
  try {
    parseRoutingRules(cfg.routingMd);
  } catch (err) {
    if (err instanceof RoutingRuleParseError) {
      return {
        attempted: accountIds.length,
        succeeded: 0,
        failed: accountIds.map((accountId) => ({
          accountId, error: 'routing-rules.md is invalid',
        })),
      };
    }
    throw err; // unexpected parser bug — propagate, don't mask
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
