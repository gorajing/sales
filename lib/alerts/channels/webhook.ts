import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChannelDelivery } from '../types';

/**
 * Generic-webhook delivery with file fallback. Mirrors slack.ts's
 * structure; the payload is an arbitrary JSON object rather than a
 * `{text}` Slack shape.
 *
 * Returned `channel` is `'file'` when GENERIC_WEBHOOK_URL is unset
 * (honest fallback) regardless of whether the file write succeeded.
 * Returned `channel` is `'webhook'` when the URL was set, regardless of
 * HTTP status. Network errors are re-thrown to the dispatcher.
 */
export async function sendWebhook(
  payload: unknown,
  alertId: string,
  sentAt: string,
): Promise<ChannelDelivery> {
  const url = process.env.GENERIC_WEBHOOK_URL;
  if (!url) {
    try {
      const dir = resolve(process.cwd(), 'outbox');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, `webhook-${alertId}.json`), JSON.stringify(payload, null, 2));
      return {
        channel: 'file',
        ok: true,
        sent_at: sentAt,
        detail: 'GENERIC_WEBHOOK_URL unset; wrote payload to outbox/',
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.ok
    ? { channel: 'webhook', ok: true, sent_at: sentAt }
    : { channel: 'webhook', ok: false, sent_at: sentAt, detail: `HTTP ${res.status}` };
}
