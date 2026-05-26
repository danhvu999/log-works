import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncNetdokWorklogs } from "../src/services/netdok-worklogs.service.ts";
import type {
  CreateTaskInput,
  CreateWorklogInput,
  NetdokClient,
  NetdokTask,
  NetdokWorklog,
} from "../src/services/netdok.service.ts";
import { buildWorklogDescription } from "../src/services/netdok.service.ts";
import {
  emptyDatabase,
  writeDatabase,
} from "../src/services/storage.service.ts";
import type {
  Database,
  LogWorksConfig,
  WorkLogEntry,
} from "../src/types/index.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

interface FakeState {
  createdWorklogs: CreateWorklogInput[];
  remoteByTask: Map<string, NetdokWorklog[]>;
  fetchWorklogCalls: number;
  createTaskCalls: number;
  fetchTaskCalls: number;
  failNext?: boolean;
}

function makeFakeClient(state: FakeState): NetdokClient {
  return {
    async fetchTasksForProject(): Promise<NetdokTask[]> {
      state.fetchTaskCalls += 1;
      return [];
    },
    async fetchWorklogsForTask(taskId): Promise<NetdokWorklog[]> {
      state.fetchWorklogCalls += 1;
      return state.remoteByTask.get(taskId) ?? [];
    },
    async createTask(_input: CreateTaskInput): Promise<NetdokTask> {
      state.createTaskCalls += 1;
      throw new Error("createTask not used in worklog tests");
    },
    async createWorklog(input): Promise<NetdokWorklog> {
      if (state.failNext) {
        state.failNext = false;
        throw new Error("simulated 500");
      }
      state.createdWorklogs.push(input);
      const id = `worklog-${state.createdWorklogs.length}`;
      const log: NetdokWorklog = {
        id,
        taskId: input.taskId,
        logAt: input.logAt,
        logTime: input.logTime,
        description: buildWorklogDescription(input.text),
      };
      const list = state.remoteByTask.get(input.taskId) ?? [];
      list.push(log);
      state.remoteByTask.set(input.taskId, list);
      return log;
    },
    async fetchMe() {
      throw new Error("fetchMe not used in worklog tests");
    },
    async fetchProjects() {
      throw new Error("fetchProjects not used in worklog tests");
    },
    async fetchProjectDetails() {
      throw new Error("fetchProjectDetails not used in worklog tests");
    },
    async fetchWorkspaces() {
      throw new Error("fetchWorkspaces not used in worklog tests");
    },
  };
}

async function makeTempDb(database: Database): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-worklogs-"));
  const path = join(tempDir, "db.json");
  await writeDatabase(path, database);
  return path;
}

function entry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
  return {
    id: "e1#0",
    sourceTs: "1716200000.000001",
    date: "2026-05-21",
    project: "Venulog",
    text: "Fixed bug",
    hours: 1,
    status: "pending",
    ...overrides,
  };
}

const baseConfig: LogWorksConfig = {
  netdok: {
    baseUrl: "https://api.test",
    apiKey: "k",
    workspaceId: "w",
    profileId: "p",
    reporterId: "r",
    projects: {
      Venulog: {
        projectId: "proj-v",
        sprintId: "sprint-1",
        statusId: "status-1",
      },
    },
  },
};

function dbWithWrapper(entries: WorkLogEntry[]): Database {
  const db = emptyDatabase();
  db.workLogs.push(...entries);
  db.netdokWeekTasks.push({
    id: "proj-v#Venulog#2026-05-18",
    project: "Venulog",
    projectId: "proj-v",
    weekStart: "2026-05-18",
    weekEnd: "2026-05-24",
    taskId: "task-week-1",
    taskKey: "TP-7",
    taskName: "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
    createdAt: "2026-05-18T00:00:00.000Z",
  });
  return db;
}

