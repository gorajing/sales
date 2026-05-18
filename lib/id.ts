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
 * A RegExp matching exactly the `newId(kind)` shape:
 * `<prefix>_<YYYYMMDD>_<10 lowercase hex>`, anchored on word
 * boundaries so it finds ids embedded in prose WITHOUT
 * false-matching ("evidence", "ev_", a bare prefix).
 *
 * Co-located with `newId` ON PURPOSE: the pattern here and the
 * construction above MUST change together. Any drift (suffix length
 * or charset, date width) not mirrored here would make a consumer
 * silently miss real ids — for the Phase 6 application gate that
 * means an uncaught unbacked citation. A test round-trips
 * `newId('evidence')` through this so drift fails loud.
 */
export function idRegExp(kind: IdKind, flags = ''): RegExp {
  return new RegExp(`\\b${PREFIX[kind]}_\\d{8}_[0-9a-f]{10}\\b`, flags);
}
