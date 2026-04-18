'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ResearchButton({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true); setMsg(null); setError(null);
    try {
      const res = await fetch('/api/evidence/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === 'string' ? data.error : 'Research failed');
        return;
      }
      const { evidenceIds } = await res.json();
      setMsg(`Captured ${evidenceIds.length} facts (pending audit).`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3">
      <button disabled={busy} onClick={go}
              className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm disabled:opacity-50">
        {busy ? 'Researching… (30-120s)' : 'Run auto-research'}
      </button>
      {msg && <span className="ml-2 text-sm text-neutral-600">{msg}</span>}
      {error && <span className="ml-2 text-sm text-red-600">{error}</span>}
    </div>
  );
}
