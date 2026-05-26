import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  loadConfig,
  redactConfig,
  resolveConfigPath,
  saveConfig,
  setConfigValue,
} from "./config/config.manager.ts";
import { errorResponse } from "./output.ts";
import { deriveWorkLogs } from "./services/derive.service.ts";
import { exportWorkLogs } from "./services/export.service.ts";
import { fetchWorkLogs } from "./services/fetch.service.ts";
import { fetchNetdokRemoteTasks } from "./services/netdok-fetch-tasks.service.ts";
import { syncNetdokTasks } from "./services/netdok-tasks.service.ts";
import { syncNetdokWorklogs } from "./services/netdok-worklogs.service.ts";
import {
  addKnownProjects,
  listProjects,
  setKnownProjects,
} from "./services/projects.service.ts";
import {
  checkConfigReadiness,
  setupNetdokApply,
  setupNetdokDiscover,
  setupSlackConfig,
} from "./services/setup.service.ts";
import {
  clearNetdokStorage,
  resetStorage,
} from "./services/storage-admin.service.ts";
import { summarizeStorage } from "./services/summary.service.ts";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

function ok(value: unknown): ToolResult {
  const text = JSON.stringify(value, null, 2);
  const structured =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

function failure(error: unknown): ToolResult {
  const body = errorResponse(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(body, null, 2),
      },
    ],
  };
}

async function run<T>(work: () => Promise<T>): Promise<ToolResult> {
  try {
    return ok(await work());
  } catch (error) {
    return failure(error);
  }
}

