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
import { exportWorkLogs } from "./services/export.service.ts";
import { fetchWorkLogs } from "./services/fetch.service.ts";
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
  ingestSmartEntries,
  listUnparsedMessages,
} from "./services/smart-parse.service.ts";
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

const SERVER_INSTRUCTIONS = `log-works syncs the user's Slack debrief messages into structured work-logs and (optionally) posts them to Netdok as worklogs under per-(project, ISO-week) wrapper tasks. Use this server whenever the user's request implies any of:

- Logging or "logging works" for a day or week ("log my work today", "log this week", "log yesterday's debrief").
- Reading, summarising, exporting, or reviewing their Slack work-log / debrief messages ("what did I do last week", "export my worklogs to CSV/xlsx", "summarise my debriefs").
- Pushing or syncing time entries / worklogs to Netdok ("sync to Netdok", "post worklogs", "create the weekly task on Netdok").
- Setting up or reconfiguring log-works itself (Slack token, Netdok api key, project mappings).
- Any mention of log-works, the local DB at ~/.log-works/db.json, debrief parsing, smart-parse, pinned Netdok tasks, or weekly wrapper tasks.

If the user's request is unrelated to Slack debriefs / Netdok worklogs / log-works config, do NOT call this server's tools.

When you do use the server, follow the two-stage setup protocol. Before invoking any other tool in a fresh session, call log_works_config_check. Respect the \`nextStep\` field in its result:

- "setup-slack": prompt the user only for Slack credentials (userToken, userId, channels) and call log_works_config_setup_slack. Do NOT also prompt for Netdok in the same exchange.
- "fetch-and-derive": Slack is ready and Netdok is either deferred or not requested. Proceed to log_works_fetch (with \`from: "lastmonth"\` for first-run setup) then the smart-parse loop (log_works_unparsed → log_works_ingest_entries). log_works_derive is intentionally NOT exposed via MCP — it lives in the CLI only because the rule parser is too strict for varied debrief formats.
- "setup-netdok-discover": Slack is ready and the user wants to sync. Ask for the Netdok API key, call log_works_config_setup_netdok_discover (apiKey only), present workspaces, then re-call discover with workspaceId. Before moving on to apply, ask the user whether any of their projects should run in pinned-task mode (all hours under one fixed task, e.g. retainer / support); if yes, re-call discover with includeTasks=true so they can pick a taskId from \`projectTasks\`.
- "setup-netdok-apply": Netdok base keys are set; assemble project mappings (use the readiness result's knownLocalProjects) and call log_works_config_setup_netdok_apply. For each project decide: weekly-wrapper mode (set sprintId + statusId) OR pinned-task mode (set pinnedTaskId, omit sprintId/statusId). Modes can be mixed across projects in one call.
- "ready": call log_works_netdok_tasks / log_works_netdok_worklogs as the user requests.

Never bundle Slack and Netdok setup in one user-facing prompt. Slack always comes first.

NEW-USER HAPPY PATH. For a brand-new user (nextStep walks "setup-slack" → "fetch-and-derive" → "setup-netdok-discover"), always run: log_works_config_setup_slack → log_works_fetch with \`from: "lastmonth"\` (bounded to the last 30 days during setup so the first-run fetch stays small) → log_works_projects_list → confirm/add project names with the user → log_works_projects_set (persist the full final list) → log_works_unparsed → log_works_ingest_entries (for every message returned, propose structured entries with the user and write them as \`source: "smart"\`, drawing project names from the persisted vocabulary; if a debrief surfaces a project name not yet in \`known\`, ask the user to confirm it and call log_works_projects_add to persist it) → log_works_config_setup_netdok_discover → log_works_config_setup_netdok_apply → preview log_works_netdok_tasks → confirm + apply → preview log_works_netdok_worklogs → confirm + apply. There is no MCP derive step — the rule parser is CLI-only. log_works_summary is NOT part of setup — it is the aggregation tool the agent reaches for when the user asks "what did I log last week?" or "how many hours on project X?", not a project-name inference feed.

MUTATING NETDOK CALLS (preview → approve → apply). \`log_works_netdok_tasks\` and \`log_works_netdok_worklogs\` are the only mutating Netdok tools. Both must be called twice:
1. First call without \`apply\` (or \`apply: false\`). This is a preview — no Netdok writes.
2. Present the preview entries to the user in a human-readable form (group by project + week; show wrapper task name or pinned task; for worklogs list date / hours / first line of text and the count per status).
3. Wait for explicit user confirmation ("yes", "apply", "sync it"). Do NOT infer consent from earlier "log my work" phrasing — the preview is the consent gate.
4. Only then re-call with \`apply: true\`. Never chain preview and apply in the same agent turn, and never call \`apply: true\` first.

POST-SYNC SUMMARY. After a successful \`apply: true\` response, write a short summary for the user grouped by project. Each project's section must list: the wrapper or pinned task name, total hours posted, and the \`taskUrl\` from the response rendered as a clickable link. Do not reconstruct URLs by hand — always use the \`taskUrl\` field the server returns. For \`log_works_netdok_tasks\` apply responses, surface \`taskUrl\` from \`weeks[*].taskUrl\` / \`pinned[*].taskUrl\`. For \`log_works_netdok_worklogs\` apply responses, surface \`taskUrl\` (and \`projectId\`) from each posted entry; group entries by \`taskUrl\` so each Netdok task appears once with its total hours.

DEBRIEF FILTER. log_works_fetch only stores Slack messages whose text contains the case-insensitive substring \`debrief\` (so chatter and Brief-only notes never reach the local DB). The result's \`droppedNonDebrief\` field reports how many were filtered. Only pass \`includeNonDebrief: true\` when the user explicitly asks to "fetch everything" / "include all messages" / debug why a message is missing — otherwise leave it off so derive and the smart-parse loop stay focused on real debriefs.

After log_works_fetch succeeds, inspect the optional \`netdokHint\` field on the result. When present, it means either Netdok is not yet configured (\`configured: false\`) or some projects in the just-fetched range are missing from \`netdok.projects\` (\`unmappedProjects\`). Prompt the user to run the Netdok setup flow for those projects — still without bundling Slack prompts.

PROJECT VOCABULARY. Before running the smart-parse loop, call log_works_projects_list and show \`merged\` to the user: "Which of these are your current projects? Add any new ones, drop any you no longer work on." Once the user confirms, call log_works_projects_set with the full final list (REPLACE semantics — pass everything they want kept). Then use the persisted \`known\` list as context when proposing structured entries during log_works_ingest_entries: prefer names already in \`known\`, only invent a new name when the debrief clearly mentions a project not in the list. If the smart-parse step surfaces a project name not in \`known\`, ask the user to confirm it before calling log_works_projects_add (UPSERT) to persist it incrementally — do NOT silently invent names, and do NOT re-call log_works_projects_set for incremental additions (that would clobber other entries). Use log_works_projects_set only for explicit cleanup or full replacement. On subsequent sessions the persisted list reloads automatically — only re-prompt the user if a new debrief references unfamiliar project names.

SMART-PARSE LOOP. After log_works_fetch succeeds, ALWAYS call log_works_unparsed next — it is the canonical parsing step in MCP. There is no log_works_derive tool here; the rule parser stays CLI-only because debrief formats vary too widely for it. If log_works_unparsed returns a non-empty \`messages\` array, propose structured entries (project, text, hours per bullet) to the user, confirm, then call log_works_ingest_entries to write them back as \`source: "smart"\`. If it returns an empty array, say "no debrief messages to parse" briefly and move on. Skip the loop only if the user explicitly opts out.

LOCAL DB INSPECTION. To answer aggregate questions about local work-logs ("what projects did I log last week?", "how many hours on Venulog this month?", "how many pending entries do I still have?"), call log_works_summary — it reads from \`workLogs\` and returns per-project totals plus grand totals over an optional from/to range. To list raw Slack messages whose rule-parser output was empty or partial, call log_works_unparsed. Do NOT shell out to read \`~/.log-works/db.json\` directly (no python / jq / cat / shell tools) — log_works_summary and log_works_unparsed are the supported accessors and they redact storage path correctly. log_works_summary is intentionally NOT part of the setup chain; the project-name vocabulary is established via log_works_projects_list / log_works_projects_set / log_works_projects_add during the smart-parse loop.`;

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
        "Pull Slack messages from configured channels into local storage. Idempotent on Slack `ts`. By default, only messages containing the case-insensitive substring `debrief` are stored — everything else (chatter, Brief-only notes, link drops) is counted in `droppedNonDebrief` and discarded. Pass `includeNonDebrief: true` to keep every authored message. The result may include an optional `netdokHint` field listing projects in the just-fetched range that are missing from `netdok.projects` (and whether Netdok base keys are configured) so the agent can prompt the user to run Netdok setup.",
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
            "When true, skip the default `debrief` substring filter and store every message the configured user authored. Use only when the user explicitly asks to fetch everything (e.g. debugging channel coverage).",
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
    "log_works_summary",
    {
      title: "Aggregate local work-logs by project",
      description:
        "Aggregate the local work-log database. Reads from `workLogs` (NOT raw debrief messages) and returns per-project totals + grand totals over the optional from/to range. Response shape: `{ projects: [{ project, entries, hours, entriesWithoutHours, firstDate, lastDate }], totals: { entries, hours, entriesWithoutHours }, from?, to?, storagePath }`. Projects are sorted by name asc. Use for questions like 'what projects did I log last week?', 'how many hours on Venulog this month?', or any aggregate over the local DB. This is the canonical tool for inspecting local work-log state — do NOT shell out (python / jq / cat ~/.log-works/db.json) to read the DB.",
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
      title: "List the user's known project vocabulary",
      description:
        "Returns the project-name vocabulary the agent should use as parsing context. Three fields: `suggestions` (server seed list from src/constants/project-name-suggestions.ts), `known` (names the user has previously confirmed and persisted under config.projects.known), `merged` (union, dedup, sorted). Call this right before log_works_unparsed so the LLM has a stable project vocabulary; show `merged` to the user, let them confirm or add, then persist via log_works_projects_set.",
      inputSchema: z.object({}).shape,
    },
    async () => run(() => listProjects()),
  );

  server.registerTool(
    "log_works_projects_set",
    {
      title: "Persist user-confirmed project names",
      description:
        "Replace config.projects.known with the supplied list. REPLACE semantics — pass the full final list, not a delta. Names are trimmed, deduped, and sorted before persisting. Use after log_works_projects_list once the user has confirmed their working project names. To drop a stale project, omit it from `names`. Pass an empty list to clear the vocabulary entirely. For incremental additions during the smart-parse loop, prefer log_works_projects_add (UPSERT) so existing entries are preserved.",
      inputSchema: z.object({
        names: z
          .array(z.string().min(1))
          .max(200)
          .describe(
            "Full list of project names the user wants persisted. Replaces any previously stored list.",
          ),
      }).shape,
    },
    async (input) => run(() => setKnownProjects(input)),
  );

  server.registerTool(
    "log_works_projects_add",
    {
      title: "Add project names to known vocabulary (upsert)",
      description:
        "Merge `names` into config.projects.known. UPSERT semantics — existing entries are kept; only new names are added. Trimmed, deduped, sorted before persisting. Use during the smart-parse loop when you encounter a project name not already in `known`: ask the user to confirm the new name, then call this to persist it. To remove or replace entries, use log_works_projects_set (REPLACE semantics).",
      inputSchema: z.object({
        names: z
          .array(z.string().min(1))
          .max(200)
          .describe(
            "Project names to add. Names already in known are kept (no-op); only new ones are persisted.",
          ),
      }).shape,
    },
    async (input) => run(() => addKnownProjects(input)),
  );

  server.registerTool(
    "log_works_netdok_tasks",
    {
      title: "Sync Netdok wrapper tasks",
      description:
        "For each (project, ISO-week) in range, ensure a wrapper task '[<Project>] Task issues from <Mon> to <Sun>' exists in Netdok. Previews by default; pass apply=true to create. ALWAYS call with apply omitted first, show the preview entries to the user, wait for explicit confirmation, then re-call with apply=true. Each result entry (in `weeks` and `pinned`) includes `taskUrl` when a taskId is known — render these as clickable links in the post-sync summary instead of building URLs by hand.",
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
        "Post pending work-logs to Netdok under their weekly wrapper task. Dedup: local `sent` status + remote (day, text) fingerprint. Previews by default; pass apply=true to post. ALWAYS call with apply omitted first, show the preview entries (grouped by project + week, with date/hours/text) to the user, wait for explicit confirmation, then re-call with apply=true. Each result entry includes `projectId` and `taskUrl` when known — render `taskUrl` as a clickable link in the post-sync summary instead of building URLs by hand.",
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
