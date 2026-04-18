# Sales Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal, local-first sales research-and-outreach tool where every factual claim in every draft traces to a verified evidence row, drafts are critiqued against a user-owned principles file, and every revision is preserved.

**Architecture:** Next.js 16 local web app + SQLite (Drizzle ORM) + `claude` CLI subprocess as the LLM runtime (powered by the owner's Max 20 subscription). Evidence → Drafting → Critique pipeline with a typed `supporting_spans` substring check as the structural anti-hallucination invariant, plus an Extraction Audit critic gating raw evidence into "verified" status before it can be draftable. Immutable `touch_revisions` preserve audit trail across rewrites.

**Tech Stack:** TypeScript, Next.js 16 App Router, React 19, Tailwind CSS, shadcn/ui, Drizzle ORM, better-sqlite3, Zod, Vitest, pnpm, `claude` CLI (local Max 20 auth).

**Scope:** v1 MVP only. Deferred to v1.5+: Deep Research paste parser, Perplexity MCP, call-prep briefs, GPT-5 second-model critic. See spec §10–§11.

---

## File structure (target)

```
Sales/
├── data/
│   ├── principles.md                  (exists)
│   ├── icp.md                         (NEW — user-authored ICP brief)
│   └── sales.db                       (gitignored, generated)
├── db/
│   ├── schema.ts                      Drizzle schema, all 9 tables
│   ├── index.ts                       DB connection singleton
│   └── migrate.ts                     One-shot migration runner
├── lib/
│   ├── id.ts                          Prefixed IDs (acc_, ct_, ev_, sq_, to_, tr_, cr_, ea_, cp_)
│   ├── claude/
│   │   ├── run.ts                     spawnClaude() wrapper with queue + JSON parsing
│   │   ├── prompts.ts                 Prompt template rendering
│   │   └── types.ts                   Zod schemas for every LLM output shape
│   ├── evidence/
│   │   ├── extract.ts                 Paste → atomic facts → evidence rows (pending_audit)
│   │   ├── audit.ts                   Extraction Audit critic runner
│   │   └── validate.ts                Drafter output validator (substring check)
│   ├── drafter/
│   │   └── draft.ts                   Run drafter for a touch; persist first revision
│   ├── critics/
│   │   ├── skeptical-buyer.ts
│   │   ├── sales-coach.ts
│   │   ├── writing-editor.ts
│   │   └── run-panel.ts               Orchestrate critics 1–3 concurrently
│   ├── research/
│   │   └── auto-research.ts           Claude CLI with WebFetch + WebSearch
│   └── export/
│       └── eml.ts                     .eml generation
├── skills/
│   ├── research-account/SKILL.md
│   ├── extract-evidence/SKILL.md
│   ├── draft-touch/SKILL.md
│   ├── critique-touch/SKILL.md
│   └── audit-extraction/SKILL.md
├── app/                               Next.js App Router
│   ├── layout.tsx, page.tsx, globals.css
│   ├── accounts/new/page.tsx
│   ├── accounts/[id]/page.tsx
│   ├── accounts/[id]/evidence/page.tsx
│   ├── accounts/[id]/contacts/[cid]/page.tsx
│   ├── accounts/[id]/sequences/[sid]/page.tsx
│   └── api/.../route.ts               CRUD + pipeline endpoints
├── components/
│   ├── ui/...                         shadcn primitives
│   ├── EvidencePill.tsx
│   ├── TouchBodyWithHighlights.tsx
│   ├── CriticPanel.tsx
│   └── AuditQueue.tsx
├── tests/
│   ├── unit/                          Pure-function tests (validator, id, eml, parsers)
│   └── integration/                   API + pipeline tests with fake Claude CLI
└── Config: package.json, tsconfig.json, next.config.ts, tailwind.config.ts,
          postcss.config.js, drizzle.config.ts, vitest.config.ts, .env.local.example
```

---

## Task 1: Scaffold Next.js project + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `vitest.config.ts`, `.env.local.example`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`

- [ ] **Step 1.1: Initialize pnpm + Next.js skeleton**

```bash
cd /Users/jinchoi/Code/Sales
pnpm init
pnpm add next@^16 react@^19 react-dom@^19
pnpm add -D typescript@^5 @types/node @types/react @types/react-dom
pnpm add -D vitest @vitest/ui @types/node
pnpm add -D tailwindcss@^4 postcss autoprefixer
pnpm add -D drizzle-kit drizzle-orm better-sqlite3 @types/better-sqlite3
pnpm add zod
```

- [ ] **Step 1.2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 1.3: Write `next.config.ts`**

```ts
import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
};
export default nextConfig;
```

- [ ] **Step 1.4: Write `tailwind.config.ts` + `postcss.config.js` + `app/globals.css`**

`tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
export default config;
```

`postcss.config.js`:
```js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`app/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 1.5: Write `app/layout.tsx` + `app/page.tsx`**

`app/layout.tsx`:
```tsx
import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Sales', description: 'Grounded sales tool' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </body>
    </html>
  );
}
```

`app/page.tsx`:
```tsx
export default function Home() {
  return (
    <main>
      <h1 className="text-2xl font-semibold">Sales</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Personal, evidence-grounded B2B outreach tool.
      </p>
    </main>
  );
}
```

- [ ] **Step 1.6: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
```

- [ ] **Step 1.7: Add scripts to `package.json`**

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx db/migrate.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

Install `tsx` for running TS scripts: `pnpm add -D tsx`

- [ ] **Step 1.8: Write `.env.local.example`**

```
# .env.local.example — copy to .env.local and fill in
# No secrets required for MVP; Claude CLI uses your local OAuth session.
# Add MCP server configs here if you later wire Perplexity or ChatGPT MCP.
```

- [ ] **Step 1.9: Verify scaffold builds and runs**

```bash
pnpm typecheck
pnpm build
pnpm dev
```

Expected: `typecheck` clean, `build` completes, `dev` serves http://localhost:3000 showing the "Sales" heading.

- [ ] **Step 1.10: Commit**

```bash
git add -A
git commit -m "Scaffold Next.js + Tailwind + Drizzle + Vitest"
```

---

## Task 2: Database schema

**Files:**
- Create: `db/schema.ts`, `db/index.ts`, `db/migrate.ts`, `drizzle.config.ts`
- Create: `tests/unit/schema.test.ts`

- [ ] **Step 2.1: Write `drizzle.config.ts`**

```ts
import type { Config } from 'drizzle-kit';
export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: './data/sales.db' },
} satisfies Config;
```

- [ ] **Step 2.2: Write `db/schema.ts`**

```ts
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
  supersededBy: text('superseded_by'),
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
```

- [ ] **Step 2.3: Write `db/index.ts`**

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'node:path';

const dbPath = path.resolve(process.cwd(), 'data/sales.db');
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export { schema };
```

- [ ] **Step 2.4: Write `db/migrate.ts`**

```ts
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './index';

migrate(db, { migrationsFolder: './db/migrations' });
console.log('Migrations applied.');
```

- [ ] **Step 2.5: Generate and apply the first migration**

```bash
mkdir -p data
pnpm db:generate
pnpm db:migrate
```

Expected: `db/migrations/0000_*.sql` created; `data/sales.db` exists with all 9 tables.

- [ ] **Step 2.6: Write `tests/unit/schema.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';

function freshDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './db/migrations' });
  return { db, sqlite };
}

describe('schema', () => {
  it('creates and queries an account', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
    const rows = db.select().from(schema.accounts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Acme');
  });

  it('defaults contact.archetype to unknown', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
    db.insert(schema.contacts).values({
      id: 'ct_1', accountId: 'acc_1', fullName: 'Jane',
    }).run();
    const row = db.select().from(schema.contacts).all()[0];
    expect(row.archetype).toBe('unknown');
  });

  it('enforces FK from evidence to account', () => {
    const { db } = freshDb();
    expect(() =>
      db.insert(schema.evidence).values({
        id: 'ev_1', accountId: 'acc_missing',
        sourceUrl: 'https://x', sourceType: 'manual',
        snippet: 's', extractedFact: 'f', capturedBy: 'manual',
      }).run()
    ).toThrow();
  });
});
```

- [ ] **Step 2.7: Run tests**

```bash
pnpm test
```

Expected: 3 tests pass.

- [ ] **Step 2.8: Commit**

```bash
git add -A
git commit -m "Add Drizzle schema (9 tables) + migration + schema tests"
```

---

## Task 3: ID utility + Zod schemas

**Files:**
- Create: `lib/id.ts`, `tests/unit/id.test.ts`
- Create: `lib/claude/types.ts`

- [ ] **Step 3.1: Write `lib/id.ts`**

```ts
import { randomBytes } from 'node:crypto';

const PREFIX = {
  account: 'acc', contact: 'ct', evidence: 'ev',
  sequence: 'sq', touch: 'to', touchRevision: 'tr',
  critique: 'cr', extractionAudit: 'ea', callPrepBrief: 'cp',
} as const;

export type IdKind = keyof typeof PREFIX;

export function newId(kind: IdKind): string {
  const suffix = randomBytes(5).toString('hex');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${PREFIX[kind]}_${date}_${suffix}`;
}
```

- [ ] **Step 3.2: Write `tests/unit/id.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { newId } from '../../lib/id';

describe('newId', () => {
  it('has the expected prefix', () => {
    expect(newId('account')).toMatch(/^acc_\d{8}_[0-9a-f]{10}$/);
    expect(newId('evidence')).toMatch(/^ev_\d{8}_[0-9a-f]{10}$/);
    expect(newId('touchRevision')).toMatch(/^tr_\d{8}_[0-9a-f]{10}$/);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('evidence')));
    expect(ids.size).toBe(1000);
  });
});
```

- [ ] **Step 3.3: Write `lib/claude/types.ts`**

```ts
import { z } from 'zod';

