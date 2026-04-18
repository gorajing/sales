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
  db.insert(s.evidence).values({
    id: 'ev_1', accountId: 'acc_1', sourceUrl: 'https://x',
    sourceType: 'website', snippet: 'Acme is hiring a VP of Data.',
    extractedFact: 'Acme hired a VP of Data.',
    capturedBy: 'manual', extractionStatus: 'pending_audit',
  }).run();
});

import { auditOne } from '../../lib/evidence/audit';

describe('auditOne', () => {
  it('flips evidence to disputed when the fact overstates', async () => {
    const fakeSpawn = vi.fn().mockResolvedValue({
      evidence_id: 'ev_1',
      verdict: 'disputed',
      reason: 'Snippet says "is hiring" not "hired".',
      suggested_correction: 'Acme is hiring a VP of Data.',
    });
    const verdict = await auditOne('ev_1', fakeSpawn as any);
    expect(verdict).toBe('disputed');
    const { db, schema: s } = await import('@/db');
    const row = db.select().from(s.evidence).all()[0];
    expect(row.extractionStatus).toBe('disputed');
    const audits = db.select().from(s.extractionAudits).all();
    expect(audits).toHaveLength(1);
    expect(audits[0].suggestedCorrection).toBe('Acme is hiring a VP of Data.');
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
    const { db, schema: s } = await import('@/db');
    const row = db.select().from(s.evidence).all()[0];
    expect(row.extractionStatus).toBe('verified');
  });
});
