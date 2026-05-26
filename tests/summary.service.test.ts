import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyDatabase,
  writeDatabase,
} from "../src/services/storage.service.ts";
import { summarizeStorage } from "../src/services/summary.service.ts";
import type { Database, RawSlackMessage } from "../src/types/index.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function seed(rawMessages: RawSlackMessage[]): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-summary-"));
  const path = join(tempDir, "db.json");
  const db: Database = { ...emptyDatabase(), rawMessages };
  await writeDatabase(path, db);
  return path;
}

function rawMsg(
  ts: string,
  text: string,
  fetchedAt = "2024-05-18T00:00:00.000Z",
): RawSlackMessage {
  return {
    ts,
    channel: "CWORKLOG",
    userId: "U123LOG",
    text,
    raw: {},
    fetchedAt,
  };
}

describe("summary service (raw debrief feed)", () => {
  test("empty DB returns no messages", async () => {
    const path = await seed([]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    expect(result).toEqual({
      messages: [],
      storagePath: path,
      from: undefined,
      to: undefined,
    });
  });

  test("returns full text for every debrief message verbatim", async () => {
    const debriefText =
      "Debrief:\nMetabase\n• Shipped fix [1h] <https://example.com/x|x>\n  ◦ subtask\nVenulog\n• Bug #42 [2h]";
    const path = await seed([rawMsg("1716000000.000001", debriefText)]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      ts: "1716000000.000001",
      date: "2024-05-18",
      channel: "CWORKLOG",
      text: debriefText,
    });
  });

  test("filters out Brief-only and chatter via isDebriefText", async () => {
    const path = await seed([
      rawMsg("1716000000.000001", "Debrief:\nMetabase\n• Shipped [1h]"),
      rawMsg("1716086400.000002", "Brief:\nMetabase\n• Plan [2h]"),
      rawMsg("1716172800.000003", "lunch?"),
    ]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    expect(result.messages.map((m) => m.ts)).toEqual(["1716000000.000001"]);
  });

  test("--from / --to filter inclusive on effective date", async () => {
    const path = await seed([
      rawMsg("1716000000.000001", "Debrief:\nVenulog\n• Old [1h]"), // 2024-05-18
      rawMsg("1716086400.000002", "Debrief:\nVenulog\n• In range [2h]"), // 2024-05-19
      rawMsg("1716172800.000003", "Debrief:\nVenulog\n• Also in range [3h]"), // 2024-05-20
      rawMsg("1716345600.000004", "Debrief:\nVenulog\n• Too new [1h]"), // 2024-05-22
    ]);
    const result = await summarizeStorage({
      config: { storage: { path } },
      from: "2024-05-19",
      to: "2024-05-20",
    });
    expect(result.messages.map((m) => m.date)).toEqual([
      "2024-05-19",
      "2024-05-20",
    ]);
    expect(result.from).toBe("2024-05-19");
    expect(result.to).toBe("2024-05-20");
  });

  test("messages are sorted chronologically (date asc, ties by ts)", async () => {
    const path = await seed([
      rawMsg("1716172800.000003", "Debrief:\nC\n• [1h]"), // 2024-05-20
      rawMsg("1716000000.000001", "Debrief:\nA\n• [1h]"), // 2024-05-18
      rawMsg("1716086400.000002b", "Debrief:\nB2\n• [1h]"), // 2024-05-19
      rawMsg("1716086400.000002a", "Debrief:\nB1\n• [1h]"), // 2024-05-19
    ]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    expect(result.messages.map((m) => m.ts)).toEqual([
      "1716000000.000001",
      "1716086400.000002a",
      "1716086400.000002b",
      "1716172800.000003",
    ]);
  });

  test("Debrief: Yesterday rolls the date back via effectiveDateForMessage", async () => {
    const path = await seed([
      rawMsg(
        "1716086400.000002",
        "Debrief: Yesterday\nVenulog\n• Shipped [3h]",
      ),
    ]);
    const result = await summarizeStorage({
      config: { storage: { path } },
    });
    // ts 1716086400 = 2024-05-19; "Yesterday" rolls back one day to 2024-05-18.
    expect(result.messages[0]?.date).toBe("2024-05-18");
  });
});
