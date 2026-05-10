import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tier } from '../scoring/rules';

/**
 * Routing rules — parsed from `data/routing-rules.md` and used by `route()` to
 * pick an owner email for a scored account.
 *
 * Design contract (diverges from scoring's rule parser in important ways):
 *
 *   1. **Parse-time strict, eval-time total.** parseRoutingRules throws on any
 *      malformed rule (missing field, unknown field name in predicate,
 *      unsupported operator, invalid owner email). evalRoutingPredicate takes
 *      a pre-parsed AST and walks it — it cannot fail. This means an
 *      operator who saves a typo'd routing-rules.md sees one clear error
 *      *before* any traffic hits the routing engine, instead of a silently
 *      mis-routed lead later.
 *
 *      Scoring's parser is permissive (skips malformed rules with a warn)
 *      because one bad rule out of many shouldn't poison the whole scoring
 *      pass. Routing is the opposite: routing rules are *fewer* and *load-
 *      bearing*, and partial application would route some leads correctly
 *      and others to the wrong owner. No partial success.
 *
 *   2. **Field whitelist enforced at parse time.** Only `tier`,
 *      `firmographic_size`, and `industry` are allowed. Adding a field
 *      requires touching this file, RoutingContext, the whitelist, and the
 *      evaluator's pluck step — defense against operator typos
 *      (`firmographic_sze`) being silently always-false.
 *
 *   3. **Hash over parsed semantics, not raw markdown.** hashRoutingRules
 *      JSON-encodes the array of parsed rules (id, priority, predicate
 *      source string, ownerEmail) and hashes that. Comment-only or
 *      whitespace-only edits don't churn assignments; predicate or
 *      owner_email edits do. (We hash the predicate *source string*, not
 *      the AST, so hash stability doesn't depend on AST representation
 *      decisions that may change between revisions.)
 *
 *   4. **Deterministic tie-break.** Rules are sorted by (priority ASC, id
 *      ASC). Two rules with the same priority always evaluate in the same
 *      order regardless of authoring order in the file.
 *
 *   5. **owner_email normalized.** Trimmed and lower-cased at parse time
 *      (so `AE@X.COM` and `ae@x.com` are the same router). A basic shape
 *      check (`<local>@<domain>.<tld>`) is required — full RFC validation
 *      is out of scope.
 */

// ---------------------------------------------------------------------------
// AST + types
// ---------------------------------------------------------------------------

/** Allowed predicate field names. Extending this set requires updating
 *  RoutingContext, the parser's whitelist check, and the eval pluck. */
const FIELDS = ['tier', 'firmographic_size', 'industry'] as const;
type Field = (typeof FIELDS)[number];

/** Discriminated union AST for predicates. Evaluator walks this; can't fail. */
export type PredicateAst =
  | { kind: 'eq'; field: Field; value: string }
  | { kind: 'ne'; field: Field; value: string }
  | { kind: 'in'; field: Field; values: string[] }
  | { kind: 'and'; left: PredicateAst; right: PredicateAst }
  | { kind: 'or'; left: PredicateAst; right: PredicateAst };

export interface RoutingRule {
  id: string;            // `RR\d+`
  priority: number;      // non-negative integer
  predicate: string;     // original source string (hashed for stability)
  predicateAst: PredicateAst;  // parsed form (used by the engine)
  ownerEmail: string;    // normalized: trimmed + lowercased
}

export interface RoutingContext {
  tier: Tier;
  firmographicSize?: string;
  industry?: string;
}

/** Thrown by parseRoutingRules when the file has any structural problem.
 *  The message aggregates ALL problems found across all sections, so the
 *  operator can fix them in one round-trip instead of N. */
