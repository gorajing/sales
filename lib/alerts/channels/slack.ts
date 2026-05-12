import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChannelDelivery } from '../types';

/**
 * Slack-webhook delivery with file fallback.
 *
 * Returns a `ChannelDelivery` describing what ACTUALLY happened:
 *   - SLACK_WEBHOOK_URL unset → writes the rendered text to
 *     `outbox/slack-<alertId>.json`, returns `{ channel: 'file', ok: true }`.
 *     Never returns `channel: 'slack'` for the disk path — that would lie
 *     to the operator about delivery.
 *   - URL set + HTTP 2xx → `{ channel: 'slack', ok: true }`.
 *   - URL set + HTTP non-2xx → `{ channel: 'slack', ok: false, detail: 'HTTP <code>' }`.
 *   - URL set + fetch throws → propagated to the caller; dispatcher catches
 *     and records `ok: false`.
 *
 * No retries. A retry loop here would amplify rate-limit churn and
 * complicate the reserve-then-send contract. v1.5 may add a queue.
 */
export async function sendSlack(
  text: string,
  alertId: string,
  sentAt: string,
): Promise<ChannelDelivery> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    const dir = resolve(process.cwd(), 'outbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `slack-${alertId}.json`), JSON.stringify({ text }, null, 2));
    return {
      channel: 'file',
      ok: true,
      sent_at: sentAt,
      detail: 'SLACK_WEBHOOK_URL unset; wrote payload to outbox/',
    };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return res.ok
    ? { channel: 'slack', ok: true, sent_at: sentAt }
    : { channel: 'slack', ok: false, sent_at: sentAt, detail: `HTTP ${res.status}` };
}
