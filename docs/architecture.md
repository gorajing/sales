# Architecture decisions

This document explains the six non-obvious design decisions in this tool. None of them are clever; all of them are deliberate.

The tool is a personal, local-first SDR automation layer. The drafter declares its citations as `cited_evidence_ids` and verbatim `supporting_spans`; a substring validator runs over those declarations and surfaces any that aren't verbatim substrings of the cited evidence snippets. Drafts are critiqued against a user-owned principles file. Revisions are preserved as new rows rather than overwrites. The decisions below are about why those guarantees are designed in at the data and runtime layers rather than asserted in prompts — and where the v1 implementation falls short of the architectural ideal.

**Scope of this essay.** The decisions describe the architecture that v1 establishes and that the v2 plan ([docs/superpowers/plans/2026-05-06-ai-sales-automation-revamp.md](superpowers/plans/2026-05-06-ai-sales-automation-revamp.md)) extends. Where a feature only lands in v2, this is called out explicitly.

---

## 1. Evidence is a spine, not a sidecar

Most CRMs and most enrichment tools treat third-party data as a sidecar to the contact row. A vendor pushes a "company size" field, the row gets last-write-wins overwrites, and provenance — if it exists at all — is a free-form string somewhere in metadata. When you ask "where did this fact come from," you usually can't tell.

This tool treats Evidence as the spine. Every *sourced research fact used for grounding outreach* lives in [`db/schema.ts:evidence`](../db/schema.ts) with first-class columns for what matters (account-level structured fields like `industry` and `size` and contact fields like `title` are still on the parent rows; the Evidence table is for the citable facts that drafts and downstream signals depend on): `sourceUrl` (the URL the fact came from), `snippet` (the verbatim excerpt that supports the fact), `extractedFact` (the atomic claim, one sentence), `extractionStatus` (`pending_audit | verified | disputed`), `confidence` (`high | medium | low`), `capturedBy` (the producer enum: `claude_cli`, `manual`, etc.), and `supersededBy` (a self-reference column that lets a row point at its replacement).

In v1, drafts cite Evidence IDs (via `cited_evidence_ids` and `supporting_spans` on every `touch_revisions` row) and the substring validator binds those IDs to verbatim excerpts of the cited rows' snippets. Audit decisions live in [`db/schema.ts:extraction_audits`](../db/schema.ts), keyed by `evidenceId` — every audit decision has a recorded reason; pending rows simply haven't been audited yet. The spine is partial in two specific ways:

- The current "remove" path in [`app/api/evidence/audit/route.ts`](../app/api/evidence/audit/route.ts) physically deletes evidence and audit rows; "accept correction" updates `extractedFact` in place but does set `resolvedBy: 'user_accepted'` on the audit row. The piece v1 doesn't do is route corrections through *superseding replacement rows* — the schema supports `supersededBy` (a self-reference), but no path inserts a new evidence row pointed at by it. Tightening this so corrections become new rows linked via `supersededBy` is the obvious follow-up — it isn't a v2 plan task today, but the column is already there.
- v2 extends the spine to lead scores, routing assignments, alerts, and engagement events. The provenance chain is *traceable* through joins rather than a single foreign key on each new row: `lead_scores` stores cited evidence IDs in `rationaleJson`; `routing_assignments` keys to `scoreId` and inherits the rationale through it; tier-promotion alerts reference score IDs in their payload, while engagement-spike alerts trace via the account + time window of recent verified evidence; `engagement_events` key to `touchId` and `contactId`, which themselves chain back to the cited revision and its evidence. The architectural commitment is "every score / route / alert can be answered with: which evidence rows produced this?"; the implementation realizes that via composition, not by a uniform `evidenceId` column on every table.

The cost is up-front rigor about what counts as a fact and how it gets in. The benefit is that when an outreach email is questioned, you can pull every cited row and show the URL, the verbatim snippet, and the audit decision. That's a pre-litigation level of trail for cold outreach, and it's a single SQL query.

---

## 2. The validator is a structural invariant, not a prompt instruction

You can tell Claude "do not invent claims" in the system prompt, and most of the time it will listen. "Most of the time" is unacceptable in sales outreach: one fabricated quote about a prospect's strategy poisons the relationship.

