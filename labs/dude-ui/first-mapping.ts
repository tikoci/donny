/**
 * Replay/assertion helper for the first Dude-client-written field mapping.
 *
 * The visible Wine UI still needs a human or driver to toggle the field. This
 * helper makes the evidence check deterministic once `after.export` exists.
 */

import { diffDudeDbFiles, DudeDB, RANGE, TAG } from "../../src/index.ts";
import type { AddedOrRemovedObject, ChangedObject, ComparableNovaField, ComparableNovaValue, DudeDbDiff, ProbeConfig, Service } from "../../src/index.ts";

export const FIRST_ROUTEROS_FLAG_DEVICE_PREFIX = "donny-ui-routeros-flag";
export const PROBE_TARGET_DEVICE_PREFIX = "donny-ui-probe-target";

export interface RouterOsFlagMappingAssertion {
  beforePath: string;
  afterPath: string;
  deviceName: string;
  expectedAfter?: boolean;
}

export interface RouterOsFlagMappingResult {
  objectId: number;
  deviceName: string;
  beforeValue: boolean | undefined;
  afterValue: boolean;
  fieldKey: string;
  diff: DudeDbDiff;
}

export interface ClientConnectMappingAssertion {
  beforePath: string;
  afterPath: string;
}

export interface ClientConnectMappingResult {
  objectId: number;
  beforeValue: number | undefined;
  afterValue: number;
  fieldKey: string;
  diff: DudeDbDiff;
}

export interface ProbeAddedMappingAssertion {
  beforePath: string;
  afterPath: string;
  /** Optional: scope assertion to a device with this exact NAME. */
  deviceName?: string;
  /** Optional: require the new probe to reference this probe template id (e.g. PROBE_ID_PING = 10160). */
  expectedProbeTypeId?: number;
}

export interface ProbeAddedMappingResult {
  deviceId: number;
  deviceName: string;
  probeId: number;
  serviceId: number;
  probeTypeId: number;
  probeConfig: ProbeConfig;
  service: Service | undefined;
  diff: DudeDbDiff;
}

function boolValue(value: ComparableNovaValue | undefined): boolean | undefined {
  if (!value) return undefined;
  if (value.kind !== "bool") {
    throw new Error(`expected ${TAG.DEVICE_ROUTER_OS.toString(16)} to be bool, got ${value.kind}`);
  }
  return value.value;
}

function numericValue(value: ComparableNovaValue | undefined): number | undefined {
  if (!value) return undefined;
  if (value.kind !== "u8" && value.kind !== "u32") {
    throw new Error(`expected numeric value, got ${value.kind}`);
  }
  return value.value;
}

function fieldValue(fields: ComparableNovaField[], tag: number): ComparableNovaValue | undefined {
  return fields.find((field) => field.tag === tag)?.value;
}

function summarizeObject(object: ChangedObject): string {
  const fields = [
    ...object.removedFields.map((field) => `-${field.key}`),
    ...object.addedFields.map((field) => `+${field.key}`),
    ...object.changedFields.map((field) => `~${field.key}`),
  ];
  return `object ${object.id} ${object.nameBefore ?? ""}${object.nameAfter && object.nameAfter !== object.nameBefore ? ` -> ${object.nameAfter}` : ""}: ${fields.join(", ")}`;
}

interface TargetChange {
  object: ChangedObject;
  beforeValue: boolean | undefined;
  afterValue: boolean;
  fieldKey: string;
}

