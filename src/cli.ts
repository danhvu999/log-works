import { Command } from "commander";
import {
  loadConfig,
  redactConfig,
  resolveConfigPath,
  saveConfig,
  setConfigValue,
} from "./config/config.manager.ts";
import { AppError } from "./errors.ts";
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
import { summarizeStorage } from "./services/summary.service.ts";
import type {
  CommandSpec,
  ConfigReadinessResult,
  DeriveSummary,
  ExportSummary,
  FetchSummary,
  NetdokApplyInput,
  NetdokApplySummary,
  NetdokDiscoverResult,
  NetdokHint,
  NetdokTaskSyncResult,
  NetdokWorklogSyncResult,
  SlackSetupSummary,
  SmartIngestInputEntry,
  SmartIngestSummary,
  StorageClearNetdokSummary,
  StorageResetSummary,
  SummaryResult,
  UnparsedListResult,
} from "./types/index.ts";

export const COMMON_OPTIONS = [{ name: "--json", takesValue: false }];

export const COMMAND_SPECS: CommandSpec[] = [
  {
    name: "config set",
    summary: "Set a config value",
    options: COMMON_OPTIONS,
  },
  {
    name: "config show",
    summary: "Show redacted config",
    options: COMMON_OPTIONS,
  },
  {
    name: "config setup slack",
    summary: "Write slack.* keys (no Slack network call)",
    options: [
      ...COMMON_OPTIONS,
      { name: "--user-token", takesValue: true },
      { name: "--user-id", takesValue: true },
      { name: "--channels", takesValue: true },
    ],
  },
  {
    name: "config setup netdok-discover",
    summary: "Probe Netdok with apiKey and return workspaces/projects/details",
    options: [
      ...COMMON_OPTIONS,
      { name: "--api-key", takesValue: true },
      { name: "--workspace-id", takesValue: true },
      { name: "--base-url", takesValue: true },
      { name: "--auth-base-url", takesValue: true },
      { name: "--project-ids", takesValue: true },
    ],
  },
  {
    name: "config setup netdok-apply",
    summary: "Write netdok config (apiKey/workspaceId/profileId + projects)",
    options: [...COMMON_OPTIONS, { name: "--file", takesValue: true }],
  },
  {
    name: "config check",
    summary:
      "Pre-flight: report Slack/Netdok readiness and the next setup step",
    options: COMMON_OPTIONS,
  },
  {
    name: "fetch",
    summary: "Fetch Slack messages into local storage",
    options: [
      ...COMMON_OPTIONS,
      { name: "--from", takesValue: true },
      { name: "--to", takesValue: true },
      { name: "--channel", takesValue: true },
    ],
  },
  {
    name: "derive",
    summary: "Parse raw Slack messages into structured work-logs",
    options: [
      ...COMMON_OPTIONS,
      { name: "--from", takesValue: true },
      { name: "--to", takesValue: true },
    ],
  },
  {
    name: "parse list-unparsed",
    summary:
      "List raw Slack messages the rule parser couldn't fully derive (smart-parse loop)",
    options: [
      ...COMMON_OPTIONS,
      { name: "--from", takesValue: true },
      { name: "--to", takesValue: true },
      { name: "--no-partial", takesValue: false },
    ],
  },
  {
    name: "parse ingest",
    summary: "Ingest structured smart-parsed entries from JSON (file or stdin)",
    options: [...COMMON_OPTIONS, { name: "--file", takesValue: true }],
  },
  {
    name: "export",
    summary: "Export local work-log entries in a chosen format",
    options: [
      ...COMMON_OPTIONS,
      { name: "--format", takesValue: true },
      { name: "--from", takesValue: true },
      { name: "--to", takesValue: true },
      { name: "--status", takesValue: true },
      { name: "--out", takesValue: true },
    ],
  },
  {
    name: "summary",
    summary:
      "Aggregate local DB: unique projects, total hours per project, counts",
    options: [
      ...COMMON_OPTIONS,
      { name: "--from", takesValue: true },
      { name: "--to", takesValue: true },
    ],
  },
  {
    name: "netdok tasks",
    summary: "Ensure a Netdok wrapper task exists for each (project, week)",
    options: [
      ...COMMON_OPTIONS,
      { name: "--from", takesValue: true },
      { name: "--to", takesValue: true },
      { name: "--apply", takesValue: false },
    ],
  },
  {
    name: "netdok worklogs",
    summary: "Post pending work-logs to Netdok under their weekly task",
    options: [
      ...COMMON_OPTIONS,
      { name: "--from", takesValue: true },
      { name: "--to", takesValue: true },
      { name: "--apply", takesValue: false },
    ],
  },
  {
    name: "storage clear-netdok",
    summary: "Clear local Netdok task and worklog sync state",
    options: [
      ...COMMON_OPTIONS,
      { name: "--from", takesValue: true },
      { name: "--to", takesValue: true },
      { name: "--apply", takesValue: false },
    ],
  },
  {
    name: "storage reset",
    summary: "Reset the local database to an empty state",
    options: [...COMMON_OPTIONS, { name: "--apply", takesValue: false }],
  },
];

