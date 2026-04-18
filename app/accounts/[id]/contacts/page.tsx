import { db, schema } from '@/db';
import { eq, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function ContactsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();
  const contacts = db.select().from(schema.contacts)
    .where(eq(schema.contacts.accountId, id))
    .orderBy(desc(schema.contacts.createdAt)).all();
  return (
    <main>
      <Link href={`/accounts/${id}`} className="text-sm text-neutral-500">← {account.name}</Link>
      <div className="mt-2 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Contacts</h1>
        <Link href={`/accounts/${id}/contacts/new`}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
          + New contact
        </Link>
      </div>
      <ul className="mt-4 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
        {contacts.map((c) => (
          <li key={c.id} className="p-3">
            <div className="font-medium">{c.fullName}</div>
            <div className="text-sm text-neutral-500">
              {c.title ?? '—'} · <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs">{c.archetype}</span>
            </div>
          </li>
        ))}
        {contacts.length === 0 && (
          <li className="p-3 text-sm text-neutral-500 italic">No contacts yet.</li>
        )}
      </ul>
    </main>
  );
}