function findTargetChange(diff: DudeDbDiff, expectedAfter: boolean): TargetChange {
  for (const object of diff.changedObjects) {
    for (const field of object.changedFields) {
      if (field.tag !== TAG.DEVICE_ROUTER_OS) continue;
      const beforeValue = boolValue(field.before);
      const afterValue = boolValue(field.after);
      if (afterValue === expectedAfter) {
        return { object, beforeValue, afterValue, fieldKey: field.key };
      }
    }

    const added = object.addedFields.find((field) => field.tag === TAG.DEVICE_ROUTER_OS);
    if (added) {
      const afterValue = boolValue(added.value);
      if (afterValue === expectedAfter) {
        return { object, beforeValue: undefined, afterValue, fieldKey: added.key };
      }
    }
  }

  throw new Error(
    `no ${tagName(TAG.DEVICE_ROUTER_OS)} change to ${expectedAfter} found; changed objects:\n`
    + diff.changedObjects.map(summarizeObject).join("\n"),
  );
}

function tagName(tag: number): string {
  const entry = Object.entries(TAG).find(([, value]) => value === tag);
  return entry ? `TAG.${entry[0]} (0x${tag.toString(16)})` : `0x${tag.toString(16)}`;
}

function readDeviceRouterOs(path: string, deviceName: string): boolean | undefined {
  const db = DudeDB.openAuto(path, { readonly: true });
  try {
    return db.devices().find((device) => device.name === deviceName)?.routerOS;
  } finally {
    db.close();
  }
}

export function assertRouterOsFlagMapping(options: RouterOsFlagMappingAssertion): RouterOsFlagMappingResult {
  const expectedAfter = options.expectedAfter ?? true;
  const beforeDecoded = readDeviceRouterOs(options.beforePath, options.deviceName);
  if (beforeDecoded === undefined) {
    throw new Error(`device ${JSON.stringify(options.deviceName)} was not present in before export`);
  }

  const diff = diffDudeDbFiles(options.beforePath, options.afterPath, { objectName: options.deviceName });
  const target = findTargetChange(diff, expectedAfter);
  const afterDecoded = readDeviceRouterOs(options.afterPath, options.deviceName);
  if (afterDecoded !== expectedAfter) {
    throw new Error(
      `DudeDB.devices() decoded routerOS=${afterDecoded} for ${JSON.stringify(options.deviceName)}, expected ${expectedAfter}`,
    );
  }

  const beforeField = beforeDecoded ?? fieldValue(target.object.removedFields, TAG.DEVICE_ROUTER_OS);
  return {
    objectId: target.object.id,
    deviceName: options.deviceName,
    beforeValue: typeof beforeField === "boolean" ? beforeField : target.beforeValue,
    afterValue: target.afterValue,
    fieldKey: target.fieldKey,
    diff,
  };
}

export function assertClientConnectMapping(options: ClientConnectMappingAssertion): ClientConnectMappingResult {
  const diff = diffDudeDbFiles(options.beforePath, options.afterPath);
  for (const object of diff.changedObjects) {
    for (const field of object.changedFields) {
      if (field.tag !== TAG.SYS_LAST_CLIENT_CONNECT) continue;
      const beforeValue = numericValue(field.before);
      const afterValue = numericValue(field.after);
      if (afterValue !== undefined && afterValue > 0 && afterValue !== beforeValue) {
        return {
          objectId: object.id,
          beforeValue,
          afterValue,
          fieldKey: field.key,
          diff,
        };
      }
    }

    const added = object.addedFields.find((field) => field.tag === TAG.SYS_LAST_CLIENT_CONNECT);
    if (added) {
      const afterValue = numericValue(added.value);
      if (afterValue !== undefined && afterValue > 0) {
        return {
          objectId: object.id,
          beforeValue: undefined,
          afterValue,
          fieldKey: added.key,
          diff,
        };
      }
    }
  }

  throw new Error(
    `no ${tagName(TAG.SYS_LAST_CLIENT_CONNECT)} client-connect timestamp change found; changed objects:\n`
    + diff.changedObjects.map(summarizeObject).join("\n"),
  );
}

function objectHasTagInRange(object: AddedOrRemovedObject, lo: number, hi: number): boolean {
  return object.fields.some((field) => field.tag >= lo && field.tag <= hi);
}

