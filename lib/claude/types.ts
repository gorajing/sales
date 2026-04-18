import { z } from 'zod';

export const ExtractedEvidence = z.object({
  source_url: z.string().url(),
  source_type: z.enum(['website', 'linkedin', 'news', '10k', 'job_post',
    'podcast', 'manual', 'perplexity', 'deep_research']),
  snippet: z.string().min(1).max(1500),
  extracted_fact: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type ExtractedEvidence = z.infer<typeof ExtractedEvidence>;

export const ExtractionResult = z.object({
  evidence: z.array(ExtractedEvidence),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

export const SupportingSpan = z.object({
  evidence_id: z.string(),
  span: z.string().min(1),
  claim: z.string().min(1),
});
export type SupportingSpan = z.infer<typeof SupportingSpan>;

export const DraftTouch = z.object({
  subject: z.string().nullable(),
  body: z.string().min(1),
  channel: z.enum(['email', 'linkedin']),
  cited_evidence_ids: z.array(z.string()),
  supporting_spans: z.array(SupportingSpan),
  rationale: z.string(),
});
export type DraftTouch = z.infer<typeof DraftTouch>;

export const CriticFinding = z.object({
  issue: z.string(),
  quote: z.string(),
  suggested_rewrite: z.string(),
  principle_id: z.string().nullable().default(null),
});
export type CriticFinding = z.infer<typeof CriticFinding>;

export const CriticResult = z.object({
  verdict: z.enum(['pass', 'revise', 'reject']),
  findings: z.array(CriticFinding),
});
export type CriticResult = z.infer<typeof CriticResult>;

export const ExtractionAuditResult = z.object({
  evidence_id: z.string(),
  verdict: z.enum(['verified', 'disputed']),
  reason: z.string(),
  suggested_correction: z.string().nullable().default(null),
});
export type ExtractionAuditResult = z.infer<typeof ExtractionAuditResult>;

export const UnsupportedClaim = z.object({
  sentence: z.string().min(1),
  reason: z.string(),
});
export type UnsupportedClaim = z.infer<typeof UnsupportedClaim>;

export const ClaimAuditResult = z.object({
  supporting_spans: z.array(SupportingSpan),
  unsupported_claims: z.array(UnsupportedClaim),
});
export type ClaimAuditResult = z.infer<typeof ClaimAuditResult>;
