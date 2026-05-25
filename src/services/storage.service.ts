import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError } from "../errors.ts";
import type {
  Database,
  NetdokWeekTask,
  RawSlackMessage,
  SlackFixtureMessage,
  WorkLogStatus,
} from "../types/index.ts";
import { parseMessageText } from "./parser.service.ts";

export function emptyDatabase(): Database {
  return {
    rawMessages: [],
    workLogs: [],
    netdokWeekTasks: [],
    meta: {},
  };
}

export async function readDatabase(path: string): Promise<Database> {
  try {
    const parsed = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<Database>;
    return {
      rawMessages: parsed.rawMessages ?? [],
      workLogs: parsed.workLogs ?? [],
      netdokWeekTasks: parsed.netdokWeekTasks ?? [],
      meta: parsed.meta ?? {},
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyDatabase();
    }
    throw new AppError("storage-corrupt", `Storage file is corrupt: ${path}`);
  }
}

export async function writeDatabase(
  path: string,
  database: Database,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(database, null, 2)}\n`);
}

export function clearNetdokData(
  database: Database,
  range: { from?: string; to?: string } = {},
): { database: Database; clearedWeekTasks: number; resetEntries: number } {
  const next: Database = structuredClone(database);

  const keptTasks: NetdokWeekTask[] = [];
  let clearedWeekTasks = 0;

  for (const task of next.netdokWeekTasks) {
    if (range.from && task.weekEnd < range.from) {
      keptTasks.push(task);
      continue;
    }
    if (range.to && task.weekStart > range.to) {
      keptTasks.push(task);
      continue;
    }
    clearedWeekTasks += 1;
  }

  next.netdokWeekTasks = keptTasks;

  let resetEntries = 0;
  for (const entry of next.workLogs) {
    if (range.from && entry.date < range.from) continue;
    if (range.to && entry.date > range.to) continue;

    const hadNetdokState =
      entry.status !== "pending" ||
      entry.lastError !== undefined ||
      entry.postedAt !== undefined ||
      entry.postedTaskId !== undefined ||
      entry.postedWorklogId !== undefined;

    if (!hadNetdokState) continue;

    entry.status = "pending";
    entry.lastError = undefined;
    entry.postedAt = undefined;
    entry.postedTaskId = undefined;
    entry.postedWorklogId = undefined;
    resetEntries += 1;
  }

  return { database: next, clearedWeekTasks, resetEntries };
}

export function resetDatabase(database: Database): {
  database: Database;
  removedRawMessages: number;
  removedWorkLogs: number;
  removedNetdokWeekTasks: number;
  clearedMeta: boolean;
} {
  return {
    database: emptyDatabase(),
    removedRawMessages: database.rawMessages.length,
    removedWorkLogs: database.workLogs.length,
    removedNetdokWeekTasks: database.netdokWeekTasks.length,
    clearedMeta: Object.keys(database.meta).length > 0,
  };
}

export function upsertRawMessages(
  database: Database,
  messages: RawSlackMessage[],
): { database: Database; inserted: number; skipped: number } {
  const next: Database = structuredClone(database);
  const existing = new Set(next.rawMessages.map((message) => message.ts));
  let inserted = 0;
  let skipped = 0;

  for (const message of messages) {
    if (existing.has(message.ts)) {
      skipped += 1;
      continue;
    }
    next.rawMessages.push(message);
    existing.add(message.ts);
    inserted += 1;
  }

  return { database: next, inserted, skipped };
}

export function deriveWorkLogsFromRawMessages(
  database: Database,
  dateForMessage: (message: RawSlackMessage) => string,
): { database: Database; inserted: number; skipped: number } {
  const next: Database = structuredClone(database);
  const existing = new Set(next.workLogs.map((entry) => entry.id));
  let inserted = 0;
  let skipped = 0;

  for (const message of next.rawMessages) {
    for (const parsed of parseMessageText(message.text)) {
      const id = `${message.ts}#${parsed.index}`;
      if (existing.has(id)) {
        skipped += 1;
        continue;
      }
      next.workLogs.push({
        id,
        sourceTs: message.ts,
        date: dateForMessage(message),
        project: parsed.project,
        text: parsed.text,
        hours: parsed.hours,
        status: "pending",
        source: "rule",
      });
      existing.add(id);
      inserted += 1;
    }
  }

  return { database: next, inserted, skipped };
}

export function updateWorkLogStatus(
  database: Database,
  id: string,
  status: WorkLogStatus,
  details: { lastError?: string; postedAt?: string } = {},
): Database {
  const next: Database = structuredClone(database);
  const entry = next.workLogs.find((workLog) => workLog.id === id);
  if (!entry) {
    return next;
  }

  entry.status = status;
  entry.lastError = details.lastError;
  entry.postedAt = details.postedAt;
  return next;
}

export function rawMessageFromSlackFixture(
  message: SlackFixtureMessage,
  fetchedAt: string,
): RawSlackMessage {
  return {
    ts: message.ts,
    channel: message.channel,
    userId: message.user,
    text: message.text,
    raw: message,
    fetchedAt,
  };
}

export function filterMessagesByAuthor(
  messages: SlackFixtureMessage[],
  userId: string,
): SlackFixtureMessage[] {
  return messages.filter((message) => message.user === userId);
}

export function upsertNetdokWeekTask(
  database: Database,
  task: NetdokWeekTask,
): Database {
  const next: Database = structuredClone(database);
  const existing = next.netdokWeekTasks.findIndex((row) => row.id === task.id);
  if (existing >= 0) {
    next.netdokWeekTasks[existing] = task;
  } else {
    next.netdokWeekTasks.push(task);
  }
  return next;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
