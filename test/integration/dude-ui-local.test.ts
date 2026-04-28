/**
 * Local-only scaffolding for Wine-hosted Dude UI validation.
 *
 * This is skipped unless DONNY_DUDE_UI=1 because it boots/reuses a CHR and
 * requires a visible desktop session for the actual Python UI driver.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startQuickChrDude, type QuickChrDudeHarness } from "../helpers/quickchr-dude.ts";

const RUN_UI = process.env.DONNY_DUDE_UI === "1";
const EXISTING_MACHINE = process.env.DONNY_QUICKCHR_MACHINE;
const MACHINE = EXISTING_MACHINE ?? `donny-dude-ui-${process.pid}`;
const TEST_TIMEOUT_MS = 240_000;

const maybeDescribe = RUN_UI ? describe : describe.skip;

maybeDescribe("local Wine Dude UI harness", () => {
  let harness: QuickChrDudeHarness | undefined;

  beforeAll(async () => {
    harness = await startQuickChrDude({
      machine: MACHINE,
      existingMachine: !!EXISTING_MACHINE,
      enableWinbox: true,
      timeoutMs: TEST_TIMEOUT_MS,
    });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.stop();
  }, 150_000);

  test("exposes a Dude client login target", () => {
    const target = harness?.loginTarget();
    expect(target).toBeDefined();
    expect(target?.host).toBe("localhost");
    expect(target?.username).toBe("admin");
    expect(target?.password).toBe("");
    expect(target?.port).toBeGreaterThan(0);
  });
});

