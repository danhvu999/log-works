import { z } from "zod";
import {
  loadConfig,
  redactConfig,
  resolveConfigPath,
  resolveStoragePath,
  saveConfig,
  setConfigValue,
} from "../config/config.manager.ts";
import projectNameSuggestions from "../constants/project-name-suggestions.ts";
import { AppError, isAppError } from "../errors.ts";
import type {
  ConfigCheckNextStep,
  ConfigReadinessResult,
  LogWorksConfig,
  NetdokApplyInput,
  NetdokApplySummary,
  NetdokDiscoverResult,
  NetdokReadinessResult,
  SlackReadinessResult,
  SlackSetupSummary,
} from "../types/index.ts";
import { netdokSuggestion } from "./netdok-hint.service.ts";
import { type NetdokClient, createNetdokClient } from "./netdok.service.ts";
import { UNSPECIFIED_PROJECT, evaluateMessage } from "./parser.service.ts";
import { readDatabase } from "./storage.service.ts";

export interface SetupSlackInput {
  userToken: string;
  userId: string;
  channels?: string[];
}

export interface SetupNetdokDiscoverInput {
  apiKey: string;
  workspaceId?: string;
  baseUrl?: string;
  authBaseUrl?: string;
  projectIds?: string[];
  includeTasks?: boolean;
}

const slackSchema = z.object({
  userToken: z.string().min(1),
  userId: z.string().min(1),
  channels: z.array(z.string().min(1)).optional(),
});

const discoverSchema = z.object({
  apiKey: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  authBaseUrl: z.string().url().optional(),
  projectIds: z.array(z.string().min(1)).optional(),
  includeTasks: z.boolean().optional(),
});

const projectMappingSchema = z
  .object({
    projectId: z.string().min(1),
    sprintId: z.string().min(1).optional(),
    statusId: z.string().min(1).optional(),
    pinnedTaskId: z.string().min(1).optional(),
    assigneeIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

const applySchema = z
  .object({
    baseUrl: z.string().url().optional(),
    authBaseUrl: z.string().url().optional(),
    apiKey: z.string().min(1),
    workspaceId: z.string().min(1),
    profileId: z.string().min(1),
    reporterId: z.string().min(1).optional(),
    projects: z.record(z.string().min(1), projectMappingSchema),
  })
  .strict();

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
    .join("; ");
}

async function loadOrEmptyConfig(configPath: string): Promise<LogWorksConfig> {
  try {
    return await loadConfig({ configPath });
  } catch (error) {
    if (isAppError(error) && error.code === "config-missing") {
      return {};
    }
    throw error;
  }
}

export async function setupSlackConfig(
  input: SetupSlackInput,
  options: { configPath?: string } = {},
): Promise<SlackSetupSummary> {
  const parsed = slackSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "setup-invalid",
      `Invalid slack setup payload: ${formatZodIssues(parsed.error)}`,
    );
  }

  const configPath = options.configPath ?? resolveConfigPath();
  const config = await loadOrEmptyConfig(configPath);

  setConfigValue(config, "slack.userToken", parsed.data.userToken);
  setConfigValue(config, "slack.userId", parsed.data.userId);
  if (parsed.data.channels !== undefined) {
    setConfigValue(config, "slack.channels", parsed.data.channels);
  }

  await saveConfig(configPath, config);

  return {
    applied: true,
    config: redactConfig(config),
    configPath,
  };
}

