import { Octokit } from '@octokit/rest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { SignalConnector, ConnectorPayload } from './types';
import { ConnectorError } from './types';

// --------------------------------------------------------------------------
// Watch-list grammar.
//
// `data/github-watch.md` is the operator's deploy-time config — one
// markdown section per watched repo. The schema below is the SINGLE source
// of truth for what a section is allowed to contain. Editing this enum
// list and forgetting to update `data/github-watch.md` will trip a parser
// error and refuse to load, which is the desired loud-failure behavior.
// --------------------------------------------------------------------------

const VALID_SIGNALS = ['stars', 'issue_create', 'pr_merge_external'] as const;
const VALID_CLASS = ['prospect', 'competitor', 'neutral'] as const;

export type WatchSignal = typeof VALID_SIGNALS[number];
export type WatchClass = typeof VALID_CLASS[number];

/**
 * The target format `repo:<owner>/<name>` is the only kind v1 supports.
 *
 * `org:` and `user:` require a different endpoint
 * (`/orgs/{org}/events`, `/users/{user}/events`) and different pagination
 * semantics (the orgs endpoint includes private events visible only to
 * the auth'd user). Adding them is deferred to v1.5; rejecting them
 * loudly here means an operator who writes `org:foo` doesn't silently
 * get zero events forever — the file fails to load.
 */
const REPO_TARGET_RE = /^repo:[^/]+\/[^/]+$/;

const WatchEntrySchema = z.object({
  target: z.string().regex(
    REPO_TARGET_RE,
    'unsupported target — only repo:<owner>/<name> in v1',
  ),
  signals: z.array(z.enum(VALID_SIGNALS)).min(1),
  classification: z.enum(VALID_CLASS),
});

export type WatchEntry = z.infer<typeof WatchEntrySchema>;

/**
 * Parse `data/github-watch.md` into a list of `WatchEntry`. Strict: any
 * malformed entry rejects the whole file with a Zod-pathed error, so an
 * operator who typos `classification: enemy_of_the_state` doesn't get a
 * partial poll set with their typo silently dropped.
 *
 * File layout (recommended convention):
 *   # Title
 *   <prose docs, optionally using `##` doc headings, `---` rules>
 *   ---
 *   ## repo-heading
 *   - target: repo:<owner>/<name>
 *   - signals: [a, b, c]
 *   - classification: prospect|competitor|neutral
 *   ...
 *
 * # Section detection rule
 *
 * The parser splits on `^## ` and treats a section as a watch entry
 * iff its body contains any of the three entry-field lines
 * (`- target:`, `- signals:`, `- classification:`). Sections with
 * none of those lines are docs (e.g. `## How matching works` with
 * prose only) and are silently skipped. Sections with at least one
 * but missing others surface a loud missing-field error so a
 * typoed entry doesn't silently disappear.
 *
 * Before matching, fenced code blocks (```...```) are stripped so
 * markdown examples of entry syntax inside docs don't get parsed as
 * real entries. Operators routinely paste an example like
 *   ```md
 *   - target: repo:owner/name
 *   ```
 * to teach the next person what the file looks like; without the
 * strip, the example would either fail validation (placeholder
 * values) or, worse, silently install a phantom watch entry.
 *
 * Layout is intentionally lenient (operators can put docs anywhere
 * with `##` headings used freely); recognized entries are
 * intentionally strict (any field present forces the missing-fields
 * check, and validated entries must pass Zod).
 */
