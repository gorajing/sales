# Sales Tool — AI Sales Automation Revamp Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Sales tool from "personal local-first outreach" to an SDR-side reference architecture that demonstrates the primitives shared across AI sales, GTM engineering, and sales automation roles (inbound signal ingestion, lead scoring with auditable rationale, rules-based routing, tier-transition alerts, real GitHub + stubbed CRM/SEP/marketing connectors, engagement-outcome feedback into the drafter), then use the tool on itself to apply to whichever target company is highest priority.

**Architecture:** Additive layers on the existing Evidence spine. New tables (`lead_scores`, `routing_assignments`, `alerts`, `engagement_events`) reference existing `accounts`/`contacts`/`evidence`. Routing rules live as Markdown (`data/routing-rules.md`) parsed in-memory — there is no `routing_rules` DB table. New `lib/scoring`, `lib/routing`, `lib/alerts`, `lib/connectors`, `lib/engagement` modules; each has the same Zod-typed I/O + dependency-injected `spawn` pattern as the existing drafter. All Claude calls go through the existing `lib/claude/run.ts` subprocess runner. New webhook + connector interface ingests typed `SignalPayload`s that become Evidence rows tagged with `signalType`. Alerts dispatch to Slack/email/webhook with file-based fallback when secrets are unset.

**Tech Stack:** TypeScript, Next.js 16 App Router, Drizzle ORM, better-sqlite3, Zod, Vitest, pnpm, `claude` CLI. New deps: `@octokit/rest` (GitHub). Scheduling is delegated to host cron / launchd / Task Scheduler invoking `pnpm tsx scripts/poll-connectors.ts`; no in-process scheduler.

**Scope:** Phase 0 (repackage) + Phase 1 (inbound/scoring/routing) + Phase 2 (alerts) + Phase 3 (connectors) + Phase 4 (engagement loop) + Phase 6 (closed-loop application demo). Phase 5 (auth/RBAC) is optional and out of scope for this plan; cut it if timeline demands.

**Out of scope explicitly:** real Salesforce/HubSpot/Outreach API integrations (stubs only), SaaS/multi-tenant DB, real email send (still .eml export), Postgres migration, full CI/CD beyond `pnpm typecheck && pnpm test && pnpm build`.

**Deployment security (read before deploying anything beyond `localhost`):**

The plan ships with optional shared-secret auth on **HTTP write endpoints**. **For local development the secrets are intentionally unset, which makes the endpoints permissive.** Before exposing any of this to a network you do not control:

1. Set every secret env var: `SIGNAL_WEBHOOK_SECRET`, `ENGAGEMENT_WEBHOOK_SECRET`, `INTERNAL_API_SECRET`. Each is checked by the matching route — without them, requests are unauthenticated.
2. Confirm the auth gates fire by sending an unsigned request and expecting 401.
3. Trusted-source verification (signal → `extractionStatus = 'verified'`) is gated on **both** a `TRUSTED_SOURCES` source label **and** an authenticated sender. Without `SIGNAL_WEBHOOK_SECRET`, every signal goes through extraction audit. This is the desired behavior — do not weaken it.
4. The `application/`, `outbox/`, and `data/sales.db*` paths must remain gitignored (Task 0.1.3 + existing `.gitignore`).
5. HMAC-signed webhooks with timestamp replay protection are deferred to v1.5; for v1, use a private DNS / VPN / Cloudflare Tunnel instead of bare exposure.
6. **Server actions are NOT covered by the shared-secret gates.** The `/alerts` page exposes a write-capable server action (`acknowledgeAction`) that calls `acknowledgeAlert()` directly. Server actions cannot read `INTERNAL_API_SECRET` from the browser without embedding it in HTML, so the page itself must be the trust boundary. **If you deploy `/alerts` to anything beyond localhost, you MUST gate the page** at the proxy/middleware layer (Cloudflare Access, OAuth proxy, Next.js middleware checking a session cookie, etc.). Removing the page action and routing all acks through the HTTP API is an acceptable alternative.

---

## File structure (target — new and modified)

```
Sales/
├── data/
│   ├── principles.md                         (existing)
│   ├── icp.md                                (existing)
│   ├── scoring-rules.md                      NEW — user-editable scoring weights
│   ├── routing-rules.md                      NEW — user-editable routing predicates
│   ├── alert-rules.md                        NEW — user-editable alert triggers
│   ├── github-watch.md                       NEW — GitHub orgs/repos to watch
│   └── principle-outcomes.md                 NEW — generated nightly from engagement
├── db/
│   ├── schema.ts                             MODIFY — add 4 tables (lead_scores, routing_assignments, alerts, engagement_events), extend evidence
│   ├── migrations/0003_signals_scoring.sql   NEW (auto-generated, Task 1.1)
│   └── migrations/0004_engagement.sql        NEW (auto-generated, Task 4.1)
├── lib/
│   ├── signals/
│   │   ├── ingest.ts                         NEW — webhook signal → evidence row
│   │   └── types.ts                          NEW — SignalPayload Zod schema
│   ├── scoring/
│   │   ├── score.ts                          NEW — scoring engine
│   │   ├── rules.ts                          NEW — parses scoring-rules.md
│   │   └── decay.ts                          NEW — time-decay helpers
│   ├── routing/
│   │   ├── route.ts                          NEW — routing engine
│   │   └── rules.ts                          NEW — parses routing-rules.md
│   ├── alerts/
│   │   ├── dispatch.ts                       NEW — fanout + tier-transition detection
│   │   ├── render.ts                         NEW — Claude CLI alert text rendering
│   │   └── channels/
│   │       ├── slack.ts                      NEW
│   │       ├── email.ts                      NEW
│   │       └── webhook.ts                    NEW
│   ├── connectors/
│   │   ├── types.ts                          NEW — SignalConnector interface
│   │   ├── github.ts                         NEW — REAL Octokit-based connector
│   │   ├── salesforce.ts                     NEW — fixture-backed stub
│   │   ├── hubspot.ts                        NEW — fixture-backed stub
│   │   ├── outreach.ts                       NEW — fixture-backed stub
│   │   └── poll.ts                           NEW — scheduler entrypoint
│   ├── engagement/
│   │   ├── ingest.ts                         NEW — engagement event webhook
│   │   ├── attribute.ts                      NEW — outcome → principle attribution
│   │   └── patterns.ts                       NEW — nightly digest of working patterns
│   └── drafter/
│       └── draft.ts                          MODIFY — accept principle-outcomes
├── app/
│   ├── api/
│   │   ├── signals/route.ts                  NEW — POST /api/signals
│   │   ├── scoring/recompute/route.ts        NEW — POST /api/scoring/recompute
│   │   ├── alerts/route.ts                   NEW — GET /api/alerts
│   │   ├── alerts/[id]/ack/route.ts          NEW — POST /api/alerts/:id/ack
│   │   ├── engagement/route.ts               NEW — POST /api/engagement
│   │   └── connectors/[name]/poll/route.ts   NEW — POST /api/connectors/:name/poll
│   ├── inbound/page.tsx                      NEW — signal stream + top-scored accounts
│   ├── alerts/page.tsx                       NEW — alert feed
│   └── accounts/[id]/page.tsx                MODIFY — add Score panel
├── components/
│   ├── ScoreRationale.tsx                    NEW
│   ├── TierBadge.tsx                         NEW
│   └── SignalRow.tsx                         NEW
├── tests/
│   ├── unit/
│   │   ├── scoring.test.ts                   NEW
│   │   ├── scoring-rules.test.ts             NEW
│   │   ├── routing.test.ts                   NEW
│   │   ├── routing-rules.test.ts             NEW
│   │   ├── decay.test.ts                     NEW
│   │   ├── alert-dispatch.test.ts            NEW
│   │   ├── github-connector.test.ts          NEW
│   │   ├── attribute.test.ts                 NEW
│   │   └── signal-ingest.test.ts             NEW
│   └── integration/
│       ├── signals-api.test.ts               NEW
│       ├── alerts-api.test.ts                NEW
│       ├── engagement-api.test.ts            NEW
│       └── inbound-pipeline.test.ts          NEW — end-to-end signal → score → alert
├── fixtures/
│   ├── salesforce-contacts.json              NEW
│   ├── hubspot-accounts.json                 NEW
│   └── outreach-engagement.json              NEW
├── docs/
│   ├── architecture.md                       NEW — Phase 0 essay
│   ├── demo.md                               NEW — Phase 0 demo script
│   └── connectors.md                         NEW — connector contract docs
├── scripts/
│   └── poll-connectors.ts                    NEW — cron entrypoint
├── README.md                                 MODIFY — Phase 0 rewrite
└── application/                              NEW — Phase 6 output directory (gitignored)
    ├── cover-letter.md
    ├── architecture-essay.md
    ├── evidence-pack.json                    (from scripts/dump-evidence.ts)
    ├── touch-1.eml                           (from POST /api/export, per lib/export/eml.ts)
    ├── touch-2-linkedin.txt                  (from POST /api/export)
    ├── touch-3.eml                           (from POST /api/export)
    ├── critique-findings.json
    └── loom.md
```

---

## Phase 0 — Repackage (no code, ~1 day)

### Task 0.1: Pre-flight — clean tree, branch, gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 0.1.1: Verify clean tree, on main, up to date**

This repository may already contain the two plan docs as untracked files:
`PLAN-ai-sales.md` and `docs/superpowers/plans/2026-05-06-ai-sales-automation-revamp.md`.
Before implementation, either commit those plan docs on `main` or explicitly
accept that they are the only untracked files. Do not start with unrelated
dirty files.

```bash
cd /Users/jinchoi/Code/Sales
git status                # expect: clean, OR only the two plan docs untracked
git rev-parse --abbrev-ref HEAD   # expect: main
git pull --ff-only
```

Expected output: `main`, `Already up to date.`, and either a clean working tree
or only the two plan docs listed above as untracked. Recommended: commit the
plan docs before cutting the feature branch so subsequent task commits are
cleanly scoped.

- [ ] **Step 0.1.2: Cut feature branch**

```bash
git checkout -b feature/ai-sales-automation
```

Expected output: `Switched to a new branch 'feature/ai-sales-automation'`

- [ ] **Step 0.1.3: Ignore application/ and outbox/ contents in `.gitignore`**

The current `.gitignore` does not exclude the application directory (private artifacts generated in Phase 6) or `outbox/` (alert channel file fallbacks). Use `application/*` (contents only, not the directory itself) so Phase 6 can selectively unignore one file with a single negation line, without git's "cannot re-include a file inside an excluded directory" rule getting in the way.

```bash
printf '\napplication/*\noutbox/\n' >> .gitignore
```

Verify:

```bash
grep -E '^(application/\*|outbox/)$' .gitignore
```

Expected: both lines printed.

