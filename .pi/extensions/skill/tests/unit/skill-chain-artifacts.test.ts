import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializePennyState } from "@penny/orchestration/source";
import { afterEach, describe, expect, it } from "vitest";

import { persistArtifactOutput, type ArtifactRef } from "../../artifact-client.js";
import {
  persistSkillChainHandoff,
  skillChainInput,
  validateSkillChainHandoff,
} from "../../skill-chain-artifacts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment(): { projectRoot: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "penny-skill-chain-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const env = { PENNY_STATE_ROOT: join(root, "state") };
  initializePennyState(projectRoot, { env });
  return { projectRoot, env };
}

describe("skill-chain exact terminal handoff", () => {
  it("forwards the exact predecessor ID across runs without a target-run copy", async () => {
    const { projectRoot, env } = environment();
    const terminalRef = await persistArtifactOutput({
      metadata: {
        schema_version: 2,
        run_id: "skill-run-terminal",
        phase: "report_writing",
        branch_id: null,
        kind: "agent-output",
        operation_id: "terminal-operation",
        version: 1,
        producer: "agent:skribble",
        media_type: "text/plain",
        parent_ref: null,
        upstream_refs: [],
      },
      output: "terminal bytes",
      cwd: projectRoot,
      env,
    });
    const forwarded = await persistSkillChainHandoff({
      chainRunId: "chain",
      completedStepIndex: 0,
      targetRunId: "next-run",
      skillName: "research",
      terminalRef,
      projectRoot,
      env,
    });
    expect(forwarded).toEqual(terminalRef);
    const input = skillChainInput({ targetRunId: "next-run", handoffRef: forwarded });
    expect(input).toEqual({
      schema_version: 2,
      artifacts: [{ slot: "previous-skill-terminal-output", ref: terminalRef }],
    });
    await validateSkillChainHandoff(forwarded, projectRoot, env);
  });

  it("fails when the exact terminal object is missing", async () => {
    const { projectRoot, env } = environment();
    const identity = {
      run_id: "missing-run",
      phase: "phase",
      branch_id: null,
      kind: "agent-output",
      operation_id: "missing-operation",
      version: 1,
    };
    const digest = createHash("sha256").update("missing").digest("hex");
    const ref: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${createHash("sha256")
        .update(
          JSON.stringify({
            branch_id: identity.branch_id,
            kind: identity.kind,
            operation_id: identity.operation_id,
            phase: identity.phase,
            run_id: identity.run_id,
            version: identity.version,
          })
        )
        .digest("hex")}`,
      ...identity,
      producer: "agent:fixture",
      media_type: "text/plain",
      byte_length: 7,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    };
    await expect(
      persistSkillChainHandoff({
        chainRunId: "chain",
        completedStepIndex: 0,
        targetRunId: "next-run",
        skillName: "research",
        terminalRef: ref,
        projectRoot,
        env,
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
  });
});