The drafter ([`lib/drafter/draft.ts`](../lib/drafter/draft.ts)) is required to emit two structured fields alongside the email body: `cited_evidence_ids` (which evidence rows informed the draft) and `supporting_spans` (the verbatim substring of each evidence snippet that supports each declared claim). [`lib/evidence/validate.ts:validateDraft`](../lib/evidence/validate.ts) checks each declared span: does it literally appear in the snippet of the evidence row it points at? The check normalizes (lowercase, collapse whitespace, trim) so the model can rephrase capitalization and spacing without tripping the validator, but a span that doesn't have a verbatim substring in any cited snippet is rejected as an issue.

Three caveats — important enough that anyone using the architecture as a hallucination story should internalize them:

- **The validator binds *declared* spans to evidence. It does not analyze the email body itself.** The drafter's contract is "if you make a falsifiable claim, declare a span for it; uncited prose is operator-reviewable." The substring gate prevents fabrication inside the declared spans; the body could in principle contain prose that wasn't declared as a citation. That's a contract for the drafter, not a property the validator enforces.
- **The validator surfaces issues; it does not block writes.** [`draftTouch`](../lib/drafter/draft.ts) retries once with a correction message; if issues remain, the revision is written and the issues are returned by the draft API for the UI to display alongside the body. The structural invariant is "issues are returned at the response boundary," not "issues block writes" — and v1 doesn't yet persist the issue list with the revision, so a caller that ignores the response loses the warning on a page refresh. Persisting issues with the revision is an obvious follow-up; the reason it isn't there yet is operational: a stuck draft with unflagged issues is worse than a flagged draft an operator can read and reject in the same session.
- **The drafter pulls only `verified` evidence to feed the model**, so cited evidence IDs that come back are by construction in the verified pool (the validator also rejects unknown IDs as a defense in depth). But the validator does not, on its own, check `extractionStatus` — that filter happens at the query layer, before the model ever sees the snippets.

The pattern matters more than the specific drafter does. Any structurally enforceable invariant — types, foreign keys, substring checks, monotonic counters — is worth more than the same invariant expressed in a prompt. Prompts decay; structure doesn't.

---

## 3. Principles live in a user-editable file, not in the code

The Sales Coach critic reads its rubric from [`data/principles.md`](../data/principles.md): 12 principles, each with a stable ID (`P1` through `P12`), a one-line rule, a "why," and a critic check. The file is loaded fresh on every critic run. No redeploy, no PR, no engineering review.

This matters because the people who own the outreach motion — SDR leaders, sales coaches, founders selling their own product — read drafts and form opinions for a living. Asking them to file a code change every time the bar shifts is a guaranteed way for the bar to never shift. Asking them to edit a Markdown file is just a Tuesday afternoon.

Two caveats on the v1 enforcement story:

- The critic is *prompted* to score per principle, and findings include `principle_id` so the operator can attribute failures, but [`CriticResult`](../lib/claude/types.ts) stores `verdict + findings[]`, not a per-principle pass/fail array. v2 (Phase 4) computes per-principle outcome rows from this same shape and uses absence-of-failure as the pass signal — explicit per-principle verdict persistence is labeled v1.5 in the plan.
- Re-reading is on demand: the critic loads the file when it runs. There is no filesystem watcher; the operator chooses when to re-critique a draft after editing principles.

The pattern extends in v2 to user-editable scoring rules (`data/scoring-rules.md`) and routing rules (`data/routing-rules.md`), both parsed at runtime so an SDR ops lead can change weights and predicates without an engineering change. v2 also introduces `data/alert-rules.md` and `data/github-watch.md`: the GitHub watch list is parsed and used; the alert rules file is committed as a *design reference* for v1.5 (the dispatcher hardcodes the equivalent mapping in v2 rather than parsing the file). None of these four files exist in v1.

The split isn't ideological — it's about who pays the cost of being wrong. When the principles file is wrong, the SDR team's outreach gets worse and they fix it. When the validator is wrong, hallucinations leak and engineering fixes it. Different feedback loops, different storage.

---

## 4. Each LLM call is a scoped CLI subprocess

The default way to call Claude is `Anthropic.messages.create(...)` against a `messages` API key. That works, but it couples the application to one auth method, one billing surface, and one set of tools — usually whatever the SDK exposes by default.

