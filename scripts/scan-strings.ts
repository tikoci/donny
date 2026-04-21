import { Database } from "bun:sqlite";
import { decodeBlob } from "../src/lib/nova.ts";

const path = process.argv[2] ?? "clean.db";
const db = new Database(path, { readonly: true });
const rows = db.query<{ id: number; obj: Uint8Array }, []>("SELECT id, obj FROM objs").all();
const strings: string[] = [];
for (const row of rows) {
  const msg = decodeBlob(new Uint8Array(row.obj));
  if (!msg) continue;
  for (const field of msg.fields) {
    if (field.val.k === "str" && field.val.v.length > 0) {
      strings.push(`id=${row.id} tag=0x${field.tag.toString(16).padStart(4, "0")} val="${field.val.v}"`);
    }
  }
}
for (const s of strings) console.log(s);
console.log(`\nTotal string fields: ${strings.length} across ${rows.length} objects`);
db.close();
