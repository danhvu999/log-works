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
  id: string,
  project: string,
  date: string,
  hours: number | null,
): WorkLogEntry {
  return {
    id,
    sourceTs: id,
    date,
    project,
    text: `entry ${id}`,
    hours,
    status: "pending",
    source: "rule",
  };
}

describe("summary service", () => {
  test("empty DB returns zero totals and no projects", async () => {
    const path = await seed([]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    expect(result.totals).toEqual({
      rawMessages: 0,
      workLogs: 0,
      totalHours: 0,
      uniqueProjects: 0,
      dateMin: null,
      dateMax: null,
    });
    expect(result.projects).toEqual([]);
    expect(result.storagePath).toBe(path);
  });

  test("aggregates per project, treats null hours as zero, sorts by hours desc", async () => {
    const path = await seed([
      entry("a#0", "Metabase", "2026-05-21", 1),
      entry("a#1", "Metabase", "2026-05-22", 8),
      entry("b#0", "Venulog", "2026-05-18", 3),
      entry("b#1", "Venulog", "2026-05-19", 0.5),
      entry("b#2", "Venulog", "2026-05-20", null),
    ]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    expect(result.totals).toEqual({
      rawMessages: 0,
      workLogs: 5,
      totalHours: 12.5,
      uniqueProjects: 2,
      dateMin: "2026-05-18",
      dateMax: "2026-05-22",
    });
    expect(result.projects).toEqual([
      {
        project: "Metabase",
        entries: 2,
        hours: 9,
        dateMin: "2026-05-21",
        dateMax: "2026-05-22",
      },
      {
        project: "Venulog",
        entries: 3,
        hours: 3.5,
        dateMin: "2026-05-18",
        dateMax: "2026-05-20",
      },
    ]);
  });

  test("--from / --to filter work-logs by entry.date inclusive", async () => {
    const path = await seed([
      entry("a#0", "Venulog", "2026-05-17", 2),
      entry("a#1", "Venulog", "2026-05-18", 3),
      entry("a#2", "Venulog", "2026-05-24", 1),
      entry("a#3", "Venulog", "2026-05-25", 1),
    ]);
    const result = await summarizeStorage({
      config: { storage: { path } },
      from: "2026-05-18",
      to: "2026-05-24",
    });
    expect(result.totals.workLogs).toBe(2);
    expect(result.totals.totalHours).toBe(4);
    expect(result.totals.dateMin).toBe("2026-05-18");
    expect(result.totals.dateMax).toBe("2026-05-24");
    expect(result.from).toBe("2026-05-18");
    expect(result.to).toBe("2026-05-24");
  });

  test("ties on hours break alphabetically by project name", async () => {
    const path = await seed([
      entry("a#0", "Zeta", "2026-05-20", 4),
      entry("b#0", "Alpha", "2026-05-20", 4),
    ]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    expect(result.projects.map((p) => p.project)).toEqual(["Alpha", "Zeta"]);
  });
});
