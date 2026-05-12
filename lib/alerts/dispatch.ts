import { db, schema } from '@/db';
import { eq, and, gte } from 'drizzle-orm';
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
 *  the engagement-spike threshold. Source-of-truth-checked against
 *  the SignalType union so a future enum change can't silently miss a
 *  category here. */
const ENGAGEMENT_LIKE_SIGNAL_TYPES = ['intent', 'engagement', 'trigger_event'] as const;
type EngagementLikeSignalType = (typeof ENGAGEMENT_LIKE_SIGNAL_TYPES)[number];

// Compile-time check: every member of ENGAGEMENT_LIKE_SIGNAL_TYPES must
// also be a member of SignalType. If signal_type's enum is reduced and
// loses 'intent' / 'engagement' / 'trigger_event', this assignment
// fails to typecheck — the engagement-spike rule is forced to update
// in the same change.
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
  // -----------------------------------------------------------------
  db.update(schema.alerts).set({
    payloadJson: { fromTier: fromTier ?? null, toTier: promoted, scoreId, text },
    channelsSentJson: sent,
  }).where(eq(schema.alerts.id, alertId)).run();

  return { alertId, channelsSent: sent };
}

export async function dispatchEngagementSpike(
  accountId: string,
  now: Date = new Date(),
  windowHours = 24,
  thresholdCount = 3,
): Promise<DispatchResult | null> {
  // Bound the recent-evidence query to the rolling window. SQLite TEXT
  // ISO comparison works for chronological order only when timestamps
  // share the same offset format; ingest stores whatever the producer
  // sent. The since-cutoff is precise UTC; values stored as `+HH:MM`
  // might pass a precise-UTC filter despite lexicographic surprises in
  // ORDER BY. The post-filter on signalType keeps this on the bounded
  // window's small result set.
  const since = new Date(now.getTime() - windowHours * 3600 * 1000).toISOString();
  const recent = db.select().from(schema.evidence)
    .where(and(
      eq(schema.evidence.accountId, accountId),
      eq(schema.evidence.extractionStatus, 'verified'),
      gte(schema.evidence.capturedAt, since),
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

  // (3) UPDATE.
  db.update(schema.alerts).set({
    payloadJson: { countInWindow: recent.length, windowHours, text },
    channelsSentJson: [delivery],
  }).where(eq(schema.alerts.id, alertId)).run();

  return { alertId, channelsSent: [delivery] };
}
