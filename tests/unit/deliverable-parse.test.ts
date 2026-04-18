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
  it('invokes Claude with the provided markdown and returns parsed structure', async () => {
    const fakeParse = vi.fn().mockResolvedValue({
      name: 'Q2 Targets',
      intro_md: 'Context paragraph.',
      outro_md: 'Sources and methodology.',
      accounts: [
        {
          name: 'Acme Corp', domain: 'acme.com', location: 'US', rank: 1,
          trigger_summary: 'Funding round', deal_shape: 'Standard', routing: 'Elsa, PT', time_ask: '30 min',
          why_now_md: 'Acme just raised.',
          contacts: [{ full_name: 'Jane Doe', title: 'VP Data', role: 'primary', archetype: 'leader' }],
          touches: [
            { position: 1, channel: 'email', subject: 'Your recent funding', body: 'Hi Jane, congrats.' },
            { position: 2, channel: 'linkedin', subject: null, body: 'Connect request text.' },
          ],
        },
      ],
    });
    const result = await parseDeliverableMarkdown('# Q2 Targets\n\n...', fakeParse as any);
    expect(result.name).toBe('Q2 Targets');
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].touches).toHaveLength(2);
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
