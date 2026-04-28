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
import { startQuickChrDude, type QuickChrDudeHarness } from "../helpers/quickchr-dude.ts";

const RUN_QUICKCHR = process.env.DONNY_QUICKCHR === "1";
const EXISTING_MACHINE = process.env.DONNY_QUICKCHR_MACHINE;
const MACHINE = EXISTING_MACHINE ?? `donny-dude-dns-${process.pid}`;
const TEST_TIMEOUT_MS = 240_000;

const maybeDescribe = RUN_QUICKCHR ? describe : describe.skip;

maybeDescribe("quickchr Dude DNS-mode grounding", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "donny-quickchr-"));
  let harness: QuickChrDudeHarness | undefined;

  beforeAll(async () => {
    harness = await startQuickChrDude({
      machine: MACHINE,
      existingMachine: !!EXISTING_MACHINE,
      enableWinbox: false,
      timeoutMs: TEST_TIMEOUT_MS,
    });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await harness?.stop();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 150_000);

  test("RouterOS-created DNS device stores 0x1F41 as an empty string array", async () => {
    const hostname = `routeros-dns-${Date.now()}.example`;
    const exportName = `donny-dns-${process.pid}.export`;
    const exportPath = join(tempDir, exportName);

    if (!harness) throw new Error("quickchr Dude harness was not started");
    await harness.exec("/dude/set enabled=yes data-directory=dude");
    await harness.exec(`/dude/device/add name="${hostname}"`);

    const exported = await harness.exportDb(exportName);
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
