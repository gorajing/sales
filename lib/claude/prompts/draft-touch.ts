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

export function loadStyle(): string {
  const p = path.resolve(process.cwd(), 'data/style.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(No style rules defined.)';
}

/**
 * Phase 4.4 — ADVISORY principle-outcome correlations for the
 * drafter. Written nightly by `scripts/nightly-digest.ts`; absent
 * until the first digest run, so the missing-file fallback is the
 * normal early state, not an error. The file's own preamble carries
 * the load-bearing disclaimer (descriptive, not causal, not a score
 * input, never auto-applied); the drafter consumes it as context,
 * NOT as instruction.
 */
export function loadPrincipleOutcomes(): string {
  const p = path.resolve(process.cwd(), 'data/principle-outcomes.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(No outcome data yet.)';
}
