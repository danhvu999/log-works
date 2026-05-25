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

Netdok worklogs must reference a parent **task**. To keep the local debrief bullet → Netdok worklog mapping clean, the tool creates one **wrapper task per (project, ISO-week)** and posts each bullet as a worklog under the matching wrapper.

Two commands, both preview by default and only mutate when `--apply` is passed:

- `log-works netdok tasks [--from] [--to] [--apply]` — group derived work-logs by `(project, isoWeekRange(date))`, reconcile against Netdok, and create any missing wrapper tasks named `[<project>] Task issues from {weekStart} to {weekEnd}` (Mon → Sun). The project name is part of both the task name and the local DB key so multiple local project names sharing the same Netdok `projectId` get distinct wrappers. A remote task is adopted as `existing-remote` only when `task.reporterId === netdok.reporterId`; same-named tasks created by other workspace members do not match.
- `log-works netdok worklogs [--from] [--to] [--apply]` — for each pending work-log entry, look up the wrapper task in local storage and `POST /worklogs`. Skip entries already `sent`, entries with no hours, entries whose project is unmapped, entries whose wrapper task does not yet exist, and entries whose `(day, text)` fingerprint already matches a worklog on the same Netdok task.
- Project-name → Netdok `projectId` mapping lives in config under `netdok.projects.<name>`.
- **Pinned-task mode.** If `netdok.projects.<name>.pinnedTaskId` is set, `netdok tasks` skips wrapper creation for that project (it is reported in the result's `pinned` array) and `netdok worklogs` posts every entry under the pinned `taskId` regardless of week. `sprintId` and `statusId` are not required in pinned mode. Existing `(day, text)` remote-dedup still applies.
- Track per-entry status: `pending | sent | failed`, with `lastError`, `postedAt`, `postedTaskId`, `postedWorklogId`.
- Idempotent: an entry already marked `sent` is never re-posted. Remote dedup catches worklogs created out-of-band.

Local storage maintenance commands, also preview by default and only mutate when `--apply` is passed:

- `log-works storage clear-netdok [--from] [--to] [--apply]` — remove only local Netdok sync state. Delete matching `netdokWeekTasks` rows and reset matching work-log sync fields back to `pending`, while preserving raw messages, derived text, hours, and fetch metadata.
- `log-works storage reset [--apply]` — rewrite the local database to the empty shape: no raw messages, no derived work-logs, no Netdok wrapper-task cache, and no fetch metadata.

### FR4 — CLI usable by AI agents

- Each pipeline step is a standalone subcommand. Commands compose into a full pipeline.
- Stable, parseable output: every command supports `--json` for machine-readable stdout.
- Non-zero exit code on error. Human messages go to stderr; data goes to stdout.
- No interactive prompts. All input via flags, config file, or environment variables.
- Command names and flag schema are treated as a public contract — breaking changes require a version bump.

### FR5 — MCP server

- Each command's logic lives in a callable service function, decoupled from the CLI handler.
- `src/mcp.ts` is the MCP entry point and exposes one tool per CLI command, named `log_works_<command_with_underscores>`. Stdio transport via `@modelcontextprotocol/sdk`.
- Tool inputs use Zod schemas mirroring CLI flags; tool outputs reuse the existing service result types (`FetchSummary`, `DeriveSummary`, `ExportSummary`, `NetdokTaskSyncResult`, `NetdokWorklogSyncResult`, `StorageClearNetdokSummary`, `StorageResetSummary`, redacted `LogWorksConfig`).
- Errors are surfaced as `{ isError: true, content: [{ type: "text", text: <errorResponse JSON> }] }` so MCP clients see the same typed `code`/`message` shape as the CLI's `--json` errors.
- `log_works_export` requires `outPath` — MCP cannot stream binary xlsx; the file is written to disk and the tool returns the summary.

### FR6 — Export local work-logs

- Read-only operation over locally stored work-logs. No Slack or Netdok calls.
- Format selected by required `--format` flag. Supported: `csv`, `json`, `xlsx`. Extensible without breaking the command shape.
- Optional `--from` / `--to` (`YYYY-MM-DD`, inclusive) and `--status` filters mirror the `list` command.
- Default output: export body on stdout.
- `--out <file>` writes the export to the given file path instead of stdout. Progress line goes to stderr.
- `--json` emits **summary metadata only** (`{ format, rows, path, ... }`). Never mixes raw export bytes into the JSON response — this is independent of `--format json`.
- CSV layout: header row + one row per work-log. Columns: `id, date, project, hours, text, status, lastError, postedAt, sourceTs`. Escaping follows RFC 4180. Null `hours` renders as an empty field.
- JSON layout: `{ "rows": N, "entries": [WorkLogEntry, ...] }` (flat array).
- XLSX layout: single worksheet `Work logs`, four columns `Date | Project | Task | Hours`. Header row frozen + bold. Group rows: a bold **date** row, then bold **project** sub-rows, then detail rows for each entry under that project. A final bold `TOTAL` row holds `SUM(D2:D<lastDetail>)` so re-edits stay live. `text` keeps embedded `\n` from sub-bullets via `wrapText` alignment.
- Binary `--format xlsx` body: with no `--out`, the `.xlsx` zip buffer is written to stdout (intended for shell redirection, e.g. `> worklog.xlsx`); piping to a terminal will print garbage.
- Typed errors:
  - `export-format` — missing or unsupported `--format`.
  - `export-write` — file write failure when `--out` is used.

### FR7 — Parse Slack debriefs into structured work-logs (`derive`)

- Standalone command `log-works derive` that reads `rawMessages` from local storage, parses each one, and upserts entries into `workLogs`. Pure local operation; no Slack or Netdok calls.
- **Rule-based deterministic parser**, no AI. Lives in `src/services/parser.service.ts` and operates on raw message text.
- Brief content is dropped entirely — both standalone `Brief:` messages and `Brief:` sections embedded inside a `Debrief:` message.
- Within a `Debrief:` section:
  - The first non-bullet, non-empty line establishes the current **project**. Header is normalised by:
    1. Strip a trailing `:`.
    2. Strip a trailing project-total `[Nh]` token (e.g. `Metabase [4.5h]` → `Metabase`). The token is dropped; project-total hours are not currently aggregated.
    3. If the remainder is fully wrapped in brackets (`[Venulog]`), unwrap.
    4. Trim. Empty result falls back to the `_unspecified` sentinel.
  - Each `•` bullet becomes one work-log entry.
  - `◦` sub-bullets are appended to the preceding bullet's text (joined with `\n`) and never own their own entry. CSV escaping (RFC 4180) handles the embedded newlines transparently; JSON exports keep them as `\n` in the string.
  - Slack link markup `<url|label>` is normalised to `label`, bare `<url>` to `url`.
  - The trailing `[Nh]` (or `[N.Nh]`) token on a bullet sets the `hours` field; if absent, `hours = null` and the entry is kept.
  - Bullets that appear before any project header use the sentinel project `_unspecified` so they aren't silently dropped.
- Backdated debriefs — `Debrief: <suffix>` line carries an optional date hint:
  - `Yesterday` → effective date = message date − 1 day (UTC).
  - `Today` → effective date = message date.
  - `<Month> <Day>` (e.g. `May 4`, `November 30`) → set month/day from suffix; year inherited from message ts, rolled back one year if the resulting date would be in the future relative to the message.
  - Unrecognised suffixes leave the effective date untouched.
- Idempotent on `${ts}#${bulletIndex}`. Re-running `derive` over the same DB inserts zero rows.
- Optional `--from` / `--to` (`YYYY-MM-DD`, inclusive) filters which raw messages are processed by their derived date.
- Date derivation: take the integer part of Slack `ts` as Unix seconds, format the UTC date as `YYYY-MM-DD`. Time-zone resolution is a separate open question (FR §7).
- `--json` emits `{ processed, inserted, skipped, storagePath, from?, to? }`.

### FR-SETUP — Guided config setup (external agent, Slack-first)

`log-works` exposes four commands (MCP + CLI) for filling out `~/.log-works/config.json` without
manual ID lookups. The tools never prompt; the agent (MCP client) is the user-facing layer. Setup
is **two-stage**: Slack alone is enough for `fetch` and `derive`; Netdok config is only needed
before `netdok tasks` / `netdok worklogs`. The MCP server publishes an `instructions` string that
tells connecting agents: always call `config check` first, and never bundle Slack + Netdok prompts
in a single exchange.

- `config check` / `log_works_config_check` (always call first in a session) returns
  `{ slack, netdok, nextStep, configPath }`. `slack` and `netdok` each report `{ ready, missing,
  suggestion, … }`. `nextStep` is one of `setup-slack`, `fetch-and-derive`, `setup-netdok-discover`,
  `setup-netdok-apply`, `ready`. Agents act on `nextStep`; if `setup-slack`, they only prompt for
  Slack credentials and stop. `knownLocalProjects` (inside `netdok`) unions
  [`src/constants/project-name-suggestions.ts`](../src/constants/project-name-suggestions.ts)
  with project names parsed from local rawMessages.
- `config setup slack` / `log_works_config_setup_slack` writes `slack.userToken`, `slack.userId`,
  and (optional) `slack.channels`. No Slack network call — validation deferred to the first `fetch`.
- `config setup netdok-discover` / `log_works_config_setup_netdok_discover` is a two-phase probe:
  Step 1 (no `workspaceId`) calls `auth.netdok.co/workspaces` and returns the list. Step 2 (with
  `workspaceId`) additionally calls `/profiles/me`, `/projects`, and `/projects/<id>` (subset via
  `projectIds`) using the `workspace-id` header. Result also includes `localProjectsSeen` (same
  union source as readiness) so the agent can suggest `localName → projectId` mappings. Discover
  **does not** write config.
- `config setup netdok-apply` / `log_works_config_setup_netdok_apply` accepts a finalized
  `NetdokApplyInput` (JSON via `--file` or stdin) and writes the full `netdok.*` block, including
  each `netdok.projects.<localName>.*`. `reporterId` defaults to `profileId` if absent. Bad payload →
  `setup-invalid`.

### FR-SP — Smart-parse loop (external agent)

The rule parser is intentionally permissive but cannot handle freeform debriefs or non-`•` bullets (see §6). The tool exposes a two-tool MCP/CLI loop so an external agent can supply structured entries for messages the rules miss, without putting AI inside the tool.

- `parse list-unparsed` (MCP: `log_works_unparsed`) returns raw messages in range where the rule parser produced 0 entries (`status: "empty"`) or flagged the output as partial (`status: "partial"` — bullets with no project or no hours). Each row includes the full text plus the booleans `missingProject`, `missingHours`, `hasDebriefMarker`, and `ruleEntries`. `--no-partial` / `includePartial: false` narrows to empty-only.
- `parse ingest` (MCP: `log_works_ingest_entries`) accepts an array of `{ sourceTs, index?, date?, project, text, hours? }`. Inserted rows live in `workLogs` with `source: "smart"` and id `${sourceTs}#smart-${index}`. The namespace prevents collisions with rule-derived `${ts}#${bulletIndex}` ids.
- Smart entries flow through `netdok tasks`/`netdok worklogs` exactly like rule entries. Re-ingest of the same `(sourceTs, index)` reports `skipped-duplicate`. Validation failures raise `smart-parse-invalid` and write nothing.
- The tool never invokes a model. The "agent" is whatever MCP client is connected.

## 3. CLI surface (initial)

```
log-works config set <key> <value>
log-works config show
log-works fetch  [--from <date>] [--to <date>] [--channel <id>]
log-works derive [--from <date>] [--to <date>]
log-works parse list-unparsed [--from <date>] [--to <date>] [--no-partial]
log-works parse ingest [--file <path>]
log-works export --format <csv|json|xlsx> [--from <date>] [--to <date>] [--status <s>] [--out <file>]
log-works netdok tasks    [--from <date>] [--to <date>] [--apply]
log-works netdok worklogs [--from <date>] [--to <date>] [--apply]
log-works storage clear-netdok [--from <date>] [--to <date>] [--apply]
log-works storage reset [--apply]
```

All commands accept `--json` and respect `LOG_WORKS_CONFIG` env override.

## 4. Configuration

- Config file: `~/.log-works/config.json`.
- Keys:
  - `slack.userToken` — `xoxp-…`
  - `slack.userId` — author filter
  - `slack.channels[]` — channel IDs / DM IDs to pull from
  - `netdok.baseUrl` — e.g. `https://api.netdok.co`
  - `netdok.apiKey` — sent as `x-api-key` header
  - `netdok.workspaceId` — sent as `workspace-id` header
  - `netdok.profileId` — identity for created worklogs
  - `netdok.reporterId` — identity for created tasks
  - `netdok.projects.<name>.{projectId,sprintId?,statusId?,pinnedTaskId?,assigneeIds?}` — map local project name → Netdok project. `projectId` is always required. `sprintId` and `statusId` are required only when the project uses weekly wrappers (default mode); the sync errors out with `config-missing` if either is absent and `pinnedTaskId` is not set. When `pinnedTaskId` is set, the project bypasses the weekly-wrapper flow and posts all worklogs under that fixed task.
  - `netdok.authHeader` — **deprecated**, kept for back-compat
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
- MCP HTTP / SSE transport — stdio only in v1.

## 7. Open Questions

- **Netdok contract** — resolved: tasks live under projects + sprints; worklogs reference a `taskId`. Captured from Postman session at `fixtures/netdok/Netdok.postman_collection.json`.
- **Message → work-log mapping** — resolved by FR7: each `•` bullet inside a `Debrief:` section becomes one entry; sub-bullets fold into their parent; `Brief:` content is dropped.
- **Edits & deletes** — if a Slack message is edited or deleted after first fetch, re-sync or freeze?
- **Time zone** — what TZ defines "a day" for grouping work-logs? User-local? Configurable?
