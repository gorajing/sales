import { describe, it, expect } from 'vitest';
import { fmtWeight, truncate } from '../../components/format';

describe('fmtWeight', () => {
  it('renders positive integers with a leading +', () => {
    expect(fmtWeight(2)).toBe('+2');
    expect(fmtWeight(20)).toBe('+20');
  });

  it('renders negative numbers with their own - (no double sign)', () => {
    expect(fmtWeight(-2)).toBe('-2');
    expect(fmtWeight(-2.5)).toBe('-2.5');
  });

  it('rounds to 2 decimal places and strips trailing zeros', () => {
    expect(fmtWeight(2.5)).toBe('+2.5');
    expect(fmtWeight(2.523)).toBe('+2.52');
    expect(fmtWeight(2.527)).toBe('+2.53');
    expect(fmtWeight(2.0)).toBe('+2');
  });

  it('canonicalizes zero to +0 (no -0)', () => {
    expect(fmtWeight(0)).toBe('+0');
    expect(fmtWeight(-0)).toBe('+0');
    expect(fmtWeight(-0.001)).toBe('+0');  // collapses to 0 after rounding
  });

  it('renders ? for non-finite inputs rather than the JS literal', () => {
    expect(fmtWeight(NaN)).toBe('?');
    expect(fmtWeight(Infinity)).toBe('?');
    expect(fmtWeight(-Infinity)).toBe('?');
  });
});

describe('truncate', () => {
  it('returns the original string when shorter than maxLen', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });

  it('returns the original when equal to maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('cuts and appends an ellipsis when longer', () => {
    expect(truncate('abcdefghij', 6)).toBe('abcde…');
    // Total length is at most maxLen (5 chars + 1-char ellipsis = 6).
    expect(truncate('abcdefghij', 6).length).toBe(6);
  });

  it('handles maxLen=1 by returning just the ellipsis', () => {
    expect(truncate('abcd', 1)).toBe('…');
  });
});
