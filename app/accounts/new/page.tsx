'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function NewAccountPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, domain: domain || undefined }),
    });
    const { id } = await res.json();
    router.push(`/accounts/${id}`);
  }

  return (
    <main>
      <h1 className="text-xl font-semibold">New account</h1>
      <form onSubmit={submit} className="mt-4 space-y-3 max-w-md">
        <label className="block">
          <span className="text-sm text-neutral-700">Company name</span>
          <input className="mt-1 w-full rounded border border-neutral-300 p-2"
                 value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="block">
          <span className="text-sm text-neutral-700">Domain</span>
          <input className="mt-1 w-full rounded border border-neutral-300 p-2"
                 value={domain} onChange={(e) => setDomain(e.target.value)}
                 placeholder="acme.com" />
        </label>
        <button disabled={submitting}
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
          Create
        </button>
      </form>
    </main>
  );
}
