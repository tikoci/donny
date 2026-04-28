/**
 * denormalize — rebuild a working dude.db from a normalized SQLite file.
 *
 * Encoder-first with raw fallback. For each object id:
 *   1. If a normalized table covers its type AND row is _dirty=1 (or there's
 *      no raw blob for this id, i.e. user-added) → re-encode from columns.
 *   2. Else if `_raw_objs` has the row → copy verbatim (preserves all
 *      unmodeled fields for the long tail of object types).
 *   3. Else → drop, count in `gap_report.dropped`.
 *
 * The result includes a `gapReport` describing per-type encoder coverage so
 * callers can see which Nova types still rely on raw fallback.
 *
 * Layering: pure library, no terminal I/O. CLI wraps `denormalizeToFile()`.
 */

import { existsSync, unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  encodeDevice,
  encodeMapNode,
  encodeProbeConfig,
  encodeService,
  encodeTopologyLink,
  RANGE,
} from "./nova.ts";

/** DDL for the original dude.db schema. */
export const DUDE_DB_SCHEMA_SQL = `
CREATE TABLE objs (
  id  integer primary key,
  obj blob
);

CREATE TABLE outages (
  timeAndServiceID integer primary key,
  serviceID integer,
  deviceID  integer,
  mapID     integer,
  time      integer,
  status    integer,
  duration  integer
);
CREATE INDEX outages_idx_serviceID_time ON outages(serviceID, time);
CREATE INDEX outages_idx_deviceID_time  ON outages(deviceID, timeAndServiceID);
CREATE INDEX outages_idx_mapID_time     ON outages(mapID, timeAndServiceID);

CREATE TABLE chart_values_raw    (sourceIDandTime integer primary key, value);
CREATE TABLE chart_values_10min  (sourceIDandTime integer primary key, value);
CREATE TABLE chart_values_2hour  (sourceIDandTime integer primary key, value);
CREATE TABLE chart_values_1day   (sourceIDandTime integer primary key, value);
`;

/** Per-table row counts for the rebuilt dude.db. */
export interface DenormalizeStats {
  objs: number;
  outages: number;
  chart_values_raw: number;
  chart_values_10min: number;
  chart_values_2hour: number;
  chart_values_1day: number;
}

/**
 * Coverage report describing how each rebuilt object got its blob.
 *
 * - `encoded[type]`     — count of ids re-encoded from normalized columns
 *                         (either user-edited / _dirty=1, or user-added)
 * - `rawFallback[type]` — count of ids copied verbatim from `_raw_objs`
 *                         because the type has no encoder, OR because the
 *                         normalized row is clean (_dirty=0) and we want to
 *                         preserve unmodeled fields
 * - `dropped`           — ids only in normalized but no encoder + no raw blob
 * - `unmodeledRanges`   — for raw-fallback ids, breakdown by detected range
 *                         (surfaces which Nova types still need encoders)
 */
export interface GapReport {
  encoded: Record<string, number>;
  rawFallback: Record<string, number>;
  dropped: number;
  unmodeledRanges: Record<string, number>;
}

export interface DenormalizeResult {
  tables: DenormalizeStats;
  totalRows: number;
  gapReport: GapReport;
}

export interface DenormalizeOptions {
  /** Skip time-series copy (outages + chart_values_*). Default: false. */
  skipTimeseries?: boolean;
}

export interface DenormalizeToFileOptions extends DenormalizeOptions {
  /** Overwrite the destination file if it exists. Default: false. */
  overwrite?: boolean;
}

interface RawRow { id: number; obj: Uint8Array | Buffer }

// ---------------------------------------------------------------------------
// Encoder dispatch
// ---------------------------------------------------------------------------

interface EncoderTable<TRow> {
  /** Normalized table name. */
  table: string;
  /** SELECT statement returning at minimum `id` and `_dirty` columns. */
  select: string;
  /** Build a Nova blob from a row. */
  encode: (row: TRow) => Uint8Array;
}

