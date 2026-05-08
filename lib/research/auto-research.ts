import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { loadResearchAccountSkill } from '../claude/prompts/research-account';
import { ExtractionResult } from '../claude/types';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '../id';

type SpawnFn = typeof realSpawn;

export async function autoResearchAccount(
  accountId: string,
  spawn: SpawnFn = realSpawn,
): Promise<string[]> {
  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  if (!account) throw new Error('account not found');

  const prompt = renderPrompt([
    { heading: 'Skill', body: loadResearchAccountSkill() },
    { heading: 'Account', body: JSON.stringify({
        name: account.name, domain: account.domain,
      }, null, 2),
    },
  ]);

  const result = await spawn({
    prompt, schema: ExtractionResult, model: 'sonnet', timeoutMs: 300_000,
    allowedTools: ['WebFetch', 'WebSearch'],
  });

  const ids: string[] = [];
  const capturedAt = new Date().toISOString();  // ISO 8601 with ms — matches v2 timestamp invariant
  for (const item of result.evidence) {
    // Cannot substring-verify here since we don't have the full source text;
    // Extraction Audit critic handles that on a per-row basis.
    const id = newId('evidence');
    db.insert(schema.evidence).values({
      id, accountId,
      sourceUrl: item.source_url,
      sourceType: item.source_type,
      snippet: item.snippet.slice(0, 1500),
      extractedFact: item.extracted_fact,
      confidence: item.confidence,
      capturedBy: 'claude_cli',
      capturedAt,
      extractionStatus: 'pending_audit',
    }).run();
    ids.push(id);
  }
  return ids;
}
