import Link from 'next/link';
import { db, schema } from '@/db';
import { eq, asc } from 'drizzle-orm';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function DeliverablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deliverable = db.select().from(schema.deliverables)
    .where(eq(schema.deliverables.id, id)).get();
  if (!deliverable) notFound();

  const daRows = db.select().from(schema.deliverableAccounts)
    .where(eq(schema.deliverableAccounts.deliverableId, id))
    .orderBy(asc(schema.deliverableAccounts.rank)).all();

  // For each account, fetch account + touch count
  const accountSummaries = daRows.map((da) => {
    const account = db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, da.accountId)).get();
    const touchCount = da.sequenceId
      ? db.select().from(schema.touches)
          .where(eq(schema.touches.sequenceId, da.sequenceId)).all().length
      : 0;
    return { da, account, touchCount };
  });

  return (
    <main>
      <Link href="/deliverables" className="text-sm text-neutral-500">← Deliverables</Link>
      <h1 className="mt-2 text-2xl font-semibold">{deliverable.name}</h1>

      {deliverable.introMd && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-neutral-600">Intro & framing</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded bg-neutral-50 p-3 text-xs">
            {deliverable.introMd}
          </pre>
        </details>
      )}

      <h2 className="mt-6 text-lg font-medium">Target accounts ({accountSummaries.length})</h2>
      <ol className="mt-3 space-y-3">
        {accountSummaries.map(({ da, account, touchCount }) => (
          <li key={da.id} className="rounded border border-neutral-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm text-neutral-500">#{da.rank}</span>
                <Link href={`/accounts/${account?.id}`} className="ml-2 font-medium">
                  {account?.name ?? '(missing account)'}
                </Link>
              </div>
              <div className="text-xs text-neutral-500">
                {touchCount} touches · {da.dealShape ?? '—'}
              </div>
            </div>
            {da.triggerSummary && (
              <p className="mt-1 text-xs text-neutral-700"><strong>Trigger:</strong> {da.triggerSummary}</p>
            )}
            {da.routing && (
              <p className="mt-0.5 text-xs text-neutral-500"><strong>Routing:</strong> {da.routing} · Time: {da.timeAsk ?? '—'}</p>
            )}
            <div className="mt-2 flex gap-3 text-xs">
              <Link href={`/accounts/${account?.id}/evidence`} className="underline">Evidence & audit</Link>
              {da.sequenceId && (
                <Link href={`/accounts/${account?.id}/sequences/${da.sequenceId}`} className="underline">
                  Review touches
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>

      {deliverable.outroMd && (
        <details className="mt-8">
          <summary className="cursor-pointer text-sm text-neutral-600">Methodology, sources, exclusions</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded bg-neutral-50 p-3 text-xs">
            {deliverable.outroMd}
          </pre>
        </details>
      )}
    </main>
  );
}
