import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';

/**
 * Per-principle outcome attribution (Phase 4.3).
 *
 * # What this is — and the names that matter
 *
 * This reads TOUCH ENGAGEMENT OUTCOME events (the Phase 4
 * `engagement_events` table — post-send facts: did a reply land on
 * this touch?) and correlates them with which Sales-Coach principles
 * the sent revision was FLAGGED for vs. had NO FINDING. The output
 * is ADVISORY context for the drafter (Task 4.4) — NOT a scoring
 * signal, NOT a causal claim, NEVER auto-applied to
 * `data/principles.md`.
 *
 * Deliberately NOT called an "engagement signal": that term belongs
 * to the Phase 3 Outreach connector's FORWARD scoring signal
 * (`evidence.source_type='engagement_event'`), a different
 * subsystem. This module is the BACKWARD feedback loop and touches
 * neither scoring nor evidence (see the no-write invariant below).
 *
 * # Attribution trace (explainable, end to end)
 *
 *   positive `engagement_events` row (replied|meeting_booked) → its
 *   `touchId` → that touch's `currentRevisionId` → the LATEST
 *   `sales_coach` critique on that revision → its
 *   `findings[].principle_id` = FLAGGED principles; every other
 *   principle in the universe = NO-FINDING.
 *
 * Two honesty constraints, both enforced in code and stated in the
 * rendered preamble:
 *   - "NO-FINDING" is NOT an explicit pass. The critic records
 *     findings, not per-principle verdicts, so "not flagged"
 *     includes principles it never evaluated. v1.5: persist
 *     explicit verdicts. (Hence the field names are noFinding_ and
 *     flagged_, never the old passed_ / failed_ names.)
 *   - `currentRevisionId` is MUTABLE (a redraft moves it) and
 *     `engagement_events` has no sent-revision marker, so a touch
 *     whose last revision was created AFTER its first engagement
 *     event has ambiguous attribution and is EXCLUDED (see the
 *     filter below). v1.5: a real sentRevisionId removes the
 *     ambiguity.
 *
 * # No-write invariant
 *
 * This module ONLY reads `engagement_events`, `critiques`,
 * `touches`, `touch_revisions`. It writes NOTHING — no
 * `lead_scores`, no `evidence`, no `data/principles.md`. The
 * feedback loop must never close back into scoring or silently
 * rewrite principles. Enforced structurally (no scoring/ingest
 * imports) and pinned by test.
 *
 * # Sample-size guardrail (epistemic honesty)
 *
 * The failure mode this guards against is not a code bug — it's
 * making n=1 noise look authoritative to the drafter. A reply rate
 * over a single-digit sample is meaningless; a lift ratio between
 * two thin arms is worse. So:
 *   - `sufficient` is true ONLY when BOTH arms (no-finding and
 *     flagged for that principle) independently reach `MIN_SAMPLE`.
 *   - `flagged_lift` is `null` unless `sufficient` — no comparative
 *     ratio is computed from thin data.
 *   - `renderOutcomesMarkdown` prints "insufficient data (n=…)" for
 *     thin principles instead of a fabricated percentage/lift.
 * `MIN_SAMPLE` is a deliberate conservatism knob ("more than a
 * handful"), explicitly NOT a statistical-significance threshold —
 * we don't claim precision we don't have; we decline to report.
 */

/**
 * Minimum per-arm sample below which a principle's reply rate / lift
 * is suppressed as "insufficient data". A conservative floor, not a
 * significance test — tune as outreach volume grows. Exported so the
 * value is visible/tunable in one place.
 */
export const MIN_SAMPLE = 10;

export interface PrincipleOutcome {
  principle_id: string;
  noFinding_total: number;
  noFinding_replied: number;
  noFinding_silent: number;
  flagged_total: number;
  flagged_replied: number;
  flagged_silent: number;
  /** True ONLY when BOTH arms independently reach MIN_SAMPLE. When
   *  false, the rates below are statistically meaningless and the
   *  renderer shows "insufficient data" instead. */
  sufficient: boolean;
  /** reply-rate(fail) / reply-rate(pass). >1 ⇒ failing the principle
   *  correlates with MORE replies (a flag to investigate, NOT a
   *  causal claim). `null` whenever `!sufficient` (no ratio from thin
   *  data) or pass-arm reply rate is 0. */
  flagged_lift: number | null;
}

