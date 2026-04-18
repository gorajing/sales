'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function DisputedActions({ evidenceId }: { evidenceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act(action: 'accept_correction' | 'override_verified' | 'remove') {
    setBusy(true);
    try {
      await fetch('/api/evidence/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evidenceId, action }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex gap-2">
      <button disabled={busy} onClick={() => act('accept_correction')}
              className="rounded bg-emerald-600 px-2 py-1 text-xs text-white disabled:opacity-50">
        Accept correction
      </button>
      <button disabled={busy} onClick={() => act('override_verified')}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs disabled:opacity-50">
        Override to verified
      </button>
      <button disabled={busy} onClick={() => act('remove')}
              className="rounded border border-red-300 bg-white px-2 py-1 text-xs text-red-700 disabled:opacity-50">
        Remove
      </button>
    </div>
  );
}
