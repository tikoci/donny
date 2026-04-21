/**
 * Unit tests for the Nova Message TLV codec.
 *
 * Byte fixtures are hand-constructed minimal blobs covering:
 * - IP-mode device (tag 0x1F40 present with IPv4 value)
 * - DNS-mode device (tag 0x1F41 present, no 0x1F40)
 * - Round-trip: encode a device, decode it back
 * - Edge cases: empty blob, bad magic, truncated blob
 */

import { expect, test, describe } from "bun:test";
import {
  decodeBlob,
  encodeDevice,
  encodeService,
  encodeProbeConfig,
  getStr,
  getU32,
  getU32Array,
  hasTagInRange,
  ipv4FromU32,
  ipv4ToU32,
  isBuiltInProbeName,
  NOVA_MAGIC,
  RANGE,
  TAG,
} from "../../src/lib/nova.ts";

// --- Helpers for building byte-literal test fixtures ---

/** Little-endian u16 */
const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
/** Little-endian u32 */
const u32 = (v: number) => {
  const n = v >>> 0;
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
};
/** 1-byte len + ascii bytes */
const str = (s: string) => [s.length, ...s.split("").map((c) => c.charCodeAt(0))];

const MAGIC = [...NOVA_MAGIC];
const M_STD = 0x10;
const M_ALT = 0xfe;
const TC_U32 = 0x08;
const TC_STR = 0x21;
const TC_U32_ARRAY = 0x88;
const TC_COMPOUND = 0xa0;

function must<T>(value: T | null | undefined, message = "expected value to be present"): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// Minimal device blob: IP 192.168.2.1, name "testhost", selfID 1000
const IP_DEVICE_BLOB = Uint8Array.from([
  ...MAGIC,
  ...u32(1), // section 1 count = 1
  // field: tag=0x1F40, marker=0x10, tcode=0x88 (u32_array)
  ...u16(0x1f40), M_STD, TC_U32_ARRAY,
  ...u16(1), // array len=1
  ...u32(ipv4ToU32("192.168.2.1")),
  // continuation: self_id
  ...u16(TAG.SELF_ID), M_ALT, TC_U32,
  ...u32(1000),
  // continuation: name
  ...u16(TAG.NAME), M_ALT, TC_STR,
  ...str("testhost"),
]);

// Minimal DNS-mode device: empty interface list + dns_mode=1, no IP, name "router.lan"
const DNS_DEVICE_BLOB = Uint8Array.from([
  ...MAGIC,
  ...u32(2), // section 1 count = 2
  ...u16(0x1f41), M_STD, TC_COMPOUND,
  ...u16(0), // compound count=0
  ...u16(TAG.DEVICE_DNS_MODE), M_STD, 0x09,
  0x01,
  ...u16(TAG.SELF_ID), M_ALT, TC_U32,
  ...u32(42),
  ...u16(TAG.NAME), M_ALT, TC_STR,
  ...str("router.lan"),
]);

// --- Tests ---

describe("decodeBlob", () => {
  test("returns null for empty blob", () => {
    expect(decodeBlob(new Uint8Array(0))).toBeNull();
  });

  test("returns null for wrong magic", () => {
    const bad = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x00, 0x00, 0x00]);
    expect(decodeBlob(bad)).toBeNull();
  });

  test("returns null for truncated header", () => {
    expect(decodeBlob(NOVA_MAGIC.slice(0, 4))).toBeNull();
  });

  test("decodes IP-mode device — extracts IP address", () => {
    const msg = decodeBlob(IP_DEVICE_BLOB);
    const ipArr = getU32Array(must(msg), TAG.DEVICE_IP);
    expect(ipArr).toBeDefined();
    expect(ipv4FromU32(must(ipArr)?.[0] ?? 0)).toBe("192.168.2.1");
  });

  test("decodes IP-mode device — extracts name", () => {
    const msg = decodeBlob(IP_DEVICE_BLOB);
    expect(getStr(must(msg), TAG.NAME)).toBe("testhost");
  });

  test("decodes IP-mode device — extracts selfID", () => {
    const msg = decodeBlob(IP_DEVICE_BLOB);
    expect(getU32(must(msg), TAG.SELF_ID)).toBe(1000);
  });

  test("classifies IP-mode device by tag range", () => {
    const msg = must(decodeBlob(IP_DEVICE_BLOB));
    expect(hasTagInRange(msg, RANGE.DEVICE_LO, RANGE.DEVICE_HI)).toBeTrue();
  });

  test("decodes DNS-mode device — device tags present", () => {
    const msg = decodeBlob(DNS_DEVICE_BLOB);
    expect(hasTagInRange(must(msg), RANGE.DEVICE_LO, RANGE.DEVICE_HI)).toBeTrue();
    expect(getU32(must(msg), TAG.DEVICE_DNS_MODE)).toBe(1);
  });

  test("decodes DNS-mode device — name as address", () => {
    const msg = must(decodeBlob(DNS_DEVICE_BLOB));
    expect(getStr(msg, TAG.NAME)).toBe("router.lan");
  });

  test("decodes bool_false (tcode 0x00, 0 bytes)", () => {
    const blob = Uint8Array.from([
      ...MAGIC, ...u32(1),
      ...u16(TAG.DEVICE_ENABLED), M_STD, 0x00, // bool_false
      ...u16(TAG.NAME), M_STD, TC_STR, ...str("x"),
    ]);
    const msg = must(decodeBlob(blob));
    const f = msg.fields.find((f) => f.tag === TAG.DEVICE_ENABLED);
    expect(f?.val).toEqual({ k: "bool", v: false });
  });

  test("decodes bool_true (tcode 0x01, 0 bytes) without consuming next byte", () => {
    const blob = Uint8Array.from([
      ...MAGIC, ...u32(1),
      ...u16(TAG.DEVICE_ENABLED), M_STD, 0x01, // bool_true — 0 bytes, NOT 1 byte
      ...u16(TAG.NAME), M_STD, TC_STR, ...str("booltest"),
    ]);
    const msg = must(decodeBlob(blob));
    const f = msg.fields.find((f) => f.tag === TAG.DEVICE_ENABLED);
    expect(f?.val).toEqual({ k: "bool", v: true });
    // Name field must also be present (proves no byte was consumed by bool_true)
    expect(getStr(msg, TAG.NAME)).toBe("booltest");
  });

  test("stops cleanly on unknown tcode", () => {
    const blob = Uint8Array.from([
      ...MAGIC, ...u32(1),
      ...u16(0x1234), M_STD, 0x99, // unknown tcode 0x99
    ]);
    const msg = decodeBlob(blob);
    expect(msg).not.toBeNull(); // returns partial result, not null
    expect(must(msg).fields).toHaveLength(0);
  });

  test("stops cleanly on invalid marker", () => {
    const blob = Uint8Array.from([
      ...MAGIC, ...u32(1),
      ...u16(0x1234), 0x20, TC_STR, // bad marker 0x20
    ]);
    const msg = must(decodeBlob(blob));
    expect(msg.fields).toHaveLength(0);
  });
});

