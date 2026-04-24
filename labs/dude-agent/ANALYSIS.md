# Dude DB Object Type Analysis

Findings from live CHR lab: exported a fresh `dude.db` after enabling Dude on a
CHR (RouterOS 7.21.4) and adding one device, then cross-referenced against the
`2022.db` production database (~1045 objects, 52 devices).

## Summary: all 223 objects in a fresh Dude database

| Object type | Count | Range | Notes |
|-------------|-------|-------|-------|
| File asset | 142 | `0x697A` | Built-in icons, fonts, cert templates |
| Probe template | 27 | `0x36B0–0x36D1` | Built-in probes (ping, TCP, DNS, SNMP, etc.) |
| Device type template | 17 | `0x2710–0x271F` | 17 named device types (see below) |
| Service description | 13 | `0x5208–0x520F` | Annotations on probe templates |
| Tool | 12 | `0x7530–0x7533` | Built-in Dude tools |
| Notification | 5 | `0x3E80–0x3E9B` | Default notification rules |
| SNMP profile | 3 | `0x3C68–0x3C72` | Default SNMP v1/v2c/v3 |
| Server metadata | 1 | `0x1000–0x101F` | One per db — timestamps, color palette |
| Canvas | 1 | `0x61A8–0x61FA` | Default empty map |
| Network scanner | 1 | `0x1770–0x177F` | Auto-discovery settings |
| Device | 1 | `0x1F40–0x1F5A` | Our added test device |

## Key new discoveries

### Device type templates (tag range `0x2710–0x271F`)

17 built-in device types, linked in a chain via tag `0x0005` (next_id):

| ID | Name | Parent type id |
|----|------|---------------|
| 10192 | MikroTik Device | 10043 |
| 10193 | Bridge | 10023 |
| 10194 | Router | 10044 |
| 10195 | Switch | 10047 |
| 10196 | RouterOS | `0xFFFFFFFF` (root) |
| 10197 | Windows Computer | 10039 |
| 10198 | HP Jet Direct | 10041 |
| 10199 | FTP Server | 10027 |
| 10200 | Mail Server | 10045 |
| 10201 | Web Server | `0xFFFFFFFF` (root) |
| 10202 | DNS Server | 10029 |
| 10203 | POP3 Server | 10040 |
| 10204 | IMAP4 Server | 10033 |
| 10205 | News Server | 10034 |
| 10206 | Time Server | 10025 |
| 10207 | Printer | 10041 |
| 10208 | Some Device | `0xFFFFFFFF` (root) |

Tags in each device type object:

- `0x2710` = default probe IDs (u32[])
- `0x2711` = all probe IDs for this type (u32[])
- `0x2712` = active probe IDs (u32[])
- `0x2713` = parent device type id (u32, `0xFFFFFFFF` = root)
- `0x2714` = poll interval in seconds (u8, default 60)
- `0x2715` = URL template string (e.g. `http://[Device.FirstAddress]`)
- `0x0005` = next device type id in linked list (u32)

### Service descriptions (`0x5208–0x520F`)

13 built-in service descriptions — human-readable text annotations attached to
probe templates. They start with `SELF_ID`, so the classifier must check beyond
the first field.

- `0x5208` = parent probe template id
- `0x5209` = creation timestamp (Unix seconds)
- `NAME` (0x0010) = description text (e.g. "This service is useful only for MikroTik device identification")

### Server state metadata (`0x1000–0x101F`)

Exactly one object per database (row id 10000). Tracks server-side state:

- `0x1015` = u32[] timestamps of last writes
- `0x1001` = u32[] root object id list
- `0x0FEF` = u32[] global color palette `[0xFF0000, 0xFF, 0xFF00, 0xC0C0]` = red, blue, green, silver
- `0x0FAF` = u32 reference to the network scanner config object

### Network scanner config (`0x1770–0x177F`)

One object per database. Boolean flags controlling auto-discovery behavior.

