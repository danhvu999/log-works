import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearNetdokStorage,
  resetStorage,
} from "../src/services/storage-admin.service.ts";
import {
  emptyDatabase,
  readDatabase,
  writeDatabase,
} from "../src/services/storage.service.ts";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-storage-admin-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("storage admin service", () => {
  test("previews local Netdok cleanup without mutating the database", async () => {
    const dir = await makeTempDir();
    const storagePath = join(dir, "db.json");
    const database = {
      ...emptyDatabase(),
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
    };
    await writeDatabase(storagePath, database);

    const result = await clearNetdokStorage({
      apply: false,
      config: { storage: { path: storagePath } },
    });

    expect(result).toMatchObject({
      clearedWeekTasks: 1,
      resetEntries: 1,
      applied: false,
      storagePath,
    });
    expect(await readDatabase(storagePath)).toEqual(database);
  });

  test("applies a full database reset when requested", async () => {
    const dir = await makeTempDir();
    const storagePath = join(dir, "db.json");
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
    await writeDatabase(storagePath, database);

    const result = await resetStorage({
      apply: true,
      config: { storage: { path: storagePath } },
    });

    expect(result).toMatchObject({
      removedRawMessages: 1,
      removedWorkLogs: 1,
      removedNetdokWeekTasks: 1,
      clearedMeta: true,
      applied: true,
      storagePath,
    });
    expect(await readDatabase(storagePath)).toEqual(emptyDatabase());
  });
});
