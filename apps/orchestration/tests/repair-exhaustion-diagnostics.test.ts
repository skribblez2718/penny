import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { Checkpointer, canonicalJson, sha256 } from "../dist/checkpointer.js";
import {
  validateDirective,
  type ArtifactRef,
  type Directive,
  type EvaluationResult,
  type JsonValue,
  type PhaseResult,
  type RunIdentity,
  type SkillContract,
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { OrchestrationEngine } from "../dist/engine.js";
import type { Playbook } from "../dist/playbooks/playbook.js";
import type { PlaybookRegistration } from "../dist/playbooks/registry.js";
import { RESEARCH_SKILL_CONTRACT } from "../dist/playbooks/research.js";
import { trustedInvocationDigest } from "../dist/receipts.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const identity: RunIdentity = {
  schema_version: 2,
  run_id: "run_repair_diagnostics",
  session_id: "session_repair_diagnostics",
  playbook: "repair-diagnostics-test",
  engine_owner: "typescript",
};
const contract: SkillContract = {
  ...RESEARCH_SKILL_CONTRACT,
  name: identity.playbook,
  repair_routing: {
    schema_version: 1,
    routes: [
      {
        schema_version: 1,
        origin_state: "verifying",
        feedback_kind: "product_gap",
        repair: { action: "transition", target_state: "verifying" },
        budget: { counter: "iteration", limit_source: "run.max_iterations", reserved_attempts: 0 },
        on_exhaustion: { action: "transition", target_state: "incomplete", reset_counter: false },
      },
    ],
  },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: ["verifying"],
    required_visited_states: ["verifying"],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: "penny.orchestration.terminal-result",
      product_schema_version: 2,
    },
    unresolved_policy: { mode: "allow_any" },
  },
};

function terminal(context: RunContext, success: boolean): Directive {
  const action = success ? "complete" : "incomplete";
  context.previousState = context.stateId;
  context.stateId = action;
  context.status = action;
  context.met = success;
  const partial = context.selectedArtifacts.find((ref) => ref.kind === "partial-product");
  const next = validateDirective({
    schema_version: 2,
    action,
    identity: context.identity,
    status: action,
    met: success,
    result: {
      met: success,
      output_artifact_ref: partial ?? null,
      best_partial_artifact_refs: partial ? [partial] : [],
    },
    artifacts: partial ? [partial] : [],
    unresolved: success ? [] : ["repair budget exhausted at verifying:product_gap"],
  });
  context.pendingDirective = next;
  context.terminalDirective = next;
  return next;
}

class RepairPlaybook implements Playbook {
  initialize(context: RunContext): Directive {
    context.transition("verifying");
    return this.dispatch(context);
  }
  dispatch(context: RunContext): Directive {
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: "verifying",
      agent: "vera",
      attempt: context.iteration + 1,
      task: "Review the current product.",
      trust_profile: context.trustProfile,
      input_artifacts: { schema_version: 2, artifacts: [] },
      output_artifact: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: "verifying",
        branch_id: null,
        kind: context.constraints.no_report === true ? "routing-metadata" : "agent-output",
        operation_id: `review-${context.iteration + 1}`,
        version: 1,
        producer: "agent:vera",
        media_type: "text/plain",
        parent_ref: null,
        upstream_refs: [],
      },
    });
    context.pendingDirective = next;
    return next;
  }
  resume(context: RunContext, _response: JsonValue): Directive {
    return this.dispatch(context);
  }
  cancel(context: RunContext): Directive {
    return terminal(context, false);
  }
  validateDetails(_state: string, details: Record<string, JsonValue>): Record<string, JsonValue> {
    return details;
  }
  acceptSummary(context: RunContext, _details: Record<string, JsonValue>): Directive {
    return terminal(context, true);
  }
  evaluateRepair(
    _context: RunContext,
    _state: string,
    details: Record<string, JsonValue>
  ): EvaluationResult | null {
    return details.verdict === "PASS"
      ? null
      : {
          schema_version: 2,
          kind: "product_gap",
          detail: "Needs work",
          findings: [],
          strategy_delta: "Revise the product",
        };
  }
  terminalizeRepairExhaustion(context: RunContext): Directive {
    return terminal(context, false);
  }
  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}

