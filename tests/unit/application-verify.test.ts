import { describe, it, expect } from 'vitest';
import {
  extractCitedEvidenceIds,
  verifyApplication,
  REQUIRED_FILES,
  COVER_LETTER_MIN_WORDS,
  COVER_LETTER_MAX_WORDS,
} from '../../lib/application/verify';
import { newId } from '../../lib/id';

/**
 * The Phase 6 pre-submit gate. Its whole purpose is to make
 * "every factual claim cites verified evidence" and "fact-check
 * generated prose before use" FAIL CLOSED — the human writes/approves
 * the prose, but the system cannot ship a cover letter that cites an
 * evidence id it can't back. These tests pin that the gate actually
 * rejects the unbacked cases (a permissive verifier is worse than
 * none — it would launder weak claims with a green check).
 */

const VERIFIED = 'ev_20260418_0110a19b93';
const VERIFIED_2 = 'ev_20260418_0701f2a177';
const PENDING = 'ev_20260418_086013965a';

function pack(rows: Array<{ id: string; extractionStatus: string }>) {
  return { account: { id: 'acc_x', name: 'Target' }, evidence: rows };
}
const ALL_FILES = [...REQUIRED_FILES, 'touch-1.eml'];

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

describe('extractCitedEvidenceIds', () => {
  it('extracts the exact newId evidence format, deduped, in order', () => {
    const text = `We cite ${VERIFIED} and again ${VERIFIED}, then ${VERIFIED_2}.`;
    expect(extractCitedEvidenceIds(text)).toEqual([VERIFIED, VERIFIED_2]);
  });

  it('does NOT false-match prose words or partial ids', () => {
    // "evidence", "every", a bare "ev_" with wrong shape — none match.
    const text = 'The evidence is everywhere; ev_ and ev_short and ev_2026 are not ids.';
    expect(extractCitedEvidenceIds(text)).toEqual([]);
  });

  it('round-trips a REAL newId("evidence") — id-format drift fails loud here', () => {
    // The gate's pattern is single-sourced from newId via idRegExp.
    // If newId's construction ever drifts (suffix length/charset, date
    // width) without idRegExp tracking it, a freshly-minted id stops
    // being recognized — in production that is a silently-missed
    // unbacked citation. This pins the round-trip so the drift fails
    // HERE, loudly, instead of there, silently.
    const id = newId('evidence');
    const text = `The target's ARR doubled last year, per ${id}.`;
    expect(extractCitedEvidenceIds(text)).toEqual([id]);
  });
});