### Object types only in 2022.db (user-created features)

| Type | Range | Count | Notes |
|------|-------|-------|-------|
| Service | `0xBF68–0xBF71` | 293 | One per probe instance |
| Probe config | `0x2EE0–0x2EF4` | 243 | Device + probe type binding |
| Node | `0x5DC0–0x5DDF` | 136 | Map icon placements |
| Link | `0x55F0–0x55F9` | 65 | Map topology edges |
| Device | `0x1F40–0x1F5A` | 52 | Monitored devices |
| Canvas | `0x61A8–0x61FA` | 5 | Maps (default + user-created) |
| Chart | `0x07D0–0x07DF` | 3 | Chart Line / Panel Element |
| Group | `0x2328–0x2337` | 2 | Device groups (named sets of devices) |
| Data source | `0xCB20–0xCB2F` | 8 | Custom SNMP expressions (LTE signal RSSI etc) |

## Dude agent CLI limitation (critical)

`/dude/agent/add` exists in the RouterOS v7 command tree but returns
`"doAdd Agent not implemented"`. Configuring Dude server-to-agent sessions
**requires WinBox GUI** — it is not possible via CLI or REST in v7.

Without WinBox, only MNDP neighbor discovery traffic (broadcasts every ~30s)
is captured via the TZSP sniffer. The Nova Message TCP session that carries
inter-agent sync data cannot be triggered from CLI.

## MNDP TLV format (from captured broadcasts)

From TZSP-decoded capture on macOS `lo0` (QEMU user-mode networking):

| TLV type | Decode | Example |
|----------|--------|---------|
| `0x0001` | MAC address (6 bytes) | `52:54:00:12:34:57` |
| `0x0005` | Identity string | `MikroTik` |
| `0x0007` | Version string | `7.21.4 (long-term) 2026-04-21` |
| `0x0008` | Platform string | `MikroTik` |
| `0x000A` | Uptime (u32 LE, seconds) | `0x01E2` = 482s |
| `0x000B` | Software ID (10-char base62) | `8JRoVIyyQmK` |
| `0x000C` | Board name | `CHR` |
| `0x000E` | Unpack flag (u8) | `0x01` |
| `0x000F` | IPv6 link-local (16 bytes) | `fe80::5054:ff:fe12:3457` |
| `0x0010` | Interface name | `ether2` |
| `0x0011` | IPv4 address (u32 LE) | `0xC0A86402` = `192.168.100.2` |
| `0x0012` | Unknown flag (u8) | `0x00` |

The MNDP payload starts with a 4-byte header (all zeros for announcements),
followed by TLV pairs: 2-byte type LE, 2-byte length LE, variable value.

## TZSP capture on macOS

QEMU user-mode networking (slirp) routes outbound UDP from the guest to the host's
loopback. RouterOS `/tool/sniffer` with `streaming-server=10.0.2.2` sends TZSP
packets (UDP port 37008) to the QEMU gateway IP, which arrives on `lo0` on the host.

```sh
tshark -i lo0 -f "udp port 37008" -w /tmp/capture.pcap
```

On Linux, use `-i any`. The `-i any` flag fails on macOS with
`ioctl(SIOCIFCREATE): Operation not permitted`.

## Large database import caution

Importing a 4 MB database (~2000 devices) with `/dude/import-db backup-file=X`
succeeds but immediately triggers probing of all loaded devices. The CHR's QEMU
CPU cannot handle 2000+ simultaneous probe connections and becomes unresponsive.
Use small test databases or disable probing before import.

## Export format

`/dude/export-db backup-file=X` creates a gzip-compressed tar archive (`.tar.gz`
magic `1f8b`, despite the `.db` extension). Extract with:

```sh
gunzip -f exported.db  # decompresses in-place to a tar file
tar xf exported.db     # extracts dude.db + files/ directory
```

The extracted `dude.db` is a valid SQLite file that can be opened without WAL
complications (the WAL is checkpointed during the export process).