function setup(
  noReport = false,
  limits: { maxSteps: number | null; maxIterations: number | null } = {
    maxSteps: 20,
    maxIterations: 1,
  }
) {
  const root = mkdtempSync(path.join(tmpdir(), "penny-repair-diagnostics-"));
  roots.push(root);
  const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
  const store = ArtifactStore.provision(path.join(root, "artifacts"));
  const registration: PlaybookRegistration = {
    name: identity.playbook,
    contract,
    ingress: "dedicated_tool",
    liveness: {
      resolver_id: contract.budget_policy.resolver_id,
      resolve: () => undefined,
      thinking_policy: "agent_ssot",
    },
    worker: {
      kind: "catalog-agent",
      workflow_name: identity.playbook,
      guidance: contract.guidance,
      guidance_required: true,
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
      phases: new Map([
        [
          "verifying",
          {
            agent: "vera",
            result_schema_id: "penny.test.verdict",
            result_schema_version: 1,
            schema: Type.Object({
              verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]),
            }),
          },
        ],
      ]),
    },
    completionReceiptPredicates: new Map(),
    construct: () => new RepairPlaybook(),
  };
  const engine = new OrchestrationEngine(checkpointer, {
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    projectRoot: root,
    maxSteps: limits.maxSteps,
    playbookName: identity.playbook,
    playbookRegistry: new Map([[identity.playbook, registration]]),
  });
  const first = engine.handle({
    schema_version: 2,
    action: "start",
    identity,
    goal: "Review",
    constraints: { max_iterations: limits.maxIterations, no_report: noReport },
    project_root: root,
    trust_profile: "trusted-interactive",
  });
  if (first.action !== "invoke_agent") throw new Error("expected review assignment");
  return { engine, checkpointer, store, root, first };
}

function result(
  engine: OrchestrationEngine,
  store: ArtifactStore,
  root: string,
  pending: Extract<Directive, { action: "invoke_agent" }>,
  verdict: "PASS" | "FAIL"
): PhaseResult {
  const details = { verdict };
  const output = store.persist({
    metadata: pending.output_artifact,
    content: `review ${pending.attempt}: ${verdict}`,
  });
  const digest = output.content_digest;
  const receipt = engine.receiptAuthority.sign({
    schema_version: 2,
    receipt_id: `receipt_${pending.attempt}`,
    run_id: identity.run_id,
    state_id: pending.state_id,
    branch_id: null,
    agent: pending.agent,
    attempt: pending.attempt,
    worker_id: "worker_test",
    executor: "pi-sdk",
    command: ["pi-sdk", pending.agent],
    model: null,
    working_directory: root,
    trust_profile: pending.trust_profile,
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:00.000Z",
    exit_code: 0,
    output_digest: digest,
    output_artifact_ref: output,
    trusted_invocation_digest: trustedInvocationDigest({
      identity,
      state_id: pending.state_id,
      branch_id: null,
      agent: pending.agent,
      attempt: pending.attempt,
      trust_profile: pending.trust_profile,
      model_override: null,
      task_sha256: sha256(pending.task),
      input_artifacts: pending.input_artifacts,
      output_artifact: pending.output_artifact,
    }),
  });
  return {
    schema_version: 2,
    run_id: identity.run_id,
    state_id: pending.state_id,
    agent: pending.agent,
    attempt: pending.attempt,
    confidence: "CERTAIN",
    details,
    output_artifact: output,
    worker_receipt: receipt,
  };
}