- [ ] **Step 0.1.4: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore application/* and outbox/ before Phase 6"
```

---

### Task 0.2: Rewrite README

**Files:**
- Modify: `README.md`

- [ ] **Step 0.2.1: Replace README contents**

Overwrite `README.md` with:

```markdown
# Sales — SDR Automation Reference Architecture

An evidence-grounded reference architecture for AI-powered SDR automation. Working v1 below.

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

v2 — see [docs/superpowers/plans/2026-05-06-ai-sales-automation-revamp.md](docs/superpowers/plans/2026-05-06-ai-sales-automation-revamp.md) for the implementation plan.
```

- [ ] **Step 0.2.2: Commit**

```bash
git add README.md
git commit -m "docs: reframe README as SDR automation reference architecture"
```

Expected output: commit hash + 1 file changed.

---

### Task 0.3: Write architecture essay

**Files:**
- Create: `docs/architecture.md`

- [ ] **Step 0.3.1: Write the essay**

Create `docs/architecture.md` with the six-section structure described in `PLAN-ai-sales.md` Phase 0. Each section is 200–400 words. Sections:

1. **Why Evidence is a spine, not a sidecar** — explain append-only + `extractionStatus` + `supersededBy`. Reference the existing `db/schema.ts:evidence` table. Concrete: a fact written by Claude CLI is `pending_audit`; it becomes `verified` only after the Extraction Audit critic agrees the snippet supports the fact. Drafts can only cite `verified` rows.
2. **Why the validator is a structural invariant, not a prompt instruction** — explain `lib/evidence/validate.ts` substring check. Concrete: `validateDraft` rejects any `supporting_spans[*].span` that is not a normalized-substring of the cited evidence's snippet. Normalization = lowercase + collapsed whitespace. The drafter retries once on failure with a correction message; remaining issues surface to the operator.
3. **Why principles live in a user-editable file** — explain `data/principles.md` as the Sales Coach rubric. Each principle has a stable ID; critic output references `principle_id`. Editing the file changes the critic on the next run, no redeploy. Adding `data/scoring-rules.md`, `data/routing-rules.md`, `data/alert-rules.md`, `data/github-watch.md` follows the same pattern: user-owned configuration as Markdown.
4. **Why each LLM call is a scoped CLI subprocess with `--allowed-tools`** — explain `lib/claude/run.ts:spawnClaude`. Each call passes `--allowed-tools WebFetch,WebSearch` (or none) so the model cannot read the local filesystem, run Bash, or call other tools the operator hasn't explicitly granted. Concurrency capped at 3 (Max plan tolerance). No API key — OAuth via the user's existing Claude Code session.
5. **Why drafts are immutable revisions** — explain `touches.currentRevisionId` + `touch_revisions` rows. Accepting a critic rewrite inserts a new row with `revisionNumber = N+1` and updates the pointer. Prior revisions are queryable forever. Auditable trail of every word change.
6. **Why audit status is a first-class column** — explain `evidence.extractionStatus` lifecycle: `pending_audit` → `verified` | `disputed`. The drafter's evidence pull filters on `extractionStatus = 'verified'`. Audit decisions write `extraction_audits` rows with `resolvedBy` provenance. Disputed rows can be superseded via `supersededBy` to maintain history.

Write the actual essay. Do not leave section bodies as outlines.

- [ ] **Step 0.3.2: Verify essay length and structure**

```bash
wc -w docs/architecture.md
grep -c "^## " docs/architecture.md
```

Expected: word count between 1500 and 2500; section count = 6.

- [ ] **Step 0.3.3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: add architecture essay covering 6 design decisions"
```

---

### Task 0.4: Write demo script

**Files:**
- Create: `docs/demo.md`

- [ ] **Step 0.4.1: Write demo.md**

Create `docs/demo.md` with this exact structure (fill body with concrete commands and expected screenshots — use a real public company name like Vercel, Linear, or Retool, not the current target company, so the final application evidence pack stays clean):

```markdown
# 5-minute demo — [Company]

Goal: take a public company through every pipeline stage and show the resulting artifacts.

## Setup (30s)

```bash
pnpm dev
# In another terminal:
export CLAUDE_MAX_CONCURRENT=3
```

Open http://localhost:3000.

## 1. Create account (15s)

UI: Accounts → New → name=[Company], domain=[domain]. Click Create.
Expected: redirect to `/accounts/[id]`, empty Evidence tab.

## 2. Auto-research (45s)

UI: Click "Run auto-research". Wait ~30s.
Expected: 8–20 evidence rows appear in `pending_audit`. Each has `source_url`, `snippet`, `extracted_fact`, `confidence`.

## 3. Extraction audit (30s)

UI: Click "Run extraction audit on pending". Wait ~15s.
Expected: each row transitions to `verified` or `disputed`. Disputed rows show reason + suggested correction.

## 4. Add contact (15s)

UI: Contacts → Add. Fill name, title, archetype=`leader`. Save.

## 5. Create sequence (15s)

UI: Sequences → New. Channels: [email, linkedin, email]. Create.
Expected: 3 touches in `draft` status.

## 6. Draft each touch (60s)

UI: Click each touch → Draft. Wait ~10–15s per touch.
Expected: each touch gets a subject + body with cited evidence pills + verbatim spans.

## 7. Run critic panel (45s)

UI: Click "Run critics" on touch 1. Wait ~20s.
Expected: 3 critic results (Skeptical Buyer, Sales Coach, Writing Editor) with verdict + findings.

## 8. Accept rewrites (30s)

UI: Click "Accept" on a critic's suggested rewrite.
Expected: new revision appears; prior revision still visible in history dropdown.

## 9. Export (15s)

UI: Sequence page → Export.
Expected: `.eml` file downloads for email touches; `.txt` for LinkedIn. Touch 1 copied to clipboard.

## Total: ~5 minutes.
```

- [ ] **Step 0.4.2: Commit**

```bash
git add docs/demo.md
git commit -m "docs: add 5-minute demo script"
```

---

## Phase 1 — Inbound + Signals + Routing

### Task 1.1: Schema — extend `evidence`, add 3 new tables (lead_scores, routing_assignments, alerts)

**Files:**
- Modify: `db/schema.ts`
- Generated: `db/migrations/0003_signals_scoring.sql`
- Test: `tests/unit/schema.test.ts`

- [ ] **Step 1.1.1: Write failing test for new schema**

Append to `tests/unit/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as schema from '../../db/schema';

describe('schema v2 (signals/scoring/routing)', () => {
  it('extends evidence with signalType and dedupeKey', () => {
    const cols = Object.keys(schema.evidence);
    expect(cols).toContain('signalType');
    expect(cols).toContain('dedupeKey');
  });

  it('exports leadScores with fingerprint for idempotent recompute', () => {
    expect(schema.leadScores).toBeDefined();
    const cols = Object.keys(schema.leadScores);
    for (const c of ['id', 'accountId', 'score', 'tier', 'rationaleJson',
                     'fingerprint', 'computedAt', 'expiresAt']) {
      expect(cols).toContain(c);
    }
  });

  it('exports routingAssignments with matchedRuleKey (not FK)', () => {
    expect(schema.routingAssignments).toBeDefined();
    const cols = Object.keys(schema.routingAssignments);
    expect(cols).toContain('matchedRuleKey');
    expect(cols).not.toContain('ruleId');
  });

  it('exports alerts with cooldownKey for dedupe', () => {
    expect(schema.alerts).toBeDefined();
    const cols = Object.keys(schema.alerts);
    expect(cols).toContain('cooldownKey');
  });
});
```

- [ ] **Step 1.1.2: Run test, expect FAIL**

```bash
pnpm test tests/unit/schema.test.ts
```

Expected: test fails with "schema.leadScores is not defined" or similar.

- [ ] **Step 1.1.3: Modify `db/schema.ts`**

Apply these changes to `db/schema.ts`. Add `uniqueIndex` and (if missing) `index` to the imports:

```typescript
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
```

(a) Extend the `evidence.sourceType` enum and add `signalType` + `dedupeKey`. Replace the existing `evidence` table block:

```typescript
export const evidence = sqliteTable('evidence', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  contactId: text('contact_id').references(() => contacts.id),
  sourceUrl: text('source_url').notNull(),
  sourceType: text('source_type', {
    enum: ['website', 'linkedin', 'news', '10k', 'job_post', 'podcast',
           'manual', 'perplexity', 'deep_research',
           // signal sources (new)
           'intent_data', 'web_traffic', 'form_fill', 'github_event',
           'earnings_call', 'press_release', 'social_post',
           // connector sources — distinct from form_fill so scoring rule R3
           // (form-fill-as-demo-request) does NOT match CRM upserts.
           'crm_record', 'engagement_event'],
  }).notNull(),
  signalType: text('signal_type', {
    enum: ['none', 'intent', 'engagement', 'firmographic',
           'technographic', 'trigger_event'],
  }).notNull().default('none'),
  snippet: text('snippet').notNull(),
  extractedFact: text('extracted_fact').notNull(),
  extractionStatus: text('extraction_status', {
    enum: ['pending_audit', 'verified', 'disputed'],
  }).notNull().default('pending_audit'),
  confidence: text('confidence', { enum: ['high', 'medium', 'low'] })
    .notNull().default('medium'),
  capturedAt: text('captured_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  capturedBy: text('captured_by', {
    enum: ['claude_cli', 'manual', 'perplexity_mcp', 'chatgpt_mcp',
           'deep_research_paste',
           // connector sources (new)
           'webhook', 'connector_github', 'connector_salesforce',
           'connector_hubspot', 'connector_outreach'],
  }).notNull(),
  supersededBy: text('superseded_by').references((): any => evidence.id),
  // De-dup key for idempotent webhook + connector ingestion. Format:
  // "<capturedBy>:<sourceUrl>:<sha256(snippet)>". Unique when non-null.
  dedupeKey: text('dedupe_key').unique(),
});
```

(b) Add partial-unique indexes on `accounts.domain` and `contacts.email`. SQLite's column-level UNIQUE on existing tables requires table rebuild; partial unique indexes do not, and they correctly allow multiple NULLs.

**You MUST put the index in the third-argument builder of `sqliteTable`.** Drizzle-Kit's SQLite migration generator only discovers indexes declared this way; standalone `export const fooIndex = uniqueIndex(...)` does NOT produce a `CREATE INDEX` statement and your unique constraint will silently never exist in the DB.

Modify the existing `accounts` and `contacts` table definitions (in place — do not duplicate them):

```typescript
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domain: text('domain'),
  industry: text('industry'),
  size: text('size'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({
  domainUnique: uniqueIndex('accounts_domain_unique')
    .on(t.domain).where(sql`domain IS NOT NULL`),
}));

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  fullName: text('full_name').notNull(),
  title: text('title'),
  linkedinUrl: text('linkedin_url'),
  email: text('email'),
  archetype: text('archetype', {
    enum: ['gatekeeper', 'business_user', 'enabler', 'leader', 'unknown'],
  }).notNull().default('unknown'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({
  emailUnique: uniqueIndex('contacts_email_unique')
    .on(t.email).where(sql`email IS NOT NULL`),
}));
```

After running `pnpm db:generate`, **inspect the produced migration** and confirm both `CREATE UNIQUE INDEX accounts_domain_unique` and `CREATE UNIQUE INDEX contacts_email_unique` appear with `WHERE` clauses. If they don't, your Drizzle version handles partial indexes differently — add them to the migration SQL by hand:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS accounts_domain_unique ON accounts(domain) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_unique ON contacts(email) WHERE email IS NOT NULL;
```

(c) Append the 3 new tables (`leadScores`, `routingAssignments`, `alerts`) at the end of the file. Note: `routing_assignments.matchedRuleKey` is **not** a foreign key — routing rules live in Markdown (`data/routing-rules.md`) and are parsed in-memory; we store the stable rule key (`RR1`, `RR2`, …) as text for traceability. There is no `routing_rules` DB table.

```typescript
export const leadScores = sqliteTable('lead_scores', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  contactId: text('contact_id').references(() => contacts.id),
  score: integer('score').notNull(),  // 0–100, clamped
  tier: text('tier', { enum: ['cold', 'warm', 'hot', 'on_fire'] }).notNull(),
  rationaleJson: text('rationale_json', { mode: 'json' })
    .$type<Array<{ evidence_id: string; weight: number; reason: string; rule_id: string }>>()
    .notNull().default(sql`'[]'`),
  // Stable hash of (score + tier + rationale identity + rules MD hash) —
  // lets us skip writing a new row when nothing changed since the previous
  // recompute. Rules MD hash is included so a threshold-only edit still
  // forces a fresh row + tier-promotion alert evaluation.
  fingerprint: text('fingerprint').notNull(),
  // Use ISO 8601 with milliseconds so lexicographic compare matches chronological
  // order (SQLite's CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" which sorts
  // poorly when mixed with other ISO writes elsewhere).
  computedAt: text('computed_at').notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  expiresAt: text('expires_at'),  // ISO 8601; null = no expiry
}, (t) => ({
  // Concurrent recomputes are made idempotent at the DB level: two parallel
  // calls computing the same (account, fingerprint) collide on this index;
  // computeScore catches the unique violation and re-selects the winner.
  accountFingerprintUnique: uniqueIndex('lead_scores_account_fingerprint_unique')
    .on(t.accountId, t.fingerprint),
}));

export const routingAssignments = sqliteTable('routing_assignments', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  ownerEmail: text('owner_email').notNull(),
  reason: text('reason', {
    enum: ['rule_match', 'fallback_default', 'manual_override'],
  }).notNull(),
  // Stable rule key parsed from data/routing-rules.md (e.g. 'RR1'). NOT an FK —
  // rules live in Markdown, not the DB. Null when fallback/manual.
  matchedRuleKey: text('matched_rule_key'),
  // Hash of the routing-rules.md content used to produce this assignment.
  // When the operator edits routing rules, route() computes a new hash; the
  // unique key (accountId, scoreId, routingRulesHash) lets recompute create
  // a fresh assignment under the new rules without violating uniqueness.
  routingRulesHash: text('routing_rules_hash').notNull(),
  scoreId: text('score_id').references(() => leadScores.id),
  assignedAt: text('assigned_at').notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (t) => ({
  perScoreRulesUnique: uniqueIndex('routing_assignments_account_score_rules_unique')
    .on(t.accountId, t.scoreId, t.routingRulesHash),
}));

export const alerts = sqliteTable('alerts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  trigger: text('trigger', {
    enum: ['tier_promotion', 'high_intent_signal', 'engagement_spike',
           'competitor_mention', 'manual'],
  }).notNull(),
  severity: text('severity', { enum: ['info', 'priority', 'urgent'] }).notNull(),
  payloadJson: text('payload_json', { mode: 'json' })
    .$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  channelsSentJson: text('channels_sent_json', { mode: 'json' })
    .$type<Array<{ channel: 'slack' | 'email' | 'webhook' | 'file';
                   sent_at: string; ok: boolean; detail?: string }>>()
    .notNull().default(sql`'[]'`),
  // Cooldown / dedupe key — e.g. "engagement_spike:acc_xxx:2026-05-06" so the
  // same trigger does not refire repeatedly within a window.
  cooldownKey: text('cooldown_key').unique(),
  acknowledgedAt: text('acknowledged_at'),
  acknowledgedBy: text('acknowledged_by'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

The schema test in 1.1.1 should be updated to drop the `routingRules` assertion and to assert `leadScores.fingerprint`, `routingAssignments.matchedRuleKey`, `alerts.cooldownKey`. Update step 1.1.1 accordingly.

Add these prefixes to `lib/id.ts` (no `routingRule` prefix — routing rules live in Markdown, not the DB):

```typescript
const PREFIX = {
  account: 'acc', contact: 'ct', evidence: 'ev',
  sequence: 'sq', touch: 'to', touchRevision: 'tr',
  critique: 'cr', extractionAudit: 'ea', callPrepBrief: 'cp',
  deliverable: 'del', deliverableAccount: 'da',
  // new in v2
  leadScore: 'ls', routingAssignment: 'ra',
  alert: 'al', engagementEvent: 'ee',
} as const;
```

- [ ] **Step 1.1.4: Generate migration**

```bash
pnpm db:generate
```

Expected: a new file `db/migrations/0003_*.sql` is created. Inspect it; ensure `ALTER TABLE evidence ADD COLUMN signal_type TEXT NOT NULL DEFAULT 'none'` and `ADD COLUMN dedupe_key TEXT` (with unique index) appear, plus `CREATE TABLE` statements for the 3 new tables (`lead_scores`, `routing_assignments`, `alerts`).

- [ ] **Step 1.1.5: Pre-migration duplicate check (avoid index-creation failure)**

Adding `accounts_domain_unique` and `contacts_email_unique` partial indexes will fail if the existing dev DB already has duplicate non-null domains or emails. Check first:

First normalize existing dev rows to the same casing the ingest path uses:

```bash
pnpm tsx -e "
import Database from 'better-sqlite3';
const db = new Database('data/sales.db');
db.prepare(\`
  UPDATE accounts
  SET domain = lower(trim(domain))
  WHERE domain IS NOT NULL
\`).run();
db.prepare(\`
  UPDATE contacts
  SET email = lower(trim(email))
  WHERE email IS NOT NULL
\`).run();
console.log('Normalized existing account domains and contact emails.');
"
```

Then run a case-insensitive duplicate check:

```bash
pnpm tsx -e "
import Database from 'better-sqlite3';
const db = new Database('data/sales.db', { readonly: true });
const dupAccounts = db.prepare(\`
  SELECT lower(domain) domain, COUNT(*) c FROM accounts
  WHERE domain IS NOT NULL GROUP BY lower(domain) HAVING c > 1
\`).all();
const dupContacts = db.prepare(\`
  SELECT lower(email) email, COUNT(*) c FROM contacts
  WHERE email IS NOT NULL GROUP BY lower(email) HAVING c > 1
\`).all();
if (dupAccounts.length || dupContacts.length) {
  console.error('Duplicates found:', { dupAccounts, dupContacts });
  process.exit(1);
}
console.log('No duplicates — safe to migrate.');
"
```

If duplicates exist, resolve them in the dev DB before migrating: rename one of the conflicting domains, or delete the older row. Do not skip this — the migration will roll back partway and leave the schema in an inconsistent state.

- [ ] **Step 1.1.6: Run migration on the dev DB**

```bash
pnpm db:migrate
```

Expected: no errors; `data/sales.db` schema updated. Both partial unique indexes are visible:

```bash
pnpm tsx -e "
import Database from 'better-sqlite3';
const db = new Database('data/sales.db', { readonly: true });
console.log(db.prepare(\`SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE '%_unique'\`).all());
"
```

Expected: at least `accounts_domain_unique`, `contacts_email_unique`, `lead_scores_account_fingerprint_unique`, `routing_assignments_account_score_rules_unique` listed.

- [ ] **Step 1.1.7: Run schema tests**

```bash
pnpm test tests/unit/schema.test.ts
```

Expected: all passes.

- [ ] **Step 1.1.8: Commit**

```bash
git add db/schema.ts db/migrations lib/id.ts tests/unit/schema.test.ts
git commit -m "feat(db): add lead_scores (with fingerprint), routing_assignments (matchedRuleKey, not FK), alerts (with cooldownKey); extend evidence with signalType + dedupeKey; partial-unique indexes on accounts.domain and contacts.email"
```

---

### Task 1.2: SignalPayload Zod schema

**Files:**
- Create: `lib/signals/types.ts`
- Test: `tests/unit/signal-ingest.test.ts` (partial — just the schema)

- [ ] **Step 1.2.1: Write failing schema test**

Create `tests/unit/signal-ingest.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SignalPayload } from '../../lib/signals/types';

describe('SignalPayload schema', () => {
  it('accepts a minimal valid intent signal', () => {
    const ok = SignalPayload.safeParse({
      source: 'intent_data',
      account_domain: 'acme.com',
      signal_type: 'intent',
      fact: 'Acme searched for "vector database" 12 times in the last 7d',
      source_url: 'https://bombora.example/topic/vector-db',
      snippet: 'Surge: vector database, weekly score 87',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an unknown source', () => {
    const fail = SignalPayload.safeParse({
      source: 'tarot_reading',
      account_domain: 'acme.com',
      signal_type: 'intent',
      fact: 'x', source_url: 'https://x', snippet: 'x',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(fail.success).toBe(false);
  });

  it('rejects a snippet > 1500 chars', () => {
    const fail = SignalPayload.safeParse({
      source: 'web_traffic',
      account_domain: 'acme.com', signal_type: 'engagement',
      fact: 'x', source_url: 'https://x',
      snippet: 'a'.repeat(1501),
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(fail.success).toBe(false);
  });

  it('requires captured_at to be ISO8601', () => {
    const fail = SignalPayload.safeParse({
      source: 'web_traffic',
      account_domain: 'acme.com', signal_type: 'engagement',
      fact: 'x', source_url: 'https://x', snippet: 'x',
      captured_at: 'yesterday',
    });
    expect(fail.success).toBe(false);
  });
});
```

- [ ] **Step 1.2.2: Run test, expect FAIL**

```bash
pnpm test tests/unit/signal-ingest.test.ts
```

Expected: failure (`Cannot find module '../../lib/signals/types'`).

- [ ] **Step 1.2.3: Create `lib/signals/types.ts`**

```typescript
import { z } from 'zod';

export const SIGNAL_SOURCE = [
  'intent_data', 'web_traffic', 'form_fill', 'github_event',
  'earnings_call', 'press_release', 'social_post',
  'crm_record', 'engagement_event',
] as const;
export type SignalSource = typeof SIGNAL_SOURCE[number];

export const SIGNAL_TYPE = [
  'intent', 'engagement', 'firmographic',
  'technographic', 'trigger_event',
] as const;
export type SignalType = typeof SIGNAL_TYPE[number];

// Mirrors evidence.capturedBy enum for connector- and webhook-originated rows.
export const CAPTURED_BY = [
  'webhook',
  'connector_github', 'connector_salesforce',
  'connector_hubspot', 'connector_outreach',
] as const;
export type CapturedBy = typeof CAPTURED_BY[number];

// Sources that the operator trusts to vouch for the snippet (skip extraction
// audit) when the sender is also authenticated. Includes connector-originated
// types because the connector code is configured locally — the trust comes
// from the operator's choice of fixtures/repos, not the source label alone.
export const TRUSTED_SOURCES: ReadonlySet<SignalSource> = new Set([
  'intent_data', 'form_fill',
  'crm_record', 'engagement_event', 'github_event',
] satisfies SignalSource[]);

export const SignalPayload = z.object({
  source: z.enum(SIGNAL_SOURCE),
  account_domain: z.string().min(1),
  contact_email: z.string().email().nullable().optional(),
  signal_type: z.enum(SIGNAL_TYPE),
  fact: z.string().min(1).max(500),
  source_url: z.string().url(),
  snippet: z.string().min(1).max(1500),
  captured_at: z.string().datetime({ offset: true }),  // ISO 8601, accepts ±HH:MM offsets
  // Optional: identifies the producer for provenance. When omitted, the ingest
  // layer treats this as a generic webhook (capturedBy='webhook'). Connector
  // implementations MUST set this so rows trace back to the connector.
  captured_by: z.enum(CAPTURED_BY).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SignalPayload = z.infer<typeof SignalPayload>;
```

- [ ] **Step 1.2.4: Run test, expect PASS**

```bash
pnpm test tests/unit/signal-ingest.test.ts
```

- [ ] **Step 1.2.5: Commit**

```bash
git add lib/signals/types.ts tests/unit/signal-ingest.test.ts
git commit -m "feat(signals): add SignalPayload Zod schema with trusted-source allowlist"
```

---

### Task 1.3: Signal ingestion (`lib/signals/ingest.ts`)

**Files:**
- Create: `lib/signals/ingest.ts`
- Test: `tests/unit/signal-ingest.test.ts` (extend)

- [ ] **Step 1.3.1: Add ingestion test**

Append to `tests/unit/signal-ingest.test.ts`:

```typescript
import { ingestSignal } from '../../lib/signals/ingest';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';

// Reuse the in-memory db mock from accounts-api.test.ts pattern.
// (Hoist mock to top of file in real implementation.)

describe('ingestSignal', () => {
  beforeEach(() => {
    db.delete(schema.evidence).run();
    db.delete(schema.contacts).run();
    db.delete(schema.accounts).run();
  });

  it('creates a new account when account_domain is unknown', async () => {
    const payload = {
      source: 'intent_data' as const,
      account_domain: 'newco.io',
      signal_type: 'intent' as const,
      fact: 'spike in vector-db keywords',
      source_url: 'https://bombora.example/x',
      snippet: 'Surge: vector database, weekly score 87',
      captured_at: '2026-05-06T12:00:00.000Z',
    };
    const result = await ingestSignal(payload);
    expect(result.accountId).toMatch(/^acc_/);
    expect(result.evidenceId).toMatch(/^ev_/);
    const accounts = db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].domain).toBe('newco.io');
  });

  it('reuses existing account by domain', async () => {
    const payload = {
      source: 'web_traffic' as const,
      account_domain: 'acme.com',
      signal_type: 'engagement' as const,
      fact: 'pricing page visit',
      source_url: 'https://example.com/pricing',
      snippet: 'visit_id=abc, page=/pricing, ts=2026-05-06',
      captured_at: '2026-05-06T12:00:00.000Z',
    };
    await ingestSignal(payload);
    await ingestSignal(payload);  // same payload, second call
    const accounts = db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
  });

  it('marks trusted-source + authenticated-sender signals as verified', async () => {
    const result = await ingestSignal({
      source: 'intent_data', account_domain: 'acme.com',
      signal_type: 'intent', fact: 'x',
      source_url: 'https://x', snippet: 'y',
      captured_at: '2026-05-06T12:00:00.000Z',
    }, { trustedSender: true });
    const ev = db.select().from(schema.evidence)
      .where(eq(schema.evidence.id, result.evidenceId)).get();
    expect(ev?.extractionStatus).toBe('verified');
  });

  it('keeps trusted-source signals as pending_audit when sender is not authenticated', async () => {
    const result = await ingestSignal({
      source: 'intent_data', account_domain: 'acme.com',
      signal_type: 'intent', fact: 'x',
      source_url: 'https://x', snippet: 'y',
      captured_at: '2026-05-06T12:00:00.000Z',
    });  // no opts → trustedSender defaults to false
    const ev = db.select().from(schema.evidence)
      .where(eq(schema.evidence.id, result.evidenceId)).get();
    expect(ev?.extractionStatus).toBe('pending_audit');
  });

  it('marks untrusted-source signals as pending_audit even when authenticated', async () => {
    const result = await ingestSignal({
      source: 'social_post', account_domain: 'acme.com',
      signal_type: 'trigger_event', fact: 'x',
      source_url: 'https://x', snippet: 'y',
      captured_at: '2026-05-06T12:00:00.000Z',
    }, { trustedSender: true });
    const ev = db.select().from(schema.evidence)
      .where(eq(schema.evidence.id, result.evidenceId)).get();
    expect(ev?.extractionStatus).toBe('pending_audit');
  });

  it('is idempotent on duplicate payload (same dedupe key returns same evidenceId)', async () => {
    const payload = {
      source: 'form_fill' as const, account_domain: 'acme.com',
      signal_type: 'engagement' as const, fact: 'x',
      source_url: 'https://acme.com/contact',
      snippet: 'name=Jane,email=jane@acme.com,form=demo-request',
      captured_at: '2026-05-06T12:00:00.000Z',
    };
    const a = await ingestSignal(payload);
    const b = await ingestSignal(payload);
    expect(a.evidenceId).toBe(b.evidenceId);
    expect(db.select().from(schema.evidence).all()).toHaveLength(1);
  });

  it('resolves contact by email when provided', async () => {
    const result = await ingestSignal({
      source: 'form_fill', account_domain: 'acme.com',
      contact_email: 'jane@acme.com',
      signal_type: 'engagement', fact: 'demo request',
      source_url: 'https://acme.com/contact',
      snippet: 'jane@acme.com submitted demo-request',
      captured_at: '2026-05-06T12:00:00.000Z',
    });
    expect(result.contactId).toMatch(/^ct_/);
    const contacts = db.select().from(schema.contacts).all();
    expect(contacts[0].email).toBe('jane@acme.com');
  });

  it('preserves connector provenance when captured_by is set', async () => {
    const result = await ingestSignal({
      source: 'crm_record', account_domain: 'acme.com',
      signal_type: 'firmographic', fact: 'sf contact upsert',
      source_url: 'https://salesforce.example/Contact/003xx',
      snippet: 'Id=003xx Email=alice@acme.com',
      captured_at: '2026-05-06T12:00:00.000Z',
      captured_by: 'connector_salesforce',
    }, { trustedSender: true });
    const ev = db.select().from(schema.evidence)
      .where(eq(schema.evidence.id, result.evidenceId)).get();
    expect(ev?.capturedBy).toBe('connector_salesforce');
    expect(result.capturedBy).toBe('connector_salesforce');
  });

  it('handles concurrent duplicate calls without creating duplicates', async () => {
    // Better-sqlite3 is single-writer, so true parallelism is impossible at the
    // DB layer; this test validates that even when two callers race in JS, the
    // unique constraints + catch-and-reselect produce one Account/Contact/Evidence.
    const payload = {
      source: 'form_fill' as const,
      account_domain: 'race.com',
      contact_email: 'duplicate@race.com',
      signal_type: 'engagement' as const,
      fact: 'race',
      source_url: 'https://race.com/x',
      snippet: 'race-snippet',
      captured_at: '2026-05-06T12:00:00.000Z',
    };
    const [a, b, c] = await Promise.all([
      ingestSignal(payload),
      ingestSignal(payload),
      ingestSignal(payload),
    ]);
    expect(new Set([a.evidenceId, b.evidenceId, c.evidenceId]).size).toBe(1);
    expect(db.select().from(schema.accounts).all()).toHaveLength(1);
    expect(db.select().from(schema.contacts).all()).toHaveLength(1);
    expect(db.select().from(schema.evidence).all()).toHaveLength(1);
  });
});
```

- [ ] **Step 1.3.2: Run test, expect FAIL**

```bash
pnpm test tests/unit/signal-ingest.test.ts
```

Expected: failure on `ingestSignal` import.

- [ ] **Step 1.3.3: Implement `lib/signals/ingest.ts`**

The ingest path must be:
1. **Idempotent under concurrency.** Two duplicate webhook calls landing in parallel must produce one Evidence row, one Account, one Contact.
2. **Provenance-preserving.** The `captured_by` from the payload (set by the connector) wins; `webhook` is the default only when missing.
3. **Wrapped in a synchronous Drizzle/better-sqlite3 transaction** for atomicity. Unique-constraint violations are caught and converted to re-selects (the "upsert via catch-and-reselect" pattern).

```typescript
import { createHash } from 'node:crypto';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '../id';
import {
  SignalPayload, TRUSTED_SOURCES, type CapturedBy,
} from './types';

export interface IngestResult {
  accountId: string;
  contactId: string | null;
  evidenceId: string;
  capturedBy: CapturedBy;
  /** True when this payload had been ingested before (idempotent path). */
  deduped: boolean;
}

