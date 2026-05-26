import { loadConfig, resolveStoragePath } from "../config/config.manager.ts";
import type {
  LogWorksConfig,
  SummaryRawDebrief,
  SummaryResult,
} from "../types/index.ts";
import { isDebriefText } from "./debrief-filter.ts";
import { effectiveDateForMessage } from "./derive.service.ts";
import { readDatabase } from "./storage.service.ts";

export interface SummarizeStorageInput {
  from?: string;
  to?: string;
  config?: LogWorksConfig;
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

  const messages: SummaryRawDebrief[] = [];
  for (const message of database.rawMessages) {
    const date = effectiveDateForMessage(message);
    if (!inRange(date, input.from, input.to)) continue;
    if (!isDebriefText(message.text)) continue;
    messages.push({
      ts: message.ts,
      date,
      channel: message.channel,
      text: message.text,
    });
  }
  messages.sort((a, b) =>
    a.date === b.date ? a.ts.localeCompare(b.ts) : a.date.localeCompare(b.date),
  );

  return {
    messages,
    storagePath,
    from: input.from,
    to: input.to,
  };
}
