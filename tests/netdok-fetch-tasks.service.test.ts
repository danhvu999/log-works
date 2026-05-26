import { describe, expect, test } from "bun:test";
import { fetchNetdokRemoteTasks } from "../src/services/netdok-fetch-tasks.service.ts";
import type {
  CreateTaskInput,
  CreateWorklogInput,
  NetdokClient,
  NetdokTask,
  NetdokWorklog,
} from "../src/services/netdok.service.ts";
import type { LogWorksConfig } from "../src/types/index.ts";

interface FakeState {
  calls: Array<{ projectId: string; sprintId?: string }>;
  tasks: NetdokTask[];
}

function makeClient(state: FakeState): NetdokClient {
  return {
    async fetchTasksForProject(projectId: string, sprintId?: string) {
      state.calls.push({ projectId, sprintId });
      return state.tasks;
    },
    async fetchWorklogsForTask(): Promise<NetdokWorklog[]> {
      return [];
    },
    async createTask(_input: CreateTaskInput): Promise<NetdokTask> {
      throw new Error("createTask not used");
    },
    async createWorklog(_input: CreateWorklogInput): Promise<NetdokWorklog> {
      throw new Error("createWorklog not used");
    },
    async fetchMe() {
      throw new Error("fetchMe not used");
    },
    async fetchProjects() {
      throw new Error("fetchProjects not used");
    },
    async fetchProjectDetails() {
      throw new Error("fetchProjectDetails not used");
    },
    async fetchWorkspaces() {
      throw new Error("fetchWorkspaces not used");
    },
  };
}

const baseConfig: LogWorksConfig = {
  netdok: {
    baseUrl: "https://api.test",
    apiKey: "k",
    workspaceId: "w",
    profileId: "p",
  },
};

describe("fetchNetdokRemoteTasks", () => {
  test("returns mapped tasks for a project", async () => {
    const state: FakeState = {
      calls: [],
      tasks: [
        {
          id: "task-1",
          key: "TP-1",
          name: "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
          projectId: "proj-v",
          sprintId: "sprint-1",
          statusId: "status-inprog",
          estimate: 28800,
          remaining: 28800,
          reporterId: "p",
        },
      ],
    };

    const result = await fetchNetdokRemoteTasks({
      projectId: "proj-v",
      config: baseConfig,
      client: makeClient(state),
    });

    expect(state.calls).toEqual([{ projectId: "proj-v", sprintId: undefined }]);
    expect(result.projectId).toBe("proj-v");
    expect(result.sprintId).toBeUndefined();
    expect(result.total).toBe(1);
    expect(result.tasks[0]).toMatchObject({
      id: "task-1",
      key: "TP-1",
      projectId: "proj-v",
      sprintId: "sprint-1",
      statusId: "status-inprog",
      reporterId: "p",
    });
  });

  test("forwards sprintId scope to the client", async () => {
    const state: FakeState = { calls: [], tasks: [] };
    const result = await fetchNetdokRemoteTasks({
      projectId: "proj-v",
      sprintId: "sprint-1",
      config: baseConfig,
      client: makeClient(state),
    });

    expect(state.calls).toEqual([
      { projectId: "proj-v", sprintId: "sprint-1" },
    ]);
    expect(result.sprintId).toBe("sprint-1");
    expect(result.total).toBe(0);
    expect(result.tasks).toEqual([]);
  });

  test("throws config-missing when projectId is empty", async () => {
    await expect(
      fetchNetdokRemoteTasks({
        projectId: "  ",
        config: baseConfig,
        client: makeClient({ calls: [], tasks: [] }),
      }),
    ).rejects.toThrow(/projectId/i);
  });
});
