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
    sourceType: 'website', snippet: 'Acme shipped a new product in Q2 2026.',
    extractedFact: 'Acme shipped a new product in Q2 2026.',
    capturedBy: 'manual', extractionStatus: 'verified',
  }).run();
  db.insert(s.sequences).values({ id: 'sq_1', accountId: 'acc_1' }).run();
  db.insert(s.touches).values({
    id: 'to_1', sequenceId: 'sq_1', position: 1, channel: 'email',
  }).run();
  db.insert(s.touchRevisions).values({
    id: 'tr_1', touchId: 'to_1', revisionNumber: 1,
    subject: 'Q2 product', body: 'Saw that Acme shipped a new product in Q2. Curious how rollout is going?',
    citedEvidenceIds: [], supportingSpans: [], createdBy: 'manual_edit',
  }).run();
  const { eq } = await import('drizzle-orm');
  db.update(s.touches).set({ currentRevisionId: 'tr_1' }).where(eq(s.touches.id, 'to_1')).run();
});

import { auditClaims } from '../../lib/drafter/claim-audit';

describe('auditClaims', () => {
  it('persists mapped spans as a new revision and returns unsupported claims', async () => {
    const fakeSpawn = vi.fn().mockResolvedValue({
      supporting_spans: [{
        evidence_id: 'ev_1',
        span: 'shipped a new product in Q2',
        claim: 'Saw that Acme shipped a new product in Q2.',
      }],
      unsupported_claims: [{
        sentence: 'Curious how rollout is going?',
        reason: 'Question, not a factual claim to audit. (Note: the test asserts flagging works, though ideally the skill would skip questions.)',
      }],
    });
    const out = await auditClaims('to_1', fakeSpawn as any);
    expect(out.supportingSpans).toHaveLength(1);
    expect(out.citedEvidenceIds).toEqual(['ev_1']);
    expect(out.unsupportedClaims).toHaveLength(1);
    expect(out.validationIssues).toHaveLength(0);

    const { db, schema: s } = await import('@/db');
    const revs = db.select().from(s.touchRevisions).all()
      .sort((a, b) => a.revisionNumber - b.revisionNumber);
    expect(revs).toHaveLength(2);
    expect(revs[1].revisionNumber).toBe(2);
    expect(revs[1].citedEvidenceIds).toEqual(['ev_1']);
    expect(revs[1].supportingSpans).toHaveLength(1);
    expect(revs[1].createdBy).toBe('manual_edit');
  });

  it('filters out spans that are not substrings, surfaces validation issues', async () => {
    const fakeSpawn = vi.fn().mockResolvedValue({
      supporting_spans: [{
        evidence_id: 'ev_1',
        span: 'WAS RECENTLY PROMOTED TO CTO',  // not in snippet
        claim: 'We heard you got promoted to CTO.',
      }],
      unsupported_claims: [],
    });
    const out = await auditClaims('to_1', fakeSpawn as any);
    expect(out.supportingSpans).toHaveLength(0);  // filtered out
    expect(out.citedEvidenceIds).toHaveLength(0);
    expect(out.validationIssues.length).toBeGreaterThan(0);
  });

  it('throws if the touch has no current revision', async () => {
    const { db, schema: s } = await import('@/db');
    db.insert(s.touches).values({
      id: 'to_empty', sequenceId: 'sq_1', position: 2, channel: 'email',
    }).run();
    const fakeSpawn = vi.fn();
    await expect(auditClaims('to_empty', fakeSpawn as any))
      .rejects.toThrow('no current revision');
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('throws a user-actionable error when no verified evidence exists for the account', async () => {
    const { db, schema: s } = await import('@/db');
    // Clear all evidence (the beforeEach seeded one verified row — remove it)
    db.delete(s.evidence).run();

    const fakeSpawn = vi.fn();
    await expect(auditClaims('to_1', fakeSpawn as any))
      .rejects.toThrow(/No verified evidence/);
    expect(fakeSpawn).not.toHaveBeenCalled();
  });
});
