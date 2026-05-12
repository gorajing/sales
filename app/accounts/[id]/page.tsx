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
  // recompute has run yet — the Score section renders conditionally so
  // first-time accounts don't show an empty rationale panel.
  const latestScore = latestScoreForAccount(id);

  // When the account was auto-created from a signal, ingest sets
  // `name = domain` as a placeholder until the operator renames it
  // (lib/signals/ingest.ts). Suppressing the duplicate subtitle keeps the
  // header from showing "acme.com" twice — once as the title and once as
  // the subtitle. The compare is case-insensitive + trimmed so manual
  // renames like "Acme.com" (capitalized) over a normalized lowercase
  // domain still match.
  const normalize = (s: string) => s.trim().toLowerCase();
  const showDomainSubtitle =
    account.domain != null
    && account.domain !== ''
    && normalize(account.domain) !== normalize(account.name);

  return (
    <main>
      <Link href="/" className="text-sm text-neutral-500">← Accounts</Link>
      <h1 className="mt-2 text-2xl font-semibold">{account.name}</h1>
      {showDomainSubtitle && (
        <p className="text-sm text-neutral-500">{account.domain}</p>
      )}

      {/* Score panel ABOVE the sub-nav. Operators arriving from /inbound
          clicked the account because of the score — show them why first,
          before the deeper Evidence/Contacts/Sequences tabs. */}
      {latestScore && (
        <section className="mt-4 max-w-2xl">
          <ScoreRationale
            items={latestScore.rationaleJson}
            score={latestScore.score}
            tier={latestScore.tier}
            accountId={id}
          />
        </section>
      )}

      <nav className="mt-6 flex gap-3 text-sm">
        <Link href={`/accounts/${id}/evidence`} className="underline">Evidence</Link>
        <Link href={`/accounts/${id}/contacts`} className="underline">Contacts</Link>
        <Link href={`/accounts/${id}/sequences`} className="underline">Sequences</Link>
      </nav>
    </main>
  );
}
