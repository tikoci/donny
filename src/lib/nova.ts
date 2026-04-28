/**
 * Nova Message (nv::message) TLV codec for dude.db blobs.
 *
 * RouterOS uses this binary format throughout its IPC stack and persistent
 * storage. Every row in the dude.db `objs` table is one Nova Message.
 *
 * Format: 8-byte magic, 4-byte LE field count, N fields, optional continuation.
 * Each field: 2-byte LE tag, 1-byte marker, 1-byte tcode, variable-width value.
 *
 * Reference: DESIGN.md
 */

/** 8-byte magic that starts every Nova Message blob. */
export const NOVA_MAGIC = Uint8Array.from([0x4d, 0x32, 0x01, 0x00, 0xff, 0x88, 0x01, 0x00]);

// Marker bytes
const M_STD = 0x10; // standard: value width by tcode
const M_COMPACT = 0x11; // compact: always 1 byte
const M_ALT = 0xfe; // alternate standard: same semantics as M_STD

// Type codes
const TC_BOOL_FALSE = 0x00; // 0 bytes
const TC_BOOL_TRUE = 0x01; // 0 bytes
const TC_U32 = 0x08; // 4 bytes LE
const TC_U8 = 0x09; // 1 byte
const TC_U64 = 0x10; // 8 bytes LE
const TC_BYTES_16 = 0x18; // fixed 16 bytes (e.g. IPv6 addresses in notification fields)
const TC_BYTES_4 = 0x20; // fixed 4 bytes (rare fixed-width fields)
const TC_STR = 0x21; // 1-byte length prefix + UTF-8 bytes
const TC_BYTES = 0x31; // 1-byte length prefix + raw bytes
const TC_U32_ARRAY = 0x88; // 2-byte count + count × 4 bytes LE
const TC_COMPOUND = 0xa0; // 2-byte count + nested fields; some Dude tags use string-array payloads

