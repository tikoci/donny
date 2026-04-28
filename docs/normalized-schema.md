# Normalized SQLite Schema

`donny normalize` converts a Dude database (`dude.db` raw SQLite or
`export.dude` gzip+tar) into a **fully relational** SQLite database with
foreign keys, indexes, and convenience views. The resulting file is plain
SQLite — open it in DBeaver, DuckDB, Grafana, `sqlite3`, pandas, or any
other tool, no Dude/RouterOS knowledge required.

## Generation

```sh
donny normalize <input> <output.db> [--overwrite] [--skip-timeseries]
```

Examples:

```sh
donny normalize dude.db dude.normalized.db
donny normalize backup.export dude.normalized.db --overwrite
donny normalize dude.db schema-only.db --skip-timeseries     # no chart history
```

Programmatic:

```ts
import { normalizeToFile } from "donny";

const result = normalizeToFile("dude.db", "out.db", { overwrite: true });
console.log(result.tables);     // { devices: 27, probe_configs: 142, ... }
console.log(result.totalRows);
```

The transform runs in a single transaction with `foreign_keys = ON`, so a
failed normalize leaves no partial output. Time-series tables are typically
the bulk of row count; `--skip-timeseries` produces a structure-only export
in seconds even for multi-GB sources.

## Provenance — `_meta` and `_table_counts`

Every normalized DB carries two metadata tables:

| `_meta` key       | Value                                         |
| ----------------- | --------------------------------------------- |
| `source_path`     | Absolute path of the input file               |
| `source_sha1`     | SHA-1 of the input bytes (when available)     |
| `generated_at`    | ISO-8601 UTC timestamp of the export          |
| `generator`       | `donny@<version>`                             |
| `schema_version`  | Integer; bumped when the schema breaks        |

`_table_counts(table_name, row_count)` mirrors what `result.tables` returns
from the API.

## Tables

### Reference data

| Table                          | Source tag range / origin               | Notes |
| ------------------------------ | --------------------------------------- | ----- |
| `device_types`                 | `0x0FA0–0x0FFF` (`RANGE.device_types`)  | `parent_type_id` may reference another type; built-in types flagged |
| `device_type_default_probes`   | continuation of device-type blob         | Junction: which probe templates a device type ships with |
| `probe_templates`              | `0x2710–0x277F`                          | `kind` is the Dude probe family; `port` may be NULL for ICMP |
| `link_types`                   | `0x4E20–0x4E89`                          | `speed_bps` from RouterOS link metadata |
| `snmp_profiles`                | `0x36B0–0x36CF`                          | Community/auth fields not currently extracted |
| `notifications`                | `0x33F0–0x340F`                          | Email/syslog action targets |
| `data_sources`                 | `0x4650–0x466F`                          | Custom SNMP OIDs surfaced as user-defined data sources |
| `tools`                        | `0x4A38–0x4A57`                          | User-defined CLI tools |
| `file_assets`                  | `0x57E4–0x5807`                          | Metadata only — image bytes are not copied |

### Devices and probing

| Table                | Source tag range  | Notes |
| -------------------- | ----------------- | ----- |
| `devices`            | `0x1F40–0x1FA3`   | `dns_mode=1` when address is a DNS name (no IPv4 in record); `device_type_id` is currently always NULL — see Limitations |
| `device_macs`        | continuation      | Junction: a device may have multiple MACs (RouterOS-discovered) |
| `services`           | `0x2EE0–0x2EFF`   | `unit` defaults to `'s'` (seconds, latency); `enabled=0` for disabled services |
| `probe_configs`      | `0x29F8–0x2A6F`   | The actual "device X uses probe Y reporting service Z" rows |

### Topology and maps

| Table             | Source tag range | Notes |
| ----------------- | ---------------- | ----- |
| `maps`            | `0x4E90–0x4EAF`  | Canvases (the Dude calls them "Network Maps") |
| `map_elements`    | `0x5DC0–0x5DDF`  | Element placements; only ~1/3 are device nodes — labels/images/sublink endpoints share the table |
| `topology_links`  | `0x55F0–0x560F`  | Edges between elements; B-side often references a `map_elements.id` rather than a device id directly (see `v_topology`) |

### Logical groupings

| Table                   | Source tag range  | Notes |
| ----------------------- | ----------------- | ----- |
| `networks`              | `0x4170–0x418F`   | Named subnets / address-spaces |
| `network_subnets`       | continuation      | Junction: `(network_id, cidr)` |
| `device_groups`         | `0x4400–0x441F`   | Static device groups |
| `device_group_members`  | continuation      | Junction: `(group_id, device_id)` |
| `syslog_rules`          | `0x4658–0x4677`   | Rule pattern + action + optional notification |
| `discover_jobs`         | `0x4FA8–0x4FC7`   | Auto-discovery jobs |
| `discover_job_probes`   | continuation      | Junction: probe templates a job tries |

### Time-series

| Table        | Source SQLite table              | Reshape |
| ------------ | -------------------------------- | ------- |
| `outages`    | `outages`                        | Sentinel `0` ids in `serviceID/deviceID/mapID` are stored as NULL so FKs work |
| `chart_raw`  | `chart_values_raw`               | `sourceIDandTime` decoded into `(service_id, timestamp)` |
| `chart_10min`| `chart_values_10min`             | same |
| `chart_2hour`| `chart_values_2hour`             | same |
| `chart_1day` | `chart_values_1day`              | same |

All `chart_*` tables share the schema:

