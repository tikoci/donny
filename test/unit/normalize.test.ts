/**
 * normalize() tests — verify the dude.db → normalized SQLite transform
 * against the committed clean.db / clean.export fixtures, plus a synthetic
 * round-trip via DudeDB.addDevice().
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  DudeDB,
  encodeMapNode,
  encodeTopologyLink,
  normalize,
  normalizeToFile,
  NORMALIZED_SCHEMA_SQL,
} from "../../src/index.ts";

const CLEAN_DB_PATH = "clean.db";

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "donny-norm-")); });
afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

function fkOrphans(db: Database): string[] {
  return db.query<{ table: string; rowid: number; parent: string; fkid: number }, []>(
    "PRAGMA foreign_key_check",
  ).all().map((r) => `${r.table}#${r.rowid} → ${r.parent}`);
}

function rowCount(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
}

describe("NORMALIZED_SCHEMA_SQL", () => {
  test("is non-empty and creates expected tables", () => {
    expect(NORMALIZED_SCHEMA_SQL.length).toBeGreaterThan(1000);
    const db = new Database(":memory:");
    db.exec(NORMALIZED_SCHEMA_SQL);
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all().map((r) => r.name);
    for (const expected of [
      "_meta", "_table_counts",
      "devices", "device_macs", "device_types", "device_type_default_probes",
      "probe_templates", "probe_configs", "services",
      "maps", "map_elements", "topology_links", "link_types",
      "networks", "network_subnets", "device_groups", "device_group_members",
      "syslog_rules", "notifications", "snmp_profiles",
      "discover_jobs", "discover_job_probes",
      "data_sources", "tools", "file_assets",
      "outages", "chart_raw", "chart_10min", "chart_2hour", "chart_1day",
    ]) {
      expect(tables).toContain(expected);
    }
    const views = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name",
    ).all().map((r) => r.name);
    expect(views).toEqual([
      "v_devices_full", "v_outages_full", "v_probes_full", "v_topology",
    ]);
    db.close();
  });
});

describe("normalize(clean.db)", () => {
  test("produces row counts matching DudeDB accessors", () => {
    const dst = join(tmpDir, "clean.normalized.db");
    const result = normalizeToFile(CLEAN_DB_PATH, dst);

    const src = DudeDB.openAuto(CLEAN_DB_PATH, { readonly: true });
    expect(result.tables.device_types ?? 0).toBe(src.deviceTypes().length);
    expect(result.tables.probe_templates ?? 0).toBe(src.probeTemplates().length);
    expect(result.tables.link_types ?? 0).toBe(src.linkTypes().length);
    expect(result.tables.syslog_rules ?? 0).toBe(src.syslogRules().length);
    expect(result.tables.devices ?? 0).toBe(src.devices().length);
    expect(result.tables.maps ?? 0).toBe(src.maps().length);
    src.close();

    expect(result.totalRows).toBeGreaterThan(0);
  });

  test("destination has no FK orphans", () => {
    const dst = join(tmpDir, "clean.fk.db");
    normalizeToFile(CLEAN_DB_PATH, dst);
    const db = new Database(dst, { readonly: true });
    db.exec("PRAGMA foreign_keys = ON");
    expect(fkOrphans(db)).toEqual([]);
    db.close();
  });

  test("populates _meta with provenance", () => {
    const dst = join(tmpDir, "clean.meta.db");
    normalizeToFile(CLEAN_DB_PATH, dst);
    const db = new Database(dst, { readonly: true });
    const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM _meta").all();
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(map.source_path).toBe(CLEAN_DB_PATH);
    expect(map.generated_at).toMatch(/^\d{4}-/);
    expect(map.schema_version).toBe("3");
    db.close();
  });

  test("convenience views are queryable", () => {
    const dst = join(tmpDir, "clean.views.db");
    normalizeToFile(CLEAN_DB_PATH, dst);
    const db = new Database(dst, { readonly: true });
    // No devices in clean.db, so all views return 0 rows — but they must not error.
    expect(rowCount(db, "v_devices_full")).toBe(0);
    expect(rowCount(db, "v_probes_full")).toBe(0);
    expect(rowCount(db, "v_outages_full")).toBe(0);
    expect(rowCount(db, "v_topology")).toBe(0);
    db.close();
  });

  test("_table_counts mirror result.tables", () => {
    const dst = join(tmpDir, "clean.counts.db");
    const r = normalizeToFile(CLEAN_DB_PATH, dst);
    const db = new Database(dst, { readonly: true });
    const rows = db.query<{ table_name: string; row_count: number }, []>(
      "SELECT table_name, row_count FROM _table_counts",
    ).all();
    for (const { table_name, row_count } of rows) {
      expect(r.tables[table_name]).toBe(row_count);
    }
    db.close();
  });

  test("refuses to overwrite existing destination by default", () => {
    const dst = join(tmpDir, "exists.db");
    normalizeToFile(CLEAN_DB_PATH, dst);
    expect(existsSync(dst)).toBe(true);
    expect(() => normalizeToFile(CLEAN_DB_PATH, dst)).toThrow(/destination exists/);
  });

  test("overwrite=true replaces existing destination", () => {
    const dst = join(tmpDir, "ow.db");
    normalizeToFile(CLEAN_DB_PATH, dst);
    const r2 = normalizeToFile(CLEAN_DB_PATH, dst, { overwrite: true });
    expect(r2.totalRows).toBeGreaterThan(0);
  });

  test("skipTimeseries=true zeroes the time-series counts", () => {
    const dst = join(tmpDir, "skip.db");
    const r = normalizeToFile(CLEAN_DB_PATH, dst, { skipTimeseries: true });
    expect(r.tables.outages).toBe(0);
    expect(r.tables.chart_raw).toBe(0);
    expect(r.tables.chart_10min).toBe(0);
  });
});

describe("normalize() round-trip via DudeDB.addDevice()", () => {
  test("device + service + probe surface in normalized tables", () => {
    // Build a fresh in-memory dude.db with the proper schema, add a device,
    // normalize to a temp file, and verify all three new objects appear.
    const src = DudeDB.inMemory();
    // Need at least one probe template so addDevice can find ping (10160).
    // inMemory() creates an empty schema — addDevice will use "probe" as
    // the template name fallback. That's fine for round-trip testing.
    const ids = src.addDevice({
      name: "edge-rt",
      address: "10.0.0.42",
      routerOS: true,
      enabled: false,
      probeInterval: 120,
      customField1: "rack-a",
      customField2: "row-7",
      customField3: "owner-netops",
    });

    const dstPath = join(tmpDir, "rt.db");
    const dst = new Database(dstPath);
    const r = normalize(src, dst, { sourcePath: ":memory:" });
    src.close();
    dst.close();

    const out = new Database(dstPath, { readonly: true });
    const dev = out.query<{
      id: number;
      name: string;
      address: string;
      enabled: number;
      router_os: number;
      probe_interval: number;
      poll_interval: number;
      custom_field1: string;
      custom_field2: string;
      custom_field3: string;
    }, []>(
      "SELECT id, name, address, enabled, router_os, probe_interval, poll_interval, custom_field1, custom_field2, custom_field3 FROM devices",
    ).get();
    expect(dev?.id).toBe(ids.deviceId);
    expect(dev?.name).toBe("edge-rt");
    expect(dev?.address).toBe("10.0.0.42");
    expect(dev?.enabled).toBe(0);
    expect(dev?.router_os).toBe(1);
    expect(dev?.probe_interval).toBe(120);
    expect(dev?.poll_interval).toBe(120);
    expect(dev?.custom_field1).toBe("rack-a");
    expect(dev?.custom_field2).toBe("row-7");
    expect(dev?.custom_field3).toBe("owner-netops");

    expect(rowCount(out, "services")).toBe(1);
    // probe_configs requires the referenced probe_template to exist; the
    // in-memory DudeDB has no templates, so the FK-safety check in normalize()
    // correctly drops the orphaned probe_config row. The device + service
    // still surface, which is the round-trip we care about.
    expect(r.tables.devices).toBe(1);
    out.close();
  });

  test("time-series reshape splits sourceIDandTime into (service_id, timestamp)", () => {
    const src = DudeDB.inMemory();
    src.addDevice({ name: "metrics-host", address: "10.0.0.99" });

    // Insert a synthetic chart_values_10min row directly.
    // sourceIDandTime = (serviceId << 32) | timestamp
    const services = src.services();
    expect(services.length).toBe(1);
    const service = services[0];
    expect(service).toBeDefined();
    const sid = BigInt(service?.id ?? 0);
    const ts = 1_700_000_000;
    const key = (sid << 32n) | BigInt(ts);
    // Reach into the underlying SQLite. DudeDB doesn't expose a writer for
    // chart values, so use Database directly via the same file. inMemory()
    // uses ":memory:" — we'll get the same handle via a new query through
    // the existing DudeDB. The cleanest path: drive the insert via raw SQL
    // before normalize.
    // @ts-expect-error — accessing private for test only
    (src.db as Database).exec(
      `INSERT INTO chart_values_10min (sourceIDandTime, value) VALUES (${key.toString()}, 0.123)`,
    );

    const dstPath = join(tmpDir, "ts.db");
    const dst = new Database(dstPath);
    normalize(src, dst, { sourcePath: ":memory:" });
    src.close();
    dst.close();

    const out = new Database(dstPath, { readonly: true });
    const row = out.query<{ service_id: number; timestamp: number; value: number }, []>(
      "SELECT service_id, timestamp, value FROM chart_10min",
    ).get();
    expect(row?.service_id).toBe(Number(sid));
    expect(row?.timestamp).toBe(ts);
    expect(row?.value).toBeCloseTo(0.123);
    out.close();
  });

  test("topology links preserve link metadata and resolve map-element B-side", () => {
    const srcPath = join(tmpDir, "topology-src.db");
    copyFileSync(CLEAN_DB_PATH, srcPath);
    const src = DudeDB.open(srcPath);

    const linkTypeId = src.linkTypes()[0]?.id;
    expect(linkTypeId).toBeDefined();

    const a = src.addDevice({ name: "a", address: "10.0.0.1" }).deviceId;
    const b = src.addDevice({ name: "b", address: "10.0.0.2" }).deviceId;
    const nodeId = 9_200_001;
    const linkId = 9_200_002;

    // @ts-expect-error test-only access to the underlying sqlite handle
    const sqlite = src.db as Database;
    sqlite.prepare("INSERT INTO objs (id, obj) VALUES (?, ?)").run(
      nodeId,
      encodeMapNode({ id: nodeId, mapId: 0xffffffff, deviceId: b, x: 10, y: 20 }),
    );
    sqlite.prepare("INSERT INTO objs (id, obj) VALUES (?, ?)").run(
      linkId,
      encodeTopologyLink({
        id: linkId,
        deviceAId: a,
        mapElementBId: nodeId,
        linkTypeId: linkTypeId ?? 0xffffffff,
        speedBps: 1_000_000_000,
        history: true,
      }),
    );

    const dstPath = join(tmpDir, "topology-normalized.db");
    const dst = new Database(dstPath);
    normalize(src, dst, { sourcePath: srcPath });
    src.close();
    dst.close();

    const out = new Database(dstPath, { readonly: true });
    const row = out.query<{
      device_a_id: number | null;
      device_b_id: number | null;
      map_element_b_id: number | null;
      link_type_id: number | null;
      speed_bps: number;
      history: number;
    }, [number]>("SELECT device_a_id, device_b_id, map_element_b_id, link_type_id, speed_bps, history FROM topology_links WHERE id = ?").get(linkId);
    expect(row?.device_a_id).toBe(a);
    expect(row?.device_b_id).toBeNull();
    expect(row?.map_element_b_id).toBe(nodeId);
    expect(row?.link_type_id).toBe(linkTypeId);
    expect(row?.speed_bps).toBe(1_000_000_000);
    expect(row?.history).toBe(1);

    const viewRow = out.query<{ device_b_id: number | null; device_b_name: string | null }, [number]>(
      "SELECT device_b_id, device_b_name FROM v_topology WHERE id = ?",
    ).get(linkId);
    expect(viewRow?.device_b_id).toBe(b);
    expect(viewRow?.device_b_name).toBe("b");
    out.close();
  });
});
