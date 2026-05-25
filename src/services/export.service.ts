import { writeFile as defaultWriteFile } from "node:fs/promises";
import { loadConfig, resolveStoragePath } from "../config/config.manager.ts";
import { AppError } from "../errors.ts";
import {
  EXPORT_FORMATS,
  type ExportFormat,
  type ExportSummary,
  type LogWorksConfig,
  type WorkLogEntry,
  type WorkLogStatus,
} from "../types/index.ts";
import { renderXlsx } from "./export-xlsx.ts";
import { readDatabase } from "./storage.service.ts";

const CSV_COLUMNS = [
  "id",
  "date",
  "project",
  "hours",
  "text",
  "status",
  "lastError",
  "postedAt",
  "sourceTs",
] as const satisfies ReadonlyArray<keyof WorkLogEntry>;

export interface ExportWorkLogsInput {
  format?: string;
  from?: string;
  to?: string;
  status?: string;
  out?: string;
  config?: LogWorksConfig;
  writeFile?: (path: string, contents: string | Uint8Array) => Promise<void>;
}

export interface ExportResult {
  summary: ExportSummary;
  body: string | Uint8Array;
}

export async function exportWorkLogs(
  input: ExportWorkLogsInput = {},
): Promise<ExportResult> {
  const format = parseFormat(input.format);
  const status = parseStatus(input.status);

  const config = input.config ?? (await loadConfig());
  const storagePath = resolveStoragePath(config);
  const database = await readDatabase(storagePath);

  const entries = filterWorkLogs(database.workLogs, {
    from: input.from,
    to: input.to,
    status,
  });

  const body: string | Uint8Array =
    format === "xlsx"
      ? await renderXlsx(entries)
      : format === "json"
        ? renderJson(entries)
        : renderCsv(entries);

  let path: string | null = null;
  if (input.out) {
    const writeFile = input.writeFile ?? defaultWriteFile;
    try {
      await writeFile(input.out, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError(
        "export-write",
        `Failed to write export to ${input.out}: ${message}`,
      );
    }
    path = input.out;
  }

  return {
    body,
    summary: {
      format,
      rows: entries.length,
      path,
      from: input.from,
      to: input.to,
      status,
      storagePath,
    },
  };
}

export function filterWorkLogs(
  entries: WorkLogEntry[],
  filters: { from?: string; to?: string; status?: WorkLogStatus },
): WorkLogEntry[] {
  return entries.filter((entry) => {
    if (filters.from && entry.date < filters.from) {
      return false;
    }
    if (filters.to && entry.date > filters.to) {
      return false;
    }
    if (filters.status && entry.status !== filters.status) {
      return false;
    }
    return true;
  });
}

export function renderCsv(entries: WorkLogEntry[]): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.join(","));
  for (const entry of entries) {
    const row = CSV_COLUMNS.map((column) => escapeField(entry[column]));
    lines.push(row.join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function renderJson(entries: WorkLogEntry[]): string {
  return `${JSON.stringify({ rows: entries.length, entries }, null, 2)}\n`;
}

function escapeField(value: string | number | null | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number") {
    return String(value);
  }
  const needsQuotes = /[",\r\n]/.test(value);
  if (!needsQuotes) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function parseFormat(value: unknown): ExportFormat {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(
      "export-format",
      `Missing --format. Expected one of: ${EXPORT_FORMATS.join(", ")}`,
    );
  }
  if (!isExportFormat(value)) {
    throw new AppError(
      "export-format",
      `Unknown export format: ${value}. Expected one of: ${EXPORT_FORMATS.join(", ")}`,
    );
  }
  return value;
}

function parseStatus(value: unknown): WorkLogStatus | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "pending" || value === "sent" || value === "failed") {
    return value;
  }
  throw new AppError(
    "config-missing",
    `Unknown --status: ${String(value)}. Expected pending, sent, or failed.`,
  );
}

function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}
