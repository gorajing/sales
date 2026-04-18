'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function AuditControls({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setMsg(null); setError(null);
    try {
      const res = await fetch('/api/evidence/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === 'string' ? data.error : 'Audit failed');
        return;
      }
      const { verified, disputed } = await res.json();
      setMsg(`Audited: ${verified} verified, ${disputed} disputed.`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 flex items-center gap-3">
      <button disabled={busy} onClick={run}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
        {busy ? 'Auditing…' : 'Run extraction audit on pending'}
      </button>
      {msg && <span className="text-sm text-neutral-600">{msg}</span>}
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
