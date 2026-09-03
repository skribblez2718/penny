import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer, canonicalJson } from "../src/checkpointer.js";
import type { Directive, RunIdentity } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import {
  hasApprovedPromotionCompletion,
  hasExternalStartOperationGroup,
  hasFanAggregate,
  hasGenericResponsePolicy,
  hasHostReviewedGateValidation,
  hasLivenessTerminal,
  hasReviewInvalidation,
  hasRoutingRepair,
  hasStateAwareRepair,
} from "../src/playbooks/playbook.js";
import { PLAYBOOK_REGISTRY, type PlaybookRegistryV1 } from "../src/playbooks/registry.js";
import { WorkerExecutor } from "../src/worker.js";
import { validateGroundedSynthesis } from "../src/skill-contracts/research.js";
import {
  CORE_ONLY_PLAYBOOK_NAME,
  CORE_ONLY_REGISTRATION,
  CoreOnlyPlaybook,
} from "./fixtures/core-only-playbook.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];
const OUTPUT_TEXT = 'core-only output\nSUMMARY:{"confidence":"CERTAIN","complete":true}';

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-core-only-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function identity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: `session-${runId}`,
    playbook: CORE_ONLY_PLAYBOOK_NAME,
    engine_owner: "typescript",
  };
}

function registry(): PlaybookRegistryV1 {
  return new Map([[CORE_ONLY_REGISTRATION.name, CORE_ONLY_REGISTRATION]]);
}

function engine(
  checkpointer: Checkpointer,
  root: string,
  artifacts?: ArtifactStore
): OrchestrationEngine {
  return new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    maxSteps: 16,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    playbookName: CORE_ONLY_PLAYBOOK_NAME,
    playbookRegistry: registry(),
    ...(artifacts === undefined
      ? {}
      : {
          artifactRevisions: artifacts,
          artifactStore: artifacts,
          artifactReader: artifacts,
        }),
  });
}

function requireInvocation(directive: Directive): Extract<Directive, { action: "invoke_agent" }> {
  if (directive.action !== "invoke_agent") {
    throw new Error(`expected invoke_agent, received '${directive.action}'`);
  }
  return directive;
}

class CoreOnlyClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    return { text: OUTPUT_TEXT };
  }
}

