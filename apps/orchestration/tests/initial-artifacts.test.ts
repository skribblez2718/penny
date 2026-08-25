import { requireValue } from "./helpers/narrowing.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer } from "../src/checkpointer.js";
import { OrchestrationEngine } from "../src/engine.js";
import type { ModelClient } from "../src/model-client.js";
import { WorkerExecutor } from "../src/worker.js";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "penny-initial-artifacts-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  while (roots.length > 0) {
    rmSync(requireValue(roots.pop(), "temporary initial-artifacts root"), {
      recursive: true,
      force: true,
    });
  }
});

function identity(runId: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook: "research",
    engine_owner: "typescript" as const,
  };
}

describe("owner-seeded initial artifacts", () => {
  it("accepts an exact owner-seeded chain input at the quick entry state", () => {
    const projectRoot = root();
    const runId = "research-chain-target";
    using artifacts = new ArtifactStore(path.join(projectRoot, "artifacts"));
    const ref = artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: runId,
        phase: "chain_input",
        branch_id: null,
        kind: "agent-output",
        operation_id: "chain-input-operation",
        version: 1,
        producer: "skill:research",
        media_type: "text/markdown; charset=utf-8",
        parent_ref: null,
        upstream_refs: [],
      },
      content: "exact prior skill output",
    });
    using checkpointer = new Checkpointer(path.join(projectRoot, "orchestration-v2.db"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot,
      maxSteps: 32,
      artifactRevisions: artifacts,
    });
    const directive = engine.handle({
      schema_version: 2,
      action: "start",
      identity: identity(runId),
      goal: "continue from the exact predecessor",
      constraints: { mode: "quick" },
      project_root: projectRoot,
      trust_profile: "trusted-interactive",
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "previous-skill-terminal-output", ref }],
      },
    });

    expect(directive.action).toBe("invoke_agent");
    if (directive.action !== "invoke_agent") throw new Error("expected invoke_agent");
    expect(directive.state_id).toBe("researching");
    expect(directive.input_artifacts.artifacts.map((binding) => binding.ref)).toEqual([ref]);
    expect(directive.output_artifact.upstream_refs).toEqual([ref]);
  });

  it("fails a missing input object before invoking the model", async () => {
    const projectRoot = root();
    const foreignRoot = root();
    const runId = "missing-input-preflight";
    using foreign = new ArtifactStore(path.join(foreignRoot, "artifacts"));
    const ref = foreign.persist({
      metadata: {
        schema_version: 2,
        run_id: runId,
        phase: "chain_input",
        branch_id: null,
        kind: "agent-output",
        operation_id: "foreign-operation",
        version: 1,
        producer: "agent:annie",
        media_type: "text/plain",
        parent_ref: null,
        upstream_refs: [],
      },
      content: "foreign bytes",
    });
    using artifacts = new ArtifactStore(path.join(projectRoot, "artifacts"));
    using checkpointer = new Checkpointer(path.join(projectRoot, "orchestration-v2.db"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot,
      maxSteps: 32,
      artifactRevisions: artifacts,
    });
    const directive = engine.handle({
      schema_version: 2,
      action: "start",
      identity: identity(runId),
      goal: "continue",
      constraints: { mode: "quick" },
      project_root: projectRoot,
      trust_profile: "trusted-interactive",
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "missing-local-object", ref }],
      },
    });
    const runAgent = vi.fn<ModelClient["runAgent"]>();
    const modelClient = { runAgent } satisfies ModelClient;
    const workers = new WorkerExecutor(modelClient, artifacts, {
      projectRoot,
      parallelConcurrency: 1,
    });
    await expect(workers.execute(directive)).rejects.toThrow(/absent from the manifest/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("accepts an empty v2 exact-input set without run or consumer authority", () => {
    const projectRoot = root();
    const runId = "research-chain-target";
    using checkpointer = new Checkpointer(path.join(projectRoot, "orchestration-v2.db"));
    const engine = new OrchestrationEngine(checkpointer, { projectRoot, maxSteps: 32 });
    const directive = engine.handle({
      schema_version: 2,
      action: "start",
      identity: identity(runId),
      goal: "continue",
      constraints: {},
      project_root: projectRoot,
      trust_profile: "trusted-interactive",
      input_artifacts: { schema_version: 2, artifacts: [] },
    });
    expect(directive.action).toBe("invoke_agent");
  });
});
