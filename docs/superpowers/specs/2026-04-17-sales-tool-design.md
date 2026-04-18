# Sales Tool — Design Spec

**Date:** 2026-04-17
**Owner:** jin
**Status:** Draft v2 — revised after independent GPT review (see §15 changelog)

## 1. Problem

Existing AI sales tools optimize for volume: faster drafts, more cadences, bigger blasts. The failure mode is fluent hallucination — confident emails that reference facts the model invented, creating embarrassment and trust damage with high-value prospects.

The goal is a **personal, local-first** sales tool for **small-volume, high-touch B2B outreach** where:

1. Every factual claim in an outbound message is backed by a stored, cited piece of evidence — and the chain from source text → cited claim → final draft is verifiable end-to-end.
2. Every draft is evaluated against an explicit, user-owned set of sales principles.
3. Refinement happens through named critic perspectives, not opaque "make it better" rewrites.
4. Every change to a draft is preserved in revision history so that critique audit trails remain intact.

## 2. Non-goals

- Multi-user, multi-tenant, or SaaS.
- Bulk sending, mail-merge cadences, blast outreach.
- CRM sync (Salesforce, HubSpot).
- Open/click/reply analytics (requires sending integration).
- Inbound triage or reply-handling.
- Cross-platform packaging — runs on the owner's macOS laptop.
- Redistribution as a product to third parties (see §6.1 ToS).

## 3. Users and motion

- **Single user:** the owner, working B2B SaaS / high-ticket services outbound.
- **Volume:** ~20–40 deeply-researched accounts per month.
- **Channels:** cold email + LinkedIn DMs, with optional call-prep briefs as a side artifact.
- **Flow per account:** ingest → research → extract evidence → draft sequence → critique → export for manual send via Gmail / LinkedIn.

## 4. Architecture

Three layers plus a spine. Each layer has a strict contract; the LLM operates only on structured inputs and produces structured outputs that are validated before being persisted or shown.

### 4.1 Evidence layer (the spine)

A typed, append-only store. Every fact the drafter can cite lives here with its provenance. Both the **paraphrased atomic claim** (`extracted_fact`) and the **raw source excerpt** (`snippet`) travel together through the entire pipeline — drafting, validation, and critique all see the snippet as ground truth.

**Schema (SQLite):**

```
evidence (
  id              TEXT PRIMARY KEY,    -- e.g. ev_20260417_a1b2c3
  account_id      TEXT NOT NULL,
  contact_id      TEXT,                -- nullable; account-level facts allowed
  source_url      TEXT NOT NULL,
  source_type     TEXT NOT NULL,       -- website|linkedin|news|10k|job_post|podcast|manual|perplexity|deep_research
  snippet         TEXT NOT NULL,       -- raw excerpt verbatim from the source, ≤1500 chars
  extracted_fact  TEXT NOT NULL,       -- one-sentence atomic claim derived from snippet
  extraction_status TEXT NOT NULL,     -- pending_audit|verified|disputed (see §4.3 Critic 4)
  confidence      TEXT NOT NULL,       -- high|medium|low
  captured_at     TIMESTAMP NOT NULL,
  captured_by     TEXT NOT NULL,       -- claude_cli|manual|perplexity_mcp|chatgpt_mcp|deep_research_paste
  superseded_by   TEXT                 -- nullable FK to newer evidence row
)
```

Snippet cap raised to 1500 chars to give the drafter and Extraction Audit critic enough surrounding context to verify claims, not just key in on a fragment.

**Three intake paths, all writing to the same table:**

1. **Auto-research** — Claude CLI agent run with `WebFetch`, `WebSearch`, and optional Perplexity MCP tools; extracts atomic facts from retrieved pages; writes rows with `captured_by = claude_cli` or `perplexity_mcp` and `extraction_status = pending_audit`.
2. **Manual paste** — UI textarea accepts URL + raw text; LLM extracts atomic facts preserving the URL; writes rows with `captured_by = manual` and `extraction_status = pending_audit`.
3. **Deep Research import** — UI accepts a ChatGPT Deep Research report; a parsing routine splits the report into cited paragraphs, extracts each citation's URL + snippet, and writes rows with `captured_by = chatgpt_mcp` (or `deep_research_paste`) and `extraction_status = pending_audit`.

