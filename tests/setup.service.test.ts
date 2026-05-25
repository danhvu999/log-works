import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import projectNameSuggestions from "../src/constants/project-name-suggestions.ts";
import type {
  CreateTaskInput,
  CreateWorklogInput,
  NetdokClient,
  NetdokTask,
  NetdokWorklog,
} from "../src/services/netdok.service.ts";
import {
  checkConfigReadiness,
  checkNetdokReadiness,
  checkSlackReadiness,
  setupNetdokApply,
  setupNetdokDiscover,
  setupSlackConfig,
} from "../src/services/setup.service.ts";
import {
  emptyDatabase,
  upsertRawMessages,
  writeDatabase,
} from "../src/services/storage.service.ts";
import type {
  LogWorksConfig,
  NetdokApplyInput,
  NetdokMeSummary,
  NetdokProjectDetails,
  NetdokProjectSummary,
  NetdokWorkspaceSummary,
  RawSlackMessage,
} from "../src/types/index.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function makeTempConfigPath(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-setup-"));
  return join(tempDir, "config.json");
}

interface DiscoverState {
  workspaces: NetdokWorkspaceSummary[];
  me?: NetdokMeSummary;
  projects: NetdokProjectSummary[];
  detailsById: Map<string, NetdokProjectDetails>;
  tasksByProject?: Map<string, NetdokTask[]>;
  calls: {
    workspaces: number;
    me: number;
    projects: number;
    details: string[];
    tasks: string[];
  };
}

function makeDiscoverClient(state: DiscoverState): NetdokClient {
  return {
    async fetchTasksForProject(projectId: string): Promise<NetdokTask[]> {
      if (!state.tasksByProject) {
        throw new Error("not used in discover tests");
      }
      state.calls.tasks.push(projectId);
      return state.tasksByProject.get(projectId) ?? [];
    },
    async fetchWorklogsForTask(): Promise<NetdokWorklog[]> {
      throw new Error("not used in discover tests");
    },
    async createTask(_input: CreateTaskInput): Promise<NetdokTask> {
      throw new Error("not used in discover tests");
    },
    async createWorklog(_input: CreateWorklogInput): Promise<NetdokWorklog> {
      throw new Error("not used in discover tests");
    },
    async fetchMe(): Promise<NetdokMeSummary> {
      state.calls.me += 1;
      if (!state.me) {
        throw new Error("me not configured");
      }
      return state.me;
    },
    async fetchProjects(): Promise<NetdokProjectSummary[]> {
      state.calls.projects += 1;
      return state.projects;
    },
    async fetchProjectDetails(
      projectId: string,
    ): Promise<NetdokProjectDetails> {
      state.calls.details.push(projectId);
      const details = state.detailsById.get(projectId);
      if (!details) {
        throw new Error(`no details for ${projectId}`);
      }
      return details;
    },
    async fetchWorkspaces(): Promise<NetdokWorkspaceSummary[]> {
      state.calls.workspaces += 1;
      return state.workspaces;
    },
  };
}

const workspaces: NetdokWorkspaceSummary[] = [
  { id: "ws-1", name: "Danh", apiUrl: "https://api.netdok.co" },
  { id: "ws-2", name: "Netfine.co", apiUrl: "https://api.netdok.co" },
];

const me: NetdokMeSummary = {
  profileId: "profile-1",
  displayName: "danh.vu",
  workspaceId: "ws-1",
  tz: "Asia/Bangkok",
};

const projects: NetdokProjectSummary[] = [
  { id: "proj-v", key: "TPV", name: "Venulog", workspaceId: "ws-1" },
  { id: "proj-l", key: "TPL", name: "Loopengers", workspaceId: "ws-1" },
];

const detailsById = new Map<string, NetdokProjectDetails>([
  [
    "proj-v",
    {
      id: "proj-v",
      name: "Venulog",
      key: "TPV",
      statuses: [
        { id: "status-todo", name: "Todo", type: "TODO" },
        { id: "status-inprog", name: "In progress", type: "INPROGRESS" },
      ],
      sprintIds: ["sprint-1", "sprint-2"],
      suggestedStatusId: "status-inprog",
      suggestedSprintId: "sprint-1",
    },
  ],
  [
    "proj-l",
    {
      id: "proj-l",
      name: "Loopengers",
      key: "TPL",
      statuses: [{ id: "status-todo2", name: "Todo", type: "TODO" }],
      sprintIds: [],
      suggestedStatusId: "status-todo2",
      suggestedSprintId: undefined,
    },
  ],
]);

