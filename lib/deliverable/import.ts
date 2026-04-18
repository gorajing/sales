import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { newId } from '../id';
import type { ParsedDeliverable } from '../claude/types';

export interface DeliverableImportResult {
  deliverableId: string;
  accountIds: string[];
}

export async function importParsedDeliverable(
  parsed: ParsedDeliverable,
  rawMd: string,
): Promise<DeliverableImportResult> {
  const deliverableId = newId('deliverable');
  db.insert(schema.deliverables).values({
    id: deliverableId,
    name: parsed.name,
    introMd: parsed.intro_md,
    outroMd: parsed.outro_md,
    rawMd,
  }).run();

  const accountIds: string[] = [];

  for (const parsedAccount of parsed.accounts) {
    // Create account
    const accountId = newId('account');
    db.insert(schema.accounts).values({
      id: accountId,
      name: parsedAccount.name,
      domain: parsedAccount.domain ?? undefined,
    }).run();
    accountIds.push(accountId);

    // Create contacts
    for (const c of parsedAccount.contacts) {
      const contactId = newId('contact');
      db.insert(schema.contacts).values({
        id: contactId,
        accountId,
        fullName: c.full_name,
        title: c.title ?? undefined,
        archetype: c.archetype,
        notes: c.role !== 'primary' ? `Role: ${c.role}` : undefined,
      }).run();
    }

    // Create sequence
    const sequenceId = newId('sequence');
    db.insert(schema.sequences).values({
      id: sequenceId, accountId,
    }).run();

    // Create touches + imported revisions
    for (const t of parsedAccount.touches) {
      const touchId = newId('touch');
      db.insert(schema.touches).values({
        id: touchId,
        sequenceId,
        position: t.position,
        channel: t.channel,
      }).run();

      const revisionId = newId('touchRevision');
      db.insert(schema.touchRevisions).values({
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
      db.update(schema.touches)
        .set({ currentRevisionId: revisionId })
        .where(eq(schema.touches.id, touchId)).run();
    }

    // Create deliverable_account row
    db.insert(schema.deliverableAccounts).values({
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
}
