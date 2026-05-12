import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChannelDelivery } from '../types';

/**
 * Email delivery — v1 has no SMTP integration, so this ALWAYS writes a
 * `.eml` file under `outbox/`. The returned `channel` is `'file'`, never
 * `'email'`, so operators see the honest delivery state.
 *
 * The `.eml` format is a minimal RFC-2822-ish envelope so the file is
 * openable in Mail.app / Thunderbird for verification during development.
 * No multipart, no MIME tricks — just `Subject:` + body.
 */
export async function sendEmail(
  subject: string,
  body: string,
  alertId: string,
  sentAt: string,
): Promise<ChannelDelivery> {
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
}
