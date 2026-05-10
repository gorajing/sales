# Routing rules

Operator-editable rules that decide which owner email gets assigned to a scored account. Each rule is a Markdown section. The parser is strict: an unparseable file is rejected wholesale so a typo can't silently route to the wrong inbox.

## How matching works

- Rules are evaluated in ascending **priority** order (lower number first). Ties are broken by rule **id** ascending (so `RR1` beats `RR2` when both have the same priority).
- The first rule whose predicate matches the account's tier + firmographics wins.
- If no rule matches, the assignment falls through to the email in the `DEFAULT_OWNER_EMAIL` environment variable.
- Routing recompute is idempotent against the **parsed semantics** of this file: a comment edit or a whitespace change doesn't churn assignments. Editing a predicate, priority, or owner email does.

## Allowed predicate grammar

Each rule has a single predicate expression composed of leaf clauses joined by `AND` / `OR`. `AND` binds tighter than `OR`. No parentheses (v2). Examples:

- `tier == 'hot'`
- `tier IN ['hot', 'on_fire']`
- `tier == 'warm' AND firmographic_size == 'enterprise'`
- `tier == 'hot' OR industry == 'fintech'`

**Allowed fields** (the parser rejects any other field name):

- `tier` — one of `cold`, `warm`, `hot`, `on_fire` (comes from the latest lead score).
- `firmographic_size` — `accounts.size` column (free-form string; common values: `smb`, `mid_market`, `enterprise`).
- `industry` — `accounts.industry` column (free-form string).

**Allowed operators:** `==`, `!=`, `IN [...]` (string list).

String values must be single-quoted. Numeric comparisons are not supported in v2 (no scoring fields surface through routing yet).

## Owner email

`owner_email` is normalized to lowercase + trimmed at parse time, and must contain `@` followed by at least one `.` in the domain. Invalid emails reject the whole file.

## Required fields per rule

Every rule MUST declare:

- `priority` (non-negative integer)
- `predicate` (in backticks)
- `owner_email`

If any are missing or malformed, the parser throws a `RoutingRuleParseError` listing all problems found, and **no rules are loaded** — no partial application.

---

## RR1 — Hot+ enterprise → senior AE pool

- priority: 10
- predicate: `tier IN ['hot', 'on_fire'] AND firmographic_size == 'enterprise'`
- owner_email: senior-ae-pool@company.example

## RR2 — Hot+ mid-market → AE pool

- priority: 20
- predicate: `tier IN ['hot', 'on_fire'] AND firmographic_size == 'mid_market'`
- owner_email: ae-pool@company.example

## RR3 — Warm tier → SDR pool

- priority: 30
- predicate: `tier == 'warm'`
- owner_email: sdr-pool@company.example

## RR4 — Cold (default)

- priority: 100
- predicate: `tier == 'cold'`
- owner_email: triage@company.example
