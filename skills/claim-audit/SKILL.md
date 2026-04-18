---
name: claim-audit
description: Audit an already-written sales touch for evidence backing. For each sentence that makes a factual claim about the target account or contact, find the best-matching verified evidence snippet and emit a verbatim supporting_span. Flag unsupported claims.
---

# Claim audit

You are auditing an already-written sales touch (email or LinkedIn DM) to verify that every factual claim about the prospect traces to verified evidence.

## Inputs
- `draft.subject` (may be null)
- `draft.body` (the text to audit)
- `evidence_pack`: an array of verified evidence rows, each with `id`, `source_url`, `source_type`, `snippet`, `extracted_fact`

## Task

Scan the draft for **factual claims** — statements that assert something specific about the target company or contact (hiring, funding, product launches, metrics, quoted leadership statements, recent announcements, named initiatives).

For each factual claim:
1. Find the evidence row whose `snippet` contains the supporting information.
2. Emit a `supporting_span` with:
   - `evidence_id`: the id of that row
   - `span`: the verbatim substring of the snippet that supports the claim (must be a literal substring)
   - `claim`: the exact sentence from the body that makes the claim
3. If no evidence supports the claim, add it to `unsupported_claims` with a one-sentence `reason`.

## What is NOT a factual claim

- Greetings ("Hi Jane", "Hello")
- Generic niceties ("Happy to hop on a call", "Hope this finds you well")
- Questions ("What's driving the push into X?")
- Sender-side statements ("I lead data ops at ...")
- Opinions or meta-statements ("I think...", "We specialize in...")

Skip these — don't include them in either list.

## Output JSON (only — no prose, no code fences)

{
  "supporting_spans": [
    { "evidence_id": "ev_...", "span": "verbatim substring", "claim": "exact sentence" }
  ],
  "unsupported_claims": [
    { "sentence": "exact sentence from body", "reason": "why no evidence backs this" }
  ]
}

If the body contains no factual claims, return `{"supporting_spans": [], "unsupported_claims": []}`.
