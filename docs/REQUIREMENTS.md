# log-works — Requirements

Tech-agnostic spec. Update independently of `TECHNOLOGIES.md`.

## 1. Overview

Personal CLI tool that syncs work-log messages from Slack into a local store, then pushes them to **Netdok** (internal time-tracking system) via HTTP. Single user, runs on dev machine. Designed to be driven by AI agents through stable CLI commands, with future MCP wrapper in mind.

## 2. Functional Requirements

### FR1 — Fetch Slack messages without a bot

- Authenticate as the user via a **user OAuth token** (`xoxp-…`). No bot installed in the workspace.
- Pull messages from one or more configured channels and/or DMs.
- Filter to messages authored by the configured user only.
- Support date range via `--from` / `--to`. Default range = since last successful fetch.
- Idempotent: re-running the same range must not duplicate stored messages. Key = Slack message `ts`.
- Persist the raw message payload locally **before** any transformation, so reprocessing never requires re-hitting Slack.
- Respect Slack rate limits (back off + resume).

### FR2 — Local storage

- Store: (a) raw Slack messages, (b) derived work-log entries, (c) per-entry sync status, (d) fetch metadata (cursor, last-run timestamps).
- Survive process crashes; resumable on next run.
- Single-machine, single-user. No concurrent writer support needed.
- Human-readable on disk (debuggable without special tools).

### FR3 — Post work-logs to Netdok

- Each work-log entry is sent via an HTTP request (curl-equivalent).
- Exact endpoint, payload shape, and auth scheme will be supplied by the user later from a captured curl example. Until then, the Netdok client is a **placeholder** with a clearly-marked TODO.
- Track per-entry status: `pending | sent | failed`, with `lastError` and `postedAt`.
- Retry failed entries only via explicit `--retry-failed` flag. No automatic retry loop.
- Idempotent: an entry already marked `sent` is never re-posted unless explicitly forced.
- Support `--dry-run` that prints the would-be request without sending.

### FR4 — CLI usable by AI agents

- Each pipeline step is a standalone subcommand. Commands compose into a full pipeline.
- Stable, parseable output: every command supports `--json` for machine-readable stdout.
- Non-zero exit code on error. Human messages go to stderr; data goes to stdout.
- No interactive prompts. All input via flags, config file, or environment variables.
- Command names and flag schema are treated as a public contract — breaking changes require a version bump.

### FR5 — MCP extension path (deferred)

- Each command's logic lives in a callable service function, decoupled from the CLI handler.
- A future MCP server imports the same service functions and exposes them as tools. No rewrite required.
- Implementation of the MCP server is **out of scope for v1**. Only the architectural constraint applies now.

## 3. CLI surface (initial)

```
log-works config set <key> <value>
log-works config show
log-works fetch  [--from <date>] [--to <date>] [--channel <id>]
log-works list   [--from <date>] [--to <date>] [--status <s>] [--json]
log-works post   [--from <date>] [--to <date>] [--retry-failed] [--dry-run]
log-works sync   [--from <date>] [--to <date>]     # fetch + post
```

All commands accept `--json` and respect `LOG_WORKS_CONFIG` env override.

## 4. Configuration

- Config file: `~/.log-works/config.json`.
- Keys:
  - `slack.userToken` — `xoxp-…`
  - `slack.userId` — author filter
  - `slack.channels[]` — channel IDs / DM IDs to pull from
  - `netdok.baseUrl`
  - `netdok.authHeader` — full header value (e.g. `Bearer …` or cookie)
  - `storage.path` — defaults to `~/.log-works/db.json`
- Any key may be overridden by `LOG_WORKS_<UPPER_KEY>` env var.
- Secrets live in the same config file in v1. Risk documented; future versions may move to OS keychain.

## 5. Non-functional Requirements

- **Idempotency** on all writes — Slack `ts` for raw messages, deterministic ID (`ts` + line index) for work-log entries.
- **Logging** — human-readable by default, `--json` switch for structured output.
- **Typed errors** — at minimum: `slack-auth`, `slack-rate-limit`, `netdok-http`, `storage-corrupt`, `config-missing`.
- **No telemetry.** Only outbound calls are to the configured Slack and Netdok endpoints.
- **Portable.** Runs on Linux + macOS without extra setup beyond the chosen runtime.

## 6. Out of Scope (v1)

- Multi-user, multi-workspace, or team deployment.
- Real-time Slack events / websocket / RTM.
- Web UI.
- Automated AI parsing of Slack messages inside the tool. (An agent may call the CLI and do its own parsing externally.)
- MCP server implementation (architecture only).

## 7. Open Questions

- **Netdok contract** — endpoint, payload shape, auth scheme. Blocked on user-provided curl example.
- **Message → work-log mapping** — is one Slack message one work-log, or split by line / regex / heading?
- **Edits & deletes** — if a Slack message is edited or deleted after first fetch, re-sync or freeze?
- **Time zone** — what TZ defines "a day" for grouping work-logs? User-local? Configurable?
