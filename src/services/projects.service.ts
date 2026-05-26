import { z } from "zod";
import {
  loadConfig,
  resolveConfigPath,
  saveConfig,
  setConfigValue,
} from "../config/config.manager.ts";
import projectNameSuggestions from "../constants/project-name-suggestions.ts";
import { AppError, isAppError } from "../errors.ts";
import type {
  AddKnownProjectsInput,
  LogWorksConfig,
  ProjectsAddSummary,
  ProjectsListResult,
  ProjectsSetSummary,
} from "../types/index.ts";

const namesSchema = z
  .object({
    names: z.array(z.string().min(1)).max(200),
  })
  .strict();

function uniqueSorted(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
}

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
    .join("; ");
}

async function loadOrEmpty(configPath: string): Promise<LogWorksConfig> {
  try {
    return await loadConfig({ configPath });
  } catch (error) {
    if (isAppError(error) && error.code === "config-missing") {
      return {};
    }
    throw error;
  }
}

export async function listProjects(
  options: { config?: LogWorksConfig; configPath?: string } = {},
): Promise<ProjectsListResult> {
  const configPath = options.configPath ?? resolveConfigPath();
  const config = options.config ?? (await loadOrEmpty(configPath));
  const suggestions = uniqueSorted(projectNameSuggestions);
  const known = uniqueSorted(config.projects?.known ?? []);
  const merged = uniqueSorted([...suggestions, ...known]);
  return { suggestions, known, merged, configPath };
}

export interface SetKnownProjectsInput {
  names: string[];
}

export async function setKnownProjects(
  input: SetKnownProjectsInput,
  options: { configPath?: string } = {},
): Promise<ProjectsSetSummary> {
  const parsed = namesSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "setup-invalid",
      `Invalid projects set payload: ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  const known = uniqueSorted(parsed.data.names);
  const configPath = options.configPath ?? resolveConfigPath();
  const config = await loadOrEmpty(configPath);
  setConfigValue(config, "projects.known", known);
  await saveConfig(configPath, config);
  return { applied: true, known, configPath };
}

export async function addKnownProjects(
  input: AddKnownProjectsInput,
  options: { configPath?: string } = {},
): Promise<ProjectsAddSummary> {
  const parsed = namesSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "setup-invalid",
      `Invalid projects add payload: ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  const configPath = options.configPath ?? resolveConfigPath();
  const config = await loadOrEmpty(configPath);
  const existing = uniqueSorted(config.projects?.known ?? []);
  const existingSet = new Set(existing);
  const merged = uniqueSorted([...existing, ...parsed.data.names]);
  const added = merged.filter((name) => !existingSet.has(name));
  setConfigValue(config, "projects.known", merged);
  await saveConfig(configPath, config);
  return { applied: true, known: merged, added, configPath };
}