/**
 * Parse principle IDs from a `data/principles.md` body. Matches
 * `## P<digits> — …` headings only (the file's actual format); prose
 * mentioning "P1" is ignored.
 */
export function parsePrincipleIds(md: string): string[] {
  const ids: string[] = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s+(P\d+)\b/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/**
 * Parse a critique timestamp to epoch ms, treating the bare SQLite
 * `CURRENT_TIMESTAMP` format (`YYYY-MM-DD HH:MM:SS`, which SQLite
 * emits in UTC) as UTC — `new Date()` would otherwise read it as
 * LOCAL time and mis-order it against ISO `…Z` rows (codex Phase 4.3
 * r1 blocker). ISO-8601 strings pass straight through. Unparseable →
 * NaN (sorts last via the `dt !== 0` guard, deterministic).
 */
export function parseTs(s: string): number {
  // Bare SQLite space-format, no offset → it's UTC; make that explicit.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return new Date(s.replace(' ', 'T') + 'Z').getTime();
  }
  return new Date(s).getTime();
}

function loadPrincipleIdsFromDisk(): string[] {
  const path = resolve(process.cwd(), 'data/principles.md');
  if (!existsSync(path)) return [];
  return parsePrincipleIds(readFileSync(path, 'utf8'));
}

/**
 * Compute per-principle pass/fail × replied/silent outcomes from the
 * latest sales_coach critique on each touch's current revision.
 *
 * @param principleIds optional override of the principle universe;
 *   defaults to the ids parsed from `data/principles.md`.
 */