const SERVER_INSTRUCTIONS = `log-works syncs the user's Slack debrief messages into structured work-logs and (optionally) posts them to Netdok as worklogs under per-(project, ISO-week) wrapper tasks. Use this server when the request involves Slack debriefs, the local work-log DB at \`~/.log-works/db.json\`, Netdok worklog sync, or log-works config — e.g. "log my work today", "what did I do last week", "sync to Netdok", "set up log-works". For anything else, do NOT call these tools.

SETUP PROTOCOL. Always call \`log_works_config_check\` first in a fresh session and act on the \`nextStep\` field. Slack must be set up before Netdok; never bundle Slack and Netdok prompts in the same exchange.

\`nextStep\` actions:
- \`"setup-slack"\`: prompt only for Slack credentials (userToken, userId, channels) → \`log_works_config_setup_slack\`. Stop.
- \`"fetch-and-derive"\`: Slack ready; Netdok deferred. Run \`log_works_fetch\` (with \`from: "lastmonth"\` on first-run) then \`log_works_derive\` over the same range to materialize structured work-logs.
- \`"setup-netdok-discover"\`: a status hint — Netdok is unconfigured but the local DB has data. Trigger this flow ONLY when the user explicitly asks to sync to Netdok. When asked: request the Netdok API key → \`log_works_config_setup_netdok_discover\` (apiKey only) → present workspaces → re-call with \`workspaceId\`. Before \`apply\`, ask if any project should run in pinned-task mode (one fixed task, e.g. retainer / on-call). If yes, resolve the \`pinnedTaskId\` for that project one of two ways: (a) the user already knows the taskId and provides it directly, or (b) call \`log_works_netdok_fetch_tasks\` with the project's \`projectId\` (and optional \`sprintId\`) to list candidate tasks, present them by \`key\` + \`name\`, and let the user pick — then pass the chosen \`id\` as \`pinnedTaskId\` in the apply payload. Do NOT invent a taskId or guess from the name. (Re-calling discover with \`includeTasks: true\` is also valid for batch lookup, but \`log_works_netdok_fetch_tasks\` is preferred for per-project pinning.)
- \`"setup-netdok-apply"\`: a status hint — Netdok base keys are set but no project mappings yet. Trigger this ONLY when the user is following through on a sync request. Assemble \`projects\` mappings from the readiness result's \`knownLocalProjects\` and call \`log_works_config_setup_netdok_apply\`. Each project picks one mode: weekly-wrapper (\`sprintId\` + \`statusId\`) OR pinned-task (\`pinnedTaskId\`). Modes can be mixed.
- \`"ready"\`: everything configured. Call \`log_works_netdok_tasks\` / \`log_works_netdok_worklogs\` per the user's request.

NEW-USER HAPPY PATH (PHASE A — local logging). After \`log_works_config_setup_slack\`, run in order:
1. \`log_works_fetch\` with \`from: "lastmonth"\` (bounds the first-run fetch)
2. \`log_works_derive\` over the same range — the rule parser materializes \`workLogs\` from \`rawMessages\` (source='rule'). Inspect any unmapped project names surfaced via \`netdokHint\`: confirm new names with the user and persist via \`log_works_projects_add\` (UPSERT). Do NOT ask the user to enumerate projects upfront.
3. Offer to export the derived work-logs for review: call \`log_works_export\` (format \`csv\` or \`xlsx\`, \`outPath\` required) so the user can sanity-check rows before any Netdok sync. Phrase it as "Want me to export these to CSV/XLSX so you can check them?" — wait for a yes before calling export.
4. Stop. Tell the user "Logged. Want me to sync to Netdok?" and wait for an explicit answer. Do NOT run Phase B unless the user asks to sync.

NEW-USER HAPPY PATH (PHASE B — Netdok sync, only on explicit user request).
4. (optional) \`log_works_projects_list\` to review the vocabulary built up during Phase A; persist any cleanup with \`log_works_projects_set\`.
5. \`log_works_config_setup_netdok_discover\` → \`log_works_config_setup_netdok_apply\`.
6. Preview \`log_works_netdok_tasks\` → user confirms → apply.
7. Preview \`log_works_netdok_worklogs\` → user confirms → apply.

PREVIEW → APPROVE → APPLY. \`log_works_netdok_tasks\` and \`log_works_netdok_worklogs\` are the only mutating Netdok tools. (1) Call first with \`apply\` omitted — this is a preview, no writes. (2) Present the preview entries grouped by project + week (date / hours / first line of text). (3) Wait for explicit user confirmation ("yes", "apply", "sync it") — do not infer consent from earlier phrasing. (4) Only then re-call with \`apply: true\`. Never chain preview and apply in the same turn; never call \`apply: true\` first.

POST-SYNC SUMMARY. After an \`apply: true\` response, write a short summary grouped by project: wrapper or pinned task name, total hours posted, and the \`taskUrl\` from the response rendered as a clickable link. Use the \`taskUrl\` field the server returns — never reconstruct URLs by hand.

DEBRIEF FILTER. \`log_works_fetch\` only stores messages whose text contains the case-insensitive substring \`debrief\`; non-matches are counted in \`droppedNonDebrief\` and discarded. Pass \`includeNonDebrief: true\` only when the user explicitly asks to fetch everything. Also inspect the optional \`netdokHint\` on the result: when present, it lists projects missing from \`netdok.projects\` (or flags Netdok as unconfigured) — prompt the user to run Netdok setup, still without bundling Slack prompts.

PROJECT VOCABULARY. The vocabulary at \`config.projects.known\` should mirror the project names the rule parser emits during \`log_works_derive\`. When a derive run surfaces a project not yet in \`known\`, confirm the name with the user and call \`log_works_projects_add\` (UPSERT — keeps existing entries). Do NOT call \`log_works_projects_set\` for incremental additions; it REPLACES the whole list and would clobber other entries. Use \`log_works_projects_list\` to review the current vocabulary (e.g. before Netdok mapping, or when the user asks "what projects do I have"). Use \`log_works_projects_set\` only for explicit cleanup or full replacement.

DERIVE STEP. ALWAYS call \`log_works_derive\` after \`log_works_fetch\` succeeds — it is the canonical parsing step. The rule parser handles the supported debrief formats (\`Debrief:\` section, \`Project\` / \`Project:\` / \`[Project]\` headers, \`•\`/\`◦\` bullets, inline \`[Nh]\` or \`[N]\` hours markers). \`log_works_derive\` is idempotent on \`\${ts}#\${index}\`, so re-running after a re-fetch only inserts the delta.

EXPORT FOR REVIEW. After \`log_works_derive\` (and before any Netdok sync), proactively offer \`log_works_export\` so the user can eyeball the derived rows in a spreadsheet. Recommend \`format: "xlsx"\` for human review; use \`csv\` if the user prefers plain text. Always ask first — never export unprompted. Pass an explicit \`outPath\` (e.g. \`./worklogs-<from>-<to>.xlsx\`) and surface that path back to the user.

ENTRY TEXT FORMAT. The \`text\` field on a derived work-log is the body that ends up on Netdok. The rule parser folds Slack sub-bullets (\`◦\`) into the parent bullet's text as newline-joined lines — \`log_works_netdok_worklogs\` renders each newline as a separate paragraph in the posted worklog. Example: \`"Fixed invoice line bug\\nReviewed PR #214\\nMet with QA"\` — not \`"Fixed invoice line bug; Reviewed PR #214; Met with QA"\`. One bullet = one entry; do NOT collapse multiple debrief bullets (different project/hours) into a single multi-line text — those must be split into separate entries.

LOCAL DB INSPECTION. For aggregate questions ("what did I log last week?", "how many hours on Venulog this month?"), call \`log_works_summary\` — it returns per-project totals + grand totals over \`workLogs\`. Do NOT shell out to read \`~/.log-works/db.json\` (no python / jq / cat). log_works_summary is NOT part of setup — the project vocabulary comes from \`log_works_projects_list\` / \`_set\` / \`_add\`, not from inspecting debrief texts.`;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "log-works", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "log_works_config_show",
    {
      title: "Show config",
      description:
        "Read ~/.log-works/config.json with secrets redacted (slack.userToken, netdok.apiKey, netdok.authHeader).",
      inputSchema: z.object({}).shape,
    },
    async () => run(async () => redactConfig(await loadConfig())),
  );

  server.registerTool(
    "log_works_config_set",
    {
      title: "Set config value",
      description:
        "Set a dotted config key. Numeric and boolean strings are coerced automatically.",
      inputSchema: z.object({
        key: z.string().describe("Dotted key, e.g. netdok.apiKey"),
        value: z
          .string()
          .describe("String value; coerced when numeric or boolean"),
      }).shape,
    },
    async ({ key, value }) =>
      run(async () => {
        const configPath = resolveConfigPath();
        const config = await loadConfig();
        setConfigValue(config, key, value);
        await saveConfig(configPath, config);
        return { key, updated: true };
      }),
  );

  server.registerTool(
    "log_works_fetch",
    {
      title: "Fetch Slack debriefs",
      description:
        "Pull Slack messages from configured channels into local storage; idempotent on Slack `ts`. Only messages containing the case-insensitive substring `debrief` are stored by default; pass `includeNonDebrief: true` to keep everything. May return an optional `netdokHint` flagging unmapped projects in the fetched range.",
      inputSchema: z.object({
        from: z
          .string()
          .optional()
          .describe(
            "Start date YYYY-MM-DD, ISO datetime, 'now', 'lastweek', or 'lastmonth'",
          ),
        to: z
          .string()
          .optional()
          .describe("End date YYYY-MM-DD, ISO datetime, or 'now'"),
        channel: z
          .string()
          .optional()
          .describe(
            "Override configured Slack channels with a single channel id",
          ),
        includeNonDebrief: z
          .boolean()
          .optional()
          .describe(
            "Skip the default `debrief` substring filter. Use only when the user explicitly asks to fetch everything (e.g. debugging coverage).",
          ),
      }).shape,
    },
    async (input) => run(() => fetchWorkLogs(input)),
  );

  server.registerTool(
    "log_works_export",
    {
      title: "Export work-logs",
      description:
        "Export local work-logs to a file (CSV / JSON / XLSX). `outPath` is required — MCP cannot stream binary bytes.",
      inputSchema: z.object({
        format: z.enum(["csv", "json", "xlsx"]).describe("Output format"),
        outPath: z
          .string()
          .describe("Absolute or relative path to write the export to"),
        from: z.string().optional().describe("Start date YYYY-MM-DD inclusive"),
        to: z.string().optional().describe("End date YYYY-MM-DD inclusive"),
        status: z
          .enum(["pending", "sent", "failed"])
          .optional()
          .describe("Filter by sync status"),
      }).shape,
    },
    async ({ outPath, ...rest }) =>
      run(async () => {
        const result = await exportWorkLogs({ ...rest, out: outPath });
        return result.summary;
      }),
  );

  server.registerTool(
    "log_works_summary",
    {
      title: "Aggregate work-logs by project",
      description:
        "Per-project totals + grand totals over local `workLogs` for an optional from/to range. Use for 'what did I log last week?' / 'hours on X this month?' — do NOT shell out to read `~/.log-works/db.json`.",
      inputSchema: z.object({
        from: z.string().optional().describe("Start date YYYY-MM-DD inclusive"),
        to: z.string().optional().describe("End date YYYY-MM-DD inclusive"),
      }).shape,
    },
    async (input) => run(() => summarizeStorage(input)),
  );

  server.registerTool(
    "log_works_projects_list",
    {
      title: "List project vocabulary",
      description:
        "Returns `{ suggestions, known, merged, configPath }`. Use to review the current vocabulary (e.g. before Netdok mapping, or when the user asks). The vocabulary normally builds up via `log_works_projects_add` during smart-parse — calling this beforehand is optional, not a required step.",
      inputSchema: z.object({}).shape,
    },
    async () => run(() => listProjects()),
  );

  server.registerTool(
    "log_works_projects_set",
    {
      title: "Replace project vocabulary (REPLACE)",
      description:
        "Replace `config.projects.known` with the supplied list (trim, dedup, sort). Use only for cleanup or full replacement — the vocabulary normally builds up incrementally via `log_works_projects_add` during smart-parse. Pass an empty list to clear.",
      inputSchema: z.object({
        names: z
          .array(z.string().min(1))
          .max(200)
          .describe("Full final list of project names; replaces existing."),
      }).shape,
    },
    async (input) => run(() => setKnownProjects(input)),
  );

  server.registerTool(
    "log_works_projects_add",
    {
      title: "Add to project vocabulary (UPSERT)",
      description:
        "Merge `names` into `config.projects.known`; existing entries are kept. Returns `added` (names that were not previously in `known`). Use during smart-parse when a debrief mentions a new project — after the user confirms.",
      inputSchema: z.object({
        names: z
          .array(z.string().min(1))
          .max(200)
          .describe("Project names to add; already-known names are no-ops."),
      }).shape,
    },
    async (input) => run(() => addKnownProjects(input)),
  );

  server.registerTool(
    "log_works_netdok_tasks",
    {
      title: "Sync Netdok wrapper tasks",
      description:
        "Ensure a wrapper task '[<Project>] Task issues from <Mon> to <Sun>' exists in Netdok for each (project, ISO-week) in range. Preview by default; pass `apply: true` to create. Result entries carry `taskUrl` when a taskId is known.",
      inputSchema: z.object({
        from: z.string().optional().describe("Start date YYYY-MM-DD inclusive"),
        to: z.string().optional().describe("End date YYYY-MM-DD inclusive"),
        apply: z
          .boolean()
          .optional()
          .describe(
            "Set true to create missing tasks in Netdok; default previews only",
          ),
      }).shape,
    },
    async (input) => run(() => syncNetdokTasks(input)),
  );

  server.registerTool(
    "log_works_netdok_fetch_tasks",
    {
      title: "Fetch remote Netdok tasks",
      description:
        "Read-only list of remote Netdok tasks for a project (optionally scoped by sprintId). Calls GET /tasks; no local DB writes. Use to inspect available taskIds (e.g. when picking a pinned task) or to verify a wrapper task exists.",
      inputSchema: z.object({
        projectId: z
          .string()
          .min(1)
          .describe("Netdok project id to list tasks for"),
        sprintId: z
          .string()
          .min(1)
          .optional()
          .describe("Optional sprint id to scope the listing"),
      }).shape,
    },
    async (input) => run(() => fetchNetdokRemoteTasks(input)),
  );

  server.registerTool(
    "log_works_netdok_worklogs",
    {
      title: "Post Netdok worklogs",
      description:
        "Post pending work-logs under each project's wrapper or pinned task. Dedup: local `sent` status + remote (day, text) fingerprint. Preview by default; pass `apply: true` to post. Result entries carry `projectId` and `taskUrl` when known.",
      inputSchema: z.object({
        from: z.string().optional().describe("Start date YYYY-MM-DD inclusive"),
        to: z.string().optional().describe("End date YYYY-MM-DD inclusive"),
        apply: z
          .boolean()
          .optional()
          .describe(
            "Set true to post worklogs to Netdok; default previews only",
          ),
      }).shape,
    },
    async (input) => run(() => syncNetdokWorklogs(input)),
  );

  server.registerTool(
    "log_works_derive",
    {
      title: "Derive work-logs from raw Slack messages",
      description:
        "Run the rule parser over `rawMessages` in range and insert structured entries into `workLogs` (source='rule'). Idempotent on `${ts}#${index}`. Returns `{ processed, inserted, skipped }` plus optional `netdokHint`.",
      inputSchema: z.object({
        from: z.string().optional().describe("Start date YYYY-MM-DD inclusive"),
        to: z.string().optional().describe("End date YYYY-MM-DD inclusive"),
      }).shape,
    },
    async (input) => run(() => deriveWorkLogs(input)),
  );

  server.registerTool(
    "log_works_config_setup_slack",
    {
      title: "Set up Slack credentials",
      description:
        "Write `slack.userToken`, `slack.userId`, and `slack.channels` to config. No Slack network call.",
      inputSchema: z.object({
        userToken: z
          .string()
          .min(1)
          .describe("Slack user OAuth token (xoxp-…)"),
        userId: z.string().min(1).describe("Slack user id to scope fetches to"),
        channels: z
          .array(z.string().min(1))
          .optional()
          .describe("Channel ids, DM ids, or the sentinel 'self'"),
      }).shape,
    },
    async (input) => run(() => setupSlackConfig(input)),
  );

  server.registerTool(
    "log_works_config_setup_netdok_discover",
    {
      title: "Discover Netdok workspace + projects",
      description:
        "Two-phase Netdok probe: omit `workspaceId` to list workspaces; pass `workspaceId` to also fetch profile + projects + project details. Pass `includeTasks: true` to also list project tasks (use to pick a `pinnedTaskId`). Does not write config.",
      inputSchema: z.object({
        apiKey: z.string().min(1).describe("Netdok API key (ndk_…)"),
        workspaceId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Workspace to scope /me and /projects to. Omit to list workspaces only.",
          ),
        baseUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "Override netdok api base url (default https://api.netdok.co)",
          ),
        authBaseUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "Override netdok auth base url (default https://auth.netdok.co)",
          ),
        projectIds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Restrict /projects/<id> calls (and /tasks when includeTasks=true) to this subset; default covers every project",
          ),
        includeTasks: z
          .boolean()
          .optional()
          .describe(
            "Also list project tasks (requires `workspaceId`). Use to pick a `pinnedTaskId` for `log_works_config_setup_netdok_apply`. Default false.",
          ),
      }).shape,
    },
    async (input) => run(() => setupNetdokDiscover(input)),
  );

  server.registerTool(
    "log_works_config_setup_netdok_apply",
    {
      title: "Apply Netdok config",
      description:
        "Write `netdok.*` keys and per-project mappings. Idempotent: re-applying replaces matching keys. Each project picks one mode:\n- weekly-wrapper: `sprintId` + `statusId` set. `log_works_netdok_tasks` ensures one wrapper task per ISO week; `log_works_netdok_worklogs` posts under it.\n- pinned-task: `pinnedTaskId` set. All worklogs go under that fixed task regardless of week (good for retainer / support / on-call).\n\nModes can be mixed across projects. To find taskIds for pinned mode, call `log_works_config_setup_netdok_discover` with `includeTasks: true`.",
      inputSchema: z.object({
        apiKey: z.string().min(1).describe("Netdok API key (ndk_…)"),
        workspaceId: z
          .string()
          .min(1)
          .describe("Netdok workspace id selected during discover"),
        profileId: z
          .string()
          .min(1)
          .describe(
            "Netdok profile id for the current user (from /profiles/me)",
          ),
        reporterId: z
          .string()
          .min(1)
          .optional()
          .describe("Defaults to profileId if absent"),
        baseUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "Override netdok api base url (default https://api.netdok.co)",
          ),
        authBaseUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "Override netdok auth base url (default https://auth.netdok.co)",
          ),
        projects: z
          .record(
            z
              .string()
              .min(1)
              .describe(
                "Local project name (matches the project field on derived work-log entries)",
              ),
            z.object({
              projectId: z
                .string()
                .min(1)
                .describe("Netdok project id this local project maps to"),
              sprintId: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Netdok sprint id where new weekly wrapper tasks are created. Required in weekly-wrapper mode; ignored when `pinnedTaskId` is set.",
                ),
              statusId: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Netdok status id assigned to new weekly wrapper tasks. Required in weekly-wrapper mode; ignored when `pinnedTaskId` is set.",
                ),
              pinnedTaskId: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Fixed Netdok taskId that collects every worklog for this project (pinned-task mode). Bypasses the weekly-wrapper flow; `sprintId`/`statusId` not required. Discover taskIds via `log_works_config_setup_netdok_discover` with `includeTasks: true`.",
                ),
              assigneeIds: z
                .array(z.string().min(1))
                .optional()
                .describe(
                  "Optional. Netdok profile ids assigned to new weekly wrapper tasks. Ignored in pinned mode.",
                ),
            }),
          )
          .describe(
            "Map from local project name → Netdok mapping. Each project independently picks weekly-wrapper mode (sprintId+statusId) or pinned-task mode (pinnedTaskId).",
          ),
      }).shape,
    },
    async (input) => run(() => setupNetdokApply(input)),
  );

  server.registerTool(
    "log_works_config_check",
    {
      title: "Check setup readiness",
      description:
        "First call in every fresh session. Returns `{ slack, netdok, nextStep, configPath }`. Drive subsequent calls off `nextStep`.",
      inputSchema: z.object({}).shape,
    },
    async () => run(() => checkConfigReadiness()),
  );

  server.registerTool(
    "log_works_storage_clear_netdok",
    {
      title: "Clear local Netdok sync state",
      description:
        "Drop netdokWeekTasks rows in range and reset matching work-logs to status=pending (postedTaskId / postedWorklogId / postedAt cleared). Preview by default.",
      inputSchema: z.object({
        from: z.string().optional().describe("Start date YYYY-MM-DD inclusive"),
        to: z.string().optional().describe("End date YYYY-MM-DD inclusive"),
        apply: z
          .boolean()
          .optional()
          .describe("Set true to persist the cleanup; default previews only"),
      }).shape,
    },
    async (input) => run(() => clearNetdokStorage(input)),
  );

  server.registerTool(
    "log_works_storage_reset",
    {
      title: "Reset local storage",
      description:
        "Wipe the entire local DB (rawMessages, workLogs, netdokWeekTasks, meta) to an empty state. Config file is untouched. Preview by default.",
      inputSchema: z.object({
        apply: z
          .boolean()
          .optional()
          .describe("Set true to persist the reset; default previews only"),
      }).shape,
    },
    async (input) => run(() => resetStorage(input)),
  );

  return server;
}
