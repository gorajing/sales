import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ScoreRationale } from '@/components/ScoreRationale';
import { latestScoreForAccount } from '@/lib/inbound/queries';

export const dynamic = 'force-dynamic';

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();

  // Latest scoring for this account, if any. Returns undefined when no
  // recompute has run yet — we render the Score section only when we
  // have something to show, so first-time accounts don't display an
  // empty rationale panel.
  const latestScore = latestScoreForAccount(id);

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

      {latestScore && (
        <section className="mt-6 max-w-2xl">
          <h2 className="text-lg font-medium mb-2">Score</h2>
          <ScoreRationale
            items={latestScore.rationaleJson}
            score={latestScore.score}
            tier={latestScore.tier}
          />
        </section>
      )}
    </main>
  );
}
