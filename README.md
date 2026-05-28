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

## Debrief format

`log_works_derive` parses each Slack message with a deterministic rule parser ([`src/services/parser.service.ts`](src/services/parser.service.ts)). Write debriefs in this shape:

```
Debrief:
<Project>
• <what you did> [<hours>]
    ◦ <optional sub-detail>
    ◦ <optional sub-detail>
• <another entry> [<hours>]
<Another Project>
• <entry> [<hours>]
```

Rules:

- **Section marker** — only lines under `Debrief:` are parsed. A `Brief:` line ends parsing for the rest of the message (use it for prose you don't want logged). Messages without a `Debrief:` marker are skipped entirely.
- **Project header** — any non-bullet, non-empty line under `Debrief:` becomes the current project. Trailing `:` is stripped; a trailing `[Nh]` is stripped; `[Name]` is unwrapped to `Name`. Following bullets attach to that project until the next header.
- **Bullet (`•`)** — one work-log entry per bullet. Attached to the most recently seen project (or `_unspecified` if none yet).
- **Sub-bullet (`◦`)** — merged into the previous bullet's text on a new line. Sub-bullets never become their own entry.
- **Hours** — first `[N]` or `[Nh]` token in a bullet is extracted as hours and removed from the text. Accepts `[2h]`, `[1.5h]`, `[1.5]`, `[3]`. Other bracketed text (`[Generate Quote]`, `[E2E]`) is left alone. Bullets without an hours token are still stored, but the result is flagged `partial` with `missingHours: true`.
- **Slack links** — `<url|label>` collapses to `label`, bare `<url>` collapses to the URL. Markdown is otherwise preserved.
- **Date hint (optional)** — `Debrief: Today`, `Debrief: Yesterday`, or `Debrief: May 4` after the marker overrides the message date for the derived entries. Unknown suffixes are ignored.
- **Idempotent** — each entry is keyed by `${slack_ts}#${bulletIndex}`, so re-running `derive` over the same range is a no-op.

Two examples — leading hours and trailing hours both work, sub-bullets group under their parent bullet, Slack links collapse to their label:

```
Debrief:
ProjectAlpha
• [2h] #1001 Deployed release candidate to staging and ran smoke tests.
• [4h] #1002 Replaced legacy form flow with API-driven submission; added fallback to the old form on error.
• [2h] #1003 Investigated multi-address picker bug; documented repro steps and impact assessment.
```

```
Debrief:
ProjectBeta:
• Investigated P1 regression across two modules <https://example.com/issues/2001|#2001> [2h]
    ◦ Checked dashboard → detail redirect
    ◦ Checked missing dropdown on create flow
    ◦ Checked send-action error toast
• Fixed Bug [Generate Quote] FETCH_FAILED when order has no parent record <https://example.com/issues/2002|#2002> [1.5h]
• Fixed Bug [Orders] long names break list table layout <https://example.com/issues/2003|#2003> [1h]
• Finished <https://example.com/issues/2004|[Error Notif] severity tag in alerts #2004> [1.5]
• Worked on [E2E] standardize test-id attributes across the app #2005 [1h]
```

Status codes returned per message:

- `ok` — every bullet has a project and hours.
- `partial` — bullets exist but at least one is missing a project (`_unspecified`) or hours (`missingHours`). Still inserted; surfaced so you can fix the source message.
- `empty` — no `•` bullets found under `Debrief:`. Nothing inserted.

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
