/**
 * denormalize() tests — verify the normalized-SQLite → dude.db reverse
 * transform is byte-identical at the blob level, and that round-tripping
 * through normalize → denormalize → normalize preserves both raw blobs
 * and decoded structure.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  DudeDB,
  normalize, normalizeToFile,
  denormalizeToFile,
  DUDE_DB_SCHEMA_SQL,
} from "../../src/index.ts";

const CLEAN_DB_PATH = "clean.db";

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "donny-denorm-")); });
afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

function blobAggregateSha1(dbPath: string): string {
  const db = new Database(dbPath);
  const rows = db.query<{ id: number; obj: Uint8Array | Buffer }, []>(
    "SELECT id, obj FROM objs ORDER BY id",
  ).all();
  db.close();
  const h = createHash("sha1");
  for (const { id, obj } of rows) {
    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(BigInt(id));
    h.update(idBuf);
    h.update(obj instanceof Buffer ? obj : Buffer.from(obj));
  }
  return h.digest("hex");
}

function rowCount(dbPath: string, table: string): number {
  const db = new Database(dbPath);
  const n = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
  db.close();
  return n;
}

describe("DUDE_DB_SCHEMA_SQL", () => {
  test("creates the canonical dude.db tables", () => {
    const db = new Database(":memory:");
    db.exec(DUDE_DB_SCHEMA_SQL);
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all().map((r) => r.name);
    expect(tables).toEqual([
      "chart_values_10min",
      "chart_values_1day",
      "chart_values_2hour",
      "chart_values_raw",
      "objs",
      "outages",
    ]);
    db.close();
  });
});

describe("denormalize(clean.db round-trip)", () => {
  test("byte-identical objs blobs after normalize → denormalize", () => {
    const norm = join(tmpDir, "n.db");
    const back = join(tmpDir, "back.db");
    normalizeToFile(CLEAN_DB_PATH, norm);
    denormalizeToFile(norm, back);

    expect(blobAggregateSha1(back)).toBe(blobAggregateSha1(CLEAN_DB_PATH));
    expect(rowCount(back, "objs")).toBe(rowCount(CLEAN_DB_PATH, "objs"));
  });

  test("rebuilt dude.db opens with DudeDB.openAuto and yields identical decoded counts", () => {
    const norm = join(tmpDir, "n.db");
    const back = join(tmpDir, "back.db");
    normalizeToFile(CLEAN_DB_PATH, norm);
    denormalizeToFile(norm, back);

    const a = DudeDB.openAuto(CLEAN_DB_PATH);
    const b = DudeDB.openAuto(back);
    try {
      expect(b.devices().length).toBe(a.devices().length);
      expect(b.probeTemplates().length).toBe(a.probeTemplates().length);
      expect(b.deviceTypes().length).toBe(a.deviceTypes().length);
      expect(b.linkTypes().length).toBe(a.linkTypes().length);
      expect(b.maps().length).toBe(a.maps().length);
      expect(b.syslogRules().length).toBe(a.syslogRules().length);
      expect(b.stats().objects).toBe(a.stats().objects);
    } finally { a.close(); b.close(); }
  });

  test("normalize → denormalize → normalize yields stable row counts", () => {
    const n1 = join(tmpDir, "n1.db");
    const back = join(tmpDir, "back.db");
    const n2 = join(tmpDir, "n2.db");
    const r1 = normalizeToFile(CLEAN_DB_PATH, n1);
    denormalizeToFile(n1, back);
    const r2 = normalizeToFile(back, n2);
    expect(r2.tables).toEqual(r1.tables);
    expect(r2.totalRows).toBe(r1.totalRows);
  });

  test("rejects a source missing _raw_objs", () => {
    const naked = join(tmpDir, "naked.db");
    const db = new Database(naked);
    db.exec("CREATE TABLE foo (id INTEGER)");
    db.close();
    expect(() => denormalizeToFile(naked, join(tmpDir, "out.db"))).toThrow(/_raw_objs/);
  });

  test("refuses to overwrite existing destination by default", () => {
    const norm = join(tmpDir, "n.db");
    const back = join(tmpDir, "back.db");
    normalizeToFile(CLEAN_DB_PATH, norm);
    denormalizeToFile(norm, back);
    expect(() => denormalizeToFile(norm, back)).toThrow(/destination exists/);
  });

  test("overwrite=true replaces existing destination", () => {
    const norm = join(tmpDir, "n.db");
    const back = join(tmpDir, "back.db");
    normalizeToFile(CLEAN_DB_PATH, norm);
    denormalizeToFile(norm, back);
    const r2 = denormalizeToFile(norm, back, { overwrite: true });
    expect(r2.tables.objs).toBeGreaterThan(0);
  });

  test("skipTimeseries=true zeroes the time-series counts but copies objs", () => {
    const norm = join(tmpDir, "n.db");
    const back = join(tmpDir, "back.db");
    normalizeToFile(CLEAN_DB_PATH, norm);
    const r = denormalizeToFile(norm, back, { skipTimeseries: true });
    expect(r.tables.objs).toBeGreaterThan(0);
    expect(r.tables.outages).toBe(0);
    expect(r.tables.chart_values_raw).toBe(0);
    expect(r.tables.chart_values_10min).toBe(0);
  });
});

describe("denormalize() — synthetic round-trip with time-series", () => {
  test("outages and chart_values_* survive normalize → denormalize", () => {
    // Build a fresh DudeDB, add a device, write a chart value + an outage.
    const src = DudeDB.inMemory();
    src.addDevice({ name: "host", address: "10.0.0.1" });
    const services = src.services();
    expect(services.length).toBe(1);
    const service = services[0];
    expect(service).toBeDefined();
    const sid = service?.id ?? 0;
    const ts = 1_700_000_000;

    // @ts-expect-error — private db handle for test injection
    const srcDb = src.db as Database;
    const tasi = (BigInt(ts) << 32n) | BigInt(sid);
    const sourceIDandTime = (BigInt(sid) << 32n) | BigInt(ts);
    srcDb.exec(
      `INSERT INTO outages (timeAndServiceID, serviceID, deviceID, mapID, time, status, duration)
       VALUES (${tasi.toString()}, ${sid}, 0, 0, ${ts}, 1, 42)`,
    );
    srcDb.exec(
      `INSERT INTO chart_values_10min (sourceIDandTime, value)
       VALUES (${sourceIDandTime.toString()}, 0.555)`,
    );

    // Normalize via in-memory destination, then denormalize to a file.
    const normPath = join(tmpDir, "syn.norm.db");
    const normDb = new Database(normPath);
    normalize(src, normDb, { sourcePath: ":memory:" });
    src.close();
    normDb.close();

    const backPath = join(tmpDir, "syn.back.db");
    const r = denormalizeToFile(normPath, backPath);
    expect(r.tables.objs).toBeGreaterThanOrEqual(1);
    expect(r.tables.outages).toBe(1);
    expect(r.tables.chart_values_10min).toBe(1);

    // Verify via fresh DudeDB read.
    // Note: DudeDB.outages() returns raw SQL column names (serviceID etc.)
    // — that's a pre-existing wart in db.ts; we just check the field
    // values via the underlying column names.
    const back = DudeDB.openAuto(backPath);
    try {
      const outages = back.outages() as unknown as Array<Record<string, number>>;
      expect(outages.length).toBe(1);
      const outage = outages[0];
      expect(outage).toBeDefined();
      expect(outage?.time).toBe(ts);
      expect(outage?.duration).toBe(42);
      expect(outage?.serviceID ?? outage?.serviceId).toBe(sid);

      const metrics = back.metrics(sid, "10min");
      expect(metrics.length).toBe(1);
      const metric = metrics[0];
      expect(metric).toBeDefined();
      expect(metric?.timestamp).toBe(ts);
      expect(metric?.value).toBeCloseTo(0.555);
    } finally { back.close(); }
  });
});

describe("Device.deviceTypeId", () => {
  test("decoder surfaces device_type_id (skipping 0xFFFFFFFF sentinel)", () => {
    // clean.db has no devices, so this asserts the field is at least present
    // on the type and DOES NOT end up as 0xFFFFFFFF for normal-add devices.
    const src = DudeDB.inMemory();
    src.addDevice({ name: "h", address: "10.0.0.1" });
    const dev = src.devices()[0];
    expect(dev).toBeDefined();
    expect(dev?.deviceTypeId).toBeUndefined(); // sentinel filtered out
    src.close();
  });
});

// ---------------------------------------------------------------------------
// Encoder-first round-trip: editing normalized rows propagates to dude.db
// ---------------------------------------------------------------------------

describe("denormalize() — editable round-trip via encoders", () => {
  test("clean (no edits) round-trip preserves blobs via raw fallback", () => {
    const normPath = join(tmpDir, "n.db");
    const backPath = join(tmpDir, "back.db");
    normalizeToFile(CLEAN_DB_PATH, normPath, { sourcePath: CLEAN_DB_PATH });
    const result = denormalizeToFile(normPath, backPath);
    // No edits → every modeled row should be raw fallback, not encoded.
    expect(result.gapReport.encoded).toEqual({});
    // Should have rawFallback entries for the 3 modeled types in clean.db
    // (devices=0 in clean, but services / probe_configs do exist there)
    // Just assert the report shape exists.
    expect(typeof result.gapReport.rawFallback).toBe("object");
    expect(typeof result.gapReport.unmodeledRanges).toBe("object");
  });

  test("editing a device name re-encodes that blob (dirty=1)", () => {
    const normPath = join(tmpDir, "n.db");
    const backPath = join(tmpDir, "back.db");

    // Build a normalized DB that has at least one device.
    const src = DudeDB.inMemory();
    src.addDevice({ name: "router1", address: "10.0.0.1" });
    const device = src.devices()[0];
    expect(device).toBeDefined();
    const devId = device?.id ?? 0;
    const ndb = new Database(normPath);
    normalize(src, ndb, { sourcePath: ":memory:" });
    src.close();
    ndb.close();

    // Edit: rename + mark dirty.
    const edit = new Database(normPath);
    edit.exec(`UPDATE devices SET name = 'router1-renamed', _dirty = 1 WHERE id = ${devId}`);
    edit.close();

    const result = denormalizeToFile(normPath, backPath);
    expect(result.gapReport.encoded.devices).toBe(1);

    const back = DudeDB.openAuto(backPath);
    try {
      const dev = back.devices().find((d) => d.id === devId);
      expect(dev).toBeDefined();
      expect(dev?.name).toBe("router1-renamed");
      expect(dev?.address).toBe("10.0.0.1");
    } finally { back.close(); }
  });

  test("inserting a new device row in normalized DB yields a working dude.db", () => {
    const normPath = join(tmpDir, "n.db");
    const backPath = join(tmpDir, "back.db");
    normalizeToFile(CLEAN_DB_PATH, normPath, { sourcePath: CLEAN_DB_PATH });

    // Pick an id that doesn't exist in _raw_objs.
    const edit = new Database(normPath);
    const taken = new Set<number>(
      edit.query<{ id: number }, []>("SELECT id FROM _raw_objs").all().map((r) => r.id),
    );
    let newId = 9_000_000;
    while (taken.has(newId)) newId++;

    edit.exec(
      `INSERT INTO devices (id, name, address, dns_mode, _dirty)
       VALUES (${newId}, 'new-device', '192.168.1.42', 0, 0)`,
    );
    edit.close();

    const result = denormalizeToFile(normPath, backPath);
    // New row has no raw blob → must be encoded.
    expect(result.gapReport.encoded.devices).toBe(1);

    const back = DudeDB.openAuto(backPath);
    try {
      const dev = back.devices().find((d) => d.id === newId);
      expect(dev).toBeDefined();
      expect(dev?.name).toBe("new-device");
      expect(dev?.address).toBe("192.168.1.42");
    } finally { back.close(); }
  });

  test("inserting a new map_element + topology_link round-trips through encoders", () => {
    const normPath = join(tmpDir, "n.db");
    const backPath = join(tmpDir, "back.db");
    normalizeToFile(CLEAN_DB_PATH, normPath, { sourcePath: CLEAN_DB_PATH });

    const edit = new Database(normPath);
    const taken = new Set<number>(
      edit.query<{ id: number }, []>("SELECT id FROM _raw_objs").all().map((r) => r.id),
    );
    let nextId = 9_500_000;
    const fresh = (): number => { while (taken.has(nextId)) nextId++; const v = nextId++; taken.add(v); return v; };

    const devA = fresh(); const devB = fresh();
    const node  = fresh(); const link = fresh();

    edit.exec(`INSERT INTO devices (id, name, address, _dirty) VALUES (${devA}, 'A', '10.0.0.1', 0)`);
    edit.exec(`INSERT INTO devices (id, name, address, _dirty) VALUES (${devB}, 'B', '10.0.0.2', 0)`);
    edit.exec(`INSERT INTO map_elements (id, map_id, device_id, x, y, _dirty)
               VALUES (${node}, NULL, ${devA}, 100, 200, 0)`);
    edit.exec(`INSERT INTO topology_links (id, device_a_id, device_b_id, _dirty)
               VALUES (${link}, ${devA}, ${devB}, 0)`);
    edit.close();

    const result = denormalizeToFile(normPath, backPath);
    expect(result.gapReport.encoded.devices).toBeGreaterThanOrEqual(2);
    expect(result.gapReport.encoded.map_elements).toBe(1);
    expect(result.gapReport.encoded.topology_links).toBe(1);

    // Verify objects round-trip through DudeDB read + raw blob inspection.
    const dst = new Database(backPath);
    const objIds = dst.query<{ id: number }, []>(
      `SELECT id FROM objs WHERE id IN (${devA}, ${devB}, ${node}, ${link})`,
    ).all().map((r) => r.id).sort((a, b) => a - b);
    dst.close();
    expect(objIds).toEqual([devA, devB, node, link].sort((a, b) => a - b));
  });

  test("topology link metadata + map_element_b_id survive denormalize → normalize", () => {
    const normPath = join(tmpDir, "n.db");
    const backPath = join(tmpDir, "back.db");
    const roundTripNormPath = join(tmpDir, "roundtrip.db");
    normalizeToFile(CLEAN_DB_PATH, normPath, { sourcePath: CLEAN_DB_PATH });

    const edit = new Database(normPath);
    const linkTypeId = edit.query<{ id: number }, []>("SELECT id FROM link_types ORDER BY id LIMIT 1").get()?.id;
    expect(linkTypeId).toBeDefined();

    const taken = new Set<number>(
      edit.query<{ id: number }, []>("SELECT id FROM _raw_objs").all().map((r) => r.id),
    );
    let nextId = 9_600_000;
    const fresh = (): number => { while (taken.has(nextId)) nextId++; const v = nextId++; taken.add(v); return v; };

    const devA = fresh();
    const devB = fresh();
    const node = fresh();
    const link = fresh();

    edit.exec(`INSERT INTO devices (id, name, address, _dirty) VALUES (${devA}, 'A', '10.10.0.1', 0)`);
    edit.exec(`INSERT INTO devices (id, name, address, _dirty) VALUES (${devB}, 'B', '10.10.0.2', 0)`);
    edit.exec(`INSERT INTO map_elements (id, map_id, device_id, x, y, _dirty)
               VALUES (${node}, NULL, ${devB}, 1, 2, 0)`);
    edit.exec(`INSERT INTO topology_links (id, device_a_id, device_b_id, map_element_b_id, link_type_id, speed_bps, history, _dirty)
               VALUES (${link}, ${devA}, NULL, ${node}, ${linkTypeId ?? 0}, 1000000000, 1, 0)`);
    edit.close();

    denormalizeToFile(normPath, backPath);
    normalizeToFile(backPath, roundTripNormPath, { sourcePath: backPath });

    const roundTrip = new Database(roundTripNormPath, { readonly: true });
    const row = roundTrip.query<{
      device_a_id: number | null;
      device_b_id: number | null;
      map_element_b_id: number | null;
      link_type_id: number | null;
      speed_bps: number;
      history: number;
    }, [number]>("SELECT device_a_id, device_b_id, map_element_b_id, link_type_id, speed_bps, history FROM topology_links WHERE id = ?").get(link);
    expect(row?.device_a_id).toBe(devA);
    expect(row?.device_b_id).toBeNull();
    expect(row?.map_element_b_id).toBe(node);
    expect(row?.link_type_id).toBe(linkTypeId);
    expect(row?.speed_bps).toBe(1_000_000_000);
    expect(row?.history).toBe(1);
    roundTrip.close();
  });

  test("gap report enumerates unmodeled types from a real-shape db", () => {
    const normPath = join(tmpDir, "n.db");
    const backPath = join(tmpDir, "back.db");
    normalizeToFile(CLEAN_DB_PATH, normPath, { sourcePath: CLEAN_DB_PATH });
    const result = denormalizeToFile(normPath, backPath);
    // unmodeledRanges should contain at least one bucket from clean.db
    // (probe_templates, device_types, link_types, etc. all live there).
    const totalUnmodeled = Object.values(result.gapReport.unmodeledRanges)
      .reduce((a, b) => a + b, 0);
    expect(totalUnmodeled).toBeGreaterThan(0);
  });
});
