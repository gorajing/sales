import { describe, it, expect, vi } from 'vitest';
import {
  GitHubConnector,
  parseWatchList,
  type GitHubEventsClient,
  type RepoEvent,
} from '../../lib/connectors/github';
import { ConnectorError } from '../../lib/connectors/types';

// --------------------------------------------------------------------------
// Test fixture builders.
//
// `makeClient(pages)` produces a GitHubEventsClient whose listRepoEvents
// returns `pages[i]` on the i-th call. We use the narrowed
// GitHubEventsClient interface (declared in lib/connectors/github.ts) so the
// fixture has to satisfy the same shape the real connector consumes — no
// `as any` escape hatches.
//
// We also expose the underlying spy so individual tests can assert call
// count / arguments (for pagination behavior).
// --------------------------------------------------------------------------

function makeClient(pages: RepoEvent[][]): {
  client: GitHubEventsClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn();
  for (const page of pages) {
    spy.mockResolvedValueOnce({ data: page });
  }
  // Trailing empty page so a connector that asks for "one more" doesn't trip
  // a "too few responses" error — it just sees an empty page and stops.
  spy.mockResolvedValue({ data: [] });
  return {
    client: { activity: { listRepoEvents: spy } } as GitHubEventsClient,
    spy,
  };
}

function starEvent(args: { id: string; actor: string; repo: string; ts: string }): RepoEvent {
  return {
    id: args.id,
    type: 'WatchEvent',
    actor: { login: args.actor },
    repo: { name: args.repo },
    created_at: args.ts,
    payload: { action: 'started' },
  };
}

function issueOpenedEvent(args: {
  id: string; actor: string; repo: string; ts: string;
  title: string; body?: string | null; html_url: string;
}): RepoEvent {
  return {
    id: args.id,
    type: 'IssuesEvent',
    actor: { login: args.actor },
    repo: { name: args.repo },
    created_at: args.ts,
    payload: {
      action: 'opened',
      issue: { title: args.title, body: args.body ?? null, html_url: args.html_url },
    },
  };
}

function prClosedEvent(args: {
  id: string; actor: string; repo: string; ts: string;
  title: string; body?: string | null; html_url: string; merged: boolean;
}): RepoEvent {
  return {
    id: args.id,
    type: 'PullRequestEvent',
    actor: { login: args.actor },
    repo: { name: args.repo },
    created_at: args.ts,
    payload: {
      action: 'closed',
      pull_request: {
        title: args.title, body: args.body ?? null,
        html_url: args.html_url, merged: args.merged,
      },
    },
  };
}

// --------------------------------------------------------------------------
// parseWatchList
// --------------------------------------------------------------------------

describe('parseWatchList', () => {
  it('parses multiple repo entries with their signals and classification', () => {
    const md = `
## one
- target: repo:foo/bar
- signals: [stars, issue_create]
- classification: prospect

## two
- target: repo:baz/qux
- signals: [pr_merge_external]
- classification: competitor
`;
    const list = parseWatchList(md);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      target: 'repo:foo/bar',
      signals: ['stars', 'issue_create'],
      classification: 'prospect',
    });
    expect(list[1]).toEqual({
      target: 'repo:baz/qux',
      signals: ['pr_merge_external'],
      classification: 'competitor',
    });
  });

  it('rejects org: target as unsupported in v1 (named field path)', () => {
    // The point of pinning the message: a future loosening that allows org:
    // would need a deliberate update here, and a generic .toThrow() would
    // silently pass after such a change. We want the test to fail loud if
    // the supported-target set changes.
    const md = `
## bad
- target: org:my-org
- signals: [stars]
- classification: prospect
`;
    expect(() => parseWatchList(md)).toThrow(/target/i);
    expect(() => parseWatchList(md)).toThrow(/unsupported|repo:/i);
  });

  it('rejects user: target as unsupported in v1', () => {
    const md = `
## bad
- target: user:octocat
- signals: [stars]
- classification: prospect
`;
    expect(() => parseWatchList(md)).toThrow(/target/i);
  });

  it('rejects an unknown signal name (regression: typo should fail loud)', () => {
    const md = `
## bad
- target: repo:foo/bar
- signals: [stars, telepathy]
- classification: prospect
`;
    expect(() => parseWatchList(md)).toThrow(/signal/i);
  });

  it('rejects an unknown classification (regression: typo should fail loud)', () => {
    const md = `
## bad
- target: repo:foo/bar
- signals: [stars]
- classification: enemy_of_the_state
`;
    expect(() => parseWatchList(md)).toThrow(/classification/i);
  });

  it('rejects a section with no target line (would otherwise silently drop)', () => {
    // A section missing `target` would, under a permissive parser, be
    // silently skipped — the operator wouldn't see their typo. Pin the
    // strict behavior so a permissive refactor breaks this test.
    const md = `
## bad
- signals: [stars]
- classification: prospect
`;
    expect(() => parseWatchList(md)).toThrow(/target/i);
  });

  it('rejects a section with no signals line', () => {
    const md = `
## bad
- target: repo:foo/bar
- classification: prospect
`;
    expect(() => parseWatchList(md)).toThrow(/signal/i);
  });
});

