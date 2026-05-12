import type { ChannelDelivery } from '@/lib/alerts/types';
import {
  classifyDelivery,
  classifyDeliveries,
  channelLabel,
  type DeliveryClassification,
  type DeliveriesClassification,
} from './channel-classify';

/**
 * Visual + screen-reader-honest indicator of a single channel
 * delivery's disposition.
 *
 * Decision logic lives in `channel-classify.ts` as pure functions
 * (testable without a renderer). This component is a thin renderer
 * over those classifications.
 */
function statusGlyph(ok: boolean): string {
  return ok ? '✓' : '✗';
}

function dotColor(cls: DeliveryClassification): string {
  switch (cls) {
    case 'delivered': return 'bg-emerald-500';
    case 'fallback':  return 'bg-slate-400';
    case 'failed':    return 'bg-red-500';
  }
}

function textColor(cls: DeliveryClassification): string {
  switch (cls) {
    case 'delivered': return 'text-emerald-800';
    case 'fallback':  return 'text-slate-600';
    case 'failed':    return 'text-red-800';
  }
}

function ariaState(cls: DeliveryClassification): string {
  switch (cls) {
    case 'delivered': return 'delivered';
    case 'fallback':  return 'fallback delivery — wrote to outbox';
    case 'failed':    return 'delivery failed';
  }
}

export function ChannelDeliveryBadge({ delivery }: { delivery: ChannelDelivery }) {
  const cls = classifyDelivery(delivery);
  const label = channelLabel(delivery.channel);
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${textColor(cls)}`}
      aria-label={`${label}: ${ariaState(cls)}${delivery.detail ? `, ${delivery.detail}` : ''}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor(cls)}`} aria-hidden="true" />
      <span>{label} {statusGlyph(delivery.ok)}</span>
      {delivery.detail && !delivery.ok && (
        <span className="text-slate-500">— {delivery.detail}</span>
      )}
    </span>
  );
}

/**
 * Honest-rendering of the channelsSent array on an alert row.
 * Top-level state is classified via `classifyDeliveries`:
 *
 *   - 'pending'      → empty array; the alert is RESERVED but no
 *                      delivery attempts recorded yet (transient
 *                      between dispatcher steps 1 and 3, or
 *                      permanent if step 3 crashed — see
 *                      lib/alerts/dispatch.ts swallow-and-log).
 *   - 'all-delivered'→ every delivery ok=true; no header.
 *   - 'mixed'        → at least one delivered, at least one failed;
 *                      header warning so operator sees trouble first.
 *   - 'all-failed'   → header warning + per-channel red badges.
 */
function topLevelHeader(cls: DeliveriesClassification) {
  switch (cls) {
    case 'pending':
      return null;
    case 'all-delivered':
      return null;
    case 'mixed':
      return (
        <span className="text-xs text-amber-700 font-medium" aria-label="some deliveries failed">
          ⚠ Some deliveries failed
        </span>
      );
    case 'all-failed':
      return (
        <span className="text-xs text-red-700 font-medium" aria-label="all deliveries failed">
          ⚠ All deliveries failed
        </span>
      );
  }
}

export function ChannelDeliveryList({ deliveries }: { deliveries: ChannelDelivery[] }) {
  const cls = classifyDeliveries(deliveries);
  if (cls === 'pending') {
    return (
      <span className="text-xs text-slate-400" aria-label="delivery pending — no channel delivery recorded">
        Pending — no delivery recorded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      {topLevelHeader(cls)}
      {deliveries.map((d, i) => (
        <ChannelDeliveryBadge key={`${d.channel}-${i}`} delivery={d} />
      ))}
    </span>
  );
}