export async function computePrincipleOutcomes(
  principleIds?: string[],
): Promise<PrincipleOutcome[]> {
  const ALL = principleIds && principleIds.length > 0
    ? principleIds
    : loadPrincipleIdsFromDisk();
  if (ALL.length === 0) return [];

  // OBSERVABLE POPULATION = touches that have ≥1 engagement event.
  // codex Phase 4.3 r1 blocker: an earlier version used every touch
  // with a currentRevisionId as a denominator — including
  // drafted-but-never-SENT touches, which became fake "silent"
  // non-observations and could push a principle to "sufficient" off
  // unsent drafts. A reply (or any provider event) only exists for a
  // touch that actually went out, so engagement-event presence IS
  // the ground-truth "sent & observed" marker. (touches.status/sentAt
  // exist but NO v1 code path sets them — using them would make the
  // denominator permanently empty; engagement-event presence is the
  // honest, data-grounded population. v1.5: a real sent-revision
  // marker.)
  //
  // POSITIVE outcome = 'replied' OR 'meeting_booked'. A booked
  // meeting is an unambiguous (and stronger) positive than a reply;
  // counting it as "silent" (codex would-improve) would under-count
  // real wins. The preamble states this definition explicitly.
  const allEvents = db.select().from(schema.engagementEvents).all();
  // Earliest observed engagement per touch — the "we started
  // observing this send" instant, used for the redraft-ambiguity
  // exclusion below.
  const firstEventAt = new Map<string, number>();
  // ANY touch with a 'bounced' event is excluded entirely — a hard
  // bounce means the message never landed, so it is not a valid
  // reply-rate observation (counting it "silent" would turn a
  // deliverability failure into principle evidence — codex 4.3 r2).
  // This is intentionally blunt: a bounce "poisons" the touch even
  // if it was later resent on the same touchId and replied. Losing
  // that rare eventual-success datum is the conservative trade — it
  // can only shrink n and make "insufficient data" MORE likely,
  // never inflate evidence. v1.5 (with a sent-attempt model) could
  // refine to terminal-bounce-only. ('unsubscribed' = they DID
  // receive it → left as an observed silent outcome for v1.)
  const bouncedTouches = new Set<string>();
  for (const e of allEvents) {
    if (!e.touchId) continue;
    if (e.eventType === 'bounced') bouncedTouches.add(e.touchId);
    const t = parseTs(e.occurredAt);
    const cur = firstEventAt.get(e.touchId);
    if (cur === undefined || (Number.isFinite(t) && t < cur)) {
      firstEventAt.set(e.touchId, Number.isFinite(t) ? t : (cur ?? Infinity));
    }
  }
  const observableTouches = new Set<string>(
    allEvents
      .map((e) => e.touchId)
      .filter((x): x is string => !!x && !bouncedTouches.has(x)),
  );
  const positiveTouches = new Set<string>(
    allEvents
      .filter((e) => e.eventType === 'replied' || e.eventType === 'meeting_booked')
      .map((e) => e.touchId)
      .filter((x): x is string => !!x),
  );

  // Latest touch_revision creation time per touch — to detect a
  // redraft that happened AFTER engagement began (ambiguous: which
  // revision did the reply respond to?).
  const lastRevAt = new Map<string, number>();
  for (const r of db.select().from(schema.touchRevisions).all()) {
    const t = parseTs(r.createdAt);
    const cur = lastRevAt.get(r.touchId);
    if (cur === undefined || (Number.isFinite(t) && t > cur)) {
      lastRevAt.set(r.touchId, Number.isFinite(t) ? t : (cur ?? -Infinity));
    }
  }

  const touches = db.select().from(schema.touches).all()
    .filter((t) => {
      if (t.currentRevisionId === null || !observableTouches.has(t.id)) return false;
      // codex 4.3 r2 BLOCKER: currentRevisionId is MUTABLE — a
      // redraft (draft.ts) overwrites it. engagement_events stores
      // only touch_id, no sent-revision marker. If a revision was
      // created AFTER the first engagement event, we cannot know
      // which revision the reply responded to → attributing it to
      // the current revision's critique is wrong-message
      // attribution. Conservatively EXCLUDE such ambiguous touches.
      // The normal pre-send flow (rev1 → critic_rewrite rev2 →
      // SENT → events) has lastRev <= firstEvent and is correctly
      // INCLUDED. v1.5: a real sentRevisionId on the event removes
      // the ambiguity and this exclusion.
      const fe = firstEventAt.get(t.id);
      const lr = lastRevAt.get(t.id);
      if (fe === undefined || lr === undefined) return false;
      return lr <= fe;
    });
  const coachCritiques = db.select().from(schema.critiques)
    .where(eq(schema.critiques.criticName, 'sales_coach')).all();

  const byRevision = new Map<string, typeof coachCritiques>();
  for (const c of coachCritiques) {
    const arr = byRevision.get(c.touchRevisionId) ?? [];
    arr.push(c);
    byRevision.set(c.touchRevisionId, arr);
  }

  const counts: Record<string, PrincipleOutcome> = {};
  for (const pid of ALL) {
    counts[pid] = {
      principle_id: pid,
      noFinding_total: 0, noFinding_replied: 0, noFinding_silent: 0,
      flagged_total: 0, flagged_replied: 0, flagged_silent: 0,
      sufficient: false, flagged_lift: null,
    };
  }

  for (const t of touches) {
    const candidates = byRevision.get(t.currentRevisionId!);
    if (!candidates || candidates.length === 0) continue;
    // codex Phase 4.3 r1 blocker: `new Date('YYYY-MM-DD HH:MM:SS')`
    // (SQLite CURRENT_TIMESTAMP, which is UTC) is parsed by JS as
    // LOCAL time, while ISO '…Z' rows parse as UTC — mixed rows
    // sorted wrong → replies attributed to the wrong pass/fail set.
    // `parseTs` normalizes the bare SQLite space-format to UTC before
    // comparing. Same-instant ties fall back to a DETERMINISTIC (not
    // chronological — newId has a random suffix, no monotonic field)
    // id compare: a re-critique within the same second is
    // pathological; stable-and-reproducible is the achievable goal
    // (v1.5: monotonic critique ordering).
    const latest = [...candidates].sort((a, b) => {
      const dt = parseTs(b.createdAt) - parseTs(a.createdAt);
      return dt !== 0 ? dt : b.id.localeCompare(a.id);
    })[0];
    const responded = positiveTouches.has(t.id);
    const flagged = new Set<string>(
      latest.findingsJson
        .map((f) => f.principle_id)
        .filter((x): x is string => !!x),
    );
    for (const pid of ALL) {
      const o = counts[pid];
      if (flagged.has(pid)) {
        o.flagged_total++;
        if (responded) o.flagged_replied++; else o.flagged_silent++;
      } else {
        // "not flagged" — NOT an explicit pass. Includes principles
        // the coach never evaluated. The render labels honour this
        // (no-finding vs flagged) and the preamble states the caveat.
        o.noFinding_total++;
        if (responded) o.noFinding_replied++; else o.noFinding_silent++;
      }
    }
  }

  for (const pid of ALL) {
    const o = counts[pid];
    // Both arms must independently clear the floor. A comparative
    // lift from a thin arm is exactly the "weak evidence looks
    // authoritative" failure this guard exists to prevent.
    o.sufficient = o.noFinding_total >= MIN_SAMPLE && o.flagged_total >= MIN_SAMPLE;
    if (o.sufficient) {
      const passRate = o.noFinding_replied / o.noFinding_total;
      const failRate = o.flagged_replied / o.flagged_total;
      o.flagged_lift = passRate > 0 ? failRate / passRate : null;
    } else {
      o.flagged_lift = null;
    }
  }

  return Object.values(counts);
}

