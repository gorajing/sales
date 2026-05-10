# Scoring rules

Each rule has a stable `id` (e.g. `R1`), a predicate matched against an evidence
row, a base `weight` (added to the score when matched), and a `window_days` for
linear time-decay. Tier thresholds at the bottom map score → tier.

Edit freely; reload by hitting `POST /api/scoring/recompute`. The parser will
log warnings for predicates it cannot evaluate; check server logs after edits.

**Predicate grammar (v1):**

- Fields: `source_type`, `signal_type`, `snippet`, `extracted_fact`, `confidence`
- Ops: `==`, `!=`, `CONTAINS`, `IN ['a', 'b', ...]`
- Combinators: `AND`, `OR` (left-to-right; `OR` has lower precedence than `AND`)
- No parentheses; nested grouping not supported. Use multiple rules instead.
- String literals are single-quoted. `AND`/`OR` inside quoted strings are
  treated as content, not combinators.

---

## R1 — High-intent search keywords (Bombora)

- predicate: `source_type == 'intent_data' AND signal_type == 'intent'`
- weight: 20
- window_days: 7

## R2 — Pricing-page visit (web traffic)

- predicate: `source_type == 'web_traffic' AND snippet CONTAINS '/pricing'`
- weight: 15
- window_days: 3

## R3 — Form fill (demo / contact)

- predicate: `source_type == 'form_fill'`
- weight: 25
- window_days: 30

## R4 — Job post for relevant role

- predicate: `source_type == 'job_post'`
- weight: 10
- window_days: 30

## R5 — Recent funding round (news/press)

- predicate: `source_type IN ['press_release', 'news'] AND extracted_fact CONTAINS 'funding'`
- weight: 10
- window_days: 60

## R6 — GitHub: starred competitor repo

- predicate: `source_type == 'github_event' AND snippet CONTAINS 'starred'`
- weight: 5
- window_days: 14

## R7 — Earnings-call mention of relevant theme

- predicate: `source_type == 'earnings_call'`
- weight: 8
- window_days: 90

---

## Tier thresholds

- cold: 0–14
- warm: 15–34
- hot: 35–59
- on_fire: 60+
