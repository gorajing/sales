# Sales Tool → Anthropic GTM Engineer Plan

**Goal:** Take the existing Sales tool from "personal local-first outreach" to a reference-grade SDR automation layer that demonstrates every primitive the Anthropic GTM Engineer JD asks for, then use the tool on itself to apply.

**Constraint:** ~3 weeks of focused evening/weekend work. Application-ready at the end of Phase 0; portfolio-ready at the end of Phase 3; thesis-defining at the end of Phase 6.

**Non-goal:** Becoming a real CRM. Real Salesforce sync, real Outreach.io send, real billing/multi-tenant SaaS — all out of scope. Mocks and stubs are fine when they demonstrate the architectural pattern.

**Implementation note:** The detailed task-by-task plan in `docs/superpowers/plans/2026-05-06-anthropic-gtm-revamp.md` supersedes this high-level plan where they differ. In particular, routing rules live in `data/routing-rules.md` and are parsed in-memory; there is no `routing_rules` database table.

---

## JD requirements → current state map

| JD bullet | Current state | Gap | Phase |
|---|---|---|---|
| Claude-powered productivity tooling | ✅ 8 skills, CLI runner with concurrency | None — emphasize in narrative | 0 |
| Personalized outreach generation | ✅ Drafter + validator + 3 critics | Add engagement-loop feedback | 4 |
| Lead routing & scoring | ❌ No scoring, no routing | New module | 1 |
| Intelligent alert systems | ❌ No notifications | New worker | 2 |
| High-intent signal detection | ❌ No signal ingestion | Extend evidence schema | 1 |
| Account research | ✅ `research-account` skill | None | 0 |
| Follow-up sequencing | ✅ Sequences + touches | Engagement-aware sequencing | 4 |
| Centralized data architecture aggregating from multiple sources | 🟡 Evidence is the spine; no external connectors | Add connector layer | 3 |
| Conversational intelligence pattern recognition | ✅ Sales Coach critic + principles file | Tie to engagement outcomes | 4 |
| API integration with CRM/SEP/marketing/lead sources | ❌ Export only | Connector stubs + 1 real | 3 |
| GitHub integration (specific JD callout) | ❌ None | New signal source | 3 |
| Cross-functional feedback loops | 🟡 principles.md is editable | Add team-edit posture | 5 |
| Built ground-up in ambiguous environments | ✅ 20+ commits, 2 weeks | None | 0 |

Legend: ✅ done · 🟡 partial · ❌ missing

---

## Phase 0 — Repackage (1 day, no code)

The fastest leverage is reframing what already exists. Your tool is presented as a "personal" tool; for this application, it's a **reference architecture for SDR-side AI automation, with a working v1**.

### Tasks

1. **README rewrite** (`README.md`)
   - Replace opener with: "An evidence-grounded reference architecture for AI-powered SDR automation. Working v1 below."
   - Add an "Architecture decisions and tradeoffs" section that names every non-obvious choice (CLI not API, append-only evidence, principles-as-rubric, validator as substring check) and explains *why*.
   - Add a "Mapped to GTM Engineering primitives" table that links your modules to the canonical SDR stack vocabulary (lead capture, scoring, routing, sequencing, engagement, attribution).

2. **Architecture essay** (`docs/architecture.md`, new)
   - 1500–2000 words. Six sections, one per architectural decision:
     1. Why Evidence is a spine, not a sidecar
     2. Why the validator is a structural invariant, not a prompt instruction
     3. Why principles live in a user-editable file, not in the code
     4. Why each LLM call is a scoped CLI subprocess with `--allowed-tools`
     5. Why drafts are immutable revisions, not mutable rows
     6. Why audit status is a first-class column, not metadata
   - This essay is the basis for the cover letter.

3. **Demo script** (`docs/demo.md`, new)
   - 5-minute walkthrough script: account → research → audit → contact → sequence → draft → critique → export.
   - Use a real public company (not Anthropic — save that for Phase 6) so the screenshots are credible.

