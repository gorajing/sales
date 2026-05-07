# Architecture decisions

This document explains the six non-obvious design decisions in this tool. None of them are clever; all of them are deliberate.

The tool is a personal, local-first SDR automation layer. Every factual claim in every generated outreach traces to a verified evidence row. Drafts are critiqued against a user-owned principles file. Every revision is preserved. The decisions below are what make those guarantees structural rather than aspirational.

---

## 1. Evidence is a spine, not a sidecar

Most CRMs and most enrichment tools treat third-party data as a sidecar to the contact row. A vendor pushes a "company size" field, the row gets last-write-wins overwrites, and provenance — if it exists at all — is a free-form string somewhere in metadata. When you ask "where did this fact come from," you usually can't tell, and when the fact is wrong you can't tell which write made it wrong.

This tool treats Evidence as the spine. Every fact lives in one append-only table ([`db/schema.ts:evidence`](../db/schema.ts)) with first-class columns for what matters: `sourceUrl` (the URL the fact came from), `snippet` (the verbatim ≤1500-character excerpt that supports the fact), `extractedFact` (the atomic claim, one sentence), `extractionStatus` (`pending_audit | verified | disputed`), `confidence` (`high | medium | low`), `capturedBy` (the producer — `claude_cli`, `manual`, a specific connector, etc.), and `supersededBy` (a self-reference that keeps history when a row is replaced).

Drafts cite Evidence IDs. Scores cite Evidence IDs. Routing rationales cite Evidence IDs. Engagement attribution chains back through revisions to the Evidence rows that informed them. There is one ledger and one provenance graph; nothing else has its own truth table.

The cost is some up-front rigor about what counts as a fact and how it gets in. The benefit is that when an outreach email is flagged for any reason — a customer push-back, a legal question, a sales-leader audit — you can pull every cited row and show the operator the URL, the verbatim snippet, and the audit decision. That's a pre-litigation level of trail for cold outreach, and it costs you a single SQL query.

---

## 2. The validator is a structural invariant, not a prompt instruction

You can tell Claude "do not invent claims" in the system prompt, and most of the time it will listen. "Most of the time" is unacceptable in sales outreach: one fabricated quote about a prospect's strategy poisons the relationship and is sometimes legally exposing.

The drafter ([`lib/drafter/draft.ts`](../lib/drafter/draft.ts)) is required to emit two structured fields alongside the email body: `cited_evidence_ids` (which evidence rows informed the draft) and `supporting_spans` (the *verbatim substring* of each evidence snippet that supports each claim in the email). [`lib/evidence/validate.ts`](../lib/evidence/validate.ts) then checks: does each span literally appear in the snippet of the evidence row it points at?

The check normalizes (lowercase, collapse whitespace, trim) so the model can subtly rephrase punctuation or capitalization without tripping the validator, but it cannot invent. A fabricated claim has no verbatim substring in any cited snippet; the validator rejects it. The drafter retries once with an explicit correction message; if it still fails, the touch is surfaced to the operator with the failing spans listed by ID. The path from "model generates" to "operator sends" cannot bypass the substring check.

This pattern matters more than the specific drafter does. Any structurally enforceable invariant — types, foreign keys, substring checks, monotonic counters — is worth more than the same invariant expressed in a prompt. Prompts decay; structure doesn't.

---

## 3. Principles live in a user-editable file, not in the code

The Sales Coach critic scores every draft against 12 principles defined in [`data/principles.md`](../data/principles.md). Each principle has a stable ID (`P1` through `P12`), a one-line rule, a "why," a critic check, and a source citation. The critic re-reads the file on every run. No redeploy, no PR, no engineering review.

This matters because the people who own the outreach motion — SDR leaders, sales coaches, founders selling their own product — read drafts and form opinions for a living. Asking them to file a code change every time the bar shifts is a guaranteed way for the bar to never shift. Asking them to edit a Markdown file is just a Tuesday afternoon.

Principles are referenced by ID in critic output, so reordering the file or adding new principles doesn't break attribution. The same pattern extends to [`data/scoring-rules.md`](../data/scoring-rules.md), [`data/routing-rules.md`](../data/routing-rules.md), [`data/alert-rules.md`](../data/alert-rules.md), and [`data/github-watch.md`](../data/github-watch.md). Configuration that an operator should be able to tune lives as Markdown the operator owns. Configuration that an engineer should change lives in code.

The split isn't ideological — it's about who pays the cost of being wrong. When the principles file is wrong, the SDR team's outreach gets worse and they fix it. When the validator is wrong, hallucinations leak and engineering fixes it. Different feedback loops, different storage.

---

## 4. Each LLM call is a scoped CLI subprocess with `--allowed-tools`

The default way to call Claude in 2026 is `Anthropic.messages.create(...)` against a `messages` API key. That works, but it couples your application to one auth method, one billing surface, and one set of tools — usually whatever the SDK exposes by default.

