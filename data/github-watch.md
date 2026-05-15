# GitHub watch list

Operator-editable list of GitHub repositories the `github` connector polls for
signal events. Each section is one watch entry. The parser is strict: any
unparseable entry rejects the whole file, so a typo can't silently drop a repo
from the poll loop.

## How matching works

- `GitHubConnector.fromEnv()` reads this file at startup and converts each
  section into a `WatchEntry`. The connector polls each entry on every call to
  `fetchSince(since)`.
- Events flow `GitHub API → fetchSince → ConnectorPayload[] → ingestSignal →
  evidence`. The connector itself never writes to the DB; the orchestrator
  (Task 3.4) owns ingest. See `docs/connectors.md` for the full contract.
- Idempotency is the `evidence.dedupe_key` UNIQUE index, not this file. Editing
  this file mid-poll never duplicates rows — at worst a removed entry stops
  producing new events, and a new entry begins producing them on the next poll.

## Required fields per entry

Every entry MUST declare:

- `target` — a GitHub object spec. **v1 supports `repo:<owner>/<name>` only.**
  `org:<name>` and `user:<name>` are deferred to v1.5 (different API endpoint
  + pagination strategy). The parser throws on unsupported target kinds.
- `signals` — bracketed list of event kinds to emit signals for. **Allowed
  values:** `stars` (WatchEvent, i.e. someone starred the repo),
  `issue_create` (IssuesEvent action=opened), `pr_merge_external`
  (PullRequestEvent action=closed + merged=true). Unknown values reject the
  file.
- `classification` — how the connector should label the relationship between
  the actor and the repo. **Allowed values:** `prospect` (someone who might
  buy from us), `competitor` (someone whose engagement signals competitive
  intelligence), `neutral` (no commercial signal — usually for testing).
  Drives the `signal_type` chosen at ingest time
  (`prospect|neutral` → `engagement`; `competitor` → `trigger_event`).

If any field is missing or malformed, the parser throws an error naming the
field path so the operator can find the bad entry without grepping. **No partial
load** — a single bad entry means zero entries load.

## How entities are identified

For v1 the connector emits `account_domain = github.com/<actor-login>` (e.g.
`github.com/alice`). This is a stopgap — actor logins are not real domains and
won't fuzzy-match a CRM account by domain. In v1.5 the orchestrator gains a
GitHub-actor → company-domain resolver (commit history, profile email, employer
field), and this convention will tighten. Today it's enough that two events
from the same actor land on the same `accounts` row.

## Trust framing

The connector treats GitHub responses as **structurally trustworthy** (the
event shape comes from a known API surface) but **not semantically
authoritative** (the actor identity is self-reported and easily spoofed via
fork/PR-author games). The connector code is trusted because it's in our
deploy artifact; the GitHub actor's claimed identity is not. Routing rules
should therefore use repo + event type as the signal, not actor login as a
firmographic.

---

## modelcontextprotocol/servers

- target: repo:modelcontextprotocol/servers
- signals: [stars, issue_create]
- classification: prospect

## openai/openai-cookbook

- target: repo:openai/openai-cookbook
- signals: [pr_merge_external]
- classification: competitor
