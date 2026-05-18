import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import {
  loadDraftTouchSkill, loadPrinciples, loadIcp, loadPrincipleOutcomes,
} from '../claude/prompts/draft-touch';
import { DraftTouch } from '../claude/types';
import { validateDraft } from '../evidence/validate';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { newId } from '../id';

type SpawnFn = typeof realSpawn;

export interface DraftArgs {
  touchId: string;
  contactId?: string;
}

export async function draftTouch(
  args: DraftArgs,
  spawn: SpawnFn = realSpawn,
): Promise<{ revisionId: string; issues: string[] }> {
  const touch = db.select().from(schema.touches).where(eq(schema.touches.id, args.touchId)).get();
  if (!touch) throw new Error('touch not found');
  const sequence = db.select().from(schema.sequences).where(eq(schema.sequences.id, touch.sequenceId)).get();
  if (!sequence) throw new Error('sequence not found');

  const evidenceRows = db.select().from(schema.evidence)
    .where(and(
      eq(schema.evidence.accountId, sequence.accountId),
      eq(schema.evidence.extractionStatus, 'verified'),
    )).all();

  const priorTouches = db.select().from(schema.touches)
    .where(eq(schema.touches.sequenceId, touch.sequenceId)).all()
    .filter((t) => t.position < touch.position)
    .sort((a, b) => a.position - b.position);

  const priorRevisionsMaybeNull = priorTouches.map((t) =>
    t.currentRevisionId
      ? db.select().from(schema.touchRevisions)
          .where(eq(schema.touchRevisions.id, t.currentRevisionId)).get()
      : null,
  );
  const priorRevisions = priorRevisionsMaybeNull.filter(
    (r): r is NonNullable<typeof r> => r !== null,
  );

  const evidencePack = evidenceRows.map((e) => ({
    id: e.id, source_url: e.sourceUrl, source_type: e.sourceType,
    snippet: e.snippet, extracted_fact: e.extractedFact,
  }));

  const allTouchesInSequence = db.select().from(schema.touches)
    .where(eq(schema.touches.sequenceId, touch.sequenceId)).all();
  const totalTouches = allTouchesInSequence.length;

  async function runDrafter(extraCorrection?: string): Promise<DraftTouch> {
    const prompt = renderPrompt([
      { heading: 'Skill', body: loadDraftTouchSkill() },
      { heading: 'ICP brief', body: loadIcp() },
      { heading: 'Principles', body: loadPrinciples() },
      // ADVISORY only — descriptive correlation, not causal, not a
      // score input, never auto-applied. The file's preamble repeats
      // this; the heading reinforces it so the model treats it as
      // context, not instruction (Phase 4.4).
      { heading: 'Principle outcomes (advisory)', body: loadPrincipleOutcomes() },
      { heading: 'Account evidence pack', body: JSON.stringify(evidencePack, null, 2) },
      { heading: 'Position', body: `Touch ${touch!.position} of ${totalTouches}. Channel: ${touch!.channel}.` },
      { heading: 'Prior touches', body: JSON.stringify(priorRevisions.map((r) => ({
          subject: r.subject, body: r.body,
        })), null, 2),
      },
      ...(extraCorrection ? [{ heading: 'Correction', body: extraCorrection }] : []),
    ]);
    return spawn({ prompt, schema: DraftTouch, model: 'sonnet', timeoutMs: 180_000 });
  }

  let draft = await runDrafter();
  let issues = validateDraft(draft, evidenceRows.map((e) => ({ id: e.id, snippet: e.snippet })));

  if (issues.length > 0) {
    const correction = `Your prior draft had these issues:\n` +
      issues.map((i) => `- ${i.kind}: ${i.detail}`).join('\n') +
      `\n\nRewrite the draft so that every span is a verbatim substring of its cited evidence snippet.`;
    draft = await runDrafter(correction);
    issues = validateDraft(draft, evidenceRows.map((e) => ({ id: e.id, snippet: e.snippet })));
  }

  // Persist regardless — surface issues to user if they remain.
  const revisionId = newId('touchRevision');
  const existingRevisions = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.touchId, args.touchId)).all();
  const revisionNumber = existingRevisions.length + 1;

  db.insert(schema.touchRevisions).values({
    id: revisionId,
    touchId: args.touchId,
    revisionNumber,
    subject: draft.subject,
    body: draft.body,
    citedEvidenceIds: draft.cited_evidence_ids,
    supportingSpans: draft.supporting_spans,
    rationale: draft.rationale,
    createdBy: 'drafter',
  }).run();
  db.update(schema.touches).set({ currentRevisionId: revisionId })
    .where(eq(schema.touches.id, args.touchId)).run();

  return { revisionId, issues: issues.map((i) => `${i.kind}: ${i.detail}`) };
}
