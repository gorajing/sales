import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { EXTRACT_EVIDENCE_PROMPT } from '../claude/prompts/extract-evidence';
import { ExtractionResult } from '../claude/types';
import { db, schema } from '@/db';
import { newId } from '../id';

type SpawnFn = typeof realSpawn;

export interface PasteInput {
  accountId: string;
  contactId?: string;
  sourceUrl: string;
  rawText: string;
  capturedBy: 'manual' | 'claude_cli' | 'perplexity_mcp' | 'chatgpt_mcp'
    | 'deep_research_paste';
}

export async function extractFromPaste(
  input: PasteInput,
  spawn: SpawnFn = realSpawn,
): Promise<string[]> {
  const prompt = renderPrompt([
    { heading: 'Instructions', body: EXTRACT_EVIDENCE_PROMPT },
    { heading: 'Source URL', body: input.sourceUrl },
    { heading: 'Source text', body: input.rawText },
  ]);
  const result = await spawn({
    prompt, schema: ExtractionResult, model: 'haiku',
  });

  const ids: string[] = [];
  for (const item of result.evidence) {
    if (!input.rawText.toLowerCase().includes(item.snippet.toLowerCase())) {
      // Drop any snippet that isn't a literal substring of the provided text
      continue;
    }
    const id = newId('evidence');
    db.insert(schema.evidence).values({
      id,
      accountId: input.accountId,
      contactId: input.contactId,
      sourceUrl: item.source_url,
      sourceType: item.source_type,
      snippet: item.snippet,
      extractedFact: item.extracted_fact,
      confidence: item.confidence,
      capturedBy: input.capturedBy,
      extractionStatus: 'pending_audit',
    }).run();
    ids.push(id);
  }
  return ids;
}
