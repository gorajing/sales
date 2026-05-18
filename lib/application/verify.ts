/**
 * Phase 6 application-package pre-submit gate.
 *
 * Pure logic (no fs/db) so it is fully unit-testable;
 * `scripts/verify-application.ts` is the thin IO shell that reads
 * `application/` and calls `verifyApplication`.
 *
 * # Why this exists
 *
 * Phase 6 produces a real job-application package. The contract:
 * "every factual claim about the target cites verified evidence"
 * and "generated prose is fact-checked against evidence before
 * use". This module turns those from a HOPE into a gate that FAILS
 * CLOSED: the human still writes and approves the cover letter, but
 * the system refuses to bless a letter that cites an evidence id it
 * cannot back with a `verified` row. Same epistemic-honesty
 * discipline as the Phase 4 sample-size guardrail — a permissive
 * verifier would be worse than none, laundering an unbacked claim
 * with a green check.
 *
 * # Precise guarantee (do not overstate it)
 *
 * This gate proves a NARROW thing: every evidence id the cover
 * letter CITES exists and is `verified`, the package is structurally
 * complete, and the letter is in the length band and cites ≥1 piece
 * of evidence. It CANNOT prove that every factual sentence about the
 * target company carries a citation — detecting "this sentence is an
 * unbacked factual claim" is not mechanically decidable and is, per
 * the Phase 6 contract, a HUMAN-owned review step. Saying this gate
 * guarantees "no unbacked claim ships" would itself be the overclaim
 * the whole approach guards against. PASS therefore means
 * "mechanical floor cleared", explicitly NOT "every claim is
 * backed" — the human still must read the letter and confirm each
 * factual claim carries one of the cited, verified ids.
 *
 * It does NOT judge prose quality, persuasiveness, or whether the
 * letter SHOULD be sent — that is the human's call ("do not let the
 * system outrank your judgment").
 */

import { idRegExp } from '../id';

/** Files the package must always contain. The touch/outreach
 *  artifact filenames vary with the sequence's channel mix, so they
 *  are checked separately ("at least one outreach artifact") rather
 *  than hardcoded here — see `verifyApplication`. */
export const REQUIRED_FILES = [
  'cover-letter.md',
  'evidence-pack.json',
  'architecture-essay.md',
  'critique-findings.json',
  'loom.md',
] as const;

// Plan Step 6.3.3 targets ~600 words; Step 6.3.6 bounds it 500–800.
export const COVER_LETTER_MIN_WORDS = 500;
export const COVER_LETTER_MAX_WORDS = 800;

export interface EvidencePack {
  account?: unknown;
  /** `unknown[]` on PURPOSE: the pack is external JSON and the IO
   *  shell only array-checks `evidence`, never each element. Row
   *  shape is validated inside `verifyApplication`, which reports a
   *  malformed row as a problem rather than throwing on it (the
   *  module's contract is "report every problem in one pass"). */
  evidence: unknown[];
}

export interface VerifyInput {
  coverLetter: string;
  pack: EvidencePack;
  /** Base filenames present in `application/` (not full paths). */
  presentFiles: string[];
}

export interface VerifyResult {
  ok: boolean;
  /** Every distinct evidence id the cover letter cites, in order. */
  citedIds: string[];
  /** All problems found, reported together so the operator fixes in
   *  one pass instead of whack-a-mole. Empty iff `ok`. */
  problems: string[];
}

/**
 * Distinct evidence ids cited in the cover letter, first-seen order.
 *
 * The id pattern is single-sourced from `newId`'s construction via
 * `idRegExp('evidence', …)` — deliberately NOT re-declared here. A
 * local copy that drifted from `newId` (suffix length/charset, date
 * width) would make this silently miss a real id — i.e. an uncaught
 * unbacked citation, the exact failure this gate exists to prevent.
 * A unit test round-trips `newId('evidence')` through this so any
 * drift fails loud. A fresh regex is built per call because the `g`
 * flag carries mutable `lastIndex` state.
 */