export function getCommandNames(): string[] {
  return COMMAND_SPECS.map((command) => command.name);
}

export function renderHelp(): string {
  const commands = COMMAND_SPECS.map((command) => `  ${command.name}`).join(
    "\n",
  );
  return `Usage: log-works <command> [options]\n\nCommands:\n${commands}\n`;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("log-works")
    .description("Sync Slack work-log messages into Netdok via local storage")
    .showHelpAfterError()
    .exitOverride();

  const configCommand = program
    .command("config")
    .description("Manage local config");

  configCommand
    .command("show")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const config = redactConfig(await loadConfig());
      emit(config, Boolean(options.json), () =>
        JSON.stringify(config, null, 2),
      );
    });

  configCommand
    .command("set")
    .argument("<key>")
    .argument("<value>")
    .option("--json", "Print machine-readable JSON")
    .action(async (key: string, value: string, options: { json?: boolean }) => {
      const configPath = resolveConfigPath();
      const config = await loadConfig();
      setConfigValue(config, key, value);
      await saveConfig(configPath, config);
      emit(
        { key, updated: true },
        Boolean(options.json),
        () => `Updated ${key}\n`,
      );
    });

  const setupCommand = configCommand
    .command("setup")
    .description("Guided setup for Slack and Netdok credentials");

  setupCommand
    .command("slack")
    .description("Write slack.userToken, slack.userId, slack.channels")
    .requiredOption("--user-token <token>", "Slack user OAuth token (xoxp-…)")
    .requiredOption("--user-id <id>", "Slack user id to scope fetches to")
    .option(
      "--channels <list>",
      "Comma-separated channel ids or `self` sentinel",
    )
    .option("--json", "Print machine-readable JSON")
    .action(async (options: SetupSlackOptions) => {
      const channels = options.channels
        ? options.channels
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : undefined;
      const result = await setupSlackConfig({
        userToken: options.userToken,
        userId: options.userId,
        channels,
      });
      emit(result, Boolean(options.json), formatSlackSetupSummary);
    });

  setupCommand
    .command("netdok-discover")
    .description(
      "Probe Netdok and return workspaces/projects (no config writes)",
    )
    .requiredOption("--api-key <key>", "Netdok API key (ndk_…)")
    .option("--workspace-id <id>", "Workspace to scope /me, /projects to")
    .option("--base-url <url>", "Netdok API base url")
    .option("--auth-base-url <url>", "Netdok auth base url")
    .option("--project-ids <list>", "Comma-separated project ids to detail")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: SetupNetdokDiscoverOptions) => {
      const projectIds = options.projectIds
        ? options.projectIds
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : undefined;
      const result = await setupNetdokDiscover({
        apiKey: options.apiKey,
        workspaceId: options.workspaceId,
        baseUrl: options.baseUrl,
        authBaseUrl: options.authBaseUrl,
        projectIds,
      });
      emit(result, Boolean(options.json), formatNetdokDiscoverSummary);
    });

  setupCommand
    .command("netdok-apply")
    .description(
      "Apply a NetdokApplyInput JSON payload (file or stdin) to the config",
    )
    .option("--file <path>", "JSON file containing the apply payload")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: SetupNetdokApplyOptions) => {
      const payload = await readJsonInput(options.file);
      const result = await setupNetdokApply(payload as NetdokApplyInput);
      emit(result, Boolean(options.json), formatNetdokApplySummary);
    });

  configCommand
    .command("check")
    .description(
      "Pre-flight: report Slack/Netdok readiness and the next setup step",
    )
    .option("--json", "Print machine-readable JSON")
    .action(async (options: ConfigCheckOptions) => {
      const result = await checkConfigReadiness();
      emit(result, Boolean(options.json), formatConfigReadinessSummary);
    });

  program
    .command("fetch")
    .option(
      "--from <date>",
      "Start date, ISO datetime, now, lastweek, or last-week",
    )
    .option("--to <date>", "End date, ISO datetime, or now")
    .option("--channel <id>", "Override configured Slack channels")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: FetchOptions) => {
      const result = await fetchWorkLogs(options);
      emit(result, Boolean(options.json), formatFetchSummary);
    });

  program
    .command("derive")
    .option("--from <date>", "Start date inclusive (YYYY-MM-DD)")
    .option("--to <date>", "End date inclusive (YYYY-MM-DD)")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: DeriveOptions) => {
      const result = await deriveWorkLogs(options);
      emit(result, Boolean(options.json), formatDeriveSummary);
    });

  const parseCommand = program
    .command("parse")
    .description("Smart-parse loop for messages the rule parser cannot handle");

  parseCommand
    .command("list-unparsed")
    .description(
      "List raw Slack messages with no or partial rule-parsed entries",
    )
    .option("--from <date>", "Start date inclusive (YYYY-MM-DD)")
    .option("--to <date>", "End date inclusive (YYYY-MM-DD)")
    .option("--no-partial", "Exclude messages flagged as partial")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: ParseListUnparsedOptions) => {
      const result = await listUnparsedMessages({
        from: options.from,
        to: options.to,
        includePartial: options.partial !== false,
      });
      emit(result, Boolean(options.json), formatUnparsedListSummary);
    });

  parseCommand
    .command("ingest")
    .description(
      "Ingest structured smart-parsed entries (JSON array). Reads --file or stdin.",
    )
    .option("--file <path>", "JSON file containing the entry array")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: ParseIngestOptions) => {
      const entries = await readIngestEntries(options.file);
      const result = await ingestSmartEntries({ entries });
      emit(result, Boolean(options.json), formatSmartIngestSummary);
    });

  program
    .command("export")
    .requiredOption("--format <fmt>", "Export format (csv)")
    .option("--from <date>", "Start date, inclusive (YYYY-MM-DD)")
    .option("--to <date>", "End date, inclusive (YYYY-MM-DD)")
    .option("--status <status>", "Filter by status: pending, sent, or failed")
    .option("--out <file>", "Write to file instead of stdout")
    .option("--json", "Print machine-readable summary JSON")
    .action(async (options: ExportOptions) => {
      const result = await exportWorkLogs(options);
      emitExport(result, Boolean(options.json), Boolean(options.out));
    });

  program
    .command("summary")
    .description(
      "Aggregate local DB into unique projects and per-project hour totals",
    )
    .option("--from <date>", "Start date inclusive (YYYY-MM-DD)")
    .option("--to <date>", "End date inclusive (YYYY-MM-DD)")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: SummaryOptions) => {
      const result = await summarizeStorage({
        from: options.from,
        to: options.to,
      });
      emit(result, Boolean(options.json), formatSummaryResult);
    });

  const netdokCommand = program
    .command("netdok")
    .description("Sync work-logs into Netdok");

  netdokCommand
    .command("tasks")
    .description("Ensure a Netdok wrapper task exists for each (project, week)")
    .option("--from <date>", "Start date inclusive (YYYY-MM-DD)")
    .option("--to <date>", "End date inclusive (YYYY-MM-DD)")
    .option("--apply", "Create missing tasks (otherwise preview only)")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: NetdokTasksOptions) => {
      const result = await syncNetdokTasks(options);
      emit(result, Boolean(options.json), formatTasksSummary);
    });

  netdokCommand
    .command("worklogs")
    .description("Post pending work-logs to Netdok under their weekly task")
    .option("--from <date>", "Start date inclusive (YYYY-MM-DD)")
    .option("--to <date>", "End date inclusive (YYYY-MM-DD)")
    .option("--apply", "Post worklogs (otherwise preview only)")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: NetdokWorklogsOptions) => {
      const result = await syncNetdokWorklogs(options);
      emit(result, Boolean(options.json), formatWorklogsSummary);
    });

  const storageCommand = program
    .command("storage")
    .description("Manage the local storage database");

  storageCommand
    .command("clear-netdok")
    .description("Clear local Netdok task and worklog sync state")
    .option("--from <date>", "Start date inclusive (YYYY-MM-DD)")
    .option("--to <date>", "End date inclusive (YYYY-MM-DD)")
    .option("--apply", "Write the cleanup to storage (otherwise preview only)")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: StorageClearNetdokOptions) => {
      const result = await clearNetdokStorage(options);
      emit(result, Boolean(options.json), formatStorageClearNetdokSummary);
    });

  storageCommand
    .command("reset")
    .description("Reset the local database to an empty state")
    .option("--apply", "Write the reset to storage (otherwise preview only)")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: StorageResetOptions) => {
      const result = await resetStorage(options);
      emit(result, Boolean(options.json), formatStorageResetSummary);
    });

  return program;
}

