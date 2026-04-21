# donny — Agent Instructions

## Architecture

Three-layer layout: `src/lib/` (pure library), `src/cli/` (terminal I/O), `src/index.ts` (public barrel).

- `nova.ts` — Nova Message TLV codec. Self-contained. See DESIGN.md for the full field format.
- `db.ts` — `DudeDB` class using `bun:sqlite`. All SQLite access lives here.
- `types.ts` — Domain interfaces shared between lib and cli.

`src/lib/` must never import from `src/cli/` and must never call `process.exit()`.

## Nova Message Format Reference

See `DESIGN.md` for the full field format. Key invariants:

- Magic: `4D 32 01 00 FF 88 01 00` (8 bytes). All blobs start with this.
- `tcode 0x01` = bool_true, **0 payload bytes** — do not consume the next byte.
- `tcode 0x09` = u8, **1 payload byte** — not 4.
- Marker `0x11` (compact) = always exactly 1 payload byte regardless of tcode.
- IPv4 is LE u32; sentinel `0xFFFFFFFF` = no address (DNS-mode device).
- Continuation fields (self_id separator) use `marker=0xFE`; NAME is always last.

## Test Strategy

Unit tests live in `test/unit/` and use byte-literal fixtures — hand-constructed binary blobs that test specific tcode/marker combinations. The fixtures in `nova.test.ts` cover:

- IP-mode device decode
- DNS-mode device (tag `0x1F41`, no IP)
- `bool_true` (tcode `0x01`) consuming exactly 0 bytes
- Round-trip encode/decode for devices, services, probe configs
- Edge cases: empty blob, bad magic, unknown tcode, invalid marker

Run: `bun test test/unit/`

## Adding Object Types

To add support for a new object category (e.g., outages, users):

1. Add tag constants to `TAG` in `nova.ts`
2. Add range bounds to `RANGE` in `nova.ts`
3. Add domain type to `types.ts`
4. Add a `db.ts` method that iterates `rawObjects()`, filters by range, and maps to the domain type
5. Export the type from `src/index.ts`
6. Add CLI output in `format.ts` and a case in `cli/index.ts`

## Local Dev Databases

`*.db` files are gitignored (they may contain PII: cleartext passwords, IP addresses). Copy a dude.db from a Dude server to the project root for local testing — do not commit it.

## Dependencies

- Runtime: `@clack/prompts` (interactive wizard only; dynamically imported)
- Dev: `@biomejs/biome`, `typescript`, `@types/bun`, `markdownlint-cli2`
- No external SQLite dep — uses `bun:sqlite`

## Format & Lint

```sh
bun run check          # biome + typecheck + markdownlint
bun run lint:biome     # biome only
bun run lint:typecheck # tsc --noEmit
```

Biome config in `biome.json`. Markdownlint config in `.markdownlint.yaml`.

## End-of-Session Review

After significant work, check whether `DESIGN.md` needs updating — especially for:
- New tag constants or object types added
- Changes to the Nova encoder/decoder
- Changes to the `addDevice` transaction logic
