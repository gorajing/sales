---
name: parse-deliverable
description: Parse a finished SDR deliverable markdown document (multiple target accounts, contacts, per-account research narrative, multiple touches per account, wrapped in intro and outro narrative) into structured JSON.
---

# Parse deliverable

You are parsing a finished SDR deliverable markdown document into structured data that downstream tooling can reason about.

## Inputs
- A markdown blob. It contains: an intro narrative, a set of target accounts (each with location, contacts, "why now" narrative, and several touches — cold emails + LinkedIn variations), and an outro section (methodology, sources, exclusions, runners-up, closing pitch).

## Output
Return ONLY JSON in this exact shape (no prose, no code fences):

{
  "name": "short deliverable title (e.g., the top-of-doc title)",
  "intro_md": "the narrative block(s) before the first target account section, verbatim markdown including the shortlist table if present",
  "outro_md": "all content after the last account section (methodology, sources, excluded, runners-up, known unknowns, closing pitch) — verbatim markdown",
  "accounts": [
    {
      "name": "company name (strip 'Target N.' prefix)",
      "domain": "best-guess domain or null if not stated",
      "location": "city/country or null",
      "rank": 1,
      "trigger_summary": "one-line summary of the trigger, from the shortlist table if present",
      "deal_shape": "one-line deal shape from shortlist table or account header",
      "routing": "e.g. 'Elisa, CET' or null",
      "time_ask": "e.g. '15 min' or null",
      "why_now_md": "the full 'Why now' narrative paragraph(s) for this account, verbatim markdown",
      "contacts": [
        { "full_name": "...", "title": "...", "role": "primary|secondary|tertiary|executive_sponsor",
          "archetype": "gatekeeper|business_user|enabler|leader|unknown" }
      ],
      "touches": [
        { "position": 1, "channel": "email", "subject": "exact subject line", "body": "full email body, verbatim" },
        { "position": 2, "channel": "linkedin", "subject": null, "body": "LinkedIn connection request text, verbatim" },
        { "position": 3, "channel": "email", "subject": "subject of email 2", "body": "full email 2 body, verbatim" },
        { "position": 4, "channel": "linkedin", "subject": null, "body": "LinkedIn DM text, verbatim" }
      ]
    }
  ]
}

## Rules
- Preserve body text VERBATIM. Do not summarize, paraphrase, or reformat. Newlines and paragraphs should match the source.
- Touch subjects for LinkedIn entries are always `null` (LinkedIn has no subject field).
- Touch position is 1-based. Use the order the touches appear in the document.
- Contact role inference:
  - "Primary contact" → role: "primary"
  - "Secondary contact" → role: "secondary"
  - "Tertiary contact" → role: "tertiary"
  - "Executive sponsor" → role: "executive_sponsor"
- Contact archetype inference (best-guess from title; use "unknown" if unsure):
  - BD / Sales / Marketing / Communications → business_user
  - R&D / Innovation / Technical / Scientist / Director of X Research → business_user
  - IT / Enablement / HR → enabler
  - CEO / CTO / VP / President / Chief → leader
  - Procurement / Ops → gatekeeper
  - Default: unknown
- Account rank: use the number shown in the document (e.g., "Target 1" → rank 1).
- Strip markdown table syntax from `trigger_summary`, `deal_shape`, `routing`, `time_ask` — store as plain strings.
- `intro_md` and `outro_md` are for preservation. The intro may include narrative analysis and a shortlist table. The outro includes methodology, sources, excluded, runners-up, known unknowns, and closing. Concatenate all outro content as a single markdown string.
- If a section doesn't exist, use `null` (for optional strings) or `[]` (for arrays).
