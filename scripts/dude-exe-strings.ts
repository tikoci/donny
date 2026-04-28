/**
 * Extract high-signal strings from the local The Dude Windows client binary.
 *
 * The output is a research aid only. Client-written DB diffs remain the mapping
 * authority.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const defaultExe = join(homedir(), ".wine/drive_c/Program Files (x86)/dude/dude.exe");
const exePath = process.argv[2] ?? process.env.DONNY_DUDE_CLIENT ?? defaultExe;

if (!existsSync(exePath)) {
  console.error(`dude.exe not found: ${exePath}`);
  process.exit(1);
}

const proc = Bun.spawn(["strings", "-a", exePath], {
  stdout: "pipe",
  stderr: "pipe",
});

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);

if (exitCode !== 0) {
  throw new Error(`strings failed (${exitCode}): ${stderr}`);
}

const interesting = /\b(Device|RouterOS|Snmp|SNMP|Agent|Probe|Service|Custom|Address|Mac|MAC|Map|Link|Canvas|Interface|nv::|Nova|message|FirstAddress|Lookup|Polling|Notification|Tool)\b/i;
const strings = [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => interesting.test(line)))].sort((a, b) => a.localeCompare(b));

for (const line of strings) console.log(line);

