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
| `generated_at`    | ISO-8601 UTC timestamp of the export          |
| `generator`       | `@tikoci/donny normalize`                     |
| `schema_version`  | Integer; bumped when the schema breaks        |

`_table_counts(table_name, row_count)` mirrors what `result.tables` returns
from the API.

## Tables

### Reference data

| Table                          | Source tag range / origin               | Notes |
| ------------------------------ | --------------------------------------- | ----- |
| `device_types`                 | `0x2710–0x271F`                         | `parent_type_id` may reference another type; built-in types flagged |
| `device_type_default_probes`   | continuation of device-type blob         | Junction: which probe templates a device type ships with |
| `probe_templates`              | `0x36B0–0x36D1`                          | `kind` is the Dude probe family; `port` may be NULL for ICMP |
| `link_types`                   | `0x59D8–0x59DB`                          | `speed_bps` from RouterOS link metadata |
| `snmp_profiles`                | `0x3C68–0x3C72`                          | Community/auth fields not currently extracted |
| `notifications`                | `0x3E80–0x3E9B`                          | Email/syslog action targets |
| `data_sources`                 | `0xCB20–0xCB2F`                          | Dude Function/custom expression objects; table name kept for compatibility with earlier donny snapshots |
| `tools`                        | `0x7530–0x7533`                          | User-defined CLI tools |
| `file_assets`                  | `0x697A`                                 | Metadata only — image bytes are not copied |

### Devices and probing

| Table                | Source tag range  | Notes |
| -------------------- | ----------------- | ----- |
| `devices`            | `0x1F40–0x1FA3`   | `dns_mode=1` when address is a DNS name (no IPv4 in record); RouterOS-created DNS devices store the hostname in `NAME` and an empty `Device_DnsNames` string array; `device_type_id` references `device_types(id)` — devices with the 0xFFFFFFFF "no type" sentinel are stored as NULL |
| `device_macs`        | continuation      | Junction: a device may have multiple MACs (RouterOS-discovered) |
| `services`           | `0xBF68–0xBF71`   | Dude DataSource/time-series anchor objects; `unit` defaults to `'s'` (seconds, latency); `enabled=0` for disabled anchors |
| `probe_configs`      | `0x2EE0–0x2EF4`   | Dude Service objects: the actual "device X uses probe Y reporting service Z" rows |

### Topology and maps

| Table             | Source tag range | Notes |
| ----------------- | ---------------- | ----- |
| `maps`            | `0x61A8–0x61FA`  | Canvases (the Dude calls them "Network Maps") |
| `map_elements`    | `0x5DC0–0x5DDF`  | Element placements; only ~1/3 are device nodes — labels/images/sublink endpoints share the table |
| `topology_links`  | `0x55F0–0x55F9`  | Edges between map elements; includes `map_id`, `link_type_id`, master interface, speed/history, and optional Tx/Rx data source ids. B-side normally references a `map_elements.id` (see `v_topology`) |

### Logical groupings

| Table                   | Source tag range  | Notes |
| ----------------------- | ----------------- | ----- |
| `networks`              | `0x2AF8–0x2AFA`   | Named subnets / address-spaces |
| `network_subnets`       | continuation      | Junction: `(network_id, cidr)` |
| `device_groups`         | `0x2328–0x2337`   | Static device groups |
| `device_group_members`  | continuation      | Junction: `(group_id, device_id)` |
| `syslog_rules`          | `0x1770–0x1779`   | Rule pattern + action + optional notification |
| `discover_jobs`         | `0x6590–0x65AD`   | Auto-discovery jobs |
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

### Naming note: Dude object names vs donny table names

The Dude internally calls `0x2EE0–0x2EF4` objects **Service** and
`0xBF68–0xBF71` objects **DataSource**. donny keeps the older, user-facing
names `probe_configs` for the per-device service assignment and `services`
for the time-series/data-source anchor because those names are easier to use
in SQL queries and match the public `DudeDB.services()` API.

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
- **Schema version is `2`.** Future breaking changes will bump it; check
  `_meta.schema_version` when consuming the export programmatically.

## Round-trip / Restoring a `dude.db` (editable)

