/**
 * Diff two raw Dude DBs or `/dude/export-db` archives at Nova-field level.
 *
 * Usage:
 *   bun run scripts/diff-db.ts before.db after.export
 *   bun run scripts/diff-db.ts before.db after.db --name router1
 *   bun run scripts/diff-db.ts before.db after.db --id 12345 --json
 */

import { diffDudeDbFiles } from "../src/lib/diff.ts";

function usage(): never {
  console.error("Usage: bun run scripts/diff-db.ts <before.db|export> <after.db|export> [--name <object-name>] [--id <object-id>] [--json]");
  process.exit(1);
}

const args = process.argv.slice(2);
const beforePath = args[0];
const afterPath = args[1];
if (!beforePath || !afterPath) usage();

let objectName: string | undefined;
const objectIds: number[] = [];
let json = false;

for (let i = 2; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case "--name": {
      const value = args[++i];
      if (!value) usage();
      objectName = value;
      break;
    }
    case "--id": {
      const value = args[++i];
      if (!value) usage();
      const id = Number.parseInt(value, 10);
      if (!Number.isFinite(id)) usage();
      objectIds.push(id);
      break;
    }
    case "--json":
      json = true;
      break;
    default:
      usage();
  }
}

const diff = diffDudeDbFiles(beforePath, afterPath, {
  objectName,
  objectIds: objectIds.length ? objectIds : undefined,
});

if (json) {
  console.log(JSON.stringify(diff, null, 2));
  process.exit(0);
}

console.log(`added objects:   ${diff.addedObjects.length}`);
console.log(`removed objects: ${diff.removedObjects.length}`);
console.log(`changed objects: ${diff.changedObjects.length}`);
console.log(`unchanged seen:  ${diff.unchangedObjectCount}`);

for (const object of diff.addedObjects) {
  console.log(`\n+ object ${object.id}${object.name ? ` (${object.name})` : ""}`);
  for (const field of object.fields) console.log(`  + ${field.key} ${field.value.kind} ${JSON.stringify(field.value.value)}`);
}

for (const object of diff.removedObjects) {
  console.log(`\n- object ${object.id}${object.name ? ` (${object.name})` : ""}`);
  for (const field of object.fields) console.log(`  - ${field.key} ${field.value.kind} ${JSON.stringify(field.value.value)}`);
}

for (const object of diff.changedObjects) {
  const beforeName = object.nameBefore ? ` (${object.nameBefore}` : "";
  const afterName = object.nameAfter && object.nameAfter !== object.nameBefore ? ` -> ${object.nameAfter}` : "";
  const suffix = beforeName ? `${beforeName}${afterName})` : "";
  console.log(`\n~ object ${object.id}${suffix}`);
  for (const field of object.removedFields) console.log(`  - ${field.key} ${field.value.kind} ${JSON.stringify(field.value.value)}`);
  for (const field of object.addedFields) console.log(`  + ${field.key} ${field.value.kind} ${JSON.stringify(field.value.value)}`);
  for (const field of object.changedFields) {
    console.log(`  ~ ${field.key} ${field.before.kind} ${JSON.stringify(field.before.value)} -> ${JSON.stringify(field.after.value)}`);
  }
}

