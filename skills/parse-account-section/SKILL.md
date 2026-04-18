---
name: parse-account-section
description: Given the markdown slab for a single target account (including its why-now narrative, contacts, multiple touches), return a structured ParsedAccount JSON. Preserves body text verbatim.
---

# Parse account section

You receive a markdown slab for ONE target account. It contains location, contacts, a "why now" narrative, and several touches (cold emails + LinkedIn variations). Extract them into structured form.

## Output JSON (only, no prose, no code fences)

{
  "name": "company name, stripped of any 'Target N.' prefix",
  "domain": "best-guess domain or null if not stated",
  "location": "city/country or null",
  "rank": 1,
  "trigger_summary": "one-line summary of the trigger, or null",
  "deal_shape": "one-line deal shape or null",
  "routing": "e.g. 'Elisa, CET' or null",
  "time_ask": "e.g. '15 min' or null",
  "why_now_md": "the full 'Why now' narrative paragraph(s), verbatim markdown, or null",
  "contacts": [
    { "full_name": "...", "title": "...", "role": "primary|secondary|tertiary|executive_sponsor", "archetype": "gatekeeper|business_user|enabler|leader|unknown" }
  ],
  "touches": [
    { "position": 1, "channel": "email", "subject": "exact subject line", "body": "full email body, verbatim" },
    { "position": 2, "channel": "linkedin", "subject": null, "body": "LinkedIn connection request text, verbatim" },
    { "position": 3, "channel": "email", "subject": "subject of email 2", "body": "full email 2 body, verbatim" },
    { "position": 4, "channel": "linkedin", "subject": null, "body": "LinkedIn DM text, verbatim" }
  ]
}

## Rules

- Preserve touch bodies VERBATIM. Do not summarize or reformat.
- LinkedIn touches always have `subject: null`.
- Touch `position` is 1-based, in document order.
- Contact role inference:
  - "Primary contact" → primary
  - "Secondary contact" → secondary
  - "Tertiary contact" → tertiary
  - "Executive sponsor" → executive_sponsor
- Contact archetype best-guess from title (BD/Sales/Marketing → business_user, CEO/VP/Chief → leader, IT/HR → enabler, Procurement → gatekeeper, default unknown).
- `rank` is provided in the instructions section; copy it into the output.
- If a field doesn't exist, use null (for optional strings) or [] (for arrays).
