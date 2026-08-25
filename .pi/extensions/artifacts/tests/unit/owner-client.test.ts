import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializePennyState } from "@penny/orchestration/source";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseArtifactRef,
  parseOutputArtifactMetadata,
  persistArtifactOutput,
  readArtifactById,
  readArtifactOutput,
} from "../../owner-client.js";
import { outputMetadata } from "../fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { projectRoot: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "penny-owner-client-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const env = { PENNY_STATE_ROOT: join(root, "state") };
  initializePennyState(projectRoot, { env });
  return { projectRoot, env };
}

describe("artifact owner client", () => {
  it("persists, re-reads, and resolves by exact ID", async () => {
    const { projectRoot, env } = fixture();
    const ref = await persistArtifactOutput({
      metadata: outputMetadata(),
      output: "exact bytes",
      cwd: projectRoot,
      env,
    });
    expect(ref.schema_version).toBe(2);
    expect(ref).not.toHaveProperty("consumer_scope");
    expect((await readArtifactOutput({ ref, projectRoot, env })).toString()).toBe("exact bytes");
    const direct = await readArtifactById({ artifactId: ref.artifact_id, projectRoot, env });
    expect(direct.ref).toEqual(ref);
    expect(direct.content.toString()).toBe("exact bytes");
  });

  it("rejects a retired schema-v1 ref", () => {
    expect(() =>
      parseArtifactRef({
        schema_version: 1,
        artifact_id: "art_0526090a3d11649ef309c47abb6b890a802b9412d299ac0baeff6fef1aaf2e5a",
        run_id: "legacy-run",
        phase: "legacy-phase",
        branch_id: null,
        kind: "agent-output",
        operation_id: "legacy-operation",
        version: 1,
        producer: "agent:legacy",
        consumer_scope: ["ignored"],
        media_type: "text/plain",
        byte_length: 0,
        content_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        store_ref:
          "artifact://sha256/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      })
    ).toThrow(/schema_version|consumer_scope/);
  });

  it("rejects retired schema-v1 output metadata", () => {
    expect(() =>
      parseOutputArtifactMetadata({
        ...outputMetadata(),
        schema_version: 1,
        consumer_scope: ["state:any"],
      })
    ).toThrow(/unsupported output_artifact schema version/);
  });
});
