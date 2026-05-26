import { loadConfig, resolveStoragePath } from "../config/config.manager.ts";
import { AppError } from "../errors.ts";
import type {
  LogWorksConfig,
  NetdokWorklogSyncEntry,
  NetdokWorklogSyncResult,
  WorkLogEntry,
} from "../types/index.ts";
import { isoWeekRange } from "../utils/iso-week.ts";
import { netdokTaskUrl } from "./netdok-url.ts";
import {
  type NetdokClient,
  type NetdokWorklog,
  createNetdokClient,
  extractWorklogPlainText,
} from "./netdok.service.ts";
import { readDatabase, writeDatabase } from "./storage.service.ts";

export interface SyncWorklogsOptions {
  from?: string;
  to?: string;
  apply?: boolean;
  config?: LogWorksConfig;
  client?: NetdokClient;
  now?: Date;
}

const WORKLOG_HOUR_OF_DAY_UTC = 9;

export async function syncNetdokWorklogs(
  options: SyncWorklogsOptions = {},
): Promise<NetdokWorklogSyncResult> {
  const config = options.config ?? (await loadConfig());
  const storagePath = resolveStoragePath(config);
  const database = await readDatabase(storagePath);

  const profileId = config.netdok?.profileId;
  if (options.apply && !profileId) {
    throw new AppError("config-missing", "Missing netdok.profileId");
  }

  const projects = config.netdok?.projects ?? {};
  const filtered = database.workLogs.filter((entry) => {
    if (options.from && entry.date < options.from) return false;
    if (options.to && entry.date > options.to) return false;
    return true;
  });

  const candidates: Array<{
    entry: WorkLogEntry;
    taskId: string;
    projectId: string;
    weekStart: string;
  }> = [];
  const entries: NetdokWorklogSyncEntry[] = [];

  for (const entry of filtered) {
    if (entry.status === "sent") {
      entries.push({
        entryId: entry.id,
        date: entry.date,
        project: entry.project,
        text: entry.text,
        hours: entry.hours,
        status: "skipped-already-sent",
        worklogId: entry.postedWorklogId,
        taskId: entry.postedTaskId,
      });
      continue;
    }
    const mapping = projects[entry.project];
    if (!mapping) {
      entries.push({
        entryId: entry.id,
        date: entry.date,
        project: entry.project,
        text: entry.text,
        hours: entry.hours,
        status: "skipped-no-project",
        reason: `no netdok.projects entry for "${entry.project}"`,
      });
      continue;
    }
    if (entry.hours == null) {
      entries.push({
        entryId: entry.id,
        date: entry.date,
        project: entry.project,
        text: entry.text,
        hours: entry.hours,
        status: "skipped-no-hours",
        reason: "entry has no [Nh] hours token",
      });
      continue;
    }
    const { weekStart } = isoWeekRange(entry.date);
    let taskId: string | undefined = mapping.pinnedTaskId;
    if (!taskId) {
      const wrapper = database.netdokWeekTasks.find(
        (row) =>
          row.id === `${mapping.projectId}#${entry.project}#${weekStart}`,
      );
      taskId = wrapper?.taskId;
    }
    if (!taskId) {
      entries.push({
        entryId: entry.id,
        date: entry.date,
        project: entry.project,
        text: entry.text,
        hours: entry.hours,
        status: "skipped-no-task",
        reason: "run 'netdok tasks --apply' first",
      });
      continue;
    }
    candidates.push({
      entry,
      taskId,
      projectId: mapping.projectId,
      weekStart,
    });
  }

  let client = options.client;
  if (!client && candidates.length > 0) {
    client = createNetdokClient(config);
  }

  const remoteByTask = new Map<string, NetdokWorklog[]>();
  const uniqueTaskIds = [...new Set(candidates.map((c) => c.taskId))];
  if (client) {
    for (const taskId of uniqueTaskIds) {
      const remote = await client.fetchWorklogsForTask(taskId);
      remoteByTask.set(taskId, remote);
    }
  }

  const remoteFingerprints = new Map<string, Set<string>>();
  for (const [taskId, list] of remoteByTask.entries()) {
    const set = new Set<string>();
    for (const log of list) {
      set.add(
        worklogFingerprint(log.logAt, extractWorklogPlainText(log.description)),
      );
    }
    remoteFingerprints.set(taskId, set);
  }

  let mutated = database;

  for (const candidate of candidates) {
    const { entry, taskId } = candidate;
    const logAt = buildLogAt(entry.date);
    const fingerprint = worklogFingerprint(logAt, entry.text);
    const remote = remoteFingerprints.get(taskId);
    if (remote?.has(fingerprint)) {
      entries.push({
        entryId: entry.id,
        date: entry.date,
        project: entry.project,
        text: entry.text,
        hours: entry.hours,
        taskId,
        status: "skipped-duplicate-remote",
        reason: "matching worklog already exists in Netdok",
      });
      continue;
    }
    if (!options.apply) {
      entries.push({
        entryId: entry.id,
        date: entry.date,
        project: entry.project,
        text: entry.text,
        hours: entry.hours,
        taskId,
        status: "would-post",
      });
      continue;
    }
    if (!client) {
      throw new AppError(
        "config-missing",
        "Netdok client unavailable for --apply",
      );
    }
    if (!profileId) {
      throw new AppError("config-missing", "Missing netdok.profileId");
    }
    try {
      const logTime = Math.round((entry.hours as number) * 3600);
      const created = await client.createWorklog({
        taskId,
        logAt,
        logTime,
        text: entry.text,
        profileId,
      });
      const next = structuredClone(mutated);
      const row = next.workLogs.find((r) => r.id === entry.id);
      if (row) {
        row.status = "sent";
        row.postedAt = (options.now ?? new Date()).toISOString();
        row.postedTaskId = taskId;
        row.postedWorklogId = created.id;
        row.lastError = undefined;
      }
      mutated = next;
      remote?.add(fingerprint);
      entries.push({
        entryId: entry.id,
        date: entry.date,
        project: entry.project,
        text: entry.text,
        hours: entry.hours,
        taskId,
        status: "posted",
        worklogId: created.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const next = structuredClone(mutated);
      const row = next.workLogs.find((r) => r.id === entry.id);
      if (row) {
        row.status = "failed";
        row.lastError = message;
      }
      mutated = next;
      entries.push({
        entryId: entry.id,
        date: entry.date,
        project: entry.project,
        text: entry.text,
        hours: entry.hours,
        taskId,
        status: "failed",
        reason: message,
      });
    }
  }

  if (options.apply) {
    await writeDatabase(storagePath, mutated);
  }

  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.project !== b.project) return a.project.localeCompare(b.project);
    return a.entryId.localeCompare(b.entryId);
  });

  const enrichedEntries = entries.map((row) => {
    const projectId = projects[row.project]?.projectId;
    if (!projectId) return row;
    const taskUrl = netdokTaskUrl(config, projectId, row.taskId);
    return {
      ...row,
      projectId,
      ...(taskUrl ? { taskUrl } : {}),
    };
  });

  return {
    entries: enrichedEntries,
    applied: Boolean(options.apply),
    storagePath,
    from: options.from,
    to: options.to,
  };
}

export function buildLogAt(date: string): string {
  return `${date}T${String(WORKLOG_HOUR_OF_DAY_UTC).padStart(2, "0")}:00:00.000Z`;
}

function worklogFingerprint(logAt: string, text: string): string {
  const day = logAt.slice(0, 10);
  return `${day}|${text.trim()}`;
}
