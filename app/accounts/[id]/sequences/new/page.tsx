'use client';
import { useRouter, useParams } from 'next/navigation';
import { useState } from 'react';

type Channel = 'email' | 'linkedin';

export default function NewSequencePage() {
  const router = useRouter();
  const { id: accountId } = useParams<{ id: string }>();
  const [channels, setChannels] = useState<Channel[]>(['email', 'linkedin', 'email']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setAt(i: number, c: Channel) {
    setChannels(channels.map((ch, idx) => idx === i ? c : ch));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/sequences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, channels }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === 'string' ? data.error : 'Failed to create sequence');
        return;
      }
      const { sequenceId } = await res.json();
      router.push(`/accounts/${accountId}/sequences/${sequenceId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1 className="text-xl font-semibold">New sequence</h1>
      <form onSubmit={submit} className="mt-4 max-w-md space-y-3">
        <p className="text-sm text-neutral-700">Touches (in order):</p>
        <ul className="space-y-2">
          {channels.map((c, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-6 text-sm text-neutral-500">#{i + 1}</span>
              <select value={c} onChange={(e) => setAt(i, e.target.value as Channel)}
                      className="rounded border border-neutral-300 p-1 text-sm">
                <option value="email">email</option>
                <option value="linkedin">linkedin</option>
              </select>
              <button type="button" onClick={() => setChannels(channels.filter((_, idx) => idx !== i))}
                      disabled={channels.length <= 1}
                      className="text-xs text-red-600 disabled:opacity-30">remove</button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => setChannels([...channels, 'email'])}
                disabled={channels.length >= 10}
                className="text-sm text-blue-600 disabled:opacity-50">+ Add touch</button>
        <div>
          <button disabled={busy}
                  className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {busy ? 'Creating…' : 'Create sequence'}
          </button>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>
      </form>
    </main>
  );
}
