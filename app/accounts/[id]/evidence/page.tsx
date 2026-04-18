import { db, schema } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PasteForm } from './PasteForm';

export const dynamic = 'force-dynamic';

export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();
  const evidence = db.select().from(schema.evidence)
    .where(eq(schema.evidence.accountId, id))
    .orderBy(desc(schema.evidence.capturedAt)).all();
  return (
    <main>
      <Link href={`/accounts/${id}`} className="text-sm text-neutral-500">← {account.name}</Link>
      <h1 className="mt-2 text-2xl font-semibold">Evidence</h1>
      <PasteForm accountId={id} />
      <h2 className="mt-8 text-lg font-medium">Captured ({evidence.length})</h2>
      <ul className="mt-3 space-y-2">
        {evidence.map((e) => (
          <li key={e.id} className="rounded border border-neutral-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">
                {e.extractionStatus}
              </span>
              <a href={e.sourceUrl} target="_blank" rel="noreferrer"
                 className="text-xs text-blue-600 underline">{e.sourceType}</a>
            </div>
            <p className="mt-2 text-sm font-medium">{e.extractedFact}</p>
            <p className="mt-1 text-xs text-neutral-500 italic line-clamp-2">
              &quot;{e.snippet}&quot;
            </p>
          </li>
        ))}
        {evidence.length === 0 && (
          <li className="text-sm text-neutral-500 italic">No evidence yet.</li>
        )}
      </ul>
    </main>
  );
}