### Verification
- `README.md` reads as if a senior infra engineer wrote it for hiring managers, not as a tutorial.
- `docs/architecture.md` is a standalone document a stranger could read cold.
- A peer can replicate the demo from the script.

### JD bullets satisfied
"Engineering experience working with complex technologies, varied datasets, and building data-driven productivity solutions with AI" — you already have this; Phase 0 makes it legible.

---

## Phase 1 — Inbound, Signals, and Routing (4–5 days)

This is the largest gap and the most visible in the JD. Build it as additive layers on the Evidence spine.

### 1A. Schema extensions (half day)

Add to `db/schema.ts`:

```ts
// Extend evidence.sourceType enum:
sourceType: text('source_type', {
  enum: [
    // existing
    'website', 'linkedin', 'news', '10k', 'job_post', 'podcast',
    'manual', 'perplexity', 'deep_research',
    // new: signal sources
    'intent_data', 'web_traffic', 'form_fill', 'github_event',
    'earnings_call', 'press_release', 'social_post',
  ],
}).notNull(),

// Extend evidence with a signal_type for typed signal evidence rows
signalType: text('signal_type', {
  enum: ['none', 'intent', 'engagement', 'firmographic',
         'technographic', 'trigger_event'],
}).notNull().default('none'),

// New: lead_scores table
export const leadScores = sqliteTable('lead_scores', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  contactId: text('contact_id').references(() => contacts.id),
  score: integer('score').notNull(),  // 0-100
  tier: text('tier', { enum: ['cold', 'warm', 'hot', 'on_fire'] }).notNull(),
  rationaleJson: text('rationale_json', { mode: 'json' })
    .$type<Array<{ evidence_id: string; weight: number; reason: string }>>()
    .notNull().default(sql`'[]'`),
  computedAt: text('computed_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text('expires_at'),  // scores decay
});

// New: routing_assignments
export const routingAssignments = sqliteTable('routing_assignments', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  ownerEmail: text('owner_email').notNull(),
  reason: text('reason').notNull(),  // 'territory' | 'account_owner' | 'round_robin' | 'specialist'
  matchedRuleKey: text('matched_rule_key'),  // stable key from data/routing-rules.md
  assignedAt: text('assigned_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Routing rules are intentionally NOT a DB table. They live in
// data/routing-rules.md and routing_assignments stores the matched rule key
// plus the routing-rules.md hash used for the decision.
```

Generate migration: `pnpm db:generate && pnpm db:migrate`.

### 1B. Inbound webhook (1 day)

`app/api/signals/route.ts` — new POST endpoint that accepts:

```ts
type SignalPayload = {
  source: 'intent_data' | 'web_traffic' | 'form_fill' | 'github_event' | ...;
  account_domain: string;            // resolves to or creates an Account
  contact_email?: string;             // resolves to or creates a Contact
  signal_type: 'intent' | 'engagement' | 'firmographic' | ...;
  fact: string;                       // human-readable summary
  source_url: string;
  snippet: string;                    // verbatim excerpt (≤1500 chars)
  metadata?: Record<string, unknown>;
};
```

The handler:
1. Resolves or creates Account by domain.
2. Resolves or creates Contact by email (if provided).
3. Inserts an Evidence row with `extractionStatus: 'verified'` (since the upstream sender vouches for the snippet) **only if** the `source` is in a trust-allowlist; otherwise `pending_audit`.
4. Triggers the scoring engine (next).

Decision: signals from trusted enterprise sources (Bombora, 6sense, Salesforce form fills) bypass audit. Signals from scrapers or third-party tools go to audit. This matches real GTM ops policy.

### 1C. Scoring engine (1 day)

`lib/scoring/score.ts` — new module that:

