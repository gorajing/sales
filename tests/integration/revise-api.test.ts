import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

vi.mock('@/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schema = await import('../../db/schema');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const _dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(_dirname, '../../db/migrations') });
  return { db, schema };
});

import { eq } from 'drizzle-orm';
import { POST } from '../../app/api/touches/revise/route';

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
    subject: 'Hello', body: 'Original body with some text.',
    citedEvidenceIds: [], supportingSpans: [], createdBy: 'drafter',
  }).run();
  db.update(s.touches).set({ currentRevisionId: 'tr_1' })
    .where(eq(s.touches.id, 'to_1')).run();
});

describe('touches/revise API', () => {
  it('creates a new revision and advances currentRevisionId', async () => {
    const req = new Request('http://x/api/touches/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touchId: 'to_1',
        oldText: 'some text',
        newText: 'different text',
        source: 'critic_rewrite',
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const { revisionId } = await res.json();

    const { db, schema: s } = await import('@/db');
    const revs = db.select().from(s.touchRevisions).all()
      .sort((a, b) => a.revisionNumber - b.revisionNumber);
    expect(revs).toHaveLength(2);
    expect(revs[0].id).toBe('tr_1');
    expect(revs[0].body).toBe('Original body with some text.');  // original unchanged
    expect(revs[1].id).toBe(revisionId);
    expect(revs[1].revisionNumber).toBe(2);
    expect(revs[1].body).toBe('Original body with different text.');
    expect(revs[1].createdBy).toBe('critic_rewrite');

    const touch = db.select().from(s.touches).where(eq(s.touches.id, 'to_1')).get();
    expect(touch?.currentRevisionId).toBe(revisionId);
  });

  it('returns 400 when oldText is not in body', async () => {
    const req = new Request('http://x/api/touches/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touchId: 'to_1',
        oldText: 'NOT IN BODY',
        newText: 'whatever',
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('preserves cited_evidence_ids and supporting_spans across revisions', async () => {
    const { db, schema: s } = await import('@/db');
    // Update tr_1 to have some cited evidence
    db.update(s.touchRevisions).set({
      citedEvidenceIds: ['ev_a'],
      supportingSpans: [{ evidence_id: 'ev_a', span: 'some text', claim: 'Original body with some text.' }],
    }).where(eq(s.touchRevisions.id, 'tr_1')).run();

    const req = new Request('http://x/api/touches/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touchId: 'to_1',
        oldText: 'some text',
        newText: 'revised text',
      }),
    });
    await POST(req);
    const revs = db.select().from(s.touchRevisions).all()
      .sort((a, b) => a.revisionNumber - b.revisionNumber);
    expect(revs[1].citedEvidenceIds).toEqual(['ev_a']);
    expect(revs[1].supportingSpans).toHaveLength(1);
  });
});
