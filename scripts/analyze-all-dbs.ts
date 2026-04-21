/**
 * Cross-database analysis: classify every object in all source databases,
 * report coverage and any unknown first-tags not yet handled.
 *
 *   bun run scripts/analyze-all-dbs.ts
 */
import {
  decodeBlob,
  RANGE,
  TAG,
  hasTagInRange,
  getStr,
  getU32,
  getField,
} from "../src/lib/nova.ts";
import { DudeDB } from "../src/lib/db.ts";

const DBS = ["2022.db", "tikoci.db", "dude.db", "dude_from_export.db", "clean.db", "clean.export"];

/** Ordered classifier: first match wins. */
const TYPES: Array<[string, number, number]> = [
  ["settings",     RANGE.SETTINGS_LO,      RANGE.SETTINGS_HI],
  ["syslog_rule",  RANGE.SYSLOG_RULE_LO,   RANGE.SYSLOG_RULE_HI],
  ["device_type",  RANGE.DEVICE_TYPE_LO,   RANGE.DEVICE_TYPE_HI],
  ["network",      RANGE.NETWORK_LO,       RANGE.NETWORK_HI],
  ["chart_item",   RANGE.CHART_ITEM_LO,    RANGE.CHART_ITEM_HI],
  ["probe_config", RANGE.PROBE_CONFIG_LO,  RANGE.PROBE_CONFIG_HI],
  ["probe_tpl",    RANGE.PROBE_TEMPLATE_LO,RANGE.PROBE_TEMPLATE_HI],
  ["device",       RANGE.DEVICE_LO,        RANGE.DEVICE_HI],
  ["service",      RANGE.SERVICE_LO,       RANGE.SERVICE_HI],
  ["notification", RANGE.NOTIF_LO,         RANGE.NOTIF_HI],
  ["snmp_profile", RANGE.SNMP_LO,          RANGE.SNMP_HI],
  ["tool",         RANGE.TOOL_LO,          RANGE.TOOL_HI],
  ["note",         RANGE.NOTE_LO,          RANGE.NOTE_HI],
  ["link",         RANGE.LINK_LO,          RANGE.LINK_HI],
  ["link_type",    RANGE.LINK_TYPE_LO,     RANGE.LINK_TYPE_HI],
  ["map_node",     RANGE.NODE_LO,          RANGE.NODE_HI],
  ["canvas",       RANGE.CANVAS_LO,        RANGE.CANVAS_HI],
  ["open_panel",   RANGE.OPEN_PANEL_LO,    RANGE.OPEN_PANEL_HI],
  ["active_sess",  RANGE.ACTIVE_SESSION_LO,RANGE.ACTIVE_SESSION_HI],
  ["asset",        RANGE.ASSET_LO,         RANGE.ASSET_HI],
  ["chart_line",   RANGE.CHART_LINE_LO,    RANGE.CHART_LINE_HI],
  ["custom_fn",    RANGE.CUSTOM_FN_LO,     RANGE.CUSTOM_FN_HI],
  ["group",        RANGE.GROUP_LO,         RANGE.GROUP_HI],
  ["discover",     RANGE.DISCOVER_LO,      RANGE.DISCOVER_HI],
];

// Tracks first-tag → hex for unknowns across all databases
const globalUnknownTags = new Map<number, { count: number; dbs: Set<string>; sampleId: number; sampleFields: string }>();

for (const dbPath of DBS) {
  let dudeDb: DudeDB;
  try {
    dudeDb = DudeDB.openAuto(dbPath, { readonly: true });
  } catch {
    console.log(`\n=== ${dbPath}: NOT FOUND, skipping ===`);
    continue;
  }

  const counts: Record<string, number> = {};
  const unknowns: Array<{ id: number; tags: string }> = [];
  let nullCount = 0;
  let total = 0;

  for (const { id, msg } of dudeDb.rawObjects()) {
    total++;

    let matched = false;
    for (const [label, lo, hi] of TYPES) {
      if (hasTagInRange(msg, lo, hi)) {
        counts[label] = (counts[label] ?? 0) + 1;
        matched = true;
        break;
      }
    }

    if (!matched) {
      counts["UNKNOWN"] = (counts["UNKNOWN"] ?? 0) + 1;
      // Collect all tags present in this object for diagnosis
      const tags = msg.fields.map((f) => `0x${f.tag.toString(16)}`).join(",");
      unknowns.push({ id, tags });

      // Track globally by first tag
      const firstTag = msg.fields[0]?.tag ?? 0;
      const existing = globalUnknownTags.get(firstTag);
      if (existing) {
        existing.count++;
        existing.dbs.add(dbPath);
      } else {
        const sampleFields = msg.fields.map((f) => `0x${f.tag.toString(16)}:${f.val.k}`).join("  ");
        globalUnknownTags.set(firstTag, { count: 1, dbs: new Set([dbPath]), sampleId: id, sampleFields });
      }
    }
  }

  dudeDb.close();
  const known = total - (counts["UNKNOWN"] ?? 0) - nullCount;
  const pct = ((known / total) * 100).toFixed(1);

  console.log(`\n=== ${dbPath} (${total} objects, ${pct}% classified) ===`);
  for (const [k, v] of Object.entries(counts).sort()) {
    console.log(`  ${k.padEnd(18)} ${v}`);
  }
  if (nullCount) console.log(`  ${"(null decode)".padEnd(18)} ${nullCount}`);

  if (unknowns.length > 0) {
    console.log(`  --- ${unknowns.length} unknown object(s) ---`);
    for (const u of unknowns.slice(0, 15)) {
      console.log(`  id=${u.id}  tags=[${u.tags.slice(0, 100)}]`);
    }
    if (unknowns.length > 15) console.log(`  ... and ${unknowns.length - 15} more`);
  }
}

// Global summary of unknown tag groups
if (globalUnknownTags.size > 0) {
  console.log("\n=== Unknown objects — unique first-tag groups across all DBs ===");
  for (const [tag, info] of [...globalUnknownTags.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const hex = `0x${tag.toString(16).padStart(4, "0")}`;
    console.log(`  firstTag=${hex}  count=${info.count}  dbs=[${[...info.dbs].join(", ")}]`);
    console.log(`    sample id=${info.sampleId}: ${info.sampleFields}`);
  }
}
