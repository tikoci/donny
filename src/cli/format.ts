/**
 * Output formatting helpers for the donny CLI.
 */

import type { Device, DbStats, ProbeTemplate } from "../lib/types.ts";

/** Print a two-column key/value table. */
export function printKV(pairs: [string, string | number | boolean | undefined][]): void {
  const maxKey = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    if (v === undefined) continue;
    console.log(`  ${k.padEnd(maxKey)}  ${v}`);
  }
}

/** Print a simple ASCII table from an array of objects with a fixed set of columns. */
export function printTable(rows: Record<string, string | number | boolean | undefined>[], columns: string[]): void {
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((r) => String(r[col] ?? "").length)));
  const header = columns.map((col, i) => col.padEnd(widths[i]!)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  console.log(`  ${header}`);
  console.log(`  ${sep}`);
  for (const row of rows) {
    const line = columns.map((col, i) => String(row[col] ?? "").padEnd(widths[i]!)).join("  ");
    console.log(`  ${line}`);
  }
}

/** Format a device list as a table, omitting credentials. */
export function printDevices(devices: Device[]): void {
  printTable(
    devices.map((d) => ({ id: d.id, name: d.name, address: d.address, ros: d.routerOS ? "yes" : "", snmp: d.snmpEnabled ? "yes" : "" })),
    ["id", "name", "address", "ros", "snmp"],
  );
}

/** Format db stats. */
export function printStats(stats: DbStats): void {
  printKV([
    ["objects", stats.objects],
    ["outages", stats.outages],
    ["chart rows (raw)", stats.chartRaw],
    ["chart rows (10min)", stats.chart10min],
    ["chart rows (2hr)", stats.chart2hour],
    ["chart rows (1day)", stats.chart1day],
  ]);
}

/** Print probe templates as a table. */
export function printProbes(probes: ProbeTemplate[]): void {
  printTable(
    probes.map((p) => ({ id: p.id, name: p.name, kind: p.kind, port: p.port ?? "", builtin: p.builtIn ? "yes" : "no" })),
    ["id", "name", "kind", "port", "builtin"],
  );
}

/** Format devices as CSV to stdout. */
export function printDevicesCSV(devices: Device[], includeCredentials = false): void {
  const cols = includeCredentials
    ? ["id", "name", "address", "routerOS", "snmpEnabled", "macs", "username", "password"]
    : ["id", "name", "address", "routerOS", "snmpEnabled", "macs"];
  console.log(cols.join(","));
  for (const d of devices) {
    const row = [
      d.id,
      csvEscape(d.name),
      csvEscape(d.address),
      d.routerOS,
      d.snmpEnabled,
      csvEscape(d.macs.join(";")),
      ...(includeCredentials ? [csvEscape(d.username ?? ""), csvEscape(d.password ?? "")] : []),
    ];
    console.log(row.join(","));
  }
}

function csvEscape(v: string | undefined): string {
  if (v === undefined || v === "") return "";
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** Format devices as JSON to stdout. */
export function printDevicesJSON(devices: Device[], includeCredentials = false): void {
  const out = includeCredentials
    ? devices
    : devices.map(({ username: _u, password: _p, ...rest }) => rest);
  console.log(JSON.stringify(out, null, 2));
}

export function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

export function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
