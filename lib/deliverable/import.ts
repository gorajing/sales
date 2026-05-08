import { eq, and, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { newId } from '../id';
import type { ParsedDeliverable } from '../claude/types';

export interface DeliverableImportResult {
  deliverableId: string;
  accountIds: string[];
}

function normalizeDomain(d: string | null | undefined): string | null {
  if (d === undefined || d === null) return null;
  const t = d.toLowerCase().trim();
  return t === '' ? null : t;
}

export async function importParsedDeliverable(
  parsed: ParsedDeliverable,
  rawMd: string,
): Promise<DeliverableImportResult> {
  // Wrap the entire import in a single SQLite transaction so a duplicate
  // domain or email mid-way through doesn't leave a half-written deliverable
  // pointing at orphan accounts.
  return db.transaction((tx): DeliverableImportResult => {
    const deliverableId = newId('deliverable');
    tx.insert(schema.deliverables).values({
      id: deliverableId,
      name: parsed.name,
      introMd: parsed.intro_md,
      outroMd: parsed.outro_md,
      rawMd,
    }).run();

    const accountIds: string[] = [];

    for (const parsedAccount of parsed.accounts) {
      // Resolve-or-create account by normalized domain. The case-insensitive
      // unique index would otherwise reject re-imports of the same company.
      const domain = normalizeDomain(parsedAccount.domain);
      let accountId: string;
      const existingAccount = domain
        ? tx.select().from(schema.accounts)
            .where(sql`lower(${schema.accounts.domain}) = ${domain}`)
            .get()
        : undefined;
      if (existingAccount) {
        accountId = existingAccount.id;
      } else {
        accountId = newId('account');
        tx.insert(schema.accounts).values({
          id: accountId,
          name: parsedAccount.name,
          domain: domain ?? undefined,
        }).run();
      }
      accountIds.push(accountId);

      // Resolve-or-skip contacts. Re-imports of the same deliverable can
      // include the same person again; we identify by (accountId, fullName)
      // since parsed contacts don't carry email.
      for (const c of parsedAccount.contacts) {
        const existingContact = tx.select().from(schema.contacts)
          .where(and(
            eq(schema.contacts.accountId, accountId),
            eq(schema.contacts.fullName, c.full_name),
          ))
          .get();
        if (existingContact) {
          continue;
        }
        const contactId = newId('contact');
        tx.insert(schema.contacts).values({
          id: contactId,
          accountId,
          fullName: c.full_name,
          title: c.title ?? undefined,
          archetype: c.archetype,
          notes: c.role !== 'primary' ? `Role: ${c.role}` : undefined,
        }).run();
      }

      // Create sequence (always new — each deliverable import is its own play)
      const sequenceId = newId('sequence');
      tx.insert(schema.sequences).values({
        id: sequenceId, accountId,
      }).run();

      // Create touches + imported revisions
      for (const t of parsedAccount.touches) {
        const touchId = newId('touch');
        tx.insert(schema.touches).values({
          id: touchId,
          sequenceId,
          position: t.position,
          channel: t.channel,
        }).run();

        const revisionId = newId('touchRevision');
        tx.insert(schema.touchRevisions).values({
          id: revisionId,
          touchId,
          revisionNumber: 1,
          subject: t.subject,
          body: t.body,
          citedEvidenceIds: [],
          supportingSpans: [],
          rationale: 'Imported from deliverable; claim audit not yet run.',
          createdBy: 'manual_edit',
        }).run();
        tx.update(schema.touches)
          .set({ currentRevisionId: revisionId })
          .where(eq(schema.touches.id, touchId)).run();
      }

      // Create deliverable_account row
      tx.insert(schema.deliverableAccounts).values({
        id: newId('deliverableAccount'),
        deliverableId,
        accountId,
        rank: parsedAccount.rank,
        whyNowMd: parsedAccount.why_now_md,
        dealShape: parsedAccount.deal_shape,
        routing: parsedAccount.routing,
        timeAsk: parsedAccount.time_ask,
        triggerSummary: parsedAccount.trigger_summary,
        sequenceId,
      }).run();
    }

    return { deliverableId, accountIds };
  });
}
