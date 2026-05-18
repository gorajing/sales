import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { ingestSignal } from '../signals/ingest';
import { formatError } from '../alerts/http';
import { computeScore } from '../scoring/score';
import { route as routeAccount } from '../routing/route';
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
 *     the gating in `/api/scoring/recompute/route.ts` (tier_promotion
 *     gated on `score.inserted`; engagement_spike always attempted;
 *     alert failures never fail the recompute).
 *
 * # Why not share the recompute core with /api/scoring/recompute?
 *
 * That route's orchestration is entangled with HTTP-boundary concerns
 * (body bounding, 404 vs 500 vs 503 status distinctions, routing-rules
 * pre-validation) and — critically — has NO route-level test to
 * refactor against safely. Extracting a shared core from converged,
 * hardened, untested-at-the-route-level code mid-Task-3.4 is the
 * refactor-without-a-safety-net anti-pattern. Instead the gating logic
 * lives HERE in one place (used by the endpoint AND the scheduler, so
 * no triplication within 3.4's surface) and parity with the route is
 * pinned by tests. Unifying the two is a deliberate future seam — see
 * docs/connectors.md.
 *
 * # Connectors never write the DB
 *
 * Connectors are pure data sources; this orchestrator owns
 * `ingestSignal`. The layered-trust model (docs/connectors.md) holds:
 * every signal goes through the same Zod validation + dedupe + trust
 * resolution whether it arrived via webhook or connector poll.
 */

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface PerConnectorResult {
  connector: string;
  /** True IFF fetch succeeded AND every fetched payload ingested
   *  without error. A partial ingest is NOT a success — this is the
   *  "do not overstate" contract. */
  ok: boolean;
  /** The effective `since` used (ISO-8601), for operator visibility. */
  since: string;
  fetched: number;
  ingested: number;
  deduped: number;
  failed: number;
  /** Present only when ok === false; the connector-level error or a
   *  summary of per-payload ingest failures. Never swallowed. */
  error?: string;
}

export interface PollSummary {
  /** Poll-start instant (ISO-8601). Watermarks advance to THIS, not
   *  poll-end, so events created mid-poll are caught next time; the
   *  inclusive [since, now] boundary + dedupe_key absorb the overlap. */
  pollStartedAt: string;
  connectors: PerConnectorResult[];
  /** Accounts that received at least one NON-deduped ingest, deduped
   *  across connectors. Feed this to recomputeAffectedAccounts. */
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

function advanceWatermark(connectorName: string, pollStartedAtIso: string): void {
  db.insert(schema.connectorPollState)
    .values({ connectorName, lastPolledAt: pollStartedAtIso })
    .onConflictDoUpdate({
      target: schema.connectorPollState.connectorName,
      set: { lastPolledAt: pollStartedAtIso },
    })
    .run();
}

export async function pollConnectors(opts: PollConnectorsOptions): Promise<PollSummary> {
  const pollStartedAt = opts.now ?? new Date();
  const pollStartedAtIso = pollStartedAt.toISOString();
  const results: PerConnectorResult[] = [];
  const affected = new Set<string>();

  for (const connector of opts.connectors) {
    // `since` precedence: explicit override > stored watermark >
    // now-24h fallback (first-ever poll of this connector).
    const effectiveSince =
      opts.since
      ?? readWatermark(connector.name)
      ?? new Date(pollStartedAt.getTime() - DEFAULT_LOOKBACK_MS);
    const sinceIso = effectiveSince.toISOString();

    let fetched = 0;
    let ingested = 0;
    let deduped = 0;
    let failed = 0;
    let connectorError: string | undefined;
    let fetchOk = false;

    try {
      const payloads = await connector.fetchSince(effectiveSince);
      fetchOk = true;
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
            affected.add(r.accountId);
          }
        } catch (err) {
          // Per-payload isolation: one bad payload must not abort the
          // connector's other payloads.
          failed++;
          ingestErrors.push(formatError(err));
        }
      }
      if (failed > 0) {
        connectorError =
          `${failed} of ${fetched} payload(s) failed to ingest: ` +
          ingestErrors.slice(0, 3).join(' | ') +
          (ingestErrors.length > 3 ? ` (+${ingestErrors.length - 3} more)` : '');
      }
    } catch (err) {
      // Connector-level failure (e.g. GitHub all-or-nothing
      // ConnectorError, fixture defect). Surface it as THIS
      // connector's ok:false + error — NOT a swallowed warning, and
      // NOT a reason to skip the other connectors.
      connectorError = formatError(err);
    }

    const ok = fetchOk && failed === 0;
    // Advance the watermark ONLY on a fully clean poll. A connector
    // that threw, or had any per-payload ingest failure, keeps its
    // old watermark so the next poll retries the same window —
    // at-least-once, made safe by evidence.dedupe_key.
    if (ok) advanceWatermark(connector.name, pollStartedAtIso);

    results.push({
      connector: connector.name,
      ok,
      since: sinceIso,
      fetched,
      ingested,
      deduped,
      failed,
      ...(connectorError ? { error: connectorError } : {}),
    });
  }

  return {
    pollStartedAt: pollStartedAtIso,
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
      failed.push({ accountId, error: formatError(err) });
    }
  }

  return { attempted: accountIds.length, succeeded, failed };
}
