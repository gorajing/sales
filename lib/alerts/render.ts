import { z } from 'zod';
import { spawnClaude } from '../claude/run';

/**
 * Context for rendering one alert text. The fields used depend on the
 * trigger:
 *   - `tier_promotion`: fromTier (optional, undefined on first-ever),
 *     toTier, scoreId.
 *   - `engagement_spike`: countInWindow, windowHours.
 *   - `competitor_mention`: (v1.5, not wired)
 *   - `manual`: caller free-form
 *
 * accountName is required so the rendered message identifies the account
 * in plain English even when the LLM path fails and we fall back to a
 * deterministic template.
 */
export interface AlertContext {
  trigger: 'tier_promotion' | 'engagement_spike' | 'competitor_mention' | 'manual';
  accountName: string;
  accountId: string;
  fromTier?: string;
  toTier?: string;
  scoreId?: string;
  countInWindow?: number;
  windowHours?: number;
}

/** LLM output schema. Bounded length so a runaway model can't blow past
 *  Slack's message limit or fill a notification preview. */
const Out = z.object({ text: z.string().min(1).max(500) });

const SYSTEM = `You write short Slack-ready alert messages for a sales team.
Output JSON: {"text": "..."} only. Plain text inside, no markdown formatting,
no code fences, no salutations. <=2 sentences. Mention the account name once.
Include the trigger reason and a clear next step.`;

/**
 * Render the alert text. The LLM path is best-effort; on ANY failure
 * (rate limit, CLI not authenticated, timeout, malformed JSON) we fall
 * back to a deterministic template per trigger.
 *
 * The fallback path is what makes the alert pipeline reliable: if Claude
 * is down, alerts still go out — they just read more mechanically. The
 * fallback text always names the account so the operator can act on the
 * alert without reading the JSON payload.
 */
export async function renderAlertText(ctx: AlertContext): Promise<string> {
  const prompt = `${SYSTEM}\n\nContext: ${JSON.stringify(ctx)}`;
  try {
    // 5-second budget. Alerts are best-effort and have a deterministic
    // fallback, so spending up to 30s waiting for Claude (and thus
    // blocking the recompute response) is the wrong trade-off. A
    // 5-second cap is comfortable for Haiku's typical latency
    // (<1s) and falls back loudly if anything is genuinely slow.
    const out = await spawnClaude({
      prompt,
      schema: Out,
      model: 'haiku',
      timeoutMs: 5_000,
    });
    return out.text;
  } catch {
    return fallbackText(ctx);
  }
}

/** Deterministic per-trigger template. Exported so dispatch tests can
 *  pin the expected shape without going through the LLM path. */
export function fallbackText(ctx: AlertContext): string {
  if (ctx.trigger === 'tier_promotion') {
    const from = ctx.fromTier ?? 'unscored';
    return `${ctx.accountName} promoted ${from} → ${ctx.toTier}. Open the account view to see the rationale.`;
  }
  if (ctx.trigger === 'engagement_spike') {
    return `${ctx.accountName} had ${ctx.countInWindow} signals in the last ${ctx.windowHours}h. Worth a look.`;
  }
  return `${ctx.accountName}: ${ctx.trigger}.`;
}
