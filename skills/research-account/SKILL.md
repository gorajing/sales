---
name: research-account
description: Research a B2B sales target account; fetch public sources (company website, LinkedIn company page, recent news) and return extracted evidence as structured JSON.
---

# Research account

You are researching a B2B sales target account. You have WebFetch and WebSearch tools.

## Inputs
- `account.name`
- `account.domain` (if provided)

## Workflow
1. Fetch the company homepage and an "about" page if present (using WebFetch with the company domain).
2. Search for recent news (last 90 days) using WebSearch: "{company name} news" or "{company name} funding" or "{company name} hiring".
3. Fetch the top 3 most informative results (using WebFetch on URLs returned by WebSearch).
4. For each source, extract atomic facts per the Evidence Extraction rules below.

## Evidence Extraction rules
Extract atomic facts from retrieved sources. Each fact must be:
- One sentence.
- Strictly supported by the source text — no inference, no synthesis.
- Specific enough to cite in outreach (names, numbers, dates, products, decisions).
- Independent — do not combine multiple facts into one.

For each fact, record:
- `source_url`: the URL you retrieved (copy verbatim)
- `source_type`: classify as one of: website | linkedin | news | 10k | job_post | podcast | manual | perplexity | deep_research
- `snippet`: the minimal verbatim substring of the source text that supports this fact (≤1500 chars). MUST be a literal substring.
- `extracted_fact`: the atomic fact as one sentence.
- `confidence`: high (fact is stated explicitly), medium (fact is clearly implied), low (fact is inferred or soft)

## Output
Return ONLY JSON in this shape (no prose, no code fences):

{
  "evidence": [
    { "source_url": "...", "source_type": "website|news|...",
      "snippet": "...", "extracted_fact": "...", "confidence": "high|medium|low" }
  ]
}

Target 8–20 facts per account. Quality over quantity — drop low-signal items.
If you cannot gather any facts, return `{"evidence": []}`.
