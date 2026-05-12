import type { ChannelDelivery, AlertChannel } from '@/lib/alerts/types';

/**
 * Pure classification logic for rendering ChannelDelivery state on
 * /alerts. Lives in its own file so the "what should this render as?"
 * decisions are unit-testable without a renderer — same pattern as
 * `components/format.ts` for `fmtWeight` / `truncate`.
 *
 * The single concern is: given the delivery data, what STATE should
 * the operator-facing UI represent? Color/icon mapping lives in
 * `ChannelDeliveryBadge.tsx` and is a thin function of these states.
 */

/** One-delivery state. */
export type DeliveryClassification = 'delivered' | 'fallback' | 'failed';

/** Whole-list state for the alert row's channels column. */
export type DeliveriesClassification =
  | 'pending'        // empty array — reserved but no delivery recorded
  | 'all-delivered'  // every delivery ok=true (including 'file' fallback ok=true)
  | 'mixed'          // some ok=true, some ok=false
  | 'all-failed';    // every delivery ok=false

/**
 * Classify ONE delivery.
 *
 *   - ok=false                  → 'failed'
 *   - ok=true + channel='file'  → 'fallback' (wrote to outbox; not real channel)
 *   - ok=true + other channel   → 'delivered'
 *
 * The fallback state is the channel-honesty contract from Task 2.1:
 * a 'file'-channel delivery means the env var for the requested
 * channel was unset, NOT that the channel actually fired.
 */
export function classifyDelivery(d: ChannelDelivery): DeliveryClassification {
  if (!d.ok) return 'failed';
  if (d.channel === 'file') return 'fallback';
  return 'delivered';
}

/**
 * Classify the channelsSent array as a whole. Pure function; the
 * caller decides what header (if any) to render.
 */
export function classifyDeliveries(deliveries: ChannelDelivery[]): DeliveriesClassification {
  if (deliveries.length === 0) return 'pending';
  const okCount = deliveries.filter((d) => d.ok).length;
  if (okCount === 0) return 'all-failed';
  if (okCount === deliveries.length) return 'all-delivered';
  return 'mixed';
}

/** Human-readable label for a channel. Centralized so /alerts and any
 *  future channel-aware UI surface the same labels. */
export function channelLabel(channel: AlertChannel): string {
  switch (channel) {
    case 'slack':   return 'Slack';
    case 'email':   return 'Email';
    case 'webhook': return 'Webhook';
    case 'file':    return 'File (outbox)';
  }
}
