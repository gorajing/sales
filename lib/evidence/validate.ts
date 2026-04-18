import type { DraftTouch } from '../claude/types';

export interface EvidenceRow {
  id: string;
  snippet: string;
}

export interface ValidationIssue {
  kind: 'unknown_evidence_id' | 'span_not_in_snippet' | 'missing_evidence';
  detail: string;
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
      issues.push({ kind: 'unknown_evidence_id', detail: id });
    }
  }
  for (const span of draft.supporting_spans) {
    const ev = byId.get(span.evidence_id);
    if (!ev) {
      issues.push({ kind: 'unknown_evidence_id', detail: span.evidence_id });
      continue;
    }
    if (!normalize(ev.snippet).includes(normalize(span.span))) {
      issues.push({
        kind: 'span_not_in_snippet',
        detail: `span "${span.span.slice(0, 80)}…" not in snippet of ${span.evidence_id}`,
      });
    }
  }
  return issues;
}
