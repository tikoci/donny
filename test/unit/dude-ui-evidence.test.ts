import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EVIDENCE_TARGETS, evaluateEvidenceTargets } from "../../labs/dude-ui/evidence.ts";

const artifactDir = join(import.meta.dir, "../../labs/dude-ui/artifacts");

describe("Dude UI evidence manifest", () => {
  test("keeps known Dude UI targets discoverable", () => {
    expect(EVIDENCE_TARGETS.map((target) => target.id)).toContain("server-last-client-connect");
    expect(EVIDENCE_TARGETS.map((target) => target.id)).toContain("device-routeros-flag");
    expect(EVIDENCE_TARGETS.map((target) => target.id)).toContain("device-add-with-ping-probe");
    expect(EVIDENCE_TARGETS.map((target) => target.dudeTerm)).toContain("Custom Fields");
  });

  test("grounds the committed client-connect evidence and reports missing live probe evidence", () => {
    const results = evaluateEvidenceTargets({ artifactDir });
    const byId = new Map(results.map((result) => [result.target.id, result]));

    expect(byId.get("server-last-client-connect")?.status).toBe("grounded");
    expect(byId.get("device-add-with-ping-probe")?.status).toBe("missing-artifact");
  });
});
