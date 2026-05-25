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

## 4a. CSV export — hand-rolled writer

- No CSV library dependency. `src/services/export.service.ts` ships a small RFC 4180 writer (~30 lines): quote a field when it contains `,`, `"`, `\r`, or `\n`; double-up inner `"`.
- Trade-off vs `papaparse` / `csv-stringify`: zero dep weight, schema is fixed (nine columns: `id, date, project, hours, text, status, lastError, postedAt, sourceTs`), volumes small (single user). Swap to a library only if the format grows or streaming becomes a concern.

## 4c. XLSX export — `exceljs`

- Runtime dep: `exceljs@^4` (~1MB). Required only when `--format xlsx` is invoked; loaded lazily via dynamic `import()` so csv/json paths don't pay the import cost.
- Reason: Google Sheets import via *File → Open* preserves frozen headers, bold group rows, auto-filter, and live `SUM` formulas — none of which CSV can carry. Hand-rolling the OOXML zip from scratch would dwarf the lib.
- Output is a `Uint8Array` (zip-shaped, magic bytes `0x50 0x4b`).

## 4b. Debrief parser — rule-based, no AI

- `src/services/parser.service.ts` is pure-function, regex-driven. No LLM, no external service. This is deliberate: REQUIREMENTS §6 puts in-tool AI parsing out of scope; the structure of work-log messages is regular enough that a small rule set is sufficient and trivially testable.
- Rules: section split on `^(Brief|Debrief)\b`, bullet on `^•`, sub-bullet on `^◦`, hours via `\[(\d+(?:\.\d+)?)h\]$`, link markup via `<url|label>` / `<url>`. See `docs/REQUIREMENTS.md` FR7 for the full contract.
- If an agent later wants AI-assisted parsing for messages that don't fit the format, the right home is a separate command (e.g. `derive --strategy ai`) and a new optional dep, behind the same `WorkLogEntry` schema.

## 5. HTTP — native `fetch`

- Bun's built-in `fetch`. No `axios`, no `node-fetch`.
- Slack client: use **`@slack/web-api`** (typed, handles pagination + rate-limit headers) rather than hand-rolling. Decision revisit-able if dep size becomes an issue.
- Netdok client: thin native-`fetch` wrapper in `src/services/netdok.service.ts`. Auth via `x-api-key` + `workspace-id` headers. `createNetdokClient(config, fetchImpl?)` accepts an injected `fetch` for tests.

## 6. MCP server

- **`@modelcontextprotocol/sdk`** (^1.29) — stdio transport. Entry point `src/mcp.ts` registers one tool per CLI command via `server.registerTool(name, config, handler)` and reuses the same `services/*` modules as the CLI.
- Tool input schemas use Zod (same `zod@^3` dep as config validation). Tool outputs are the existing service result types serialised as JSON in a single text content block, plus `structuredContent` for clients that prefer typed access.
- Errors return `{ isError: true, content: [...] }` so the typed `code` (e.g. `netdok-http`, `config-missing`) is visible to the client.
- Bin entries: `log-works` (CLI) and `log-works-mcp` (MCP server). `bun link` exposes both.

## 7. Dev tooling

- **Tests:** `bun test`.
- **Type-check:** `tsc --noEmit` in CI.
- **Lint + format:** `biome` (single binary, fast). Avoids ESLint + Prettier combo.
- **Config validation:** `zod` for parsing `config.json` and Slack API responses at boundaries.

## 8. Project layout

```
src/
  cli.ts                          # commander entry — wires subcommands
  commands/
    config.ts
    derive.ts
    export.ts
    fetch.ts
    netdok.ts
  services/
    slack.service.ts              # @slack/web-api wrapper
    netdok.service.ts             # native-fetch Netdok client
    netdok-tasks.service.ts       # weekly task sync
    netdok-worklogs.service.ts    # worklog sync with dedup
    storage.service.ts            # JSON file DB, typed DB ops
    derive.service.ts             # rawMessages → workLogs parser orchestrator
    export.service.ts             # csv/json/xlsx exporters
    parser.service.ts             # rule-based debrief parser
    fetch.service.ts              # Slack fetch orchestrator
  utils/
    iso-week.ts
  config/
    config.manager.ts             # read/write ~/.log-works/config.json
  types/
    index.ts
package.json
tsconfig.json
biome.json
docs/
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
