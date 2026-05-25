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
import { syncNetdokTasks } from "./services/netdok-tasks.service.ts";
import { syncNetdokWorklogs } from "./services/netdok-worklogs.service.ts";
import {
  checkConfigReadiness,
  setupNetdokApply,
  setupNetdokDiscover,
  setupSlackConfig,
} from "./services/setup.service.ts";
import {
  ingestSmartEntries,
  listUnparsedMessages,
} from "./services/smart-parse.service.ts";
import {
  clearNetdokStorage,
  resetStorage,
} from "./services/storage-admin.service.ts";

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

const SERVER_INSTRUCTIONS = `log-works syncs the user's Slack debrief messages into structured work-logs and (optionally) posts them to Netdok as worklogs under per-(project, ISO-week) wrapper tasks. Use this server whenever the user's request implies any of:

- Logging or "logging works" for a day or week ("log my work today", "log this week", "log yesterday's debrief").
- Reading, summarising, exporting, or reviewing their Slack work-log / debrief messages ("what did I do last week", "export my worklogs to CSV/xlsx", "summarise my debriefs").
- Pushing or syncing time entries / worklogs to Netdok ("sync to Netdok", "post worklogs", "create the weekly task on Netdok").
- Setting up or reconfiguring log-works itself (Slack token, Netdok api key, project mappings).
- Any mention of log-works, the local DB at ~/.log-works/db.json, debrief parsing, smart-parse, pinned Netdok tasks, or weekly wrapper tasks.

If the user's request is unrelated to Slack debriefs / Netdok worklogs / log-works config, do NOT call this server's tools.

When you do use the server, follow the two-stage setup protocol. Before invoking any other tool in a fresh session, call log_works_config_check. Respect the \`nextStep\` field in its result:

- "setup-slack": prompt the user only for Slack credentials (userToken, userId, channels) and call log_works_config_setup_slack. Do NOT also prompt for Netdok in the same exchange.
- "fetch-and-derive": Slack is ready and Netdok is either deferred or not requested. Proceed to log_works_fetch and log_works_derive when the user asks.
- "setup-netdok-discover": Slack is ready and the user wants to sync. Ask for the Netdok API key, call log_works_config_setup_netdok_discover (apiKey only), present workspaces, then re-call discover with workspaceId. Before moving on to apply, ask the user whether any of their projects should run in pinned-task mode (all hours under one fixed task, e.g. retainer / support); if yes, re-call discover with includeTasks=true so they can pick a taskId from \`projectTasks\`.
- "setup-netdok-apply": Netdok base keys are set; assemble project mappings (use the readiness result's knownLocalProjects) and call log_works_config_setup_netdok_apply. For each project decide: weekly-wrapper mode (set sprintId + statusId) OR pinned-task mode (set pinnedTaskId, omit sprintId/statusId). Modes can be mixed across projects in one call.
- "ready": call log_works_netdok_tasks / log_works_netdok_worklogs as the user requests.

Never bundle Slack and Netdok setup in one user-facing prompt. Slack always comes first.`;

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
        "Set a dotted config key. Values like '28800' / 'true' are coerced to number / boolean automatically.",
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
        "Pull Slack messages from configured channels into local storage. Idempotent on Slack `ts`.",
      inputSchema: z.object({
        from: z
          .string()
          .optional()
          .describe(
            "Start date YYYY-MM-DD, ISO datetime, 'now', or 'lastweek'",
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
      }).shape,
    },
    async (input) => run(() => fetchWorkLogs(input)),
  );

  server.registerTool(
    "log_works_derive",
    {
      title: "Derive work-logs",
      description:
        "Parse local raw Slack messages into structured WorkLogEntry rows. Idempotent on ${ts}#${bulletIndex}.",
      inputSchema: z.object({
        from: z.string().optional().describe("Start date YYYY-MM-DD inclusive"),
        to: z.string().optional().describe("End date YYYY-MM-DD inclusive"),
      }).shape,
    },
    async (input) => run(() => deriveWorkLogs(input)),
  );

  server.registerTool(
    "log_works_export",
    {
      title: "Export work-logs",
      description:
        "Export local work-logs to a file. CSV/JSON/XLSX. The MCP transport cannot stream binary bytes, so `outPath` is required.",
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
    "log_works_netdok_tasks",
    {
      title: "Sync Netdok wrapper tasks",
      description:
        "For each (project, ISO-week) in range, ensure a wrapper task '[<Project>] Task issues from <Mon> to <Sun>' exists in Netdok. Previews by default; pass apply=true to create.",
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
    "log_works_netdok_worklogs",
    {
      title: "Post Netdok worklogs",
      description:
        "Post pending work-logs to Netdok under their weekly wrapper task. Dedup: local `sent` status + remote (day, text) fingerprint. Previews by default; pass apply=true to post.",
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
    "log_works_unparsed",
    {
      title: "List unparsed Slack messages",
      description:
        "List raw Slack messages the rule parser produced 0 entries from, or flagged as partial (missing project/hours). Smart-parse loop step 1.",
      inputSchema: z.object({
        from: z.string().optional().describe("Start date YYYY-MM-DD inclusive"),
        to: z.string().optional().describe("End date YYYY-MM-DD inclusive"),
        includePartial: z
          .boolean()
          .optional()
          .describe(
            "Include partially-parsed messages (default true). Set false to list only zero-entry messages.",
          ),
      }).shape,
    },
    async (input) => run(() => listUnparsedMessages(input)),
  );

  server.registerTool(
    "log_works_ingest_entries",
    {
      title: "Ingest smart-parsed entries",
      description:
        "Insert externally-parsed work-log entries (source='smart') into local storage. Idempotent on ${sourceTs}#smart-${index}. Smart-parse loop step 2.",
      inputSchema: z.object({
        entries: z
          .array(
            z.object({
              sourceTs: z
                .string()
                .describe("Slack message ts the entry was derived from"),
              index: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .describe(
                  "Stable index within sourceTs; auto-assigned if omitted",
                ),
              date: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .describe("YYYY-MM-DD; defaults to message's effective date"),
              project: z
                .string()
                .min(1)
                .describe("Project name matching netdok.projects key"),
              text: z.string().min(1).describe("Work-log body"),
              hours: z
                .number()
                .positive()
                .nullable()
                .optional()
                .describe("Hours spent (positive), or null"),
            }),
          )
          .min(1),
      }).shape,
    },
    async (input) => run(() => ingestSmartEntries(input)),
  );

  server.registerTool(
    "log_works_config_setup_slack",
    {
      title: "Setup Slack credentials",
      description:
        "Write slack.userToken, slack.userId, and slack.channels into config. Does not call Slack.",
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
      title: "Discover Netdok workspaces, projects, and statuses",
      description:
        "Call Netdok with the supplied apiKey to list workspaces (always) and — when workspaceId is provided — /profiles/me, /projects, and /projects/<id>. Does not write config. Two-phase: call without workspaceId first to list workspaces, then re-call with the chosen workspaceId for the rest. Pass includeTasks=true to also list existing Netdok tasks per project so the user can pick a pinnedTaskId for any project that should use pinned-task mode (see log_works_config_setup_netdok_apply).",
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
            "When true (workspaceId required), also fetch existing tasks per project and return them as `projectTasks: [{ projectId, tasks: [{id,key,name,sprintId,statusId}] }]`. Use this to let the user pick a pinnedTaskId before calling log_works_config_setup_netdok_apply. Default false (skipped to save Netdok API calls).",
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
        "Write netdok.apiKey, workspaceId, profileId, reporterId, baseUrl, authBaseUrl, and netdok.projects.<name>.* for each mapping. Idempotent: re-applying replaces matching keys without touching unrelated config.\n\nEach project mapping runs in one of two modes:\n- Default 'weekly-wrapper' mode: requires sprintId + statusId. `log_works_netdok_tasks` ensures a per-(project, ISO-week) wrapper task '[<Project>] Task issues from <Mon> to <Sun>' exists, and `log_works_netdok_worklogs` posts each entry under the wrapper for the entry's week.\n- 'Pinned-task' mode: set `pinnedTaskId` to a fixed Netdok taskId; sprintId and statusId are not required. All worklogs for this project are posted under that single task regardless of which week the entry falls in. Use this for long-running umbrella tasks (e.g. retainer / support / on-call) where the user wants every hour in one place instead of split across weekly wrappers.\n\nWhen the user wants pinned mode but does not yet know the taskId, first call `log_works_config_setup_netdok_discover` with `includeTasks=true` and let them pick from `projectTasks`. Both modes can be mixed across projects in a single call.",
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
                  "Optional. A fixed Netdok taskId that collects every worklog for this project. When set, this project bypasses the weekly-wrapper flow entirely: `log_works_netdok_tasks` skips wrapper creation (reports the project under `pinned` instead of `weeks`), and `log_works_netdok_worklogs` posts every entry under this taskId regardless of which ISO week the entry falls in. `sprintId` and `statusId` are not required in pinned mode. Find available taskIds by calling `log_works_config_setup_netdok_discover` with `includeTasks=true`.",
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
      title: "Check Slack + Netdok readiness",
      description:
        "Always call this before any other tool in a fresh session. Returns { slack, netdok, nextStep, configPath }. If slack.ready is false, only set up Slack and stop — never bundle Netdok setup in the same exchange.",
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
