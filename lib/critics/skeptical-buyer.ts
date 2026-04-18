import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { SKEPTICAL_BUYER_PROMPT } from '../claude/prompts/critics';
import { loadStyle } from '../claude/prompts/draft-touch';
import { CriticResult } from '../claude/types';
import fs from 'node:fs';
import path from 'node:path';

type SpawnFn = typeof realSpawn;

const skillPath = path.resolve(process.cwd(), 'skills/critique-touch/SKILL.md');

export async function critiqueSkepticalBuyer(
  body: string,
  subject: string | null,
  channel: 'email' | 'linkedin',
  spawn: SpawnFn = realSpawn,
) {
  const prompt = renderPrompt([
    { heading: 'Skill', body: fs.readFileSync(skillPath, 'utf8') },
    { heading: 'Persona', body: SKEPTICAL_BUYER_PROMPT },
    { heading: 'Style', body: loadStyle() },
    { heading: 'Draft', body: JSON.stringify({ channel, subject, body }, null, 2) },
  ]);
  return spawn({ prompt, schema: CriticResult, model: 'sonnet' });
}
