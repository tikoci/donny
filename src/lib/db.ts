/**
 * DudeDB — read/write access to a dude.db SQLite file.
 *
 * Uses Bun's built-in `bun:sqlite` driver — no native addons required.
 * All blob encoding/decoding is handled by the Nova Message codec in nova.ts.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  decodeBlob,
  encodeDevice,
  encodeProbeConfig,
  encodeService,
  getBool,
  getField,
  getStr,
  getStringArray,
  getU32,
  getU32Array,
  getU64,
  hasTagInRange,
  ipv4FromU32,
  isBuiltInProbeName,
  PROBE_ID_PING,
  RANGE,
  TAG,
} from "./nova.ts";
import type {
  AddDeviceOptions,
  DbStats,
  Device,
  DeviceGroup,
  DeviceType,
  DiscoverJob,
  DudeMap,
  LinkType,
  MetricPoint,
  Network,
  Outage,
  ProbeConfig,
  ProbeTemplate,
  Service,
  SyslogRule,
} from "./types.ts";

interface ObjRow {
  id: number;
  obj: Uint8Array;
}

interface CountRow {
  n: number;
}

/** MAC address data format: 4-byte header + 2-byte LE count + N × 6-byte MACs. */
function parseMacData(raw: Uint8Array): string[] {
  if (raw.length < 6) return [];
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const macBytesLen = view.getUint16(4, true);
  const macs: string[] = [];
  let pos = 6;
  const end = Math.min(pos + macBytesLen, raw.length);
  while (pos + 6 <= end) {
    const mac = Array.from(raw.slice(pos, pos + 6))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(":");
    if (mac !== "00:00:00:00:00:00" && mac !== "ff:ff:ff:ff:ff:ff") {
      macs.push(mac.toUpperCase());
    }
    pos += 6;
  }
  return macs;
}

function isDeviceObject(rowId: number, msg: NonNullable<ReturnType<typeof decodeBlob>>): boolean {
  if (!hasTagInRange(msg, RANGE.DEVICE_LO, RANGE.DEVICE_HI)) return false;

  // Real device objects observed in Dude DBs carry SELF_ID in the continuation
  // section. Partial fragments can still contain device-range tags, so skip them.
  if (getU32(msg, TAG.SELF_ID) !== rowId) return false;

  return getField(msg, TAG.DEVICE_IP) !== undefined
    || getField(msg, TAG.DEVICE_LOOKUP) !== undefined
    || getField(msg, TAG.NAME) !== undefined;
}

/** Open a dude.db file for read/write or read-only access. */
export class DudeDB {
  private db: Database;
  private isReadonly: boolean;
  private _tempDir?: string;

  private constructor(db: Database, isReadonly: boolean, tempDir?: string) {
    this.db = db;
    this.isReadonly = isReadonly;
    this._tempDir = tempDir;
  }

  /** Open a database file. Pass `readonly: true` to prevent accidental writes. */
  static open(path: string, options: { readonly?: boolean } = {}): DudeDB {
    const readonly = options.readonly ?? false;
    const db = readonly ? new Database(path, { readonly: true }) : new Database(path);
    return new DudeDB(db, readonly);
  }

  /**
   * Open either a raw `dude.db` SQLite file or an `export.dude` archive.
   *
   * `export.dude` is the file produced by The Dude's `/dude/export-db` command.
   * It is a gzip-compressed POSIX tar archive containing a single `dude.db` file.
   * This method detects the gzip magic header, decompresses, strips the 512-byte
   * tar header, and opens the embedded SQLite data as an in-memory database.
   *
   * Raw `.db` files are opened directly with the normal `open()` path.
   */
  static openAuto(path: string, options: { readonly?: boolean } = {}): DudeDB {
    const readonly = options.readonly ?? false;
    const bytes = new Uint8Array(readFileSync(path));

    // gzip magic: 0x1F 0x8B
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const decompressed = Bun.gunzipSync(bytes);
      // TAR header: file size is a 12-byte null-terminated octal string at offset 124
      const sizeField = new TextDecoder().decode(decompressed.slice(124, 136)).replace(/\0/g, "").trim();
      const fileSize = Number.parseInt(sizeField, 8);
      if (Number.isNaN(fileSize) || fileSize <= 0) {
        throw new Error("export.dude: could not parse tar header file size");
      }
      const sqliteBytes = decompressed.slice(512, 512 + fileSize);
      // Database.deserialize is unreliable in some Bun versions; write to a
      // temporary file and open it normally. The temp dir is cleaned up on close().
      const tempDir = mkdtempSync(join(tmpdir(), "donny-"));
      const tempPath = join(tempDir, "dude.db");
      writeFileSync(tempPath, sqliteBytes);
      const db = new Database(tempPath);
      if (readonly) db.exec("PRAGMA query_only = ON");
      return new DudeDB(db, readonly, tempDir);
    }

