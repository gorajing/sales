import { describe, it, expect } from 'vitest';
import { validateDraft, normalize, selectValidSpans } from '../../lib/evidence/validate';
import type { DraftTouch } from '../../lib/claude/types';

const evidence = [
  { id: 'ev_a', snippet: 'Acme is hiring a VP of Data per a LinkedIn post.' },
  { id: 'ev_b', snippet: 'Revenue grew 40% in Q2 2026.' },
];

describe('normalize', () => {
  it('lowercases, collapses whitespace, trims', () => {
    expect(normalize('  Hello\n  WORLD  \t')).toBe('hello world');
  });
});

describe('validateDraft', () => {
  it('passes when every span is a substring of its snippet', () => {
    const draft: DraftTouch = {
      subject: 'Hey', body: 'Saw you are hiring a VP of Data.', channel: 'email',
      cited_evidence_ids: ['ev_a'],
      supporting_spans: [{ evidence_id: 'ev_a', span: 'hiring a VP of Data', claim: 'Saw you are hiring a VP of Data.' }],
      rationale: '',
    };
    expect(validateDraft(draft, evidence)).toHaveLength(0);
  });

  it('flags unknown evidence ids in cited_evidence_ids', () => {
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_missing'],
      supporting_spans: [], rationale: '',
    };
    const issues = validateDraft(draft, evidence);
    // Two issues: unknown_evidence_id + missing_evidence (spans empty while ids non-empty)
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.kind === 'unknown_evidence_id' && i.detail === 'ev_missing')).toBe(true);
  });

  it('flags unknown evidence ids in supporting_spans', () => {
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_a'],
      supporting_spans: [{ evidence_id: 'ev_missing', span: 'whatever', claim: 'x' }],
      rationale: '',
    };
    const issues = validateDraft(draft, evidence);
    expect(issues.some((i) => i.kind === 'unknown_evidence_id' && i.detail === 'ev_missing')).toBe(true);
  });

  it('flags spans that are not substrings of the snippet', () => {
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_a'],
      supporting_spans: [{ evidence_id: 'ev_a', span: 'promoted to CTO', claim: 'x' }],
      rationale: '',
    };
    const issues = validateDraft(draft, evidence);
    expect(issues[0].kind).toBe('span_not_in_snippet');
    expect(issues[0].detail).toContain('ev_a');
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_a'],
      supporting_spans: [{ evidence_id: 'ev_a', span: 'HIRING   a vp\nof data', claim: 'x' }],
      rationale: '',
    };
    expect(validateDraft(draft, evidence)).toHaveLength(0);
  });

  it('flags missing_evidence when cited_evidence_ids is set but supporting_spans is empty', () => {
    const draft: DraftTouch = {
      subject: 'x', body: 'Saw your thing.', channel: 'email',
      cited_evidence_ids: ['ev_a'],
      supporting_spans: [],
      rationale: '',
    };
    const issues = validateDraft(draft, evidence);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('missing_evidence');
  });

  it('passes when no evidence cited and no spans provided (empty-body edge case)', () => {
    const draft: DraftTouch = {
      subject: 'x', body: 'Hello.', channel: 'email',
      cited_evidence_ids: [],
      supporting_spans: [],
      rationale: '',
    };
    expect(validateDraft(draft, evidence)).toHaveLength(0);
  });

  it('accumulates multiple issues across spans', () => {
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_a', 'ev_b'],
      supporting_spans: [
        { evidence_id: 'ev_a', span: 'does not exist in this snippet', claim: 'x' },
        { evidence_id: 'ev_ghost', span: 'anything', claim: 'x' },
      ],
      rationale: '',
    };
    const issues = validateDraft(draft, evidence);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.some((i) => i.kind === 'span_not_in_snippet')).toBe(true);
    expect(issues.some((i) => i.kind === 'unknown_evidence_id')).toBe(true);
  });
});

describe('selectValidSpans (claim-audit span selection)', () => {
  const ev = [
    { id: 'ev_1', snippet: 'alpha appears here' },
    { id: 'ev_12', snippet: 'beta appears here' },
  ];

  // Would FAIL under the old `detail.includes(evidence_id)` filter: the issue for
  // ev_12 ("…not in snippet of ev_12") includes the substring "ev_1", wrongly
  // dropping the valid ev_1 span.
  it('does not cross-match evidence ids by substring (ev_1 vs ev_12)', () => {
    const spans = [
      { evidence_id: 'ev_1', span: 'alpha', claim: 'ok' },
      { evidence_id: 'ev_12', span: 'NOT PRESENT', claim: 'bad' },
    ];
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_1', 'ev_12'], supporting_spans: spans, rationale: '',
    };
    const issues = validateDraft(draft, ev);
    expect(selectValidSpans(spans, issues)).toEqual([
      { evidence_id: 'ev_1', span: 'alpha', claim: 'ok' },
    ]);
  });

  // Would FAIL under the old filter: one bad span for ev_1 produced an issue
  // mentioning "ev_1", dropping the GOOD ev_1 span too.
  it('drops only the bad span for an id, not every span citing that id', () => {
    const spans = [
      { evidence_id: 'ev_1', span: 'alpha', claim: 'good' },
      { evidence_id: 'ev_1', span: 'NOT PRESENT', claim: 'bad' },
    ];
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_1'], supporting_spans: spans, rationale: '',
    };
    const issues = validateDraft(draft, ev);
    expect(selectValidSpans(spans, issues)).toEqual([
      { evidence_id: 'ev_1', span: 'alpha', claim: 'good' },
    ]);
  });

  it('drops all spans citing an unknown evidence id', () => {
    const spans = [{ evidence_id: 'ev_ghost', span: 'whatever', claim: 'x' }];
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_ghost'], supporting_spans: spans, rationale: '',
    };
    const issues = validateDraft(draft, ev);
    expect(selectValidSpans(spans, issues)).toEqual([]);
  });
});
