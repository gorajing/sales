import { randomBytes } from 'node:crypto';

const PREFIX = {
  account: 'acc', contact: 'ct', evidence: 'ev',
  sequence: 'sq', touch: 'to', touchRevision: 'tr',
  critique: 'cr', extractionAudit: 'ea', callPrepBrief: 'cp',
  deliverable: 'del', deliverableAccount: 'da',
  // v2 additions — routing rules live in Markdown so no routingRule prefix.
  leadScore: 'ls', routingAssignment: 'ra',
  alert: 'al', engagementEvent: 'ee',
} as const;

export type IdKind = keyof typeof PREFIX;

export function newId(kind: IdKind): string {
  const suffix = randomBytes(5).toString('hex');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${PREFIX[kind]}_${date}_${suffix}`;
}

/**
 * The body every `newId` appends after `<prefix>_`: an 8-digit date,
 * `_`, then 10 lowercase hex. SINGLE SOURCE for the id shape — change
 * `newId` above and this together and NOTHING else needs touching.
 * `idRegExp` (finds an id embedded in prose, `\b…\b`) and `isId`
 * (validates a whole string, `^…$`) both derive from it, so no
 * consumer can keep a private copy that drifts. Drift here that
 * `newId` doesn't mirror (or vice versa) makes the round-trip tests
 * fail loud (`isId(kind, newId(kind))`; the Phase 6 extractor test).
 */
const ID_BODY = String.raw`\d{8}_[0-9a-f]{10}`;

/**
 * A RegExp matching the `newId(kind)` shape EMBEDDED in prose,
 * anchored on word boundaries so it does not false-match
 * ("evidence", "ev_", a bare prefix). For the Phase 6 application
 * gate a pattern that drifted from `newId` would silently miss real
 * ids — an uncaught unbacked citation — hence the single source above.
 */
export function idRegExp(kind: IdKind, flags = ''): RegExp {
  return new RegExp(`\\b${PREFIX[kind]}_${ID_BODY}\\b`, flags);
}

/**
 * True iff `value` is EXACTLY `newId(kind)` — whole-string match, no
 * surrounding characters. Use this to validate an id received as
 * input (route param, form field) before a DB round-trip. Distinct
 * from `idRegExp`: the `\b…\b` there would accept `"<id> junk"` (the
 * id is *found* within it), which is wrong — and a security hole —
 * for input validation. The `^…$` here rejects anything but the id.
 */
export function isId(kind: IdKind, value: string): boolean {
  return new RegExp(`^${PREFIX[kind]}_${ID_BODY}$`).test(value);
}
