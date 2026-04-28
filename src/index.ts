/**
 * @module @tikoci/donny
 *
 * TypeScript library for reading and writing MikroTik The Dude network
 * monitoring databases (dude.db).
 *
 * ## Quick start
 *
 * ```ts
 * import { DudeDB } from "@tikoci/donny";
 *
 * const db = DudeDB.open("dude.db", { readonly: true });
 * const devices = db.devices();
 * console.log(devices);
 * db.close();
 * ```
 *
 * ## Key exports
 *
 * - {@link DudeDB} — Main class: `open()`, `devices()`, `probeTemplates()`,
 *   `maps()`, `services()`, `outages()`, `metrics()`, `addDevice()`, `stats()`
 * - {@link decodeBlob} / {@link encodeDevice} — Low-level Nova Message codec
 * - {@link ipv4FromU32} / {@link ipv4ToU32} — IPv4 ↔ dude.db u32 conversion
 * - {@link TAG} / {@link RANGE} / {@link NOVA_MAGIC} — Tag and range constants
 *
 * @packageDocumentation
 */

// Database class
export { DudeDB } from "./lib/db.ts";

// Normalized SQLite export
export {
  normalize,
  normalizeToFile,
  NORMALIZED_SCHEMA_SQL,
} from "./lib/normalize.ts";
export type {
  NormalizeStats,
  NormalizeResult,
  NormalizeOptions,
  NormalizeToFileOptions,
} from "./lib/normalize.ts";

// Denormalize (rebuild dude.db from normalized SQLite)
export {
  denormalize,
  denormalizeToFile,
  DUDE_DB_SCHEMA_SQL,
} from "./lib/denormalize.ts";
export type {
  DenormalizeStats,
  DenormalizeResult,
  DenormalizeOptions,
  DenormalizeToFileOptions,
} from "./lib/denormalize.ts";

// Nova Message codec (low-level)
export {
  NOVA_MAGIC,
  TAG,
  RANGE,
  decodeBlob,
  encodeDevice,
  encodeMapNode,
  encodeService,
  encodeProbeConfig,
  encodeTopologyLink,
  getField,
  getStr,
  getU32,
  getBool,
  getU32Array,
  getStringArray,
  hasTagInRange,
  ipv4FromU32,
  ipv4ToU32,
  isBuiltInProbeName,
  getU64,
  PROBE_ID_PING,
  NovaWriter,
} from "./lib/nova.ts";

// Domain types
export type {
  DbStats,
  Device,
  AddDeviceOptions,
  ProbeTemplate,
  ProbeConfig,
  Service,
  DudeMap,
  Outage,
  MetricPoint,
  ExportOptions,
  DeviceType,
  LinkType,
  Network,
  SyslogRule,
  DeviceGroup,
  DiscoverJob,
} from "./lib/types.ts";

// Nova codec types
export type { NovaField, NovaMessage, NovaValue } from "./lib/nova.ts";
