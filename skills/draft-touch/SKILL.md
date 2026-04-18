---
name: draft-touch
description: Write a single outbound touch (email or LinkedIn DM) for a sequence. Use only the provided evidence; cite every factual claim with an evidence_id and a verbatim supporting_span from that evidence's snippet.
---

# Draft Touch

You are drafting ONE touch in a B2B sales sequence.

## Inputs (provided separately)
- ICP brief
- Account evidence pack (verified rows only; each has id, source_url, source_type, snippet, extracted_fact)
- Contact evidence pack (if targeting a specific contact)
- Principles file (this is the rubric your draft will be scored against)
- Position in sequence (touch N of M)
- Prior touches (already sent or drafted in this sequence)

## Hard rules
1. Every factual or personalized claim about the account/contact MUST be backed by a cited `evidence_id` AND a `supporting_span` that is a verbatim substring of that evidence row's `snippet`.
2. Do not invent facts. If you do not have evidence for a claim, do not make the claim.
3. Respect word caps: email body ≤120 words, LinkedIn DM ≤60 words.
4. One CTA per touch. Small and low-friction on touch 1; larger on later touches.
5. Lead with a specific observation (from evidence), never with self-introduction.
6. Read your draft aloud mentally — if a sentence feels awkward or corporate, rewrite it.

## Output JSON (only — no prose, no code fences)
{
  "subject": "string or null (null for LinkedIn)",
  "body": "string",
  "channel": "email|linkedin",
  "cited_evidence_ids": ["ev_..."],
  "supporting_spans": [
    { "evidence_id": "ev_...", "span": "verbatim substring of that snippet",
      "claim": "the sentence in body this span supports" }
  ],
  "rationale": "why this angle, why this CTA, why this touch position"
}
