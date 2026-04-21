# dude.db — Binary Format Reference

Reference for the MikroTik Dude database binary format.
Intended for tool authors working with `dude.db` files directly.

---

## Database Structure

`dude.db` is a standard SQLite 3 file with six tables.

### `objs` — Main Data Store

Every Dude entity (device, service, probe, map, etc.) is one row.
All data lives in binary blobs.

```sql
CREATE TABLE objs (
  id   INTEGER PRIMARY KEY,
  obj  BLOB
);
```

### `outages` — Outage History

Plain SQL, no binary encoding.

```sql
CREATE TABLE outages (
  timeAndServiceID  INTEGER PRIMARY KEY,
  serviceID         INTEGER,
  deviceID          INTEGER,
  mapID             INTEGER,
  time              INTEGER,   -- Unix epoch
  status            INTEGER,
  duration          INTEGER    -- seconds
);
```

### Chart / Metric Tables

Pre-aggregated monitoring data at four resolutions:

```sql
CREATE TABLE chart_values_raw    (sourceIDandTime INTEGER PRIMARY KEY, value REAL);
CREATE TABLE chart_values_10min  (sourceIDandTime INTEGER PRIMARY KEY, value REAL);
CREATE TABLE chart_values_2hour  (sourceIDandTime INTEGER PRIMARY KEY, value REAL);
CREATE TABLE chart_values_1day   (sourceIDandTime INTEGER PRIMARY KEY, value REAL);
```

Key packing:

```text
source_id = sourceIDandTime >> 32        -- objs.id of the service
timestamp = sourceIDandTime & 0xFFFFFFFF -- Unix seconds
```

Ping services store seconds (`0.001341` = 1.3 ms). Traffic stores bits/second.

---

## Nova Message Format

The `objs.obj` blobs are **Nova Messages** (`nv::message`), the binary
serialization format used throughout RouterOS for WinBox IPC, MAC Telnet,
and internal `.x3` configuration files.

### Magic Header

All blobs start with an 8-byte magic:

```text
4D 32 01 00 FF 88 01 00
```

Followed by a 4-byte LE field count, then the section-1 fields, then an
optional continuation section.

### Two-Section Structure

```text
MAGIC (8 bytes)
SECTION_1_COUNT (u32 LE)
SECTION_1_FIELDS × SECTION_1_COUNT
[SEPARATOR: tag=0x0001  marker=0xFE  tcode=0x08  value=self_id]
[SECTION_2_FIELDS]
[NAME: tag=0x0010  marker=0xFE  tcode=0x21  value=object_name]
```

The separator uses `tag=0x0001, marker=0xFE, tcode=0x08` and stores the
object's own ID. The name field is always the last field in the blob.

### Field Encoding

```text
TAG (2 bytes LE)  MARKER (1 byte)  TCODE (1 byte)  VALUE (variable)
```

### Type Codes

| Tcode | Type | Payload |
|-------|------|---------|
| `0x00` | bool_false | 0 bytes |
| `0x01` | bool_true | 0 bytes — **NOT 1 byte** |
| `0x08` | u32 | 4 bytes LE |
| `0x09` | u8 | 1 byte — **NOT 4 bytes** |
| `0x10` | u64 | 8 bytes LE |
| `0x21` | string | 1-byte length prefix + UTF-8 bytes |
| `0x31` | bytes | 1-byte length prefix + raw bytes |
| `0x88` | u32_array | 2-byte count + count × 4 bytes LE |
| `0xA0` | compound | 2-byte count + nested fields |

**Critical**: `tcode 0x01` is bool_true with **zero** payload bytes. Treating
it as a 1-byte integer causes a cascade misalignment corrupting all subsequent
fields. Similarly, `tcode 0x09` is exactly 1 byte.

### Marker Byte

| Marker | Semantics |
|--------|-----------|
| `0x10` | Standard — value width from tcode |
| `0x11` | Compact — always 1 byte regardless of tcode |
| `0xFE` | Alternate standard — same as `0x10`; used for section separator and name field |

---

## Object Classification

The leading tag in the section-1 fields identifies the object type:

| Tag range | Object type | Key tags |
|-----------|-------------|----------|
| `0x1F40`–`0x1F5A` | Device | `0x1F40` (IP), `0x1F46` (username), `0x1F47` (password) |
| `0x2EE0`–`0x2EF4` | Probe config | `0x2EE1` (device_id), `0x2EE3` (type_id), `0x2EEC` (service_id) |
| `0x36B0`–`0x36D1` | Probe template | `0x36B0` (probe_kind), `0x36B4` (packet_size) |
| `0xBF68`–`0xBF71` | Service | `0xBF6A` (unit), `0xBF71` (interval) |
| `0x3E80`–`0x3E9B` | Map | `0x61A9` (node size) |
| `0x55F0`–`0x55F9` | Topology link/edge | `0x55F1` (device_a_id), `0x55F4/5` (device_b_id) |
| `0x5DC0`–`0x5DDF` | Map node placement | `0x5DC0` (map_id), `0x5DC4` (device_id), `0x5DC5/6` (x/y) |
| `0x697A` | File asset | `0x697A` (parent_dir_id) — filter these out |

