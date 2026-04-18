import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schema = await import('../../db/schema');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(dirname, '../../db/migrations') });
  return { db, schema };
});

beforeEach(async () => {
  const { db, schema: s } = await import('@/db');
  // child → parent order
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

  it('writes rows with pending_audit extraction status', async () => {
    const fakeSpawn = vi.fn().mockResolvedValue({
      evidence: [{
        source_url: 'https://x', source_type: 'website',
        snippet: 'a small quote', extracted_fact: 'Fact.', confidence: 'high',
      }],
    });
    const ids = await extractFromPaste({
      accountId: 'acc_1', sourceUrl: 'https://x',
      rawText: 'a small quote in longer text', capturedBy: 'manual',
    }, fakeSpawn as any);
    expect(ids).toHaveLength(1);

    const { db, schema: s } = await import('@/db');
    const rows = db.select().from(s.evidence).all();
    expect(rows[0].extractionStatus).toBe('pending_audit');
    expect(rows[0].capturedBy).toBe('manual');
  });

  it('is case-insensitive in the substring check', async () => {
    const fakeSpawn = vi.fn().mockResolvedValue({
      evidence: [{
        source_url: 'https://x', source_type: 'website',
        snippet: 'ACME HIRED', extracted_fact: 'Fact.', confidence: 'high',
      }],
    });
    const ids = await extractFromPaste({
      accountId: 'acc_1', sourceUrl: 'https://x',
      rawText: 'today acme hired a vp', capturedBy: 'manual',
    }, fakeSpawn as any);
    expect(ids).toHaveLength(1);
  });
});
