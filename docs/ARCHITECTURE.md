# log-works Architecture

`log-works` is a local single-user CLI. The implementation should stay split into thin CLI handlers and reusable services so a future MCP server can call the same logic.

## Boundaries

- `src/cli.ts` owns command registration and process-level concerns.
- `src/commands/` owns flag parsing adapters and output selection.
- `src/config/` owns config file loading, environment overrides, validation, and redaction.
- `src/services/storage.service.ts` owns local JSON database reads and writes.
- `src/services/slack.service.ts` owns Slack API fetching and rate-limit handling.
- `src/services/netdok.service.ts` owns Netdok request construction and posting.
- `src/services/sync.service.ts` owns fetch-to-post orchestration.
- `src/services/parser.service.ts` owns the rule-based debrief parser. Pure functions, no IO. Exposes `parseMessageText` (returns entries) and `evaluateMessage` (returns entries plus `status`/`flags` used by the smart-parse loop).
- `src/services/derive.service.ts` owns the raw → work-log derivation step (loads the DB, runs the parser, upserts entries idempotently with `source: "rule"`).
- `src/services/smart-parse.service.ts` owns the external-agent loop: `listUnparsedMessages` surfaces raw messages where the rule parser produced 0 entries or a partial result; `ingestSmartEntries` validates a structured array supplied by an MCP client and upserts rows with `source: "smart"`.
- `src/services/export.service.ts` owns reading the local database and rendering exports (CSV and JSON inline; XLSX via the sibling module). Dispatches on `--format`.
- `src/services/summary.service.ts` owns the read-only aggregate over local work-logs (totals, per-project hours and counts) used by `log-works summary` / `log_works_summary`.
- `src/services/netdok-hint.service.ts` owns the post-success Netdok readiness hint attached to `FetchSummary` / `DeriveSummary`. Suggestion strings are shared with `checkNetdokReadiness` (via `netdokSuggestion`) so `config check` and `netdokHint` stay in lock-step.
- `src/services/export-xlsx.ts` owns the XLSX (Google-Sheets-friendly) renderer. `exceljs` is loaded lazily via dynamic `import` so csv/json paths pay no cost.
- `src/output.ts` owns success and error response shapes.

## Data Flow

```text
CLI command -> command handler -> service function -> storage/client boundary
```

Raw Slack messages are stored before transformation. Work-log entries are derived from stored raw messages and then posted to Netdok. Per-entry status is updated only through the storage service.

Smart-parse sits beside `derive` rather than inside it: for messages the rule parser cannot fully handle, an external agent (an MCP client such as a Claude Code session) reads `log_works_unparsed`, produces structured entries, and pushes them back via `log_works_ingest_entries`. Smart entries are tagged `source: "smart"` and have id `${sourceTs}#smart-${index}` to avoid colliding with rule entries' `${ts}#${bulletIndex}`. The tool itself never invokes a language model — REQUIREMENTS §6 still applies.

Guided setup is another external-agent loop: `config setup slack` writes the Slack section
directly; `config setup netdok-discover` calls `auth.netdok.co/workspaces`, `/profiles/me`,
`/projects`, and `/projects/<id>` (workspace-scoped) and returns the raw structures plus a
`localProjectsSeen` list (union of `src/constants/project-name-suggestions.ts` and project names
parsed from local rawMessages); `config setup netdok-apply` accepts a finalized `NetdokApplyInput`
and writes the full netdok block atomically. The MCP client is the prompt layer — the tool never
asks. Setup is two-stage: Slack alone is enough for `fetch`+`derive`. Readiness is exposed via
a unified `config check` (returns `{ slack, netdok, nextStep, configPath }`) that the agent runs
first in every session. The MCP server publishes a connect-time `instructions` string telling
agents to honour `nextStep` and to never bundle Slack and Netdok prompts in the same exchange.
`netdok tasks`/`netdok worklogs` stay strict — they still raise `config-missing` if invoked
without the required keys.

Pinned-task mode is a per-project escape hatch from the weekly-wrapper flow: when `netdok.projects.<name>.pinnedTaskId` is set, that project's entries bypass `netdok tasks` grouping (reported separately under `result.pinned`) and `netdok worklogs` routes every entry to the pinned `taskId` instead of looking up `netdokWeekTasks`. `sprintId`/`statusId` are optional in pinned mode.

## MCP Readiness

Service functions must not depend on Commander, process globals, stdout, stderr, or interactive prompts. A future MCP entry point should be able to import services and pass explicit inputs.

## Testing Strategy

Tests should exercise command contracts and service behavior with fixtures. Slack and Netdok tests must use injected fakes or static fixture data, never live network calls.
