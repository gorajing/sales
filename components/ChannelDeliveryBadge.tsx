import type { ChannelDelivery } from '@/lib/alerts/types';

/**
 * Visual + screen-reader-honest indicator of a single channel
 * delivery's disposition. Renders one of three states:
 *
 *   - ok=true              → small green dot + channel name (and a
 *                            "Slack ✓" or "Sent to file" label).
 *   - ok=false             → small red dot + channel name + the
 *                            failure detail (HTTP code or error).
 *   - "file" channel       → muted neutral indicator with the "wrote
 *                            to outbox" message so the operator knows
 *                            it didn't reach the real channel.
 *
 * Color is supplementary — the visible text and (when relevant) the
 * aria-label always carry the same information.
 */
function labelFor(d: ChannelDelivery): string {
  if (d.channel === 'file') return 'File (outbox)';
  if (d.channel === 'slack') return 'Slack';
  if (d.channel === 'email') return 'Email';
  return 'Webhook';
}

function statusGlyph(ok: boolean): string {
  return ok ? '✓' : '✗';
}

export function ChannelDeliveryBadge({ delivery }: { delivery: ChannelDelivery }) {
  const ok = delivery.ok;
  // file = fallback (wrote-to-disk, not the originally-requested
  // channel). Operator should know this isn't real delivery.
  const isFallback = delivery.channel === 'file';
  const ariaState = ok
    ? (isFallback ? 'fallback delivery — wrote to outbox' : 'delivered')
    : 'delivery failed';

  const dotColor = !ok
    ? 'bg-red-500'
    : isFallback
      ? 'bg-slate-400'
      : 'bg-emerald-500';
  const textColor = !ok
    ? 'text-red-800'
    : isFallback
      ? 'text-slate-600'
      : 'text-emerald-800';

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${textColor}`}
      aria-label={`${labelFor(delivery)}: ${ariaState}${delivery.detail ? `, ${delivery.detail}` : ''}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
      <span>{labelFor(delivery)} {statusGlyph(ok)}</span>
      {delivery.detail && !ok && (
        <span className="text-slate-500">— {delivery.detail}</span>
      )}
    </span>
  );
}

/**
 * Honest-rendering of the channelsSent array on an alert row.
 * Distinguishes three states the operator needs to see:
 *
 *   - empty []      → the alert was RESERVED but no delivery
 *                     attempts have been recorded yet. This is the
 *                     transient state between the dispatcher's
 *                     reserve step and the post-send update; it
 *                     ALSO persists if step-3 of dispatch crashed
 *                     (see lib/alerts/dispatch.ts swallow-and-log).
 *                     Render as "Pending — no delivery recorded."
 *   - all ok=true   → "Delivered" header + per-channel green badges.
 *   - any ok=false  → "Some deliveries failed" header so the operator
 *                     immediately sees the trouble before reading the
 *                     individual badges.
 */
export function ChannelDeliveryList({ deliveries }: { deliveries: ChannelDelivery[] }) {
  if (deliveries.length === 0) {
    return (
      <span className="text-xs text-slate-400" aria-label="delivery pending — no channel delivery recorded">
        Pending — no delivery recorded
      </span>
    );
  }
  const anyFailed = deliveries.some((d) => !d.ok);
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      {anyFailed && (
        <span className="text-xs text-red-700 font-medium" aria-label="some deliveries failed">
          ⚠ Some deliveries failed
        </span>
      )}
      {deliveries.map((d, i) => (
        <ChannelDeliveryBadge key={`${d.channel}-${i}`} delivery={d} />
      ))}
    </span>
  );
}
