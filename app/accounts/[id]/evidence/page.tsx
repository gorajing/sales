import { db, schema } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PasteForm } from './PasteForm';
import { ResearchButton } from './ResearchButton';
import { AuditControls } from './AuditControls';
import { DisputedActions } from './DisputedActions';

export const dynamic = 'force-dynamic';

export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();

  const evidence = db.select().from(schema.evidence)
    .where(eq(schema.evidence.accountId, id))
    .orderBy(desc(schema.evidence.capturedAt)).all();

  // Latest audit per evidence id (for disputed rows)
  const audits = db.select().from(schema.extractionAudits)
    .orderBy(desc(schema.extractionAudits.createdAt)).all();
  const latestAudit = new Map<string, typeof audits[number]>();
  for (const a of audits) {
    if (!latestAudit.has(a.evidenceId)) latestAudit.set(a.evidenceId, a);
  }

  return (
    <main>
      <Link href={`/accounts/${id}`} className="text-sm text-neutral-500">← {account.name}</Link>
      <h1 className="mt-2 text-2xl font-semibold">Evidence</h1>
      <PasteForm accountId={id} />
      <ResearchButton accountId={id} />
      <AuditControls accountId={id} />
      <h2 className="mt-8 text-lg font-medium">Captured ({evidence.length})</h2>
      <ul className="mt-3 space-y-2">
        {evidence.map((e) => {
          const audit = latestAudit.get(e.id);
          const statusColor =
            e.extractionStatus === 'verified' ? 'bg-emerald-100 text-emerald-800' :
            e.extractionStatus === 'disputed' ? 'bg-amber-100 text-amber-800' :
            'bg-neutral-100 text-neutral-700';
          return (
            // `id={e.id}` is the anchor target for deep-links from
            // ScoreRationale on /accounts/[id] (rationale rows link
            // `…/evidence#ev_…`). React `key` is virtual-DOM only;
            // the HTML `id` is what the browser scrolls to.
            <li key={e.id} id={e.id} className="rounded border border-neutral-200 bg-white p-3 scroll-mt-20 target:ring-2 target:ring-blue-400">
              <div className="flex items-center justify-between">
                <span className={`rounded px-2 py-0.5 text-xs ${statusColor}`}>
                  {e.extractionStatus}
                </span>
                <a href={e.sourceUrl} target="_blank" rel="noreferrer"
                   className="text-xs text-blue-600 underline">{e.sourceType}</a>
              </div>
              <p className="mt-2 text-sm font-medium">{e.extractedFact}</p>
              <p className="mt-1 text-xs text-neutral-500 italic line-clamp-2">
                &quot;{e.snippet}&quot;
              </p>
              {e.extractionStatus === 'disputed' && audit && (
                <div className="mt-2 rounded bg-amber-50 p-2 text-xs">
                  <p className="font-medium text-amber-900">Audit disputed:</p>
                  <p className="text-amber-800">{audit.reason}</p>
                  {audit.suggestedCorrection && (
                    <p className="mt-1 text-amber-700">
                      Suggested: &quot;{audit.suggestedCorrection}&quot;
                    </p>
                  )}
                  <DisputedActions evidenceId={e.id} />
                </div>
              )}
            </li>
          );
        })}
        {evidence.length === 0 && (
          <li className="text-sm text-neutral-500 italic">No evidence yet.</li>
        )}
      </ul>
    </main>
  );
}
