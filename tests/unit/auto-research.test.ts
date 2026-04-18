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
  db.insert(s.accounts).values({ id: 'acc_1', name: 'Acme', domain: 'acme.com' }).run();
});

import { autoResearchAccount } from '../../lib/research/auto-research';

describe('autoResearchAccount', () => {
  it('writes evidence rows from LLM output as pending_audit with captured_by=claude_cli', async () => {
    const fakeSpawn = vi.fn().mockResolvedValue({
      evidence: [
        { source_url: 'https://acme.com', source_type: 'website',
          snippet: 'Acme ships widgets.', extracted_fact: 'Acme makes widgets.',
          confidence: 'high' },
        { source_url: 'https://news/acme', source_type: 'news',
          snippet: 'Acme raised $50M.', extracted_fact: 'Acme raised $50M in 2026.',
          confidence: 'medium' },
      ],
    });
    const ids = await autoResearchAccount('acc_1', fakeSpawn as any);
    expect(ids).toHaveLength(2);
    const { db, schema: s } = await import('@/db');
    const rows = db.select().from(s.evidence).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.extractionStatus === 'pending_audit')).toBe(true);
    expect(rows.every((r) => r.capturedBy === 'claude_cli')).toBe(true);
  });

  it('throws when account not found', async () => {
    const fakeSpawn = vi.fn();
    await expect(autoResearchAccount('acc_missing', fakeSpawn as any))
      .rejects.toThrow('account not found');
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('truncates snippet to 1500 chars', async () => {
    const longSnippet = 'x'.repeat(2000);
    const fakeSpawn = vi.fn().mockResolvedValue({
      evidence: [{
        source_url: 'https://x', source_type: 'website',
        snippet: longSnippet, extracted_fact: 'Fact.', confidence: 'high',
      }],
    });
    const ids = await autoResearchAccount('acc_1', fakeSpawn as any);
    expect(ids).toHaveLength(1);
    const { db, schema: s } = await import('@/db');
    const row = db.select().from(s.evidence).all()[0];
    expect(row.snippet.length).toBe(1500);
  });
});
