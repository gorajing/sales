import { createHash } from 'node:crypto';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '../id';
import {
  SignalPayload, TRUSTED_SOURCES, type CapturedBy, type SignalPayload as SignalPayloadT,
} from './types';

/**
 * Result of an `ingestSignal` call.
 *
 * `deduped: true` means a row with the same dedupe key already existed; the
 * caller's payload is structurally identical to a prior ingest, and we return
 * the existing IDs without writing.
 *
 * `contactId: null` happens in three cases:
 *   1. The payload had no `contact_email`.
 *   2. The email already belongs to a contact under a *different* account
 *      (cross-account contact poisoning is blocked — see security note below).
 *   3. The payload was deduped to a prior evidence row whose contactId was null.
 */
export interface IngestResult {
  accountId: string;
  contactId: string | null;
  evidenceId: string;
  capturedBy: CapturedBy;
  deduped: boolean;
}

export interface IngestOptions {
  /**
   * True when the upstream sender was authenticated. The webhook route sets
   * this only after the shared-secret check passes; the connector poll path
   * sets it because in-process configured code is trusted by definition.
   *
   * Trust is two-factor: source label in TRUSTED_SOURCES AND trustedSender.
   * Either alone → `extractionStatus = 'pending_audit'`. This blocks an
   * attacker from forging a trusted-source label via an open webhook.
   */
  trustedSender?: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  // Narrow to UNIQUE / PRIMARY KEY constraint violations only. FK / NOT NULL /
  // CHECK violations are real bugs and must propagate.
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/**
 * Composite dedupe key for idempotent ingestion.
 *
 * Includes the normalized account_domain and the source label so that the same
 * snippet from the same upstream URL can legitimately attach to multiple
 * accounts (e.g. a press release that names two companies). Without this
 * scoping, the second account would silently dedupe to the first.
 *
 * Format: `<capturedBy>:<source>:<accountDomain>:<sourceUrl>:<sha256(snippet)[:16]>`
 */
function buildDedupeKey(
  p: SignalPayloadT,
  capturedBy: CapturedBy,
  accountDomain: string,
): string {
  const h = createHash('sha256').update(p.snippet).digest('hex').slice(0, 16);
  return `${capturedBy}:${p.source}:${accountDomain}:${p.source_url}:${h}`;
}

/**
 * Ingest a typed signal into the evidence spine.
 *
 * Pipeline (all wrapped in a single SQLite transaction, atomic):
 *   1. Zod-validate the payload (throws on schema/contract violation; nothing
 *      is written).
 *   2. Compute dedupe key. If a prior evidence row matches, short-circuit and
 *      return its IDs with `deduped: true`. No new rows.
 *   3. Resolve-or-create the account by lowercased+trimmed domain. Catches
 *      unique-constraint races and re-selects the winner.
 *   4. Resolve-or-skip the contact by lowercased+trimmed email:
 *        - Exists under SAME account → resolve.
 *        - Exists under DIFFERENT account → skip (contactId stays null).
 *          Cross-account contact poisoning is blocked at this layer; an
 *          operator can manually re-link via the contacts UI if appropriate.
 *        - Does not exist → create under this account. Catches unique-races.
 *   5. Insert the evidence row with extractionStatus determined by the trust
 *      two-factor (TRUSTED_SOURCES.has(source) AND trustedSender). Catches
 *      a unique-key race on dedupeKey and re-selects.
 *
 * The whole thing is `db.transaction((tx) => …)` — Drizzle's better-sqlite3
 * transactions are synchronous, so any throw aborts and rolls back; partial
 * writes never persist.
 */
export async function ingestSignal(
  raw: unknown,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  // (1) Validate. ZodError propagates; nothing is written.
  const payload = SignalPayload.parse(raw);

  const capturedBy: CapturedBy = payload.captured_by ?? 'webhook';
  const domain = payload.account_domain.toLowerCase().trim();
  const email = payload.contact_email?.toLowerCase().trim() || null;
  const dedupeKey = buildDedupeKey(payload, capturedBy, domain);

  // Trust requires BOTH a trusted source label AND an authenticated sender.
  const status: 'verified' | 'pending_audit' =
    opts.trustedSender === true && TRUSTED_SOURCES.has(payload.source)
      ? 'verified'
      : 'pending_audit';

  // The Drizzle transaction body is synchronous (better-sqlite3). We wrap it
  // in `await Promise.resolve(...)` so the function signature stays Promise-
  // shaped for callers and any synchronous throw inside still rejects the
  // outer Promise correctly.
  return db.transaction((tx): IngestResult => {
    // (2) Dedupe: short-circuit on existing dedupe key.
    const existing = tx.select().from(schema.evidence)
      .where(eq(schema.evidence.dedupeKey, dedupeKey)).get();
    if (existing) {
      return {
        accountId: existing.accountId,
        contactId: existing.contactId ?? null,
        evidenceId: existing.id,
        capturedBy: existing.capturedBy as CapturedBy,
        deduped: true,
      };
    }

    // (3) Resolve-or-create the account by domain.
    let account = tx.select().from(schema.accounts)
      .where(eq(schema.accounts.domain, domain)).get();
    if (!account) {
      const id = newId('account');
      try {
        tx.insert(schema.accounts).values({
          id, name: domain /* placeholder; operator may rename */, domain,
        }).run();
        account = tx.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get()!;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Concurrent insert won the unique-domain index; re-select the winner.
        account = tx.select().from(schema.accounts)
          .where(eq(schema.accounts.domain, domain)).get();
        if (!account) throw err;
      }
    }
    const accountId = account.id;

    // (4) Resolve-or-skip the contact by email.
    //
    // Security note: the email index is global (one contact per email across
    // all accounts), so an existing contact under account A cannot be
    // duplicated under account B. If the email belongs to a different
    // account, we leave evidence.contactId NULL rather than cross-linking —
    // an attacker submitting `{ account_domain: 'evil.com', contact_email:
    // 'ceo@target.com' }` cannot poison the existing CEO contact's evidence
    // graph this way.
    let contactId: string | null = null;
    if (email) {
      const found = tx.select().from(schema.contacts)
        .where(eq(schema.contacts.email, email)).get();
      if (found) {
        if (found.accountId === accountId) {
          contactId = found.id;
        }
        // else: cross-account email — leave contactId null, fall through.
      } else {
        const newContactId = newId('contact');
        try {
          tx.insert(schema.contacts).values({
            id: newContactId,
            accountId,
            // Placeholder; operator can edit via the Contacts UI. The local
            // part of the email is a reasonable starter for the display name.
            fullName: email.split('@')[0],
            email,
          }).run();
          contactId = newContactId;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // Concurrent insert with the same email won. Re-resolve, but apply
          // the same cross-account guard as above.
          const reselect = tx.select().from(schema.contacts)
            .where(eq(schema.contacts.email, email)).get();
          if (!reselect) throw err;
          if (reselect.accountId === accountId) {
            contactId = reselect.id;
          }
          // else: cross-account, contactId stays null.
        }
      }
    }

    // (5) Insert the evidence row. Dedupe-key race → re-select the winner.
    const evidenceId = newId('evidence');
    try {
      tx.insert(schema.evidence).values({
        id: evidenceId,
        accountId,
        contactId,
        sourceUrl: payload.source_url,
        sourceType: payload.source,
        signalType: payload.signal_type,
        snippet: payload.snippet,
        extractedFact: payload.fact,
        extractionStatus: status,
        confidence: 'high',
        capturedAt: payload.captured_at,
        capturedBy,
        dedupeKey,
      }).run();
      return { accountId, contactId, evidenceId, capturedBy, deduped: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = tx.select().from(schema.evidence)
        .where(eq(schema.evidence.dedupeKey, dedupeKey)).get();
      if (!winner) throw err;
      return {
        accountId: winner.accountId,
        contactId: winner.contactId ?? null,
        evidenceId: winner.id,
        capturedBy: winner.capturedBy as CapturedBy,
        deduped: true,
      };
    }
  });
}
