import { db, schema } from '@/db';
import { eq, and, sql } from 'drizzle-orm';
import { newId } from '../id';
import type { Tier } from '../scoring/rules';
import type { SignalType } from '@/db/schema';
import { renderAlertText } from './render';
import { sendSlack } from './channels/slack';
import { sendEmail } from './channels/email';
import type { ChannelDelivery, DispatchResult, AlertChannel } from './types';

export type { AlertChannel, ChannelDelivery, DispatchResult } from './types';

/**
 * Alert dispatch — the v1 hardcoded mapping documented in
 * `data/alert-rules.md`. Two public entry points:
 *
 *   - `dispatchTierPromotion(accountId, fromTier, toTier, scoreId)`:
 *     fired by /api/scoring/recompute when a recompute produces a
 *     strictly-higher tier than the prior state for the same account.
 *
 *   - `dispatchEngagementSpike(accountId, now?, windowHours?, threshold?)`:
 *     fired by the same orchestrator when an account has ≥ threshold
 *     verified engagement-like signals in the last `windowHours`.
 *
 * # Reserve-then-send invariant
 *
 * Both dispatchers follow the same three-step pattern:
 *
 *   1. **Reserve** an `alerts` row with `cooldownKey = <key>` and an
 *      empty `channelsSentJson`. The schema's UNIQUE index on
 *      `cooldownKey` is what enforces "at most one send per key" — if
 *      two callers race, exactly one wins the insert and the others
 *      catch SQLITE_CONSTRAINT_UNIQUE and return `null`.
 *
 *   2. **Send** to the configured channels. We hold the cooldown slot
 *      while the external HTTP calls fire. Send failures (HTTP non-2xx,
 *      timeouts, thrown errors) are recorded in the delivery record,
 *      not retried — a retry loop here would amplify rate-limit churn
 *      and complicate the at-most-once contract.
 *
 *   3. **Update** the row with the delivery results and the rendered
 *      text. After this point an operator looking at /alerts sees both
 *      the alert payload and what actually shipped.
 *
 * Critically, step 1 commits BEFORE any external side effect. If the
 * process crashes between step 1 and step 2, the row exists with an
 * empty `channelsSentJson` — the operator sees a "reserved but not
 * sent" alert and can investigate. The alternative (send first, then
 * record) would lose audit trail on the failure path.
 *
 * # Cooldown key shape
 *
 *   - `tier_promotion`: `tier_promotion:<accountId>:<scoreId>` — one
 *     alert per score row. Recompute-dedupe paths return the existing
 *     scoreId, so the second dispatch attempt hits the same key and is
 *     correctly suppressed.
 *
 *   - `engagement_spike`: `engagement_spike:<accountId>:<UTC-day>` —
 *     one alert per account per UTC day, regardless of how many
 *     qualifying signals arrive that day.
 *
 * # Single-process SQLite caveat
 *
 * The unique-index guarantee holds on SQLite at the database layer, but
 * the catch-and-skip race is only well-defined in single-process
 * deployments. See `docs/architecture.md` for what changes under
 * multi-process / networked databases.
 */

const TIER_RANK: Record<Tier, number> = { cold: 0, warm: 1, hot: 2, on_fire: 3 };

/** Engagement-like signal types — signal_type values that count toward
 *  the engagement-spike threshold. Adding a value to SignalType does
 *  NOT automatically make it engagement-like (categorization is a
 *  product decision); this list is the explicit allow-list. */
const ENGAGEMENT_LIKE_SIGNAL_TYPES = ['intent', 'engagement', 'trigger_event'] as const;

// Compile-time **subset** check (catches REMOVALS only):
// every member of ENGAGEMENT_LIKE_SIGNAL_TYPES must also be a member of
// SignalType. If signal_type's enum is reduced and loses 'intent',
// 'engagement', or 'trigger_event', this assignment fails to typecheck
// and forces an explicit update of this list in the same change.
//
// This check does NOT detect ADDITIONS to SignalType — that's by design.
// A new signal_type ('demo_attended', say) is not engagement-like by
// default; a human has to decide whether to include it in this list.
const _ENGAGEMENT_TYPES_ARE_SIGNAL_TYPES: readonly SignalType[] = ENGAGEMENT_LIKE_SIGNAL_TYPES;
void _ENGAGEMENT_TYPES_ARE_SIGNAL_TYPES;