This tool spawns the `claude` CLI as a subprocess for every LLM call ([`lib/claude/run.ts:spawnClaude`](../lib/claude/run.ts)). The CLI authenticates through the operator's existing Claude Max OAuth session: no API key, no key rotation, no per-token billing fork. Each subprocess is invoked with `--print --output-format json --model <sonnet|haiku|opus>` and an explicit `--allowed-tools <list>` whitelist. The drafter call gets no tools (it should never browse). The research call gets `WebFetch,WebSearch` and nothing else. The critics get no tools.

The model cannot exceed the tool surface you grant for that specific call. That's principle-of-least-privilege applied to an LLM: the same approach you'd take with any service account in a real system, except that here the "service account" is a thinking model whose ability to cause damage scales with its tool access.

Concurrency is bounded by `CLAUDE_MAX_CONCURRENT` (default 3) — the Max plan tolerates roughly that many simultaneous CLI processes before rate-limiting. The runner queues beyond that.

The structural benefit isn't only auth and billing. It's parity: the agent that runs at Anthropic in production is the agent running here. Same primitives, same skill discovery, same tool-allowlist mechanism. When something works in this tool, it transfers; when something breaks, the fix transfers too.

---

## 5. Drafts are immutable revisions, not mutable rows

A typical CRM stores the current text of an outreach email and overwrites on edit. The history lives in some `activity_log` table, often filtered out of the default UI, sometimes in a separate database that no one queries. When a deal closes (or doesn't), the question "what did we actually say, and why did we change it" is a 30-minute archaeology task.

Here, [`db/schema.ts:touches`](../db/schema.ts) carries a `currentRevisionId` pointer; [`db/schema.ts:touch_revisions`](../db/schema.ts) is append-only with a monotonic `revisionNumber` per touch. Each accepted critic rewrite inserts a new row and updates the pointer. Prior revisions and their critiques are queryable forever; nothing is overwritten.

Why this is worth the disk space: the audit trail of *which rewrite worked* is data, not metadata. When a touch gets a reply, the engagement attribution layer ([`lib/engagement/attribute.ts`](../lib/engagement/attribute.ts) once Phase 4 lands) joins back to the *current* revision and the *latest critique* on that revision, and rolls it up per principle. The reply rate when P5 (pattern interrupt) is satisfied versus violated becomes a measurable thing, and the principle's wording can evolve based on observed outcomes rather than gut.

The pairing with §3 is the point: when an SDR leader edits the principles file, the critic re-runs against the current revision and may surface a new rewrite. The prior critique under the prior principles is still on disk. You can replay your own evolution.

---

## 6. Audit status is a first-class column, not metadata

`evidence.extractionStatus` is a NOT NULL enum on the row: `pending_audit | verified | disputed`. Not a JSON metadata blob, not a side table, not a soft "is_verified" boolean.

The lifecycle is explicit. A fact written by the auto-researcher arrives `pending_audit`. The Extraction Audit critic ([`lib/evidence/audit.ts`](../lib/evidence/audit.ts)) compares the snippet to the extracted fact and returns `verified` (the snippet supports the fact) or `disputed` (it doesn't, with a reason and a suggested correction). The drafter's evidence pull filters on `extractionStatus = 'verified'` — untrusted facts physically cannot be cited in outreach.

Audit decisions are themselves rows in [`db/schema.ts:extraction_audits`](../db/schema.ts), with `resolvedBy` (`auto | user_accepted | user_overrode | user_removed`) so you can tell which decisions came from the model, which from the operator accepting a correction, which from the operator overriding the model, and which from manual removal. Disputed rows can be marked `supersededBy` a corrected version to keep the history.

The structural answer to "could this email contain a hallucinated fact" is "no — every claim's evidence row is `verified`, every span is a verbatim substring of the snippet, the validator gate sits between the model and the database." The probabilistic answer is "the model usually doesn't hallucinate." Those are different products.

This pattern should propagate. When new LLM-emitted data enters the system — a connector inferring intent type, a critic emitting a verdict, a future model classifying buyer archetypes — the right move is the same: model the audit status as a column, gate downstream readers on it, write the audit decision as its own row. Don't trust the model to mark its own work; build the seams that let the operator do it without leaving the tool.

---

## What this is not

It is not a CRM. It does not authenticate users, sync to Salesforce, send email through SMTP, or run as a multi-tenant SaaS. The decisions above are about what makes the *generation and audit* loop trustworthy. Distribution, sending, and team coordination are explicitly out of scope for v1.

What it *is* is a working demonstration that the GTM-engineering primitives — typed evidence, structural anti-hallucination, user-owned configuration, scoped LLM tool surfaces, immutable audit history — compose into a tool that an SDR can actually use, and that an SDR leader can actually steer, without engineering being on the critical path for every behavior change.
