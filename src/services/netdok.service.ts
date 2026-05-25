import { AppError } from "../errors.ts";
import type {
  LogWorksConfig,
  NetdokMeSummary,
  NetdokProjectDetails,
  NetdokProjectSummary,
  NetdokStatusSummary,
  NetdokWorkspaceSummary,
  WorkLogEntry,
} from "../types/index.ts";

export interface NetdokDryRunRequest {
  method: "POST";
  url: string;
  headers: {
    authorization: string;
    "content-type": "application/json";
  };
  body: {
    date: string;
    text: string;
    sourceId: string;
  };
}

export function buildNetdokDryRunRequest(
  config: LogWorksConfig,
  entry: WorkLogEntry,
): NetdokDryRunRequest {
  if (!config.netdok?.baseUrl) {
    throw new AppError("config-missing", "Missing netdok.baseUrl");
  }

  return {
    method: "POST",
    url: `${config.netdok.baseUrl.replace(/\/$/, "")}/worklogs`,
    headers: {
      authorization: "[redacted]",
      "content-type": "application/json",
    },
    body: {
      date: entry.date,
      text: entry.text,
      sourceId: entry.id,
    },
  };
}

export interface NetdokTask {
  id: string;
  key: string;
  name: string;
  projectId: string;
  sprintId: string | null;
  statusId: string;
  estimate: number;
  remaining: number;
  reporterId?: string;
}

export interface NetdokWorklog {
  id: string;
  taskId: string;
  logAt: string;
  logTime: number;
  description: unknown;
}

export interface CreateTaskInput {
  projectId: string;
  statusId: string;
  sprintId?: string;
  name: string;
  estimate: number;
  remaining: number;
  priority: number;
  assigneeIds: string[];
  reporterId: string;
}

export interface CreateWorklogInput {
  taskId: string;
  logTime: number;
  logAt: string;
  text: string;
  profileId: string;
}

export interface NetdokClient {
  fetchTasksForProject(
    projectId: string,
    sprintId?: string,
  ): Promise<NetdokTask[]>;
  fetchWorklogsForTask(taskId: string): Promise<NetdokWorklog[]>;
  createTask(input: CreateTaskInput): Promise<NetdokTask>;
  createWorklog(input: CreateWorklogInput): Promise<NetdokWorklog>;
  fetchMe(): Promise<NetdokMeSummary>;
  fetchProjects(): Promise<NetdokProjectSummary[]>;
  fetchProjectDetails(projectId: string): Promise<NetdokProjectDetails>;
  fetchWorkspaces(authBaseUrl?: string): Promise<NetdokWorkspaceSummary[]>;
}

export type FetchLike = typeof fetch;

export function buildWorklogDescription(text: string): unknown {
  const lines = text.split("\n");
  return {
    type: "doc",
    content: lines.map((line) => {
      const content = line.length > 0 ? [{ type: "text", text: line }] : [];
      return { type: "paragraph", content };
    }),
  };
}

export function extractWorklogPlainText(description: unknown): string {
  if (!isObject(description)) return "";
  const content = (description as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    const inner = (block as { content?: unknown }).content;
    if (!Array.isArray(inner)) {
      lines.push("");
      continue;
    }
    const parts: string[] = [];
    for (const node of inner) {
      if (
        isObject(node) &&
        typeof (node as { text?: unknown }).text === "string"
      ) {
        parts.push((node as { text: string }).text);
      }
    }
    lines.push(parts.join(""));
  }
  return lines.join("\n");
}

