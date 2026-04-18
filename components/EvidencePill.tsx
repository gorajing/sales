'use client';
export function EvidencePill({
  id, fact, sourceUrl,
}: { id: string; fact: string; sourceUrl: string }) {
  return (
    <a href={sourceUrl} target="_blank" rel="noreferrer"
       title={fact}
       className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800 hover:bg-emerald-200">
      {id.slice(0, 11)}
    </a>
  );
}
