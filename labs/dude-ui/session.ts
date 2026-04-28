/**
 * Interactive local session for grounding Dude UI writes.
 *
 * This is intentionally not a CI test. It starts/reuses a QuickCHR Dude server,
 * exports a baseline DB, helps launch/login the Wine client, waits while a human
 * or future driver changes one UI field, then exports and diffs the result.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { diffDudeDbFiles } from "../../src/index.ts";
import { startQuickChrDude } from "../../test/helpers/quickchr-dude.ts";
import { assertRouterOsFlagMapping, FIRST_ROUTEROS_FLAG_DEVICE_PREFIX } from "./first-mapping.ts";

interface Args {
  machine: string;
  reuse: boolean;
  keep: boolean;
  driveLogin: boolean;
  artifactDir: string;
  firstRouterOsFlag: boolean;
  deviceName: string;
  expectedRouterOs: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    machine: `donny-dude-ui-${process.pid}`,
    reuse: false,
    keep: false,
    driveLogin: false,
    artifactDir: "labs/dude-ui/artifacts",
    firstRouterOsFlag: false,
    deviceName: `${FIRST_ROUTEROS_FLAG_DEVICE_PREFIX}-${process.pid}`,
    expectedRouterOs: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--machine":
        out.machine = argv[++i] ?? out.machine;
        break;
      case "--reuse":
        out.reuse = true;
        break;
      case "--keep":
        out.keep = true;
        break;
      case "--drive-login":
        out.driveLogin = true;
        break;
      case "--artifact-dir":
        out.artifactDir = argv[++i] ?? out.artifactDir;
        break;
      case "--first-routeros-flag":
        out.firstRouterOsFlag = true;
        break;
      case "--device-name":
        out.deviceName = argv[++i] ?? out.deviceName;
        break;
      case "--expect-routeros": {
        const value = argv[++i];
        if (value === "true") out.expectedRouterOs = true;
        else if (value === "false") out.expectedRouterOs = false;
        else throw new Error("--expect-routeros must be true or false");
        break;
      }
      case "--help":
      case "-h":
        console.log(`
Usage:
  bun run labs/dude-ui/session.ts [--machine <name>] [--reuse] [--keep] [--drive-login]
                                   [--first-routeros-flag] [--device-name <name>]

Flow:
  1. start/reuse QuickCHR with Dude + WinBox enabled
  2. optionally seed a known target device, then export before.export
  3. optionally launch/fill Wine Dude login
  4. wait for you to change one field in the UI and save
  5. export after.export, write diff.json, and assert the target mapping when selected
`);
        process.exit(0);
    }
  }

  if (process.env.DONNY_QUICKCHR_MACHINE) {
    out.machine = process.env.DONNY_QUICKCHR_MACHINE;
    out.reuse = true;
  }

  return out;
}

async function runDriver(port: number, artifactDir: string): Promise<void> {
  const proc = Bun.spawn([
    "python3",
    "labs/dude-ui/dude_ui_driver.py",
    "login",
    "--port", String(port),
    "--screenshot-dir", artifactDir,
  ], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`dude_ui_driver.py failed with exit code ${exitCode}`);
}

function routerOsQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.artifactDir, { recursive: true });

const harness = await startQuickChrDude({
  machine: args.machine,
  existingMachine: args.reuse,
  enableWinbox: true,
});

try {
  const target = harness.loginTarget();
  if (!target) throw new Error(`could not read quickchr WinBox port for ${args.machine}`);

  console.log(`Dude server: ${target.host}:${target.port}`);
  console.log(`Credentials: ${target.username} / <empty password>`);

  const beforePath = join(args.artifactDir, "before.export");
  const afterPath = join(args.artifactDir, "after.export");
  const diffPath = join(args.artifactDir, "diff.json");

  if (args.firstRouterOsFlag) {
    console.log(`Seeding first mapping target device: ${args.deviceName}`);
    await harness.exec(`/dude/device/add name=${routerOsQuote(args.deviceName)}`);
    console.log("UI target: open Device Settings and toggle the RouterOS checkbox");
    console.log(`Expected ${args.deviceName} ${args.expectedRouterOs ? "RouterOS=checked" : "RouterOS=unchecked"}`);
  }

  console.log(`Exporting baseline: ${beforePath}`);
  writeFileSync(beforePath, await harness.exportDb("donny-ui-before.export"));

  if (args.driveLogin) await runDriver(target.port, args.artifactDir);
  else console.log("Launch the client manually with: wine ~/.wine/drive_c/Program\\ Files\\ \\(x86\\)/dude/dude.exe");

  const rl = createInterface({ input, output });
  await rl.question("Make one Dude UI change, save it, then press Enter to export/diff... ");
  rl.close();

  console.log(`Exporting after snapshot: ${afterPath}`);
  writeFileSync(afterPath, await harness.exportDb("donny-ui-after.export"));

  const diff = diffDudeDbFiles(beforePath, afterPath);
  writeFileSync(diffPath, `${JSON.stringify(diff, null, 2)}\n`);

  if (args.firstRouterOsFlag) {
    const result = assertRouterOsFlagMapping({
      beforePath,
      afterPath,
      deviceName: args.deviceName,
      expectedAfter: args.expectedRouterOs,
    });
    console.log(`Asserted TAG.DEVICE_ROUTER_OS on object ${result.objectId}: ${result.beforeValue} -> ${result.afterValue}`);
  }

  console.log(`Diff written: ${diffPath}`);
  console.log(`added=${diff.addedObjects.length} removed=${diff.removedObjects.length} changed=${diff.changedObjects.length}`);
} finally {
  if (!args.keep) await harness.stop();
}