export const ExtractedEvidence = z.object({
  source_url: z.string().url(),
  source_type: z.enum(['website', 'linkedin', 'news', '10k', 'job_post',
    'podcast', 'manual', 'perplexity', 'deep_research']),
  snippet: z.string().min(1).max(1500),
  extracted_fact: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type ExtractedEvidence = z.infer<typeof ExtractedEvidence>;

export const ExtractionResult = z.object({
  evidence: z.array(ExtractedEvidence),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

export const SupportingSpan = z.object({
  evidence_id: z.string(),
  span: z.string().min(1),
  claim: z.string().min(1),
});
export type SupportingSpan = z.infer<typeof SupportingSpan>;

export const DraftTouch = z.object({
  subject: z.string().nullable(),
  body: z.string().min(1),
  channel: z.enum(['email', 'linkedin']),
  cited_evidence_ids: z.array(z.string()),
  supporting_spans: z.array(SupportingSpan),
  rationale: z.string(),
});
export type DraftTouch = z.infer<typeof DraftTouch>;

export const CriticFinding = z.object({
  issue: z.string(),
  quote: z.string(),
  suggested_rewrite: z.string(),
  principle_id: z.string().nullable().default(null),
});
export type CriticFinding = z.infer<typeof CriticFinding>;

export const CriticResult = z.object({
  verdict: z.enum(['pass', 'revise', 'reject']),
  findings: z.array(CriticFinding),
});
export type CriticResult = z.infer<typeof CriticResult>;

export const ExtractionAuditResult = z.object({
  evidence_id: z.string(),
  verdict: z.enum(['verified', 'disputed']),
  reason: z.string(),
  suggested_correction: z.string().nullable().default(null),
});
export type ExtractionAuditResult = z.infer<typeof ExtractionAuditResult>;
```

- [ ] **Step 3.4: Run tests**

```bash
pnpm test
```

Expected: all tests still pass (now includes id tests).

- [ ] **Step 3.5: Commit**

```bash
git add -A
git commit -m "Add ID utility + Zod schemas for LLM outputs"
```

---

## Task 4: Claude CLI bridge

**Files:**
- Create: `lib/claude/run.ts`, `lib/claude/prompts.ts`
- Create: `tests/unit/claude-run.test.ts`, `tests/integration/fake-claude.sh`

- [ ] **Step 4.1: Write `lib/claude/run.ts`**

```ts
import { spawn } from 'node:child_process';
import { z, ZodSchema } from 'zod';

type Model = 'sonnet' | 'haiku' | 'opus';

export interface SpawnClaudeOptions<T> {
  prompt: string;
  schema: ZodSchema<T>;
  model?: Model;
  cwd?: string;
  timeoutMs?: number;
}

export class ClaudeError extends Error {
  constructor(message: string, public stderr: string, public exitCode: number | null) {
    super(message);
  }
}

export class RateLimitError extends ClaudeError {}

// Simple global concurrency limit; Max 20 tolerates ~3 concurrent CLI processes.
const MAX_CONCURRENT = Number(process.env.CLAUDE_MAX_CONCURRENT ?? 3);
let inFlight = 0;
const queue: Array<() => void> = [];

async function acquire() {
  if (inFlight < MAX_CONCURRENT) { inFlight++; return; }
  await new Promise<void>((res) => queue.push(res));
  inFlight++;
}
function release() {
  inFlight--;
  const next = queue.shift();
  if (next) next();
}

export async function spawnClaude<T>({
  prompt, schema, model = 'sonnet', cwd = process.cwd(), timeoutMs = 120_000,
}: SpawnClaudeOptions<T>): Promise<T> {
  await acquire();
  try {
    const args = [
      '--print',
      '--output-format', 'json',
      '--model', model,
    ];
    const bin = process.env.CLAUDE_BIN ?? 'claude';

    return await new Promise<T>((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env: process.env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new ClaudeError('Claude CLI timed out', stderr, null));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new ClaudeError(`Claude CLI failed to spawn: ${err.message}`, stderr, null));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          if (/rate limit|quota/i.test(stderr)) {
            return reject(new RateLimitError('Rate limit hit', stderr, code));
          }
          return reject(new ClaudeError(`Claude CLI exit ${code}`, stderr, code));
        }
        try {
          // Claude CLI --output-format json wraps the response; the message content is a JSON string.
          const envelope = JSON.parse(stdout);
          const raw = typeof envelope.result === 'string' ? envelope.result : stdout;
          // Try to parse as JSON; if assistant returned JSON-as-text, extract it.
          let parsed: unknown;
          try { parsed = JSON.parse(raw); }
          catch {
            const match = raw.match(/```json\s*([\s\S]*?)```/);
            if (!match) throw new Error('no JSON in response');
            parsed = JSON.parse(match[1]);
          }
          resolve(schema.parse(parsed));
        } catch (err) {
          reject(new ClaudeError(
            `Response parse failed: ${(err as Error).message}`,
            `stdout=${stdout}\nstderr=${stderr}`, code,
          ));
        }
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  } finally {
    release();
  }
}
```

- [ ] **Step 4.2: Write `lib/claude/prompts.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

export function loadFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

export interface PromptSection { heading: string; body: string; }

export function renderPrompt(sections: PromptSection[]): string {
  return sections.map(s => `## ${s.heading}\n\n${s.body.trim()}`).join('\n\n');
}
```

- [ ] **Step 4.3: Write `tests/integration/fake-claude.sh`**

```bash
#!/usr/bin/env bash
# Fake `claude` CLI for tests. Reads stdin, ignores it, and emits a fixture
# whose path is specified via FAKE_CLAUDE_FIXTURE env var.
set -e
if [ -z "$FAKE_CLAUDE_FIXTURE" ]; then
  echo "FAKE_CLAUDE_FIXTURE not set" >&2
  exit 2
fi
cat >/dev/null
cat "$FAKE_CLAUDE_FIXTURE"
```

Make it executable:

```bash
chmod +x tests/integration/fake-claude.sh
```

- [ ] **Step 4.4: Write `tests/unit/claude-run.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spawnClaude, ClaudeError } from '../../lib/claude/run';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const fixture = (obj: unknown) => {
  const envelope = { result: JSON.stringify(obj) };
  const tmp = path.join(os.tmpdir(), `fake-claude-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(envelope));
  return tmp;
};

describe('spawnClaude', () => {
  it('parses a valid JSON result against the schema', async () => {
    const fx = fixture({ answer: 'yes', n: 42 });
    process.env.CLAUDE_BIN = path.resolve('tests/integration/fake-claude.sh');
    process.env.FAKE_CLAUDE_FIXTURE = fx;
    const schema = z.object({ answer: z.string(), n: z.number() });
    const result = await spawnClaude({ prompt: 'anything', schema });
    expect(result).toEqual({ answer: 'yes', n: 42 });
  });

  it('throws ClaudeError on schema mismatch', async () => {
    const fx = fixture({ wrong: true });
    process.env.CLAUDE_BIN = path.resolve('tests/integration/fake-claude.sh');
    process.env.FAKE_CLAUDE_FIXTURE = fx;
    const schema = z.object({ answer: z.string() });
    await expect(spawnClaude({ prompt: 'x', schema })).rejects.toBeInstanceOf(ClaudeError);
  });
});
```

- [ ] **Step 4.5: Run tests**

```bash
pnpm test
```

Expected: all prior tests + 2 new tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add -A
git commit -m "Add Claude CLI bridge with concurrency queue and fake CLI for tests"
```

---

## Task 5: Account CRUD (API + UI)

**Files:**
- Create: `app/api/accounts/route.ts`, `app/accounts/new/page.tsx`, `app/accounts/[id]/page.tsx`
- Modify: `app/page.tsx` (list accounts)
- Create: `tests/integration/accounts-api.test.ts`

- [ ] **Step 5.1: Write `app/api/accounts/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { newId } from '@/lib/id';
import { z } from 'zod';

const CreateAccount = z.object({
  name: z.string().min(1),
  domain: z.string().optional(),
  industry: z.string().optional(),
  size: z.string().optional(),
  notes: z.string().optional(),
});

export async function GET() {
  const rows = db.select().from(schema.accounts).all();
  return NextResponse.json({ accounts: rows });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = CreateAccount.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const id = newId('account');
  db.insert(schema.accounts).values({ id, ...parsed.data }).run();
  return NextResponse.json({ id });
}
```

- [ ] **Step 5.2: Modify `app/page.tsx` to list accounts**

```tsx
import Link from 'next/link';
import { db, schema } from '@/db';

export const dynamic = 'force-dynamic';

export default function Home() {
  const accounts = db.select().from(schema.accounts).all();
  return (
    <main>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <Link href="/accounts/new" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
          + New account
        </Link>
      </div>
      <ul className="mt-6 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
        {accounts.map((a) => (
          <li key={a.id} className="p-3">
            <Link href={`/accounts/${a.id}`} className="font-medium">{a.name}</Link>
            {a.domain && <span className="ml-2 text-sm text-neutral-500">{a.domain}</span>}
          </li>
        ))}
        {accounts.length === 0 && (
          <li className="p-3 text-sm text-neutral-500">No accounts yet.</li>
        )}
      </ul>
    </main>
  );
}
```

- [ ] **Step 5.3: Write `app/accounts/new/page.tsx`**

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function NewAccountPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, domain: domain || undefined }),
    });
    const { id } = await res.json();
    router.push(`/accounts/${id}`);
  }

  return (
    <main>
      <h1 className="text-xl font-semibold">New account</h1>
      <form onSubmit={submit} className="mt-4 space-y-3 max-w-md">
        <label className="block">
          <span className="text-sm text-neutral-700">Company name</span>
          <input className="mt-1 w-full rounded border border-neutral-300 p-2"
                 value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="block">
          <span className="text-sm text-neutral-700">Domain</span>
          <input className="mt-1 w-full rounded border border-neutral-300 p-2"
                 value={domain} onChange={(e) => setDomain(e.target.value)}
                 placeholder="acme.com" />
        </label>
        <button disabled={submitting}
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
          Create
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 5.4: Write `app/accounts/[id]/page.tsx`**

```tsx
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();
  return (
    <main>
      <Link href="/" className="text-sm text-neutral-500">← Accounts</Link>
      <h1 className="mt-2 text-2xl font-semibold">{account.name}</h1>
      {account.domain && <p className="text-sm text-neutral-500">{account.domain}</p>}
      <nav className="mt-4 flex gap-3 text-sm">
        <Link href={`/accounts/${id}/evidence`} className="underline">Evidence</Link>
        <Link href={`/accounts/${id}/contacts`} className="underline">Contacts</Link>
        <Link href={`/accounts/${id}/sequences`} className="underline">Sequences</Link>
      </nav>
    </main>
  );
}
```

- [ ] **Step 5.5: Write `tests/integration/accounts-api.test.ts`**

Integration tests use the API directly via Next's test harness is overkill; instead call the route handlers as functions.

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST, GET } from '../../app/api/accounts/route';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';

vi.mock('@/db', () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './db/migrations' });
  return { db, schema };
});

describe('accounts API', () => {
  it('creates and lists an account', async () => {
    const createReq = new Request('http://x/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme', domain: 'acme.com' }),
    });
    const createRes = await POST(createReq);
    expect(createRes.status).toBe(200);
    const { id } = await createRes.json();
    expect(id).toMatch(/^acc_/);

    const listRes = await GET();
    const { accounts } = await listRes.json();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe('Acme');
  });

  it('rejects invalid input', async () => {
    const req = new Request('http://x/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 5.6: Run tests + manual smoke**

```bash
pnpm test
pnpm dev
```

Navigate to http://localhost:3000, click "+ New account", create "Acme", verify it appears on the home page and the detail page loads.

- [ ] **Step 5.7: Commit**

```bash
git add -A
git commit -m "Accounts CRUD: API + list + create + detail pages"
```

---

## Task 6: Evidence paste + extraction

**Files:**
- Create: `lib/evidence/extract.ts`, `lib/claude/prompts/extract-evidence.ts`
- Create: `app/api/evidence/paste/route.ts`, `app/accounts/[id]/evidence/page.tsx`
- Create: `tests/unit/extract.test.ts`

- [ ] **Step 6.1: Write `lib/claude/prompts/extract-evidence.ts`**

```ts
export const EXTRACT_EVIDENCE_PROMPT = `You are an evidence extraction assistant for a sales research tool.

INPUT: The user will provide a URL and a block of source text.

YOUR TASK: Extract atomic facts from the source text. Each fact must be:
- One sentence.
- Strictly supported by the text provided — no inference, no synthesis.
- Specific enough to cite in outreach (names, numbers, dates, products, decisions).
- Independent — do not combine multiple facts into one.

For each fact, record:
- source_url: the URL the user provided (copy verbatim)
- source_type: classify as one of: website | linkedin | news | 10k | job_post | podcast | manual | perplexity | deep_research
- snippet: the minimal verbatim substring of the source text that supports this fact (≤1500 chars). MUST be a literal substring.
- extracted_fact: the atomic fact as one sentence.
- confidence: high (fact is stated explicitly), medium (fact is clearly implied), low (fact is inferred or soft)

OUTPUT: Return only JSON in this exact shape:

{
  "evidence": [
    { "source_url": "...", "source_type": "...", "snippet": "...",
      "extracted_fact": "...", "confidence": "high|medium|low" }
  ]
}

If the text contains no extractable facts, return {"evidence": []}.
Do not wrap the output in markdown code fences.`;
```

- [ ] **Step 6.2: Write `lib/evidence/extract.ts`**

```ts
import { spawnClaude } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { EXTRACT_EVIDENCE_PROMPT } from '../claude/prompts/extract-evidence';
import { ExtractionResult } from '../claude/types';
import { db, schema } from '@/db';
import { newId } from '../id';

export interface PasteInput {
  accountId: string;
  contactId?: string;
  sourceUrl: string;
  rawText: string;
  capturedBy: 'manual' | 'claude_cli' | 'perplexity_mcp' | 'chatgpt_mcp'
    | 'deep_research_paste';
}

export async function extractFromPaste(input: PasteInput): Promise<string[]> {
  const prompt = renderPrompt([
    { heading: 'Instructions', body: EXTRACT_EVIDENCE_PROMPT },
    { heading: 'Source URL', body: input.sourceUrl },
    { heading: 'Source text', body: input.rawText },
  ]);
  const result = await spawnClaude({
    prompt, schema: ExtractionResult, model: 'haiku',
  });

  const ids: string[] = [];
  for (const item of result.evidence) {
    if (!input.rawText.toLowerCase().includes(item.snippet.toLowerCase())) {
      // Drop any snippet that isn't a literal substring of the provided text
      continue;
    }
    const id = newId('evidence');
    db.insert(schema.evidence).values({
      id,
      accountId: input.accountId,
      contactId: input.contactId,
      sourceUrl: item.source_url,
      sourceType: item.source_type,
      snippet: item.snippet,
      extractedFact: item.extracted_fact,
      confidence: item.confidence,
      capturedBy: input.capturedBy,
      extractionStatus: 'pending_audit',
    }).run();
    ids.push(id);
  }
  return ids;
}
```

- [ ] **Step 6.3: Write `tests/unit/extract.test.ts`**

Test the substring-drop behavior without hitting the LLM by injecting a fake `spawnClaude` via dep injection. Refactor `extract.ts` to accept an optional spawn function:

Modify `lib/evidence/extract.ts` top:
```ts
import { spawnClaude as realSpawn } from '../claude/run';
type SpawnFn = typeof realSpawn;
export async function extractFromPaste(
  input: PasteInput,
  spawn: SpawnFn = realSpawn,
): Promise<string[]> {
  // ...replace `spawnClaude(...)` with `spawn(...)`
}
```

Then the test:
```ts
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';

vi.mock('@/db', () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './db/migrations' });
  db.insert(schema.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
  return { db, schema };
});

import { extractFromPaste } from '../../lib/evidence/extract';

describe('extractFromPaste', () => {
  it('drops snippets that are not substrings of the source text', async () => {
    const fakeSpawn = vi.fn().mockResolvedValue({
      evidence: [
        { source_url: 'https://x', source_type: 'website',
          snippet: 'Acme hired a VP of Data',
          extracted_fact: 'Acme hired a VP of Data.', confidence: 'high' },
        { source_url: 'https://x', source_type: 'website',
          snippet: 'This is not in the source',
          extracted_fact: 'Something else.', confidence: 'high' },
      ],
    });
    const rawText = 'On Tuesday, Acme hired a VP of Data, per a LinkedIn post.';
    const ids = await extractFromPaste({
      accountId: 'acc_1', sourceUrl: 'https://x', rawText, capturedBy: 'manual',
    }, fakeSpawn as any);
    expect(ids).toHaveLength(1);
  });
});
```

- [ ] **Step 6.4: Write `app/api/evidence/paste/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { extractFromPaste } from '@/lib/evidence/extract';

const PasteBody = z.object({
  accountId: z.string(),
  contactId: z.string().optional(),
  sourceUrl: z.string().url(),
  rawText: z.string().min(10),
  capturedBy: z.enum(['manual', 'claude_cli', 'perplexity_mcp',
    'chatgpt_mcp', 'deep_research_paste']).default('manual'),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = PasteBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  try {
    const ids = await extractFromPaste(parsed.data);
    return NextResponse.json({ evidenceIds: ids });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 6.5: Write `app/accounts/[id]/evidence/page.tsx`**

```tsx
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PasteForm } from './PasteForm';

export const dynamic = 'force-dynamic';

export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();
  const evidence = db.select().from(schema.evidence)
    .where(eq(schema.evidence.accountId, id)).all();
  return (
    <main>
      <Link href={`/accounts/${id}`} className="text-sm text-neutral-500">← {account.name}</Link>
      <h1 className="mt-2 text-2xl font-semibold">Evidence</h1>
      <PasteForm accountId={id} />
      <h2 className="mt-8 text-lg font-medium">Captured ({evidence.length})</h2>
      <ul className="mt-3 space-y-2">
        {evidence.map((e) => (
          <li key={e.id} className="rounded border border-neutral-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">
                {e.extractionStatus}
              </span>
              <a href={e.sourceUrl} target="_blank" rel="noreferrer"
                 className="text-xs text-blue-600 underline">{e.sourceType}</a>
            </div>
            <p className="mt-2 text-sm font-medium">{e.extractedFact}</p>
            <p className="mt-1 text-xs text-neutral-500 italic line-clamp-2">
              “{e.snippet}”
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

And `app/accounts/[id]/evidence/PasteForm.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function PasteForm({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await fetch('/api/evidence/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, sourceUrl: url, rawText: text, capturedBy: 'manual' }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error?.toString() ?? 'Extraction failed');
      return;
    }
    setUrl(''); setText('');
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3 rounded border border-neutral-200 bg-white p-4">
      <h2 className="text-lg font-medium">Paste evidence</h2>
      <input className="w-full rounded border border-neutral-300 p-2"
             value={url} onChange={(e) => setUrl(e.target.value)}
             placeholder="Source URL (required)" required />
      <textarea className="w-full rounded border border-neutral-300 p-2 font-mono text-sm"
                rows={8} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="Paste raw text from the source (article, LinkedIn post, 10-K excerpt, etc.)"
                required />
      <button disabled={busy}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
        {busy ? 'Extracting…' : 'Extract facts'}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 6.6: Run tests + manual smoke**

```bash
pnpm test
pnpm dev
```

Create an account, click "Evidence", paste a real URL and raw text from a company blog post. Verify rows appear with `pending_audit` status.

- [ ] **Step 6.7: Commit**

```bash
git add -A
git commit -m "Evidence paste + extraction with substring guard"
```

---

## Task 7: Extraction Audit critic + audit queue

**Files:**
- Create: `lib/evidence/audit.ts`, `lib/claude/prompts/audit-extraction.ts`
- Create: `app/api/evidence/audit/route.ts`
- Modify: `app/accounts/[id]/evidence/page.tsx` (add audit queue section)
- Create: `tests/unit/audit.test.ts`

- [ ] **Step 7.1: Write `lib/claude/prompts/audit-extraction.ts`**

```ts
export const AUDIT_PROMPT = `You are an Extraction Audit critic for a sales research tool.

You will receive an evidence row: a snippet (raw source text) and an extracted_fact (a one-sentence claim derived from the snippet).

YOUR TASK: Determine whether the extracted_fact is strictly supported by the snippet.

Rules:
- "Verified" = the fact is explicitly stated or very clearly implied by the snippet, with no inference beyond what the text says.
- "Disputed" = the fact overstates, misreads, paraphrases incorrectly, infers beyond the text, or cannot be confirmed from the snippet alone.
- Err on the side of disputed when in doubt. False verified is more harmful than false disputed.

OUTPUT: JSON only, in this exact shape:

{
  "evidence_id": "<copied from input>",
  "verdict": "verified" | "disputed",
  "reason": "<one sentence explaining>",
  "suggested_correction": "<a more accurate fact supported by the snippet, or null>"
}`;
```

- [ ] **Step 7.2: Write `lib/evidence/audit.ts`**

```ts
import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { AUDIT_PROMPT } from '../claude/prompts/audit-extraction';
import { ExtractionAuditResult } from '../claude/types';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { newId } from '../id';

type SpawnFn = typeof realSpawn;

export async function auditOne(
  evidenceId: string,
  spawn: SpawnFn = realSpawn,
): Promise<'verified' | 'disputed'> {
  const row = db.select().from(schema.evidence)
    .where(eq(schema.evidence.id, evidenceId)).get();
  if (!row) throw new Error('evidence not found');

  const prompt = renderPrompt([
    { heading: 'Instructions', body: AUDIT_PROMPT },
    { heading: 'Input', body: JSON.stringify({
        evidence_id: row.id, snippet: row.snippet, extracted_fact: row.extractedFact,
      }, null, 2),
    },
  ]);
  const result = await spawn({
    prompt, schema: ExtractionAuditResult, model: 'haiku',
  });

  db.insert(schema.extractionAudits).values({
    id: newId('extractionAudit'),
    evidenceId: row.id,
    verdict: result.verdict,
    reason: result.reason,
    suggestedCorrection: result.suggested_correction,
  }).run();

  db.update(schema.evidence)
    .set({ extractionStatus: result.verdict })
    .where(eq(schema.evidence.id, row.id)).run();

  return result.verdict;
}

export async function auditPendingForAccount(
  accountId: string,
  spawn: SpawnFn = realSpawn,
): Promise<{ verified: number; disputed: number }> {
  const pending = db.select().from(schema.evidence)
    .where(and(
      eq(schema.evidence.accountId, accountId),
      eq(schema.evidence.extractionStatus, 'pending_audit'),
    )).all();

  let verified = 0, disputed = 0;
  for (const row of pending) {
    const verdict = await auditOne(row.id, spawn);
    if (verdict === 'verified') verified++; else disputed++;
  }
  return { verified, disputed };
}
```

- [ ] **Step 7.3: Write `app/api/evidence/audit/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditPendingForAccount } from '@/lib/evidence/audit';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';

const RunBody = z.object({ accountId: z.string() });
const ResolveBody = z.object({
  evidenceId: z.string(),
  action: z.enum(['accept_correction', 'override_verified', 'remove']),
});

export async function POST(req: Request) {
  const body = await req.json();
  const run = RunBody.safeParse(body);
  if (run.success) {
    const counts = await auditPendingForAccount(run.data.accountId);
    return NextResponse.json(counts);
  }
  const resolve = ResolveBody.safeParse(body);
  if (!resolve.success) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const { evidenceId, action } = resolve.data;
  if (action === 'remove') {
    db.delete(schema.evidence).where(eq(schema.evidence.id, evidenceId)).run();
  } else if (action === 'override_verified') {
    db.update(schema.evidence).set({ extractionStatus: 'verified' })
      .where(eq(schema.evidence.id, evidenceId)).run();
  } else if (action === 'accept_correction') {
    const audit = db.select().from(schema.extractionAudits)
      .where(eq(schema.extractionAudits.evidenceId, evidenceId)).all()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (audit?.suggestedCorrection) {
      db.update(schema.evidence)
        .set({ extractedFact: audit.suggestedCorrection, extractionStatus: 'verified' })
        .where(eq(schema.evidence.id, evidenceId)).run();
    }
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 7.4: Add audit queue UI to `app/accounts/[id]/evidence/page.tsx`**

Append beneath the existing list:

```tsx
import { AuditControls } from './AuditControls';
// inside the return, after the captured list:
<AuditControls accountId={id} />
```

Create `app/accounts/[id]/evidence/AuditControls.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function AuditControls({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    const res = await fetch('/api/evidence/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    const { verified, disputed } = await res.json();
    setBusy(false);
    setMsg(`Audited: ${verified} verified, ${disputed} disputed.`);
    router.refresh();
  }

  return (
    <div className="mt-6 flex items-center gap-3">
      <button disabled={busy} onClick={run}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
        {busy ? 'Auditing…' : 'Run extraction audit on pending'}
      </button>
      {msg && <span className="text-sm text-neutral-600">{msg}</span>}
    </div>
  );
}
```

- [ ] **Step 7.5: Write `tests/unit/audit.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';

const fakeDb = (() => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './db/migrations' });
  return db;
})();

vi.mock('@/db', () => ({ db: fakeDb, schema }));

import { auditOne } from '../../lib/evidence/audit';

describe('auditOne', () => {
  beforeEach(() => {
    fakeDb.delete(schema.extractionAudits).run();
    fakeDb.delete(schema.evidence).run();
    fakeDb.delete(schema.accounts).run();
    fakeDb.insert(schema.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
    fakeDb.insert(schema.evidence).values({
      id: 'ev_1', accountId: 'acc_1', sourceUrl: 'https://x',
      sourceType: 'website', snippet: 'Acme is hiring a VP of Data.',
      extractedFact: 'Acme hired a VP of Data.',
      capturedBy: 'manual', extractionStatus: 'pending_audit',
    }).run();
  });

  it('flips evidence to disputed when the fact overstates', async () => {
    const fakeSpawn = vi.fn().mockResolvedValue({
      evidence_id: 'ev_1',
      verdict: 'disputed',
      reason: 'Snippet says "is hiring" not "hired".',
      suggested_correction: 'Acme is hiring a VP of Data.',
    });
    const verdict = await auditOne('ev_1', fakeSpawn as any);
    expect(verdict).toBe('disputed');
    const row = fakeDb.select().from(schema.evidence).all()[0];
    expect(row.extractionStatus).toBe('disputed');
  });

  it('flips evidence to verified when the fact is supported', async () => {
    const fakeSpawn = vi.fn().mockResolvedValue({
      evidence_id: 'ev_1',
      verdict: 'verified',
      reason: 'Fact is supported.',
      suggested_correction: null,
    });
    const verdict = await auditOne('ev_1', fakeSpawn as any);
    expect(verdict).toBe('verified');
  });
});
```

- [ ] **Step 7.6: Run tests + manual smoke**

```bash
pnpm test
pnpm dev
```

Extract some evidence, click "Run extraction audit on pending", verify rows flip to `verified` or `disputed`.

- [ ] **Step 7.7: Commit**

```bash
git add -A
git commit -m "Extraction Audit critic + audit queue"
```

---

## Task 8: Contact CRUD with archetype

**Files:**
- Create: `app/api/contacts/route.ts`, `app/accounts/[id]/contacts/page.tsx`, `app/accounts/[id]/contacts/new/page.tsx`
- Create: `tests/integration/contacts-api.test.ts`

- [ ] **Step 8.1: Write `app/api/contacts/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { newId } from '@/lib/id';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

const CreateContact = z.object({
  accountId: z.string(),
  fullName: z.string().min(1),
  title: z.string().optional(),
  linkedinUrl: z.string().url().optional(),
  email: z.string().email().optional(),
  archetype: z.enum(['gatekeeper', 'business_user', 'enabler', 'leader', 'unknown'])
    .default('unknown'),
  notes: z.string().optional(),
});

const UpdateContact = z.object({
  id: z.string(),
  archetype: z.enum(['gatekeeper', 'business_user', 'enabler', 'leader', 'unknown']).optional(),
  title: z.string().optional(),
  email: z.string().email().optional(),
  notes: z.string().optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const accountId = url.searchParams.get('accountId');
  const q = accountId
    ? db.select().from(schema.contacts).where(eq(schema.contacts.accountId, accountId))
    : db.select().from(schema.contacts);
  return NextResponse.json({ contacts: q.all() });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = CreateContact.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const id = newId('contact');
  db.insert(schema.contacts).values({ id, ...parsed.data }).run();
  return NextResponse.json({ id });
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const parsed = UpdateContact.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const { id, ...patch } = parsed.data;
  db.update(schema.contacts).set(patch).where(eq(schema.contacts.id, id)).run();
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 8.2: Write `app/accounts/[id]/contacts/page.tsx`**

```tsx
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function ContactsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();
  const contacts = db.select().from(schema.contacts)
    .where(eq(schema.contacts.accountId, id)).all();
  return (
    <main>
      <Link href={`/accounts/${id}`} className="text-sm text-neutral-500">← {account.name}</Link>
      <div className="mt-2 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Contacts</h1>
        <Link href={`/accounts/${id}/contacts/new`}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
          + New contact
        </Link>
      </div>
      <ul className="mt-4 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
        {contacts.map((c) => (
          <li key={c.id} className="p-3">
            <div className="font-medium">{c.fullName}</div>
            <div className="text-sm text-neutral-500">
              {c.title} · {c.archetype}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 8.3: Write `app/accounts/[id]/contacts/new/page.tsx`**

```tsx
'use client';
import { useRouter, useParams } from 'next/navigation';
import { useState } from 'react';

const ARCHETYPES = ['unknown', 'gatekeeper', 'business_user', 'enabler', 'leader'] as const;

export default function NewContactPage() {
  const router = useRouter();
  const { id: accountId } = useParams<{ id: string }>();
  const [fullName, setFullName] = useState('');
  const [title, setTitle] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [archetype, setArchetype] = useState<typeof ARCHETYPES[number]>('unknown');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId, fullName, title: title || undefined,
        linkedinUrl: linkedinUrl || undefined, archetype,
      }),
    });
    router.push(`/accounts/${accountId}/contacts`);
  }

  return (
    <main>
      <h1 className="text-xl font-semibold">New contact</h1>
      <form onSubmit={submit} className="mt-4 max-w-md space-y-3">
        <label className="block">
          <span className="text-sm">Full name</span>
          <input className="mt-1 w-full rounded border border-neutral-300 p-2"
                 required value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm">Title</span>
          <input className="mt-1 w-full rounded border border-neutral-300 p-2"
                 value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm">LinkedIn URL</span>
          <input className="mt-1 w-full rounded border border-neutral-300 p-2"
                 value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm">Buyer archetype</span>
          <select className="mt-1 w-full rounded border border-neutral-300 p-2"
                  value={archetype} onChange={(e) => setArchetype(e.target.value as any)}>
            {ARCHETYPES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <span className="mt-1 block text-xs text-neutral-500">
            gatekeeper = procurement/ops · business_user = uses the product ·
            enabler = IT/HR/enablement · leader = exec/founder
          </span>
        </label>
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">Create</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 8.4: Write `tests/integration/contacts-api.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';

const fakeDb = (() => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './db/migrations' });
  db.insert(schema.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
  return db;
})();

vi.mock('@/db', () => ({ db: fakeDb, schema }));

import { POST, PATCH } from '../../app/api/contacts/route';

describe('contacts API', () => {
  it('creates a contact with archetype defaulting to unknown', async () => {
    const req = new Request('http://x/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc_1', fullName: 'Jane Doe' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const row = fakeDb.select().from(schema.contacts).all()[0];
    expect(row.fullName).toBe('Jane Doe');
    expect(row.archetype).toBe('unknown');
  });

  it('patches archetype', async () => {
    const row = fakeDb.select().from(schema.contacts).all()[0];
    const req = new Request('http://x/api/contacts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row.id, archetype: 'leader' }),
    });
    await PATCH(req);
    const updated = fakeDb.select().from(schema.contacts).all()[0];
    expect(updated.archetype).toBe('leader');
  });
});
```

- [ ] **Step 8.5: Run tests + manual smoke + commit**

```bash
pnpm test
pnpm dev    # create a contact, verify archetype dropdown works
git add -A
git commit -m "Contacts CRUD with archetype"
```

---

## Task 9: Auto-research via Claude CLI

**Files:**
- Create: `lib/research/auto-research.ts`, `lib/claude/prompts/research-account.ts`
- Create: `skills/research-account/SKILL.md`
- Create: `app/api/evidence/research/route.ts`
- Modify: `app/accounts/[id]/evidence/page.tsx` (add "Run auto-research" button)

- [ ] **Step 9.1: Write `skills/research-account/SKILL.md`**

```md
---
name: research-account
description: Research a B2B sales target account; fetch public sources (company website, LinkedIn company page, recent news) and return extracted evidence as structured JSON.
---

# Research account

You are researching a B2B sales target account. You have WebFetch and WebSearch tools.

## Inputs
- `account.name`
- `account.domain` (if provided)

## Workflow
1. Fetch the company homepage and an "about" page if present.
2. Search for recent news (last 90 days) using WebSearch.
3. Fetch the top 3 most informative results.
4. For each source, extract atomic facts per the Evidence Extraction rules below.

## Evidence Extraction rules
[same rules as lib/claude/prompts/extract-evidence.ts — one sentence per fact, strict substring snippet ≤1500 chars, classify source_type]

## Output
Return only JSON in this shape:

```json
{
  "evidence": [
    { "source_url": "...", "source_type": "website|news|...",
      "snippet": "...", "extracted_fact": "...", "confidence": "high|medium|low" }
  ]
}
```

Target 8–20 facts per account. Quality over quantity — drop low-signal items.
```

- [ ] **Step 9.2: Write `lib/claude/prompts/research-account.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

export function loadResearchAccountSkill(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), 'skills/research-account/SKILL.md'),
    'utf8',
  );
}
```

- [ ] **Step 9.3: Write `lib/research/auto-research.ts`**

```ts
import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { loadResearchAccountSkill } from '../claude/prompts/research-account';
import { ExtractionResult } from '../claude/types';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '../id';

