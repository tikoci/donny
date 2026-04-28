/**
 * Replay/assertion helper for the first Dude-client-written field mapping.
 *
 * The visible Wine UI still needs a human or driver to toggle the field. This
 * helper makes the evidence check deterministic once `after.export` exists.
 */

import { diffDudeDbFiles, DudeDB, TAG } from "../../src/index.ts";
import type { ChangedObject, ComparableNovaField, ComparableNovaValue, DudeDbDiff } from "../../src/index.ts";

export const FIRST_ROUTEROS_FLAG_DEVICE_PREFIX = "donny-ui-routeros-flag";

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

function helpText(): string {
  return `
Usage:
  bun run labs/dude-ui/first-mapping.ts assert --before before.export --after after.export --name <device-name> [--expected-routeros true|false] [--json]
  bun run labs/dude-ui/first-mapping.ts assert-connect --before before.export --after after.export [--json]
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
  if (args[0] !== "assert" && args[0] !== "assert-connect") usage();

  let beforePath = "";
  let afterPath = "";
  let deviceName = "";
  let expectedAfter = true;
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

  const result = assertRouterOsFlagMapping({ beforePath, afterPath, deviceName, expectedAfter });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ok: ${tagName(TAG.DEVICE_ROUTER_OS)} changed on object ${result.objectId} (${result.deviceName})`);
    console.log(`routerOS: ${result.beforeValue} -> ${result.afterValue} via ${result.fieldKey}`);
  }
}
