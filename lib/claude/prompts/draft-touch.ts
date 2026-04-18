import fs from 'node:fs';
import path from 'node:path';

export function loadDraftTouchSkill(): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'skills/draft-touch/SKILL.md'), 'utf8');
}

export function loadPrinciples(): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'data/principles.md'), 'utf8');
}

export function loadIcp(): string {
  const p = path.resolve(process.cwd(), 'data/icp.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(No ICP brief yet.)';
}
