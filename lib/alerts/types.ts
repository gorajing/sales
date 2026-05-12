/**
 * Shared types for the alert subsystem. Lives in its own file (rather than
 * inside `dispatch.ts`) so the channel modules can import the delivery
 * shape without creating an import cycle back to the dispatcher.
 */

/** What ACTUALLY shipped — never lies about the channel. When an env var
 *  isn't set and we wrote to outbox/, the channel is `'file'`, not the
 *  originally-requested channel. */
export type AlertChannel = 'slack' | 'email' | 'webhook' | 'file';

export interface ChannelDelivery {
  channel: AlertChannel;
  ok: boolean;
  /** ISO 8601 timestamp captured at send-attempt time, persisted for the
   *  audit trail. Distinct from `alerts.createdAt` (when the row was
   *  reserved) — under retry, sent_at may be much later than createdAt. */
  sent_at: string;
  detail?: string;
}

export interface DispatchResult {
  alertId: string;
  channelsSent: ChannelDelivery[];
}
