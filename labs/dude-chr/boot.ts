/**
 * boot.ts — Lab: Boot a RouterOS CHR with the Dude package and experiment with dude.db.
 *
 * Usage:
 *   bun run boot.ts                        # Boot, enable Dude, download fresh dude.db
 *   bun run boot.ts --load ../../2022.db   # Boot, load a custom dude.db, verify devices
 *   bun run boot.ts --smb                  # Also expose Dude dir via SMB share
 *   bun run boot.ts --keep                 # Keep instance running after script exits
 *   bun run boot.ts --name my-dude         # Named instance (reuse if already running)
 *   bun run boot.ts --help                 # Print this help
 *
 * Phases:
 *   1. Boot CHR with the "dude" extra package installed
 *   2. Enable Dude (creates /dude/ directory and empty dude.db on CHR)
 *   2b.[If --smb] Configure /ip/smb to share the /dude/ directory
 *   3. [If --load] Disable Dude, SCP custom db as /dude/dude.db, re-enable
 *   4. Download /dude/dude.db to local disk for inspection
 *   5. Print device count via REST and exec
 *
 * Prerequisites:
 *   qemu-system-x86_64  (or qemu-system-aarch64 on Apple Silicon)
 *   bun install  (run once in this directory)
 */

import { QuickCHR } from "@tikoci/quickchr";
import type { ChrInstance } from "@tikoci/quickchr";
import { scpUpload, scpDownload } from "./scp.ts";
import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

// Host port for SMB forward — uses the reserved slot (+6) in quickchr's port block.
// Default port base is 9100, so SMB lands on 9106. Declared early for use in --help.
const SMB_HOST_PORT = 9106;

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
dude-chr lab — boot CHR with Dude package, load dude.db, verify via REST

Usage:
  bun run boot.ts [--load <path>] [--smb] [--keep] [--name <n>] [--channel <ch>]

Options:
  --load <path>      Local .db file to upload as dude.db (optional)
  --smb              Expose /dude directory as an SMB share on host port ${SMB_HOST_PORT}
  --keep             Keep the CHR instance running after script exits
  --name <name>      Instance name (default: dude-lab)
  --channel <ch>     RouterOS channel: stable, long-term, testing (default: long-term)
  --help             Show this help
`);
  process.exit(0);
}

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

const LOAD_DB = flag("--load") ? resolve(flag("--load")!) : undefined;
const KEEP = args.includes("--keep");
const SMB = args.includes("--smb");
const NAME = flag("--name") ?? "dude-lab";
const CHANNEL = (flag("--channel") ?? "long-term") as "long-term" | "stable" | "testing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pause execution. */
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Print a section header. */
function section(label: string) {
  console.log(`\n─── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
}

/**
 * Poll /dude until enabled=true appears in exec output or timeout expires.
 * Dude takes a few seconds to initialize after being enabled.
 */
async function waitForDude(instance: ChrInstance, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = await instance.exec("/dude/print");
      if (out.output.includes("enabled: yes")) return true;
    } catch { /* not ready yet */ }
    await sleep(2000);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let instance: ChrInstance | undefined;

