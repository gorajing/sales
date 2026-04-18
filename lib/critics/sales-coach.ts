import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { loadPrinciples, loadStyle } from '../claude/prompts/draft-touch';
import { SALES_COACH_PROMPT } from '../claude/prompts/critics';
import { CriticResult } from '../claude/types';
import fs from 'node:fs';
import path from 'node:path';

type SpawnFn = typeof realSpawn;

const skillPath = path.resolve(process.cwd(), 'skills/critique-touch/SKILL.md');

export async function critiqueSalesCoach(
  body: string, subject: string | null, channel: 'email' | 'linkedin',
  spawn: SpawnFn = realSpawn,
) {
  const prompt = renderPrompt([
    { heading: 'Skill', body: fs.readFileSync(skillPath, 'utf8') },
    { heading: 'Persona', body: SALES_COACH_PROMPT },
    { heading: 'Style', body: loadStyle() },
    { heading: 'Principles', body: loadPrinciples() },
    { heading: 'Draft', body: JSON.stringify({ channel, subject, body }, null, 2) },
  ]);
  return spawn({ prompt, schema: CriticResult, model: 'sonnet' });
}
