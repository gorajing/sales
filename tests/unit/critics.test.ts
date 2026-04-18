import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@/db', async () => {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(dirname, '../../db/migrations') });
  return { db, schema };
});

// Mock all three critic modules
vi.mock('../../lib/critics/skeptical-buyer', () => ({
  critiqueSkepticalBuyer: vi.fn().mockResolvedValue({
    verdict: 'pass', findings: [],
  }),
}));
vi.mock('../../lib/critics/sales-coach', () => ({
  critiqueSalesCoach: vi.fn().mockResolvedValue({
    verdict: 'revise',
    findings: [{ issue: 'P3 violation', quote: 'q', suggested_rewrite: 's', principle_id: 'P3' }],
  }),
}));
vi.mock('../../lib/critics/writing-editor', () => ({
  critiqueWritingEditor: vi.fn().mockResolvedValue({
    verdict: 'pass', findings: [],
  }),
}));

beforeEach(async () => {
  const { db, schema: s } = await import('@/db');
  db.delete(s.critiques).run();
  db.delete(s.touchRevisions).run();
  db.delete(s.touches).run();
  db.delete(s.sequences).run();
  db.delete(s.extractionAudits).run();
  db.delete(s.evidence).run();
  db.delete(s.callPrepBriefs).run();
  db.delete(s.contacts).run();
  db.delete(s.accounts).run();
  db.insert(s.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
  db.insert(s.sequences).values({ id: 'sq_1', accountId: 'acc_1' }).run();
  db.insert(s.touches).values({
    id: 'to_1', sequenceId: 'sq_1', position: 1, channel: 'email',
  }).run();
  db.insert(s.touchRevisions).values({
    id: 'tr_1', touchId: 'to_1', revisionNumber: 1,
    subject: 'x', body: 'y', createdBy: 'drafter',
    citedEvidenceIds: [], supportingSpans: [],
  }).run();
  db.update(s.touches).set({ currentRevisionId: 'tr_1' }).where(eq(s.touches.id, 'to_1')).run();
});

import { eq } from 'drizzle-orm';
import { runCriticPanel } from '../../lib/critics/run-panel';

describe('runCriticPanel', () => {
  it('runs all 3 critics and persists critique rows', async () => {
    const rows = await runCriticPanel('tr_1');
    expect(rows).toHaveLength(3);
    const names = rows.map((r) => r.criticName).sort();
    expect(names).toEqual(['sales_coach', 'skeptical_buyer', 'writing_editor']);

    const { db, schema: s } = await import('@/db');
    const persisted = db.select().from(s.critiques).all();
    expect(persisted).toHaveLength(3);
    const salesCoach = persisted.find((c) => c.criticName === 'sales_coach');
    expect(salesCoach?.verdict).toBe('revise');
    expect(Array.isArray(salesCoach?.findingsJson)).toBe(true);
  });
});
