import Link from 'next/link';
import { db, schema } from '@/db';
import { desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export default function Home() {
  const accounts = db.select().from(schema.accounts).orderBy(desc(schema.accounts.createdAt)).all();
  return (
    <main>
      <nav className="mb-6 flex gap-4 text-sm text-neutral-600">
        <Link href="/" className="font-medium">Accounts</Link>
        <Link href="/deliverables" className="hover:underline">Deliverables</Link>
      </nav>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <Link href="/accounts/new" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
          + New account
        </Link>
      </div>
      <ul className="mt-6 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
        {accounts.map((a) => (
          <li key={a.id} className="p-3">
            <Link href={`/accounts/${a.id}`} className="font-medium">{a.name}</Link>
            {a.domain && <span className="ml-2 text-sm text-neutral-500">{a.domain}</span>}
          </li>
        ))}
        {accounts.length === 0 && (
          <li className="p-3 text-sm text-neutral-500">No accounts yet.</li>
        )}
      </ul>
    </main>
  );
}
