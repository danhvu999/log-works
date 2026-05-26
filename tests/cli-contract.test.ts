import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { COMMAND_SPECS, getCommandNames } from "../src/cli.ts";
import { AppError } from "../src/errors.ts";
import { errorResponse, successResponse } from "../src/output.ts";
import { ERROR_CODES } from "../src/types/index.ts";

describe("CLI contract", () => {
  test("pins the public command names", () => {
    expect(getCommandNames()).toEqual([
      "config set",
      "config show",
      "config setup slack",
      "config setup netdok-discover",
      "config setup netdok-apply",
      "config check",
      "fetch",
      "derive",
      "parse list-unparsed",
      "parse ingest",
      "export",
      "summary",
      "projects list",
      "projects set",
      "projects add",
      "netdok tasks",
      "netdok fetch-tasks",
      "netdok worklogs",
      "storage clear-netdok",
      "storage reset",
    ]);
  });

  test("every command accepts --json", () => {
    for (const command of COMMAND_SPECS) {
      expect(command.options.some((option) => option.name === "--json")).toBe(
        true,
      );
    }
  });

  test("fetch exposes the --include-non-debrief escape hatch", () => {
    const fetchSpec = COMMAND_SPECS.find((c) => c.name === "fetch");
    const flag = fetchSpec?.options.find(
      (opt) => opt.name === "--include-non-debrief",
    );
    expect(flag).toBeDefined();
    expect(flag?.takesValue).toBe(false);
  });

  test("netdok mutating commands default to preview (require --apply for writes)", () => {
    const mutating = ["netdok tasks", "netdok worklogs"];
    const netdokCommands = COMMAND_SPECS.filter((c) =>
      mutating.includes(c.name),
    );
    expect(netdokCommands.length).toBe(mutating.length);
    for (const command of netdokCommands) {
      const applyFlag = command.options.find((opt) => opt.name === "--apply");
      expect(applyFlag).toBeDefined();
      expect(applyFlag?.takesValue).toBe(false);
    }
  });

  test("netdok fetch-tasks is read-only (no --apply, requires --project-id)", () => {
    const spec = COMMAND_SPECS.find((c) => c.name === "netdok fetch-tasks");
    expect(spec).toBeDefined();
    expect(spec?.options.some((o) => o.name === "--apply")).toBe(false);
    const projectFlag = spec?.options.find((o) => o.name === "--project-id");
    expect(projectFlag).toBeDefined();
    expect(projectFlag?.takesValue).toBe(true);
  });

  test("storage commands default to preview (require --apply for writes)", () => {
    const storageCommands = COMMAND_SPECS.filter((c) =>
      c.name.startsWith("storage "),
    );
    expect(storageCommands.length).toBe(2);
    for (const command of storageCommands) {
      const applyFlag = command.options.find((opt) => opt.name === "--apply");
      expect(applyFlag).toBeDefined();
      expect(applyFlag?.takesValue).toBe(false);
    }
  });

  test("documents stdout JSON error shape and stable error codes", async () => {
    const contract = await readFile("docs/CLI_CONTRACT.md", "utf8");

    for (const code of ERROR_CODES) {
      expect(contract).toContain(code);
    }
    expect(
      errorResponse(new AppError("config-missing", "Config file not found")),
    ).toEqual({
      error: {
        code: "config-missing",
        message: "Config file not found",
      },
    });
  });

  test("successful JSON responses keep an object at the top level", () => {
    expect(successResponse({ ok: true })).toEqual({ ok: true });
  });
});
