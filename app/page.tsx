import Link from 'next/link';
import { db, schema } from '@/db';

export const dynamic = 'force-dynamic';

export default function Home() {
  const accounts = db.select().from(schema.accounts).all();
  return (
    <main>
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
