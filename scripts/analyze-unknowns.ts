import { Database } from "bun:sqlite";
import { decodeBlob, RANGE, hasTagInRange, getStr, getU32 } from "../src/lib/nova.ts";

const dbPath = process.argv[2] ?? "dude_from_export.db";
const db = new Database(dbPath, { readonly: true });
const rows = db.query("SELECT id, obj FROM objs ORDER BY id").all() as { id: number; obj: Uint8Array }[];

// Dump ALL fields for specific unknown objects
const targetIds = [10000, 10176, 10178, 10191, 10192, 10208, 10209];

for (const row of rows) {
  if (!targetIds.includes(row.id)) continue;
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg) { console.log(`id=${row.id} => null`); continue; }

  console.log(`\n=== id=${row.id}  fields=${msg.fields.length} ===`);
  for (const f of msg.fields) {
    const tagHex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    let val: string;
    if (f.val.k === "str") val = `"${f.val.v}"`;
    else if (f.val.k === "bytes") val = `bytes[${f.val.v.length}] = ${Array.from(f.val.v).slice(0, 16).map(b => b.toString(16).padStart(2,"0")).join(" ")}`;
    else if (f.val.k === "compound") {
      val = `compound[${f.val.v.length}]`;
      for (const sf of f.val.v) {
        const stag = `0x${sf.tag.toString(16).padStart(4, "0")}`;
        const sv = sf.val.k === "str" ? `"${sf.val.v}"` : sf.val.k === "bytes" ? `bytes[${sf.val.v.length}]` : String(sf.val.v);
        console.log(`    ${tagHex} > ${stag} (${sf.val.k}) = ${sv}`);
      }
    }
    else if (f.val.k === "u32[]") val = `u32[${f.val.v.length}] = [${f.val.v.slice(0, 8).join(", ")}${f.val.v.length > 8 ? "..." : ""}]`;
    else val = String(f.val.v);
    console.log(`  ${tagHex} (${f.val.k.padEnd(8)}) = ${val}`);
  }
}

// Also look at ALL objects whose tag is in 0x2712 range
console.log("\n=== All 0x2712-range objects ===");
for (const row of rows) {
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg) continue;
  const firstTag = msg.fields[0]?.tag ?? 0;
  if (firstTag < 0x2712 || firstTag > 0x2800) continue;
  console.log(`\n  id=${row.id}  firstTag=0x${firstTag.toString(16)}  fields=${msg.fields.length}`);
  for (const f of msg.fields) {
    const tagHex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    const val = f.val.k === "str" ? `"${f.val.v}"` : f.val.k === "bytes" ? `bytes[${f.val.v.length}]` : f.val.k === "compound" ? `compound[${f.val.v.length}]` : f.val.k === "u32[]" ? `u32[${f.val.v.length}] = [${f.val.v.slice(0,4).join(",")}]` : String(f.val.v);
    console.log(`    ${tagHex} (${f.val.k.padEnd(8)}) = ${val}`);
  }
}

// Show firstTag=0x0001 objects
console.log("\n=== All 0x0001-firstTag unknown objects ===");
for (const row of rows) {
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg) continue;
  const firstTag = msg.fields[0]?.tag ?? 0;
  if (firstTag !== 0x0001) continue;
  // skip known types
  if (hasTagInRange(msg, RANGE.DEVICE_LO, RANGE.DEVICE_HI) ||
      hasTagInRange(msg, RANGE.PROBE_CONFIG_LO, RANGE.PROBE_CONFIG_HI) ||
      hasTagInRange(msg, RANGE.PROBE_TEMPLATE_LO, RANGE.PROBE_TEMPLATE_HI) ||
      hasTagInRange(msg, RANGE.SERVICE_LO, RANGE.SERVICE_HI) ||
      hasTagInRange(msg, RANGE.NOTIF_LO, RANGE.NOTIF_HI) ||
      hasTagInRange(msg, RANGE.NODE_LO, RANGE.NODE_HI) ||
      hasTagInRange(msg, RANGE.CANVAS_LO, RANGE.CANVAS_HI) ||
      hasTagInRange(msg, RANGE.LINK_LO, RANGE.LINK_HI) ||
      hasTagInRange(msg, RANGE.SNMP_LO, RANGE.SNMP_HI) ||
      hasTagInRange(msg, RANGE.TOOL_LO, RANGE.TOOL_HI) ||
      hasTagInRange(msg, RANGE.ASSET_LO, RANGE.ASSET_HI)) continue;
  console.log(`\n  id=${row.id}  fields=${msg.fields.length}`);
  for (const f of msg.fields) {
    const tagHex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    const val = f.val.k === "str" ? `"${f.val.v}"` : f.val.k === "bytes" ? `bytes[${f.val.v.length}]` : f.val.k === "compound" ? `compound[${f.val.v.length}]` : f.val.k === "u32[]" ? `u32[${f.val.v.length}] = [${f.val.v.slice(0,4).join(",")}]` : String(f.val.v);
    console.log(`    ${tagHex} (${f.val.k.padEnd(8)}) = ${val}`);
  }
}

db.close();