interface DeviceRow {
  id: number;
  name: string;
  address: string;
  username: string | null;
  password: string | null;
  router_os: number;
  snmp_enabled: number;
  snmp_profile_id: number | null;
  _dirty: number;
}
interface ServiceRow {
  id: number;
  name: string;
  unit: string;
  _dirty: number;
}
interface ProbeRow {
  id: number;
  device_id: number;
  service_id: number;
  probe_type_id: number;
  _dirty: number;
}
interface MapElementRow {
  id: number;
  map_id: number | null;
  device_id: number | null;
  x: number | null;
  y: number | null;
  _dirty: number;
}
interface TopologyLinkRow {
  id: number;
  map_id: number | null;
  device_a_id: number | null;
  device_b_id: number | null;
  map_element_b_id: number | null;
  link_type_id: number | null;
  mastering_type: number | null;
  master_interface: number | null;
  speed_bps: number | bigint | string | null;
  history: number | null;
  tx_data_source_id: number | null;
  rx_data_source_id: number | null;
  _dirty: number;
}

const ENCODER_TABLES: EncoderTable<unknown>[] = [
  {
    table: "devices",
    select: "SELECT id, name, address, username, password, router_os, snmp_enabled, snmp_profile_id, _dirty FROM devices",
    encode: (row) => {
      const r = row as DeviceRow;
      return encodeDevice({
        id: r.id,
        name: r.name,
        address: r.address,
        username: r.username ?? "",
        password: r.password ?? "",
        routerOS: !!r.router_os,
        snmpEnabled: !!r.snmp_enabled,
        snmpProfileId: r.snmp_profile_id ?? 0xffffffff,
      });
    },
  },
  {
    table: "services",
    select: "SELECT id, name, unit, _dirty FROM services",
    encode: (row) => {
      const r = row as ServiceRow;
      return encodeService({ id: r.id, name: r.name, unit: r.unit });
    },
  },
  {
    table: "probe_configs",
    select: "SELECT id, device_id, service_id, probe_type_id, _dirty FROM probe_configs",
    encode: (row) => {
      const r = row as ProbeRow;
      return encodeProbeConfig({
        id: r.id,
        deviceId: r.device_id,
        serviceId: r.service_id,
        probeTypeId: r.probe_type_id,
      });
    },
  },
  {
    table: "map_elements",
    select: "SELECT id, map_id, device_id, x, y, _dirty FROM map_elements",
    encode: (row) => {
      const r = row as MapElementRow;
      return encodeMapNode({
        id: r.id,
        mapId: r.map_id ?? 0,
        deviceId: r.device_id ?? 0xffffffff,
        x: r.x ?? 0,
        y: r.y ?? 0,
      });
    },
  },
  {
    table: "topology_links",
    select: "SELECT id, map_id, device_a_id, device_b_id, map_element_b_id, link_type_id, mastering_type, master_interface, speed_bps, history, tx_data_source_id, rx_data_source_id, _dirty FROM topology_links",
    encode: (row) => {
      const r = row as TopologyLinkRow;
      return encodeTopologyLink({
        id: r.id,
        mapId: r.map_id ?? 0xffffffff,
        deviceAId: r.device_a_id ?? 0xffffffff,
        deviceBId: r.device_b_id ?? 0xffffffff,
        mapElementBId: r.map_element_b_id ?? 0xffffffff,
        linkTypeId: r.link_type_id ?? 0xffffffff,
        masteringType: r.mastering_type ?? 0,
        masterInterface: r.master_interface ?? 0xffffffff,
        speedBps: typeof r.speed_bps === "string" ? BigInt(r.speed_bps) : (r.speed_bps ?? 0),
        history: !!r.history,
        txDataSourceId: r.tx_data_source_id ?? 0xffffffff,
        rxDataSourceId: r.rx_data_source_id ?? 0xffffffff,
      });
    },
  },
];

