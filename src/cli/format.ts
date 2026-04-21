/**
 * Output formatting helpers for the donny CLI.
 */

import type { Device, DbStats, ProbeTemplate, DeviceType, LinkType, Network, SyslogRule, DeviceGroup, DiscoverJob } from "../lib/types.ts";

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
  const header = columns.map((col, i) => col.padEnd(widths[i] ?? col.length)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  console.log(`  ${header}`);
  console.log(`  ${sep}`);
  for (const row of rows) {
    const line = columns.map((col, i) => String(row[col] ?? "").padEnd(widths[i] ?? col.length)).join("  ");
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

/** Print device type templates as a table. */
export function printDeviceTypes(types: DeviceType[]): void {
  printTable(
    types.map((t) => ({
      id: t.id,
      name: t.name,
      defaultProbes: t.defaultProbeIds.slice(0, 3).join(",") + (t.defaultProbeIds.length > 3 ? "…" : ""),
      builtin: t.builtIn ? "yes" : "no",
    })),
    ["id", "name", "defaultProbes", "builtin"],
  );
}

/** Print link type definitions as a table. */
export function printLinkTypes(types: LinkType[]): void {
  const CATEGORY = ["ethernet", "vlan", "point-to-point", "wireless"];
  printTable(
    types.map((t) => ({
      id: t.id,
      name: t.name,
      category: CATEGORY[t.category] ?? String(t.category),
      ifType: t.ifType ?? "",
      speed: t.speedBps > 0n ? `${(t.speedBps / 1_000_000n).toString()}M` : "",
      builtin: t.builtIn ? "yes" : "no",
    })),
    ["id", "name", "category", "ifType", "speed", "builtin"],
  );
}

/** Print network/subnet groups as a table. */
export function printNetworks(nets: Network[]): void {
  printTable(
    nets.map((n) => ({
      id: n.id,
      name: n.name,
      subnets: n.subnets.join(", ") || "(none)",
      mapId: n.mapId ?? "",
    })),
    ["id", "name", "subnets", "mapId"],
  );
}

/** Print syslog rules as a table. */
export function printSyslogRules(rules: SyslogRule[]): void {
  const ACTION = ["notify", "log", "ignore"];
  printTable(
    rules.map((r) => ({
      id: r.id,
      name: r.name || "(default)",
      enabled: r.enabled ? "yes" : "no",
      action: ACTION[r.action] ?? String(r.action),
      pattern: r.pattern || "(any)",
    })),
    ["id", "name", "enabled", "action", "pattern"],
  );
}

export function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

/** Print device groups as a table. */
export function printDeviceGroups(groups: DeviceGroup[]): void {
  printTable(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      members: g.memberIds.length,
      memberIds: g.memberIds.slice(0, 5).join(",") + (g.memberIds.length > 5 ? "\u2026" : ""),
    })),
    ["id", "name", "members", "memberIds"],
  );
}

/** Print auto-discovery jobs as a table. */
export function printDiscoverJobs(jobs: DiscoverJob[]): void {
  printTable(
    jobs.map((j) => ({
      id: j.id,
      name: j.name,
      network: j.network ?? "",
      seedIp: j.seedIp || "(none)",
      interval: `${j.intervalSecs}s`,
      canvasId: j.canvasId ?? "",
      enabled: j.enabled ? "yes" : "no",
    })),
    ["id", "name", "network", "seedIp", "interval", "canvasId", "enabled"],
  );
}
