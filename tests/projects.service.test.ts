import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import projectNameSuggestions from "../src/constants/project-name-suggestions.ts";
import {
  listProjects,
  setKnownProjects,
} from "../src/services/projects.service.ts";
import type { LogWorksConfig } from "../src/types/index.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function makeTempConfigPath(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "log-works-projects-"));
  return join(tempDir, "config.json");
}

describe("listProjects", () => {
  test("empty config returns sorted suggestions and empty known", async () => {
    const configPath = await makeTempConfigPath();
    const result = await listProjects({ configPath });
    expect(result.known).toEqual([]);
    expect(result.suggestions).toEqual([...projectNameSuggestions].sort());
    expect(result.merged).toEqual(result.suggestions);
    expect(result.configPath).toBe(configPath);
  });

  test("merged unions persisted known with suggestions (dedup, sorted)", async () => {
    const config: LogWorksConfig = {
      projects: { known: ["Metabase", "internal-tools"] },
    };
    const result = await listProjects({
      config,
      configPath: "/tmp/ignored",
    });
    expect(result.known).toEqual(["Metabase", "internal-tools"]);
    expect(result.merged).toContain("internal-tools");
    expect(result.merged).toContain("Metabase");
    expect(result.merged).toContain("Venulog");
    // sorted via default String comparison (ASCII)
    const sorted = [...result.merged].sort();
    expect(result.merged).toEqual(sorted);
  });
});

describe("setKnownProjects", () => {
  test("writes config.projects.known sorted and deduped", async () => {
    const configPath = await makeTempConfigPath();
    const summary = await setKnownProjects(
      { names: ["Venulog", "Metabase", "Venulog", " internal-tools "] },
      { configPath },
    );
    expect(summary.applied).toBe(true);
    expect(summary.known).toEqual(["Metabase", "Venulog", "internal-tools"]);

    const written = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as LogWorksConfig;
    expect(written.projects?.known).toEqual([
      "Metabase",
      "Venulog",
      "internal-tools",
    ]);
  });

  test("REPLACE semantics — second set drops names not in the new list", async () => {
    const configPath = await makeTempConfigPath();
    await setKnownProjects({ names: ["A", "B"] }, { configPath });
    const second = await setKnownProjects(
      { names: ["B", "C"] },
      { configPath },
    );
    expect(second.known).toEqual(["B", "C"]);
  });

  test("empty names list clears the persisted vocabulary", async () => {
    const configPath = await makeTempConfigPath();
    await setKnownProjects({ names: ["X", "Y"] }, { configPath });
    const cleared = await setKnownProjects({ names: [] }, { configPath });
    expect(cleared.known).toEqual([]);
    const list = await listProjects({ configPath });
    expect(list.known).toEqual([]);
  });

  test("rejects payload missing names with setup-invalid", async () => {
    const configPath = await makeTempConfigPath();
    let caught: unknown;
    try {
      await setKnownProjects({} as unknown as { names: string[] }, {
        configPath,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe("setup-invalid");
  });

  test("rejects empty-string entries with setup-invalid", async () => {
    const configPath = await makeTempConfigPath();
    let caught: unknown;
    try {
      await setKnownProjects({ names: ["A", ""] }, { configPath });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe("setup-invalid");
  });
});
