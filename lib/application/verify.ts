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
 * It does NOT judge prose quality, persuasiveness, or whether the
 * letter SHOULD be sent — that is the human's call ("do not let the
 * system outrank your judgment"). It only enforces the mechanical,
 * objective floor: structural completeness + citation backing +
 * length bounds.
 */

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

// The EXACT `newId('evidence')` shape: `ev_YYYYMMDD_<10 lowercase
// hex>`. Anchored on word boundaries so prose ("evidence", "ev_",
// "ev_2026") cannot false-match — a loose pattern would let an
// unbacked claim slip through, the exact failure this gate prevents.
const EVIDENCE_ID_RE = /\bev_\d{8}_[0-9a-f]{10}\b/g;

export interface EvidencePack {
  account?: unknown;
  evidence: Array<{ id: string; extractionStatus: string }>;
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

/** Distinct evidence ids cited in the cover letter, first-seen order. */
export function extractCitedEvidenceIds(coverLetter: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of coverLetter.matchAll(EVIDENCE_ID_RE)) {
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
  const byId = new Map(input.pack.evidence.map((e) => [e.id, e.extractionStatus]));
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
