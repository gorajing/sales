import Link from 'next/link';
import { db, schema } from '@/db';
import { desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export default function DeliverablesListPage() {
  const deliverables = db.select().from(schema.deliverables)
    .orderBy(desc(schema.deliverables.createdAt)).all();
  return (
    <main>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Deliverables</h1>
        <Link href="/deliverables/new"
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
          + Import deliverable
        </Link>
      </div>
      <ul className="mt-6 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
        {deliverables.map((d) => (
          <li key={d.id} className="p-3">
            <Link href={`/deliverables/${d.id}`} className="font-medium">{d.name}</Link>
            <span className="ml-2 text-xs text-neutral-500">{d.createdAt}</span>
          </li>
        ))}
        {deliverables.length === 0 && (
          <li className="p-3 text-sm text-neutral-500 italic">No deliverables yet.</li>
        )}
      </ul>
    </main>
  );
}
