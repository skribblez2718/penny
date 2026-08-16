import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function ref(runId: string, kind: string, operationId: string) {
  const metadata: OutputArtifactMetadata = {
    schema_version: 1,
    run_id: runId,
    phase: "skill-chain-step-0001",
    branch_id: null,
    kind,
    operation_id: operationId,
    version: 1,
    producer: kind === "skill-output" ? "skill:research" : "agent:skribble",
    consumer_scope: [
      kind === "skill-output" ? `skill-chain:${CHAIN_ID}:step:0002` : "state:report_writing",
    ],
    media_type: "text/markdown; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
  };
  return expectedArtifactRef(metadata, "exact terminal bytes");
}

function checkpoint(handoffRun = CHAIN_ID): ChainCheckpoint {
  const now = "2026-08-15T12:00:00.000Z";
  return {
    schema_version: 1,
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
        handoff_artifact_ref: ref(handoffRun, "skill-output", "handoff-1"),
      },
      {
        index: 1,
        skill_name: "research",
        goal: "use {previous}",
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
        session_id: "research-2",
      },
    ],
    created_at: now,
    updated_at: now,
  };
}

afterEach(() => {
  vi.resetModules();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("durable skill-chain checkpoints", () => {
  it("survives a module restart with exact refs under owner-only XDG state", async () => {
    const xdg = root();
    const env = { XDG_STATE_HOME: xdg, HOME: undefined };
    const value = checkpoint();
    saveChainCheckpoint(value, env);

    const stateRoot = resolveSkillChainStateRoot(env);
    const file = join(stateRoot, `${CHAIN_ID}.json`);
    expect(stateRoot.startsWith(xdg)).toBe(true);
    expect(stateRoot).not.toContain("skill-checkpoints");
    expect(statSync(stateRoot).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    vi.resetModules();
    const restarted = await import("../../chain-checkpoint.js");
    const recovered = restarted.readChainCheckpoint(CHAIN_ID, env);
    expect(recovered?.steps[0]?.output_artifact_ref).toEqual(value.steps[0]?.output_artifact_ref);
    expect(recovered?.steps[0]?.handoff_artifact_ref).toEqual(value.steps[0]?.handoff_artifact_ref);
    expect(recovered?.steps[0]?.result_preview).toBe("display only");
  });

  it("rejects a wrong-run handoff ref and distinguishes a missing checkpoint", () => {
    const xdg = root();
    const env = { XDG_STATE_HOME: xdg };
    expect(() => saveChainCheckpoint(checkpoint("chain-other"), env)).toThrow(/another run/);
    expect(readChainCheckpoint("chain-missing", env)).toBeNull();
  });
});
