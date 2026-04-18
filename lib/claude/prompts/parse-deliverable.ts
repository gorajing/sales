import fs from 'node:fs';
import path from 'node:path';

export function loadParseDeliverableSkill(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), 'skills/parse-deliverable/SKILL.md'),
    'utf8',
  );
}