export interface IngestOptions {
  /**
   * True when the upstream sender was authenticated (verified webhook secret,
   * or in-process connector call). Only authenticated callers can mark trusted-
   * source signals as 'verified'; unauthenticated callers always go through
   * extraction audit, regardless of source label. This blocks an attacker from
   * forging a trusted-source label via an open webhook.
   */
  trustedSender?: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  // Narrow to UNIQUE / PRIMARY KEY constraint violations only. FK / NOT NULL /
  // CHECK violations are real bugs and must propagate.
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

function buildDedupeKey(
  p: SignalPayload,
  capturedBy: CapturedBy,
  accountDomain: string,
): string {
  const h = createHash('sha256').update(p.snippet).digest('hex').slice(0, 16);
  // Include source + normalized account domain so identical snippets from the
  // same upstream URL can still be attached to multiple accounts without
  // cross-account evidence collapse.
  return `${capturedBy}:${p.source}:${accountDomain}:${p.source_url}:${h}`;
}

export async function ingestSignal(
  raw: unknown,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const payload = SignalPayload.parse(raw);
  const capturedBy: CapturedBy = payload.captured_by ?? 'webhook';
  const domain = payload.account_domain.toLowerCase().trim();
  const key = buildDedupeKey(payload, capturedBy, domain);
  const email = payload.contact_email?.toLowerCase().trim() || null;
  // Trust requires BOTH a trusted source label AND an authenticated sender.
  const status =
    opts.trustedSender === true && TRUSTED_SOURCES.has(payload.source)
      ? 'verified'
      : 'pending_audit';

  // Drizzle/better-sqlite3 transactions are SYNCHRONOUS. Wrapping the read +
  // insert pair in a transaction makes the dedupe-then-insert sequence atomic.
  // Unique violations from concurrent inserts are re-resolved by re-selecting.
  return db.transaction((tx): IngestResult => {
    // (1) Dedupe: if dedupeKey already present, short-circuit.
    const existing = tx.select().from(schema.evidence)
      .where(eq(schema.evidence.dedupeKey, key)).get();
    if (existing) {
      return {
        accountId: existing.accountId,
        contactId: existing.contactId ?? null,
        evidenceId: existing.id,
        capturedBy: existing.capturedBy as CapturedBy,
        deduped: true,
      };
    }

    // (2) Resolve or create the account by domain (unique partial index).
    let account = tx.select().from(schema.accounts)
      .where(eq(schema.accounts.domain, domain)).get();
    if (!account) {
      const id = newId('account');
      try {
        tx.insert(schema.accounts).values({ id, name: domain, domain }).run();
        account = tx.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get()!;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Concurrent insert won; re-select.
        account = tx.select().from(schema.accounts)
          .where(eq(schema.accounts.domain, domain)).get();
        if (!account) throw err;
      }
    }

    // (3) Resolve or create the contact by email (unique partial index).
    let contactId: string | null = null;
    if (email) {
      const found = tx.select().from(schema.contacts)
        .where(eq(schema.contacts.email, email)).get();
      if (found) {
        contactId = found.id;
      } else {
        contactId = newId('contact');
        try {
          tx.insert(schema.contacts).values({
            id: contactId,
            accountId: account.id,
            fullName: email.split('@')[0],
            email,
          }).run();
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          const reselect = tx.select().from(schema.contacts)
            .where(eq(schema.contacts.email, email)).get();
          if (!reselect) throw err;
          contactId = reselect.id;
        }
      }
    }

    // (4) Insert the evidence row. Unique violation on dedupeKey means a
    //     concurrent insert just won the race — re-select and return that one.
    const evidenceId = newId('evidence');
    try {
      tx.insert(schema.evidence).values({
        id: evidenceId,
        accountId: account.id,
        contactId,
        sourceUrl: payload.source_url,
        sourceType: payload.source,
        signalType: payload.signal_type,
        snippet: payload.snippet,
        extractedFact: payload.fact,
        extractionStatus: status,
        confidence: 'high',
        capturedAt: payload.captured_at,
        capturedBy,
        dedupeKey: key,
      }).run();
      return { accountId: account.id, contactId, evidenceId, capturedBy, deduped: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = tx.select().from(schema.evidence)
        .where(eq(schema.evidence.dedupeKey, key)).get();
      if (!winner) throw err;
      return {
        accountId: winner.accountId,
        contactId: winner.contactId ?? null,
        evidenceId: winner.id,
        capturedBy: winner.capturedBy as CapturedBy,
        deduped: true,
      };
    }
  });
}
```

> **Note on Drizzle transaction typing:** `db.transaction((tx) => …)` for `better-sqlite3` is synchronous in Drizzle v0.45+. The function signature here is `async` because callers expect a `Promise`, but the body inside the transaction is sync. If your Drizzle version disagrees, drop the outer `async` and return `db.transaction((tx) => …)` directly.

- [ ] **Step 1.3.4: Run tests, expect PASS**

```bash
pnpm test tests/unit/signal-ingest.test.ts
```

- [ ] **Step 1.3.5: Commit**

```bash
git add lib/signals tests/unit/signal-ingest.test.ts
git commit -m "feat(signals): ingestSignal — domain/email resolution, trusted-source verification, dedupe-key idempotency"
```

---

### Task 1.4: POST /api/signals route + integration test

**Files:**
- Create: `app/api/signals/route.ts`
- Test: `tests/integration/signals-api.test.ts`

- [ ] **Step 1.4.1: Write failing integration test**

Create `tests/integration/signals-api.test.ts`. Use the same in-memory mock pattern as `accounts-api.test.ts:1-39` (copy the `vi.mock('@/db', ...)` block and `beforeEach` cleanup). Then:

```typescript
import { POST } from '../../app/api/signals/route';

describe('POST /api/signals', () => {
  it('200s on valid payload, creates evidence', async () => {
    const req = new Request('http://x/api/signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'intent_data',
        account_domain: 'acme.com',
        signal_type: 'intent',
        fact: 'spike',
        source_url: 'https://bombora.example/x',
        snippet: 'Surge weekly 87',
        captured_at: '2026-05-06T12:00:00.000Z',
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evidenceId).toMatch(/^ev_/);
    expect(body.deduped).toBe(false);
  });

  it('400s on invalid payload', async () => {
    const req = new Request('http://x/api/signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'tarot' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('401s without webhook secret when SIGNAL_WEBHOOK_SECRET is set', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const req = new Request('http://x/api/signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'intent_data', account_domain: 'acme.com',
        signal_type: 'intent', fact: 'x',
        source_url: 'https://x', snippet: 'y',
        captured_at: '2026-05-06T12:00:00.000Z',
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    delete process.env.SIGNAL_WEBHOOK_SECRET;
  });

  it('200s with correct webhook secret', async () => {
    process.env.SIGNAL_WEBHOOK_SECRET = 'shh';
    const req = new Request('http://x/api/signals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': 'shh',
      },
      body: JSON.stringify({
        source: 'intent_data', account_domain: 'acme.com',
        signal_type: 'intent', fact: 'x',
        source_url: 'https://x', snippet: 'y',
        captured_at: '2026-05-06T12:00:00.000Z',
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    delete process.env.SIGNAL_WEBHOOK_SECRET;
  });
});
```

- [ ] **Step 1.4.2: Run test, expect FAIL**

```bash
pnpm test tests/integration/signals-api.test.ts
```

- [ ] **Step 1.4.3: Implement route**

Create `app/api/signals/route.ts`. The route passes `trustedSender: true` to `ingestSignal` only when (a) `SIGNAL_WEBHOOK_SECRET` is configured AND (b) the request presented the matching secret. If the env var is unset (local dev), the request is treated as untrusted and even trusted-source labels go through extraction audit. This is conservative-by-default.

```typescript
import { NextResponse } from 'next/server';
import { ingestSignal } from '@/lib/signals/ingest';

export async function POST(req: Request) {
  const expected = process.env.SIGNAL_WEBHOOK_SECRET;
  let trustedSender = false;
  if (expected) {
    const got = req.headers.get('x-webhook-secret');
    if (got !== expected) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    trustedSender = true;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const result = await ingestSignal(body, { trustedSender });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof Error && err.name === 'ZodError') {
      return NextResponse.json({ error: 'invalid_payload', detail: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'internal', detail: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 1.4.4: Run tests, expect PASS**

```bash
pnpm test tests/integration/signals-api.test.ts
```

- [ ] **Step 1.4.5: Commit**

```bash
git add app/api/signals tests/integration/signals-api.test.ts
git commit -m "feat(api): POST /api/signals with optional shared-secret auth and Zod-validated payload"
```

---

### Task 1.5: Time-decay helper

**Files:**
- Create: `lib/scoring/decay.ts`
- Test: `tests/unit/decay.test.ts`

- [ ] **Step 1.5.1: Write failing test**

Create `tests/unit/decay.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { linearDecayWeight } from '../../lib/scoring/decay';

describe('linearDecayWeight', () => {
  const base = 100;
  const window = 7;  // days
  const t0 = new Date('2026-05-06T00:00:00Z');

  it('returns full weight at t=0', () => {
    expect(linearDecayWeight(base, t0, t0, window)).toBe(100);
  });

  it('returns half weight at half window', () => {
    const t = new Date('2026-05-09T12:00:00Z');  // 3.5 days later
    expect(linearDecayWeight(base, t0, t, window)).toBe(50);
  });

  it('returns 0 weight at full window', () => {
    const t = new Date('2026-05-13T00:00:00Z');  // 7 days later
    expect(linearDecayWeight(base, t0, t, window)).toBe(0);
  });

  it('clamps to 0 past the window', () => {
    const t = new Date('2026-06-06T00:00:00Z');  // 31 days later
    expect(linearDecayWeight(base, t0, t, window)).toBe(0);
  });

  it('returns 0 for events in the future (clock skew guard)', () => {
    const t = new Date('2026-05-05T00:00:00Z');  // before t0
    expect(linearDecayWeight(base, t0, t, window)).toBe(0);
  });
});
```

- [ ] **Step 1.5.2: Run, expect FAIL.**

```bash
pnpm test tests/unit/decay.test.ts
```

- [ ] **Step 1.5.3: Implement**

Create `lib/scoring/decay.ts`:

```typescript
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Linear decay: weight at t=tEvent, 0 at t = tEvent + windowDays, 0 outside [tEvent, tEvent+windowDays].
 * Future events (tEvent > now) return 0 to guard against clock skew.
 */
export function linearDecayWeight(
  baseWeight: number,
  tEvent: Date,
  now: Date,
  windowDays: number,
): number {
  const elapsedMs = now.getTime() - tEvent.getTime();
  if (elapsedMs < 0) return 0;
  const windowMs = windowDays * MS_PER_DAY;
  if (elapsedMs >= windowMs) return 0;
  return Math.round(baseWeight * (1 - elapsedMs / windowMs));
}
```

- [ ] **Step 1.5.4: Run, expect PASS.**

- [ ] **Step 1.5.5: Commit.**

```bash
git add lib/scoring/decay.ts tests/unit/decay.test.ts
git commit -m "feat(scoring): linear time-decay helper with clock-skew guard"
```

---

### Task 1.6: Scoring rules parser

**Files:**
- Create: `data/scoring-rules.md`
- Create: `lib/scoring/rules.ts`
- Test: `tests/unit/scoring-rules.test.ts`

- [ ] **Step 1.6.1: Author the rules file**

Create `data/scoring-rules.md`:

```markdown
# Scoring rules

Each rule has a stable `id`, a predicate matched against an evidence row, a base `weight` (added to the score when matched), and a `window_days` for linear time-decay. Tier thresholds at the bottom map score → tier.

Edit freely; reload by hitting `POST /api/scoring/recompute`.

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
```

- [ ] **Step 1.6.2: Write failing parser test**

Create `tests/unit/scoring-rules.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseScoringRules, evalPredicate, scoreToTier } from '../../lib/scoring/rules';

const sampleRules = `
## R1 — Intent
- predicate: \`source_type == 'intent_data' AND signal_type == 'intent'\`
- weight: 20
- window_days: 7

## R2 — Pricing
- predicate: \`source_type == 'web_traffic' AND snippet CONTAINS '/pricing'\`
- weight: 15
- window_days: 3

## Tier thresholds

- cold: 0–14
- warm: 15–34
- hot: 35–59
- on_fire: 60+
`;

describe('parseScoringRules', () => {
  it('parses rules with id, weight, window, predicate', () => {
    const { rules, thresholds } = parseScoringRules(sampleRules);
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe('R1');
    expect(rules[0].weight).toBe(20);
    expect(rules[0].windowDays).toBe(7);
    expect(rules[1].id).toBe('R2');
  });

  it('parses tier thresholds', () => {
    const { thresholds } = parseScoringRules(sampleRules);
    expect(thresholds.cold).toEqual([0, 14]);
    expect(thresholds.warm).toEqual([15, 34]);
    expect(thresholds.hot).toEqual([35, 59]);
    expect(thresholds.on_fire).toEqual([60, Infinity]);
  });
});

describe('evalPredicate', () => {
  const ev = (overrides: Partial<any> = {}) => ({
    sourceType: 'intent_data', signalType: 'intent',
    snippet: 'x', extractedFact: 'y',
    ...overrides,
  });

  it('matches equality', () => {
    expect(evalPredicate(`source_type == 'intent_data'`, ev())).toBe(true);
    expect(evalPredicate(`source_type == 'web_traffic'`, ev())).toBe(false);
  });

  it('matches AND', () => {
    expect(evalPredicate(`source_type == 'intent_data' AND signal_type == 'intent'`, ev())).toBe(true);
    expect(evalPredicate(`source_type == 'intent_data' AND signal_type == 'firmographic'`, ev())).toBe(false);
  });

  it('matches CONTAINS', () => {
    expect(evalPredicate(`snippet CONTAINS '/pricing'`, ev({ snippet: 'visited /pricing' }))).toBe(true);
    expect(evalPredicate(`snippet CONTAINS '/pricing'`, ev({ snippet: 'visited /home' }))).toBe(false);
  });

  it('matches IN list', () => {
    expect(evalPredicate(`source_type IN ['press_release', 'news']`, ev({ sourceType: 'news' }))).toBe(true);
    expect(evalPredicate(`source_type IN ['press_release', 'news']`, ev({ sourceType: 'website' }))).toBe(false);
  });

  it('returns false on malformed predicate (does not throw)', () => {
    expect(evalPredicate(`!!!`, ev())).toBe(false);
  });
});

describe('scoreToTier', () => {
  const thresholds = {
    cold: [0, 14] as [number, number],
    warm: [15, 34] as [number, number],
    hot: [35, 59] as [number, number],
    on_fire: [60, Infinity] as [number, number],
  };

  it('maps boundaries correctly', () => {
    expect(scoreToTier(0, thresholds)).toBe('cold');
    expect(scoreToTier(14, thresholds)).toBe('cold');
    expect(scoreToTier(15, thresholds)).toBe('warm');
    expect(scoreToTier(35, thresholds)).toBe('hot');
    expect(scoreToTier(60, thresholds)).toBe('on_fire');
    expect(scoreToTier(999, thresholds)).toBe('on_fire');
  });
});
```

- [ ] **Step 1.6.3: Run, expect FAIL.**

- [ ] **Step 1.6.4: Implement `lib/scoring/rules.ts`**

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ScoringRule {
  id: string;
  predicate: string;
  weight: number;
  windowDays: number;
}

export type Tier = 'cold' | 'warm' | 'hot' | 'on_fire';

export interface TierThresholds {
  cold: [number, number];
  warm: [number, number];
  hot: [number, number];
  on_fire: [number, number];
}

export interface ParsedRules {
  rules: ScoringRule[];
  thresholds: TierThresholds;
}

const HEADER_RE = /^## (R\d+)\s*[—-]\s*.+$/gm;
const FIELD_RE = (name: string) =>
  new RegExp(`^- ${name}:\\s*\`?(.+?)\`?\\s*$`, 'm');
const TIER_RE = /^- (cold|warm|hot|on_fire):\s*(\d+)(?:[–-]|\s+to\s+)?(\d+|\+)?\s*$/m;

export function parseScoringRules(md: string): ParsedRules {
  const rules: ScoringRule[] = [];
  const sections = md.split(/^## /m).slice(1);
  for (const section of sections) {
    const idMatch = section.match(/^(R\d+)/);
    if (!idMatch) continue;
    const predMatch = section.match(/- predicate:\s*`([^`]+)`/);
    const weightMatch = section.match(/- weight:\s*(\d+)/);
    const windowMatch = section.match(/- window_days:\s*(\d+)/);
    if (!predMatch || !weightMatch || !windowMatch) continue;
    rules.push({
      id: idMatch[1],
      predicate: predMatch[1],
      weight: parseInt(weightMatch[1], 10),
      windowDays: parseInt(windowMatch[1], 10),
    });
  }

  const thresholds: TierThresholds = {
    cold: [0, 14], warm: [15, 34], hot: [35, 59], on_fire: [60, Infinity],
  };
  const tierBlock = md.split(/^## Tier thresholds/m)[1] ?? '';
  for (const line of tierBlock.split('\n')) {
    const m = line.match(/- (cold|warm|hot|on_fire):\s*(\d+)\s*[–-]\s*(\d+)?\+?/);
    if (m) {
      const lo = parseInt(m[2], 10);
      const hi = m[3] === undefined ? Infinity : parseInt(m[3], 10);
      thresholds[m[1] as Tier] = [lo, hi];
    } else {
      const mPlus = line.match(/- (cold|warm|hot|on_fire):\s*(\d+)\+/);
      if (mPlus) {
        thresholds[mPlus[1] as Tier] = [parseInt(mPlus[2], 10), Infinity];
      }
    }
  }

  return { rules, thresholds };
}

/**
 * Mini predicate evaluator. Supported grammar:
 *   pred ::= leaf | pred AND pred | pred OR pred
 *   leaf ::= field op value
 *   op   ::= == | != | CONTAINS | IN
 *   field ::= source_type | signal_type | snippet | extracted_fact | confidence
 *   value ::= 'string' | ['string', ...]
 *
 * On parse failure, logs a warning and returns `false` so one bad rule does
 * not break the whole recompute. Operators see the warning in stderr and can
 * fix the rule file. (Failing closed avoids surprise rule-firing on garbage.)
 */
export function evalPredicate(
  pred: string,
  ev: { sourceType: string; signalType: string; snippet: string;
        extractedFact: string; confidence?: string },
): boolean {
  try {
    return evalAndOr(pred.trim(), ev);
  } catch (err) {
    console.warn(`[scoring] predicate failed to evaluate (returning false): ${pred}`, err);
    return false;
  }
}

function evalAndOr(s: string, ev: any): boolean {
  // Split on top-level AND / OR (no parentheses for v1).
  const orParts = splitTopLevel(s, ' OR ');
  if (orParts.length > 1) return orParts.some((p) => evalAndOr(p, ev));
  const andParts = splitTopLevel(s, ' AND ');
  if (andParts.length > 1) return andParts.every((p) => evalAndOr(p, ev));
  return evalLeaf(s.trim(), ev);
}

function splitTopLevel(s: string, sep: string): string[] {
  // No parens in v1; just split.
  return s.split(sep);
}

function evalLeaf(s: string, ev: any): boolean {
  // CONTAINS
  let m = s.match(/^(\w+)\s+CONTAINS\s+'([^']+)'$/);
  if (m) {
    const fieldVal = pluckField(m[1], ev);
    return typeof fieldVal === 'string' && fieldVal.includes(m[2]);
  }
  // IN ['a','b']
  m = s.match(/^(\w+)\s+IN\s+\[([^\]]+)\]$/);
  if (m) {
    const fieldVal = pluckField(m[1], ev);
    const list = m[2].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
    return list.includes(String(fieldVal));
  }
  // ==
  m = s.match(/^(\w+)\s*==\s*'([^']*)'$/);
  if (m) return pluckField(m[1], ev) === m[2];
  // !=
  m = s.match(/^(\w+)\s*!=\s*'([^']*)'$/);
  if (m) return pluckField(m[1], ev) !== m[2];
  return false;
}

function pluckField(name: string, ev: any): unknown {
  switch (name) {
    case 'source_type': return ev.sourceType;
    case 'signal_type': return ev.signalType;
    case 'snippet': return ev.snippet;
    case 'extracted_fact': return ev.extractedFact;
    case 'confidence': return ev.confidence;
    default: return undefined;
  }
}

export function scoreToTier(score: number, t: TierThresholds): Tier {
  if (score >= t.on_fire[0]) return 'on_fire';
  if (score >= t.hot[0]) return 'hot';
  if (score >= t.warm[0]) return 'warm';
  return 'cold';
}

export function loadScoringRulesFromDisk(
  path = resolve(process.cwd(), 'data/scoring-rules.md'),
): ParsedRules {
  return parseScoringRules(readFileSync(path, 'utf8'));
}
```

- [ ] **Step 1.6.5: Run tests, expect PASS.**

- [ ] **Step 1.6.6: Commit.**

```bash
git add data/scoring-rules.md lib/scoring/rules.ts tests/unit/scoring-rules.test.ts
git commit -m "feat(scoring): scoring-rules.md format + parser + mini predicate evaluator"
```

---

### Task 1.7: Scoring engine

**Files:**
- Create: `lib/scoring/score.ts`
- Test: `tests/unit/scoring.test.ts`

- [ ] **Step 1.7.1: Write failing test**

Create `tests/unit/scoring.test.ts`. Use the in-memory db mock pattern. Then:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
// (vi.mock('@/db', ...) hoisted at top — copy from accounts-api.test.ts)
import { db, schema } from '@/db';
import { newId } from '../../lib/id';
import { computeScore } from '../../lib/scoring/score';

const RULES_MD = `
## R1 — Intent
- predicate: \`source_type == 'intent_data'\`
- weight: 20
- window_days: 7

## R2 — Pricing
- predicate: \`source_type == 'web_traffic' AND snippet CONTAINS '/pricing'\`
- weight: 15
- window_days: 3

## Tier thresholds

- cold: 0–14
- warm: 15–34
- hot: 35–59
- on_fire: 60+
`;

describe('computeScore', () => {
  let accountId: string;

  beforeEach(() => {
    db.delete(schema.leadScores).run();
    db.delete(schema.evidence).run();
    db.delete(schema.contacts).run();
    db.delete(schema.accounts).run();
    accountId = newId('account');
    db.insert(schema.accounts).values({
      id: accountId, name: 'Acme', domain: 'acme.com',
    }).run();
  });

  function addEvidence(opts: {
    sourceType: any; signalType?: any; snippet?: string;
    capturedAt?: string; extractionStatus?: any;
  }) {
    db.insert(schema.evidence).values({
      id: newId('evidence'), accountId,
      sourceUrl: 'https://x', sourceType: opts.sourceType,
      signalType: opts.signalType ?? 'none',
      snippet: opts.snippet ?? 'x', extractedFact: 'y',
      extractionStatus: opts.extractionStatus ?? 'verified',
      capturedAt: opts.capturedAt ?? '2026-05-06T12:00:00.000Z',
      capturedBy: 'webhook',
    }).run();
  }

  const NOW = new Date('2026-05-06T12:00:00.000Z');

  it('returns 0 / cold for an account with no signals', async () => {
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(0);
    expect(r.tier).toBe('cold');
    expect(r.rationale).toEqual([]);
  });

  it('sums matching rules at full weight at t=0', async () => {
    addEvidence({ sourceType: 'intent_data' });
    addEvidence({ sourceType: 'web_traffic', snippet: '/pricing visit' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(35);
    expect(r.tier).toBe('hot');
    expect(r.rationale).toHaveLength(2);
  });

  it('decays old signals', async () => {
    // 4 days ago — past R2's 3-day window, so its weight is 0.
    addEvidence({
      sourceType: 'web_traffic', snippet: '/pricing',
      capturedAt: '2026-05-02T12:00:00.000Z',
    });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(0);
  });

  it('skips disputed evidence', async () => {
    addEvidence({ sourceType: 'intent_data', extractionStatus: 'disputed' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(0);
  });

  it('skips pending_audit evidence (only verified contributes to score)', async () => {
    // Use a source that DOES match R1 — only the pending_audit status should
    // exclude it. Otherwise the test would pass for the wrong reason (no rule
    // matched social_post anyway).
    addEvidence({ sourceType: 'intent_data', extractionStatus: 'pending_audit' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(0);
    expect(r.rationale).toEqual([]);
  });

  it('clamps score to 100', async () => {
    for (let i = 0; i < 10; i++) addEvidence({ sourceType: 'intent_data' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    expect(r.score).toBe(100);
  });

  it('writes a leadScores row with rationale citing evidence ids', async () => {
    addEvidence({ sourceType: 'intent_data' });
    const r = await computeScore(accountId, RULES_MD, NOW);
    const stored = db.select().from(schema.leadScores).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].score).toBe(r.score);
    expect(stored[0].rationaleJson[0].evidence_id).toMatch(/^ev_/);
    expect(stored[0].rationaleJson[0].rule_id).toBe('R1');
    expect(r.inserted).toBe(true);
    expect(r.priorTier).toBeUndefined();
  });

  it('is idempotent — same evidence + rules → no new row', async () => {
    addEvidence({ sourceType: 'intent_data' });
    const a = await computeScore(accountId, RULES_MD, NOW);
    const b = await computeScore(accountId, RULES_MD, NOW);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.scoreId).toBe(a.scoreId);
    expect(db.select().from(schema.leadScores).all()).toHaveLength(1);
  });

  it('inserts a new row when rationale changes', async () => {
    addEvidence({ sourceType: 'intent_data' });
    const a = await computeScore(accountId, RULES_MD, NOW);
    addEvidence({ sourceType: 'web_traffic', snippet: '/pricing' });
    const b = await computeScore(accountId, RULES_MD, NOW);
    expect(b.inserted).toBe(true);
    expect(b.scoreId).not.toBe(a.scoreId);
    expect(b.priorTier).toBe(a.tier);
  });
});
```

- [ ] **Step 1.7.2: Run, expect FAIL.**

- [ ] **Step 1.7.3: Implement `lib/scoring/score.ts`**

Two design decisions:
1. **Only `extractionStatus = 'verified'` evidence contributes.** Untrusted sources (scraped social posts, etc.) must clear the Extraction Audit critic before they can move score or routing. This prevents an attacker from forging a tier-promotion alert by spamming the webhook with hostile content.
2. **Recompute is idempotent.** Compute a fingerprint over the rationale; if it matches the latest score's fingerprint, skip the insert and return the existing row. Callers always get a `ScoreResult`; only the `inserted` flag tells them whether anything changed.

```typescript
import { createHash } from 'node:crypto';
import { db, schema } from '@/db';
import { eq, and, desc } from 'drizzle-orm';
import { newId } from '../id';
import { parseScoringRules, evalPredicate, scoreToTier, type Tier } from './rules';
import { linearDecayWeight } from './decay';

export interface ScoreRationaleItem {
  evidence_id: string;
  rule_id: string;
  weight: number;
  reason: string;
}

export interface ScoreResult {
  scoreId: string;
  accountId: string;
  score: number;
  tier: Tier;
  /** Tier of the previous (if any) latest score — used downstream for promotion alerts. */
  priorTier: Tier | undefined;
  rationale: ScoreRationaleItem[];
  /** True if a new lead_scores row was written; false if the recompute was a no-op. */
  inserted: boolean;
}

const MAX_SCORE = 100;

function fingerprint(
  score: number,
  tier: Tier,
  rationale: ScoreRationaleItem[],
  rulesMd: string,
): string {
  // Hash over: score, tier, sorted rationale identity, AND a hash of the rules
  // markdown. Including tier + rulesHash means *any* rule edit (threshold,
  // predicate, weight, window) invalidates the fingerprint and forces a new
  // insert + downstream alert evaluation. Without rulesHash, a threshold-only
  // edit could leave the same fingerprint and silently suppress promotion.
  const norm = rationale
    .map((r) => `${r.rule_id}:${r.evidence_id}:${r.weight}`)
    .sort()
    .join('|');
  const rulesHash = createHash('sha256').update(rulesMd).digest('hex').slice(0, 16);
  return createHash('sha256')
    .update(`${score}::${tier}::${norm}::${rulesHash}`)
    .digest('hex').slice(0, 16);
}

export async function computeScore(
  accountId: string,
  rulesMd: string,
  now: Date = new Date(),
): Promise<ScoreResult> {
  const { rules, thresholds } = parseScoringRules(rulesMd);

  // Verified-only: prevents unaudited signals from forging high tiers.
  const evidenceRows = db.select().from(schema.evidence)
    .where(and(
      eq(schema.evidence.accountId, accountId),
      eq(schema.evidence.extractionStatus, 'verified'),
    )).all();

  const rationale: ScoreRationaleItem[] = [];
  let total = 0;

  for (const ev of evidenceRows) {
    for (const rule of rules) {
      if (!evalPredicate(rule.predicate, ev)) continue;
      const t = new Date(ev.capturedAt);
      const w = linearDecayWeight(rule.weight, t, now, rule.windowDays);
      if (w <= 0) continue;
      rationale.push({
        evidence_id: ev.id,
        rule_id: rule.id,
        weight: w,
        reason: `${rule.id} matched (predicate=${rule.predicate})`,
      });
      total += w;
    }
  }

  const score = Math.min(MAX_SCORE, total);
  const tier = scoreToTier(score, thresholds);
  const fp = fingerprint(score, tier, rationale, rulesMd);

  // Latest existing score for this account (for prior tier and idempotency).
  const latest = db.select().from(schema.leadScores)
    .where(eq(schema.leadScores.accountId, accountId))
    .orderBy(desc(schema.leadScores.computedAt))
    .limit(1).get();

  if (latest && latest.fingerprint === fp) {
    return {
      scoreId: latest.id, accountId,
      score: latest.score, tier: latest.tier,
      priorTier: latest.tier, rationale, inserted: false,
    };
  }

  function isUniqueViolation(err: unknown): boolean {
    // UNIQUE / PRIMARY KEY only — FK / NOT NULL / CHECK errors must propagate.
    const e = err as { code?: string };
    return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
        || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
  }

  const scoreId = newId('leadScore');
  try {
    db.insert(schema.leadScores).values({
      id: scoreId, accountId, score, tier,
      rationaleJson: rationale,
      fingerprint: fp,
      computedAt: now.toISOString(),
    }).run();
    return {
      scoreId, accountId, score, tier,
      priorTier: latest?.tier, rationale, inserted: true,
    };
  } catch (err) {
    // Concurrent recompute: another caller wrote the same (account, fingerprint)
    // first. Re-select that row instead of inserting a duplicate.
    if (!isUniqueViolation(err)) throw err;
    const winner = db.select().from(schema.leadScores)
      .where(and(
        eq(schema.leadScores.accountId, accountId),
        eq(schema.leadScores.fingerprint, fp),
      )).get();
    if (!winner) throw err;
    return {
      scoreId: winner.id, accountId,
      score: winner.score, tier: winner.tier,
      priorTier: latest?.tier, rationale, inserted: false,
    };
  }
}
```

- [ ] **Step 1.7.4: Run, expect PASS.**

- [ ] **Step 1.7.5: Commit.**

```bash
git add lib/scoring/score.ts tests/unit/scoring.test.ts
git commit -m "feat(scoring): computeScore — sums weighted rule matches with decay; writes auditable rationale"
```

---

### Task 1.8: Routing rules + engine

**Files:**
- Create: `data/routing-rules.md`
- Create: `lib/routing/rules.ts`, `lib/routing/route.ts`
- Test: `tests/unit/routing.test.ts`, `tests/unit/routing-rules.test.ts`

- [ ] **Step 1.8.1: Author `data/routing-rules.md`**

```markdown
# Routing rules

Each rule has a stable `id`, a `priority` (lower = evaluated first), an `owner_email`, and a predicate. First matching rule wins. If no rule matches, falls through to the email in `DEFAULT_OWNER_EMAIL` env var.

## RR1 — Hot+ enterprise → senior AE pool

- priority: 10
- predicate: `tier IN ['hot', 'on_fire'] AND firmographic_size == 'enterprise'`
- owner_email: senior-ae-pool@company.example

## RR2 — Warm tier → SDR pool

- priority: 20
- predicate: `tier == 'warm'`
- owner_email: sdr-pool@company.example

## RR3 — Default

- priority: 100
- predicate: `tier == 'cold'`
- owner_email: triage@company.example
```

- [ ] **Step 1.8.2: Write failing test for `lib/routing/rules.ts`**

Create `tests/unit/routing-rules.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseRoutingRules, evalRoutingPredicate } from '../../lib/routing/rules';

const md = `
## RR1 — Hot
- priority: 10
- predicate: \`tier IN ['hot', 'on_fire']\`
- owner_email: ae@x.com

## RR2 — Default
- priority: 100
- predicate: \`tier == 'cold'\`
- owner_email: triage@x.com
`;

describe('parseRoutingRules', () => {
  it('parses with priority + predicate + owner_email, sorted ascending priority', () => {
    const rules = parseRoutingRules(md);
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe('RR1');
    expect(rules[0].priority).toBe(10);
    expect(rules[1].id).toBe('RR2');
  });
});

describe('evalRoutingPredicate', () => {
  it('matches tier IN list', () => {
    expect(evalRoutingPredicate(`tier IN ['hot', 'on_fire']`, { tier: 'hot' } as any)).toBe(true);
    expect(evalRoutingPredicate(`tier IN ['hot', 'on_fire']`, { tier: 'cold' } as any)).toBe(false);
  });
  it('matches firmographic_size from account row', () => {
    expect(evalRoutingPredicate(
      `firmographic_size == 'enterprise'`,
      { tier: 'hot', firmographicSize: 'enterprise' } as any,
    )).toBe(true);
  });
});
```

- [ ] **Step 1.8.3: Run, expect FAIL.**

- [ ] **Step 1.8.4: Implement `lib/routing/rules.ts`**

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tier } from '../scoring/rules';

export interface RoutingRule {
  id: string;
  priority: number;
  predicate: string;
  ownerEmail: string;
}

export interface RoutingContext {
  tier: Tier;
  firmographicSize?: string;
  industry?: string;
  geo?: string;
  hasOwnerHistory?: boolean;
}

export function parseRoutingRules(md: string): RoutingRule[] {
  const rules: RoutingRule[] = [];
  const sections = md.split(/^## /m).slice(1);
  for (const section of sections) {
    const idMatch = section.match(/^(RR\d+)/);
    const priorityMatch = section.match(/- priority:\s*(\d+)/);
    const predMatch = section.match(/- predicate:\s*`([^`]+)`/);
    const ownerMatch = section.match(/- owner_email:\s*(\S+)/);
    if (!idMatch || !priorityMatch || !predMatch || !ownerMatch) continue;
    rules.push({
      id: idMatch[1],
      priority: parseInt(priorityMatch[1], 10),
      predicate: predMatch[1],
      ownerEmail: ownerMatch[1].trim(),
    });
  }
  rules.sort((a, b) => a.priority - b.priority);
  return rules;
}

export function evalRoutingPredicate(pred: string, ctx: RoutingContext): boolean {
  try {
    return evalAndOr(pred.trim(), ctx);
  } catch (err) {
    console.warn(`[routing] predicate failed to evaluate (returning false): ${pred}`, err);
    return false;
  }
}

function evalAndOr(s: string, ctx: RoutingContext): boolean {
  const orParts = s.split(' OR ');
  if (orParts.length > 1) return orParts.some((p) => evalAndOr(p, ctx));
  const andParts = s.split(' AND ');
  if (andParts.length > 1) return andParts.every((p) => evalAndOr(p, ctx));
  return evalLeaf(s.trim(), ctx);
}

function evalLeaf(s: string, ctx: RoutingContext): boolean {
  let m = s.match(/^(\w+)\s+IN\s+\[([^\]]+)\]$/);
  if (m) {
    const list = m[2].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
    return list.includes(String(pluck(m[1], ctx)));
  }
  m = s.match(/^(\w+)\s*==\s*'([^']*)'$/);
  if (m) return pluck(m[1], ctx) === m[2];
  m = s.match(/^(\w+)\s*!=\s*'([^']*)'$/);
  if (m) return pluck(m[1], ctx) !== m[2];
  return false;
}

function pluck(name: string, ctx: RoutingContext): unknown {
  switch (name) {
    case 'tier': return ctx.tier;
    case 'firmographic_size': return ctx.firmographicSize;
    case 'industry': return ctx.industry;
    case 'geo': return ctx.geo;
    case 'has_owner_history': return ctx.hasOwnerHistory ? 'true' : 'false';
    default: return undefined;
  }
}

export function loadRoutingRulesFromDisk(
  path = resolve(process.cwd(), 'data/routing-rules.md'),
): RoutingRule[] {
  return parseRoutingRules(readFileSync(path, 'utf8'));
}
```

- [ ] **Step 1.8.5: Run, expect PASS.**

- [ ] **Step 1.8.6: Write failing test for `route.ts`**

Create `tests/unit/routing.test.ts`. Hoist the same `vi.mock('@/db', ...)` block from `tests/integration/accounts-api.test.ts:11-25` at the top of the file. Then:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { newId } from '../../lib/id';
import { route } from '../../lib/routing/route';

const RULES_MD = `
## RR1 — Hot enterprise
- priority: 10
- predicate: \`tier IN ['hot', 'on_fire'] AND firmographic_size == 'enterprise'\`
- owner_email: ae@x.com

## RR2 — Warm
- priority: 20
- predicate: \`tier == 'warm'\`
- owner_email: sdr@x.com
`;

describe('route', () => {
  let accountId: string, scoreId: string;

  beforeEach(() => {
    db.delete(schema.routingAssignments).run();
    db.delete(schema.leadScores).run();
    db.delete(schema.accounts).run();
    accountId = newId('account');
    db.insert(schema.accounts).values({
      id: accountId, name: 'Acme', domain: 'acme.com', size: 'enterprise',
    }).run();
    scoreId = newId('leadScore');
    db.insert(schema.leadScores).values({
      id: scoreId, accountId, score: 70, tier: 'on_fire',
      fingerprint: 'fp_test_70_onfire', rationaleJson: [],
    }).run();
  });

  it('matches the highest-priority rule and writes assignment', async () => {
    const r = await route(accountId, scoreId, RULES_MD, 'fallback@x.com');
    expect(r.ownerEmail).toBe('ae@x.com');
    expect(r.reason).toBe('rule_match');
    expect(r.matchedRuleKey).toBe('RR1');
    const stored = db.select().from(schema.routingAssignments).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].matchedRuleKey).toBe('RR1');
  });

  it('falls through to default when no rule matches', async () => {
    // Replace the score with a cold-tier one.
    db.delete(schema.leadScores).where(eq(schema.leadScores.id, scoreId)).run();
    const sid = newId('leadScore');
    db.insert(schema.leadScores).values({
      id: sid, accountId, score: 5, tier: 'cold',
      fingerprint: 'cold0', rationaleJson: [],
    }).run();
    const r = await route(accountId, sid, RULES_MD, 'fallback@x.com');
    expect(r.ownerEmail).toBe('fallback@x.com');
    expect(r.reason).toBe('fallback_default');
    expect(r.matchedRuleKey).toBeNull();
  });

  it('is idempotent on repeated route() for the same (scoreId, rulesHash)', async () => {
    const a = await route(accountId, scoreId, RULES_MD, 'fallback@x.com');
    const b = await route(accountId, scoreId, RULES_MD, 'fallback@x.com');
    expect(a.ownerEmail).toBe(b.ownerEmail);
    expect(a.assignmentId).toBe(b.assignmentId);
    expect(db.select().from(schema.routingAssignments).all()).toHaveLength(1);
  });

  it('rejects when score.accountId does not match the passed accountId', async () => {
    const otherId = newId('account');
    db.insert(schema.accounts).values({ id: otherId, name: 'Other' }).run();
    await expect(route(otherId, scoreId, RULES_MD, 'fallback@x.com')).rejects.toThrow(
      /belongs to account/,
    );
  });

  it('creates a fresh assignment when routing rules change (different hash)', async () => {
    const a = await route(accountId, scoreId, RULES_MD, 'fallback@x.com');
    const EDITED_RULES_MD = `
## RR1 — Hot enterprise (edited owner)
- priority: 10
- predicate: \`tier IN ['hot', 'on_fire'] AND firmographic_size == 'enterprise'\`
- owner_email: senior-ae@x.com
`;
    const b = await route(accountId, scoreId, EDITED_RULES_MD, 'fallback@x.com');
    expect(b.ownerEmail).toBe('senior-ae@x.com');
    expect(b.assignmentId).not.toBe(a.assignmentId);
    expect(b.routingRulesHash).not.toBe(a.routingRulesHash);
    expect(db.select().from(schema.routingAssignments).all()).toHaveLength(2);
  });
});
```

- [ ] **Step 1.8.7: Run, expect FAIL.**

- [ ] **Step 1.8.8: Implement `lib/routing/route.ts`**

```typescript
import { createHash } from 'node:crypto';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { newId } from '../id';
import { parseRoutingRules, evalRoutingPredicate, type RoutingContext } from './rules';

export interface RouteResult {
  assignmentId: string;
  accountId: string;
  scoreId: string;
  ownerEmail: string;
  /** Stable parsed-from-Markdown key (e.g. 'RR1'). Null on fallback. */
  matchedRuleKey: string | null;
  reason: 'rule_match' | 'fallback_default';
  /** Hash of the routing-rules.md content used; changing rules → fresh assignment. */
  routingRulesHash: string;
}

function isUniqueViolation(err: unknown): boolean {
  // UNIQUE / PRIMARY KEY only — FK / NOT NULL / CHECK errors must propagate.
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

function hashRules(rulesMd: string): string {
  return createHash('sha256').update(rulesMd).digest('hex').slice(0, 16);
}

export async function route(
  accountId: string,
  scoreId: string,
  rulesMd: string,
  defaultOwnerEmail: string,
): Promise<RouteResult> {
  const rules = parseRoutingRules(rulesMd);
  const routingRulesHash = hashRules(rulesMd);

  const score = db.select().from(schema.leadScores)
    .where(eq(schema.leadScores.id, scoreId)).get();
  if (!score) throw new Error(`leadScore not found: ${scoreId}`);
  // Provenance check: caller must pass an accountId that matches the score's
  // account. Without this guard, an assignment for account A could reference
  // a score row computed for account B.
  if (score.accountId !== accountId) {
    throw new Error(
      `score ${scoreId} belongs to account ${score.accountId}, not ${accountId}`,
    );
  }

  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  if (!account) throw new Error(`account not found: ${accountId}`);

  const ctx: RoutingContext = {
    tier: score.tier,
    firmographicSize: account.size ?? undefined,
    industry: account.industry ?? undefined,
  };

  let matchedRuleKey: string | null = null;
  let ownerEmail = defaultOwnerEmail;
  let reason: RouteResult['reason'] = 'fallback_default';

  for (const rule of rules) {
    if (evalRoutingPredicate(rule.predicate, ctx)) {
      matchedRuleKey = rule.id;
      ownerEmail = rule.ownerEmail;
      reason = 'rule_match';
      break;
    }
  }

  // Idempotency: unique key is (accountId, scoreId, routingRulesHash). When
  // routing rules change, the hash changes and a fresh assignment is created
  // for the same scoreId — recompute under new rules just works.
  const assignmentId = newId('routingAssignment');
  try {
    db.insert(schema.routingAssignments).values({
      id: assignmentId, accountId, ownerEmail,
      reason, matchedRuleKey, scoreId, routingRulesHash,
    }).run();
    return { assignmentId, accountId, scoreId, ownerEmail, matchedRuleKey, reason, routingRulesHash };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = db.select().from(schema.routingAssignments)
      .where(and(
        eq(schema.routingAssignments.accountId, accountId),
        eq(schema.routingAssignments.scoreId, scoreId),
        eq(schema.routingAssignments.routingRulesHash, routingRulesHash),
      )).get();
    if (!winner) throw err;
    return {
      assignmentId: winner.id, accountId, scoreId,
      ownerEmail: winner.ownerEmail,
      matchedRuleKey: winner.matchedRuleKey,
      reason: winner.reason as RouteResult['reason'],
      routingRulesHash: winner.routingRulesHash,
    };
  }
}
```

- [ ] **Step 1.8.9: Run tests, expect PASS.**

- [ ] **Step 1.8.10: Commit.**

```bash
git add data/routing-rules.md lib/routing tests/unit/routing.test.ts tests/unit/routing-rules.test.ts
git commit -m "feat(routing): RR rules format + parser + first-match engine with default fallback"
```

---

### Task 1.9: POST /api/scoring/recompute (orchestrate signal → score → route)

**Files:**
- Create: `app/api/scoring/recompute/route.ts`
- Test: extend `tests/integration/signals-api.test.ts` (or create `tests/integration/inbound-pipeline.test.ts`)

- [ ] **Step 1.9.1: Write failing pipeline test**

Create `tests/integration/inbound-pipeline.test.ts`. (Use the in-memory db mock pattern.) Set the webhook secret in `beforeEach` so signals come in as `trustedSender: true` → `verified` → contribute to score. **Use a relative `captured_at` (now-minus-N-minutes) so the integration test is not time-bombed by decay windows.**

```typescript
import { POST as postSignal } from '../../app/api/signals/route';
import { POST as postRecompute } from '../../app/api/scoring/recompute/route';

const SECRET = 'test-signal-secret';

const SAVED_ENV: Record<string, string | undefined> = {};
beforeEach(() => {
  SAVED_ENV.SIGNAL_WEBHOOK_SECRET = process.env.SIGNAL_WEBHOOK_SECRET;
  SAVED_ENV.DEFAULT_OWNER_EMAIL = process.env.DEFAULT_OWNER_EMAIL;
  SAVED_ENV.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
  process.env.SIGNAL_WEBHOOK_SECRET = SECRET;
  process.env.DEFAULT_OWNER_EMAIL = 'fallback@x.com';
  delete process.env.INTERNAL_API_SECRET;  // recompute open in tests
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function nowIso(): string { return new Date().toISOString(); }

function postSig(body: object) {
  return postSignal(new Request('http://x/api/signals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET },
    body: JSON.stringify(body),
  }));
}

describe('inbound pipeline: signal → score → route', () => {
  it('end-to-end produces a score and a routing assignment', async () => {
    // 1. Post a signal with current timestamp.
    const sig = await postSig({
      source: 'intent_data', account_domain: 'acme.com',
      signal_type: 'intent', fact: 'spike',
      source_url: 'https://bombora.example/x',
      snippet: 'Surge weekly 87',
      captured_at: nowIso(),
    });
    const { accountId } = await sig.json();

    // 2. Recompute scoring + routing for that account.
    const rec = await postRecompute(new Request('http://x/api/scoring/recompute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    }));
    expect(rec.status).toBe(200);
    const body = await rec.json();
    expect(body.score).toBeGreaterThan(0);
    expect(body.tier).toBeDefined();
    expect(body.ownerEmail).toBeTruthy();
  });
});
```

- [ ] **Step 1.9.2: Run, expect FAIL.**

- [ ] **Step 1.9.3: Implement route (no alerts yet — those land in Task 2.2)**

Three decisions:
1. **Rule overrides via request body are removed.** Allowing the caller to inject arbitrary scoring/routing Markdown is a privilege-escalation vector. Rules live on disk only.
2. **Optional shared-secret auth.** Same pattern as `/api/signals`: when `INTERNAL_API_SECRET` is set, the request must present `X-Internal-Secret`.
3. **Alert dispatch is intentionally *not* imported here.** The dispatcher (`lib/alerts/dispatch.ts`) is created in Task 2.1; the wiring of `dispatchTierPromotion`/`dispatchEngagementSpike` calls into this route happens in Task 2.2 by editing this same file. Phase 1's verification is just "score and route compute correctly"; alerts are Phase 2.

Create `app/api/scoring/recompute/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeScore } from '@/lib/scoring/score';
import { route as routeAccount } from '@/lib/routing/route';

const Body = z.object({ accountId: z.string().min(1) });

function requireSecret(req: Request): NextResponse | null {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) return null;
  const got = req.headers.get('x-internal-secret');
  if (got !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return null;
}

export async function POST(req: Request) {
  const guard = requireSecret(req);
  if (guard) return guard;

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }

  const root = process.cwd();
  const scoringMd = readFileSync(resolve(root, 'data/scoring-rules.md'), 'utf8');
  const routingMd = readFileSync(resolve(root, 'data/routing-rules.md'), 'utf8');
  const defaultOwner = process.env.DEFAULT_OWNER_EMAIL ?? 'triage@example.com';

  try {
    const score = await computeScore(parsed.data.accountId, scoringMd);
    const assignment = await routeAccount(
      parsed.data.accountId, score.scoreId, routingMd, defaultOwner,
    );
    return NextResponse.json({
      scoreId: score.scoreId,
      score: score.score,
      tier: score.tier,
      priorTier: score.priorTier ?? null,
      inserted: score.inserted,
      rationale: score.rationale,
      assignmentId: assignment.assignmentId,
      ownerEmail: assignment.ownerEmail,
      matchedRuleKey: assignment.matchedRuleKey,
      reason: assignment.reason,
      alerts: [],  // populated in Task 2.2
    }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal', detail: (err as Error).message },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 1.9.4: Run, expect PASS.**

- [ ] **Step 1.9.5: Commit.**

```bash
git add app/api/scoring tests/integration/inbound-pipeline.test.ts
git commit -m "feat(api): POST /api/scoring/recompute orchestrating compute + route"
```

---

### Task 1.10: Inbound UI page

**Files:**
- Create: `app/inbound/page.tsx`, `components/SignalRow.tsx`, `components/TierBadge.tsx`, `components/ScoreRationale.tsx`

- [ ] **Step 1.10.1: TierBadge component**

Create `components/TierBadge.tsx`:

```typescript
import type { Tier } from '@/lib/scoring/rules';

const STYLES: Record<Tier, string> = {
  cold: 'bg-slate-200 text-slate-700',
  warm: 'bg-amber-100 text-amber-800',
  hot: 'bg-orange-200 text-orange-900',
  on_fire: 'bg-red-200 text-red-900',
};
const LABEL: Record<Tier, string> = {
  cold: 'Cold', warm: 'Warm', hot: 'Hot', on_fire: 'On fire',
};

export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span className={`px-2 py-0.5 text-xs rounded ${STYLES[tier]}`}>
      {LABEL[tier]}
    </span>
  );
}
```

- [ ] **Step 1.10.2: ScoreRationale component**

Create `components/ScoreRationale.tsx`:

```typescript
interface RationaleItem {
  evidence_id: string;
  rule_id: string;
  weight: number;
  reason: string;
}

export function ScoreRationale({
  items, score, tier,
}: { items: RationaleItem[]; score: number; tier: string }) {
  return (
    <div className="border rounded p-3 text-sm">
      <div className="flex justify-between mb-2">
        <span className="font-medium">Score</span>
        <span>{score} ({tier})</span>
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-slate-700">
            <span className="font-mono text-xs mr-2">{it.rule_id}</span>
            <span className="mr-2">+{it.weight}</span>
            <span className="text-slate-500">cites {it.evidence_id}</span>
          </li>
        ))}
        {items.length === 0 && <li className="text-slate-400">No matching signals.</li>}
      </ul>
    </div>
  );
}
```

- [ ] **Step 1.10.3: SignalRow component**

Create `components/SignalRow.tsx`:

```typescript
export function SignalRow({
  capturedAt, sourceType, snippet, accountDomain,
}: {
  capturedAt: string; sourceType: string; snippet: string; accountDomain: string;
}) {
  const ts = new Date(capturedAt).toLocaleString();
  return (
    <tr className="border-b">
      <td className="py-1 px-2 text-xs text-slate-500 whitespace-nowrap">{ts}</td>
      <td className="py-1 px-2 font-mono text-xs">{sourceType}</td>
      <td className="py-1 px-2 text-xs">{accountDomain}</td>
      <td className="py-1 px-2 text-xs text-slate-700">{snippet.slice(0, 120)}</td>
    </tr>
  );
}
```

- [ ] **Step 1.10.4: Inbound page**

Create `app/inbound/page.tsx` (server component fetching directly from db):

```typescript
import { db, schema } from '@/db';
import { desc, ne } from 'drizzle-orm';
import { TierBadge } from '@/components/TierBadge';
import { SignalRow } from '@/components/SignalRow';

export const dynamic = 'force-dynamic';

export default async function InboundPage() {
  // Most recent 50 signal-typed evidence rows (any signalType except 'none').
  const recentSignals = db.select({
    id: schema.evidence.id,
    capturedAt: schema.evidence.capturedAt,
    sourceType: schema.evidence.sourceType,
    snippet: schema.evidence.snippet,
    accountId: schema.evidence.accountId,
  }).from(schema.evidence)
    .where(ne(schema.evidence.signalType, 'none'))
    .orderBy(desc(schema.evidence.capturedAt))
    .limit(50)
    .all();

  // Top-scored accounts: latest score per account, ordered desc.
  // Simpler v1: pull all scores, group in JS.
  const allScores = db.select().from(schema.leadScores)
    .orderBy(desc(schema.leadScores.computedAt)).all();
  const latestByAccount = new Map<string, typeof allScores[number]>();
  for (const s of allScores) {
    if (!latestByAccount.has(s.accountId)) latestByAccount.set(s.accountId, s);
  }
  const topScored = Array.from(latestByAccount.values())
    .sort((a, b) => b.score - a.score).slice(0, 25);

  const accountById = new Map(
    db.select().from(schema.accounts).all().map((a) => [a.id, a]),
  );

  return (
    <main className="p-6 space-y-6">
      <h1 className="text-xl font-semibold">Inbound</h1>

      <section>
        <h2 className="text-lg font-medium mb-2">Top-scored accounts</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-1 px-2">Account</th>
              <th className="py-1 px-2">Score</th>
              <th className="py-1 px-2">Tier</th>
              <th className="py-1 px-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {topScored.map((s) => {
              const a = accountById.get(s.accountId);
              return (
                <tr key={s.id} className="border-b">
                  <td className="py-1 px-2">
                    <a className="text-blue-700 hover:underline" href={`/accounts/${s.accountId}`}>
                      {a?.name ?? s.accountId}
                    </a>
                  </td>
                  <td className="py-1 px-2 font-mono">{s.score}</td>
                  <td className="py-1 px-2"><TierBadge tier={s.tier} /></td>
                  <td className="py-1 px-2 text-xs text-slate-500">
                    {new Date(s.computedAt).toLocaleString()}
                  </td>
                </tr>
              );
            })}
            {topScored.length === 0 && (
              <tr><td colSpan={4} className="py-2 px-2 text-slate-400">No scores yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Recent signals</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-1 px-2">When</th>
              <th className="py-1 px-2">Source</th>
              <th className="py-1 px-2">Account</th>
              <th className="py-1 px-2">Snippet</th>
            </tr>
          </thead>
          <tbody>
            {recentSignals.map((s) => (
              <SignalRow key={s.id}
                capturedAt={s.capturedAt}
                sourceType={s.sourceType}
                snippet={s.snippet}
                accountDomain={accountById.get(s.accountId)?.domain ?? ''}
              />
            ))}
            {recentSignals.length === 0 && (
              <tr><td colSpan={4} className="py-2 px-2 text-slate-400">No signals yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
```

- [ ] **Step 1.10.5: Mount `ScoreRationale` on the account detail page**

The `ScoreRationale` component is created in 1.10.2 but unused unless it's mounted on `app/accounts/[id]/page.tsx`. Add a Score panel section.

Read the existing `app/accounts/[id]/page.tsx` first (it's a server component returning JSX). Locate the JSX `return` block. Just before the existing top-level closing `</main>` (or analogous container), insert this block:

```tsx
{/* Score panel — latest score for this account, with rationale. */}
{(() => {
  const latest = db.select().from(schema.leadScores)
    .where(eq(schema.leadScores.accountId, params.id))  // or however account id is bound
    .orderBy(desc(schema.leadScores.computedAt))
    .limit(1).get();
  if (!latest) return null;
  return (
    <section className="mt-6">
      <h2 className="text-lg font-medium mb-2">Score</h2>
      <ScoreRationale items={latest.rationaleJson} score={latest.score} tier={latest.tier} />
    </section>
  );
})()}
```

Add the matching imports at the top of the file:

```typescript
import { db, schema } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { ScoreRationale } from '@/components/ScoreRationale';
```

> Implementation note: read the existing file first to find the right binding for the account id (`params.id`, `await params`, etc.) and to ensure these imports aren't duplicated. If the file already imports `db, schema`, reuse those.

- [ ] **Step 1.10.6: Smoke-test the page**

```bash
pnpm dev
# Open http://localhost:3000/inbound — should render with empty tables.
# Then post a signal:
curl -X POST http://localhost:3000/api/signals \
  -H 'Content-Type: application/json' \
  -d '{"source":"intent_data","account_domain":"acme.com","signal_type":"intent","fact":"x","source_url":"https://x.example","snippet":"Surge weekly 87","captured_at":"2026-05-06T12:00:00.000Z"}'
# Recompute (use the accountId from the response above):
curl -X POST http://localhost:3000/api/scoring/recompute \
  -H 'Content-Type: application/json' \
  -d "{\"accountId\":\"<account_id>\"}"
# Reload /inbound — should show 1 signal and 1 scored account.
# Open the account page — Score panel should render the rationale.
```

Expected: tables populate; account detail page renders the Score panel.

- [ ] **Step 1.10.7: Add nav links in `app/layout.tsx`**

`app/layout.tsx` currently has no nav. The new `/inbound` and (Phase-2) `/alerts` pages are unreachable from the app's main shell unless we add links. Modify it to include a small top nav.

Read the current `app/layout.tsx` first; replace the body with:

```tsx
import './globals.css';
import type { ReactNode } from 'react';
import Link from 'next/link';

export const metadata = { title: 'Sales', description: 'Grounded sales tool' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        <header className="border-b bg-white">
          <nav className="mx-auto max-w-6xl px-6 py-3 flex gap-4 text-sm">
            <Link href="/" className="font-semibold">Sales</Link>
            <span className="text-neutral-300">·</span>
            <Link href="/" className="hover:underline">Accounts</Link>
            <Link href="/inbound" className="hover:underline">Inbound</Link>
            <Link href="/alerts" className="hover:underline">Alerts</Link>
          </nav>
        </header>
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </body>
    </html>
  );
}
```

> Note: the `/alerts` link will 404 until Task 2.3 ships. That's fine for ordering — the link is harmless until then.

- [ ] **Step 1.10.8: Commit**

```bash
git add app/inbound app/layout.tsx app/accounts/[id]/page.tsx components/TierBadge.tsx components/ScoreRationale.tsx components/SignalRow.tsx
git commit -m "feat(ui): /inbound page + ScoreRationale panel on account detail; nav links"
```

---

## Phase 2 — Alerts

### Task 2.1: Alert rules + dispatch core

**Files:**
- Create: `data/alert-rules.md`, `lib/alerts/dispatch.ts`, `lib/alerts/render.ts`
- Create: `lib/alerts/channels/slack.ts`, `lib/alerts/channels/email.ts`, `lib/alerts/channels/webhook.ts`
- Test: `tests/unit/alert-dispatch.test.ts`

- [ ] **Step 2.1.1: Author `data/alert-rules.md`**

> **v1 status:** This file is the **design reference** for v1.5's pluggable alert routing. The v1 dispatcher (next steps) **hardcodes** the trigger → severity → channels mapping below. The file is committed so the contract is visible and reviewable, and so swapping in a parser later is purely additive. Do not let this file silently diverge from `lib/alerts/dispatch.ts` — when you change the dispatcher, update the rules here in the same commit.

```markdown
# Alert rules (v1: documents v1.5 contract; v1 dispatcher hardcodes equivalents)

Each rule maps a trigger to one or more channels and a severity. Channels: `slack`, `email`, `webhook`. If a channel's secret/URL env var is unset, the dispatcher falls back to writing the payload to `outbox/<channel>-<alertId>.json` (channel recorded as `'file'`).

## A1 — Tier promotion (any → warm/hot)

- trigger: `tier_promotion`
- severity: priority
- channels: [slack]

## A2 — On-fire tier

- trigger: `tier_promotion`
- min_to_tier: on_fire
- severity: urgent
- channels: [slack, email]

## A3 — Engagement spike

- trigger: `engagement_spike`
- severity: priority
- channels: [slack]

## A4 — Competitor mention (v1.5 — not yet wired)

- trigger: `competitor_mention`
- severity: info
- channels: [webhook]
```

- [ ] **Step 2.1.2: Failing test for tier-promotion detection**

Create `tests/unit/alert-dispatch.test.ts`. Use in-memory db mock. **Mock `spawnClaude` at the top of the file so the dispatcher's `renderAlertText()` exercises its deterministic fallback instead of actually shelling out to `claude`** — without this the test is slow/flaky and depends on local CLI auth.

```typescript
import { vi } from 'vitest';

// Force renderAlertText() to fall back to its deterministic template.
vi.mock('../../lib/claude/run', () => ({
  spawnClaude: vi.fn(() => Promise.reject(new Error('test mock — force deterministic fallback'))),
  RateLimitError: class extends Error {},
  ClaudeError: class extends Error {},
}));

import { detectTierPromotion } from '../../lib/alerts/dispatch';

describe('alert dispatch — reserve-then-send', () => {
  beforeEach(() => {
    db.delete(schema.alerts).run();
    db.delete(schema.accounts).run();
    delete process.env.SLACK_WEBHOOK_URL;  // force file-fallback delivery
  });

  it('inserts alert row first then sends; concurrent calls dispatch only once', async () => {
    const accountId = newId('account');
    db.insert(schema.accounts).values({ id: accountId, name: 'Race Co' }).run();
    const scoreId = newId('leadScore');
    db.insert(schema.leadScores).values({
      id: scoreId, accountId, score: 80, tier: 'on_fire',
      fingerprint: 'fp_race', rationaleJson: [],
    }).run();

    const { dispatchTierPromotion } = await import('../../lib/alerts/dispatch');
    const [a, b, c] = await Promise.all([
      dispatchTierPromotion(accountId, 'warm', 'on_fire', scoreId),
      dispatchTierPromotion(accountId, 'warm', 'on_fire', scoreId),
      dispatchTierPromotion(accountId, 'warm', 'on_fire', scoreId),
    ]);
    const wins = [a, b, c].filter((r) => r !== null);
    expect(wins).toHaveLength(1);  // exactly one caller wins the cooldown
    const row = db.select().from(schema.alerts).all();
    expect(row).toHaveLength(1);
    // Channel records reflect the file-fallback (since SLACK_WEBHOOK_URL is unset).
    const channels = row[0].channelsSentJson;
    expect(channels.length).toBeGreaterThan(0);
    expect(channels.every((c) => c.channel === 'file' || c.channel === 'slack')).toBe(true);
  });
});

describe('detectTierPromotion', () => {
  it('returns null when prior tier equals new tier', () => {
    expect(detectTierPromotion('warm', 'warm')).toBeNull();
  });
  it('returns the new tier when promoted', () => {
    expect(detectTierPromotion('cold', 'warm')).toBe('warm');
    expect(detectTierPromotion('warm', 'on_fire')).toBe('on_fire');
  });
  it('returns null on demotion', () => {
    expect(detectTierPromotion('hot', 'warm')).toBeNull();
  });
  it('returns the new tier when prior is undefined and not cold', () => {
    expect(detectTierPromotion(undefined, 'warm')).toBe('warm');
    expect(detectTierPromotion(undefined, 'hot')).toBe('hot');
  });
  it('returns null on first-ever cold score', () => {
    // First score is cold = nothing to alert about.
    expect(detectTierPromotion(undefined, 'cold')).toBeNull();
  });
});
```

- [ ] **Step 2.1.3: Run, expect FAIL.**

- [ ] **Step 2.1.4: Implement detection + dispatch**

Three design decisions:
1. **`AlertChannel` is a typed union** matching the schema enum exactly.
2. **File fallback is recorded honestly** — when `SLACK_WEBHOOK_URL` is unset and we write to `outbox/`, the row's `channel` field is `'file'`, not `'slack'`. The send function returns its actual delivery channel, not just a boolean.
3. **`engagement_spike` is cooldown-keyed** to one alert per account per UTC day. The unique index on `alerts.cooldownKey` enforces this at the DB layer; the catch-and-skip pattern handles concurrent races.

```typescript
import { db, schema } from '@/db';
import { eq, and, gte } from 'drizzle-orm';
import { newId } from '../id';
import type { Tier } from '../scoring/rules';
import { renderAlertText } from './render';
import { sendSlack } from './channels/slack';
import { sendEmail } from './channels/email';
import { sendWebhook } from './channels/webhook';

const TIER_RANK: Record<Tier, number> = { cold: 0, warm: 1, hot: 2, on_fire: 3 };

export type AlertChannel = 'slack' | 'email' | 'webhook' | 'file';

export interface ChannelDelivery {
  channel: AlertChannel;
  ok: boolean;
  sent_at: string;
  detail?: string;
}

export interface DispatchResult {
  alertId: string;
  channelsSent: ChannelDelivery[];
}

export function detectTierPromotion(
  prior: Tier | undefined,
  now: Tier,
): Tier | null {
  // First-ever score for an account: only treat the initial classification as
  // a "promotion" when it lands at warm or higher. Cold has nothing
  // interesting to announce.
  if (prior === undefined) return now === 'cold' ? null : now;
  if (TIER_RANK[now] > TIER_RANK[prior]) return now;
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  // UNIQUE / PRIMARY KEY only — FK / NOT NULL / CHECK errors must propagate.
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

// Pattern: RESERVE-THEN-SEND. Insert the alerts row first with empty
// channelsSentJson and a unique cooldownKey. If two callers race, exactly one
// wins the insert (the other catches SQLITE_CONSTRAINT and exits without
// sending). Then the winner performs side effects and UPDATEs the row.
//
// This guarantees external sends fire AT MOST once per cooldown key — even
// if two recompute requests arrive simultaneously.

export async function dispatchTierPromotion(
  accountId: string,
  fromTier: Tier | undefined,
  toTier: Tier,
  scoreId: string,
): Promise<DispatchResult | null> {
  const promoted = detectTierPromotion(fromTier, toTier);
  if (!promoted) return null;

  const severity: 'info' | 'priority' | 'urgent' =
    promoted === 'on_fire' ? 'urgent' : 'priority';
  const cooldownKey = `tier_promotion:${accountId}:${scoreId}`;

  // (1) Reserve the alert row with empty channels.
  const alertId = newId('alert');
  try {
    db.insert(schema.alerts).values({
      id: alertId, accountId, trigger: 'tier_promotion', severity,
      payloadJson: { fromTier: fromTier ?? null, toTier: promoted, scoreId },
      channelsSentJson: [],
      cooldownKey,
    }).run();
  } catch (err) {
    if (isUniqueViolation(err)) return null;  // someone else owns this cooldown key
    throw err;
  }

  // (2) Render text and send to channels (we own the cooldown key now).
  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  const text = await renderAlertText({
    trigger: 'tier_promotion',
    accountName: account?.name ?? accountId,
    accountId, fromTier, toTier: promoted, scoreId,
  });

  const channelTargets: AlertChannel[] = promoted === 'on_fire' ? ['slack', 'email'] : ['slack'];
  const sent: ChannelDelivery[] = [];
  for (const target of channelTargets) {
    const sendAt = new Date().toISOString();
    try {
      if (target === 'slack') sent.push(await sendSlack(text, alertId, sendAt));
      else if (target === 'email') sent.push(
        await sendEmail(`[Signal Alert] ${account?.name ?? accountId}`, text, alertId, sendAt));
      else if (target === 'webhook') sent.push(
        await sendWebhook({ alertId, text, accountId }, alertId, sendAt));
    } catch (err) {
      sent.push({ channel: target, ok: false, sent_at: sendAt, detail: (err as Error).message });
    }
  }

  // (3) Update the row with delivery results + rendered text.
  db.update(schema.alerts).set({
    payloadJson: { fromTier: fromTier ?? null, toTier: promoted, scoreId, text },
    channelsSentJson: sent,
  }).where(eq(schema.alerts.id, alertId)).run();

  return { alertId, channelsSent: sent };
}

// signal/source types treated as "engagement-like" for spike detection.
const ENGAGEMENT_LIKE_SIGNAL_TYPES: readonly string[] = ['intent', 'engagement', 'trigger_event'];

export async function dispatchEngagementSpike(
  accountId: string,
  now: Date = new Date(),
  windowHours = 24,
  thresholdCount = 3,
): Promise<DispatchResult | null> {
  const since = new Date(now.getTime() - windowHours * 3600 * 1000).toISOString();
  const recent = db.select().from(schema.evidence)
    .where(and(
      eq(schema.evidence.accountId, accountId),
      eq(schema.evidence.extractionStatus, 'verified'),
      gte(schema.evidence.capturedAt, since),
    )).all()
    .filter((e) => ENGAGEMENT_LIKE_SIGNAL_TYPES.includes(e.signalType));
  if (recent.length < thresholdCount) return null;

  // One spike alert per account per UTC day.
  const dayBucket = now.toISOString().slice(0, 10);
  const cooldownKey = `engagement_spike:${accountId}:${dayBucket}`;

  // (1) Reserve.
  const alertId = newId('alert');
  try {
    db.insert(schema.alerts).values({
      id: alertId, accountId, trigger: 'engagement_spike', severity: 'priority',
      payloadJson: { countInWindow: recent.length, windowHours },
      channelsSentJson: [],
      cooldownKey,
    }).run();
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }

  // (2) Render + send.
  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  const text = await renderAlertText({
    trigger: 'engagement_spike',
    accountName: account?.name ?? accountId,
    accountId,
    countInWindow: recent.length, windowHours,
  });
  const sendAt = new Date().toISOString();
  let delivery: ChannelDelivery;
  try {
    delivery = await sendSlack(text, alertId, sendAt);
  } catch (err) {
    delivery = { channel: 'slack', ok: false, sent_at: sendAt, detail: (err as Error).message };
  }

  // (3) Update.
  db.update(schema.alerts).set({
    payloadJson: { countInWindow: recent.length, windowHours, text },
    channelsSentJson: [delivery],
  }).where(eq(schema.alerts.id, alertId)).run();

  return { alertId, channelsSent: [delivery] };
}
```

- [ ] **Step 2.1.5: Implement render + channels**

Create `lib/alerts/render.ts`:

```typescript
import { spawnClaude } from '../claude/run';
import { z } from 'zod';

export interface AlertContext {
  trigger: 'tier_promotion' | 'engagement_spike' | 'competitor_mention' | 'manual';
  accountName: string;
  accountId: string;
  fromTier?: string;
  toTier?: string;
  scoreId?: string;
  countInWindow?: number;
  windowHours?: number;
}

const Out = z.object({ text: z.string().min(1).max(500) });

const SYSTEM = `You write short Slack-ready alert messages for a sales team.
Output JSON: {"text": "..."} only. Plain text inside, no markdown formatting,
no code fences, no salutations. <=2 sentences. Mention the account name once.
Include the trigger reason and a clear next step.`;

export async function renderAlertText(ctx: AlertContext): Promise<string> {
  const prompt = `${SYSTEM}\n\nContext: ${JSON.stringify(ctx)}`;
  try {
    const out = await spawnClaude({ prompt, schema: Out, model: 'haiku', timeoutMs: 30_000 });
    return out.text;
  } catch {
    // Deterministic fallback so we never block the alert path on LLM failure.
    if (ctx.trigger === 'tier_promotion') {
      return `${ctx.accountName} promoted ${ctx.fromTier ?? 'unknown'} → ${ctx.toTier}. Open the account view to see the rationale.`;
    }
    if (ctx.trigger === 'engagement_spike') {
      return `${ctx.accountName} had ${ctx.countInWindow} signals in the last ${ctx.windowHours}h. Worth a look.`;
    }
    return `${ctx.accountName}: ${ctx.trigger}.`;
  }
}
```

Create `lib/alerts/channels/slack.ts`. Each channel function returns a `ChannelDelivery` describing what actually shipped — `'slack'` if the HTTP webhook succeeded, `'file'` if we fell back to disk:

```typescript
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChannelDelivery } from '../dispatch';

export async function sendSlack(
  text: string, alertId: string, sentAt: string,
): Promise<ChannelDelivery> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    const dir = resolve(process.cwd(), 'outbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `slack-${alertId}.json`), JSON.stringify({ text }, null, 2));
    return { channel: 'file', ok: true, sent_at: sentAt, detail: 'slack webhook unset; wrote to outbox/' };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return res.ok
    ? { channel: 'slack', ok: true, sent_at: sentAt }
    : { channel: 'slack', ok: false, sent_at: sentAt, detail: `HTTP ${res.status}` };
}
```

Create `lib/alerts/channels/email.ts`:

```typescript
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChannelDelivery } from '../dispatch';

export async function sendEmail(
  subject: string, body: string, alertId: string, sentAt: string,
): Promise<ChannelDelivery> {
  // No SMTP integration in v1; always file fallback.
  const dir = resolve(process.cwd(), 'outbox');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `email-${alertId}.eml`);
  const eml = [
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join('\r\n');
  writeFileSync(path, eml);
  return { channel: 'file', ok: true, sent_at: sentAt, detail: 'no SMTP; wrote .eml to outbox/' };
}
```

Create `lib/alerts/channels/webhook.ts`:

```typescript
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChannelDelivery } from '../dispatch';

export async function sendWebhook(
  payload: unknown, alertId: string, sentAt: string,
): Promise<ChannelDelivery> {
  const url = process.env.GENERIC_WEBHOOK_URL;
  if (!url) {
    const dir = resolve(process.cwd(), 'outbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `webhook-${alertId}.json`), JSON.stringify(payload, null, 2));
    return { channel: 'file', ok: true, sent_at: sentAt, detail: 'GENERIC_WEBHOOK_URL unset; wrote to outbox/' };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.ok
    ? { channel: 'webhook', ok: true, sent_at: sentAt }
    : { channel: 'webhook', ok: false, sent_at: sentAt, detail: `HTTP ${res.status}` };
}
```

- [ ] **Step 2.1.6: Run dispatch tests, expect PASS.**

```bash
pnpm test tests/unit/alert-dispatch.test.ts
```

- [ ] **Step 2.1.7: Commit.**

```bash
git add data/alert-rules.md lib/alerts tests/unit/alert-dispatch.test.ts
git commit -m "feat(alerts): tier-promotion + engagement-spike dispatch with file-fallback channels"
```

---

### Task 2.2: Wire alerts into /api/scoring/recompute + integration test

**Files:**
- Modify: `app/api/scoring/recompute/route.ts`
- Modify: `tests/integration/inbound-pipeline.test.ts`

- [ ] **Step 2.2.1: Add alert dispatch calls to the recompute route**

Edit `app/api/scoring/recompute/route.ts`. Add the imports at the top:

```typescript
import { dispatchTierPromotion, dispatchEngagementSpike } from '@/lib/alerts/dispatch';
```

Replace the `alerts: []` line in the success response with a real dispatch block. Insert this block immediately after the `routeAccount(...)` call and before the `return NextResponse.json(...)`:

```typescript
    // Best-effort alerting.
    //
    // - tier_promotion: only when the score *changed* (score.inserted=true).
    //   No state change means no promotion to announce.
    // - engagement_spike: ALWAYS attempt. Engagement-like signals (Outreach
    //   opens, GitHub stars, etc.) often don't match any scoring rule and
    //   therefore don't change the fingerprint, but still represent real
    //   activity worth alerting on. The cooldown key (account+UTC-day)
    //   prevents duplicates per day.
    const alertResults: Array<{ trigger: string; alertId: string }> = [];
    if (score.inserted) {
      try {
        const tp = await dispatchTierPromotion(
          parsed.data.accountId, score.priorTier, score.tier, score.scoreId);
        if (tp) alertResults.push({ trigger: 'tier_promotion', alertId: tp.alertId });
      } catch (err) { console.error('tier-promotion dispatch failed:', err); }
    }
    try {
      const sp = await dispatchEngagementSpike(parsed.data.accountId);
      if (sp) alertResults.push({ trigger: 'engagement_spike', alertId: sp.alertId });
    } catch (err) { console.error('engagement-spike dispatch failed:', err); }
```

Then in the response, change `alerts: []` to `alerts: alertResults`.

- [ ] **Step 2.2.2: Extend the integration test**

These tests reuse the `postSig` helper and `SECRET` from Step 1.9.1, so signals arrive as authenticated and become `verified` → contribute to score.

```typescript
it('dispatches a tier-promotion alert when score crosses thresholds', async () => {
  // 4 distinct intent signals → 4 × R1@20 = 80 → on_fire tier.
  let accId = '';
  for (let i = 0; i < 4; i++) {
    const res = await postSig({
      source: 'intent_data', account_domain: 'acme2.com',
      signal_type: 'intent', fact: `x${i}`,
      source_url: `https://bombora.example/${i}`, snippet: `s${i}-unique`,
      captured_at: nowIso(),
    });
    accId = (await res.json()).accountId;
  }
  const r = await postRecompute(new Request('http://x/api/scoring/recompute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: accId }),
  }));
  const body = await r.json();
  expect(body.tier).toBe('on_fire');
  expect(body.alerts).toEqual(expect.arrayContaining([
    expect.objectContaining({ trigger: 'tier_promotion' }),
  ]));
});

it('does not dispatch a duplicate tier-promotion on identical recompute', async () => {
  let accId = '';
  for (const s of ['a', 'b', 'c', 'd']) {
    accId = (await (await postSig({
      source: 'intent_data', account_domain: 'noop.com',
      signal_type: 'intent', fact: 'x',
      source_url: `https://x.example/${s}`, snippet: `${s}-snippet`,
      captured_at: nowIso(),
    })).json()).accountId;
  }
  const r1 = await (await postRecompute(new Request('http://x/api/scoring/recompute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: accId }),
  }))).json();
  const r2 = await (await postRecompute(new Request('http://x/api/scoring/recompute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: accId }),
  }))).json();
  expect(r1.inserted).toBe(true);
  expect(r2.inserted).toBe(false);
  expect(r2.alerts).toEqual([]);
});

it('does not dispatch tier_promotion when first-ever score is cold', async () => {
  // Single low-weight signal that scores under the warm threshold (15).
  // R6 (github starred competitor) is +5; one occurrence yields 5 → cold tier.
  const res = await postSig({
    source: 'github_event', account_domain: 'github.com/lone-star',
    captured_by: 'connector_github',
    signal_type: 'engagement', fact: 'one star',
    source_url: 'https://github.com/foo/bar/stargazers',
    snippet: 'lone-star starred foo/bar (competitor classification)',
    captured_at: nowIso(),
  });
  const accId = (await res.json()).accountId;
  // Audit-bypass for this test: directly verify the row so it scores. (The
  // ingest layer marks github_event from authenticated senders as verified
  // already; if your TRUSTED_SOURCES set differs, manually update the row.)
  const r = await (await postRecompute(new Request('http://x/api/scoring/recompute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: accId }),
  }))).json();
  expect(['cold']).toContain(r.tier);
  // Critical: no tier_promotion alert should fire on first-ever cold.
  const tps = (r.alerts as Array<{ trigger: string }>).filter((a) => a.trigger === 'tier_promotion');
  expect(tps).toEqual([]);
});

it('fires engagement_spike when ≥3 engagement_event signals arrive AND the score fingerprint does not change', async () => {
  // Regression test for: alert dispatch must NOT be gated by score.inserted
  // for engagement_spike. We arrange this so the second recompute has
  // inserted=false (score did not change) and still fires the spike — that
  // proves we are not relying on score-state as the trigger.

  // (1) Seed an initial score by posting one signal that matches no scoring
  // rule (engagement_event matches none of R1–R7). First recompute writes
  // a 0/cold score row.
  const seed = await (await postSig({
    source: 'engagement_event', captured_by: 'connector_outreach',
    account_domain: 'engagement-spike.com',
    contact_email: 'c0@engagement-spike.com',
    signal_type: 'engagement', fact: 'seed open',
    source_url: 'https://outreach.example/event/seed',
    snippet: 'id=seed type=email_open',
    captured_at: nowIso(),
  })).json();
  const accId = seed.accountId;
  const seedRecompute = await (await postRecompute(new Request('http://x/api/scoring/recompute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: accId }),
  }))).json();
  expect(seedRecompute.inserted).toBe(true);   // first score row created
  expect(seedRecompute.tier).toBe('cold');
  // First-ever cold score must NOT fire tier_promotion (regression on its own).
  expect((seedRecompute.alerts as Array<{ trigger: string }>)
    .filter((a) => a.trigger === 'tier_promotion')).toEqual([]);

  // (2) Post 2 more engagement_event signals (totaling 3 within the spike window).
  for (const i of [1, 2]) {
    await postSig({
      source: 'engagement_event', captured_by: 'connector_outreach',
      account_domain: 'engagement-spike.com',
      contact_email: `c${i}@engagement-spike.com`,
      signal_type: 'engagement', fact: `outreach event ${i}`,
      source_url: `https://outreach.example/event/${i}`,
      snippet: `id=${i} type=email_open subject=hello`,
      captured_at: nowIso(),
    });
  }

  // (3) Second recompute — score is still 0/cold (no rule matched), so
  // inserted=false. The spike must still fire because the dispatcher does
  // not gate on score.inserted.
  const r = await (await postRecompute(new Request('http://x/api/scoring/recompute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: accId }),
  }))).json();
  expect(r.inserted).toBe(false);  // score fingerprint unchanged
  expect(r.score).toBe(0);
  expect((r.alerts as Array<{ trigger: string }>)
    .filter((a) => a.trigger === 'engagement_spike').length).toBeGreaterThanOrEqual(1);
});

it('serializes concurrent recomputes without producing duplicate scores', async () => {
  // Set up an account with one verified signal, then fire two recomputes in
  // parallel. The unique index on (accountId, fingerprint) means at most one
  // new lead_scores row should exist.
  const accId = (await (await postSig({
    source: 'intent_data', account_domain: 'race-recompute.com',
    signal_type: 'intent', fact: 'race',
    source_url: 'https://x.example/race', snippet: 'race-snippet-recompute',
    captured_at: nowIso(),
  })).json()).accountId;
  const recompute = () => postRecompute(new Request('http://x/api/scoring/recompute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: accId }),
  }));
  const [a, b, c] = await Promise.all([recompute(), recompute(), recompute()]);
  const ja = await a.json(), jb = await b.json(), jc = await c.json();
  // All three should resolve to the same scoreId.
  expect(new Set([ja.scoreId, jb.scoreId, jc.scoreId]).size).toBe(1);
  // At most one tier-promotion alert across all three responses.
  const tps = [ja, jb, jc].flatMap((j) => (j.alerts as Array<{ trigger: string }>) ?? [])
    .filter((a) => a.trigger === 'tier_promotion');
  expect(tps.length).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2.2.3: Run, expect PASS.**

```bash
pnpm test tests/integration/inbound-pipeline.test.ts
```

- [ ] **Step 2.2.4: Commit.**

```bash
git add app/api/scoring/recompute tests/integration/inbound-pipeline.test.ts
git commit -m "feat(alerts): wire tier-promotion + engagement-spike dispatch into recompute (best-effort)"
```

---

### Task 2.3: Alerts UI + ack endpoint

**Files:**
- Create: `app/alerts/page.tsx`, `app/api/alerts/[id]/ack/route.ts`
- Test: `tests/integration/alerts-api.test.ts`

- [ ] **Step 2.3.1: Failing test for ack endpoint**

Create `tests/integration/alerts-api.test.ts` (in-memory db mock). Then:

```typescript
import { POST as ackPost } from '../../app/api/alerts/[id]/ack/route';
import { db, schema } from '@/db';
import { newId } from '../../lib/id';

describe('POST /api/alerts/:id/ack', () => {
  beforeEach(() => {
    db.delete(schema.alerts).run();
    db.delete(schema.accounts).run();
  });

  it('marks the alert as acknowledged', async () => {
    const accountId = newId('account');
    db.insert(schema.accounts).values({ id: accountId, name: 'Acme' }).run();
    const alertId = newId('alert');
    db.insert(schema.alerts).values({
      id: alertId, accountId, trigger: 'tier_promotion', severity: 'priority',
      payloadJson: {}, channelsSentJson: [],
    }).run();

    const req = new Request(`http://x/api/alerts/${alertId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'jin@example.com' }),
    });
    const res = await ackPost(req, { params: Promise.resolve({ id: alertId }) });
    expect(res.status).toBe(200);
    const stored = db.select().from(schema.alerts).all();
    expect(stored[0].acknowledgedAt).toBeTruthy();
    expect(stored[0].acknowledgedBy).toBe('jin@example.com');
  });

  it('404s when alert is missing', async () => {
    const req = new Request(`http://x/api/alerts/al_missing/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'x@y.z' }),
    });
    const res = await ackPost(req, { params: Promise.resolve({ id: 'al_missing' }) });
    expect(res.status).toBe(404);
  });

  it('401s without internal secret when INTERNAL_API_SECRET is set', async () => {
    process.env.INTERNAL_API_SECRET = 'shh-internal';
    const accountId = newId('account');
    db.insert(schema.accounts).values({ id: accountId, name: 'X' }).run();
    const alertId = newId('alert');
    db.insert(schema.alerts).values({
      id: alertId, accountId, trigger: 'manual', severity: 'info',
      payloadJson: {}, channelsSentJson: [],
    }).run();
    const req = new Request(`http://x/api/alerts/${alertId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },  // no x-internal-secret
      body: JSON.stringify({ by: 'jin@example.com' }),
    });
    const res = await ackPost(req, { params: Promise.resolve({ id: alertId }) });
    expect(res.status).toBe(401);
    delete process.env.INTERNAL_API_SECRET;
  });
});
```

- [ ] **Step 2.3.2: Run, expect FAIL.**

- [ ] **Step 2.3.3: Extract ack logic + implement ack route**

Both the API route and the alerts-page server action need to acknowledge alerts. Extract the DB write into a shared helper so the page action and the HTTP route share the same code path. The HTTP route adds a shared-secret gate; the page server action assumes the page itself is gated by deploy-time auth (see Deployment security section).

Create `lib/alerts/ack.ts`:

```typescript
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';