// --------------------------------------------------------------------------
// GitHubConnector.fetchSince — event mapping
// --------------------------------------------------------------------------

describe('GitHubConnector.fetchSince — event mapping', () => {
  it('maps a WatchEvent to a connector_github star payload', async () => {
    const { client } = makeClient([[
      starEvent({ id: '1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'competitor' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(payloads).toHaveLength(1);
    const p = payloads[0];
    expect(p.source).toBe('github_event');
    expect(p.captured_by).toBe('connector_github');
    expect(p.account_domain).toBe('github.com/alice');
    // 'competitor' classification → 'trigger_event' signal_type (engagement
    // from a competitor's customers is a buying signal for us). This
    // mapping is the connector's domain decision — pin it so a future
    // refactor that flips it is forced through this test.
    expect(p.signal_type).toBe('trigger_event');
    expect(p.fact).toContain('starred');
    expect(p.source_url).toBe('https://github.com/foo/bar/stargazers');
    // Snippet includes the timestamp so two polls of the same event
    // produce IDENTICAL snippets → identical dedupe_key. See the
    // idempotency test below for the full proof.
    expect(p.snippet).toContain('2026-05-10T11:00:00Z');
    expect(p.captured_at).toBe('2026-05-10T11:00:00Z');
  });

  it("maps a 'prospect' star to 'engagement' (not 'trigger_event')", async () => {
    // The classification → signal_type mapping is the only domain
    // decision in event-mapping; test both branches so flipping one
    // doesn't silently change scoring downstream.
    const { client } = makeClient([[
      starEvent({ id: '1', actor: 'bob', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    const [p] = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(p.signal_type).toBe('engagement');
  });

  it('maps an IssuesEvent action=opened to an issue_create payload', async () => {
    const { client } = makeClient([[
      issueOpenedEvent({
        id: '2', actor: 'carol', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z',
        title: 'Feature request: add MCP support',
        body: 'It would be great if you supported MCP servers.',
        html_url: 'https://github.com/foo/bar/issues/42',
      }),
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['issue_create'], classification: 'prospect' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(payloads).toHaveLength(1);
    const p = payloads[0];
    expect(p.fact).toContain('opened issue');
    expect(p.fact).toContain('Feature request');
    expect(p.source_url).toBe('https://github.com/foo/bar/issues/42');
    expect(p.snippet).toContain('Feature request');
    expect(p.snippet).toContain('MCP servers');
  });

  it('maps a merged PullRequestEvent action=closed to a pr_merge_external payload', async () => {
    const { client } = makeClient([[
      prClosedEvent({
        id: '3', actor: 'dave', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z',
        title: 'Refactor auth layer',
        body: 'Big diff. See description.',
        html_url: 'https://github.com/foo/bar/pull/99',
        merged: true,
      }),
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['pr_merge_external'], classification: 'competitor' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].signal_type).toBe('trigger_event');
    expect(payloads[0].source_url).toBe('https://github.com/foo/bar/pull/99');
  });

  it('ignores a CLOSED-not-merged PullRequestEvent (merged=false → no signal)', async () => {
    // A closed-not-merged PR is a non-signal — the PR was rejected.
    // Emitting a signal here would cause scoring to count abandoned PRs
    // as if they were merges, which is semantically wrong. Test pins
    // the "merged===true" gate so a refactor can't drop it accidentally.
    const { client } = makeClient([[
      prClosedEvent({
        id: '3', actor: 'dave', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z',
        title: 'Refactor', body: null,
        html_url: 'https://github.com/foo/bar/pull/99', merged: false,
      }),
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['pr_merge_external'], classification: 'competitor' },
    ]);
    expect(await c.fetchSince(new Date('2026-05-10T10:00:00Z'))).toHaveLength(0);
  });

  it("filters out event kinds NOT in the watch entry's signals list", async () => {
    // The signals list is the operator's whitelist. If the connector
    // emits star events for an entry that only watches `issue_create`,
    // the operator is producing unintended evidence. Pin the filter.
    const { client } = makeClient([[
      starEvent({ id: '1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
      issueOpenedEvent({
        id: '2', actor: 'carol', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z',
        title: 'Bug', body: null, html_url: 'https://github.com/foo/bar/issues/1',
      }),
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['issue_create'], classification: 'prospect' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].fact).toContain('opened issue');
  });

  it('skips events with missing actor (some GitHub events are anonymous)', async () => {
    // GitHub returns null `actor` for some org-level events. Without a
    // null check the connector would either crash (NPE on `.login`) or
    // emit a payload with account_domain="github.com/undefined" which
    // would create a junk account. Test pins the skip behavior.
    const { client } = makeClient([[
      // Anonymous event — actor.login is absent on the wire. We model
      // it here as actor=null to match what Octokit returns.
      { id: '1', type: 'WatchEvent', actor: null, repo: { name: 'foo/bar' },
        created_at: '2026-05-10T11:00:00Z', payload: { action: 'started' } } as RepoEvent,
      starEvent({ id: '2', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:00:01Z' }),
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(payloads).toHaveLength(1);  // alice survived, anonymous was dropped
    expect(payloads[0].account_domain).toBe('github.com/alice');
  });

  it('ignores unknown event types (e.g. PushEvent — not in v1)', async () => {
    const { client } = makeClient([[
      { id: '1', type: 'PushEvent', actor: { login: 'alice' },
        repo: { name: 'foo/bar' }, created_at: '2026-05-10T11:00:00Z',
        payload: {} } as RepoEvent,
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars', 'issue_create', 'pr_merge_external'],
        classification: 'prospect' },
    ]);
    expect(await c.fetchSince(new Date('2026-05-10T10:00:00Z'))).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Time filtering
// --------------------------------------------------------------------------

describe('GitHubConnector.fetchSince — time filtering', () => {
  it('drops events strictly older than `since`', async () => {
    const { client } = makeClient([[
      starEvent({ id: '1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-05T00:00:00Z' }),
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    expect(await c.fetchSince(new Date('2026-05-06T00:00:00Z'))).toHaveLength(0);
  });

  it('keeps events at or after `since` (boundary: equality is INCLUSIVE)', async () => {
    // The contract is "events captured after (since, now]". This test
    // pins the exact boundary so a refactor that flips < to <= or
    // vice versa surfaces. We pick equality to be INCLUSIVE so the
    // first poll after a restart doesn't lose the boundary event.
    const ts = '2026-05-10T10:00:00Z';
    const { client } = makeClient([[
      starEvent({ id: '1', actor: 'alice', repo: 'foo/bar', ts }),
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    const payloads = await c.fetchSince(new Date(ts));
    expect(payloads).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// Pagination
// --------------------------------------------------------------------------

describe('GitHubConnector.fetchSince — pagination', () => {
  it('drains multiple pages until the first event of a page is older than `since`', async () => {
    // GitHub returns events newest-first. The drain stops when the
    // FIRST event of a freshly fetched page is older than `since`,
    // because every subsequent event in that page (and all later
    // pages) is older too — a hard cutoff.
    //
    // Page 1 (newest first):
    //   t = 11:05, 11:04, 11:03  ← all > since (10:00)
    // Page 2:
    //   t = 11:02, 11:01, 11:00  ← still > since
    // Page 3:
    //   t = 09:59 (first event < since) → stop draining
    const { client, spy } = makeClient([
      [
        starEvent({ id: '5', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:05:00Z' }),
        starEvent({ id: '4', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:04:00Z' }),
        starEvent({ id: '3', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:03:00Z' }),
      ],
      [
        starEvent({ id: '2b', actor: 'bob',   repo: 'foo/bar', ts: '2026-05-10T11:02:00Z' }),
        starEvent({ id: '1b', actor: 'bob',   repo: 'foo/bar', ts: '2026-05-10T11:01:00Z' }),
        starEvent({ id: '0b', actor: 'bob',   repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
      ],
      [
        starEvent({ id: 'old', actor: 'eve',  repo: 'foo/bar', ts: '2026-05-10T09:59:00Z' }),
      ],
    ]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    // 3 from page 1 + 3 from page 2 + 0 from page 3 (boundary event was
    // dropped, then we stopped — there was nothing newer)
    expect(payloads).toHaveLength(6);
    // We fetched exactly 3 pages. A buggy implementation that fetched
    // only page 1 would have 3 payloads; one that didn't stop at the
    // older-than-since boundary would have fetched a 4th page and the
    // spy count would be 4+. Pin the stop condition.
    expect(spy).toHaveBeenCalledTimes(3);
    // page args: 1, 2, 3.
    expect(spy.mock.calls[0][0]).toMatchObject({ owner: 'foo', repo: 'bar', page: 1 });
    expect(spy.mock.calls[2][0]).toMatchObject({ page: 3 });
  });

  it('respects a hard page cap so a misconfigured `since=Date(0)` cannot drain history forever', async () => {
    // GitHub's Events API returns at most 90 days / 300 events anyway,
    // but a defensive cap inside the connector means a future API
    // change (or a buggy `since` that's pinned to the epoch) cannot
    // make the orchestrator spin for thousands of pages. Test pins
    // the cap at the connector level so the docs match the code.
    //
    // Generate 12 "fresh" pages — more than the cap (10) — all
    // contain events newer than `since`. Connector should stop at
    // exactly 10 page fetches and return whatever it has.
    const pages: RepoEvent[][] = [];
    for (let i = 0; i < 12; i++) {
      pages.push([
        starEvent({
          id: `${i}`, actor: 'alice', repo: 'foo/bar',
          ts: `2026-05-10T11:${String(i).padStart(2, '0')}:00Z`,
        }),
      ]);
    }
    const { client, spy } = makeClient(pages);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    const payloads = await c.fetchSince(new Date('2020-01-01T00:00:00Z'));
    // Hard cap is 10 pages — see PAGE_CAP in lib/connectors/github.ts.
    expect(spy).toHaveBeenCalledTimes(10);
    expect(payloads).toHaveLength(10);
  });

  it('stops on the first empty page (no events left to drain)', async () => {
    // If the upstream returns [] before the time cutoff, the connector
    // must stop — continuing would either loop forever (if the empty
    // page were a hiccup) or burn API budget. Pin "empty page = done".
    const { client, spy } = makeClient([
      [starEvent({ id: '1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:05:00Z' })],
      [],
    ]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(spy).toHaveBeenCalledTimes(2);  // page 1, page 2 (empty → stop)
  });
});

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

describe('GitHubConnector.fetchSince — error wrapping', () => {
  it('wraps a 5xx into a ConnectorError preserving the cause AND status', async () => {
    // The orchestrator (Task 3.4) inspects `cause.status` to decide
    // between back-off (5xx, 429) and abort (4xx other than 404).
    // If the connector flattens to message-only, the orchestrator
    // can't make that distinction without re-parsing the message.
    const upstream = Object.assign(new Error('Internal Server Error'), { status: 500 });
    const client: GitHubEventsClient = {
      activity: { listRepoEvents: vi.fn().mockRejectedValue(upstream) },
    };
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);

    let caught: unknown;
    try { await c.fetchSince(new Date(0)); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(ConnectorError);
    const err = caught as ConnectorError;
    expect(err.cause).toBe(upstream);
    // The status should be retrievable from the original error via
    // err.cause — not parsed out of a message string.
    expect((err.cause as { status?: number }).status).toBe(500);
    expect(err.message).toMatch(/foo\/bar/);  // names the failing repo
  });

  it('wraps a 404 into ConnectorError with status preserved (orchestrator can skip the repo)', async () => {
    // A 404 on listRepoEvents means the repo was deleted/renamed/
    // made-private. The orchestrator should skip THAT repo on the
    // next poll, not crash the whole connector. The connector's job
    // is just to surface the status faithfully — policy lives in
    // the orchestrator. So this test pins "status flows through".
    const upstream = Object.assign(new Error('Not Found'), { status: 404 });
    const client: GitHubEventsClient = {
      activity: { listRepoEvents: vi.fn().mockRejectedValue(upstream) },
    };
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);

    let caught: unknown;
    try { await c.fetchSince(new Date(0)); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect(((caught as ConnectorError).cause as { status?: number }).status).toBe(404);
  });

  it('wraps a rate-limit (429/403 with rate-limit headers) into ConnectorError', async () => {
    // Octokit raises 429 OR 403 depending on which rate limiter
    // tripped — primary or secondary. Either way we want a typed
    // ConnectorError so the orchestrator can back off based on the
    // upstream's `retry-after` header (which the orchestrator reads
    // from `cause.response.headers`).
    const upstream = Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
      response: { headers: { 'retry-after': '60' } },
    });
    const client: GitHubEventsClient = {
      activity: { listRepoEvents: vi.fn().mockRejectedValue(upstream) },
    };
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);

    let caught: unknown;
    try { await c.fetchSince(new Date(0)); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect(((caught as ConnectorError).cause as { status?: number }).status).toBe(403);
    // The retry-after header must survive untouched — that's the
    // orchestrator's signal for how long to back off.
    const headers = ((caught as ConnectorError).cause as {
      response?: { headers?: Record<string, string> };
    }).response?.headers;
    expect(headers?.['retry-after']).toBe('60');
  });

  it('a failure mid-paginate aborts the whole entry (does not silently truncate)', async () => {
    // Subtle: if page 1 succeeds but page 2 throws, returning page 1's
    // events silently would corrupt the watermark advance — the
    // orchestrator would think it had drained everything through page
    // 1's oldest event, but page 2 had more. So a partial-page failure
    // must throw, NOT return partial results. Pin this so a future
    // "best-effort" refactor breaks the test.
    const upstream = Object.assign(new Error('Bad Gateway'), { status: 502 });
    const spy = vi.fn();
    spy.mockResolvedValueOnce({ data: [
      starEvent({ id: '1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:05:00Z' }),
    ] });
    spy.mockRejectedValueOnce(upstream);
    const client: GitHubEventsClient = { activity: { listRepoEvents: spy } };
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);

    await expect(c.fetchSince(new Date('2026-05-10T10:00:00Z'))).rejects.toThrow(ConnectorError);
  });
});

// --------------------------------------------------------------------------
// Multiple entries
// --------------------------------------------------------------------------

describe('GitHubConnector.fetchSince — multiple watch entries', () => {
  it('polls each entry independently and concatenates results', async () => {
    const spy = vi.fn();
    spy.mockImplementation((params: {
      owner: string; repo: string; page?: number;
    }) => {
      // Return data ONLY on page 1; subsequent pages are empty so the
      // pagination loop terminates per the "empty page → stop" rule.
      // A test that didn't model the empty-page boundary would drain
      // up to PAGE_CAP and pollute the assertion count.
      if (params.page !== 1) return Promise.resolve({ data: [] });
      if (params.owner === 'foo' && params.repo === 'bar') {
        return Promise.resolve({ data: [
          starEvent({ id: '1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
        ] });
      }
      if (params.owner === 'baz' && params.repo === 'qux') {
        return Promise.resolve({ data: [
          issueOpenedEvent({
            id: '2', actor: 'bob', repo: 'baz/qux', ts: '2026-05-10T11:00:00Z',
            title: 'Help', body: null, html_url: 'https://github.com/baz/qux/issues/1',
          }),
        ] });
      }
      return Promise.resolve({ data: [] });
    });
    const client: GitHubEventsClient = { activity: { listRepoEvents: spy } };
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
      { target: 'repo:baz/qux', signals: ['issue_create'], classification: 'competitor' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(payloads).toHaveLength(2);
    expect(payloads.map((p) => p.account_domain).sort()).toEqual([
      'github.com/alice', 'github.com/bob',
    ]);
  });
});

// --------------------------------------------------------------------------
// Idempotency
// --------------------------------------------------------------------------

describe('GitHubConnector.fetchSince — idempotency', () => {
  it('produces identical snippet/source_url for the same upstream event across two polls', async () => {
    // The orchestrator-level safety net is `evidence.dedupe_key`'s
    // UNIQUE index, which is a hash of (captured_by, source,
    // domain, url, sha256(snippet)[:16]). For overlapping polls to
    // be idempotent, the snippet (which feeds the SHA-256) MUST be
    // BYTE-IDENTICAL across polls of the same event. Test pins this:
    // if a future change introduces `Date.now()` or the poll
    // sequence number into the snippet, two polls of the same star
    // would produce different dedupe keys and create a duplicate
    // row.
    const ev = starEvent({
      id: '1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z',
    });
    const c = new GitHubConnector(
      makeClient([[ev]]).client,
      [{ target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' }],
    );
    const c2 = new GitHubConnector(
      makeClient([[ev]]).client,
      [{ target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' }],
    );
    const [a] = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    const [b] = await c2.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(a.snippet).toBe(b.snippet);
    expect(a.source_url).toBe(b.source_url);
    expect(a.account_domain).toBe(b.account_domain);
    expect(a.captured_at).toBe(b.captured_at);
  });
});
