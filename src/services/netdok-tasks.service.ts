import { loadConfig, resolveStoragePath } from "../config/config.manager.ts";
import { AppError } from "../errors.ts";
import type {
  LogWorksConfig,
  NetdokPinnedTaskEntry,
  NetdokTaskSyncEntry,
  NetdokTaskSyncResult,
  NetdokWeekTask,
  WorkLogEntry,
} from "../types/index.ts";
import { isoWeekRange, isoWeekTaskName } from "../utils/iso-week.ts";
import { netdokTaskUrl } from "./netdok-url.ts";
import { type NetdokClient, createNetdokClient } from "./netdok.service.ts";
import {
  readDatabase,
  upsertNetdokWeekTask,
  writeDatabase,
} from "./storage.service.ts";

const WRAPPER_TASK_ESTIMATE_SECONDS = 28800; // 8h placeholder for weekly wrapper task
const WRAPPER_TASK_PRIORITY = 0;

export interface SyncTasksOptions {
  from?: string;
  to?: string;
  apply?: boolean;
  config?: LogWorksConfig;
  client?: NetdokClient;
  now?: Date;
}

interface GroupKey {
  project: string;
  weekStart: string;
  weekEnd: string;
}

export async function syncNetdokTasks(
  options: SyncTasksOptions = {},
): Promise<NetdokTaskSyncResult> {
  const config = options.config ?? (await loadConfig());
  const storagePath = resolveStoragePath(config);
  const database = await readDatabase(storagePath);

  const projects = config.netdok?.projects ?? {};
  const filtered = database.workLogs.filter((entry) => {
    if (options.from && entry.date < options.from) return false;
    if (options.to && entry.date > options.to) return false;
    return true;
  });

  const unmappedCounts = new Map<string, number>();
  const pinnedSlots = new Map<string, NetdokPinnedTaskEntry>();
  const groups = new Map<string, { key: GroupKey; entries: WorkLogEntry[] }>();
  for (const entry of filtered) {
    const mapping = projects[entry.project];
    if (!mapping) {
      unmappedCounts.set(
        entry.project,
        (unmappedCounts.get(entry.project) ?? 0) + 1,
      );
      continue;
    }
    if (mapping.pinnedTaskId) {
      const slot = pinnedSlots.get(entry.project) ?? {
        project: entry.project,
        projectId: mapping.projectId,
        pinnedTaskId: mapping.pinnedTaskId,
        entries: 0,
      };
      slot.entries += 1;
      pinnedSlots.set(entry.project, slot);
      continue;
    }
    const { weekStart, weekEnd } = isoWeekRange(entry.date);
    const key = `${mapping.projectId}#${entry.project}#${weekStart}`;
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      groups.set(key, {
        key: { project: entry.project, weekStart, weekEnd },
        entries: [entry],
      });
    }
  }

  if (options.apply && unmappedCounts.size > 0) {
    const names = [...unmappedCounts.keys()].sort().join(", ");
    throw new AppError(
      "netdok-project-unmapped",
      `Missing netdok.projects entry for: ${names}`,
    );
  }

  const client =
    options.client ?? (groups.size > 0 ? createNetdokClient(config) : null);

  const reporterId = config.netdok?.reporterId;
  if (client && groups.size > 0 && !reporterId) {
    throw new AppError("config-missing", "Missing netdok.reporterId");
  }

  type RemoteTaskSummary = {
    id: string;
    name: string;
    key: string;
    reporterId?: string;
  };
  const remoteCache = new Map<string, Promise<RemoteTaskSummary[]>>();
  const fetchRemoteTasks = async (
    projectId: string,
    sprintId: string | undefined,
  ): Promise<RemoteTaskSummary[]> => {
    if (!client) return [];
    const cacheKey = `${projectId}#${sprintId ?? ""}`;
    let pending = remoteCache.get(cacheKey);
    if (!pending) {
      pending = client.fetchTasksForProject(projectId, sprintId).then((tasks) =>
        tasks.map((t) => ({
          id: t.id,
          name: t.name,
          key: t.key,
          reporterId: t.reporterId,
        })),
      );
      remoteCache.set(cacheKey, pending);
    }
    return pending;
  };

  let mutated = database;
  const weeks: NetdokTaskSyncEntry[] = [];

  for (const [, group] of [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const mapping = projects[group.key.project];
    if (!mapping) continue;
    const expectedTaskName = isoWeekTaskName(
      group.key.weekStart,
      group.key.project,
    );
    const localId = `${mapping.projectId}#${group.key.project}#${group.key.weekStart}`;
    const local = mutated.netdokWeekTasks.find((row) => row.id === localId);

    if (local) {
      weeks.push({
        project: group.key.project,
        projectId: mapping.projectId,
        weekStart: group.key.weekStart,
        weekEnd: group.key.weekEnd,
        expectedTaskName,
        status: "existing-local",
        taskId: local.taskId,
        taskKey: local.taskKey,
      });
      continue;
    }

    if (!mapping.sprintId) {
      throw new AppError(
        "config-missing",
        `Missing netdok.projects.${group.key.project}.sprintId`,
      );
    }
    if (!mapping.statusId) {
      throw new AppError(
        "config-missing",
        `Missing netdok.projects.${group.key.project}.statusId`,
      );
    }
    const sprintId = mapping.sprintId;
    const remoteTasks = await fetchRemoteTasks(mapping.projectId, sprintId);
    const remoteMatch = remoteTasks.find(
      (t) => t.name === expectedTaskName && t.reporterId === reporterId,
    );

    if (remoteMatch) {
      const record: NetdokWeekTask = {
        id: localId,
        project: group.key.project,
        projectId: mapping.projectId,
        weekStart: group.key.weekStart,
        weekEnd: group.key.weekEnd,
        taskId: remoteMatch.id,
        taskKey: remoteMatch.key,
        taskName: remoteMatch.name,
        createdAt: (options.now ?? new Date()).toISOString(),
      };
      if (options.apply) {
        mutated = upsertNetdokWeekTask(mutated, record);
      }
      weeks.push({
        project: group.key.project,
        projectId: mapping.projectId,
        weekStart: group.key.weekStart,
        weekEnd: group.key.weekEnd,
        expectedTaskName,
        status: "existing-remote",
        taskId: remoteMatch.id,
        taskKey: remoteMatch.key,
      });
      continue;
    }

    if (!options.apply) {
      weeks.push({
        project: group.key.project,
        projectId: mapping.projectId,
        weekStart: group.key.weekStart,
        weekEnd: group.key.weekEnd,
        expectedTaskName,
        status: "would-create",
      });
      continue;
    }

    if (!client) {
      throw new AppError(
        "config-missing",
        "Netdok client unavailable for --apply",
      );
    }

    if (!reporterId) {
      throw new AppError("config-missing", "Missing netdok.reporterId");
    }

    const created = await client.createTask({
      projectId: mapping.projectId,
      statusId: mapping.statusId,
      sprintId,
      name: expectedTaskName,
      estimate: WRAPPER_TASK_ESTIMATE_SECONDS,
      remaining: WRAPPER_TASK_ESTIMATE_SECONDS,
      priority: WRAPPER_TASK_PRIORITY,
      assigneeIds: mapping.assigneeIds ?? [reporterId],
      reporterId,
    });

    const record: NetdokWeekTask = {
      id: localId,
      project: group.key.project,
      projectId: mapping.projectId,
      weekStart: group.key.weekStart,
      weekEnd: group.key.weekEnd,
      taskId: created.id,
      taskKey: created.key,
      taskName: created.name,
      createdAt: (options.now ?? new Date()).toISOString(),
    };
    mutated = upsertNetdokWeekTask(mutated, record);

    weeks.push({
      project: group.key.project,
      projectId: mapping.projectId,
      weekStart: group.key.weekStart,
      weekEnd: group.key.weekEnd,
      expectedTaskName,
      status: "created",
      taskId: created.id,
      taskKey: created.key,
    });
  }

  if (options.apply) {
    await writeDatabase(storagePath, mutated);
  }

  weeks.sort((a, b) => {
    if (a.weekStart !== b.weekStart)
      return a.weekStart.localeCompare(b.weekStart);
    return a.project.localeCompare(b.project);
  });

  const unmapped = [...unmappedCounts.entries()]
    .map(([project, entries]) => ({ project, entries }))
    .sort((a, b) => a.project.localeCompare(b.project));

  const pinned = [...pinnedSlots.values()].sort((a, b) =>
    a.project.localeCompare(b.project),
  );

  const weeksWithUrls = weeks.map((week) => {
    const taskUrl = netdokTaskUrl(config, week.projectId, week.taskId);
    return taskUrl ? { ...week, taskUrl } : week;
  });
  const pinnedWithUrls = pinned.map((slot) => {
    const taskUrl = netdokTaskUrl(config, slot.projectId, slot.pinnedTaskId);
    return taskUrl ? { ...slot, taskUrl } : slot;
  });

  return {
    weeks: weeksWithUrls,
    unmapped,
    pinned: pinnedWithUrls,
    applied: Boolean(options.apply),
    storagePath,
    from: options.from,
    to: options.to,
  };
}