export type AckResult = { ok: true } | { ok: false; reason: 'not_found' };

export function acknowledgeAlert(id: string, by: string): AckResult {
  const existing = db.select().from(schema.alerts)
    .where(eq(schema.alerts.id, id)).get();
  if (!existing) return { ok: false, reason: 'not_found' };
  db.update(schema.alerts).set({
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: by,
  }).where(eq(schema.alerts.id, id)).run();
  return { ok: true };
}
```

Create `app/api/alerts/[id]/ack/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { acknowledgeAlert } from '@/lib/alerts/ack';

const Body = z.object({ by: z.string().min(1) });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const expected = process.env.INTERNAL_API_SECRET;
  if (expected) {
    const got = req.headers.get('x-internal-secret');
    if (got !== expected) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const { id } = await params;
  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const result = acknowledgeAlert(id, parsed.data.by);
  if (!result.ok && result.reason === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2.3.4: Add `GET /api/alerts` (read API, gated by INTERNAL_API_SECRET)**

Create `app/api/alerts/route.ts`. Reads expose alert payloads (which can include account names, score rationale, engagement counts), so the same `INTERNAL_API_SECRET` gate that protects writes also protects this read.

```typescript
import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { desc, eq, and, isNull } from 'drizzle-orm';

export async function GET(req: Request) {
  const expected = process.env.INTERNAL_API_SECRET;
  if (expected) {
    const got = req.headers.get('x-internal-secret');
    if (got !== expected) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const onlyOpen = url.searchParams.get('open') === '1';
  const accountId = url.searchParams.get('accountId');
  const conditions = [
    onlyOpen ? isNull(schema.alerts.acknowledgedAt) : undefined,
    accountId ? eq(schema.alerts.accountId, accountId) : undefined,
  ].filter(Boolean) as any[];
  const q = conditions.length > 0
    ? db.select().from(schema.alerts).where(and(...conditions)).orderBy(desc(schema.alerts.createdAt)).limit(100)
    : db.select().from(schema.alerts).orderBy(desc(schema.alerts.createdAt)).limit(100);
  return NextResponse.json({ alerts: q.all() });
}
```

- [ ] **Step 2.3.5: Implement alerts page with Acknowledge action**

Create `app/alerts/page.tsx`. The Acknowledge button is a server action that
calls the shared `acknowledgeAlert()` helper directly. The existing
`POST /api/alerts/:id/ack` route stays available for external integrations
and is covered by the same helper.

```typescript
import { db, schema } from '@/db';
import { desc } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';

const SEVERITY_STYLE: Record<string, string> = {
  info: 'bg-slate-100',
  priority: 'bg-amber-100',
  urgent: 'bg-red-100',
};

async function acknowledgeAction(formData: FormData) {
  'use server';
  // The /alerts page is the trust boundary for this action — gate it with
  // deploy-time auth (reverse proxy, SSO, etc.) per the Deployment security
  // section. The server action does NOT enforce INTERNAL_API_SECRET because
  // the secret would have to be embedded in the rendered HTML.
  const id = String(formData.get('alertId') ?? '');
  const by = String(formData.get('by') ?? 'unknown@example.com');
  if (!id) return;
  const { acknowledgeAlert } = await import('@/lib/alerts/ack');
  acknowledgeAlert(id, by);
  revalidatePath('/alerts');
}

export default async function AlertsPage() {
  const rows = db.select().from(schema.alerts)
    .orderBy(desc(schema.alerts.createdAt)).limit(100).all();
  const accountById = new Map(
    db.select().from(schema.accounts).all().map((a) => [a.id, a]),
  );
  // The acknowledger identity comes from an env var for v1; in a real
  // multi-user deploy this would be the authenticated user.
  const acknowledger = process.env.OPERATOR_EMAIL ?? 'operator@example.com';
  return (
    <main className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">Alerts</h1>
      <ul className="space-y-2">
        {rows.map((a) => {
          const acct = accountById.get(a.accountId);
          const text = (a.payloadJson as any)?.text ?? `${a.trigger} on ${acct?.name}`;
          return (
            <li key={a.id} className={`p-3 rounded ${SEVERITY_STYLE[a.severity]}`}>
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-xs text-slate-500">
                    {new Date(a.createdAt).toLocaleString()} · {a.severity} · {a.trigger}
                  </div>
                  <div className="mt-1">{text}</div>
                  {a.acknowledgedAt && (
                    <div className="text-xs text-slate-500 mt-1">
                      Acknowledged by {a.acknowledgedBy} at {new Date(a.acknowledgedAt).toLocaleString()}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <a className="text-sm text-blue-700 hover:underline"
                     href={`/accounts/${a.accountId}`}>
                    View account →
                  </a>
                  {!a.acknowledgedAt && (
                    <form action={acknowledgeAction}>
                      <input type="hidden" name="alertId" value={a.id} />
                      <input type="hidden" name="by" value={acknowledger} />
                      <button type="submit" className="text-xs px-2 py-1 border rounded">
                        Acknowledge
                      </button>
                    </form>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {rows.length === 0 && <li className="text-slate-400">No alerts yet.</li>}
      </ul>
    </main>
  );
}
```

> Why a server action instead of POST `/api/alerts/:id/ack`? Both work; the server action is the standard Next 16 pattern for server-rendered pages and avoids round-tripping through the API for the same in-process write. The HTTP endpoint stays available for external integrations (Phase 6 demo, Slack interactivity, etc.).

- [ ] **Step 2.3.6: Run tests, expect PASS.**

```bash
pnpm test tests/integration/alerts-api.test.ts
```

- [ ] **Step 2.3.7: Commit.**

```bash
git add app/alerts app/api/alerts tests/integration/alerts-api.test.ts
git commit -m "feat(alerts): /alerts page with Acknowledge server action; GET /api/alerts; POST /api/alerts/:id/ack"
```

---

## Phase 3 — Connectors

### Open decisions — Phase 3 checkpoint (captured 2026-05-17, post Task 3.2 review)

These surfaced during the Task 3.2 self-review. None block 3.2 (codex-converged,
pushed). They are recorded here so the Phase 3 manual checkpoint (after 3.3+3.4)
FORCES a decision rather than letting a default ride silently into production.

- **[CHECKPOINT] Connector account identity.** `GitHubConnector` emits
  `account_domain = github.com/<actor.login>` (`lib/connectors/github.ts`).
  That string is not a real domain, so GitHub-sourced evidence lives in its
  own account namespace, disconnected from domain-matched CRM accounts. v1
  ships siloed; a GitHub-actor→company resolver is deferred to v1.5. **Decide
  at checkpoint:** accept siloed for the demo, or add a resolution seam.
  This propagates to every connector (3.3 stubs face the same question), so
  the principle must be set with the full 3.3+3.4 picture in view.

- **[CHECKPOINT] All-or-nothing across watch entries.** `fetchSince` aborts
  the whole call on any single entry's `ConnectorError` (subsequent entries
  not polled) — see the contract note in `lib/connectors/types.ts`. Simple
  and documented, but one stale repo silently starves the connector as the
  watch list grows. The fix (skip-and-continue + per-entry error channel)
  changes the `SignalConnector` contract and ripples into the orchestrator,
  so it must be driven by 3.4's retry/backoff design, not guessed now.
  **Decide at checkpoint:** keep all-or-nothing, or change the contract.

- **[TASK 3.3 — RESOLVED 2026-05-17] Shared connector logic / drift.**
  Original prediction: extract a shared `classificationToSignalType()`
  because `GitHubConnector` maps `classification==='competitor'` →
  `trigger_event`. **The prediction was mis-aimed.** The 3.3 stubs have
  no `classification` concept (no watch file) — they map source →
  signal_type directly, so a `classificationToSignalType` helper would
  have had zero callers. The *actual* drift risk was the near-identical
  load-JSON / since-filter / map plumbing across the three stubs.
  Resolved by extracting `lib/connectors/fixture-loader.ts`
  (`loadFixtureSince`), so per-connector code is just the mapper. Lesson
  recorded: predicted-seam ≠ actual-seam; the shared abstraction emerged
  from the three concrete implementations, not the forecast.

- **[TASK 3.4 — LARGELY RESOLVED 2026-05-18] Drain-until-empty polling
  cost.** The GitHub connector re-fetches stale pages per cold repo per
  poll (early-stop removed for cross-page-order correctness — jsdoc in
  `lib/connectors/github.ts`). Task 3.4 added the `connector_poll_state`
  watermark, so each poll's `since` advances to the prior poll-start
  instead of a fixed `now − 24h` — a cold repo now passes a recent
  `since` and drains far fewer stale pages. The residual (GitHub's
  Events API has no server-side `since`, so SOME stale pages are still
  fetched within the window) is pure efficiency, not correctness, and
  bounded by `PAGE_CAP`. ETag/conditional-request optimization remains a
  future refinement; no further action needed for v1.

- **[TASK 3.4 DEFERRED SEAM — now feasible] Unify the recompute core
  with `/api/scoring/recompute`.** `recomputeAffectedAccounts`
  (lib/connectors/poll.ts) deliberately mirrors the route's gating +
  config-before-mutation invariant rather than sharing one
  `recomputeAccount` core. An earlier code comment justified this with
  "the route has no route-level test" — codex 3.4 r3 caught that as
  FALSE (`tests/integration/inbound-pipeline.test.ts` covers it,
  including the malformed-routing no-side-effect case). So a unification
  IS feasible with a regression net; it was deferred purely as a
  Task-3.4 scope boundary (refactoring the route's ~150-line hardened
  HTTP handler is a separate change). Clean follow-up task: extract a
  shared `recomputeAccount(accountId, cfg)` consumed by BOTH the route
  and the connector path; the parity tests on both sides become the
  net. Not a checkpoint blocker — connector orchestration is correct
  and converged with the duplication pinned by tests.

### Task 3.1: Connector interface

**Files:**
- Create: `lib/connectors/types.ts`, `docs/connectors.md`

- [ ] **Step 3.1.1: Define interface + docs**

Create `lib/connectors/types.ts`:

```typescript
import type { SignalPayload } from '../signals/types';

export interface SignalConnector {
  /** Stable connector identifier; matches `data/{name}-watch.md` and route param. */
  readonly name: string;

  /**
   * Pull all new signals since `since`. Implementations should be idempotent
   * (the ingest layer dedupes via dedupeKey, but connectors should not amplify load).
   * Returns a list of payloads ready for ingestSignal().
   */
  fetchSince(since: Date): Promise<SignalPayload[]>;
}

export class ConnectorError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConnectorError';
  }
}
```

Create `docs/connectors.md` (~300 words explaining the interface, idempotency expectations, fixtures vs. real APIs, secrets via env, polling cadence, rate-limit respect).

- [ ] **Step 3.1.2: Commit.**

```bash
git add lib/connectors/types.ts docs/connectors.md
git commit -m "feat(connectors): SignalConnector interface + contract docs"
```

---

### Task 3.2: GitHub connector (real Octokit)

**Files:**
- Create: `data/github-watch.md`, `lib/connectors/github.ts`
- Test: `tests/unit/github-connector.test.ts`

- [ ] **Step 3.2.1: Add dependency**

```bash
pnpm add @octokit/rest
```

- [ ] **Step 3.2.2: Author `data/github-watch.md`**

v1 supports `repo:` targets only. `org:` and `user:` targets are deferred to v1.5 (the GitHub API requires a different endpoint and pagination strategy). The parser emits a clear error on unsupported targets so operators see the limitation.

```markdown
# GitHub watch list

Each entry watches a single repository for events. Set `GITHUB_TOKEN` env var
(PAT with `public_repo` scope, or `repo` for private).

Supported `target` formats: `repo:<owner>/<name>` only. (`org:` and `user:`
deferred to v1.5.)

## modelcontextprotocol/servers

- target: repo:modelcontextprotocol/servers
- signals: [stars, issue_create]
- classification: prospect

## openai/openai-cookbook

- target: repo:openai/openai-cookbook
- signals: [pr_merge_external]
- classification: competitor
```

- [ ] **Step 3.2.3: Failing test**

Create `tests/unit/github-connector.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { GitHubConnector, parseWatchList } from '../../lib/connectors/github';

describe('parseWatchList', () => {
  it('parses repo entries', () => {
    const md = `
## one
- target: repo:foo/bar
- signals: [stars, issue_create]
- classification: prospect

## two
- target: repo:baz/qux
- signals: [pr_merge_external]
- classification: competitor
`;
    const list = parseWatchList(md);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      target: 'repo:foo/bar', signals: ['stars', 'issue_create'], classification: 'prospect',
    });
    expect(list[1]).toEqual({
      target: 'repo:baz/qux', signals: ['pr_merge_external'], classification: 'competitor',
    });
  });

  it('throws on unsupported target kind (e.g. org:)', () => {
    const md = `
## bad
- target: org:my-org
- signals: [stars]
- classification: prospect
`;
    expect(() => parseWatchList(md)).toThrow(/unsupported target/i);
  });

  it('throws on unknown signal name', () => {
    const md = `
## bad
- target: repo:foo/bar
- signals: [stars, telepathy]
- classification: prospect
`;
    expect(() => parseWatchList(md)).toThrow(/signal/i);
  });

  it('throws on unknown classification', () => {
    const md = `
## bad
- target: repo:foo/bar
- signals: [stars]
- classification: enemy_of_the_state
`;
    expect(() => parseWatchList(md)).toThrow(/classification/i);
  });
});

describe('GitHubConnector.fetchSince', () => {
  it('maps a star event to a SignalPayload', async () => {
    const fakeOctokit = {
      activity: {
        listRepoEvents: vi.fn().mockResolvedValue({ data: [
          {
            id: '1', type: 'WatchEvent',
            actor: { login: 'alice', html_url: 'https://github.com/alice', email: null },
            repo: { name: 'foo/bar' },
            created_at: '2026-05-06T11:00:00Z',
          },
        ] }),
      },
    } as any;
    const c = new GitHubConnector(fakeOctokit, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'competitor' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-06T10:00:00Z'));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].source).toBe('github_event');
    expect(payloads[0].snippet).toContain('starred');
    expect(payloads[0].account_domain).toBe('github.com/alice');
  });

  it('drops events older than `since`', async () => {
    const fakeOctokit = {
      activity: {
        listRepoEvents: vi.fn().mockResolvedValue({ data: [
          {
            id: '1', type: 'WatchEvent',
            actor: { login: 'alice', html_url: 'https://github.com/alice', email: null },
            repo: { name: 'foo/bar' },
            created_at: '2026-05-05T00:00:00Z',
          },
        ] }),
      },
    } as any;
    const c = new GitHubConnector(fakeOctokit, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'competitor' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-06T00:00:00Z'));
    expect(payloads).toHaveLength(0);
  });
});
```

- [ ] **Step 3.2.4: Run, expect FAIL.**

- [ ] **Step 3.2.5: Implement `lib/connectors/github.ts`**

```typescript
import { Octokit } from '@octokit/rest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { SignalConnector } from './types';
import { ConnectorError } from './types';
import type { SignalPayload } from '../signals/types';

const VALID_SIGNALS = ['stars', 'issue_create', 'pr_merge_external'] as const;
const VALID_CLASS = ['prospect', 'competitor', 'neutral'] as const;

const WatchEntrySchema = z.object({
  target: z.string().regex(/^repo:[^/]+\/[^/]+$/, 'unsupported target — only repo:<owner>/<name> in v1'),
  signals: z.array(z.enum(VALID_SIGNALS)).min(1),
  classification: z.enum(VALID_CLASS),
});
export type WatchEntry = z.infer<typeof WatchEntrySchema>;

export function parseWatchList(md: string): WatchEntry[] {
  const out: WatchEntry[] = [];
  const sections = md.split(/^## /m).slice(1);
  for (const section of sections) {
    const target = section.match(/- target:\s*(\S+)/)?.[1];
    const signalsRaw = section.match(/- signals:\s*\[([^\]]*)\]/)?.[1];
    const classification = section.match(/- classification:\s*(\S+)/)?.[1] ?? 'prospect';
    if (!target || !signalsRaw) continue;
    const signals = signalsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const parsed = WatchEntrySchema.safeParse({ target, signals, classification });
    if (!parsed.success) {
      // Include the field path so test assertions like /signals/i / /classification/i
      // / /target/i can pinpoint which field broke.
      const detail = parsed.error.issues
        .map((i) => `[${i.path.join('.')}] ${i.message}`)
        .join('; ');
      throw new Error(`bad github-watch.md entry: ${detail}`);
    }
    out.push(parsed.data);
  }
  return out;
}

export class GitHubConnector implements SignalConnector {
  readonly name = 'github';
  constructor(
    private readonly octokit: Octokit,
    private readonly watchList: WatchEntry[],
  ) {}

  static fromEnv(): GitHubConnector {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new ConnectorError('GITHUB_TOKEN env var not set');
    const octokit = new Octokit({ auth: token });
    const md = readFileSync(resolve(process.cwd(), 'data/github-watch.md'), 'utf8');
    return new GitHubConnector(octokit, parseWatchList(md));
  }

  async fetchSince(since: Date): Promise<SignalPayload[]> {
    const out: SignalPayload[] = [];
    for (const entry of this.watchList) {
      const events = await this.fetchEntryEvents(entry, since);
      out.push(...events);
    }
    return out;
  }

  private async fetchEntryEvents(entry: WatchEntry, since: Date): Promise<SignalPayload[]> {
    // Watch list parser already enforces target format; this destructure is safe.
    const ref = entry.target.slice('repo:'.length);
    const [owner, repo] = ref.split('/');
    let raw: any[];
    try {
      const r = await this.octokit.activity.listRepoEvents({
        owner, repo, per_page: 100,
      });
      raw = r.data;
    } catch (err) {
      throw new ConnectorError(
        `GitHub listRepoEvents failed for ${owner}/${repo}: ${(err as Error).message}`,
        err,
      );
    }

    const out: SignalPayload[] = [];
    for (const ev of raw) {
      const ts = new Date(ev.created_at);
      if (ts < since) continue;
      const mapped = this.mapEvent(ev, entry);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  private mapEvent(ev: any, entry: WatchEntry): SignalPayload | null {
    const base = {
      source: 'github_event' as const,
      captured_by: 'connector_github' as const,
    };
    if (ev.type === 'WatchEvent' && entry.signals.includes('stars')) {
      const actor = ev.actor.login;
      return {
        ...base,
        account_domain: `github.com/${actor}`,  // best-effort entity for v1
        signal_type: entry.classification === 'competitor' ? 'trigger_event' : 'engagement',
        fact: `${actor} starred ${ev.repo.name}`,
        source_url: `https://github.com/${ev.repo.name}/stargazers`,
        snippet: `${actor} starred ${ev.repo.name} at ${ev.created_at}`,
        captured_at: ev.created_at,
        metadata: { event_id: ev.id, classification: entry.classification },
      };
    }
    if (ev.type === 'IssuesEvent' && ev.payload?.action === 'opened'
        && entry.signals.includes('issue_create')) {
      return {
        ...base,
        account_domain: `github.com/${ev.actor.login}`,
        signal_type: 'engagement',
        fact: `${ev.actor.login} opened issue: ${ev.payload.issue.title}`,
        source_url: ev.payload.issue.html_url,
        snippet: (ev.payload.issue.title + '\n\n' + (ev.payload.issue.body ?? '')).slice(0, 1500),
        captured_at: ev.created_at,
        metadata: { event_id: ev.id, classification: entry.classification },
      };
    }
    if (ev.type === 'PullRequestEvent' && ev.payload?.action === 'closed'
        && ev.payload.pull_request?.merged
        && entry.signals.includes('pr_merge_external')) {
      return {
        ...base,
        account_domain: `github.com/${ev.actor.login}`,
        signal_type: 'trigger_event',
        fact: `${ev.actor.login} merged PR in ${ev.repo.name}`,
        source_url: ev.payload.pull_request.html_url,
        snippet: (ev.payload.pull_request.title + '\n\n' + (ev.payload.pull_request.body ?? ''))
          .slice(0, 1500),
        captured_at: ev.created_at,
        metadata: { event_id: ev.id, classification: entry.classification },
      };
    }
    return null;
  }
}
```

- [ ] **Step 3.2.6: Run, expect PASS.**

- [ ] **Step 3.2.7: Commit.**

```bash
git add data/github-watch.md lib/connectors/github.ts tests/unit/github-connector.test.ts package.json pnpm-lock.yaml
git commit -m "feat(connectors): GitHub real connector — stars/issues/PRs via Octokit"
```

---

### Task 3.3: Stub connectors (Salesforce, HubSpot, Outreach)

**Files:**
- Create: `fixtures/salesforce-contacts.json`, `fixtures/hubspot-accounts.json`, `fixtures/outreach-engagement.json`
- Create: `lib/connectors/salesforce.ts`, `lib/connectors/hubspot.ts`, `lib/connectors/outreach.ts`

- [ ] **Step 3.3.1: Author fixtures**

`fixtures/salesforce-contacts.json`:

```json
[
  { "Id": "003xx0000001", "Email": "alice@globex.com", "Name": "Alice Park",
    "Title": "VP Engineering", "Account.Domain": "globex.com",
    "LastModifiedDate": "2026-05-06T10:00:00.000Z" }
]
```

`fixtures/hubspot-accounts.json`:

```json
[
  { "id": "1001", "domain": "initech.io", "name": "Initech",
    "industry": "Software", "size": "mid-market",
    "lastModifiedAt": "2026-05-06T10:00:00.000Z" }
]
```

`fixtures/outreach-engagement.json`:

```json
[
  { "id": "eng_1", "type": "email_open", "contactEmail": "bob@umbrella.co",
    "accountDomain": "umbrella.co", "occurredAt": "2026-05-06T11:00:00.000Z",
    "subject": "Quick intro" }
]
```

- [ ] **Step 3.3.2: Implement Salesforce / HubSpot / Outreach stubs**

Each stub sets `captured_by` so ingest preserves provenance through to the `evidence.captured_by` column. The `source` field maps to `evidence.source_type`: Salesforce + HubSpot use `crm_record`, Outreach uses `engagement_event`. These distinct enum values keep CRM upserts from accidentally matching the form-fill scoring rule (R3).

Create `lib/connectors/salesforce.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SignalConnector } from './types';
import type { SignalPayload } from '../signals/types';

