import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Shared enums exported as both runtime arrays (for parser whitelists,
 * select-option lists, etc.) and types (for narrowing at component
 * boundaries). Add new members in one place; both the type and the
 * column constraint stay in sync.
 */
export const SIGNAL_TYPES = [
  'none', 'intent', 'engagement', 'firmographic',
  'technographic', 'trigger_event',
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domain: text('domain'),
  industry: text('industry'),
  size: text('size'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({
  // Case-insensitive partial unique index: stores any case the user types,
  // but treats 'Acme.com' and 'acme.com' as the same value for uniqueness.
  // Excludes NULL and empty-string domains so unset values can coexist.
  domainUnique: uniqueIndex('accounts_domain_unique')
    .on(sql`lower(${t.domain})`)
    .where(sql`domain IS NOT NULL AND domain <> ''`),
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
  // Same case-insensitive partial pattern as accounts.domain.
  emailUnique: uniqueIndex('contacts_email_unique')
    .on(sql`lower(${t.email})`)
    .where(sql`email IS NOT NULL AND email <> ''`),
}));

export const evidence = sqliteTable('evidence', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  contactId: text('contact_id').references(() => contacts.id),
  sourceUrl: text('source_url').notNull(),
  sourceType: text('source_type', {
    enum: ['website', 'linkedin', 'news', '10k', 'job_post', 'podcast',
           'manual', 'perplexity', 'deep_research',
           // signal sources (new in v2)
           'intent_data', 'web_traffic', 'form_fill', 'github_event',
           'earnings_call', 'press_release', 'social_post',
           // connector sources — distinct from form_fill so scoring rule R3
           // (form-fill-as-demo-request) does NOT match CRM upserts.
           'crm_record', 'engagement_event'],
  }).notNull(),
  signalType: text('signal_type', { enum: SIGNAL_TYPES }).notNull().default('none'),
  snippet: text('snippet').notNull(),
  extractedFact: text('extracted_fact').notNull(),
  extractionStatus: text('extraction_status', {
    enum: ['pending_audit', 'verified', 'disputed'],
  }).notNull().default('pending_audit'),
  confidence: text('confidence', { enum: ['high', 'medium', 'low'] })
    .notNull().default('medium'),
  // NOTE: this default still produces SQLite's "YYYY-MM-DD HH:MM:SS" format,
  // not the ISO-8601-with-ms shape the new v2 tables use. Changing it requires
  // a SQLite table-rebuild migration on a v1 hot table; for v2 we instead
  // require all evidence insert paths to pass an explicit ISO string
  // (`new Date().toISOString()`). The default is the fallback for any caller
  // that still omits the field.
  capturedAt: text('captured_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  capturedBy: text('captured_by', {
    enum: ['claude_cli', 'manual', 'perplexity_mcp', 'chatgpt_mcp',
           'deep_research_paste',
           // connector sources (new in v2)
           'webhook', 'connector_github', 'connector_salesforce',
           'connector_hubspot', 'connector_outreach'],
  }).notNull(),
  supersededBy: text('superseded_by').references((): any => evidence.id),
  // De-dup key for idempotent webhook + connector ingestion. Format:
  // "<capturedBy>:<source>:<accountDomain>:<sourceUrl>:<sha256(snippet)>".
  // Unique when non-null; SQLite allows multiple NULLs by default.
  dedupeKey: text('dedupe_key').unique(),
}, (t) => ({
  // computeScore filters on (accountId, extractionStatus='verified') for
  // every recompute. With ~hundreds of evidence rows per account this is
  // already a hot query path; the recompute API + inbound UI will hit it
  // for every account on every refresh. Composite index keeps it cheap.
  accountStatusIdx: index('evidence_account_status_idx')
    .on(t.accountId, t.extractionStatus),
}));

