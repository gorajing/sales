import { describe, it, expect } from 'vitest';
import {
  classifyDelivery,
  classifyDeliveries,
  channelLabel,
} from '../../components/channel-classify';
import type { ChannelDelivery } from '../../lib/alerts/types';

function d(
  channel: 'slack' | 'email' | 'webhook' | 'file',
  ok: boolean,
  detail?: string,
): ChannelDelivery {
  return { channel, ok, sent_at: '2026-05-10T12:00:00.000Z', detail };
}

describe('classifyDelivery', () => {
  it('returns "failed" for ok=false regardless of channel', () => {
    expect(classifyDelivery(d('slack', false))).toBe('failed');
    expect(classifyDelivery(d('webhook', false))).toBe('failed');
    expect(classifyDelivery(d('file', false))).toBe('failed');
  });

  it('returns "fallback" for ok=true + file channel (wrote to outbox, not real channel)', () => {
    expect(classifyDelivery(d('file', true))).toBe('fallback');
  });

  it('returns "delivered" for ok=true + non-file channel', () => {
    expect(classifyDelivery(d('slack', true))).toBe('delivered');
    expect(classifyDelivery(d('email', true))).toBe('delivered');
    expect(classifyDelivery(d('webhook', true))).toBe('delivered');
  });
});

describe('classifyDeliveries', () => {
  it('returns "pending" for an empty list (reserved but not yet delivered)', () => {
    expect(classifyDeliveries([])).toBe('pending');
  });

  it('returns "all-delivered" when every delivery is ok=true', () => {
    expect(classifyDeliveries([d('slack', true)])).toBe('all-delivered');
    expect(classifyDeliveries([d('slack', true), d('email', true)])).toBe('all-delivered');
  });

  it('treats fallback (file ok=true) as a SUCCESSFUL delivery for whole-list classification', () => {
    // A fallback delivery is "the system honestly recorded it went to
    // disk" — that's still a successful outcome of the dispatch
    // attempt, so the whole-list classification doesn't escalate to
    // 'mixed' / 'all-failed' just because the channel is 'file'.
    expect(classifyDeliveries([d('file', true)])).toBe('all-delivered');
    expect(classifyDeliveries([d('file', true), d('file', true)])).toBe('all-delivered');
  });

  it('returns "all-failed" when every delivery is ok=false', () => {
    expect(classifyDeliveries([d('slack', false)])).toBe('all-failed');
    expect(classifyDeliveries([d('slack', false), d('email', false)])).toBe('all-failed');
  });

  it('returns "mixed" when some delivered and some failed', () => {
    expect(classifyDeliveries([d('slack', true), d('email', false)])).toBe('mixed');
    expect(classifyDeliveries([d('slack', false), d('email', true)])).toBe('mixed');
    // Fallback + failed = mixed (one succeeded-as-fallback, one didn't).
    expect(classifyDeliveries([d('file', true), d('slack', false)])).toBe('mixed');
  });
});

describe('channelLabel', () => {
  it('renders human-readable labels for each channel', () => {
    expect(channelLabel('slack')).toBe('Slack');
    expect(channelLabel('email')).toBe('Email');
    expect(channelLabel('webhook')).toBe('Webhook');
    expect(channelLabel('file')).toBe('File (outbox)');
  });
});
