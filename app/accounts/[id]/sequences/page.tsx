import { db, schema } from '@/db';
import { eq, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function SequencesListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();
  const sequences = db.select().from(schema.sequences)
    .where(eq(schema.sequences.accountId, id))
    .orderBy(desc(schema.sequences.createdAt)).all();

  return (
    <main>
      <Link href={`/accounts/${id}`} className="text-sm text-neutral-500">← {account.name}</Link>
      <div className="mt-2 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sequences</h1>
        <Link href={`/accounts/${id}/sequences/new`}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
          + New sequence
        </Link>
      </div>
      <ul className="mt-4 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
        {sequences.map((s) => {
          const touches = db.select().from(schema.touches)
            .where(eq(schema.touches.sequenceId, s.id)).all();
          return (
            <li key={s.id} className="p-3">
              <Link href={`/accounts/${id}/sequences/${s.id}`} className="font-medium">
                Sequence {s.id.slice(0, 11)}
              </Link>
              <span className="ml-2 text-sm text-neutral-500">
                {touches.length} touches · {s.status}
              </span>
            </li>
          );
        })}
        {sequences.length === 0 && (
          <li className="p-3 text-sm text-neutral-500 italic">No sequences yet.</li>
        )}
      </ul>
    </main>
  );
}
