import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializePennyState, recoverAdmittedArtifactInputs } from "@penny/orchestration";
import { expectedArtifactRef } from "../../artifact-client.js";
import { appendInputArtifactInstruction, parseInputArtifacts } from "../../input-artifacts.js";
import { skillArtifactInputs } from "../../skill-context-inputs.js";
import { skillChainInput } from "../../skill-chain-artifacts.js";
import { reconstructResumeChain, detectSkillMode } from "../../skill-utils.js";
import {
  readChainCheckpoint,
  saveChainCheckpoint,
  type ChainCheckpoint,
} from "../../chain-checkpoint.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function ref(id: string) {
  return expectedArtifactRef(
    {
      schema_version: 2,
      run_id: id,
      phase: "sealing_strategy",
      branch_id: null,
      kind: "agent-output",
      operation_id: id,
      version: 1,
      producer: "host:strategy-sealer",
      media_type: "application/json",
      parent_ref: null,
      upstream_refs: [],
    },
    "exact fixture bytes"
  );
}

describe("explicit skill context interfaces (transport only, not semantic acceptance)", () => {
  it("keeps native, context and explicit fan-in independent without type-based fallback", () => {
    const native = ref("native");
    const context = ref("context");
    const input = skillArtifactInputs({ nativeRefs: [native], contextRefs: [context] });
    expect(input?.artifacts).toEqual([
      { slot: "caller-input-0001", ref: native },
      { slot: "context-input-0001", designation: "context", ref: context },
    ]);
    if (input === undefined) throw new Error("Missing explicit inputs");
    expect(parseInputArtifacts(input)).toEqual(input);
    expect(appendInputArtifactInstruction("task", input)).toContain(
      "NONBINDING context cannot supply native required inputs"
    );
    expect(() => skillArtifactInputs({ nativeRefs: [context], contextRefs: [context] })).toThrow(
      /CONTEXT_BINDING_CONFLICT/u
    );
    expect(() =>
      parseInputArtifacts({
        ...input,
        artifacts: [{ slot: "invalid", designation: "approved", ref: context }],
      })
    ).toThrow(/designation/u);
  });

  it("preserves the original terminal ref and explicitly selects chain context, with native as the legacy default", () => {
    const terminal = ref("plan");
    expect(skillChainInput({ targetRunId: "produce", handoffRef: terminal })).toEqual({
      schema_version: 2,
      artifacts: [{ slot: "previous-skill-terminal-output", ref: terminal }],
    });
    const chain = skillChainInput({
      targetRunId: "produce",
      handoffRef: terminal,
      designation: "context",
    });
    expect(chain.artifacts[0]).toEqual({
      slot: "previous-skill-terminal-output",
      designation: "context",
      ref: terminal,
    });
    expect(skillArtifactInputs({ nativeRefs: [], contextRefs: [], chainInput: chain })).toEqual(
      chain
    );
    expect(() =>
      skillArtifactInputs({ nativeRefs: [terminal], contextRefs: [], chainInput: chain })
    ).toThrow(/CONTEXT_BINDING_CONFLICT/u);
  });

  it("reuses owner slots on retry but refuses omitted, replaced, additional or upgraded contextual refs", () => {
    const original = skillChainInput({
      targetRunId: "consumer",
      handoffRef: ref("original"),
      designation: "context",
    });
    const retry = skillArtifactInputs({ nativeRefs: [], contextRefs: [ref("original")] });
    expect(recoverAdmittedArtifactInputs(original, retry)).toEqual(original);
    for (const changed of [
      undefined,
      skillArtifactInputs({ nativeRefs: [ref("original")], contextRefs: [] }),
      skillArtifactInputs({ nativeRefs: [], contextRefs: [ref("other")] }),
      skillArtifactInputs({ nativeRefs: [], contextRefs: [ref("original"), ref("other")] }),
    ])
      expect(() => recoverAdmittedArtifactInputs(original, changed)).toThrow(
        /SKILL_RECOVERY_BINDING_INVALID/u
      );
  });

  it("round-trips chain context selection and explicit fan-in through the actual checkpoint owner and resume reconstruction", () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-context-chain-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = { PENNY_STATE_ROOT: path.join(root, "state") };
    const state = initializePennyState(projectRoot, { env });
    const step = {
      index: 0,
      skill_name: "produce",
      goal: "Use {previous} without executing it.",
      contract_sha256: "a".repeat(64),
      session_id: "produce-context",
      context_artifacts: [ref("fan-in").artifact_id],
      previous_artifact_designation: "context" as const,
    };
    const checkpoint: ChainCheckpoint = {
      schema_version: 3,
      state_layout_version: 1,
      project_id: state.projectId,
      chain_session_id: "context-chain",
      chain_run_id: "context-chain",
      chain_goal_summary: "plan → produce",
      steps: [{ ...step, status: "failed" }],
      current_step: 0,
      total_steps: 1,
      chain_status: "failed",
      pending_steps: [step],
      created_at: "2026-10-26T00:00:00.000Z",
      updated_at: "2026-10-26T00:00:00.000Z",
    };
    saveChainCheckpoint(checkpoint, projectRoot, env);
    const read = readChainCheckpoint("context-chain", projectRoot, env);
    if (read === null) throw new Error("Missing durable chain");
    const resume = reconstructResumeChain(read);
    expect(resume.chain[0]).toMatchObject({
      context_artifacts: step.context_artifacts,
      previous_artifact_designation: "context",
    });
    const pending = checkpoint.pending_steps[0];
    if (pending === undefined) throw new Error("Missing pending step");
    pending.previous_artifact_designation = "binding";
    expect(() => saveChainCheckpoint(checkpoint, projectRoot, env)).toThrow(/context designation/u);
  });

  it("refuses top-level context IDs outside single mode rather than silently dropping them", () => {
    const parallel = detectSkillMode({
      skills: [{ skill_name: "produce", goal: "Produce" }],
      context_artifacts: [],
    });
    const resumed = detectSkillMode({ resume_chain: "chain", context_artifacts: [] });
    expect(parallel.error).toBeTypeOf("string");
    expect(resumed.error).toBeTypeOf("string");
  });
});