/** Well-known tag constants. */
export const TAG = {
  SELF_ID: 0x0001,
  NAME: 0x0010,
  // Device (0x1F40–0x1F5A)
  DEVICE_IP: 0x1f40,
  DEVICE_DNS_NAMES: 0x1f41,
  DEVICE_LOOKUP: 0x1f42,
  /** @deprecated 0x1F42 is Device_Lookup; normalized dns_mode is derived from an empty IP list. */
  DEVICE_DNS_MODE: 0x1f42,
  DEVICE_POLL_INTERVAL: 0x1f43,
  DEVICE_MAC: 0x1f44,
  DEVICE_MAC_LOOKUP: 0x1f45,  // binary flag: 0=off 1=on (C++ Device_MacLookup)
  DEVICE_USERNAME: 0x1f46,
  DEVICE_PASSWORD: 0x1f47,
  DEVICE_ENABLED: 0x1f49,
  DEVICE_ROUTER_OS: 0x1f4a,
  DEVICE_SNMP_ENABLED: 0x1f4b,
  DEVICE_TYPE_ID: 0x1f4c,     // u32 DeviceType object ID (C++ Device_TypeId); 0xFFFFFFFF = none
  DEVICE_AGENT_ID: 0x1f4d,
  DEVICE_SNMP_PROFILE: 0x1f4e, // u32 SNMP profile object ID (C++ Device_SnmpProfileId); 0xFFFFFFFF = none
  DEVICE_AUTO_DISCOVER: 0x1f51,
  DEVICE_ORDER: 0x1f52,
  DEVICE_COLOR_OVERRIDE: 0x1f53,
  DEVICE_SIZE: 0x1f54,
  DEVICE_INHERIT_PROBES: 0x1f55,
  DEVICE_EXTRA_SERVICES: 0x1f57,
  DEVICE_NOTES: 0x1f58,
  DEVICE_LABEL: 0x1f59,
  DEVICE_CUSTOM_FIELD: 0x1f5a,
  DEVICE_SERVICES: 0x1f56,
  // Device type template (0x2710–0x271F) — 17 built-in types (Bridge, Router, etc.)
  DEV_TYPE_PROBE_IDS: 0x2712,   // u32[] active probe template IDs
  DEV_TYPE_ALL_PROBES: 0x2711,  // u32[] all probe template IDs for this type
  DEV_TYPE_DEF_PROBES: 0x2710,  // u32[] default-enabled probe IDs
  DEV_TYPE_PARENT: 0x2713,      // u32 parent type id (0xFFFFFFFF = root)
  DEV_TYPE_POLL: 0x2714,        // u8 poll interval in seconds
  DEV_TYPE_URL: 0x2715,         // str device URL template e.g. "http://[Device.FirstAddress]"
  // Network/subnet group (0x2AF8–0x2AFA)
  NETWORK_SUBNETS: 0x2af8,
  NETWORK_MAP_ID: 0x2af9,
  NETWORK_NEXT_ID: 0x2afa,
  // Probe config (0x2EE0–0x2EF4)
  PROBE_ENABLED: 0x2ee0,
  PROBE_DEVICE_ID: 0x2ee1,
  PROBE_TYPE_ID: 0x2ee3,
  PROBE_SERVICE_ID: 0x2eec,
  PROBE_CREATED: 0x2eef,
  // Probe template (0x36B0–0x36D1)
  PROBE_KIND: 0x36b0,
  PROBE_PARENT: 0x36b1,
  PROBE_PORT: 0x36b2,
  // Data source / time-series anchor (0xBF68–0xBF71), exposed as Service in donny.
  SVC_ENABLED: 0xbf68,
  SVC_STATUS: 0xbf69,
  SVC_UNIT: 0xbf6a,
  SVC_TIMEOUT: 0xbf6f,
  SVC_INTERVAL: 0xbf71,
  // Notification (0x3E80–0x3E9B)
  NOTIF_ENABLED: 0x3e80,
  NOTIF_MAIL_V6: 0x3e9a,  // tcode 0x18 — 16-byte IPv6 mail server address (all-zero = not configured)
  NOTIF_MAIL_DNS: 0x3e9b, // str mail server DNS name (empty = not configured)
  // Map node placement (0x5DC0–0x5DDF)
  NODE_MAP_ID: 0x5dc0,
  NODE_DEVICE_ID: 0x5dc4,
  NODE_X: 0x5dc5,
  NODE_Y: 0x5dc6,
  // Map canvas container (0x61A8–0x61FA)
  CANVAS_LO_TAG: 0x61a8,
  // Link (0x55F0–0x55F9)
  LINK_MASTERING_TYPE: 0x55f0,
  LINK_DEVICE_A: 0x55f1, // C++ Link_MasterDevice
  LINK_MASTER_INTERFACE: 0x55f2,
  LINK_SPEED: 0x55f3,
  LINK_MAP_ID: 0x55f4,
  LINK_MAP_ELEMENT_ID: 0x55f5,
  LINK_TYPE_ID: 0x55f6,
  LINK_HISTORY: 0x55f7,
  LINK_TX_DATA_SOURCE_ID: 0x55f8,
  LINK_RX_DATA_SOURCE_ID: 0x55f9,
  // File asset virtual FS
  ASSET_PARENT_DIR: 0x697a,
  // SNMP profile (0x3C68–0x3C72)
  SNMP_VERSION: 0x3c68,
  SNMP_PORT: 0x3c6a,
  // Note/annotation (0x5208–0x5209)
  NOTE_PARENT_ID: 0x5208,
  NOTE_TIMESTAMP: 0x5209,
  // Link type (0x59D8–0x59DB)
  LTYPE_CATEGORY: 0x59d8,
  LTYPE_STYLE: 0x59d9,
  LTYPE_IFTYPE: 0x59da,
  LTYPE_SPEED: 0x59db,
  // Tool (0x7530–0x7533)
  TOOL_PARENT: 0x7531,
  TOOL_KIND: 0x7530,
  // Syslog rule (0x1770–0x1779)
  SYSLOG_ENABLED: 0x1770,
  SYSLOG_IP_FILTER: 0x1771,
  SYSLOG_IP_MASK: 0x1772,
  SYSLOG_PATTERN: 0x1773,
  SYSLOG_INVERT: 0x1774,
  SYSLOG_ACTION: 0x1778,
  SYSLOG_NOTIFICATION_ID: 0x1779,
  // Active session (0x4E20–0x4E23)
  SESSION_PANEL_ID: 0x4e20,
  SESSION_USERNAME: 0x4e21,
  // Open panel (0x4A38–0x4A3F)
  PANEL_SESSION_ID: 0x4a38,
  PANEL_MAP_ID: 0x4a3e,
  // Service description — annotations on probe templates (0x5208–0x520F)
  SVC_DESCR_PARENT: 0x5208,  // u32 probe template id this describes
  SVC_DESCR_CREATED: 0x5209, // u32 creation timestamp (Unix seconds)
  // Function / custom expression (0xCB20–0xCB2F), historically exposed as data_sources in donny.
  DS_EXPRESSION: 0xcb21,    // str OID formula e.g. "oid(concatenate(...))"
  DS_DESCRIPTION: 0xcb22,   // str human-readable description
  // Chart / panel element (0x07D0–0x07DF)
  CHART_TYPE: 0x07d0,       // str "Chart Line" | "Panel Element"
  CHART_ENABLED: 0x07d1,    // bool
  // Chart line (0xC350–0xC356)
  CHARTLINE_CHART_ID: 0xc350,
  CHARTLINE_SERVICE_ID: 0xc351,
  // Group (0x2328–0x2337)
  GROUP_MEMBERS: 0x2328,    // u32[] device/object ids in the group
  // Server state metadata (0x1000–0x101F) — one per database
  SYS_LAST_UPDATE: 0x1015,  // u32[] [timestamp, ...] last-write timestamps
  SYS_ROOT_IDS: 0x1001,     // u32[] root object id list
  SYS_COLORS: 0x0fef,       // u32[] global color palette [red,blue,green,orange]
  // Auto-discovery job (0x6590–0x65AD)
  DISCOVER_PROBE_TPLS: 0x65a0,  // u32[] — probe template IDs to apply
  DISCOVER_EXCLUDE_IDS: 0x65a1, // u32[] — device IDs to exclude
  DISCOVER_INCLUDE_IDS: 0x6590, // u32[] — explicit IDs to include
  DISCOVER_NETWORK: 0x659a,     // LE u32 — target network IPv4 address
  DISCOVER_SEED_IP: 0x65ad,     // str   — seed/gateway IP (may be empty)
  DISCOVER_CANVAS_ID: 0x6598,   // u32   — destination canvas/map ID
  DISCOVER_INTERVAL: 0x659b,    // u32   — scan interval in seconds
  DISCOVER_ENABLED: 0x659f,     // bool
} as const;

