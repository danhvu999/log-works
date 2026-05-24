# log-works — Technologies

Stack chosen for v1. Swappable — each layer isolated behind a service so a single replacement does not cascade. Update independently of `REQUIREMENTS.md`.

## 1. Runtime — Bun

- Runs TypeScript directly, no build step in dev.
- Fast cold start matters for a CLI invoked frequently by agents.
- Built-in test runner (`bun test`) and bundler.
- Single-binary distribution possible later via `bun build --compile`.

## 2. Language — TypeScript

- `strict: true`. No `any` in service signatures.
- Targets Bun's bundled TS — no separate `tsc` compile step at runtime; `tsc --noEmit` used only for type-check in CI.

## 3. Storage — lowdb v7

- JSON file database, TypeScript-typed schema, sync + async adapters.
- File: `~/.log-works/db.json` (overridable via `storage.path`).
- Human-readable on disk, trivial to back up or inspect.
- Schema sketch:
  ```ts
  type DB = {
    rawMessages: {
      ts: string;          // Slack ts — primary key
      channel: string;
      userId: string;
      text: string;
      raw: unknown;        // full Slack payload
      fetchedAt: string;
    }[];
    workLogs: {
      id: string;          // deterministic: `${ts}#${lineIndex}`
      sourceTs: string;
      date: string;        // YYYY-MM-DD in user TZ
      text: string;
      status: "pending" | "sent" | "failed";
      lastError?: string;
      postedAt?: string;
    }[];
    meta: {
      lastFetchAt?: string;
      lastFetchCursor?: Record<string /* channel */, string /* ts */>;
    };
  };
  ```
- **Trade-offs vs SQLite:** simpler and human-readable, but no indexes, no concurrent-write safety, full file rewrite on every save. Acceptable for single-user CLI. If volume grows, swap behind `storage.service.ts` interface.

## 4. CLI framework — commander v12

- Mature, typed, supports nested subcommands, custom help, and option parsing.
- Handlers stay thin — they only parse flags and delegate to service functions.

## 5. HTTP — native `fetch`

- Bun's built-in `fetch`. No `axios`, no `node-fetch`.
- Slack client: use **`@slack/web-api`** (typed, handles pagination + rate-limit headers) rather than hand-rolling. Decision revisit-able if dep size becomes an issue.
- Netdok client: thin native-`fetch` wrapper. Placeholder until user supplies curl example.

## 6. MCP (future, not installed in v1)

- **`@modelcontextprotocol/sdk`** — separate entry point `src/mcp.ts`, reuses the same `services/*` modules as the CLI.
- v1 only enforces that services are CLI-handler-free so MCP can drop in.

## 7. Dev tooling

- **Tests:** `bun test`.
- **Type-check:** `tsc --noEmit` in CI.
- **Lint + format:** `biome` (single binary, fast). Avoids ESLint + Prettier combo.
- **Config validation:** `zod` for parsing `config.json` and Slack API responses at boundaries.

## 8. Project layout

```
src/
  cli.ts                    # commander entry — wires subcommands
  commands/
    config.ts
    fetch.ts
    list.ts
    post.ts
    sync.ts
  services/
    slack.service.ts        # @slack/web-api wrapper
    netdok.service.ts       # placeholder HTTP client
    storage.service.ts      # lowdb wrapper, exports typed DB ops
    sync.service.ts         # orchestrates fetch → store → post
  config/
    config.manager.ts       # read/write ~/.log-works/config.json
    schema.ts               # zod schema for config
  types/
    index.ts
package.json
tsconfig.json
biome.json
README.md
REQUIREMENTS.md
TECHNOLOGIES.md
```

## 9. Swap-ability notes

| Layer        | Current        | Swap path                                                              |
| ------------ | -------------- | ---------------------------------------------------------------------- |
| Storage      | lowdb          | Replace `storage.service.ts` impl; keep interface. SQLite / Postgres.  |
| HTTP         | native `fetch` | Isolated in service files. Swap to `undici`, `axios`, etc.             |
| CLI parser   | commander      | Handlers are thin — yargs / clipanion drop-in.                         |
| Slack client | `@slack/web-api` | Replace with raw `fetch` if dep weight matters.                      |
| Runtime      | Bun            | Node 20+ possible — would need to replace `bun:*` APIs (none used yet).|

## 10. Dependencies (initial)

Runtime:
- `commander@^12`
- `lowdb@^7`
- `@slack/web-api@^7`
- `zod@^3`

Dev:
- `typescript@^5`
- `@types/node`
- `@biomejs/biome`

No build-time deps beyond TypeScript itself.