function fieldNumberFromAdded(object: AddedOrRemovedObject, tag: number): number | undefined {
  const field = object.fields.find((f) => f.tag === tag);
  if (!field) return undefined;
  if (field.value.kind !== "u8" && field.value.kind !== "u32") return undefined;
  return field.value.value;
}

function objectName(object: AddedOrRemovedObject): string {
  return object.name ?? "";
}

export function assertProbeAddedMapping(options: ProbeAddedMappingAssertion): ProbeAddedMappingResult {
  const diff = diffDudeDbFiles(options.beforePath, options.afterPath, {
    objectName: options.deviceName,
  });

  // When deviceName is set we restrict the diff via objectName above. For the
  // probe and service objects (no NAME == deviceName) we re-run an unfiltered
  // diff to find them; an unfiltered second pass is cheap relative to the
  // overall manual workflow.
  const fullDiff = options.deviceName
    ? diffDudeDbFiles(options.beforePath, options.afterPath)
    : diff;

  // Find the added device. If deviceName is provided, restrict to that.
  const candidateDevices = diff.addedObjects.filter((object) => {
    if (!objectHasTagInRange(object, RANGE.DEVICE_LO, RANGE.DEVICE_HI)) return false;
    if (options.deviceName && objectName(object) !== options.deviceName) return false;
    return true;
  });

  if (candidateDevices.length === 0) {
    const summary = diff.addedObjects.map((object) => `${object.id}:${objectName(object)}`).join(", ") || "<none>";
    throw new Error(`no added device${options.deviceName ? ` named ${JSON.stringify(options.deviceName)}` : ""} found in diff. added objects: ${summary}`);
  }

  // Pick the candidate device that has at least one matching new probe-config.
  for (const deviceObj of candidateDevices) {
    const deviceId = deviceObj.id;
    const probeObj = fullDiff.addedObjects.find((object) => {
      if (!objectHasTagInRange(object, RANGE.PROBE_CONFIG_LO, RANGE.PROBE_CONFIG_HI)) return false;
      if (fieldNumberFromAdded(object, TAG.PROBE_DEVICE_ID) !== deviceId) return false;
      if (options.expectedProbeTypeId !== undefined
        && fieldNumberFromAdded(object, TAG.PROBE_TYPE_ID) !== options.expectedProbeTypeId) return false;
      return true;
    });

    if (!probeObj) continue;

    const serviceId = fieldNumberFromAdded(probeObj, TAG.PROBE_SERVICE_ID);
    const probeTypeId = fieldNumberFromAdded(probeObj, TAG.PROBE_TYPE_ID);
    if (serviceId === undefined || probeTypeId === undefined) {
      throw new Error(`new probe-config object ${probeObj.id} for device ${deviceId} is missing PROBE_SERVICE_ID or PROBE_TYPE_ID`);
    }

    // Confirm donny's domain decode agrees with the diff.
    const after = DudeDB.openAuto(options.afterPath, { readonly: true });
    try {
      const decodedDevice = after.devices().find((device) => device.id === deviceId);
      if (!decodedDevice) {
        throw new Error(`device ${deviceId} not decodable via DudeDB.devices() in after export`);
      }
      const probeConfig = after.probeConfigs().find((p) => p.id === probeObj.id);
      if (!probeConfig) {
        throw new Error(`probe-config ${probeObj.id} not decodable via DudeDB.probeConfigs() in after export`);
      }
      if (probeConfig.deviceId !== deviceId) {
        throw new Error(`probe-config ${probeObj.id} decoded deviceId=${probeConfig.deviceId}, expected ${deviceId}`);
      }
      if (probeConfig.probeTypeId !== probeTypeId) {
        throw new Error(`probe-config ${probeObj.id} decoded probeTypeId=${probeConfig.probeTypeId}, expected ${probeTypeId}`);
      }
      const service = after.services().find((s) => s.id === serviceId);

      return {
        deviceId,
        deviceName: decodedDevice.name,
        probeId: probeObj.id,
        serviceId,
        probeTypeId,
        probeConfig,
        service,
        diff: fullDiff,
      };
    } finally {
      after.close();
    }
  }

  const probeSummaries = fullDiff.addedObjects
    .filter((object) => objectHasTagInRange(object, RANGE.PROBE_CONFIG_LO, RANGE.PROBE_CONFIG_HI))
    .map((object) => `probe ${object.id} -> device ${fieldNumberFromAdded(object, TAG.PROBE_DEVICE_ID)} type ${fieldNumberFromAdded(object, TAG.PROBE_TYPE_ID)}`);
  throw new Error(
    `added device(s) [${candidateDevices.map((object) => `${object.id}:${objectName(object)}`).join(", ")}] but no matching new probe-config object${options.expectedProbeTypeId !== undefined ? ` for probeTypeId=${options.expectedProbeTypeId}` : ""}.\nadded probes: ${probeSummaries.join("; ") || "<none>"}`,
  );
}

