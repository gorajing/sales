'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function TouchDrafter({ touchId, hasDraft }: { touchId: string; hasDraft: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function draft() {
    setBusy(true); setIssues([]); setError(null);
    try {
      const res = await fetch('/api/touches/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touchId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === 'string' ? data.error : 'Draft failed');
        return;
      }
      const json = await res.json();
      if (Array.isArray(json.issues) && json.issues.length) setIssues(json.issues);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {issues.length > 0 && (
        <span className="text-xs text-amber-700">{issues.length} validation issues</span>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button disabled={busy} onClick={draft}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs disabled:opacity-50">
        {busy ? 'Drafting…' : hasDraft ? 'Redraft' : 'Draft'}
      </button>
    </div>
  );
}
