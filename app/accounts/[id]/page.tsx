import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();
  return (
    <main>
      <Link href="/" className="text-sm text-neutral-500">← Accounts</Link>
      <h1 className="mt-2 text-2xl font-semibold">{account.name}</h1>
      {account.domain && <p className="text-sm text-neutral-500">{account.domain}</p>}
      <nav className="mt-4 flex gap-3 text-sm">
        <Link href={`/accounts/${id}/evidence`} className="underline">Evidence</Link>
        <Link href={`/accounts/${id}/contacts`} className="underline">Contacts</Link>
        <Link href={`/accounts/${id}/sequences`} className="underline">Sequences</Link>
      </nav>
    </main>
  );
}
