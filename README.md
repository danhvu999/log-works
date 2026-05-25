# log-works

Sync Slack work-log debriefs into a local JSON store and (optionally) post them as Netdok worklogs. Ships as a CLI (`log-works`) and an MCP server (`log-works-mcp`).

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

## Wire into Claude Code

```bash
claude mcp add log-works -- log-works-mcp
```

Or, by config file (Claude Desktop / Cursor / Windsurf):

```json
{ "mcpServers": { "log-works": { "command": "log-works-mcp" } } }
```

In any Claude session, ask **"set up log-works"** or **"log my work today"**. The agent walks you through Slack credentials, Netdok credentials (optional), and per-project mappings — including **pinned-task mode** for retainer / support projects (all hours under one fixed Netdok task instead of weekly wrappers).

Config lands at `~/.log-works/config.json`. Secrets stay local; nothing is uploaded outside the Slack and Netdok APIs.

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
