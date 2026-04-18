'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function NewDeliverablePage() {
  const router = useRouter();
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/deliverables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawMarkdown: raw }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === 'string' ? data.error : 'Import failed');
        return;
      }
      const { deliverableId } = await res.json();
      router.push(`/deliverables/${deliverableId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1 className="text-xl font-semibold">Import deliverable</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Paste a full SDR deliverable markdown document (targets + touches + narrative).
        Claude will parse it into accounts, contacts, sequences, and touches — each auditable with claim audit + critics.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <textarea className="w-full rounded border border-neutral-300 p-2 font-mono text-xs"
                  rows={20} value={raw} onChange={(e) => setRaw(e.target.value)}
                  placeholder="Paste the full deliverable here…"
                  required />
        <button disabled={busy || raw.length < 50}
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {busy ? 'Parsing & importing… (30-90s)' : 'Import'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </main>
  );
}