export async function setupNetdokDiscover(
  input: SetupNetdokDiscoverInput,
  options: { config?: LogWorksConfig; client?: NetdokClient } = {},
): Promise<NetdokDiscoverResult> {
  const parsed = discoverSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "setup-invalid",
      `Invalid netdok discover payload: ${formatZodIssues(parsed.error)}`,
    );
  }

  const requested = parsed.data;
  const baseConfig =
    options.config ?? (await loadOrEmptyConfig(resolveConfigPath()));
  const ephemeralConfig: LogWorksConfig = {
    ...baseConfig,
    netdok: {
      ...(baseConfig.netdok ?? {}),
      apiKey: requested.apiKey,
      baseUrl: requested.baseUrl ?? baseConfig.netdok?.baseUrl,
      authBaseUrl: requested.authBaseUrl ?? baseConfig.netdok?.authBaseUrl,
      workspaceId: requested.workspaceId,
    },
  };
  const client = options.client ?? createNetdokClient(ephemeralConfig);

  const workspaces = await client.fetchWorkspaces(requested.authBaseUrl);
  const localProjectsSeen = await collectKnownLocalProjects(baseConfig);

  if (!requested.workspaceId) {
    return {
      workspaces,
      me: null,
      projects: [],
      projectDetails: [],
      localProjectsSeen,
    };
  }

  const me = await client.fetchMe();
  const projects = await client.fetchProjects();
  const detailsTargets =
    requested.projectIds && requested.projectIds.length > 0
      ? projects.filter((p) => requested.projectIds?.includes(p.id))
      : projects;
  const projectDetails = await Promise.all(
    detailsTargets.map((p) => client.fetchProjectDetails(p.id)),
  );

  const projectTasks = requested.includeTasks
    ? await Promise.all(
        detailsTargets.map(async (p) => {
          const tasks = await client.fetchTasksForProject(p.id);
          return {
            projectId: p.id,
            tasks: tasks.map((t) => ({
              id: t.id,
              key: t.key,
              name: t.name,
              sprintId: t.sprintId,
              statusId: t.statusId,
            })),
          };
        }),
      )
    : undefined;

  return {
    workspaces,
    me,
    projects,
    projectDetails,
    ...(projectTasks ? { projectTasks } : {}),
    localProjectsSeen,
    workspaceId: requested.workspaceId,
  };
}

export async function setupNetdokApply(
  input: NetdokApplyInput,
  options: { configPath?: string } = {},
): Promise<NetdokApplySummary> {
  const parsed = applySchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "setup-invalid",
      `Invalid netdok apply payload: ${formatZodIssues(parsed.error)}`,
    );
  }
  const data = parsed.data;

  const configPath = options.configPath ?? resolveConfigPath();
  const config = await loadOrEmptyConfig(configPath);

  setConfigValue(config, "netdok.apiKey", data.apiKey);
  setConfigValue(config, "netdok.workspaceId", data.workspaceId);
  setConfigValue(config, "netdok.profileId", data.profileId);
  setConfigValue(
    config,
    "netdok.reporterId",
    data.reporterId ?? data.profileId,
  );
  if (data.baseUrl !== undefined) {
    setConfigValue(config, "netdok.baseUrl", data.baseUrl);
  } else if (!config.netdok?.baseUrl) {
    setConfigValue(config, "netdok.baseUrl", "https://api.netdok.co");
  }
  if (data.authBaseUrl !== undefined) {
    setConfigValue(config, "netdok.authBaseUrl", data.authBaseUrl);
  }

  for (const [localName, mapping] of Object.entries(data.projects)) {
    const prefix = `netdok.projects.${localName}`;
    setConfigValue(config, `${prefix}.projectId`, mapping.projectId);
    if (mapping.sprintId !== undefined) {
      setConfigValue(config, `${prefix}.sprintId`, mapping.sprintId);
    }
    if (mapping.statusId !== undefined) {
      setConfigValue(config, `${prefix}.statusId`, mapping.statusId);
    }
    if (mapping.pinnedTaskId !== undefined) {
      setConfigValue(config, `${prefix}.pinnedTaskId`, mapping.pinnedTaskId);
    }
    if (mapping.assigneeIds !== undefined) {
      setConfigValue(config, `${prefix}.assigneeIds`, mapping.assigneeIds);
    }
  }

  await saveConfig(configPath, config);

  return {
    applied: true,
    config: redactConfig(config),
    configPath,
  };
}

async function scanLocalProjectsSeen(
  config: LogWorksConfig | undefined,
): Promise<string[]> {
  if (!config) return [];
  let storagePath: string;
  try {
    storagePath = resolveStoragePath(config);
  } catch {
    return [];
  }
  let database: Awaited<ReturnType<typeof readDatabase>>;
  try {
    database = await readDatabase(storagePath);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const message of database.rawMessages) {
    const evaluation = evaluateMessage(message.text);
    for (const entry of evaluation.entries) {
      if (entry.project && entry.project !== UNSPECIFIED_PROJECT) {
        seen.add(entry.project);
      }
    }
  }
  return [...seen].sort();
}

