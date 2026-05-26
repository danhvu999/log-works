# log-works CLI Contract

This file pins the public CLI surface. Breaking changes require a version bump and an explicit docs update.

## Commands

```text
log-works config set <key> <value>
log-works config show
log-works fetch [--from <date>] [--to <date>] [--channel <id>] [--include-non-debrief]
log-works derive [--from <date>] [--to <date>]
log-works config setup slack --user-token <t> --user-id <u> [--channels <a,b,c>]
log-works config setup netdok-discover --api-key <k> [--workspace-id <w>] [--base-url <u>] [--auth-base-url <u>] [--project-ids <a,b,c>]
log-works config setup netdok-apply [--file <path>]
log-works config check
log-works parse list-unparsed [--from <date>] [--to <date>] [--no-partial]
log-works parse ingest [--file <path>]
log-works export --format <csv|json|xlsx> [--from <date>] [--to <date>] [--status <pending|sent|failed>] [--out <file>]
log-works summary [--from <date>] [--to <date>]
log-works netdok tasks    [--from <date>] [--to <date>] [--apply]
log-works netdok worklogs [--from <date>] [--to <date>] [--apply]
log-works storage clear-netdok [--from <date>] [--to <date>] [--apply]
log-works storage reset [--apply]
```

Every command accepts `--json`.

`netdok tasks` and `netdok worklogs` preview by default. Pass `--apply` to mutate Netdok and persist results to local storage.

`storage clear-netdok` and `storage reset` preview by default. Pass `--apply` to mutate local storage.

## MCP surface

Every command above is also exposed by the MCP server (`src/mcp.ts`) as a tool named `log_works_<command_with_underscores>` (e.g. `log_works_netdok_worklogs`). Tool inputs mirror CLI flags 1:1 with two adjustments:

- `--apply` becomes a boolean `apply` argument (default `false`).
- `log_works_export` requires `outPath` (no stdout pipe in MCP).

Tool outputs are the same JSON shapes documented below; errors use `{ isError: true, content: [{ type: "text", text: <errorResponse JSON> }] }` with the same `code`/`message` strings.

### `fetch` JSON

```json
{
  "fetched": 7,
  "inserted": 7,
  "skipped": 0,
  "droppedNonDebrief": 12,
  "channels": ["C08SZ28DSJE"],
  "from": "2026-05-18",
  "to": "2026-05-24",
  "storagePath": "~/.log-works/db.json"
}
```

- `fetched` — count of messages stored (after the debrief filter).
- `inserted` / `skipped` — `upsertRawMessages` outcome, deduped on Slack `ts`.
- `droppedNonDebrief` — messages Slack returned that did not contain the case-insensitive substring `debrief`. Filter runs by default; pass `--include-non-debrief` (CLI) / `includeNonDebrief: true` (MCP) to disable it and store everything.
- `netdokHint` — optional, see the section below.

### `summary` JSON

```json
{
  "messages": [
    {
      "ts": "1779378065.759309",
      "date": "2026-05-21",
      "channel": "C08SZ28DSJE",
      "text": "Debrief:\nMetabase\n• Worked on Duplicate PostgreSQL Sync Pipeline for ClickHouse [8h]"
    }
  ],
  "storagePath": "~/.log-works/db.json",
  "from": "2026-05-18",
  "to": "2026-05-24"
}
```

Read-only. Returns every raw debrief message in range. The agent (LLM) is expected to infer project names from `text` — the tool does not parse. Messages are sorted by `date` asc (ties broken by `ts`). Each message's `date` uses the same `effectiveDateForMessage` logic as `derive`. `isDebriefText` (case-insensitive `/debrief/i`) filters out anything that slipped past the fetch filter, so non-debrief / Brief-only / chatter never appears.

### `netdok tasks` JSON

