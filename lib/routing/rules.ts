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
 *      JSON-encodes (rule id, priority, predicate AST, ownerEmail) and
 *      hashes that. Comment-only, whitespace-only, AND predicate-internal
 *      whitespace edits don't churn assignments; semantic predicate edits
 *      and owner_email edits do. (We hash the AST rather than the source
 *      string, so lexical noise — extra spaces around operators, etc. —
 *      doesn't invalidate downstream assignments.) For route()'s
 *      idempotency, use hashRoutingConfig(rules, defaultOwnerEmail)
 *      below — it folds the fallback owner into the hash so that
 *      changing DEFAULT_OWNER_EMAIL invalidates fallback assignments.
 *
 *   4. **Deterministic numeric tie-break.** Rules are sorted by
 *      (priority ASC, numeric id suffix ASC). So RR2 beats RR10 when
 *      priorities tie — operator-intuitive rather than lexicographic
 *      (where '1' < '2' would silently re-order policy past RR9).
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

/** Allowed tier values — only this field is enum-validated at parse time.
 *  firmographic_size and industry are free-form text columns so the parser
 *  can't enumerate their valid values. Tier comes from a hard-coded scoring
 *  union (lib/scoring/rules.ts:Tier) so we CAN validate it, and a typo'd
 *  tier literal (`'hots'`) silently becomes a dead rule otherwise. */
const TIER_VALUES = new Set(['cold', 'warm', 'hot', 'on_fire']);

/** Shape regex for a routing owner email: <local>@<host>.<tld>, no
 *  whitespace. The check is intentionally loose; full RFC 5322 is out of
 *  scope. Both this file and route() apply the same check (route() carries
 *  its own copy keyed to the default owner email; keeping the regexes
 *  textually identical is a small redundancy that lives until we have a
 *  routing-utils module worth extracting). */
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  /** Original source string, kept for human display (error messages,
   *  future operator UI). NOT what gets hashed — the AST is hashed
   *  instead so lexical noise doesn't churn assignments. */
  predicate: string;
  predicateAst: PredicateAst;  // parsed form — used by the engine and the hash
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

  // A section is "rule-shaped" if it has any of priority/predicate/owner_email
  // bullets. Pure doc sections have none of these and are silently skipped.
  // A rule-shaped section whose heading isn't `RR\d+` is treated as a typo
  // (silent skip there would give an empty rule set and route everything to
  // fallback). The `\b` anchor on the id regex rejects `RR1oops` — without
  // it, `^(RR\d+)` would greedy-match `RR1` from `RR1oops` and discard the
  // suffix silently.
  const RULE_BULLET_RE = /^- (priority|predicate|owner_email)\b/m;

  for (const section of sections) {
    const idMatch = section.match(/^(RR\d+)\b/);
    if (!idMatch) {
      if (RULE_BULLET_RE.test(section)) {
        const heading = section.split('\n', 1)[0].trim();
        problems.push(
          `section "## ${heading}" has rule bullets but its heading isn't a valid rule id — ` +
          `rule ids must match the shape RR<digits> (e.g. RR1, RR12). Pure doc sections ` +
          `should have no priority/predicate/owner_email bullets.`,
        );
      }
      continue;  // doc section, no rule bullets
    }
    const id = idMatch[1];

    if (seenIds.has(id)) {
      problems.push(`duplicate rule id "${id}" — each RR\\d+ heading must be unique`);
      // Skip this duplicate body to avoid double-reporting field issues
      // against the duplicate; the first occurrence is already accepted.
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

    // predicate: backtick-quoted on a bullet line. Anchored start-to-end of
    // line so `- predicate: \`tier == 'hot'\` AND industry == 'fintech'` is
    // REJECTED rather than silently parsed as just `tier == 'hot'`.
    const predMatch = section.match(/^- predicate:\s*`([^`]+)`\s*$/m);
    let predicate: string | null = null;
    let predicateAst: PredicateAst | null = null;
    if (!predMatch) {
      // Distinguish "missing entirely" from "present but malformed" so the
      // error message helps the operator. The malformed message catches both
      // trailing content and unclosed backticks.
      if (!/^- predicate:/m.test(section)) {
        ruleProblems.push(`${id}: missing "- predicate: \\\`<expr>\\\`"`);
      } else {
        ruleProblems.push(
          `${id}: predicate bullet is malformed — must be exactly ` +
          `"- predicate: \\\`<expr>\\\`" with no trailing content`,
        );
      }
    } else {
      predicate = predMatch[1].trim();
      try {
        predicateAst = parsePredicate(predicate);
      } catch (err) {
        ruleProblems.push(`${id}: predicate "${predicate}" — ${(err as Error).message}`);
      }
    }

    // owner_email: trimmed, lower-cased, basic shape.
    const ownerMatch = section.match(/^- owner_email:\s*(\S.*?)\s*$/m);
    let ownerEmail: string | null = null;
    if (!ownerMatch) {
      ruleProblems.push(`${id}: missing "- owner_email: <email>"`);
    } else {
      const candidate = ownerMatch[1].trim().toLowerCase();
      if (!EMAIL_SHAPE_RE.test(candidate)) {
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

  // Deterministic order: priority ASC, then numeric id ASC. Numeric (not
  // lexicographic) tie-break so RR2 beats RR10 — matching how an operator
  // reading "rule numbers ascending" would expect them to evaluate.
  rules.sort((a, b) => a.priority - b.priority || ruleIdNum(a.id) - ruleIdNum(b.id));
  return rules;
}

/** Parse the digit suffix out of an `RR\d+` id. Used for numeric tie-break. */
function ruleIdNum(id: string): number {
  return parseInt(id.slice(2), 10);
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
 * Stable under: comment-only edits, whitespace-only edits, and predicate-
 * internal whitespace edits (because the AST collapses lexical variation).
 * Sensitive to: rule id changes, priority changes, predicate semantics
 * changes, and owner_email changes.
 *
 * If the file is malformed, hashRoutingRules throws the same error
 * parseRoutingRules would — callers should never see a "hash of an invalid
 * file" because there shouldn't be one.
 *
 * **NOTE**: route() uses `hashRoutingConfig(rules, defaultOwnerEmail)`
 * below, NOT this function, because the fallback owner is part of the
 * effective routing configuration and changing it must invalidate
 * fallback assignments.
 */
export function hashRoutingRules(md: string): string {
  return hashRoutingConfig(parseRoutingRules(md), '');
}

/**
 * Hash a parsed routing config (rules + default owner email).
 *
 * The hash captures everything that influences a routing decision:
 *   - Each rule's id, priority, predicate semantics (via AST), and owner.
 *   - The fallback owner email used when no rule matches.
 *
 * Why fold defaultOwnerEmail into the hash: route()'s idempotency key is
 * `(account_id, score_id, routing_rules_hash)`. If the hash didn't include
 * the default, then changing `DEFAULT_OWNER_EMAIL` would silently fail to
 * recompute existing fallback assignments — the catch-and-reselect path
 * would return the old row with the old owner. Folding the default in means
 * a change produces a new hash → a new row → the correct new owner.
 *
 * Trade-off: rule-match assignments (where the default isn't actually used)
 * also see a new hash on default changes and so write an effectively-identical
 * new row. Storage cost is negligible; correctness is sharper.
 *
 * The default email is normalized (trim + lowercase) before hashing so
 * cosmetic differences in env-var formatting don't churn.
 */
export function hashRoutingConfig(rules: RoutingRule[], defaultOwnerEmail: string): string {
  const canonical = {
    rules: rules.map((r) => ({
      id: r.id,
      priority: r.priority,
      // Hash the AST, not the source string, so `tier == 'hot'` and
      // `tier  ==  'hot'` collide (semantic equality, no whitespace churn).
      predicate: r.predicateAst,
      ownerEmail: r.ownerEmail,
    })),
    defaultOwnerEmail: defaultOwnerEmail.trim().toLowerCase(),
  };
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
    if (field === 'tier') values.forEach((v) => requireTierValue(v, s));
    return { kind: 'in', field, values };
  }
  // == 'value'
  m = s.match(/^(\w+)\s*==\s*'([^']*)'$/);
  if (m) {
    const field = requireField(m[1], s);
    if (field === 'tier') requireTierValue(m[2], s);
    return { kind: 'eq', field, value: m[2] };
  }
  // != 'value'
  m = s.match(/^(\w+)\s*!=\s*'([^']*)'$/);
  if (m) {
    const field = requireField(m[1], s);
    if (field === 'tier') requireTierValue(m[2], s);
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

function requireTierValue(v: string, leafSource: string): void {
  // tier is the only enum-validated literal. Other fields (firmographic_size,
  // industry) are free-form text columns and the parser can't enumerate their
  // valid values; tier comes from a hard-coded scoring union so a typo'd
  // literal silently becomes a dead rule otherwise.
  if (!TIER_VALUES.has(v)) {
    throw new Error(
      `unknown tier value "${v}" in leaf "${leafSource}" — allowed: ${[...TIER_VALUES].join(', ')}`,
    );
  }
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
