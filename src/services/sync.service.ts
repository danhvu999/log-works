import type { FetchSlackMessagesInput } from "./slack.service.ts";

export interface SyncServices {
  fetch(input: FetchSlackMessagesInput): Promise<{ fetched: number }>;
  post(input: { from?: string; to?: string }): Promise<{ posted: number }>;
}

export async function syncWorkLogs(
  input: FetchSlackMessagesInput,
  services: SyncServices,
): Promise<{ fetched: number; posted: number }> {
  const fetchResult = await services.fetch(input);
  const postResult = await services.post({ from: input.from, to: input.to });

  return {
    fetched: fetchResult.fetched,
    posted: postResult.posted,
  };
}
