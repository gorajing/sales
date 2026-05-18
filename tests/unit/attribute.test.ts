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
  parseTs,
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
 * Make a SENT touch (a baseline 'sent' engagement event makes it
 * observable — the denominator is sent touches only) whose current
 * revision has a single latest sales_coach critique flagging
 * `principleFailed` (every other principle "no-finding" by the
 * documented inference). When `replied`, also emit a 'replied'
 * outcome event. A touch with NO engagement events would be
 * unobservable (drafted-but-unsent) and correctly excluded.
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
    // Realistic timeline: the revision is created BEFORE it is sent
    // and BEFORE any engagement events (10:00 < sent 11:00 < reply
    // 12:00). Without this the column defaults to CURRENT_TIMESTAMP
    // (~now), which is AFTER the 2026-05-06 events — the
    // redraft-ambiguity guard would (correctly) exclude such a
    // temporally-impossible fixture.
    createdAt: '2026-05-06T10:00:00.000Z',
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
  // Baseline 'sent' event → the touch is observable (it went out).
  db.insert(schemaMod.engagementEvents).values({
    id: newId('engagementEvent'), touchId, contactId: null,
    eventType: 'sent', occurredAt: '2026-05-06T11:00:00.000Z',
  }).run();
  if (replied) {
    db.insert(schemaMod.engagementEvents).values({
      id: newId('engagementEvent'), touchId, contactId: null,
      eventType: 'replied', occurredAt: '2026-05-06T12:00:00.000Z',
    }).run();
  }
  return touchId;
}

/** A drafted-but-UNSENT touch: critique exists, but NO engagement
 *  event, so it must NOT count toward any denominator. */
function makeUnsentTouch(principleFailed: string[]): string {
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
    createdAt: '2020-01-01T00:00:00.000Z',
  }).run();
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
    expect(p5.flagged_total).toBe(2);          // touches 1 & 3
    expect(p5.flagged_replied).toBe(1);        // touch 1
    expect(p5.noFinding_total).toBe(1);          // touch 2
    const p1 = outcomes.find((o) => o.principle_id === 'P1')!;
    expect(p1.noFinding_total).toBe(3);          // P1 never failed
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
    expect(p5.flagged_total).toBe(0);  // latest critique passed P5
    expect(p5.noFinding_total).toBe(1);
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

  it('marks a thin principle insufficient and refuses a flagged_lift from tiny n', async () => {
    // 1 failed touch, 1 passed touch for P5 — far below MIN_SAMPLE.
    makeTouch(['P5'], true);
    makeTouch([], false);
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.sufficient).toBe(false);
    // No authoritative-looking lift from n=1 arms.
    expect(p5.flagged_lift).toBeNull();
  });

  it('computes flagged_lift ONLY when BOTH arms reach MIN_SAMPLE (one thin arm → null)', async () => {
    // MIN_SAMPLE+2 touches that FAIL P5 (replied), but only 1 that PASSES P5.
    for (let i = 0; i < MIN_SAMPLE + 2; i++) makeTouch(['P5'], true);
    makeTouch([], true);  // single passed-P5 arm → thin
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.flagged_total).toBeGreaterThanOrEqual(MIN_SAMPLE);
    expect(p5.noFinding_total).toBeLessThan(MIN_SAMPLE);
    expect(p5.sufficient).toBe(false);   // the PASS arm is thin
    expect(p5.flagged_lift).toBeNull();     // no lift from a 1-sample arm
  });

  it('reports sufficient + a flagged_lift once BOTH arms reach MIN_SAMPLE', async () => {
    for (let i = 0; i < MIN_SAMPLE; i++) makeTouch(['P5'], i % 2 === 0);  // failed arm, mixed replies
    for (let i = 0; i < MIN_SAMPLE; i++) makeTouch([], i % 3 === 0);      // passed arm, mixed replies
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.noFinding_total).toBeGreaterThanOrEqual(MIN_SAMPLE);
    expect(p5.flagged_total).toBeGreaterThanOrEqual(MIN_SAMPLE);
    expect(p5.sufficient).toBe(true);
    expect(typeof p5.flagged_lift).toBe('number');
  });
});

// --------------------------------------------------------------------------
// Observable population & attribution robustness (codex 4.3 r1 blockers)
// --------------------------------------------------------------------------

