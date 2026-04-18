# Sales Tool — Design Spec

**Date:** 2026-04-17
**Owner:** jin
**Status:** Draft — awaiting user review

## 1. Problem

Existing AI sales tools optimize for volume: faster drafts, more cadences, bigger blasts. The failure mode is fluent hallucination — confident emails that reference facts the model invented, creating embarrassment and trust damage with high-value prospects.

The goal is a **personal, local-first** sales tool for **small-volume, high-touch B2B outreach** where:

1. Every factual claim in an outbound message is backed by a stored, cited piece of evidence.
2. Every draft is evaluated against an explicit, user-owned set of sales principles.
3. Refinement happens through named critic perspectives, not opaque "make it better" rewrites.

## 2. Non-goals

- Multi-user, multi-tenant, or SaaS.
- Bulk sending, mail-merge cadences, blast outreach.
- CRM sync (Salesforce, HubSpot).
- Open/click/reply analytics (requires sending integration).
- Inbound triage or reply-handling.
- Cross-platform packaging — runs on the owner's macOS laptop.

## 3. Users and motion

- **Single user:** the owner, working B2B SaaS / high-ticket services outbound.
- **Volume:** ~20–40 deeply-researched accounts per month.
- **Channels:** cold email + LinkedIn DMs, with optional call-prep briefs as a side artifact.
- **Flow per account:** ingest → research → extract evidence → draft sequence → critique → export for manual send via Gmail / LinkedIn.

## 4. Architecture

Three layers plus a spine. Each layer has a strict contract; the LLM operates only on structured inputs and produces structured outputs that are validated before being persisted or shown.

### 4.1 Evidence layer (the spine)

A typed, append-only store. Every fact the drafter can cite lives here with its provenance.

**Schema (SQLite):**

```
evidence (
  id              TEXT PRIMARY KEY,   -- e.g. ev_20260417_a1b2c3
  account_id      TEXT NOT NULL,
  contact_id      TEXT,               -- nullable; account-level facts allowed
  source_url      TEXT NOT NULL,
  source_type     TEXT NOT NULL,      -- website|linkedin|news|10k|job_post|podcast|manual|perplexity|deep_research
  snippet         TEXT NOT NULL,      -- raw excerpt, ≤500 chars
  extracted_fact  TEXT NOT NULL,      -- one-sentence atomic claim
  confidence      TEXT NOT NULL,      -- high|medium|low
  captured_at     TIMESTAMP NOT NULL,
  captured_by     TEXT NOT NULL,      -- auto|manual|claude_web_fetch|perplexity_mcp|chatgpt_mcp
  superseded_by   TEXT                -- nullable FK to newer evidence row
)
```

**Three intake paths, all writing to the same table:**

1. **Auto-research** — Claude Code agent runs with `WebFetch`, `WebSearch`, and optional Perplexity MCP tools; extracts atomic facts from retrieved pages; writes rows with `captured_by = claude_web_fetch` or `perplexity_mcp`.
2. **Manual paste** — UI textarea accepts URL + raw text; LLM extracts atomic facts preserving the URL; writes rows with `captured_by = manual`.
3. **Deep Research import** — UI accepts a ChatGPT Deep Research report; a parsing routine splits the report into cited paragraphs, extracts each citation's URL + snippet, and writes rows with `captured_by = chatgpt_mcp` (or `manual` when pasted).

**Hard invariant enforced in code:**

- The drafter prompt is constructed from a filtered list of `(evidence_id, extracted_fact)` pairs scoped to the account and contact.
- The drafter must cite `evidence_id`s in its structured output.
- A post-generation validator parses the output, confirms every cited ID exists in the input set, and rejects the draft otherwise. Rejections are retried once, then surfaced to the user.

### 4.2 Drafting layer

**Unit:** a `Sequence` belongs to an `Account` and contains N ordered `Touches`. Each touch is either `email` or `linkedin`.

**Drafter input (per touch):**

- ICP brief (markdown, hand-authored, account-agnostic)
- Account evidence pack (atomic facts + IDs only, not raw snippets, to reduce token use)
- Contact evidence pack (if a specific contact is targeted)
- Principles file (markdown, see §4.4)
- Position in sequence (touch 1 of 5, etc.)
- Prior touches in the thread (subject + body)