All three paths produce rows in `pending_audit` status. The **Extraction Audit critic** (§4.3) flips them to `verified` or `disputed` before they're allowed into a drafter run.

**Hard invariants enforced in code (the validator):**

- The drafter prompt is constructed from a filtered list of `verified` evidence rows scoped to the account/contact, providing both `extracted_fact` AND `snippet` (not just the paraphrase).
- The drafter must cite `evidence_id`s in its structured output.
- The drafter must emit a `supporting_spans` array — one entry per cited evidence ID, each containing a verbatim substring of that evidence row's `snippet` that backs the claim being made.
- The validator runs three checks:
  1. Every `cited_evidence_id` exists in the input set and is `verified`.
  2. Every `supporting_span` is an exact substring (case-insensitive, whitespace-normalized) of the `snippet` for its cited evidence row.
  3. Every personalized claim sentence in the body has at least one supporting span attached.
- Failed validation triggers a single retry with an explicit error message ("span X not found in snippet for evidence Y; either revise the claim or pick a different supporting span"). If the second attempt fails, the draft is surfaced raw with a banner explaining what failed; nothing is silently dropped or auto-rewritten.

### 4.2 Drafting layer

**Unit:** a `Sequence` belongs to an `Account` and contains N ordered `Touches`. Each `Touch` has an immutable list of `TouchRevisions` (see §5).

**Drafter input (per touch):**

- ICP brief (markdown, hand-authored, account-agnostic)
- Account evidence pack — `verified` evidence rows for the account, each as a struct of `{id, source_url, source_type, snippet, extracted_fact}`. Snippets are included in full.
- Contact evidence pack — same shape, scoped to the contact if specified.
- Principles file (markdown, see §4.4)
- Position in sequence (touch 1 of 5, etc.)
- Prior touches in the thread (subject + body + cited_evidence_ids of the latest revision of each prior touch)

**Drafter output (JSON):**

```json
{
  "subject": "string (email only; null for linkedin)",
  "body": "string",
  "channel": "email|linkedin",
  "cited_evidence_ids": ["ev_...", "ev_..."],
  "supporting_spans": [
    { "evidence_id": "ev_...", "span": "verbatim substring of that row's snippet", "claim": "the sentence in body that this span supports" }
  ],
  "rationale": "string — why this touch, why this angle, why this CTA"
}
```

`rationale` is logged and persisted on the revision but never shown in the final exported text.

**Call-prep brief** is a separate artifact generated on demand from the same evidence pack. It produces: (a) three openers tied to specific evidence, (b) five discovery questions linked to evidence IDs with supporting spans, (c) likely objections and how to handle them. Stored as `call_prep_briefs` rows linked to the contact.

### 4.3 Critic panel

Four critics. Three score drafts; one audits evidence extraction. Each is a separate LLM call with a tight rubric and structured output. No silent auto-rewriting — the UI surfaces each critic's verdict as an accept/reject diff against the current touch revision, and accepting any rewrite creates a new immutable revision.

**Critic 1 — Skeptical Buyer (Claude Sonnet 4.6)**
Persona: the recipient. Rubric: would I delete this in under 2 seconds? Flags generic compliments, vague value props, hidden or unclear CTAs, anything that smells like a template.

**Critic 2 — Sales Coach (Claude Sonnet 4.6)**
Loads `principles.md`. For each principle, returns `{principle_id, verdict: pass|fail|n/a, quoted_violation, suggested_rewrite}`. Fully rubric-driven; the rubric is user-owned.

