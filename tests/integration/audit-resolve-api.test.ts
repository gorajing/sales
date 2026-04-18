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
    capturedBy: 'manual', extractionStatus: 'disputed',
  }).run();
  db.insert(s.extractionAudits).values({
    id: 'ea_1', evidenceId: 'ev_1', verdict: 'disputed',
    reason: 'Snippet says "is hiring" not "hired".',
    suggestedCorrection: 'Acme is hiring a VP of Data.',
  }).run();
});

import { POST } from '../../app/api/evidence/audit/route';

describe('audit resolve actions', () => {
  it('accept_correction updates fact, flips to verified, marks audit as user_accepted', async () => {
    const req = new Request('http://x/api/evidence/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidenceId: 'ev_1', action: 'accept_correction' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const { db, schema: s } = await import('@/db');
    const ev = db.select().from(s.evidence).all()[0];
    expect(ev.extractedFact).toBe('Acme is hiring a VP of Data.');
    expect(ev.extractionStatus).toBe('verified');
    const audit = db.select().from(s.extractionAudits).all()[0];
    expect(audit.resolvedBy).toBe('user_accepted');
  });

  it('override_verified flips to verified, marks audit as user_overrode', async () => {
    const req = new Request('http://x/api/evidence/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidenceId: 'ev_1', action: 'override_verified' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const { db, schema: s } = await import('@/db');
    const ev = db.select().from(s.evidence).all()[0];
    expect(ev.extractionStatus).toBe('verified');
    expect(ev.extractedFact).toBe('Acme hired a VP of Data.');  // unchanged
    const audit = db.select().from(s.extractionAudits).all()[0];
    expect(audit.resolvedBy).toBe('user_overrode');
  });

  it('remove deletes evidence and its audits', async () => {
    const req = new Request('http://x/api/evidence/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidenceId: 'ev_1', action: 'remove' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const { db, schema: s } = await import('@/db');
    expect(db.select().from(s.evidence).all()).toHaveLength(0);
    expect(db.select().from(s.extractionAudits).all()).toHaveLength(0);
  });
});
