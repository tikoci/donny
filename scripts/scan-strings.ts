import { Database } from "bun:sqlite";
import { decodeMessage } from "../src/lib/nova.ts";

const path = process.argv[2] ?? "clean.db";
const db = new Database(path, { readonly: true });
const rows = db.query<{ id: number; data: Buffer }, []>("SELECT id, data FROM objs").all();
const strings: string[] = [];
for (const row of rows) {
  const msg = decodeMessage(new Uint8Array(row.data));
  if (!msg) continue;
  for (const [tag, val] of msg.fields) {
    if (typeof val === "string" && val.length > 0) {
      strings.push(`id=${row.id} tag=0x${tag.toString(16).padStart(4, "0")} val="${val}"`);
    }
  }
}
for (const s of strings) console.log(s);
console.log(`\nTotal string fields: ${strings.length} across ${rows.length} objects`);
db.close();
