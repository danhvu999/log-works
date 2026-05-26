import { loadConfig, resolveStoragePath } from "../config/config.manager.ts";
import { AppError } from "../errors.ts";
import type { FetchSummary, LogWorksConfig } from "../types/index.ts";
import { isDebriefText } from "./debrief-filter.ts";
import { computeNetdokHint } from "./netdok-hint.service.ts";
import { evaluateMessage } from "./parser.service.ts";
import { type SlackGateway, fetchSlackMessages } from "./slack.service.ts";
import {
  readDatabase,
  upsertRawMessages,
  writeDatabase,
} from "./storage.service.ts";

export interface FetchWorkLogsInput {
  from?: string;
  to?: string;
  channel?: string;
  config?: LogWorksConfig;
  now?: Date;
  includeNonDebrief?: boolean;
  gateway?: SlackGateway;
}

export async function fetchWorkLogs(
  input: FetchWorkLogsInput = {},
): Promise<FetchSummary> {
  const config = input.config ?? (await loadConfig());
  const slack = config.slack;

  if (!slack?.userToken) {
    throw new AppError("config-missing", "Missing slack.userToken");
  }

  if (!slack.userId) {
    throw new AppError("config-missing", "Missing slack.userId");
  }

  const channels = input.channel ? [input.channel] : (slack.channels ?? []);
  if (channels.length === 0) {
    throw new AppError("config-missing", "Missing slack.channels");
  }

  const storagePath = resolveStoragePath(config);
  const rawMessages = await fetchSlackMessages(
    {
      channel: input.channel,
      channels,
      from: input.from,
      now: input.now,
      to: input.to,
      userId: slack.userId,
      userToken: slack.userToken,
    },
    input.gateway,
  );
  const includeNonDebrief = input.includeNonDebrief ?? false;
  const messages = includeNonDebrief
    ? rawMessages
    : rawMessages.filter((message) => isDebriefText(message.text));
  const droppedNonDebrief = rawMessages.length - messages.length;
  const database = await readDatabase(storagePath);
  const result = upsertRawMessages(database, messages);

  result.database.meta.lastFetchAt = new Date().toISOString();
  result.database.meta.lastFetchCursor = {
    ...(result.database.meta.lastFetchCursor ?? {}),
  };
  for (const message of messages) {
    result.database.meta.lastFetchCursor[message.channel] = message.ts;
  }

  await writeDatabase(storagePath, result.database);

  const projectsInRange = new Set<string>();
  for (const message of messages) {
    for (const entry of evaluateMessage(message.text).entries) {
      projectsInRange.add(entry.project);
    }
  }
  const netdokHint = computeNetdokHint(config, projectsInRange);

  return {
    fetched: messages.length,
    inserted: result.inserted,
    skipped: result.skipped,
    droppedNonDebrief,
    channels,
    from: input.from,
    to: input.to,
    storagePath,
    ...(netdokHint ? { netdokHint } : {}),
  };
}