describe("syncNetdokWorklogs", () => {
  test("preview reports would-post for pending entries", async () => {
    const path = await makeTempDb(
      dbWithWrapper([entry({ id: "e1#0", text: "Fixed bug" })]),
    );
    const state: FakeState = {
      createdWorklogs: [],
      remoteByTask: new Map(),
      fetchWorklogCalls: 0,
      createTaskCalls: 0,
      fetchTaskCalls: 0,
    };
    const result = await syncNetdokWorklogs({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient(state),
    });

    expect(result.applied).toBe(false);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      entryId: "e1#0",
      status: "would-post",
      taskId: "task-week-1",
    });
    expect(state.createdWorklogs).toEqual([]);

    const written = JSON.parse(await readFile(path, "utf8")) as Database;
    expect(written.workLogs[0]?.status).toBe("pending");
  });

  test("apply posts each entry, marks it sent, and persists posted ids", async () => {
    const path = await makeTempDb(
      dbWithWrapper([
        entry({ id: "e1#0" }),
        entry({ id: "e2#0", text: "Wrote tests", hours: 2 }),
      ]),
    );
    const state: FakeState = {
      createdWorklogs: [],
      remoteByTask: new Map(),
      fetchWorklogCalls: 0,
      createTaskCalls: 0,
      fetchTaskCalls: 0,
    };
    const now = new Date("2026-05-25T12:00:00.000Z");
    const result = await syncNetdokWorklogs({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient(state),
      apply: true,
      now,
    });

    expect(result.applied).toBe(true);
    expect(state.createdWorklogs).toHaveLength(2);
    expect(state.createdWorklogs[0]).toMatchObject({
      taskId: "task-week-1",
      logTime: 3600,
      logAt: "2026-05-21T09:00:00.000Z",
      profileId: "p",
      text: "Fixed bug",
    });
    expect(state.createdWorklogs[1]?.logTime).toBe(7200);

    const written = JSON.parse(await readFile(path, "utf8")) as Database;
    const e1 = written.workLogs.find((w) => w.id === "e1#0");
    expect(e1).toMatchObject({
      status: "sent",
      postedTaskId: "task-week-1",
      postedWorklogId: "worklog-1",
      postedAt: "2026-05-25T12:00:00.000Z",
    });
  });

  test("skipped-already-sent never re-posts entries", async () => {
    const path = await makeTempDb(
      dbWithWrapper([
        entry({
          id: "e1#0",
          status: "sent",
          postedTaskId: "task-week-1",
          postedWorklogId: "old-worklog",
        }),
      ]),
    );
    const state: FakeState = {
      createdWorklogs: [],
      remoteByTask: new Map(),
      fetchWorklogCalls: 0,
      createTaskCalls: 0,
      fetchTaskCalls: 0,
    };
    const result = await syncNetdokWorklogs({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient(state),
      apply: true,
    });

    expect(result.entries[0]?.status).toBe("skipped-already-sent");
    expect(result.entries[0]?.worklogId).toBe("old-worklog");
    expect(state.createdWorklogs).toEqual([]);
  });

  test("skipped-no-task when the weekly wrapper hasn't been created yet", async () => {
    const db = emptyDatabase();
    db.workLogs.push(entry({ id: "e1#0", date: "2026-05-21" }));
    const path = await makeTempDb(db);
    const result = await syncNetdokWorklogs({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient({
        createdWorklogs: [],
        remoteByTask: new Map(),
        fetchWorklogCalls: 0,
        createTaskCalls: 0,
        fetchTaskCalls: 0,
      }),
    });

    expect(result.entries[0]?.status).toBe("skipped-no-task");
  });

  test("skipped-no-hours when hours is null", async () => {
    const path = await makeTempDb(
      dbWithWrapper([entry({ id: "e1#0", hours: null })]),
    );
    const result = await syncNetdokWorklogs({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient({
        createdWorklogs: [],
        remoteByTask: new Map(),
        fetchWorklogCalls: 0,
        createTaskCalls: 0,
        fetchTaskCalls: 0,
      }),
    });
    expect(result.entries[0]?.status).toBe("skipped-no-hours");
  });

  test("skipped-no-project when project is unmapped", async () => {
    const db = dbWithWrapper([entry({ id: "e1#0", project: "Dealer tool" })]);
    const path = await makeTempDb(db);
    const result = await syncNetdokWorklogs({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient({
        createdWorklogs: [],
        remoteByTask: new Map(),
        fetchWorklogCalls: 0,
        createTaskCalls: 0,
        fetchTaskCalls: 0,
      }),
    });
    expect(result.entries[0]?.status).toBe("skipped-no-project");
  });

  test("skipped-duplicate-remote when a matching worklog already exists in Netdok", async () => {
    const path = await makeTempDb(
      dbWithWrapper([entry({ id: "e1#0", text: "Fixed bug" })]),
    );
    const state: FakeState = {
      createdWorklogs: [],
      remoteByTask: new Map([
        [
          "task-week-1",
          [
            {
              id: "remote-1",
              taskId: "task-week-1",
              logAt: "2026-05-21T08:00:00.000Z",
              logTime: 3600,
              description: buildWorklogDescription("Fixed bug"),
            },
          ],
        ],
      ]),
      fetchWorklogCalls: 0,
      createTaskCalls: 0,
      fetchTaskCalls: 0,
    };
    const result = await syncNetdokWorklogs({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient(state),
      apply: true,
    });
    expect(result.entries[0]?.status).toBe("skipped-duplicate-remote");
    expect(state.createdWorklogs).toEqual([]);
  });

  test("apply marks entry failed on HTTP error and persists lastError", async () => {
    const path = await makeTempDb(dbWithWrapper([entry({ id: "e1#0" })]));
    const state: FakeState = {
      createdWorklogs: [],
      remoteByTask: new Map(),
      fetchWorklogCalls: 0,
      createTaskCalls: 0,
      fetchTaskCalls: 0,
      failNext: true,
    };
    const result = await syncNetdokWorklogs({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient(state),
      apply: true,
    });

    expect(result.entries[0]?.status).toBe("failed");
    const written = JSON.parse(await readFile(path, "utf8")) as Database;
    expect(written.workLogs[0]).toMatchObject({
      status: "failed",
      lastError: "simulated 500",
    });
  });

  test("pinned project posts under pinnedTaskId without a netdokWeekTask row", async () => {
    const db = emptyDatabase();
    db.workLogs.push(
      entry({
        id: "pin#0",
        date: "2026-05-21",
        project: "Loopengers",
        sourceTs: "1716200000.000099",
      }),
    );
    const path = await makeTempDb(db);

    const state: FakeState = {
      createdWorklogs: [],
      remoteByTask: new Map(),
      fetchWorklogCalls: 0,
      createTaskCalls: 0,
      fetchTaskCalls: 0,
    };

    const result = await syncNetdokWorklogs({
      config: {
        ...baseConfig,
        netdok: {
          ...baseConfig.netdok,
          projects: {
            ...baseConfig.netdok?.projects,
            Loopengers: {
              projectId: "proj-l",
              pinnedTaskId: "pinned-task-1",
            },
          },
        },
        storage: { path },
      },
      client: makeFakeClient(state),
      apply: true,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      status: "posted",
      taskId: "pinned-task-1",
      project: "Loopengers",
    });
    expect(state.createdWorklogs).toHaveLength(1);
    expect(state.createdWorklogs[0]?.taskId).toBe("pinned-task-1");

    const written = JSON.parse(await readFile(path, "utf8")) as Database;
    expect(written.netdokWeekTasks).toEqual([]);
    expect(written.workLogs[0]?.postedTaskId).toBe("pinned-task-1");
  });

  test("two pinned entries from different ISO weeks share the same pinnedTaskId", async () => {
    const db = emptyDatabase();
    db.workLogs.push(
      entry({
        id: "pin#0",
        date: "2026-05-18",
        project: "Loopengers",
        text: "Week A task",
      }),
      entry({
        id: "pin#1",
        date: "2026-05-26",
        project: "Loopengers",
        text: "Week B task",
      }),
    );
    const path = await makeTempDb(db);

    const state: FakeState = {
      createdWorklogs: [],
      remoteByTask: new Map(),
      fetchWorklogCalls: 0,
      createTaskCalls: 0,
      fetchTaskCalls: 0,
    };

    const result = await syncNetdokWorklogs({
      config: {
        ...baseConfig,
        netdok: {
          ...baseConfig.netdok,
          projects: {
            Loopengers: {
              projectId: "proj-l",
              pinnedTaskId: "pinned-task-1",
            },
          },
        },
        storage: { path },
      },
      client: makeFakeClient(state),
      apply: true,
    });

    expect(state.createdWorklogs).toHaveLength(2);
    expect(
      state.createdWorklogs.every((w) => w.taskId === "pinned-task-1"),
    ).toBe(true);
    expect(state.fetchWorklogCalls).toBe(1);
    expect(result.entries.every((e) => e.taskId === "pinned-task-1")).toBe(
      true,
    );
  });

  test("dedup against pinned task's remote worklogs still works", async () => {
    const db = emptyDatabase();
    db.workLogs.push(
      entry({
        id: "pin#0",
        date: "2026-05-21",
        project: "Loopengers",
        text: "Already there",
      }),
    );
    const path = await makeTempDb(db);

    const state: FakeState = {
      createdWorklogs: [],
      remoteByTask: new Map([
        [
          "pinned-task-1",
          [
            {
              id: "existing-worklog",
              taskId: "pinned-task-1",
              logAt: "2026-05-21T09:00:00.000Z",
              logTime: 3600,
              description: buildWorklogDescription("Already there"),
            },
          ],
        ],
      ]),
      fetchWorklogCalls: 0,
      createTaskCalls: 0,
      fetchTaskCalls: 0,
    };

    const result = await syncNetdokWorklogs({
      config: {
        ...baseConfig,
        netdok: {
          ...baseConfig.netdok,
          projects: {
            Loopengers: {
              projectId: "proj-l",
              pinnedTaskId: "pinned-task-1",
            },
          },
        },
        storage: { path },
      },
      client: makeFakeClient(state),
      apply: true,
    });

    expect(result.entries[0]?.status).toBe("skipped-duplicate-remote");
    expect(state.createdWorklogs).toHaveLength(0);
  });

  test("populates projectId + taskUrl on mapped entries, omits on skipped-no-project", async () => {
    const path = await makeTempDb(
      dbWithWrapper([
        entry({ id: "e1#0", project: "Venulog" }),
        entry({ id: "e2#0", project: "Dealer tool" }),
      ]),
    );
    const result = await syncNetdokWorklogs({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient({
        createdWorklogs: [],
        remoteByTask: new Map(),
        fetchWorklogCalls: 0,
        createTaskCalls: 0,
        fetchTaskCalls: 0,
      }),
    });
    const mapped = result.entries.find((e) => e.project === "Venulog");
    const unmapped = result.entries.find((e) => e.project === "Dealer tool");
    expect(mapped?.projectId).toBe("proj-v");
    expect(mapped?.taskUrl).toBe(
      "https://app.netdok.co/app/projects/active-sprint?id=proj-v&taskId=task-week-1",
    );
    expect(unmapped?.projectId).toBeUndefined();
    expect(unmapped?.taskUrl).toBeUndefined();
  });

  test("skipped-already-sent still carries projectId + taskUrl", async () => {
    const path = await makeTempDb(
      dbWithWrapper([
        entry({
          id: "e1#0",
          status: "sent",
          postedTaskId: "task-week-1",
          postedWorklogId: "old-worklog",
        }),
      ]),
    );
    const result = await syncNetdokWorklogs({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient({
        createdWorklogs: [],
        remoteByTask: new Map(),
        fetchWorklogCalls: 0,
        createTaskCalls: 0,
        fetchTaskCalls: 0,
      }),
    });
    expect(result.entries[0]?.projectId).toBe("proj-v");
    expect(result.entries[0]?.taskUrl).toBe(
      "https://app.netdok.co/app/projects/active-sprint?id=proj-v&taskId=task-week-1",
    );
  });
});
