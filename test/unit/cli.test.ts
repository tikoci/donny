import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseFlags, resolveWizardDbPath } from "../../src/cli/app.ts";

describe("CLI routing", () => {
  test("routes an existing file path to the wizard on TTY", () => {
    const dir = mkdtempSync(join(tmpdir(), "donny-cli-"));
    const dbPath = join(dir, "fixture.db");
    try {
      writeFileSync(dbPath, "");
      expect(resolveWizardDbPath([dbPath], true)).toBe(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not route known commands to the wizard", () => {
    expect(resolveWizardDbPath(["info"], true)).toBeUndefined();
    expect(resolveWizardDbPath(["setup"], true)).toBeUndefined();
  });

  test("does not route file paths to the wizard when stdin is not a TTY", () => {
    const dir = mkdtempSync(join(tmpdir(), "donny-cli-"));
    const dbPath = join(dir, "fixture.db");
    try {
      writeFileSync(dbPath, "");
      expect(resolveWizardDbPath([dbPath], false)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseFlags", () => {
  test("parses --flag=value, --flag value, and positional args", () => {
    expect(parseFlags(["devices", "--format=csv", "--include-credentials", "--name", "core-01"])).toEqual({
      flags: {
        format: "csv",
        "include-credentials": true,
        name: "core-01",
      },
      positional: ["devices"],
    });
  });
});