export class SalesforceConnector implements SignalConnector {
  readonly name = 'salesforce';
  private readonly fixturePath: string;
  constructor(fixturePath = resolve(process.cwd(), 'fixtures/salesforce-contacts.json')) {
    this.fixturePath = fixturePath;
  }
  async fetchSince(since: Date): Promise<SignalPayload[]> {
    const contacts = JSON.parse(readFileSync(this.fixturePath, 'utf8')) as Array<any>;
    return contacts
      .filter((c) => new Date(c.LastModifiedDate) >= since)
      .map((c) => ({
        source: 'crm_record' as const,
        captured_by: 'connector_salesforce' as const,
        account_domain: c['Account.Domain'],
        contact_email: c.Email,
        signal_type: 'firmographic' as const,
        fact: `Salesforce contact: ${c.Name} (${c.Title}) at ${c['Account.Domain']}`,
        source_url: `https://salesforce.example/Contact/${c.Id}`,
        snippet: `Id=${c.Id} Email=${c.Email} Name=${c.Name} Title=${c.Title}`,
        captured_at: c.LastModifiedDate,
        metadata: { sf_contact_id: c.Id },
      }));
  }
}
```

Create `lib/connectors/hubspot.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SignalConnector } from './types';
import type { SignalPayload } from '../signals/types';

