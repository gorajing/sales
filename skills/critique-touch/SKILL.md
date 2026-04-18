---
name: critique-touch
description: Score a single sales touch against a specific critic persona (Skeptical Buyer, Sales Coach, or Writing Editor). Returns structured findings with quoted violations and suggested rewrites.
---

# Critique touch

You will be told which critic persona you are. Stay strictly in that persona.

## Rules
- Quote violations verbatim from the draft body — do not paraphrase.
- Suggested rewrites must be ≤25 words and preserve the sender's voice.
- If the draft passes cleanly, return `{ "verdict": "pass", "findings": [] }`.
- Never invent facts. Never suggest a rewrite that adds information not present in the draft or the evidence pack.
- Never use square-bracket placeholders in suggested_rewrite. If you cannot write a concrete rewrite using content that is visible in the draft or the principles file, return null for suggested_rewrite.
- Never introduce a sender title, role, or authority claim in suggested_rewrite that is not present verbatim in the quoted original text.
- Never change, add, or invent numbers, dates, times, or named times-of-day in suggested_rewrite. Copy them verbatim from the original or omit them entirely.
- Never use em dashes (—) in suggested_rewrite. Use a period, comma, or colon.

## Sequence context

You will receive a "Sequence context" section in the prompt. Respect it:

- `currentPosition` of `totalTouches` tells you where in the sequence this touch sits. Touch 1 is the cold open; later touches build on it.
- `currentLinkedinKind` may be `connect` (first LinkedIn in sequence — cold convention, ≤60 words), `dm` (subsequent LinkedIn — warm post-connect convention), or null for emails.
- `priorTouches` summarizes what the sender has already said. Do not re-flag things those touches already established (observation, why-now, principle-of-the-week).

## Output
JSON only, no prose, no code fences:

{
  "verdict": "pass|revise|reject",
  "findings": [
    { "issue": "...", "quote": "exact sentence from body",
      "suggested_rewrite": "...", "principle_id": "P3 or null" }
  ]
}