export function createNetdokClient(
  config: LogWorksConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): NetdokClient {
  const netdok = config.netdok;
  if (!netdok?.apiKey) {
    throw new AppError("config-missing", "Missing netdok.apiKey");
  }

  const baseUrl =
    (netdok.baseUrl ?? "https://api.netdok.co").replace(/\/$/, "") || "";
  const authBaseUrl =
    (netdok.authBaseUrl ?? "https://auth.netdok.co").replace(/\/$/, "") || "";
  const apiKey = netdok.apiKey;
  const workspaceId = netdok.workspaceId;

  function buildHeaders(includeWorkspace: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "x-api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
    };
    if (includeWorkspace) {
      if (!workspaceId) {
        throw new AppError("config-missing", "Missing netdok.workspaceId");
      }
      headers["workspace-id"] = workspaceId;
    }
    return headers;
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { baseUrlOverride?: string; omitWorkspace?: boolean } = {},
  ): Promise<T> {
    const root = options.baseUrlOverride ?? baseUrl;
    const url = `${root}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: buildHeaders(!options.omitWorkspace),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new AppError(
        "netdok-http",
        `${method} ${path} → network error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new AppError(
        "netdok-http",
        `${method} ${path} → ${response.status} ${text}`.trim(),
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  return {
    async fetchTasksForProject(projectId, sprintId) {
      const params = new URLSearchParams({
        projectId,
        sortBy: "createdAt",
        sortDesc: "false",
        customSort: "",
      });
      if (sprintId) params.set("sprintId", sprintId);
      const data = await request<{ total: number; data: NetdokTask[] }>(
        "GET",
        `/tasks?${params.toString()}`,
      );
      return data.data ?? [];
    },

    async fetchWorklogsForTask(taskId) {
      const out: NetdokWorklog[] = [];
      const take = 100;
      let skip = 0;
      while (true) {
        const params = new URLSearchParams({
          take: String(take),
          sortDesc: "true",
          skip: String(skip),
        });
        const page = await request<
          { total?: number; data?: NetdokWorklog[] } | NetdokWorklog[]
        >("GET", `/worklogs/tasks/${taskId}?${params.toString()}`);
        const rows = Array.isArray(page) ? page : (page.data ?? []);
        out.push(...rows);
        if (rows.length < take) break;
        skip += rows.length;
      }
      return out;
    },

    async createTask(input) {
      return request<NetdokTask>("POST", "/tasks", {
        projectId: input.projectId,
        statusId: input.statusId,
        sprintId: input.sprintId,
        name: input.name,
        estimate: input.estimate,
        remaining: input.remaining,
        priority: input.priority,
        type: "TASK",
        attachments: [],
        description: {},
        assigneeIds: input.assigneeIds,
        reporterId: input.reporterId,
        defaultCustomTabs: [],
        defaultFields: [],
      });
    },

    async createWorklog(input) {
      return request<NetdokWorklog>("POST", "/worklogs", {
        taskId: input.taskId,
        logTime: input.logTime,
        logAt: input.logAt,
        description: buildWorklogDescription(input.text),
        profileId: input.profileId,
      });
    },

    async fetchMe(): Promise<NetdokMeSummary> {
      const me = await request<{
        id: string;
        displayName?: string;
        fullName?: string;
        workspaceId: string;
        tz?: string;
      }>("GET", "/profiles/me");
      return {
        profileId: me.id,
        displayName: me.displayName ?? me.fullName ?? "",
        workspaceId: me.workspaceId,
        tz: me.tz ?? "",
      };
    },

    async fetchProjects(): Promise<NetdokProjectSummary[]> {
      const params = new URLSearchParams({
        skip: "0",
        take: "100",
        sortBy: "createdAt",
        sortDesc: "true",
        search: "",
      });
      const data = await request<{
        data: Array<{
          id: string;
          name: string;
          key: string;
          workspaceId: string;
        }>;
      }>("GET", `/projects?${params.toString()}`);
      return (data.data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        workspaceId: p.workspaceId,
      }));
    },

    async fetchProjectDetails(projectId): Promise<NetdokProjectDetails> {
      const project = await request<{
        id: string;
        name: string;
        key: string;
        statuses?: Array<{
          id: string;
          name: string;
          type: string;
          tasks?: Array<{ sprintId?: string | null }>;
        }>;
      }>("GET", `/projects/${projectId}`);
      const statuses: NetdokStatusSummary[] = (project.statuses ?? []).map(
        (s) => ({ id: s.id, name: s.name, type: s.type }),
      );
      const sprintCounts = new Map<string, number>();
      for (const status of project.statuses ?? []) {
        for (const task of status.tasks ?? []) {
          if (!task.sprintId) continue;
          sprintCounts.set(
            task.sprintId,
            (sprintCounts.get(task.sprintId) ?? 0) + 1,
          );
        }
      }
      const sprintIds = [...sprintCounts.keys()];
      const suggestedSprintId =
        sprintIds.length === 0
          ? undefined
          : [...sprintCounts.entries()].sort(([, a], [, b]) => b - a)[0]?.[0];
      const suggestedStatusId =
        statuses.find((s) => s.type === "INPROGRESS")?.id ?? statuses[0]?.id;
      return {
        id: project.id,
        name: project.name,
        key: project.key,
        statuses,
        sprintIds,
        suggestedStatusId,
        suggestedSprintId,
      };
    },

    async fetchWorkspaces(
      authBaseUrlOverride?: string,
    ): Promise<NetdokWorkspaceSummary[]> {
      const root = authBaseUrlOverride
        ? authBaseUrlOverride.replace(/\/$/, "")
        : authBaseUrl;
      const params = new URLSearchParams({ sortBy: "name", sortDesc: "asc" });
      const data = await request<{
        data: Array<{ id: string; name: string; apiUrl?: string }>;
      }>("GET", `/workspaces?${params.toString()}`, undefined, {
        baseUrlOverride: root,
        omitWorkspace: true,
      });
      return (data.data ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        apiUrl: w.apiUrl,
      }));
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
