import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/errors.ts";
import {
  clearNetdokData,
  deriveWorkLogsFromRawMessages,
  emptyDatabase,
  filterMessagesByAuthor,
  rawMessageFromSlackFixture,
  readDatabase,
  resetDatabase,
  updateWorkLogStatus,
  upsertRawMessages,
  writeDatabase,
} from "../src/services/storage.service.ts";
import type { SlackFixtureMessage } from "../src/types/index.ts";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-storage-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("storage service", () => {
  test("returns an empty database when the storage file does not exist", async () => {
    const dir = await makeTempDir();

    expect(await readDatabase(join(dir, "db.json"))).toEqual(emptyDatabase());
  });

  test("writes human-readable JSON", async () => {
    const dir = await makeTempDir();
    const dbPath = join(dir, "db.json");

    await writeDatabase(dbPath, emptyDatabase());

    expect(await readFile(dbPath, "utf8")).toBe(
      `${JSON.stringify(emptyDatabase(), null, 2)}\n`,
    );
  });

  test("upserts raw Slack messages idempotently by ts", async () => {
    const fixture = JSON.parse(
      await readFile("fixtures/slack/messages.basic.json", "utf8"),
    ) as SlackFixtureMessage[];
    const messages = filterMessagesByAuthor(fixture, "U123LOG").map((message) =>
      rawMessageFromSlackFixture(message, "2026-05-20T12:00:00.000Z"),
    );

    const first = upsertRawMessages(emptyDatabase(), messages);
    const second = upsertRawMessages(first.database, messages);

    expect(first.inserted).toBe(2);
    expect(first.skipped).toBe(0);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.database.rawMessages).toHaveLength(2);
  });

  test("derives deterministic work-log ids from a debrief message", () => {
    const raw = rawMessageFromSlackFixture(
      {
        type: "message",
        channel: "CWORKLOG",
        user: "U123LOG",
        ts: "1716200000.000100",
        text: "Debrief:\nMetabase:\n• Built pipeline [2h]\nVenulog\n• Fixed bug [1h]",
      },
      "2026-05-20T12:00:00.000Z",
    );
    const withRaw = upsertRawMessages(emptyDatabase(), [raw]).database;

    const result = deriveWorkLogsFromRawMessages(withRaw, () => "2026-05-20");

    expect(result.database.workLogs.map((entry) => entry.id)).toEqual([
      "1716200000.000100#0",
      "1716200000.000100#1",
    ]);
    expect(result.database.workLogs).toMatchObject([
      {
        project: "Metabase",
        text: "Built pipeline",
        hours: 2,
        status: "pending",
      },
      {
        project: "Venulog",
        text: "Fixed bug",
        hours: 1,
        status: "pending",
      },
    ]);
  });

  test("updates work-log status without mutating the original database", () => {
    const database = {
      ...emptyDatabase(),
      workLogs: [
        {
          id: "1716200000.000100#0",
          sourceTs: "1716200000.000100",
          date: "2026-05-20",
          project: "log-works",
          text: "Implemented Slack fetch foundation",
          hours: 2,
          status: "pending" as const,
        },
      ],
    };

    const updated = updateWorkLogStatus(
      database,
      "1716200000.000100#0",
      "sent",
      {
        postedAt: "2026-05-20T12:30:00.000Z",
      },
    );

    expect(database.workLogs[0]?.status).toBe("pending");
    expect(updated.workLogs[0]).toMatchObject({
      status: "sent",
      postedAt: "2026-05-20T12:30:00.000Z",
    });
  });

  test("clears only local Netdok sync state within the selected range", () => {
    const database = {
      rawMessages: [
        {
          ts: "1716200000.000100",
          channel: "CWORKLOG",
          userId: "U123LOG",
          text: "Debrief",
          raw: {},
          fetchedAt: "2026-05-20T12:00:00.000Z",
        },
      ],
      workLogs: [
        {
          id: "entry-1",
          sourceTs: "1716200000.000100",
          date: "2026-05-20",
          project: "log-works",
          text: "Posted already",
          hours: 1,
          status: "sent" as const,
          postedAt: "2026-05-20T12:30:00.000Z",
          postedTaskId: "task-1",
          postedWorklogId: "wl-1",
        },
        {
          id: "entry-2",
          sourceTs: "1716113600.000100",
          date: "2026-05-19",
          project: "log-works",
          text: "Failed once",
          hours: 1,
          status: "failed" as const,
          lastError: "boom",
        },
        {
          id: "entry-3",
          sourceTs: "1715595200.000100",
          date: "2026-05-13",
          project: "log-works",
          text: "Outside range",
          hours: 1,
          status: "sent" as const,
          postedTaskId: "task-old",
        },
      ],
      netdokWeekTasks: [
        {
          id: "project-1#log-works#2026-05-19",
          project: "log-works",
          projectId: "project-1",
          weekStart: "2026-05-19",
          weekEnd: "2026-05-25",
          taskId: "task-1",
          taskName: "[log-works] Task issues from 2026-05-19 to 2026-05-25",
          createdAt: "2026-05-20T12:00:00.000Z",
        },
        {
          id: "project-1#log-works#2026-05-12",
          project: "log-works",
          projectId: "project-1",
          weekStart: "2026-05-12",
          weekEnd: "2026-05-18",
          taskId: "task-old",
          taskName: "[log-works] Task issues from 2026-05-12 to 2026-05-18",
          createdAt: "2026-05-13T12:00:00.000Z",
        },
      ],
      meta: {
        lastFetchAt: "2026-05-20T12:00:00.000Z",
      },
    };

    const result = clearNetdokData(database, {
      from: "2026-05-19",
      to: "2026-05-25",
    });

    expect(result.clearedWeekTasks).toBe(1);
    expect(result.resetEntries).toBe(2);
    expect(database.netdokWeekTasks).toHaveLength(2);
    expect(result.database.netdokWeekTasks).toHaveLength(1);
    expect(result.database.meta).toEqual(database.meta);
    expect(result.database.workLogs).toMatchObject([
      {
        id: "entry-1",
        status: "pending",
        postedAt: undefined,
        postedTaskId: undefined,
        postedWorklogId: undefined,
      },
      {
        id: "entry-2",
        status: "pending",
        lastError: undefined,
      },
      {
        id: "entry-3",
        status: "sent",
        postedTaskId: "task-old",
      },
    ]);
  });

  test("computes a full database reset summary", () => {
    const database = {
      rawMessages: [
        {
          ts: "1716200000.000100",
          channel: "CWORKLOG",
          userId: "U123LOG",
          text: "Debrief",
          raw: {},
          fetchedAt: "2026-05-20T12:00:00.000Z",
        },
      ],
      workLogs: [
        {
          id: "entry-1",
          sourceTs: "1716200000.000100",
          date: "2026-05-20",
          project: "log-works",
          text: "Posted already",
          hours: 1,
          status: "sent" as const,
        },
      ],
      netdokWeekTasks: [
        {
          id: "project-1#log-works#2026-05-19",
          project: "log-works",
          projectId: "project-1",
          weekStart: "2026-05-19",
          weekEnd: "2026-05-25",
          taskId: "task-1",
          taskName: "[log-works] Task issues from 2026-05-19 to 2026-05-25",
          createdAt: "2026-05-20T12:00:00.000Z",
        },
      ],
      meta: {
        lastFetchAt: "2026-05-20T12:00:00.000Z",
      },
    };

    const result = resetDatabase(database);

    expect(result.removedRawMessages).toBe(1);
    expect(result.removedWorkLogs).toBe(1);
    expect(result.removedNetdokWeekTasks).toBe(1);
    expect(result.clearedMeta).toBe(true);
    expect(result.database).toEqual(emptyDatabase());
  });

  test("throws typed corrupt-storage errors", async () => {
    const dir = await makeTempDir();
    const dbPath = join(dir, "db.json");
    await writeFile(dbPath, "{not json");

    await expect(readDatabase(dbPath)).rejects.toEqual(
      new AppError("storage-corrupt", `Storage file is corrupt: ${dbPath}`),
    );
  });
});
