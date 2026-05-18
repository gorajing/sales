# Routing rules

Operator-editable rules that decide which owner email gets assigned to a scored account. Each rule is a Markdown section. The parser is strict: an unparseable file is rejected wholesale so a typo can't silently route to the wrong inbox.

## How matching works

- Rules are evaluated in ascending **priority** order (lower number first). Ties are broken by the **numeric suffix** of the rule id ascending (so `RR2` beats `RR10` when both have the same priority — operator-intuitive, not lexicographic).
- The first rule whose predicate matches the account's tier + firmographics wins.
- If no rule matches, the assignment falls through to the email in the `DEFAULT_OWNER_EMAIL` environment variable. **Changing `DEFAULT_OWNER_EMAIL` invalidates existing fallback assignments** — the new value participates in the routing-config hash, so a recompute under a new default produces a fresh assignment.
- Routing recompute is idempotent against the **parsed semantics** of this file: comments, blank lines, and whitespace inside or outside predicates don't churn assignments. Editing a predicate's semantics, priority, owner email, or the default owner email does.

## Allowed predicate grammar

Each rule has a single predicate expression composed of leaf clauses joined by `AND` / `OR`. `AND` binds tighter than `OR`. No parentheses (v2). Examples:

- `tier == 'hot'`
- `tier IN ['hot', 'on_fire']`
- `tier == 'warm' AND firmographic_size == 'enterprise'`
- `tier == 'hot' OR industry == 'fintech'`

**Allowed fields** (the parser rejects any other field name):

- `tier` — one of `cold`, `warm`, `hot`, `on_fire` (comes from the latest lead score). **Tier literals are enum-validated at parse time** — `tier == 'hots'` is rejected because that value can never appear in a score. The other fields are free-form text columns so the parser can't enumerate their valid values.
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
