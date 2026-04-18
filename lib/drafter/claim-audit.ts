import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { loadClaimAuditSkill } from '../claude/prompts/claim-audit';
import { ClaimAuditResult } from '../claude/types';
import { validateDraft } from '../evidence/validate';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { newId } from '../id';

type SpawnFn = typeof realSpawn;

export interface ClaimAuditOutcome {
  revisionId: string;
  supportingSpans: Array<{ evidence_id: string; span: string; claim: string }>;
  citedEvidenceIds: string[];
  unsupportedClaims: Array<{ sentence: string; reason: string }>;
  validationIssues: string[];
}

export async function auditClaims(
  touchId: string,
  spawn: SpawnFn = realSpawn,
): Promise<ClaimAuditOutcome> {
  const touch = db.select().from(schema.touches).where(eq(schema.touches.id, touchId)).get();
  if (!touch) throw new Error('touch not found');
  if (!touch.currentRevisionId) throw new Error('touch has no current revision — import a draft first');
  const rev = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.id, touch.currentRevisionId)).get();
  if (!rev) throw new Error('current revision missing');
  const sequence = db.select().from(schema.sequences)
    .where(eq(schema.sequences.id, touch.sequenceId)).get();
  if (!sequence) throw new Error('sequence not found');

  const evidenceRows = db.select().from(schema.evidence)
    .where(and(
      eq(schema.evidence.accountId, sequence.accountId),
      eq(schema.evidence.extractionStatus, 'verified'),
    )).all();

  const evidencePack = evidenceRows.map((e) => ({
    id: e.id, source_url: e.sourceUrl, source_type: e.sourceType,
    snippet: e.snippet, extracted_fact: e.extractedFact,
  }));

  const prompt = renderPrompt([
    { heading: 'Skill', body: loadClaimAuditSkill() },
    { heading: 'Evidence pack', body: JSON.stringify(evidencePack, null, 2) },
    { heading: 'Draft', body: JSON.stringify({
        subject: rev.subject, body: rev.body, channel: touch.channel,
      }, null, 2),
    },
  ]);

  const result = await spawn({ prompt, schema: ClaimAuditResult, model: 'haiku' });

  // Validate the spans against evidence (substring check)
  const pseudoDraft = {
    subject: rev.subject, body: rev.body, channel: touch.channel as 'email' | 'linkedin',
    cited_evidence_ids: Array.from(new Set(result.supporting_spans.map((s) => s.evidence_id))),
    supporting_spans: result.supporting_spans,
    rationale: '',
  };
  const issues = validateDraft(pseudoDraft, evidenceRows.map((e) => ({ id: e.id, snippet: e.snippet })));

  // Filter to only VALID spans
  const validSpans = result.supporting_spans.filter((s) =>
    !issues.some((i) =>
      (i.kind === 'unknown_evidence_id' && i.detail === s.evidence_id) ||
      (i.kind === 'span_not_in_snippet' && i.detail.includes(s.evidence_id))
    )
  );
  const citedIds = Array.from(new Set(validSpans.map((s) => s.evidence_id)));

  // Create a new revision preserving the body, updating spans + cited ids
  const newRevisionId = newId('touchRevision');
  const existing = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.touchId, touchId)).all();

  db.insert(schema.touchRevisions).values({
    id: newRevisionId,
    touchId,
    revisionNumber: existing.length + 1,
    subject: rev.subject,
    body: rev.body,
    citedEvidenceIds: citedIds,
    supportingSpans: validSpans,
    rationale: `Claim audit: ${validSpans.length} supported, ${result.unsupported_claims.length} unsupported.`,
    createdBy: 'manual_edit',
  }).run();
  db.update(schema.touches).set({ currentRevisionId: newRevisionId })
    .where(eq(schema.touches.id, touchId)).run();

  return {
    revisionId: newRevisionId,
    supportingSpans: validSpans,
    citedEvidenceIds: citedIds,
    unsupportedClaims: result.unsupported_claims,
    validationIssues: issues.map((i) => `${i.kind}: ${i.detail}`),
  };
}
