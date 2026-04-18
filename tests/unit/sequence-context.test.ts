import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';

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
  // truncate all
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
  // Seed an account + sequence with 4 touches (email, linkedin, email, linkedin)
  db.insert(s.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
  db.insert(s.sequences).values({ id: 'sq_1', accountId: 'acc_1' }).run();
  const touches = [
    { id: 'to_1', position: 1, channel: 'email' as const, body: 'Touch 1 email body' },
    { id: 'to_2', position: 2, channel: 'linkedin' as const, body: 'Connect request body' },
    { id: 'to_3', position: 3, channel: 'email' as const, body: 'Touch 3 email body' },
    { id: 'to_4', position: 4, channel: 'linkedin' as const, body: 'DM body' },
  ];
  for (const t of touches) {
    db.insert(s.touches).values({
      id: t.id, sequenceId: 'sq_1', position: t.position, channel: t.channel,
    }).run();
    const rid = `tr_${t.id}`;
    db.insert(s.touchRevisions).values({
      id: rid, touchId: t.id, revisionNumber: 1,
      subject: t.channel === 'email' ? `subject ${t.position}` : null,
      body: t.body, citedEvidenceIds: [], supportingSpans: [],
      createdBy: 'manual_edit',
    }).run();
    db.update(s.touches).set({ currentRevisionId: rid })
      .where(eq(s.touches.id, t.id)).run();
  }
});

import { buildSequenceContext, renderSequenceContext } from '../../lib/critics/sequence-context';

describe('buildSequenceContext', () => {
  it('labels first LinkedIn touch as connect and second as dm', async () => {
    const ctxConnect = await buildSequenceContext('tr_to_2');
    expect(ctxConnect.currentLinkedinKind).toBe('connect');

    const ctxDm = await buildSequenceContext('tr_to_4');
    expect(ctxDm.currentLinkedinKind).toBe('dm');
  });

  it('includes prior touches in order', async () => {
    const ctx = await buildSequenceContext('tr_to_4');
    expect(ctx.priorTouches).toHaveLength(3);
    expect(ctx.priorTouches[0].position).toBe(1);
    expect(ctx.priorTouches[1].position).toBe(2);
    expect(ctx.priorTouches[2].position).toBe(3);
    expect(ctx.priorTouches[1].linkedinKind).toBe('connect');
  });

  it('returns empty priorTouches for the first touch', async () => {
    const ctx = await buildSequenceContext('tr_to_1');
    expect(ctx.priorTouches).toHaveLength(0);
    expect(ctx.currentPosition).toBe(1);
    expect(ctx.totalTouches).toBe(4);
  });

  it('rendered context contains sequence-rule guidance', async () => {
    const ctx = await buildSequenceContext('tr_to_4');
    const rendered = renderSequenceContext(ctx);
    expect(rendered).toContain('post-connection LinkedIn DM');
    expect(rendered).toContain('Current touch: 4 of 4');
  });

  it('rendered first-touch context omits prior-touches section', async () => {
    const ctx = await buildSequenceContext('tr_to_1');
    const rendered = renderSequenceContext(ctx);
    expect(rendered).not.toContain('Prior touches');
  });
});
