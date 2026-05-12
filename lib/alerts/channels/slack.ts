import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChannelDelivery } from '../types';

/**
 * Slack-webhook delivery with file fallback.
 *
 * Returns a `ChannelDelivery` describing what ACTUALLY happened. The
 * `channel` field is the honest disposition of the delivery attempt:
 *
 *   - URL set + HTTP 2xx → `{ channel: 'slack', ok: true }`.
 *   - URL set + HTTP non-2xx → `{ channel: 'slack', ok: false, detail: 'HTTP <code>' }`.
 *   - URL unset + file write OK → `{ channel: 'file', ok: true }`.
 *   - URL unset + file write THROWS → `{ channel: 'file', ok: false, detail }`.
 *     (Critically NOT `channel: 'slack'` — the slack network call never
 *     happened. The disposition reflects the attempt that was actually
 *     made, which was the file path.)
 *
 * Network errors from the URL-set path (DNS failure, timeout, fetch throw)
 * are re-thrown to the caller; the dispatcher's `try/catch` records them
 * as `{ channel: 'slack', ok: false }` since 'slack' WAS the attempted
 * channel.
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
    try {
      const dir = resolve(process.cwd(), 'outbox');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, `slack-${alertId}.json`), JSON.stringify({ text }, null, 2));
      return {
        channel: 'file',
        ok: true,
        sent_at: sentAt,
        detail: 'SLACK_WEBHOOK_URL unset; wrote payload to outbox/',
      };
    } catch (err) {
      // File-fallback failed (disk full, perms, etc.). The disposition
      // is 'file' — that's the channel we attempted — and ok=false so
      // operators see "fallback was attempted and broke" rather than
      // "slack failed" (which would lie about a network call we never
      // even tried).
      return {
        channel: 'file',
        ok: false,
        sent_at: sentAt,
        detail: `file fallback failed: ${(err as Error).message}`,
      };
    }
  }
  // 5-second budget. Slack typically responds in <500ms; a multi-second
  // hang here would block the recompute orchestrator's response. The
  // dispatcher's reserve has already committed; if the send times out,
  // the alert row sits with empty channelsSentJson and the cooldown
  // blocks any duplicate (which is exactly the "reserved but didn't
  // deliver" state the Task 2.1 reserve-then-send pattern designed for).
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5000),
  });
  return res.ok
    ? { channel: 'slack', ok: true, sent_at: sentAt }
    : { channel: 'slack', ok: false, sent_at: sentAt, detail: `HTTP ${res.status}` };
}
