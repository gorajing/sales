const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Linear time-decay for scoring rule weights.
 *
 * Computes the contribution of a time-stamped event to a scoring rule's
 * weight, decaying linearly from `baseWeight` at the moment of the event
 * to `0` at `tEvent + windowDays`. Outside the window, returns `0`.
 *
 *   weight(t) = baseWeight * (1 - elapsed/window)   for elapsed ∈ [0, window)
 *   weight(t) = 0                                   for elapsed ∉ [0, window)
 *
 * Inputs:
 *   - `baseWeight`: any finite number. Negative values are supported (penalty
 *     rules — a scoring rule may dock score for a stale signal). The result
 *     is always rounded with JS `Math.round`, which rounds half away from
 *     zero for positives (so `baseWeight=1` at half-window → 1, not 0).
 *     Acceptable for scoring because production rules typically have
 *     `baseWeight ≥ 5`.
 *   - `tEvent`: when the event was captured. If the underlying Date is
 *     invalid (NaN getTime), returns 0.
 *   - `now`: the moment we're scoring at. Same NaN-handling as `tEvent`.
 *   - `windowDays`: must be a finite positive number (integer or fractional).
 *     0, negative, NaN, and Infinity are caller errors and throw `TypeError`.
 *     Production rules go through the parser in `lib/scoring/rules.ts` which
 *     enforces a positive integer; this guard is defense-in-depth against
 *     misuse from elsewhere.
 *
 * Clock-skew guard: if `tEvent > now` (the event is in the future, almost
 * always indicating a clock skew between producer and ingest), returns 0
 * rather than producing a negative-elapsed scaling factor.
 *
 * Pure: does not mutate either Date input.
 */
export function linearDecayWeight(
  baseWeight: number,
  tEvent: Date,
  now: Date,
  windowDays: number,
): number {
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new TypeError(
      `windowDays must be a finite positive number; got ${windowDays}`,
    );
  }
  const eventMs = tEvent.getTime();
  const nowMs = now.getTime();
  if (Number.isNaN(eventMs) || Number.isNaN(nowMs)) return 0;
  const elapsedMs = nowMs - eventMs;
  if (elapsedMs < 0) return 0;
  const windowMs = windowDays * MS_PER_DAY;
  if (elapsedMs >= windowMs) return 0;
  return Math.round(baseWeight * (1 - elapsedMs / windowMs));
}