**Critic 3 — Writing Editor (Claude Haiku 4.5)**
Concision, specificity, removing AI-tells ("I hope this finds you well", "I came across", "I noticed that"). Haiku because rubric-grading doesn't need Sonnet-level reasoning.

**Critic 4 — Extraction Audit (Claude Haiku 4.5)** *(new in v2)*
Runs over evidence rows in `pending_audit` status, **not** drafts. For each row, compares `extracted_fact` against `snippet` and returns:
```json
{
  "evidence_id": "ev_...",
  "verdict": "verified|disputed",
  "reason": "string — what part of the fact is or isn't supported by the snippet",
  "suggested_correction": "string — a more accurate fact, if disputable"
}
```
`verified` rows become draftable. `disputed` rows surface in a queue for the user to either accept the correction, edit the fact manually, or remove the row. **No row enters a drafter run until it's verified.** This closes the extraction-boundary hallucination gap.

**Optional Critic 5 — Second-Model Skeptic (GPT-5 via ChatGPT MCP, v1.1)**
Runs the Skeptical Buyer rubric through a different model family to catch blind spots Claude shares with itself. Disabled by default; promote once the MCP proves stable.

**Standard critic output schema (Critics 1–3, 5):**

```json
{
  "verdict": "pass|revise|reject",
  "findings": [
    { "issue": "string", "quote": "string from draft", "suggested_rewrite": "string", "principle_id": "P3 or null" }
  ]
}
```

### 4.4 Principles file

`data/principles.md` — version-controlled, hand-edited by the owner. Seeded with 12 Zuhn-sourced principles (P1–P12) at project start; see `data/principles.md` for the canonical set. Principles are the single source of truth for the Sales Coach critic.

## 5. Data model

Nine SQLite tables. Plain SQL, no migration framework.

```
accounts (
  id, name, domain, industry, size, notes, created_at
)

contacts (
  id, account_id, full_name, title, linkedin_url, email,
  archetype,            -- gatekeeper|business_user|enabler|leader|unknown   (new in v2)
  notes, created_at
)

evidence (see §4.1, includes extraction_status)

sequences (id, account_id, status, created_at)

touches (
  id, sequence_id, position, channel, status,
  current_revision_id,  -- FK into touch_revisions
  created_at, sent_at
)

touch_revisions (                                              -- new in v2
  id, touch_id, revision_number,
  subject, body,
  cited_evidence_ids JSON,
  supporting_spans   JSON,
  rationale          TEXT,
  created_at,
  created_by         -- drafter|critic_rewrite|manual_edit
)

critiques (
  id, touch_revision_id,                                       -- FK changed to revision (was touch_id)
  critic_name,                                                 -- skeptical_buyer|sales_coach|writing_editor|second_model_skeptic
  verdict,
  findings_json,
  created_at
)

extraction_audits (                                            -- new in v2
  id, evidence_id, verdict, reason, suggested_correction,
  resolved_by,          -- nullable: auto|user_accepted|user_overrode|user_removed
  created_at
)

call_prep_briefs (
  id, contact_id, openers_json, discovery_questions_json, objections_json, created_at
)
```

Stored at `./data/sales.db` and gitignored. `data/principles.md` is tracked in git.

**Why immutable revisions matter:** When the user accepts a critic-suggested rewrite, the touch's `current_revision_id` advances to a new row; the prior revision and any critiques pointing at it remain unchanged. This preserves the audit trail — for any past critique you can see exactly which body it evaluated.

## 6. Tech stack

