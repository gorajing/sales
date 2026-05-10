import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ScoringRule {
  id: string;
  predicate: string;
  weight: number;
  windowDays: number;
}

export type Tier = 'cold' | 'warm' | 'hot' | 'on_fire';

export interface TierThresholds {
  cold: [number, number];
  warm: [number, number];
  hot: [number, number];
  on_fire: [number, number];
}

export interface ParsedRules {
  rules: ScoringRule[];
  thresholds: TierThresholds;
}

const DEFAULT_THRESHOLDS: TierThresholds = {
  cold: [0, 14], warm: [15, 34], hot: [35, 59], on_fire: [60, Infinity],
};

// ============================================================================
// parseScoringRules
// ============================================================================

/**
 * Parse a `data/scoring-rules.md` file into structured rules + tier thresholds.
 *
 * Sections beginning with `## R<digits>` are rules; each must declare a
 * `predicate`, an integer `weight`, and a positive integer `window_days`.
 * Sections that fail to parse are skipped with a `console.warn` so operators
 * editing the file see the issue without one bad rule blocking recompute.
 *
 * The `## Tier thresholds` section, if present, overrides defaults. Missing
 * or invalid tier sections fall back per-tier to the defaults documented in
 * DEFAULT_THRESHOLDS, with a warning when a tier line exists but doesn't
 * parse. If the parsed thresholds leave a gap or overlap between consecutive
 * tiers, a warning is emitted (`scoreToTier` snaps to the lower tier in a
 * gap, but the operator likely made a mistake).
 *
 * Numeric fields are anchored to end-of-line: `weight: 5.5` or `weight: 7 days`
 * are rejected with a warning rather than silently parsing as `5` and `7`.
 */