function helpText(): string {
  return `
Usage:
  bun run labs/dude-ui/first-mapping.ts assert --before before.export --after after.export --name <device-name> [--expected-routeros true|false] [--json]
  bun run labs/dude-ui/first-mapping.ts assert-connect --before before.export --after after.export [--json]
  bun run labs/dude-ui/first-mapping.ts assert-probe --before before.export --after after.export [--name <device-name>] [--expected-probe-type <id>] [--json]
`;
}

function usage(): never {
  console.error(helpText());
  process.exit(1);
}

function parseBool(value: string | undefined): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  usage();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(helpText());
    process.exit(0);
  }
  if (args[0] !== "assert" && args[0] !== "assert-connect" && args[0] !== "assert-probe") usage();

  let beforePath = "";
  let afterPath = "";
  let deviceName = "";
  let expectedAfter = true;
  let expectedProbeTypeId: number | undefined;
  let json = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--before":
        beforePath = args[++i] ?? "";
        break;
      case "--after":
        afterPath = args[++i] ?? "";
        break;
      case "--name":
        deviceName = args[++i] ?? "";
        break;
      case "--expected-routeros":
        expectedAfter = parseBool(args[++i]);
        break;
      case "--expected-probe-type": {
        const value = args[++i];
        const id = Number.parseInt(value ?? "", 10);
        if (!Number.isFinite(id)) usage();
        expectedProbeTypeId = id;
        break;
      }
      case "--json":
        json = true;
        break;
      default:
        usage();
    }
  }

  if (!beforePath || !afterPath || (args[0] === "assert" && !deviceName)) usage();

  if (args[0] === "assert-connect") {
    const result = assertClientConnectMapping({ beforePath, afterPath });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`ok: ${tagName(TAG.SYS_LAST_CLIENT_CONNECT)} changed on object ${result.objectId}`);
      console.log(`last client connect: ${result.beforeValue} -> ${result.afterValue} via ${result.fieldKey}`);
    }
    process.exit(0);
  }

  if (args[0] === "assert-probe") {
    const result = assertProbeAddedMapping({
      beforePath,
      afterPath,
      deviceName: deviceName || undefined,
      expectedProbeTypeId,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`ok: client added device ${result.deviceId} (${JSON.stringify(result.deviceName)})`);
      console.log(`     probe-config ${result.probeId} type=${result.probeTypeId} -> service ${result.serviceId}${result.service ? ` (${JSON.stringify(result.service.name)})` : ""}`);
      console.log(`     enabled=${result.probeConfig.enabled} createdAt=${result.probeConfig.createdAt}`);
    }
    process.exit(0);
  }

  const result = assertRouterOsFlagMapping({ beforePath, afterPath, deviceName, expectedAfter });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ok: ${tagName(TAG.DEVICE_ROUTER_OS)} changed on object ${result.objectId} (${result.deviceName})`);
    console.log(`routerOS: ${result.beforeValue} -> ${result.afterValue} via ${result.fieldKey}`);
  }
}
