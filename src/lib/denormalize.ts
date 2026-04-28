/**
 * denormalize — rebuild a working dude.db from a normalized SQLite file.
 *
 * Companion to `normalize()`. The normalized schema includes a `_raw_objs`
 * table that mirrors every source `objs` row verbatim; this module copies
 * those blobs back, plus the time-series tables, into a fresh dude.db
 * with the original Dude schema. The result is byte-identical at the
 * blob level and round-trip-safe through a real Dude server.
 *
 * Layering: pure library, no terminal I/O. CLI wraps `denormalizeToFile()`.
 */

import { existsSync, unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";

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

export interface DenormalizeResult {
  tables: DenormalizeStats;
  totalRows: number;
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
interface OutageRow {
  timeAndServiceID: number; serviceID: number | null; deviceID: number | null;
  mapID: number | null; time: number; status: number; duration: number;
}
interface ChartRow { sourceIDandTime: number | bigint; value: number | null }

/**
 * Rebuild a dude.db from a normalized SQLite database.
 * `src` must be a database produced by `normalize()` (i.e. contain `_raw_objs`).
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

  dst.transaction(() => {
    // --- objs -------------------------------------------------------------
    const insObj = dst.prepare("INSERT INTO objs (id, obj) VALUES (?, ?)");
    const objStmt = src.query<RawRow, []>("SELECT id, obj FROM _raw_objs ORDER BY id");
    for (const row of objStmt.iterate()) {
      const obj = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
      insObj.run(row.id, obj);
      stats.objs++;
    }

    if (options.skipTimeseries) return;

    // --- outages ----------------------------------------------------------
    // Reconstitute timeAndServiceID = (time << 32) | serviceID, matching the
    // composite key Dude uses. NULL serviceID means the original was 0.
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
  return { tables: stats, totalRows };
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
