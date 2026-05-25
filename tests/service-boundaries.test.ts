import { describe, expect, test } from "bun:test";
import { handleConfigSet, handleConfigShow } from "../src/commands/config.ts";
import { handleDerive } from "../src/commands/derive.ts";
import { handleExport } from "../src/commands/export.ts";
import { handleFetch } from "../src/commands/fetch.ts";
import {
  handleNetdokTasks,
  handleNetdokWorklogs,
} from "../src/commands/netdok.ts";
import {
  handleStorageClearNetdok,
  handleStorageReset,
} from "../src/commands/storage.ts";
import type { CommandServices } from "../src/commands/types.ts";

function makeServices(calls: string[]): CommandServices {
  return {
    config: {
      show: async () => {
        calls.push("config.show");
        return { ok: true };
      },
      set: async () => {
        calls.push("config.set");
        return { ok: true };
      },
    },
    fetch: {
      run: async () => {
        calls.push("fetch.run");
        return { ok: true };
      },
    },
    derive: {
      run: async () => {
        calls.push("derive.run");
        return { ok: true };
      },
    },
    export: {
      run: async () => {
        calls.push("export.run");
        return { ok: true };
      },
    },
    netdokTasks: {
      run: async () => {
        calls.push("netdokTasks.run");
        return { ok: true };
      },
    },
    netdokWorklogs: {
      run: async () => {
        calls.push("netdokWorklogs.run");
        return { ok: true };
      },
    },
    storageClearNetdok: {
      run: async () => {
        calls.push("storageClearNetdok.run");
        return { ok: true };
      },
    },
    storageReset: {
      run: async () => {
        calls.push("storageReset.run");
        return { ok: true };
      },
    },
  };
}

describe("service boundaries", () => {
  test("command handlers delegate to injected services", async () => {
    const calls: string[] = [];
    const services = makeServices(calls);

    await handleConfigShow({}, services);
    await handleConfigSet({ key: "storage.path", value: "db.json" }, services);
    await handleFetch({ from: "2026-05-20" }, services);
    await handleDerive({ from: "2026-05-20" }, services);
    await handleExport({ format: "csv" }, services);
    await handleNetdokTasks({ from: "2026-05-20" }, services);
    await handleNetdokWorklogs({ from: "2026-05-20", apply: true }, services);
    await handleStorageClearNetdok({ from: "2026-05-20" }, services);
    await handleStorageReset({ apply: true }, services);

    expect(calls).toEqual([
      "config.show",
      "config.set",
      "fetch.run",
      "derive.run",
      "export.run",
      "netdokTasks.run",
      "netdokWorklogs.run",
      "storageClearNetdok.run",
      "storageReset.run",
    ]);
  });
});
