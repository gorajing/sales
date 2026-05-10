import { db, schema } from '@/db';
import { desc, inArray, ne, and, isNotNull } from 'drizzle-orm';
import { TierBadge } from '@/components/TierBadge';
import { SignalRow } from '@/components/SignalRow';
import { latestScorePerAccount } from '@/lib/inbound/queries';
import Link from 'next/link';

/**
 * /inbound — the operator's daily landing view.
 *
 * Two sections:
 *
 *   1. **Top-scored accounts** (latest score per account, sorted by score
 *      DESC, limit 25). Backed by `latestScorePerAccount`, which uses a
 *      SQL correlated subquery so the wire-level cost is bounded by the
 *      number of distinct accounts, not the historical score count.
 *
 *   2. **Recent signals** (most recent 50 `evidence` rows where
 *      `signal_type` is non-NULL and not `'none'`, ordered by
 *      `captured_at DESC`). Bounded at the query — no in-memory
 *      slicing.
 *
 * Account labels for both sections are resolved via a single bounded
 * `inArray` lookup over the union of account ids referenced. An earlier
 * draft pulled every row of `accounts` and built a Map — that scales
 * with total accounts, not with what the page actually shows. The
 * current approach keeps the working set at most 75 ids.
 *
 * `force-dynamic` because the page is a real-time operator view —
 * caching here would render stale signals/scores between recomputes.
 */
export const dynamic = 'force-dynamic';

export default async function InboundPage() {
  const topScored = latestScorePerAccount(25);

  // Recent signal-typed evidence. Filter excludes:
  //   - NULL signal_type (pre-v2 evidence, manual paste, etc.)
  //   - 'none' (explicitly tagged non-signal)
  // The schema only enforces the enum membership, not non-null, so the
  // explicit isNotNull guards against pre-v2 rows leaking into the view.
  const recentSignals = db.select({
    id: schema.evidence.id,
    capturedAt: schema.evidence.capturedAt,
    sourceType: schema.evidence.sourceType,
    signalType: schema.evidence.signalType,
    snippet: schema.evidence.snippet,
    accountId: schema.evidence.accountId,
  }).from(schema.evidence)
    .where(and(
      isNotNull(schema.evidence.signalType),
      ne(schema.evidence.signalType, 'none'),
    ))
    .orderBy(desc(schema.evidence.capturedAt))
    .limit(50)
    .all();

  // One bounded account fetch covering both sections.
  const referencedIds = Array.from(new Set([
    ...topScored.map((s) => s.accountId),
    ...recentSignals.map((s) => s.accountId),
  ]));
  const accounts = referencedIds.length > 0
    ? db.select().from(schema.accounts)
        .where(inArray(schema.accounts.id, referencedIds))
        .all()
    : [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  return (
    <main className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Inbound</h1>
        <p className="text-sm text-neutral-500">
          Latest scoring + the signals that drove it. Run a recompute to refresh.
        </p>
      </header>

      <section>
        <h2 className="text-lg font-medium mb-2">Top-scored accounts</h2>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-1 px-2">Account</th>
              <th className="py-1 px-2">Score</th>
              <th className="py-1 px-2">Tier</th>
              <th className="py-1 px-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {topScored.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-3 px-2 text-slate-400">
                  No scores yet. POST to <code className="font-mono">/api/signals</code> then{' '}
                  <code className="font-mono">/api/scoring/recompute</code> to populate this list.
                </td>
              </tr>
            ) : (
              topScored.map((s) => {
                const a = accountById.get(s.accountId);
                const label = a?.name ?? s.accountId;
                return (
                  <tr key={s.id} className="border-b hover:bg-slate-50">
                    <td className="py-1 px-2">
                      <Link className="text-blue-700 hover:underline" href={`/accounts/${s.accountId}`}>
                        {label}
                      </Link>
                    </td>
                    <td className="py-1 px-2 font-mono">{s.score}</td>
                    <td className="py-1 px-2"><TierBadge tier={s.tier} /></td>
                    <td className="py-1 px-2 text-xs text-slate-500">
                      {new Date(s.computedAt).toLocaleString()}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Recent signals</h2>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-1 px-2">When</th>
              <th className="py-1 px-2">Source</th>
              <th className="py-1 px-2">Signal</th>
              <th className="py-1 px-2">Account</th>
              <th className="py-1 px-2">Snippet</th>
            </tr>
          </thead>
          <tbody>
            {recentSignals.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-3 px-2 text-slate-400">
                  No signals yet.
                </td>
              </tr>
            ) : (
              recentSignals.map((s) => {
                const a = accountById.get(s.accountId);
                // Prefer the domain (more identifying than the placeholder
                // name) when available; fall back to name; finally to id.
                const label = a?.domain ?? a?.name ?? null;
                return (
                  <SignalRow
                    key={s.id}
                    capturedAt={s.capturedAt}
                    sourceType={s.sourceType}
                    signalType={s.signalType}
                    snippet={s.snippet}
                    accountId={s.accountId}
                    accountLabel={label}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
