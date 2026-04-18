'use client';
import { useState } from 'react';

export function ExportButton({ sequenceId }: { sequenceId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function go() {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sequenceId }),
      });
      if (!res.ok) {
        setError('Export failed');
        return;
      }
      const { artifacts } = await res.json();
      if (!artifacts || artifacts.length === 0) {
        setError('No drafts to export.');
        return;
      }
      for (const a of artifacts) {
        const blob = new Blob([a.content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = a.filename;
        link.click();
        URL.revokeObjectURL(url);
      }
      if (artifacts[0]) {
        try {
          await navigator.clipboard.writeText(artifacts[0].content);
        } catch {
          // clipboard may fail in non-secure contexts; silently ignore
        }
      }
      setSuccess(`Exported ${artifacts.length} touches. Touch 1 copied to clipboard.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={go} disabled={busy}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
        {busy ? 'Exporting…' : 'Export sequence'}
      </button>
      {success && <span className="text-sm text-emerald-700">{success}</span>}
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