export async function runCli(argv: string[]): Promise<number> {
  const wantsJson = argv.includes("--json");

  try {
    await createProgram().parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (isCommanderExit(error)) {
      return error.exitCode;
    }

    const body = errorResponse(error);
    if (wantsJson) {
      process.stdout.write(`${JSON.stringify(body)}\n`);
    } else {
      process.stderr.write(`${body.error.code}: ${body.error.message}\n`);
    }
    return 1;
  }
}

interface FetchOptions {
  from?: string;
  to?: string;
  channel?: string;
  json?: boolean;
}

interface ExportOptions {
  format?: string;
  from?: string;
  to?: string;
  status?: string;
  out?: string;
  json?: boolean;
}

interface DeriveOptions {
  from?: string;
  to?: string;
  json?: boolean;
}

interface NetdokTasksOptions {
  from?: string;
  to?: string;
  apply?: boolean;
  json?: boolean;
}

interface NetdokWorklogsOptions {
  from?: string;
  to?: string;
  apply?: boolean;
  json?: boolean;
}

interface StorageClearNetdokOptions {
  from?: string;
  to?: string;
  apply?: boolean;
  json?: boolean;
}

interface StorageResetOptions {
  apply?: boolean;
  json?: boolean;
}

interface SummaryOptions {
  from?: string;
  to?: string;
  json?: boolean;
}

