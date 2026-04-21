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

function withTempDb(fn: (dbPath: string, sqlite: Database) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "donny-test-"));
  const dbPath = join(dir, "fixture.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(SCHEMA);
  try {
    fn(dbPath, sqlite);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
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
    ...u16(TAG.DEVICE_IFACE_LIST), 0x10, 0xa0, ...u16(0),
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

  test("uses the device name as address for DNS-mode devices", () => {
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
