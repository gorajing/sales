import { describe, it, expect } from 'vitest';
import {
  parseRoutingRules,
  evalRoutingPredicate,
  hashRoutingRules,
  hashRoutingConfig,
  RoutingRuleParseError,
  type RoutingContext,
} from '../../lib/routing/rules';

const ctxFor = (over: Partial<RoutingContext> = {}): RoutingContext => ({
  tier: 'cold',
  ...over,
});

describe('parseRoutingRules — happy path', () => {
  const md = `
## RR1 — Hot
- priority: 10
- predicate: \`tier IN ['hot', 'on_fire']\`
- owner_email: ae@x.com

## RR2 — Warm
- priority: 20
- predicate: \`tier == 'warm'\`
- owner_email: sdr@x.com

## RR3 — Default
- priority: 100
- predicate: \`tier == 'cold'\`
- owner_email: Triage@Example.COM
`;

  it('parses three rules with priority + predicate + owner_email', () => {
    const rules = parseRoutingRules(md);
    expect(rules).toHaveLength(3);
    expect(rules[0].id).toBe('RR1');
    expect(rules[0].priority).toBe(10);
    expect(rules[1].id).toBe('RR2');
    expect(rules[2].id).toBe('RR3');
  });

  it('sorts ascending by priority', () => {
    const reordered = `
## RR3 — Default
- priority: 100
- predicate: \`tier == 'cold'\`
- owner_email: triage@x.com

## RR1 — Hot
- priority: 10
- predicate: \`tier == 'hot'\`
- owner_email: ae@x.com
`;
    const rules = parseRoutingRules(reordered);
    expect(rules.map((r) => r.id)).toEqual(['RR1', 'RR3']);
  });

  it('tie-breaks equal-priority rules by numeric id ASC (deterministic)', () => {
    const sameP = `
## RR2 — B
- priority: 20
- predicate: \`tier == 'warm'\`
- owner_email: b@x.com

## RR1 — A
- priority: 20
- predicate: \`tier == 'hot'\`
- owner_email: a@x.com
`;
    const rules = parseRoutingRules(sameP);
    // Same priority — RR1 must come before RR2 regardless of authoring order.
    expect(rules.map((r) => r.id)).toEqual(['RR1', 'RR2']);
  });

  it('tie-breaks numerically — RR2 beats RR10 (NOT lexicographic)', () => {
    // If the sort were lexicographic, RR10 < RR2 by string compare, which
    // would silently re-order policy as rule count grows past 9.
    const sameP = `
## RR10 — Ten
- priority: 30
- predicate: \`tier == 'warm'\`
- owner_email: ten@x.com

## RR2 — Two
- priority: 30
- predicate: \`tier == 'hot'\`
- owner_email: two@x.com
`;
    const rules = parseRoutingRules(sameP);
    expect(rules.map((r) => r.id)).toEqual(['RR2', 'RR10']);
  });

  it('normalizes owner_email to lowercase trimmed', () => {
    const rules = parseRoutingRules(md);
    const def = rules.find((r) => r.id === 'RR3')!;
    expect(def.ownerEmail).toBe('triage@example.com');
  });
});

