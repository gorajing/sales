'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type UnsupportedClaim = { sentence: string; reason: string };

export function ClaimAuditButton({ touchId }: { touchId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState<UnsupportedClaim[] | null>(null);
  const [mappedCount, setMappedCount] = useState<number | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setError(null); setIssues([]); setUnsupported(null); setMappedCount(null);
    try {
      const res = await fetch('/api/touches/claim-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touchId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === 'string' ? data.error : 'Claim audit failed');
        return;
      }
      const json = await res.json();
      setMappedCount(json.supportingSpans.length);
      setUnsupported(json.unsupportedClaims);
      if (Array.isArray(json.validationIssues)) setIssues(json.validationIssues);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <button disabled={busy} onClick={run}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs disabled:opacity-50">
        {busy ? 'Auditing claims…' : 'Run claim audit'}
      </button>
      {mappedCount !== null && (
        <p className="text-xs text-emerald-700">
          Mapped {mappedCount} claim{mappedCount === 1 ? '' : 's'} to evidence.
        </p>
      )}
      {issues.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-amber-700">
            {issues.length} span validation issue{issues.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 ml-4 list-disc space-y-0.5 text-amber-800">
            {issues.map((i, idx) => <li key={idx}>{i}</li>)}
          </ul>
        </details>
      )}
      {unsupported && unsupported.length > 0 && (
        <div className="rounded bg-red-50 p-2 text-xs">
          <p className="font-medium text-red-900">
            {unsupported.length} unsupported claim{unsupported.length === 1 ? '' : 's'}:
          </p>
          <ul className="mt-1 space-y-1">
            {unsupported.map((u, idx) => (
              <li key={idx}>
                <blockquote className="italic text-red-800">&quot;{u.sentence}&quot;</blockquote>
                <p className="text-red-700">&rarr; {u.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {unsupported && unsupported.length === 0 && mappedCount !== null && (
        <p className="text-xs text-emerald-700">No unsupported claims. Good to go.</p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