interface ParseListUnparsedOptions {
  from?: string;
  to?: string;
  partial?: boolean;
  json?: boolean;
}

interface ParseIngestOptions {
  file?: string;
  json?: boolean;
}

interface SetupSlackOptions {
  userToken: string;
  userId: string;
  channels?: string;
  json?: boolean;
}

interface SetupNetdokDiscoverOptions {
  apiKey: string;
  workspaceId?: string;
  baseUrl?: string;
  authBaseUrl?: string;
  projectIds?: string;
  json?: boolean;
}

interface SetupNetdokApplyOptions {
  file?: string;
  json?: boolean;
}

interface ConfigCheckOptions {
  json?: boolean;
}

function emit<T extends object>(
  data: T,
  asJson: boolean,
  humanFormatter: (data: T) => string,
): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
    return;
  }

  process.stdout.write(humanFormatter(data));
}

function emitExport(
  result: { body: string | Uint8Array; summary: ExportSummary },
  asJson: boolean,
  hasOut: boolean,
): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result.summary)}\n`);
    return;
  }

  if (hasOut) {
    process.stderr.write(
      `Exported ${result.summary.rows} rows to ${result.summary.path}\n`,
    );
    return;
  }

  process.stdout.write(result.body);
}

function formatDeriveSummary(summary: DeriveSummary): string {
  const lines = [
    `Processed ${summary.processed} messages.`,
    `Inserted ${summary.inserted}; skipped ${summary.skipped}.`,
    `Storage: ${summary.storagePath}`,
  ];
  appendNetdokHintLines(lines, summary.netdokHint);
  lines.push("");
  return lines.join("\n");
}

function formatFetchSummary(summary: FetchSummary): string {
  const lines = [
    `Fetched ${summary.fetched} Slack messages.`,
    `Inserted ${summary.inserted}; skipped ${summary.skipped}.`,
    `Storage: ${summary.storagePath}`,
  ];
  appendNetdokHintLines(lines, summary.netdokHint);
  lines.push("");
  return lines.join("\n");
}

function appendNetdokHintLines(
  lines: string[],
  hint: NetdokHint | undefined,
): void {
  if (!hint) return;
  lines.push(`Netdok: ${hint.configured ? "configured" : "not configured"}.`);
  if (hint.unmappedProjects.length > 0) {
    lines.push(`  Unmapped projects: ${hint.unmappedProjects.join(", ")}`);
  }
  if (hint.suggestion) {
    lines.push(`  Suggestion: ${hint.suggestion}`);
  }
}

function formatSummaryResult(result: SummaryResult): string {
  const lines: string[] = [];
  lines.push(
    `Raw messages: ${result.totals.rawMessages}; work-logs: ${result.totals.workLogs}.`,
  );
  lines.push(
    `Total hours: ${result.totals.totalHours}; unique projects: ${result.totals.uniqueProjects}.`,
  );
  if (result.totals.dateMin && result.totals.dateMax) {
    lines.push(
      `Date range: ${result.totals.dateMin} to ${result.totals.dateMax}.`,
    );
  }
  if (result.projects.length > 0) {
    lines.push("Projects:");
    for (const stat of result.projects) {
      lines.push(
        `  ${stat.project}: ${stat.hours}h, ${stat.entries} entry/entries (${stat.dateMin}..${stat.dateMax})`,
      );
    }
  }
  lines.push(`Storage: ${result.storagePath}`);
  lines.push("");
  return lines.join("\n");
}

function formatTasksSummary(result: NetdokTaskSyncResult): string {
  const lines: string[] = [];
  const verb = result.applied ? "Synced" : "Previewed";
  lines.push(`${verb} ${result.weeks.length} week(s).`);
  for (const week of result.weeks) {
    const idLabel = week.taskKey
      ? `${week.taskKey} (${week.taskId})`
      : (week.taskId ?? "(no taskId)");
    lines.push(
      `  [${week.status}] ${week.project} ${week.weekStart}..${week.weekEnd} → ${idLabel}`,
    );
  }
  if (result.unmapped.length > 0) {
    lines.push("Unmapped projects (no netdok.projects entry):");
    for (const u of result.unmapped) {
      lines.push(`  - ${u.project} (${u.entries} entry/entries)`);
    }
  }
  if (!result.applied) {
    lines.push("Run with --apply to create missing tasks.");
  }
  lines.push("");
  return lines.join("\n");
}

function formatWorklogsSummary(result: NetdokWorklogSyncResult): string {
  const lines: string[] = [];
  const verb = result.applied ? "Synced" : "Previewed";
  const counts = countByStatus(result.entries);
  lines.push(`${verb} ${result.entries.length} entry/entries.`);
  for (const [status, count] of counts) {
    lines.push(`  ${status}: ${count}`);
  }
  if (!result.applied) {
    lines.push("Run with --apply to post worklogs.");
  }
  lines.push("");
  return lines.join("\n");
}

function formatStorageClearNetdokSummary(
  summary: StorageClearNetdokSummary,
): string {
  const verb = summary.applied ? "Cleared" : "Previewed";
  const lines = [
    `${verb} local Netdok sync state.`,
    `Week tasks: ${summary.clearedWeekTasks}; work-log entries reset: ${summary.resetEntries}.`,
    `Storage: ${summary.storagePath}`,
  ];
  if (!summary.applied) {
    lines.push("Run with --apply to persist the cleanup.");
  }
  lines.push("");
  return lines.join("\n");
}

function formatUnparsedListSummary(result: UnparsedListResult): string {
  const lines: string[] = [];
  lines.push(`Unparsed messages: ${result.messages.length}.`);
  for (const message of result.messages) {
    lines.push(
      `  [${message.status}] ${message.date} ${message.ts} (rule entries: ${message.ruleEntries})`,
    );
  }
  if (result.messages.length === 0) {
    lines.push("Nothing to smart-parse in this range.");
  }
  lines.push(`Storage: ${result.storagePath}`);
  lines.push("");
  return lines.join("\n");
}

function formatSmartIngestSummary(summary: SmartIngestSummary): string {
  const lines = [
    `Ingested ${summary.inserted}; skipped (duplicate) ${summary.skipped}.`,
    `Storage: ${summary.storagePath}`,
    "",
  ];
  return lines.join("\n");
}

async function readIngestEntries(
  filePath: string | undefined,
): Promise<SmartIngestInputEntry[]> {
  const raw = filePath ? await readFileText(filePath) : await readStdinText();
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AppError(
      "smart-parse-invalid",
      "No input received. Pass --file <path> or pipe JSON on stdin.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new AppError(
      "smart-parse-invalid",
      `Failed to parse JSON input: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new AppError(
      "smart-parse-invalid",
      "Input must be a JSON array of entries.",
    );
  }
  return parsed as SmartIngestInputEntry[];
}

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve, reject) => {
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.on("error", reject);
  });
}

