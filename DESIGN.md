# donny — Design

## Layers

```text
src/
  lib/
    nova.ts      — Nova Message TLV codec (encode + decode)
    db.ts        — DudeDB: SQLite access via bun:sqlite
    types.ts     — Domain types shared across lib and cli
  cli/
    index.ts     — Command router (info, list, export, add, wizard)
    wizard.ts    — Interactive @clack/prompts wizard
    format.ts    — Table/CSV/JSON output helpers
  index.ts       — Public barrel export
```

`src/lib/` is a pure library. It never imports from `src/cli/`, never calls `process.exit()`, and has no terminal I/O.

`src/cli/` wraps the library. It owns terminal output and exit codes.

`src/index.ts` re-exports the public surface: `DudeDB`, all Nova codec functions and types, and domain types.

## Storage: dude.db

The Dude stores all configuration in a SQLite database with three key tables:

- `objs` — one row per monitored object (device, probe, map, etc.). The `obj` column holds a Nova Message binary blob.
- `obj_links` — topology edges (from/to obj ids).
- `chart_values_raw`, `chart_values_10min`, `chart_values_2hour`, `chart_values_1day` — time-series metrics.

`DudeDB` reads and writes `objs` directly. Edges and metrics are read-only in this version.

## Nova Message (nv::message)

The binary serialization format used throughout RouterOS IPC, WinBox, and dude.db. Each object blob is a self-contained TLV sequence.

**Magic**: `4D 32 01 00 FF 88 01 00` (8 bytes)

**Structure**:

1. Magic (8 bytes)
2. Section-1 field count (u32 LE)
3. Section-1 fields (the "standard" fields for this object type)
4. Continuation fields — separated by `tag=0x0001, marker=0xFE, tcode=0x08` (self_id); NAME is always last

**Field header**: `tag (u16 LE) + marker (u8) + tcode (u8)`

Markers: `0x10` standard, `0x11` compact (always 1 byte), `0xFE` alternate standard.

Type codes:

| tcode | type | payload bytes |
|-------|------|---------------|
| `0x00` | bool_false | 0 |
| `0x01` | bool_true | 0 |
| `0x08` | u32 | 4 |
| `0x09` | u8 | 1 |
| `0x10` | u64 | 8 |
| `0x18` | bytes_16 | fixed 16 (notification padding) |
| `0x20` | bytes_4 | fixed 4 (rare fixed-width fields) |
| `0x21` | str | 1-byte len prefix + bytes |
| `0x31` | bytes | 1-byte len prefix + bytes |
| `0x88` | u32_array | 2-byte count + count×4 bytes |
| `0xA0` | compound | 2-byte count + count × nested fields |

## Object Classification by Tag Range

The leading tag in the section-1 fields identifies the object type:

| Range | Object type | Notes |
|-------|-------------|-------|
| `0x1F40–0x1F5A` | Device | |
| `0x2EE0–0x2EF4` | Probe config | |
| `0x36B0–0x36D1` | Probe template | |
| `0x3C68–0x3C72` | SNMP profile | |
| `0x3E80–0x3E9B` | Notification | `0x3E9A` = 16-byte reserved-zero padding (tcode `0x18`) |
| `0x55F0–0x55F9` | Topology link/edge | `0x55F1` (device_a_id), `0x55F4/5` (device_b_id) |
| `0x5DC0–0x5DDF` | Map node placement | `0x5DC0` (map_id), `0x5DC4` (device_id), `0x5DC5/6` (x/y px) |
| `0x61A8–0x61FA` | Map canvas container | 85 fields: background, grid, palettes, label templates, font blobs |
| `0x6978–0x697A` | File asset | fonts, icons, certs — filter when enumerating user objects |
| `0x7530–0x7533` | Tool | |
| `0xBF68–0xBF71` | Service | |

## IPv4 Encoding

IPv4 addresses are stored as u32 little-endian: `a | (b<<8) | (c<<16) | (d<<24)`. Sentinel `0xFFFFFFFF` means no address (DNS-mode device). `ipv4FromU32` / `ipv4ToU32` handle conversion.

## DNS-mode Devices

Devices with a hostname instead of an IP address have no entry in tag `0x1F40` (or an empty array). They are identified by the presence of tag `0x1F41` (interface_list compound). The name field holds the FQDN and is used as the address.

## addDevice Transaction

`DudeDB.addDevice()` writes three objects in a single SQLite transaction:

1. **Device** blob (tags `0x1F40–0x1F4x`) with IP/DNS, credentials, MAC placeholder
2. **Service** blob (tags `0xBF68–0xBF71`) linked to the device
3. **ProbeConfig** blob (tags `0x2EE0–0x2EF4`) linking device → service → probe type

IDs are allocated by scanning the current max id in `objs` and incrementing. The new objects are invisible to The Dude server until it is restarted.

## Key Design Decisions

- **bun:sqlite** — built-in, no external dep. BLOBs arrive as `Uint8Array`.
- **DataView cursor** over `Buffer` — clean u16/u32/u64 reads with bounds checking.
- **NovaWriter** collects fields in an array and serializes once — avoids incremental buffer resizing.
- **Credentials in cleartext** — dude.db stores RouterOS username/password unencrypted. `DudeDB.devices()` includes them by default; callers must handle PII carefully. `*.db` is gitignored.