function isUniqueViolation(err: unknown): boolean {
  // UNIQUE / PRIMARY KEY only — FK / NOT NULL / CHECK errors must
  // propagate. SQLite-specific; see docs/architecture.md "Deployment
  // assumptions" for what changes when porting to Postgres.
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/**
 * Pure tier-transition classifier.
 *
 * Returns the new tier when there's a strictly-upward transition, null
 * otherwise. Special cases:
 *
 *   - First-ever score (prior is `undefined`): treat the initial
 *     classification as a "promotion" only if it lands at warm or
 *     higher. A first score of `cold` is uninteresting noise.
 *   - Demotions (any → lower) → null.
 *   - Equal-tier (e.g. warm → warm on a recompute that didn't move the
 *     needle) → null.
 *
 * Used by both the dispatcher and (in Task 2.2) the recompute
 * orchestrator. Pure for easy unit testing — no DB access.
 */
export function detectTierPromotion(
  prior: Tier | undefined,
  now: Tier,
): Tier | null {
  if (prior === undefined) return now === 'cold' ? null : now;
  if (TIER_RANK[now] > TIER_RANK[prior]) return now;
  return null;
}

export async function dispatchTierPromotion(
  accountId: string,
  fromTier: Tier | undefined,
  toTier: Tier,
  scoreId: string,
): Promise<DispatchResult | null> {
  const promoted = detectTierPromotion(fromTier, toTier);
  if (!promoted) return null;

  // Severity escalates at on_fire. Both severities trigger the
  // reserve-then-send path; the channel set differs (see step 2).
  const severity: 'priority' | 'urgent' = promoted === 'on_fire' ? 'urgent' : 'priority';
  const cooldownKey = `tier_promotion:${accountId}:${scoreId}`;

  // -----------------------------------------------------------------
  // (1) RESERVE — insert with empty channelsSentJson; rely on the
  //     UNIQUE index on cooldownKey to reject duplicate races.
  // -----------------------------------------------------------------
  const alertId = newId('alert');
  try {
    db.insert(schema.alerts).values({
      id: alertId,
      accountId,
      trigger: 'tier_promotion',
      severity,
      payloadJson: { fromTier: fromTier ?? null, toTier: promoted, scoreId },
      channelsSentJson: [],
      cooldownKey,
    }).run();
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Another caller already owns this cooldown key. Do NOT fire a
      // duplicate send. Returning null is the contract — the caller
      // (typically the recompute orchestrator) can distinguish "no
      // promotion" from "promotion already alerted" by tracking
      // whether dispatchTierPromotion was reached at all.
      return null;
    }
    throw err;
  }

  // -----------------------------------------------------------------
  // (2) SEND — we own the cooldown slot. Render text + dispatch.
  // -----------------------------------------------------------------
  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  const text = await renderAlertText({
    trigger: 'tier_promotion',
    accountName: account?.name ?? accountId,
    accountId,
    fromTier,
    toTier: promoted,
    scoreId,
  });

  // on_fire escalates to email; everything else stays slack-only.
  const channelTargets: AlertChannel[] = promoted === 'on_fire' ? ['slack', 'email'] : ['slack'];
  const sent: ChannelDelivery[] = [];
  for (const target of channelTargets) {
    const sendAt = new Date().toISOString();
    try {
      if (target === 'slack') {
        sent.push(await sendSlack(text, alertId, sendAt));
      } else if (target === 'email') {
        sent.push(await sendEmail(
          `[Signal Alert] ${account?.name ?? accountId}`,
          text,
          alertId,
          sendAt,
        ));
      }
      // 'webhook' isn't currently a tier-promotion target; kept in the
      // type union for future rules without code change.
    } catch (err) {
      sent.push({
        channel: target,
        ok: false,
        sent_at: sendAt,
        detail: (err as Error).message,
      });
    }
  }

  // -----------------------------------------------------------------
  // (3) UPDATE — record what actually shipped and persist the
  //     rendered text so /alerts can display it.
  //
  // If this UPDATE throws after the external sends succeeded, the row
  // is stuck in its reserved state (empty channelsSentJson) and the
  // cooldown slot is taken forever. We catch + log loudly rather than
  // propagating, because:
  //   - We've already done external side effects (Slack got the
  //     message); throwing here doesn't undo them.
  //   - The cooldown slot is already blocking duplicate sends, so we
  //     have at-most-once at the user-visible layer.
  //   - The orchestrator (recompute) shouldn't fail just because the
  //     audit-update step couldn't write.
  // The console.error gives operators a recovery handle: delete the
  // empty alert row by id to release the cooldown if they need to
  // re-fire. In practice better-sqlite3 .update() by id only throws
  // on a corrupted DB, in which case bigger problems are at play.
  // -----------------------------------------------------------------
  try {
    db.update(schema.alerts).set({
      payloadJson: { fromTier: fromTier ?? null, toTier: promoted, scoreId, text },
      channelsSentJson: sent,
    }).where(eq(schema.alerts.id, alertId)).run();
  } catch (err) {
    console.error(
      `[alerts] dispatchTierPromotion: post-send UPDATE failed for alertId=${alertId}; ` +
      `delivery already attempted (channels=${JSON.stringify(sent)}); ` +
      `cooldown is now stuck. Manual recovery: DELETE FROM alerts WHERE id='${alertId}'.`,
      err,
    );
  }

  return { alertId, channelsSent: sent };
}