async function main() {
  // Validate --load arg early
  if (LOAD_DB) {
    if (!existsSync(LOAD_DB)) {
      console.error(`Error: --load file not found: ${LOAD_DB}`);
      process.exit(1);
    }
    console.log(`Will load: ${LOAD_DB}`);
  }

  // ── Phase 1: Boot ─────────────────────────────────────────────────────────
  section("Phase 1 · Boot CHR with Dude package");
  console.log(`Instance : ${NAME}`);
  console.log(`Channel  : ${CHANNEL}`);
  console.log(`Packages : dude${SMB ? " (+ SMB on port " + SMB_HOST_PORT + ")" : ""}`);

  instance = await QuickCHR.start({
    name: NAME,
    version: CHANNEL,
    // Omit arch — quickchr resolves via hostArchToChr() which reads process.arch.
    // Do NOT pass arch: "auto" — that string is not a valid Arch type and silently
    // causes quickchr to pick qemu-system-aarch64 (else-branch fallback), bypassing
    // host detection entirely.  Omitting lets the default kick in correctly.
    background: true,
    secureLogin: false,   // admin / empty password — simplest for lab use
    packages: ["dude"],
    cpu: 1,
    mem: 256,
    // Forward SMB guest port 445 → host port SMB_HOST_PORT when --smb is set.
    // SMB_HOST_PORT sits in the reserved block (portBase+6) so it won't collide
    // with any of the standard quickchr service ports.
    extraPorts: SMB ? [{ name: "smb", host: SMB_HOST_PORT, guest: 445, proto: "tcp" as const }] : [],
  });

  console.log(`SSH port : ${instance.sshPort}`);
  console.log(`REST URL : ${instance.restUrl}`);
  console.log("Waiting for boot…");

  const ready = await instance.waitForBoot(300_000);
  if (!ready) {
    console.error("Timed out waiting for CHR to boot");
    process.exit(1);
  }
  console.log("Boot OK");

  // ── Phase 2: Enable Dude ──────────────────────────────────────────────────
  section("Phase 2 · Enable Dude");
  console.log("Setting: /dude/set enabled=yes data-directory=dude");
  await instance.exec("/dude/set enabled=yes data-directory=dude");

  console.log("Waiting for Dude to initialize…");
  const dudeUp = await waitForDude(instance);
  if (!dudeUp) {
    console.warn("Dude did not report enabled=yes within timeout — proceeding anyway");
  }

  // Print Dude state
  const dudeState = await instance.exec("/dude/print");
  console.log("\n/dude/print output:");
  console.log(dudeState.output);

  // ── Phase 2b: Configure SMB share (optional) ─────────────────────────────
  if (SMB) {
    section("Phase 2b · Configure SMB share for /dude directory");
    // RouterOS SMB server shares from flash root. The Dude data directory is /dude/.
    // We add a read-write share with a password-free guest user so the host can
    // mount it without credentials and read (or write, when Dude is stopped) dude.db.
    await instance.exec(`
      /ip/smb/set enabled=yes
      /ip/smb/shares/add name=dude directory=/dude comment="dude data dir"
      /ip/smb/users/add name=guest password="" read-only=no
    `);
    console.log("SMB share configured: \\\\127.0.0.1\\dude");
    console.log(`\nTo mount on macOS:`);
    console.log(`  mkdir -p /tmp/chr-dude`);
    console.log(`  mount_smbfs //guest@127.0.0.1:${SMB_HOST_PORT}/dude /tmp/chr-dude`);
    console.log(`  ls -la /tmp/chr-dude   # should show dude.db (and .db-wal if Dude is running)`);
    console.log(`\nTo write a modified db (safe only when Dude is stopped):`);
    console.log(`  # 1. Stop Dude:  curl -u admin: -X POST http://127.0.0.1:${instance.ports.http}/rest/dude/set -d '{"enabled":"false"}'`);
    console.log(`  # 2. Write:      bun run ../../src/cli/index.ts add device --db /tmp/chr-dude/dude.db --name "test" --address 1.2.3.4`);
    console.log(`  # 3. Unmount:    umount /tmp/chr-dude`);
    console.log(`  # 4. Re-enable:  curl -u admin: -X POST http://127.0.0.1:${instance.ports.http}/rest/dude/set -d '{"enabled":"true","data-directory":"dude"}'`);
  }

  // ── Phase 3: Load custom db (optional) ────────────────────────────────────
  if (LOAD_DB) {
    section(`Phase 3 · Load custom db: ${basename(LOAD_DB)}`);

    console.log("Disabling Dude before db swap…");
    await instance.exec("/dude/set enabled=no");
    await sleep(2000);  // let Dude flush and close the db

    console.log(`Uploading ${LOAD_DB} → /dude/dude.db`);
    await scpUpload(instance.sshPort, LOAD_DB, "/dude/dude.db");
    console.log("Upload complete");

    console.log("Re-enabling Dude with custom db…");
    await instance.exec("/dude/set enabled=yes data-directory=dude");

    console.log("Waiting for Dude to reload…");
    const reloaded = await waitForDude(instance, 30_000);
    if (!reloaded) {
      console.warn("Dude did not confirm enabled after db swap — check /dude/print manually");
    }
  }

  // ── Phase 4: Download dude.db ─────────────────────────────────────────────
  section("Phase 4 · Download /dude/dude.db");
  // Dude uses SQLite WAL mode — the WAL file holds uncommitted writes.
  // Disable Dude to force a WAL checkpoint before downloading so the main
  // .db file is self-contained and readable without the WAL.
  console.log("Disabling Dude to checkpoint WAL before download…");
  await instance.exec("/dude/set enabled=no");
  await sleep(2000);
  const outFile = LOAD_DB
    ? `./downloaded-custom-${Date.now()}.db`
    : `./downloaded-fresh-${Date.now()}.db`;

  try {
    await scpDownload(instance.sshPort, "/dude/dude.db", outFile);
    // Re-enable Dude after download
    await instance.exec("/dude/set enabled=yes data-directory=dude");
    console.log(`Downloaded to: ${outFile}`);
    console.log("(Inspect with: cd ../.. && bun run src/cli/index.ts info labs/dude-chr/" + outFile.replace("./", "") + ")");
  } catch (e) {
    // Dude may not have written the db file yet — not fatal for the first run
    console.warn(`Download failed (Dude may not have persisted the db yet): ${e instanceof Error ? e.message : e}`);
  }

  // ── Phase 5: Verify via REST + exec ───────────────────────────────────────
  section("Phase 5 · Verify via REST API");

  // Device count via exec
  try {
    const countOut = await instance.exec("/dude/device/print count-only");
    console.log(`/dude/device/print count-only → ${countOut.output.trim()}`);
  } catch (e) {
    console.warn(`exec /dude/device/print failed: ${e instanceof Error ? e.message : e}`);
  }

  // REST GET /dude/device — first page
  try {
    const devices = await instance.rest("/dude/device") as unknown[];
    const count = Array.isArray(devices) ? devices.length : "?";
    console.log(`REST GET /dude/device → ${count} device(s)`);
    if (Array.isArray(devices) && devices.length > 0) {
      console.log("First device:", JSON.stringify(devices[0], null, 2));
    }
  } catch (e) {
    console.warn(`REST /dude/device failed: ${e instanceof Error ? e.message : e}`);
  }

  // REST GET /dude/service — first page
  try {
    const services = await instance.rest("/dude/service") as unknown[];
    const count = Array.isArray(services) ? services.length : "?";
    console.log(`REST GET /dude/service → ${count} service(s)`);
  } catch (e) {
    console.warn(`REST /dude/service failed: ${e instanceof Error ? e.message : e}`);
  }

  section("Done");
  if (KEEP) {
    console.log(`Instance "${NAME}" left running (--keep).`);
    console.log(`  SSH:  ssh -p ${instance.sshPort} admin@127.0.0.1`);
    console.log(`  REST: ${instance.restUrl}/rest/dude/device`);
    if (SMB) console.log(`  SMB:  smb://guest@127.0.0.1:${SMB_HOST_PORT}/dude`);
    console.log(`  Stop: quickchr stop ${NAME}`);
  }
}

main()
  .catch(e => {
    console.error("\nFatal:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    if (!KEEP && instance) {
      section("Cleanup");
      console.log(`Stopping instance "${NAME}"…`);
      try { await instance.remove(); } catch { /* ignore */ }
    }
  });
