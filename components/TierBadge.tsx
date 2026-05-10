import type { Tier } from '@/lib/scoring/rules';

/**
 * Visual indicator of an account's current scoring tier. Server-rendered;
 * no client state.
 *
 * Color is supplementary, not load-bearing — the human-readable label is
 * always present so screen-reader users and color-blind users get the
 * same information.
 */
const STYLES: Record<Tier, string> = {
  cold: 'bg-slate-200 text-slate-700',
  warm: 'bg-amber-100 text-amber-800',
  hot: 'bg-orange-200 text-orange-900',
  on_fire: 'bg-red-200 text-red-900',
};
const LABEL: Record<Tier, string> = {
  cold: 'Cold',
  warm: 'Warm',
  hot: 'Hot',
  on_fire: 'On fire',
};

export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span className={`px-2 py-0.5 text-xs rounded font-medium ${STYLES[tier]}`}>
      {LABEL[tier]}
    </span>
  );
}
