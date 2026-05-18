import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as schemaMod from '../../db/schema';

vi.mock('@/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schemaModInner = await import('../../db/schema');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const _dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: schemaModInner });
  migrate(db, { migrationsFolder: path.resolve(_dirname, '../../db/migrations') });
  return { db, schema: schemaModInner };
});

import { db } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '../../lib/id';
import {
  computePrincipleOutcomes,
  parsePrincipleIds,
  renderOutcomesMarkdown,
  MIN_SAMPLE,
} from '../../lib/engagement/attribute';

const PRINCIPLES = ['P1', 'P2', 'P3', 'P4', 'P5'];

beforeEach(() => {
  db.delete(schemaMod.engagementEvents).run();
  db.delete(schemaMod.critiques).run();
  db.delete(schemaMod.touchRevisions).run();
  db.delete(schemaMod.touches).run();
  db.delete(schemaMod.sequences).run();
  db.delete(schemaMod.leadScores).run();
  db.delete(schemaMod.evidence).run();
  db.delete(schemaMod.contacts).run();
  db.delete(schemaMod.accounts).run();
});

/**
 * Make a touch whose CURRENT revision has a single latest sales_coach
 * critique that FAILED `principleFailed` (everything else passed by
 * the "absence of failure → pass" inference) and optionally received
 * a `replied` outcome event.
 */
function makeTouch(
  principleFailed: string[],
  replied: boolean,
  critiqueAt = '2020-01-01T00:00:00.000Z',
): string {
  const accountId = newId('account');
  db.insert(schemaMod.accounts).values({ id: accountId, name: 'X' }).run();
  const sequenceId = newId('sequence');
  db.insert(schemaMod.sequences).values({ id: sequenceId, accountId }).run();
  const touchId = newId('touch');
  db.insert(schemaMod.touches).values({
    id: touchId, sequenceId, position: 1, channel: 'email',
  }).run();
  const revId = newId('touchRevision');
  db.insert(schemaMod.touchRevisions).values({
    id: revId, touchId, revisionNumber: 1, body: 'x', createdBy: 'drafter',
  }).run();
  db.update(schemaMod.touches).set({ currentRevisionId: revId })
    .where(eq(schemaMod.touches.id, touchId)).run();
  db.insert(schemaMod.critiques).values({
    id: newId('critique'), touchRevisionId: revId,
    criticName: 'sales_coach',
    verdict: principleFailed.length > 0 ? 'revise' : 'pass',
    findingsJson: principleFailed.map((pid) => ({
      issue: 'x', quote: '', suggested_rewrite: null, principle_id: pid,
    })),
    createdAt: critiqueAt,
  }).run();
  if (replied) {
    db.insert(schemaMod.engagementEvents).values({
      id: newId('engagementEvent'), touchId, contactId: null,
      eventType: 'replied', occurredAt: '2026-05-06T12:00:00.000Z',
    }).run();
  }
  return touchId;
}

// --------------------------------------------------------------------------
// parsePrincipleIds
// --------------------------------------------------------------------------

describe('parsePrincipleIds', () => {
  it('parses `## P<n> — heading` ids (the data/principles.md format)', () => {
    const ids = parsePrincipleIds('# Sales Principles\n\n## P1 — A\n## P2 — B\n## P12 — Z\ntext\n');
    expect(ids).toEqual(['P1', 'P2', 'P12']);
  });

  it('ignores non-principle headings and prose mentioning P-words', () => {
    const ids = parsePrincipleIds('## Meta\nThe P1 principle is great.\n## P3 — C\n');
    expect(ids).toEqual(['P3']);
  });
});

// --------------------------------------------------------------------------
// computePrincipleOutcomes — core attribution
// --------------------------------------------------------------------------

