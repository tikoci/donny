/**
 * Deep inspection of remaining unknown object types.
 *   bun run scripts/analyze-unknowns3.ts
 */
import { Database } from "bun:sqlite";
import { decodeBlob, getStr, getU32 } from "../src/lib/nova.ts";

function dumpObject(row: { id: number; obj: Uint8Array }, label: string) {
  const msg = decodeBlob(row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj);
  if (!msg) { console.log(`  ${label}: null decode`); return; }
  const name = getStr(msg, 0x10) ?? "";
  const selfId = getU32(msg, 0x01);
  console.log(`  id=${row.id} selfId=${selfId} name=${JSON.stringify(name)}`);
  for (const f of msg.fields) {
    const hex = `0x${f.tag.toString(16).padStart(4, "0")}`;
    let val: string;
    if (f.val.k === "str") val = JSON.stringify(f.val.v);
    else if (f.val.k === "u32[]") {
      const preview = f.val.v.slice(0, 8).join(",");
      val = `[${preview}${f.val.v.length > 8 ? "…" : ""}]  len=${f.val.v.length}`;
    } else {
      val = String(f.val.v);
    }
    process.stdout.write(`    ${hex} (${f.val.k.padEnd(6)}) = ${val}\n`);
  }
}

// ---- 0x6590-range objects (26000 block) ----
console.log("\n=== Type A: 0x6590-range objects from tikoci.db ===");
{
  const db = new Database("tikoci.db", { readonly: true });
  const rows = db
    .query("SELECT id, obj FROM objs WHERE id IN (515033, 520338, 521732, 654556, 706814) ORDER BY id")
    .all() as { id: number; obj: Uint8Array }[];
  for (const row of rows) dumpObject(row, `id=${row.id}`);
  db.close();
}

// 2022.db has 1 of these
console.log("\n=== Type A: 0x6590-range from 2022.db ===");
{
  const db = new Database("2022.db", { readonly: true });
  const rows = db
    .query("SELECT id, obj FROM objs WHERE id = 45032")
    .all() as { id: number; obj: Uint8Array }[];
  for (const row of rows) dumpObject(row, `id=${row.id}`);
  db.close();
}

// ---- 0x2328-range objects (9000 block) ----
console.log("\n=== Type B: 0x2328-range objects from 2022.db ===");
{
  const db = new Database("2022.db", { readonly: true });
  const rows = db
    .query("SELECT id, obj FROM objs WHERE id IN (83624, 83721) ORDER BY id")
    .all() as { id: number; obj: Uint8Array }[];
  for (const row of rows) dumpObject(row, `id=${row.id}`);

  // Do the u32[] IDs match objects in the DB?
  const allIds = new Set<number>(
    (db.query("SELECT id FROM objs").all() as { id: number }[]).map((r) => r.id),
  );
  for (const row of rows) {
    const msg = decodeBlob(row.obj instanceof Buffer ? new Uint8Array(row.obj) : row.obj);
    const field = msg?.fields.find((f) => f.tag === 0x2328);
    if (field?.val.k === "u32[]") {
      const ids = field.val.v;
      const matched = ids.filter((id) => allIds.has(id));
      console.log(
        `  -> 0x2328 array: ${ids.length} IDs, ${matched.length} match existing objs: [${matched.join(",")}]`,
      );
    }
  }
  db.close();
}
