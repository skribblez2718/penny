/** Real Node package resolution, without providers or retained state. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertCurrentShippingBuild } from "../dist/build-provenance.js";

const packageRoot = path.resolve(import.meta.dirname, "..");

describe("one shipping orchestration generation", () => {
  it("binds the actual source, external policy helper, artifact bundle and declarations", () => {
    const build = assertCurrentShippingBuild();
    if (build === undefined) throw new Error("Shipping test loaded source rather than dist");
    expect(build.generation).toMatch(/^[a-f0-9]{64}$/u);
    for (const file of [
      "apps/orchestration/src/service.ts",
      "apps/orchestration/src/skill-result.ts",
      ".pi/lib/compaction-policy.mjs",
      ".pi/extensions/artifacts/owner-client.ts",
    ])
      expect(build.provenance.inputs[file]).toMatch(/^[a-f0-9]{64}$/u);
    expect(build.provenance.helper_inputs).toContain(".pi/extensions/artifacts/owner-client.ts");
    for (const file of [
      "index.js",
      "index.d.ts",
      "artifact-worker.js",
      "videogen/voice-private-peer.py",
    ])
      expect(build.provenance.outputs[file]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses identical classes and result parser through the root, explicit exports and helper", () => {
    const execution = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      const root = await import("@penny/orchestration");
      const service = await import("@penny/orchestration/service");
      const store = await import("@penny/orchestration/artifact-store");
      const results = await import("./dist/skill-result.js");
      const helper = await import("./dist/artifact-worker.js");
      assert.equal(root.OrchestrationService, service.OrchestrationService);
      assert.equal(root.ArtifactStore, store.ArtifactStore);
      assert.equal(root.parseCurrentSkillResult, results.parseCurrentSkillResult);
      assert.equal(typeof helper.createArtifactReadExtension, "function");
      await assert.rejects(import("@penny/orchestration/source"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
      await assert.rejects(import("@penny/orchestration/skill-contracts/research"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
      process.stdout.write(root.assertCurrentShippingBuild().generation);
    `,
      ],
      { cwd: packageRoot, encoding: "utf8" }
    );
    expect(execution.stderr).toBe("");
    expect(execution.status).toBe(0);
    expect(execution.stdout).toMatch(/^[a-f0-9]{64}$/u);
    // The bundle keeps orchestration external: it cannot embed a second set of classes.
    const helper = readFileSync(path.join(packageRoot, "dist/artifact-worker.js"), "utf8");
    expect(helper).toContain('from "@penny/orchestration"');
    expect(helper).not.toMatch(/class (?:OrchestrationService|ArtifactStore)/u);
  });
});
