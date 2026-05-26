import { loadConfig, resolveStoragePath } from "../config/config.manager.ts";
import type {
  LogWorksConfig,
  SummaryProjectAggregate,
  SummaryResult,
  SummaryTotals,
  WorkLogEntry,
} from "../types/index.ts";
import { filterWorkLogs } from "./export.service.ts";
import { readDatabase } from "./storage.service.ts";

export interface SummarizeStorageInput {
  from?: string;
  to?: string;
  config?: LogWorksConfig;
}

export async function summarizeStorage(
  input: SummarizeStorageInput = {},
): Promise<SummaryResult> {
  const config = input.config ?? (await loadConfig());
  const storagePath = resolveStoragePath(config);
  const database = await readDatabase(storagePath);

  const entries = filterWorkLogs(database.workLogs, {
    from: input.from,
    to: input.to,
  });

  const projects = aggregateByProject(entries);
  const totals = computeTotals(projects);

  return {
    projects,
    totals,
    storagePath,
    from: input.from,
    to: input.to,
  };
}

function aggregateByProject(
  entries: WorkLogEntry[],
): SummaryProjectAggregate[] {
  const buckets = new Map<string, SummaryProjectAggregate>();
  for (const entry of entries) {
    let bucket = buckets.get(entry.project);
    if (!bucket) {
      bucket = {
        project: entry.project,
        entries: 0,
        hours: 0,
        entriesWithoutHours: 0,
        firstDate: entry.date,
        lastDate: entry.date,
      };
      buckets.set(entry.project, bucket);
    }
    bucket.entries += 1;
    if (entry.hours === null || entry.hours === undefined) {
      bucket.entriesWithoutHours += 1;
    } else {
      bucket.hours += entry.hours;
    }
    if (entry.date < bucket.firstDate) bucket.firstDate = entry.date;
    if (entry.date > bucket.lastDate) bucket.lastDate = entry.date;
  }
  return [...buckets.values()].sort((a, b) =>
    a.project.localeCompare(b.project),
  );
}

function computeTotals(projects: SummaryProjectAggregate[]): SummaryTotals {
  const totals: SummaryTotals = {
    entries: 0,
    hours: 0,
    entriesWithoutHours: 0,
  };
  for (const p of projects) {
    totals.entries += p.entries;
    totals.hours += p.hours;
    totals.entriesWithoutHours += p.entriesWithoutHours;
  }
  return totals;
}