/**
 * Render the advisory markdown the nightly digest writes to
 * `data/principle-outcomes.md` (Task 4.5) and the drafter reads as
 * context (Task 4.4). The preamble is deliberately load-bearing: it
 * is the thing standing between "descriptive correlation over a
 * controlled sample" and the drafter treating it as ground truth.
 */
export function renderOutcomesMarkdown(
  outcomes: PrincipleOutcome[],
  generatedAt: Date = new Date(),
): string {
  const lines = [
    '# Principle outcomes (ADVISORY)',
    '',
    `Generated: ${generatedAt.toISOString()}`,
    '',
    // Each disclaimer is a single self-contained line on purpose:
    // this preamble is the load-bearing guard between "descriptive
    // correlation over a small controlled sample" and a reader
    // treating it as ground truth. Don't wrap these into prose.
    'Advisory only. This is descriptive correlation, NOT causation, and NOT a score input.',
    'It is NOT auto-applied to data/principles.md; the drafter reads it as advisory context, not instruction.',
    'A correlation here is a prompt to investigate, never a verdict — reply behaviour has many causes.',
    `Population = SENT touches only (≥1 engagement event). EXCLUDED: drafted-but-unsent touches; touches with`,
    `a 'bounced' event (never delivered → not a valid reply observation); and touches redrafted AFTER engagement`,
    `began (we cannot know which revision the reply answered — ambiguous attribution). These exclusions shrink n,`,
    `which makes "insufficient data" MORE likely — deliberately conservative, never inflating the sample.`,
    `Positive outcome = a 'replied' OR 'meeting_booked' event for the touch. All other observed touches are "silent".`,
    `"no-finding" = the latest Sales-Coach critique did NOT flag this principle. This INCLUDES principles the critic`,
    `never evaluated (it records findings, not explicit per-principle passes) — so "no-finding" is NOT an explicit`,
    `pass. v1.5 will persist explicit verdicts. "flagged" = the latest critique raised a finding for this principle.`,
    `Principles below ${MIN_SAMPLE} touches in EITHER arm (no-finding / flagged) show "insufficient data", not a misleading percentage.`,
    'Insufficient data means we decline to report — NOT that the principle has no effect.',
    '',
    '| Principle | n(no-finding) | reply%(no-finding) | n(flagged) | reply%(flagged) | flagged_lift |',
    '|---|---|---|---|---|---|',
  ];
  for (const o of outcomes) {
    if (!o.sufficient) {
      const n = o.noFinding_total + o.flagged_total;
      lines.push(
        `| ${o.principle_id} | ${o.noFinding_total} | insufficient data ` +
        `| ${o.flagged_total} | insufficient data | — (n=${n}) |`,
      );
      continue;
    }
    const pp = Math.round(100 * o.noFinding_replied / o.noFinding_total);
    const fp = Math.round(100 * o.flagged_replied / o.flagged_total);
    // codex Phase 4.3 r1 would-improve: when the no-finding arm has
    // ZERO replies but the flagged arm has some, the ratio is
    // mathematically undefined — but that's the STRONGEST possible
    // inverse signal (this principle's presence may HURT), not "no
    // data". Render it as an explicit investigate callout, never a
    // bland "n/a" that hides it.
    let liftCell: string;
    if (o.flagged_lift !== null) {
      liftCell = o.flagged_lift.toFixed(2);
    } else if (o.noFinding_replied === 0 && o.flagged_replied > 0) {
      liftCell = 'no-finding arm 0% — strong inverse, investigate';
    } else {
      liftCell = 'n/a (no replies in either arm)';
    }
    lines.push(
      `| ${o.principle_id} | ${o.noFinding_total} | ${pp}% | ` +
      `${o.flagged_total} | ${fp}% | ${liftCell} |`,
    );
  }
  return lines.join('\n');
}
