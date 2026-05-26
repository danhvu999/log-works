import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWorkLogs } from "../src/services/fetch.service.ts";
import type { SlackGateway } from "../src/services/slack.service.ts";
import type { Database, LogWorksConfig } from "../src/types/index.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function makeTempStoragePath(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-fetch-"));
  return join(tempDir, "db.json");
}

const baseConfig = (storagePath: string): LogWorksConfig => ({
  slack: {
    userToken: "xoxp-test",
    userId: "U123LOG",
    channels: ["CWORKLOG"],
  },
  storage: { path: storagePath },
});

function mixedGateway(): SlackGateway {
  return {
    async fetchMessages() {
      const fetchedAt = "2026-05-24T12:00:00.000Z";
      return [
        {
          ts: "1716000000.000001",
          channel: "CWORKLOG",
          userId: "U123LOG",
          text: "Debrief:\nMetabase\n• Shipped fix [1h]",
          raw: {},
          fetchedAt,
        },
        {
          ts: "1716000000.000002",
          channel: "CWORKLOG",
          userId: "U123LOG",
          text: "Brief:\nMetabase\n• Plan migration [2h]",
          raw: {},
          fetchedAt,
        },
        {
          ts: "1716000000.000003",
          channel: "CWORKLOG",
          userId: "U123LOG",
          text: "lunch?",
          raw: {},
          fetchedAt,
        },
      ];
    },
  };
}

describe("fetchWorkLogs debrief filter", () => {
  test("default fetch keeps only messages containing `debrief`", async () => {
    const storagePath = await makeTempStoragePath();
    const summary = await fetchWorkLogs({
      config: baseConfig(storagePath),
      gateway: mixedGateway(),
    });

    expect(summary.fetched).toBe(1);
    expect(summary.inserted).toBe(1);
    expect(summary.droppedNonDebrief).toBe(2);

    const written = JSON.parse(await readFile(storagePath, "utf8")) as Database;
    expect(written.rawMessages).toHaveLength(1);
    expect(written.rawMessages[0]?.text.toLowerCase()).toContain("debrief");
  });

  test("includeNonDebrief=true keeps every authored message", async () => {
    const storagePath = await makeTempStoragePath();
    const summary = await fetchWorkLogs({
      config: baseConfig(storagePath),
      gateway: mixedGateway(),
      includeNonDebrief: true,
    });

    expect(summary.fetched).toBe(3);
    expect(summary.droppedNonDebrief).toBe(0);

    const written = JSON.parse(await readFile(storagePath, "utf8")) as Database;
    expect(written.rawMessages).toHaveLength(3);
  });

  test("re-fetching the same gateway response is idempotent on Slack ts", async () => {
    const storagePath = await makeTempStoragePath();
    const config = baseConfig(storagePath);
    const gateway = mixedGateway();

    await fetchWorkLogs({ config, gateway });
    const second = await fetchWorkLogs({ config, gateway });

    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.droppedNonDebrief).toBe(2);
  });
});
