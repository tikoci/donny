---
applyTo: "**"
---

# General Code Instructions

## Runtime

- **Bun** — not Node.js. Use `bun:sqlite`, `Bun.file`, `Bun.$` instead of Node equivalents.
- All code is ESM. Use `.ts` extensions in relative imports.
- No CommonJS (`require`, `module.exports`).

## Layer Rules

- `src/lib/` — Pure library. NEVER import from `src/cli/`. No `process.exit()`.
- `src/cli/` — CLI wrapper. May import from `src/lib/`. Owns terminal output and `process.exit()`.
- `src/index.ts` — Public barrel. Only re-exports from `src/lib/`.

## Nova Message Invariants

- `tcode 0x01` = bool_true, **0 payload bytes** — do not consume the next byte.
- `tcode 0x09` = u8, **1 payload byte** — not 4.
- `tcode 0x18` = fixed **16 bytes** (notification padding).
- `tcode 0x20` = fixed **4 bytes** (rare fixed-width fields).
- `tcode 0x31` = bytes, **1-byte** length prefix — not 2.
- Marker `0x11` (compact) = always exactly 1 payload byte regardless of tcode.
- Magic: `4D 32 01 00 FF 88 01 00`. Every blob starts with this.
- IPv4 stored as u32 LE. Sentinel `0xFFFFFFFF` = no address (DNS-mode device).

## Style

- Biome 2.x for lint. Run: `bun run lint:biome`.
- Tabs for indentation.
- No comments on obvious code.

## Adding Object Types

1. Add tag constants to `TAG` in `nova.ts` and range bounds to `RANGE`.
2. Add domain type to `types.ts`.
3. Add a `DudeDB` method in `db.ts` using `rawObjects()` + range filter.
4. Export from `src/index.ts`.
5. Add CLI output in `format.ts` and a case in `cli/index.ts`.

## End-of-Session Review

After significant changes, verify both `DESIGN.md` and this file reflect the current implementation — especially tag constants, tcode table, object types, and transaction logic.
