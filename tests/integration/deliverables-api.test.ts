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

// Mock the Claude parse to avoid spawning real claude
vi.mock('../../lib/deliverable/parse', () => ({
  parseDeliverableMarkdown: vi.fn().mockResolvedValue({
    name: 'Q2 Targets',
    intro_md: 'Intro.',
    outro_md: 'Outro.',
    accounts: [
      {
        name: 'Acme', domain: 'acme.com', location: 'US', rank: 1,
        trigger_summary: 'Funding', deal_shape: 'Standard', routing: 'Elsa, PT', time_ask: '30 min',
        why_now_md: 'They raised.',
        contacts: [{ full_name: 'Jane', title: 'VP', role: 'primary', archetype: 'leader' }],
        touches: [
          { position: 1, channel: 'email', subject: 'Hi', body: 'Body' },
          { position: 2, channel: 'linkedin', subject: null, body: 'Connect' },
        ],
      },
    ],
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
  db.delete(s.deliverableAccounts).run();
  db.delete(s.deliverables).run();
  db.delete(s.contacts).run();
  db.delete(s.accounts).run();
});

import { POST } from '../../app/api/deliverables/route';

describe('deliverables API', () => {
  it('imports a pasted deliverable via mocked Claude parse', async () => {
    const req = new Request('http://x/api/deliverables', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawMarkdown: '# Q2 Targets\n\n...'.padEnd(60, '.') }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.deliverableId).toMatch(/^del_/);
    expect(body.accountIds).toHaveLength(1);

    const { db, schema: s } = await import('@/db');
    expect(db.select().from(s.deliverables).all()).toHaveLength(1);
    expect(db.select().from(s.touches).all()).toHaveLength(2);
  });

  it('rejects too-short markdown', async () => {
    const req = new Request('http://x/api/deliverables', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawMarkdown: 'short' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
