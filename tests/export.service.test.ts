import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/errors.ts";
import {
  exportWorkLogs,
  filterWorkLogs,
  renderCsv,
  renderJson,
} from "../src/services/export.service.ts";
import type { Database, LogWorksConfig } from "../src/types/index.ts";

const FIXTURE_PATH = "fixtures/storage/db.export-mixed.json";
const CSV_HEADER =
  "id,date,project,hours,text,status,lastError,postedAt,sourceTs";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-export-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function loadFixture(): Promise<Database> {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Database;
}

function configWith(storagePath: string): LogWorksConfig {
  return { storage: { path: storagePath } };
}

describe("export service — renderCsv", () => {
  test("starts with header row exposing project + hours and contains every id", async () => {
    const database = await loadFixture();
    const csv = renderCsv(database.workLogs);

    expect(csv.startsWith(`${CSV_HEADER}\n`)).toBe(true);
    for (const entry of database.workLogs) {
      expect(csv).toContain(entry.id);
    }
  });

  test("escapes per RFC 4180 and prints numeric hours unquoted", () => {
    const csv = renderCsv([
      {
        id: "x#0",
        sourceTs: "x",
        date: "2026-05-24",
        project: "Venulog",
        text: 'Field with, comma and "quote" and\nnewline',
        hours: 0.5,
        status: "pending",
      },
    ]);
    expect(csv).toBe(
      `${CSV_HEADER}\nx#0,2026-05-24,Venulog,0.5,"Field with, comma and ""quote"" and\nnewline",pending,,,x\n`,
    );
  });

  test("empty work-log list emits header-only", () => {
    expect(renderCsv([])).toBe(`${CSV_HEADER}\n`);
  });

  test("null hours render as empty field", () => {
    const csv = renderCsv([
      {
        id: "y#0",
        sourceTs: "y",
        date: "2026-05-24",
        project: "Metabase",
        text: "no hours",
        hours: null,
        status: "pending",
      },
    ]);
    expect(csv).toBe(
      `${CSV_HEADER}\ny#0,2026-05-24,Metabase,,no hours,pending,,,y\n`,
    );
  });
});

describe("export service — renderJson", () => {
  test("emits rows count + entries array", async () => {
    const database = await loadFixture();
    const json = renderJson(database.workLogs);
    const parsed = JSON.parse(json) as {
      rows: number;
      entries: Array<{ project: string; hours: number | null }>;
    };
    expect(parsed.rows).toBe(database.workLogs.length);
    expect(parsed.entries[0]).toHaveProperty("project");
    expect(parsed.entries[0]).toHaveProperty("hours");
  });
});

describe("export service — filterWorkLogs", () => {
  test("filters inclusive on --from and --to (string compare on YYYY-MM-DD)", async () => {
    const database = await loadFixture();
    const filtered = filterWorkLogs(database.workLogs, {
      from: "2026-05-20",
      to: "2026-05-22",
    });
    expect(filtered.map((entry) => entry.id)).toEqual([
      "1716300000.000200#0",
      "1716400000.000300#0",
    ]);
  });

  test("filters by status", async () => {
    const database = await loadFixture();
    const filtered = filterWorkLogs(database.workLogs, { status: "sent" });
    expect(filtered.map((entry) => entry.id)).toEqual(["1716200000.000100#1"]);
  });

  test("returns all entries when no filters applied", async () => {
    const database = await loadFixture();
    const filtered = filterWorkLogs(database.workLogs, {});
    expect(filtered.length).toBe(database.workLogs.length);
  });
});

describe("export service — exportWorkLogs", () => {
  test("returns CSV body and summary when --format csv and no --out", async () => {
    const result = await exportWorkLogs({
      format: "csv",
      config: configWith(FIXTURE_PATH),
    });
    expect(result.summary.format).toBe("csv");
    expect(result.summary.rows).toBe(5);
    expect(result.summary.path).toBeNull();
    expect((result.body as string).startsWith(`${CSV_HEADER}\n`)).toBe(true);
  });

  test("returns JSON body when --format json", async () => {
    const result = await exportWorkLogs({
      format: "json",
      config: configWith(FIXTURE_PATH),
    });
    expect(result.summary.format).toBe("json");
    const parsed = JSON.parse(result.body as string) as { rows: number };
    expect(parsed.rows).toBe(5);
  });

  test("returns Uint8Array zip buffer when --format xlsx", async () => {
    const result = await exportWorkLogs({
      format: "xlsx",
      config: configWith(FIXTURE_PATH),
    });
    expect(result.summary.format).toBe("xlsx");
    const body = result.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body[0]).toBe(0x50);
    expect(body[1]).toBe(0x4b);
  });

  test("--out with --format xlsx writes Uint8Array to writeFile", async () => {
    const dir = await makeTempDir();
    const outPath = join(dir, "out.xlsx");
    const writes: Array<{ path: string; contents: string | Uint8Array }> = [];

    await exportWorkLogs({
      format: "xlsx",
      out: outPath,
      config: configWith(FIXTURE_PATH),
      writeFile: async (path, contents) => {
        writes.push({ path, contents });
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.contents).toBeInstanceOf(Uint8Array);
  });

  test("writes file via injected writeFile when --out set", async () => {
    const dir = await makeTempDir();
    const outPath = join(dir, "out.csv");
    const writes: Array<{ path: string; contents: string | Uint8Array }> = [];

    const result = await exportWorkLogs({
      format: "csv",
      out: outPath,
      config: configWith(FIXTURE_PATH),
      writeFile: async (path, contents) => {
        writes.push({ path, contents });
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(outPath);
    expect(writes[0]?.contents).toBe(result.body as string);
    expect(result.summary.path).toBe(outPath);
  });

  test("translates file-write failure into AppError export-write", async () => {
    const dir = await makeTempDir();
    const outPath = join(dir, "out.csv");

    await expect(
      exportWorkLogs({
        format: "csv",
        out: outPath,
        config: configWith(FIXTURE_PATH),
        writeFile: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toEqual(
      new AppError(
        "export-write",
        `Failed to write export to ${outPath}: disk full`,
      ),
    );
  });

  test("rejects missing --format with export-format", async () => {
    await expect(
      exportWorkLogs({ config: configWith(FIXTURE_PATH) }),
    ).rejects.toMatchObject({ code: "export-format" });
  });

  test("rejects unknown --format with export-format", async () => {
    await expect(
      exportWorkLogs({ format: "ods", config: configWith(FIXTURE_PATH) }),
    ).rejects.toMatchObject({ code: "export-format" });
  });

  test("honors --from + --status combined", async () => {
    const result = await exportWorkLogs({
      format: "csv",
      from: "2026-05-20",
      status: "pending",
      config: configWith(FIXTURE_PATH),
    });
    expect(result.summary.rows).toBe(2);
    const body = result.body as string;
    expect(body).toContain("1716300000.000200#0");
    expect(body).toContain("1716500000.000400#0");
    expect(body).not.toContain("1716200000.000100#0");
    expect(body).not.toContain("1716400000.000300#0");
  });
});