export const sequences = sqliteTable('sequences', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  status: text('status', { enum: ['draft', 'active', 'paused', 'done'] })
    .notNull().default('draft'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const touches = sqliteTable('touches', {
  id: text('id').primaryKey(),
  sequenceId: text('sequence_id').notNull().references(() => sequences.id),
  position: integer('position').notNull(),
  channel: text('channel', { enum: ['email', 'linkedin'] }).notNull(),
  status: text('status', { enum: ['draft', 'ready', 'sent'] })
    .notNull().default('draft'),
  currentRevisionId: text('current_revision_id'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  sentAt: text('sent_at'),
});

export const touchRevisions = sqliteTable('touch_revisions', {
  id: text('id').primaryKey(),
  touchId: text('touch_id').notNull().references(() => touches.id),
  revisionNumber: integer('revision_number').notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  citedEvidenceIds: text('cited_evidence_ids', { mode: 'json' })
    .$type<string[]>().notNull().default(sql`'[]'`),
  supportingSpans: text('supporting_spans', { mode: 'json' })
    .$type<Array<{ evidence_id: string; span: string; claim: string }>>()
    .notNull().default(sql`'[]'`),
  rationale: text('rationale'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: text('created_by', {
    enum: ['drafter', 'critic_rewrite', 'manual_edit'],
  }).notNull(),
});

export const critiques = sqliteTable('critiques', {
  id: text('id').primaryKey(),
  touchRevisionId: text('touch_revision_id').notNull()
    .references(() => touchRevisions.id),
  criticName: text('critic_name', {
    enum: ['skeptical_buyer', 'sales_coach', 'writing_editor',
           'second_model_skeptic'],
  }).notNull(),
  verdict: text('verdict', { enum: ['pass', 'revise', 'reject'] }).notNull(),
  findingsJson: text('findings_json', { mode: 'json' })
    .$type<Array<{
      issue: string; quote: string; suggested_rewrite: string | null;
      principle_id: string | null;
    }>>().notNull().default(sql`'[]'`),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const extractionAudits = sqliteTable('extraction_audits', {
  id: text('id').primaryKey(),
  evidenceId: text('evidence_id').notNull().references(() => evidence.id),
  verdict: text('verdict', { enum: ['verified', 'disputed'] }).notNull(),
  reason: text('reason').notNull(),
  suggestedCorrection: text('suggested_correction'),
  resolvedBy: text('resolved_by', {
    enum: ['auto', 'user_accepted', 'user_overrode', 'user_removed'],
  }),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const callPrepBriefs = sqliteTable('call_prep_briefs', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull().references(() => contacts.id),
  openersJson: text('openers_json', { mode: 'json' })
    .$type<string[]>().notNull().default(sql`'[]'`),
  discoveryQuestionsJson: text('discovery_questions_json', { mode: 'json' })
    .$type<Array<{ question: string; evidence_id: string }>>()
    .notNull().default(sql`'[]'`),
  objectionsJson: text('objections_json', { mode: 'json' })
    .$type<Array<{ objection: string; response: string }>>()
    .notNull().default(sql`'[]'`),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const deliverables = sqliteTable('deliverables', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  introMd: text('intro_md'),
  outroMd: text('outro_md'),
  rawMd: text('raw_md'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const deliverableAccounts = sqliteTable('deliverable_accounts', {
  id: text('id').primaryKey(),
  deliverableId: text('deliverable_id').notNull().references(() => deliverables.id),
  accountId: text('account_id').notNull().references(() => accounts.id),
  rank: integer('rank').notNull(),
  whyNowMd: text('why_now_md'),
  dealShape: text('deal_shape'),
  routing: text('routing'),
  timeAsk: text('time_ask'),
  triggerSummary: text('trigger_summary'),
  sequenceId: text('sequence_id'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ─── v2 additions: scoring / routing / alerts ────────────────────────────────

export const leadScores = sqliteTable('lead_scores', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  contactId: text('contact_id').references(() => contacts.id),
  // Final integer score for the account at compute time. Clamped to
  // ≤100 at the upper end; lower bound is NOT clamped — penalty rules
  // (negative weights) can produce negative scores, which scoreToTier
  // maps to 'cold'. UI/routing/alerts must handle negative-friendly
  // display (don't render as a 0-100 progress bar).
  score: integer('score').notNull(),
  tier: text('tier', { enum: ['cold', 'warm', 'hot', 'on_fire'] }).notNull(),
  rationaleJson: text('rationale_json', { mode: 'json' })
    .$type<Array<{ evidence_id: string; weight: number; reason: string; rule_id: string }>>()
    .notNull().default(sql`'[]'`),
  // Stable hash of (score + tier + rationale identity + rules MD hash). A
  // threshold-only edit invalidates the fingerprint and forces a fresh row +
  // downstream alert evaluation.
  fingerprint: text('fingerprint').notNull(),
  // ISO 8601 with milliseconds so lexicographic compare matches chronological
  // order when mixed with code-written ISO timestamps elsewhere.
  computedAt: text('computed_at').notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  expiresAt: text('expires_at'),  // ISO 8601; null = no expiry
}, (t) => ({
  // Non-unique index for the latest-row lookup in computeScore. Earlier
  // versions had a UNIQUE (accountId, fingerprint) constraint as defense
  // against multi-writer SQLite races, but it broke state recurrence: an
  // account that goes cold → warm → cold would have the third row collide
  // with the first row's fingerprint and silently return the stale id.
  // Single-process SQLite serializes transactions, so the unique was
  // defending against a race we don't have. Reverted to a plain index.
  accountFingerprintIdx: index('lead_scores_account_fingerprint_idx')
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
  // Hash of the effective routing CONFIG used to produce this assignment:
  // parsed rules (id, priority, predicate AST, owner_email) AND the
  // normalized default owner email. The column name is historical
  // ("rules" only) — the hash now also folds in the fallback owner so
  // that changing DEFAULT_OWNER_EMAIL produces a new hash and recomputes
  // existing fallback assignments rather than being silently sticky.
  // Edits to any of those inputs → new hash → new assignment without
  // violating the unique index. See lib/routing/rules.ts:hashRoutingConfig.
  routingRulesHash: text('routing_rules_hash').notNull(),
  // NOT NULL: every routing decision in v2 is tied to a specific lead score.
  // SQLite treats NULLs as distinct in unique indexes, which would let
  // duplicate (account_id, NULL, hash) rows slip past the uniqueness check
  // — so the column itself disallows null. Manual override (no score) is a
  // v1.5 feature and will need a separate partial index on score_id IS NULL.
  scoreId: text('score_id').notNull().references(() => leadScores.id),
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
  // Cooldown / dedupe key — e.g. "engagement_spike:acc_xxx:2026-05-06" — so
  // the same trigger does not refire repeatedly within a window. Unique when
  // non-null; null is allowed for trigger types that don't have natural
  // cooldowns.
  cooldownKey: text('cooldown_key').unique(),
  acknowledgedAt: text('acknowledged_at'),
  acknowledgedBy: text('acknowledged_by'),
  createdAt: text('created_at').notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ─── v2 additions: connector poll watermark (Task 3.4) ───────────────────────

/**
 * One watermark row per connector. The poll orchestrator
 * (`lib/connectors/poll.ts`) reads `lastPolledAt` as the default
 * `since` for the next poll of that connector, and advances it to the
 * poll's START time after a SUCCESSFUL poll only. A connector that
 * failed keeps its old watermark so the next poll retries the same
 * window — at-least-once delivery, made safe by `evidence.dedupe_key`.
 *
 * Deliberately minimal (Task 3.4 directive: "even if simple"). A
 * config-hash column (invalidate the watermark when the connector's
 * watch list / fixture changes, mirroring `routingRulesHash` on
 * `routing_assignments`) is a documented future refinement, NOT built
 * here — adding it now would be scope the directive explicitly bounded.
 */
export const connectorPollState = sqliteTable('connector_poll_state', {
  // The connector's stable `name` ('github' | 'salesforce' | 'hubspot'
  // | 'outreach') — the same identifier `SignalConnector.name` exposes.
  // Natural PK: exactly one watermark per connector.
  connectorName: text('connector_name').primaryKey(),
  // ISO-8601 UTC. The START time of the last successful poll, used as
  // the next poll's default `since`. Poll-start (not end) so events
  // created mid-poll are caught next time; the inclusive [since, now]
  // boundary + dedupe_key absorb the resulting small overlap.
  lastPolledAt: text('last_polled_at').notNull(),
});

// ─── v2 additions: engagement loop (Phase 4) ─────────────────────────────────

/**
 * Engagement events are FACTS (sent / delivered / opened / clicked /
 * replied / …) emitted by outreach providers (Outreach, SendGrid),
 * NOT inferred outcomes and NOT scoring evidence. This table is
 * deliberately separate from `evidence`: an engagement event never
 * enters the lead score. It exists only to close the feedback loop —
 * attribution (Phase 4.3) reads it to compute per-principle reply
 * rates that become ADVISORY context for the drafter.
 *
 * Contract notes (enforced at the ingest boundary, not all at the SQL
 * level):
 *   - `externalId` UNIQUE is the webhook-redelivery idempotency key.
 *     Nullable because some providers don't supply a stable id;
 *     SQLite allows multiple NULLs under a UNIQUE index, so id-less
 *     events still insert (and can double-count on redelivery — a
 *     documented limitation, not a silent one).
 *   - `touchId` / `contactId` are FK-nullable at the SQL level, but
 *     `ingestEngagement` REJECTS an event that resolves to neither an
 *     existing touch nor an existing contact ("attach-or-fail"). An
 *     orphan event is unattributable noise.
 *   - `occurredAt` is the upstream event time, ISO-8601 UTC-Z,
 *     normalized at the ingest boundary (same canonical policy as
 *     `evidence.captured_at`). Intentionally NO `CURRENT_TIMESTAMP`
 *     default: it is REQUIRED from the payload, and a wall-clock
 *     default would (a) be the wrong format (`YYYY-MM-DD HH:MM:SS`,
 *     no `T`/`Z`/ms) and (b) silently mask a missing required
 *     timestamp. A missing value must fail loudly.
 */
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
  // Upstream event time, UTC-Z, normalized at ingest. NO default — see
  // the table doc above for why a CURRENT_TIMESTAMP default is wrong.
  occurredAt: text('occurred_at').notNull(),
  // Webhook idempotency key (provider's stable event id). Nullable;
  // UNIQUE permits multiple NULLs in SQLite.
  externalId: text('external_id').unique(),
  createdAt: text('created_at').notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});
