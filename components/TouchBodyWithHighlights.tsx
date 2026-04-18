'use client';

export function TouchBodyWithHighlights({
  body, spans,
}: {
  body: string;
  spans: Array<{ evidence_id: string; span: string; claim: string }>;
}) {
  const claims = spans.map((s) => s.claim).filter(Boolean);
  if (claims.length === 0) return <p className="whitespace-pre-wrap">{body}</p>;
  const escaped = claims.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'g');
  const parts = body.split(re);
  return (
    <p className="whitespace-pre-wrap leading-relaxed">
      {parts.map((part, i) =>
        claims.includes(part)
          ? <mark key={i} className="bg-emerald-100 text-emerald-900 rounded px-0.5">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </p>
  );
}
