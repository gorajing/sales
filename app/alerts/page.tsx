import { db, schema } from '@/db';
import { inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { recentAlerts } from '@/lib/alerts/queries';
import { acknowledgeAlert } from '@/lib/alerts/ack';
import { ChannelDeliveryList } from '@/components/ChannelDeliveryBadge';
import type { ChannelDelivery } from '@/lib/alerts/types';

/**
 * /alerts — the operator's alert feed.
 *
 * Server-rendered (no client component). The Acknowledge control is a
 * native `<form action={serverAction}>` — runs server-side, works
 * without JavaScript, gets the usual server-action enhancement in
 * Next 16. No `'use client'` anywhere on this page.
 *
 * Data path:
 *   - `recentAlerts(100)` is the bounded SQL query (lib/alerts/queries.ts).
 *     Orders by `createdAt DESC, rowid DESC` so the top-N cut is
 *     deterministic across renders.
 *   - Account labels are resolved via a single bounded `inArray` over
 *     only the IDs the page actually shows (max 100). Same lesson as
 *     `app/inbound/page.tsx`: never pull every row of `accounts`.
 *
 * Trust boundary:
 *   - This page (and the server action below) does NOT enforce
 *     `INTERNAL_API_SECRET`. The page is gated by deploy-time auth
 *     (reverse proxy, SSO, etc.) per `docs/architecture.md`. The
 *     external `POST /api/alerts/:id/ack` route DOES enforce the
 *     secret, for external integrations.
 *   - The server action receives form data which CAN be tampered with
 *     (any operator who can reach the page can submit any alertId).
 *     This is acceptable because the page is already gated; an
 *     authenticated operator acknowledging any alert is in-scope.
 *     The ack helper enforces the id-shape regex so SQL-injection-
 *     shaped form values return cleanly as `not_found`.
 *
 * Rendering honesty:
 *   - `channelsSent` is rendered via ChannelDeliveryList, which shows
 *     each channel's actual disposition (delivered, fallback file,
 *     failed) with both visual and screen-reader text — operator
 *     can't be tricked into thinking a 504-failed Slack send actually
 *     went through.
 *   - When `acknowledgedAt` is set, the Acknowledge button is replaced
 *     with the acker's identity + timestamp; the button only appears
 *     for actionable alerts.
 *   - Severity color is supplementary; the severity label is always
 *     visible text.
 */
export const dynamic = 'force-dynamic';

const SEVERITY_STYLE: Record<string, string> = {
  info: 'bg-slate-50 border-slate-200',
  priority: 'bg-amber-50 border-amber-200',
  urgent: 'bg-red-50 border-red-200',
};

const TRIGGER_LABEL: Record<string, string> = {
  tier_promotion: 'Tier promotion',
  engagement_spike: 'Engagement spike',
  high_intent_signal: 'High-intent signal',
  competitor_mention: 'Competitor mention',
  manual: 'Manual',
};

async function acknowledgeAction(formData: FormData) {
  'use server';
  const id = String(formData.get('alertId') ?? '');
  const by = String(formData.get('by') ?? 'unknown@example.com');
  if (!id) return;
  acknowledgeAlert(id, by);
  revalidatePath('/alerts');
}

export default async function AlertsPage() {
  const rows = recentAlerts(100);

  // Bounded account lookup over only the IDs the page renders. The
  // page can show at most 100 rows; accountById has at most 100 keys.
  // An earlier draft pulled every account row regardless — same
  // pattern fix as inbound's `inArray` lookup (Phase 1).
  const referencedAccountIds = Array.from(new Set(rows.map((r) => r.accountId)));
  const accounts = referencedAccountIds.length > 0
    ? db.select().from(schema.accounts)
        .where(inArray(schema.accounts.id, referencedAccountIds))
        .all()
    : [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  // The acknowledger identity comes from an env var for v1; in a
  // multi-user deploy this would be the authenticated user. Falls back
  // to a placeholder rather than crashing the render.
  const acknowledger = process.env.OPERATOR_EMAIL ?? 'operator@example.com';

  return (
    <main className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Alerts</h1>
        <p className="text-sm text-neutral-500">
          Newest first. Fires on tier promotion or engagement spike;
          delivery channels are honest about fallback to file when an
          env var isn&rsquo;t set.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="text-slate-400">
          No alerts yet. Alerts fire automatically from{' '}
          <code className="font-mono">/api/scoring/recompute</code> when an
          account&rsquo;s tier rises or when ≥3 engagement-like signals
          arrive in a 24-hour window.
        </p>
      ) : (
        <ul className="space-y-2" role="list">
          {rows.map((a) => {
            const acct = accountById.get(a.accountId);
            const accountLabel = acct?.name ?? a.accountId;
            const payload = a.payloadJson as Record<string, unknown>;
            // The dispatcher persists `payloadJson.text` after rendering
            // (step 3). Before that update commits the row sits with
            // just the structured payload — render a sensible fallback.
            const text = typeof payload.text === 'string'
              ? payload.text
              : `${TRIGGER_LABEL[a.trigger] ?? a.trigger} on ${accountLabel}`;
            const sevStyle = SEVERITY_STYLE[a.severity] ?? SEVERITY_STYLE.info;
            return (
              <li key={a.id} className={`p-3 rounded border ${sevStyle}`}>
                <div className="flex justify-between items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <time dateTime={a.createdAt}>{new Date(a.createdAt).toLocaleString()}</time>
                      <span>·</span>
                      <span className="uppercase tracking-wide">{a.severity}</span>
                      <span>·</span>
                      <span>{TRIGGER_LABEL[a.trigger] ?? a.trigger}</span>
                    </div>
                    <p className="mt-1 text-sm">{text}</p>
                    <div className="mt-2">
                      <ChannelDeliveryList
                        deliveries={a.channelsSentJson as ChannelDelivery[]}
                      />
                    </div>
                    {a.acknowledgedAt && (
                      <p className="text-xs text-slate-500 mt-2">
                        Acknowledged by{' '}
                        <span className="font-mono">{a.acknowledgedBy}</span>{' '}
                        at <time dateTime={a.acknowledgedAt}>{new Date(a.acknowledgedAt).toLocaleString()}</time>
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <Link
                      className="text-sm text-blue-700 hover:underline"
                      href={`/accounts/${a.accountId}`}
                    >
                      View account →
                    </Link>
                    {!a.acknowledgedAt && (
                      <form action={acknowledgeAction}>
                        <input type="hidden" name="alertId" value={a.id} />
                        <input type="hidden" name="by" value={acknowledger} />
                        <button
                          type="submit"
                          className="text-xs px-3 py-1 border border-neutral-300 rounded bg-white hover:bg-neutral-50"
                          aria-label={`Acknowledge alert: ${TRIGGER_LABEL[a.trigger] ?? a.trigger} for ${accountLabel}`}
                        >
                          Acknowledge
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