export function parseWatchList(md: string): WatchEntry[] {
  const out: WatchEntry[] = [];
  // Strip Markdown fenced code blocks before any further processing.
  // Per CommonMark:
  //   - Fence opener: 0–3 leading spaces, then 3+ backticks OR 3+
  //     tildes (the marker, HOMOGENEOUS — no mixed chars), optional
  //     info string on the rest of the line.
  //   - Fence closer: same marker character, same-or-LONGER run
  //     length, 0–3 leading spaces, nothing else on the line. A
  //     shorter run or different-char sequence does NOT close.
  // The opener regexes are character-specific (backtick-only or
  // tilde-only) so a mixed marker like ```~~~ does NOT register as a
  // 6-char backtick fence — it's actually a 3-backtick opener with
  // `~~~` as its info string. Likewise a mixed line like ``~~~ does
  // NOT close a backtick fence — only homogeneous ``` does.
  // An unclosed fence drops the rest of the file, which is loud-
  // failure shaped: zero entries → operator notices the watch list
  // isn't polling anything. We prefer this over silently parsing a
  // half-fenced example as an entry.
  //
  // Limitation: CommonMark allows list-item containers to add their
  // own indentation, so a fence nested under a list could have more
  // than 3 leading raw spaces. The connector only recognizes
  // unindented (column-0) `- target:` lines as entry markers, so a
  // list-nested fence wouldn't shift parsing anyway. Documenting
  // here so the limitation is intentional rather than accidental.
  const lines = md.split('\n');
  const sanitizedLines: string[] = [];
  // fenceMarker: null = outside; otherwise the homogeneous run
  // (e.g. '```' or '~~~~'). We compare both first-char and length
  // when matching close so the inversion of backtick/tilde
  // (different opener vs. close attempt) is rejected.
  let fenceMarker: string | null = null;
  const OPEN_BACKTICK_RE = /^ {0,3}(`{3,})/;
  const OPEN_TILDE_RE = /^ {0,3}(~{3,})/;
  const CLOSE_BACKTICK_RE = /^ {0,3}(`{3,})\s*$/;
  const CLOSE_TILDE_RE = /^ {0,3}(~{3,})\s*$/;
  for (const line of lines) {
    if (fenceMarker) {
      // Inside fence — look for the homogeneous closer matching
      // the OPENER's char and length-or-greater.
      const closeRe = fenceMarker[0] === '`' ? CLOSE_BACKTICK_RE : CLOSE_TILDE_RE;
      const close = line.match(closeRe);
      if (close && close[1].length >= fenceMarker.length) {
        fenceMarker = null;
      }
      continue;  // drop every line inside the fence (and the closer)
    }
    // Outside fence — is this line an opener? Try backtick first,
    // then tilde. The regexes are mutually exclusive (each requires
    // its own char), so order doesn't change which fires.
    const openB = line.match(OPEN_BACKTICK_RE);
    if (openB) {
      fenceMarker = openB[1];
      continue;  // drop the opener line
    }
    const openT = line.match(OPEN_TILDE_RE);
    if (openT) {
      fenceMarker = openT[1];
      continue;
    }
    sanitizedLines.push(line);
  }
  const sanitized = sanitizedLines.join('\n');

  // Split on `^## ` headings. The first chunk is the file preamble
  // (anything before the first `##`), which we drop.
  const sections = sanitized.split(/^## /m).slice(1);
  const errors: string[] = [];

  // Marker for "this section is intended to be a watch entry, not
  // pure docs." A section qualifies if it contains ANY of the three
  // entry-field lines (`- target:`, `- signals:`, `- classification:`).
  // Pure-docs sections (e.g. `## How matching works` with prose only)
  // contain none of them and are skipped silently.
  //
  // Why ANY rather than just `- target:`: an operator who typos
  // `- targt: repo:foo/bar` would otherwise have their section
  // silently classified as docs and the repo would never be polled.
  // With this rule, the typoed section still triggers the
  // missing-fields error path (because target is missing, signals
  // and/or classification are present), so the operator sees a loud
  // failure naming the bad section.
  //
  // Docs containing `- target` (no colon) or `\`target\`` in prose
  // don't match — the colon-after pattern is a strong syntactic
  // signal of operator intent to declare a field value.
  const ENTRY_MARKER_RE = /^- (target|signals|classification):/m;

  for (const section of sections) {
    const heading = section.split('\n')[0].trim();
    if (!ENTRY_MARKER_RE.test(section)) {
      // Doc-only section — skip.
      continue;
    }

    const target = section.match(/^- target:\s*(\S+)/m)?.[1];
    const signalsRaw = section.match(/^- signals:\s*\[([^\]]*)\]/m)?.[1];
    const classification = section.match(/^- classification:\s*(\S+)/m)?.[1];

    const missing: string[] = [];
    if (!target) missing.push('target');
    if (!signalsRaw) missing.push('signals');
    if (!classification) missing.push('classification');
    if (missing.length) {
      errors.push(`[${heading}] missing required field(s): ${missing.join(', ')}`);
      continue;
    }

    // Even with all three present, validate the values via Zod so a
    // future schema tightening (e.g. lowercase-only classification)
    // catches operator typos without us hand-rolling the check.
    const signals = signalsRaw!.split(',').map((s) => s.trim()).filter(Boolean);
    const parsed = WatchEntrySchema.safeParse({ target, signals, classification });
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `[${i.path.join('.') || '(root)'}] ${i.message}`)
        .join('; ');
      errors.push(`[${heading}] ${detail}`);
      continue;
    }
    out.push(parsed.data);
  }

  if (errors.length) {
    // No partial load — fail the whole file. The operator should see
    // every problem at once so a multi-error commit doesn't require
    // multiple round-trips to fix.
    throw new Error(`bad github-watch.md:\n  ${errors.join('\n  ')}`);
  }
  return out;
}

