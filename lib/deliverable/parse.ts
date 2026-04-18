import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { loadParseDeliverableSkill } from '../claude/prompts/parse-deliverable';
import { ParsedDeliverable } from '../claude/types';

type SpawnFn = typeof realSpawn;

export async function parseDeliverableMarkdown(
  markdown: string,
  spawn: SpawnFn = realSpawn,
): Promise<ParsedDeliverable> {
  const prompt = renderPrompt([
    { heading: 'Skill', body: loadParseDeliverableSkill() },
    { heading: 'Document', body: markdown },
  ]);
  return spawn({
    prompt, schema: ParsedDeliverable, model: 'sonnet',
    timeoutMs: 300_000,  // large docs may take time
  });
}