```json
{
  "weeks": [
    {
      "project": "Venulog",
      "projectId": "acn…",
      "weekStart": "2026-05-18",
      "weekEnd": "2026-05-24",
      "expectedTaskName": "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
      "status": "existing-local|existing-remote|would-create|created",
      "taskId": "cmpkkh…",
      "taskKey": "TP-7",
      "taskUrl": "https://app.netdok.co/app/projects/active-sprint?id=acn%E2%80%A6&taskId=cmpkkh%E2%80%A6"
    }
  ],
  "unmapped": [{ "project": "Dealer tool", "entries": 1 }],
  "pinned": [
    {
      "project": "Loopengers",
      "projectId": "proj-l",
      "pinnedTaskId": "pinned-task-1",
      "entries": 3,
      "taskUrl": "https://app.netdok.co/app/projects/active-sprint?id=proj-l&taskId=pinned-task-1"
    }
  ],
  "applied": false,
  "storagePath": "~/.log-works/db.json"
}
```

`taskUrl` is built server-side from `netdok.appBaseUrl` (default `https://app.netdok.co`) and the row's `projectId` + `taskId`. Omitted on `would-create` rows (no taskId yet).

Projects with `netdok.projects.<name>.pinnedTaskId` set never appear in `weeks` and skip wrapper creation. They are surfaced in `pinned` so the caller can confirm the mode is active. The `status` enum on each `weeks` entry adds `"pinned"` for forward compatibility (currently only used in the `pinned` array's parallel reporting).

### `netdok worklogs` JSON

```json
{
  "entries": [
    {
      "entryId": "1779113451.476519#0",
      "date": "2026-05-19",
      "project": "Venulog",
      "text": "Checked …",
      "hours": 0.5,
      "taskId": "cmpkkh…",
      "projectId": "proj-v",
      "taskUrl": "https://app.netdok.co/app/projects/active-sprint?id=proj-v&taskId=cmpkkh%E2%80%A6",
      "status": "would-post|posted|skipped-already-sent|skipped-no-task|skipped-no-hours|skipped-no-project|skipped-duplicate-remote|failed",
      "worklogId": "f6vm…",
      "reason": "matching worklog already exists in Netdok"
    }
  ],
  "applied": false,
  "storagePath": "~/.log-works/db.json"
}
```

`projectId` is present whenever `netdok.projects[entry.project]` is mapped (so missing only on `skipped-no-project`). `taskUrl` is built server-side from `netdok.appBaseUrl` (default `https://app.netdok.co`), `projectId`, and `taskId`. Omitted when either is missing (e.g. `skipped-no-task`, `skipped-no-project`).

### Post-success `smartParseHint` (on `derive`)

When `derive` succeeds, the JSON result may include an optional `smartParseHint` field:

```json
{
  "smartParseHint": {
    "emptyCount": 1,
    "partialCount": 2,
    "totalNeedingReview": 3,
    "suggestion": "Call log_works_unparsed to list the failing messages, then propose structured entries and pass them to log_works_ingest_entries."
  }
}
```

- `emptyCount` — raw messages in the range where the rule parser produced zero entries (`status: "empty"`).
- `partialCount` — raw messages where the rule parser produced entries but at least one bullet is missing a project or hours (`status: "partial"`).
- `totalNeedingReview` — `emptyCount + partialCount`. Use this as the headline number when prompting the user.
- `suggestion` — points the agent at `log_works_unparsed` (step 1 of the smart-parse loop) followed by `log_works_ingest_entries` (step 2).
- The field is **omitted entirely** when every raw message in the range parsed cleanly (`status: "ok"`).

### Post-success `netdokHint` (on `fetch` and `derive`)

When `fetch` or `derive` succeeds, the JSON result may include an optional `netdokHint` field:

```json
{
  "netdokHint": {
    "configured": false,
    "unmappedProjects": ["Metabase", "Venulog"],
    "suggestion": "Call log_works_config_setup_netdok_discover (start with apiKey only)."
  }
}
```

- `configured` — `false` when any of `netdok.apiKey`, `netdok.workspaceId`, `netdok.profileId` are missing.
- `unmappedProjects` — projects observed in the just-processed range that are not present in `netdok.projects`. Sorted, deduplicated, `_unspecified` filtered out.
- `suggestion` — same wording as the matching `config check` branch.
- The field is **omitted entirely** when Netdok is fully configured AND every project in range is already mapped, so silent successes stay silent.

### `config setup slack` JSON

```json
{
  "applied": true,
  "config": { "slack": { "userToken": "[redacted]", "userId": "U123LOG", "channels": ["CWORKLOG"] } },
  "configPath": "/home/you/.log-works/config.json"
}
```

### `config setup netdok-discover` JSON

```json
{
  "workspaces": [{ "id": "ws-1", "name": "Danh", "apiUrl": "https://api.netdok.co" }],
  "me": {
    "profileId": "profile-1",
    "displayName": "danh.vu",
    "workspaceId": "ws-1",
    "tz": "Asia/Bangkok"
  },
  "projects": [{ "id": "proj-v", "name": "Venulog", "key": "TPV", "workspaceId": "ws-1" }],
  "projectDetails": [
    {
      "id": "proj-v",
      "name": "Venulog",
      "key": "TPV",
      "statuses": [{ "id": "status-inprog", "name": "In progress", "type": "INPROGRESS" }],
      "sprintIds": ["sprint-1", "sprint-2"],
      "suggestedStatusId": "status-inprog",
      "suggestedSprintId": "sprint-1"
    }
  ],
  "localProjectsSeen": ["Metabase", "Venulog"],
  "workspaceId": "ws-1"
}
```

When `workspaceId` is omitted, `me` is `null` and `projects` / `projectDetails` are empty. `localProjectsSeen` is always populated (or `[]` if no rawMessages locally).

### `config setup netdok-apply` JSON

Input (stdin or `--file <path>`):

```json
{
  "apiKey": "ndk_…",
  "workspaceId": "ws-1",
  "profileId": "profile-1",
  "reporterId": "profile-1",
  "baseUrl": "https://api.netdok.co",
  "authBaseUrl": "https://auth.netdok.co",
  "projects": {
    "Venulog":   { "projectId": "proj-v", "sprintId": "sprint-1", "statusId": "status-inprog" },
    "Loopengers":{ "projectId": "proj-l", "pinnedTaskId": "pinned-task-1" }
  }
}
```

Output mirrors `config setup slack`: `{ applied, config (redacted), configPath }`.

### `config check` JSON

```json
{
  "slack": {
    "ready": false,
    "missing": ["slack.userToken", "slack.userId", "slack.channels"],
    "suggestion": "Call log_works_config_setup_slack with userToken, userId, and channels."
  },
  "netdok": {
    "ready": false,
    "missing": [
      "netdok.apiKey",
      "netdok.workspaceId",
      "netdok.profileId",
      "netdok.projects (at least one mapping)"
    ],
    "knownLocalProjects": ["Dealer tools", "Loopengers", "Metabase", "Venulog", "…"],
    "mappedLocalProjects": [],
    "unmappedLocalProjects": ["Dealer tools", "Loopengers", "Metabase", "Venulog", "…"],
    "suggestion": "Call log_works_config_setup_netdok_discover (start with apiKey only)."
  },
  "nextStep": "setup-slack",
  "configPath": "/home/you/.log-works/config.json"
}
```

`nextStep` is the precomputed agent hint — one of `"setup-slack"`, `"fetch-and-derive"`,
`"setup-netdok-discover"`, `"setup-netdok-apply"`, `"ready"`. Agents act on it directly; the
MCP server's connect-time `instructions` describe the protocol (Slack first, never bundle
Slack + Netdok in one prompt).