**Drafter output (JSON):**

```json
{
  "subject": "string (email only)",
  "body": "string",
  "channel": "email|linkedin",
  "cited_evidence_ids": ["ev_...", "ev_..."],
  "rationale": "string — why this touch, why this angle, why this CTA"
}
```

Rationale is logged for audit, never shown in the final export.

**Call-prep brief** is a separate artifact generated on demand from the same evidence pack. It produces: (a) three openers tied to specific evidence, (b) five discovery questions linked to evidence IDs, (c) likely objections and how to handle them.

### 4.3 Critic panel

Three named critics run sequentially (or in parallel) over a draft. Each is a separate LLM call with a tight rubric and a structured output. No silent auto-rewriting — the UI surfaces each critic's verdict as an accept/reject diff.

**Critic 1 — Skeptical Buyer (Claude Sonnet 4.6)**
Prompt persona: the recipient. Rubric: would I delete this in under 2 seconds? Flags generic compliments, vague value props, hidden or unclear CTAs, anything that smells like a template.

**Critic 2 — Sales Coach (Claude Sonnet 4.6)**
Loads `principles.md`. For each principle, returns `{principle_id, verdict: pass|fail|n/a, evidence: "quote from draft", suggested_rewrite}`. Fully rubric-driven; the rubric is user-owned.

**Critic 3 — Writing Editor (Claude Haiku 4.5)**
Concision, specificity, removing AI-tells ("I hope this finds you well", "I came across", "I noticed that"). Haiku is chosen because rubric-grading doesn't need Sonnet-level reasoning and Max 20 rate limits are kinder on Haiku.

**Optional Critic 4 — Second-Model Skeptic (GPT-5 via ChatGPT MCP, v1.1)**
Runs the Skeptical Buyer rubric through a different model family to catch blind spots Claude shares with itself. Disabled by default; promote once the MCP proves stable.

Each critic returns:

```json
{
  "verdict": "pass|revise|reject",
  "findings": [
    { "issue": "string", "quote": "string from draft", "suggested_rewrite": "string" }
  ]
}
```

### 4.4 Principles file

`data/principles.md` — version-controlled, hand-edited by the owner. Starter principles (replace freely):

