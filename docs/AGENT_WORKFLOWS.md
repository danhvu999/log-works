# Agent Workflows

Use these flows to keep changes predictable and easy to review.

## Implement A Command

1. Read `docs/CLI_CONTRACT.md` and confirm the command shape.
2. Add or update the command handler in `src/commands/`.
3. Delegate business logic to `src/services/`; do not put Slack, Netdok, or storage details in the handler.
4. Add contract tests for flags, JSON output, and error handling.
5. Run `bun test`, `bun run typecheck`, and `bun run lint`.

## Add A Service

1. Define the service input and output types in `src/types/`.
2. Keep the service callable without a CLI context.
3. Inject external dependencies in tests.
4. Add fixture data when behavior depends on Slack, Netdok, or stored JSON.
5. Add tests for success, idempotency, and typed errors.

## Update CLI Output

1. Treat `docs/CLI_CONTRACT.md` as the source of truth.
2. Update docs and tests in the same change.
3. Preserve machine-readable stdout.
4. Keep human-readable diagnostics on stderr.

## Add Fixtures

1. Put Slack fixtures under `fixtures/slack/`.
2. Put storage fixtures under `fixtures/storage/`.
3. Put Netdok fixtures under `fixtures/netdok/`.
4. Keep fixtures small and deterministic.
5. Do not include real tokens, cookies, user names, or private work content.
