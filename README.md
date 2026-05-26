# log-works

Sync Slack work-log debriefs into a local JSON store and (optionally) post them as Netdok worklogs. Ships as a CLI (`log-works`) and an MCP server (`log-works-mcp`) usable with any MCP-capable AI agent — Claude Code, Claude Desktop, Codex, GitHub Copilot, Cursor, Windsurf, Continue, etc.

## Install

Grab the latest release tarball URL from <https://github.com/danhvu999/log-works/releases> (e.g. `https://github.com/danhvu999/log-works/releases/download/v0.1.0/log-works-0.1.0.tgz`).

**Bun:**

```bash
bun add -g https://github.com/danhvu999/log-works/releases/download/v0.1.0/log-works-0.1.0.tgz
```

**Node ≥20:**

```bash
npm i -g https://github.com/danhvu999/log-works/releases/download/v0.1.0/log-works-0.1.0.tgz
```

**Node ≥20, ephemeral (no install):**

```bash
npx -y https://github.com/danhvu999/log-works/releases/download/v0.1.0/log-works-0.1.0.tgz log-works-mcp
```

All three expose `log-works` and `log-works-mcp` on your PATH. The tarball ships pre-built — no `prepare`/`postinstall` runs on your machine, so no `bun pm trust` step needed.

## Wire into your AI agent (MCP)

`log-works-mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio, so any MCP-capable client can drive it. Pick the snippet for your agent:

**Claude Code (CLI):**

```bash
claude mcp add log-works -- log-works-mcp
```

**Claude Desktop / Cursor / Windsurf / Continue** — add to the client's MCP config file (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json`, `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.continue/config.json`):

```json
{
  "mcpServers": {
    "log-works": { "command": "log-works-mcp" }
  }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.log-works]
command = "log-works-mcp"
```

**GitHub Copilot (VS Code)** — add to `.vscode/mcp.json` in your workspace (or the user-level equivalent):

```json
{
  "servers": {
    "log-works": { "type": "stdio", "command": "log-works-mcp" }
  }
}
```

Any other MCP client works the same way: point `command` at `log-works-mcp`, no args needed.

Config lands at `~/.log-works/config.json`. Secrets stay local; nothing is uploaded outside the Slack and Netdok APIs.

## Using log-works through an AI agent

Once the MCP server is wired in, drive the whole workflow with natural language. The server publishes connect-time instructions describing the Slack-first setup protocol, so any compliant agent will follow the right order.

**First-time setup** — ask the agent:

> set up log-works

The agent runs `log_works_config_check`, then prompts you for Slack credentials (`xoxp-…` user token, your Slack user ID, channel IDs to scan) and writes them to `~/.log-works/config.json`. Netdok setup is a **separate** prompt — only triggered when you ask to sync.

**Daily / weekly logging** — ask:

> log my work today
> log this week
> log last week

The agent fetches the relevant Slack debriefs, derives structured entries, and (if Netdok is configured) posts them as worklogs under the right wrapper task. Every mutating step previews first; you confirm before `--apply`.

**Netdok project mapping** — when you ask to sync for the first time, the agent walks through `log_works_config_setup_netdok_discover` → workspace pick → per-project mode pick. Two modes per project:

- **Weekly wrapper** (default): one `[<Project>] Task issues from <Mon> to <Sun>` task per ISO week; every bullet lands as a worklog under that wrapper.
- **Pinned task**: all hours go under one fixed Netdok task — best for retainer / support / on-call work. The agent re-discovers with `includeTasks=true` so you can pick the task ID.

**Planning / review queries** — once data is in the local DB:

> what projects did I log last week?
> how many hours on Venulog this month?
> export my worklogs to xlsx

The agent uses `log_works_summary` for aggregate questions (per-project hours, entry counts, date ranges) and `log_works_export` for CSV / JSON / XLSX dumps.

**Post-fetch hints** — after every `log_works_fetch` / `log_works_derive`, the result carries an optional `netdokHint` listing projects in the just-processed range that aren't yet mapped in `netdok.projects`. The agent surfaces this so you never lose hours to a forgotten mapping.

All command JSON shapes are pinned in [`docs/CLI_CONTRACT.md`](docs/CLI_CONTRACT.md). The full agent protocol (next-step state machine, Slack-first rule, pinned-task semantics) lives in [`AGENTS.md`](AGENTS.md) and [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md).

## CLI quick reference

```bash
log-works fetch                              # pull Slack debriefs into local DB
log-works derive                             # parse into structured work-logs
log-works export --format xlsx --out worklogs.xlsx
log-works netdok tasks    --apply            # create weekly wrappers in Netdok
log-works netdok worklogs --apply            # post worklogs under each wrapper
```

Every command accepts `--from <YYYY-MM-DD> --to <YYYY-MM-DD>` and `--json`. Both `netdok` stages preview by default; pass `--apply` to mutate. All stages are idempotent — safe to re-run.

Full flag reference and JSON shapes: [`docs/CLI_CONTRACT.md`](docs/CLI_CONTRACT.md).

## Update / uninstall

```bash
bun update -g log-works
bun remove -g log-works
```

## Development

See [`AGENTS.md`](AGENTS.md) and [`docs/`](docs/) for the dev loop, test conventions, and architecture.
