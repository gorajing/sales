#!/usr/bin/env tsx
/**
 * Phase 6 PRE-SUBMIT GATE. Run before packaging/submitting:
 *
 *   pnpm tsx scripts/verify-application.ts
 *
 * Reads the gitignored `application/` directory and enforces the
 * mechanical floor (structural completeness + every cover-letter
 * evidence citation backed by a `verified` row + length bounds) via
 * the pure `lib/application/verify.ts`. It does NOT judge prose
 * quality or whether to submit — that is the human's call. It only
 * makes "no unbacked claim ships" FAIL CLOSED.
 *
 * Exit: 0 iff the package passes every check; 1 otherwise (with all
 * problems listed). Intended to gate the final
 * `typecheck && test && build && verify-application` step.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyApplication, type EvidencePack } from '../lib/application/verify';

function main(): number {
  const dir = resolve(process.cwd(), 'application');

  let presentFiles: string[];
  try {
    presentFiles = readdirSync(dir);
  } catch {
    console.error(
      `[verify-application] application/ does not exist or is unreadable. ` +
      `Build the package first (see the Phase 6 runbook).`,
    );
    return 1;
  }

  const problems: string[] = [];

  let coverLetter = '';
  try {
    coverLetter = readFileSync(resolve(dir, 'cover-letter.md'), 'utf8');
  } catch {
    // Reported by the completeness check too; note it explicitly so
    // a missing cover letter isn't a silent empty-string pass.
    problems.push('cover-letter.md is missing or unreadable');
  }

  let pack: EvidencePack = { evidence: [] };
  try {
    const raw = readFileSync(resolve(dir, 'evidence-pack.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed && typeof parsed === 'object'
      && Array.isArray((parsed as { evidence?: unknown }).evidence)
    ) {
      pack = parsed as EvidencePack;
    } else {
      problems.push('evidence-pack.json is not an object with an `evidence` array');
    }
  } catch {
    problems.push('evidence-pack.json is missing or not valid JSON');
  }

  const result = verifyApplication({ coverLetter, pack, presentFiles });
  const all = [...problems, ...result.problems];

  if (all.length === 0) {
    console.log(
      `[verify-application] PASS — package complete; ` +
      `${result.citedIds.length} evidence citation(s), all verified.`,
    );
    return 0;
  }
  console.error('[verify-application] FAIL — pre-submit gate blocked:');
  for (const p of all) console.error(`  - ${p}`);
  console.error(
    `\nFix every item above, then re-run. This gate only enforces the ` +
    `mechanical floor — passing it is necessary, not sufficient; the ` +
    `prose and the decision to submit remain yours.`,
  );
  return 1;
}

process.exit(main());
