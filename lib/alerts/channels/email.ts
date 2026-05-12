import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChannelDelivery } from '../types';

/**
 * Email delivery — v1 has no SMTP integration, so this ALWAYS takes the
 * file-fallback path. The returned `channel` is `'file'`, never
 * `'email'`, so operators see the honest delivery state.
 *
 * The `.eml` format is a minimal RFC-2822-ish envelope so the file is
 * openable in Mail.app / Thunderbird for verification during development.
 * No multipart, no MIME tricks — just `Subject:` + body.
 *
 * File-write failure (disk full, perms) is caught and returned as
 * `{ channel: 'file', ok: false }` so the dispatcher's catch can't
 * misattribute it to a non-existent SMTP attempt.
 */
export async function sendEmail(
  subject: string,
  body: string,
  alertId: string,
  sentAt: string,
): Promise<ChannelDelivery> {
  try {
    const dir = resolve(process.cwd(), 'outbox');
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `email-${alertId}.eml`);
    const eml = [
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body,
    ].join('\r\n');
    writeFileSync(path, eml);
    return {
      channel: 'file',
      ok: true,
      sent_at: sentAt,
      detail: 'no SMTP in v1; wrote .eml to outbox/',
    };
  } catch (err) {
    return {
      channel: 'file',
      ok: false,
      sent_at: sentAt,
      detail: `file fallback failed: ${(err as Error).message}`,
    };
  }
}
