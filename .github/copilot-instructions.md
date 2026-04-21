# donny repository instructions

## Build, test, and lint commands

- Runtime is **Bun**, not Node.js. There is no separate build step; Bun runs the TypeScript sources directly.
- Install dependencies: `bun install --frozen-lockfile`
- Full lint/type/docs check: `bun run check`
- Biome only: `bun run lint:biome`
- TypeScript only: `bun run lint:typecheck`
- Markdown only: `bun run lint:markdown`
- Full unit suite: `bun test test/unit/`
- Single test file: `bun test test/unit/nova.test.ts`
- Single named test: `bun test test/unit/nova.test.ts --test-name-pattern "bool_true"`
- Windows bootstrap: `scripts\setup-windows.cmd`
- Windows environment check: `scripts\doctor-windows.cmd`

## High-level architecture

- The codebase has a strict three-layer split:
  - `src/lib/` is the pure library layer.
  - `src/cli/` is the terminal wrapper.
  - `src/index.ts` is the public barrel and only re-exports library APIs.
- `src/lib/nova.ts` is the low-level Nova Message TLV codec. It owns tag constants, range constants, encode/decode helpers, and the binary invariants documented in `DESIGN.md`.
- `src/lib/db.ts` is the main integration layer. `DudeDB` opens SQLite databases with `bun:sqlite`, handles `export.dude` gzip+tar extraction in `openAuto()`, and maps decoded Nova blobs into domain objects.
- Most object readers in `DudeDB` follow the same pattern: iterate `rawObjects()`, classify blobs by `RANGE`, then map tags into typed objects. `outages()` and `metrics()` are the exception; they read the plain SQL tables directly instead of going through Nova decoding.
- `src/cli/app.ts` is the command router for the non-interactive CLI. `src/cli/wizard.ts` is a lazily loaded interactive flow using `@clack/prompts`. `src/cli/format.ts` owns ASCII table, CSV, and JSON output.

## Key conventions

- Keep the layer boundary strict: `src/lib/` must never import from `src/cli/`, perform terminal I/O, or call `process.exit()`. CLI-only behavior belongs under `src/cli/`.
- This repo is all-ESM and uses `.ts` extensions in relative imports. Prefer Bun-native APIs and `bun:sqlite`.
- The Nova codec has several non-obvious invariants that are easy to break:
  - magic header is `4D 32 01 00 FF 88 01 00`
  - `tcode 0x01` (`bool_true`) has **0 payload bytes**
  - `tcode 0x09` (`u8`) has **1 payload byte**
  - `tcode 0x18` is fixed **16 bytes**
  - `tcode 0x20` is fixed **4 bytes**
  - `tcode 0x31` uses a **1-byte** length prefix
  - marker `0x11` always consumes exactly **1 payload byte**
  - continuation fields use `marker=0xFE`, and `NAME` is always last
- Device decoding has repo-specific rules: real device objects must have `SELF_ID` in the continuation section matching the row id, which filters out fragment rows that still contain device-range tags. DNS-mode devices use the object name as the address when no IPv4 value is present.
- When adding support for a new object category, update all of these together: `TAG`/`RANGE` in `src/lib/nova.ts`, the domain type in `src/lib/types.ts`, a `DudeDB` reader in `src/lib/db.ts`, exports in `src/index.ts`, and CLI formatting/routing in `src/cli/format.ts` and `src/cli/app.ts`.
- Tests rely on hand-built byte fixtures in `test/unit/nova.test.ts` for exact TLV behavior, plus committed `clean.db` and `clean.export` fixtures in `test/unit/db.test.ts` to cover both raw SQLite and `export.dude` paths.
- Real `*.db` files may contain plaintext credentials and IPs. Keep them out of git. `clean.db` and `clean.export` are the safe committed fixtures intended for tests and baseline comparisons.
- If you change Nova tags, range classification, or object write transactions, keep `DESIGN.md` and `.github/instructions/general.md` in sync with the implementation.
- Windows-first developer setup now lives in `CONTRIBUTING.md`. Repo-owned VS Code/Copilot helpers live in `.vscode\` and `.github\lsp.json`, with RouterOS LSP launched through `scripts\routeroslsp-launcher.cjs`.