This tool spawns the `claude` CLI as a subprocess for every LLM call ([`lib/claude/run.ts:spawnClaude`](../lib/claude/run.ts)). Each subprocess is invoked with `--print --output-format json --model <sonnet|haiku|opus>`. When the caller passes a non-empty `allowedTools` array, the runner appends `--allowed-tools <list>` to the args; this is how the research call gets `WebFetch,WebSearch` and nothing else. When the caller omits `allowedTools` (drafter, critics, audit, parsers in v1), no `--allowed-tools` flag is passed and the CLI uses its defaults. In other words: the runner *supports* per-call tool allowlisting and the auto-research path uses it; extending the same scoping to drafter and critics is straightforward but is not enforced today.

The auth story is an environment assumption rather than a code-enforced contract. The runner spawns whatever binary `CLAUDE_BIN` (default `claude`) points at, with the operator's existing environment. In practice the CLI authenticates through a Claude Max OAuth session, so no API key is required and there's no per-token billing fork — but if the operator points `CLAUDE_BIN` at a key-based binary, the runner doesn't know.

Concurrency is bounded by `CLAUDE_MAX_CONCURRENT` (default 3) — the Max plan tolerates roughly that many simultaneous CLI processes before rate-limiting. The runner queues beyond that.

The skills directory ([`skills/`](../skills/)) holds Claude Code-format SKILL.md files. v1 reads these files into the subprocess prompt directly (see [`lib/claude/prompts/draft-touch.ts`](../lib/claude/prompts/draft-touch.ts)) rather than relying on the CLI's runtime skill discovery. This is a deliberate v1 simplification — keeping the skill content in the prompt makes test fixtures and prompt diffs reproducible — but the SKILL.md format itself is the same Claude Code uses, so promotion to runtime discovery is a one-line change later.

The structural benefit isn't only auth and billing. The same Claude CLI surface an operator already uses for agentic work is the surface exercised here, with the same tool-allowlist mechanism available at every call site. When something works in this tool, the operational lesson transfers to other Claude-based sales workflows; when something breaks, the fix is in the same layer the operator already understands.

---

## 5. Drafts are immutable revisions