export function extractCitedEvidenceIds(coverLetter: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of coverLetter.matchAll(idRegExp('evidence', 'g'))) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

function wordCount(s: string): number {
  const t = s.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

const OUTREACH_ARTIFACT_RE = /\.eml$|-linkedin\.txt$/;

export function verifyApplication(input: VerifyInput): VerifyResult {
  const problems: string[] = [];
  const citedIds = extractCitedEvidenceIds(input.coverLetter);

  // 1. Structural completeness — required files.
  for (const f of REQUIRED_FILES) {
    if (!input.presentFiles.includes(f)) {
      problems.push(`required file missing: ${f}`);
    }
  }
  // ...and at least one outreach artifact (channel mix varies, so
  // we don't hardcode touch-1.eml / touch-2-linkedin.txt names).
  if (!input.presentFiles.some((f) => OUTREACH_ARTIFACT_RE.test(f))) {
    problems.push(
      'no outreach artifact present (expected at least one *.eml or *-linkedin.txt)',
    );
  }

  // 2. Citation backing — the load-bearing gate. Every cited id must
  // exist in the pack AND be `verified`. A cited-but-unbacked or
  // cited-but-unverified claim fails the package.
  //
  // Defensive: `pack.evidence` is `unknown[]` — at runtime it is
  // JSON.parse'd external input and the IO shell only checks it is an
  // array, never each element's shape. A malformed row (null,
  // missing/non-string `id` or `extractionStatus`) must not throw: an
  // uncaught crash would fail closed but on the FIRST bad row, hiding
  // every other problem and breaking this module's "report all
  // problems in one pass" contract. So we skip+count malformed rows
  // and surface them as one more problem.
  const byId = new Map<string, string>();
  let malformedRows = 0;
  for (const e of input.pack.evidence) {
    if (
      e === null
      || typeof e !== 'object'
      || typeof (e as { id?: unknown }).id !== 'string'
      || typeof (e as { extractionStatus?: unknown }).extractionStatus !== 'string'
    ) {
      malformedRows++;
      continue;
    }
    byId.set(
      (e as { id: string }).id,
      (e as { extractionStatus: string }).extractionStatus,
    );
  }
  if (malformedRows > 0) {
    problems.push(
      `evidence-pack.json has ${malformedRows} malformed evidence row(s) ` +
      `(each must be an object with string \`id\` and \`extractionStatus\`) ` +
      `— a malformed row can back no citation; regenerate the pack with ` +
      `scripts/dump-evidence.ts`,
    );
  }
  if (citedIds.length === 0) {
    problems.push(
      'cover letter cites NO evidence ids — the "every claim traces to ' +
      'verified evidence" proof claim is itself unbacked',
    );
  }
  for (const id of citedIds) {
    const status = byId.get(id);
    if (status === undefined) {
      problems.push(
        `cover letter cites ${id} but it is NOT in evidence-pack.json ` +
        `(missing/absent — no backing)`,
      );
    } else if (status !== 'verified') {
      problems.push(
        `cover letter cites ${id} but it is NOT verified ` +
        `(extractionStatus="${status}" — unverified/pending/disputed claims ` +
        `may not back a submitted letter)`,
      );
    }
  }

  // 3. Length bounds.
  const wc = wordCount(input.coverLetter);
  if (wc < COVER_LETTER_MIN_WORDS) {
    problems.push(
      `cover letter word count ${wc} is too short ` +
      `(< ${COVER_LETTER_MIN_WORDS})`,
    );
  } else if (wc > COVER_LETTER_MAX_WORDS) {
    problems.push(
      `cover letter word count ${wc} is too long ` +
      `(> ${COVER_LETTER_MAX_WORDS})`,
    );
  }

  return { ok: problems.length === 0, citedIds, problems };
}
