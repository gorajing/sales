import { createHash } from 'node:crypto';
import { db, schema } from '@/db';
import { eq, sql } from 'drizzle-orm';
import { newId } from '../id';
import { isUniqueViolation } from '../db-errors';
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

/**
 * Composite dedupe key for idempotent ingestion.
 *
 * Includes the normalized account_domain and the source label so that the same
 * snippet from the same upstream URL can legitimately attach to multiple
 * accounts (e.g. a press release that names two companies). Without this
 * scoping, the second account would silently dedupe to the first.
 *
 * Format: `<capturedBy>:<source>:<accountDomain>:<sourceUrl>:<sha256(snippet)[:16]>`
 *
 * The snippet hash is truncated to 16 hex chars (64 bits). At expected scale
 * (≤10⁶ events) the collision probability is below 1 in 10⁹; if a collision
 * does occur the only consequence is one false dedupe (the second event is
 * dropped). For tighter guarantees in larger deployments, swap to the full
 * 64-char SHA-256 hex.
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

  // Normalize captured_at to UTC-Z at the boundary. SignalPayload's
  // `z.string().datetime({ offset: true })` accepts the full RFC 3339
  // offset range (±23:59), but SQLite's `strftime('%Y-%m-%dT%H:%M:%fZ',
  // ...)` only handles realistic timezone offsets (±14:00) and returns
  // NULL for extremes — silently dropping rows from downstream
  // `strftime`-based WHERE/ORDER BY queries (engagement_spike, recent
  // signals, etc.). Storing in canonical UTC-Z form makes lexicographic
  // compare equivalent to chronological compare and eliminates the
  // value-range mismatch between Zod and SQLite. The Zod schema already
  // rejected malformed inputs; this only changes the FORM of valid
  // inputs.
  const capturedAtIso = new Date(payload.captured_at).toISOString();

  // Trust requires BOTH a trusted source label AND an authenticated sender.
  const status: 'verified' | 'pending_audit' =
    opts.trustedSender === true && TRUSTED_SOURCES.has(payload.source)
      ? 'verified'
      : 'pending_audit';

  // Drizzle's better-sqlite3 transactions are synchronous. The function
  // signature is async because callers expect a Promise; any throw inside the
  // transaction (Zod parse already happened above) aborts the transaction and
  // rejects the returned Promise — partial writes never persist.
  return db.transaction((tx): IngestResult => {
    // (2) Dedupe: short-circuit on existing dedupe key.
    //
    // Trust upgrade: a re-ingest under stronger authentication (TRUSTED_SOURCES
    // source + trustedSender=true) can promote an existing pending_audit row
    // to verified. Safe because pending_audit means the audit critic has not
    // yet emitted a verdict; we are not overriding any audit decision. We do
    // NOT downgrade verified → pending_audit, and we do NOT touch disputed
    // rows (operator's audit verdict is sticky). We do NOT auto-link contacts
    // on dedupe — a payload that adds contact_email to a previously contact-
    // less event requires manual linking via the Contacts UI; this keeps the
    // idempotent path from cascading additional writes.
    const existing = tx.select().from(schema.evidence)
      .where(eq(schema.evidence.dedupeKey, dedupeKey)).get();
    if (existing) {
      maybeUpgradeTrust(tx, existing, status);
      return {
        accountId: existing.accountId,
        contactId: existing.contactId ?? null,
        evidenceId: existing.id,
        capturedBy: existing.capturedBy as CapturedBy,
        deduped: true,
      };
    }

    // (3) Resolve-or-create the account by domain.
    //
    // Lookups use lower(col) = lower(normalized) to match the case-insensitive
    // partial unique index in db/schema.ts. v2 normalizes on every write path,
    // so stored values should always be lowercase already, but matching the
    // index expression is defense-in-depth: if a future code path inserts a
    // mixed-case domain, the lookup still finds it (and the post-insert
    // catch-and-reselect still works under unique-violation races).
    let account = tx.select().from(schema.accounts)
      .where(sql`lower(${schema.accounts.domain}) = ${domain}`).get();
    if (!account) {
      const id = newId('account');
      try {
        tx.insert(schema.accounts).values({
          id, name: domain /* placeholder; operator may rename */, domain,
        }).run();
        account = tx.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get()!;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Concurrent insert won the unique-domain index; re-select via the
        // same case-insensitive expression the index uses.
        account = tx.select().from(schema.accounts)
          .where(sql`lower(${schema.accounts.domain}) = ${domain}`).get();
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
    //
    // Lookup uses lower() to match the case-insensitive partial unique index
    // (same defense-in-depth rationale as the account block above).
    let contactId: string | null = null;
    if (email) {
      const found = tx.select().from(schema.contacts)
        .where(sql`lower(${schema.contacts.email}) = ${email}`).get();
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
          // Concurrent insert with the same email won. Re-resolve via the
          // same case-insensitive expression, applying the same cross-account
          // guard as above.
          const reselect = tx.select().from(schema.contacts)
            .where(sql`lower(${schema.contacts.email}) = ${email}`).get();
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
        capturedAt: capturedAtIso,
        capturedBy,
        dedupeKey,
      }).run();
      return { accountId, contactId, evidenceId, capturedBy, deduped: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = tx.select().from(schema.evidence)
        .where(eq(schema.evidence.dedupeKey, dedupeKey)).get();
      if (!winner) throw err;
      // Apply the same trust-upgrade as the dedupe-SELECT path (step 2). If
      // the unauthenticated call won the insert race and a trusted call lost
      // here, the existing pending_audit row should still be promoted to
      // verified — anything else silently preempts trust upgrades.
      maybeUpgradeTrust(tx, winner, status);
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

/**
 * Promote a dedupe-matched evidence row from pending_audit to verified when
 * the new ingest call would yield verified. Called from BOTH the dedupe-
 * SELECT path and the insert-race catch path so the upgrade is consistent
 * regardless of which path triggers the dedupe.
 *
 * Does not downgrade verified → pending_audit, and does not touch disputed
 * (operator/audit-critic verdicts are sticky).
 */
function maybeUpgradeTrust(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  existing: typeof schema.evidence.$inferSelect,
  newStatus: 'verified' | 'pending_audit',
): void {
  if (existing.extractionStatus === 'pending_audit' && newStatus === 'verified') {
    tx.update(schema.evidence)
      .set({ extractionStatus: 'verified' })
      .where(eq(schema.evidence.id, existing.id)).run();
  }
}