/** Tag range boundaries for object classification. */
export const RANGE = {
  // Core monitored objects
  DEVICE_LO: 0x1f40,
  DEVICE_HI: 0x1f5a,
  PROBE_CONFIG_LO: 0x2ee0,
  PROBE_CONFIG_HI: 0x2ef4,
  PROBE_TEMPLATE_LO: 0x36b0,
  PROBE_TEMPLATE_HI: 0x36d1,
  SERVICE_LO: 0xbf68,
  SERVICE_HI: 0xbf71,
  // Map / topology
  NODE_LO: 0x5dc0,
  NODE_HI: 0x5ddf,
  CANVAS_LO: 0x61a8,
  CANVAS_HI: 0x61fa,
  LINK_LO: 0x55f0,
  LINK_HI: 0x55f9,
  GROUP_LO: 0x2328,
  GROUP_HI: 0x2337,
  // Alerting / notifications
  NOTIF_LO: 0x3e80,
  NOTIF_HI: 0x3e9b,
  // Configuration profiles
  SNMP_LO: 0x3c68,
  SNMP_HI: 0x3c72,
  TOOL_LO: 0x7530,
  TOOL_HI: 0x7533,
  // Device type templates — 17 built-in types (Bridge, Router, Windows Computer, etc.)
  DEV_TYPE_LO: 0x2710,
  DEV_TYPE_HI: 0x271f,
  // Charts and functions (custom expressions; table name remains data_sources for compatibility)
  CHART_LO: 0x07d0,
  CHART_HI: 0x07df,
  DATA_SOURCE_LO: 0xcb20,
  DATA_SOURCE_HI: 0xcb2f,
  // Service description annotations on probe templates
  SVC_DESCR_LO: 0x5208,
  SVC_DESCR_HI: 0x520f,
  // Network scanner / auto-discovery settings (one per db)
  NET_SCANNER_LO: 0x1770,
  NET_SCANNER_HI: 0x177f,
  // Syslog rules (subset of net-scanner range)
  SYSLOG_RULE_LO: 0x1770,
  SYSLOG_RULE_HI: 0x1779,
  // Server state metadata (one per db)
  SERVER_META_LO: 0x1000,
  SERVER_META_HI: 0x101f,
  // File assets (fonts, icons, certs) — not user objects
  ASSET_LO: 0x697a,
  ASSET_HI: 0x697a,
  // Network/subnet group (0x2AF8–0x2AFA)
  NETWORK_LO: 0x2af8,
  NETWORK_HI: 0x2afa,
  // Link type definitions (0x59D8–0x59DB)
  LINK_TYPE_LO: 0x59d8,
  LINK_TYPE_HI: 0x59db,
  // Open panel / active session (ephemeral state)
  OPEN_PANEL_LO: 0x4a38,
  OPEN_PANEL_HI: 0x4a3f,
  ACTIVE_SESSION_LO: 0x4e20,
  ACTIVE_SESSION_HI: 0x4e23,
  // Chart line (0xC350–0xC356)
  CHART_LINE_LO: 0xc350,
  CHART_LINE_HI: 0xc356,
  // Auto-discovery job (0x6590–0x65AD)
  DISCOVER_LO: 0x6590,
  DISCOVER_HI: 0x65ad,
} as const;

