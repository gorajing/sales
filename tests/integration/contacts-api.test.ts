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
});

import { POST, PATCH } from '../../app/api/contacts/route';

describe('contacts API', () => {
  it('creates a contact with archetype defaulting to unknown', async () => {
    const req = new Request('http://x/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc_1', fullName: 'Jane Doe' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const { db, schema: s } = await import('@/db');
    const row = db.select().from(s.contacts).all()[0];
    expect(row.fullName).toBe('Jane Doe');
    expect(row.archetype).toBe('unknown');
  });

  it('patches archetype', async () => {
    const { db, schema: s } = await import('@/db');
    db.insert(s.contacts).values({
      id: 'ct_1', accountId: 'acc_1', fullName: 'Jane',
    }).run();
    const req = new Request('http://x/api/contacts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ct_1', archetype: 'leader' }),
    });
    await PATCH(req);
    const updated = db.select().from(s.contacts).all()[0];
    expect(updated.archetype).toBe('leader');
  });

  it('rejects invalid archetype', async () => {
    const req = new Request('http://x/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc_1', fullName: 'Jane', archetype: 'bogus' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