// Detect the Nova range of a raw blob, for gap reporting. Heuristic scan
// (no full decode) — adequate for surfacing which Nova types still need
// encoders.
function detectRange(buf: Uint8Array): string {
  const checks: Array<[string, number, number]> = [
    ["devices", RANGE.DEVICE_LO, RANGE.DEVICE_HI],
    ["services", RANGE.SERVICE_LO, RANGE.SERVICE_HI],
    ["probe_configs", RANGE.PROBE_CONFIG_LO, RANGE.PROBE_CONFIG_HI],
    ["probe_templates", RANGE.PROBE_TEMPLATE_LO, RANGE.PROBE_TEMPLATE_HI],
    ["device_types", RANGE.DEV_TYPE_LO, RANGE.DEV_TYPE_HI],
    ["link_types", RANGE.LINK_TYPE_LO, RANGE.LINK_TYPE_HI],
    ["networks", RANGE.NETWORK_LO, RANGE.NETWORK_HI],
    ["maps", RANGE.CANVAS_LO, RANGE.CANVAS_HI],
    ["map_elements", RANGE.NODE_LO, RANGE.NODE_HI],
    ["topology_links", RANGE.LINK_LO, RANGE.LINK_HI],
    ["snmp_profiles", RANGE.SNMP_LO, RANGE.SNMP_HI],
    ["notifications", RANGE.NOTIF_LO, RANGE.NOTIF_HI],
    ["tools", RANGE.TOOL_LO, RANGE.TOOL_HI],
    ["data_sources", RANGE.DATA_SOURCE_LO, RANGE.DATA_SOURCE_HI],
    ["file_assets", RANGE.ASSET_LO, RANGE.ASSET_HI],
    ["charts", RANGE.CHART_LO, RANGE.CHART_HI],
    ["device_groups", RANGE.GROUP_LO, RANGE.GROUP_HI],
    ["syslog_rules", RANGE.SYSLOG_RULE_LO, RANGE.SYSLOG_RULE_HI],
    ["panels", RANGE.OPEN_PANEL_LO, RANGE.OPEN_PANEL_HI],
  ];
  for (const [name, lo, hi] of checks) {
    if (rawHasTagInRange(buf, lo, hi)) return name;
  }
  return "unknown";
}

