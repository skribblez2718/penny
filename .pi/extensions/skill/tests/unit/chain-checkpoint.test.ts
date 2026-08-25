import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializePennyState } from "@penny/orchestration/source";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectedArtifactRef, type OutputArtifactMetadata } from "../../artifact-client.js";
import {
  readChainCheckpoint,
  resolveSkillChainStateRoot,
  saveChainCheckpoint,
  type ChainCheckpoint,
} from "../../chain-checkpoint.js";

const roots: string[] = [];
const CHAIN_ID = "chain-00000000-0000-4000-8000-000000000001";

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "penny-chain-state-test-"));
  roots.push(value);
  return value;
}

function ref(runId: string, kind: "agent-output", operationId: string) {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: runId,
    phase: "skill-chain-step-0001",
    branch_id: null,
    kind,
    operation_id: operationId,
    version: 1,
    producer: operationId.startsWith("handoff") ? "skill:research" : "agent:skribble",
    media_type: "text/markdown; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
  };
  return expectedArtifactRef(metadata, "exact terminal bytes");
}

function checkpoint(projectId: string, handoffRun = "research-2"): ChainCheckpoint {
  const now = "2026-08-15T12:00:00.000Z";
  return {
    schema_version: 1,
    state_layout_version: 1,
    project_id: projectId,
    chain_session_id: CHAIN_ID,
    chain_run_id: CHAIN_ID,
    chain_goal_summary: "research → research",
    steps: [
      {
        index: 0,
        skill_name: "research",
        goal: "first",
        session_id: "research-1",
        status: "complete",
        result_preview: "display only",
        output_artifact_ref: ref("skill-run-1", "agent-output", "terminal-1"),
        handoff_artifact_ref: ref(handoffRun, "agent-output", "handoff-1"),
      },
      {
        index: 1,
        skill_name: "research",
        goal: "use {previous}",
        input_artifacts: [`art_${"1".repeat(64)}`],
        session_id: "research-2",
        status: "failed",
      },
    ],
    current_step: 1,
    total_steps: 2,
    chain_status: "failed",
    pending_steps: [
      {
        index: 1,
        skill_name: "research",
        goal: "use {previous}",
        input_artifacts: [`art_${"1".repeat(64)}`],
        session_id: "research-2",
      },
    ],
    created_at: now,
    updated_at: now,
  };
}

function stateFixture(): {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  projectId: string;
} {
  const sandbox = root();
  const projectRoot = join(sandbox, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const env = { PENNY_STATE_ROOT: join(sandbox, "state") };
  const state = initializePennyState(projectRoot, { env });
  return { projectRoot, env, projectId: state.projectId };
}

afterEach(() => {
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable skill-chain checkpoints", () => {
  it("survives a module restart with exact refs under owner-only project state", async () => {
    const { projectRoot, env, projectId } = stateFixture();
    const value = checkpoint(projectId);
    saveChainCheckpoint(value, projectRoot, env);

    const stateRoot = resolveSkillChainStateRoot(projectRoot, env);
    const file = join(stateRoot, `${CHAIN_ID}.json`);
    const expectedStateRoot = env.PENNY_STATE_ROOT;
    if (expectedStateRoot === undefined) {
      throw new Error("state fixture must define PENNY_STATE_ROOT");
    }
    expect(stateRoot.startsWith(expectedStateRoot)).toBe(true);
    expect(stateRoot).not.toContain("skill-checkpoints");
    expect(statSync(stateRoot).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    vi.resetModules();
    const restarted = await import("../../chain-checkpoint.js");
    const recovered = restarted.readChainCheckpoint(CHAIN_ID, projectRoot, env);
    expect(recovered?.steps[0]?.output_artifact_ref).toEqual(value.steps[0]?.output_artifact_ref);
    expect(recovered?.steps[0]?.handoff_artifact_ref).toEqual(value.steps[0]?.handoff_artifact_ref);
    expect(recovered?.steps[0]?.result_preview).toBe("display only");
    expect(recovered?.steps[1]?.input_artifacts).toEqual([`art_${"1".repeat(64)}`]);
  });

  it("accepts cross-run handoff refs, rejects invalid explicit IDs, and distinguishes missing", () => {
    const { projectRoot, env, projectId } = stateFixture();
    expect(() =>
      saveChainCheckpoint(checkpoint(projectId, "chain-other"), projectRoot, env)
    ).not.toThrow();
    const invalid = checkpoint(projectId);
    const firstStep = invalid.steps[0];
    if (firstStep === undefined) {
      throw new Error("checkpoint fixture must contain its first step");
    }
    firstStep.input_artifacts = ["not-an-artifact"];
    expect(() => saveChainCheckpoint(invalid, projectRoot, env)).toThrow(
      /explicit input artifacts/
    );
    expect(readChainCheckpoint("chain-missing", projectRoot, env)).toBeNull();
  });
});