describe('verifyApplication — evidence-citation gate (fails closed)', () => {
  const baseCover = `Intro. Problem framed by ${VERIFIED} and ${VERIFIED_2}. ` + words(600);

  it('passes when every cited id exists AND is verified, files complete, length in range', () => {
    const r = verifyApplication({
      coverLetter: baseCover,
      pack: pack([
        { id: VERIFIED, extractionStatus: 'verified' },
        { id: VERIFIED_2, extractionStatus: 'verified' },
        { id: PENDING, extractionStatus: 'pending_audit' },
      ]),
      presentFiles: ALL_FILES,
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.citedIds).toEqual([VERIFIED, VERIFIED_2]);
  });

  it('REPORTS malformed evidence rows instead of crashing on them', () => {
    // evidence-pack.json is external JSON and the IO shell only
    // array-checks `evidence`. A null / shape-broken row must be
    // reported as ONE problem, not throw — a throw would fail closed
    // but on the first bad row, hiding every other problem and
    // breaking the "report all problems in one pass" contract. The
    // well-formed rows are still honored, so the malformed-row report
    // is the ONLY problem here.
    const r = verifyApplication({
      coverLetter: baseCover, // cites VERIFIED + VERIFIED_2
      pack: {
        account: { id: 'acc_x' },
        evidence: [
          null,                                            // not an object
          { id: 123, extractionStatus: 'verified' },       // non-string id
          { id: VERIFIED },                                // missing status
          { id: VERIFIED, extractionStatus: 'verified' },  // good
          { id: VERIFIED_2, extractionStatus: 'verified' },// good
        ],
      },
      presentFiles: ALL_FILES,
    });
    expect(r.problems).toEqual([
      expect.stringMatching(/3 malformed evidence row\(s\)/i),
    ]);
    expect(r.ok).toBe(false);
    expect(r.citedIds).toEqual([VERIFIED, VERIFIED_2]);
  });

  it('FAILS when the cover letter cites an id that is NOT in the pack', () => {
    const r = verifyApplication({
      coverLetter: `Claim backed by ${VERIFIED}. ` + words(600),
      pack: pack([{ id: VERIFIED_2, extractionStatus: 'verified' }]),  // VERIFIED absent
      presentFiles: ALL_FILES,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(new RegExp(`${VERIFIED}.*(not in|missing|absent)`, 'i'));
  });

  it('FAILS when a cited id exists but is NOT verified (pending_audit / disputed)', () => {
    const r = verifyApplication({
      coverLetter: `Claim backed by ${PENDING}. ` + words(600),
      pack: pack([{ id: PENDING, extractionStatus: 'pending_audit' }]),
      presentFiles: ALL_FILES,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(new RegExp(`${PENDING}.*(not verified|unverified|pending|disputed)`, 'i'));
  });

  it('FAILS when a required package file is missing', () => {
    const r = verifyApplication({
      coverLetter: baseCover,
      pack: pack([
        { id: VERIFIED, extractionStatus: 'verified' },
        { id: VERIFIED_2, extractionStatus: 'verified' },
      ]),
      presentFiles: ALL_FILES.filter((f) => f !== 'evidence-pack.json'),
    });
    expect(r.ok).toBe(false);
    const joined = r.problems.join(' ');
    expect(joined).toMatch(/evidence-pack\.json/);
    expect(joined).toMatch(/missing/i);
  });

  it('FAILS when there is no outreach artifact (no .eml / -linkedin.txt)', () => {
    const r = verifyApplication({
      coverLetter: baseCover,
      pack: pack([
        { id: VERIFIED, extractionStatus: 'verified' },
        { id: VERIFIED_2, extractionStatus: 'verified' },
      ]),
      presentFiles: [...REQUIRED_FILES],  // no touch artifact
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/outreach artifact/i);
  });

  it('FAILS when the cover letter is too short or too long', () => {
    const short = verifyApplication({
      coverLetter: `Cites ${VERIFIED} ${VERIFIED_2}. ` + words(COVER_LETTER_MIN_WORDS - 100),
      pack: pack([
        { id: VERIFIED, extractionStatus: 'verified' },
        { id: VERIFIED_2, extractionStatus: 'verified' },
      ]),
      presentFiles: ALL_FILES,
    });
    expect(short.ok).toBe(false);
    expect(short.problems.join(' ')).toMatch(/word count|too short|length/i);

    const long = verifyApplication({
      coverLetter: `Cites ${VERIFIED} ${VERIFIED_2}. ` + words(COVER_LETTER_MAX_WORDS + 200),
      pack: pack([
        { id: VERIFIED, extractionStatus: 'verified' },
        { id: VERIFIED_2, extractionStatus: 'verified' },
      ]),
      presentFiles: ALL_FILES,
    });
    expect(long.ok).toBe(false);
    expect(long.problems.join(' ')).toMatch(/word count|too long|length/i);
  });

  it('FAILS a cover letter that cites NO evidence at all (the proof claim is unbacked)', () => {
    const r = verifyApplication({
      coverLetter: words(600),  // no ev_ ids
      pack: pack([{ id: VERIFIED, extractionStatus: 'verified' }]),
      presentFiles: ALL_FILES,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/no evidence (ids|citations)/i);
  });

  it('reports ALL problems at once (operator fixes in one pass, not whack-a-mole)', () => {
    const r = verifyApplication({
      coverLetter: `Only ${PENDING}. ` + words(50),  // unverified + too short
      pack: pack([{ id: PENDING, extractionStatus: 'disputed' }]),
      presentFiles: [...REQUIRED_FILES],  // missing outreach artifact too
    });
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThanOrEqual(3);
  });
});
