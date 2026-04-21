import { Database } from "bun:sqlite";
import { decodeBlob, RANGE, hasTagInRange } from "../src/lib/nova.ts";

const dbPath = process.argv[2] ?? "dude_from_export.db";
const db = new Database(dbPath, { readonly: true });
const rows = db.query("SELECT id, obj FROM objs ORDER BY id").all() as { id: number; obj: Uint8Array }[];

// Check IDs > 10214 for unknown objects
console.log("=== All unknown objects after 10214 ===");
for (const row of rows) {
  if (row.id <= 10214) continue;
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg) continue;
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

  const firstTag = msg.fields[0]?.tag ?? 0;
  console.log(`  id=${row.id}  firstTag=0x${firstTag.toString(16).padStart(4,"0")}  fields=${msg.fields.length}`);
  for (const f of msg.fields) {
    const tagHex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    const val = f.val.k === "str" ? `"${f.val.v}"` : f.val.k === "bytes" ? `bytes[${f.val.v.length}]` : f.val.k === "compound" ? `compound[${f.val.v.length}]` : f.val.k === "u32[]" ? `u32[${f.val.v.length}] = [${f.val.v.slice(0,4).join(",")}]` : f.val.k === "u64" ? `u64(${f.val.v})` : String(f.val.v);
    console.log(`    ${tagHex} (${f.val.k.padEnd(8)}) = ${val}`);
  }
}

// Also check what tags device objects have that we don't know about
console.log("\n=== Full device object tags survey ===");
const knownDeviceTags = new Set([0x1f40, 0x1f41, 0x1f42, 0x1f43, 0x1f44, 0x1f45, 0x1f46, 0x1f47, 0x1f49, 0x1f4a, 0x1f4b, 0x1f4c, 0x1f56, 0x0001, 0x0010]);
const unknownDeviceTags = new Map<number, number>();
for (const row of rows) {
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg || !hasTagInRange(msg, RANGE.DEVICE_LO, RANGE.DEVICE_HI)) continue;
  for (const f of msg.fields) {
    if (!knownDeviceTags.has(f.tag)) {
      unknownDeviceTags.set(f.tag, (unknownDeviceTags.get(f.tag) ?? 0) + 1);
    }
  }
}
if (unknownDeviceTags.size) {
  console.log("Unrecognized device tags:");
  for (const [tag, count] of [...unknownDeviceTags.entries()].sort((a,b) => a[0]-b[0])) {
    console.log(`  0x${tag.toString(16).padStart(4,"0")}  (appears ${count}x)`);
  }
} else {
  console.log("All device tags accounted for!");
}

db.close();
