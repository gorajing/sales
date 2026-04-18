'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function ImportTouchForm({ touchId, channel }: { touchId: string; channel: 'email' | 'linkedin' }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/touches/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touchId,
          subject: channel === 'email' ? (subject || null) : null,
          body,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === 'string' ? data.error : 'Import failed');
        return;
      }
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs">
        Import draft
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded border border-neutral-200 bg-neutral-50 p-3">
      {channel === 'email' && (
        <input className="w-full rounded border border-neutral-300 p-1.5 text-sm"
               placeholder="Subject (optional)" value={subject}
               onChange={(e) => setSubject(e.target.value)} />
      )}
      <textarea className="w-full rounded border border-neutral-300 p-1.5 font-mono text-sm"
                rows={6} placeholder="Paste your draft body…" required
                value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex gap-2">
        <button disabled={busy}
                className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-50">
          {busy ? 'Importing…' : 'Save draft'}
        </button>
        <button type="button" onClick={() => setOpen(false)}
                className="text-xs text-neutral-500">Cancel</button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}
