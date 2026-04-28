import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { assertClientConnectMapping, assertProbeAddedMapping, assertRouterOsFlagMapping } from "../../labs/dude-ui/first-mapping.ts";
import { diffDudeDbs, DudeDB, encodeDevice, TAG } from "../../src/index.ts";

const scratchBefore = join(import.meta.dir, ".first-mapping-before.db");
const scratchAfter = join(import.meta.dir, ".first-mapping-after.db");

function writeSingleDeviceDb(path: string, routerOS: boolean): void {
  rmSync(path, { force: true });
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE objs (id integer primary key, obj blob)");
    db.query("INSERT INTO objs (id, obj) VALUES (?, ?)").run(
      10000,
      encodeDevice({ id: 10000, name: "routeros-flag-target", address: "10.0.0.1", routerOS }),
    );
  } finally {
    db.close();
  }
}

function writeServerMetaDb(path: string, lastConnect: number): void {
  rmSync(path, { force: true });
  const db = DudeDB.inMemory();
  // @ts-expect-error test fixture injection through private db handle
  const sqlite = db.db as Database;
  const writer = new (class {
    private parts: Uint8Array[] = [];
    raw(data: Uint8Array) { this.parts.push(data); return this; }
    u8(v: number) { return this.raw(Uint8Array.from([v & 0xff])); }
    u16(v: number) { return this.raw(Uint8Array.from([v & 0xff, (v >>> 8) & 0xff])); }
    u32(v: number) {
      const n = v >>> 0;
      return this.raw(Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]));
    }
    bytes() {
      const out = new Uint8Array(this.parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of this.parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }
  })();
  const blob = writer
    .raw(Uint8Array.from([0x4d, 0x32, 0x01, 0x00, 0xff, 0x88, 0x01, 0x00]))
    .u32(2)
    .u16(TAG.SYS_LAST_CLIENT_CONNECT).u8(0x10).u8(lastConnect === 0 ? 0x09 : 0x08)
    [lastConnect === 0 ? "u8" : "u32"](lastConnect)
    .u16(TAG.NAME).u8(0xfe).u8(0x21).u8(0)
    .bytes();
  sqlite.query("INSERT INTO objs (id, obj) VALUES (?, ?)").run(10000, blob);
  sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  db.close();
}

