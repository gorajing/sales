import { describe, it, expect } from 'vitest';
import { isUniqueViolation } from '../../lib/db-errors';

/**
 * `isUniqueViolation` is the load-bearing decision in every
 * SELECT-then-INSERT idempotency path (signals, engagement, routing,
 * alerts): on an INSERT throw, "is this the recoverable lost-the-race
 * case (UNIQUE/PK) or a real bug (FK/NOT NULL/CHECK) that must
 * propagate?" codex Phase 4 r1 noted the concurrent catch/reselect
 * path isn't directly integration-tested (it needs true concurrency);
 * this pins the classifier itself — the part most likely to regress
 * and the part that decides whether a race is absorbed or a real FK
 * bug is (correctly) surfaced as a 500.
 */
describe('isUniqueViolation', () => {
  it('is TRUE for UNIQUE and PRIMARY KEY violations (the recoverable race)', () => {
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe(true);
  });

  it('is FALSE for FK / NOT NULL / CHECK — real bugs that MUST propagate', () => {
    // If this ever returned true for an FK violation, an
    // attach-or-fail / missing-parent bug would be silently swallowed
    // as a "dedupe" instead of surfacing. Load-bearing negative.
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })).toBe(false);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_NOTNULL' })).toBe(false);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_CHECK' })).toBe(false);
  });

  it('is FALSE for non-DB / shapeless errors (no code, plain Error, null)', () => {
    expect(isUniqueViolation(new Error('network'))).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('SQLITE_CONSTRAINT_UNIQUE')).toBe(false);
  });
});
