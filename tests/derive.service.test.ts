import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveWorkLogs } from "../src/services/derive.service.ts";
import {
  emptyDatabase,
  upsertRawMessages,
  writeDatabase,
} from "../src/services/storage.service.ts";
import type { Database, RawSlackMessage } from "../src/types/index.ts";

let tempDir: string | undefined;

async function makeTempDb(messages: RawSlackMessage[]): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-derive-"));
  const dbPath = join(tempDir, "db.json");
  const { database } = upsertRawMessages(emptyDatabase(), messages);
  await writeDatabase(dbPath, database);
  return dbPath;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function loadDebriefFixture(): Promise<RawSlackMessage[]> {
  const fixture = JSON.parse(
    await readFile("fixtures/slack/messages.debrief.json", "utf8"),
  );
  return fixture as RawSlackMessage[];
}

describe("derive service", () => {
  test("processes raw messages, skips Brief content, populates workLogs", async () => {
    const messages = await loadDebriefFixture();
    const dbPath = await makeTempDb(messages);

    const summary = await deriveWorkLogs({
      config: { storage: { path: dbPath } },
    });

    expect(summary.processed).toBe(messages.length);
    expect(summary.inserted).toBeGreaterThan(0);
    expect(summary.skipped).toBe(0);

    const final = JSON.parse(await readFile(dbPath, "utf8")) as Database;
    // None of the Brief-only or Brief-section text should leak in.
    for (const entry of final.workLogs) {
      expect(entry.text).not.toContain("Plan migration");
      expect(entry.text).not.toContain("Plan next sprint");
    }
    expect(final.workLogs.some((e) => e.project === "Metabase")).toBe(true);
    expect(final.workLogs.some((e) => e.project === "Venulog")).toBe(true);
  });

  test("is idempotent: second run inserts nothing", async () => {
    const messages = await loadDebriefFixture();
    const dbPath = await makeTempDb(messages);
    const config = { storage: { path: dbPath } };

    const first = await deriveWorkLogs({ config });
    const second = await deriveWorkLogs({ config });

    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first.inserted);
  });

  test("attaches netdokHint when Netdok is unconfigured", async () => {
    const messages = await loadDebriefFixture();
    const dbPath = await makeTempDb(messages);

    const summary = await deriveWorkLogs({
      config: { storage: { path: dbPath } },
    });

    expect(summary.netdokHint).toBeDefined();
    expect(summary.netdokHint?.configured).toBe(false);
    expect(summary.netdokHint?.unmappedProjects).toEqual(
      expect.arrayContaining(["Metabase", "Venulog"]),
    );
    expect(summary.netdokHint?.suggestion).toMatch(/setup_netdok_discover/);
  });

  test("attaches netdokHint listing only unmapped projects when partly mapped", async () => {
    const messages = await loadDebriefFixture();
    const dbPath = await makeTempDb(messages);

    const summary = await deriveWorkLogs({
      config: {
        storage: { path: dbPath },
        netdok: {
          apiKey: "k",
          workspaceId: "w",
          profileId: "p",
          projects: {
            Venulog: { projectId: "proj-v" },
          },
        },
      },
    });

    expect(summary.netdokHint).toBeDefined();
    expect(summary.netdokHint?.configured).toBe(true);
    expect(summary.netdokHint?.unmappedProjects).toEqual(["Metabase"]);
  });

  test("attaches smartParseHint when fixture contains empty/partial messages", async () => {
    const messages = await loadDebriefFixture();
    const dbPath = await makeTempDb(messages);

    const summary = await deriveWorkLogs({
      config: { storage: { path: dbPath } },
    });

    expect(summary.smartParseHint).toBeDefined();
    expect(summary.smartParseHint?.totalNeedingReview).toBeGreaterThan(0);
    expect(summary.smartParseHint?.suggestion).toMatch(/log_works_unparsed/);
  });

  test("omits smartParseHint when every raw message parses cleanly", async () => {
    const messages: RawSlackMessage[] = [
      {
        ts: "1716000000.999999",
        channel: "CWORKLOG",
        userId: "U123LOG",
        text: "Debrief:\nMetabase\n• Shipped fix [1h]",
        raw: {},
        fetchedAt: "2026-05-18T00:00:00.000Z",
      },
    ];
    const dbPath = await makeTempDb(messages);

    const summary = await deriveWorkLogs({
      config: { storage: { path: dbPath } },
    });

    expect(summary.smartParseHint).toBeUndefined();
  });

  test("omits netdokHint when Netdok is fully configured and every project mapped", async () => {
    const messages = await loadDebriefFixture();
    const dbPath = await makeTempDb(messages);

    const summary = await deriveWorkLogs({
      config: {
        storage: { path: dbPath },
        netdok: {
          apiKey: "k",
          workspaceId: "w",
          profileId: "p",
          projects: {
            Venulog: { projectId: "proj-v" },
            Metabase: { projectId: "proj-m" },
          },
        },
      },
    });

    expect(summary.netdokHint).toBeUndefined();
  });

  test("--from / --to filter raw messages by date", async () => {
    const messages = await loadDebriefFixture();
    const dbPath = await makeTempDb(messages);
    const config = { storage: { path: dbPath } };

    // Fixture msg ts → effective date (after applyDateHint):
    //   1716000000 (no hint)  → 2024-05-18
    //   1716100000 Brief only → 2024-05-19 (still processed)
    //   1716200000 "Yesterday" → 2024-05-19 (was 2024-05-20)
    //   1716300000 (no hint)  → 2024-05-21
    const summary = await deriveWorkLogs({
      config,
      from: "2024-05-21",
      to: "2024-05-21",
    });

    expect(summary.processed).toBe(1);
  });
});
