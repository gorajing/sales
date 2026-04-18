'use client';
import { useState } from 'react';

type Finding = { issue: string; quote: string; suggested_rewrite: string; principle_id: string | null };
type Critique = { criticName: string; result: { verdict: 'pass' | 'revise' | 'reject'; findings: Finding[] } };

export function CriticPanel({
  touchRevisionId,
  onAcceptRewrite,
}: {
  touchRevisionId: string;
  onAcceptRewrite: (oldText: string, newText: string) => Promise<void>;
}) {
  const [critiques, setCritiques] = useState<Critique[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/touches/critique', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touchRevisionId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === 'string' ? data.error : 'Critique failed');
        return;
      }
      const json = await res.json();
      setCritiques(json.critiques);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!critiques) {
    return (
      <div className="mt-3">
        <button onClick={run} disabled={busy}
                className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs disabled:opacity-50">
          {busy ? 'Critiquing… (20-60s)' : 'Run critics'}
        </button>
        {error && <span className="ml-2 text-xs text-red-600">{error}</span>}
      </div>
    );
  }
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
      {critiques.map((c) => {
        const verdict = c.result.verdict;
        return (
          <div key={c.criticName} className="rounded border border-neutral-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{c.criticName.replace(/_/g, ' ')}</h3>
              <span className={`rounded px-2 py-0.5 text-xs ${
                verdict === 'pass' ? 'bg-emerald-100 text-emerald-800' :
                verdict === 'reject' ? 'bg-red-100 text-red-800' :
                'bg-amber-100 text-amber-800'
              }`}>{verdict}</span>
            </div>
            <ul className="mt-2 space-y-2">
              {c.result.findings.map((f, i) => (
                <li key={i} className="rounded bg-neutral-50 p-2 text-xs">
                  <div className="font-medium">{f.issue}{f.principle_id ? ` (${f.principle_id})` : ''}</div>
                  <blockquote className="mt-1 italic text-neutral-600">&quot;{f.quote}&quot;</blockquote>
                  <div className="mt-1"><span className="text-neutral-400">→ </span>{f.suggested_rewrite}</div>
                  <button
                    className="mt-2 rounded border border-neutral-300 bg-white px-2 py-0.5 text-[11px]"
                    onClick={() => onAcceptRewrite(f.quote, f.suggested_rewrite)}
                  >Accept rewrite</button>
                </li>
              ))}
              {c.result.findings.length === 0 && (
                <li className="text-xs text-neutral-500">No findings.</li>
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
