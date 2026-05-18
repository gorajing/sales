import { formatError } from './alerts/http';
import { computeScore } from './scoring/score';
import { route as routeAccount } from './routing/route';
import { dispatchTierPromotion, dispatchEngagementSpike } from './alerts/dispatch';
import type { ScoreResult } from './scoring/score';
import type { RouteResult } from './routing/route';
import type { ChannelDelivery } from './alerts/types';

/**
 * Shared score → route → best-effort-alert core.
 *
 * Extracted (post codex 3.4 r3) so `/api/scoring/recompute` and the
 * connector poll path (`recomputeAffectedAccounts`) run the EXACT
 * same orchestration instead of two hand-maintained copies that
 * already drifted twice (the config-before-mutation blockers in
 * Task 3.4 rounds 1 & 2 were drift between these two paths). The
 * unification is behavior-preserving: this is the route's steps
 * 9–10 and the poll loop body, verbatim — same gating, same
 * best-effort isolation, same alert-entry shape. The two callers
 * keep their OWN pre-validation (the route maps config failures to
 * HTTP 503/404; the poll path maps them to a failed summary) and
 * their OWN result shaping (HTTP JSON vs. summary). This core does
 * NOT pre-validate config or check account existence — callers do
 * that their own way, unchanged.
 *
 * Gating (identical to the pre-extraction route + poll):
 *   - tier_promotion: dispatched ONLY when `score.inserted` (a
 *     dedupe-path recompute can't represent a tier transition).
 *   - engagement_spike: ALWAYS attempted (engagement signals often
 *     don't move the score fingerprint but ARE what the spike alert
 *     exists for; the dispatcher's per-day cooldown key dedupes).
 *   - Each dispatch is isolated in its own try/catch: a Slack/disk
 *     outage must NOT fail a recompute whose score + routing already
 *     committed. The dispatchers self-isolate channel failures into
 *     ChannelDelivery{ok:false}; the outer catch only fires on truly
 *     unexpected throws (SQLITE_BUSY on reserve, a JS bug).
 *
 * `computeScore` / `route` throwing propagates to the caller (the
 * route's outer catch maps RoutingRuleParseError→503 else→500; the
 * poll path's per-account try/catch records it in `failed[]`).
 */

export interface RecomputeConfig {
  scoringMd: string;
  routingMd: string;
  /** Already normalized + shape-validated by the caller. The core
   *  passes it straight to `route()`, which re-validates as
   *  defense-in-depth. */
  defaultOwner: string;
}

export interface AlertEntry {
  trigger: 'tier_promotion' | 'engagement_spike';
  alertId: string;
  /** Actual per-channel disposition (channel='file' on fallback,
   *  ok=false on delivery failure) — avoids overstating success. */
  channelsSent: ChannelDelivery[];
}

export interface RecomputeAccountResult {
  score: ScoreResult;
  assignment: RouteResult;
  alerts: AlertEntry[];
}

/**
 * Injectable so callers/tests can substitute the score/route/alert
 * primitives. The connector unit tests pass a full spy object; the
 * route integration tests instead use `vi.spyOn(module, fn)` and
 * rely on the DEFAULT path.
 *
 * CRITICAL: the default path must call through the LIVE module
 * import bindings at invocation time — `deps?.fn ?? fn` below, NOT a
 * snapshot object built at module init. An earlier version captured
 * `{ computeScore, route, ... }` into a const at load time; that
 * froze the references BEFORE any `vi.spyOn` could replace the module
 * export, so `/api/scoring/recompute`'s spy-based tests silently ran
 * the REAL functions (200 instead of 500, alerts populated instead
 * of []). Production behavior was identical, but the refactor was
 * not test-transparent — which means it was not actually
 * behavior-preserving. Resolving per-call against the live binding
 * keeps `vi.spyOn` working exactly as it did before extraction.
 * This is the single definition; `lib/connectors/poll.ts` re-exports
 * it so existing importers don't break.
 */
export interface RecomputeDeps {
  computeScore: typeof computeScore;
  route: typeof routeAccount;
  dispatchTierPromotion: typeof dispatchTierPromotion;
  dispatchEngagementSpike: typeof dispatchEngagementSpike;
}

export async function recomputeAccount(
  accountId: string,
  cfg: RecomputeConfig,
  deps?: Partial<RecomputeDeps>,
): Promise<RecomputeAccountResult> {
  // Per-call resolution against the live import binding (see the
  // RecomputeDeps doc above for why this MUST NOT be a snapshot).
  const computeScoreFn = deps?.computeScore ?? computeScore;
  const routeFn = deps?.route ?? routeAccount;
  const dispatchTierPromotionFn = deps?.dispatchTierPromotion ?? dispatchTierPromotion;
  const dispatchEngagementSpikeFn = deps?.dispatchEngagementSpike ?? dispatchEngagementSpike;

  const score = await computeScoreFn(accountId, cfg.scoringMd);
  const assignment = await routeFn(
    accountId, score.scoreId, cfg.routingMd, cfg.defaultOwner,
  );

  const alerts: AlertEntry[] = [];

  if (score.inserted) {
    try {
      const tp = await dispatchTierPromotionFn(
        accountId, score.priorTier, score.tier, score.scoreId,
      );
      if (tp) {
        alerts.push({
          trigger: 'tier_promotion',
          alertId: tp.alertId,
          channelsSent: tp.channelsSent,
        });
      }
    } catch (err) {
      console.error(
        `[recompute-core] tier_promotion dispatch threw for accountId=${accountId} ` +
        `scoreId=${score.scoreId}; recompute continues without this alert.`,
        formatError(err),
      );
    }
  }

  try {
    const sp = await dispatchEngagementSpikeFn(accountId);
    if (sp) {
      alerts.push({
        trigger: 'engagement_spike',
        alertId: sp.alertId,
        channelsSent: sp.channelsSent,
      });
    }
  } catch (err) {
    console.error(
      `[recompute-core] engagement_spike dispatch threw for accountId=${accountId}; ` +
      `recompute continues without this alert.`,
      formatError(err),
    );
  }

  return { score, assignment, alerts };
}