    return DudeDB.open(path, options);
  }

  /** Create an empty in-memory database with the dude.db schema (useful for tests). */
  static inMemory(): DudeDB {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE objs (id integer primary key, obj blob);
      CREATE TABLE outages (
        timeAndServiceID integer primary key,
        serviceID integer, deviceID integer, mapID integer,
        time integer, status integer, duration integer
      );
      CREATE TABLE chart_values_raw    (sourceIDandTime integer primary key, value real);
      CREATE TABLE chart_values_10min  (sourceIDandTime integer primary key, value real);
      CREATE TABLE chart_values_2hour  (sourceIDandTime integer primary key, value real);
      CREATE TABLE chart_values_1day   (sourceIDandTime integer primary key, value real);
    `);
    return new DudeDB(db, false);
  }

  close() {
    this.db.close();
    if (this._tempDir) {
      try { rmSync(this._tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      this._tempDir = undefined;
    }
  }

  /** Row counts for each table. */
  stats(): DbStats {
    const q = (sql: string) => this.db.query<CountRow, []>(sql).get()?.n ?? 0;
    return {
      objects: q("SELECT COUNT(*) as n FROM objs"),
      outages: q("SELECT COUNT(*) as n FROM outages"),
      chartRaw: q("SELECT COUNT(*) as n FROM chart_values_raw"),
      chart10min: q("SELECT COUNT(*) as n FROM chart_values_10min"),
      chart2hour: q("SELECT COUNT(*) as n FROM chart_values_2hour"),
      chart1day: q("SELECT COUNT(*) as n FROM chart_values_1day"),
    };
  }

  /** Iterate all raw decoded object blobs. */
  *rawObjects(): Generator<{ id: number; msg: NonNullable<ReturnType<typeof decodeBlob>> }> {
    const stmt = this.db.query<ObjRow, []>("SELECT id, obj FROM objs ORDER BY id");
    for (const row of stmt.iterate()) {
      const msg = decodeBlob(row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj);
      if (msg) yield { id: row.id, msg };
    }
  }

  /** All raw object blobs (id + bytes) without decoding. Used by normalize() to mirror the source verbatim. */
  *rawObjectBlobs(): Generator<{ id: number; obj: Uint8Array }> {
    const stmt = this.db.query<ObjRow, []>("SELECT id, obj FROM objs ORDER BY id");
    for (const row of stmt.iterate()) {
      const obj = row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj;
      yield { id: row.id, obj };
    }
  }

  /** All decoded device objects. */
  devices(): Device[] {
    const out: Device[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!isDeviceObject(id, msg)) continue;

      const ipArr = getU32Array(msg, TAG.DEVICE_IP) ?? [];
      let address = "";
      for (const v of ipArr) {
        const s = ipv4FromU32(v);
        if (s) { address = s; break; }
      }
      const name = getStr(msg, TAG.NAME) ?? "";
      if (!address) address = getStringArray(msg, TAG.DEVICE_DNS_NAMES)?.[0] ?? name;

      const macField = msg.fields.find((f) => f.tag === TAG.DEVICE_MAC && f.val.k === "bytes");
      const macs = macField?.val.k === "bytes" ? parseMacData(macField.val.v) : [];

      const rawDtId = getU32(msg, TAG.DEVICE_TYPE_ID);
      const deviceTypeId = rawDtId === undefined || rawDtId === 0xffffffff ? undefined : rawDtId;

      out.push({
        id,
        name,
        address,
        username: getStr(msg, TAG.DEVICE_USERNAME) || undefined,
        password: getStr(msg, TAG.DEVICE_PASSWORD) || undefined,
        routerOS: getBool(msg, TAG.DEVICE_ROUTER_OS) ?? false,
        snmpEnabled: getBool(msg, TAG.DEVICE_SNMP_ENABLED) ?? false,
        snmpProfileId: getU32(msg, TAG.DEVICE_SNMP_PROFILE),
        pollInterval: getU32(msg, TAG.DEVICE_POLL_INTERVAL),
        deviceTypeId,
        macs,
      });
    }
    return out;
  }

  /** All probe type templates (built-in and custom). */
  probeTemplates(options: { builtInOnly?: boolean; customOnly?: boolean } = {}): ProbeTemplate[] {
    const out: ProbeTemplate[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!hasTagInRange(msg, RANGE.PROBE_TEMPLATE_LO, RANGE.PROBE_TEMPLATE_HI)) continue;
      const name = getStr(msg, TAG.NAME) ?? "";
      const builtIn = isBuiltInProbeName(name);
      if (options.builtInOnly && !builtIn) continue;
      if (options.customOnly && builtIn) continue;
      out.push({
        id,
        name,
        kind: getU32(msg, TAG.PROBE_KIND) ?? 0,
        port: getU32(msg, TAG.PROBE_PORT),
        builtIn,
      });
    }
    return out;
  }

  /** All probe config records (per-device monitoring assignments). */
  probeConfigs(): ProbeConfig[] {
    const out: ProbeConfig[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!hasTagInRange(msg, RANGE.PROBE_CONFIG_LO, RANGE.PROBE_CONFIG_HI)) continue;
      const deviceId = getU32(msg, TAG.PROBE_DEVICE_ID);
      const serviceId = getU32(msg, TAG.PROBE_SERVICE_ID);
      const probeTypeId = getU32(msg, TAG.PROBE_TYPE_ID);
      if (!deviceId || !serviceId || !probeTypeId) continue;
      out.push({
        id,
        deviceId,
        serviceId,
        probeTypeId,
        enabled: getBool(msg, TAG.PROBE_ENABLED) ?? true,
        createdAt: getU32(msg, TAG.PROBE_CREATED),
      });
    }
    return out;
  }

  /** All monitoring service records. */
  services(): Service[] {
    const out: Service[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!hasTagInRange(msg, RANGE.SERVICE_LO, RANGE.SERVICE_HI)) continue;
      out.push({
        id,
        name: getStr(msg, TAG.NAME) ?? "",
        unit: getStr(msg, TAG.SVC_UNIT) ?? "s",
        enabled: getBool(msg, TAG.SVC_ENABLED) ?? true,
      });
    }
    return out;
  }

  /** All map canvas objects. */
  maps(): DudeMap[] {
    const out: DudeMap[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!hasTagInRange(msg, RANGE.CANVAS_LO, RANGE.CANVAS_HI)) continue;
      out.push({ id, name: getStr(msg, TAG.NAME) ?? `map-${id}` });
    }
    return out;
  }

  /** All device type templates (built-in and custom). */
  deviceTypes(): DeviceType[] {
    const out: DeviceType[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!hasTagInRange(msg, RANGE.DEV_TYPE_LO, RANGE.DEV_TYPE_HI)) continue;
      const parentRaw = getU32(msg, TAG.DEV_TYPE_PARENT);
      out.push({
        id,
        name: getStr(msg, TAG.NAME) ?? "",
        defaultProbeIds: getU32Array(msg, TAG.DEV_TYPE_DEF_PROBES) ?? [],
        parentTypeId: parentRaw === 0xffffffff ? undefined : parentRaw,
        manageUrl: getStr(msg, TAG.DEV_TYPE_URL) || undefined,
        builtIn: getU32(msg, TAG.SELF_ID) !== undefined && id < 20000,
      });
    }
    return out;
  }

  /** All link/interface type definitions (built-in and custom). */
  linkTypes(): LinkType[] {
    const out: LinkType[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!hasTagInRange(msg, RANGE.LINK_TYPE_LO, RANGE.LINK_TYPE_HI)) continue;
      const ifTypeRaw = getU32(msg, TAG.LTYPE_IFTYPE);
      out.push({
        id,
        name: getStr(msg, TAG.NAME) ?? "",
        category: getU32(msg, TAG.LTYPE_CATEGORY) ?? 0,
        ifType: ifTypeRaw === 0xffffffff ? undefined : ifTypeRaw,
        speedBps: getU64(msg, TAG.LTYPE_SPEED) ?? 0n,
        builtIn: id < 20000,
      });
    }
    return out;
  }

  /** All network/subnet group definitions. */
  networks(): Network[] {
    const out: Network[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!hasTagInRange(msg, RANGE.NETWORK_LO, RANGE.NETWORK_HI)) continue;
      const subnetPairs = getU32Array(msg, TAG.NETWORK_SUBNETS) ?? [];
      const subnets: string[] = [];
      for (let i = 0; i + 1 < subnetPairs.length; i += 2) {
        const ip = ipv4FromU32(subnetPairs[i] ?? 0);
        const mask = subnetPairs[i + 1];
        if (ip && mask !== undefined && mask !== 0xffffffff) {
          // Mask is stored as prefix length or full mask — count bits
          const bits = mask === 0 ? 0 : 32 - Math.clz32(mask === 0xffffffff ? 0 : ~mask >>> 0);
          subnets.push(`${ip}/${bits}`);
        }
      }
      const mapRaw = getU32(msg, TAG.NETWORK_MAP_ID);
      out.push({
        id,
        name: getStr(msg, TAG.NAME) ?? "",
        subnets,
        mapId: mapRaw === 0xffffffff ? undefined : mapRaw,
      });
    }
    return out;
  }

  /** All syslog rules. */
  syslogRules(): SyslogRule[] {
    const out: SyslogRule[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!hasTagInRange(msg, RANGE.SYSLOG_RULE_LO, RANGE.SYSLOG_RULE_HI)) continue;
      const notifRaw = getU32(msg, TAG.SYSLOG_NOTIFICATION_ID);
      out.push({
        id,
        name: getStr(msg, TAG.NAME) ?? "",
        enabled: getBool(msg, TAG.SYSLOG_ENABLED) ?? true,
        pattern: getStr(msg, TAG.SYSLOG_PATTERN) ?? "",
        action: getU32(msg, TAG.SYSLOG_ACTION) ?? 0,
        notificationId: notifRaw === 0xffffffff ? undefined : notifRaw,
      });
    }
    return out;
  }

  /** Named device groups (collections of device IDs, range 0x2328). */
  deviceGroups(): DeviceGroup[] {
    const out: DeviceGroup[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!hasTagInRange(msg, RANGE.GROUP_LO, RANGE.GROUP_HI)) continue;
      out.push({
        id,
        name: getStr(msg, TAG.NAME) ?? "",
        memberIds: getU32Array(msg, TAG.GROUP_MEMBERS) ?? [],
      });
    }
    return out;
  }

  /** Auto-discovery job records (range 0x6590–0x65AD). */
  discoverJobs(): DiscoverJob[] {
    const out: DiscoverJob[] = [];
    for (const { id, msg } of this.rawObjects()) {
      if (!hasTagInRange(msg, RANGE.DISCOVER_LO, RANGE.DISCOVER_HI)) continue;
      const netRaw = getU32(msg, TAG.DISCOVER_NETWORK);
      out.push({
        id,
        name: getStr(msg, TAG.NAME) ?? "",
        network: netRaw !== undefined && netRaw !== 0xffffffff ? ipv4FromU32(netRaw) : undefined,
        seedIp: getStr(msg, TAG.DISCOVER_SEED_IP) ?? "",
        canvasId: getU32(msg, TAG.DISCOVER_CANVAS_ID),
        intervalSecs: getU32(msg, TAG.DISCOVER_INTERVAL) ?? 3600,
        probeTemplateIds: getU32Array(msg, TAG.DISCOVER_PROBE_TPLS) ?? [],
        enabled: getBool(msg, TAG.DISCOVER_ENABLED) ?? true,
      });
    }
    return out;
  }

  /** Outage history. Optionally filter by service or device ID. */
  outages(options: { serviceId?: number; deviceId?: number; limit?: number } = {}): Outage[] {
    const conditions: string[] = [];
    const params: Record<string, number> = {};
    if (options.serviceId !== undefined) {
      conditions.push("serviceID = $serviceId");
      params.$serviceId = options.serviceId;
    }
    if (options.deviceId !== undefined) {
      conditions.push("deviceID = $deviceId");
      params.$deviceId = options.deviceId;
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ? `LIMIT ${options.limit}` : "";
    const sql = `SELECT serviceID, deviceID, mapID, time, status, duration FROM outages ${where} ORDER BY time DESC ${limit}`;
    return this.db.query<Omit<Outage, never>, Record<string, number>>(sql).all(params) as Outage[];
  }

  /**
   * Metric history for a service across all resolutions.
   * `resolution` maps to the four chart_values_* tables.
   */
  metrics(serviceId: number, resolution: "raw" | "10min" | "2hour" | "1day" = "10min", limit = 1000): MetricPoint[] {
    const table = `chart_values_${resolution}`;
    const sid = BigInt(serviceId);
    const loKey = (sid << 32n).toString();
    const hiKey = ((sid + 1n) << 32n).toString();
    const rows = this.db
      .query<{ k: string; v: number }, []>(
        `SELECT sourceIDandTime as k, value as v FROM ${table} WHERE sourceIDandTime >= ${loKey} AND sourceIDandTime < ${hiKey} ORDER BY sourceIDandTime DESC LIMIT ${limit}`,
      )
      .all();
    return rows.map((r) => ({
      serviceId,
      timestamp: Number(BigInt(r.k) & 0xffffffffn),
      value: r.v,
    }));
  }

  // --- Write operations ---

  private assertWritable() {
    if (this.isReadonly) throw new Error("DudeDB opened read-only");
  }

  private nextId(): number {
    const row = this.db.query<{ m: number | null }, []>("SELECT MAX(id) as m FROM objs").get();
    return (row?.m ?? 9999) + 1;
  }

  /**
   * Insert a device with a ping probe into the database.
   *
   * Returns `{ deviceId, probeId, serviceId }`.
   * The probe type defaults to the built-in ping template (ID 10160).
   */
  addDevice(opts: AddDeviceOptions): { deviceId: number; probeId: number; serviceId: number } {
    this.assertWritable();

    const probeTypeIds = opts.probeTypeIds ?? [PROBE_ID_PING];
    const insert = this.db.prepare("INSERT INTO objs (id, obj) VALUES (?, ?)");

    let deviceId = 0;
    let lastProbeId = 0;
    let lastServiceId = 0;

    this.db.transaction(() => {
      deviceId = this.nextId();
      const deviceBlob = encodeDevice({ ...opts, id: deviceId });
      insert.run(deviceId, deviceBlob);

      for (const probeTypeId of probeTypeIds) {
        const probeId = this.nextId();
        const serviceId = probeId + 1;

        // Determine service name by looking up the probe template name
        const templateName = this.probeTemplates().find((p) => p.id === probeTypeId)?.name ?? "probe";
        const serviceName = `${templateName} @ ${opts.name}`;
        const serviceUnit = templateName === "ping" ? "s" : "bit/s";

        const serviceBlob = encodeService({ id: serviceId, name: serviceName, unit: serviceUnit });
        insert.run(serviceId, serviceBlob);

        const probeBlob = encodeProbeConfig({ id: probeId, deviceId, serviceId, probeTypeId });
        insert.run(probeId, probeBlob);

        lastProbeId = probeId;
        lastServiceId = serviceId;
      }
    })();

    return { deviceId, probeId: lastProbeId, serviceId: lastServiceId };
  }

  /** Remove an object by ID. */
  removeObject(id: number) {
    this.assertWritable();
    this.db.run("DELETE FROM objs WHERE id = ?", [id]);
  }
}