// Lightweight scan: any 16-bit LE word followed by a recognized marker byte,
// where the word is in [lo, hi]. False-positive rate is low enough for the
// gap report.
function rawHasTagInRange(buf: Uint8Array, lo: number, hi: number): boolean {
  if (buf.length < 14) return false;
  for (let i = 12; i + 2 < buf.length; i++) {
    const loByte = buf[i];
    const hiByte = buf[i + 1];
    const marker = buf[i + 2];
    if (loByte === undefined || hiByte === undefined || marker === undefined) break;
    const tag = loByte | (hiByte << 8);
    if (tag >= lo && tag <= hi && (marker === 0x01 || marker === 0x11 || marker === 0xfe)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------

/**
 * Rebuild a dude.db from a normalized SQLite database.
 * `src` must be a database produced by `normalize()` (it must contain `_raw_objs`).
 */
export function denormalize(
  src: Database,
  dst: Database,
  options: DenormalizeOptions = {},
): DenormalizeResult {
  // Sanity: source must contain _raw_objs.
  const hasRaw = src.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='_raw_objs'",
  ).get()?.n ?? 0;
  if (!hasRaw) {
    throw new Error(
      "source database is missing _raw_objs table — was it produced by donny normalize? " +
      "denormalize requires the raw blob mirror to rebuild a working dude.db.",
    );
  }

  dst.exec("PRAGMA journal_mode = MEMORY");
  dst.exec("PRAGMA synchronous = OFF");
  dst.exec(DUDE_DB_SCHEMA_SQL);

  const stats: DenormalizeStats = {
    objs: 0,
    outages: 0,
    chart_values_raw: 0,
    chart_values_10min: 0,
    chart_values_2hour: 0,
    chart_values_1day: 0,
  };
  const gap: GapReport = {
    encoded: {},
    rawFallback: {},
    dropped: 0,
    unmodeledRanges: {},
  };

  dst.transaction(() => {
    const insObj = dst.prepare("INSERT OR REPLACE INTO objs (id, obj) VALUES (?, ?)");

    // Build raw-blob lookup keyed by id (for clean rows + non-encoded types).
    const rawMap = new Map<number, Uint8Array>();
    const rawStmt = src.query<RawRow, []>("SELECT id, obj FROM _raw_objs");
    for (const r of rawStmt.iterate()) {
      const obj = r.obj instanceof Buffer ? new Uint8Array(r.obj) : r.obj;
      rawMap.set(r.id, obj);
    }

    // Track which ids were handled via an encoder table (so we don't double-emit).
    const handledIds = new Set<number>();

    // 1. Walk encoder-backed normalized tables.
    for (const enc of ENCODER_TABLES) {
      const stmt = src.query<{ id: number; _dirty: number } & Record<string, unknown>, []>(enc.select);
      for (const row of stmt.iterate()) {
        const id = row.id;
        if (handledIds.has(id)) continue;
        const dirty = row._dirty === 1;
        const raw = rawMap.get(id);
        let blob: Uint8Array;
        if (raw && !dirty) {
          // Clean row → preserve raw to keep unmodeled fields intact.
          blob = raw;
          gap.rawFallback[enc.table] = (gap.rawFallback[enc.table] ?? 0) + 1;
        } else {
          // Dirty edit OR newly inserted (no raw) → encode from columns.
          blob = enc.encode(row);
          gap.encoded[enc.table] = (gap.encoded[enc.table] ?? 0) + 1;
        }
        insObj.run(id, blob);
        stats.objs++;
        handledIds.add(id);
      }
    }

    // 2. Copy raw blobs for ids not handled by any encoder table.
    for (const [id, blob] of rawMap) {
      if (handledIds.has(id)) continue;
      insObj.run(id, blob);
      stats.objs++;
      const range = detectRange(blob);
      gap.unmodeledRanges[range] = (gap.unmodeledRanges[range] ?? 0) + 1;
    }

    // 3. Surface ids only in normalized tables with no encoder + no raw → dropped.
    //    (None today: every encoder-backed table is handled in step 1, and
    //    non-encoder tables all derive from _raw_objs anyway.)

    if (options.skipTimeseries) return;

    // --- outages ----------------------------------------------------------
    const insOutage = dst.prepare(
      "INSERT OR IGNORE INTO outages (timeAndServiceID, serviceID, deviceID, mapID, time, status, duration) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const outStmt = src.query<{ service_id: number | null; device_id: number | null; map_id: number | null; time: number; status: number; duration: number }, []>(
      "SELECT service_id, device_id, map_id, time, status, duration FROM outages",
    );
    for (const r of outStmt.iterate()) {
      const sid = r.service_id ?? 0;
      const tasi = (BigInt(r.time) << 32n) | BigInt(sid);
      insOutage.run(
        tasi.toString(), sid, r.device_id ?? 0, r.map_id ?? 0,
        r.time, r.status, r.duration,
      );
      stats.outages++;
    }

    // --- chart_values_* ---------------------------------------------------
    copyChart(src, dst, "chart_raw",   "chart_values_raw",   stats, "chart_values_raw");
    copyChart(src, dst, "chart_10min", "chart_values_10min", stats, "chart_values_10min");
    copyChart(src, dst, "chart_2hour", "chart_values_2hour", stats, "chart_values_2hour");
    copyChart(src, dst, "chart_1day",  "chart_values_1day",  stats, "chart_values_1day");
  })();

  const totalRows = Object.values(stats).reduce((a, b) => a + b, 0);
  return { tables: stats, totalRows, gapReport: gap };
}

function copyChart(
  src: Database, dst: Database,
  fromTable: string, toTable: string,
  stats: DenormalizeStats, key: keyof DenormalizeStats,
): void {
  const ins = dst.prepare(`INSERT OR IGNORE INTO ${toTable} (sourceIDandTime, value) VALUES (?, ?)`);
  const stmt = src.query<{ service_id: number; timestamp: number; value: number | null }, []>(
    `SELECT service_id, timestamp, value FROM ${fromTable}`,
  );
  let n = 0;
  for (const r of stmt.iterate()) {
    const k = (BigInt(r.service_id) << 32n) | BigInt(r.timestamp);
    ins.run(k.toString(), r.value);
    n++;
  }
  (stats[key] as number) = n;
}

/**
 * File-to-file convenience: open the normalized SQLite, write a fresh dude.db.
 */
export function denormalizeToFile(
  srcPath: string,
  dstPath: string,
  options: DenormalizeToFileOptions = {},
): DenormalizeResult {
  if (existsSync(dstPath)) {
    if (!options.overwrite) {
      throw new Error(`destination exists: ${dstPath} (pass --overwrite to replace)`);
    }
    unlinkSync(dstPath);
  }
  const src = new Database(srcPath, { readonly: true });
  const dst = new Database(dstPath);
  try {
    return denormalize(src, dst, options);
  } finally {
    src.close();
    dst.close();
  }
}