describe('parseRoutingRules — strict validation (no silent skip)', () => {
  it('throws RoutingRuleParseError listing all problems at once', () => {
    const bad = `
## RR1 — Missing priority
- predicate: \`tier == 'hot'\`
- owner_email: ae@x.com

## RR2 — Missing predicate
- priority: 20
- owner_email: sdr@x.com

## RR3 — Missing owner_email
- priority: 30
- predicate: \`tier == 'cold'\`
`;
    let err: unknown;
    try { parseRoutingRules(bad); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RoutingRuleParseError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/RR1/);
    expect(msg).toMatch(/RR2/);
    expect(msg).toMatch(/RR3/);
    expect(msg).toMatch(/priority/i);
    expect(msg).toMatch(/predicate/i);
    expect(msg).toMatch(/owner_email/i);
  });

  it('throws on duplicate rule ids', () => {
    const dup = `
## RR1 — first
- priority: 10
- predicate: \`tier == 'hot'\`
- owner_email: a@x.com

## RR1 — second (typo, should have been RR2)
- priority: 20
- predicate: \`tier == 'warm'\`
- owner_email: b@x.com
`;
    expect(() => parseRoutingRules(dup)).toThrow(/duplicate.*RR1/i);
  });

  it('throws on malformed predicate: unquoted string value', () => {
    const bad = `
## RR1 — bad
- priority: 10
- predicate: \`tier == hot\`
- owner_email: ae@x.com
`;
    expect(() => parseRoutingRules(bad)).toThrow(RoutingRuleParseError);
  });

  it('throws on malformed predicate: unknown field name', () => {
    const bad = `
## RR1 — typo
- priority: 10
- predicate: \`firmographic_sze == 'enterprise'\`
- owner_email: ae@x.com
`;
    let err: unknown;
    try { parseRoutingRules(bad); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RoutingRuleParseError);
    expect((err as Error).message).toMatch(/firmographic_sze/);
  });

  it('throws on unsupported operator', () => {
    const bad = `
## RR1 — bad
- priority: 10
- predicate: \`tier > 'hot'\`
- owner_email: ae@x.com
`;
    expect(() => parseRoutingRules(bad)).toThrow(RoutingRuleParseError);
  });

  it('throws on invalid owner_email shape', () => {
    const bad = `
## RR1 — bad
- priority: 10
- predicate: \`tier == 'hot'\`
- owner_email: not-an-email
`;
    expect(() => parseRoutingRules(bad)).toThrow(/owner_email/i);
  });

  it('throws on negative priority', () => {
    const bad = `
## RR1 — bad
- priority: -5
- predicate: \`tier == 'hot'\`
- owner_email: ae@x.com
`;
    expect(() => parseRoutingRules(bad)).toThrow(/priority/i);
  });

  it('throws when a rule-shaped section has a malformed heading (silent skip is wrong)', () => {
    // A section that has all three rule bullet lines but a heading that
    // doesn't match RR\d+ is almost certainly a typo — silently treating it
    // as a doc section produces an empty rule set and fallback routing for
    // every account. Distinguish doc sections (no rule bullets) from
    // malformed rule sections (has rule bullets).
    const bad = `
## R1 — typo, should have been RR1
- priority: 10
- predicate: \`tier == 'hot'\`
- owner_email: ae@x.com
`;
    expect(() => parseRoutingRules(bad)).toThrow(/RR\\?d\+|heading|malformed/i);
  });

  it('rejects RR1oops — id must end at a word boundary', () => {
    const bad = `
## RR1oops — looks like a rule but suffix is garbage
- priority: 10
- predicate: \`tier == 'hot'\`
- owner_email: ae@x.com
`;
    expect(() => parseRoutingRules(bad)).toThrow();
  });

  it('allows pure doc sections that have no rule bullets', () => {
    const ok = `
## How matching works

Rules are evaluated in ascending priority order. First match wins.

## RR1 — Hot
- priority: 10
- predicate: \`tier == 'hot'\`
- owner_email: ae@x.com
`;
    const rules = parseRoutingRules(ok);
    expect(rules.map((r) => r.id)).toEqual(['RR1']);
  });

  it('throws when predicate line has trailing content after the closing backtick', () => {
    // The original regex was unanchored, so this silently dropped the
    // trailing AND clause and routed on only the first backticked fragment.
    const bad = `
## RR1 — sneaky
- priority: 10
- predicate: \`tier == 'hot'\` AND industry == 'fintech'
- owner_email: ae@x.com
`;
    expect(() => parseRoutingRules(bad)).toThrow(RoutingRuleParseError);
  });

  it('throws on unknown tier literal in equality', () => {
    const bad = `
## RR1 — typo'd tier
- priority: 10
- predicate: \`tier == 'hots'\`
- owner_email: ae@x.com
`;
    let err: unknown;
    try { parseRoutingRules(bad); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RoutingRuleParseError);
    expect((err as Error).message).toMatch(/hots/);
  });

  it('throws on unknown tier literal inside IN list', () => {
    const bad = `
## RR1 — typo'd tier in IN
- priority: 10
- predicate: \`tier IN ['hot', 'onfire']\`
- owner_email: ae@x.com
`;
    expect(() => parseRoutingRules(bad)).toThrow(/onfire/);
  });

  it('accepts free-form (non-tier) values without enum validation', () => {
    // firmographic_size and industry are free-form text columns; the parser
    // can't know all valid values, so any non-empty single-quoted string is
    // accepted. Tier is the only enum-validated field.
    const ok = `
## RR1 — Custom firmographic
- priority: 10
- predicate: \`firmographic_size == 'public-sector-fed'\`
- owner_email: ae@x.com
`;
    expect(() => parseRoutingRules(ok)).not.toThrow();
  });
});

describe('parseRoutingRules — predicate AST is precomputed', () => {
  it('exposes parsed predicate so eval cannot fail', () => {
    const md = `
## RR1 — ok
- priority: 10
- predicate: \`tier IN ['hot', 'on_fire']\`
- owner_email: ae@x.com
`;
    const rules = parseRoutingRules(md);
    expect(rules[0].predicateAst).toBeDefined();
    // The AST shape is internal — we just verify eval against context works.
    expect(evalRoutingPredicate(rules[0].predicateAst, ctxFor({ tier: 'hot' }))).toBe(true);
    expect(evalRoutingPredicate(rules[0].predicateAst, ctxFor({ tier: 'cold' }))).toBe(false);
  });
});

