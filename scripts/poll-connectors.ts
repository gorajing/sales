#!/usr/bin/env tsx
/**
 * Poll all configured connectors once, ingest, recompute affected
 * accounts, print a per-connector summary. Run from cron / launchd /
 * Task Scheduler:
 *
 *   pnpm tsx scripts/poll-connectors.ts
 *
 * Env:
 *   GITHUB_TOKEN          — if set, the GitHub connector is included
 *   DEFAULT_OWNER_EMAIL   — required for the recompute step
 *   POLL_SINCE            — optional ISO-8601 override (backfill). When
 *                           unset, each connector's persisted watermark
 *                           (else now-24h) is used — durable across runs
 *                           via the connector_poll_state table.
 *
 * This is a THIN wrapper: all orchestration (per-connector isolation,
 * watermark, recompute gating) lives in lib/connectors/poll.ts and is
 * shared verbatim with POST /api/connectors/poll — no logic is
 * duplicated here (the original plan draft triplicated it).
 *
 * Exit code: 0 iff every connector AND every recompute succeeded;
 * non-zero otherwise, so cron/launchd surfaces partial failures
 * instead of silently "succeeding."
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GitHubConnector } from '../lib/connectors/github';
import { SalesforceConnector } from '../lib/connectors/salesforce';
import { HubSpotConnector } from '../lib/connectors/hubspot';
import { OutreachConnector } from '../lib/connectors/outreach';
import {
  pollConnectors,
  recomputeAffectedAccounts,
  type RecomputeSummary,
} from '../lib/connectors/poll';
import type { SignalConnector } from '../lib/connectors/types';

async function main(): Promise<number> {
  const sinceParam = process.env.POLL_SINCE;
  let since: Date | undefined;
  if (sinceParam) {
    const d = new Date(sinceParam);
    if (Number.isNaN(d.getTime())) {
      console.error(`[poll] invalid POLL_SINCE: ${JSON.stringify(sinceParam)}`);
      return 2;
    }
    since = d;
  }

  const connectors: SignalConnector[] = [
    new SalesforceConnector(),
    new HubSpotConnector(),
    new OutreachConnector(),
    ...(process.env.GITHUB_TOKEN ? [GitHubConnector.fromEnv()] : []),
  ];

  const poll = await pollConnectors({ connectors, since });
  for (const c of poll.connectors) {
    const line =
      `[${c.connector}] ok=${c.ok} since=${c.since} fetched=${c.fetched} ` +
      `ingested=${c.ingested} deduped=${c.deduped} failed=${c.failed}`;
    if (c.ok) console.log(line);
    else console.error(`${line} error=${c.error ?? '(none)'}`);
  }

  let recompute: RecomputeSummary = { attempted: 0, succeeded: 0, failed: [] };
  if (poll.affectedAccountIds.length > 0) {
    const owner = (process.env.DEFAULT_OWNER_EMAIL ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) {
      console.error(
        `[poll-recompute] DEFAULT_OWNER_EMAIL is missing/invalid; ` +
        `${poll.affectedAccountIds.length} account(s) ingested but NOT recomputed.`,
      );
      recompute = {
        attempted: poll.affectedAccountIds.length,
        succeeded: 0,
        failed: poll.affectedAccountIds.map((accountId) => ({
          accountId, error: 'DEFAULT_OWNER_EMAIL missing/invalid',
        })),
      };
    } else {
      const root = process.cwd();
      const scoringMd = readFileSync(resolve(root, 'data/scoring-rules.md'), 'utf8');
      const routingMd = readFileSync(resolve(root, 'data/routing-rules.md'), 'utf8');
      recompute = await recomputeAffectedAccounts(
        poll.affectedAccountIds, { scoringMd, routingMd, defaultOwner: owner },
      );
    }
  }
  console.log(
    `[recompute] attempted=${recompute.attempted} succeeded=${recompute.succeeded} ` +
    `failed=${recompute.failed.length}`,
  );
  for (const f of recompute.failed) {
    console.error(`[recompute] ${f.accountId}: ${f.error}`);
  }

  const ok = poll.ok && recompute.failed.length === 0;
  console.log(`[poll] overall ok=${ok}`);
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[poll] fatal:', err);
    process.exit(3);
  },
);
