import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  redactConfig,
  resolveConfigPath,
  setConfigValue,
} from "../src/config/config.manager.ts";
import { AppError } from "../src/errors.ts";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-config-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("config manager", () => {
  test("loads config from LOG_WORKS_CONFIG", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        slack: { userId: "U123LOG" },
        storage: { path: "db.json" },
      }),
    );

    expect(resolveConfigPath({ LOG_WORKS_CONFIG: configPath })).toBe(
      configPath,
    );
    expect(await loadConfig({ env: { LOG_WORKS_CONFIG: configPath } })).toEqual(
      {
        slack: { userId: "U123LOG" },
        storage: { path: "db.json" },
      },
    );
  });

  test("applies environment overrides", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ slack: { userId: "old" } }));

    expect(
      await loadConfig({
        configPath,
        env: {
          LOG_WORKS_SLACK_USER_ID: "U123LOG",
          LOG_WORKS_SLACK_CHANNELS: "CWORKLOG,DWORKLOG",
        },
      }),
    ).toEqual({
      slack: {
        userId: "U123LOG",
        channels: ["CWORKLOG", "DWORKLOG"],
      },
    });
  });

  test("throws typed missing-config errors", async () => {
    const dir = await makeTempDir();
    const missingPath = join(dir, "missing.json");

    await expect(
      loadConfig({ configPath: missingPath, env: {} }),
    ).rejects.toEqual(
      new AppError("config-missing", `Config file not found: ${missingPath}`),
    );
  });

  test("redacts secret values", () => {
    expect(
      redactConfig({
        slack: { userToken: "xoxp-secret", userId: "U123LOG" },
        netdok: {
          authHeader: "Bearer secret",
          baseUrl: "https://netdok.example.test",
        },
      }),
    ).toEqual({
      slack: { userToken: "[redacted]", userId: "U123LOG" },
      netdok: {
        authHeader: "[redacted]",
        baseUrl: "https://netdok.example.test",
      },
    });
  });

  test("sets nested config values", () => {
    expect(setConfigValue({}, "storage.path", "/tmp/db.json")).toEqual({
      storage: { path: "/tmp/db.json" },
    });
  });
});
