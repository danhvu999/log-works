import type { LogWorksConfig } from "../types/index.ts";

const DEFAULT_APP_BASE_URL = "https://app.netdok.co";

export function netdokAppBaseUrl(config: LogWorksConfig | undefined): string {
  return config?.netdok?.appBaseUrl ?? DEFAULT_APP_BASE_URL;
}

export function netdokTaskUrl(
  config: LogWorksConfig | undefined,
  projectId: string | undefined,
  taskId: string | undefined,
): string | undefined {
  if (!projectId || !taskId) return undefined;
  const base = netdokAppBaseUrl(config).replace(/\/+$/, "");
  return `${base}/app/projects/active-sprint?id=${encodeURIComponent(projectId)}&taskId=${encodeURIComponent(taskId)}`;
}
