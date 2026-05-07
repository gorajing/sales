# Sales — SDR Automation Reference Architecture

An evidence-grounded reference architecture for AI-powered SDR automation. Working v1 below.

Every factual claim in every generated outreach traces to a verified evidence row. Lead scores cite the specific signals that produced them. Routing decisions name the rule that fired. Drafts are critiqued against a user-owned principles file. Every revision is preserved.

Built on Claude Code primitives: each LLM call is a scoped CLI subprocess with `--allowed-tools`, the same pattern Claude Code itself ships.

## Mapped to GTM Engineering primitives

| Primitive | Module | Notes |
|---|---|---|
| Lead capture | `lib/signals/ingest.ts`, `app/api/signals/route.ts` | Webhook + connector pull, both produce typed Evidence rows |
| Centralized prospect data | `db/schema.ts` (`evidence` table) | Append-only, audit-tracked, multi-source |
| Lead scoring | `lib/scoring/score.ts` | Weighted rules in `data/scoring-rules.md`; rationale cites evidence IDs |
| Routing | `lib/routing/route.ts` | Predicate DSL in `data/routing-rules.md` |
| Alerts | `lib/alerts/dispatch.ts` | Tier-transition + spike detection; Slack/email/webhook fanout |
| Account research | `lib/research/auto-research.ts` | Claude CLI with WebFetch + WebSearch |
| Personalized outreach | `lib/drafter/draft.ts` + 3 critics | Substring-validator anti-hallucination invariant |
| Engagement attribution | `lib/engagement/attribute.ts` | Per-principle outcome rates feed back into drafter |
| External integrations | `lib/connectors/` | One real (GitHub via Octokit), three fixture-backed stubs |

## Architecture decisions

See [docs/architecture.md](docs/architecture.md) for the full essay. Summary:

1. **Evidence is a spine, not a sidecar.** Every signal, fact, and outcome lives in one append-only table with `extractionStatus`, `confidence`, and `supersededBy` columns. Drafts cite Evidence IDs; scores cite Evidence IDs; routing rationales cite Evidence IDs. One ledger; one provenance graph.
2. **The validator is a structural invariant, not a prompt instruction.** `lib/evidence/validate.ts` rejects any draft whose `supporting_spans` are not verbatim substrings of the cited snippets. The LLM cannot bypass it; the drafter retries with correction once, then surfaces remaining issues to the operator.
3. **Principles, scoring rules, routing rules, and alert triggers are user-editable Markdown files**, not code. SDR leaders edit `data/*.md`; the critics, scoring engine, routing engine, and alert worker re-read on every run.
4. **Each LLM call is a scoped Claude CLI subprocess with `--allowed-tools`.** No Anthropic API key required; the CLI authenticates via the operator's existing Claude Max OAuth session. Concurrency is bounded by `CLAUDE_MAX_CONCURRENT` (default 3).
5. **Drafts are immutable revisions, not mutable rows.** Accepting a critic rewrite creates a new `touch_revisions` row; the prior revision and its critiques are preserved indefinitely.

## Quick start

```bash
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000.

## Demo

See [docs/demo.md](docs/demo.md) for a 5-minute walkthrough that takes a public company through every stage of the pipeline.

## Tests

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Status

v2 — see [docs/superpowers/plans/2026-05-06-anthropic-gtm-revamp.md](docs/superpowers/plans/2026-05-06-anthropic-gtm-revamp.md) for the implementation plan.