export class RoutingRuleParseError extends Error {
  constructor(problems: string[]) {
    super(`Routing rules file is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'RoutingRuleParseError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseRoutingRules(md: string): RoutingRule[] {
  const problems: string[] = [];
  const rules: RoutingRule[] = [];
  const seenIds = new Set<string>();
  const sections = md.split(/^## /m).slice(1);

  for (const section of sections) {
    const idMatch = section.match(/^(RR\d+)/);
    if (!idMatch) continue;  // not a rule section (doc heading, etc.)
    const id = idMatch[1];

    if (seenIds.has(id)) {
      problems.push(`duplicate rule id "${id}" — each RR\\d+ heading must be unique`);
      // Don't `continue` — keep parsing to surface ALL problems, but skip
      // the body to avoid double-reporting field issues against the dup.
      continue;
    }
    seenIds.add(id);

    const ruleProblems: string[] = [];

    // priority: non-negative integer, end-of-line anchored.
    const priorityMatch = section.match(/^- priority:\s*(-?\d+)\s*$/m);
    let priority: number | null = null;
    if (!priorityMatch) {
      ruleProblems.push(`${id}: missing or malformed "- priority: <integer>"`);
    } else {
      const p = parseInt(priorityMatch[1], 10);
      if (p < 0) {
        ruleProblems.push(`${id}: priority must be non-negative, got ${p}`);
      } else {
        priority = p;
      }
    }

    // predicate: backtick-quoted on a bullet line.
    const predMatch = section.match(/- predicate:\s*`([^`]+)`/);
    let predicate: string | null = null;
    let predicateAst: PredicateAst | null = null;
    if (!predMatch) {
      ruleProblems.push(`${id}: missing "- predicate: \\\`<expr>\\\`"`);
    } else {
      predicate = predMatch[1].trim();
      try {
        predicateAst = parsePredicate(predicate);
      } catch (err) {
        ruleProblems.push(`${id}: predicate "${predicate}" — ${(err as Error).message}`);
      }
    }

    // owner_email: trimmed, lower-cased, basic shape.
    const ownerMatch = section.match(/- owner_email:\s*(\S.*?)\s*$/m);
    let ownerEmail: string | null = null;
    if (!ownerMatch) {
      ruleProblems.push(`${id}: missing "- owner_email: <email>"`);
    } else {
      const candidate = ownerMatch[1].trim().toLowerCase();
      // <local>@<host>.<tld> — at least one dot after the @, no whitespace.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) {
        ruleProblems.push(`${id}: owner_email "${ownerMatch[1]}" doesn't look like an email`);
      } else {
        ownerEmail = candidate;
      }
    }

    if (ruleProblems.length > 0) {
      problems.push(...ruleProblems);
      continue;
    }

    rules.push({
      id,
      priority: priority!,
      predicate: predicate!,
      predicateAst: predicateAst!,
      ownerEmail: ownerEmail!,
    });
  }

  if (problems.length > 0) throw new RoutingRuleParseError(problems);

  // Deterministic order: priority ASC, then id ASC. This makes equal-priority
  // tie-breaking independent of the operator's authoring order in the file.
  rules.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rules;
}

export function evalRoutingPredicate(ast: PredicateAst, ctx: RoutingContext): boolean {
  switch (ast.kind) {
    case 'eq': {
      const v = pluck(ast.field, ctx);
      return v === ast.value;
    }
    case 'ne': {
      const v = pluck(ast.field, ctx);
      // Undefined-field on != should NOT match — "industry != 'finance'" against
      // an account with industry = undefined is neither true nor obviously
      // false, but matching feels like a bug magnet (it would route accounts
      // missing industry to "everything except finance" rules). Treat as false.
      if (v === undefined) return false;
      return v !== ast.value;
    }
    case 'in': {
      const v = pluck(ast.field, ctx);
      return typeof v === 'string' && ast.values.includes(v);
    }
    case 'and':
      return evalRoutingPredicate(ast.left, ctx) && evalRoutingPredicate(ast.right, ctx);
    case 'or':
      return evalRoutingPredicate(ast.left, ctx) || evalRoutingPredicate(ast.right, ctx);
  }
}

/**
 * Hash the routing rules file over its **parsed semantics**, not raw bytes.
 *
 * This makes hashRoutingRules stable under comment-only and whitespace-only
 * edits — an operator adding a note doesn't churn every routing assignment
 * downstream. It is sensitive to: rule id additions/removals, priority changes,
 * predicate text changes, and owner_email changes. predicateAst is NOT in the
 * hash; we hash the predicate source string instead so AST representation
 * changes between revisions don't invalidate every assignment.
 *
 * If the file is malformed, hashRoutingRules throws the same error
 * parseRoutingRules would — callers should never see a "hash of an invalid
 * file" because there shouldn't be one.
 */
export function hashRoutingRules(md: string): string {
  const rules = parseRoutingRules(md);
  const canonical = rules.map((r) => ({
    id: r.id,
    priority: r.priority,
    predicate: r.predicate,
    ownerEmail: r.ownerEmail,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

export function loadRoutingRulesFromDisk(
  path = resolve(process.cwd(), 'data/routing-rules.md'),
): RoutingRule[] {
  return parseRoutingRules(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// Predicate parser (recursive on top-level AND / OR; mirrors scoring's
// string-aware splitter)
// ---------------------------------------------------------------------------

function parsePredicate(s: string): PredicateAst {
  // OR has lowest precedence — split first.
  const orParts = splitTopLevel(s, 'OR');
  if (orParts.length > 1) {
    return orParts.map((p) => parsePredicate(p)).reduce((acc, cur) => ({
      kind: 'or', left: acc, right: cur,
    }));
  }
  // Then AND.
  const andParts = splitTopLevel(s, 'AND');
  if (andParts.length > 1) {
    return andParts.map((p) => parsePredicate(p)).reduce((acc, cur) => ({
      kind: 'and', left: acc, right: cur,
    }));
  }
  return parseLeaf(s.trim());
}

function parseLeaf(s: string): PredicateAst {
  // IN ['v1', 'v2', ...]
  let m = s.match(/^(\w+)\s+IN\s+\[([^\]]*)\]$/);
  if (m) {
    const field = requireField(m[1], s);
    const inner = m[2].trim();
    // Enforce strict list grammar: each element must be a single-quoted
    // string, comma-separated, optional whitespace. Empty list is allowed but
    // would never match anything, so we treat it as a parse error rather than
    // a silent dead rule.
    if (inner === '') throw new Error('IN list is empty (a rule that can never match is almost certainly a typo)');
    if (!/^'[^']*'(\s*,\s*'[^']*')*$/.test(inner)) {
      throw new Error(`malformed IN list (expected ['v1', 'v2', ...]): "[${m[2]}]"`);
    }
    const values = [...inner.matchAll(/'([^']*)'/g)].map((q) => q[1]);
    return { kind: 'in', field, values };
  }
  // == 'value'
  m = s.match(/^(\w+)\s*==\s*'([^']*)'$/);
  if (m) {
    const field = requireField(m[1], s);
    return { kind: 'eq', field, value: m[2] };
  }
  // != 'value'
  m = s.match(/^(\w+)\s*!=\s*'([^']*)'$/);
  if (m) {
    const field = requireField(m[1], s);
    return { kind: 'ne', field, value: m[2] };
  }
  // Bare bareword == bareword is a common operator typo (`tier == hot` — they
  // forgot the quotes). Catch this *before* the generic failure message so
  // the error explains the fix.
  m = s.match(/^(\w+)\s*(?:==|!=)\s*(\w+)\s*$/);
  if (m) {
    throw new Error(`string value must be single-quoted (got bareword "${m[2]}"; write '${m[2]}')`);
  }
  throw new Error(`unsupported or malformed predicate leaf: "${s}" — allowed operators are ==, !=, IN`);
}

function requireField(name: string, leafSource: string): Field {
  if ((FIELDS as readonly string[]).includes(name)) return name as Field;
  throw new Error(`unknown field "${name}" in leaf "${leafSource}" — allowed fields are ${FIELDS.join(', ')}`);
}

function pluck(field: Field, ctx: RoutingContext): string | undefined {
  switch (field) {
    case 'tier': return ctx.tier;
    case 'firmographic_size': return ctx.firmographicSize;
    case 'industry': return ctx.industry;
  }
}

/**
 * Split a predicate string at top-level occurrences of `<sep>` while ignoring
 * occurrences inside single-quoted values or square-bracketed lists.
 * Mirrors the scoring splitter so the routing DSL has identical lexical rules.
 * Whitespace-tolerant: any amount of whitespace around the keyword counts as
 * a separator.
 */
function splitTopLevel(s: string, sep: 'AND' | 'OR'): string[] {
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