type SpawnFn = typeof realSpawn;

export async function autoResearchAccount(
  accountId: string,
  spawn: SpawnFn = realSpawn,
): Promise<string[]> {
  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  if (!account) throw new Error('account not found');

  const prompt = renderPrompt([
    { heading: 'Skill', body: loadResearchAccountSkill() },
    { heading: 'Account', body: JSON.stringify({
        name: account.name, domain: account.domain,
      }, null, 2),
    },
  ]);

  const result = await spawn({
    prompt, schema: ExtractionResult, model: 'sonnet', timeoutMs: 300_000,
  });

  const ids: string[] = [];
  for (const item of result.evidence) {
    // Cannot substring-verify here since we don't have the full source text;
    // Extraction Audit critic handles that on a per-row basis.
    const id = newId('evidence');
    db.insert(schema.evidence).values({
      id, accountId,
      sourceUrl: item.source_url,
      sourceType: item.source_type,
      snippet: item.snippet.slice(0, 1500),
      extractedFact: item.extracted_fact,
      confidence: item.confidence,
      capturedBy: 'claude_cli',
      extractionStatus: 'pending_audit',
    }).run();
    ids.push(id);
  }
  return ids;
}
```

- [ ] **Step 9.4: Write `app/api/evidence/research/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autoResearchAccount } from '@/lib/research/auto-research';

