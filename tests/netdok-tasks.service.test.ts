import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncNetdokTasks } from "../src/services/netdok-tasks.service.ts";
import type {
  CreateTaskInput,
  CreateWorklogInput,
  NetdokClient,
  NetdokTask,
  NetdokWorklog,
} from "../src/services/netdok.service.ts";
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

interface FakeClientState {
  tasksByProject: Map<string, NetdokTask[]>;
  createdTasks: CreateTaskInput[];
  fetchTaskCalls: number;
  createWorklogCalls: number;
  fetchWorklogCalls: number;
}

function makeFakeClient(state: FakeClientState): NetdokClient {
  return {
    async fetchTasksForProject(projectId: string) {
      state.fetchTaskCalls += 1;
      return state.tasksByProject.get(projectId) ?? [];
    },
    async fetchWorklogsForTask(): Promise<NetdokWorklog[]> {
      state.fetchWorklogCalls += 1;
      return [];
    },
    async createTask(input: CreateTaskInput): Promise<NetdokTask> {
      state.createdTasks.push(input);
      const id = `task-${state.createdTasks.length}`;
      const task: NetdokTask = {
        id,
        key: `TP-${state.createdTasks.length}`,
        name: input.name,
        projectId: input.projectId,
        sprintId: input.sprintId ?? null,
        statusId: input.statusId,
        estimate: input.estimate,
        remaining: input.remaining,
      };
      const list = state.tasksByProject.get(input.projectId) ?? [];
      list.push(task);
      state.tasksByProject.set(input.projectId, list);
      return task;
    },
    async createWorklog(_input: CreateWorklogInput): Promise<NetdokWorklog> {
      state.createWorklogCalls += 1;
      throw new Error("createWorklog not used in tasks tests");
    },
    async fetchMe() {
      throw new Error("fetchMe not used in tasks tests");
    },
    async fetchProjects() {
      throw new Error("fetchProjects not used in tasks tests");
    },
    async fetchProjectDetails() {
      throw new Error("fetchProjectDetails not used in tasks tests");
    },
    async fetchWorkspaces() {
      throw new Error("fetchWorkspaces not used in tasks tests");
    },
  };
}

async function makeTempDb(database: Database): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-tasks-"));
  const path = join(tempDir, "db.json");
  await writeDatabase(path, database);
  return path;
}

