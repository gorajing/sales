'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function PasteForm({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<number | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setSuccess(null);
    try {
      const res = await fetch('/api/evidence/paste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, sourceUrl: url, rawText: text, capturedBy: 'manual' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = Array.isArray(data.error) && data.error[0]?.message
          ? data.error[0].message
          : (typeof data.error === 'string' ? data.error : 'Extraction failed');
        setError(msg);
        return;
      }
      const { evidenceIds } = await res.json();
      setSuccess(evidenceIds.length);
      setUrl(''); setText('');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3 rounded border border-neutral-200 bg-white p-4">
      <h2 className="text-lg font-medium">Paste evidence</h2>
      <input className="w-full rounded border border-neutral-300 p-2"
             value={url} onChange={(e) => setUrl(e.target.value)}
             placeholder="Source URL (required)" required />
      <textarea className="w-full rounded border border-neutral-300 p-2 font-mono text-sm"
                rows={8} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="Paste raw text from the source (article, LinkedIn post, 10-K excerpt, etc.)"
                required />
      <button disabled={busy}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
        {busy ? 'Extracting…' : 'Extract facts'}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {success !== null && <p className="text-sm text-emerald-700">Captured {success} facts (pending audit).</p>}
    </form>
  );
}
