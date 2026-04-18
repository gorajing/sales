import fs from 'node:fs';
import path from 'node:path';

export function loadClaimAuditSkill(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), 'skills/claim-audit/SKILL.md'),
    'utf8',
  );
}