| Concern | Choice | Rationale |
|---|---|---|
| Runtime / UI | **Next.js 16 (App Router) + React 19** | Local web UI beats CLI for review/edit ergonomics; API routes co-located |
| Styling / components | **Tailwind + shadcn/ui** | Craft-quality defaults, no wasted time on CSS |
| Database | **SQLite via better-sqlite3** with **Drizzle ORM** | Synchronous, single-writer; ideal for single-user local |
| LLM runtime | **Headless `claude` CLI** invoked via `child_process.spawn` from Next.js API routes | See §6.1 for mechanism detail |
| Agent skills | A directory of Claude Code-compatible skills (`research-account`, `extract-evidence`, `draft-touch`, `critique-touch`, `audit-extraction`) loaded by the CLI per invocation | Keeps prompts in the filesystem, version-controlled, hand-tunable |
| Web research | Claude CLI's built-in `WebFetch` + `WebSearch`; **Perplexity MCP** as Sonar-backed augmenter | Subscription-powered when API credits available; falls back per §8 |
| Premium research | **ChatGPT Plus Deep Research** (manual paste in v1; community ChatGPT MCP in v1.1) | Variable plan-dependent allowance, treated as best-effort capacity |
| Second-model critic | **GPT-5 via ChatGPT MCP** (v1.1, feature-flagged) | Catches blind spots Claude shares with itself |
| Sending | **Copy-to-clipboard + `.eml` file export** | Keeps replies in the owner's real Gmail inbox; avoids OAuth complexity |
| Auth | **None** (localhost only) | Single-user personal tool |
| Deploy | `pnpm dev`, runs on `http://localhost:3000` | No cloud deploy; evidence includes private notes |

### 6.1 LLM runtime mechanism (precise)

The Next.js backend invokes the Claude CLI as a subprocess for each LLM call. There is **no** direct use of the Anthropic API and **no** API key billing. Concretely:

```ts
// Pseudocode — actual wrapper lives in lib/claude/run.ts
const result = await spawnClaude({
  prompt: renderPromptFromTemplate(...),
  skill: 'draft-touch',
  outputFormat: 'json',
  model: 'sonnet',         // or 'haiku' / 'opus' per critic config
});
```

Under the hood this runs `claude --print --output-format json --model sonnet …` (or the equivalent SDK bridge), which authenticates via the local Claude Code installation's existing OAuth session — i.e., the owner's Max 20 subscription. Output is parsed as JSON and validated against the appropriate Zod schema before persistence.

**Practical implications:**
- The Next.js process must be running on a machine where `claude` is installed and the user is logged in. Trivial: it's the owner's laptop.
- Rate limits are Max 20's rate limits, not API rate limits. Quota errors are surfaced as retryable failures (§9).
- Concurrent CLI processes are limited (Max 20 supports a few in flight) — the orchestration layer queues calls with a small concurrency cap (default 3).

### 6.2 ToS and personal-use scope

This tool is built for a **single user (the owner) automating their own outreach** using their own subscriptions. It is **not** a product for third parties. Key constraints:

- The tool runs only on the owner's machine, bound to localhost.
- The Claude CLI subprocess uses the owner's Claude Code OAuth session.
- The Perplexity MCP server uses the owner's Perplexity Pro account.
- The ChatGPT MCP server (v1.1) uses the owner's ChatGPT Plus account.
- No backend is exposed publicly; no other users can authenticate or trigger LLM calls through this tool.

If the tool is ever extended for additional users, those users must each authenticate against their own Claude / Perplexity / ChatGPT accounts, OR the tool must switch to direct paid API billing per provider.

## 7. Key flows

### 7.1 Add an account

1. User clicks "New Account", enters name + domain.
2. Tool creates `accounts` row.
3. Optional: user kicks off "Auto-research" — Claude CLI agent run with `WebFetch` + `WebSearch` + Perplexity MCP, writes ~10–30 evidence rows in `pending_audit` status.
4. Optional: user triggers a Deep Research run in ChatGPT Plus, pastes the report; parser splits into evidence rows in `pending_audit`.
5. Extraction Audit critic runs automatically over new `pending_audit` rows; user reviews `disputed` rows in the audit queue.

### 7.2 Add a contact

