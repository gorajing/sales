import { randomBytes } from 'node:crypto';

const PREFIX = {
  account: 'acc', contact: 'ct', evidence: 'ev',
  sequence: 'sq', touch: 'to', touchRevision: 'tr',
  critique: 'cr', extractionAudit: 'ea', callPrepBrief: 'cp',
  deliverable: 'del', deliverableAccount: 'da',
} as const;

export type IdKind = keyof typeof PREFIX;

export function newId(kind: IdKind): string {
  const suffix = randomBytes(5).toString('hex');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${PREFIX[kind]}_${date}_${suffix}`;
}
