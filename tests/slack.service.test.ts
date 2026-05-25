import { describe, expect, test } from "bun:test";
import {
  fetchSlackMessages,
  resolveSlackDateRange,
} from "../src/services/slack.service.ts";

describe("Slack service", () => {
  test("resolves lastweek to seven days before now", () => {
    const now = new Date("2026-05-24T12:00:00.000Z");

    expect(resolveSlackDateRange("lastweek", "now", now)).toEqual({
      from: "2026-05-17T12:00:00.000Z",
      to: "2026-05-24T12:00:00.000Z",
      oldest: "1779019200",
      latest: "1779624000",
    });
  });

  test("expands bare YYYY-MM-DD to local start- and end-of-day", () => {
    const now = new Date("2026-05-25T12:00:00.000Z");
    const range = resolveSlackDateRange("2026-05-25", "2026-05-25", now);

    const expectedFrom = new Date(2026, 4, 25, 0, 0, 0, 0);
    const expectedTo = new Date(2026, 4, 25, 23, 59, 59, 999);

    expect(range.from).toBe(expectedFrom.toISOString());
    expect(range.to).toBe(expectedTo.toISOString());
    expect(range.oldest).toBe(String(expectedFrom.getTime() / 1000));
    expect(range.latest).toBe(String(expectedTo.getTime() / 1000));
    expect(range.oldest).not.toBe(range.latest);
  });

  test("uses injected gateways for tests instead of live Slack calls", async () => {
    const messages = await fetchSlackMessages(
      { from: "lastweek", to: "now" },
      {
        fetchMessages: async () => [
          {
            ts: "1716200000.000100",
            channel: "CWORKLOG",
            userId: "U123LOG",
            text: "Wrote Slack fetch tests",
            raw: {},
            fetchedAt: "2026-05-24T12:00:00.000Z",
          },
        ],
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("Wrote Slack fetch tests");
  });
});