A typical CRM stores the current text of an outreach email and overwrites on edit. The history lives in some `activity_log` table, often filtered out of the default UI. When a deal closes (or doesn't), "what did we actually say, and why did we change it" is a 30-minute archaeology task.

Here, [`db/schema.ts:touches`](../db/schema.ts) carries a `currentRevisionId` pointer; [`db/schema.ts:touchRevisions`](../db/schema.ts) is written append-style with a `revisionNumber` per touch. Each accepted critic rewrite inserts a new row and updates the pointer. Prior revisions and their critiques are queryable forever; nothing in the touch_revisions path overwrites.

The invariant is enforced *by code*, not by schema constraint. The drafter computes `revisionNumber = existingRevisions.length + 1` per touch (see [`draftTouch`](../lib/drafter/draft.ts)), and the same pattern applies when the operator accepts a critic rewrite. There is no DB-level uniqueness on `(touchId, revisionNumber)` in v1; a buggy code path could produce two rows with the same revision number. Adding that constraint is a small migration and a v1.5 candidate; the pattern itself — "create new row, update pointer, never UPDATE the body" — is consistent across the v1 paths that touch revisions.

Why this is worth the disk space: the audit trail of *which rewrite worked* is data, not metadata. v2's engagement attribution layer (introduced by Phase 4 of the plan; will live at `lib/engagement/attribute.ts`) joins replies to the *current* revision and the *latest critique* on that revision, then rolls outcomes up per principle. Without immutable revisions, that join would require parsing diffs out of the activity log; with them, it's a normal SQL query.

The pairing with §3 is the point: when an SDR leader edits the principles file, the critic re-runs against the current revision and may surface a new rewrite. The prior critique under the prior principles is still on disk. You can replay your own evolution.

---

## 6. Audit status is a first-class column

`evidence.extractionStatus` is a NOT NULL enum on the row: `pending_audit | verified | disputed`. Not a JSON metadata blob, not a side table, not a soft `is_verified` boolean.

The lifecycle is explicit. A fact written by the auto-researcher arrives `pending_audit`. The Extraction Audit critic ([`lib/evidence/audit.ts`](../lib/evidence/audit.ts)) compares the snippet to the extracted fact and returns `verified` (the snippet supports the fact) or `disputed` (it doesn't, with a reason and a suggested correction). The drafter's evidence pull filters on `extractionStatus = 'verified'` — untrusted facts physically cannot be cited in outreach.

Audit decisions are themselves rows in [`db/schema.ts:extractionAudits`](../db/schema.ts), with a `resolvedBy` column intended to record provenance (`auto | user_accepted | user_overrode | user_removed`). v1 implementation is partial here, and v2 doesn't currently include a task to fix it — these are honest follow-ups, not implicit promises:

- Auto-audit rows from the critic are inserted without setting `resolvedBy: 'auto'`; the column is null on those rows.
- The "remove" path on the audit-resolution route physically deletes rows rather than marking `resolvedBy: 'user_removed'`, and "accept correction" updates `extractedFact` in place rather than creating a replacement row pointed at by `supersededBy`.

Even with those gaps, the structural answer to "could this email contain a hallucinated *declared* claim" is "the drafter's pull filters on `extractionStatus = 'verified'`; the validator surfaces any declared span that isn't a verbatim substring of its cited snippet, and the operator sees the issues alongside the draft." The probabilistic answer is "the model usually doesn't hallucinate." Those are different products, even if the v1 gate is "surface for operator review" rather than "block."

This pattern should propagate. When new LLM-emitted data enters the system — a connector inferring intent type, a critic emitting a verdict, a future model classifying buyer archetypes — the right move is the same: model the audit status as a column, gate downstream readers on it, write the audit decision as its own row. Don't trust the model to mark its own work; build the seams that let the operator do it without leaving the tool.

---

## Deployment assumptions (read before scaling out)

The architecture is designed for **single-process SQLite** running on one operator's machine or one Node server. A handful of concurrency-correctness decisions exploit that assumption explicitly:

1. **Scoring recompute idempotency.** `lib/scoring/score.ts` uses a "latest-row-fingerprint short-circuit" — if the most recent `lead_scores` row for an account has the same fingerprint as the new computation, it returns that row instead of inserting. The earlier draft had a UNIQUE `(account_id, fingerprint)` index as a multi-writer race defense, but that index blocked legitimate state recurrence (cold → warm → cold returning to cold should write a new row, not collide with the original). The index was dropped because single-process SQLite serializes transactions, so concurrent recomputes in this Node process can't race past each other — the second call sees the first's committed row in its SELECT and short-circuits.
2. **Signal ingest idempotency.** `lib/signals/ingest.ts` likewise relies on transaction serialization plus a dedupe-key column to guarantee at-most-once insertion of the same event.
3. **Latest-row ordering.** Both layers use SQLite's `rowid DESC` as the "most recently inserted" oracle — SQLite guarantees `rowid` is monotonically incrementing per insert within a table.

**These assumptions break if you move to:**

- **Multiple Node processes pointing at the same SQLite file.** Two processes can each start a transaction, both miss the dedupe SELECT, both insert, and SQLite serializes the commits without rejecting either. The scoring layer would need a real concurrency strategy: a sequence column per account, or a chain indicator in the fingerprint that includes the previous row's id (so state recurrence under a new prior produces a new fingerprint).
- **Postgres or any networked database.** Same problem at the database layer; the same fixes apply.
- **Serverless / Edge runtimes.** Each invocation is a fresh process. Two near-simultaneous requests run as independent processes. Same fix list.

This isn't a bug to defer — it's a *deployment constraint*. The v2 design is correct for its target. If the operator moves it beyond that target, the concurrency layer needs to be redesigned before the move, not after the first race surfaces.

---

## What this is not

It is not a CRM. v1 does not authenticate users, sync to Salesforce, send email through SMTP, or run as a multi-tenant SaaS; v2 adds lead scoring, routing, alerts, and an engagement loop, but still does not send outreach, sync to a CRM, authenticate users, or run multi-tenant. The decisions above are about what makes the *generation and audit* loop trustworthy. Outreach sending, CRM sync, auth/RBAC, and team-multi-tenant workflows are explicitly out of scope for both versions — the existing CRMs do those well, and replicating them would crowd out the parts that are actually novel.

What this *is* is a working demonstration that AI sales automation primitives — typed evidence, structural anti-hallucination on cited claims, user-owned configuration, scoped LLM tool surfaces, immutable revision history, audit-as-column — compose into a tool an SDR can use, and that an SDR leader can steer, without engineering being on the critical path for every behavior change.
