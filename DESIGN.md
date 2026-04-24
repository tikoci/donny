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

The magic is structured, not opaque: `4D 32` = 2-byte magic marker, followed by a full `DataFormat` field (`tag=0x0001, marker=0xFF, tcode=0x88`) with a 1-element u32 array whose value identifies the object type (e.g. `0x03`=ServerConfig, `0x0F`=Device, `0x18`=Notification). Both ends of a decode reach offset 12 before reading object fields — `donny` treats bytes 2–7 as part of the magic constant and discards them along with the u32 at offset 8.

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
| `0x18` | bytes_16 | fixed 16 (IPv6 address fields, e.g. notification mail server) |
| `0x20` | bytes_4 | fixed 4 (rare fixed-width fields) |
| `0x21` | str | 1-byte len prefix + bytes |
| `0x31` | bytes | 1-byte len prefix + bytes |
| `0x88` | u32_array | 2-byte count + count×4 bytes |
| `0xA0` | compound | 2-byte count + count × nested fields |

## Object Classification by Tag Range

The leading tag in the section-1 fields identifies the object type. If the first
field is `SELF_ID` (`0x0001`), look at the next type-specific tag to classify.

| Range | Object type | Key tags / notes |
|-------|-------------|-----------------|
| `0x07D0–0x07DF` | Chart / Panel element | `0x07D0`=type str ("Chart Line"\|"Panel Element"), `0x07D1`=enabled bool |
| `0x1000–0x101F` | Server state metadata | `0x1001`=root_id_list, `0x1015`=timestamp_array, `0x0FEF`=color palette — one per db |
| `0x1770–0x177F` | Network scanner config / Syslog rule | boolean auto-discovery flags; syslog rule objects start at `0x1770` — one scanner config per db |
| `0x1F40–0x1F5A` | Device | `0x1F40`=ip, `0x1F45`=mac_lookup (bool), `0x1F46/7`=credentials, `0x1F4C`=type_id (DeviceType ref), `0x1F4E`=snmp_profile_id |
| `0x2328–0x2337` | Group | `0x2328`=member_id_list (u32[]) |
| `0x2710–0x271F` | Device type template | 17 built-ins: MikroTik Device, Bridge, Router, Switch, RouterOS, Windows Computer, HP Jet Direct, FTP/Mail/Web/DNS/POP3/IMAP4/News/Time Server, Printer, Some Device. `0x2710`=required service IDs (u32[]), `0x2711`=allowed service IDs (u32[]), `0x2712`=ignored service IDs (u32[]), `0x2713`=image asset ID, `0x2714`=image scale, `0x2715`=URL template. Arrays reference ProbeTemplate/Service IDs. |
| `0x2AF8–0x2AFA` | Network / Subnet group | `0x2AF8`=subnet list (u32 pairs: ip+mask), `0x2AF9`=map_id |
| `0x2EE0–0x2EF4` | Probe config | `0x2EE1`=device_id, `0x2EE3`=type_id, `0x2EEC`=service_id |
| `0x36B0–0x36D1` | Probe template | `0x36B0`=kind str, `0x36B2`=port |
| `0x3C68–0x3C72` | SNMP profile | |
| `0x3E80–0x3E9B` | Notification | `0x3E9A` = IPv6 mail server address (tcode `0x18`, 16 bytes; all-zero = not configured); `0x3E9B` = mail server DNS name (str; empty = not configured) |
| `0x4A38–0x4A3F` | Open panel | ephemeral; absent in offline databases |
| `0x4E20–0x4E23` | Active session | ephemeral; absent in offline databases |
| `0x5208–0x520F` | Service description | annotation on a probe template; starts with `SELF_ID`. `0x5208`=parent probe template id, `0x5209`=creation timestamp |
| `0x55F0–0x55F9` | Topology link/edge | `0x55F1`=device_a_id (C++ `Link_MasterDevice`); `0x55F4`=probe type id (link check); `0x55F5`=map element or device_b_id (C++ `Link_NetMapElementID`); `0x55F6`=notification_id |
| `0x59D8–0x59DB` | Link type | |
| `0x5DC0–0x5DDF` | Map node placement | `0x5DC0`=map_id, `0x5DC4`=device_id, `0x5DC5/6`=x/y px |
| `0x61A8–0x61FA` | Map canvas container | 85 fields: background, grid, palettes, label templates, font blobs |
| `0x6590–0x65AD` | Discovery job | `0x659A` = network subnet as LE u32 broadcast address |
| `0x697A` | File asset | fonts, icons, certs — filter when enumerating user objects |
| `0x7530–0x7533` | Tool | |
| `0xBF68–0xBF71` | Service | |
| `0xC350–0xC356` | Chart line | |
| `0xCB20–0xCB2F` | Data source | custom SNMP variable; `0xCB21`=OID expression, `0xCB22`=description |

## export.dude Format

The Dude's built-in backup is a gzip-compressed tar archive containing a single `dude.db` SQLite file:

- **Detection**: bytes 0–1 are `0x1F 0x8B` (gzip magic).
- **Structure**: After `Bun.gunzipSync()`, the result is a standard 512-byte POSIX tar block. The file size is an octal string at offset 124 (12 bytes, null-terminated). The SQLite file data starts at byte 512.
- **Opening**: `DudeDB.openAuto(path)` detects the magic, decompresses, extracts the SQLite payload to a temp file (`mkdtempSync`), opens it, and deletes it on `db.close()`.

## Builtin Objects (Clean Database)

A freshly initialised Dude database (`clean.db` / `clean.export`) contains 224 objects — all builtin, no user data:

| Type | Count | ID range |
|------|-------|----------|
| Settings | 1 | 10000 |
| Probe templates | 27 | 10159–10190 (ping=10159, disk=10190) |
| Device types | 17 | 10191–10207 (MikroTik Device=10191, Some Device=10207) |
| Link types | 8 | 10208–10215 (10g ethernet=10208, some link=10215) |
| Syslog rule | 1 | 10221 (name="(default)", enabled, action=notify) |
| Assets | 142 | built-in icons and fonts |
| Notes | 5 | built-in welcome notes |
| Notifications | 5 | built-in alerts |
| SNMP profiles | 3 | built-in community strings |
| Tools | 12 | built-in ping/traceroute/etc tools |
| Chart items | 2 | built-in chart layouts |
| Open panels | 1 | built-in panel definition |

`clean.db` and `clean.export` are committed to the repo (gitignore has `!clean.db` / `!clean.export` exceptions). They contain no PII and are safe to share. Use them in tests to validate both the SQLite and gzip/tar code paths.

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
