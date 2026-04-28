/**
 * Local-only evidence manifest for Dude UI mapping coverage.
 *
 * This is not a CI test. It is the canonical checklist for client-written
 * mapping evidence: each target names the Dude UI term, donny's current mapping,
 * the expected artifact pair, and (when available) the replay assertion that
 * proves the exported DB matches donny's decode.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ipv4ToU32, TAG } from "../../src/index.ts";
import type { ComparableNovaValue } from "../../src/index.ts";
import {
  assertClientConnectMapping,
  assertDeviceFieldMapping,
  assertProbeAddedMapping,
  assertRouterOsFlagMapping,
} from "./first-mapping.ts";

export type EvidenceKind =
  | "client-written"
  | "cli-written"
  | "synthetic"
  | "static"
  | "planned";

type AssertionKind = "client-connect" | "routeros-flag" | "probe-added" | "device-field";

export interface EvidenceAssertion {
  kind: AssertionKind;
  before: string;
  after: string;
  deviceName?: string;
  seedDeviceName?: string;
  expectedRouterOs?: boolean;
  expectedProbeTypeId?: number;
  tag?: number;
  expectedAfter?: ComparableNovaValue;
  decodedField?: "name" | "address" | "username" | "password" | "enabled" | "routerOS" | "snmpEnabled" | "snmpProfileId" | "probeInterval" | "pollInterval" | "customField1" | "customField2" | "customField3";
  expectedDecodedAfter?: string | number | boolean;
}

export interface EvidenceTarget {
  id: string;
  area: string;
  dudeTerm: string;
  donnySurface: string;
  nova: string;
  kind: EvidenceKind;
  docs: string;
  assertion?: EvidenceAssertion;
  instructions?: string;
  notes: string;
}

interface TargetResult {
  target: EvidenceTarget;
  status: "grounded" | "missing-artifact" | "planned" | "failed";
  detail: string;
}

const DEVICE_SETTINGS_DOC = "The Dude v6 Device settings";
const PROBES_DOC = "The Dude v6 Probes";

const FIELD_VALUES = {
  nameBefore: "donny-ui-name-before",
  nameAfter: "donny-ui-name-after",
  routerOsDevice: "donny-ui-routeros-flag-target",
  probeDevice: "donny-ui-probe-target",
  addressDevice: "donny-ui-address-target",
  address: "10.77.0.11",
  dnsDevice: "donny-ui-dns-target",
  dnsName: "donny-ui-target.example.invalid",
  usernameDevice: "donny-ui-username-target",
  username: "donny-ui-user",
  passwordDevice: "donny-ui-password-target",
  password: "donny-ui-pass",
  enabledDevice: "donny-ui-enabled-target",
  pollDevice: "donny-ui-poll-target",
  probeInterval: 120,
  snmpDevice: "donny-ui-snmp-target",
  customField1Device: "donny-ui-custom-field-1-target",
  customField1: "donny-custom-field-1",
  customField2Device: "donny-ui-custom-field-2-target",
  customField2: "donny-custom-field-2",
  customField3Device: "donny-ui-custom-field-3-target",
  customField3: "donny-custom-field-3",
} as const;

export const EVIDENCE_TARGETS: EvidenceTarget[] = [
  {
    id: "server-last-client-connect",
    area: "Server metadata",
    dudeTerm: "client connects to server",
    donnySurface: "raw diff only",
    nova: `TAG.SYS_LAST_CLIENT_CONNECT (0x${TAG.SYS_LAST_CLIENT_CONNECT.toString(16)})`,
    kind: "client-written",
    docs: "Dude client behavior",
    assertion: {
      kind: "client-connect",
      before: "before.export",
      after: "after-cli-connect.export",
    },
    notes: "Grounds that a real dude.exe login writes the server metadata timestamp.",
  },
  {
    id: "device-routeros-flag",
    area: "Device / General",
    dudeTerm: "RouterOS",
    donnySurface: "Device.routerOS",
    nova: `TAG.DEVICE_ROUTER_OS (0x${TAG.DEVICE_ROUTER_OS.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "routeros-flag",
      before: "before-routeros-flag.export",
      after: "after-routeros-flag.export",
      seedDeviceName: FIELD_VALUES.routerOsDevice,
      deviceName: FIELD_VALUES.routerOsDevice,
      expectedRouterOs: true,
    },
    instructions: `Seeded device is ${FIELD_VALUES.routerOsDevice}; in Device Settings > General, check RouterOS.`,
    notes: "Requires adding --device-name when replaying if artifact naming does not encode the target name.",
  },
  {
    id: "device-add-with-ping-probe",
    area: "Device wizard / Services",
    dudeTerm: "Add device, then select services/probes",
    donnySurface: "Device + Service + ProbeConfig",
    nova: `probe range 0x2ee0..0x2ef4 (${[
      `PROBE_DEVICE_ID=0x${TAG.PROBE_DEVICE_ID.toString(16)}`,
      `PROBE_TYPE_ID=0x${TAG.PROBE_TYPE_ID.toString(16)}`,
      `PROBE_SERVICE_ID=0x${TAG.PROBE_SERVICE_ID.toString(16)}`,
    ].join(", ")})`,
    kind: "client-written",
    docs: `${DEVICE_SETTINGS_DOC}; ${PROBES_DOC}`,
    assertion: {
      kind: "probe-added",
      before: "before-add-probe.export",
      after: "after-add-probe.export",
      deviceName: FIELD_VALUES.probeDevice,
      expectedProbeTypeId: 10160,
    },
    instructions: `Use the Add Device wizard to create a new device named ${FIELD_VALUES.probeDevice}, then select the ping probe/service.`,
    notes: "Synthetic unit coverage exists; live evidence requires dude.exe to create the device and probe.",
  },
  {
    id: "device-name",
    area: "Device / General",
    dudeTerm: "Name",
    donnySurface: "Device.name",
    nova: `TAG.NAME (0x${TAG.NAME.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-name.export",
      after: "after-device-name.export",
      seedDeviceName: FIELD_VALUES.nameBefore,
      deviceName: FIELD_VALUES.nameAfter,
      tag: TAG.NAME,
      expectedAfter: { kind: "str", value: FIELD_VALUES.nameAfter },
      decodedField: "name",
      expectedDecodedAfter: FIELD_VALUES.nameAfter,
    },
    instructions: `Seeded device starts as ${FIELD_VALUES.nameBefore}; in Device Settings > General, change Name to ${FIELD_VALUES.nameAfter}.`,
    notes: "Generic NAME decode is known; this replay target grounds that the Device Settings label maps to TAG.NAME for devices.",
  },
  {
    id: "device-addresses",
    area: "Device / General",
    dudeTerm: "Addresses",
    donnySurface: "Device.address",
    nova: `TAG.DEVICE_IP (0x${TAG.DEVICE_IP.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-addresses.export",
      after: "after-device-addresses.export",
      seedDeviceName: FIELD_VALUES.addressDevice,
      deviceName: FIELD_VALUES.addressDevice,
      tag: TAG.DEVICE_IP,
      expectedAfter: { kind: "u32[]", value: [ipv4ToU32(FIELD_VALUES.address)] },
      decodedField: "address",
      expectedDecodedAfter: FIELD_VALUES.address,
    },
    instructions: `In Device Settings > General, set Addresses to exactly ${FIELD_VALUES.address}.`,
    notes: "RouterOS CLI/export and unit fixtures cover decode; this replay target grounds the client UI field.",
  },
  {
    id: "device-dns-names",
    area: "Device / General",
    dudeTerm: "DNS names",
    donnySurface: "Device.address for DNS-mode devices",
    nova: `TAG.DEVICE_DNS_NAMES (0x${TAG.DEVICE_DNS_NAMES.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-dns-names.export",
      after: "after-device-dns-names.export",
      seedDeviceName: FIELD_VALUES.dnsDevice,
      deviceName: FIELD_VALUES.dnsDevice,
      tag: TAG.DEVICE_DNS_NAMES,
      expectedAfter: { kind: "str[]", value: [FIELD_VALUES.dnsName] },
    },
    instructions: `In Device Settings > General, set DNS names to exactly ${FIELD_VALUES.dnsName}. If the UI also requires clearing Addresses, do that in the same save and inspect the diff before marking grounded.`,
    notes: "QuickCHR DNS-mode integration covers current decode; this target grounds the client UI DNS names field and will reveal whether address clearing is also required.",
  },
  {
    id: "device-username",
    area: "Device / General",
    dudeTerm: "Username",
    donnySurface: "Device.username",
    nova: `TAG.DEVICE_USERNAME (0x${TAG.DEVICE_USERNAME.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-username.export",
      after: "after-device-username.export",
      seedDeviceName: FIELD_VALUES.usernameDevice,
      deviceName: FIELD_VALUES.usernameDevice,
      tag: TAG.DEVICE_USERNAME,
      expectedAfter: { kind: "str", value: FIELD_VALUES.username },
      decodedField: "username",
      expectedDecodedAfter: FIELD_VALUES.username,
    },
    instructions: `In Device Settings > General, set Username to the non-secret dummy value ${FIELD_VALUES.username}.`,
    notes: "Use only dummy values. Unit fixtures cover encode/decode, but this target grounds the UI label.",
  },
  {
    id: "device-password",
    area: "Device / General",
    dudeTerm: "Password",
    donnySurface: "Device.password",
    nova: `TAG.DEVICE_PASSWORD (0x${TAG.DEVICE_PASSWORD.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-password.export",
      after: "after-device-password.export",
      seedDeviceName: FIELD_VALUES.passwordDevice,
      deviceName: FIELD_VALUES.passwordDevice,
      tag: TAG.DEVICE_PASSWORD,
      expectedAfter: { kind: "str", value: FIELD_VALUES.password },
      decodedField: "password",
      expectedDecodedAfter: FIELD_VALUES.password,
    },
    instructions: `In Device Settings > General, set Password to the non-secret dummy value ${FIELD_VALUES.password}.`,
    notes: "Use only dummy values. Artifacts may still contain plaintext credentials and must not be committed if they come from real infrastructure.",
  },
  {
    id: "device-enabled",
    area: "Device / Polling",
    dudeTerm: "Enabled",
    donnySurface: "Device.enabled / devices.enabled",
    nova: `TAG.DEVICE_ENABLED (0x${TAG.DEVICE_ENABLED.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-enabled.export",
      after: "after-device-enabled.export",
      seedDeviceName: FIELD_VALUES.enabledDevice,
      deviceName: FIELD_VALUES.enabledDevice,
      tag: TAG.DEVICE_ENABLED,
      expectedAfter: { kind: "bool", value: false },
      decodedField: "enabled",
      expectedDecodedAfter: false,
    },
    instructions: "In Device Settings > Polling, uncheck Enabled.",
    notes: "Aligned to the Dude UI Polling > Enabled label as Device.enabled and normalized devices.enabled.",
  },
  {
    id: "device-probe-interval",
    area: "Device / Polling",
    dudeTerm: "Probe interval",
    donnySurface: "Device.probeInterval / devices.probe_interval",
    nova: `TAG.DEVICE_POLL_INTERVAL (0x${TAG.DEVICE_POLL_INTERVAL.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-probe-interval.export",
      after: "after-device-probe-interval.export",
      seedDeviceName: FIELD_VALUES.pollDevice,
      deviceName: FIELD_VALUES.pollDevice,
      tag: TAG.DEVICE_POLL_INTERVAL,
      expectedAfter: { kind: "u8", value: FIELD_VALUES.probeInterval },
      decodedField: "probeInterval",
      expectedDecodedAfter: FIELD_VALUES.probeInterval,
    },
    instructions: `In Device Settings > Polling, set Probe interval to ${FIELD_VALUES.probeInterval} seconds.`,
    notes: "Normalized column is probe_interval to match the Dude UI label; poll_interval remains a deprecated compatibility alias.",
  },
  {
    id: "device-snmp-enabled",
    area: "Device / General",
    dudeTerm: "SNMP profile enabled",
    donnySurface: "Device.snmpEnabled",
    nova: `TAG.DEVICE_SNMP_ENABLED (0x${TAG.DEVICE_SNMP_ENABLED.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-snmp-enabled.export",
      after: "after-device-snmp-enabled.export",
      seedDeviceName: FIELD_VALUES.snmpDevice,
      deviceName: FIELD_VALUES.snmpDevice,
      tag: TAG.DEVICE_SNMP_ENABLED,
      expectedAfter: { kind: "bool", value: true },
      decodedField: "snmpEnabled",
      expectedDecodedAfter: true,
    },
    instructions: "In Device Settings > General, enable SNMP for the default SNMP profile without changing the profile selection.",
    notes: "Decode exists; this target grounds the checkbox semantics separately from profile object ID selection.",
  },
  {
    id: "device-custom-field-1",
    area: "Device / General",
    dudeTerm: "Custom Fields / CustomField1",
    donnySurface: "Device.customField1 / devices.custom_field1",
    nova: `TAG.DEVICE_CUSTOM_FIELD1 (0x${TAG.DEVICE_CUSTOM_FIELD1.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-custom-field-1.export",
      after: "after-device-custom-field-1.export",
      seedDeviceName: FIELD_VALUES.customField1Device,
      deviceName: FIELD_VALUES.customField1Device,
      tag: TAG.DEVICE_CUSTOM_FIELD1,
      expectedAfter: { kind: "str", value: FIELD_VALUES.customField1 },
      decodedField: "customField1",
      expectedDecodedAfter: FIELD_VALUES.customField1,
    },
    instructions: `In Device Settings > General > Custom Fields, set CustomField1 to ${FIELD_VALUES.customField1}.`,
    notes: "Previously surfaced internally as DEVICE_NOTES; now aligned to the Dude UI CustomField1 label while keeping the old tag as a deprecated alias.",
  },
  {
    id: "device-custom-field-2",
    area: "Device / General",
    dudeTerm: "Custom Fields / CustomField2",
    donnySurface: "Device.customField2 / devices.custom_field2",
    nova: `TAG.DEVICE_CUSTOM_FIELD2 (0x${TAG.DEVICE_CUSTOM_FIELD2.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-custom-field-2.export",
      after: "after-device-custom-field-2.export",
      seedDeviceName: FIELD_VALUES.customField2Device,
      deviceName: FIELD_VALUES.customField2Device,
      tag: TAG.DEVICE_CUSTOM_FIELD2,
      expectedAfter: { kind: "str", value: FIELD_VALUES.customField2 },
      decodedField: "customField2",
      expectedDecodedAfter: FIELD_VALUES.customField2,
    },
    instructions: `In Device Settings > General > Custom Fields, set CustomField2 to ${FIELD_VALUES.customField2}.`,
    notes: "Previously surfaced internally as DEVICE_LABEL; now aligned to the Dude UI CustomField2 label while keeping the old tag as a deprecated alias.",
  },
  {
    id: "device-custom-field-3",
    area: "Device / General",
    dudeTerm: "Custom Fields / CustomField3",
    donnySurface: "Device.customField3 / devices.custom_field3",
    nova: `TAG.DEVICE_CUSTOM_FIELD3 (0x${TAG.DEVICE_CUSTOM_FIELD3.toString(16)})`,
    kind: "client-written",
    docs: DEVICE_SETTINGS_DOC,
    assertion: {
      kind: "device-field",
      before: "before-device-custom-field-3.export",
      after: "after-device-custom-field-3.export",
      seedDeviceName: FIELD_VALUES.customField3Device,
      deviceName: FIELD_VALUES.customField3Device,
      tag: TAG.DEVICE_CUSTOM_FIELD3,
      expectedAfter: { kind: "str", value: FIELD_VALUES.customField3 },
      decodedField: "customField3",
      expectedDecodedAfter: FIELD_VALUES.customField3,
    },
    instructions: `In Device Settings > General > Custom Fields, set CustomField3 to ${FIELD_VALUES.customField3}.`,
    notes: "Previously only DEVICE_CUSTOM_FIELD existed; now aligned to the Dude UI CustomField3 label while keeping the old tag as a deprecated alias.",
  },
  {
    id: "device-agent",
    area: "Device / General",
    dudeTerm: "Agent",
    donnySurface: "not currently exposed on Device",
    nova: `TAG.DEVICE_AGENT_ID (0x${TAG.DEVICE_AGENT_ID.toString(16)})`,
    kind: "planned",
    docs: DEVICE_SETTINGS_DOC,
    notes: "Known GUI-only area; /dude/agent/add is limited/not implemented in RouterOS CLI.",
  },
  {
    id: "map-node-placement",
    area: "Map",
    dudeTerm: "device shown on map",
    donnySurface: "map nodes / topology",
    nova: `NODE_MAP_ID=0x${TAG.NODE_MAP_ID.toString(16)}, NODE_X=0x${TAG.NODE_X.toString(16)}, NODE_Y=0x${TAG.NODE_Y.toString(16)}`,
    kind: "planned",
    docs: "The Dude v6 Device map",
    notes: "Requires reliable map interactions or protocol automation; not grounded yet.",
  },
];

function artifactPath(artifactDir: string, name: string): string {
  return join(artifactDir, name);
}

function missingArtifact(assertion: EvidenceAssertion, artifactDir: string): string | undefined {
  const beforePath = artifactPath(artifactDir, assertion.before);
  const afterPath = artifactPath(artifactDir, assertion.after);
  if (!existsSync(beforePath)) return beforePath;
  if (!existsSync(afterPath)) return afterPath;
  return undefined;
}

function runAssertion(target: EvidenceTarget, artifactDir: string): string {
  const assertion = target.assertion;
  if (!assertion) return "no replay assertion for this target";

  const beforePath = artifactPath(artifactDir, assertion.before);
  const afterPath = artifactPath(artifactDir, assertion.after);
  switch (assertion.kind) {
    case "client-connect": {
      const result = assertClientConnectMapping({ beforePath, afterPath });
      return `object ${result.objectId} ${result.fieldKey}: ${result.beforeValue} -> ${result.afterValue}`;
    }
    case "routeros-flag": {
      if (!assertion.deviceName) {
        throw new Error("missing --routeros-device-name; cannot replay routeros-flag evidence without the target device name");
      }
      const result = assertRouterOsFlagMapping({
        beforePath,
        afterPath,
        deviceName: assertion.deviceName,
        expectedAfter: assertion.expectedRouterOs,
      });
      return `device ${result.objectId} ${result.fieldKey}: ${result.beforeValue} -> ${result.afterValue}`;
    }
    case "probe-added": {
      const result = assertProbeAddedMapping({
        beforePath,
        afterPath,
        deviceName: assertion.deviceName,
        expectedProbeTypeId: assertion.expectedProbeTypeId,
      });
      return `device ${result.deviceId}, probe-config ${result.probeId}, service ${result.serviceId}, probeType ${result.probeTypeId}`;
    }
    case "device-field": {
      if (!assertion.deviceName || assertion.tag === undefined || !assertion.expectedAfter) {
        throw new Error("device-field assertion requires deviceName, tag, and expectedAfter");
      }
      const result = assertDeviceFieldMapping({
        beforePath,
        afterPath,
        deviceName: assertion.deviceName,
        tag: assertion.tag,
        expectedAfter: assertion.expectedAfter,
        decodedField: assertion.decodedField,
        expectedDecodedAfter: assertion.expectedDecodedAfter,
      });
      return `device ${result.objectId} ${result.fieldKey}: ${JSON.stringify(result.beforeValue)} -> ${JSON.stringify(result.afterValue)}${result.decodedField ? `; decoded ${result.decodedField}=${JSON.stringify(result.decodedAfter)}` : ""}`;
    }
  }
}

export function evaluateEvidenceTargets(options: {
  artifactDir: string;
  targetId?: string;
  routerOsDeviceName?: string;
  probeDeviceName?: string;
}): TargetResult[] {
  return EVIDENCE_TARGETS
    .filter((target) => !options.targetId || target.id === options.targetId)
    .map((target): TargetResult => {
      const assertion = target.assertion
        ? {
          ...target.assertion,
          deviceName: target.assertion.kind === "routeros-flag"
            ? options.routerOsDeviceName ?? target.assertion.deviceName
            : target.assertion.kind === "probe-added"
              ? options.probeDeviceName ?? target.assertion.deviceName
              : target.assertion.deviceName,
        }
        : undefined;
      const patchedTarget = assertion ? { ...target, assertion } : target;

      if (!assertion) {
        return {
          target,
          status: "planned",
          detail: `${target.kind}: ${target.notes}`,
        };
      }

      const missing = missingArtifact(assertion, options.artifactDir);
      if (missing) {
        return {
          target: patchedTarget,
          status: "missing-artifact",
          detail: missing,
        };
      }

      try {
        return {
          target: patchedTarget,
          status: "grounded",
          detail: runAssertion(patchedTarget, options.artifactDir),
        };
      } catch (error) {
        return {
          target: patchedTarget,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    });
}

function helpText(): string {
  return `
Usage:
  bun run labs/dude-ui/evidence.ts [--artifact-dir <dir>] [--target <id>]
                                  [--routeros-device-name <name>] [--probe-device-name <name>]
                                  [--require-live] [--json]

Default mode reports all known Dude UI mapping targets and exits non-zero only when an
available replay artifact fails its assertion.

--require-live exits non-zero for missing replay artifacts too. Use it after a local
Wine UI evidence run when you expect all replay-target artifacts to exist.
`;
}

function printTable(results: TargetResult[]): void {
  const rows = results.map((result) => ({
    status: result.status,
    id: result.target.id,
    area: result.target.area,
    dudeTerm: result.target.dudeTerm,
    donnySurface: result.target.donnySurface,
    evidence: result.target.kind,
    detail: result.detail,
  }));

  const columns = ["status", "id", "area", "dudeTerm", "donnySurface", "evidence", "detail"] as const;
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => String(row[column]).length)));
  const widthAt = (index: number) => widths[index] ?? 0;
  console.log(columns.map((column, i) => column.padEnd(widthAt(i))).join("  "));
  console.log(columns.map((_, i) => "-".repeat(widthAt(i))).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, i) => String(row[column]).padEnd(widthAt(i))).join("  "));
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let artifactDir = "labs/dude-ui/artifacts";
  let targetId: string | undefined;
  let routerOsDeviceName: string | undefined;
  let probeDeviceName: string | undefined;
  let json = false;
  let requireLive = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--artifact-dir":
        artifactDir = args[++i] ?? artifactDir;
        break;
      case "--target":
        targetId = args[++i];
        break;
      case "--routeros-device-name":
        routerOsDeviceName = args[++i];
        break;
      case "--probe-device-name":
        probeDeviceName = args[++i];
        break;
      case "--require-live":
        requireLive = true;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        console.log(helpText());
        process.exit(0);
      default:
        console.error(`unknown argument: ${arg}`);
        console.error(helpText());
        process.exit(2);
    }
  }

  const results = evaluateEvidenceTargets({
    artifactDir,
    targetId,
    routerOsDeviceName,
    probeDeviceName,
  });

  if (targetId && results.length === 0) {
    console.error(`unknown target: ${targetId}`);
    process.exit(2);
  }

  if (json) console.log(JSON.stringify(results, null, 2));
  else printTable(results);

  const hasFailed = results.some((result) => result.status === "failed");
  const hasMissing = results.some((result) => result.status === "missing-artifact");
  if (hasFailed || (requireLive && hasMissing)) process.exit(1);
}
