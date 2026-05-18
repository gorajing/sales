#!/usr/bin/env tsx
/**
 * Export an account's VERIFIED evidence to
 * `application/evidence-pack.json` — the backing pack the Phase 6
 * cover letter cites and reviewers inspect.
 *
 *   pnpm tsx scripts/dump-evidence.ts <accountId>
 *
 * Only `extractionStatus = 'verified'` rows are exported: a claim in
 * the cover letter may only rest on audited evidence (the same bar
 * `verify-application.ts` enforces on citations). Output lands in
 * gitignored `application/` — private by default.
 *
 * Exit codes: 2 = bad usage, 1 = unknown account / write failure,
 * 0 = wrote the pack. The 0-verified-rows case is deliberately exit 0
 * (a loud WARNING, not a failure): an account may legitimately have
 * no audited evidence yet — a research/audit gap, not a dump-evidence
 * fault. This script is NOT the gate. The hard stop is
 * `verify-application.ts`, which FAILS CLOSED if the cover letter
 * cites nothing or cites an id no `verified` row backs — so exiting 0
 * on an empty pack here cannot smuggle an unbacked claim downstream.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db';

function main(): number {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error('usage: tsx scripts/dump-evidence.ts <accountId>');
    return 2;
  }

  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  if (!account) {
    // Fail loud — do NOT write a pack for a nonexistent account
    // (that would produce an empty/garbage backing file the cover
    // letter then "cites").
    console.error(`[dump-evidence] account not found: ${accountId}`);
    return 1;
  }

  const evidence = db.select().from(schema.evidence).where(and(
    eq(schema.evidence.accountId, accountId),
    eq(schema.evidence.extractionStatus, 'verified'),
  )).all();

  const outDir = resolve(process.cwd(), 'application');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, 'evidence-pack.json'),
    JSON.stringify({ account, evidence }, null, 2) + '\n',
  );
  console.log(
    `[dump-evidence] wrote ${evidence.length} verified evidence row(s) ` +
    `for ${account.name} → application/evidence-pack.json`,
  );
  if (evidence.length === 0) {
    // Not a hard failure (an account legitimately may have no
    // verified evidence yet), but the cover letter cannot cite
    // anything — surface it so the operator runs research/audit
    // before packaging.
    console.error(
      '[dump-evidence] WARNING: 0 verified rows — run research + audit ' +
      'and verify evidence in the UI before writing the cover letter.',
    );
  }
  return 0;
}

process.exit(main());
