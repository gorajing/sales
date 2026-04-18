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
  db.insert(s.sequences).values({ id: 'sq_1', accountId: 'acc_1' }).run();
  db.insert(s.touches).values({
    id: 'to_1', sequenceId: 'sq_1', position: 1, channel: 'email',
  }).run();
});

import { POST } from '../../app/api/touches/import/route';

describe('touches/import API', () => {
  it('creates a revision 1 with body and subject, updates currentRevisionId', async () => {
    const req = new Request('http://x/api/touches/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touchId: 'to_1',
        subject: 'Hello',
        body: 'Hey Jane — quick question about your Q2 launch.',
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const { revisionId } = await res.json();

    const { db, schema: s } = await import('@/db');
    const rev = db.select().from(s.touchRevisions).all()[0];
    expect(rev.id).toBe(revisionId);
    expect(rev.revisionNumber).toBe(1);
    expect(rev.createdBy).toBe('manual_edit');
    expect(rev.body).toBe('Hey Jane — quick question about your Q2 launch.');
    expect(rev.subject).toBe('Hello');

    const { eq } = await import('drizzle-orm');
    const touch = db.select().from(s.touches).where(eq(s.touches.id, 'to_1')).get();
    expect(touch?.currentRevisionId).toBe(revisionId);
  });

  it('rejects empty body', async () => {
    const req = new Request('http://x/api/touches/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touchId: 'to_1', body: '' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent touchId', async () => {
    const req = new Request('http://x/api/touches/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touchId: 'to_missing', body: 'some text' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });
});
