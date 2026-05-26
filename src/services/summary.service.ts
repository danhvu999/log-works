import { loadConfig, resolveStoragePath } from "../config/config.manager.ts";
import type {
  LogWorksConfig,
  SummaryProjectStat,
  SummaryResult,
} from "../types/index.ts";
import { effectiveDateForMessage } from "./derive.service.ts";
import { readDatabase } from "./storage.service.ts";

export interface SummarizeStorageInput {
  from?: string;
  to?: string;
  config?: LogWorksConfig;
}

interface MutableProjectStat {
  project: string;
  entries: number;
  hours: number;
  dateMin: string;
  dateMax: string;
}

function inRange(date: string, from?: string, to?: string): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export async function summarizeStorage(
  input: SummarizeStorageInput = {},
): Promise<SummaryResult> {
  const config = input.config ?? (await loadConfig());
  const storagePath = resolveStoragePath(config);
  const database = await readDatabase(storagePath);

  let rawMessages = 0;
  for (const message of database.rawMessages) {
    const date = effectiveDateForMessage(message);
    if (inRange(date, input.from, input.to)) rawMessages += 1;
  }

  const projects = new Map<string, MutableProjectStat>();
  let workLogs = 0;
  let totalHours = 0;
  let dateMin: string | null = null;
  let dateMax: string | null = null;

  for (const entry of database.workLogs) {
    if (!inRange(entry.date, input.from, input.to)) continue;
    workLogs += 1;
    const hours = entry.hours ?? 0;
    totalHours += hours;
    if (dateMin === null || entry.date < dateMin) dateMin = entry.date;
    if (dateMax === null || entry.date > dateMax) dateMax = entry.date;

    const stat = projects.get(entry.project);
    if (stat) {
      stat.entries += 1;
      stat.hours += hours;
      if (entry.date < stat.dateMin) stat.dateMin = entry.date;
      if (entry.date > stat.dateMax) stat.dateMax = entry.date;
    } else {
      projects.set(entry.project, {
        project: entry.project,
        entries: 1,
        hours,
        dateMin: entry.date,
        dateMax: entry.date,
      });
    }
  }

  const sortedProjects: SummaryProjectStat[] = [...projects.values()].sort(
    (a, b) => {
      if (b.hours !== a.hours) return b.hours - a.hours;
      return a.project.localeCompare(b.project);
    },
  );

  return {
    totals: {
      rawMessages,
      workLogs,
      totalHours: roundHours(totalHours),
      uniqueProjects: sortedProjects.length,
      dateMin,
      dateMax,
    },
    projects: sortedProjects.map((stat) => ({
      ...stat,
      hours: roundHours(stat.hours),
    })),
    storagePath,
    from: input.from,
    to: input.to,
  };
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}
