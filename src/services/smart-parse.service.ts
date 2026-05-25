import { z } from "zod";
import { loadConfig, resolveStoragePath } from "../config/config.manager.ts";
import { AppError } from "../errors.ts";
import type {
  Database,
  LogWorksConfig,
  ParseEvaluation,
  SmartIngestEntryResult,
  SmartIngestInputEntry,
  SmartIngestSummary,
  UnparsedListResult,
  UnparsedRawMessage,
} from "../types/index.ts";
import { effectiveDateForMessage } from "./derive.service.ts";
import { evaluateMessage } from "./parser.service.ts";
import { readDatabase, writeDatabase } from "./storage.service.ts";

export interface ListUnparsedInput {
  from?: string;
  to?: string;
  includePartial?: boolean;
  config?: LogWorksConfig;
}

export interface IngestSmartEntriesInput {
  entries: SmartIngestInputEntry[];
  config?: LogWorksConfig;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const ingestEntrySchema = z.object({
  sourceTs: z.string().min(1),
  index: z.number().int().nonnegative().optional(),
  date: z.string().regex(DATE_PATTERN, "date must be YYYY-MM-DD").optional(),
  project: z.string().min(1),
  text: z.string().min(1),
  hours: z.number().positive().nullable().optional(),
});

const ingestEntriesSchema = z.array(ingestEntrySchema).min(1);

export async function listUnparsedMessages(
  input: ListUnparsedInput = {},
): Promise<UnparsedListResult> {
  const config = input.config ?? (await loadConfig());
  const storagePath = resolveStoragePath(config);
  const database = await readDatabase(storagePath);
  const includePartial = input.includePartial ?? true;

  const messages: UnparsedRawMessage[] = [];

  for (const message of database.rawMessages) {
    const date = effectiveDateForMessage(message);
    if (input.from && date < input.from) continue;
    if (input.to && date > input.to) continue;

    const evaluation: ParseEvaluation = evaluateMessage(message.text);
    const isEmpty = evaluation.status === "empty";
    const isPartial = evaluation.status === "partial";
    if (!isEmpty && !(includePartial && isPartial)) continue;

    messages.push({
      ts: message.ts,
      channel: message.channel,
      date,
      text: message.text,
      status: evaluation.status,
      flags: evaluation.flags,
      ruleEntries: evaluation.entries.length,
    });
  }

  return {
    messages,
    storagePath,
    from: input.from,
    to: input.to,
  };
}

export async function ingestSmartEntries(
  input: IngestSmartEntriesInput,
): Promise<SmartIngestSummary> {
  const config = input.config ?? (await loadConfig());
  const storagePath = resolveStoragePath(config);

  const parsed = ingestEntriesSchema.safeParse(input.entries);
  if (!parsed.success) {
    throw new AppError(
      "smart-parse-invalid",
      `Invalid smart entries: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  const entries = parsed.data;

  const database = await readDatabase(storagePath);
  const messagesByTs = new Map(
    database.rawMessages.map((message) => [message.ts, message] as const),
  );
  const existingIds = new Set(database.workLogs.map((entry) => entry.id));
  const nextSmartIndex = new Map<string, number>();

  const results: SmartIngestEntryResult[] = [];
  let inserted = 0;
  let skipped = 0;

  for (const entry of entries) {
    const source = messagesByTs.get(entry.sourceTs);
    if (!source) {
      throw new AppError(
        "smart-parse-invalid",
        `Unknown sourceTs '${entry.sourceTs}'. Run fetch first.`,
      );
    }

    const index = entry.index ?? nextSmartIndex.get(entry.sourceTs) ?? 0;
    if (entry.index === undefined) {
      nextSmartIndex.set(entry.sourceTs, index + 1);
    }
    const id = `${entry.sourceTs}#smart-${index}`;
    const date = entry.date ?? effectiveDateForMessage(source);

    if (existingIds.has(id)) {
      results.push({
        id,
        sourceTs: entry.sourceTs,
        index,
        date,
        project: entry.project,
        status: "skipped-duplicate",
      });
      skipped += 1;
      continue;
    }

    database.workLogs.push({
      id,
      sourceTs: entry.sourceTs,
      date,
      project: entry.project,
      text: entry.text,
      hours: entry.hours ?? null,
      status: "pending",
      source: "smart",
    });
    existingIds.add(id);
    results.push({
      id,
      sourceTs: entry.sourceTs,
      index,
      date,
      project: entry.project,
      status: "inserted",
    });
    inserted += 1;
  }

  await writeDatabase(storagePath, database satisfies Database);

  return {
    entries: results,
    inserted,
    skipped,
    storagePath,
  };
}