// --------------------------------------------------------------------------
// GitHub events client interface (test seam).
//
// The connector consumes `octokit.activity.listRepoEvents` only. A
// narrowed interface lets test fixtures supply a typed fake (no `as any`)
// AND lets a real Octokit instance satisfy the same contract — the real
// client has many more methods, but we only depend on this one.
//
// A future fork that switches off Octokit (e.g. to a thin `fetch` wrapper
// to drop the dependency) only has to satisfy this interface.
// --------------------------------------------------------------------------

/**
 * Shape of a GitHub event as returned by `/repos/{owner}/{repo}/events`.
 *
 * Nullability mirrors Octokit's wire types: `type` and `created_at`
 * are both `string | null` because GitHub's OpenAPI spec marks them so
 * (some legacy/anonymous events have nulls). `mapEvent` returns `null`
 * for events with no type and the pagination loop skips events with no
 * `created_at` (we can't time-filter what we can't parse). The remaining
 * fields are narrower than Octokit's full shape — structural typing
 * means an Octokit event (which has `actor: { id, login, ...}`) is
 * trivially assignable to `actor: { login: string } | null`.
 */
export interface RepoEvent {
  id: string;
  type: string | null;
  actor: { login: string } | null;
  repo: { name: string };
  created_at: string | null;
  payload?: {
    action?: string;
    issue?: { title?: string; body?: string | null; html_url?: string };
    pull_request?: {
      title?: string; body?: string | null;
      html_url?: string; merged?: boolean;
    };
  };
}

export interface GitHubEventsClient {
  activity: {
    listRepoEvents(params: {
      owner: string;
      repo: string;
      per_page?: number;
      page?: number;
    }): Promise<{ data: RepoEvent[] }>;
  };
}

// --------------------------------------------------------------------------
// Pagination limits.
//
// `PER_PAGE` is the max GitHub allows; smaller pages just mean more
// round-trips. `PAGE_CAP` bounds the worst case: a `since` set to the
// epoch on a hot repo would otherwise drain forever, burning API budget
// and orchestrator time. GitHub's Events API retains roughly 30 days /
// 300 events per repo (3 pages at PER_PAGE=100), so PAGE_CAP=10 is
// well above the documented limit — the cap is the defense if that
// limit changes upstream.
// --------------------------------------------------------------------------

const PER_PAGE = 100;
const PAGE_CAP = 10;

// --------------------------------------------------------------------------
// GitHub login regex.
//
// GitHub usernames are documented as alphanumeric + single hyphens,
// 1-39 chars, no leading/trailing/consecutive hyphens. The connector
// rejects events whose actor.login violates this — a login containing
// `/`, whitespace, or other punctuation would otherwise leak into
// `account_domain = github.com/${actor}` and produce a fake-looking
// account row. The check defends against API-shape changes too:
// a future field rename or impostor schema can't produce a malformed
// `login` value that slips into our account namespace.
// --------------------------------------------------------------------------

const GITHUB_LOGIN_RE = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

// --------------------------------------------------------------------------
// Snippet helper: cap to N characters without splitting a surrogate
// pair. `.slice(0, N)` is in UTF-16 code units, so capping in the
// middle of a multi-code-unit emoji (e.g. 👨‍💻) can leave a dangling
// high surrogate which renders as `�`. The trim is cheap (one char
// inspection at the boundary) and keeps snippets visually clean.
// --------------------------------------------------------------------------

function safeSlice(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  // High surrogate range. If the cap-1 char is a high surrogate, the
  // cap would split the pair — back off by one so the surrogate is
  // either kept whole (if pair-completed by char[n]) or fully dropped.
  if (code >= 0xd800 && code <= 0xdbff) return s.slice(0, n - 1);
  return s.slice(0, n);
}

// --------------------------------------------------------------------------
// The connector.
// --------------------------------------------------------------------------