The reverse transform (`donny denormalize`) is **encoder-first with raw
fallback**, so the normalized DB is the editable source of truth — you can
add, modify, and delete rows in the normalized tables and rebuild a working
`dude.db` from them.

### Per-row dispatch

Every modeled object table carries a `_dirty INTEGER NOT NULL DEFAULT 0`
column. For each row id, denormalize chooses one of three paths:

| Row state                                  | What happens                                             |
| ------------------------------------------ | -------------------------------------------------------- |
| Has raw blob (`_raw_objs`) AND `_dirty=0`  | **Raw fallback** — original Nova blob copied verbatim    |
| Modeled table has encoder AND (`_dirty=1` OR no raw) | **Re-encode** from normalized columns           |
| No encoder AND no raw                      | **Dropped** (counted in `gapReport.dropped`)             |

Raw fallback is byte-identical, so an unedited round-trip is still
SHA-1-identical to the source. Editing or inserting a row sets up an encode
on the next `denormalize`.

### Editing workflow

```sql
-- rename an existing device:
UPDATE devices SET name = 'core-router-01', _dirty = 1 WHERE id = 12;

-- add a brand new device (no raw blob → forced encode):
INSERT INTO devices (id, name, address, _dirty)
VALUES (9000001, 'new-edge-01', '10.20.30.40', 0);

-- add a map node placement + a topology link between two devices:
INSERT INTO map_elements   (id, device_id, x, y, _dirty) VALUES (9000002, 9000001, 100, 200, 0);
INSERT INTO topology_links (id, device_a_id, device_b_id, _dirty) VALUES (9000003, 9000001, 12, 0);
```

Then `donny denormalize normalized.db rebuilt.db` and open `rebuilt.db` in
The Dude — the new objects are there.

### Encoder coverage (Phase 3)

| Modeled table     | Encoder              | Round-trip class         |
| ----------------- | -------------------- | ------------------------ |
| `devices`         | `encodeDevice`       | minimal — IPv4 devices preserve name/address separately; DNS-mode devices follow RouterOS CLI shape and use the address as `NAME` |
| `services`        | `encodeService`      | minimal — name, unit |
| `probe_configs`   | `encodeProbeConfig`  | minimal — device_id, service_id, probe_type_id |
| `map_elements`    | `encodeMapNode`      | minimal — map_id, device_id, x, y |
| `topology_links`  | `encodeTopologyLink` | minimal — map_id, device_a_id, map_element_b_id, link_type_id, master_interface, speed/history, tx/rx data source ids |

"Minimal" means: re-encoding a previously-clean row that you marked `_dirty=1`
will preserve only the columns the encoder reads. Fields not in the
normalized schema (e.g., a device's interfaces, MAC, custom poll-interval
overrides) are lost on re-encode. Raw fallback (the default for unedited
rows) preserves everything. Adding a brand-new row gets only what you supply.

### Gap report

`denormalize()` returns a `gapReport` that surfaces what each path covered:

```ts
gapReport: {
  encoded:        { devices: 3, map_elements: 1, ... },  // ids re-encoded
  rawFallback:    { devices: 116, services: 712, ... },  // ids preserved as-is
  dropped:        0,                                     // no encoder + no raw
  unmodeledRanges:{ snmp_profiles: 5, unknown: 486, ... } // raw blobs by detected Nova range
}
```

`unmodeledRanges` is the **explicit list of missing encoders** — every entry
there is a Nova object class that currently has no normalized columns and
relies entirely on raw fallback. That is the to-do list for future phases.

### `_raw_objs` is transitional fallback

`_raw_objs (id INTEGER PK, obj BLOB)` mirrors every source `objs` row. It
exists so that unedited rows and unmodeled types still round-trip. As more
encoders are added, fewer rows will need it. Treat it as internal storage,
not a query surface — relational queries should go through the normalized
tables / views.

```ts
import { denormalize, denormalizeToFile, DUDE_DB_SCHEMA_SQL } from "donny";
import { Database } from "bun:sqlite";

// File → file
const result = denormalizeToFile("normalized.db", "rebuilt.db", { overwrite: true });
console.log(result.counts); // { objs, outages, chart_raw, ... }
```

Pass `{ skipTimeseries: true }` to rebuild only `objs` (useful when the
normalized DB has been edited and you want a clean structural rebuild).

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
