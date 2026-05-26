import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyDatabase,
  writeDatabase,
} from "../src/services/storage.service.ts";
import { summarizeStorage } from "../src/services/summary.service.ts";
import type { Database, WorkLogEntry } from "../src/types/index.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function seed(workLogs: WorkLogEntry[]): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-summary-"));
  const path = join(tempDir, "db.json");
  const db: Database = { ...emptyDatabase(), workLogs };
  await writeDatabase(path, db);
  return path;
}

function entry(
  overrides: Partial<WorkLogEntry> & { id: string },
): WorkLogEntry {
  return {
    sourceTs: "1716000000.000001",
    date: "2024-05-18",
    project: "Venulog",
    text: "did stuff",
    hours: 1,
    status: "pending",
    ...overrides,
  };
}

describe("summary service (workLog aggregation)", () => {
  test("empty DB returns empty projects and zeroed totals", async () => {
    const path = await seed([]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    expect(result).toEqual({
      projects: [],
      totals: { entries: 0, hours: 0, entriesWithoutHours: 0 },
      storagePath: path,
      from: undefined,
      to: undefined,
    });
  });

  test("aggregates per-project hours and counts; sorted by project name asc", async () => {
    const path = await seed([
      entry({ id: "v1", project: "Venulog", hours: 2.5, date: "2024-05-18" }),
      entry({ id: "v2", project: "Venulog", hours: 1, date: "2024-05-20" }),
      entry({ id: "m1", project: "Metabase", hours: 3, date: "2024-05-19" }),
      entry({
        id: "v3",
        project: "Venulog",
        hours: null,
        date: "2024-05-21",
      }),
    ]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    expect(result.projects.map((p) => p.project)).toEqual([
      "Metabase",
      "Venulog",
    ]);
    expect(result.projects[0]).toEqual({
      project: "Metabase",
      entries: 1,
      hours: 3,
      entriesWithoutHours: 0,
      firstDate: "2024-05-19",
      lastDate: "2024-05-19",
    });
    expect(result.projects[1]).toEqual({
      project: "Venulog",
      entries: 3,
      hours: 3.5,
      entriesWithoutHours: 1,
      firstDate: "2024-05-18",
      lastDate: "2024-05-21",
    });
    expect(result.totals).toEqual({
      entries: 4,
      hours: 6.5,
      entriesWithoutHours: 1,
    });
  });

  test("from / to filter inclusive on entry.date", async () => {
    const path = await seed([
      entry({ id: "a", project: "A", date: "2024-05-17", hours: 1 }),
      entry({ id: "b", project: "B", date: "2024-05-19", hours: 2 }),
      entry({ id: "c", project: "C", date: "2024-05-20", hours: 4 }),
      entry({ id: "d", project: "D", date: "2024-05-22", hours: 8 }),
    ]);
    const result = await summarizeStorage({
      config: { storage: { path } },
      from: "2024-05-19",
      to: "2024-05-20",
    });
    expect(result.projects.map((p) => p.project)).toEqual(["B", "C"]);
    expect(result.totals).toEqual({
      entries: 2,
      hours: 6,
      entriesWithoutHours: 0,
    });
    expect(result.from).toBe("2024-05-19");
    expect(result.to).toBe("2024-05-20");
  });

  test("entriesWithoutHours counts null-hour entries without inflating hours sum", async () => {
    const path = await seed([
      entry({ id: "x1", project: "X", hours: null, date: "2024-05-18" }),
      entry({ id: "x2", project: "X", hours: null, date: "2024-05-19" }),
      entry({ id: "y1", project: "Y", hours: 1, date: "2024-05-18" }),
    ]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    const x = result.projects.find((p) => p.project === "X");
    expect(x).toEqual({
      project: "X",
      entries: 2,
      hours: 0,
      entriesWithoutHours: 2,
      firstDate: "2024-05-18",
      lastDate: "2024-05-19",
    });
    expect(result.totals).toEqual({
      entries: 3,
      hours: 1,
      entriesWithoutHours: 2,
    });
  });
});