export async function dispatchEngagementSpike(
  accountId: string,
  now: Date = new Date(),
  windowHours = 24,
  thresholdCount = 3,
): Promise<DispatchResult | null> {
  // Bound the recent-evidence query to the rolling window.
  //
  // capturedAt is a raw TEXT column; ingest stores whatever ISO string
  // the producer sent (Z or ±HH:MM). A naive lexicographic compare
  // against a UTC `since` cutoff would WRONGLY exclude rows whose
  // local-offset prefix sorts before the cutoff but whose UTC instant is
  // recent — e.g. `2026-05-09T01:00:00.000-12:00` (UTC = May 9 13:00Z)
  // sorts lexically before `2026-05-09T12:00:00.000Z` but is the same
  // UTC moment. We normalize both sides to UTC via SQLite's strftime,
  // matching the pattern already established in lib/inbound/queries.ts.
  // Same root cause as the recentSignalEvidence sort fix.
  const since = new Date(now.getTime() - windowHours * 3600 * 1000).toISOString();
  const recent = db.select().from(schema.evidence)
    .where(and(
      eq(schema.evidence.accountId, accountId),
      eq(schema.evidence.extractionStatus, 'verified'),
      sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.evidence.capturedAt}) >= ${since}`,
    )).all()
    .filter((e) => (ENGAGEMENT_LIKE_SIGNAL_TYPES as readonly string[]).includes(e.signalType));
  if (recent.length < thresholdCount) return null;

  // Day-bucket: one alert per account per UTC day. `dayBucket` is the
  // ISO date prefix (YYYY-MM-DD) of `now` — explicit so the caller can
  // pass a deterministic `now` in tests.
  const dayBucket = now.toISOString().slice(0, 10);
  const cooldownKey = `engagement_spike:${accountId}:${dayBucket}`;

  // (1) RESERVE.
  const alertId = newId('alert');
  try {
    db.insert(schema.alerts).values({
      id: alertId,
      accountId,
      trigger: 'engagement_spike',
      severity: 'priority',
      payloadJson: { countInWindow: recent.length, windowHours },
      channelsSentJson: [],
      cooldownKey,
    }).run();
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }

  // (2) SEND.
  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  const text = await renderAlertText({
    trigger: 'engagement_spike',
    accountName: account?.name ?? accountId,
    accountId,
    countInWindow: recent.length,
    windowHours,
  });
  const sendAt = new Date().toISOString();
  let delivery: ChannelDelivery;
  try {
    delivery = await sendSlack(text, alertId, sendAt);
  } catch (err) {
    delivery = {
      channel: 'slack',
      ok: false,
      sent_at: sendAt,
      detail: (err as Error).message,
    };
  }

  // (3) UPDATE. Same swallow-and-log as dispatchTierPromotion (see
  // that function for the rationale).
  try {
    db.update(schema.alerts).set({
      payloadJson: { countInWindow: recent.length, windowHours, text },
      channelsSentJson: [delivery],
    }).where(eq(schema.alerts.id, alertId)).run();
  } catch (err) {
    console.error(
      `[alerts] dispatchEngagementSpike: post-send UPDATE failed for alertId=${alertId}; ` +
      `delivery already attempted (channel=${delivery.channel}, ok=${delivery.ok}); ` +
      `cooldown is now stuck. Manual recovery: DELETE FROM alerts WHERE id='${alertId}'.`,
      err,
    );
  }

  return { alertId, channelsSent: [delivery] };
}
