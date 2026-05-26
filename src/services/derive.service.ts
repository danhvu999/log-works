import { loadConfig, resolveStoragePath } from "../config/config.manager.ts";
import type {
  DeriveSummary,
  LogWorksConfig,
  RawSlackMessage,
} from "../types/index.ts";
import { computeNetdokHint } from "./netdok-hint.service.ts";
import {
  applyDateHint,
  extractDateHint,
  parseMessageText,
} from "./parser.service.ts";
import { readDatabase, writeDatabase } from "./storage.service.ts";

export interface DeriveWorkLogsInput {
  from?: string;
  to?: string;
  config?: LogWorksConfig;
}

export async function deriveWorkLogs(
  input: DeriveWorkLogsInput = {},
): Promise<DeriveSummary> {
  const config = input.config ?? (await loadConfig());
  const storagePath = resolveStoragePath(config);
  const database = await readDatabase(storagePath);
  const existing = new Set(database.workLogs.map((entry) => entry.id));

  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  const projectsInRange = new Set<string>();

  for (const message of database.rawMessages) {
    const date = effectiveDateForMessage(message);
    if (input.from && date < input.from) continue;
    if (input.to && date > input.to) continue;

    processed += 1;
    for (const parsed of parseMessageText(message.text)) {
      projectsInRange.add(parsed.project);
      const id = `${message.ts}#${parsed.index}`;
      if (existing.has(id)) {
        skipped += 1;
        continue;
      }
      database.workLogs.push({
        id,
        sourceTs: message.ts,
        date,
        project: parsed.project,
        text: parsed.text,
        hours: parsed.hours,
        status: "pending",
        source: "rule",
      });
      existing.add(id);
      inserted += 1;
    }
  }

  await writeDatabase(storagePath, database);

  const netdokHint = computeNetdokHint(config, projectsInRange);

  return {
    processed,
    inserted,
    skipped,
    storagePath,
    from: input.from,
    to: input.to,
    ...(netdokHint ? { netdokHint } : {}),
  };
}

export function dateForRawMessage(message: RawSlackMessage): string {
  const seconds = Number(message.ts.split(".")[0]);
  if (!Number.isFinite(seconds)) {
    return message.fetchedAt.slice(0, 10);
  }
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function effectiveDateForMessage(message: RawSlackMessage): string {
  const base = dateForRawMessage(message);
  const hint = extractDateHint(message.text);
  return hint ? applyDateHint(base, hint) : base;
}
