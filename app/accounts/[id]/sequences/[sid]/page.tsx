import { db, schema } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { SequenceTouchList, type TouchForList, type EvidenceForPill } from './SequenceTouchList';

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
  const evidenceById: Record<string, EvidenceForPill> = Object.fromEntries(
    evidence.map((e) => [e.id, { id: e.id, extractedFact: e.extractedFact, sourceUrl: e.sourceUrl }])
  );

  const touchesForList: TouchForList[] = touches.map((t) => {
    const rev = revisions.find((r) => r.id === t.currentRevisionId);
    return {
      id: t.id, position: t.position, channel: t.channel as 'email' | 'linkedin',
      currentRevisionId: t.currentRevisionId,
      revision: rev ? {
        id: rev.id, subject: rev.subject, body: rev.body,
        supportingSpans: rev.supportingSpans,
        citedEvidenceIds: rev.citedEvidenceIds,
      } : null,
    };
  });

  return (
    <main>
      <Link href={`/accounts/${accountId}/sequences`} className="text-sm text-neutral-500">← Sequences</Link>
      <h1 className="mt-2 text-2xl font-semibold">Sequence {sid.slice(0, 11)}</h1>
      <SequenceTouchList touches={touchesForList} evidenceById={evidenceById} />
    </main>
  );
}
