import { loadConfig } from "../config/config.manager.ts";
import { AppError } from "../errors.ts";
import type {
  LogWorksConfig,
  NetdokFetchTasksResult,
  NetdokRemoteTaskSummary,
} from "../types/index.ts";
import { type NetdokClient, createNetdokClient } from "./netdok.service.ts";

export interface FetchNetdokRemoteTasksOptions {
  projectId?: string;
  sprintId?: string;
  config?: LogWorksConfig;
  client?: NetdokClient;
}

export async function fetchNetdokRemoteTasks(
  options: FetchNetdokRemoteTasksOptions,
): Promise<NetdokFetchTasksResult> {
  const projectId = options.projectId?.trim();
  if (!projectId) {
    throw new AppError("config-missing", "Missing projectId");
  }

  const config = options.config ?? (await loadConfig());
  const client = options.client ?? createNetdokClient(config);

  const sprintId = options.sprintId?.trim() || undefined;
  const remote = await client.fetchTasksForProject(projectId, sprintId);

  const tasks: NetdokRemoteTaskSummary[] = remote.map((task) => ({
    id: task.id,
    key: task.key,
    name: task.name,
    projectId: task.projectId,
    sprintId: task.sprintId,
    statusId: task.statusId,
    estimate: task.estimate,
    remaining: task.remaining,
    reporterId: task.reporterId,
  }));

  return {
    projectId,
    sprintId,
    total: tasks.length,
    tasks,
  };
}
