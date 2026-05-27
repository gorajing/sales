import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();
  const handoffs = db.select().from(schema.gtmHandoffImports)
    .where(eq(schema.gtmHandoffImports.accountId, id)).all();
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
      {handoffs.length > 0 && (
        <section className="mt-6 border-t border-neutral-200 pt-4">
          <h2 className="text-sm font-semibold uppercase text-neutral-500">
            GTM handoff seed
          </h2>
          <ul className="mt-3 space-y-3">
            {handoffs.map((handoff) => (
              <li key={handoff.routerDealId} className="rounded border border-neutral-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{handoff.routerDealId}</span>
                  <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">
                    {handoff.routeKind}
                  </span>
                  <span className="text-neutral-500">
                    ${handoff.amountUsd.toLocaleString()} · {handoff.sourceChannel}
                    {handoff.salesOwner ? ` · ${handoff.salesOwner}` : ''}
                  </span>
                </div>
                <p className="mt-2 text-sm text-neutral-700">{handoff.researchBrief}</p>
                <ul className="mt-2 list-disc pl-5 text-sm text-neutral-600">
                  {handoff.suggestedEvidenceQuestionsJson.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