describe("ipv4FromU32 / ipv4ToU32", () => {
  test("round-trips common addresses", () => {
    for (const ip of ["192.168.88.1", "10.0.0.1", "172.16.100.254", "1.2.3.4"]) {
      expect(ipv4FromU32(ipv4ToU32(ip))).toBe(ip);
    }
  });

  test("sentinel 0xFFFFFFFF returns empty string", () => {
    expect(ipv4FromU32(0xffffffff)).toBe("");
  });

  test("rejects invalid addresses", () => {
    expect(() => ipv4ToU32("not-an-ip")).toThrow();
    expect(() => ipv4ToU32("256.0.0.1")).toThrow();
    expect(() => ipv4ToU32("1.2.3")).toThrow();
  });
});

describe("isBuiltInProbeName", () => {
  test("recognizes all built-in names", () => {
    for (const name of ["ping", "ssh", "http", "routeros management", "cpu", "memory", "disk"]) {
      expect(isBuiltInProbeName(name)).toBeTrue();
    }
  });

  test("case-insensitive", () => {
    expect(isBuiltInProbeName("PING")).toBeTrue();
    expect(isBuiltInProbeName("RouterOS Management")).toBeTrue();
  });

  test("custom probe name returns false", () => {
    expect(isBuiltInProbeName("mimosa signal")).toBeFalse();
    expect(isBuiltInProbeName("custom-oid")).toBeFalse();
  });
});

describe("encode / decode round-trip", () => {
  test("encodeDevice round-trips IP address and name", () => {
    const blob = encodeDevice({ id: 99, name: "core-01", address: "10.10.10.1" });
    const msg = must(decodeBlob(blob));
    const ipArr = must(getU32Array(msg, TAG.DEVICE_IP));
    expect(ipv4FromU32(must(ipArr[0]))).toBe("10.10.10.1");
    expect(getStr(msg, TAG.NAME)).toBe("core-01");
  });

  test("encodeDevice round-trips credentials", () => {
    const blob = encodeDevice({ id: 1, name: "r", address: "1.2.3.4", username: "admin", password: "s3cr3t" });
    const msg = must(decodeBlob(blob));
    expect(getStr(msg, TAG.DEVICE_USERNAME)).toBe("admin");
    expect(getStr(msg, TAG.DEVICE_PASSWORD)).toBe("s3cr3t");
  });

  test("encodeDevice for DNS-mode (no IP) — address absent from 0x1F40", () => {
    const blob = encodeDevice({ id: 2, name: "gw.example.com", address: "gw.example.com" });
    const msg = must(decodeBlob(blob));
    const ipArr = getU32Array(msg, TAG.DEVICE_IP) ?? [];
    expect(ipArr).toHaveLength(0);
    expect(getU32(msg, TAG.DEVICE_DNS_MODE)).toBe(1);
    expect(getStr(msg, TAG.NAME)).toBe("gw.example.com");
  });

  test("encodeService round-trips name and unit", () => {
    const blob = encodeService({ id: 500, name: "ping @ myrouter", unit: "s" });
    const msg = must(decodeBlob(blob));
    expect(getStr(msg, TAG.NAME)).toBe("ping @ myrouter");
    expect(getStr(msg, TAG.SVC_UNIT)).toBe("s");
  });

  test("encodeProbeConfig links device/service/type", () => {
    const blob = encodeProbeConfig({ id: 200, deviceId: 100, serviceId: 201, probeTypeId: 10160 });
    const msg = must(decodeBlob(blob));
    expect(getU32(msg, TAG.PROBE_DEVICE_ID)).toBe(100);
    expect(getU32(msg, TAG.PROBE_SERVICE_ID)).toBe(201);
    expect(getU32(msg, TAG.PROBE_TYPE_ID)).toBe(10160);
  });

  test("encoded blob starts with Nova magic", () => {
    const blob = encodeDevice({ id: 1, name: "x", address: "1.1.1.1" });
    for (let i = 0; i < NOVA_MAGIC.length; i++) {
      expect(blob[i]).toBe(NOVA_MAGIC[i]);
    }
  });
});