export class HubSpotConnector implements SignalConnector {
  readonly name = 'hubspot';
  private readonly fixturePath: string;
  constructor(fixturePath = resolve(process.cwd(), 'fixtures/hubspot-accounts.json')) {
    this.fixturePath = fixturePath;
  }
  async fetchSince(since: Date): Promise<SignalPayload[]> {
    const accounts = JSON.parse(readFileSync(this.fixturePath, 'utf8')) as Array<any>;
    return accounts
      .filter((a) => new Date(a.lastModifiedAt) >= since)
      .map((a) => ({
        source: 'crm_record' as const,
        captured_by: 'connector_hubspot' as const,
        account_domain: a.domain,
        signal_type: 'firmographic' as const,
        fact: `HubSpot company: ${a.name} (${a.industry}, ${a.size})`,
        source_url: `https://hubspot.example/company/${a.id}`,
        snippet: `id=${a.id} name=${a.name} industry=${a.industry} size=${a.size}`,
        captured_at: a.lastModifiedAt,
        metadata: { hs_company_id: a.id },
      }));
  }
}
```

Create `lib/connectors/outreach.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SignalConnector } from './types';
import type { SignalPayload } from '../signals/types';

export class OutreachConnector implements SignalConnector {
  readonly name = 'outreach';
  private readonly fixturePath: string;
  constructor(fixturePath = resolve(process.cwd(), 'fixtures/outreach-engagement.json')) {
    this.fixturePath = fixturePath;
  }
  async fetchSince(since: Date): Promise<SignalPayload[]> {
    const events = JSON.parse(readFileSync(this.fixturePath, 'utf8')) as Array<any>;
    return events
      .filter((e) => new Date(e.occurredAt) >= since)
      .map((e) => ({
        source: 'engagement_event' as const,
        captured_by: 'connector_outreach' as const,
        account_domain: e.accountDomain,
        contact_email: e.contactEmail,
        signal_type: 'engagement' as const,
        fact: `Outreach engagement: ${e.type} on "${e.subject}"`,
        source_url: `https://outreach.example/event/${e.id}`,
        snippet: `id=${e.id} type=${e.type} subject=${e.subject} contact=${e.contactEmail}`,
        captured_at: e.occurredAt,
        metadata: { outreach_event_id: e.id, type: e.type },
      }));
  }
}
```

- [ ] **Step 3.3.3: Smoke test (no formal test for fixture passthroughs)**

```bash
pnpm tsx -e "import('./lib/connectors/salesforce').then(async (m) => { const c = new m.SalesforceConnector(); console.log(await c.fetchSince(new Date('2000-01-01'))); })"
```

Expected: prints 1 SignalPayload.

- [ ] **Step 3.3.4: Commit.**

```bash
git add fixtures lib/connectors/salesforce.ts lib/connectors/hubspot.ts lib/connectors/outreach.ts
git commit -m "feat(connectors): Salesforce/HubSpot/Outreach fixture-backed stubs"
```

---

### Task 3.4: Connector polling endpoint + scheduler script

**Files:**
- Create: `app/api/connectors/[name]/poll/route.ts`, `scripts/poll-connectors.ts`

- [ ] **Step 3.4.1: Implement poll endpoint**

Create `app/api/connectors/[name]/poll/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { GitHubConnector } from '@/lib/connectors/github';
import { SalesforceConnector } from '@/lib/connectors/salesforce';
import { HubSpotConnector } from '@/lib/connectors/hubspot';
import { OutreachConnector } from '@/lib/connectors/outreach';
import { ingestSignal } from '@/lib/signals/ingest';
import type { SignalConnector } from '@/lib/connectors/types';