/**
 * Pulls public-event signals from GitHub (stars, issues, PR merges) per
 * the operator-configured watch list. Emits `ConnectorPayload`-shaped
 * events for the orchestrator (Task 3.4) to feed through `ingestSignal`.
 *
 * # Contract recap (from `SignalConnector` / `docs/connectors.md`)
 *
 *   - This class does NOT write to the database. The orchestrator owns
 *     ingest. A future contributor who imports `db` here is breaking
 *     the layered-trust model documented in `docs/connectors.md`.
 *   - Output is `ConnectorPayload[]`, not `SignalPayload[]`. The
 *     narrower type forces TypeScript to confirm `captured_by` is
 *     `connector_github` on every emission.
 *   - Transient upstream failures surface as `ConnectorError` with
 *     `cause` preserved (status, response headers, etc.). The
 *     orchestrator inspects `cause.status` to choose backoff vs. abort.
 *
 * # Trust framing
 *
 * GitHub API responses are STRUCTURALLY trustworthy (well-known shape)
 * but NOT semantically authoritative — `actor.login` is self-reported.
 * Anyone can register a github.com account and star a repo. We trust
 * THIS CODE (it's in our deploy artifact) and the API endpoint
 * identity (TLS + token-auth). We do NOT trust the actor's claimed
 * identity for routing decisions; the orchestrator should use
 * repo + event type, not actor login, as the routable signal.
 *
 * # Idempotency
 *
 * `snippet` is built from event-data only (id, actor login, repo
 * name, `created_at`) — no `Date.now()`, no poll-attempt counter.
 * Re-polling the same event therefore produces a byte-identical
 * snippet, which produces a byte-identical dedupe_key downstream.
 * Overlapping polls (restart, retry, two operators triggering a
 * poll) hit the `evidence.dedupe_key` UNIQUE index and are dropped
 * without duplication.
 *
 * # All-or-nothing across watch entries
 *
 * `fetchSince` polls each entry serially and any ConnectorError
 * aborts the whole call (subsequent entries are not polled). This
 * matches the `SignalConnector` interface contract — see the
 * "All-or-nothing across watch entries" section in
 * `lib/connectors/types.ts`. The orchestrator (Task 3.4) is
 * responsible for whole-connector backoff on error; if it needs
 * to skip a single failed repo on the next poll it should remove
 * that entry from the watch list, not partially retry.
 */
export class GitHubConnector implements SignalConnector {
  readonly name = 'github';

  constructor(
    private readonly client: GitHubEventsClient,
    private readonly watchList: WatchEntry[],
  ) {}

