import { describe, it, expect } from 'vitest';
import {
  parseRoutingRules,
  evalRoutingPredicate,
  hashRoutingRules,
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

  it('tie-breaks equal-priority rules by id ASC (deterministic)', () => {
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

  it('rejects rule ids that are not RR\\d+', () => {
    const bad = `
## R1 — wrong shape
- priority: 10
- predicate: \`tier == 'hot'\`
- owner_email: ae@x.com
`;
    // Sections that aren't routing rules should not be parsed as routing rules.
    // The parser must not silently treat them as rules — either skip cleanly
    // (if obviously not a rule section) or throw if they look ambiguously like
    // one. We pick "ignore sections whose id doesn't match RR\d+" to allow
    // future doc sections in the file (e.g. "## How matching works").
    const rules = parseRoutingRules(bad);
    expect(rules).toHaveLength(0);
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
});
