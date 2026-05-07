# 5-minute demo — Linear

Goal: take a public company through every pipeline stage and show the resulting artifacts. A reviewer should be able to follow this script start-to-finish and reproduce the result.

Target: [Linear](https://linear.app) — well-known issue tracker, lots of public news, public LinkedIn posts from leadership, and a public hiring footprint. Replace with any public B2B company if you're recording your own.

**Total runtime:** ~5 minutes of operator time + ~60 seconds of LLM wait spread across the run.

## Pre-flight (skip if already up)

```bash
pnpm install                       # first time only
pnpm db:generate && pnpm db:migrate
pnpm dev                           # leave running in one terminal
export CLAUDE_MAX_CONCURRENT=3     # in another terminal
```

Open http://localhost:3000.

## 1. Create the account (15 s)

UI: **Accounts → New** → name=`Linear`, domain=`linear.app`. Click **Create**.

Expected: redirect to `/accounts/<id>`. The Evidence tab is empty; the Contacts tab is empty.

## 2. Auto-research (45 s)

UI: on the account page, click **Run auto-research**. The CLI subprocess kicks off; a spinner shows.

Wait ~30 s. The runner pulls the company homepage, an "about" page if present, and the top 3 news/funding/hiring search results, then extracts atomic facts from each source.

Expected: 8–20 evidence rows appear in the Evidence tab, each with a `source_url`, a `snippet` (≤1500 chars verbatim from the source), an `extracted_fact` (one sentence), and a `confidence` (`high | medium | low`). All rows show `extraction_status: pending_audit`.

## 3. Extraction audit (30 s)

UI: click **Run extraction audit on pending**. The Extraction Audit critic compares each `snippet` to its `extracted_fact` and decides whether the snippet supports the fact.

Wait ~15 s. Each row transitions to `verified` or `disputed`. Disputed rows show a `reason` (e.g. "snippet does not mention the cited number") and a `suggested_correction`.

Expected: most rows verify. Disputed rows are typically (a) facts inferred across multiple sentences, (b) numbers the auditor couldn't find verbatim, or (c) facts that drifted in extraction. Click into a disputed row and either **Accept correction**, **Override → verified** (if the auditor was wrong), or **Remove**.

## 4. Add a contact (15 s)

UI: **Contacts → Add**. Fill:

- Full name: any public Linear leader (CEO/CTO/CRO — real name from the evidence pack)
- Title: pulled from evidence
- Archetype: `leader` (or `enabler` if it's a head-of-ops type)

Click **Save**. The archetype is read by the drafter to choose the right frame (per principle P11 — match frame to buyer archetype).

## 5. Create a sequence (15 s)

UI: **Sequences → New**. Channels: `[email, linkedin, email]` (touch 1 + 2 + 3). Click **Create**.

Expected: 3 touches in `draft` status, each with `position` 1–3 and the channel you selected.

## 6. Draft each touch (60 s)

UI: click into each touch in turn and click **Draft**. Each call takes ~10–15 s.

Expected per touch: a `subject` (email only), a `body`, a `cited_evidence_ids` list, and a `supporting_spans` list. The UI renders the body with each cited claim highlighted and the cited evidence ID shown inline. If the validator caught any spans that weren't verbatim substrings, the drafter retried once with a correction message; remaining issues (rare) appear in an `Issues` panel.

If you see issues: don't click send. Either fix the underlying evidence (re-audit) or rewrite manually before continuing. The validator is intentionally a hard gate.

## 7. Run the critic panel on touch 1 (45 s)

UI: on touch 1, click **Run critics**. Three critics run in parallel:

- **Skeptical Buyer** (Sonnet) — "Would I delete this in 2 seconds?"
- **Sales Coach** (Sonnet) — scores the draft against every principle in `data/principles.md`, returning structured findings with a `principle_id` per failure.
- **Writing Editor** (Haiku) — concision, AI-tell phrases, active voice.

Wait ~20 s. Each critic returns a verdict (`pass | revise | reject`) and a list of findings (issue, quoted violation, suggested rewrite, principle ID where applicable).

## 8. Accept rewrites (30 s)

UI: in the critic panel, each suggested rewrite has an **Accept** button. Clicking it inserts a new revision in `touch_revisions`, updates the touch's `currentRevisionId`, and preserves the prior revision and its critiques.

Iterate until all three critics return `pass` (or until the remaining `revise` items are stylistic preferences you disagree with). Repeat for touches 2 and 3.

## 9. Export (15 s)

UI: on the sequence page, click **Export**. The `/api/export` route returns the artifacts as JSON; the UI downloads each:

- `touch-1.eml` — the email touch, RFC 5322 formatted (subject, content-type, body), ready to drag into Gmail
- `touch-2-linkedin.txt` — the LinkedIn DM, plain text
- `touch-3.eml` — the second email touch

Touch 1's body is also copied to your clipboard for immediate paste.

## What the reviewer should see at the end

- A `data/sales.db` with one new account, one contact, ~10–20 verified evidence rows, one sequence, three touches, multiple revisions per touch, and a critique row per (revision × critic).
- Three downloaded artifact files in your Downloads folder.
- A clipboard containing touch 1's body, ready to paste.
- An audit trail: every claim in every touch's current revision points at one or more `evidence.id` values whose `snippet` literally contains the cited span.

## Troubleshooting

**Auto-research returns no evidence:** the `claude` CLI is not authenticated. Run `claude` in a terminal once and complete the OAuth flow. Then retry.

**Drafter surfaces unfixable validator issues:** the model is rephrasing claims into something the snippet doesn't literally support. Either widen the snippet (re-research, accept a longer excerpt), or drop the claim. The validator is doing its job.

**Critic panel times out:** `CLAUDE_MAX_CONCURRENT` is too low or you're rate-limited. Wait 30 s and retry; bump the env var to 4 or 5 if your Max plan is fresh.

**Disputed rows you disagree with:** click **Override → verified**. The audit row records `resolvedBy: user_overrode` for traceability.
