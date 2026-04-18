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
  // Seed: acc_1 with one verified evidence row, one sequence, one touch
  db.insert(s.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
  db.insert(s.evidence).values({
    id: 'ev_1', accountId: 'acc_1', sourceUrl: 'https://x',
    sourceType: 'website', snippet: 'Acme is hiring a VP of Data.',
    extractedFact: 'Acme is hiring a VP of Data.',
    capturedBy: 'manual', extractionStatus: 'verified',
  }).run();
  db.insert(s.sequences).values({ id: 'sq_1', accountId: 'acc_1' }).run();
  db.insert(s.touches).values({
    id: 'to_1', sequenceId: 'sq_1', position: 1, channel: 'email',
  }).run();
});

import { draftTouch } from '../../lib/drafter/draft';

describe('draftTouch', () => {
  it('persists a valid draft as revision 1', async () => {
    const fakeSpawn = vi.fn().mockResolvedValue({
      subject: 'Saw your data role',
      body: 'Saw you are hiring a VP of Data. Curious what prompted it.',
      channel: 'email',
      cited_evidence_ids: ['ev_1'],
      supporting_spans: [{ evidence_id: 'ev_1', span: 'hiring a VP of Data', claim: 'Saw you are hiring a VP of Data.' }],
      rationale: 'Lead with specific observation from ev_1.',
    });
    const { revisionId, issues } = await draftTouch({ touchId: 'to_1' }, fakeSpawn as any);
    expect(issues).toHaveLength(0);
    const { db, schema: s } = await import('@/db');
    const rev = db.select().from(s.touchRevisions).all()[0];
    expect(rev.id).toBe(revisionId);
    expect(rev.revisionNumber).toBe(1);
    expect(rev.createdBy).toBe('drafter');
    const touch = db.select().from(s.touches).all()[0];
    expect(touch.currentRevisionId).toBe(revisionId);
  });

  it('retries once with correction when spans invalid, returns issues if still invalid', async () => {
    const fakeSpawn = vi.fn()
      .mockResolvedValueOnce({
        subject: 'x', body: 'y', channel: 'email',
        cited_evidence_ids: ['ev_1'],
        supporting_spans: [{ evidence_id: 'ev_1', span: 'NOT IN SNIPPET', claim: 'y' }],
        rationale: 'bad',
      })
      .mockResolvedValueOnce({
        subject: 'x', body: 'y', channel: 'email',
        cited_evidence_ids: ['ev_1'],
        supporting_spans: [{ evidence_id: 'ev_1', span: 'STILL NOT IN SNIPPET', claim: 'y' }],
        rationale: 'bad again',
      });
    const { issues } = await draftTouch({ touchId: 'to_1' }, fakeSpawn as any);
    expect(fakeSpawn).toHaveBeenCalledTimes(2);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('retry succeeds when second attempt has valid spans', async () => {
    const fakeSpawn = vi.fn()
      .mockResolvedValueOnce({
        subject: 'x', body: 'y', channel: 'email',
        cited_evidence_ids: ['ev_1'],
        supporting_spans: [{ evidence_id: 'ev_1', span: 'NOT IN SNIPPET', claim: 'y' }],
        rationale: 'bad',
      })
      .mockResolvedValueOnce({
        subject: 'x', body: 'y', channel: 'email',
        cited_evidence_ids: ['ev_1'],
        supporting_spans: [{ evidence_id: 'ev_1', span: 'hiring a VP of Data', claim: 'y' }],
        rationale: 'corrected',
      });
    const { revisionId, issues } = await draftTouch({ touchId: 'to_1' }, fakeSpawn as any);
    expect(fakeSpawn).toHaveBeenCalledTimes(2);
    expect(issues).toHaveLength(0);  // second attempt passes validation
    const { db, schema: s } = await import('@/db');
    const rev = db.select().from(s.touchRevisions).all().find((r) => r.id === revisionId);
    expect(rev?.rationale).toBe('corrected');
  });

  it('increments revisionNumber when drafted twice on the same touch', async () => {
    const ok = {
      subject: 'x', body: 'y', channel: 'email' as const,
      cited_evidence_ids: ['ev_1'],
      supporting_spans: [{ evidence_id: 'ev_1', span: 'hiring a VP of Data', claim: 'y' }],
      rationale: 'r',
    };
    const fakeSpawn = vi.fn().mockResolvedValue(ok);
    await draftTouch({ touchId: 'to_1' }, fakeSpawn as any);
    await draftTouch({ touchId: 'to_1' }, fakeSpawn as any);
    const { db, schema: s } = await import('@/db');
    const revs = db.select().from(s.touchRevisions).all();
    expect(revs).toHaveLength(2);
    const nums = revs.map((r) => r.revisionNumber).sort();
    expect(nums).toEqual([1, 2]);
  });

  it('only uses verified evidence', async () => {
    const { db, schema: s } = await import('@/db');
    db.insert(s.evidence).values({
      id: 'ev_pending', accountId: 'acc_1', sourceUrl: 'https://p',
      sourceType: 'website', snippet: 'pending thing', extractedFact: 'fact.',
      capturedBy: 'manual', extractionStatus: 'pending_audit',
    }).run();
    const fakeSpawn = vi.fn().mockImplementation(async ({ prompt }: { prompt: string }) => {
      // Assert the pending row is NOT in the prompt
      expect(prompt).not.toContain('ev_pending');
      expect(prompt).not.toContain('pending thing');
      return {
        subject: 's', body: 'b', channel: 'email',
        cited_evidence_ids: [], supporting_spans: [], rationale: 'r',
      };
    });
    await draftTouch({ touchId: 'to_1' }, fakeSpawn as any);
  });
});
