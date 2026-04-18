'use client';
import { useRouter } from 'next/navigation';
import { CriticPanel } from '@/components/CriticPanel';
import { TouchBodyWithHighlights } from '@/components/TouchBodyWithHighlights';
import { EvidencePill } from '@/components/EvidencePill';
import { TouchDrafter } from './TouchDrafter';

export interface TouchForList {
  id: string;
  position: number;
  channel: 'email' | 'linkedin';
  currentRevisionId: string | null;
  revision: {
    id: string; subject: string | null; body: string;
    supportingSpans: Array<{ evidence_id: string; span: string; claim: string }>;
    citedEvidenceIds: string[];
  } | null;
}

export interface EvidenceForPill {
  id: string; extractedFact: string; sourceUrl: string;
}

export function SequenceTouchList({
  touches, evidenceById,
}: {
  touches: TouchForList[];
  evidenceById: Record<string, EvidenceForPill>;
}) {
  const router = useRouter();

  async function onAcceptRewrite(touchId: string, oldText: string, newText: string) {
    const res = await fetch('/api/touches/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touchId, oldText, newText, source: 'critic_rewrite' }),
    });
    if (res.ok) router.refresh();
  }

  return (
    <ol className="mt-6 space-y-6">
      {touches.map((t) => (
        <li key={t.id} className="rounded border border-neutral-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-500">#{t.position} · {t.channel}</span>
            <TouchDrafter touchId={t.id} hasDraft={!!t.revision} />
          </div>
          {t.revision ? (
            <div className="mt-3">
              {t.revision.subject && <div className="font-medium">{t.revision.subject}</div>}
              <TouchBodyWithHighlights body={t.revision.body} spans={t.revision.supportingSpans} />
              <div className="mt-2 flex flex-wrap gap-1">
                {t.revision.citedEvidenceIds.map((eid) => {
                  const e = evidenceById[eid];
                  return e ? <EvidencePill key={eid} id={eid} fact={e.extractedFact} sourceUrl={e.sourceUrl} /> : null;
                })}
              </div>
              <CriticPanel
                touchRevisionId={t.revision.id}
                onAcceptRewrite={(oldText, newText) => onAcceptRewrite(t.id, oldText, newText)}
              />
            </div>
          ) : (
            <p className="mt-3 text-sm text-neutral-500 italic">No draft yet.</p>
          )}
        </li>
      ))}
    </ol>
  );
}