async function readJsonInput(filePath: string | undefined): Promise<unknown> {
  const raw = filePath ? await readFileText(filePath) : await readStdinText();
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AppError(
      "setup-invalid",
      "No input received. Pass --file <path> or pipe JSON on stdin.",
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new AppError(
      "setup-invalid",
      `Failed to parse JSON input: ${(error as Error).message}`,
    );
  }
}

function formatSlackSetupSummary(summary: SlackSetupSummary): string {
  return [
    `Wrote slack.* keys to ${summary.configPath}.`,
    `Applied: ${summary.applied}.`,
    "",
  ].join("\n");
}

function formatNetdokDiscoverSummary(result: NetdokDiscoverResult): string {
  const lines: string[] = [];
  lines.push(`Workspaces (${result.workspaces.length}):`);
  for (const ws of result.workspaces) {
    lines.push(`  ${ws.id}  ${ws.name}`);
  }
  if (result.me) {
    lines.push(`Profile: ${result.me.profileId} (${result.me.displayName})`);
    lines.push(`Projects (${result.projects.length}):`);
    for (const p of result.projects) {
      lines.push(`  ${p.id}  ${p.key}  ${p.name}`);
    }
    lines.push(`Project details (${result.projectDetails.length}):`);
    for (const d of result.projectDetails) {
      lines.push(
        `  ${d.id}  status=${d.suggestedStatusId ?? "-"}  sprint=${
          d.suggestedSprintId ?? "-"
        }`,
      );
    }
  } else {
    lines.push("Workspace not chosen yet — re-run with --workspace-id");
  }
  if (result.localProjectsSeen.length > 0) {
    lines.push(`Local projects seen: ${result.localProjectsSeen.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatNetdokApplySummary(summary: NetdokApplySummary): string {
  return [
    `Wrote netdok.* keys to ${summary.configPath}.`,
    `Applied: ${summary.applied}.`,
    "",
  ].join("\n");
}

function formatConfigReadinessSummary(result: ConfigReadinessResult): string {
  const lines: string[] = [];
  lines.push(`Next step: ${result.nextStep}`);
  lines.push("");
  lines.push(`Slack ready: ${result.slack.ready}`);
  if (result.slack.missing.length > 0) {
    lines.push(`  Missing: ${result.slack.missing.join(", ")}`);
  }
  lines.push(`  Suggestion: ${result.slack.suggestion}`);
  lines.push("");
  lines.push(`Netdok ready: ${result.netdok.ready}`);
  if (result.netdok.missing.length > 0) {
    lines.push(`  Missing: ${result.netdok.missing.join(", ")}`);
  }
  if (result.netdok.mappedLocalProjects.length > 0) {
    lines.push(
      `  Mapped projects: ${result.netdok.mappedLocalProjects.join(", ")}`,
    );
  }
  if (result.netdok.unmappedLocalProjects.length > 0) {
    lines.push(
      `  Unmapped projects: ${result.netdok.unmappedLocalProjects.join(", ")}`,
    );
  }
  lines.push(`  Suggestion: ${result.netdok.suggestion}`);
  lines.push("");
  lines.push(`Config: ${result.configPath}`);
  lines.push("");
  return lines.join("\n");
}

function formatStorageResetSummary(summary: StorageResetSummary): string {
  const verb = summary.applied ? "Reset" : "Previewed reset of";
  const lines = [
    `${verb} local storage database.`,
    `Raw messages: ${summary.removedRawMessages}; work-logs: ${summary.removedWorkLogs}; week tasks: ${summary.removedNetdokWeekTasks}.`,
    `Cleared meta: ${summary.clearedMeta ? "yes" : "no"}.`,
    `Storage: ${summary.storagePath}`,
  ];
  if (!summary.applied) {
    lines.push("Run with --apply to persist the reset.");
  }
  lines.push("");
  return lines.join("\n");
}

function countByStatus(
  entries: NetdokWorklogSyncResult["entries"],
): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    map.set(entry.status, (map.get(entry.status) ?? 0) + 1);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function isCommanderExit(error: unknown): error is { exitCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "commander.helpDisplayed" &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
  );
}
