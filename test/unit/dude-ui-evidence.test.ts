import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVIDENCE_TARGETS, evaluateEvidenceTargets } from "../../labs/dude-ui/evidence.ts";
import { writeServerMetaDb } from "../helpers/dude-ui-fixtures.ts";

describe("Dude UI evidence manifest", () => {
  test("keeps known Dude UI targets discoverable", () => {
    expect(EVIDENCE_TARGETS.map((target) => target.id)).toContain("server-last-client-connect");
    expect(EVIDENCE_TARGETS.map((target) => target.id)).toContain("device-routeros-flag");
    expect(EVIDENCE_TARGETS.map((target) => target.id)).toContain("device-add-with-ping-probe");
    expect(EVIDENCE_TARGETS.map((target) => target.id)).toContain("device-username");
    expect(EVIDENCE_TARGETS.map((target) => target.id)).toContain("device-custom-field-1");
  });

  test("grounds supplied client-connect artifacts and reports missing live probe evidence", () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "donny-dude-ui-evidence-"));
    writeServerMetaDb(join(artifactDir, "before.export"), 0);
    writeServerMetaDb(join(artifactDir, "after-cli-connect.export"), 1_777_405_776);

    try {
      const results = evaluateEvidenceTargets({ artifactDir });
      const byId = new Map(results.map((result) => [result.target.id, result]));

      expect(byId.get("server-last-client-connect")?.status).toBe("grounded");
      expect(byId.get("device-add-with-ping-probe")?.status).toBe("missing-artifact");
    } finally {
      rmSync(artifactDir, { force: true, recursive: true });
    }
  });
});
