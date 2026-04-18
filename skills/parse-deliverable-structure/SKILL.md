---
name: parse-deliverable-structure
description: Given a full SDR deliverable markdown, return the deliverable name, ordered list of account-section heading lines, and the heading that marks the start of the outro (methodology/sources/exclusions). Does NOT return account bodies — only boundaries.
---

# Parse deliverable structure

You receive a full SDR deliverable markdown document. Return only the boundary markers needed to split it programmatically.

## Output JSON (only)

{
  "name": "short title of the deliverable (the top-of-doc title line)",
  "account_headers": [
    { "rank": 1, "heading": "EXACT heading line that starts account 1" },
    { "rank": 2, "heading": "EXACT heading line that starts account 2" }
  ],
  "outro_start_heading": "EXACT heading line that starts the outro (methodology / sources / notes / if this lands / etc.), or null if no clear outro"
}

## Rules

- `heading` must be a VERBATIM copy of a line in the document, not paraphrased, not reformatted. Case and punctuation must match exactly.
- Typically account sections are headed by patterns like "Target 1. RAHN AG" or "Target 2. Solabia Group" or "1. RAHN AG" — return whatever the actual heading line is.
- Outro is commonly started by "Notes on methodology", "Sources", "Deliverable methodology", "Methodology", "If this lands" — return whichever appears first and marks the end of the last account's section.
- Do NOT return the bodies of accounts or touches. Only the boundary markers. Output should be tiny.
- If you cannot identify account headers, return `"account_headers": []` and we'll fail fast.