describe("shared semantic repair exhaustion diagnostics", () => {
  it.each([
    [null, 9, 9],
    [5, null, 5],
    [5, 9, 5],
    [9, 5, 5],
    [null, null, null],
  ] as const)(
    "intersects explicit host %s and caller %s policy without inventing a default",
    (host, caller, expected) => {
      const context = RunContext.create({
        identity,
        goal: "Policy intersection",
        constraints: { max_iterations: caller },
        maxIterations: host,
        projectRoot: "/fixture",
        trustProfile: "trusted-interactive",
      });
      expect(context.maxIterations).toBe(expected);
      expect(RunContext.fromSnapshot(context.snapshot()).snapshot()).toEqual(context.snapshot());
    }
  );

  it("continues productive repairs beyond former iteration and 96-step ceilings, with exact restart and replay", () => {
    const { engine, checkpointer, store, root, first } = setup(false, {
      maxSteps: null,
      maxIterations: null,
    });
    let pending = first;
    for (let index = 0; index < 105; index += 1) {
      const accepted = result(engine, store, root, pending, "FAIL");
      const next = engine.handle({ schema_version: 2, action: "step", identity, result: accepted });
      if (next.action !== "invoke_agent") throw new Error(`repair ${index} terminated`);
      // Exact receipt replay cannot charge a second iteration.
      expect(
        engine.handle({ schema_version: 2, action: "step", identity, result: accepted })
      ).toEqual(next);
      pending = next;
    }
    const snapshot = checkpointer.loadRun(identity).snapshot();
    expect(snapshot).toMatchObject({
      max_steps: null,
      max_iterations: null,
      iteration: 105,
      step_count: 106,
    });
    expect(RunContext.fromSnapshot(snapshot).snapshot()).toEqual(snapshot);
    expect(
      checkpointer
        .events(identity.run_id)
        .some((event) => event.payload.feedback_route_evidence_v1 !== undefined)
    ).toBe(true);
    const terminal = engine.handle({
      schema_version: 2,
      action: "step",
      identity,
      result: result(engine, store, root, pending, "PASS"),
    });
    expect(terminal).toMatchObject({ action: "complete", met: true });
    expect(engine.handle({ schema_version: 2, action: "recover", identity })).toEqual(terminal);
    store.close();
    checkpointer.close();
  });

  it("enforces an explicit step ceiling without replacing an unspecified iteration limit", () => {
    const { engine, checkpointer, store, root, first } = setup(false, {
      maxSteps: 2,
      maxIterations: null,
    });
    const next = engine.handle({
      schema_version: 2,
      action: "step",
      identity,
      result: result(engine, store, root, first, "FAIL"),
    });
    if (next.action !== "invoke_agent") throw new Error("explicit limit stopped too soon");
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "step",
        identity,
        result: result(engine, store, root, next, "FAIL"),
      })
    ).toThrow("max_steps=2");
    expect(checkpointer.loadRun(identity).stepCount).toBe(2);
    store.close();
    checkpointer.close();
  });

  it("binds only the current receipt report, preserves partial/negative truth and recovers the exact terminal", () => {
    const { engine, checkpointer, store, root, first } = setup();
    const initial = checkpointer.loadRun(identity);
    const stale = result(engine, store, root, first, "FAIL").output_artifact;
    if (stale === undefined) throw new Error("missing stale ref");
    if (initial === undefined) throw new Error("missing run");
    const partial: ArtifactRef = {
      ...stale,
      artifact_id: `art_${"b".repeat(64)}`,
      phase: "authoring",
      kind: "partial-product",
      content_digest: "b".repeat(64),
      store_ref: `artifact://sha256/${"b".repeat(64)}`,
    };
    initial.selectedArtifacts.push(partial, stale);
    checkpointer.saveRun(initial, "test_selected_refs", {});
    const repair = engine.handle({
      schema_version: 2,
      action: "step",
      identity,
      result: result(engine, store, root, first, "FAIL"),
    });
    if (repair.action !== "invoke_agent") throw new Error("expected repair");
    const current = result(engine, store, root, repair, "FAIL");
    // A worker-proposed ref is not a diagnostic identity, even if it names a selected artifact.
    current.details.feedback_report_refs = [stale];
    const exhausted = engine.handle({
      schema_version: 2,
      action: "step",
      identity,
      result: current,
    });
    if (exhausted.action !== "incomplete") throw new Error("expected exhaustion");
    expect(exhausted).toMatchObject({
      status: "incomplete",
      met: false,
      result: {
        output_artifact_ref: partial,
        best_partial_artifact_refs: [partial],
        repair_diagnostics: {
          origin_state: "verifying",
          feedback_kind: "product_gap",
          budget: { used: 1, limit: 1 },
          feedback_report_refs: [current.output_artifact],
        },
      },
    });
    expect(store.readById(current.output_artifact.artifact_id).toString()).toBe("review 2: FAIL");
    expect(JSON.stringify(exhausted)).not.toContain("review 2: FAIL");
    expect(JSON.stringify(exhausted)).not.toContain("Revise the product");
    const persisted = checkpointer.loadRun(identity);
    if (persisted === undefined) throw new Error("missing persisted run");
    expect(canonicalJson(persisted.pendingDirective)).toBe(canonicalJson(exhausted));
    expect(canonicalJson(persisted.terminalDirective)).toBe(canonicalJson(exhausted));
    expect(engine.handle({ schema_version: 2, action: "recover", identity })).toEqual(exhausted);
  });
  it("records an empty report list when the receipt is routing metadata, not a report", () => {
    const { engine, store, root, first } = setup(true);
    const retry = engine.handle({
      schema_version: 2,
      action: "step",
      identity,
      result: result(engine, store, root, first, "FAIL"),
    });
    if (retry.action !== "invoke_agent") throw new Error("expected retry");
    const exhausted = engine.handle({
      schema_version: 2,
      action: "step",
      identity,
      result: result(engine, store, root, retry, "FAIL"),
    });
    if (exhausted.action !== "incomplete") throw new Error("expected exhausted terminal");
    expect(exhausted.result.repair_diagnostics).toMatchObject({ feedback_report_refs: [] });
  });

  it("does not attach repair diagnostics to a successful terminal", () => {
    const { engine, store, root, first } = setup();
    const completed = engine.handle({
      schema_version: 2,
      action: "step",
      identity,
      result: result(engine, store, root, first, "PASS"),
    });
    expect(completed.action).toBe("complete");
    if ("result" in completed) expect(completed.result.repair_diagnostics).toBeUndefined();
  });
});
