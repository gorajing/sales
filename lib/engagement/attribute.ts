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
 * the sent revision PASSED vs FAILED. The output is ADVISORY context
 * for the drafter (Task 4.4) — it is NOT a scoring signal, NOT a
 * causal claim, and is NEVER auto-applied to `data/principles.md`.
 *
 * Deliberately NOT called an "engagement signal": that term belongs
 * to the Phase 3 Outreach connector's FORWARD scoring signal
 * (`evidence.source_type='engagement_event'`), a different
 * subsystem. This module is the BACKWARD feedback loop and touches
 * neither scoring nor evidence (see the no-write invariant below).
 *
 * # Attribution trace (explainable, end to end)
 *
 *   reply `engagement_events` row  → its `touchId`
 *   → that touch's `currentRevisionId` (the version actually sent)
 *   → the LATEST `sales_coach` critique on that revision
 *   → that critique's `findings[].principle_id` = FAILED principles;
 *     every other principle in the universe = PASSED.
 *
 * "Absence of failure ⇒ pass" is an inference, not a stored verdict
 * — the same inference the Sales Coach critic itself relies on. A
 * known v1.5 limitation (persist explicit per-principle verdicts).
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
 *   - `sufficient` is true ONLY when BOTH arms (passed and failed
 *     for that principle) independently reach `MIN_SAMPLE`.
 *   - `fail_lift` is `null` unless `sufficient` — no comparative
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
  passed_total: number;
  passed_replied: number;
  passed_silent: number;
  failed_total: number;
  failed_replied: number;
  failed_silent: number;
  /** True ONLY when BOTH arms independently reach MIN_SAMPLE. When
   *  false, the rates below are statistically meaningless and the
   *  renderer shows "insufficient data" instead. */
  sufficient: boolean;
  /** reply-rate(fail) / reply-rate(pass). >1 ⇒ failing the principle
   *  correlates with MORE replies (a flag to investigate, NOT a
   *  causal claim). `null` whenever `!sufficient` (no ratio from thin
   *  data) or pass-arm reply rate is 0. */
  fail_lift: number | null;
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

  // Which touches received a reply outcome event.
  const repliedTouches = new Set<string>(
    db.select().from(schema.engagementEvents)
      .where(eq(schema.engagementEvents.eventType, 'replied'))
      .all()
      .map((e) => e.touchId)
      .filter((x): x is string => !!x),
  );

  const touches = db.select().from(schema.touches).all()
    .filter((t) => t.currentRevisionId !== null);
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
      passed_total: 0, passed_replied: 0, passed_silent: 0,
      failed_total: 0, failed_replied: 0, failed_silent: 0,
      sufficient: false, fail_lift: null,
    };
  }

  for (const t of touches) {
    const candidates = byRevision.get(t.currentRevisionId!);
    if (!candidates || candidates.length === 0) continue;
    // Deterministic latest: parse timestamps (SQLite "YYYY-MM-DD
    // HH:MM:SS" vs ISO "…Z" don't sort lexicographically the same),
    // tie-break on id desc.
    const latest = [...candidates].sort((a, b) => {
      const dt = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return dt !== 0 ? dt : b.id.localeCompare(a.id);
    })[0];
    const didReply = repliedTouches.has(t.id);
    const failed = new Set<string>(
      latest.findingsJson
        .map((f) => f.principle_id)
        .filter((x): x is string => !!x),
    );
    for (const pid of ALL) {
      const o = counts[pid];
      if (failed.has(pid)) {
        o.failed_total++;
        if (didReply) o.failed_replied++; else o.failed_silent++;
      } else {
        o.passed_total++;
        if (didReply) o.passed_replied++; else o.passed_silent++;
      }
    }
  }

  for (const pid of ALL) {
    const o = counts[pid];
    // Both arms must independently clear the floor. A comparative
    // lift from a thin arm is exactly the "weak evidence looks
    // authoritative" failure this guard exists to prevent.
    o.sufficient = o.passed_total >= MIN_SAMPLE && o.failed_total >= MIN_SAMPLE;
    if (o.sufficient) {
      const passRate = o.passed_replied / o.passed_total;
      const failRate = o.failed_replied / o.failed_total;
      o.fail_lift = passRate > 0 ? failRate / passRate : null;
    } else {
      o.fail_lift = null;
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
export function renderOutcomesMarkdown(outcomes: PrincipleOutcome[]): string {
  const lines = [
    '# Principle outcomes (ADVISORY)',
    '',
    // Each disclaimer is a single self-contained line on purpose:
    // this preamble is the load-bearing guard between "descriptive
    // correlation over a small controlled sample" and a reader
    // treating it as ground truth. Don't wrap these into prose.
    'Advisory only. This is descriptive correlation, NOT causation, and NOT a score input.',
    'It is NOT auto-applied to data/principles.md; the drafter reads it as advisory context, not instruction.',
    'A correlation here is a prompt to investigate, never a verdict — reply behaviour has many causes.',
    `Principles below ${MIN_SAMPLE} touches in EITHER arm (passed / failed) show "insufficient data", not a misleading percentage.`,
    'Insufficient data means we decline to report — NOT that the principle has no effect.',
    '',
    '| Principle | n(pass) | reply%(pass) | n(fail) | reply%(fail) | fail_lift |',
    '|---|---|---|---|---|---|',
  ];
  for (const o of outcomes) {
    if (!o.sufficient) {
      const n = o.passed_total + o.failed_total;
      lines.push(
        `| ${o.principle_id} | ${o.passed_total} | insufficient data ` +
        `| ${o.failed_total} | insufficient data | — (n=${n}) |`,
      );
      continue;
    }
    const pp = Math.round(100 * o.passed_replied / o.passed_total);
    const fp = Math.round(100 * o.failed_replied / o.failed_total);
    lines.push(
      `| ${o.principle_id} | ${o.passed_total} | ${pp}% | ` +
      `${o.failed_total} | ${fp}% | ${o.fail_lift?.toFixed(2) ?? 'n/a'} |`,
    );
  }
  return lines.join('\n');
}
