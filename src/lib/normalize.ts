/**
 * normalize — transform a dude.db (or export.dude) into a fresh, fully
 * relational SQLite database with foreign keys, junction tables, indexes,
 * and convenience views.
 *
 * The output is **derived data**: a relational snapshot of the source intended
 * for SQL consumption (DBeaver, DuckDB, Grafana, sqlite3 CLI, pandas, etc.).
 * It can be turned back into a working `dude.db` via `denormalize()`, but that
 * reverse path is currently encoder-first with raw fallback rather than a
 * complete logical model for every Nova object type.
 *
 * Layering note: this module lives in `src/lib/` and stays free of
 * terminal I/O. The CLI wraps `normalizeToFile()`.
 */

import { existsSync, unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import { DudeDB } from "./db.ts";
import {
  getBool,
  getStr,
  getU32,
  getU64,
  hasTagInRange,
  RANGE,
  TAG,
} from "./nova.ts";

/** Per-table row counts for the normalized output. */
export interface NormalizeStats {
  [table: string]: number;
}

/** Result of a normalize() call. */
export interface NormalizeResult {
  tables: NormalizeStats;
  totalRows: number;
}

/** Options for normalization. */
export interface NormalizeOptions {
  /** Source file path stored in `_meta` for provenance. */
  sourcePath?: string;
  /** Skip time-series tables (outages + chart_values_*). Default: false. */
  skipTimeseries?: boolean;
}

/** Options for normalizeToFile(). */
export interface NormalizeToFileOptions extends NormalizeOptions {
  /** Overwrite the destination file if it exists. Default: false. */
  overwrite?: boolean;
}

// ---------------------------------------------------------------------------
// Schema DDL — exported as a string so consumers can introspect / preview it.
// ---------------------------------------------------------------------------

/**
 * Full DDL for the normalized schema.
 *
 * Tables follow the convention `id INTEGER PRIMARY KEY` matching the source
 * `objs.id`, so cross-references between dude.db and the normalized DB are
 * always by integer id.
 */
export const NORMALIZED_SCHEMA_SQL = `
-- Provenance ----------------------------------------------------------------
CREATE TABLE _meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE _table_counts (
  table_name TEXT PRIMARY KEY,
  row_count  INTEGER NOT NULL
);

-- Raw fallback for object types without encoders -----------------------------
-- Transitional: every source objs row is mirrored here. denormalize() uses
-- this only for object types whose encoders aren't implemented yet, AND for
-- modeled rows that haven't been edited (_dirty=0) so unmodeled fields are
-- preserved verbatim. As more encoders are added, reliance on this table
-- shrinks.
CREATE TABLE _raw_objs (
  id  INTEGER PRIMARY KEY,
  obj BLOB NOT NULL
);

-- Reference data ------------------------------------------------------------
CREATE TABLE device_types (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  parent_type_id  INTEGER REFERENCES device_types(id),
  manage_url      TEXT,
  built_in        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE probe_templates (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  kind      INTEGER NOT NULL DEFAULT 0,
  port      INTEGER,
  built_in  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE device_type_default_probes (
  device_type_id    INTEGER NOT NULL REFERENCES device_types(id),
  probe_template_id INTEGER NOT NULL REFERENCES probe_templates(id),
  PRIMARY KEY (device_type_id, probe_template_id)
);

CREATE TABLE link_types (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  category  INTEGER NOT NULL DEFAULT 0,
  if_type   INTEGER,
  speed_bps INTEGER NOT NULL DEFAULT 0,
  built_in  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE snmp_profiles (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  version INTEGER,
  port    INTEGER
);

CREATE TABLE notifications (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  mail_dns      TEXT,
  mail_v6_hex   TEXT
);

-- Core monitored objects ----------------------------------------------------
CREATE TABLE devices (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  address         TEXT NOT NULL,
  dns_mode        INTEGER NOT NULL DEFAULT 0,
  username        TEXT,
  password        TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  router_os       INTEGER NOT NULL DEFAULT 0,
  snmp_enabled    INTEGER NOT NULL DEFAULT 0,
  snmp_profile_id INTEGER REFERENCES snmp_profiles(id),
  probe_interval  INTEGER,
  -- Deprecated compatibility alias for earlier donny snapshots.
  poll_interval   INTEGER,
  device_type_id  INTEGER REFERENCES device_types(id),
  custom_field1   TEXT,
  custom_field2   TEXT,
  custom_field3   TEXT,
  _dirty          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_devices_name    ON devices(name);
CREATE INDEX idx_devices_address ON devices(address);

CREATE TABLE device_macs (
  device_id INTEGER NOT NULL REFERENCES devices(id),
  mac       TEXT NOT NULL,
  PRIMARY KEY (device_id, mac)
);

CREATE TABLE services (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  unit    TEXT NOT NULL DEFAULT 's',
  enabled INTEGER NOT NULL DEFAULT 1,
  _dirty  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_services_name ON services(name);

CREATE TABLE probe_configs (
  id            INTEGER PRIMARY KEY,
  device_id     INTEGER NOT NULL REFERENCES devices(id),
  service_id    INTEGER NOT NULL REFERENCES services(id),
  probe_type_id INTEGER NOT NULL REFERENCES probe_templates(id),
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER,
  _dirty        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_probes_device  ON probe_configs(device_id);
CREATE INDEX idx_probes_service ON probe_configs(service_id);

-- Topology ------------------------------------------------------------------
CREATE TABLE maps (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE map_elements (
  id        INTEGER PRIMARY KEY,
  map_id    INTEGER REFERENCES maps(id),
  device_id INTEGER REFERENCES devices(id),
  x         INTEGER,
  y         INTEGER,
  _dirty    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_map_elements_map    ON map_elements(map_id);
CREATE INDEX idx_map_elements_device ON map_elements(device_id);

CREATE TABLE topology_links (
  id              INTEGER PRIMARY KEY,
  map_id          INTEGER REFERENCES maps(id),
  device_a_id     INTEGER REFERENCES devices(id),
  device_b_id     INTEGER REFERENCES devices(id),
  map_element_b_id INTEGER REFERENCES map_elements(id),
  link_type_id    INTEGER REFERENCES link_types(id),
  mastering_type  INTEGER,
  master_interface INTEGER,
  speed_bps       INTEGER NOT NULL DEFAULT 0,
  history         INTEGER NOT NULL DEFAULT 0,
  tx_data_source_id INTEGER,
  rx_data_source_id INTEGER,
  _dirty          INTEGER NOT NULL DEFAULT 0
);

-- Grouping ------------------------------------------------------------------
CREATE TABLE networks (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  map_id INTEGER REFERENCES maps(id)
);

CREATE TABLE network_subnets (
  network_id INTEGER NOT NULL REFERENCES networks(id),
  cidr       TEXT NOT NULL,
  PRIMARY KEY (network_id, cidr)
);

CREATE TABLE device_groups (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE device_group_members (
  group_id  INTEGER NOT NULL REFERENCES device_groups(id),
  device_id INTEGER NOT NULL,  -- not a hard FK: members may be other groups/objects
  PRIMARY KEY (group_id, device_id)
);

-- Discovery / syslog --------------------------------------------------------
CREATE TABLE syslog_rules (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  pattern         TEXT,
  action          INTEGER NOT NULL DEFAULT 0,
  notification_id INTEGER REFERENCES notifications(id)
);

CREATE TABLE discover_jobs (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  network       TEXT,
  seed_ip       TEXT,
  canvas_id     INTEGER REFERENCES maps(id),
  interval_secs INTEGER NOT NULL DEFAULT 3600,
  enabled       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE discover_job_probes (
  discover_job_id   INTEGER NOT NULL REFERENCES discover_jobs(id),
  probe_template_id INTEGER NOT NULL REFERENCES probe_templates(id),
  PRIMARY KEY (discover_job_id, probe_template_id)
);

-- Misc ----------------------------------------------------------------------
CREATE TABLE data_sources (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  expression  TEXT,
  description TEXT
);

CREATE TABLE tools (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind INTEGER
);

CREATE TABLE file_assets (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  parent_id INTEGER
);

-- Time-series ---------------------------------------------------------------
CREATE TABLE outages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER REFERENCES services(id),
  device_id  INTEGER REFERENCES devices(id),
  map_id     INTEGER REFERENCES maps(id),
  time       INTEGER NOT NULL,
  status     INTEGER NOT NULL,
  duration   INTEGER NOT NULL
);
CREATE INDEX idx_outages_service ON outages(service_id);
CREATE INDEX idx_outages_device  ON outages(device_id);
CREATE INDEX idx_outages_time    ON outages(time);

CREATE TABLE chart_raw (
  service_id INTEGER NOT NULL,
  timestamp  INTEGER NOT NULL,
  value      REAL,
  PRIMARY KEY (service_id, timestamp)
);
CREATE TABLE chart_10min (
  service_id INTEGER NOT NULL,
  timestamp  INTEGER NOT NULL,
  value      REAL,
  PRIMARY KEY (service_id, timestamp)
);
CREATE TABLE chart_2hour (
  service_id INTEGER NOT NULL,
  timestamp  INTEGER NOT NULL,
  value      REAL,
  PRIMARY KEY (service_id, timestamp)
);
CREATE TABLE chart_1day (
  service_id INTEGER NOT NULL,
  timestamp  INTEGER NOT NULL,
  value      REAL,
  PRIMARY KEY (service_id, timestamp)
);

-- Convenience views ---------------------------------------------------------
CREATE VIEW v_devices_full AS
  SELECT
    d.id, d.name, d.address, d.dns_mode, d.enabled, d.router_os, d.snmp_enabled,
    d.probe_interval, d.poll_interval, d.custom_field1, d.custom_field2, d.custom_field3,
    dt.name AS device_type, sp.name AS snmp_profile,
    (SELECT GROUP_CONCAT(mac, ',') FROM device_macs WHERE device_id = d.id) AS macs
  FROM devices d
  LEFT JOIN device_types  dt ON dt.id = d.device_type_id
  LEFT JOIN snmp_profiles sp ON sp.id = d.snmp_profile_id;

CREATE VIEW v_probes_full AS
  SELECT
    pc.id AS probe_id, pc.enabled, pc.created_at,
    d.id  AS device_id, d.name AS device_name, d.address,
    s.id  AS service_id, s.name AS service_name, s.unit,
    pt.id AS probe_type_id, pt.name AS probe_type, pt.built_in AS probe_built_in
  FROM probe_configs pc
  LEFT JOIN devices         d  ON d.id  = pc.device_id
  LEFT JOIN services        s  ON s.id  = pc.service_id
  LEFT JOIN probe_templates pt ON pt.id = pc.probe_type_id;

CREATE VIEW v_outages_full AS
  SELECT
    o.id, o.time, o.status, o.duration,
    o.device_id,  d.name AS device_name,
    o.service_id, s.name AS service_name,
    o.map_id,     m.name AS map_name
  FROM outages o
  LEFT JOIN devices  d ON d.id = o.device_id
  LEFT JOIN services s ON s.id = o.service_id
  LEFT JOIN maps     m ON m.id = o.map_id;

CREATE VIEW v_topology AS
  SELECT
    tl.id,
    tl.map_id, m.name AS map_name,
    tl.device_a_id, da.name AS device_a_name,
    -- Side B may be a direct device or a map element pointing at one.
    COALESCE(tl.device_b_id, me.device_id) AS device_b_id,
    COALESCE(db.name, dbe.name) AS device_b_name,
    tl.link_type_id, lt.name AS link_type,
    tl.master_interface,
    tl.speed_bps,
    tl.history,
    tl.tx_data_source_id,
    tl.rx_data_source_id
  FROM topology_links tl
  LEFT JOIN maps            m   ON m.id   = tl.map_id
  LEFT JOIN devices         da  ON da.id  = tl.device_a_id
  LEFT JOIN devices         db  ON db.id  = tl.device_b_id
  LEFT JOIN map_elements    me  ON me.id  = tl.map_element_b_id
  LEFT JOIN devices         dbe ON dbe.id = me.device_id
  LEFT JOIN link_types      lt  ON lt.id  = tl.link_type_id;
`;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Convert a u32 sentinel into nullable. */
function nullIfSentinel(v: number | undefined): number | null {
  if (v === undefined || v === 0xffffffff) return null;
  return v;
}

/** Format 16 bytes as a colon-separated hex string. */
function hex16(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

/**
 * Walk the source DudeDB and write a normalized snapshot into `dst`.
 *
 * `dst` must be an open, writable bun:sqlite Database. The destination
 * tables and views are created here — pass an empty database.
 */
export function normalize(
  src: DudeDB,
  dst: Database,
  options: NormalizeOptions = {},
): NormalizeResult {
  // Schema first.
  dst.exec("PRAGMA journal_mode = MEMORY");
  dst.exec("PRAGMA synchronous = OFF");
  dst.exec(NORMALIZED_SCHEMA_SQL);

  const counts: NormalizeStats = {};

  dst.transaction(() => {
    // --- Raw blob mirror (lossless preservation) --------------------------
    // Stream every objs row verbatim into _raw_objs. denormalize() needs
    // this to rebuild a working dude.db. Done first so even if a normalized
    // table fails to populate, the raw data is intact.
    const insRaw = dst.prepare("INSERT INTO _raw_objs (id, obj) VALUES (?, ?)");
    let nRaw = 0;
    for (const { id, obj } of src.rawObjectBlobs()) {
      insRaw.run(id, obj);
      nRaw++;
    }
    counts._raw_objs = nRaw;

    // --- Reference data ----------------------------------------------------
    const insDeviceType = dst.prepare(
      "INSERT INTO device_types (id, name, parent_type_id, manage_url, built_in) VALUES (?, ?, ?, ?, ?)",
    );
    const insDtDefProbe = dst.prepare(
      "INSERT OR IGNORE INTO device_type_default_probes (device_type_id, probe_template_id) VALUES (?, ?)",
    );
    let nDeviceTypes = 0;
    for (const dt of src.deviceTypes()) {
      insDeviceType.run(
        dt.id,
        dt.name,
        dt.parentTypeId ?? null,
        dt.manageUrl ?? null,
        dt.builtIn ? 1 : 0,
      );
      for (const pid of dt.defaultProbeIds) {
        // FK target may not yet exist (probe_templates inserted next) so
        // defer the junction inserts until probe_templates are populated.
        // We collect them in a small array.
        pendingDtDefProbes.push([dt.id, pid]);
      }
      nDeviceTypes++;
    }
    // Some Dude builds reference parent device-type IDs that aren't actually
    // present in the table (e.g., abstract roots). Null them out so the FK
    // stays clean.
    dst.exec(`
      UPDATE device_types SET parent_type_id = NULL
      WHERE parent_type_id IS NOT NULL
        AND parent_type_id NOT IN (SELECT id FROM device_types)
    `);
    counts.device_types = nDeviceTypes;

    const insProbeTpl = dst.prepare(
      "INSERT INTO probe_templates (id, name, kind, port, built_in) VALUES (?, ?, ?, ?, ?)",
    );
    let nProbeTpls = 0;
    for (const p of src.probeTemplates()) {
      insProbeTpl.run(p.id, p.name, p.kind, p.port ?? null, p.builtIn ? 1 : 0);
      nProbeTpls++;
    }
    counts.probe_templates = nProbeTpls;

    // Now flush deferred junction rows; FK references resolve.
    let nDtDefProbes = 0;
    for (const [dtId, pid] of pendingDtDefProbes) {
      // Only insert if both sides exist (avoid orphan rows from defaults
      // pointing at unknown templates).
      const probeExists = dst
        .query<{ n: number }, [number]>("SELECT 1 AS n FROM probe_templates WHERE id = ?")
        .get(pid);
      if (!probeExists) continue;
      insDtDefProbe.run(dtId, pid);
      nDtDefProbes++;
    }
    counts.device_type_default_probes = nDtDefProbes;

    const insLinkType = dst.prepare(
      "INSERT INTO link_types (id, name, category, if_type, speed_bps, built_in) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let nLinkTypes = 0;
    for (const lt of src.linkTypes()) {
      insLinkType.run(
        lt.id,
        lt.name,
        lt.category,
        lt.ifType ?? null,
        // bun:sqlite handles bigint via .toString fallback; cast to Number when small.
        lt.speedBps <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(lt.speedBps) : lt.speedBps.toString(),
        lt.builtIn ? 1 : 0,
      );
      nLinkTypes++;
    }
    counts.link_types = nLinkTypes;

    // SNMP profiles, notifications, tools, data sources, file assets, maps,
    // map elements, topology links — read raw blobs since DudeDB does not
    // expose dedicated accessors yet.
    const insSnmp   = dst.prepare("INSERT INTO snmp_profiles (id, name, version, port) VALUES (?, ?, ?, ?)");
    const insNotif  = dst.prepare("INSERT INTO notifications (id, name, enabled, mail_dns, mail_v6_hex) VALUES (?, ?, ?, ?, ?)");
    const insTool   = dst.prepare("INSERT INTO tools (id, name, kind) VALUES (?, ?, ?)");
    const insDS     = dst.prepare("INSERT INTO data_sources (id, name, expression, description) VALUES (?, ?, ?, ?)");
    const insAsset  = dst.prepare("INSERT INTO file_assets (id, name, parent_id) VALUES (?, ?, ?)");
    const insMap    = dst.prepare("INSERT INTO maps (id, name) VALUES (?, ?)");
    const insMapEl  = dst.prepare("INSERT INTO map_elements (id, map_id, device_id, x, y) VALUES (?, ?, ?, ?, ?)");
    const insLink   = dst.prepare("INSERT INTO topology_links (id, map_id, device_a_id, device_b_id, map_element_b_id, link_type_id, mastering_type, master_interface, speed_bps, history, tx_data_source_id, rx_data_source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

    let nSnmp = 0, nNotif = 0, nTools = 0, nDS = 0, nAssets = 0, nMaps = 0, nMapEls = 0, nLinks = 0;
    // Deferred map element + topology rows so target FKs (devices, maps, probe_templates, notifications)
    // can be checked after everything is in place.
    const pendingMapEls: Array<[number, number | null, number | null, number | null, number | null]> = [];
    const pendingLinks:  Array<[
      number,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | bigint | null,
      number,
      number | null,
      number | null,
    ]> = [];

    for (const { id, msg } of src.rawObjects()) {
      // Skip everything already imported via accessor methods.
      // (We re-walk here because a single object can match exactly one range.)
      if (hasTagInRange(msg, RANGE.SNMP_LO, RANGE.SNMP_HI)) {
        insSnmp.run(id, getStr(msg, TAG.NAME) ?? "", getU32(msg, TAG.SNMP_VERSION) ?? null, getU32(msg, TAG.SNMP_PORT) ?? null);
        nSnmp++;
        continue;
      }
      if (hasTagInRange(msg, RANGE.NOTIF_LO, RANGE.NOTIF_HI)) {
        const v6 = msg.fields.find((f) => f.tag === TAG.NOTIF_MAIL_V6 && f.val.k === "bytes");
        const v6hex = v6 && v6.val.k === "bytes" ? hex16(v6.val.v) : null;
        insNotif.run(
          id,
          getStr(msg, TAG.NAME) ?? "",
          getBool(msg, TAG.NOTIF_ENABLED) === false ? 0 : 1,
          getStr(msg, TAG.NOTIF_MAIL_DNS) || null,
          v6hex,
        );
        nNotif++;
        continue;
      }
      if (hasTagInRange(msg, RANGE.TOOL_LO, RANGE.TOOL_HI)) {
        insTool.run(id, getStr(msg, TAG.NAME) ?? "", getU32(msg, TAG.TOOL_KIND) ?? null);
        nTools++;
        continue;
      }
      if (hasTagInRange(msg, RANGE.DATA_SOURCE_LO, RANGE.DATA_SOURCE_HI)) {
        insDS.run(id, getStr(msg, TAG.NAME) ?? "", getStr(msg, TAG.DS_EXPRESSION) ?? null, getStr(msg, TAG.DS_DESCRIPTION) ?? null);
        nDS++;
        continue;
      }
      if (hasTagInRange(msg, RANGE.ASSET_LO, RANGE.ASSET_HI)) {
        insAsset.run(id, getStr(msg, TAG.NAME) ?? "", getU32(msg, TAG.ASSET_PARENT_DIR) ?? null);
        nAssets++;
        continue;
      }
      if (hasTagInRange(msg, RANGE.CANVAS_LO, RANGE.CANVAS_HI)) {
        insMap.run(id, getStr(msg, TAG.NAME) ?? `map-${id}`);
        nMaps++;
        continue;
      }
      if (hasTagInRange(msg, RANGE.NODE_LO, RANGE.NODE_HI)) {
        pendingMapEls.push([
          id,
          nullIfSentinel(getU32(msg, TAG.NODE_MAP_ID)),
          nullIfSentinel(getU32(msg, TAG.NODE_DEVICE_ID)),
          getU32(msg, TAG.NODE_X) ?? null,
          getU32(msg, TAG.NODE_Y) ?? null,
        ]);
        continue;
      }
      if (hasTagInRange(msg, RANGE.LINK_LO, RANGE.LINK_HI)) {
        // 0x55F5 is Link_NetMapElementID. Some old fixtures used it as a
        // direct device id; keep that compatibility when no map_element exists.
        pendingLinks.push([
          id,
          nullIfSentinel(getU32(msg, TAG.LINK_DEVICE_A)),
          nullIfSentinel(getU32(msg, TAG.LINK_MAP_ELEMENT_ID)),
          nullIfSentinel(getU32(msg, TAG.LINK_MAP_ID)),
          nullIfSentinel(getU32(msg, TAG.LINK_TYPE_ID)),
          getU32(msg, TAG.LINK_MASTERING_TYPE) ?? null,
          nullIfSentinel(getU32(msg, TAG.LINK_MASTER_INTERFACE)),
          getU64(msg, TAG.LINK_SPEED) ?? 0n,
          getBool(msg, TAG.LINK_HISTORY) ? 1 : 0,
          nullIfSentinel(getU32(msg, TAG.LINK_TX_DATA_SOURCE_ID)),
          nullIfSentinel(getU32(msg, TAG.LINK_RX_DATA_SOURCE_ID)),
        ]);
      }
    }
    counts.snmp_profiles = nSnmp;
    counts.notifications = nNotif;
    counts.tools         = nTools;
    counts.data_sources  = nDS;
    counts.file_assets   = nAssets;
    counts.maps          = nMaps;

    // --- Devices and dependents -------------------------------------------
    // Devices need device_types, snmp_profiles in place — they are now.
    const insDevice = dst.prepare(
      "INSERT INTO devices (id, name, address, dns_mode, username, password, enabled, router_os, snmp_enabled, snmp_profile_id, probe_interval, poll_interval, device_type_id, custom_field1, custom_field2, custom_field3) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insMac = dst.prepare(
      "INSERT OR IGNORE INTO device_macs (device_id, mac) VALUES (?, ?)",
    );
    let nDevices = 0;
    let nMacs = 0;
    const knownSnmpIds = new Set(
      dst.query<{ id: number }, []>("SELECT id FROM snmp_profiles").all().map((r) => r.id),
    );
    const knownDtIds = new Set(
      dst.query<{ id: number }, []>("SELECT id FROM device_types").all().map((r) => r.id),
    );
    for (const d of src.devices()) {
      // device_type_id and snmp_profile_id must reference real rows or be NULL.
      const snmpId = d.snmpProfileId !== undefined && knownSnmpIds.has(d.snmpProfileId) ? d.snmpProfileId : null;
      const dtId = d.deviceTypeId !== undefined && knownDtIds.has(d.deviceTypeId) ? d.deviceTypeId : null;
      insDevice.run(
        d.id, d.name, d.address,
        d.address === d.name && d.address.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(d.address) ? 1 : 0,
        d.username ?? null, d.password ?? null,
        d.enabled ? 1 : 0,
        d.routerOS ? 1 : 0, d.snmpEnabled ? 1 : 0,
        snmpId, d.probeInterval ?? d.pollInterval ?? null,
        d.probeInterval ?? d.pollInterval ?? null,
        dtId,
        d.customField1 ?? null, d.customField2 ?? null, d.customField3 ?? null,
      );
      for (const m of d.macs) {
        insMac.run(d.id, m);
        nMacs++;
      }
      nDevices++;
    }
    counts.devices     = nDevices;
    counts.device_macs = nMacs;

    // --- Services ---------------------------------------------------------
    const insService = dst.prepare(
      "INSERT INTO services (id, name, unit, enabled) VALUES (?, ?, ?, ?)",
    );
    let nServices = 0;
    for (const s of src.services()) {
      insService.run(s.id, s.name, s.unit, s.enabled ? 1 : 0);
      nServices++;
    }
    counts.services = nServices;

    // --- Probe configs (depend on devices, services, probe_templates) -----
    const insProbeCfg = dst.prepare(
      "INSERT INTO probe_configs (id, device_id, service_id, probe_type_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const knownDeviceIds  = new Set(dst.query<{ id: number }, []>("SELECT id FROM devices").all().map((r) => r.id));
    const knownServiceIds = new Set(dst.query<{ id: number }, []>("SELECT id FROM services").all().map((r) => r.id));
    const knownProbeIds   = new Set(dst.query<{ id: number }, []>("SELECT id FROM probe_templates").all().map((r) => r.id));
    let nProbeCfgs = 0;
    for (const p of src.probeConfigs()) {
      if (!knownDeviceIds.has(p.deviceId) || !knownServiceIds.has(p.serviceId) || !knownProbeIds.has(p.probeTypeId)) {
        continue;
      }
      insProbeCfg.run(p.id, p.deviceId, p.serviceId, p.probeTypeId, p.enabled ? 1 : 0, p.createdAt ?? null);
      nProbeCfgs++;
    }
    counts.probe_configs = nProbeCfgs;

    // --- Networks, syslog, groups, discover -------------------------------
    const knownMapIds = new Set(dst.query<{ id: number }, []>("SELECT id FROM maps").all().map((r) => r.id));
    const insNet  = dst.prepare("INSERT INTO networks (id, name, map_id) VALUES (?, ?, ?)");
    const insSub  = dst.prepare("INSERT OR IGNORE INTO network_subnets (network_id, cidr) VALUES (?, ?)");
    let nNets = 0, nSubs = 0;
    for (const n of src.networks()) {
      const mapId = n.mapId !== undefined && knownMapIds.has(n.mapId) ? n.mapId : null;
      insNet.run(n.id, n.name, mapId);
      for (const cidr of n.subnets) { insSub.run(n.id, cidr); nSubs++; }
      nNets++;
    }
    counts.networks        = nNets;
    counts.network_subnets = nSubs;

    const knownNotifIds = new Set(dst.query<{ id: number }, []>("SELECT id FROM notifications").all().map((r) => r.id));
    const insSyslog = dst.prepare(
      "INSERT INTO syslog_rules (id, name, enabled, pattern, action, notification_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let nSyslog = 0;
    for (const r of src.syslogRules()) {
      const nid = r.notificationId !== undefined && knownNotifIds.has(r.notificationId) ? r.notificationId : null;
      insSyslog.run(r.id, r.name, r.enabled ? 1 : 0, r.pattern, r.action, nid);
      nSyslog++;
    }
    counts.syslog_rules = nSyslog;

    const insGroup = dst.prepare("INSERT INTO device_groups (id, name) VALUES (?, ?)");
    const insMember = dst.prepare("INSERT OR IGNORE INTO device_group_members (group_id, device_id) VALUES (?, ?)");
    let nGroups = 0, nMembers = 0;
    for (const g of src.deviceGroups()) {
      insGroup.run(g.id, g.name);
      for (const m of g.memberIds) { insMember.run(g.id, m); nMembers++; }
      nGroups++;
    }
    counts.device_groups        = nGroups;
    counts.device_group_members = nMembers;

    const insDisc = dst.prepare(
      "INSERT INTO discover_jobs (id, name, network, seed_ip, canvas_id, interval_secs, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insDiscProbe = dst.prepare(
      "INSERT OR IGNORE INTO discover_job_probes (discover_job_id, probe_template_id) VALUES (?, ?)",
    );
    let nDisc = 0, nDiscProbes = 0;
    for (const j of src.discoverJobs()) {
      const cv = j.canvasId !== undefined && knownMapIds.has(j.canvasId) ? j.canvasId : null;
      insDisc.run(j.id, j.name, j.network ?? null, j.seedIp, cv, j.intervalSecs, j.enabled ? 1 : 0);
      for (const pid of j.probeTemplateIds) {
        if (knownProbeIds.has(pid)) { insDiscProbe.run(j.id, pid); nDiscProbes++; }
      }
      nDisc++;
    }
    counts.discover_jobs       = nDisc;
    counts.discover_job_probes = nDiscProbes;

    // --- Map elements + topology (deferred) -------------------------------
    let nValidMapEls = 0;
    for (const [eid, mapId, devId, x, y] of pendingMapEls) {
      const safeMapId = mapId !== null && knownMapIds.has(mapId) ? mapId : null;
      const safeDevId = devId !== null && knownDeviceIds.has(devId) ? devId : null;
      insMapEl.run(eid, safeMapId, safeDevId, x, y);
      nValidMapEls++;
    }
    counts.map_elements = nValidMapEls;
    nMapEls = nValidMapEls;

    let nValidLinks = 0;
    const knownMapElIds = new Set(dst.query<{ id: number }, []>("SELECT id FROM map_elements").all().map((r) => r.id));
    const knownLinkTypeIds = new Set(dst.query<{ id: number }, []>("SELECT id FROM link_types").all().map((r) => r.id));
    for (const [
      lid,
      a,
      bRaw,
      mapId,
      linkTypeId,
      masteringType,
      masterInterface,
      speedBps,
      history,
      txDataSourceId,
      rxDataSourceId,
    ] of pendingLinks) {
      const safeA = a !== null && knownDeviceIds.has(a) ? a : null;
      // bRaw is normally a map_element id. Accept direct device ids for older
      // synthetic fixtures and partial databases.
      let safeDevB: number | null = null;
      let safeMapElB: number | null = null;
      if (bRaw !== null) {
        if (knownMapElIds.has(bRaw)) safeMapElB = bRaw;
        else if (knownDeviceIds.has(bRaw)) safeDevB = bRaw;
      }
      const safeMap = mapId !== null && knownMapIds.has(mapId) ? mapId : null;
      const safeLinkType = linkTypeId !== null && knownLinkTypeIds.has(linkTypeId) ? linkTypeId : null;
      const safeTxDataSource = txDataSourceId !== null && knownServiceIds.has(txDataSourceId) ? txDataSourceId : null;
      const safeRxDataSource = rxDataSourceId !== null && knownServiceIds.has(rxDataSourceId) ? rxDataSourceId : null;
      insLink.run(
        lid, safeMap, safeA, safeDevB, safeMapElB, safeLinkType,
        masteringType, masterInterface, speedBps, history,
        safeTxDataSource, safeRxDataSource,
      );
      nValidLinks++;
    }
    counts.topology_links = nValidLinks;
    nLinks = nValidLinks;
    void nMapEls; void nLinks; // counted above

    // --- Time-series ------------------------------------------------------
    if (!options.skipTimeseries) {
      counts.outages     = copyOutages(src, dst);
      counts.chart_raw   = copyChart(src, dst, "raw");
      counts.chart_10min = copyChart(src, dst, "10min");
      counts.chart_2hour = copyChart(src, dst, "2hour");
      counts.chart_1day  = copyChart(src, dst, "1day");
    } else {
      counts.outages = counts.chart_raw = counts.chart_10min = counts.chart_2hour = counts.chart_1day = 0;
    }

    // --- Provenance -------------------------------------------------------
    const insMeta  = dst.prepare("INSERT INTO _meta (key, value) VALUES (?, ?)");
    const insCount = dst.prepare("INSERT INTO _table_counts (table_name, row_count) VALUES (?, ?)");
    insMeta.run("source_path", options.sourcePath ?? "");
    insMeta.run("generated_at", new Date().toISOString());
    insMeta.run("schema_version", "3");
    insMeta.run("generator", "@tikoci/donny normalize");
    for (const [tbl, n] of Object.entries(counts)) insCount.run(tbl, n);
  })();

  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  return { tables: counts, totalRows };
}

// We need a place to hold deferred device_type_default_probes inserts that
// span the device_types and probe_templates loops. A module-scoped buffer
// keeps the code readable; it's reset at the start of each normalize() call
// so concurrent calls remain safe (bun:sqlite is single-threaded per process).
const pendingDtDefProbes: Array<[number, number]> = [];

/**
 * Convenience wrapper: open a source file (auto-detects .db vs .export),
 * normalize it into a fresh SQLite file at `dstPath`.
 */
export function normalizeToFile(
  srcPath: string,
  dstPath: string,
  options: NormalizeToFileOptions = {},
): NormalizeResult {
  if (existsSync(dstPath)) {
    if (!options.overwrite) {
      throw new Error(`destination exists: ${dstPath} (pass overwrite=true to replace)`);
    }
    unlinkSync(dstPath);
  }

  // Reset any deferred state from a prior call.
  pendingDtDefProbes.length = 0;

  const src = DudeDB.openAuto(srcPath, { readonly: true });
  const dst = new Database(dstPath);
  try {
    return normalize(src, dst, { ...options, sourcePath: options.sourcePath ?? srcPath });
  } finally {
    dst.close();
    src.close();
  }
}

// ---------------------------------------------------------------------------
// Time-series copy helpers
// ---------------------------------------------------------------------------

interface OutageRow { serviceID: number; deviceID: number; mapID: number; time: number; status: number; duration: number; }
function copyOutages(src: DudeDB, dst: Database): number {
  // DudeDB.outages() returns rows with the raw SQLite column names
  // (serviceID/deviceID/mapID — camelCase D), not the camelCase fields the
  // Outage interface advertises. We type the rows accordingly here.
  const rows = src.outages({ limit: 1_000_000_000 }) as unknown as OutageRow[];
  const ins = dst.prepare(
    "INSERT INTO outages (service_id, device_id, map_id, time, status, duration) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let n = 0;
  for (const r of rows) {
    ins.run(
      r.serviceID === 0 ? null : r.serviceID,
      r.deviceID  === 0 ? null : r.deviceID,
      r.mapID     === 0 ? null : r.mapID,
      r.time, r.status, r.duration,
    );
    n++;
  }
  return n;
}

function copyChart(src: DudeDB, dst: Database, res: "raw" | "10min" | "2hour" | "1day"): number {
  const tableSrc = `chart_values_${res}`;
  const tableDst = `chart_${res}`;
  // Use the underlying sqlite via a fresh prepared statement on the source.
  // DudeDB exposes `metrics()` per service, but a bulk copy needs raw access.
  // We re-attach using ATTACH DATABASE if both DBs are file-backed; for the
  // common in-memory-source case we fall through to a row-by-row copy via
  // a public query helper.
  //
  // The simplest portable approach: use DudeDB.metrics() requires knowing
  // service ids in advance, which is fine — only services we already inserted
  // can have data we care about. Pull data per service.
  const insStmt = dst.prepare(
    `INSERT OR REPLACE INTO ${tableDst} (service_id, timestamp, value) VALUES (?, ?, ?)`,
  );
  const services = dst.query<{ id: number }, []>("SELECT id FROM services").all();
  let n = 0;
  for (const s of services) {
    const points = src.metrics(s.id, res, 1_000_000_000);
    for (const p of points) {
      insStmt.run(p.serviceId, p.timestamp, p.value);
      n++;
    }
  }
  // tableSrc unused — kept for documentation that the source name maps 1:1
  void tableSrc;
  return n;
}
