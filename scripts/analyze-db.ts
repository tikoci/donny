import { Database } from "bun:sqlite";
import { decodeBlob, RANGE, hasTagInRange, getStr, getU32, getBool, getField } from "../src/lib/nova.ts";

const dbPath = process.argv[2] ?? "dude_from_export.db";
const db = new Database(dbPath, { readonly: true });
const rows = db.query("SELECT id, obj FROM objs ORDER BY id").all() as { id: number; obj: Uint8Array }[];

const typeCounts: Record<string, number> = {};
const unknownObjects: Array<{ id: number; firstTag: number; fields: number }> = [];

for (const row of rows) {
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg) { typeCounts["null"] = (typeCounts["null"] ?? 0) + 1; continue; }

  const firstTag = msg.fields[0]?.tag ?? 0;

  if (hasTagInRange(msg, RANGE.DEVICE_LO, RANGE.DEVICE_HI)) typeCounts["device"] = (typeCounts["device"] ?? 0) + 1;
  else if (hasTagInRange(msg, RANGE.PROBE_CONFIG_LO, RANGE.PROBE_CONFIG_HI)) typeCounts["probeConfig"] = (typeCounts["probeConfig"] ?? 0) + 1;
  else if (hasTagInRange(msg, RANGE.PROBE_TEMPLATE_LO, RANGE.PROBE_TEMPLATE_HI)) typeCounts["probeTemplate"] = (typeCounts["probeTemplate"] ?? 0) + 1;
  else if (hasTagInRange(msg, RANGE.SERVICE_LO, RANGE.SERVICE_HI)) typeCounts["service"] = (typeCounts["service"] ?? 0) + 1;
  else if (hasTagInRange(msg, RANGE.NOTIF_LO, RANGE.NOTIF_HI)) typeCounts["notification"] = (typeCounts["notification"] ?? 0) + 1;
  else if (hasTagInRange(msg, RANGE.NODE_LO, RANGE.NODE_HI)) typeCounts["mapNode"] = (typeCounts["mapNode"] ?? 0) + 1;
  else if (hasTagInRange(msg, RANGE.CANVAS_LO, RANGE.CANVAS_HI)) typeCounts["canvas"] = (typeCounts["canvas"] ?? 0) + 1;
  else if (hasTagInRange(msg, RANGE.LINK_LO, RANGE.LINK_HI)) typeCounts["link"] = (typeCounts["link"] ?? 0) + 1;
  else if (hasTagInRange(msg, RANGE.SNMP_LO, RANGE.SNMP_HI)) typeCounts["snmpProfile"] = (typeCounts["snmpProfile"] ?? 0) + 1;
  else if (hasTagInRange(msg, RANGE.TOOL_LO, RANGE.TOOL_HI)) typeCounts["tool"] = (typeCounts["tool"] ?? 0) + 1;
  else if (hasTagInRange(msg, RANGE.ASSET_LO, RANGE.ASSET_HI)) typeCounts["asset"] = (typeCounts["asset"] ?? 0) + 1;
  else {
    typeCounts["unknown"] = (typeCounts["unknown"] ?? 0) + 1;
    unknownObjects.push({ id: row.id, firstTag, fields: msg.fields.length });
  }
}

console.log("=== Object type counts ===");
for (const [type, count] of Object.entries(typeCounts).sort()) {
  console.log(`  ${type.padEnd(16)} ${count}`);
}
console.log(`  ${"TOTAL".padEnd(16)} ${rows.length}`);

if (unknownObjects.length > 0) {
  console.log("\n=== Unknown objects (id / firstTag / fieldCount) ===");
  for (const u of unknownObjects.slice(0, 30)) {
    console.log(`  id=${u.id}  firstTag=0x${u.firstTag.toString(16).padStart(4, "0")}  fields=${u.fields}`);
  }
}

// Dump a few objects of each range to understand structure
console.log("\n=== Notification samples ===");
let notifCount = 0;
for (const row of rows) {
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg || !hasTagInRange(msg, RANGE.NOTIF_LO, RANGE.NOTIF_HI)) continue;
  if (notifCount++ >= 3) break;
  console.log(`  id=${row.id}  name=${getStr(msg, 0x0010) ?? "(none)"}  fields=${msg.fields.length}`);
  for (const f of msg.fields.slice(0, 12)) {
    const tagHex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    const val = f.val.k === "str" ? `"${f.val.v}"` : f.val.k === "bytes" ? `bytes[${f.val.v.length}]` : f.val.k === "compound" ? `compound[${f.val.v.length}]` : f.val.k === "u32[]" ? `u32[${f.val.v.length}]` : String(f.val.v);
    console.log(`    ${tagHex} (${f.val.k.padEnd(8)}) = ${val}`);
  }
}