export function parseScoringRules(md: string): ParsedRules {
  const rules: ScoringRule[] = [];
  const sections = md.split(/^## /m).slice(1);

  for (const section of sections) {
    const idMatch = section.match(/^(R\d+)/);
    if (!idMatch) continue;
    const id = idMatch[1];

    const predMatch = section.match(/- predicate:\s*`([^`]+)`/);
    // Anchored to end-of-line so `weight: 5.5` and `window_days: 7 days`
    // are rejected rather than silently parsed as integers.
    const weightMatch = section.match(/^- weight:\s*(-?\d+)\s*$/m);
    const windowMatch = section.match(/^- window_days:\s*(\d+)\s*$/m);

    if (!predMatch || !weightMatch || !windowMatch) {
      const missing: string[] = [];
      if (!predMatch) missing.push('predicate');
      if (!weightMatch) missing.push('weight (must be integer, no units, no decimals)');
      if (!windowMatch) missing.push('window_days (must be positive integer)');
      console.warn(`[scoring] rule ${id} skipped — missing/invalid field(s): ${missing.join(', ')}`);
      continue;
    }

    const windowDays = parseInt(windowMatch[1], 10);
    if (windowDays <= 0) {
      console.warn(`[scoring] rule ${id} skipped — window_days must be positive, got ${windowDays}`);
      continue;
    }

    rules.push({
      id,
      predicate: predMatch[1],
      weight: parseInt(weightMatch[1], 10),
      windowDays,
    });
  }

  const thresholds = parseTierThresholds(md);
  return { rules, thresholds };
}

function parseTierThresholds(md: string): TierThresholds {
  const tierBlock = md.split(/^## Tier thresholds/m)[1];
  if (tierBlock === undefined) return { ...DEFAULT_THRESHOLDS };

  const result: TierThresholds = { ...DEFAULT_THRESHOLDS };
  // Look for any tier lines (matched or not). Whitespace-tolerant around
  // colons; en-dash, em-dash, and ASCII hyphen all accepted between bounds.
  const tierLineRe = /^- (cold|warm|hot|on_fire)\s*:.*$/gm;
  const rangeRe = /^- (cold|warm|hot|on_fire)\s*:\s*(\d+)\s*[–—-]\s*(\d+)\s*$/m;
  const plusRe = /^- (cold|warm|hot|on_fire)\s*:\s*(\d+)\s*\+\s*$/m;

  for (const lineMatch of tierBlock.matchAll(tierLineRe)) {
    const line = lineMatch[0];
    const tier = lineMatch[1] as Tier;
    const range = line.match(rangeRe);
    if (range) {
      result[tier] = [parseInt(range[2], 10), parseInt(range[3], 10)];
      continue;
    }
    const plus = line.match(plusRe);
    if (plus) {
      result[tier] = [parseInt(plus[2], 10), Infinity];
      continue;
    }
    console.warn(`[scoring] tier line for "${tier}" did not parse; using default`);
  }

  // Gap / overlap check for contiguity. Each next-lo should be exactly
  // current-hi + 1.
  const order: Tier[] = ['cold', 'warm', 'hot', 'on_fire'];
  for (let i = 0; i < order.length - 1; i++) {
    const cur = result[order[i]];
    const nxt = result[order[i + 1]];
    if (nxt[0] !== cur[1] + 1) {
      console.warn(
        `[scoring] tier thresholds have a gap or overlap between ${order[i]}` +
        ` (ends at ${cur[1]}) and ${order[i + 1]} (starts at ${nxt[0]})`,
      );
    }
  }

  return result;
}

// ============================================================================
// evalPredicate
// ============================================================================

/**
 * Mini predicate evaluator. Supported grammar:
 *
 *     pred  ::= leaf | pred AND pred | pred OR pred
 *     leaf  ::= field op value
 *     op    ::= == | != | CONTAINS | IN
 *     field ::= source_type | signal_type | snippet | extracted_fact | confidence
 *     value ::= 'string' | ['string', 'string', ...]
 *
 * Precedence: AND binds tighter than OR (so `a OR b AND c` parses as
 * `a OR (b AND c)`). No parentheses; nested grouping is intentionally not
 * supported in v1 — operators write multiple rules instead.
 *
 * Whitespace-tolerant: any whitespace around AND/OR is accepted (multi-space,
 * tab, newline). Whitespace inside quoted strings is preserved as content.
 *
 * String-aware: AND, OR, `[`, `]`, and `,` characters inside single-quoted
 * values are treated as content, not combinators or list separators. So
 * `snippet CONTAINS 'foo AND bar'` parses as a single CONTAINS leaf, and
 * `IN ['a,b', 'c']` correctly produces the list `['a,b', 'c']`.
 *
 * Failing closed: unsupported operators, malformed leaves, and unknown fields
 * all return `false` and emit a `console.warn` (so operators see the typo
 * in stderr after editing). Other rules continue evaluating normally.
 */
export function evalPredicate(
  pred: string,
  ev: {
    sourceType: string;
    signalType: string;
    snippet: string;
    extractedFact: string;
    confidence?: string;
  },
): boolean {
  try {
    return evalAndOr(pred.trim(), ev);
  } catch (err) {
    console.warn(`[scoring] predicate failed to evaluate (returning false): ${pred} — ${(err as Error).message}`);
    return false;
  }
}

interface EvCtx {
  sourceType: string;
  signalType: string;
  snippet: string;
  extractedFact: string;
  confidence?: string;
}

function evalAndOr(s: string, ev: EvCtx): boolean {
  const orParts = splitTopLevel(s, 'OR');
  if (orParts.length > 1) return orParts.some((p) => evalAndOr(p, ev));
  const andParts = splitTopLevel(s, 'AND');
  if (andParts.length > 1) return andParts.every((p) => evalAndOr(p, ev));
  return evalLeaf(s.trim(), ev);
}

/**
 * Split a predicate string at top-level occurrences of `<sep>` while ignoring
 * occurrences inside single-quoted values or square-bracketed lists.
 * Whitespace-tolerant: any amount of whitespace (including tabs, newlines)
 * around the keyword counts as a separator.
 */
function splitTopLevel(s: string, sep: 'AND' | 'OR'): string[] {
  // Find boundary positions by walking the string with quote/bracket state.
  // At each top-level position, peek ahead for `\s+SEP\s+`.
  const sepRe = new RegExp(`^\\s+${sep}\\s+`);
  const positions: Array<{ start: number; end: number }> = [];
  let inString = false;
  let bracketDepth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") { inString = !inString; i++; continue; }
    if (!inString) {
      if (c === '[') { bracketDepth++; i++; continue; }
      if (c === ']') { bracketDepth--; i++; continue; }
      if (bracketDepth === 0) {
        const m = s.slice(i).match(sepRe);
        if (m) {
          positions.push({ start: i, end: i + m[0].length });
          i += m[0].length;
          continue;
        }
      }
    }
    i++;
  }
  if (positions.length === 0) return [s];
  const parts: string[] = [];
  let lastEnd = 0;
  for (const p of positions) {
    parts.push(s.slice(lastEnd, p.start));
    lastEnd = p.end;
  }
  parts.push(s.slice(lastEnd));
  return parts;
}

/**
 * Pull quoted-string literals out of an `IN` list's content. Walks the input
 * extracting `'...'` literals one at a time, so commas inside a value (like
 * `'a,b'`) don't get mis-split.
 *
 * Limitation: there is no escape syntax for embedded apostrophes. A value
 * with an apostrophe (e.g. `O'Reilly`) is unrepresentable in this DSL.
 */
function parseQuotedList(content: string): string[] {
  const re = /'([^']*)'/g;
  const items: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function evalLeaf(s: string, ev: EvCtx): boolean {
  // CONTAINS '...'  (allow empty string match per documented behavior)
  let m = s.match(/^(\w+)\s+CONTAINS\s+'([^']*)'$/);
  if (m) {
    const fieldVal = pluckField(m[1], ev);
    return typeof fieldVal === 'string' && fieldVal.includes(m[2]);
  }
  // IN ['a', 'b', ...]
  m = s.match(/^(\w+)\s+IN\s+\[([^\]]*)\]$/);
  if (m) {
    const fieldVal = pluckField(m[1], ev);
    if (typeof fieldVal !== 'string') return false;
    const list = parseQuotedList(m[2]);
    return list.includes(fieldVal);
  }
  // == '...'
  m = s.match(/^(\w+)\s*==\s*'([^']*)'$/);
  if (m) {
    const fieldVal = pluckField(m[1], ev);
    return typeof fieldVal === 'string' && fieldVal === m[2];
  }
  // != '...'
  m = s.match(/^(\w+)\s*!=\s*'([^']*)'$/);
  if (m) {
    const fieldVal = pluckField(m[1], ev);
    if (typeof fieldVal !== 'string') return false;
    return fieldVal !== m[2];
  }
  // Nothing matched. Throw so evalPredicate's catch surfaces ONE warning per
  // rule per recompute (operator gets a clear typo signal in stderr).
  throw new Error(`unsupported or malformed leaf: "${s}"`);
}

