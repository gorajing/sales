import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { newId } from '../id';
import {
  parseRoutingRules, evalRoutingPredicate, hashRoutingConfig,
  type RoutingContext,
} from './rules';

/**
 * Owner-assignment outcome for one (account, score) pair.
 *
 * `matchedRuleKey` is non-null when `reason === 'rule_match'`, null when
 * `reason === 'fallback_default'`. The unique index on
 * `(account_id, score_id, routing_rules_hash)` is what makes route()
 * idempotent — recomputing under the same rules returns the existing row
 * via the catch-and-reselect path; recomputing under edited rules creates
 * a fresh row because the hash differs.
 */
export interface RouteResult {
  assignmentId: string;
  accountId: string;
  scoreId: string;
  ownerEmail: string;
  /** Stable parsed-from-Markdown key (e.g. 'RR1'). Null on fallback. */
  matchedRuleKey: string | null;
  reason: 'rule_match' | 'fallback_default';
  /** Hash of the parsed routing-rules.md semantics used for this decision. */
  routingRulesHash: string;
}

function isUniqueViolation(err: unknown): boolean {
  // UNIQUE / PRIMARY KEY only — FK / NOT NULL / CHECK errors must propagate.
  // SQLite-specific; see docs/architecture.md "Deployment assumptions" for
  // what changes when porting to Postgres.
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Compute and persist the owner assignment for a given (account, score) pair
 * under the supplied routing rules markdown.
 *
 * Order of operations is deliberate:
 *   1. Validate the caller-provided default email shape. We do this FIRST so
 *      a misconfigured DEFAULT_OWNER_EMAIL env var fails loudly even when no
 *      rules match — otherwise the operator would only learn about it on
 *      the first cold-tier account.
 *   2. Parse + hash the rules. parseRoutingRules throws RoutingRuleParseError
 *      on any malformed rule, aborting BEFORE any DB write. No partial
 *      success: a typo'd routing-rules.md can't half-apply.
 *   3. Resolve the score, then verify its account matches the caller-supplied
 *      one. This is a provenance guard — an attacker who could pass an
 *      arbitrary scoreId belonging to a different account could otherwise
 *      cause an assignment for account A pointing at account B's score.
 *   4. Build the routing context from score.tier + account columns (size,
 *      industry). Walk rules in (priority ASC, id ASC) order — the sort is
 *      done by parseRoutingRules — and pick the first match. No match →
 *      fallback to the default email.
 *   5. Insert. Race on the unique (account, score, hash) index is caught
 *      and the existing row is returned, making route() idempotent.
 *
 * Idempotency behavior:
 *   - Calling route() twice with the same (accountId, scoreId, rulesMd):
 *     second call returns the existing assignment.
 *   - Calling route() with the same scoreId but edited rulesMd: NEW hash →
 *     NEW assignment. Both rows survive (the unique index includes the hash).
 *
 * Failure modes (all leave the DB unchanged):
 *   - RoutingRuleParseError: rules file malformed.
 *   - Error('leadScore not found'): bad scoreId.
 *   - Error('score N belongs to account A, not B'): provenance mismatch.
 *   - Error('account not found'): account missing.
 *   - Error('default owner email …'): caller passed an unparseable email.
 */
export async function route(
  accountId: string,
  scoreId: string,
  rulesMd: string,
  defaultOwnerEmail: string,
): Promise<RouteResult> {
  const normalizedDefault = defaultOwnerEmail.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(normalizedDefault)) {
    throw new Error(
      `default owner email "${defaultOwnerEmail}" doesn't look like an email`,
    );
  }

  // Parse once; hash from the parsed config. The hash includes the
  // normalized default email so that changing DEFAULT_OWNER_EMAIL
  // invalidates existing fallback assignments — see hashRoutingConfig
  // for why fallback owners are part of the effective config.
  const rules = parseRoutingRules(rulesMd);
  const routingRulesHash = hashRoutingConfig(rules, normalizedDefault);

  const score = db.select().from(schema.leadScores)
    .where(eq(schema.leadScores.id, scoreId)).get();
  if (!score) throw new Error(`leadScore not found: ${scoreId}`);
  if (score.accountId !== accountId) {
    throw new Error(
      `score ${scoreId} belongs to account ${score.accountId}, not ${accountId}`,
    );
  }

  const account = db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
  if (!account) throw new Error(`account not found: ${accountId}`);

  const ctx: RoutingContext = {
    tier: score.tier,
    firmographicSize: account.size ?? undefined,
    industry: account.industry ?? undefined,
  };

  let matchedRuleKey: string | null = null;
  let ownerEmail = normalizedDefault;
  let reason: RouteResult['reason'] = 'fallback_default';

  for (const rule of rules) {
    if (evalRoutingPredicate(rule.predicateAst, ctx)) {
      matchedRuleKey = rule.id;
      ownerEmail = rule.ownerEmail;
      reason = 'rule_match';
      break;
    }
  }

  // Idempotency on the unique (account_id, score_id, routing_rules_hash)
  // index. Two recompute calls under the same rules share the row; rule
  // edits → new hash → new row. The catch-and-reselect mirrors the pattern
  // in lib/signals/ingest.ts.
  const assignmentId = newId('routingAssignment');
  try {
    db.insert(schema.routingAssignments).values({
      id: assignmentId, accountId, ownerEmail,
      reason, matchedRuleKey, scoreId, routingRulesHash,
    }).run();
    return {
      assignmentId, accountId, scoreId, ownerEmail,
      matchedRuleKey, reason, routingRulesHash,
    };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = db.select().from(schema.routingAssignments)
      .where(and(
        eq(schema.routingAssignments.accountId, accountId),
        eq(schema.routingAssignments.scoreId, scoreId),
        eq(schema.routingAssignments.routingRulesHash, routingRulesHash),
      )).get();
    if (!winner) throw err;
    return {
      assignmentId: winner.id, accountId, scoreId,
      ownerEmail: winner.ownerEmail,
      matchedRuleKey: winner.matchedRuleKey,
      reason: winner.reason as RouteResult['reason'],
      routingRulesHash: winner.routingRulesHash,
    };
  }
}