1. Lead with a specific observation, never with a compliment.
2. One CTA per email. Ask the reader to do exactly one thing.
3. Earn the right to ask — offer value before the ask.
4. No fake personalization ("I saw your post about X" when you didn't read it).
5. Specificity beats cleverness.
6. Respect the reader's time. ≤120 words for a cold email.
7. Reference something that happened in the last 90 days when possible.
8. CTA is low-commitment on touch 1, higher on later touches.
9. If you can't say why this prospect and not 50 others, don't send.
10. No AI-tell phrases: "I hope this finds you well", "I came across", "just wanted to reach out", "circle back".

Principles are the single source of truth for the Sales Coach critic.

## 5. Data model

Six SQLite tables. Plain SQL, no migration framework.

```
accounts (id, name, domain, industry, size, notes, created_at)
contacts (id, account_id, full_name, title, linkedin_url, email, notes, created_at)
evidence (see §4.1)
sequences (id, account_id, status, created_at)
touches (id, sequence_id, position, channel, subject, body, status, created_at, sent_at)
critiques (id, touch_id, critic_name, verdict, findings_json, created_at)
```

Stored at `./data/sales.db` and gitignored.

## 6. Tech stack

| Concern | Choice | Rationale |
|---|---|---|
| Runtime / UI | **Next.js 16 (App Router) + React 19** | Local web UI beats CLI for review/edit ergonomics; API routes co-located |
| Styling / components | **Tailwind + shadcn/ui** | Craft-quality defaults, no wasted time on CSS |
| Database | **SQLite via better-sqlite3** (synchronous, single-writer) with **Drizzle ORM** | Simplest possible persistence for a single-user local tool |
| LLM runtime | **Claude Agent SDK** (headless Claude Code) | Powers all LLM calls via Max 20 subscription; no per-token API billing |
| Web research | Claude Code built-in `WebFetch` + `WebSearch`; **Perplexity MCP** as a Sonar-backed augmenter | Uses Perplexity Pro's included API credits |
| Premium research | **ChatGPT Plus Deep Research** (manual paste in v1; community ChatGPT MCP in v1.1) | Uses Plus's ~25 Deep Research runs/month for top-priority accounts |
| Second-model critic | **GPT-5 via ChatGPT MCP** (v1.1, feature-flagged) | Catches blind spots Claude shares with itself |
| Sending | **Copy-to-clipboard + `.eml` file export** | Keeps replies in the owner's real Gmail inbox; avoids OAuth complexity |
| Auth | **None** (localhost only) | Single-user personal tool |
| Deploy | `pnpm dev`, runs on `http://localhost:3000` | No cloud deploy; evidence includes private notes |

## 7. Key flows

### 7.1 Add an account

1. User clicks "New Account", enters name + domain.
2. Tool creates `accounts` row.
3. Optional: user kicks off "Auto-research" — agent run with WebFetch + WebSearch + Perplexity MCP, writes ~10-30 evidence rows.
4. Optional: user triggers a Deep Research run in ChatGPT Plus, pastes the report; parser splits into evidence rows.

### 7.2 Add a contact

1. User pastes a LinkedIn URL on the account page.
2. Tool fetches the page (WebFetch) and extracts role, tenure, recent posts → contact row + evidence rows.
3. Manual editing is always allowed.

### 7.3 Draft a sequence

1. User clicks "New Sequence", picks channels per touch (e.g., `[email, linkedin, email]`).
2. For each touch, the drafter runs with the full evidence pack, principles, and prior touches.
3. Validator rejects any draft citing unknown evidence IDs; retried once, then surfaced to the user for manual review.
4. Drafts land in an editable UI alongside their `cited_evidence_ids` (hoverable pills linking back to source URL + snippet).

### 7.4 Critique a touch

1. User clicks "Run Critics" on a touch.
2. Critics 1–3 run (parallel when Max 20 allows, sequential otherwise).
3. UI shows three panels side-by-side with findings + proposed rewrites.
4. User accepts/rejects each suggestion inline; accepted rewrites update the touch; critique history stored in `critiques`.

### 7.5 Export

1. User clicks "Export" on a sequence.
2. Tool generates `.eml` files (one per email touch) + a plain-text block for each LinkedIn touch.
3. Also copies touch 1 to clipboard for immediate paste into Gmail or LinkedIn.

## 8. Cost model

| Item | Cost |
|---|---|
| Claude Agent SDK runtime (Sonnet 4.6, Haiku 4.5, occasional Opus 4.7) | $0 marginal — uses existing Claude Code Max 20 plan |
| Perplexity research | $0 marginal — Pro plan's $5/mo API credits cover expected usage |
| ChatGPT Deep Research + GPT-5 critic | $0 marginal — uses existing Plus plan (~25 Deep Research/mo) |
| Exa, Apollo, Clay, SMTP, hosting | Not used in v1 |
| **Total new recurring spend** | **$0/month** |

Future Apollo add-on ($49/mo) gated on "manual contact lookup has become the bottleneck for ≥2 weeks."

## 9. Rate-limit and failure behavior

- **Max 20 rate limit hit** — agent run pauses, surfaces a "retry in X minutes" message, preserves all evidence already captured.
- **WebFetch 4xx/5xx** — logs the failure, skips the source, continues with remaining sources; no partial evidence row created.
- **Validator rejects draft** — retry once with an explicit "you cited evidence IDs that don't exist; here's the full list" correction. If second attempt fails, surface the raw output for manual editing rather than silently discarding.
- **Perplexity MCP unavailable** — degrade to WebFetch + WebSearch only; log a warning on the account page.
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

## 12. Open questions

None blocking. v1.1 items above are deferred by design, not by ambiguity.

## 13. Success criteria

- Zero unsourced claims in generated drafts (measured by validator rejection rate staying at 0 after the first week of usage).
- Owner sends ≥20 drafted sequences in the first month without rewriting touch 1 from scratch more than 20% of the time.
- Principles file is edited at least twice in the first month — indicating it's serving as a living rubric, not a set-and-forget config.
- Marginal monthly cost stays at $0.