describe('computePrincipleOutcomes — observable population', () => {
  it('EXCLUDES drafted-but-unsent touches from the denominator (no fabricated silent rows)', async () => {
    // 1 SENT touch failing P5 (replied) + many UNSENT drafts failing
    // P5. The unsent drafts must NOT inflate flagged_total or push P5
    // toward "sufficient" — only the sent touch is observable.
    makeTouch(['P5'], true);
    for (let i = 0; i < MIN_SAMPLE + 5; i++) makeUnsentTouch(['P5']);
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.flagged_total).toBe(1);     // ONLY the sent touch
    expect(p5.sufficient).toBe(false);   // unsent drafts didn't count
  });

  it("counts 'meeting_booked' as a positive outcome, not silent", async () => {
    const touchId = makeTouch(['P5'], false);  // sent, no reply
    db.insert(schemaMod.engagementEvents).values({
      id: newId('engagementEvent'), touchId, contactId: null,
      eventType: 'meeting_booked', occurredAt: '2026-05-06T13:00:00.000Z',
    }).run();
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.flagged_total).toBe(1);
    expect(p5.flagged_replied).toBe(1);   // meeting_booked = positive
    expect(p5.flagged_silent).toBe(0);
  });

  it('parseTs treats the SQLite space-format as UTC, and returns NaN for junk', () => {
    // In-process positive pin (TZ-independent: explicit Z).
    expect(parseTs('2026-05-06 12:00:00')).toBe(Date.UTC(2026, 4, 6, 12, 0, 0));
    expect(parseTs('2026-05-06 12:00:00')).toBe(parseTs('2026-05-06T12:00:00.000Z'));
    // codex r3 nit: junk → NaN (defensive; createdAt is NOT NULL).
    expect(Number.isNaN(parseTs(''))).toBe(true);
    expect(Number.isNaN(parseTs('not-a-date'))).toBe(true);
  });

  it('parseTs is UTC even under a non-UTC TZ (child process — genuinely pins the local-parse bug)', () => {
    // codex r3: the in-process test above can't catch the bug in
    // TZ=UTC CI (there local==UTC). Force a non-UTC TZ in a child
    // node process and assert the SQLite space-format still resolves
    // to the SAME instant as the explicit-Z form, AND differs from a
    // naive `new Date(space)` local parse. This is the only way to
    // pin a timezone-dependent bug regardless of the CI's own TZ.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const path = require('node:path') as typeof import('node:path');
    const mod = path.resolve(__dirname, '../../lib/engagement/attribute.ts').replace(/\\/g, '/');
    // CommonJS require() (not dynamic import()) — under `tsx`,
    // require('<file>.ts') exposes the named exports directly,
    // whereas import() returns a {default, 'module.exports'} wrapper.
    const script =
      `const m = require('${mod}');` +
      `const u = m.parseTs('2026-05-06 12:00:00');` +
      `const z = m.parseTs('2026-05-06T12:00:00.000Z');` +
      `const naive = new Date('2026-05-06 12:00:00').getTime();` +
      `if (typeof m.parseTs !== 'function') { console.error('FAIL no parseTs'); process.exit(1); }` +
      `if (u !== z) { console.error('FAIL space!=Z', u, z); process.exit(1); }` +
      `if (u === naive) { console.error('FAIL space==naive-local (bug present)', u); process.exit(1); }` +
      `console.log('OK');`;
    const out = execFileSync(
      process.execPath,
      ['--import', 'tsx', '-e', script],
      { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' },
    );
    expect(out).toContain('OK');
  });

  it('picks the chronologically-later critique when SQLite-UTC and ISO-Z formats are mixed', async () => {
    // Same-instant-relevant: a SQLite-format critique that is
    // genuinely LATER (in UTC) than an ISO-Z one must win, proving
    // the sort uses parseTs, not naive new Date().
    const touchId = makeTouch([], true, '2026-05-06T10:00:00.000Z'); // ISO pass, 10:00Z
    const rev = db.select().from(schemaMod.touchRevisions)
      .where(eq(schemaMod.touchRevisions.touchId, touchId)).get()!;
    db.insert(schemaMod.critiques).values({
      id: newId('critique'), touchRevisionId: rev.id,
      criticName: 'sales_coach', verdict: 'revise',
      findingsJson: [{ issue: 'x', quote: '', suggested_rewrite: null, principle_id: 'P5' }],
      createdAt: '2026-05-06 11:00:00',  // SQLite UTC, 11:00Z — later
    }).run();
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.flagged_total).toBe(1);  // 11:00Z SQLite critique won
    expect(p5.noFinding_total).toBe(0);
  });

  it('EXCLUDES a touch redrafted AFTER engagement began (ambiguous attribution — codex r2 blocker)', async () => {
    // Send rev1, get a reply, THEN redraft to rev2. currentRevisionId
    // now points at rev2, but the reply responded to rev1 — we cannot
    // attribute it. The touch must be dropped, NOT mis-attributed to
    // rev2's critique. (A bunch of these must not become evidence.)
    const accountId = newId('account');
    db.insert(schemaMod.accounts).values({ id: accountId, name: 'X' }).run();
    const sequenceId = newId('sequence');
    db.insert(schemaMod.sequences).values({ id: sequenceId, accountId }).run();
    const touchId = newId('touch');
    db.insert(schemaMod.touches).values({
      id: touchId, sequenceId, position: 1, channel: 'email',
    }).run();
    // rev1, critiqued (flags P5), then sent + replied.
    const rev1 = newId('touchRevision');
    db.insert(schemaMod.touchRevisions).values({
      id: rev1, touchId, revisionNumber: 1, body: 'v1', createdBy: 'drafter',
      createdAt: '2026-05-01T00:00:00.000Z',
    }).run();
    db.insert(schemaMod.critiques).values({
      id: newId('critique'), touchRevisionId: rev1, criticName: 'sales_coach',
      verdict: 'revise',
      findingsJson: [{ issue: 'x', quote: '', suggested_rewrite: null, principle_id: 'P5' }],
      createdAt: '2026-05-01T00:00:00.000Z',
    }).run();
    db.update(schemaMod.touches).set({ currentRevisionId: rev1 })
      .where(eq(schemaMod.touches.id, touchId)).run();
    db.insert(schemaMod.engagementEvents).values({
      id: newId('engagementEvent'), touchId, contactId: null,
      eventType: 'replied', occurredAt: '2026-05-05T00:00:00.000Z',
    }).run();
    // THEN redraft → rev2 created AFTER the reply event.
    const rev2 = newId('touchRevision');
    db.insert(schemaMod.touchRevisions).values({
      id: rev2, touchId, revisionNumber: 2, body: 'v2', createdBy: 'drafter',
      createdAt: '2026-05-10T00:00:00.000Z',  // after the 05-05 reply
    }).run();
    db.insert(schemaMod.critiques).values({
      id: newId('critique'), touchRevisionId: rev2, criticName: 'sales_coach',
      verdict: 'pass', findingsJson: [], createdAt: '2026-05-10T00:00:00.000Z',
    }).run();
    db.update(schemaMod.touches).set({ currentRevisionId: rev2 })
      .where(eq(schemaMod.touches.id, touchId)).run();

    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    // Ambiguous → excluded from BOTH arms entirely.
    expect(p5.flagged_total).toBe(0);
    expect(p5.noFinding_total).toBe(0);
  });

  it('EXCLUDES a bounced touch from the denominator (deliverability failure ≠ silent — codex r2)', async () => {
    const touchId = makeTouch(['P5'], false);  // sent, no reply
    db.insert(schemaMod.engagementEvents).values({
      id: newId('engagementEvent'), touchId, contactId: null,
      eventType: 'bounced', occurredAt: '2026-05-06T11:30:00.000Z',
    }).run();
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.flagged_total).toBe(0);   // bounced → not a valid observation
    expect(p5.noFinding_total).toBe(0);
  });

  it('a bounce POISONS the touch even if it later replied (documented conservative behavior — codex r3)', async () => {
    // makeTouch already emits sent(11:00)+replied(12:00). Add a
    // bounce: the conservative rule is "any bounce excludes the
    // touch entirely", even with a later positive on the same
    // touchId. Pin it so a future "only terminal bounce" refactor is
    // a deliberate, reviewed change — not a silent semantics drift.
    const touchId = makeTouch(['P5'], true);  // sent + replied
    db.insert(schemaMod.engagementEvents).values({
      id: newId('engagementEvent'), touchId, contactId: null,
      eventType: 'bounced', occurredAt: '2026-05-06T11:15:00.000Z',
    }).run();
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.flagged_total).toBe(0);          // poisoned, not counted as a win
    expect(p5.flagged_replied).toBe(0);
    expect(p5.noFinding_total).toBe(0);
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

  it('uses honest "no-finding"/"flagged" labels + carries the absence⇒pass caveat (codex r1)', () => {
    // "pass" overclaims — the critic records findings, not explicit
    // per-principle passes, so "not flagged" includes never-evaluated
    // principles. The artifact the drafter reads must say so.
    const md = renderOutcomesMarkdown([]);
    expect(md).toMatch(/no-finding/);
    expect(md).toMatch(/flagged/);
    expect(md).not.toMatch(/reply%\(pass\)/);  // the misleading old label is gone
    expect(md).toMatch(/INCLUDES principles the critic\s*\n?\s*never evaluated|not an explicit\s*\n?\s*pass/i);
    expect(md).toMatch(/SENT touches only/i);            // population caveat
    expect(md).toMatch(/replied' OR 'meeting_booked'/);  // positive-outcome definition
  });

  it('renders a generated-at timestamp so digest staleness is visible (codex r1)', () => {
    const at = new Date('2026-05-18T09:00:00.000Z');
    expect(renderOutcomesMarkdown([], at)).toMatch(/Generated: 2026-05-18T09:00:00\.000Z/);
  });

  it('renders the strong-inverse case explicitly, NOT a bland "n/a" that hides it (codex r1)', async () => {
    // no-finding arm: MIN_SAMPLE touches, ZERO replies. flagged arm:
    // MIN_SAMPLE touches that all replied. Both arms sufficient; the
    // ratio is undefined but it's the STRONGEST inverse signal.
    for (let i = 0; i < MIN_SAMPLE; i++) makeTouch([], false);     // no-finding P5, all silent
    for (let i = 0; i < MIN_SAMPLE; i++) makeTouch(['P5'], true);  // flagged P5, all replied
    const p5 = (await computePrincipleOutcomes(PRINCIPLES))
      .find((o) => o.principle_id === 'P5')!;
    expect(p5.sufficient).toBe(true);
    expect(p5.noFinding_replied).toBe(0);
    expect(p5.flagged_replied).toBe(MIN_SAMPLE);
    const md = renderOutcomesMarkdown([p5]);
    const line = md.split('\n').find((l) => l.includes('P5'))!;
    expect(line).toMatch(/strong inverse|investigate/i);
    expect(line).not.toMatch(/\bn\/a\b/);
  });
});
