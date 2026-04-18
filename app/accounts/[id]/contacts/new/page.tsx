'use client';
import { useRouter, useParams } from 'next/navigation';
import { useState } from 'react';

const ARCHETYPES = ['unknown', 'gatekeeper', 'business_user', 'enabler', 'leader'] as const;

export default function NewContactPage() {
  const router = useRouter();
  const { id: accountId } = useParams<{ id: string }>();
  const [fullName, setFullName] = useState('');
  const [title, setTitle] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [archetype, setArchetype] = useState<typeof ARCHETYPES[number]>('unknown');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId, fullName, title: title || undefined,
          linkedinUrl: linkedinUrl || undefined, archetype,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = Array.isArray(data.error) && data.error[0]?.message
          ? data.error[0].message
          : 'Failed to create contact';
        setError(msg);
        return;
      }
      router.push(`/accounts/${accountId}/contacts`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1 className="text-xl font-semibold">New contact</h1>
      <form onSubmit={submit} className="mt-4 max-w-md space-y-3">
        <label className="block">
          <span className="text-sm">Full name</span>
          <input className="mt-1 w-full rounded border border-neutral-300 p-2"
                 required value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm">Title</span>
          <input className="mt-1 w-full rounded border border-neutral-300 p-2"
                 value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm">LinkedIn URL</span>
          <input className="mt-1 w-full rounded border border-neutral-300 p-2"
                 value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm">Buyer archetype</span>
          <select className="mt-1 w-full rounded border border-neutral-300 p-2"
                  value={archetype} onChange={(e) => setArchetype(e.target.value as typeof ARCHETYPES[number])}>
            {ARCHETYPES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <span className="mt-1 block text-xs text-neutral-500">
            gatekeeper = procurement/ops · business_user = uses the product ·
            enabler = IT/HR/enablement · leader = exec/founder
          </span>
        </label>
        <button disabled={busy}
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {busy ? 'Creating…' : 'Create'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </main>
  );
}