describe('evalRoutingPredicate — operators and composition', () => {
  function parseSingle(pred: string) {
    const md = `
## RR1 — t
- priority: 10
- predicate: \`${pred}\`
- owner_email: a@x.com
`;
    return parseRoutingRules(md)[0].predicateAst;
  }

  it('matches IN list', () => {
    const ast = parseSingle(`tier IN ['hot', 'on_fire']`);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'hot' }))).toBe(true);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'on_fire' }))).toBe(true);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'warm' }))).toBe(false);
  });

  it('matches ==', () => {
    const ast = parseSingle(`firmographic_size == 'enterprise'`);
    expect(evalRoutingPredicate(ast, ctxFor({ firmographicSize: 'enterprise' }))).toBe(true);
    expect(evalRoutingPredicate(ast, ctxFor({ firmographicSize: 'smb' }))).toBe(false);
  });

  it('matches !=', () => {
    const ast = parseSingle(`industry != 'finance'`);
    expect(evalRoutingPredicate(ast, ctxFor({ industry: 'tech' }))).toBe(true);
    expect(evalRoutingPredicate(ast, ctxFor({ industry: 'finance' }))).toBe(false);
  });

  it('AND requires both sides', () => {
    const ast = parseSingle(`tier == 'hot' AND firmographic_size == 'enterprise'`);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'hot', firmographicSize: 'enterprise' }))).toBe(true);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'hot', firmographicSize: 'smb' }))).toBe(false);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'warm', firmographicSize: 'enterprise' }))).toBe(false);
  });

  it('OR allows either side', () => {
    const ast = parseSingle(`tier == 'hot' OR industry == 'fintech'`);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'hot' }))).toBe(true);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'warm', industry: 'fintech' }))).toBe(true);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'warm', industry: 'tech' }))).toBe(false);
  });

  it('AND binds tighter than OR (standard precedence)', () => {
    // tier == 'hot' OR tier == 'warm' AND industry == 'fintech'
    //   ≡ tier == 'hot' OR (tier == 'warm' AND industry == 'fintech')
    const ast = parseSingle(`tier == 'hot' OR tier == 'warm' AND industry == 'fintech'`);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'hot', industry: 'random' }))).toBe(true);
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'warm', industry: 'fintech' }))).toBe(true);
    // Crucially, warm + non-fintech must NOT match — that would prove
    // we accidentally bound (hot OR warm) AND fintech instead.
    expect(evalRoutingPredicate(ast, ctxFor({ tier: 'warm', industry: 'tech' }))).toBe(false);
  });

  it('returns false (does not throw) when context field is undefined', () => {
    const ast = parseSingle(`industry == 'fintech'`);
    expect(evalRoutingPredicate(ast, ctxFor({ industry: undefined }))).toBe(false);
  });
});

describe('hashRoutingRules — semantics not raw bytes', () => {
  const baseMd = `
## RR1 — Hot
- priority: 10
- predicate: \`tier == 'hot'\`
- owner_email: ae@x.com
`;

  it('returns the same hash for whitespace-only edits', () => {
    const a = hashRoutingRules(baseMd);
    const b = hashRoutingRules(baseMd.replace(/\n/g, '\n   \n').trim());
    expect(b).toBe(a);
  });

  it('returns the same hash for comment-only edits (sections without RR\\d+)', () => {
    const a = hashRoutingRules(baseMd);
    const withComment = `# Sales routing\n\nDocs paragraph here.\n${baseMd}`;
    expect(hashRoutingRules(withComment)).toBe(a);
  });

  it('returns a different hash when a predicate changes', () => {
    const a = hashRoutingRules(baseMd);
    const edited = baseMd.replace(`'hot'`, `'warm'`);
    expect(hashRoutingRules(edited)).not.toBe(a);
  });

  it('returns a different hash when an owner_email changes', () => {
    const a = hashRoutingRules(baseMd);
    const edited = baseMd.replace('ae@x.com', 'new-ae@x.com');
    expect(hashRoutingRules(edited)).not.toBe(a);
  });

  it('returns a different hash when priority changes', () => {
    const a = hashRoutingRules(baseMd);
    const edited = baseMd.replace('priority: 10', 'priority: 11');
    expect(hashRoutingRules(edited)).not.toBe(a);
  });

  it('is stable under predicate-internal whitespace edits', () => {
    // Predicate semantics are captured by the AST. Whitespace around operators
    // is lexical noise and should not churn the hash.
    const a = hashRoutingRules(baseMd);
    const padded = baseMd.replace(`\`tier == 'hot'\``, `\`tier    ==    'hot'\``);
    expect(hashRoutingRules(padded)).toBe(a);
  });
});

describe('hashRoutingConfig — folds defaultOwnerEmail into the config hash', () => {
  const baseMd = `
## RR1 — Hot
- priority: 10
- predicate: \`tier == 'hot'\`
- owner_email: ae@x.com
`;

  it('hashRoutingConfig differs when defaultOwnerEmail changes (so fallback churns correctly)', () => {
    const rules = parseRoutingRules(baseMd);
    const a = hashRoutingConfig(rules, 'fallback-a@x.com');
    const b = hashRoutingConfig(rules, 'fallback-b@x.com');
    expect(b).not.toBe(a);
  });

  it('hashRoutingConfig normalizes defaultOwnerEmail (whitespace + case ignored)', () => {
    const rules = parseRoutingRules(baseMd);
    const a = hashRoutingConfig(rules, 'fallback@x.com');
    const b = hashRoutingConfig(rules, '  Fallback@X.COM  ');
    expect(b).toBe(a);
  });
});