```sql
CREATE TABLE chart_<resolution> (
  service_id INTEGER NOT NULL,
  timestamp  INTEGER NOT NULL,        -- unix seconds
  value      REAL,
  PRIMARY KEY (service_id, timestamp)
);
```

## Views

| View              | Joins                                             |
| ----------------- | ------------------------------------------------- |
| `v_devices_full`  | devices + device_types + snmp_profiles + MAC list |
| `v_probes_full`   | probe_configs + devices + probe_templates + services |
| `v_outages_full`  | outages + devices + services                       |
| `v_topology`      | topology_links + devices on both sides (using `map_elements` to resolve B-side) |

## Sample queries

### Find all RouterOS devices and their ping probes

```sql
SELECT d.name, d.address, p.id AS probe_id, t.name AS probe
FROM devices d
JOIN probe_configs p ON p.device_id = d.id
JOIN probe_templates t ON t.id = p.probe_type_id
WHERE d.router_os = 1 AND lower(t.name) LIKE '%ping%'
ORDER BY d.name;
```

### Top 20 devices by outage count

```sql
SELECT d.name, COUNT(*) AS outages
FROM outages o
JOIN devices d ON d.id = o.device_id
GROUP BY d.id
ORDER BY outages DESC
LIMIT 20;
```

### Average ping latency per device per day (last 30 days)

```sql
SELECT
  d.name,
  date(c.timestamp, 'unixepoch') AS day,
  AVG(c.value) AS avg_latency
FROM chart_10min c
JOIN probe_configs p ON p.service_id = c.service_id
JOIN devices d        ON d.id = p.device_id
JOIN probe_templates t ON t.id = p.probe_type_id
WHERE lower(t.name) LIKE '%ping%'
  AND c.timestamp > strftime('%s', 'now', '-30 days')
GROUP BY d.id, day
ORDER BY d.name, day;
```

### Devices in a named device group

```sql
SELECT d.name, d.address
FROM devices d
JOIN device_group_members m ON m.device_id = d.id
JOIN device_groups g        ON g.id = m.group_id
WHERE g.name = 'Edge Routers';
```

### Custom (non-built-in) probe templates and where they are used

```sql
SELECT t.name AS probe, COUNT(p.id) AS uses
FROM probe_templates t
LEFT JOIN probe_configs p ON p.probe_type_id = t.id
WHERE t.built_in = 0
GROUP BY t.id
ORDER BY uses DESC;
```

### Map-element placements per canvas

```sql
SELECT m.name AS map, COUNT(e.id) AS element_count,
       SUM(CASE WHEN e.device_id IS NOT NULL THEN 1 ELSE 0 END) AS device_nodes
FROM maps m
LEFT JOIN map_elements e ON e.map_id = m.id
GROUP BY m.id
ORDER BY element_count DESC;
```

### Devices missing an SNMP profile but with SNMP enabled

```sql
SELECT id, name, address
FROM devices
WHERE snmp_enabled = 1 AND snmp_profile_id IS NULL;
```

### Topology adjacency — every device's direct neighbors

```sql
SELECT a.name AS device, b.name AS neighbor
FROM v_topology
JOIN devices a ON a.id = device_a_id
JOIN devices b ON b.id = device_b_id
ORDER BY device, neighbor;
```

### Outages in the last 24 hours, by service

```sql
SELECT
  d.name AS device,
  s.name AS service,
  datetime(o.time, 'unixepoch') AS started_at,
  o.duration AS seconds
FROM outages o
JOIN devices  d ON d.id = o.device_id
JOIN services s ON s.id = o.service_id
WHERE o.time > strftime('%s', 'now', '-1 day')
ORDER BY o.time DESC;
```

## Limitations

- **`devices.device_type_id` is currently always NULL.** The `DudeDB.devices()`
  accessor does not yet surface the `0x1F70` type-link tag; adding it requires
  extending the reader. Workaround: join through `v_devices_full` once the
  accessor is updated, or do a parallel raw-blob walk in your own code.
- **Topology B-side resolution is partial.** `topology_links` stores a
  `map_element_b_id`, and `v_topology` resolves both endpoints via the
  `map_elements` table. Some real-world links reference decorative or virtual
  map elements that have no `device_id`, so those neighbors won't appear in
  `v_topology`. The raw `topology_links` row is always preserved.
- **`file_assets` stores metadata only**, not the image bytes. Re-run the
  Dude server if you need the assets themselves.
- **Ephemeral runtime state** (current panel state, transient SNMP caches,
  the `info`/`history` panel buffers) is intentionally not normalized.
- **SNMP credentials and notification action templates** are summarized
  (name, version, port, type) — secrets are not exported.
- **Schema version is `1`.** Future breaking changes will bump it; check
  `_meta.schema_version` when consuming the export programmatically.

## Programmatic API

```ts
import { DudeDB, normalize, normalizeToFile, NORMALIZED_SCHEMA_SQL } from "donny";
import { Database } from "bun:sqlite";

// One-shot file → file
const result = normalizeToFile("dude.db", "out.db", { overwrite: true });

// Or use an open DudeDB and your own destination
const src = DudeDB.openAuto("dude.db", { readonly: true });
const dst = new Database("out.db");
normalize(src, dst, { sourcePath: "dude.db" });
src.close();
dst.close();

// Raw DDL, e.g. for documentation generators
console.log(NORMALIZED_SCHEMA_SQL);
```

The CLI is a thin wrapper over `normalizeToFile` and prints a per-table
summary on success.