### File Assets

Objects with tag `0x697A` are virtual FS entries (fonts, icons, certificates,
sounds). Filter them when enumerating user-created objects.

Root is always named `"default"` (ID ~10016). Children: `Vera.ttf`,
`VeraMono.ttf`, `certificate.pem`, `done.wav`, SVG icons.

---

## Device Fields

### Section 1 (counted by header)

| Tag | Name | Type | Notes |
|-----|------|------|-------|
| `0x1F40` | primary_address | u32_array | IPv4 address(es) LE; empty = DNS mode |
| `0x1F41` | interface_list | compound | Present even in DNS-mode devices |
| `0x1F42` | dns_lookup_mode | u8 | 0 or 1 |
| `0x1F43` | poll_interval | u8 | Seconds |
| `0x1F45` | device_type_id | u8 | |
| `0x1F49` | enabled | bool | |
| `0x1F4A` | router_os | bool | |
| `0x1F4B` | snmp_enabled | bool | |
| `0x1F4C` | snmp_profile_id | u32 | `0xFFFFFFFF` = none |
| `0x1F4D` | custom_field_ref | u8 | |
| `0x1F4E` | custom2 | u32 | |
| `0x1F51` | secure_mode | bool | |
| `0x1F55` | flag_55 | bool | |
| `0x1F56` | services_ids | u32_array | Always empty — use probe_config instead |
| `0x1F57` | reserved_57 | u32_array | Always empty |

### Section 2 (after `0x0001` separator)

| Tag | Name | Type | Notes |
|-----|------|------|-------|
| `0x1F44` | mac_data | bytes | `u32(0) + u16(6) + 6-byte MAC × N` |
| `0x1F46` | username | str | RouterOS admin username — **plaintext** |
| `0x1F47` | password | str | RouterOS admin password — **plaintext** |
| `0x1F52`–`0x1F54` | reserved | u8 | |
| `0x1F58`–`0x1F5A` | custom_str | str | |
| `0x0010` | name | str | Always last |

**Security**: credentials are stored in cleartext. Any tool reading `dude.db`
has full credential access.

---

## Service Fields

Tags `0xBF68`–`0xBF71`. All 12 fields in section 1.

| Tag | Name | Type | Notes |
|-----|------|------|-------|
| `0xBF68` | enabled | bool | |
| `0xBF69` | status_code | u8 | |
| `0xBF6A` | unit | str | `"s"` (latency), `"bit/s"` (traffic) |
| `0xBF6B`–`0xBF6E` | reserved | u8 | |
| `0xBF6F` | timeout_ref | u32 | `0xFFFFFFFF` = default |
| `0xBF70` | extra_config | str | |
| `0xBF71` | interval | u8 | Seconds |
| `0x0001` | self_id | u32 | |
| `0x0010` | name | str | `"probe_type @ device_name"` |

---

## Probe Config Fields

Tags `0x2EE0`–`0x2EF4`. 17 fields in section 1, 5 in section 2.

Key section-2 fields:

| Tag | Name | Type | Notes |
|-----|------|------|-------|
| `0x2EE1` | device_id | u32 | → device object |
| `0x2EE3` | probe_type_id | u32 | → probe template |
| `0x2EEC` | service_id | u32 | → service object |

---

## Object Relationships

```text
probe_template ←── probe_config ──→ device
                       │
                       └──→ service
```

`probe_config` is the join table. `0x1F56` (services_ids) on devices is always
empty in production — always query `probe_configs` by device_id.

### ID Allocation

IDs start at 10000. Probe and service IDs are consecutive (probe=N, service=N+1).
Allocate by reading `MAX(id) FROM objs` and incrementing.

---

## IPv4 Encoding

Stored little-endian as u32: `10.10.100.1` → bytes `0x0A 0x64 0x0A 0x0A`.

```ts
ipv4ToU32("192.168.88.1")  // → a | (b<<8) | (c<<16) | (d<<24)
ipv4FromU32(0xFFFFFFFF)    // → "" (no address — DNS mode)
```

---

## DNS-mode Devices

Devices with a hostname instead of an IP:

- `0x1F40` is absent or contains only `0xFFFFFFFF`
- `0x1F41` (interface_list compound) is present
- Device name field holds the FQDN

---

## Built-in Probe Type IDs

| ID | Name |
|----|------|
| 10160 | ping |
| 10161 | rnd 50:50 |
| 10162 | tcp echo |
| 10163 | ftp |
| 10164 | ssh |
| 10165 | telnet |
| 10166 | smtp |
| 10168 | http |
| 10174 | routeros management |
| 10183 | cpu |
| 10184 | memory |
| 10185 | virtual memory |
| 10186 | disk |

Built-in tool IDs 10004–10015 (Ping, Traceroute, Snmpwalk, etc.) and file
asset IDs starting at ~10016 should be excluded when listing user objects.
