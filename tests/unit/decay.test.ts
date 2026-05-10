import { describe, it, expect } from 'vitest';
import { linearDecayWeight } from '../../lib/scoring/decay';

describe('linearDecayWeight — nominal cases', () => {
  const base = 100;
  const window = 7;  // days
  const t0 = new Date('2026-05-06T00:00:00Z');

  it('returns full weight at t=0', () => {
    expect(linearDecayWeight(base, t0, t0, window)).toBe(100);
  });

  it('returns 75% weight at quarter window', () => {
    const t = new Date('2026-05-07T18:00:00Z');  // 1.75 days = 25% of 7d
    expect(linearDecayWeight(base, t0, t, window)).toBe(75);
  });

  it('returns half weight at half window', () => {
    const t = new Date('2026-05-09T12:00:00Z');  // 3.5 days
    expect(linearDecayWeight(base, t0, t, window)).toBe(50);
  });

  it('returns 25% weight at 75% window', () => {
    const t = new Date('2026-05-11T06:00:00Z');  // 5.25 days
    expect(linearDecayWeight(base, t0, t, window)).toBe(25);
  });

  it('returns 0 weight at full window', () => {
    const t = new Date('2026-05-13T00:00:00Z');  // 7 days
    expect(linearDecayWeight(base, t0, t, window)).toBe(0);
  });

  it('clamps to 0 past the window', () => {
    const t = new Date('2026-06-06T00:00:00Z');  // 31 days
    expect(linearDecayWeight(base, t0, t, window)).toBe(0);
  });
});

describe('linearDecayWeight — clock-skew guard', () => {
  const t0 = new Date('2026-05-06T00:00:00Z');

  it('returns 0 when tEvent > now (event in the future)', () => {
    const past = new Date('2026-05-05T00:00:00Z');
    expect(linearDecayWeight(100, t0, past, 7)).toBe(0);
  });

  it('returns 0 even at +1ms in the future (no negative-elapsed math)', () => {
    const justAfter = new Date(t0.getTime() - 1);
    expect(linearDecayWeight(100, t0, justAfter, 7)).toBe(0);
  });
});

describe('linearDecayWeight — degenerate inputs', () => {
  const t0 = new Date('2026-05-06T00:00:00Z');
  const tNow = new Date('2026-05-09T12:00:00Z');

  it('throws TypeError when windowDays is 0 (would divide by zero)', () => {
    expect(() => linearDecayWeight(100, t0, tNow, 0)).toThrow(TypeError);
  });

  it('throws TypeError when windowDays is negative', () => {
    expect(() => linearDecayWeight(100, t0, tNow, -5)).toThrow(TypeError);
  });

  it('throws TypeError when windowDays is NaN or Infinity', () => {
    expect(() => linearDecayWeight(100, t0, tNow, NaN)).toThrow(TypeError);
    expect(() => linearDecayWeight(100, t0, tNow, Infinity)).toThrow(TypeError);
  });

  it('returns 0 when tEvent is an Invalid Date (NaN getTime)', () => {
    const bad = new Date('not-a-date');
    expect(linearDecayWeight(100, bad, tNow, 7)).toBe(0);
  });

  it('returns 0 when now is an Invalid Date (NaN getTime)', () => {
    const bad = new Date('not-a-date');
    expect(linearDecayWeight(100, t0, bad, 7)).toBe(0);
  });

  it('returns 0 when both dates are Invalid', () => {
    const bad1 = new Date('not-a-date');
    const bad2 = new Date('still-not-a-date');
    expect(linearDecayWeight(100, bad1, bad2, 7)).toBe(0);
  });
});

describe('linearDecayWeight — baseWeight edge cases', () => {
  const t0 = new Date('2026-05-06T00:00:00Z');
  const tHalf = new Date('2026-05-09T12:00:00Z');

  it('returns 0 when baseWeight is 0 (trivial)', () => {
    expect(linearDecayWeight(0, t0, tHalf, 7)).toBe(0);
  });

  it('preserves sign for negative baseWeight (penalty rules supported)', () => {
    // Half-window decay of a -20 penalty → -10. Negative weights are an
    // explicit feature: a scoring rule may dock score for a stale signal.
    expect(linearDecayWeight(-20, t0, tHalf, 7)).toBe(-10);
  });

  it('rounds half to next-magnitude-up for positives (JS Math.round semantics)', () => {
    // baseWeight=1 at exactly half-window: 1 * (1 - 0.5) = 0.5 → Math.round → 1.
    // Documented: small positives may not decay symmetrically. Acceptable for
    // scoring because integer rules are typically baseWeight ≥ 5.
    expect(linearDecayWeight(1, t0, tHalf, 7)).toBe(1);
  });

  it('handles fractional days correctly (windowDays does not need to be integer)', () => {
    // Half of a 0.5-day window = 0.25 days = 6 hours.
    const tQuarterDay = new Date('2026-05-06T06:00:00Z');
    expect(linearDecayWeight(100, t0, tQuarterDay, 0.5)).toBe(50);
  });
});

describe('linearDecayWeight — purity', () => {
  it('does not mutate either Date input', () => {
    const t0 = new Date('2026-05-06T00:00:00Z');
    const t = new Date('2026-05-07T00:00:00Z');
    const t0Snapshot = t0.getTime();
    const tSnapshot = t.getTime();
    linearDecayWeight(100, t0, t, 7);
    linearDecayWeight(100, t0, t, 7);
    expect(t0.getTime()).toBe(t0Snapshot);
    expect(t.getTime()).toBe(tSnapshot);
  });

  it('is deterministic for the same inputs', () => {
    const t0 = new Date('2026-05-06T00:00:00Z');
    const t = new Date('2026-05-09T00:00:00Z');
    const a = linearDecayWeight(100, t0, t, 7);
    const b = linearDecayWeight(100, t0, t, 7);
    const c = linearDecayWeight(100, t0, t, 7);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
