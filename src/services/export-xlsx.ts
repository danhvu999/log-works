import type { WorkLogEntry } from "../types/index.ts";

export async function renderXlsx(entries: WorkLogEntry[]): Promise<Uint8Array> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet("Work logs");

  ws.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Project", key: "project", width: 18 },
    { header: "Task", key: "task", width: 80 },
    { header: "Hours", key: "hours", width: 8 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = "A1:D1";

  for (const [date, projects] of groupByDateThenProject(entries)) {
    const dateRow = ws.addRow({ date });
    dateRow.font = { bold: true, size: 12 };
    for (const [project, items] of projects) {
      const projRow = ws.addRow({ project });
      projRow.font = { bold: true };
      for (const entry of items) {
        const row = ws.addRow({
          task: entry.text,
          hours: entry.hours,
        });
        row.getCell("task").alignment = { wrapText: true, vertical: "top" };
      }
    }
  }

  const lastDataRow = ws.lastRow?.number ?? 1;
  const totalRow = ws.addRow({
    task: "TOTAL",
    hours: { formula: `SUM(D2:D${lastDataRow})` },
  });
  totalRow.font = { bold: true };

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

export function groupByDateThenProject(
  entries: WorkLogEntry[],
): Map<string, Map<string, WorkLogEntry[]>> {
  const sorted = [...entries].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.project !== b.project) return a.project < b.project ? -1 : 1;
    return 0;
  });

  const grouped = new Map<string, Map<string, WorkLogEntry[]>>();
  for (const entry of sorted) {
    let byProject = grouped.get(entry.date);
    if (!byProject) {
      byProject = new Map();
      grouped.set(entry.date, byProject);
    }
    let bucket = byProject.get(entry.project);
    if (!bucket) {
      bucket = [];
      byProject.set(entry.project, bucket);
    }
    bucket.push(entry);
  }
  return grouped;
}