`slack.ready` is `true` only when `slack.userToken`, `slack.userId`, and at least one entry in
`slack.channels` are all present. `netdok.ready` is `true` only when `netdok.apiKey`,
`netdok.workspaceId`, `netdok.profileId`, and at least one entry in `netdok.projects` are all
present. `knownLocalProjects` is the union of `src/constants/project-name-suggestions.ts` and
project names parsed from local rawMessages, sorted.

### `parse list-unparsed` JSON

```json
{
  "messages": [
    {
      "ts": "1779714923.439209",
      "channel": "C08SZ28DSJE",
      "date": "2026-05-25",
      "text": "Today I shipped a fix on Venulog: invoice line bug took maybe 2 hours.",
      "status": "empty|partial",
      "flags": {
        "missingProject": false,
        "missingHours": true,
        "hasDebriefMarker": false
      },
      "ruleEntries": 0
    }
  ],
  "storagePath": "~/.log-works/db.json",
  "from": "2026-05-25",
  "to": "2026-05-25"
}
```

`--no-partial` excludes messages with `status: "partial"`. Messages where the rule parser produced at least one entry and no flags fire (`status: "ok"`) are never returned. The MCP equivalent is `log_works_unparsed` with an optional boolean `includePartial` (default `true`).

### `parse ingest` JSON