function pluckField(name: string, ev: EvCtx): unknown {
  switch (name) {
    case 'source_type': return ev.sourceType;
    case 'signal_type': return ev.signalType;
    case 'snippet': return ev.snippet;
    case 'extracted_fact': return ev.extractedFact;
    case 'confidence': return ev.confidence;
    default:
      // Unknown field — typo or schema drift. Warn so operator notices;
      // returning undefined makes the leaf return false, so the rule won't
      // accidentally fire.
      console.warn(`[scoring] unknown field in predicate: "${name}"`);
      return undefined;
  }
}

// ============================================================================
// scoreToTier
// ============================================================================

/**
 * Map a score to its tier using the configured thresholds. Uses each tier's
 * lower bound for the comparison (a score equal to a tier's `lo` is in that
 * tier). Negative scores collapse to `cold`; very large scores to `on_fire`.
 *
 * Tiers are assumed to be contiguous — the gap/overlap warning at parse time
 * surfaces operator misconfigurations. Upper bounds in the threshold tuples
 * are advisory (used by the parser's gap detector) rather than enforced
 * here, so a misconfigured threshold file can't make a score "fall through"
 * tiers; the lowest matching `lo` wins.
 *
 * Floats are accepted (the scoring engine sums fractional weights and only
 * rounds at storage). 14.999 maps to cold; 15.0 to warm — documented behavior.
 */
export function scoreToTier(score: number, t: TierThresholds): Tier {
  if (score >= t.on_fire[0]) return 'on_fire';
  if (score >= t.hot[0]) return 'hot';
  if (score >= t.warm[0]) return 'warm';
  return 'cold';
}

// ============================================================================
// loadScoringRulesFromDisk
// ============================================================================

export function loadScoringRulesFromDisk(
  path = resolve(process.cwd(), 'data/scoring-rules.md'),
): ParsedRules {
  return parseScoringRules(readFileSync(path, 'utf8'));
}
