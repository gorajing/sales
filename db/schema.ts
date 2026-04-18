import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domain: text('domain'),
  industry: text('industry'),
  size: text('size'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

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
});

export const evidence = sqliteTable('evidence', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  contactId: text('contact_id').references(() => contacts.id),
  sourceUrl: text('source_url').notNull(),
  sourceType: text('source_type', {
    enum: ['website', 'linkedin', 'news', '10k', 'job_post', 'podcast',
           'manual', 'perplexity', 'deep_research'],
  }).notNull(),
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
           'deep_research_paste'],
  }).notNull(),
  supersededBy: text('superseded_by').references((): any => evidence.id),
});

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
      issue: string; quote: string; suggested_rewrite: string;
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
