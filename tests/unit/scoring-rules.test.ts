import { describe, it, expect, vi } from 'vitest';
import { parseScoringRules, evalPredicate, scoreToTier } from '../../lib/scoring/rules';

const sampleRules = `
## R1 — Intent
- predicate: \`source_type == 'intent_data' AND signal_type == 'intent'\`
- weight: 20
- window_days: 7

## R2 — Pricing
- predicate: \`source_type == 'web_traffic' AND snippet CONTAINS '/pricing'\`
- weight: 15
- window_days: 3

## Tier thresholds

- cold: 0–14
- warm: 15–34
- hot: 35–59
- on_fire: 60+
`;

// ============================================================================
// parseScoringRules
// ============================================================================

describe('parseScoringRules — rules', () => {
  it('parses rules with id, weight, window, predicate', () => {
    const { rules } = parseScoringRules(sampleRules);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({
      id: 'R1',
      weight: 20,
      windowDays: 7,
      predicate: "source_type == 'intent_data' AND signal_type == 'intent'",
    });
    expect(rules[1].id).toBe('R2');
  });

  it('preserves rule order from the file', () => {
    const md = `
## R3 — Third
- predicate: \`source_type == 'a'\`
- weight: 1
- window_days: 1

## R1 — First
- predicate: \`source_type == 'b'\`
- weight: 1
- window_days: 1

## R2 — Second
- predicate: \`source_type == 'c'\`
- weight: 1
- window_days: 1
`;
    const { rules } = parseScoringRules(md);
    expect(rules.map((r) => r.id)).toEqual(['R3', 'R1', 'R2']);
  });

  it('skips sections that are not Rxx headers', () => {
    const md = `
## Notes
this is a comment block

## R1 — Real rule
- predicate: \`source_type == 'a'\`
- weight: 5
- window_days: 1
`;
    const { rules } = parseScoringRules(md);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('R1');
  });

  it('skips Rxx sections missing required fields (warns rather than throws)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const md = `
## R1 — Missing weight
- predicate: \`source_type == 'a'\`
- window_days: 7

## R2 — Complete
- predicate: \`source_type == 'b'\`
- weight: 5
- window_days: 7
`;
    const { rules } = parseScoringRules(md);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('R2');
    expect(warn).toHaveBeenCalled();  // operator gets a heads-up
    warn.mockRestore();
  });

  it('rejects fractional weight (5.5 must not silently parse as 5)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const md = `
## R1 — Bad
- predicate: \`source_type == 'a'\`
- weight: 5.5
- window_days: 7
`;
    const { rules } = parseScoringRules(md);
    expect(rules).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects window_days with trailing units (7 days must not silently parse as 7)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const md = `
## R1 — Bad
- predicate: \`source_type == 'a'\`
- weight: 5
- window_days: 7 days
`;
    const { rules } = parseScoringRules(md);
    expect(rules).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects window_days = 0 (would divide by zero in linearDecayWeight)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const md = `
## R1 — Bad
- predicate: \`source_type == 'a'\`
- weight: 5
- window_days: 0
`;
    const { rules } = parseScoringRules(md);
    expect(rules).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns the empty rule array when there are no rules', () => {
    const md = `## Tier thresholds\n- cold: 0–14\n- warm: 15–34\n- hot: 35–59\n- on_fire: 60+`;
    const { rules } = parseScoringRules(md);
    expect(rules).toHaveLength(0);
  });
});