  /**
   * Real-world factory: reads `GITHUB_TOKEN` from env, instantiates
   * Octokit, loads `data/github-watch.md`. Test code constructs the
   * class directly with a fake `GitHubEventsClient` instead.
   */
  static fromEnv(): GitHubConnector {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      // Auth errors are programming/configuration mistakes, not
      // transient failures — ConnectorError so the orchestrator can
      // surface "GitHub connector disabled — set GITHUB_TOKEN" in
      // logs without crashing other connectors.
      throw new ConnectorError('GITHUB_TOKEN env var not set');
    }
    const octokit = new Octokit({ auth: token });
    // Adapter: Octokit's `listRepoEvents` returns the full
    // OctokitResponse (status, headers, url, data) and an event
    // type wider than `RepoEvent`. The connector consumes only
    // `data`. Narrow here so the production code path goes through
    // the SAME `GitHubEventsClient` shape the tests exercise — if a
    // future Octokit upgrade changes the wire types, this adapter
    // is the one place that has to know.
    //
    // Prefer the namespaced `octokit.rest.activity` alias over the
    // top-level `octokit.activity`. Both work today; the namespaced
    // form is the one Octokit guarantees across major versions, and
    // confining the cast to a single line here keeps the
    // version-coupling explicit.
    const client: GitHubEventsClient = {
      activity: {
        async listRepoEvents(params) {
          const r = await octokit.rest.activity.listRepoEvents(params);
          // The wire shape from Octokit is structurally a superset
          // of `RepoEvent` (more fields per event, plus wrapper
          // metadata we don't use). The cast narrows from the
          // wider Octokit response to our subset; both sides agree
          // on nullability of `type` and `created_at`.
          return { data: r.data as RepoEvent[] };
        },
      },
    };
    const md = readFileSync(resolve(process.cwd(), 'data/github-watch.md'), 'utf8');
    return new GitHubConnector(client, parseWatchList(md));
  }

  async fetchSince(since: Date): Promise<ConnectorPayload[]> {
    const out: ConnectorPayload[] = [];
    for (const entry of this.watchList) {
      const events = await this.fetchEntryEvents(entry, since);
      out.push(...events);
    }
    return out;
  }

  // --- internal -----------------------------------------------------------

  /**
   * Drain pages of `listRepoEvents` for one watch entry until we hit
   * an empty page or the page cap. Each page is fetched in series —
   * parallel page fetches would race with rate limits and complicate
   * watermark semantics.
   *
   * # Why no early-stop on "first old event"
   *
   * An earlier version stopped the drain as soon as any event in a
   * page was older than `since`. That assumed GitHub returns events
   * strictly sorted newest-first across pages, but the Events API
   * docs don't explicitly guarantee this — the worst case under
   * slight cross-page disorder is that newer events on page N+1 are
   * silently missed. The current design drains every page within
   * the cap, filters individual events by their own timestamp, and
   * relies on the `evidence.dedupe_key` UNIQUE index downstream to
   * absorb the redundant fetches when overlapping windows occur.
   *
   * GitHub's repo-events endpoint has no `since` query parameter,
   * so `since` is purely a client-side filter. A "stale" repo with
   * retained but old events therefore drains as many pages as the
   * API returns (up to its documented 300-event / 30-day cap, ≈3
   * pages at PER_PAGE=100), filtering them all out and stopping on
   * the next empty page. Bounded but not zero-cost; the alternative
   * (early-stop) would be cheaper but unsound.
   *
   * Stop conditions, in priority order:
   *   1. Page returned 0 events → no more to drain.
   *   2. PAGE_CAP reached → defensive bound; the operator's `since`
   *      may be wrong, but we still return a useful slice.
   */
  private async fetchEntryEvents(entry: WatchEntry, since: Date): Promise<ConnectorPayload[]> {
    const ref = entry.target.slice('repo:'.length);
    // The regex in WatchEntrySchema guarantees exactly one '/' so
    // this destructure is safe; we re-derive owner/repo rather than
    // storing them parsed because the regex IS the canonical parse.
    const [owner, repo] = ref.split('/');

    const out: ConnectorPayload[] = [];
    const sinceMs = since.getTime();

    for (let page = 1; page <= PAGE_CAP; page++) {
      let raw: RepoEvent[];
      try {
        const r = await this.client.activity.listRepoEvents({
          owner, repo, per_page: PER_PAGE, page,
        });
        raw = r.data;
      } catch (err) {
        // Wrap, preserve cause. Don't try to classify status here —
        // that's orchestrator policy. The cause carries `status` and
        // `response.headers.retry-after` so the orchestrator can
        // back off intelligently.
        throw new ConnectorError(
          `GitHub listRepoEvents failed for ${owner}/${repo} (page ${page}): ` +
          `${(err as Error).message}`,
          err,
        );
      }

      if (raw.length === 0) break;

      for (const ev of raw) {
        // Skip events with no timestamp. Octokit's types say
        // `created_at` can be null (rare anonymous events). Without
        // this guard, downstream parsing would emit NaN as
        // `captured_at` and ingestSignal would reject the row.
        if (!ev.created_at) continue;
        // GitHub's `created_at` is ISO-8601 with Z offset.
        // ingestSignal normalizes again at the write boundary, so
        // even if a future API quirk returned an unusual format, the
        // canonical normalization wins downstream.
        const ts = new Date(ev.created_at).getTime();
        // Malformed timestamps (`new Date("not-a-date").getTime()`
        // returns NaN) compare false against everything. Skip them
        // explicitly so a bad event doesn't end up emitted with a
        // captured_at that ingestSignal would later reject.
        if (!Number.isFinite(ts)) continue;
        if (ts < sinceMs) continue;
        const mapped = this.mapEvent(ev, entry);
        if (mapped) out.push(mapped);
      }
    }

    return out;
  }

  /**
   * Map one GitHub event to a `ConnectorPayload`, or `null` if this
   * event isn't actionable for this entry (wrong type, not in
   * `entry.signals`, missing actor, etc.).
   *
   * The branching is per-event-type rather than a generic table so
   * each branch can deal with its specific payload shape (issue body
   * vs. PR body vs. nothing-but-actor for stars).
   */
  private mapEvent(ev: RepoEvent, entry: WatchEntry): ConnectorPayload | null {
    // Defensive null checks — some GitHub events have null actor
    // (anonymous org-level events) or null created_at (the upstream
    // pagination loop already skips null created_at, but a future
    // caller that uses mapEvent directly shouldn't crash). The
    // plan's `ev.actor.login` access would crash; we skip instead
    // so one weird event doesn't poison the whole batch.
    if (!ev.actor?.login) return null;
    if (!ev.created_at) return null;
    const actor = ev.actor.login;
    // Reject logins that don't match GitHub's documented username
    // format. The account_domain is built as `github.com/${actor}`,
    // so a login containing `/` or whitespace would create a
    // confusing or impostor-looking account row. Skipping here is
    // the conservative call — the alternative (sanitizing) would
    // mask a real upstream-shape-change. This bit of strictness is
    // what the jsdoc means by "we don't trust GitHub actor identity
    // for routing" — we don't crash on a malformed identity, we
    // refuse to coin one.
    if (!GITHUB_LOGIN_RE.test(actor)) return null;
    const capturedAt = ev.created_at;

    const base = {
      source: 'github_event' as const,
      // ConnectorPayload narrows captured_by to `connector_*` — this
      // literal type is what makes the whole class output type-check
      // as `ConnectorPayload[]`.
      captured_by: 'connector_github' as const,
    };

    // -- stars (WatchEvent) ------------------------------------------------
    if (ev.type === 'WatchEvent' && entry.signals.includes('stars')) {
      return {
        ...base,
        account_domain: `github.com/${actor}`,
        // A competitor's customers starring our adjacent space is a
        // trigger event (someone might be evaluating); a prospect's
        // own activity is general engagement. The classification
        // label is the operator's intent, set per-entry.
        signal_type: entry.classification === 'competitor' ? 'trigger_event' : 'engagement',
        fact: `${actor} starred ${ev.repo.name}`,
        source_url: `https://github.com/${ev.repo.name}/stargazers`,
        // Including `ev.created_at` makes the snippet stable across
        // re-polls of the SAME event — see the idempotency note in
        // the class jsdoc.
        snippet: `${actor} starred ${ev.repo.name} at ${capturedAt}`,
        captured_at: capturedAt,
        metadata: { event_id: ev.id, classification: entry.classification },
      };
    }

    // -- issue creation (IssuesEvent action=opened) ------------------------
    if (
      ev.type === 'IssuesEvent'
      && ev.payload?.action === 'opened'
      && entry.signals.includes('issue_create')
    ) {
      const issue = ev.payload?.issue;
      // Title is required for a meaningful snippet. If GitHub returns
      // a malformed event (no title / no url), skip rather than emit
      // a junk row that would fail Zod validation downstream.
      if (!issue?.title || !issue.html_url) return null;
      return {
        ...base,
        account_domain: `github.com/${actor}`,
        signal_type: 'engagement',
        fact: `${actor} opened issue: ${issue.title}`,
        source_url: issue.html_url,
        // Cap at 1500 chars — issue bodies can be huge, and
        // SignalPayload caps `snippet` already, but trimming here
        // makes the dedupe_key SHA stable to body edits beyond 1500
        // chars (an edit to char 1600 produces the same dedupe).
        snippet: safeSlice(`${issue.title}\n\n${issue.body ?? ''}`, 1500),
        captured_at: capturedAt,
        metadata: { event_id: ev.id, classification: entry.classification },
      };
    }

    // -- PR merge (PullRequestEvent action=closed, merged=true) ------------
    if (
      ev.type === 'PullRequestEvent'
      && ev.payload?.action === 'closed'
      && ev.payload?.pull_request?.merged === true
      && entry.signals.includes('pr_merge_external')
    ) {
      const pr = ev.payload.pull_request;
      if (!pr.title || !pr.html_url) return null;
      return {
        ...base,
        account_domain: `github.com/${actor}`,
        signal_type: 'trigger_event',
        fact: `${actor} merged PR in ${ev.repo.name}`,
        source_url: pr.html_url,
        snippet: safeSlice(`${pr.title}\n\n${pr.body ?? ''}`, 1500),
        captured_at: capturedAt,
        metadata: { event_id: ev.id, classification: entry.classification },
      };
    }

    return null;
  }
}
