import { chmodSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  expectedArtifactRef,
  persistArtifactOutput,
  readArtifactOutput,
  type OutputArtifactMetadata,
} from "../../owner-client.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const PYTHON = join(PROJECT_ROOT, ".venv", "bin", "python");
const roots: string[] = [];

function metadata(): OutputArtifactMetadata {
  return {
    schema_version: 1,
    run_id: "owner-client-restart-run",
    phase: "chain-step-0001",
    branch_id: null,
    kind: "agent-output",
    operation_id: "owner-client-restart-operation",
    version: 1,
    producer: "agent:echo",
    consumer_scope: ["subagent-chain:step:0002"],
    media_type: "text/markdown; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
  };
}

function artifactRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "penny-owner-client-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("shared artifact owner client", () => {
  it("persists and reopens exact large multibyte bytes without memory configuration", async () => {
    const root = artifactRoot();
    const output = `RESTART-SENTINEL\n${"🙂漢字é".repeat(20_000)}`;
    const contract = metadata();
    const env = {
      PATH: process.env.PATH,
      PENNY_ARTIFACT_ROOT: root,
      XDG_STATE_HOME: dirname(root),
    };

    const ref = await persistArtifactOutput({
      pythonPath: PYTHON,
      metadata: contract,
      output,
      cwd: PROJECT_ROOT,
      env,
    });
    expect(ref).toEqual(expectedArtifactRef(contract, output));

    // A new owner read uses only the durable ref and configured artifact root.
    const reopened = await readArtifactOutput({ ref: structuredClone(ref), env });
    expect(reopened.equals(Buffer.from(output, "utf8"))).toBe(true);
    expect(JSON.stringify(env)).not.toContain("MEMPALACE");
    expect(JSON.stringify(env)).not.toContain("MEMORY");
  });

  it("fails closed when a checkpointed artifact object is missing", async () => {
    const root = artifactRoot();
    const contract = metadata();
    const output = "exact but removed";
    const env = { ...process.env, PENNY_ARTIFACT_ROOT: root };
    const ref = await persistArtifactOutput({
      pythonPath: PYTHON,
      metadata: contract,
      output,
      cwd: PROJECT_ROOT,
      env,
    });
    const objectPath = join(
      root,
      "objects",
      "sha256",
      ref.content_digest.slice(0, 2),
      ref.content_digest.slice(2)
    );
    unlinkSync(objectPath);

    await expect(readArtifactOutput({ ref, env })).rejects.toMatchObject({
      code: "ARTIFACT_MISSING",
    });
  });
});
