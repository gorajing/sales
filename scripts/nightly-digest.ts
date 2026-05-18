#!/usr/bin/env tsx
/**
 * Nightly: recompute per-principle outcome correlations and write the
 * ADVISORY digest to data/principle-outcomes.md (the drafter reads it
 * as context — Phase 4.4). Run from cron / launchd:
 *
 *   pnpm tsx scripts/nightly-digest.ts
 *
 * Thin wrapper: ALL logic (the sample-size guardrail, the
 * descriptive-not-causal framing, the no-write-to-scoring invariant)
 * lives in lib/engagement/attribute.ts. This script only orchestrates
 * read → render → write and reports honestly.
 *
 * Exit code: 0 on success; non-zero on failure, so a cron/launchd
 * wrapper surfaces a broken digest instead of silently serving a
 * stale (or empty) principle-outcomes.md to the drafter.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computePrincipleOutcomes,
  renderOutcomesMarkdown,
} from '../lib/engagement/attribute';

async function main(): Promise<number> {
  const outcomes = await computePrincipleOutcomes();
  if (outcomes.length === 0) {
    // No principles parsed from data/principles.md → nothing to
    // attribute. Don't overwrite a previously-good digest with an
    // empty table; fail loud so the operator notices the misconfig.
    console.error(
      '[nightly-digest] no principles found (data/principles.md missing/empty); ' +
      'NOT overwriting data/principle-outcomes.md.',
    );
    return 1;
  }
  const md = renderOutcomesMarkdown(outcomes);
  const out = resolve(process.cwd(), 'data/principle-outcomes.md');
  writeFileSync(out, md + '\n');
  const sufficient = outcomes.filter((o) => o.sufficient).length;
  console.log(
    `[nightly-digest] wrote ${outcomes.length} principle rows to ${out} ` +
    `(${sufficient} with sufficient sample, ${outcomes.length - sufficient} ` +
    `shown as insufficient data)`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[nightly-digest] fatal:', err);
    process.exit(2);
  },
);
