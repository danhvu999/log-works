import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import {
  groupByDateThenProject,
  renderXlsx,
} from "../src/services/export-xlsx.ts";
import type { Database } from "../src/types/index.ts";

const FIXTURE_PATH = "fixtures/storage/db.export-mixed.json";

async function loadFixture(): Promise<Database> {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Database;
}

describe("export-xlsx — groupByDateThenProject", () => {
  test("groups deterministically by date then project (ascending)", async () => {
    const db = await loadFixture();
    const grouped = groupByDateThenProject(db.workLogs);
    expect([...grouped.keys()]).toEqual([
      "2026-05-18",
      "2026-05-20",
      "2026-05-22",
      "2026-05-24",
    ]);
    expect([...(grouped.get("2026-05-18") ?? new Map()).keys()]).toEqual([
      "Metabase",
      "Venulog",
    ]);
  });
});

describe("export-xlsx — renderXlsx", () => {
  test("produces a zip-shaped Uint8Array", async () => {
    const db = await loadFixture();
    const buffer = await renderXlsx(db.workLogs);
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });

  test("workbook contains expected header row, groupings, and TOTAL formula", async () => {
    const db = await loadFixture();
    const buffer = await renderXlsx(db.workLogs);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer.buffer as ArrayBuffer);
    const ws = wb.getWorksheet("Work logs");
    expect(ws).toBeDefined();
    if (!ws) return;

    expect(ws.getCell("A1").value).toBe("Date");
    expect(ws.getCell("B1").value).toBe("Project");
    expect(ws.getCell("C1").value).toBe("Task");
    expect(ws.getCell("D1").value).toBe("Hours");

    // Find TOTAL row
    let totalRow: ExcelJS.Row | undefined;
    ws.eachRow((row) => {
      if (row.getCell("C").value === "TOTAL") {
        totalRow = row;
      }
    });
    expect(totalRow).toBeDefined();
    const totalFormula = totalRow?.getCell("D").value as {
      formula?: string;
    } | null;
    expect(totalFormula?.formula).toMatch(/^SUM\(D2:D\d+\)$/);

    // Date header rows appear
    const dateCells: unknown[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const v = row.getCell("A").value;
      if (v) dateCells.push(v);
    });
    expect(dateCells).toEqual([
      "2026-05-18",
      "2026-05-20",
      "2026-05-22",
      "2026-05-24",
    ]);
  });
});