describe("W1 core-only lifecycle", () => {
  it("persists, rereads, receipts, admits, statuses, and recovers one exact positive terminal", async () => {
    const root = temporaryRoot();
    using checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const runtime = engine(checkpointer, root);
    const runIdentity = identity("run-core-only-positive");
    const pending = requireInvocation(
      runtime.handle({
        schema_version: 2,
        action: "start",
        identity: runIdentity,
        goal: "Prove the complete core-only lifecycle.",
        constraints: {},
        project_root: root,
        trust_profile: "hardened-untrusted",
      })
    );
    expect(pending.state_id).toBe("planning");
    expect(pending.agent).toBe("piper");

    const client = new CoreOnlyClient();
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: root,
      parallelConcurrency: 1,
      registration: CORE_ONLY_REGISTRATION,
    });
    workers.setReceiptAuthority(runtime.receiptAuthority);
    const result = (await workers.execute(pending))[0];
    if (result === undefined) throw new Error("core-only worker produced no result");
    expect(artifacts.read(result.output_artifact).toString("utf8")).toBe(OUTPUT_TEXT);
    expect(artifacts.readById(result.output_artifact.artifact_id).toString("utf8")).toBe(
      OUTPUT_TEXT
    );
    expect(runtime.receiptAuthority.verify(result.worker_receipt)).toEqual(result.worker_receipt);

    const terminal = runtime.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result,
    });
    workers.acceptArtifact(result);
    expect(terminal).toMatchObject({ action: "complete", status: "complete", met: true });
    expect(checkpointer.receiptResult(result.worker_receipt)).toEqual(result);
    const admission = checkpointer.completionAdmission(runIdentity.run_id);
    expect(admission).toMatchObject({
      origin_state: "planning",
      latest_product: { selector: "terminal_result" },
    });

    const status = runtime.handle({ schema_version: 2, action: "status", identity: runIdentity });
    const recovered = engine(checkpointer, root).handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    expect(canonicalJson(status)).toBe(canonicalJson(terminal));
    expect(canonicalJson(recovered)).toBe(canonicalJson(terminal));
    expect(client.invocations[0]?.registration.workflow_name).toBe(CORE_ONLY_PLAYBOOK_NAME);
  });

  it("chains an exact Research semantic core into the compatible typed fixture port", () => {
    const root = temporaryRoot();
    using checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL("./fixtures/skills/research/positive-vectors.json", import.meta.url),
        "utf8"
      )
    );
    if (
      fixture === null ||
      typeof fixture !== "object" ||
      Array.isArray(fixture) ||
      !("grounded_synthesis" in fixture)
    ) {
      throw new Error("grounded synthesis fixture is unavailable");
    }
    const core = validateGroundedSynthesis(fixture.grounded_synthesis);
    const ref = artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "prior-research-run",
        phase: "sealing_core",
        branch_id: null,
        kind: "semantic-core",
        operation_id: "prior-research-core",
        version: 1,
        producer: "host:research-core",
        media_type: "application/json",
        content_schema: { schema_id: "penny.grounded-synthesis.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(core),
    });
    const runtime = engine(checkpointer, root, artifacts);
    const runIdentity = identity("run-core-only-typed-chain");
    const pending = requireInvocation(
      runtime.handle({
        schema_version: 2,
        action: "start",
        identity: runIdentity,
        goal: "Consume the prior typed product.",
        constraints: {},
        project_root: root,
        trust_profile: "hardened-untrusted",
        input_artifacts: {
          schema_version: 2,
          artifacts: [{ slot: "previous-skill-terminal-output", ref }],
        },
      })
    );
    expect(pending.input_artifacts.artifacts.map((binding) => binding.ref)).toEqual([ref]);
  });

  it("rejects its closed fixture request before run or model work", () => {
    const root = temporaryRoot();
    using checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const runtime = engine(checkpointer, root);
    const runIdentity = identity("run-core-only-invalid-request");
    expect(() =>
      runtime.handle({
        schema_version: 2,
        action: "start",
        identity: runIdentity,
        goal: "Reject unknown fixture request fields.",
        constraints: { unknown: true },
        project_root: root,
        trust_profile: "hardened-untrusted",
      })
    ).toThrow(/closed empty object/u);
    expect(checkpointer.runExists(runIdentity.run_id)).toBe(false);
  });

  it("persists cancellation as an exact durable negative terminal", () => {
    const root = temporaryRoot();
    using checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const runtime = engine(checkpointer, root);
    const runIdentity = identity("run-core-only-cancelled");
    requireInvocation(
      runtime.handle({
        schema_version: 2,
        action: "start",
        identity: runIdentity,
        goal: "Prove durable core-only cancellation.",
        constraints: {},
        project_root: root,
        trust_profile: "trusted-interactive",
      })
    );
    const cancelled = runtime.handle({
      schema_version: 2,
      action: "cancel",
      identity: runIdentity,
      reason: "deterministic fixture cancellation",
    });
    expect(cancelled).toMatchObject({
      action: "cancelled",
      status: "cancelled",
      met: false,
    });
    const recovered = engine(checkpointer, root).handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    expect(canonicalJson(recovered)).toBe(canonicalJson(cancelled));
    expect(checkpointer.loadRun(runIdentity).terminalDirective).toEqual(cancelled);
  });

  it("has no optional capability and never enters the shipped registry", () => {
    const playbook = new CoreOnlyPlaybook();
    expect(hasFanAggregate(playbook)).toBe(false);
    expect(hasRoutingRepair(playbook)).toBe(false);
    expect(hasLivenessTerminal(playbook)).toBe(false);
    expect(hasStateAwareRepair(playbook)).toBe(false);
    expect(hasGenericResponsePolicy(playbook)).toBe(false);
    expect(hasExternalStartOperationGroup(playbook)).toBe(false);
    expect(hasHostReviewedGateValidation(playbook)).toBe(false);
    expect(hasApprovedPromotionCompletion(playbook)).toBe(false);
    expect(hasReviewInvalidation(playbook)).toBe(false);
    expect(PLAYBOOK_REGISTRY.has(CORE_ONLY_PLAYBOOK_NAME)).toBe(false);
  });
});
