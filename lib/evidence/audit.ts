import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { AUDIT_PROMPT } from '../claude/prompts/audit-extraction';
import { ExtractionAuditResult } from '../claude/types';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { newId } from '../id';

type SpawnFn = typeof realSpawn;

export async function auditOne(
  evidenceId: string,
  spawn: SpawnFn = realSpawn,
): Promise<'verified' | 'disputed'> {
  const row = db.select().from(schema.evidence)
    .where(eq(schema.evidence.id, evidenceId)).get();
  if (!row) throw new Error('evidence not found');

  const prompt = renderPrompt([
    { heading: 'Instructions', body: AUDIT_PROMPT },
    { heading: 'Input', body: JSON.stringify({
        evidence_id: row.id, snippet: row.snippet, extracted_fact: row.extractedFact,
      }, null, 2),
    },
  ]);
  const result = await spawn({
    prompt, schema: ExtractionAuditResult, model: 'haiku',
  });

  db.insert(schema.extractionAudits).values({
    id: newId('extractionAudit'),
    evidenceId: row.id,
    verdict: result.verdict,
    reason: result.reason,
    suggestedCorrection: result.suggested_correction,
  }).run();

  db.update(schema.evidence)
    .set({ extractionStatus: result.verdict })
    .where(eq(schema.evidence.id, row.id)).run();

  return result.verdict;
}

export async function auditPendingForAccount(
  accountId: string,
  spawn: SpawnFn = realSpawn,
): Promise<{ verified: number; disputed: number }> {
  const pending = db.select().from(schema.evidence)
    .where(and(
      eq(schema.evidence.accountId, accountId),
      eq(schema.evidence.extractionStatus, 'pending_audit'),
    )).all();

  let verified = 0, disputed = 0;
  for (const row of pending) {
    const verdict = await auditOne(row.id, spawn);
    if (verdict === 'verified') verified++; else disputed++;
  }
  return { verified, disputed };
}