async function collectKnownLocalProjects(
  config: LogWorksConfig | undefined,
): Promise<string[]> {
  const scanned = await scanLocalProjectsSeen(config);
  return [...new Set([...projectNameSuggestions, ...scanned])].sort();
}

export async function checkSlackReadiness(
  config: LogWorksConfig,
): Promise<SlackReadinessResult> {
  const slack = config.slack;
  const missing: string[] = [];
  if (!slack?.userToken) missing.push("slack.userToken");
  if (!slack?.userId) missing.push("slack.userId");
  if (!slack?.channels || slack.channels.length === 0) {
    missing.push("slack.channels");
  }
  return {
    ready: missing.length === 0,
    missing,
    suggestion:
      missing.length === 0
        ? "Ready."
        : "Call log_works_config_setup_slack with userToken, userId, and channels.",
  };
}

export async function checkNetdokReadiness(
  options: { config?: LogWorksConfig; configPath?: string } = {},
): Promise<NetdokReadinessResult> {
  const configPath = options.configPath ?? resolveConfigPath();
  const config = options.config ?? (await loadOrEmptyConfig(configPath));

  const missing: string[] = [];
  const netdok = config.netdok;
  if (!netdok?.apiKey) missing.push("netdok.apiKey");
  if (!netdok?.workspaceId) missing.push("netdok.workspaceId");
  if (!netdok?.profileId) missing.push("netdok.profileId");

  const mappedLocalProjects = Object.keys(netdok?.projects ?? {}).sort();
  if (mappedLocalProjects.length === 0) {
    missing.push("netdok.projects (at least one mapping)");
  }

  const knownLocalProjects = await collectKnownLocalProjects(config);
  const mappedSet = new Set(mappedLocalProjects);
  const unmappedLocalProjects = knownLocalProjects.filter(
    (project) => !mappedSet.has(project),
  );

  const baseKeysMissing =
    missing.includes("netdok.apiKey") ||
    missing.includes("netdok.workspaceId") ||
    missing.includes("netdok.profileId");
  const noMappings = mappedLocalProjects.length === 0;
  const suggestion = netdokSuggestion({
    baseKeysMissing,
    noMappings,
    unmappedProjects: unmappedLocalProjects,
  });

  return {
    ready: missing.length === 0,
    missing,
    knownLocalProjects,
    mappedLocalProjects,
    unmappedLocalProjects,
    suggestion,
  };
}

export async function checkConfigReadiness(
  options: { config?: LogWorksConfig; configPath?: string } = {},
): Promise<ConfigReadinessResult> {
  const configPath = options.configPath ?? resolveConfigPath();
  const config = options.config ?? (await loadOrEmptyConfig(configPath));

  const slack = await checkSlackReadiness(config);
  const netdok = await checkNetdokReadiness({ config });

  const netdokBaseKeysMissing =
    netdok.missing.includes("netdok.apiKey") ||
    netdok.missing.includes("netdok.workspaceId") ||
    netdok.missing.includes("netdok.profileId");
  const noNetdokMappings = netdok.mappedLocalProjects.length === 0;
  const hasRawMessages = await hasAnyRawMessages(config);

  let nextStep: ConfigCheckNextStep;
  if (!slack.ready) {
    nextStep = "setup-slack";
  } else if (netdokBaseKeysMissing) {
    nextStep = !hasRawMessages ? "fetch-and-derive" : "setup-netdok-discover";
  } else if (noNetdokMappings) {
    nextStep = "setup-netdok-apply";
  } else if (!hasRawMessages) {
    nextStep = "fetch-and-derive";
  } else {
    nextStep = "ready";
  }

  return {
    slack,
    netdok,
    nextStep,
    configPath,
  };
}

async function hasAnyRawMessages(
  config: LogWorksConfig | undefined,
): Promise<boolean> {
  if (!config) return false;
  let storagePath: string;
  try {
    storagePath = resolveStoragePath(config);
  } catch {
    return false;
  }
  try {
    const database = await readDatabase(storagePath);
    return database.rawMessages.length > 0;
  } catch {
    return false;
  }
}
