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
 * `predicate`, a `weight`, and a `window_days`. Sections that fail to parse
 * (missing fields, etc.) are skipped with a `console.warn` so operators
 * editing the file see the issue without one bad rule blocking recompute.
 *
 * The `## Tier thresholds` section, if present, overrides defaults. Missing
 * or invalid tier sections fall back to the defaults documented in
 * DEFAULT_THRESHOLDS. If the parsed thresholds leave a gap (the upper bound
 * of one tier is more than one less than the lower bound of the next), a
 * warning is emitted — the math still works (`scoreToTier` snaps to the
 * lower tier when in the gap) but the operator likely made a mistake.
 */
export function parseScoringRules(md: string): ParsedRules {
  const rules: ScoringRule[] = [];
  const sections = md.split(/^## /m).slice(1);

  for (const section of sections) {
    const idMatch = section.match(/^(R\d+)/);
    if (!idMatch) continue;
    const id = idMatch[1];

    const predMatch = section.match(/- predicate:\s*`([^`]+)`/);
    const weightMatch = section.match(/- weight:\s*(-?\d+)/);
    const windowMatch = section.match(/- window_days:\s*(\d+)/);

    if (!predMatch || !weightMatch || !windowMatch) {
      const missing: string[] = [];
      if (!predMatch) missing.push('predicate');
      if (!weightMatch) missing.push('weight');
      if (!windowMatch) missing.push('window_days');
      console.warn(`[scoring] rule ${id} skipped — missing field(s): ${missing.join(', ')}`);
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
  // Accept en-dash, em-dash, or ASCII hyphen between bounds. `60+` form means
  // [60, Infinity].
  const tiersFound = new Set<Tier>();
  for (const line of tierBlock.split('\n')) {
    const range = line.match(/- (cold|warm|hot|on_fire):\s*(\d+)\s*[–—-]\s*(\d+)/);
    if (range) {
      result[range[1] as Tier] = [parseInt(range[2], 10), parseInt(range[3], 10)];
      tiersFound.add(range[1] as Tier);
      continue;
    }
    const plus = line.match(/- (cold|warm|hot|on_fire):\s*(\d+)\+/);
    if (plus) {
      result[plus[1] as Tier] = [parseInt(plus[2], 10), Infinity];
      tiersFound.add(plus[1] as Tier);
    }
  }

  // Gap check: between consecutive tiers, the next-lo should be exactly
  // current-hi + 1. Anything else is an operator error worth flagging.
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
 * Precedence: AND binds tighter than OR (`a OR b AND c` parses as
 * `a OR (b AND c)`). No parentheses; nested grouping is intentionally not
 * supported in v1 — operators write multiple rules instead.
 *
 * String-aware: AND / OR / `[` / `]` characters inside single-quoted values
 * are treated as content, not combinators. So `snippet CONTAINS 'foo AND bar'`
 * parses as a single CONTAINS leaf, not as two predicates joined by AND.
 *
 * Failing closed: malformed predicates and unknown ops/fields all return
 * `false` (with a `console.warn`) so one bad rule doesn't break the whole
 * recompute. Operators see the warning in stderr.
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
    console.warn(`[scoring] predicate failed to evaluate (returning false): ${pred}`, err);
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
 *
 * The plan's original `s.split(' AND ')` was unsafe: `snippet CONTAINS
 * 'foo AND bar'` would split inside the quoted string. This walker tracks
 * quote state and bracket depth so combinators only fire at the syntactic
 * top level.
 */
function splitTopLevel(s: string, sep: 'AND' | 'OR'): string[] {
  const parts: string[] = [];
  let buf = '';
  let inString = false;
  let bracketDepth = 0;
  let i = 0;
  const sepWithSpaces = ` ${sep} `;

  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      inString = !inString;
      buf += c;
      i++;
      continue;
    }
    if (!inString) {
      if (c === '[') { bracketDepth++; buf += c; i++; continue; }
      if (c === ']') { bracketDepth--; buf += c; i++; continue; }
      if (bracketDepth === 0 && s.startsWith(sepWithSpaces, i)) {
        parts.push(buf);
        buf = '';
        i += sepWithSpaces.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  parts.push(buf);
  return parts;
}

function evalLeaf(s: string, ev: EvCtx): boolean {
  // CONTAINS '...'  (allow empty string match per documented behavior)
  let m = s.match(/^(\w+)\s+CONTAINS\s+'([^']*)'$/);
  if (m) {
    const fieldVal = pluckField(m[1], ev);
    return typeof fieldVal === 'string' && fieldVal.includes(m[2]);
  }
  // IN ['a', 'b', ...]
  m = s.match(/^(\w+)\s+IN\s+\[([^\]]+)\]$/);
  if (m) {
    const fieldVal = pluckField(m[1], ev);
    if (typeof fieldVal !== 'string') return false;
    const list = m[2].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
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
  return false;  // unsupported operator or malformed leaf
}

function pluckField(name: string, ev: EvCtx): unknown {
  switch (name) {
    case 'source_type': return ev.sourceType;
    case 'signal_type': return ev.signalType;
    case 'snippet': return ev.snippet;
    case 'extracted_fact': return ev.extractedFact;
    case 'confidence': return ev.confidence;
    default: return undefined;
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
 * Floats are accepted (the scoring engine sums fractional weights and only
 * rounds at storage). 14.999 maps to cold; 15.0 to warm — this is the
 * documented behavior. If you want fractional scores to round up, do that
 * before calling `scoreToTier`.
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
