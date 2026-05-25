# log-works Agent Instructions

This repo is designed to be implemented safely by AI agents. Treat the files in `docs/` as the product contract, especially `docs/REQUIREMENTS.md`, `docs/TECHNOLOGIES.md`, `docs/CLI_CONTRACT.md`, and `docs/ARCHITECTURE.md`.

## Setup Protocol (for MCP agents driving log-works as a tool)

This applies to AI agents that drive `log-works` end-to-end over MCP — not to agents writing code in this repo. The same rule is also published as the server's connect-time `instructions` string.

- **Always call `log_works_config_check` first** in a new session. It returns `{ slack, netdok, nextStep, configPath }`.
- Respect `nextStep`:
  - `"setup-slack"`: prompt the user only for Slack credentials and call `log_works_config_setup_slack`. Stop. Do **not** also ask for Netdok in the same exchange.
  - `"fetch-and-derive"`: Slack is ready and Netdok is deferred. Proceed to `log_works_fetch` / `log_works_derive` when the user asks.
  - `"setup-netdok-discover"`: ask for the Netdok API key, run `log_works_config_setup_netdok_discover` (apiKey only) → present workspaces → re-run with `workspaceId`.
  - `"setup-netdok-apply"`: assemble `NetdokApplyInput` (use `netdok.knownLocalProjects` for suggestions) and call `log_works_config_setup_netdok_apply`.
  - `"ready"`: call `log_works_netdok_tasks` / `log_works_netdok_worklogs` as requested.
- Slack always comes first. Never bundle Slack and Netdok setup prompts in the same exchange.

## Required Workflow

- Read the relevant docs before changing code.
- Keep CLI behavior stable. Command names, flags, JSON output shapes, and error codes are public interfaces.
- Keep command handlers thin. They parse input and delegate to service functions.
- Keep service functions callable outside the CLI so a future MCP server can import them directly.
- Do not make real Slack or Netdok network calls in tests. Use fixtures or injected fakes.
- Keep stdout for data and stderr for human diagnostics.
- Do not add interactive prompts. All input must come from flags, config, or environment variables.

## Checks Before Finishing

Run these when the relevant tooling is installed:

```bash
bun test
bun run typecheck
bun run lint
```

If a check cannot be run, report why and what remains unverified.

## Repo-Specific Conventions

- Canonical specs live in `docs/REQUIREMENTS.md` and `docs/TECHNOLOGIES.md`; do not add duplicate root copies.
- Fixture data belongs in `fixtures/`.
- Contract and boundary tests belong in `tests/`.
- Secrets must never be committed. Redact `slack.userToken` and `netdok.authHeader` in human-readable output.
