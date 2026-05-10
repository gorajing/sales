/**
 * Small display formatters shared across the UI surface. Pure functions —
 * unit-tested separately so the component code doesn't have to construct
 * a renderer just to assert a string shape.
 */

/**
 * Render a numeric weight with explicit sign, up to 2 decimal places,
 * stripping trailing zeros. Designed for `ScoreRationale` rows where the
 * weight may be negative (penalty rules), fractional (time-decay), or
 * zero (edge cases worth surfacing).
 *
 *   +2     → '+2'
 *   +2.5   → '+2.5'
 *   +2.523 → '+2.52'
 *   -2.5   → '-2.5'   (never '+-2.5')
 *    0     → '+0'
 *   -0     → '+0'     (canonicalize negative zero to positive)
 *
 * Non-finite inputs (NaN, Infinity) render as '?' rather than 'NaN' /
 * 'Infinity' — those should never reach the UI but we guard rather than
 * displaying a confusing literal.
 */
export function fmtWeight(w: number): string {
  if (!Number.isFinite(w)) return '?';
  // Normalize -0 → 0 before sign check so a near-zero negative doesn't render
  // as '-0'. Math.round(w * 100) / 100 also collapses -0.001 to 0.
  const rounded = Math.round(w * 100) / 100;
  const normalized = rounded === 0 ? 0 : rounded;
  const sign = normalized < 0 ? '' : '+';  // negative already carries its '-'
  // Strip trailing zeros via Number → String round-trip; '2.50' becomes '2.5'.
  return `${sign}${normalized}`;
}

/**
 * Truncate a string to at most `maxLen` characters, appending an ellipsis
 * when truncated so the reader knows content was cut. Operates on UTF-16
 * code units (JS string length), which is fine for the ASCII-heavy
 * snippets v2 ingests — a multi-byte snippet would still render
 * correctly, the cut just might land mid-character. Acceptable for a
 * display-only truncation.
 */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}
