import type { ScoreRationaleItem } from '@/lib/scoring/score';
import type { Tier } from '@/lib/scoring/rules';
import { TierBadge } from './TierBadge';
import { fmtWeight } from './format';

/**
 * Per-account score breakdown panel. Shows the integer score, the tier
 * badge, and one row per rule that contributed (positive or negative).
 *
 * Items are expected to come from `lead_scores.rationaleJson` — same
 * type as `ScoreRationaleItem` so a schema drift would show up at the
 * TypeScript boundary, not the rendered page.
 *
 * Server-rendered; no client state. The empty state explicitly says
 * "no matching signals" so an operator can distinguish "score is zero
 * because nothing matched" from "score is zero because no data" — the
 * latter would mean the recompute hadn't run.
 */
export function ScoreRationale({
  items, score, tier,
}: {
  items: ScoreRationaleItem[];
  score: number;
  tier: Tier;
}) {
  return (
    <div className="border rounded p-3 text-sm bg-white">
      <div className="flex items-center justify-between mb-3">
        <span className="font-medium">Score</span>
        <span className="flex items-center gap-2">
          <span className="font-mono">{score}</span>
          <TierBadge tier={tier} />
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-slate-400">No matching signals.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => (
            // (rule_id, evidence_id) is unique within a rationale — the
            // scoring engine appends one row per matched (rule, evidence)
            // pair. Using that as the React key avoids index-based keys
            // which would mis-reconcile if rules were reordered.
            <li key={`${it.rule_id}::${it.evidence_id}`} className="flex gap-2 text-slate-700">
              <span className="font-mono text-xs w-12 shrink-0">{it.rule_id}</span>
              <span className="font-mono text-xs w-12 shrink-0">{fmtWeight(it.weight)}</span>
              <span className="text-slate-500 text-xs">cites <span className="font-mono">{it.evidence_id}</span></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
