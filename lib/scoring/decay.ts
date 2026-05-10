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
 * **Returns a fractional weight, NOT a rounded integer.** Per-rule rounding
 * was a bug: a `baseWeight=5` rule rounded to `0` for the last ~10% of its
 * window, silently dropping signal. The scoring-engine consumer is expected
 * to sum these fractions across all matching rules and round only at the
 * final score, so total precision is preserved and the sign-asymmetry of
 * `Math.round` (which rounds `+0.5 → +1` but `-0.5 → -0`) doesn't introduce
 * per-rule bias.
 *
 * Inputs:
 *   - `baseWeight`: any finite number (positive or negative). NaN / Infinity
 *     throw `TypeError` — these would propagate undetected through the
 *     scoring engine's sum and corrupt the final score for every account.
 *     Negative values are supported (penalty rules — a scoring rule may
 *     dock score for a stale signal).
 *   - `tEvent`: when the event was captured. If the underlying Date is
 *     invalid (NaN getTime), returns 0 — invalid timestamps do not
 *     contribute, rather than propagating NaN through the score arithmetic.
 *   - `now`: the moment we're scoring at. Same NaN-handling as `tEvent`.
 *   - `windowDays`: must be a finite positive number (integer or fractional).
 *     0, negative, NaN, Infinity, -Infinity are caller errors and throw
 *     `TypeError`. Production rules go through the parser in
 *     `lib/scoring/rules.ts` which enforces a positive integer; this guard
 *     is defense-in-depth against misuse from elsewhere.
 *
 * Clock-skew guard: if `tEvent > now` (the event is in the future, almost
 * always indicating a clock skew between producer and ingest), returns 0
 * rather than producing a negative-elapsed scaling factor that would
 * over-weight future events.
 *
 * Pure: does not mutate either Date input.
 */
export function linearDecayWeight(
  baseWeight: number,
  tEvent: Date,
  now: Date,
  windowDays: number,
): number {
  if (!Number.isFinite(baseWeight)) {
    throw new TypeError(
      `baseWeight must be a finite number; got ${baseWeight}`,
    );
  }
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
  return baseWeight * (1 - elapsedMs / windowMs);
}