const Body = z.object({ accountId: z.string() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  try {
    const ids = await autoResearchAccount(parsed.data.accountId);
    return NextResponse.json({ evidenceIds: ids });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 9.5: Add "Run auto-research" button to evidence page**

Add to `PasteForm.tsx` or create a separate component next to the paste form. Simplest: add to the evidence page alongside AuditControls.

Create `app/accounts/[id]/evidence/ResearchButton.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ResearchButton({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function go() {
    setBusy(true); setMsg(null);
    const res = await fetch('/api/evidence/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    setBusy(false);
    if (!res.ok) { setMsg('Research failed'); return; }
    const { evidenceIds } = await res.json();
    setMsg(`Captured ${evidenceIds.length} facts (pending audit).`);
    router.refresh();
  }
  return (
    <div className="mt-3">
      <button disabled={busy} onClick={go}
              className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm disabled:opacity-50">
        {busy ? 'Researching…' : 'Run auto-research'}
      </button>
      {msg && <span className="ml-2 text-sm text-neutral-600">{msg}</span>}
    </div>
  );
}
```

Include it in evidence page alongside `<PasteForm />` and `<AuditControls />`.

- [ ] **Step 9.6: Manual smoke + commit**

```bash
pnpm dev
```

On an account, click "Run auto-research". Expect a spinner for 30-120s, then a count message. Verify new evidence rows appear.

```bash
git add -A
git commit -m "Auto-research via Claude CLI WebFetch/WebSearch skill"
```

---

## Task 10: Drafter + validator

**Files:**
- Create: `lib/evidence/validate.ts`, `lib/drafter/draft.ts`, `lib/claude/prompts/draft-touch.ts`
- Create: `skills/draft-touch/SKILL.md`
- Create: `tests/unit/validate.test.ts`

- [ ] **Step 10.1: Write `lib/evidence/validate.ts`**

```ts
import type { DraftTouch } from '../claude/types';

export interface EvidenceRow {
  id: string;
  snippet: string;
}

export interface ValidationIssue {
  kind: 'unknown_evidence_id' | 'span_not_in_snippet' | 'missing_evidence';
  detail: string;
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function validateDraft(
  draft: DraftTouch,
  availableEvidence: EvidenceRow[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(availableEvidence.map((e) => [e.id, e]));

  for (const id of draft.cited_evidence_ids) {
    if (!byId.has(id)) {
      issues.push({ kind: 'unknown_evidence_id', detail: id });
    }
  }
  for (const span of draft.supporting_spans) {
    const ev = byId.get(span.evidence_id);
    if (!ev) {
      issues.push({ kind: 'unknown_evidence_id', detail: span.evidence_id });
      continue;
    }
    if (!normalize(ev.snippet).includes(normalize(span.span))) {
      issues.push({
        kind: 'span_not_in_snippet',
        detail: `span "${span.span.slice(0, 80)}…" not in snippet of ${span.evidence_id}`,
      });
    }
  }
  return issues;
}
```

- [ ] **Step 10.2: Write `tests/unit/validate.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { validateDraft } from '../../lib/evidence/validate';
import type { DraftTouch } from '../../lib/claude/types';

const evidence = [
  { id: 'ev_a', snippet: 'Acme is hiring a VP of Data per a LinkedIn post.' },
  { id: 'ev_b', snippet: 'Revenue grew 40% in Q2 2026.' },
];

describe('validateDraft', () => {
  it('passes when every span is a substring of its snippet', () => {
    const draft: DraftTouch = {
      subject: 'Hey', body: 'Saw you are hiring a VP of Data.', channel: 'email',
      cited_evidence_ids: ['ev_a'],
      supporting_spans: [{ evidence_id: 'ev_a', span: 'hiring a VP of Data', claim: 'Saw you are hiring a VP of Data.' }],
      rationale: '',
    };
    expect(validateDraft(draft, evidence)).toHaveLength(0);
  });

  it('flags unknown evidence ids', () => {
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_missing'],
      supporting_spans: [], rationale: '',
    };
    expect(validateDraft(draft, evidence)[0].kind).toBe('unknown_evidence_id');
  });

  it('flags spans that are not substrings', () => {
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_a'],
      supporting_spans: [{ evidence_id: 'ev_a', span: 'promoted to CTO', claim: 'x' }],
      rationale: '',
    };
    expect(validateDraft(draft, evidence)[0].kind).toBe('span_not_in_snippet');
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    const draft: DraftTouch = {
      subject: null, body: 'x', channel: 'linkedin',
      cited_evidence_ids: ['ev_a'],
      supporting_spans: [{ evidence_id: 'ev_a', span: 'HIRING   a vp\nof data', claim: 'x' }],
      rationale: '',
    };
    expect(validateDraft(draft, evidence)).toHaveLength(0);
  });
});
```

- [ ] **Step 10.3: Write `skills/draft-touch/SKILL.md`**

```md
---
name: draft-touch
description: Write a single outbound touch (email or LinkedIn DM) for a sequence. Use only the provided evidence; cite every factual claim with an evidence_id and a verbatim supporting_span from that evidence's snippet.
---

# Draft Touch

You are drafting ONE touch in a B2B sales sequence.

## Inputs (provided separately)
- ICP brief
- Account evidence pack (verified rows only; each has id, source_url, source_type, snippet, extracted_fact)
- Contact evidence pack (if targeting a specific contact)
- Principles file (this is the rubric your draft will be scored against)
- Position in sequence (touch N of M)
- Prior touches (already sent or drafted in this sequence)

## Hard rules
1. Every factual or personalized claim about the account/contact MUST be backed by a cited `evidence_id` AND a `supporting_span` that is a verbatim substring of that evidence row's `snippet`.
2. Do not invent facts. If you do not have evidence for a claim, do not make the claim.
3. Respect word caps: email body ≤120 words, LinkedIn DM ≤60 words.
4. One CTA per touch. Small and low-friction on touch 1; larger on later touches.
5. Lead with a specific observation (from evidence), never with self-introduction.
6. Read your draft aloud mentally — if a sentence feels awkward or corporate, rewrite it.

## Output JSON (only — no prose, no code fences)
{
  "subject": "string or null (null for LinkedIn)",
  "body": "string",
  "channel": "email|linkedin",
  "cited_evidence_ids": ["ev_..."],
  "supporting_spans": [
    { "evidence_id": "ev_...", "span": "verbatim substring of that snippet",
      "claim": "the sentence in body this span supports" }
  ],
  "rationale": "why this angle, why this CTA, why this touch position"
}
```

- [ ] **Step 10.4: Write `lib/claude/prompts/draft-touch.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

export function loadDraftTouchSkill(): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'skills/draft-touch/SKILL.md'), 'utf8');
}

export function loadPrinciples(): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'data/principles.md'), 'utf8');
}

export function loadIcp(): string {
  const p = path.resolve(process.cwd(), 'data/icp.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(No ICP brief yet.)';
}
```

- [ ] **Step 10.5: Write `lib/drafter/draft.ts`**

```ts
import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import {
  loadDraftTouchSkill, loadPrinciples, loadIcp,
} from '../claude/prompts/draft-touch';
import { DraftTouch } from '../claude/types';
import { validateDraft } from '../evidence/validate';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { newId } from '../id';

type SpawnFn = typeof realSpawn;

export interface DraftArgs {
  touchId: string;
  contactId?: string;
}

export async function draftTouch(
  args: DraftArgs,
  spawn: SpawnFn = realSpawn,
): Promise<{ revisionId: string; issues: string[] }> {
  const touch = db.select().from(schema.touches).where(eq(schema.touches.id, args.touchId)).get();
  if (!touch) throw new Error('touch not found');
  const sequence = db.select().from(schema.sequences).where(eq(schema.sequences.id, touch.sequenceId)).get();
  if (!sequence) throw new Error('sequence not found');

  const evidenceRows = db.select().from(schema.evidence)
    .where(and(
      eq(schema.evidence.accountId, sequence.accountId),
      eq(schema.evidence.extractionStatus, 'verified'),
    )).all();

  const priorTouches = db.select().from(schema.touches)
    .where(eq(schema.touches.sequenceId, touch.sequenceId)).all()
    .filter((t) => t.position < touch.position)
    .sort((a, b) => a.position - b.position);

  const priorRevisions = priorTouches
    .map((t) => t.currentRevisionId
      ? db.select().from(schema.touchRevisions)
          .where(eq(schema.touchRevisions.id, t.currentRevisionId)).get()
      : null)
    .filter(Boolean);

  const evidencePack = evidenceRows.map((e) => ({
    id: e.id, source_url: e.sourceUrl, source_type: e.sourceType,
    snippet: e.snippet, extracted_fact: e.extractedFact,
  }));

  async function runDrafter(extraCorrection?: string): Promise<DraftTouch> {
    const prompt = renderPrompt([
      { heading: 'Skill', body: loadDraftTouchSkill() },
      { heading: 'ICP brief', body: loadIcp() },
      { heading: 'Principles', body: loadPrinciples() },
      { heading: 'Account evidence pack', body: JSON.stringify(evidencePack, null, 2) },
      { heading: 'Position', body: `Touch ${touch.position} of this sequence. Channel: ${touch.channel}.` },
      { heading: 'Prior touches', body: JSON.stringify(priorRevisions.map((r) => ({
          subject: r!.subject, body: r!.body,
        })), null, 2),
      },
      ...(extraCorrection ? [{ heading: 'Correction', body: extraCorrection }] : []),
    ]);
    return spawn({ prompt, schema: DraftTouch, model: 'sonnet', timeoutMs: 180_000 });
  }

  let draft = await runDrafter();
  let issues = validateDraft(draft, evidenceRows.map((e) => ({ id: e.id, snippet: e.snippet })));

  if (issues.length > 0) {
    const correction = `Your prior draft had these issues:\n` +
      issues.map((i) => `- ${i.kind}: ${i.detail}`).join('\n') +
      `\n\nRewrite the draft so that every span is a verbatim substring of its cited evidence snippet.`;
    draft = await runDrafter(correction);
    issues = validateDraft(draft, evidenceRows.map((e) => ({ id: e.id, snippet: e.snippet })));
  }

  // Persist regardless — surface issues to user if they remain.
  const revisionId = newId('touchRevision');
  const existingRevisions = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.touchId, args.touchId)).all();
  const revisionNumber = existingRevisions.length + 1;

  db.insert(schema.touchRevisions).values({
    id: revisionId,
    touchId: args.touchId,
    revisionNumber,
    subject: draft.subject,
    body: draft.body,
    citedEvidenceIds: draft.cited_evidence_ids,
    supportingSpans: draft.supporting_spans,
    rationale: draft.rationale,
    createdBy: 'drafter',
  }).run();
  db.update(schema.touches).set({ currentRevisionId: revisionId })
    .where(eq(schema.touches.id, args.touchId)).run();

  return { revisionId, issues: issues.map((i) => `${i.kind}: ${i.detail}`) };
}
```

- [ ] **Step 10.6: Run validator tests + commit**

```bash
pnpm test
```

Expected: all validator tests pass.

```bash
git add -A
git commit -m "Drafter + validator with substring enforcement and one-retry loop"
```

---

## Task 11: Sequences + touches UI

**Files:**
- Create: `app/api/sequences/route.ts`, `app/api/touches/route.ts`, `app/api/touches/draft/route.ts`
- Create: `app/accounts/[id]/sequences/page.tsx`, `app/accounts/[id]/sequences/new/page.tsx`, `app/accounts/[id]/sequences/[sid]/page.tsx`
- Create: `components/EvidencePill.tsx`, `components/TouchBodyWithHighlights.tsx`

- [ ] **Step 11.1: Write `app/api/sequences/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { newId } from '@/lib/id';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

const Create = z.object({
  accountId: z.string(),
  channels: z.array(z.enum(['email', 'linkedin'])).min(1).max(10),
});

export async function POST(req: Request) {
  const parsed = Create.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const sequenceId = newId('sequence');
  db.insert(schema.sequences).values({
    id: sequenceId, accountId: parsed.data.accountId,
  }).run();
  const touchIds: string[] = [];
  parsed.data.channels.forEach((channel, idx) => {
    const id = newId('touch');
    db.insert(schema.touches).values({
      id, sequenceId, position: idx + 1, channel,
    }).run();
    touchIds.push(id);
  });
  return NextResponse.json({ sequenceId, touchIds });
}
```

- [ ] **Step 11.2: Write `app/api/touches/draft/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { draftTouch } from '@/lib/drafter/draft';

const Body = z.object({ touchId: z.string(), contactId: z.string().optional() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  try {
    const result = await draftTouch(parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 11.3: Write `app/accounts/[id]/sequences/new/page.tsx`**

```tsx
'use client';
import { useRouter, useParams } from 'next/navigation';
import { useState } from 'react';

type Channel = 'email' | 'linkedin';

export default function NewSequencePage() {
  const router = useRouter();
  const { id: accountId } = useParams<{ id: string }>();
  const [channels, setChannels] = useState<Channel[]>(['email', 'linkedin', 'email']);

  function setAt(i: number, c: Channel) {
    setChannels(channels.map((ch, idx) => idx === i ? c : ch));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/sequences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, channels }),
    });
    const { sequenceId } = await res.json();
    router.push(`/accounts/${accountId}/sequences/${sequenceId}`);
  }

  return (
    <main>
      <h1 className="text-xl font-semibold">New sequence</h1>
      <form onSubmit={submit} className="mt-4 max-w-md space-y-3">
        <p className="text-sm text-neutral-700">Touches (in order):</p>
        <ul className="space-y-2">
          {channels.map((c, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-6 text-sm text-neutral-500">#{i + 1}</span>
              <select value={c} onChange={(e) => setAt(i, e.target.value as Channel)}
                      className="rounded border border-neutral-300 p-1 text-sm">
                <option value="email">email</option>
                <option value="linkedin">linkedin</option>
              </select>
              <button type="button" onClick={() => setChannels(channels.filter((_, idx) => idx !== i))}
                      className="text-xs text-red-600">remove</button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => setChannels([...channels, 'email'])}
                className="text-sm text-blue-600">+ Add touch</button>
        <div>
          <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
            Create sequence
          </button>
        </div>
      </form>
    </main>
  );
}
```

- [ ] **Step 11.4: Write `components/EvidencePill.tsx`**

```tsx
'use client';
export function EvidencePill({
  id, fact, sourceUrl,
}: { id: string; fact: string; sourceUrl: string }) {
  return (
    <a href={sourceUrl} target="_blank" rel="noreferrer"
       title={fact}
       className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800 hover:bg-emerald-200">
      {id.slice(0, 8)}
    </a>
  );
}
```

- [ ] **Step 11.5: Write `components/TouchBodyWithHighlights.tsx`**

```tsx
'use client';

export function TouchBodyWithHighlights({
  body, spans,
}: {
  body: string;
  spans: Array<{ evidence_id: string; span: string; claim: string }>;
}) {
  // Highlight each `claim` substring of the body.
  const claims = spans.map((s) => s.claim).filter(Boolean);
  if (claims.length === 0) return <p className="whitespace-pre-wrap">{body}</p>;
  // Build regex that matches any claim; highlight matches.
  const escaped = claims.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'g');
  const parts = body.split(re);
  return (
    <p className="whitespace-pre-wrap leading-relaxed">
      {parts.map((part, i) =>
        claims.includes(part)
          ? <mark key={i} className="bg-emerald-100 text-emerald-900 rounded px-0.5">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </p>
  );
}
```

- [ ] **Step 11.6: Write `app/accounts/[id]/sequences/[sid]/page.tsx`**

```tsx
import { db, schema } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { TouchDrafter } from './TouchDrafter';
import { TouchBodyWithHighlights } from '@/components/TouchBodyWithHighlights';
import { EvidencePill } from '@/components/EvidencePill';

export const dynamic = 'force-dynamic';

export default async function SequencePage({ params }: {
  params: Promise<{ id: string; sid: string }>;
}) {
  const { id: accountId, sid } = await params;
  const sequence = db.select().from(schema.sequences).where(eq(schema.sequences.id, sid)).get();
  if (!sequence) notFound();
  const touches = db.select().from(schema.touches)
    .where(eq(schema.touches.sequenceId, sid)).all()
    .sort((a, b) => a.position - b.position);
  const revisions = db.select().from(schema.touchRevisions).all()
    .filter((r) => touches.some((t) => t.currentRevisionId === r.id));
  const evidenceIds = Array.from(new Set(revisions.flatMap((r) => r.citedEvidenceIds)));
  const evidence = evidenceIds.length
    ? db.select().from(schema.evidence).where(inArray(schema.evidence.id, evidenceIds)).all()
    : [];
  const byId = new Map(evidence.map((e) => [e.id, e]));

  return (
    <main>
      <Link href={`/accounts/${accountId}/sequences`} className="text-sm text-neutral-500">← Sequences</Link>
      <h1 className="mt-2 text-2xl font-semibold">Sequence</h1>
      <ol className="mt-6 space-y-6">
        {touches.map((t) => {
          const rev = revisions.find((r) => r.id === t.currentRevisionId);
          return (
            <li key={t.id} className="rounded border border-neutral-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-500">#{t.position} · {t.channel}</span>
                <TouchDrafter touchId={t.id} hasDraft={!!rev} />
              </div>
              {rev ? (
                <div className="mt-3">
                  {rev.subject && <div className="font-medium">{rev.subject}</div>}
                  <TouchBodyWithHighlights body={rev.body} spans={rev.supportingSpans} />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {rev.citedEvidenceIds.map((eid) => {
                      const e = byId.get(eid);
                      return e ? <EvidencePill key={eid} id={eid} fact={e.extractedFact} sourceUrl={e.sourceUrl} /> : null;
                    })}
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-sm text-neutral-500 italic">No draft yet.</p>
              )}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
```

And `TouchDrafter.tsx` in the same directory:

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function TouchDrafter({ touchId, hasDraft }: { touchId: string; hasDraft: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);

  async function draft() {
    setBusy(true); setIssues([]);
    const res = await fetch('/api/touches/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touchId }),
    });
    setBusy(false);
    const json = await res.json();
    if (json.issues?.length) setIssues(json.issues);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      {issues.length > 0 && (
        <span className="text-xs text-red-600">{issues.length} validation issues</span>
      )}
      <button disabled={busy} onClick={draft}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs disabled:opacity-50">
        {busy ? 'Drafting…' : hasDraft ? 'Redraft' : 'Draft'}
      </button>
    </div>
  );
}
```

- [ ] **Step 11.7: Manual smoke + commit**

```bash
pnpm dev
```

On an account with verified evidence, create a sequence, click "Draft" on each touch. Verify body renders with highlights + evidence pills.

```bash
git add -A
git commit -m "Sequences + touches UI with draft endpoint and evidence pills"
```

---

## Task 12: Critic panel

**Files:**
- Create: `lib/critics/skeptical-buyer.ts`, `lib/critics/sales-coach.ts`, `lib/critics/writing-editor.ts`, `lib/critics/run-panel.ts`
- Create: `lib/claude/prompts/critics.ts`, `skills/critique-touch/SKILL.md`
- Create: `app/api/touches/critique/route.ts`
- Create: `components/CriticPanel.tsx`

- [ ] **Step 12.1: Write `lib/claude/prompts/critics.ts`**

```ts
export const SKEPTICAL_BUYER_PROMPT = `You are the recipient of a cold outbound message.
Your job: would you delete this in under 2 seconds? Why?

Flag:
- Generic compliments or vague value props
- Hidden, unclear, or over-asking CTAs
- Anything that smells like a template
- Self-introduction before the reader understands why the message is for them
- Fake personalization ("I saw your post about X" when no specific post is cited)

Return JSON only:
{
  "verdict": "pass|revise|reject",
  "findings": [
    { "issue": "<short>", "quote": "<exact sentence from body>",
      "suggested_rewrite": "<better sentence>", "principle_id": null }
  ]
}

"pass" = send it; "revise" = fixable with the suggestions; "reject" = start over.`;

export const WRITING_EDITOR_PROMPT = `You are a tight-prose editor.

Flag any of:
- AI-tell phrases: "I hope this finds you well", "I came across", "I noticed", "just wanted to reach out", "circle back", "touch base", "per my last email"
- Unnecessary adverbs, hedging, throat-clearing
- Sentences >25 words that could be split
- Passive voice where active is clearer

Same JSON shape as other critics.`;
```

- [ ] **Step 12.2: Write `skills/critique-touch/SKILL.md`**

```md
---
name: critique-touch
description: Score a single sales touch against a specific critic persona (Skeptical Buyer, Sales Coach, or Writing Editor). Returns structured findings with quoted violations and suggested rewrites.
---

# Critique touch

You will be told which critic persona you are. Stay strictly in that persona.

## Rules
- Quote violations verbatim from the draft body — do not paraphrase.
- Suggested rewrites must be ≤25 words and preserve the sender's voice.
- If the draft passes cleanly, return `{ "verdict": "pass", "findings": [] }`.
- Never invent facts. Never suggest a rewrite that adds information not present in the draft or the evidence pack.

## Output
JSON only, no prose, no code fences:

{
  "verdict": "pass|revise|reject",
  "findings": [
    { "issue": "...", "quote": "exact sentence from body",
      "suggested_rewrite": "...", "principle_id": "P3 or null" }
  ]
}
```

- [ ] **Step 12.3: Write `lib/critics/skeptical-buyer.ts`**

```ts
import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { SKEPTICAL_BUYER_PROMPT } from '../claude/prompts/critics';
import { CriticResult } from '../claude/types';
import fs from 'node:fs';
import path from 'node:path';

type SpawnFn = typeof realSpawn;

const skillPath = path.resolve(process.cwd(), 'skills/critique-touch/SKILL.md');

export async function critiqueSkepticalBuyer(
  body: string,
  subject: string | null,
  channel: 'email' | 'linkedin',
  spawn: SpawnFn = realSpawn,
) {
  const prompt = renderPrompt([
    { heading: 'Skill', body: fs.readFileSync(skillPath, 'utf8') },
    { heading: 'Persona', body: SKEPTICAL_BUYER_PROMPT },
    { heading: 'Draft', body: JSON.stringify({ channel, subject, body }, null, 2) },
  ]);
  return spawn({ prompt, schema: CriticResult, model: 'sonnet' });
}
```

- [ ] **Step 12.4: Write `lib/critics/sales-coach.ts`**

```ts
import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { loadPrinciples } from '../claude/prompts/draft-touch';
import { CriticResult } from '../claude/types';
import fs from 'node:fs';
import path from 'node:path';

type SpawnFn = typeof realSpawn;

const skillPath = path.resolve(process.cwd(), 'skills/critique-touch/SKILL.md');

const SALES_COACH_PROMPT = `You are the Sales Coach critic. For every principle in the Principles file,
check the draft against it. For each failing principle, include a finding with:
- principle_id (e.g. "P3")
- issue: short description of the violation
- quote: exact sentence from body that violates the principle
- suggested_rewrite: a rewrite that satisfies the principle

Ignore principles that are N/A for this touch.`;

export async function critiqueSalesCoach(
  body: string, subject: string | null, channel: 'email' | 'linkedin',
  spawn: SpawnFn = realSpawn,
) {
  const prompt = renderPrompt([
    { heading: 'Skill', body: fs.readFileSync(skillPath, 'utf8') },
    { heading: 'Persona', body: SALES_COACH_PROMPT },
    { heading: 'Principles', body: loadPrinciples() },
    { heading: 'Draft', body: JSON.stringify({ channel, subject, body }, null, 2) },
  ]);
  return spawn({ prompt, schema: CriticResult, model: 'sonnet' });
}
```

- [ ] **Step 12.5: Write `lib/critics/writing-editor.ts`**

```ts
import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import { WRITING_EDITOR_PROMPT } from '../claude/prompts/critics';
import { CriticResult } from '../claude/types';
import fs from 'node:fs';
import path from 'node:path';

type SpawnFn = typeof realSpawn;

const skillPath = path.resolve(process.cwd(), 'skills/critique-touch/SKILL.md');

export async function critiqueWritingEditor(
  body: string, subject: string | null, channel: 'email' | 'linkedin',
  spawn: SpawnFn = realSpawn,
) {
  const prompt = renderPrompt([
    { heading: 'Skill', body: fs.readFileSync(skillPath, 'utf8') },
    { heading: 'Persona', body: WRITING_EDITOR_PROMPT },
    { heading: 'Draft', body: JSON.stringify({ channel, subject, body }, null, 2) },
  ]);
  return spawn({ prompt, schema: CriticResult, model: 'haiku' });
}
```

- [ ] **Step 12.6: Write `lib/critics/run-panel.ts`**

```ts
import { critiqueSkepticalBuyer } from './skeptical-buyer';
import { critiqueSalesCoach } from './sales-coach';
import { critiqueWritingEditor } from './writing-editor';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '../id';

export async function runCriticPanel(touchRevisionId: string) {
  const rev = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.id, touchRevisionId)).get();
  if (!rev) throw new Error('revision not found');
  const touch = db.select().from(schema.touches)
    .where(eq(schema.touches.id, rev.touchId)).get();
  if (!touch) throw new Error('touch not found');

  const args = [rev.body, rev.subject, touch.channel as 'email' | 'linkedin'] as const;
  const [skep, coach, editor] = await Promise.all([
    critiqueSkepticalBuyer(...args),
    critiqueSalesCoach(...args),
    critiqueWritingEditor(...args),
  ]);

  const rows = [
    { name: 'skeptical_buyer' as const, result: skep },
    { name: 'sales_coach' as const, result: coach },
    { name: 'writing_editor' as const, result: editor },
  ];
  for (const { name, result } of rows) {
    db.insert(schema.critiques).values({
      id: newId('critique'),
      touchRevisionId,
      criticName: name,
      verdict: result.verdict,
      findingsJson: result.findings,
    }).run();
  }
  return rows.map(({ name, result }) => ({ criticName: name, ...result }));
}
```

- [ ] **Step 12.7: Write `app/api/touches/critique/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runCriticPanel } from '@/lib/critics/run-panel';

const Body = z.object({ touchRevisionId: z.string() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  try {
    const critiques = await runCriticPanel(parsed.data.touchRevisionId);
    return NextResponse.json({ critiques });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 12.8: Write `components/CriticPanel.tsx`**

```tsx
'use client';
import { useState } from 'react';

type Finding = { issue: string; quote: string; suggested_rewrite: string; principle_id: string | null };
type Critique = { criticName: string; verdict: 'pass' | 'revise' | 'reject'; findings: Finding[] };

export function CriticPanel({
  touchRevisionId,
  onAcceptRewrite,
}: {
  touchRevisionId: string;
  onAcceptRewrite: (oldText: string, newText: string) => Promise<void>;
}) {
  const [critiques, setCritiques] = useState<Critique[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const res = await fetch('/api/touches/critique', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touchRevisionId }),
    });
    const json = await res.json();
    setBusy(false);
    setCritiques(json.critiques);
  }

  if (!critiques) {
    return (
      <button onClick={run} disabled={busy}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs disabled:opacity-50">
        {busy ? 'Critiquing…' : 'Run critics'}
      </button>
    );
  }
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
      {critiques.map((c) => (
        <div key={c.criticName} className="rounded border border-neutral-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{c.criticName}</h3>
            <span className={`rounded px-2 py-0.5 text-xs ${
              c.verdict === 'pass' ? 'bg-emerald-100 text-emerald-800' :
              c.verdict === 'reject' ? 'bg-red-100 text-red-800' :
              'bg-amber-100 text-amber-800'
            }`}>{c.verdict}</span>
          </div>
          <ul className="mt-2 space-y-2">
            {c.findings.map((f, i) => (
              <li key={i} className="rounded bg-neutral-50 p-2 text-xs">
                <div className="font-medium">{f.issue}{f.principle_id ? ` (${f.principle_id})` : ''}</div>
                <blockquote className="mt-1 italic text-neutral-600">“{f.quote}”</blockquote>
                <div className="mt-1"><span className="text-neutral-400">→ </span>{f.suggested_rewrite}</div>
                <button
                  className="mt-2 rounded border border-neutral-300 bg-white px-2 py-0.5 text-[11px]"
                  onClick={() => onAcceptRewrite(f.quote, f.suggested_rewrite)}
                >Accept rewrite</button>
              </li>
            ))}
            {c.findings.length === 0 && (
              <li className="text-xs text-neutral-500">No findings.</li>
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 12.9: Manual smoke + commit**

Wire `<CriticPanel />` into `SequencePage` beneath each touch that has a draft. Test in browser: click "Run critics", verify three panels render with findings.

```bash
git add -A
git commit -m "Critic panel: 3 critics (skeptical buyer, sales coach, writing editor)"
```

---

## Task 13: Accept rewrites → new revision

**Files:**
- Create: `app/api/touches/revise/route.ts`
- Modify: `app/accounts/[id]/sequences/[sid]/page.tsx` (wire CriticPanel's onAcceptRewrite)

- [ ] **Step 13.1: Write `app/api/touches/revise/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '@/lib/id';

const Body = z.object({
  touchId: z.string(),
  oldText: z.string(),
  newText: z.string(),
  source: z.enum(['critic_rewrite', 'manual_edit']).default('critic_rewrite'),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const touch = db.select().from(schema.touches)
    .where(eq(schema.touches.id, parsed.data.touchId)).get();
  if (!touch?.currentRevisionId) {
    return NextResponse.json({ error: 'no current revision' }, { status: 400 });
  }
  const current = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.id, touch.currentRevisionId)).get();
  if (!current) return NextResponse.json({ error: 'revision missing' }, { status: 500 });

  const newBody = current.body.replace(parsed.data.oldText, parsed.data.newText);
  if (newBody === current.body) {
    return NextResponse.json({ error: 'oldText not found in body' }, { status: 400 });
  }

  const newRevisionId = newId('touchRevision');
  const existingRevisions = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.touchId, parsed.data.touchId)).all();

  db.insert(schema.touchRevisions).values({
    id: newRevisionId,
    touchId: parsed.data.touchId,
    revisionNumber: existingRevisions.length + 1,
    subject: current.subject,
    body: newBody,
    citedEvidenceIds: current.citedEvidenceIds,
    supportingSpans: current.supportingSpans,
    rationale: current.rationale,
    createdBy: parsed.data.source,
  }).run();
  db.update(schema.touches).set({ currentRevisionId: newRevisionId })
    .where(eq(schema.touches.id, parsed.data.touchId)).run();

  return NextResponse.json({ revisionId: newRevisionId });
}
```

- [ ] **Step 13.2: Wire accept-rewrite handler**

In `app/accounts/[id]/sequences/[sid]/page.tsx`, within the touches map, pass an `onAcceptRewrite` callback to `<CriticPanel />` — that callback POSTs to `/api/touches/revise`:

```tsx
'use client';
// In a wrapper client component (create SequenceTouchList.tsx if needed):
const onAcceptRewrite = async (oldText: string, newText: string) => {
  await fetch('/api/touches/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ touchId, oldText, newText, source: 'critic_rewrite' }),
  });
  router.refresh();
};
```

(The existing `SequencePage` is a server component; you'll need a small client wrapper that holds the touch loop and the `onAcceptRewrite` closure. Pull the touch list into `SequenceTouchList.tsx` as a client component.)

- [ ] **Step 13.3: Manual smoke + commit**

Run critics, click "Accept rewrite" on a finding. Verify: new revision is created (the body changes); prior critiques are still visible (you can query the DB or add a "Revision history" link). Evidence pills remain.

```bash
git add -A
git commit -m "Accept rewrites as new touch revisions (immutable history)"
```

---

## Task 14: Export (.eml + clipboard)

**Files:**
- Create: `lib/export/eml.ts`, `app/api/export/route.ts`
- Modify: `app/accounts/[id]/sequences/[sid]/page.tsx` (add Export button)
- Create: `tests/unit/eml.test.ts`

- [ ] **Step 14.1: Write `lib/export/eml.ts`**

```ts
export interface EmlInput {
  subject: string;
  body: string;
  to?: string;
  from?: string;
}

export function buildEml({ subject, body, to, from }: EmlInput): string {
  const lines = [
    `From: ${from ?? ''}`,
    `To: ${to ?? ''}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    body,
  ];
  return lines.join('\r\n');
}
```

- [ ] **Step 14.2: Write `tests/unit/eml.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildEml } from '../../lib/export/eml';

describe('buildEml', () => {
  it('builds a minimal eml with CRLF headers', () => {
    const eml = buildEml({ subject: 'Hi', body: 'Hey Jane\n\nThoughts?' });
    expect(eml).toMatch(/^From: /);
    expect(eml).toContain('Subject: Hi');
    expect(eml.split('\r\n\r\n')[1]).toBe('Hey Jane\n\nThoughts?');
  });
});
```

- [ ] **Step 14.3: Write `app/api/export/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { buildEml } from '@/lib/export/eml';
import { z } from 'zod';

const Body = z.object({ sequenceId: z.string() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const touches = db.select().from(schema.touches)
    .where(eq(schema.touches.sequenceId, parsed.data.sequenceId)).all()
    .sort((a, b) => a.position - b.position);

  const artifacts = touches.map((t) => {
    if (!t.currentRevisionId) return null;
    const rev = db.select().from(schema.touchRevisions)
      .where(eq(schema.touchRevisions.id, t.currentRevisionId)).get();
    if (!rev) return null;
    if (t.channel === 'email') {
      return {
        position: t.position, channel: 'email' as const,
        filename: `touch-${t.position}.eml`,
        content: buildEml({ subject: rev.subject ?? '(no subject)', body: rev.body }),
      };
    }
    return {
      position: t.position, channel: 'linkedin' as const,
      filename: `touch-${t.position}-linkedin.txt`,
      content: rev.body,
    };
  }).filter(Boolean);

  return NextResponse.json({ artifacts });
}
```

- [ ] **Step 14.4: Add export button + client-side download**

Create `app/accounts/[id]/sequences/[sid]/ExportButton.tsx`:

```tsx
'use client';
import { useState } from 'react';

export function ExportButton({ sequenceId }: { sequenceId: string }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sequenceId }),
    });
    const { artifacts } = await res.json();
    setBusy(false);
    for (const a of artifacts) {
      const blob = new Blob([a.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = a.filename;
      link.click();
      URL.revokeObjectURL(url);
    }
    if (artifacts[0]) {
      await navigator.clipboard.writeText(artifacts[0].content);
    }
  }
  return (
    <button onClick={go} disabled={busy}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
      {busy ? 'Exporting…' : 'Export sequence (.eml + copy touch 1)'}
    </button>
  );
}
```

Add `<ExportButton sequenceId={sid} />` to the sequence page header.

- [ ] **Step 14.5: Run tests + manual smoke + commit**

```bash
pnpm test
pnpm dev  # export a sequence, verify .eml files download and first touch is on clipboard
git add -A
git commit -m "Export sequence as .eml files + copy first touch to clipboard"
```

---

## Task 15: Skill docs + README + final polish

**Files:**
- Create: `skills/extract-evidence/SKILL.md`, `skills/audit-extraction/SKILL.md`
- Create: `README.md`
- Create: `data/icp.md` (stub)

- [ ] **Step 15.1: Write `skills/extract-evidence/SKILL.md`** — same content as `EXTRACT_EVIDENCE_PROMPT` from lib/claude/prompts/extract-evidence.ts, formatted as a skill.

- [ ] **Step 15.2: Write `skills/audit-extraction/SKILL.md`** — same content as `AUDIT_PROMPT`, formatted as a skill.

- [ ] **Step 15.3: Write `data/icp.md`**

```md
# ICP Brief

(Fill this in with your Ideal Customer Profile. This file is read by the drafter on every touch.)

## Who we sell to
- Company size, industry, geography:
- Job titles we engage with:
- Tech stack signals we look for:

## Why they buy
- Trigger events:
- Primary pain points:
- Outcomes we deliver (with specifics):

## Disqualifiers
- When NOT to engage:
```

- [ ] **Step 15.4: Write `README.md`**

```md
# Sales

Personal, local-first B2B sales tool. Research → Evidence → Draft → Critique → Export.

## Requirements
- macOS with `claude` CLI installed and logged into a Claude Max 20 account
- Node 22+, pnpm

## Setup
```
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000.

## Key files
- `data/principles.md` — sales principles rubric (edit as your tactical bar evolves)
- `data/icp.md` — ICP brief (fill in before your first draft)
- `skills/` — Claude Code-compatible skill files used by the CLI
- `docs/superpowers/specs/` — full design spec
- `docs/superpowers/plans/` — this implementation plan

## Scope
v1 MVP. See spec §10 for out-of-scope and §11 for v1.1 roadmap.
```

- [ ] **Step 15.5: Final type-check, test, build**

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected: all three clean.

- [ ] **Step 15.6: Final commit**

```bash
git add -A
git commit -m "Skill docs, ICP stub, README, final polish"
```

---

## Self-review of plan

**Spec coverage:**
- §4.1 Evidence layer → Tasks 2, 6, 7, 9
- §4.2 Drafting → Tasks 10, 11
- §4.3 Critic panel (1–3) → Task 12; Extraction Audit (Critic 4) → Task 7
- §4.4 Principles file → consumed in Tasks 10 and 12; file already exists in repo
- §5 Data model → Task 2 (all 9 tables)
- §6 Tech stack → Task 1
- §6.1 CLI mechanism → Task 4 (spawnClaude with concurrency queue)
- §6.2 ToS/personal-use → covered by deployment staying on localhost; no additional code
- §7.1–7.5 flows → Tasks 5, 6, 7, 8, 9, 11, 12, 13, 14
- §8 cost model → observational, no code
- §9 failure behavior → Task 4 (RateLimitError), Task 7 (audit queue), Task 10 (retry-once validator)
- §10 out of scope → honored (no Deep Research parser, no Perplexity MCP wiring, no GPT-5 critic, no call-prep briefs)
- §13 success criteria → measurable via running the tool; no code to add

**Deferred from v1 (matches spec §11):**
- Deep Research paste parser — revisit post-MVP
- Perplexity MCP wiring — revisit post-MVP
- Second-model skeptic critic (GPT-5) — v1.1 per spec
- Call-prep briefs — v1.5 (schema exists, generator deferred)

**Type consistency check:** spawn function signature `SpawnFn = typeof realSpawn` used consistently across extract/audit/draft/critics. `DraftTouch` and `ExtractionAuditResult` Zod types referenced in both prompts and validators. `EvidenceRow` in `validate.ts` maps to `schema.evidence` fields.

**Placeholder scan:** None found — every step has concrete code.
