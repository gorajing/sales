import { describe, it, expect, vi } from 'vitest';
import {
  GitHubConnector,
  parseWatchList,
  type GitHubEventsClient,
  type RepoEvent,
  type WatchSignal,
  type WatchClass,
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

  it('rejects a section with a typoed target (signals/classification present, target missing)', () => {
    // The hard case for the lenient-by-default parser: an operator
    // intended to declare an entry but typoed `- target:` (e.g.
    // `- targt:`). The section still has `- signals:` and
    // `- classification:` so the marker rule classifies it as
    // "intended entry" and the missing-field check fires. If a
    // future refactor narrowed the marker rule to only `- target:`,
    // this test would catch the regression — the typoed entry
    // would silently disappear.
    const md = `
## bad
- targt: repo:foo/bar
- signals: [stars]
- classification: prospect
`;
    expect(() => parseWatchList(md)).toThrow(/target/i);
  });

  it('skips a pure-docs section (no entry-field lines) without error', () => {
    // The complement of the previous test: a section that genuinely
    // documents something (no `- target:`, `- signals:`, or
    // `- classification:` lines) is silently ignored. This is what
    // makes the operator-friendly file layout work — docs can use
    // `##` headings freely.
    const md = `
## How matching works

Some prose explaining \`target\`, \`signals\`, and \`classification\`.

It even mentions "the - target field above" in prose, without a colon,
which should not match the entry marker regex.

## real-entry
- target: repo:foo/bar
- signals: [stars]
- classification: prospect
`;
    const list = parseWatchList(md);
    expect(list).toHaveLength(1);
    expect(list[0].target).toBe('repo:foo/bar');
  });

  it('strips fenced code blocks so example syntax in docs is not parsed as a real entry', () => {
    // Codex-flagged: a markdown example like the one inside the
    // fence below would otherwise be parsed as a real watch entry.
    // If the operator's example is a complete-looking entry, they'd
    // silently get an extra repo polled; if it has placeholders
    // (`repo:owner/name`), they'd get a Zod error at startup that
    // they wouldn't know how to fix because the source is in their
    // docs section.
    //
    // The parser strips ``` fences before section matching. This
    // test pins both directions: the fenced example is NOT parsed
    // as an entry, AND the real entry below it IS parsed.
    const md = `
## Example

Here's what a watch entry looks like:

\`\`\`md
- target: repo:owner/name
- signals: [stars]
- classification: prospect
\`\`\`

## real-entry
- target: repo:foo/bar
- signals: [stars]
- classification: prospect
`;
    const list = parseWatchList(md);
    expect(list).toHaveLength(1);
    expect(list[0].target).toBe('repo:foo/bar');
    // Confirm the placeholder example was NOT parsed (else we'd
    // have repo:owner/name in the list too).
    expect(list.find((e) => e.target.includes('owner/name'))).toBeUndefined();
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
  it('drains across pages, filtering old events per-event (no early-stop on first-old)', async () => {
    // Earlier design: stop as soon as any page contained an event
    // older than `since`. That relied on GitHub's Events API
    // returning events sorted newest-first ACROSS pages, which the
    // API docs don't explicitly guarantee — under slight cross-page
    // disorder a fresh event on page N+1 would be silently missed.
    //
    // Current design: drain to empty / PAGE_CAP, filter individual
    // events by their own timestamp, and rely on the
    // `evidence.dedupe_key` UNIQUE index to absorb redundant
    // fetches. GitHub retains ~300 events per repo total, so the
    // worst-case fetch count for a hot repo is ~3 pages anyway.
    //
    // Test layout (newest first, since=10:00):
    //   Page 1: 3 fresh events
    //   Page 2: 3 fresh events
    //   Page 3: 1 OLD event (filtered per-event)
    //   Page 4 (trailing empty in makeClient): [] → stop
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
    // 3 (page 1) + 3 (page 2) + 0 (page 3 — sole event was old) = 6.
    // The old event on page 3 is filtered out per-event, NOT used
    // as an early-stop signal — page 4 is the empty-page that
    // terminates the drain.
    expect(payloads).toHaveLength(6);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy.mock.calls[0][0]).toMatchObject({ owner: 'foo', repo: 'bar', page: 1 });
    expect(spy.mock.calls[3][0]).toMatchObject({ page: 4 });
  });

  it('keeps newer events on a later page even if an earlier page contains an old one (no early-stop)', async () => {
    // The whole point of dropping the early-stop: cross-page
    // ordering is not contractually guaranteed by GitHub's Events
    // API. This test pins that we do NOT trade correctness for an
    // empty-fetch saving — if page 1 has a stray-old event but
    // page 2 has fresh events, we keep both.
    //
    // A regression that re-introduces "first old in page → stop"
    // would fetch page 1 only and miss the fresh event on page 2,
    // and this test would fail loudly.
    const { client, spy } = makeClient([
      [
        starEvent({ id: '1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:05:00Z' }),
        // Stray old event on page 1 — possible under cross-page
        // disorder.
        starEvent({ id: '2', actor: 'alice', repo: 'foo/bar', ts: '2026-05-09T11:05:00Z' }),
      ],
      [
        starEvent({ id: '3', actor: 'bob',   repo: 'foo/bar', ts: '2026-05-10T11:06:00Z' }),
      ],
    ]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    // alice from page 1 + bob from page 2 = 2 fresh. The old alice
    // event was filtered. Total fetches: 1, 2, 3 (page 3 = empty).
    expect(payloads.map((p) => p.account_domain).sort()).toEqual([
      'github.com/alice', 'github.com/bob',
    ]);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('a single mixed page (some events kept, some dropped per-event) emits the kept ones intact', async () => {
    // Codex-flagged test gap: the earlier suite had no test for a
    // single page with mixed-age events. Pin the per-event filter.
    const { client } = makeClient([
      [
        starEvent({ id: 'k1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:05:00Z' }),
        starEvent({ id: 'd1', actor: 'eve',   repo: 'foo/bar', ts: '2026-05-09T11:05:00Z' }),
        starEvent({ id: 'k2', actor: 'bob',   repo: 'foo/bar', ts: '2026-05-10T11:04:00Z' }),
        starEvent({ id: 'd2', actor: 'mal',   repo: 'foo/bar', ts: '2026-05-08T11:05:00Z' }),
      ],
    ]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(payloads).toHaveLength(2);
    expect(payloads.map((p) => p.account_domain).sort()).toEqual([
      'github.com/alice', 'github.com/bob',
    ]);
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

// --------------------------------------------------------------------------
// Robustness against malformed events
// --------------------------------------------------------------------------

describe('GitHubConnector.fetchSince — robustness', () => {
  it('skips events whose actor.login violates GitHub username rules', async () => {
    // Codex-flagged: actor.login feeds account_domain. If GitHub
    // ever returned a malformed login (slash, whitespace, empty),
    // we'd coin an impostor-looking account row like
    // `github.com/foo/bar` that downstream routing might treat as
    // genuine. The connector skips invalid logins.
    const bad: RepoEvent[] = [
      // Slash — most dangerous (would split the account_domain path).
      starEvent({ id: '1', actor: 'foo/bar', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
      // Whitespace.
      starEvent({ id: '2', actor: 'has space', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
      // Leading hyphen — GitHub doesn't allow this.
      starEvent({ id: '3', actor: '-leading', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
      // Trailing hyphen.
      starEvent({ id: '4', actor: 'trailing-', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
      // Consecutive hyphens.
      starEvent({ id: '5', actor: 'has--double', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
      // Empty string (treated as falsy → already skipped, but pin it).
      starEvent({ id: '6', actor: '', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
      // Good login — survives.
      starEvent({ id: '7', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
    ];
    const { client } = makeClient([bad]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].account_domain).toBe('github.com/alice');
  });

  it('skips events with a malformed created_at (NaN) without affecting other events on the page', async () => {
    // Codex-flagged: `new Date('not-a-date').getTime()` is NaN.
    // NaN compares false against everything, so the old code would
    // not catch it via `ts < sinceMs` and would emit it with
    // captured_at='not-a-date' — which ingestSignal would then
    // reject. The connector skips malformed timestamps and
    // continues to process the rest of the page.
    const { client } = makeClient([
      [
        {
          id: 'bad', type: 'WatchEvent', actor: { login: 'alice' },
          repo: { name: 'foo/bar' }, created_at: 'not-a-date',
          payload: { action: 'started' },
        } as RepoEvent,
        starEvent({ id: '2', actor: 'bob', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z' }),
      ],
    ]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['stars'], classification: 'prospect' },
    ]);
    const payloads = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].account_domain).toBe('github.com/bob');
  });

  it('does not split a surrogate pair when trimming a long issue body to the 1500-char cap', async () => {
    // Codex-flagged nit: `.slice(0, 1500)` operates on UTF-16 code
    // units, so a 4-byte emoji landing at the boundary could be
    // split, leaving a dangling high surrogate. The safeSlice
    // helper backs off the cap by one if the boundary char is a
    // high surrogate. We construct a body whose 1500th UTF-16
    // unit is a high surrogate to exercise it.
    //
    // We use the 'pile of poo' emoji (U+1F4A9) — encoded in UTF-16
    // as the surrogate pair [0xD83D, 0xDCA9]. The body's length
    // before the emoji is set so the emoji starts exactly at
    // character 1499 (a high surrogate at index 1499, low
    // surrogate at 1500).
    const title = 'T';
    // title + '\n\n' = 3 chars. We want char 1499 to be the high
    // surrogate, so padding length = 1499 - 3 = 1496.
    const padding = 'a'.repeat(1496);
    const body = padding + '💩 trailing';  // poo + ' trailing'
    const { client } = makeClient([[
      issueOpenedEvent({
        id: '1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z',
        title, body, html_url: 'https://github.com/foo/bar/issues/1',
      }),
    ]]);
    const c = new GitHubConnector(client, [
      { target: 'repo:foo/bar', signals: ['issue_create'], classification: 'prospect' },
    ]);
    const [p] = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
    // Snippet must be capped to 1499 (one less than 1500 due to
    // the surrogate trim) — and the trailing char must NOT be a
    // dangling high surrogate. The well-formedness check: every
    // high surrogate must be followed by a low surrogate.
    expect(p.snippet.length).toBeLessThanOrEqual(1500);
    for (let i = 0; i < p.snippet.length; i++) {
      const code = p.snippet.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        // High surrogate; the next char MUST be a low surrogate.
        const next = p.snippet.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
      }
    }
  });
});

// --------------------------------------------------------------------------
// Real watch file
// --------------------------------------------------------------------------

describe('parseWatchList — committed data/github-watch.md', () => {
  it('successfully parses the committed watch file (regression: codex round 1 blocker)', async () => {
    // The original commit shipped a data/github-watch.md whose own
    // documentation used ## headings; parseWatchList treated them
    // as missing-field entries and the whole file failed to load
    // at startup. The fix skips doc-only sections (no `- target:`).
    // This test loads the actual committed file, which is the only
    // way to catch a regression of that exact bug — any fixture
    // inside the test file would diverge from the shipped content.
    //
    // Resolution uses `import.meta.url` instead of `process.cwd()`
    // so vitest invocations from a different cwd (--root flag, IDE
    // runners, monorepo configs) still find the file. The path is
    // relative to THIS test file, not the working directory.
    const { readFileSync } = await import('node:fs');
    const fileUrl = new URL('../../data/github-watch.md', import.meta.url);
    const md = readFileSync(fileUrl, 'utf8');
    const entries = parseWatchList(md);
    // Don't pin exact entries — operators will add and remove
    // them over time. Just confirm we got at least one and that
    // each parses as a valid WatchEntry shape (Zod-narrowed).
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const e of entries) {
      expect(e.target.startsWith('repo:')).toBe(true);
      expect(e.signals.length).toBeGreaterThanOrEqual(1);
      expect(['prospect', 'competitor', 'neutral']).toContain(e.classification);
    }
  });

  it('still parses a file with no --- separator (header-less watch file)', () => {
    // The separator is a docs-convention. If an operator writes a
    // minimal watch file with no preamble, every section is an
    // entry. Test pins this fallback so a future "require ---"
    // refactor breaks loudly.
    const md = `## repo-one
- target: repo:foo/bar
- signals: [stars]
- classification: prospect
`;
    expect(parseWatchList(md)).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// Idempotency
// --------------------------------------------------------------------------

describe('GitHubConnector.fetchSince — idempotency', () => {
  // The orchestrator-level safety net is `evidence.dedupe_key`'s
  // UNIQUE index, which is a hash of (captured_by, source, domain,
  // url, sha256(snippet)[:16]). For overlapping polls to be
  // idempotent, EVERY field that feeds the dedupe key must be
  // byte-identical across polls of the same event.
  //
  // The strong proof: ONE connector, ONE fake client whose
  // listRepoEvents returns the SAME event on multiple calls, with
  // `Date.now()` mocked to advance between the calls (catching any
  // accidental `Date.now()` injection into snippet/url/domain).
  // We compute the SHA-256 of the snippet directly to mirror the
  // dedupe-key formula exactly — comparing strings would catch
  // "snippet differs," but the explicit hash check matches what
  // ingest does at the boundary and rules out any
  // platform/encoding subtlety in the comparison.
  function makeSameEventClient(ev: RepoEvent): GitHubEventsClient {
    const spy = vi.fn();
    // Return the event on EVERY call. The pagination loop will see
    // it on page 1, then empty on page 2, then stop. Repeated
    // fetchSince calls re-trigger this from page 1.
    spy.mockImplementation((params: { page?: number }) =>
      Promise.resolve({ data: params.page === 1 ? [ev] : [] }),
    );
    return { activity: { listRepoEvents: spy } };
  }

  async function sha256Hex(s: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(s, 'utf8').digest('hex');
  }

  /** Run two fetchSince calls on the same connector with Date.now()
   *  advanced between them. Returns the two payloads for comparison. */
  async function twoPolls(ev: RepoEvent, signal: WatchSignal, classification: WatchClass) {
    const c = new GitHubConnector(makeSameEventClient(ev), [
      { target: 'repo:foo/bar', signals: [signal], classification },
    ]);
    const realNow = Date.now;
    try {
      // First poll at t=0 (mock-time).
      Date.now = () => new Date('2026-05-10T12:00:00Z').getTime();
      const [a] = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
      // Advance Date.now by 5 minutes before the second poll. If
      // any code path called `Date.now()` during fetchSince and
      // embedded it in the output, the two payloads would diverge
      // here.
      Date.now = () => new Date('2026-05-10T12:05:00Z').getTime();
      const [b] = await c.fetchSince(new Date('2026-05-10T10:00:00Z'));
      return [a, b] as const;
    } finally {
      Date.now = realNow;
    }
  }

  it('star event: dedupe-key material is identical across polls with Date.now advanced', async () => {
    const ev = starEvent({
      id: '1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z',
    });
    const [a, b] = await twoPolls(ev, 'stars', 'prospect');
    // Every field that feeds the dedupe_key:
    expect(a.captured_by).toBe(b.captured_by);
    expect(a.source).toBe(b.source);
    expect(a.account_domain).toBe(b.account_domain);
    expect(a.source_url).toBe(b.source_url);
    expect(a.snippet).toBe(b.snippet);
    // And, redundantly, the SHA-256 prefix that the dedupe formula
    // computes from snippet — proves byte-level identity.
    expect((await sha256Hex(a.snippet)).slice(0, 16))
      .toBe((await sha256Hex(b.snippet)).slice(0, 16));
    // captured_at isn't part of the dedupe key but is also a poll-
    // sensitive field worth confirming stable.
    expect(a.captured_at).toBe(b.captured_at);
  });

  it('issue_create event: dedupe-key material is identical across polls with Date.now advanced', async () => {
    const ev = issueOpenedEvent({
      id: 'iss-1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z',
      title: 'Bug', body: 'Repro: ...',
      html_url: 'https://github.com/foo/bar/issues/1',
    });
    const [a, b] = await twoPolls(ev, 'issue_create', 'prospect');
    expect(a.snippet).toBe(b.snippet);
    expect(a.source_url).toBe(b.source_url);
    expect(a.account_domain).toBe(b.account_domain);
    expect((await sha256Hex(a.snippet)).slice(0, 16))
      .toBe((await sha256Hex(b.snippet)).slice(0, 16));
  });

  it('pr_merge_external event: dedupe-key material is identical across polls with Date.now advanced', async () => {
    const ev = prClosedEvent({
      id: 'pr-1', actor: 'alice', repo: 'foo/bar', ts: '2026-05-10T11:00:00Z',
      title: 'Refactor', body: 'See description',
      html_url: 'https://github.com/foo/bar/pull/1', merged: true,
    });
    const [a, b] = await twoPolls(ev, 'pr_merge_external', 'competitor');
    expect(a.snippet).toBe(b.snippet);
    expect(a.source_url).toBe(b.source_url);
    expect(a.account_domain).toBe(b.account_domain);
    expect((await sha256Hex(a.snippet)).slice(0, 16))
      .toBe((await sha256Hex(b.snippet)).slice(0, 16));
  });
});