describe("setupSlackConfig", () => {
  test("writes slack.* keys atomically and leaves netdok untouched", async () => {
    const configPath = await makeTempConfigPath();
    const result = await setupSlackConfig(
      {
        userToken: "xoxp-test",
        userId: "U123LOG",
        channels: ["CWORKLOG", "self"],
      },
      { configPath },
    );

    expect(result.applied).toBe(true);
    expect(result.configPath).toBe(configPath);
    expect(result.config.slack?.userToken).toBe("[redacted]");
    expect(result.config.slack?.userId).toBe("U123LOG");
    expect(result.config.slack?.channels).toEqual(["CWORKLOG", "self"]);
    expect(result.config.netdok).toBeUndefined();

    const written = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as LogWorksConfig;
    expect(written.slack?.userToken).toBe("xoxp-test");
    expect(written.slack?.userId).toBe("U123LOG");
    expect(written.slack?.channels).toEqual(["CWORKLOG", "self"]);
  });

  test("rejects empty userToken with setup-invalid", async () => {
    const configPath = await makeTempConfigPath();
    let caught: unknown;
    try {
      await setupSlackConfig(
        { userToken: "", userId: "U", channels: [] },
        { configPath },
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe("setup-invalid");
  });
});

describe("setupNetdokDiscover", () => {
  test("step 1 (no workspaceId) returns workspaces only", async () => {
    const state: DiscoverState = {
      workspaces,
      projects: [],
      detailsById: new Map(),
      calls: { workspaces: 0, me: 0, projects: 0, details: [], tasks: [] },
    };
    const result = await setupNetdokDiscover(
      { apiKey: "ndk_test" },
      { client: makeDiscoverClient(state) },
    );

    expect(state.calls.workspaces).toBe(1);
    expect(state.calls.me).toBe(0);
    expect(state.calls.projects).toBe(0);
    expect(state.calls.details).toEqual([]);
    expect(result.workspaces).toEqual(workspaces);
    expect(result.me).toBeNull();
    expect(result.projects).toEqual([]);
    expect(result.projectDetails).toEqual([]);
  });

  test("step 2 (workspaceId provided) fans out to me/projects/details and includes localProjectsSeen", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "log-works-discover-"));
    const dbPath = join(tempDir, "db.json");
    const messages: RawSlackMessage[] = [
      {
        ts: "1716000000.000001",
        channel: "CWORKLOG",
        userId: "U123LOG",
        text: "Debrief:\nVenulog\n• Shipped feature [3h]",
        raw: {},
        fetchedAt: "2026-05-25T00:00:00.000Z",
      },
      {
        ts: "1716100000.000002",
        channel: "CWORKLOG",
        userId: "U123LOG",
        text: "Debrief:\nMetabase\n• Migrated pipeline [2h]",
        raw: {},
        fetchedAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const { database } = upsertRawMessages(emptyDatabase(), messages);
    await writeDatabase(dbPath, database);

    const state: DiscoverState = {
      workspaces,
      me,
      projects,
      detailsById,
      calls: { workspaces: 0, me: 0, projects: 0, details: [], tasks: [] },
    };
    const result = await setupNetdokDiscover(
      { apiKey: "ndk_test", workspaceId: "ws-1" },
      {
        client: makeDiscoverClient(state),
        config: { storage: { path: dbPath } },
      },
    );

    expect(state.calls.workspaces).toBe(1);
    expect(state.calls.me).toBe(1);
    expect(state.calls.projects).toBe(1);
    expect(state.calls.details).toEqual(["proj-v", "proj-l"]);
    expect(result.me).toEqual(me);
    expect(result.workspaceId).toBe("ws-1");
    expect(result.projects).toEqual(projects);
    expect(result.projectDetails).toHaveLength(2);
    expect(result.projectDetails[0]?.suggestedStatusId).toBe("status-inprog");
    for (const name of projectNameSuggestions) {
      expect(result.localProjectsSeen).toContain(name);
    }
    expect(result.localProjectsSeen).toContain("Venulog");
    expect(result.localProjectsSeen).toContain("Metabase");
  });

  test("step 2 with includeTasks=true also returns projectTasks per project", async () => {
    const tasksByProject = new Map<string, NetdokTask[]>([
      [
        "proj-v",
        [
          {
            id: "task-v-1",
            key: "TPV-101",
            name: "Q2 retainer umbrella",
            projectId: "proj-v",
            sprintId: "sprint-1",
            statusId: "status-inprog",
            estimate: 0,
            remaining: 0,
          },
          {
            id: "task-v-2",
            key: "TPV-102",
            name: "Random feature",
            projectId: "proj-v",
            sprintId: null,
            statusId: "status-todo",
            estimate: 0,
            remaining: 0,
          },
        ],
      ],
      ["proj-l", []],
    ]);

    const state: DiscoverState = {
      workspaces,
      me,
      projects,
      detailsById,
      tasksByProject,
      calls: { workspaces: 0, me: 0, projects: 0, details: [], tasks: [] },
    };
    const result = await setupNetdokDiscover(
      { apiKey: "ndk_test", workspaceId: "ws-1", includeTasks: true },
      { client: makeDiscoverClient(state) },
    );

    expect(state.calls.tasks).toEqual(["proj-v", "proj-l"]);
    expect(result.projectTasks).toBeDefined();
    expect(result.projectTasks).toHaveLength(2);
    const vTasks = result.projectTasks?.find((p) => p.projectId === "proj-v");
    expect(vTasks?.tasks).toEqual([
      {
        id: "task-v-1",
        key: "TPV-101",
        name: "Q2 retainer umbrella",
        sprintId: "sprint-1",
        statusId: "status-inprog",
      },
      {
        id: "task-v-2",
        key: "TPV-102",
        name: "Random feature",
        sprintId: null,
        statusId: "status-todo",
      },
    ]);
    expect(
      result.projectTasks?.find((p) => p.projectId === "proj-l")?.tasks,
    ).toEqual([]);
  });

  test("step 2 without includeTasks omits projectTasks (no /tasks calls)", async () => {
    const state: DiscoverState = {
      workspaces,
      me,
      projects,
      detailsById,
      tasksByProject: new Map<string, NetdokTask[]>(),
      calls: { workspaces: 0, me: 0, projects: 0, details: [], tasks: [] },
    };
    const result = await setupNetdokDiscover(
      { apiKey: "ndk_test", workspaceId: "ws-1" },
      { client: makeDiscoverClient(state) },
    );

    expect(state.calls.tasks).toEqual([]);
    expect(result.projectTasks).toBeUndefined();
  });

  test("step 2 with projectIds subset only fetches details for that subset", async () => {
    const state: DiscoverState = {
      workspaces,
      me,
      projects,
      detailsById,
      calls: { workspaces: 0, me: 0, projects: 0, details: [], tasks: [] },
    };
    const result = await setupNetdokDiscover(
      {
        apiKey: "ndk_test",
        workspaceId: "ws-1",
        projectIds: ["proj-v"],
      },
      { client: makeDiscoverClient(state) },
    );

    expect(state.calls.details).toEqual(["proj-v"]);
    expect(result.projectDetails).toHaveLength(1);
    expect(result.projectDetails[0]?.id).toBe("proj-v");
  });

  test("rejects empty apiKey with setup-invalid", async () => {
    let caught: unknown;
    try {
      await setupNetdokDiscover(
        { apiKey: "" },
        {
          client: makeDiscoverClient({
            workspaces,
            projects: [],
            detailsById: new Map(),
            calls: {
              workspaces: 0,
              me: 0,
              projects: 0,
              details: [],
              tasks: [],
            },
          }),
        },
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe("setup-invalid");
  });
});

describe("setupNetdokApply", () => {
  test("writes nested netdok keys, defaults reporterId, defaults baseUrl", async () => {
    const configPath = await makeTempConfigPath();
    const result = await setupNetdokApply(
      {
        apiKey: "ndk_test",
        workspaceId: "ws-1",
        profileId: "profile-1",
        projects: {
          Venulog: {
            projectId: "proj-v",
            sprintId: "sprint-1",
            statusId: "status-inprog",
          },
          Loopengers: {
            projectId: "proj-l",
            pinnedTaskId: "pinned-task-1",
          },
        },
      },
      { configPath },
    );

    expect(result.applied).toBe(true);
    expect(result.config.netdok?.apiKey).toBe("[redacted]");

    const written = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as LogWorksConfig;
    expect(written.netdok?.apiKey).toBe("ndk_test");
    expect(written.netdok?.workspaceId).toBe("ws-1");
    expect(written.netdok?.profileId).toBe("profile-1");
    expect(written.netdok?.reporterId).toBe("profile-1");
    expect(written.netdok?.baseUrl).toBe("https://api.netdok.co");
    expect(written.netdok?.projects?.Venulog).toEqual({
      projectId: "proj-v",
      sprintId: "sprint-1",
      statusId: "status-inprog",
    });
    expect(written.netdok?.projects?.Loopengers).toEqual({
      projectId: "proj-l",
      pinnedTaskId: "pinned-task-1",
    });
  });

  test("re-applying overwrites only matching keys", async () => {
    const configPath = await makeTempConfigPath();
    await setupNetdokApply(
      {
        apiKey: "ndk_first",
        workspaceId: "ws-1",
        profileId: "profile-1",
        projects: {
          Venulog: { projectId: "proj-old" },
        },
      },
      { configPath },
    );

    await setupNetdokApply(
      {
        apiKey: "ndk_second",
        workspaceId: "ws-1",
        profileId: "profile-1",
        projects: {
          Venulog: { projectId: "proj-new", sprintId: "sprint-1" },
        },
      },
      { configPath },
    );

    const written = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as LogWorksConfig;
    expect(written.netdok?.apiKey).toBe("ndk_second");
    expect(written.netdok?.projects?.Venulog?.projectId).toBe("proj-new");
    expect(written.netdok?.projects?.Venulog?.sprintId).toBe("sprint-1");
  });

  test("rejects payload missing apiKey with setup-invalid and writes nothing", async () => {
    const configPath = await makeTempConfigPath();
    let caught: unknown;
    try {
      await setupNetdokApply(
        {
          workspaceId: "ws-1",
          profileId: "profile-1",
          projects: { Venulog: { projectId: "proj-v" } },
        } as unknown as NetdokApplyInput,
        { configPath },
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe("setup-invalid");

    let readError: unknown;
    try {
      await readFile(configPath, "utf8");
    } catch (error) {
      readError = error;
    }
    expect((readError as NodeJS.ErrnoException)?.code).toBe("ENOENT");
  });
});

describe("checkNetdokReadiness", () => {
  test("empty config reports all base keys missing and suggests discover", async () => {
    const result = await checkNetdokReadiness({ config: {} });

    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([
      "netdok.apiKey",
      "netdok.workspaceId",
      "netdok.profileId",
      "netdok.projects (at least one mapping)",
    ]);
    expect(result.mappedLocalProjects).toEqual([]);
    expect(result.suggestion).toContain(
      "log_works_config_setup_netdok_discover",
    );
    for (const name of projectNameSuggestions) {
      expect(result.knownLocalProjects).toContain(name);
      expect(result.unmappedLocalProjects).toContain(name);
    }
  });

  test("base keys set, no project mapping → ready=false, suggest apply", async () => {
    const result = await checkNetdokReadiness({
      config: {
        netdok: {
          apiKey: "k",
          workspaceId: "w",
          profileId: "p",
        },
      },
    });

    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(["netdok.projects (at least one mapping)"]);
    expect(result.suggestion).toContain("log_works_config_setup_netdok_apply");
  });

  test("base keys set + at least one mapping → ready=true", async () => {
    const result = await checkNetdokReadiness({
      config: {
        netdok: {
          apiKey: "k",
          workspaceId: "w",
          profileId: "p",
          projects: {
            Venulog: { projectId: "proj-v" },
          },
        },
      },
    });

    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.mappedLocalProjects).toEqual(["Venulog"]);
    expect(result.unmappedLocalProjects).not.toContain("Venulog");
    expect(result.suggestion).toMatch(/Ready\./);
  });

  test("knownLocalProjects unions rawMessages scan with constants", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "log-works-readiness-"));
    const dbPath = join(tempDir, "db.json");
    const messages: RawSlackMessage[] = [
      {
        ts: "1716000000.000001",
        channel: "CWORKLOG",
        userId: "U123LOG",
        text: "Debrief:\nExperimentalAI\n• Prototype agent [3h]",
        raw: {},
        fetchedAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const { database } = upsertRawMessages(emptyDatabase(), messages);
    await writeDatabase(dbPath, database);

    const result = await checkNetdokReadiness({
      config: { storage: { path: dbPath } },
    });

    expect(result.knownLocalProjects).toContain("ExperimentalAI");
    for (const name of projectNameSuggestions) {
      expect(result.knownLocalProjects).toContain(name);
    }
    expect(result.unmappedLocalProjects).toContain("ExperimentalAI");
  });
});

describe("checkSlackReadiness", () => {
  test("empty config flags all three slack keys as missing", async () => {
    const result = await checkSlackReadiness({});
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([
      "slack.userToken",
      "slack.userId",
      "slack.channels",
    ]);
    expect(result.suggestion).toContain("log_works_config_setup_slack");
  });

  test("empty channels array flags slack.channels missing", async () => {
    const result = await checkSlackReadiness({
      slack: { userToken: "xoxp-x", userId: "U", channels: [] },
    });
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(["slack.channels"]);
  });

  test("token + userId + at least one channel → ready", async () => {
    const result = await checkSlackReadiness({
      slack: { userToken: "xoxp-x", userId: "U", channels: ["CWORKLOG"] },
    });
    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.suggestion).toBe("Ready.");
  });
});

describe("checkConfigReadiness", () => {
  test("empty config → nextStep setup-slack (Slack first, ignore netdok)", async () => {
    const result = await checkConfigReadiness({ config: {} });
    expect(result.slack.ready).toBe(false);
    expect(result.netdok.ready).toBe(false);
    expect(result.nextStep).toBe("setup-slack");
  });

  test("Slack ready, netdok empty, no rawMessages → nextStep fetch-and-derive", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "log-works-cfgcheck-empty-"));
    const dbPath = join(tempDir, "db.json");
    const result = await checkConfigReadiness({
      config: {
        slack: { userToken: "xoxp-x", userId: "U", channels: ["CWORKLOG"] },
        storage: { path: dbPath },
      },
    });
    expect(result.slack.ready).toBe(true);
    expect(result.netdok.ready).toBe(false);
    expect(result.nextStep).toBe("fetch-and-derive");
  });

  test("Slack ready + rawMessages exist + netdok base missing → setup-netdok-discover", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "log-works-cfgcheck-"));
    const dbPath = join(tempDir, "db.json");
    const messages: RawSlackMessage[] = [
      {
        ts: "1716000000.000001",
        channel: "CWORKLOG",
        userId: "U",
        text: "Debrief:\nVenulog\n• Shipped [1h]",
        raw: {},
        fetchedAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const { database } = upsertRawMessages(emptyDatabase(), messages);
    await writeDatabase(dbPath, database);

    const result = await checkConfigReadiness({
      config: {
        slack: { userToken: "xoxp-x", userId: "U", channels: ["CWORKLOG"] },
        storage: { path: dbPath },
      },
    });
    expect(result.nextStep).toBe("setup-netdok-discover");
  });

  test("Slack ready + netdok base set, no mappings → setup-netdok-apply", async () => {
    const result = await checkConfigReadiness({
      config: {
        slack: { userToken: "xoxp-x", userId: "U", channels: ["CWORKLOG"] },
        netdok: { apiKey: "k", workspaceId: "w", profileId: "p" },
      },
    });
    expect(result.nextStep).toBe("setup-netdok-apply");
  });

  test("Everything set + at least one mapping + rawMessages exist → ready", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "log-works-cfgcheck-ready-"));
    const dbPath = join(tempDir, "db.json");
    const messages: RawSlackMessage[] = [
      {
        ts: "1716000000.000001",
        channel: "CWORKLOG",
        userId: "U",
        text: "Debrief:\nVenulog\n• Shipped [1h]",
        raw: {},
        fetchedAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const { database } = upsertRawMessages(emptyDatabase(), messages);
    await writeDatabase(dbPath, database);

    const result = await checkConfigReadiness({
      config: {
        slack: { userToken: "xoxp-x", userId: "U", channels: ["CWORKLOG"] },
        netdok: {
          apiKey: "k",
          workspaceId: "w",
          profileId: "p",
          projects: { Venulog: { projectId: "proj-v" } },
        },
        storage: { path: dbPath },
      },
    });
    expect(result.nextStep).toBe("ready");
    expect(result.slack.ready).toBe(true);
    expect(result.netdok.ready).toBe(true);
  });
});