/** The decoded value of a single Nova field. */
export type NovaValue =
  | { k: "bool"; v: boolean }
  | { k: "u8"; v: number }
  | { k: "u32"; v: number }
  | { k: "u64"; v: bigint }
  | { k: "str"; v: string }
  | { k: "bytes"; v: Uint8Array }
  | { k: "u32[]"; v: number[] }
  | { k: "str[]"; v: string[] }
  | { k: "compound"; v: NovaField[] };

/** A single decoded TLV field. */
export interface NovaField {
  tag: number;
  val: NovaValue;
}

/** A decoded Nova Message blob. */
export interface NovaMessage {
  fields: NovaField[];
}

// --- Cursor (bounds-safe sequential reader) ---

class Cur {
  readonly buf: Uint8Array;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get left() {
    return this.buf.length - this.pos;
  }

  u8(): number {
    if (this.left < 1) throw new RangeError("eof");
    const b = this.buf[this.pos];
    if (b === undefined) throw new RangeError("eof");
    this.pos += 1;
    return b;
  }

  u16(): number {
    if (this.left < 2) throw new RangeError("eof");
    const b0 = this.buf[this.pos];
    const b1 = this.buf[this.pos + 1];
    if (b0 === undefined || b1 === undefined) throw new RangeError("eof");
    const v = (b0 | (b1 << 8)) >>> 0;
    this.pos += 2;
    return v;
  }

  u32(): number {
    if (this.left < 4) throw new RangeError("eof");
    const b0 = this.buf[this.pos];
    const b1 = this.buf[this.pos + 1];
    const b2 = this.buf[this.pos + 2];
    const b3 = this.buf[this.pos + 3];
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
      throw new RangeError("eof");
    }
    this.pos += 4;
    return ((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0);
  }

  u64(): bigint {
    const lo = BigInt(this.u32());
    const hi = BigInt(this.u32());
    return (hi << 32n) | lo;
  }

