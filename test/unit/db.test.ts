import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DudeDB, NOVA_MAGIC, TAG, encodeDevice } from "../../src/index.ts";

const SCHEMA = `
  CREATE TABLE objs (id integer primary key, obj blob);
  CREATE TABLE outages (
    timeAndServiceID integer primary key,
    serviceID integer, deviceID integer, mapID integer,
    time integer, status integer, duration integer
  );
  CREATE TABLE chart_values_raw    (sourceIDandTime integer primary key, value real);
  CREATE TABLE chart_values_10min  (sourceIDandTime integer primary key, value real);
  CREATE TABLE chart_values_2hour  (sourceIDandTime integer primary key, value real);
  CREATE TABLE chart_values_1day   (sourceIDandTime integer primary key, value real);
`;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeDirWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EBUSY") throw error;
      if (attempt === 4) {
        if (process.platform === "win32") return;
        throw error;
      }
      sleepMs(50 * (attempt + 1));
    }
  }
}

function withTempDb(fn: (dbPath: string, sqlite: Database) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "donny-test-"));
  const dbPath = join(dir, "fixture.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(SCHEMA);
  try {
    fn(dbPath, sqlite);
  } finally {
    sqlite.close();
    removeDirWithRetry(dir);
  }
}

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}

function u32(v: number): number[] {
  const n = v >>> 0;
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function encodeDeviceFragment(): Uint8Array {
  return Uint8Array.from([
    ...NOVA_MAGIC,
    ...u32(3),
    ...u16(0x1f57), 0x10, 0x88, ...u16(0),
    ...u16(TAG.DEVICE_SERVICES), 0x10, 0x88, ...u16(0),
    ...u16(TAG.DEVICE_DNS_NAMES), 0x10, 0xa0, ...u16(0),
  ]);
}

describe("DudeDB", () => {
  test("opens a writable on-disk database and can insert a device", () => {
    withTempDb((dbPath) => {
      const db = DudeDB.open(dbPath);
      const ids = db.addDevice({ name: "core-01", address: "10.0.0.1" });
      expect(ids.deviceId).toBeGreaterThan(0);
      expect(db.devices().map((device) => device.name)).toContain("core-01");
      db.close();
    });
  });

  test("filters fragment rows out of devices()", () => {
    withTempDb((dbPath, sqlite) => {
      sqlite.prepare("INSERT INTO objs (id, obj) VALUES (?, ?)").run(34329, encodeDeviceFragment());
      sqlite.prepare("INSERT INTO objs (id, obj) VALUES (?, ?)").run(45062, encodeDevice({ id: 45062, name: "edge-01", address: "192.168.88.1" }));

      const db = DudeDB.open(dbPath, { readonly: true });
      expect(db.devices()).toEqual([
        expect.objectContaining({
          id: 45062,
          name: "edge-01",
          address: "192.168.88.1",
        }),
      ]);
      db.close();
    });
  });

  test("uses the device name as address for RouterOS-style DNS-mode devices", () => {
    withTempDb((dbPath, sqlite) => {
      sqlite.prepare("INSERT INTO objs (id, obj) VALUES (?, ?)").run(12, encodeDevice({ id: 12, name: "gw.example.com", address: "gw.example.com" }));

      const db = DudeDB.open(dbPath, { readonly: true });
      expect(db.devices()).toEqual([
        expect.objectContaining({
          id: 12,
          name: "gw.example.com",
          address: "gw.example.com",
        }),
      ]);
      db.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Clean-baseline tests — use the committed clean.db / clean.export fixtures
// which represent a freshly initialised Dude instance with no user data.
// ---------------------------------------------------------------------------

const CLEAN_DB_PATH     = "clean.db";
const CLEAN_EXPORT_PATH = "clean.export";
const CLEAN_OBJECT_COUNT   = 224;
const CLEAN_PROBE_TPL_COUNT   = 27;
const CLEAN_DEVICE_TYPE_COUNT = 17;
const CLEAN_LINK_TYPE_COUNT   =  8;

describe("DudeDB — clean baseline (clean.db / clean.export)", () => {
  test("openAuto(clean.db) reads the SQLite path", () => {
    const db = DudeDB.openAuto(CLEAN_DB_PATH, { readonly: true });
    expect(db.stats().objects).toBe(CLEAN_OBJECT_COUNT);
    expect(db.devices()).toHaveLength(0);
    db.close();
  });

  test("openAuto(clean.export) reads the gzip-tar export path", () => {
    const db = DudeDB.openAuto(CLEAN_EXPORT_PATH, { readonly: true });
    expect(db.stats().objects).toBe(CLEAN_OBJECT_COUNT);
    expect(db.devices()).toHaveLength(0);
    db.close();
  });

  test("both formats produce identical object counts", () => {
    const fromDb     = DudeDB.openAuto(CLEAN_DB_PATH,     { readonly: true });
    const fromExport = DudeDB.openAuto(CLEAN_EXPORT_PATH, { readonly: true });

    const sDb     = fromDb.stats();
    const sExport = fromExport.stats();

    expect(sExport.objects).toBe(sDb.objects);

    fromDb.close();
    fromExport.close();
  });

  test("clean baseline has the expected builtin probe templates", () => {
    const db = DudeDB.openAuto(CLEAN_DB_PATH, { readonly: true });
    const probes = db.probeTemplates();

    expect(probes).toHaveLength(CLEAN_PROBE_TPL_COUNT);
    expect(probes.every((p) => p.builtIn)).toBe(true);

    const names = probes.map((p) => p.name);
    expect(names).toContain("ping");
    expect(names).toContain("routeros management");
    expect(names).toContain("mikrotik");
    expect(names).toContain("cpu");
    expect(names).toContain("disk");

    // Builtin probe IDs occupy the 10159–10190 range
    const ids = probes.map((p) => p.id);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(10159);
    expect(Math.max(...ids)).toBeLessThanOrEqual(10190);

    db.close();
  });

  test("clean baseline has the expected builtin device types", () => {
    const db = DudeDB.openAuto(CLEAN_DB_PATH, { readonly: true });
    const types = db.deviceTypes();

    expect(types).toHaveLength(CLEAN_DEVICE_TYPE_COUNT);
    expect(types.every((t) => t.builtIn)).toBe(true);

    const names = types.map((t) => t.name);
    expect(names).toContain("MikroTik Device");
    expect(names).toContain("Router");
    expect(names).toContain("Switch");
    expect(names).toContain("Some Device");

    db.close();
  });

  test("clean baseline has the expected builtin link types", () => {
    const db = DudeDB.openAuto(CLEAN_DB_PATH, { readonly: true });
    const types = db.linkTypes();

    expect(types).toHaveLength(CLEAN_LINK_TYPE_COUNT);
    expect(types.every((t) => t.builtIn)).toBe(true);

    const names = types.map((t) => t.name);
    expect(names).toContain("gigabit ethernet");
    expect(names).toContain("wireless");
    expect(names).toContain("some link");

    db.close();
  });
});
