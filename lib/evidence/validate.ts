import type { DraftTouch } from '../claude/types';

export interface EvidenceRow {
  id: string;
  snippet: string;
}

export interface ValidationIssue {
  kind: 'unknown_evidence_id' | 'span_not_in_snippet' | 'missing_evidence';
  detail: string;
  // Structured identity so consumers match an issue to a span by exact
  // (evidenceId, span) — never by substring-scanning `detail`. Omitted for
  // `missing_evidence`, which is not tied to a single span.
  evidenceId?: string;
  span?: string;
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function validateDraft(
  draft: DraftTouch,
  availableEvidence: EvidenceRow[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(availableEvidence.map((e) => [e.id, e]));

  for (const id of draft.cited_evidence_ids) {
    if (!byId.has(id)) {
      issues.push({ kind: 'unknown_evidence_id', detail: id, evidenceId: id });
    }
  }
  for (const span of draft.supporting_spans) {
    const ev = byId.get(span.evidence_id);
    if (!ev) {
      issues.push({ kind: 'unknown_evidence_id', detail: span.evidence_id, evidenceId: span.evidence_id });
      continue;
    }
    if (!normalize(ev.snippet).includes(normalize(span.span))) {
      issues.push({
        kind: 'span_not_in_snippet',
        detail: `span "${span.span.slice(0, 80)}…" not in snippet of ${span.evidence_id}`,
        evidenceId: span.evidence_id,
        span: span.span,
      });
    }
  }
  // Structural guard: if the draft cites any evidence, it MUST provide at least one supporting span.
  // This closes a bypass where the drafter could list cited_evidence_ids but omit spans, making
  // the substring check vacuous.
  if (draft.cited_evidence_ids.length > 0 && draft.supporting_spans.length === 0) {
    issues.push({
      kind: 'missing_evidence',
      detail: 'cited_evidence_ids is non-empty but supporting_spans is empty; every cited claim must have a supporting_span',
    });
  }
  return issues;
}

// Select the spans that survived validation. Matches issues to spans by exact
// (evidenceId, span) identity — never by substring-scanning `detail`, which
// cross-matched evidence ids (e.g. ev_1 vs ev_12) and let one bad span for an
// id invalidate every other span citing that id.
export function selectValidSpans<T extends { evidence_id: string; span: string }>(
  spans: T[],
  issues: ValidationIssue[],
): T[] {
  return spans.filter(
    (s) =>
      !issues.some(
        (i) =>
          (i.kind === 'unknown_evidence_id' && i.evidenceId === s.evidence_id) ||
          (i.kind === 'span_not_in_snippet' &&
            i.evidenceId === s.evidence_id &&
            i.span === s.span),
      ),
  );
}