  slice(n: number): Uint8Array {
    if (this.left < n) throw new RangeError("eof");
    const s = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
}

// --- Decoder ---

/**
 * Decode a Nova Message blob.
 *
 * Returns `null` if the blob does not start with the Nova magic.
 * Partial decodes (truncated blobs, unknown tcodes) return whatever
 * fields were successfully read.
 */
export function decodeBlob(data: Uint8Array): NovaMessage | null {
  if (data.length < NOVA_MAGIC.length + 4) return null;
  for (let i = 0; i < NOVA_MAGIC.length; i++) {
    if (data[i] !== NOVA_MAGIC[i]) return null;
  }

  const cur = new Cur(data);
  cur.pos = NOVA_MAGIC.length;
  cur.u32(); // declared field count — we parse past it (continuation section)

  const fields: NovaField[] = [];

  while (cur.left >= 4) {
    const tag = cur.u16();
    const marker = cur.u8();
    const tcode = cur.u8();

    if (marker !== M_STD && marker !== M_COMPACT && marker !== M_ALT) break;

    try {
      const val = readValue(cur, marker, tcode, tag);
      fields.push({ tag, val });
    } catch {
      break; // truncated or unknown tcode — stop cleanly
    }
  }

  return { fields };
}

function readValue(cur: Cur, marker: number, tcode: number, tag?: number): NovaValue {
  if (marker === M_COMPACT) return { k: "u8", v: cur.u8() };

  switch (tcode) {
    case TC_BOOL_FALSE:
      return { k: "bool", v: false };
    case TC_BOOL_TRUE:
      return { k: "bool", v: true };
    case TC_U8:
      return { k: "u8", v: cur.u8() };
    case TC_U32:
      return { k: "u32", v: cur.u32() };
    case TC_U64:
      return { k: "u64", v: cur.u64() };
    case TC_BYTES_16:
      return { k: "bytes", v: cur.slice(16) };
    case TC_BYTES_4:
      return { k: "bytes", v: cur.slice(4) };
    case TC_STR: {
      const len = cur.u8();
      return { k: "str", v: new TextDecoder().decode(cur.slice(len)) };
    }
    case TC_BYTES: {
      const len = cur.u8();
      return { k: "bytes", v: cur.slice(len) };
    }
    case TC_U32_ARRAY: {
      const count = cur.u16();
      const arr: number[] = [];
      for (let i = 0; i < count; i++) arr.push(cur.u32());
      return { k: "u32[]", v: arr };
    }
    case TC_COMPOUND: {
      const count = cur.u16();
      if (tag === TAG.DEVICE_DNS_NAMES) {
        const arr: string[] = [];
        for (let i = 0; i < count; i++) {
          const len = cur.u16();
          arr.push(new TextDecoder().decode(cur.slice(len)));
        }
        return { k: "str[]", v: arr };
      }
      const subs: NovaField[] = [];
      for (let i = 0; i < count && cur.left >= 4; i++) {
        const subTag = cur.u16();
        const subMarker = cur.u8();
        const subTcode = cur.u8();
        if (subMarker !== M_STD && subMarker !== M_COMPACT && subMarker !== M_ALT) break;
        try {
          subs.push({ tag: subTag, val: readValue(cur, subMarker, subTcode, subTag) });
        } catch {
          break;
        }
      }
      return { k: "compound", v: subs };
    }
    default:
      throw new Error(`unknown tcode 0x${tcode.toString(16).padStart(2, "0")}`);
  }
}

// --- Field accessors ---

/** Get the first field with a given tag, or undefined. */
export function getField(msg: NovaMessage, tag: number): NovaField | undefined {
  return msg.fields.find((f) => f.tag === tag);
}

/** Get the string value of a tag, or undefined. */
export function getStr(msg: NovaMessage, tag: number): string | undefined {
  const f = getField(msg, tag);
  return f?.val.k === "str" ? f.val.v : undefined;
}

/** Get the u32 value of a tag, or undefined. */
export function getU32(msg: NovaMessage, tag: number): number | undefined {
  const f = getField(msg, tag);
  return f?.val.k === "u32" ? f.val.v : f?.val.k === "u8" ? f.val.v : undefined;
}

/** Get the bool value of a tag, or undefined. */
export function getBool(msg: NovaMessage, tag: number): boolean | undefined {
  const f = getField(msg, tag);
  return f?.val.k === "bool" ? f.val.v : undefined;
}

/** Get the u32[] value of a tag, or undefined. */
export function getU32Array(msg: NovaMessage, tag: number): number[] | undefined {
  const f = getField(msg, tag);
  return f?.val.k === "u32[]" ? f.val.v : undefined;
}

export function getStringArray(msg: NovaMessage, tag: number): string[] | undefined {
  const f = getField(msg, tag);
  return f?.val.k === "str[]" ? f.val.v : undefined;
}

/** Get the u64 value of a tag, or undefined. */
export function getU64(msg: NovaMessage, tag: number): bigint | undefined {
  const f = getField(msg, tag);
  return f?.val.k === "u64" ? f.val.v : undefined;
}

/** True if any field's tag falls within [lo, hi] inclusive. */
export function hasTagInRange(msg: NovaMessage, lo: number, hi: number): boolean {
  return msg.fields.some((f) => f.tag >= lo && f.tag <= hi);
}

// --- IPv4 helpers ---

/**
 * Convert a dude.db little-endian u32 to dotted IPv4.
 * Returns `""` for the sentinel `0xFFFFFFFF` (no address assigned).
 */
export function ipv4FromU32(v: number): string {
  if (v === 0xffffffff) return "";
  const n = v >>> 0;
  return `${n & 0xff}.${(n >>> 8) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 24) & 0xff}`;
}

/**
 * Convert dotted-decimal IPv4 to a little-endian u32 for dude.db storage.
 */
export function ipv4ToU32(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4: ${ip}`);
  }
  const [a, b, c, d] = parts;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error(`Invalid IPv4: ${ip}`);
  }
  return ((a | (b << 8) | (c << 16) | (d << 24)) >>> 0);
}

// --- Encoder ---

/** Low-level blob builder. */
export class NovaWriter {
  private parts: Uint8Array[] = [];

  get byteLength() {
    return this.parts.reduce((s, p) => s + p.length, 0);
  }

  raw(data: Uint8Array) {
    this.parts.push(data);
    return this;
  }

  u8(v: number) {
    return this.raw(Uint8Array.from([v & 0xff]));
  }

  u16(v: number) {
    return this.raw(Uint8Array.from([v & 0xff, (v >>> 8) & 0xff]));
  }

  u32(v: number) {
    const n = v >>> 0;
    return this.raw(Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]));
  }

  u64(v: bigint) {
    const lo = Number(v & 0xffffffffn) >>> 0;
    const hi = Number((v >> 32n) & 0xffffffffn) >>> 0;
    return this.u32(lo).u32(hi);
  }

  // Field header
  private hdr(tag: number, marker: number, tcode: number) {
    return this.u16(tag).u8(marker).u8(tcode);
  }

  addBool(tag: number, v: boolean, marker = M_STD) {
    return this.hdr(tag, marker, v ? TC_BOOL_TRUE : TC_BOOL_FALSE);
  }

  addU8(tag: number, v: number, marker = M_STD) {
    return this.hdr(tag, marker, TC_U8).u8(v);
  }

  addU32(tag: number, v: number, marker = M_STD) {
    return this.hdr(tag, marker, TC_U32).u32(v);
  }

  addU64(tag: number, v: bigint, marker = M_STD) {
    return this.hdr(tag, marker, TC_U64).u64(v);
  }

  addStr(tag: number, v: string, marker = M_STD) {
    const enc = new TextEncoder().encode(v);
    return this.hdr(tag, marker, TC_STR).u8(enc.length).raw(enc);
  }

  addBytes(tag: number, v: Uint8Array, marker = M_STD) {
    return this.hdr(tag, marker, TC_BYTES).u8(v.length).raw(v);
  }

  addU32Array(tag: number, arr: number[], marker = M_STD) {
    this.hdr(tag, marker, TC_U32_ARRAY).u16(arr.length);
    for (const v of arr) this.u32(v);
    return this;
  }

  addStringArray(tag: number, arr: string[], marker = M_STD) {
    this.hdr(tag, marker, TC_COMPOUND).u16(arr.length);
    const enc = new TextEncoder();
    for (const value of arr) {
      const bytes = enc.encode(value);
      this.u16(bytes.length).raw(bytes);
    }
    return this;
  }

  addEmptyCompound(tag: number, marker = M_STD) {
    return this.hdr(tag, marker, TC_COMPOUND).u16(0);
  }

  toBytes(): Uint8Array {
    const total = this.byteLength;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of this.parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }
}

/** Build the magic + count header prefix for a blob. */
function makeHeader(sectionOneCount: number): Uint8Array {
  const w = new NovaWriter();
  w.raw(NOVA_MAGIC).u32(sectionOneCount);
  return w.toBytes();
}

// --- Blob builders for new objects ---

/** Build a minimal device blob. Credentials are optional. */
export function encodeDevice(opts: {
  id: number;
  name: string;
  address: string;
  username?: string;
  password?: string;
  routerOS?: boolean;
  snmpEnabled?: boolean;
  snmpProfileId?: number;
}): Uint8Array {
  const { id, name, address, username = "", password = "", routerOS = false, snmpEnabled = false, snmpProfileId = 0xffffffff } = opts;

  const isDns = !/^\d{1,3}(\.\d{1,3}){3}$/.test(address);
  const ipArr = isDns ? [] : [ipv4ToU32(address)];

  // Section 1: 15 fields
  const s1 = new NovaWriter();
  s1.addU32Array(TAG.DEVICE_EXTRA_SERVICES, [], M_STD);
  s1.addU32Array(TAG.DEVICE_SERVICES, [], M_STD);
  s1.addStringArray(TAG.DEVICE_DNS_NAMES, [], M_STD);
  s1.addU32Array(TAG.DEVICE_IP, ipArr, M_STD); // primary_address
  s1.addBool(TAG.DEVICE_ENABLED, true);
  s1.addBool(TAG.DEVICE_ROUTER_OS, routerOS);
  s1.addBool(TAG.DEVICE_SNMP_ENABLED, snmpEnabled);
  s1.addBool(0x1f55, false); // flag_55
  s1.addBool(TAG.DEVICE_AUTO_DISCOVER, true);
  s1.addU8(TAG.DEVICE_LOOKUP, 0);
  s1.addU8(TAG.DEVICE_POLL_INTERVAL, 60);
  s1.addU8(TAG.DEVICE_MAC_LOOKUP, 1);
  s1.addU32(TAG.DEVICE_TYPE_ID, 0xffffffff);
  s1.addU32(TAG.DEVICE_AGENT_ID, 0xffffffff);
  s1.addU32(TAG.DEVICE_SNMP_PROFILE, snmpProfileId);
  const s1Bytes = s1.toBytes();
  const s1Count = 15;

  // Section 2: separator + credentials + custom strings + MAC + name
  const s2 = new NovaWriter();
  s2.addU32(TAG.SELF_ID, id, M_ALT); // section separator
  s2.addU8(0x1f52, 0);
  s2.addU8(0x1f53, 0);
  s2.addU8(0x1f54, 0);
  s2.addStr(0x1f5a, ""); // custom_str_3
  s2.addStr(0x1f59, ""); // custom_str_2
  s2.addStr(0x1f58, ""); // custom_str_1
  s2.addStr(TAG.DEVICE_PASSWORD, password);
  s2.addStr(TAG.DEVICE_USERNAME, username);
  s2.addBytes(TAG.DEVICE_MAC, new Uint8Array());
  s2.addStr(TAG.NAME, isDns ? address : name, M_ALT); // name is always last, marker=0xFE
  const s2Bytes = s2.toBytes();

  const header = makeHeader(s1Count);
  const out = new Uint8Array(header.length + s1Bytes.length + s2Bytes.length);
  out.set(header, 0);
  out.set(s1Bytes, header.length);
  out.set(s2Bytes, header.length + s1Bytes.length);
  return out;
}

/** Build a service blob. Name convention: "probe_type @ device_name". */
export function encodeService(opts: {
  id: number;
  name: string;
  unit?: string;
}): Uint8Array {
  const { id, name, unit = "s" } = opts;

  // 12 fields in section 1, no continuation
  const w = new NovaWriter();
  w.raw(NOVA_MAGIC).u32(12);
  w.addBool(TAG.SVC_ENABLED, true);
  w.addU32(TAG.SVC_TIMEOUT, 0xffffffff);
  w.addU8(TAG.SVC_INTERVAL, 30);
  w.addU8(TAG.SVC_STATUS, 0);
  w.addU32(TAG.SELF_ID, id);
  w.addU8(0xbf6b, 0);
  w.addU8(0xbf6c, 0);
  w.addU8(0xbf6d, 0);
  w.addU8(0xbf6e, 0);
  w.addStr(0xbf70, ""); // extra_config
  w.addStr(TAG.SVC_UNIT, unit);
  w.addStr(TAG.NAME, name); // name last
  return w.toBytes();
}

/** Build a probe_config blob linking device ↔ service ↔ probe template. */
export function encodeProbeConfig(opts: {
  id: number;
  deviceId: number;
  serviceId: number;
  probeTypeId: number;
}): Uint8Array {
  const { id, deviceId, serviceId, probeTypeId } = opts;
  const now = Math.floor(Date.now() / 1000);

  // Section 1: 17 fields
  const s1 = new NovaWriter();
  s1.addU32Array(0x2ee9, []); // extra_ids
  s1.addBool(TAG.PROBE_ENABLED, true);
  s1.addBool(0x2eeb, true);
  s1.addBool(0x2ee8, false);
  s1.addBool(0x2eea, false);
  s1.addU8(0x2ee4, 0);
  s1.addU8(0x2ee5, 0);
  s1.addU8(0x2ee6, 0);
  s1.addU8(0x2ee7, 0);
  s1.addU32(TAG.PROBE_SERVICE_ID, serviceId);
  s1.addU8(0x2eed, 4);
  s1.addU32(TAG.PROBE_CREATED, now);
  s1.addU8(0x2ef0, 0); // last_value
  s1.addU8(0x2ef1, 0); // min_value
  s1.addU8(0x2ef2, 0); // avg_value
  s1.addU8(0x2ef3, 0); // max_value
  s1.addU8(0x2ef4, 0); // sample_count
  const s1Bytes = s1.toBytes();

  // Section 2: separator + device/type refs + name
  const s2 = new NovaWriter();
  s2.addU32(TAG.SELF_ID, id, M_ALT);
  s2.addU32(TAG.PROBE_DEVICE_ID, deviceId);
  s2.addU32(0x2ee2, 0xffffffff);
  s2.addU32(TAG.PROBE_TYPE_ID, probeTypeId);
  s2.addU64(0x2eee, 0n);
  s2.addStr(TAG.NAME, "", M_ALT); // probe name is usually empty
  const s2Bytes = s2.toBytes();

  const header = makeHeader(17);
  const out = new Uint8Array(header.length + s1Bytes.length + s2Bytes.length);
  out.set(header, 0);
  out.set(s1Bytes, header.length);
  out.set(s2Bytes, header.length + s1Bytes.length);
  return out;
}

// --- Built-in probe type names (present in every Dude installation) ---

const BUILTIN_PROBE_NAMES = new Set([
  "ping",
  "rnd 50:50",
  "tcp echo",
  "ftp",
  "ssh",
  "telnet",
  "smtp",
  "time",
  "gopher",
  "http",
  "pop3",
  "nntp",
  "imap4",
  "printer",
  "routeros management",
  "dns",
  "dns to mikrotik",
  "mikrotik",
  "windows",
  "hp jetdirect",
  "switch",
  "router",
  "radius",
  "netbios",
  "cpu",
  "memory",
  "virtual memory",
  "disk",
]);

export function isBuiltInProbeName(name: string): boolean {
  return BUILTIN_PROBE_NAMES.has(name.toLowerCase().trim());
}

// Built-in ID 10160 = ping probe template (present in every database).
export const PROBE_ID_PING = 10160;

// --- Additional encoders for denormalize() round-trip ---

/**
 * Build a minimal map_element (node) blob that places a device on a map.
 * Range: 0x5dc0–0x5ddf (NODE_LO/HI).
 *
 * Minimum viable fields:
 *   - SELF_ID (0x0001)         — node id
 *   - NODE_MAP_ID (0x5dc0)     — parent canvas id
 *   - NODE_DEVICE_ID (0x5dc4)  — the device this node represents (or 0xffffffff for decorative)
 *   - NODE_X (0x5dc5), NODE_Y (0x5dc6) — placement coords
 *   - NAME (0x0010, marker M_ALT) — last field
 */
export function encodeMapNode(opts: {
  id: number;
  mapId: number;
  deviceId?: number;
  x?: number;
  y?: number;
  name?: string;
}): Uint8Array {
  const { id, mapId, deviceId = 0xffffffff, x = 0, y = 0, name = "" } = opts;

  // Section 1: 4 fields
  const s1 = new NovaWriter();
  s1.addU32(TAG.NODE_MAP_ID, mapId);
  s1.addU32(TAG.NODE_DEVICE_ID, deviceId);
  s1.addU32(TAG.NODE_X, x);
  s1.addU32(TAG.NODE_Y, y);
  const s1Bytes = s1.toBytes();

  // Section 2: SELF_ID (separator) + NAME (last)
  const s2 = new NovaWriter();
  s2.addU32(TAG.SELF_ID, id, M_ALT);
  s2.addStr(TAG.NAME, name, M_ALT);
  const s2Bytes = s2.toBytes();

  const header = makeHeader(4);
  const out = new Uint8Array(header.length + s1Bytes.length + s2Bytes.length);
  out.set(header, 0);
  out.set(s1Bytes, header.length);
  out.set(s2Bytes, header.length + s1Bytes.length);
  return out;
}

/**
 * Build a minimal topology_link blob.
 * Range: 0x55f0–0x55f9 (LINK_LO/HI).
 *
 * Links are usually defined between two device endpoints; the B side may
 * point to a map_element id when the link terminates on a non-device node.
 */
export function encodeTopologyLink(opts: {
  id: number;
  deviceAId?: number;
  deviceBId?: number;
  mapElementBId?: number;
  mapId?: number;
  linkTypeId?: number;
  masteringType?: number;
  masterInterface?: number;
  speedBps?: bigint | number;
  history?: boolean;
  txDataSourceId?: number;
  rxDataSourceId?: number;
}): Uint8Array {
  const {
    id,
    deviceAId = 0xffffffff,
    deviceBId = 0xffffffff,
    mapElementBId = 0xffffffff,
    mapId = 0xffffffff,
    linkTypeId = 0xffffffff,
    masteringType = 0,
    masterInterface = 0xffffffff,
    speedBps = 0,
    history = false,
    txDataSourceId = 0xffffffff,
    rxDataSourceId = 0xffffffff,
  } = opts;
  const bSideId = mapElementBId !== 0xffffffff ? mapElementBId : deviceBId;

  // Section 1: core LinkData fields (TheDudeToHuman: Link_* 0x55F0–0x55F9).
  const s1 = new NovaWriter();
  s1.addU8(TAG.LINK_MASTERING_TYPE, masteringType);
  s1.addU32(TAG.LINK_DEVICE_A, deviceAId);
  s1.addU32(TAG.LINK_MASTER_INTERFACE, masterInterface);
  s1.addU64(TAG.LINK_SPEED, BigInt(speedBps));
  s1.addU32(TAG.LINK_MAP_ID, mapId);
  s1.addU32(TAG.LINK_MAP_ELEMENT_ID, bSideId);
  s1.addU32(TAG.LINK_TYPE_ID, linkTypeId);
  s1.addBool(TAG.LINK_HISTORY, history);
  s1.addU32(TAG.LINK_TX_DATA_SOURCE_ID, txDataSourceId);
  s1.addU32(TAG.LINK_RX_DATA_SOURCE_ID, rxDataSourceId);
  const s1Bytes = s1.toBytes();

  // Section 2: SELF_ID separator + empty NAME
  const s2 = new NovaWriter();
  s2.addU32(TAG.SELF_ID, id, M_ALT);
  s2.addStr(TAG.NAME, "", M_ALT);
  const s2Bytes = s2.toBytes();

  const header = makeHeader(10);
  const out = new Uint8Array(header.length + s1Bytes.length + s2Bytes.length);
  out.set(header, 0);
  out.set(s1Bytes, header.length);
  out.set(s2Bytes, header.length + s1Bytes.length);
  return out;
}