console.log("\n=== Link samples ===");
let linkCount = 0;
for (const row of rows) {
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg || !hasTagInRange(msg, RANGE.LINK_LO, RANGE.LINK_HI)) continue;
  if (linkCount++ >= 3) break;
  console.log(`  id=${row.id}  name=${getStr(msg, 0x0010) ?? "(none)"}  fields=${msg.fields.length}`);
  for (const f of msg.fields) {
    const tagHex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    const val = f.val.k === "str" ? `"${f.val.v}"` : f.val.k === "bytes" ? `bytes[${f.val.v.length}]` : f.val.k === "compound" ? `compound[${f.val.v.length}]` : f.val.k === "u32[]" ? `u32[${f.val.v.length}]` : String(f.val.v);
    console.log(`    ${tagHex} (${f.val.k.padEnd(8)}) = ${val}`);
  }
}

console.log("\n=== Map node samples ===");
let nodeCount = 0;
for (const row of rows) {
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg || !hasTagInRange(msg, RANGE.NODE_LO, RANGE.NODE_HI)) continue;
  if (nodeCount++ >= 2) break;
  console.log(`  id=${row.id}  fields=${msg.fields.length}`);
  for (const f of msg.fields) {
    const tagHex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    const val = f.val.k === "str" ? `"${f.val.v}"` : f.val.k === "bytes" ? `bytes[${f.val.v.length}]` : f.val.k === "compound" ? `compound[${f.val.v.length}]` : f.val.k === "u32[]" ? `u32[${f.val.v.length}]` : String(f.val.v);
    console.log(`    ${tagHex} (${f.val.k.padEnd(8)}) = ${val}`);
  }
}

console.log("\n=== SNMP profile samples ===");
let snmpCount = 0;
for (const row of rows) {
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg || !hasTagInRange(msg, RANGE.SNMP_LO, RANGE.SNMP_HI)) continue;
  if (snmpCount++ >= 3) break;
  console.log(`  id=${row.id}  name=${getStr(msg, 0x0010) ?? "(none)"}  fields=${msg.fields.length}`);
  for (const f of msg.fields) {
    const tagHex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    const val = f.val.k === "str" ? `"${f.val.v}"` : f.val.k === "bytes" ? `bytes[${f.val.v.length}]` : f.val.k === "compound" ? `compound[${f.val.v.length}]` : f.val.k === "u32[]" ? `u32[${f.val.v.length}]` : String(f.val.v);
    console.log(`    ${tagHex} (${f.val.k.padEnd(8)}) = ${val}`);
  }
}

console.log("\n=== Tool samples ===");
let toolCount = 0;
for (const row of rows) {
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg || !hasTagInRange(msg, RANGE.TOOL_LO, RANGE.TOOL_HI)) continue;
  if (toolCount++ >= 3) break;
  console.log(`  id=${row.id}  name=${getStr(msg, 0x0010) ?? "(none)"}  fields=${msg.fields.length}`);
  for (const f of msg.fields) {
    const tagHex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    const val = f.val.k === "str" ? `"${f.val.v}"` : f.val.k === "bytes" ? `bytes[${f.val.v.length}]` : f.val.k === "compound" ? `compound[${f.val.v.length}]` : f.val.k === "u32[]" ? `u32[${f.val.v.length}]` : String(f.val.v);
    console.log(`    ${tagHex} (${f.val.k.padEnd(8)}) = ${val}`);
  }
}

console.log("\n=== Device samples (first 2) ===");
let devCount = 0;
for (const row of rows) {
  const blob = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
  const msg = decodeBlob(blob);
  if (!msg || !hasTagInRange(msg, RANGE.DEVICE_LO, RANGE.DEVICE_HI)) continue;
  if (devCount++ >= 2) break;
  console.log(`  id=${row.id}  fields=${msg.fields.length}`);
  for (const f of msg.fields) {
    const tagHex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    const val = f.val.k === "str" ? `"${f.val.v}"` : f.val.k === "bytes" ? `bytes[${f.val.v.length}]` : f.val.k === "compound" ? `compound[${f.val.v.length}]` : f.val.k === "u32[]" ? `u32[${f.val.v.length}]` : String(f.val.v);
    console.log(`    ${tagHex} (${f.val.k.padEnd(8)}) = ${val}`);
  }
}

db.close();
