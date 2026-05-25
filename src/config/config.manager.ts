import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AppError } from "../errors.ts";
import type { LogWorksConfig } from "../types/index.ts";

const SECRET_KEYS = new Set([
  "slack.userToken",
  "netdok.authHeader",
  "netdok.apiKey",
]);

export function defaultConfigPath(): string {
  return join(homedir(), ".log-works", "config.json");
}

export function defaultStoragePath(): string {
  return join(homedir(), ".log-works", "db.json");
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.LOG_WORKS_CONFIG ?? defaultConfigPath();
}

export function resolveStoragePath(config: LogWorksConfig): string {
  return config.storage?.path ?? defaultStoragePath();
}

export async function loadConfig(
  options: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LogWorksConfig> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? resolveConfigPath(env);

  let parsed: LogWorksConfig;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as LogWorksConfig;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new AppError(
        "config-missing",
        `Config file not found: ${configPath}`,
      );
    }
    throw error;
  }

  return applyEnvOverrides(parsed, env);
}

export async function saveConfig(
  configPath: string,
  config: LogWorksConfig,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function applyEnvOverrides(
  config: LogWorksConfig,
  env: NodeJS.ProcessEnv,
): LogWorksConfig {
  const next = structuredClone(config);
  const overrides: Array<[string, string | undefined]> = [
    ["slack.userToken", env.LOG_WORKS_SLACK_USER_TOKEN],
    ["slack.userId", env.LOG_WORKS_SLACK_USER_ID],
    ["slack.channels", env.LOG_WORKS_SLACK_CHANNELS],
    ["netdok.baseUrl", env.LOG_WORKS_NETDOK_BASE_URL],
    ["netdok.authHeader", env.LOG_WORKS_NETDOK_AUTH_HEADER],
    ["netdok.apiKey", env.LOG_WORKS_NETDOK_API_KEY],
    ["netdok.workspaceId", env.LOG_WORKS_NETDOK_WORKSPACE_ID],
    ["netdok.profileId", env.LOG_WORKS_NETDOK_PROFILE_ID],
    ["netdok.reporterId", env.LOG_WORKS_NETDOK_REPORTER_ID],
    ["storage.path", env.LOG_WORKS_STORAGE_PATH],
  ];

  for (const [key, value] of overrides) {
    if (value !== undefined) {
      setConfigValue(next, key, parseConfigValue(key, value));
    }
  }

  return next;
}

export function setConfigValue(
  config: LogWorksConfig,
  key: string,
  value: unknown,
): LogWorksConfig {
  const parts = key.split(".").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid config key: ${key}`);
  }

  let cursor = config as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i] as string;
    const existing = cursor[segment];
    if (!isPlainObject(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[parts.at(-1) as string] = coerceConfigValue(value);

  return config;
}

export function redactConfig(config: LogWorksConfig): LogWorksConfig {
  const redacted = structuredClone(config);

  for (const key of SECRET_KEYS) {
    if (getConfigValue(redacted, key) !== undefined) {
      setConfigValue(redacted, key, "[redacted]");
    }
  }

  return redacted;
}

export function getConfigValue(config: LogWorksConfig, key: string): unknown {
  const parts = key.split(".").filter(Boolean);
  if (parts.length < 2) return undefined;

  let cursor: unknown = config;
  for (const part of parts) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function parseConfigValue(key: string, value: string): string | string[] {
  if (key === "slack.channels") {
    return value
      .split(",")
      .map((channel) => channel.trim())
      .filter(Boolean);
  }

  return value;
}

function coerceConfigValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (
    value !== "" &&
    !Number.isNaN(Number(value)) &&
    /^-?\d+(\.\d+)?$/.test(value)
  ) {
    return Number(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
