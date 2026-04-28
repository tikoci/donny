/**
 * quickchr-backed integration test for RouterOS Dude DNS-mode device encoding.
 *
 * This is opt-in because it boots a real CHR VM and installs the Dude package:
 *
 *   DONNY_QUICKCHR=1 bun test test/integration/quickchr-dude-dns.test.ts
 *
 * Set DONNY_QUICKCHR_MACHINE=<name> to reuse an already-running quickchr
 * machine with the Dude package installed; otherwise the test creates and
 * removes a disposable x86 long-term CHR instance.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DudeDB,
  getStr,
  getStringArray,
  getU32Array,
  TAG,
} from "../../src/index.ts";

const RUN_QUICKCHR = process.env.DONNY_QUICKCHR === "1";
const EXISTING_MACHINE = process.env.DONNY_QUICKCHR_MACHINE;
const MACHINE = EXISTING_MACHINE ?? `donny-dude-dns-${process.pid}`;
const TEST_TIMEOUT_MS = 240_000;

const maybeDescribe = RUN_QUICKCHR ? describe : describe.skip;

maybeDescribe("quickchr Dude DNS-mode grounding", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "donny-quickchr-"));
  let ownsMachine = false;

  beforeAll(async () => {
    if (EXISTING_MACHINE) return;
    ownsMachine = true;
    await runQuickchr([
      "start",
      "--name", MACHINE,
      "--channel", "long-term",
      "--arch", "x86",
      "--add-package", "dude",
      "--no-secure-login",
      "--no-winbox",
      "--no-api-ssl",
      "--device-mode", "skip",
      "--timeout-extra", "120",
    ], TEST_TIMEOUT_MS);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      if (ownsMachine) await runQuickchr(["remove", MACHINE], 120_000);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 150_000);

  test("RouterOS-created DNS device stores 0x1F41 as an empty string array", async () => {
    const hostname = `routeros-dns-${Date.now()}.example`;
    const exportName = `donny-dns-${process.pid}.export`;
    const exportPath = join(tempDir, exportName);

    await execRouterOS("/dude/set enabled=yes data-directory=dude");
    await execRouterOS(`/dude/device/add name="${hostname}"`);
    await execRouterOS(`/dude/export-db backup-file=${exportName}`);

    const exported = await readRouterOSFile(exportName);
    writeFileSync(exportPath, exported);

    const dude = DudeDB.openAuto(exportPath, { readonly: true });
    try {
      const device = dude.devices().find((d) => d.name === hostname);
      expect(device).toBeDefined();
      expect(device?.address).toBe(hostname);

      const raw = [...dude.rawObjects()].find(({ msg }) => getStr(msg, TAG.NAME) === hostname);
      expect(raw).toBeDefined();
      if (!raw) throw new Error(`exported Dude DB did not contain ${hostname}`);
      expect(getU32Array(raw.msg, TAG.DEVICE_IP)).toEqual([]);
      expect(getStringArray(raw.msg, TAG.DEVICE_DNS_NAMES)).toEqual([]);
    } finally {
      dude.close();
    }
  }, TEST_TIMEOUT_MS);
});

async function execRouterOS(command: string): Promise<string> {
  return runQuickchr(["exec", MACHINE, command], 60_000);
}

async function readRouterOSFile(fileName: string): Promise<Buffer> {
  const sizeText = await execRouterOS(`:put [/file/get [find name="${fileName}"] size]`);
  const size = Number.parseInt(sizeText.replace(/\D/g, ""), 10);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`could not determine RouterOS file size for ${fileName}: ${sizeText}`);
  }

  const chunks: Buffer[] = [];
  const chunkSize = 8192;
  for (let offset = 0; offset < size; offset += chunkSize) {
    const script = `:local r [/file/read file="${fileName}" offset=${offset} chunk-size=${chunkSize} as-value]; :put [:convert ($r->"data") to=base64]`;
    const b64 = await execRouterOS(script);
    chunks.push(Buffer.from(b64.replace(/\s+/g, ""), "base64"));
  }
  return Buffer.concat(chunks);
}

async function runQuickchr(args: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(["quickchr", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`quickchr ${args.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`);
    }
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
}
