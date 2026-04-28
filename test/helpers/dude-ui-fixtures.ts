import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { DudeDB, TAG } from "../../src/index.ts";

export function writeServerMetaDb(path: string, lastConnect: number): void {
  rmSync(path, { force: true });
  const db = DudeDB.inMemory();
  try {
    // @ts-expect-error test fixture injection through private db handle
    const sqlite = db.db as Database;
    const writer = new (class {
      private parts: Uint8Array[] = [];

      raw(data: Uint8Array) {
        this.parts.push(data);
        return this;
      }

      u8(v: number) {
        return this.raw(Uint8Array.from([v & 0xff]));
      }

      u16(v: number) {
        return this.raw(Uint8Array.from([v & 0xff, (v >>> 8) & 0xff]));
      }

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
  } finally {
    db.close();
  }
}
