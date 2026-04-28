/**
 * Field-level diff helpers for Dude Nova objects.
 *
 * These helpers are intentionally data-oriented: UI/protocol labs can use them
 * to prove exactly which `objs` rows and Nova tags changed after a real Dude
 * client action.
 */

import { DudeDB } from "./db.ts";
import { getStr, TAG } from "./nova.ts";
import type { NovaField, NovaMessage, NovaValue } from "./nova.ts";

export type ComparableNovaValue =
  | { kind: "bool"; value: boolean }
  | { kind: "u8"; value: number }
  | { kind: "u32"; value: number }
  | { kind: "u64"; value: string }
  | { kind: "str"; value: string }
  | { kind: "bytes"; value: string }
  | { kind: "u32[]"; value: number[] }
  | { kind: "str[]"; value: string[] }
  | { kind: "compound"; value: ComparableNovaField[] };

export interface ComparableNovaField {
  tag: number;
  tagHex: string;
  index: number;
  key: string;
  value: ComparableNovaValue;
}

export interface ChangedNovaField {
  tag: number;
  tagHex: string;
  index: number;
  key: string;
  before: ComparableNovaValue;
  after: ComparableNovaValue;
}

export interface ChangedObject {
  id: number;
  nameBefore?: string;
  nameAfter?: string;
  addedFields: ComparableNovaField[];
  removedFields: ComparableNovaField[];
  changedFields: ChangedNovaField[];
}

export interface AddedOrRemovedObject {
  id: number;
  name?: string;
  fields: ComparableNovaField[];
}

export interface DudeDbDiffOptions {
  /** Limit the comparison to these object ids. */
  objectIds?: Iterable<number>;
  /** Limit the comparison to objects whose before/after NAME matches exactly. */
  objectName?: string;
}

export interface DudeDbDiff {
  addedObjects: AddedOrRemovedObject[];
  removedObjects: AddedOrRemovedObject[];
  changedObjects: ChangedObject[];
  unchangedObjectCount: number;
}

function tagHex(tag: number): string {
  return `0x${tag.toString(16).padStart(4, "0")}`;
}

function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function comparableValue(value: NovaValue): ComparableNovaValue {
  switch (value.k) {
    case "bool":
      return { kind: "bool", value: value.v };
    case "u8":
      return { kind: "u8", value: value.v };
    case "u32":
      return { kind: "u32", value: value.v };
    case "u64":
      return { kind: "u64", value: value.v.toString() };
    case "str":
      return { kind: "str", value: value.v };
    case "bytes":
      return { kind: "bytes", value: bytesHex(value.v) };
    case "u32[]":
      return { kind: "u32[]", value: [...value.v] };
    case "str[]":
      return { kind: "str[]", value: [...value.v] };
    case "compound":
      return { kind: "compound", value: comparableFields(value.v) };
  }
}

function comparableFields(fields: NovaField[]): ComparableNovaField[] {
  const counts = new Map<number, number>();
  return fields.map((field) => {
    const index = counts.get(field.tag) ?? 0;
    counts.set(field.tag, index + 1);
    const hex = tagHex(field.tag);
    return {
      tag: field.tag,
      tagHex: hex,
      index,
      key: `${hex}#${index}`,
      value: comparableValue(field.val),
    };
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function collect(db: DudeDB): Map<number, NovaMessage> {
  const out = new Map<number, NovaMessage>();
  for (const { id, msg } of db.rawObjects()) out.set(id, msg);
  return out;
}

function includeObject(id: number, before: NovaMessage | undefined, after: NovaMessage | undefined, idFilter: Set<number> | undefined, objectName: string | undefined): boolean {
  if (idFilter && !idFilter.has(id)) return false;
  if (objectName) {
    return getStr(before ?? after ?? { fields: [] }, TAG.NAME) === objectName
      || getStr(after ?? before ?? { fields: [] }, TAG.NAME) === objectName;
  }
  return true;
}

function objectSnapshot(id: number, msg: NovaMessage): AddedOrRemovedObject {
  return {
    id,
    name: getStr(msg, TAG.NAME),
    fields: comparableFields(msg.fields),
  };
}

function diffObject(id: number, before: NovaMessage, after: NovaMessage): ChangedObject | undefined {
  const beforeFields = comparableFields(before.fields);
  const afterFields = comparableFields(after.fields);
  const beforeMap = new Map(beforeFields.map((field) => [field.key, field]));
  const afterMap = new Map(afterFields.map((field) => [field.key, field]));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  const addedFields: ComparableNovaField[] = [];
  const removedFields: ComparableNovaField[] = [];
  const changedFields: ChangedNovaField[] = [];

  for (const key of [...keys].sort()) {
    const beforeField = beforeMap.get(key);
    const afterField = afterMap.get(key);
    if (!beforeField && afterField) {
      addedFields.push(afterField);
      continue;
    }
    if (beforeField && !afterField) {
      removedFields.push(beforeField);
      continue;
    }
    if (beforeField && afterField && stableJson(beforeField.value) !== stableJson(afterField.value)) {
      changedFields.push({
        tag: afterField.tag,
        tagHex: afterField.tagHex,
        index: afterField.index,
        key,
        before: beforeField.value,
        after: afterField.value,
      });
    }
  }

  if (addedFields.length === 0 && removedFields.length === 0 && changedFields.length === 0) {
    return undefined;
  }

  return {
    id,
    nameBefore: getStr(before, TAG.NAME),
    nameAfter: getStr(after, TAG.NAME),
    addedFields,
    removedFields,
    changedFields,
  };
}

/** Diff two open Dude databases at the `objs`/Nova-field level. */
export function diffDudeDbs(before: DudeDB, after: DudeDB, options: DudeDbDiffOptions = {}): DudeDbDiff {
  const beforeObjects = collect(before);
  const afterObjects = collect(after);
  const ids = [...new Set([...beforeObjects.keys(), ...afterObjects.keys()])].sort((a, b) => a - b);
  const idFilter = options.objectIds ? new Set(options.objectIds) : undefined;

  const addedObjects: AddedOrRemovedObject[] = [];
  const removedObjects: AddedOrRemovedObject[] = [];
  const changedObjects: ChangedObject[] = [];
  let unchangedObjectCount = 0;

  for (const id of ids) {
    const beforeMsg = beforeObjects.get(id);
    const afterMsg = afterObjects.get(id);
    if (!includeObject(id, beforeMsg, afterMsg, idFilter, options.objectName)) continue;

    if (!beforeMsg && afterMsg) {
      addedObjects.push(objectSnapshot(id, afterMsg));
      continue;
    }
    if (beforeMsg && !afterMsg) {
      removedObjects.push(objectSnapshot(id, beforeMsg));
      continue;
    }
    if (!beforeMsg || !afterMsg) continue;

    const changed = diffObject(id, beforeMsg, afterMsg);
    if (changed) changedObjects.push(changed);
    else unchangedObjectCount++;
  }

  return { addedObjects, removedObjects, changedObjects, unchangedObjectCount };
}

/** Open and diff two raw `dude.db` files or `/dude/export-db` archives. */
export function diffDudeDbFiles(beforePath: string, afterPath: string, options: DudeDbDiffOptions = {}): DudeDbDiff {
  const before = DudeDB.openAuto(beforePath, { readonly: true });
  const after = DudeDB.openAuto(afterPath, { readonly: true });
  try {
    return diffDudeDbs(before, after, options);
  } finally {
    before.close();
    after.close();
  }
}
