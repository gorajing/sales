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
  db.delete(s.deliverableAccounts).run();
  db.delete(s.deliverables).run();
  db.delete(s.contacts).run();
  db.delete(s.accounts).run();
});

import { parseDeliverableMarkdown } from '../../lib/deliverable/parse';
import { importParsedDeliverable } from '../../lib/deliverable/import';

describe('parseDeliverableMarkdown', () => {
  it('calls structure pass then per-account passes and assembles correctly', async () => {
    const raw = `# Q2 Targets\n\nIntro text.\n\nTarget 1. Acme\n\nSome content.\n\nTarget 2. Beta\n\nMore.\n\nNotes on methodology\n\nEnd.`;

    const fakeSpawn = vi.fn().mockImplementation(async ({ prompt, schema }) => {
      if (prompt.includes('parse-deliverable-structure')) {
        return {
          name: 'Q2 Targets',
          account_headers: [
            { rank: 1, heading: 'Target 1. Acme' },
            { rank: 2, heading: 'Target 2. Beta' },
          ],
          outro_start_heading: 'Notes on methodology',
        };
      }
      if (prompt.includes("rank is 1")) {
        return {
          name: 'Acme', domain: null, location: null, rank: 1,
          trigger_summary: null, deal_shape: null, routing: null, time_ask: null,
          why_now_md: null, contacts: [],
          touches: [{ position: 1, channel: 'email', subject: 'Hi', body: 'Body' }],
        };
      }
      if (prompt.includes("rank is 2")) {
        return {
          name: 'Beta', domain: null, location: null, rank: 2,
          trigger_summary: null, deal_shape: null, routing: null, time_ask: null,
          why_now_md: null, contacts: [],
          touches: [{ position: 1, channel: 'email', subject: 'Hey', body: 'Text' }],
        };
      }
      throw new Error(`Unexpected prompt: ${prompt.slice(0, 80)}`);
    });

    const result = await parseDeliverableMarkdown(raw, fakeSpawn as any);

    expect(result.name).toBe('Q2 Targets');
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0].name).toBe('Acme');
    expect(result.accounts[1].name).toBe('Beta');
    // Intro should be the text before "Target 1."
    expect(result.intro_md).toContain('Intro text');
    // Outro should start at "Notes on methodology"
    expect(result.outro_md).toMatch(/^Notes on methodology/);

    // Structure call + 2 account calls = 3 total
    expect(fakeSpawn).toHaveBeenCalledTimes(3);
  });

  it('throws if account header not found verbatim', async () => {
    const raw = `# Doc\n\nTarget 1. Acme\n\nBody.`;
    const fakeSpawn = vi.fn().mockImplementation(async ({ prompt }) => {
      if (prompt.includes('parse-deliverable-structure')) {
        return {
          name: 'Doc',
          account_headers: [{ rank: 1, heading: 'Target 9. NotInDoc' }],
          outro_start_heading: null,
        };
      }
      throw new Error('should not reach');
    });
    await expect(parseDeliverableMarkdown(raw, fakeSpawn as any))
      .rejects.toThrow(/not found verbatim/);
  });

  it('throws if zero account headers returned', async () => {
    const raw = `# Doc\n\nNo accounts here.`;
    const fakeSpawn = vi.fn().mockImplementation(async ({ prompt, schema }) => {
      if (prompt.includes('parse-deliverable-structure')) {
        // The DI'd fake bypasses Zod; the length === 0 check in parseDeliverableMarkdown fires.
        return {
          name: 'Doc', account_headers: [], outro_start_heading: null,
        };
      }
      throw new Error('should not reach');
    });
    await expect(parseDeliverableMarkdown(raw, fakeSpawn as any))
      .rejects.toThrow(/no account headers/);
  });
});

describe('importParsedDeliverable', () => {
  it('creates deliverable + accounts + contacts + sequences + touches + revisions', async () => {
    const parsed = {
      name: 'Q2 Targets',
      intro_md: null, outro_md: null,
      accounts: [
        {
          name: 'Acme', domain: 'acme.com', location: null, rank: 1,
          trigger_summary: null, deal_shape: null, routing: null, time_ask: null,
          why_now_md: null,
          contacts: [{ full_name: 'Jane', title: null, role: 'primary' as const, archetype: 'unknown' as const }],
          touches: [
            { position: 1, channel: 'email' as const, subject: 'Hi', body: 'Body 1' },
            { position: 2, channel: 'linkedin' as const, subject: null, body: 'LinkedIn text' },
          ],
        },
      ],
    };

    const { deliverableId, accountIds } = await importParsedDeliverable(parsed, '# raw md');
    expect(deliverableId).toMatch(/^del_/);
    expect(accountIds).toHaveLength(1);

    const { db, schema: s } = await import('@/db');
    expect(db.select().from(s.deliverables).all()).toHaveLength(1);
    expect(db.select().from(s.accounts).all()).toHaveLength(1);
    expect(db.select().from(s.contacts).all()).toHaveLength(1);
    expect(db.select().from(s.sequences).all()).toHaveLength(1);
    expect(db.select().from(s.touches).all()).toHaveLength(2);
    expect(db.select().from(s.touchRevisions).all()).toHaveLength(2);

    const revs = db.select().from(s.touchRevisions).all();
    expect(revs.every((r) => r.createdBy === 'manual_edit')).toBe(true);
    expect(revs.every((r) => r.revisionNumber === 1)).toBe(true);

    const touchesInDb = db.select().from(s.touches).all();
    expect(touchesInDb.every((t) => t.currentRevisionId !== null)).toBe(true);

    const daRows = db.select().from(s.deliverableAccounts).all();
    expect(daRows).toHaveLength(1);
    expect(daRows[0].rank).toBe(1);
    expect(daRows[0].sequenceId).not.toBeNull();
  });
});
