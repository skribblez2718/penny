import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer } from "../src/checkpointer.js";
import { OrchestrationEngine } from "../src/engine.js";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "penny-initial-artifacts-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
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
  it("grants an imported chain input to the actual quick entry state", () => {
    const projectRoot = root();
    const runId = "research-chain-target";
    using artifacts = new ArtifactStore(path.join(projectRoot, "artifacts"));
    const consumer = `skill-start:${runId}`;
    const ref = artifacts.persist({
      metadata: {
        schema_version: 1,
        run_id: runId,
        phase: "chain_input",
        branch_id: null,
        kind: "agent-output",
        operation_id: "chain-input-operation",
        version: 1,
        producer: "skill:research",
        consumer_scope: [consumer, "state:planning", "state:researching"].sort(),
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
        schema_version: 1,
        run_id: runId,
        consumer,
        artifacts: [{ slot: "previous-skill-terminal-output", ref }],
      },
    });

    expect(directive.action).toBe("invoke_agent");
    if (directive.action !== "invoke_agent") throw new Error("expected invoke_agent");
    expect(directive.state_id).toBe("researching");
    expect(directive.input_artifacts.artifacts.map((binding) => binding.ref)).toEqual([ref]);
    expect(directive.output_artifact.upstream_refs).toEqual([ref]);
  });

  it("refuses a seed that is not bound to the target run", () => {
    const projectRoot = root();
    const runId = "research-chain-target";
    using checkpointer = new Checkpointer(path.join(projectRoot, "orchestration-v2.db"));
    const engine = new OrchestrationEngine(checkpointer, { projectRoot, maxSteps: 32 });
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "start",
        identity: identity(runId),
        goal: "continue",
        constraints: {},
        project_root: projectRoot,
        trust_profile: "trusted-interactive",
        input_artifacts: {
          schema_version: 1,
          run_id: "another-run",
          consumer: "skill-start:another-run",
          artifacts: [],
        },
      })
    ).toThrow(/another run/);
  });
});