Input on stdin or via `--file <path>` is a JSON array of entries:

```json
[
  {
    "sourceTs": "1779714923.439209",
    "index": 0,
    "date": "2026-05-25",
    "project": "Venulog",
    "text": "Fixed invoice line bug",
    "hours": 2
  }
]
```

`index` and `date` are optional; `index` auto-assigns within `sourceTs`, `date` defaults to the source message's effective date. `hours` may be a positive number or `null`. Inserted rows are stamped `source: "smart"` with id `${sourceTs}#smart-${index}`.

Output:

```json
{
  "entries": [
    {
      "id": "1779714923.439209#smart-0",
      "sourceTs": "1779714923.439209",
      "index": 0,
      "date": "2026-05-25",
      "project": "Venulog",
      "status": "inserted|skipped-duplicate"
    }
  ],
  "inserted": 1,
  "skipped": 0,
  "storagePath": "~/.log-works/db.json"
}
```

Re-ingesting the same `(sourceTs, index)` reports `skipped-duplicate` and never errors. Validation failures (missing required fields, unknown `sourceTs`, bad date format) raise `smart-parse-invalid` and write nothing.

### `storage clear-netdok` JSON

```json
{
  "clearedWeekTasks": 2,
  "resetEntries": 5,
  "applied": false,
  "storagePath": "~/.log-works/db.json",
  "from": "2026-05-19",
  "to": "2026-05-25"
}
```

Removes only local Netdok sync state. Raw Slack messages, derived text, hours, and fetch metadata remain in place.

### `storage reset` JSON

```json
{
  "removedRawMessages": 12,
  "removedWorkLogs": 20,
  "removedNetdokWeekTasks": 3,
  "clearedMeta": true,
  "applied": false,
  "storagePath": "~/.log-works/db.json"
}
```

Resets the local database to the empty shape.

## Output

- Data goes to stdout.
- Human diagnostics go to stderr.
- `--json` stdout must be valid JSON.
- Successful JSON responses use an object at the top level.
- `export` is the one documented exception to "data on stdout" when `--out <file>` is set: stdout is silent (or carries only the JSON summary when `--json` is also set), and the export bytes land in the file. A progress line goes to stderr.
- Failed JSON responses use:

```json
{
  "error": {
    "code": "config-missing",
    "message": "Config file not found"
  }
}
```

## Exit Codes

- `0`: success
- `1`: expected operational failure, such as missing config or HTTP failure
- `2`: invalid command usage or invalid flags

## Error Codes

The minimum stable error-code set is:

- `slack-auth`
- `slack-rate-limit`
- `netdok-http`
- `netdok-task-missing`
- `netdok-project-unmapped`
- `storage-corrupt`
- `config-missing`
- `export-format`
- `export-write`
- `smart-parse-invalid`
- `setup-invalid`

## Breaking Changes

These are breaking changes:

- Removing or renaming a command.
- Removing or renaming a flag.
- Changing JSON top-level shapes.
- Changing error-code strings.
- Moving data from stdout to stderr, or diagnostics from stderr to stdout.
- Adding an interactive prompt to a command.
