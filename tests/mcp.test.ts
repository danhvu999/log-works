import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.ts";

async function makePair() {
  const server = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

describe("MCP wrapper", () => {
  test("exposes all log-works tools with input schemas", async () => {
    const { client } = await makePair();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        "log_works_config_check",
        "log_works_config_set",
        "log_works_config_setup_netdok_apply",
        "log_works_config_setup_netdok_discover",
        "log_works_config_setup_slack",
        "log_works_config_show",
        "log_works_derive",
        "log_works_export",
        "log_works_fetch",
        "log_works_netdok_fetch_tasks",
        "log_works_netdok_tasks",
        "log_works_netdok_worklogs",
        "log_works_projects_add",
        "log_works_projects_list",
        "log_works_projects_set",
        "log_works_storage_clear_netdok",
        "log_works_storage_reset",
        "log_works_summary",
      ].sort(),
    );

    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect((tool.inputSchema as { type?: string }).type).toBe("object");
    }
  });

  test("export tool rejects calls missing the required outPath", async () => {
    const { client } = await makePair();
    const result = await client.callTool({
      name: "log_works_export",
      arguments: { format: "csv" },
    });
    expect(result.isError).toBe(true);
  });

  test("netdok tasks tool rejects bad apply payloads", async () => {
    const { client } = await makePair();
    const result = await client.callTool({
      name: "log_works_netdok_tasks",
      arguments: { apply: "yes" as unknown as boolean },
    });
    expect(result.isError).toBe(true);
  });

  test("server surfaces Slack-first instructions to clients", async () => {
    const { client } = await makePair();
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toContain("log_works_config_check");
    expect(instructions).toMatch(/Slack/);
    expect(instructions).toMatch(/Never bundle|never bundle/);
    expect(instructions).toMatch(/preview/i);
    expect(instructions).toContain("taskUrl");
    expect(instructions).toContain("log_works_derive");
    expect(instructions).toContain("PROJECT VOCABULARY");
    expect(instructions).toContain("log_works_projects_list");
    expect(instructions).toContain("DEBRIEF FILTER");
    expect(instructions).toContain("includeNonDebrief");
    expect(instructions).toMatch(/ALWAYS call `log_works_derive`/);
    expect(instructions).toContain("lastmonth");
    expect(instructions).toContain("log_works_summary");
    expect(instructions).toContain("log_works_projects_add");
    expect(instructions).toMatch(/Do NOT shell out/);
    expect(instructions).toMatch(/log_works_summary is NOT part of setup/);
    expect(instructions).toMatch(/per-project totals|workLogs/);
  });
});