1. Takes an `accountId`.
2. Pulls all evidence rows for that account (verified + signals).
3. Runs each evidence row through a weighted rule set (configurable in `data/scoring-rules.md`, similar to `principles.md`):
   ```
   - High-intent search keywords (Bombora) → +20 over 7d
   - Pricing-page visit → +15 over 3d
   - Job post for relevant role → +10 over 30d
   - Recent funding round → +10 over 60d
   - GitHub: starred competitor repo → +5 over 14d
   - Decay: linear over expiry window
   ```
4. Emits a `lead_scores` row with `rationaleJson` showing every contributing evidence ID and weight.
5. Recomputes on every signal ingestion (debounced per-account).

Critical design choice: the rationale is auditable, not opaque. Every score points back to specific evidence rows. This mirrors the anti-hallucination invariant in drafting.

### 1D. Routing engine (1 day)

`lib/routing/route.ts` — new module that:

1. Takes an `accountId` with a fresh score.
2. Evaluates rules from `data/routing-rules.md` in priority order.
3. Predicate DSL supports: `score_tier`, `firmographic.size`, `firmographic.industry`, `geo.country`, `signal_type` presence, account ownership history.
4. First matching rule wins; emits a `routing_assignments` row.
5. If no rule matches, falls through to `default_owner` env var.

Seed three example rules in `data/routing-rules.md`:
- "Hot tier + enterprise size → senior AE pool (round-robin)"
- "Warm tier + existing account owner → re-route to that owner"
- "Anything else → SDR pool (round-robin)"

### 1E. UI surface (1 day)

`app/inbound/page.tsx` — new page showing:
- Live signal stream (most recent 50 signals)
- Top-scored accounts table (score, tier, last signal, owner)
- Click an account → drill to the existing account view, plus a new "Score rationale" panel showing weighted evidence

Reuse existing `app/accounts` components.

### 1F. Test harness (half day)

