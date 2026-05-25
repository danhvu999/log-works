import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestSmartEntries,
  listUnparsedMessages,
} from "../src/services/smart-parse.service.ts";
import {
  emptyDatabase,
  upsertRawMessages,
  writeDatabase,
} from "../src/services/storage.service.ts";
import type {
  Database,
  LogWorksConfig,
  RawSlackMessage,
} from "../src/types/index.ts";

let tempDir: string | undefined;

async function makeTempDb(messages: RawSlackMessage[]): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-smart-"));
  const dbPath = join(tempDir, "db.json");
  const { database } = upsertRawMessages(emptyDatabase(), messages);
  await writeDatabase(dbPath, database);
  return dbPath;
}

async function loadMalformedFixture(): Promise<RawSlackMessage[]> {
  return JSON.parse(
    await readFile("fixtures/slack/messages.malformed.json", "utf8"),
  ) as RawSlackMessage[];
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("smart-parse — listUnparsedMessages", () => {
  test("returns empty + partial messages with flags and status", async () => {
    const messages = await loadMalformedFixture();
    const dbPath = await makeTempDb(messages);
    const config: LogWorksConfig = { storage: { path: dbPath } };

    const result = await listUnparsedMessages({ config });

    expect(result.messages).toHaveLength(messages.length);
    const byTs = new Map(result.messages.map((m) => [m.ts, m] as const));
    expect(byTs.get("1716400000.000001")?.status).toBe("empty");
    expect(byTs.get("1716400001.000002")?.flags.hasDebriefMarker).toBe(true);
    expect(byTs.get("1716400002.000003")?.status).toBe("partial");
    expect(byTs.get("1716400002.000003")?.flags.missingHours).toBe(true);
  });

  test("excludes partial messages when includePartial=false", async () => {
    const messages = await loadMalformedFixture();
    const dbPath = await makeTempDb(messages);
    const config: LogWorksConfig = { storage: { path: dbPath } };

    const result = await listUnparsedMessages({
      config,
      includePartial: false,
    });

    expect(result.messages.every((m) => m.status === "empty")).toBe(true);
    expect(result.messages).toHaveLength(2);
  });

  test("does not include rule-parseable messages", async () => {
    const message: RawSlackMessage = {
      ts: "1716000000.000999",
      channel: "CWORKLOG",
      userId: "U123LOG",
      text: "Debrief:\nVenulog\n• Shipped [2h]",
      raw: {},
      fetchedAt: "2026-05-25T00:00:00.000Z",
    };
    const dbPath = await makeTempDb([message]);
    const result = await listUnparsedMessages({
      config: { storage: { path: dbPath } },
    });
    expect(result.messages).toHaveLength(0);
  });
});

describe("smart-parse — ingestSmartEntries", () => {
  test("inserts entries with source=smart and auto-assigned smart index", async () => {
    const messages = await loadMalformedFixture();
    const dbPath = await makeTempDb(messages);
    const config: LogWorksConfig = { storage: { path: dbPath } };

    const summary = await ingestSmartEntries({
      config,
      entries: [
        {
          sourceTs: "1716400000.000001",
          project: "Venulog",
          text: "Fixed invoice line bug",
          hours: 2,
        },
        {
          sourceTs: "1716400000.000001",
          project: "Metabase",
          text: "Checked pipeline",
          hours: null,
        },
      ],
    });

    expect(summary.inserted).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.entries[0]?.id).toBe("1716400000.000001#smart-0");
    expect(summary.entries[1]?.id).toBe("1716400000.000001#smart-1");

    const final = JSON.parse(await readFile(dbPath, "utf8")) as Database;
    const inserted = final.workLogs.filter(
      (e) => e.sourceTs === "1716400000.000001",
    );
    expect(inserted).toHaveLength(2);
    expect(inserted.every((e) => e.source === "smart")).toBe(true);
    expect(inserted.every((e) => e.status === "pending")).toBe(true);
  });

  test("is idempotent: re-ingesting the same explicit index skips duplicates", async () => {
    const messages = await loadMalformedFixture();
    const dbPath = await makeTempDb(messages);
    const config: LogWorksConfig = { storage: { path: dbPath } };

    const payload = {
      config,
      entries: [
        {
          sourceTs: "1716400000.000001",
          index: 0,
          project: "Venulog",
          text: "Fixed invoice line bug",
          hours: 2,
        },
      ],
    };

    const first = await ingestSmartEntries(payload);
    const second = await ingestSmartEntries(payload);

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.entries[0]?.status).toBe("skipped-duplicate");
  });

  test("rejects entries missing required fields with smart-parse-invalid", async () => {
    const messages = await loadMalformedFixture();
    const dbPath = await makeTempDb(messages);
    const config: LogWorksConfig = { storage: { path: dbPath } };

    let caught: unknown;
    try {
      await ingestSmartEntries({
        config,
        // biome-ignore lint/suspicious/noExplicitAny: deliberate bad payload for test
        entries: [{ sourceTs: "1716400000.000001", text: "" } as any],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string })?.code).toBe("smart-parse-invalid");
  });

  test("rejects entries pointing at unknown sourceTs", async () => {
    const dbPath = await makeTempDb([]);
    const config: LogWorksConfig = { storage: { path: dbPath } };

    let caught: unknown;
    try {
      await ingestSmartEntries({
        config,
        entries: [
          {
            sourceTs: "9999999999.000000",
            project: "Venulog",
            text: "ghost",
            hours: 1,
          },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe("smart-parse-invalid");
  });
});