describe('computePrincipleOutcomes — attribution trace', () => {
  it('counts passed/failed × replied/silent per principle from the LATEST sales_coach critique on the current revision', async () => {
    makeTouch(['P5'], true);   // failed P5, replied
    makeTouch([], false);      // passed all, silent
    makeTouch(['P5'], false);  // failed P5, silent
    const outcomes = await computePrincipleOutcomes(PRINCIPLES);
    const p5 = outcomes.find((o) => o.principle_id === 'P5')!;
    expect(p5.failed_total).toBe(2);          // touches 1 & 3
    expect(p5.failed_replied).toBe(1);        // touch 1
    expect(p5.passed_total).toBe(1);          // touch 2
    const p1 = outcomes.find((o) => o.principle_id === 'P1')!;
    expect(p1.passed_total).toBe(3);          // P1 never failed
  });

  it('uses only the LATEST sales_coach critique per current revision (re-critique supersedes)', async () => {
    const touchId = makeTouch(['P5'], true, '2020-01-01T00:00:00.000Z');
    const rev = db.select().from(schemaMod.touchRevisions)
      .where(eq(schemaMod.touchRevisions.touchId, touchId)).get()!;
    db.insert(schemaMod.critiques).values({
      id: newId('critique'), touchRevisionId: rev.id,
      criticName: 'sales_coach', verdict: 'pass', findingsJson: [],
      createdAt: '2020-06-01T00:00:00.000Z',  // later → wins
    }).run();
    const outcomes = await computePrincipleOutcomes(PRINCIPLES);
    const p5 = outcomes.find((o) => o.principle_id === 'P5')!;
    expect(p5.failed_total).toBe(0);  // latest critique passed P5
    expect(p5.passed_total).toBe(1);
  });

  it('writes NOTHING — no lead_scores, no evidence, no principles mutation (advisory only, never scoring)', async () => {
    makeTouch(['P5'], true);
    await computePrincipleOutcomes(PRINCIPLES);
    // The feedback loop must never touch scoring state.
    expect(db.select().from(schemaMod.leadScores).all()).toHaveLength(0);
    expect(db.select().from(schemaMod.evidence).all()).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Sample-size guardrail — the epistemic-risk requirement
// --------------------------------------------------------------------------

describe('computePrincipleOutcomes — sample-size guardrail', () => {
  it('MIN_SAMPLE is a small conservative floor (not n=1), exported so it is tunable', () => {
    expect(MIN_SAMPLE).toBeGreaterThan(1);
    expect(typeof MIN_SAMPLE).toBe('number');
  });

  it('marks a thin principle insufficient and refuses a fail_lift from tiny n', async () => {
    // 1 failed touch, 1 passed touch for P5 — far below MIN_SAMPLE.
    makeTouch(['P5'], true);
    makeTouch([], false);
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.sufficient).toBe(false);
    // No authoritative-looking lift from n=1 arms.
    expect(p5.fail_lift).toBeNull();
  });

  it('computes fail_lift ONLY when BOTH arms reach MIN_SAMPLE (one thin arm → null)', async () => {
    // MIN_SAMPLE+2 touches that FAIL P5 (replied), but only 1 that PASSES P5.
    for (let i = 0; i < MIN_SAMPLE + 2; i++) makeTouch(['P5'], true);
    makeTouch([], true);  // single passed-P5 arm → thin
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.failed_total).toBeGreaterThanOrEqual(MIN_SAMPLE);
    expect(p5.passed_total).toBeLessThan(MIN_SAMPLE);
    expect(p5.sufficient).toBe(false);   // the PASS arm is thin
    expect(p5.fail_lift).toBeNull();     // no lift from a 1-sample arm
  });

  it('reports sufficient + a fail_lift once BOTH arms reach MIN_SAMPLE', async () => {
    for (let i = 0; i < MIN_SAMPLE; i++) makeTouch(['P5'], i % 2 === 0);  // failed arm, mixed replies
    for (let i = 0; i < MIN_SAMPLE; i++) makeTouch([], i % 3 === 0);      // passed arm, mixed replies
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.passed_total).toBeGreaterThanOrEqual(MIN_SAMPLE);
    expect(p5.failed_total).toBeGreaterThanOrEqual(MIN_SAMPLE);
    expect(p5.sufficient).toBe(true);
    expect(typeof p5.fail_lift).toBe('number');
  });
});

// --------------------------------------------------------------------------
// renderOutcomesMarkdown — must not look more scientific than it is
// --------------------------------------------------------------------------

describe('renderOutcomesMarkdown — epistemic honesty', () => {
  it('preamble states it is descriptive/advisory, NOT causal, and never auto-applied', () => {
    const md = renderOutcomesMarkdown([]);
    expect(md).toMatch(/advisory/i);
    expect(md).toMatch(/not causal|correlation, not causation|descriptive/i);
    expect(md).toMatch(/not.*auto|advisory context|do not.*automatically/i);
  });

  it('renders "insufficient data" for thin principles instead of a misleading reply% / lift', async () => {
    makeTouch(['P5'], true);   // n far below MIN_SAMPLE
    makeTouch([], false);
    const md = renderOutcomesMarkdown(await computePrincipleOutcomes(PRINCIPLES));
    expect(md).toMatch(/insufficient data/i);
    // A thin principle row must NOT print a fabricated lift number.
    const p5Line = md.split('\n').find((l) => l.includes('P5'))!;
    expect(p5Line).toMatch(/insufficient data/i);
    expect(p5Line).not.toMatch(/\d+%/);
  });

  it('renders concrete numbers only for sufficient principles', async () => {
    for (let i = 0; i < MIN_SAMPLE; i++) makeTouch(['P5'], i % 2 === 0);
    for (let i = 0; i < MIN_SAMPLE; i++) makeTouch([], i % 2 === 0);
    const md = renderOutcomesMarkdown(await computePrincipleOutcomes(PRINCIPLES));
    const p5Line = md.split('\n').find((l) => l.includes('P5'))!;
    expect(p5Line).toMatch(/%/);                       // a real reply rate
    expect(p5Line).not.toMatch(/insufficient data/i);
  });
});
