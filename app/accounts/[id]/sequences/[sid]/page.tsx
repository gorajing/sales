import { db, schema } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { TouchDrafter } from './TouchDrafter';
import { TouchBodyWithHighlights } from '@/components/TouchBodyWithHighlights';
import { EvidencePill } from '@/components/EvidencePill';

export const dynamic = 'force-dynamic';

export default async function SequencePage({ params }: {
  params: Promise<{ id: string; sid: string }>;
}) {
  const { id: accountId, sid } = await params;
  const sequence = db.select().from(schema.sequences).where(eq(schema.sequences.id, sid)).get();
  if (!sequence) notFound();
  const touches = db.select().from(schema.touches)
    .where(eq(schema.touches.sequenceId, sid)).all()
    .sort((a, b) => a.position - b.position);
  const revisions = db.select().from(schema.touchRevisions).all()
    .filter((r) => touches.some((t) => t.currentRevisionId === r.id));
  const evidenceIds = Array.from(new Set(revisions.flatMap((r) => r.citedEvidenceIds)));
  const evidence = evidenceIds.length
    ? db.select().from(schema.evidence).where(inArray(schema.evidence.id, evidenceIds)).all()
    : [];
  const byId = new Map(evidence.map((e) => [e.id, e]));

  return (
    <main>
      <Link href={`/accounts/${accountId}/sequences`} className="text-sm text-neutral-500">← Sequences</Link>
      <h1 className="mt-2 text-2xl font-semibold">Sequence {sid.slice(0, 11)}</h1>
      <ol className="mt-6 space-y-6">
        {touches.map((t) => {
          const rev = revisions.find((r) => r.id === t.currentRevisionId);
          return (
            <li key={t.id} className="rounded border border-neutral-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-500">#{t.position} · {t.channel}</span>
                <TouchDrafter touchId={t.id} hasDraft={!!rev} />
              </div>
              {rev ? (
                <div className="mt-3">
                  {rev.subject && <div className="font-medium">{rev.subject}</div>}
                  <TouchBodyWithHighlights body={rev.body} spans={rev.supportingSpans} />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {rev.citedEvidenceIds.map((eid) => {
                      const e = byId.get(eid);
                      return e ? <EvidencePill key={eid} id={eid} fact={e.extractedFact} sourceUrl={e.sourceUrl} /> : null;
                    })}
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-sm text-neutral-500 italic">No draft yet.</p>
              )}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