function makeConnector(name: string): SignalConnector {
  switch (name) {
    case 'github':     return GitHubConnector.fromEnv();
    case 'salesforce': return new SalesforceConnector();
    case 'hubspot':    return new HubSpotConnector();
    case 'outreach':   return new OutreachConnector();
    default: throw new Error(`unknown connector: ${name}`);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  // Connector polling triggers external API calls and writes evidence rows;
  // gate it behind the same internal-API secret as /api/scoring/recompute.
  const expected = process.env.INTERNAL_API_SECRET;
  if (expected) {
    const got = req.headers.get('x-internal-secret');
    if (got !== expected) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const { name } = await params;
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get('since');
  // Default lookback: 24h.
  const since = sinceParam
    ? new Date(sinceParam)
    : new Date(Date.now() - 24 * 3600 * 1000);
  if (Number.isNaN(since.getTime())) {
    return NextResponse.json({ error: 'invalid since' }, { status: 400 });
  }

  let connector: SignalConnector;
  try { connector = makeConnector(name); }
  catch (err) {
    return NextResponse.json(
      { error: 'unknown_or_misconfigured_connector', detail: (err as Error).message },
      { status: 400 },
    );
  }

  let payloads;
  try { payloads = await connector.fetchSince(since); }
  catch (err) {
    return NextResponse.json(
      { error: 'connector_fetch_failed', detail: (err as Error).message },
      { status: 502 },
    );
  }

  const results: Array<{ ok: boolean; evidenceId?: string; deduped?: boolean; accountId?: string; error?: string }> = [];
  for (const p of payloads) {
    try {
      // Connectors run as in-process configured code; pass trustedSender=true.
      const r = await ingestSignal(p, { trustedSender: true });
      results.push({ ok: true, evidenceId: r.evidenceId, deduped: r.deduped, accountId: r.accountId });
    } catch (err) {
      results.push({ ok: false, error: (err as Error).message });
    }
  }

  // Trigger recompute for each unique account that received non-deduped signals.
  // Without this, scores/routes/alerts stay stale until manual recompute.
  const affectedAccounts = Array.from(new Set(
    results.filter((r) => r.ok && !r.deduped && r.accountId).map((r) => r.accountId!),
  ));
  const recomputed: Array<{ accountId: string; ok: boolean; error?: string }> = [];
  if (affectedAccounts.length > 0) {
    const { computeScore } = await import('@/lib/scoring/score');
    const { route: routeAccount } = await import('@/lib/routing/route');
    const { dispatchTierPromotion, dispatchEngagementSpike } = await import('@/lib/alerts/dispatch');
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const scoringMd = readFileSync(resolve(process.cwd(), 'data/scoring-rules.md'), 'utf8');
    const routingMd = readFileSync(resolve(process.cwd(), 'data/routing-rules.md'), 'utf8');
    const defaultOwner = process.env.DEFAULT_OWNER_EMAIL ?? 'triage@example.com';
    for (const accountId of affectedAccounts) {
      try {
        const score = await computeScore(accountId, scoringMd);
        await routeAccount(accountId, score.scoreId, routingMd, defaultOwner);
        if (score.inserted) {
          await dispatchTierPromotion(accountId, score.priorTier, score.tier, score.scoreId);
        }
        // Always check for engagement spike — engagement-like signals may not
        // change the score fingerprint but still merit an alert.
        await dispatchEngagementSpike(accountId);
        recomputed.push({ accountId, ok: true });
      } catch (err) {
        recomputed.push({ accountId, ok: false, error: (err as Error).message });
      }
    }
  }

  return NextResponse.json({
    name, since: since.toISOString(),
    fetched: payloads.length,
    ingested: results.filter((r) => r.ok && !r.deduped).length,
    deduped: results.filter((r) => r.ok && r.deduped).length,
    failed: results.filter((r) => !r.ok).length,
    recomputed,
  });
}
```

- [ ] **Step 3.4.2: Create scheduler script**

Create `scripts/poll-connectors.ts`:

```typescript
#!/usr/bin/env tsx
// Polls all connectors once. Run from cron / Task Scheduler / launchd.
//   pnpm tsx scripts/poll-connectors.ts
// Optional env: POLL_LOOKBACK_HOURS (default 24).

import { GitHubConnector } from '../lib/connectors/github';
import { SalesforceConnector } from '../lib/connectors/salesforce';
import { HubSpotConnector } from '../lib/connectors/hubspot';
import { OutreachConnector } from '../lib/connectors/outreach';
import { ingestSignal } from '../lib/signals/ingest';

const lookbackHours = Number(process.env.POLL_LOOKBACK_HOURS ?? '24');
const since = new Date(Date.now() - lookbackHours * 3600 * 1000);

const connectors = [
  ...(process.env.GITHUB_TOKEN ? [GitHubConnector.fromEnv()] : []),
  new SalesforceConnector(),
  new HubSpotConnector(),
  new OutreachConnector(),
];

(async () => {
  const { computeScore } = await import('../lib/scoring/score');
  const { route: routeAccount } = await import('../lib/routing/route');
  const { dispatchTierPromotion, dispatchEngagementSpike } = await import('../lib/alerts/dispatch');
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');

  const scoringMd = readFileSync(resolve(process.cwd(), 'data/scoring-rules.md'), 'utf8');
  const routingMd = readFileSync(resolve(process.cwd(), 'data/routing-rules.md'), 'utf8');
  const defaultOwner = process.env.DEFAULT_OWNER_EMAIL ?? 'triage@example.com';

  const affected = new Set<string>();
  for (const c of connectors) {
    try {
      const payloads = await c.fetchSince(since);
      let ingested = 0, deduped = 0, failed = 0;
      for (const p of payloads) {
        try {
          const r = await ingestSignal(p, { trustedSender: true });
          if (r.deduped) deduped++;
          else { ingested++; affected.add(r.accountId); }
        } catch { failed++; }
      }
      console.log(`[${c.name}] fetched=${payloads.length} ingested=${ingested} deduped=${deduped} failed=${failed}`);
    } catch (err) {
      console.error(`[${c.name}] failed:`, (err as Error).message);
    }
  }

  let scored = 0, alerted = 0;
  for (const accountId of affected) {
    try {
      const s = await computeScore(accountId, scoringMd);
      await routeAccount(accountId, s.scoreId, routingMd, defaultOwner);
      scored++;
      if (s.inserted) {
        const tp = await dispatchTierPromotion(accountId, s.priorTier, s.tier, s.scoreId);
        if (tp) alerted++;
      }
      // Always attempt spike (cooldown handles duplicates).
      const sp = await dispatchEngagementSpike(accountId);
      if (sp) alerted++;
    } catch (err) {
      console.error(`[recompute ${accountId}] failed:`, (err as Error).message);
    }
  }
  console.log(`[recompute] accounts=${affected.size} scored=${scored} alerted=${alerted}`);
})();
```

Make it executable:

```bash
chmod +x scripts/poll-connectors.ts
```

- [ ] **Step 3.4.3: Smoke test**

The fixtures use `2026-05-06T...` timestamps. To avoid the script silently filtering them out as "older than 24h" if you run it on a later date, override the lookback:

```bash
POLL_LOOKBACK_HOURS=8760 pnpm tsx scripts/poll-connectors.ts
```

Expected: prints `[salesforce] fetched=1 ingested=1 deduped=0 failed=0`, `[hubspot]` and `[outreach]` similarly. `[github]` only if `GITHUB_TOKEN` is set. Then a `[recompute] accounts=… scored=… alerted=…` line.

- [ ] **Step 3.4.4: Commit.**

```bash
git add app/api/connectors scripts/poll-connectors.ts
git commit -m "feat(connectors): polling endpoint + scheduler script for all four connectors"
```

---

## Phase 4 — Engagement Loop

### Task 4.1: Engagement schema

**Files:**
- Modify: `db/schema.ts`
- Generated: `db/migrations/0004_engagement.sql`
- Test: extend `tests/unit/schema.test.ts`

- [ ] **Step 4.1.1: Add `engagement_events` table**

Append to `db/schema.ts`:

```typescript
export const engagementEvents = sqliteTable('engagement_events', {
  id: text('id').primaryKey(),
  touchId: text('touch_id').references(() => touches.id),
  contactId: text('contact_id').references(() => contacts.id),
  eventType: text('event_type', {
    enum: ['sent', 'delivered', 'opened', 'clicked', 'replied',
           'bounced', 'unsubscribed', 'meeting_booked'],
  }).notNull(),
  metadataJson: text('metadata_json', { mode: 'json' })
    .$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  occurredAt: text('occurred_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  // Idempotency for webhook deliveries.
  externalId: text('external_id').unique(),
});
```

- [ ] **Step 4.1.2: Generate + migrate.**

```bash
pnpm db:generate
pnpm db:migrate
```

- [ ] **Step 4.1.3: Add a quick schema test, run, expect PASS.**

```typescript
it('exports engagementEvents', () => {
  expect(schema.engagementEvents).toBeDefined();
});
```

- [ ] **Step 4.1.4: Commit.**

```bash
git add db/schema.ts db/migrations tests/unit/schema.test.ts
git commit -m "feat(db): engagement_events table with idempotent externalId"
```

---

### Task 4.2: Engagement webhook + idempotent ingest

**Files:**
- Create: `lib/engagement/ingest.ts`, `app/api/engagement/route.ts`
- Test: `tests/integration/engagement-api.test.ts`

- [ ] **Step 4.2.1: Failing test**

Create `tests/integration/engagement-api.test.ts`. (In-memory db mock, beforeEach cleanup including engagementEvents and touches.) Then:

```typescript
import { POST } from '../../app/api/engagement/route';
import { db, schema } from '@/db';
import { newId } from '../../lib/id';

describe('POST /api/engagement', () => {
  beforeEach(() => {
    db.delete(schema.engagementEvents).run();
    db.delete(schema.touchRevisions).run();
    db.delete(schema.touches).run();
    db.delete(schema.sequences).run();
    db.delete(schema.contacts).run();
    db.delete(schema.accounts).run();
  });

  function setupTouch(): { touchId: string; contactId: string } {
    const accountId = newId('account');
    db.insert(schema.accounts).values({ id: accountId, name: 'Acme', domain: 'acme.com' }).run();
    const contactId = newId('contact');
    db.insert(schema.contacts).values({ id: contactId, accountId, fullName: 'X', email: 'x@acme.com' }).run();
    const sequenceId = newId('sequence');
    db.insert(schema.sequences).values({ id: sequenceId, accountId }).run();
    const touchId = newId('touch');
    db.insert(schema.touches).values({ id: touchId, sequenceId, position: 1, channel: 'email' }).run();
    return { touchId, contactId };
  }

  it('creates an engagement event', async () => {
    const { touchId, contactId } = setupTouch();
    const req = new Request('http://x/api/engagement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touchId, contactId, event_type: 'opened',
        external_id: 'sg_123',
        occurred_at: '2026-05-06T12:00:00.000Z',
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const stored = db.select().from(schema.engagementEvents).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].eventType).toBe('opened');
  });

  it('is idempotent on duplicate external_id', async () => {
    const { touchId, contactId } = setupTouch();
    const body = {
      touchId, contactId, event_type: 'opened',
      external_id: 'sg_dup',
      occurred_at: '2026-05-06T12:00:00.000Z',
    };
    await POST(new Request('http://x/api/engagement', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    await POST(new Request('http://x/api/engagement', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    expect(db.select().from(schema.engagementEvents).all()).toHaveLength(1);
  });
});
```

- [ ] **Step 4.2.2: Run, expect FAIL.**

- [ ] **Step 4.2.3: Implement**

Create `lib/engagement/ingest.ts`:

```typescript
import { z } from 'zod';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '../id';

export const EngagementPayload = z.object({
  touchId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  event_type: z.enum([
    'sent', 'delivered', 'opened', 'clicked', 'replied',
    'bounced', 'unsubscribed', 'meeting_booked',
  ]),
  external_id: z.string().min(1).optional(),
  occurred_at: z.string().datetime({ offset: true }),  // accepts ±HH:MM offsets
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type EngagementPayload = z.infer<typeof EngagementPayload>;

function isUniqueViolation(err: unknown): boolean {
  // UNIQUE / PRIMARY KEY only — FK / NOT NULL / CHECK errors must propagate.
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export async function ingestEngagement(raw: unknown): Promise<{ id: string; deduped: boolean }> {
  const p = EngagementPayload.parse(raw);
  if (p.external_id) {
    const dup = db.select().from(schema.engagementEvents)
      .where(eq(schema.engagementEvents.externalId, p.external_id)).get();
    if (dup) return { id: dup.id, deduped: true };
  }
  const id = newId('engagementEvent');
  try {
    db.insert(schema.engagementEvents).values({
      id,
      touchId: p.touchId ?? null,
      contactId: p.contactId ?? null,
      eventType: p.event_type,
      metadataJson: p.metadata ?? {},
      occurredAt: p.occurred_at,
      externalId: p.external_id ?? null,
    }).run();
    return { id, deduped: false };
  } catch (err) {
    // Concurrent duplicate posts can both pass the SELECT; the second loses the
    // unique constraint on external_id and re-resolves to the winner.
    if (!isUniqueViolation(err) || !p.external_id) throw err;
    const winner = db.select().from(schema.engagementEvents)
      .where(eq(schema.engagementEvents.externalId, p.external_id)).get();
    if (!winner) throw err;
    return { id: winner.id, deduped: true };
  }
}
```

Create `app/api/engagement/route.ts`. Same shared-secret auth as `/api/signals` — engagement webhooks come from third-party providers (Outreach, SendGrid, etc.) and need `X-Webhook-Secret` to be authenticated when `ENGAGEMENT_WEBHOOK_SECRET` is set.

```typescript
import { NextResponse } from 'next/server';
import { ingestEngagement } from '@/lib/engagement/ingest';

export async function POST(req: Request) {
  const expected = process.env.ENGAGEMENT_WEBHOOK_SECRET;
  if (expected) {
    const got = req.headers.get('x-webhook-secret');
    if (got !== expected) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  try {
    const r = await ingestEngagement(raw);
    return NextResponse.json(r);
  } catch (err) {
    if (err instanceof Error && err.name === 'ZodError') {
      return NextResponse.json({ error: 'invalid_payload', detail: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'internal', detail: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 4.2.4: Run tests, expect PASS.**

- [ ] **Step 4.2.5: Commit.**

```bash
git add lib/engagement app/api/engagement tests/integration/engagement-api.test.ts
git commit -m "feat(engagement): ingest webhook with idempotent external_id dedupe"
```

---

### Task 4.3: Outcome attribution per principle

**Files:**
- Create: `lib/engagement/attribute.ts`, `data/principle-outcomes.md` (initially empty / generated)
- Test: `tests/unit/attribute.test.ts`

- [ ] **Step 4.3.1: Failing test**

Create `tests/unit/attribute.test.ts`. Use in-memory db mock. Then:

```typescript
import { computePrincipleOutcomes, parsePrincipleIds } from '../../lib/engagement/attribute';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '../../lib/id';

// Tests use this fixed list of principle ids; in real code the list is parsed
// from data/principles.md.
const PRINCIPLES = ['P1', 'P2', 'P3', 'P4', 'P5'];

describe('computePrincipleOutcomes', () => {
  beforeEach(() => {
    db.delete(schema.engagementEvents).run();
    db.delete(schema.critiques).run();
    db.delete(schema.touchRevisions).run();
    db.delete(schema.touches).run();
    db.delete(schema.sequences).run();
    db.delete(schema.accounts).run();
  });

  function makeTouchWithPassFail(
    principlePassed: string[],
    principleFailed: string[],
    critiqueCreatedAt: string = '2020-01-01T00:00:00.000Z',  // explicit, ancient — won't time-bomb
  ): string {
    const accountId = newId('account');
    db.insert(schema.accounts).values({ id: accountId, name: 'X' }).run();
    const sequenceId = newId('sequence');
    db.insert(schema.sequences).values({ id: sequenceId, accountId }).run();
    const touchId = newId('touch');
    db.insert(schema.touches).values({
      id: touchId, sequenceId, position: 1, channel: 'email',
    }).run();
    const revId = newId('touchRevision');
    db.insert(schema.touchRevisions).values({
      id: revId, touchId, revisionNumber: 1,
      subject: null, body: 'x', createdBy: 'drafter',
    }).run();
    db.update(schema.touches).set({ currentRevisionId: revId })
      .where(eq(schema.touches.id, touchId)).run();
    const failFindings = principleFailed.map((pid) => ({
      issue: 'x', quote: '', suggested_rewrite: null, principle_id: pid,
    }));
    db.insert(schema.critiques).values({
      id: newId('critique'), touchRevisionId: revId,
      criticName: 'sales_coach',
      verdict: failFindings.length > 0 ? 'revise' : 'pass',
      findingsJson: failFindings,
      createdAt: critiqueCreatedAt,  // explicit so "later" assertions are deterministic forever
    }).run();
    return touchId;
  }

  it('counts replied vs not-replied per principle (latest critique per touch)', async () => {
    // Touch A passed P1, failed P5 → got reply.
    const touchA = makeTouchWithPassFail(['P1'], ['P5']);
    db.insert(schema.engagementEvents).values({
      id: newId('engagementEvent'), touchId: touchA, contactId: null,
      eventType: 'replied', occurredAt: '2026-05-06T12:00:00.000Z',
    }).run();
    // Touch B passed P1, P5 → no reply.
    makeTouchWithPassFail(['P1', 'P5'], []);
    // Touch C failed P5 → no reply.
    makeTouchWithPassFail([], ['P5']);

    const outcomes = await computePrincipleOutcomes(PRINCIPLES);
    const p5 = outcomes.find((o) => o.principle_id === 'P5');
    expect(p5).toBeDefined();
    expect(p5!.failed_replied + p5!.failed_silent).toBe(2);  // touches A & C failed P5
    expect(p5!.passed_replied + p5!.passed_silent).toBe(1);  // touch B passed P5
  });

  it('uses only the LATEST sales_coach critique per touch revision', async () => {
    // Touch with two critiques on the same revision. The first (failed P5)
    // is created at an ancient timestamp via the helper; the second (pass)
    // is created at a relatively-later but still fixed timestamp. Both
    // timestamps are explicit so this test never time-bombs.
    const FIRST = '2020-01-01T00:00:00.000Z';
    const LATER = '2020-06-01T00:00:00.000Z';
    const touchId = makeTouchWithPassFail([], ['P5'], FIRST);
    const rev = db.select().from(schema.touchRevisions)
      .where(eq(schema.touchRevisions.touchId, touchId)).get()!;
    db.insert(schema.critiques).values({
      id: newId('critique'), touchRevisionId: rev.id,
      criticName: 'sales_coach', verdict: 'pass', findingsJson: [],
      createdAt: LATER,
    }).run();
    db.insert(schema.engagementEvents).values({
      id: newId('engagementEvent'), touchId, contactId: null,
      eventType: 'replied', occurredAt: '2020-06-02T00:00:00.000Z',
    }).run();

    const outcomes = await computePrincipleOutcomes(PRINCIPLES);
    const p5 = outcomes.find((o) => o.principle_id === 'P5');
    // Latest critique passed everything, including P5.
    expect(p5!.passed_total).toBe(1);
    expect(p5!.failed_total).toBe(0);
  });

  it('uses parsed principle ids when called via the convenience wrapper', async () => {
    // The exported wrapper reads data/principles.md; smoke-test the parser path.
    const ids = parsePrincipleIds(`# Principles\n## P1 — A\n## P2 — B\n## P12 — Z\n`);
    expect(ids).toEqual(['P1', 'P2', 'P12']);
  });
});
```

- [ ] **Step 4.3.2: Run, expect FAIL.**

- [ ] **Step 4.3.3: Implement**

Three corrections from v1:
1. **Principle ID universe is parsed from `data/principles.md`**, not hardcoded — the principles file may grow or shrink.
2. **Only the latest sales_coach critique per touch_revision counts.** A revision can be re-critiqued (e.g. after the principles file changed); historical runs would inflate the counts.
3. **The "absence of failure → pass" inference is documented as a known limitation.** Persisting explicit per-principle verdicts is a v1.5 enhancement.

Create `lib/engagement/attribute.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';

export interface PrincipleOutcome {
  principle_id: string;
  passed_total: number;
  passed_replied: number;
  passed_silent: number;
  failed_total: number;
  failed_replied: number;
  failed_silent: number;
  /** Reply rate ratio when principle is FAILED vs PASSED. >1 means failing correlates with replies. */
  fail_lift: number | null;
}

/**
 * Parse principle IDs (P1, P2, …) from a principles.md file body.
 * Matches `## P<digits> — <heading>` exactly; this is the existing format
 * used in `data/principles.md` (see lines 8, 19, 31 of that file).
 */
export function parsePrincipleIds(md: string): string[] {
  const ids: string[] = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s+(P\d+)\b/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

function loadPrincipleIdsFromDisk(): string[] {
  const path = resolve(process.cwd(), 'data/principles.md');
  if (!existsSync(path)) return [];
  return parsePrincipleIds(readFileSync(path, 'utf8'));
}

/**
 * Compute per-principle reply outcomes.
 *
 * Scope:
 *   - One critique per TOUCH (not per revision): the LATEST sales_coach
 *     critique on the touch's CURRENT revision (`touches.currentRevisionId`).
 *     A touch may have many revisions and many historical critiques; we
 *     attribute outcomes to the version that was actually accepted/sent.
 *   - "Latest" is sorted by `(createdAt DESC, id DESC)` for deterministic
 *     tie-breaking when two critiques share a timestamp (ISO seconds collide
 *     on fast test runs).
 *
 * Inference: principles in the latest critique's `findings.principle_id`
 * are FAILED; all other principles in `principleIds` are PASSED. This
 * "absence of failure means pass" inference is the same one the Sales Coach
 * critic itself relies on (see `data/principles.md` Meta). v1.5 will persist
 * explicit per-principle verdicts.
 *
 * @param principleIds Optional override of the principle universe. Defaults
 *   to ids parsed from `data/principles.md`.
 */
export async function computePrincipleOutcomes(
  principleIds?: string[],
): Promise<PrincipleOutcome[]> {
  const ALL = principleIds && principleIds.length > 0
    ? principleIds
    : loadPrincipleIdsFromDisk();
  if (ALL.length === 0) return [];

  // Touch → did this touch ever receive a reply?
  const replied = new Set<string>(
    db.select().from(schema.engagementEvents)
      .where(eq(schema.engagementEvents.eventType, 'replied'))
      .all()
      .map((e) => e.touchId)
      .filter((x): x is string => !!x),
  );

  // For each touch with a currentRevisionId, find the latest sales_coach
  // critique on that revision. Only those critiques contribute.
  const touches = db.select().from(schema.touches).all()
    .filter((t) => t.currentRevisionId !== null);
  const allCoachCritiques = db.select().from(schema.critiques)
    .where(eq(schema.critiques.criticName, 'sales_coach')).all();

  // Group critiques by revision id.
  const byRevision = new Map<string, typeof allCoachCritiques>();
  for (const c of allCoachCritiques) {
    const arr = byRevision.get(c.touchRevisionId) ?? [];
    arr.push(c);
    byRevision.set(c.touchRevisionId, arr);
  }

  const counts: Record<string, PrincipleOutcome> = {};
  for (const pid of ALL) {
    counts[pid] = {
      principle_id: pid,
      passed_total: 0, passed_replied: 0, passed_silent: 0,
      failed_total: 0, failed_replied: 0, failed_silent: 0,
      fail_lift: null,
    };
  }

  for (const t of touches) {
    const candidates = byRevision.get(t.currentRevisionId!);
    if (!candidates || candidates.length === 0) continue;
    // Deterministic latest: parse-then-compare so SQLite "YYYY-MM-DD HH:MM:SS"
    // and code-written "YYYY-MM-DDTHH:MM:SS.sssZ" sort chronologically rather
    // than lexicographically. Tie-break on id (lexicographic is fine — ids
    // include a date+hex suffix and are monotonic within a day).
    const latest = [...candidates].sort((a, b) => {
      const dt = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return dt !== 0 ? dt : b.id.localeCompare(a.id);
    })[0];
    const didReply = replied.has(t.id);
    const failedPrinciples = new Set<string>(
      latest.findingsJson
        .map((f) => f.principle_id)
        .filter((x): x is string => !!x),
    );
    for (const pid of ALL) {
      const o = counts[pid];
      if (failedPrinciples.has(pid)) {
        o.failed_total++;
        if (didReply) o.failed_replied++; else o.failed_silent++;
      } else {
        o.passed_total++;
        if (didReply) o.passed_replied++; else o.passed_silent++;
      }
    }
  }

  for (const pid of ALL) {
    const o = counts[pid];
    const passRate = o.passed_total ? o.passed_replied / o.passed_total : 0;
    const failRate = o.failed_total ? o.failed_replied / o.failed_total : 0;
    o.fail_lift = passRate > 0 ? failRate / passRate : null;
  }

  return Object.values(counts);
}

export function renderOutcomesMarkdown(outcomes: PrincipleOutcome[]): string {
  const lines = ['# Principle outcomes', '',
    'Generated nightly. Reply rates per principle (passed vs failed in latest sales_coach critique per touch revision).',
    '',
    '| Principle | n(pass) | reply%(pass) | n(fail) | reply%(fail) | fail_lift |',
    '|---|---|---|---|---|---|'];
  for (const o of outcomes) {
    const pp = o.passed_total ? Math.round(100 * o.passed_replied / o.passed_total) : 0;
    const fp = o.failed_total ? Math.round(100 * o.failed_replied / o.failed_total) : 0;
    lines.push(`| ${o.principle_id} | ${o.passed_total} | ${pp}% | ${o.failed_total} | ${fp}% | ${o.fail_lift?.toFixed(2) ?? 'n/a'} |`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4.3.4: Run, expect PASS.**

- [ ] **Step 4.3.5: Commit.**

```bash
git add lib/engagement/attribute.ts tests/unit/attribute.test.ts
git commit -m "feat(engagement): per-principle pass/fail × replied/silent attribution"
```

---

### Task 4.4: Drafter feeds `principle-outcomes.md`

**Files:**
- Modify: `lib/drafter/draft.ts`
- Create: `lib/claude/prompts/draft-touch.ts` modifications (add `loadPrincipleOutcomes`)

- [ ] **Step 4.4.1: Add loader**

`lib/claude/prompts/draft-touch.ts` already uses default-import style (`import fs from 'node:fs'`, `import path from 'node:path'`). Match that style — do not introduce named-imports here. Append to the existing file:

```typescript
export function loadPrincipleOutcomes(): string {
  const p = path.resolve(process.cwd(), 'data/principle-outcomes.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(No outcome data yet.)';
}
```

- [ ] **Step 4.4.2: Modify drafter to include outcomes**

In `lib/drafter/draft.ts`, modify the imports (add `loadPrincipleOutcomes`) and the `runDrafter` function. Replace the `renderPrompt([...])` call with one that includes the outcomes block:

```typescript
const prompt = renderPrompt([
  { heading: 'Skill', body: loadDraftTouchSkill() },
  { heading: 'ICP brief', body: loadIcp() },
  { heading: 'Principles', body: loadPrinciples() },
  { heading: 'Outcomes', body: loadPrincipleOutcomes() },
  { heading: 'Account evidence pack', body: JSON.stringify(evidencePack, null, 2) },
  { heading: 'Position', body: `Touch ${touch!.position} of ${totalTouches}. Channel: ${touch!.channel}.` },
  { heading: 'Prior touches', body: JSON.stringify(priorRevisions.map((r) => ({ subject: r.subject, body: r.body })), null, 2) },
  ...(extraCorrection ? [{ heading: 'Correction', body: extraCorrection }] : []),
]);
```

- [ ] **Step 4.4.3: Run all drafter tests to ensure no regression.**

```bash
pnpm test tests/unit/drafter.test.ts
```

Expected: all pass. If a test was asserting on prompt structure, update its expected string to include the new heading.

- [ ] **Step 4.4.4: Commit.**

```bash
git add lib/claude/prompts/draft-touch.ts lib/drafter/draft.ts
git commit -m "feat(drafter): inject data/principle-outcomes.md into the drafter prompt"
```

---

### Task 4.5: Nightly digest script

**Files:**
- Create: `scripts/nightly-digest.ts`

- [ ] **Step 4.5.1: Implement**

Create `scripts/nightly-digest.ts`:

```typescript
#!/usr/bin/env tsx
// Nightly: recompute principle outcomes, write to data/principle-outcomes.md.
//   pnpm tsx scripts/nightly-digest.ts

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computePrincipleOutcomes, renderOutcomesMarkdown } from '../lib/engagement/attribute';

(async () => {
  const outcomes = await computePrincipleOutcomes();
  const md = renderOutcomesMarkdown(outcomes);
  const out = resolve(process.cwd(), 'data/principle-outcomes.md');
  writeFileSync(out, md);
  console.log(`Wrote ${outcomes.length} principle rows to ${out}`);
})();
```

- [ ] **Step 4.5.2: Smoke test**

```bash
pnpm tsx scripts/nightly-digest.ts
cat data/principle-outcomes.md
```

Expected: a markdown table with 12 P-rows.

- [ ] **Step 4.5.3: Commit.**

```bash
git add scripts/nightly-digest.ts
git commit -m "feat(engagement): nightly digest script writes principle-outcomes.md"
```

---

## Phase 6 — Closed-Loop Target Application Demo

The final demo is target-company agnostic. Use the same workflow for Anthropic, OpenAI, Harvey, Clay, Cursor, or any other AI sales role by changing the three environment variables below.

### Task 6.1: Research target company + audit evidence

**Files:** none new — uses existing pipeline. The commands below match the existing API contracts (see `app/api/accounts/route.ts`, `app/api/evidence/research/route.ts`, `app/api/evidence/audit/route.ts`, `app/api/sequences/route.ts`, `app/api/touches/draft/route.ts`, `app/api/touches/critique/route.ts`, `app/api/export/route.ts`).

- [ ] **Step 6.1.1: Create the account**

Set the target once:

```bash
export TARGET_COMPANY="Anthropic"
export TARGET_DOMAIN="anthropic.com"
export TARGET_ROLE_LABEL="AI sales automation"
```

Anthropic is the example because it was the first target for this plan. For another role, change only those three values.

```bash
curl -sS -X POST http://localhost:3000/api/accounts \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TARGET_COMPANY\",\"domain\":\"$TARGET_DOMAIN\"}"
```

Expected: 201 with `{ "id": "acc_..." }`. Save the id as `TARGET_ACCOUNT_ID` in your shell:

```bash
export TARGET_ACCOUNT_ID=acc_<paste-here>
```

- [ ] **Step 6.1.2: Run auto-research**

```bash
curl -sS -X POST "http://localhost:3000/api/evidence/research" \
  -H 'Content-Type: application/json' \
  -d "{\"accountId\":\"$TARGET_ACCOUNT_ID\"}"
```

Expected: 201 with `{ "evidenceIds": [...] }`. Wait ~30s for completion.

- [ ] **Step 6.1.3: Run extraction audit**

```bash
curl -sS -X POST "http://localhost:3000/api/evidence/audit" \
  -H 'Content-Type: application/json' \
  -d "{\"accountId\":\"$TARGET_ACCOUNT_ID\"}"
```

Expected: 200 with audit counts; rows transition to `verified` or `disputed`. Wait ~15s.

- [ ] **Step 6.1.4: Manually review evidence in the UI**

Open `http://localhost:3000/accounts/$TARGET_ACCOUNT_ID/evidence`. For each `disputed` row, decide: accept correction, override to verified, or remove. Promote any `pending_audit` rows whose audit missed nuance.

- [ ] **Step 6.1.5: Snapshot the evidence pack via direct DB read**

There is no `GET /api/evidence` endpoint in v1 (the UI reads via the page server component). For the application package, dump the verified evidence directly with `tsx`. Create a one-off script at `scripts/dump-evidence.ts`:

```typescript
#!/usr/bin/env tsx
import { db, schema } from '../db';
import { eq, and } from 'drizzle-orm';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const accountId = process.argv[2];
if (!accountId) { console.error('usage: dump-evidence.ts <accountId>'); process.exit(1); }

const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
const evidence = db.select().from(schema.evidence).where(and(
  eq(schema.evidence.accountId, accountId),
  eq(schema.evidence.extractionStatus, 'verified'),
)).all();

mkdirSync(resolve(process.cwd(), 'application'), { recursive: true });
writeFileSync(
  resolve(process.cwd(), 'application/evidence-pack.json'),
  JSON.stringify({ account, evidence }, null, 2),
);
console.log(`wrote ${evidence.length} verified evidence rows for ${account?.name}`);
```

Run it:

```bash
mkdir -p application
pnpm tsx scripts/dump-evidence.ts "$TARGET_ACCOUNT_ID"
```

Expected: `application/evidence-pack.json` exists with the account and verified evidence rows.

- [ ] **Step 6.1.6: Commit the helper script (it's a real script, not a one-off)**

```bash
git add scripts/dump-evidence.ts
git commit -m "feat(scripts): dump-evidence.ts — export verified evidence pack for an account"
```

---

### Task 6.2: Add hiring contact + sequence

- [ ] **Step 6.2.1: Add a contact (manually via UI)**

Open `/accounts/$TARGET_ACCOUNT_ID/contacts`. Add the hiring manager for the target role, or a public-facing sales/GTM/RevOps leader at the target company if the direct hiring manager is not public. Set archetype = `enabler` or `leader` based on the role's posture.

- [ ] **Step 6.2.2: Create a 3-touch sequence**

```bash
SEQUENCE_JSON=$(curl -sS -X POST http://localhost:3000/api/sequences \
  -H 'Content-Type: application/json' \
  -d "{\"accountId\":\"$TARGET_ACCOUNT_ID\",\"channels\":[\"email\",\"linkedin\",\"email\"]}")
echo "$SEQUENCE_JSON"
# Capture for next steps:
SEQUENCE_ID=$(echo "$SEQUENCE_JSON" | jq -r '.sequenceId')
TOUCH_IDS=($(echo "$SEQUENCE_JSON" | jq -r '.touchIds[]'))
```

Expected: 201; `sequenceId` and a 3-element `touchIds` array.

- [ ] **Step 6.2.3: Draft each touch**

```bash
for TID in "${TOUCH_IDS[@]}"; do
  curl -sS -X POST http://localhost:3000/api/touches/draft \
    -H 'Content-Type: application/json' \
    -d "{\"touchId\":\"$TID\"}"
  echo
done
```

Expected: each call returns `{ revisionId, issues }`. If `issues` is non-empty for any touch, the validator caught a span mismatch — fix the evidence pack (Step 6.1.4) or rewrite the draft via the UI before continuing. The validator is structural; you cannot ship a touch with issues.

- [ ] **Step 6.2.4: Capture each touch's current revision id**

```bash
# Server-side: read currentRevisionId per touch directly via tsx (no GET endpoint).
TR1=$(pnpm -s tsx -e "import { db, schema } from './db'; import { eq } from 'drizzle-orm';
const t = db.select().from(schema.touches).where(eq(schema.touches.id, '${TOUCH_IDS[0]}')).get();
process.stdout.write(t?.currentRevisionId ?? '');")
echo "TR1=$TR1"
```

Repeat for TR2, TR3 (or write a one-line tsx that prints all three). Save them.

- [ ] **Step 6.2.5: Run critic panel on each touch**

```bash
for TR in "$TR1" "$TR2" "$TR3"; do
  curl -sS -X POST http://localhost:3000/api/touches/critique \
    -H 'Content-Type: application/json' \
    -d "{\"touchRevisionId\":\"$TR\"}"
  echo
done
```

Expected: each call returns `{ critiques: [{ criticName, verdict, findings }, ...] }` with 3 critics each.

- [ ] **Step 6.2.6: Accept critic rewrites in the UI**

Open `/accounts/$TARGET_ACCOUNT_ID/sequences/$SEQUENCE_ID`. For each touch, click "Accept" on each critic's suggested rewrite that genuinely improves the draft. Each acceptance creates a new immutable `touch_revisions` row and updates `touches.currentRevisionId`. Iterate until: Skeptical Buyer = `pass`, Sales Coach = `pass` (zero failed principles), Writing Editor = `pass`.

> Note: after each accepted rewrite, the touch's `currentRevisionId` changes. Re-capture TR1/TR2/TR3 (Step 6.2.4) before re-running critics.

---

### Task 6.3: Application package generation

**Files:**
- Create: `application/cover-letter.md`, `application/architecture-essay.md`, `application/email-touch-1.eml`, `application/linkedin-touch-2.txt`, `application/critique-findings.json`, `application/loom.md`

- [ ] **Step 6.3.1: Export touches**

`POST /api/export` accepts `{sequenceId}` and returns `{ artifacts: [{ position, channel, filename, content }, ...] }`. Write each artifact to disk:

```bash
curl -sS -X POST http://localhost:3000/api/export \
  -H 'Content-Type: application/json' \
  -d "{\"sequenceId\":\"$SEQUENCE_ID\"}" \
  | jq -r '.artifacts[] | @base64' \
  | while read row; do
      decoded=$(echo "$row" | base64 --decode)
      filename=$(echo "$decoded" | jq -r '.filename')
      echo "$decoded" | jq -r '.content' > "application/$filename"
      echo "wrote application/$filename"
    done
```

Expected: `application/touch-1.eml`, `application/touch-2-linkedin.txt`, `application/touch-3.eml` exist (filenames per `lib/export/eml.ts` + the route's naming in [app/api/export/route.ts:25-36](/Users/jinchoi/Code/Sales/app/api/export/route.ts:25)).

- [ ] **Step 6.3.2: Export critique findings**

Re-run the critic panel for each touch's *current* revision and save the consolidated JSON. (`POST /api/touches/critique` recomputes; if you don't want to re-spend tokens, instead read existing `critiques` rows directly via `tsx`.)

```bash
for TR in "$TR1" "$TR2" "$TR3"; do
  pnpm -s tsx -e "import { db, schema } from './db'; import { eq } from 'drizzle-orm';
  const rows = db.select().from(schema.critiques).where(eq(schema.critiques.touchRevisionId, '$TR')).all();
  process.stdout.write(JSON.stringify({ touchRevisionId: '$TR', critiques: rows }, null, 2) + ',\n');"
done > application/critique-findings.json.partial
# Wrap in an array
{ echo '['; cat application/critique-findings.json.partial | sed '$ s/,$//'; echo ']'; } > application/critique-findings.json
rm application/critique-findings.json.partial
```

Expected: `application/critique-findings.json` is valid JSON with 3 entries (one per current touch revision).

- [ ] **Step 6.3.3: Write the cover letter**

Create `application/cover-letter.md` (~600 words). Required structure:

1. **Opening (1 sentence):** "I built an SDR automation reference architecture in three weeks, then used it to write this cover letter. Every claim below traces to a verified evidence row in the attached pack."
2. **Problem framing (1 paragraph):** quote two evidence IDs from the target-company evidence pack that motivate the role (e.g., GTM headcount post, public commentary on AI product adoption, sales automation roadmap, or partner ecosystem expansion).
3. **What I built (3 short paragraphs):** map the tool to five hard AI sales automation primitives — lead routing, scoring, alerts, GitHub integration, conversational intelligence. Cite file paths (`lib/scoring/score.ts`, `lib/connectors/github.ts`, `lib/engagement/attribute.ts`).
4. **Why this loop closes (1 paragraph):** point at the touch you generated and the critique that scored it. The artifact is the proof.
5. **What I'd do in the first 90 days (3 bullets):** based on the evidence pack, name three specific AI-sales automation bets you'd ship. Be falsifiable.

- [ ] **Step 6.3.4: Copy architecture essay**

```bash
cp docs/architecture.md application/architecture-essay.md
```

- [ ] **Step 6.3.5: Record Loom**

Record a 5-minute screen capture covering:
1. The tool open at `/inbound`. Post a fake intent signal for `$TARGET_DOMAIN`. Watch the score appear.
2. Recompute → see tier transition → see Slack mock at `outbox/slack-*.json`.
3. Open the touch you drafted; show the critic panel + accepted rewrite.
4. Show `application/email-touch-1.eml` rendered.

Save URL to `application/loom.md`:

```markdown
# Loom: SDR automation reference architecture — closed-loop demo

URL: <paste loom URL>

5-minute walkthrough showing the tool generating its own application materials for the target AI sales role.
```

- [ ] **Step 6.3.6: Final verification of application package**

```bash
ls application/
# Expected: architecture-essay.md, cover-letter.md, critique-findings.json,
#           evidence-pack.json, loom.md, touch-1.eml, touch-2-linkedin.txt,
#           touch-3.eml
wc -w application/cover-letter.md
# Expected: 500–800 words.
```

- [ ] **Step 6.3.7: Verify every claim in cover-letter cites evidence**

Read the cover letter. For each factual claim about the target company, confirm the evidence ID it points to exists in `application/evidence-pack.json`. Reject claims without backing.

- [ ] **Step 6.3.8: Decide whether to commit the package**

`application/` is gitignored (Task 0.1.3). The package contains private application artifacts and is intended to be uploaded directly to the careers portal, not pushed to the repo. Default: do not commit.

If you decide you do want a public artifact in the repo (e.g. as a writing sample), unignore selectively:

```bash
# Selectively unignore architecture-essay.md only. Task 0.1.3 already ignores
# `application/*` (contents) instead of `application/` (the directory), so a
# single negation line is enough — git can re-include a file inside an
# unexcluded directory whose contents are gitignored.
# Leave evidence-pack.json and the touch .eml/.txt files gitignored — they
# may name a hiring manager and contain personalized outreach.
printf '!application/architecture-essay.md\n' >> .gitignore
git add .gitignore application/architecture-essay.md
git commit -m "docs: publish architecture essay as part of application package"
```

Otherwise skip; the files live locally and are uploaded via the portal.

---

### Task 6.4: Final pre-submit checklist

- [ ] **Step 6.4.1: Full test suite passes.**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: all green, no errors.

- [ ] **Step 6.4.2: README + architecture essay reviewed by a peer.**

(External step — ask one person to read both cold and tell you if a stranger would understand the architecture decisions.)

- [ ] **Step 6.4.3: Cold email passes the read-aloud test.**

(External step — read the email aloud. If any sentence feels stilted, rewrite.)

- [ ] **Step 6.4.4: Submit application.**

Submit the target role at the company's careers portal. Attach:
- `cover-letter.md` (paste into the cover-letter field)
- `architecture-essay.md` (attached or linked)
- `email-touch-1.eml` (linked or attached as writing sample)
- `loom.md` (link in the cover letter)
- Resume

Reference the GitHub repo URL in the cover letter so reviewers can browse the code.

- [ ] **Step 6.4.5: Commit the final state and tag.**

```bash
git checkout main
git merge --no-ff feature/ai-sales-automation -m "feat: AI sales automation revamp v2"
git tag v2-ai-sales-automation
git push origin main --tags
```

---

## Self-review checklist

Before declaring this plan ready for codex review:

- [ ] **Spec coverage**: Every Role bullet in PLAN-ai-sales.md "AI sales role requirements → current state map" has a corresponding task in this plan.
- [ ] **Placeholders**: No "TBD", "fill in", "implement appropriate error handling" without code shown.
- [ ] **Type consistency**: `SignalPayload`, `Tier`, `RoutingContext`, `ScoringRule`, `RoutingRule`, `ScoreRationaleItem` all referenced consistently across tasks.
- [ ] **Migrations**: Tasks 1.1 and 4.1 explicitly call `pnpm db:generate && pnpm db:migrate`.
- [ ] **Idempotency**: Webhook ingest (1.3), engagement ingest (4.2), connector pull (3.4) all have explicit dedupe-by-key tests.
- [ ] **Time-zones**: All `captured_at` and `occurred_at` fields are required ISO8601 with timezone (`z.string().datetime()`).
- [ ] **Auth**: `/api/signals` supports optional `SIGNAL_WEBHOOK_SECRET`; `/api/connectors/:name/poll` is local-only by default (production deployment would gate this).
- [ ] **Failure modes**: Alert dispatch is best-effort; recompute doesn't fail on alert errors.

---

## Execution

Two options:

**1. Subagent-driven (recommended)** — dispatch a fresh subagent per task; review between tasks. Use superpowers:subagent-driven-development.

**2. Inline** — execute tasks in this session. Use superpowers:executing-plans.

Phase 0 is sequential (tasks 0.1–0.4 in order). Phase 1 is mostly sequential, but tasks 1.6–1.8 can be parallelized across two agents (scoring vs routing). Phase 3 connectors (3.2, 3.3) can be parallelized after 3.1. Phase 6 is strictly sequential.