describe('parseScoringRules — tier thresholds', () => {
  it('parses tier thresholds (em-dash and ASCII-dash both)', () => {
    const { thresholds } = parseScoringRules(sampleRules);
    expect(thresholds.cold).toEqual([0, 14]);
    expect(thresholds.warm).toEqual([15, 34]);
    expect(thresholds.hot).toEqual([35, 59]);
    expect(thresholds.on_fire).toEqual([60, Infinity]);
  });

  it('parses ASCII-dash form (cold: 0-14) too', () => {
    const md = `
## Tier thresholds
- cold: 0-14
- warm: 15-34
- hot: 35-59
- on_fire: 60+
`;
    const { thresholds } = parseScoringRules(md);
    expect(thresholds.cold).toEqual([0, 14]);
    expect(thresholds.on_fire).toEqual([60, Infinity]);
  });

  it('returns default thresholds when the section is missing entirely', () => {
    const md = `
## R1 — Intent
- predicate: \`source_type == 'a'\`
- weight: 5
- window_days: 1
`;
    const { thresholds } = parseScoringRules(md);
    expect(thresholds.cold).toEqual([0, 14]);
    expect(thresholds.warm).toEqual([15, 34]);
    expect(thresholds.hot).toEqual([35, 59]);
    expect(thresholds.on_fire).toEqual([60, Infinity]);
  });

  it('warns when threshold tiers leave a gap (e.g. cold 0-10 then warm 20-34)', () => {
    // A misconfigured threshold file with a gap between cold and warm. The
    // parser still accepts the values, but emits a warning so the operator
    // sees their mistake rather than getting silently-misclassified scores.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const md = `
## Tier thresholds
- cold: 0–10
- warm: 20–34
- hot: 35–59
- on_fire: 60+
`;
    parseScoringRules(md);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns when threshold tiers overlap (warm starts before cold ends)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const md = `
## Tier thresholds
- cold: 0–20
- warm: 15–34
- hot: 35–59
- on_fire: 60+
`;
    parseScoringRules(md);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('parses em-dash (—) thresholds specifically', () => {
    const md = `
## Tier thresholds
- cold: 0—14
- warm: 15—34
- hot: 35—59
- on_fire: 60+
`;
    const { thresholds } = parseScoringRules(md);
    expect(thresholds.cold).toEqual([0, 14]);
    expect(thresholds.warm).toEqual([15, 34]);
  });

  it('warns on a malformed individual tier line (unrecognized punctuation)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const md = `
## Tier thresholds
- cold: 0..14
- warm: 15–34
- hot: 35–59
- on_fire: 60+
`;
    parseScoringRules(md);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('tolerates whitespace around the colon in tier lines', () => {
    const md = `
## Tier thresholds
- cold : 0–14
- warm  :  15–34
- hot: 35–59
- on_fire: 60+
`;
    const { thresholds } = parseScoringRules(md);
    expect(thresholds.cold).toEqual([0, 14]);
    expect(thresholds.warm).toEqual([15, 34]);
  });
});

// ============================================================================
// evalPredicate
// ============================================================================

describe('evalPredicate — leaf operators', () => {
  const ev = (overrides: Partial<Record<string, string>> = {}) => ({
    sourceType: 'intent_data',
    signalType: 'intent',
    snippet: 'x',
    extractedFact: 'y',
    ...overrides,
  });

  it('matches equality (==)', () => {
    expect(evalPredicate("source_type == 'intent_data'", ev())).toBe(true);
    expect(evalPredicate("source_type == 'web_traffic'", ev())).toBe(false);
  });

  it('matches inequality (!=)', () => {
    expect(evalPredicate("source_type != 'web_traffic'", ev())).toBe(true);
    expect(evalPredicate("source_type != 'intent_data'", ev())).toBe(false);
  });

  it('matches CONTAINS (substring)', () => {
    expect(evalPredicate("snippet CONTAINS '/pricing'",
      ev({ snippet: 'visited /pricing today' }))).toBe(true);
    expect(evalPredicate("snippet CONTAINS '/pricing'",
      ev({ snippet: 'visited /home' }))).toBe(false);
  });

  it('CONTAINS with empty string is always true (every string contains "")', () => {
    // Documented edge: searching for an empty substring matches anything.
    // Operators are unlikely to write this, but the parser handles it
    // gracefully rather than rejecting.
    expect(evalPredicate("snippet CONTAINS ''", ev({ snippet: 'anything' }))).toBe(true);
  });

  it('matches IN list', () => {
    expect(evalPredicate("source_type IN ['press_release', 'news']",
      ev({ sourceType: 'news' }))).toBe(true);
    expect(evalPredicate("source_type IN ['press_release', 'news']",
      ev({ sourceType: 'website' }))).toBe(false);
  });

  it('IN list tolerates extra whitespace and one-element lists', () => {
    expect(evalPredicate("source_type IN [ 'a' , 'b' ]",
      ev({ sourceType: 'a' }))).toBe(true);
    expect(evalPredicate("source_type IN ['onlyone']",
      ev({ sourceType: 'onlyone' }))).toBe(true);
  });

  it('returns false when an unknown field is referenced', () => {
    expect(evalPredicate("nonexistent_field == 'x'", ev())).toBe(false);
  });

  it('returns false for an unsupported operator (>, <, etc.) without throwing', () => {
    expect(evalPredicate("snippet > 'b'", ev())).toBe(false);
  });

  it('returns false on a malformed predicate without throwing, AND warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(evalPredicate('!!!', ev())).toBe(false);
    expect(evalPredicate('source_type ==', ev())).toBe(false);
    // Operator gets a warning per malformed predicate so they see typos in stderr.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns when a typo like HAS instead of CONTAINS is used (regression for silent-fail bug)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(evalPredicate("snippet HAS '/pricing'", ev())).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns when an unknown field is referenced', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(evalPredicate("nonexistent_field == 'x'", ev())).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('evalPredicate — combinators', () => {
  const ev = (overrides: Partial<Record<string, string>> = {}) => ({
    sourceType: 'intent_data',
    signalType: 'intent',
    snippet: 'x',
    extractedFact: 'y',
    ...overrides,
  });

  it('matches AND', () => {
    expect(evalPredicate(
      "source_type == 'intent_data' AND signal_type == 'intent'", ev(),
    )).toBe(true);
    expect(evalPredicate(
      "source_type == 'intent_data' AND signal_type == 'firmographic'", ev(),
    )).toBe(false);
  });

  it('matches OR', () => {
    expect(evalPredicate(
      "source_type == 'intent_data' OR signal_type == 'firmographic'", ev(),
    )).toBe(true);
    expect(evalPredicate(
      "source_type == 'web_traffic' OR signal_type == 'firmographic'", ev(),
    )).toBe(false);
  });

  it('mixed AND/OR uses standard precedence (AND binds tighter than OR)', () => {
    // 'a OR b AND c' === 'a OR (b AND c)'.
    // ev: source_type='intent_data', signal_type='intent', snippet='x'.
    // 'source_type == "web_traffic" OR (source_type == "intent_data" AND signal_type == "intent")'
    // = false OR (true AND true) = true.
    expect(evalPredicate(
      "source_type == 'web_traffic' OR source_type == 'intent_data' AND signal_type == 'intent'",
      ev(),
    )).toBe(true);
  });

  it('does NOT split AND/OR that appear inside quoted strings', () => {
    // Critical bug guard: a naive split on " AND " would break this leaf.
    // The plan's predicate language treats anything inside '...' as content,
    // not as a combinator.
    expect(evalPredicate(
      "snippet CONTAINS 'foo AND bar'",
      { sourceType: 'x', signalType: 'x', snippet: 'we found foo AND bar in there', extractedFact: 'y' },
    )).toBe(true);
    expect(evalPredicate(
      "snippet CONTAINS 'left OR right'",
      { sourceType: 'x', signalType: 'x', snippet: 'looking for left OR right options', extractedFact: 'y' },
    )).toBe(true);
  });

  it('does NOT split AND/OR that appear inside IN lists', () => {
    // Bracketed list values are also opaque to the combinator splitter.
    expect(evalPredicate(
      "source_type IN ['intent_data', 'crm_record'] AND signal_type == 'intent'",
      { sourceType: 'intent_data', signalType: 'intent', snippet: 'x', extractedFact: 'y' },
    )).toBe(true);
  });

  it('IN list correctly handles values containing commas (string-aware list splitter)', () => {
    // The naive `m[2].split(',')` would break this. The new parseQuotedList
    // walks the content extracting quoted literals one at a time, ignoring
    // commas between or inside.
    expect(evalPredicate(
      "extracted_fact IN ['consumer goods, packaged', 'b2b']",
      { sourceType: 'x', signalType: 'x', snippet: 'x',
        extractedFact: 'consumer goods, packaged' },
    )).toBe(true);
    expect(evalPredicate(
      "extracted_fact IN ['consumer goods, packaged', 'b2b']",
      { sourceType: 'x', signalType: 'x', snippet: 'x',
        extractedFact: 'consumer' },
    )).toBe(false);
  });

  it('tolerates flexible whitespace around AND/OR (multi-space, tab, newline)', () => {
    const e = { sourceType: 'a', signalType: 'b', snippet: 'x', extractedFact: 'y' };
    // Multi-space
    expect(evalPredicate("source_type == 'a'    AND    signal_type == 'b'", e)).toBe(true);
    // Tab around AND
    expect(evalPredicate("source_type == 'a'\tAND\tsignal_type == 'b'", e)).toBe(true);
    // Newline around AND
    expect(evalPredicate("source_type == 'a'\nAND\nsignal_type == 'b'", e)).toBe(true);
    // Mixed
    expect(evalPredicate("source_type == 'a' \n  AND \t  signal_type == 'b'", e)).toBe(true);
  });
});

// ============================================================================
// scoreToTier
// ============================================================================

describe('scoreToTier — boundary mapping', () => {
  const thresholds = {
    cold: [0, 14] as [number, number],
    warm: [15, 34] as [number, number],
    hot: [35, 59] as [number, number],
    on_fire: [60, Infinity] as [number, number],
  };

  it('maps each tier at its lower boundary', () => {
    expect(scoreToTier(0, thresholds)).toBe('cold');
    expect(scoreToTier(15, thresholds)).toBe('warm');
    expect(scoreToTier(35, thresholds)).toBe('hot');
    expect(scoreToTier(60, thresholds)).toBe('on_fire');
  });

  it('maps each tier at its upper boundary (just inside next-tier-boundary)', () => {
    expect(scoreToTier(14, thresholds)).toBe('cold');
    expect(scoreToTier(34, thresholds)).toBe('warm');
    expect(scoreToTier(59, thresholds)).toBe('hot');
  });

  it('clamps very large scores to on_fire', () => {
    expect(scoreToTier(999, thresholds)).toBe('on_fire');
    expect(scoreToTier(Number.MAX_SAFE_INTEGER, thresholds)).toBe('on_fire');
  });

  it('clamps negative scores to cold', () => {
    // Penalty rules can produce a negative pre-tier score; tier system maps it
    // to the lowest tier rather than throwing.
    expect(scoreToTier(-100, thresholds)).toBe('cold');
  });

  it('rounds fractional scores down to the lower tier', () => {
    // Scores arrive from computeScore as floats (decay returns float). The
    // tier function uses >= comparisons, so 14.999 maps to cold even though
    // 15.0 maps to warm. Documented behavior.
    expect(scoreToTier(14.999, thresholds)).toBe('cold');
    expect(scoreToTier(15.0, thresholds)).toBe('warm');
  });
});
