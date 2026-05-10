import { describe, it, expect } from 'vitest';
import { linearDecayWeight } from '../../lib/scoring/decay';

// Tolerance for floating-point comparisons. The function does float math, so
// 1e-9 is comfortably above any rounding error from a single multiply/divide.
const EPS = 1e-9;

describe('linearDecayWeight — nominal cases', () => {
  const base = 100;
  const window = 7;  // days
  const t0 = new Date('2026-05-06T00:00:00Z');

  it('returns full weight at t=0', () => {
    expect(linearDecayWeight(base, t0, t0, window)).toBe(100);
  });

  it('returns 75% weight at quarter window', () => {
    const t = new Date('2026-05-07T18:00:00Z');  // 1.75 days = 25% of 7d
    expect(linearDecayWeight(base, t0, t, window)).toBeCloseTo(75, 9);
  });

  it('returns half weight at half window', () => {
    const t = new Date('2026-05-09T12:00:00Z');  // 3.5 days
    expect(linearDecayWeight(base, t0, t, window)).toBeCloseTo(50, 9);
  });

  it('returns 25% weight at 75% window', () => {
    const t = new Date('2026-05-11T06:00:00Z');  // 5.25 days
    expect(linearDecayWeight(base, t0, t, window)).toBeCloseTo(25, 9);
  });

  it('returns 0 at full window (boundary)', () => {
    const t = new Date('2026-05-13T00:00:00Z');  // 7 days
    expect(linearDecayWeight(base, t0, t, window)).toBe(0);
  });

  it('returns a small positive at 1ms before full window (no early-zeroing)', () => {
    // The bug we fixed: the prior rounded-int return zeroed out small weights
    // for the last ~10% of the window. The float return preserves the tiny
    // contribution all the way until the boundary.
    const justInside = new Date('2026-05-12T23:59:59.999Z');
    const w = linearDecayWeight(100, t0, justInside, 7);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(0.01);  // very small, but not 0
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

  it('returns 0 even at -1ms relative-elapsed (no negative-elapsed math)', () => {
    // `now` is 1ms BEFORE the event — the event is barely in the future.
    const justBeforeEvent = new Date(t0.getTime() - 1);
    expect(linearDecayWeight(100, t0, justBeforeEvent, 7)).toBe(0);
  });
});

describe('linearDecayWeight — windowDays validation', () => {
  const t0 = new Date('2026-05-06T00:00:00Z');
  const tNow = new Date('2026-05-09T12:00:00Z');

  it('throws TypeError when windowDays is 0 (would divide by zero)', () => {
    expect(() => linearDecayWeight(100, t0, tNow, 0)).toThrow(TypeError);
  });

  it('throws TypeError when windowDays is negative', () => {
    expect(() => linearDecayWeight(100, t0, tNow, -5)).toThrow(TypeError);
  });

  it('throws TypeError when windowDays is NaN', () => {
    expect(() => linearDecayWeight(100, t0, tNow, NaN)).toThrow(TypeError);
  });

  it('throws TypeError when windowDays is +Infinity or -Infinity', () => {
    expect(() => linearDecayWeight(100, t0, tNow, Infinity)).toThrow(TypeError);
    expect(() => linearDecayWeight(100, t0, tNow, -Infinity)).toThrow(TypeError);
  });
});

describe('linearDecayWeight — baseWeight validation', () => {
  const t0 = new Date('2026-05-06T00:00:00Z');
  const tNow = new Date('2026-05-09T12:00:00Z');

  it('throws TypeError when baseWeight is NaN (would propagate through scoring sum)', () => {
    expect(() => linearDecayWeight(NaN, t0, tNow, 7)).toThrow(TypeError);
  });

  it('throws TypeError when baseWeight is +Infinity or -Infinity', () => {
    expect(() => linearDecayWeight(Infinity, t0, tNow, 7)).toThrow(TypeError);
    expect(() => linearDecayWeight(-Infinity, t0, tNow, 7)).toThrow(TypeError);
  });
});

describe('linearDecayWeight — invalid Date handling', () => {
  const t0 = new Date('2026-05-06T00:00:00Z');
  const tNow = new Date('2026-05-09T12:00:00Z');

  it('returns 0 when tEvent is an Invalid Date (NaN getTime)', () => {
    expect(linearDecayWeight(100, new Date('not-a-date'), tNow, 7)).toBe(0);
  });

  it('returns 0 when now is an Invalid Date', () => {
    expect(linearDecayWeight(100, t0, new Date('not-a-date'), 7)).toBe(0);
  });

  it('returns 0 when both dates are Invalid', () => {
    expect(linearDecayWeight(100, new Date('a'), new Date('b'), 7)).toBe(0);
  });
});

describe('linearDecayWeight — baseWeight cases (fractional return)', () => {
  const t0 = new Date('2026-05-06T00:00:00Z');
  const tHalf = new Date('2026-05-09T12:00:00Z');

  it('returns 0 when baseWeight is 0 (trivial)', () => {
    expect(linearDecayWeight(0, t0, tHalf, 7)).toBe(0);
  });

  it('returns 0.5 for baseWeight=1 at half-window (no per-rule rounding)', () => {
    // The previously rounded contract returned 1 here — masking the rounding
    // bias and inflating tiny rule contributions. The fractional contract is
    // honest: half-window of 1 unit is exactly 0.5 unit.
    expect(linearDecayWeight(1, t0, tHalf, 7)).toBeCloseTo(0.5, 9);
  });

  it('preserves sign for negative baseWeight (penalty rules supported)', () => {
    expect(linearDecayWeight(-20, t0, tHalf, 7)).toBeCloseTo(-10, 9);
  });

  it('symmetric magnitude for ± baseWeight at the same elapsed (no Math.round bias)', () => {
    // The prior rounded contract was sign-asymmetric: +5 at half-window
    // rounded to 3 while -5 rounded to -2 (Math.round rounds half AWAY from
    // zero for positives but TOWARD zero for negatives). Float math is
    // symmetric: +5 → 2.5, -5 → -2.5.
    const tQuarter = new Date('2026-05-07T18:00:00Z');  // 25% of 7d
    const pos = linearDecayWeight(5, t0, tQuarter, 7);
    const neg = linearDecayWeight(-5, t0, tQuarter, 7);
    expect(pos + neg).toBeCloseTo(0, 9);
    expect(Math.abs(pos)).toBeCloseTo(Math.abs(neg), 9);
  });

  it('handles fractional windowDays correctly', () => {
    // Half of a 0.5-day window = 0.25 days = 6 hours.
    const tQuarterDay = new Date('2026-05-06T06:00:00Z');
    expect(linearDecayWeight(100, t0, tQuarterDay, 0.5)).toBeCloseTo(50, 9);
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

// Sanity check that the documented EPS is comfortably tight enough for any
// single-multiply/single-divide error this function can produce.
describe('linearDecayWeight — float precision sanity', () => {
  it('returns exact integer at exact boundary fractions when math allows', () => {
    const t0 = new Date('2026-05-06T00:00:00Z');
    // Half of a 7-day window is exactly 3.5 days = 302400000 ms.
    // (100/7d * 3.5d) is exactly 50, no float error.
    const tHalf = new Date('2026-05-09T12:00:00Z');
    const w = linearDecayWeight(100, t0, tHalf, 7);
    expect(Math.abs(w - 50)).toBeLessThan(EPS);
  });
});