function makeEntry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
  return {
    id: "1716200000.000001#0",
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

describe("syncNetdokTasks", () => {
  test("groups entries by ISO week and previews a missing wrapper", async () => {
    const db = emptyDatabase();
    db.workLogs.push(
      makeEntry({ id: "a#0", date: "2026-05-21" }),
      makeEntry({ id: "a#1", date: "2026-05-19" }),
    );
    const path = await makeTempDb(db);

    const state: FakeClientState = {
      tasksByProject: new Map(),
      createdTasks: [],
      fetchTaskCalls: 0,
      createWorklogCalls: 0,
      fetchWorklogCalls: 0,
    };
    const client = makeFakeClient(state);

    const result = await syncNetdokTasks({
      config: { ...baseConfig, storage: { path } },
      client,
    });

    expect(result.applied).toBe(false);
    expect(result.weeks).toHaveLength(1);
    expect(result.weeks[0]).toMatchObject({
      project: "Venulog",
      weekStart: "2026-05-18",
      weekEnd: "2026-05-24",
      expectedTaskName: "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
      status: "would-create",
    });
    expect(state.createdTasks).toEqual([]);

    // Preview never writes to disk.
    const written = JSON.parse(await readFile(path, "utf8")) as Database;
    expect(written.netdokWeekTasks).toEqual([]);
  });

  test("apply creates missing tasks and persists local mapping", async () => {
    const db = emptyDatabase();
    db.workLogs.push(makeEntry({ id: "a#0", date: "2026-05-21" }));
    const path = await makeTempDb(db);

    const state: FakeClientState = {
      tasksByProject: new Map(),
      createdTasks: [],
      fetchTaskCalls: 0,
      createWorklogCalls: 0,
      fetchWorklogCalls: 0,
    };
    const client = makeFakeClient(state);

    const result = await syncNetdokTasks({
      config: { ...baseConfig, storage: { path } },
      client,
      apply: true,
    });

    expect(result.applied).toBe(true);
    expect(result.weeks[0]?.status).toBe("created");
    expect(result.weeks[0]?.taskId).toBe("task-1");
    expect(state.createdTasks).toHaveLength(1);
    expect(state.createdTasks[0]).toMatchObject({
      projectId: "proj-v",
      sprintId: "sprint-1",
      statusId: "status-1",
      name: "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
    });

    const written = JSON.parse(await readFile(path, "utf8")) as Database;
    expect(written.netdokWeekTasks).toHaveLength(1);
    expect(written.netdokWeekTasks[0]).toMatchObject({
      id: "proj-v#Venulog#2026-05-18",
      taskId: "task-1",
      project: "Venulog",
    });
  });

  test("re-running over a synced week returns existing-local with no new POSTs", async () => {
    const db = emptyDatabase();
    db.workLogs.push(makeEntry({ id: "a#0", date: "2026-05-21" }));
    db.netdokWeekTasks.push({
      id: "proj-v#Venulog#2026-05-18",
      project: "Venulog",
      projectId: "proj-v",
      weekStart: "2026-05-18",
      weekEnd: "2026-05-24",
      taskId: "existing-task",
      taskKey: "TP-99",
      taskName: "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
      createdAt: "2026-05-18T00:00:00.000Z",
    });
    const path = await makeTempDb(db);

    const state: FakeClientState = {
      tasksByProject: new Map(),
      createdTasks: [],
      fetchTaskCalls: 0,
      createWorklogCalls: 0,
      fetchWorklogCalls: 0,
    };
    const client = makeFakeClient(state);

    const result = await syncNetdokTasks({
      config: { ...baseConfig, storage: { path } },
      client,
      apply: true,
    });

    expect(result.weeks[0]?.status).toBe("existing-local");
    expect(result.weeks[0]?.taskId).toBe("existing-task");
    expect(state.createdTasks).toEqual([]);
    expect(state.fetchTaskCalls).toBe(0);
  });

  test("adopts a remote task only when its reporterId matches", async () => {
    const db = emptyDatabase();
    db.workLogs.push(makeEntry({ id: "a#0", date: "2026-05-21" }));
    const path = await makeTempDb(db);

    const state: FakeClientState = {
      tasksByProject: new Map([
        [
          "proj-v",
          [
            {
              id: "remote-task-7",
              key: "TP-7",
              name: "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
              projectId: "proj-v",
              sprintId: "sprint-1",
              statusId: "status-1",
              estimate: 28800,
              remaining: 28800,
              reporterId: "r",
            },
          ],
        ],
      ]),
      createdTasks: [],
      fetchTaskCalls: 0,
      createWorklogCalls: 0,
      fetchWorklogCalls: 0,
    };
    const client = makeFakeClient(state);

    const result = await syncNetdokTasks({
      config: { ...baseConfig, storage: { path } },
      client,
      apply: true,
    });

    expect(result.weeks[0]?.status).toBe("existing-remote");
    expect(result.weeks[0]?.taskId).toBe("remote-task-7");
    expect(state.createdTasks).toEqual([]);

    const written = JSON.parse(await readFile(path, "utf8")) as Database;
    expect(written.netdokWeekTasks[0]?.taskId).toBe("remote-task-7");
  });

  test("does not adopt a same-named remote task owned by a different reporter", async () => {
    const db = emptyDatabase();
    db.workLogs.push(makeEntry({ id: "a#0", date: "2026-05-21" }));
    const path = await makeTempDb(db);

    const state: FakeClientState = {
      tasksByProject: new Map([
        [
          "proj-v",
          [
            {
              id: "teammate-task-9",
              key: "TP-9",
              name: "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
              projectId: "proj-v",
              sprintId: "sprint-1",
              statusId: "status-1",
              estimate: 28800,
              remaining: 28800,
              reporterId: "someone-else",
            },
          ],
        ],
      ]),
      createdTasks: [],
      fetchTaskCalls: 0,
      createWorklogCalls: 0,
      fetchWorklogCalls: 0,
    };
    const client = makeFakeClient(state);

    const result = await syncNetdokTasks({
      config: { ...baseConfig, storage: { path } },
      client,
      apply: true,
    });

    expect(result.weeks[0]?.status).toBe("created");
    expect(result.weeks[0]?.taskId).toBe("task-1");
    expect(state.createdTasks).toHaveLength(1);

    const written = JSON.parse(await readFile(path, "utf8")) as Database;
    expect(written.netdokWeekTasks[0]?.taskId).toBe("task-1");
  });

  test("ignores remote tasks lacking a reporterId field", async () => {
    const db = emptyDatabase();
    db.workLogs.push(makeEntry({ id: "a#0", date: "2026-05-21" }));
    const path = await makeTempDb(db);

    const state: FakeClientState = {
      tasksByProject: new Map([
        [
          "proj-v",
          [
            {
              id: "legacy-task",
              key: "TP-1",
              name: "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
              projectId: "proj-v",
              sprintId: "sprint-1",
              statusId: "status-1",
              estimate: 28800,
              remaining: 28800,
            },
          ],
        ],
      ]),
      createdTasks: [],
      fetchTaskCalls: 0,
      createWorklogCalls: 0,
      fetchWorklogCalls: 0,
    };

    const result = await syncNetdokTasks({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient(state),
      apply: true,
    });

    expect(result.weeks[0]?.status).toBe("created");
    expect(state.createdTasks).toHaveLength(1);
  });

  test("pinned project is reported in `pinned` and triggers no remote fetch or creation", async () => {
    const db = emptyDatabase();
    db.workLogs.push(
      makeEntry({ id: "p#0", date: "2026-05-18", project: "Loopengers" }),
      makeEntry({ id: "p#1", date: "2026-05-22", project: "Loopengers" }),
    );
    const path = await makeTempDb(db);

    const state: FakeClientState = {
      tasksByProject: new Map(),
      createdTasks: [],
      fetchTaskCalls: 0,
      createWorklogCalls: 0,
      fetchWorklogCalls: 0,
    };

    const result = await syncNetdokTasks({
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

    expect(result.weeks).toEqual([]);
    expect(result.pinned).toEqual([
      {
        project: "Loopengers",
        projectId: "proj-l",
        pinnedTaskId: "pinned-task-1",
        entries: 2,
        taskUrl:
          "https://app.netdok.co/app/projects/active-sprint?id=proj-l&taskId=pinned-task-1",
      },
    ]);
    expect(state.fetchTaskCalls).toBe(0);
    expect(state.createdTasks).toEqual([]);

    const written = JSON.parse(await readFile(path, "utf8")) as Database;
    expect(written.netdokWeekTasks).toEqual([]);
  });

  test("mixed config: weekly wrapper for one project, pinned for another", async () => {
    const db = emptyDatabase();
    db.workLogs.push(
      makeEntry({ id: "v#0", date: "2026-05-21", project: "Venulog" }),
      makeEntry({ id: "p#0", date: "2026-05-21", project: "Loopengers" }),
    );
    const path = await makeTempDb(db);

    const state: FakeClientState = {
      tasksByProject: new Map(),
      createdTasks: [],
      fetchTaskCalls: 0,
      createWorklogCalls: 0,
      fetchWorklogCalls: 0,
    };

    const result = await syncNetdokTasks({
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

    expect(result.weeks).toHaveLength(1);
    expect(result.weeks[0]?.project).toBe("Venulog");
    expect(result.pinned).toHaveLength(1);
    expect(result.pinned[0]?.project).toBe("Loopengers");
    expect(state.createdTasks).toHaveLength(1);
    expect(state.createdTasks[0]?.projectId).toBe("proj-v");
  });

  test("populates taskUrl on existing-local / existing-remote / created weeks, omits on would-create", async () => {
    const db = emptyDatabase();
    db.workLogs.push(
      makeEntry({ id: "a#0", date: "2026-05-21" }),
      makeEntry({ id: "b#0", date: "2026-05-28" }),
    );
    db.netdokWeekTasks.push({
      id: "proj-v#Venulog#2026-05-18",
      project: "Venulog",
      projectId: "proj-v",
      weekStart: "2026-05-18",
      weekEnd: "2026-05-24",
      taskId: "existing-task",
      taskKey: "TP-99",
      taskName: "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
      createdAt: "2026-05-18T00:00:00.000Z",
    });
    const path = await makeTempDb(db);

    const state: FakeClientState = {
      tasksByProject: new Map(),
      createdTasks: [],
      fetchTaskCalls: 0,
      createWorklogCalls: 0,
      fetchWorklogCalls: 0,
    };

    const result = await syncNetdokTasks({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient(state),
    });

    const local = result.weeks.find((w) => w.status === "existing-local");
    const wouldCreate = result.weeks.find((w) => w.status === "would-create");
    expect(local?.taskUrl).toBe(
      "https://app.netdok.co/app/projects/active-sprint?id=proj-v&taskId=existing-task",
    );
    expect(wouldCreate?.taskUrl).toBeUndefined();
  });

  test("appBaseUrl overrides the default Netdok UI host in taskUrl", async () => {
    const db = emptyDatabase();
    db.workLogs.push(makeEntry({ id: "a#0", date: "2026-05-21" }));
    db.netdokWeekTasks.push({
      id: "proj-v#Venulog#2026-05-18",
      project: "Venulog",
      projectId: "proj-v",
      weekStart: "2026-05-18",
      weekEnd: "2026-05-24",
      taskId: "existing-task",
      taskKey: "TP-99",
      taskName: "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
      createdAt: "2026-05-18T00:00:00.000Z",
    });
    const path = await makeTempDb(db);

    const result = await syncNetdokTasks({
      config: {
        ...baseConfig,
        netdok: {
          ...baseConfig.netdok,
          appBaseUrl: "https://staging.netdok.co",
        },
        storage: { path },
      },
      client: makeFakeClient({
        tasksByProject: new Map(),
        createdTasks: [],
        fetchTaskCalls: 0,
        createWorklogCalls: 0,
        fetchWorklogCalls: 0,
      }),
    });

    expect(result.weeks[0]?.taskUrl).toBe(
      "https://staging.netdok.co/app/projects/active-sprint?id=proj-v&taskId=existing-task",
    );
  });

  test("collects unmapped projects in preview without throwing", async () => {
    const db = emptyDatabase();
    db.workLogs.push(
      makeEntry({ id: "a#0", date: "2026-05-21", project: "Venulog" }),
      makeEntry({ id: "b#0", date: "2026-05-21", project: "Dealer tool" }),
    );
    const path = await makeTempDb(db);

    const state: FakeClientState = {
      tasksByProject: new Map(),
      createdTasks: [],
      fetchTaskCalls: 0,
      createWorklogCalls: 0,
      fetchWorklogCalls: 0,
    };
    const result = await syncNetdokTasks({
      config: { ...baseConfig, storage: { path } },
      client: makeFakeClient(state),
    });

    expect(result.unmapped).toEqual([{ project: "Dealer tool", entries: 1 }]);
    expect(result.weeks).toHaveLength(1);
  });

  test("apply throws netdok-project-unmapped if any project is unmapped", async () => {
    const db = emptyDatabase();
    db.workLogs.push(
      makeEntry({ id: "b#0", date: "2026-05-21", project: "Dealer tool" }),
    );
    const path = await makeTempDb(db);

    await expect(
      syncNetdokTasks({
        config: { ...baseConfig, storage: { path } },
        client: makeFakeClient({
          tasksByProject: new Map(),
          createdTasks: [],
          fetchTaskCalls: 0,
          createWorklogCalls: 0,
          fetchWorklogCalls: 0,
        }),
        apply: true,
      }),
    ).rejects.toThrow(/Dealer tool/);
  });
});
