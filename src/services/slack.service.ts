import { ErrorCode as SlackErrorCode, WebClient } from "@slack/web-api";
import type { ConversationsHistoryResponse } from "@slack/web-api/dist/types/response/ConversationsHistoryResponse";
import { AppError } from "../errors.ts";
import type { RawSlackMessage } from "../types/index.ts";

export interface FetchSlackMessagesInput {
  from?: string;
  to?: string;
  channel?: string;
  channels?: string[];
  userToken?: string;
  userId?: string;
  now?: Date;
}

export interface SlackGateway {
  fetchMessages(input: FetchSlackMessagesInput): Promise<RawSlackMessage[]>;
}

export const SELF_DM_TOKENS = new Set(["self", "@self", "me", "@me"]);

function isSelfDmToken(value: string): boolean {
  return SELF_DM_TOKENS.has(value.toLowerCase());
}

export async function fetchSlackMessages(
  input: FetchSlackMessagesInput,
  gateway?: SlackGateway,
): Promise<RawSlackMessage[]> {
  if (gateway) {
    return gateway.fetchMessages(input);
  }

  if (!input.userToken) {
    throw new AppError("slack-auth", "Slack gateway is not configured");
  }

  if (!input.userId) {
    throw new AppError("config-missing", "Missing slack.userId");
  }

  const client = new WebClient(input.userToken);
  const channels = await expandSelfDmChannels(
    resolveChannels(input),
    client,
    input.userId,
  );
  const range = resolveSlackDateRange(input.from, input.to, input.now);
  const fetchedAt = new Date().toISOString();
  const messages: RawSlackMessage[] = [];

  for (const channel of channels) {
    messages.push(
      ...(await fetchChannelMessages({
        client,
        channel,
        userId: input.userId,
        range,
        fetchedAt,
      })),
    );
  }

  return messages;
}

async function expandSelfDmChannels(
  channels: string[],
  client: WebClient,
  userId: string,
): Promise<string[]> {
  const out: string[] = [];
  let selfDmId: string | undefined;
  for (const channel of channels) {
    if (!isSelfDmToken(channel)) {
      out.push(channel);
      continue;
    }
    if (!selfDmId) {
      selfDmId = await resolveSelfDmChannelId(client, userId);
    }
    out.push(selfDmId);
  }
  return out;
}

async function resolveSelfDmChannelId(
  client: WebClient,
  userId: string,
): Promise<string> {
  try {
    const response = await client.conversations.open({ users: userId });
    const id = response.channel?.id;
    if (!id) {
      throw new AppError(
        "slack-auth",
        "Slack did not return a channel id for self DM",
      );
    }
    return id;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw mapSlackError(error);
  }
}

export interface SlackDateRange {
  from?: string;
  to?: string;
  oldest?: string;
  latest?: string;
}

export function resolveSlackDateRange(
  from?: string,
  to?: string,
  now = new Date(),
): SlackDateRange {
  const resolvedFrom = parseDateShortcut(from, now, "from");
  const resolvedTo = parseDateShortcut(to, now, "to");

  return {
    from: resolvedFrom?.toISOString(),
    to: resolvedTo?.toISOString(),
    oldest: resolvedFrom ? toSlackTimestamp(resolvedFrom) : undefined,
    latest: resolvedTo ? toSlackTimestamp(resolvedTo) : undefined,
  };
}

function resolveChannels(input: FetchSlackMessagesInput): string[] {
  const channels = input.channel ? [input.channel] : (input.channels ?? []);

  if (channels.length === 0) {
    throw new AppError("config-missing", "Missing slack.channels");
  }

  return channels;
}

async function fetchChannelMessages(input: {
  client: WebClient;
  channel: string;
  userId: string;
  range: SlackDateRange;
  fetchedAt: string;
}): Promise<RawSlackMessage[]> {
  const messages: RawSlackMessage[] = [];
  let cursor: string | undefined;

  try {
    do {
      const response = (await input.client.conversations.history({
        channel: input.channel,
        cursor,
        inclusive: true,
        latest: input.range.latest,
        limit: 200,
        oldest: input.range.oldest,
      })) as ConversationsHistoryResponse;

      for (const message of response.messages ?? []) {
        if (!message.ts || message.user !== input.userId) {
          continue;
        }

        messages.push({
          ts: message.ts,
          channel: input.channel,
          userId: message.user,
          text: message.text ?? "",
          raw: message,
          fetchedAt: input.fetchedAt,
        });
      }

      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    throw mapSlackError(error);
  }

  return messages;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateShortcut(
  value: string | undefined,
  now: Date,
  boundary: "from" | "to" = "from",
): Date | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "now") {
    return now;
  }

  if (value === "lastweek" || value === "last-week") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }

  if (DATE_ONLY_PATTERN.test(value)) {
    const [year, month, day] = value.split("-").map(Number) as [
      number,
      number,
      number,
    ];
    return boundary === "to"
      ? new Date(year, month - 1, day, 23, 59, 59, 999)
      : new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("config-missing", `Invalid date: ${value}`);
  }

  return parsed;
}

function toSlackTimestamp(date: Date): string {
  return String(date.getTime() / 1000);
}

function mapSlackError(error: unknown): AppError {
  if (isSlackError(error, SlackErrorCode.RateLimitedError)) {
    return new AppError(
      "slack-rate-limit",
      `Slack rate limit reached. Retry after ${error.retryAfter} seconds.`,
    );
  }

  if (
    isSlackError(error, SlackErrorCode.PlatformError) &&
    typeof error.data.error === "string" &&
    error.data.error.includes("auth")
  ) {
    return new AppError(
      "slack-auth",
      `Slack authentication failed: ${error.data.error}`,
    );
  }

  if (error instanceof Error) {
    return new AppError("slack-auth", error.message);
  }

  return new AppError("slack-auth", "Slack request failed");
}

function isSlackError<TCode extends SlackErrorCode>(
  error: unknown,
  code: TCode,
): error is Error & {
  code: TCode;
  data: { error: string };
  retryAfter: number;
} {
  return error instanceof Error && "code" in error && error.code === code;
}
