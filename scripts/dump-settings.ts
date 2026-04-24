/**
 * Dump all fields in the settings object(s) from a database.
 * Usage: bun scripts/dump-settings.ts [path]
 */
import { DudeDB } from "../src/lib/db.ts";
import { hasTagInRange, RANGE } from "../src/lib/nova.ts";

const path = process.argv[2] ?? "clean.db";
const db = DudeDB.openAuto(path, { readonly: true });
let found = 0;

for (const { id, msg } of db.rawObjects()) {
  if (!hasTagInRange(msg, RANGE.SERVER_META_LO, RANGE.SERVER_META_HI)) continue;
  found++;
  console.log(`settings object id=${id}`);
  for (const f of msg.fields) {
    const hex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    let val: unknown;
    if (f.val.k === "str") val = JSON.stringify(f.val.v);
    else if (f.val.k === "bytes") val = `<bytes len=${f.val.v.length}>`;
    else if (f.val.k === "u32[]") val = `[${f.val.v.join(",")}]`;
    else val = f.val.v;
    console.log(`  ${hex}  ${f.val.k.padEnd(8)}  ${val}`);
  }
}

console.log(`\nTotal settings objects: ${found}`);
db.close();