describe("Dude DB diff", () => {
  test("reports added objects", () => {
    const before = DudeDB.inMemory();
    const after = DudeDB.inMemory();
    after.addDevice({ name: "router1", address: "10.0.0.1" });

    try {
      const diff = diffDudeDbs(before, after);
      expect(diff.addedObjects.map((object) => object.name)).toContain("router1");
      expect(diff.removedObjects).toHaveLength(0);
      expect(diff.changedObjects).toHaveLength(0);
    } finally {
      before.close();
      after.close();
    }
  });

  test("reports field-level changes for the same object id", () => {
    const before = DudeDB.inMemory();
    const after = DudeDB.inMemory();
    const ids = before.addDevice({ name: "router1", address: "10.0.0.1" });
    after.addDevice({ name: "router1-renamed", address: "10.0.0.1" });

    try {
      const diff = diffDudeDbs(before, after, { objectIds: [ids.deviceId] });
      expect(diff.changedObjects).toHaveLength(1);
      const object = diff.changedObjects[0];
      expect(object?.id).toBe(ids.deviceId);
      expect(object?.changedFields).toContainEqual(expect.objectContaining({
        tag: TAG.NAME,
        before: { kind: "str", value: "router1" },
        after: { kind: "str", value: "router1-renamed" },
      }));
    } finally {
      before.close();
      after.close();
    }
  });

  test("filters by object name across before and after values", () => {
    const before = DudeDB.inMemory();
    const after = DudeDB.inMemory();
    before.addDevice({ name: "router1", address: "10.0.0.1" });
    after.addDevice({ name: "router1-renamed", address: "10.0.0.1" });

    try {
      const diff = diffDudeDbs(before, after, { objectName: "router1-renamed" });
      expect(diff.changedObjects).toHaveLength(1);
      expect(diff.changedObjects[0]?.nameAfter).toBe("router1-renamed");
    } finally {
      before.close();
      after.close();
    }
  });

  test("asserts the first UI mapping replay target", () => {
    writeSingleDeviceDb(scratchBefore, false);
    writeSingleDeviceDb(scratchAfter, true);

    try {
      const result = assertRouterOsFlagMapping({
        beforePath: scratchBefore,
        afterPath: scratchAfter,
        deviceName: "routeros-flag-target",
      });

      expect(result.objectId).toBe(10000);
      expect(result.fieldKey).toBe("0x1f4a#0");
      expect(result.beforeValue).toBe(false);
      expect(result.afterValue).toBe(true);
    } finally {
      rmSync(scratchBefore, { force: true });
      rmSync(scratchAfter, { force: true });
    }
  });

  test("asserts the client-connect mapping replay target", () => {
    writeServerMetaDb(scratchBefore, 0);
    writeServerMetaDb(scratchAfter, 1_777_405_776);

    try {
      const result = assertClientConnectMapping({
        beforePath: scratchBefore,
        afterPath: scratchAfter,
      });

      expect(result.objectId).toBe(10000);
      expect(result.fieldKey).toBe("0x1017#0");
      expect(result.beforeValue).toBe(0);
      expect(result.afterValue).toBe(1_777_405_776);
    } finally {
      rmSync(scratchBefore, { force: true });
      rmSync(scratchAfter, { force: true });
    }
  });

  test("asserts client-connect mapping when 0x1017 is newly added in after", () => {
    rmSync(scratchBefore, { force: true });
    const beforeDb = new Database(scratchBefore);
    try {
      beforeDb.exec("CREATE TABLE objs (id integer primary key, obj blob)");
      const blob = Uint8Array.from([
        0x4d, 0x32, 0x01, 0x00, 0xff, 0x88, 0x01, 0x00,
        0x01, 0x00, 0x00, 0x00,
        0x10, 0x00, 0xfe, 0x21, 0x00,
      ]);
      beforeDb.query("INSERT INTO objs (id, obj) VALUES (?, ?)").run(10000, blob);
    } finally {
      beforeDb.close();
    }
    writeServerMetaDb(scratchAfter, 1_777_405_999);

    try {
      const result = assertClientConnectMapping({
        beforePath: scratchBefore,
        afterPath: scratchAfter,
      });

      expect(result.objectId).toBe(10000);
      expect(result.fieldKey).toBe("0x1017#0");
      expect(result.beforeValue).toBeUndefined();
      expect(result.afterValue).toBe(1_777_405_999);
    } finally {
      rmSync(scratchBefore, { force: true });
      rmSync(scratchAfter, { force: true });
    }
  });

  test("asserts probe-added mapping when client adds a device with a ping probe", () => {
    rmSync(scratchBefore, { force: true });
    rmSync(scratchAfter, { force: true });

    const before = DudeDB.inMemory();
    // @ts-expect-error test fixture access through private db handle
    (before.db as Database).exec(`VACUUM INTO '${scratchBefore.replace(/'/g, "''")}'`);
    before.close();

    // addDevice() mints device + service + probeConfig through the same encoders
    // the real client write path uses; treat it as a synthetic stand-in for the
    // dude.exe "Add Device" flow.
    const after = DudeDB.inMemory();
    const ids = after.addDevice({ name: "ui-probe-target", address: "10.0.0.7" });
    // @ts-expect-error test fixture access through private db handle
    (after.db as Database).exec(`VACUUM INTO '${scratchAfter.replace(/'/g, "''")}'`);
    after.close();

    try {
      const result = assertProbeAddedMapping({
        beforePath: scratchBefore,
        afterPath: scratchAfter,
        deviceName: "ui-probe-target",
        expectedProbeTypeId: 10160,
      });

      expect(result.deviceId).toBe(ids.deviceId);
      expect(result.deviceName).toBe("ui-probe-target");
      expect(result.probeId).toBe(ids.probeId);
      expect(result.serviceId).toBe(ids.serviceId);
      expect(result.probeTypeId).toBe(10160);
      expect(result.probeConfig.deviceId).toBe(ids.deviceId);
      expect(result.service?.id).toBe(ids.serviceId);
    } finally {
      rmSync(scratchBefore, { force: true });
      rmSync(scratchAfter, { force: true });
    }
  });
});
