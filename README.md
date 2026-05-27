# Sales — SDR Automation Reference Architecture

An evidence-grounded reference architecture for AI-powered SDR automation. Working implementation below.

Every factual claim in every generated outreach traces to a verified evidence row. Lead scores cite the specific signals that produced them. Routing decisions name the rule that fired. Drafts are critiqued against a user-owned principles file. Every revision is preserved.

Built on Claude Code primitives: each LLM call is a scoped CLI subprocess with `--allowed-tools`, the same pattern Claude Code itself ships.

## Mapped to AI Sales Automation primitives

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
| Pre-submit proof gate | `lib/application/verify.ts`, `scripts/verify-application.ts` | Outreach package fails closed unless every *cited* evidence ID resolves to a `verified` row |

## Architecture decisions

See [docs/architecture.md](docs/architecture.md) for the full essay. Summary:

1. **Evidence is a spine, not a sidecar.** Every signal, fact, and outcome lives in one append-only table with `extractionStatus`, `confidence`, and `supersededBy` columns. Drafts cite Evidence IDs; scores cite Evidence IDs; routing rationales cite Evidence IDs. One ledger; one provenance graph.
2. **The validator is a structural invariant, not a prompt instruction.** `lib/evidence/validate.ts` rejects any draft whose `supporting_spans` are not verbatim substrings of the cited snippets. The LLM cannot bypass it; the drafter retries with correction once, then surfaces remaining issues to the operator.
3. **Principles, scoring rules, routing rules, and alert triggers are user-editable Markdown files**, not code. SDR leaders edit `data/*.md`; the critics, scoring engine, routing engine, and alert worker re-read on every run.
4. **Each LLM call is a scoped Claude CLI subprocess with `--allowed-tools`.** No Anthropic API key required; the CLI authenticates via the operator's existing Claude Max OAuth session. Concurrency is bounded by `CLAUDE_MAX_CONCURRENT` (default 3).
5. **Drafts are immutable revisions, not mutable rows.** Accepting a critic rewrite creates a new `touch_revisions` row; the prior revision and its critiques are preserved indefinitely.
6. **The pre-submit gate proves a narrow floor — and says so.** `lib/application/verify.ts` fails closed unless every evidence ID the (human-written) cover letter *cites* resolves to a `verified` row, plus structural completeness and length bounds. It deliberately does **not** claim to prove every factual sentence is backed — detecting an *uncited* claim is not mechanically decidable and stays a human review step. PASS means "mechanical floor cleared," not "every claim is backed." A verifier that overstated its guarantee would launder weak claims with a green check, so the gate reports its precise scope wherever it speaks.

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

## Pre-submit gate

The pipeline can assemble a real outreach package for a chosen target and verify it before anything ships:

```bash
pnpm tsx scripts/dump-evidence.ts <accountId>   # export VERIFIED evidence → application/evidence-pack.json
# write the cover letter, citing evidence IDs inline
pnpm tsx scripts/verify-application.ts           # fails closed unless every cited ID is backed
```

The gate enforces the mechanical floor only — cited IDs resolve to `verified` rows, package structurally complete, length in band. Confirming each factual claim actually carries one of those citations stays a human read; the gate prints that reminder on PASS. The generated `application/` directory is gitignored (private by default).

## Status

v2 — see [docs/superpowers/plans/2026-05-06-ai-sales-automation-revamp.md](docs/superpowers/plans/2026-05-06-ai-sales-automation-revamp.md) for the implementation plan.
