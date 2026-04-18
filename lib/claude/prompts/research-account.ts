import fs from 'node:fs';
import path from 'node:path';

export function loadResearchAccountSkill(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), 'skills/research-account/SKILL.md'),
    'utf8',
  );
}