1. User pastes a LinkedIn URL on the account page.
2. Tool fetches the page (Claude CLI's `WebFetch`) and extracts role, tenure, recent posts → `contacts` row + `evidence` rows in `pending_audit`.
3. Tool prompts user to set `archetype` (gatekeeper / business_user / enabler / leader / unknown). Default `unknown`; can be set later.
4. Manual editing of any field is always allowed.

### 7.3 Draft a sequence

1. User clicks "New Sequence", picks channels per touch (e.g., `[email, linkedin, email]`).
2. For each touch, the drafter runs with the full `verified` evidence pack, principles, and prior touches.
3. Validator runs the three checks in §4.1. Failures retry once with explicit error context; second failure surfaces raw output.
4. The validated draft is persisted as `touch_revisions` row #1 with `created_by = drafter`.
5. UI renders the touch alongside its `cited_evidence_ids` (hoverable pills linking back to source URL + snippet) and `supporting_spans` (highlighted in the body).

### 7.4 Critique a touch

1. User clicks "Run Critics" on a touch.
2. Critics 1–3 run against the **current revision**, sequentially (or up to 3-way parallel within Max 20 limits).
3. UI shows three panels side-by-side with findings + proposed rewrites.
4. User accepts/rejects each suggestion inline. Accepting any suggestion creates a **new `touch_revisions` row** with `created_by = critic_rewrite`; the touch's `current_revision_id` advances; prior revision and its critiques remain untouched.
5. Manual edits in the UI also create new revisions with `created_by = manual_edit`.

### 7.5 Export

1. User clicks "Export" on a sequence.
2. Tool generates `.eml` files (one per email touch, using the current revision's subject + body) + a plain-text block for each LinkedIn touch.
3. Also copies touch 1 to clipboard for immediate paste into Gmail or LinkedIn.

## 8. Cost model

The architecture is designed to run primarily on subscriptions the owner already pays for. Marginal cost depends on whether subscription-included allowances cover usage.

| Item | Mechanism | Best case | Realistic | Worst case |
|---|---|---|---|---|
| Claude CLI runtime (Sonnet 4.6, Haiku 4.5, occasional Opus 4.7) | Max 20 subscription via local CLI | $0 marginal | $0 marginal | $0 marginal (rate-limited rather than billed) |
| Perplexity research (Sonar via MCP) | Pro account API credits if/when included; otherwise paid Sonar API | $0 if Pro covers usage | $5–10/mo | $20/mo at heavy use |
| ChatGPT Deep Research | Plus plan, dynamic in-product allowance | Free within Plus quota | $0 | $20/mo if user upgrades to Pro for higher allowance |
| Anthropic API fallback | Used if Max 20 rate limits block critical work | $0 (rare) | $0–10/mo | $30–50/mo on heavy weeks |
| Apollo (deferred) | Optional contact enrichment, not in v1 | $0 | $0 | $49/mo if added later |
| Hosting / DB / SMTP | Local | $0 | $0 | $0 |

**Total marginal recurring spend, expected: $0–15/month. Bounded worst case (all fallbacks engaged + Apollo): ~$80–120/month.**

The earlier draft's "$0/month guaranteed" claim was overconfident. Subscription allowances change; treat them as best-effort capacity. The architecture stays the same regardless — only the variable layer's funding changes.

Apollo addition is gated on "manual contact lookup is the bottleneck for ≥2 weeks of actual use."

## 9. Rate-limit and failure behavior

- **Max 20 rate limit hit** — Claude CLI exits with a quota error; orchestration layer catches it, surfaces a "retry in N minutes" banner, and preserves all evidence already captured. Pending drafter runs queue rather than fail.
- **WebFetch 4xx/5xx** — logs the failure, skips the source, continues with remaining sources; no partial evidence row created.
- **Validator rejects draft** — retry once with an explicit "span X not in snippet for evidence Y" correction. Second failure surfaces the raw output for manual review/editing rather than silently discarding.
- **Extraction Audit disputes a row** — row remains in the audit queue with status `disputed`; user resolves before that row can enter a drafter run. Drafter runs that depend on disputed rows wait or proceed without them.
- **Perplexity MCP unavailable** — degrade to Claude CLI's WebFetch + WebSearch only; log a warning on the account page.
- **ChatGPT MCP unavailable (v1.1)** — degrade to manual paste flow; no hard dependency.

## 10. Out of scope for v1

- SMTP / Gmail / Outlook sending integration
- CRM sync
- Analytics (open/click/reply tracking)
- Multi-user, auth, multi-tenancy
- Mobile / desktop packaging
- Apollo / Clay / ZoomInfo integration
- Automated LinkedIn DM sending (manual copy-paste only)
- Inbound reply triage

## 11. v1.1 roadmap (post-MVP)

- Wire `199-mcp/mcp-chatgpt` behind a feature flag; promote to default after 2 weeks of stability.
- Automate Deep Research triggering via the MCP for top-priority accounts.
- Add the Second-Model Skeptic critic (GPT-5) to the critic panel.
- Consider Apollo integration if manual contact lookup has been the bottleneck.
- Cross-revision diff view in the touches UI (see what changed between revision N and N+1).

## 12. Open questions

None blocking. v1.1 items above are deferred by design, not by ambiguity.

## 13. Success criteria

- **Anti-hallucination integrity:** zero published touches that reference an unsourced fact. Measured by: (a) validator rejection rate stays at 0 after the first week; (b) a monthly spot-check audit of 5 random sent touches finds zero claims that don't trace to a verified evidence row.
- **Throughput:** owner publishes ≥20 sequences in the first month without rewriting touch 1 from scratch in more than 20% of cases.
- **Living rubric:** principles file is edited at least twice in the first month — indicating it's serving as a living rubric, not a set-and-forget config.
- **Cost discipline:** marginal spend stays within the "realistic" column of §8 ($0–15/month) for 3 consecutive months. Crossing into the "worst case" range triggers an architecture review.

## 14. References to companion artifacts

- `data/principles.md` — 12 Zuhn-sourced principles with stable IDs (P1–P12)
- (Future) `docs/superpowers/plans/2026-04-17-sales-tool-plan.md` — implementation plan, written next via writing-plans skill
- (Future) `skills/` — Claude Code skills directory: `research-account`, `extract-evidence`, `draft-touch`, `critique-touch`, `audit-extraction`

## 15. Changelog

**v2 (2026-04-17, post-GPT-review)**

- **F1:** Replaced ambiguous "Claude Agent SDK" language with precise "headless `claude` CLI invoked via `child_process.spawn`" mechanism (§6.1). Added §6.2 ToS and personal-use scope.
- **F2:** Closed the extraction-boundary hallucination gap. Snippet now travels with the fact through drafting (§4.2). Drafter must emit `supporting_spans` — verbatim substrings of snippets that back each claim. Validator verifies span-is-substring as a hard check (§4.1). New Extraction Audit critic (§4.3 Critic 4) gates evidence rows from `pending_audit` to `verified` before they're draftable. Snippet cap raised to 1500 chars for adequate context.
- **F3:** Cost model rewritten with best/realistic/worst columns (§8). Removed "$0/month guaranteed" overclaim. Added bounded worst case.
- **F4:** Draft provenance now persisted: `cited_evidence_ids`, `supporting_spans`, `rationale` stored on `touch_revisions` rows (§5).
- **F5:** Critique history made version-safe via new `touch_revisions` table. `critiques.touch_revision_id` replaces `critiques.touch_id`; touches are immutable per revision; accepting a rewrite creates a new revision rather than mutating the touch (§5, §7.4).
- **F6:** Added `archetype` column to `contacts` (§5). Add-contact flow prompts for archetype (§7.2). Aligns with principle P11.
- **Schema additions:** `touch_revisions`, `extraction_audits`, `call_prep_briefs` tables. Total table count: 9 (was 6).

**v1 (2026-04-17)**

- Initial spec from brainstorming session.
