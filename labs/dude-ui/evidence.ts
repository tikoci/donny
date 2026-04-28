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
import { TAG } from "../../src/index.ts";
import {
  assertClientConnectMapping,
  assertProbeAddedMapping,
  assertRouterOsFlagMapping,
} from "./first-mapping.ts";

type EvidenceKind =
  | "client-written"
  | "cli-written"
  | "synthetic"
  | "static"
  | "planned";

type AssertionKind = "client-connect" | "routeros-flag" | "probe-added";

interface EvidenceAssertion {
  kind: AssertionKind;
  before: string;
  after: string;
  deviceName?: string;
  expectedRouterOs?: boolean;
  expectedProbeTypeId?: number;
}

interface EvidenceTarget {
  id: string;
  area: string;
  dudeTerm: string;
  donnySurface: string;
  nova: string;
  kind: EvidenceKind;
  docs: string;
  assertion?: EvidenceAssertion;
  notes: string;
}

interface TargetResult {
  target: EvidenceTarget;
  status: "grounded" | "missing-artifact" | "planned" | "failed";
  detail: string;
}

const DEVICE_SETTINGS_DOC = "The Dude v6 Device settings";
const PROBES_DOC = "The Dude v6 Probes";

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
      expectedRouterOs: true,
    },
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
      expectedProbeTypeId: 10160,
    },
    notes: "Synthetic unit coverage exists; live evidence requires dude.exe to create the device and probe.",
  },
  {
    id: "device-name",
    area: "Device / General",
    dudeTerm: "Name",
    donnySurface: "Device.name",
    nova: `TAG.NAME (0x${TAG.NAME.toString(16)})`,
    kind: "cli-written",
    docs: DEVICE_SETTINGS_DOC,
    notes: "Known generic NAME decode, but not yet grounded as a client-edited Device Settings field.",
  },
  {
    id: "device-addresses",
    area: "Device / General",
    dudeTerm: "Addresses",
    donnySurface: "Device.address",
    nova: `TAG.DEVICE_IP (0x${TAG.DEVICE_IP.toString(16)})`,
    kind: "cli-written",
    docs: DEVICE_SETTINGS_DOC,
    notes: "RouterOS CLI/export and unit fixtures cover decode; client UI editing evidence still needed.",
  },
  {
    id: "device-dns-names",
    area: "Device / General",
    dudeTerm: "DNS names",
    donnySurface: "Device.address for DNS-mode devices",
    nova: `TAG.DEVICE_DNS_NAMES (0x${TAG.DEVICE_DNS_NAMES.toString(16)})`,
    kind: "cli-written",
    docs: DEVICE_SETTINGS_DOC,
    notes: "QuickCHR DNS-mode integration covers current decode; client UI editing evidence still needed.",
  },
  {
    id: "device-credentials",
    area: "Device / General",
    dudeTerm: "Username and Password",
    donnySurface: "Device.username / Device.password",
    nova: `TAG.DEVICE_USERNAME (0x${TAG.DEVICE_USERNAME.toString(16)}), TAG.DEVICE_PASSWORD (0x${TAG.DEVICE_PASSWORD.toString(16)})`,
    kind: "synthetic",
    docs: DEVICE_SETTINGS_DOC,
    notes: "Encoded/decoded in unit fixtures; live evidence must use non-secret dummy values only.",
  },
  {
    id: "device-enabled",
    area: "Device / Polling",
    dudeTerm: "Enabled",
    donnySurface: "not currently exposed on Device",
    nova: `TAG.DEVICE_ENABLED (0x${TAG.DEVICE_ENABLED.toString(16)})`,
    kind: "planned",
    docs: DEVICE_SETTINGS_DOC,
    notes: "Important gap: tag exists in encoder but domain type does not expose it yet.",
  },
  {
    id: "device-probe-interval",
    area: "Device / Polling",
    dudeTerm: "Probe interval",
    donnySurface: "Device.pollInterval",
    nova: `TAG.DEVICE_POLL_INTERVAL (0x${TAG.DEVICE_POLL_INTERVAL.toString(16)})`,
    kind: "synthetic",
    docs: DEVICE_SETTINGS_DOC,
    notes: "Decode exists, but UI term/value units need client-written evidence.",
  },
  {
    id: "device-snmp-profile",
    area: "Device / General",
    dudeTerm: "SNMP profile",
    donnySurface: "Device.snmpEnabled / Device.snmpProfileId",
    nova: `TAG.DEVICE_SNMP_ENABLED (0x${TAG.DEVICE_SNMP_ENABLED.toString(16)}), TAG.DEVICE_SNMP_PROFILE (0x${TAG.DEVICE_SNMP_PROFILE.toString(16)})`,
    kind: "synthetic",
    docs: DEVICE_SETTINGS_DOC,
    notes: "Decode exists; client evidence still needed for checkbox/profile semantics.",
  },
  {
    id: "device-custom-fields",
    area: "Device / General",
    dudeTerm: "Custom Fields",
    donnySurface: "not currently exposed on Device",
    nova: `TAG.DEVICE_CUSTOM_FIELD (0x${TAG.DEVICE_CUSTOM_FIELD.toString(16)})`,
    kind: "static",
    docs: DEVICE_SETTINGS_DOC,
    notes: "dude.exe strings include CustomField1..3, but the DB shape and donny domain model are not grounded.",
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
