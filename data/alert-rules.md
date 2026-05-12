# Alert rules

**v1 status:** This file is a **design reference**, not a parsed config. The
v1 dispatcher in `lib/alerts/dispatch.ts` hardcodes the trigger → severity →
channels mapping described below. The file is committed so the contract is
visible and reviewable, and so swapping in a parser for v1.5 is purely
additive. **Do not let this file silently diverge from
`lib/alerts/dispatch.ts`** — when you change the dispatcher, update this file
in the same commit.

## Channels

Each rule maps a trigger to one or more channels and a severity. Channels:
`slack`, `email`, `webhook`.

If a channel's secret/URL env var is unset, the dispatcher falls back to
writing the rendered payload to `outbox/<channel>-<alertId>.json` and records
the delivery's `channel` field as `'file'` — **not** as the originally
requested channel. This is "fallback channel honesty": operators reading the
alerts table or `/alerts` UI should see the actual delivery mechanism, not a
configured-but-not-firing one.

Env-var → channel mapping:

| Channel   | Env var                | Behavior when unset                          |
|-----------|------------------------|----------------------------------------------|
| `slack`   | `SLACK_WEBHOOK_URL`    | Writes JSON to `outbox/slack-<id>.json`      |
| `email`   | (none; v1 has no SMTP) | Always writes `.eml` to `outbox/email-<id>.eml` |
| `webhook` | `GENERIC_WEBHOOK_URL`  | Writes JSON to `outbox/webhook-<id>.json`    |

## Cooldown semantics

The dispatcher inserts the alert row **before** firing any external send (the
"reserve-then-send" pattern). `alerts.cooldownKey` is `UNIQUE` at the DB
layer; if a duplicate cooldown key tries to reserve, the insert is rejected
and the dispatch is a no-op. This guarantees external sends fire **at most
once per cooldown key**, even under concurrent recompute requests.

Per-trigger keys:

- `tier_promotion`: `tier_promotion:<accountId>:<scoreId>` — one alert per
  score row. A second recompute on the same score (dedupe short-circuit)
  reuses the same scoreId and is correctly suppressed.
- `engagement_spike`: `engagement_spike:<accountId>:<utc-date>` — one alert
  per account per UTC day, regardless of how many spike-qualifying signals
  arrive that day.
- `competitor_mention` (v1.5 — not yet wired): TBD.

## Rules (hardcoded in `lib/alerts/dispatch.ts`)

### A1 — Tier promotion (any → warm/hot)

- trigger: `tier_promotion`
- severity: `priority`
- channels: `[slack]`

### A2 — On-fire tier promotion

- trigger: `tier_promotion`
- min_to_tier: `on_fire`
- severity: `urgent`
- channels: `[slack, email]`

### A3 — Engagement spike

- trigger: `engagement_spike`
- severity: `priority`
- channels: `[slack]`
- threshold: 3+ engagement-like signals in the last 24h
- cooldown: 1 alert per account per UTC day

### A4 — Competitor mention (v1.5 — not yet wired)

- trigger: `competitor_mention`
- severity: `info`
- channels: `[webhook]`
