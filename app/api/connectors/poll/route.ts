import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireInternalSecret, formatError } from '@/lib/alerts/http';
import { GitHubConnector } from '@/lib/connectors/github';
import { SalesforceConnector } from '@/lib/connectors/salesforce';
import { HubSpotConnector } from '@/lib/connectors/hubspot';
import { OutreachConnector } from '@/lib/connectors/outreach';
import {
  pollConnectors,
  recomputeAffectedAccounts,
  type RecomputeSummary,
} from '@/lib/connectors/poll';
import type { SignalConnector } from '@/lib/connectors/types';

/**
 * POST /api/connectors/poll — poll all configured connectors (or one
 * via `?only=`), ingest their signals, then recompute affected
 * accounts. Internal endpoint (cron / operator scripts), gated by the
 * shared `requireInternalSecret` (timing-safe + production fail-safe).
 *
 * Contract (Task 3.4):
 *   - connector output → ingestSignal only; no direct DB writes
 *   - per-connector failures are ISOLATED and visible per-connector;
 *     a failing connector never blocks the others
 *   - the response does NOT overstate: top-level `ok` is the AND of
 *     every connector AND every recompute; a partial failure is a
 *     200 with `ok:false` + per-connector detail (a reported failure
 *     is data, not a transport error)
 *   - a recompute config problem does NOT hide successful ingestion —
 *     poll results are reported truthfully and the ingested rows are
 *     not rolled back
 *
 * Status codes:
 *   - 401 / 503: auth / production-misconfig (requireInternalSecret)
 *   - 400: invalid `?since`, unknown `?only`, or `?only=github`
 *          without GITHUB_TOKEN
 *   - 200: orchestration ran (inspect `ok` + `connectors[]`)
 */

const KNOWN_CONNECTORS = ['github', 'salesforce', 'hubspot', 'outreach'] as const;
type KnownConnector = (typeof KNOWN_CONNECTORS)[number];

/** Build a connector by name. github is constructed only when its
 *  token is present (fromEnv throws otherwise). */
function buildConnector(name: KnownConnector): SignalConnector {
  switch (name) {
    case 'github': return GitHubConnector.fromEnv();
    case 'salesforce': return new SalesforceConnector();
    case 'hubspot': return new HubSpotConnector();
    case 'outreach': return new OutreachConnector();
  }
}

export async function POST(req: Request) {
  const gate = requireInternalSecret(req);
  if (gate) return gate;

  const url = new URL(req.url);

  // --- params ------------------------------------------------------------
  const sinceParam = url.searchParams.get('since');
  let since: Date | undefined;
  if (sinceParam !== null) {
    const d = new Date(sinceParam);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json(
        { error: 'invalid_since', detail: `?since must be a valid date, got ${JSON.stringify(sinceParam)}` },
        { status: 400 },
      );
    }
    since = d;
  }

  const only = url.searchParams.get('only');
  if (only !== null && !KNOWN_CONNECTORS.includes(only as KnownConnector)) {
    return NextResponse.json(
      { error: 'unknown_connector', detail: `?only must be one of ${KNOWN_CONNECTORS.join(', ')}` },
      { status: 400 },
    );
  }

  // --- build the connector set ------------------------------------------
  // Default: salesforce/hubspot/outreach always; github only if its
  // token is set (silently absent otherwise — not configured ≠ failed).
  // `?only=github` WITHOUT a token is an explicit misconfiguration the
  // operator asked for, so 400 rather than a confusing empty result.
  const hasGithubToken = Boolean(process.env.GITHUB_TOKEN);
  let connectors: SignalConnector[];
  try {
    if (only !== null) {
      if (only === 'github' && !hasGithubToken) {
        return NextResponse.json(
          { error: 'connector_misconfigured', detail: 'github connector requires GITHUB_TOKEN' },
          { status: 400 },
        );
      }
      connectors = [buildConnector(only as KnownConnector)];
    } else {
      connectors = [
        new SalesforceConnector(),
        new HubSpotConnector(),
        new OutreachConnector(),
        ...(hasGithubToken ? [GitHubConnector.fromEnv()] : []),
      ];
    }
  } catch (err) {
    // Connector construction failed (e.g. github-watch.md unparseable,
    // GITHUB_TOKEN missing for an included github). Log the full
    // formatError detail server-side; return only the message (no
    // stack/paths) — same body-vs-logs discipline as
    // /api/scoring/recompute.
    console.error('[poll] connector construction failed:', formatError(err));
    return NextResponse.json(
      {
        error: 'connector_misconfigured',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  // --- poll + ingest -----------------------------------------------------
  const poll = await pollConnectors({ connectors, since });

  // --- recompute affected accounts --------------------------------------
  // A recompute-config problem must NOT hide successful ingestion. If
  // config is unavailable, report recompute as failed (so `ok` is
  // false and the response doesn't overstate) but still return the
  // truthful poll results — the ingested evidence is already
  // committed and is NOT rolled back.
  let recompute: RecomputeSummary;
  if (poll.affectedAccountIds.length === 0) {
    recompute = { attempted: 0, succeeded: 0, failed: [] };
  } else {
    try {
      // recomputeAffectedAccounts is the SINGLE enforcement point for
      // the config-before-mutation invariant (routing-rules.md AND
      // defaultOwner). The endpoint no longer re-implements the owner
      // check — it just hands the config in; a bad routing/owner
      // comes back as a failed summary, not a thrown error and not a
      // dangling lead_scores row. The only thing that can throw here
      // is the rules-file READ (ENOENT) — caught below with a
      // GENERIC detail (no path leak; full detail logged
      // server-side), matching /api/scoring/recompute's discipline.
      const root = process.cwd();
      const scoringMd = readFileSync(resolve(root, 'data/scoring-rules.md'), 'utf8');
      const routingMd = readFileSync(resolve(root, 'data/routing-rules.md'), 'utf8');
      const defaultOwner = (process.env.DEFAULT_OWNER_EMAIL ?? '').trim().toLowerCase();
      recompute = await recomputeAffectedAccounts(
        poll.affectedAccountIds, { scoringMd, routingMd, defaultOwner },
      );
    } catch (err) {
      console.error('[poll] recompute rules files unreadable:', formatError(err));
      recompute = {
        attempted: poll.affectedAccountIds.length,
        succeeded: 0,
        failed: poll.affectedAccountIds.map((accountId) => ({
          accountId, error: 'recompute config unavailable: rules files unreadable',
        })),
      };
    }
  }

  return NextResponse.json({
    ok: poll.ok && recompute.failed.length === 0,
    pollStartedAt: poll.pollStartedAt,
    connectors: poll.connectors,
    affectedAccounts: poll.affectedAccountIds.length,
    recompute,
  }, { status: 200 });
}