`tests/inbound.test.ts` — fixture-driven test that:
1. Posts 10 signals across 3 accounts.
2. Asserts scoring monotonicity (more signals → higher score).
3. Asserts routing determinism (same inputs → same owner).
4. Asserts decay (signals beyond expiry don't contribute).

### Verification
- `curl -X POST http://localhost:3000/api/signals -d @fixture.json` produces a row in `evidence`, recomputes a score, and writes a routing assignment.
- The Inbound page renders scores and routing assignments correctly.
- All tests pass.

### Artifact
A working **lead intake + scoring + routing** pipeline that produces auditable explanations for every score and every assignment.

### JD bullets satisfied
- "Build sophisticated automations for lead routing, account research, personalized outreach generation, and follow-up sequencing"
- "Design and implement a centralized data architecture that aggregates prospect intelligence from multiple sources"
- "Architect intelligent alert systems that notify sales teams of high-intent signals" (partial — Phase 2 closes)
- "Experience building scalable lead routing, scoring, and prioritization systems"

---

## Phase 2 — Alerts (1–2 days)

A score that nobody sees is wasted compute. Add a notification layer that fires on score-tier transitions.

### 2A. Schema (15 minutes)

```ts
export const alerts = sqliteTable('alerts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  trigger: text('trigger', {
    enum: ['tier_promotion', 'high_intent_signal', 'engagement_spike',
           'competitor_mention', 'manual'],
  }).notNull(),
  severity: text('severity', { enum: ['info', 'priority', 'urgent'] }).notNull(),
  payloadJson: text('payload_json', { mode: 'json' })
    .$type<{ /* trigger-specific */ }>().notNull(),
  channelsSent: text('channels_sent', { mode: 'json' })
    .$type<Array<{ channel: 'slack' | 'email' | 'webhook'; sent_at: string }>>()
    .notNull().default(sql`'[]'`),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

### 2B. Worker (half day)

`lib/alerts/dispatch.ts`:
- Subscribes to scoring engine output (in-process pub/sub for v1; mention queue migration in docs).
- Compares prior tier to new tier; emits `tier_promotion` alert on cold→warm, warm→hot, hot→on_fire.
- Detects `engagement_spike` (≥3 signals in 24h on the same account).
- Renders human-readable alert text via a Claude CLI call (Haiku, cheap).
- Fanout: writes to Slack (mock webhook URL — log to console + write to disk if `SLACK_WEBHOOK_URL` unset), email (write to `outbox/`), and a generic webhook (configurable).

### 2C. UI (half day)

`app/alerts/page.tsx`:
- Recent alerts feed.
- Each alert links to the account.
- "Acknowledge" button updates a per-user state.

### 2D. Configurable rules

`data/alert-rules.md` — user-editable:
```
- tier promotion (any) → Slack #sdr-pipeline, severity=priority
- on_fire tier        → Slack #sdr-pipeline + email account owner, severity=urgent
- competitor mention  → Slack #compete, severity=info
```

### Verification
- Posting a sequence of signals that promotes an account through tiers produces alert rows with the correct severity.
- Mock Slack webhook receives the payload (or it lands in `outbox/slack-*.json`).
- Alert page shows the feed.

### Artifact
End-to-end signal-to-alert pipeline. Demo: post a signal → score updates → tier transitions → Slack mock receives the message, all in <2s.

### JD bullets satisfied
- "Architect intelligent alert systems that notify sales teams of high-intent signals, inbound leads, website activity, and optimal engagements"

---

## Phase 3 — External integrations (2–3 days, can parallelize)

The JD lists specific integration categories. Build one shallow connector per category to demonstrate the architectural pattern, plus one *real* integration (GitHub) that's both differentiated and called out by name.

### 3A. Connector layer (half day)

`lib/connectors/` — new directory with a stable interface:

```ts
// lib/connectors/types.ts
export interface SignalConnector {
  name: string;
  fetchSince(t: Date): Promise<SignalPayload[]>;
  // Or push-style:
  webhookHandler?: (req: Request) => Promise<SignalPayload[]>;
}
```

This interface lets the inbound webhook and connector polling share the same downstream pipeline.

### 3B. GitHub connector — REAL (1 day)

`lib/connectors/github.ts`:
- Authenticates via `GITHUB_TOKEN` (PAT for v1; mention GitHub App migration in docs).
- Polls watched orgs/repos for: stars, issue creation, PR merges by external contributors, README mentions of competitor products.
- Maps each event to a `SignalPayload` with `source: 'github_event'`, snippet = the GitHub event body, source_url = the GitHub URL.
- Configurable watch list in `data/github-watch.md`:
  ```
  - org: anthropic-experimental
    signals: [stars, issue_create]
  - repo: openai/openai-cookbook
    signals: [pr_merge_by_external]
    classification: competitor
  ```

This single connector accomplishes three things at once: (1) demonstrates real API integration, (2) hits the JD's specific GitHub callout, (3) generates real signal data for the demo without needing fake fixtures.

### 3C. Salesforce/HubSpot stub (half day)

`lib/connectors/salesforce.ts` and `lib/connectors/hubspot.ts`:
- Implement the interface against fixture JSON files (`fixtures/salesforce-contacts.json`).
- Real API calls live behind a `MOCK=true` env flag (default true).
- Document in `docs/connectors.md`: "Real implementation requires OAuth + REST or Bulk API. Stub here demonstrates the data shape and pipeline; production swap is one file."

### 3D. Sales engagement platform stub (half day)

`lib/connectors/outreach.ts` — same pattern. Pulls "engagement events" (opens, replies, meetings booked) as signals; pushes generated touches as drafts back into a fixture mailbox.

### 3E. Marketing automation stub (half day, optional)

`lib/connectors/marketo.ts` or similar — pulls form fills and email engagement. Same pattern.

### Verification
- `pnpm tsx lib/connectors/github.ts --since 24h` against a real GitHub token produces real signal rows.
- All other connectors run against fixtures and produce signal rows.
- The full pipeline (connector → signal → score → alert) works end-to-end from a single CLI command.

### Artifact
A pluggable connector layer with one real integration (GitHub) and three stubbed (Salesforce, HubSpot, Outreach), demonstrating the architectural pattern for any source.

### JD bullets satisfied
- "Strong technical proficiency with APIs and experience integrating lead sources, **Github**, CRM systems, sales engagement platforms, and marketing automation tools"

---

## Phase 4 — Engagement loop (2 days)

The JD specifically calls out "leverage conversational intelligence and email engagement data to identify high-performing prospecting patterns and surface best practices." Close the loop.

### 4A. Engagement schema

```ts
export const engagementEvents = sqliteTable('engagement_events', {
  id: text('id').primaryKey(),
  touchId: text('touch_id').references(() => touches.id),
  contactId: text('contact_id').references(() => contacts.id),
  eventType: text('event_type', {
    enum: ['sent', 'delivered', 'opened', 'clicked', 'replied',
           'bounced', 'unsubscribed', 'meeting_booked'],
  }).notNull(),
  metadata: text('metadata', { mode: 'json' }).$type<{ /* */ }>(),
  occurredAt: text('occurred_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

### 4B. Outcome attribution

`lib/engagement/attribute.ts` — joins engagement events back to touches and to the principles each touch was scored against. Computes per-principle outcome rates:

> "Touches that pass P5 (pattern interrupt) reply at 4.2x the rate of touches that fail it (n=87)."

Output goes into a new `data/principle-outcomes.md` that the Sales Coach critic reads.

### 4C. Pattern surfacing

`lib/engagement/patterns.ts` — runs nightly:
- Clusters replied-to touches by language patterns (via Claude CLI call to extract themes).
- Surfaces top 5 patterns in a "What's working this week" digest.
- Writes to `outbox/digest-YYYY-MM-DD.md`.

### 4D. Sequence intelligence

Modify the drafter (`lib/drafter/draft.ts`) to:
- Include high-performing patterns from `principle-outcomes.md` in the system prompt.
- De-prioritize patterns that have negative engagement signal.

### Verification
- Posting a series of engagement events for a sequence produces measurable outcome rates per principle.
- The drafter changes its output when high-performing patterns are seeded into the prompt.

### Artifact
A real feedback loop: touch → engagement → outcome → updated guidance → next touch. This is the "continuously improve" bullet in the JD, made literal.

### JD bullets satisfied
- "Leverage conversational intelligence and email engagement data to identify high-performing prospecting patterns and surface best practices for personalization, messaging, and timing"
- "Establish feedback loops that continuously improve lead quality scoring, routing accuracy, and the effectiveness of prospecting tools"

---

## Phase 5 — Team posture (optional, 2 days)

If time permits. Doesn't add capability, but demonstrates production readiness.

### 5A. Auth + multi-user

- Add `users` and `user_accounts` tables (account ownership, role).
- Lucia or Auth.js for session auth (single-server, SQLite-backed).
- Routing rules now resolve to *user IDs*, not bare emails.

### 5B. RBAC

- SDR vs SDR Manager vs Admin.
- Admins edit `principles.md` and `routing-rules.md`; SDRs read.

### 5C. Audit trail UI

- Surface every `extractionStatus` change, every `routing_assignment`, every `principle_outcomes` recompute as an event log a manager can browse.

### Verification
- Two users with different roles see different surfaces.
- Every state change is auditable.

### Artifact
A team-ready posture without becoming a SaaS.

### JD bullets satisfied
- "Partner cross-functionally with Sales Operations, Sales Development Leadership, and Marketing to establish feedback loops"

---

## Phase 6 — Closed-loop application (1 day)

The killer move. Use the tool you built to apply for the role.

### Sequence

1. **Research Anthropic.** Run `research-account` against `anthropic.com`. Let the auto-research populate evidence.
2. **Audit.** Run `audit-extraction` over the pending rows. Manually accept/reject so the evidence pack is clean.
3. **Add the hiring manager as a contact** with `archetype: 'leader'` (or `'enabler'` if it's an SDR ops manager). Use LinkedIn + the job posting page as evidence.
4. **Generate signals against your own pipeline.** Post a `form_fill` signal representing the application submission. Watch the score, the tier, the routing assignment, and the alert fire — all on yourself.
5. **Generate a 3-touch sequence.** Touch 1: cold email. Touch 2: LinkedIn DM 4 days later. Touch 3: value-add (link to your own architecture essay). Run all 3 critics.
6. **Accept the rewrites.** Each critic revision is preserved as an immutable touch revision.
7. **Export.**
   - The cold email (Touch 1) → `application/email-touch-1.eml`
   - The LinkedIn DM (Touch 2) → `application/linkedin-touch-2.txt`
   - The full evidence pack → `application/evidence-pack.pdf` (render via `pnpm render:evidence`)
   - The critic findings → `application/critique-findings.json`
8. **Loom recording.** Record a 5-minute walkthrough of the above. Show the tool driving itself.

### Application materials package

- `application/cover-letter.md` — the architecture essay from Phase 0, condensed to ~600 words, opening with: "I built an SDR automation reference architecture in three weeks, then used it to write this cover letter. Every claim below traces to a verified evidence row in the attached pack."
- `application/evidence-pack.pdf`
- `application/email-touch-1.eml` — the actual cold email to whoever you're sending to
- `application/critique-findings.json` — receipts that the email passed your own 12 principles
- `application/loom.md` — the URL of the Loom recording
- `application/architecture-essay.md` — the full Phase 0 essay

### Verification
- Every claim in the cover letter has a corresponding evidence ID.
- The cold email passes all 12 principles in the critic panel.
- The Loom shows the tool generating the application materials live.

### Artifact
A self-referential proof: the tool that the role exists to build is the tool that's applying for the role. Closed loop.

### JD bullets satisfied
- "Experience in sales and/or sales development roles is highly valued" — you literally are the SDR for this application.

---

## Sequencing and dependencies

```
Phase 0 (1d) ─┬─→ Phase 1 (4-5d) ─┬─→ Phase 2 (1-2d) ─┐
              │                    │                   │
              │                    └─→ Phase 4 (2d) ───┤
              │                                        │
              └─→ Phase 3 (2-3d, parallel) ────────────┤
                                                       │
                                       Phase 5 (2d, opt)│
                                                       │
                                                       └─→ Phase 6 (1d)
```

**Critical path:** 0 → 1 → 2 → 6 = ~9 days.
**Recommended path (with engagement loop):** 0 → 1 → 2 → 4 → 6 = ~11 days.
**Full path:** all phases = ~16 days.

If timeline pressure forces a cut, drop Phase 5 first, then Phase 4. Phase 1 and Phase 6 are non-negotiable.

---

## What success looks like

By the end:

1. **A working v2 codebase** that ingests signals from 4 source types (one real, three stubbed), scores accounts with auditable rationale, routes to owners by configurable rules, alerts on tier transitions, learns from engagement outcomes, and drafts evidence-grounded outreach.

2. **A 1500-word architecture essay** that explains every non-obvious design decision and maps cleanly onto the JD.

3. **A 5-minute Loom** of the closed-loop demo.

4. **An application package** generated by the tool itself, with every claim cited.

5. **A revamped README** that frames the project as a reference architecture, not a personal tool.

The combination is unusual: most candidates submit a resume + projects. You submit a working tool that built its own application materials. That's the differentiator.

---

## Appendix: things I'm explicitly not doing

- Real Salesforce/HubSpot/Outreach API integrations (stubs only)
- A polished marketing landing page
- A SaaS billing layer
- A multi-tenant database architecture
- Mobile responsiveness beyond functional
- A test suite that covers >70% (target ~50% on critical paths)
- A CI/CD pipeline beyond `pnpm typecheck && pnpm test && pnpm build`
- Migration to Postgres
- Real email send (still .eml export)

Each of these is a real thing a production system would have. None of them improves the application story. The story is "I built the architectural primitives, mapped them onto your stated needs, and proved the loop closes." That's the bet.
