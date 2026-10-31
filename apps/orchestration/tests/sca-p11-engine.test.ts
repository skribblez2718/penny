import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, Checkpointer } from "../dist/checkpointer.js";
import type { ArtifactRef, JsonValue, StartRequest } from "../dist/contracts.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../dist/model-client.js";
import { buildAgentOpening } from "../dist/model-client.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { RunContext } from "../dist/context.js";
import { OrchestrationRunner, WorkerExecutor } from "../dist/worker.js";
import { createScaP11ReportingProductionCompositionV1 } from "../dist/sca/p11-production-host.js";
import type { PlaybookRegistration } from "../dist/playbooks/registry.js";
import { SCA_P11_CANDIDATE_PLAYBOOK_NAME } from "../dist/sca/p11-playbook.js";
import {
  SCA_P11_REPAIRING_STATE,
  SCA_P11_REQUIRED_MODEL,
  SCA_P11_REVIEWING_STATE,
  validateScaP11CognitivePayloadV1,
  validateScaP11ReportJsonV1,
  validateScaP11TerminalV1,
  type ScaP11CandidateStartV1,
} from "../dist/sca/p11-contracts.js";
import {
  buildScaP11Lineage,
  slotsForP11,
  stubScaP11RepairPatch,
  stubScaP11ReviewOutput,
  persistScaP11FixtureQualification,
} from "./sca-p11-lineage.js";
import { asTerminal, type P11TerminalDirective } from "./sca-p11-harness.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p11-engine-"));
  roots.push(root);
  return root;
}
function terminalBody(directive: P11TerminalDirective): Record<string, JsonValue> {
  const { liveness: _liveness, ...body } = directive.result;
  return body;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}

/** Provider-free scripted reviewer: opens an actionable item on revision 1 and repairs it once. */
class ScriptedP11ModelClient implements ModelClient {
  readonly states: string[] = [];
  constructor(private readonly store: ArtifactStore) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.states.push(invocation.stateId);
    // Satisfy the exact required-model and provider-opening guard hooks exactly as the real Pi
    // model client would, so the worker admits the guarded phase without any live provider call.
    invocation.admitResolvedModel?.({
      provider: SCA_P11_REQUIRED_MODEL.provider,
      model: SCA_P11_REQUIRED_MODEL.model,
    });
    const appendix = invocation.providerOpeningAppendix?.();
    const opening = buildAgentOpening({
      invocation,
      registration: invocation.registration,
      agentGuidance: "registration-bound",
      domainGuidance: "registration-bound",
      activeToolNames: [],
      ...(appendix === undefined ? {} : { providerOpeningAppendix: appendix }),
    });
    invocation.guardModelDispatch?.(opening);
    const payloadRef = required(
      invocation.inputArtifacts.find((ref) => ref.kind === "sca-p11-cognitive-payload"),
      "scripted payload"
    );
    const payload = validateScaP11CognitivePayloadV1(
      JSON.parse(this.store.readById(payloadRef.artifact_id).toString("utf8"))
    );
    if (invocation.stateId === SCA_P11_REVIEWING_STATE) {
      const base = validateScaP11ReportJsonV1(
        JSON.parse(this.store.readById(payload.report_ref.artifact_id).toString("utf8"))
      );
      const finding = required(base.findings[0], "scripted base finding");
      const review = stubScaP11ReviewOutput({
        run_id: payload.run_id,
        report_ref: payload.report_ref,
        payload: { ...payload, revision: payload.revision },
        ...(payload.revision === 1
          ? {
              open_items: [
                {
                  open_item_id: "p11openitem_scripted_0001",
                  target_id: finding.finding_id,
                  severity: "actionable" as const,
                  evidence_refs: [] as ArtifactRef[],
                  disposition: "retained-incomplete" as const,
                },
              ],
            }
          : {}),
      });
      return {
        text: `SUMMARY:${canonicalJson({ confidence: "CERTAIN", ...review })}`,
        confidence: "CERTAIN",
        details: review,
      };
    }
    if (invocation.stateId === SCA_P11_REPAIRING_STATE) {
      const base = validateScaP11ReportJsonV1(
        JSON.parse(this.store.readById(payload.report_ref.artifact_id).toString("utf8"))
      );
      const finding = required(base.findings[0], "scripted base finding");
      const patch = stubScaP11RepairPatch({
        run_id: payload.run_id,
        payload: {
          revision: payload.revision,
          payload_sha256: payload.payload_sha256,
          report_ref: payload.report_ref,
        },
        operations: [
          {
            operation: "rewrite_prose",
            target_id: finding.finding_id,
            field: "description",
            value: "Repaired by the scripted provider-free reviewer.",
          },
        ],
      });
      return {
        text: `SUMMARY:${canonicalJson({ confidence: "CERTAIN", ...patch })}`,
        confidence: "CERTAIN",
        details: patch,
      };
    }
    throw new Error(`unexpected scripted P11 state '${invocation.stateId}'`);
  }
}

interface EngineHarness {
  readonly root: string;
  readonly artifacts: ArtifactStore;
  readonly model: ScriptedP11ModelClient;
  readonly registration: PlaybookRegistration;
  readonly checkpointer: Checkpointer;
  readonly engine: OrchestrationEngine;
  readonly runner: OrchestrationRunner;
}

function engineHarness(input: {
  readonly root: string;
  readonly artifacts: ArtifactStore;
  readonly registration: PlaybookRegistration;
  readonly model: ScriptedP11ModelClient;
  readonly checkpointer?: Checkpointer;
}): EngineHarness {
  const checkpointer =
    input.checkpointer ?? new Checkpointer(path.join(input.root, "orchestration.db"));
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: input.root,
    maxSteps: 128,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactStore: input.artifacts,
    artifactReader: input.artifacts,
    artifactRevisions: input.artifacts,
    playbookRegistration: input.registration,
    trustedClock: () => new Date("2026-10-02T00:00:06.000Z"),
  });
  const workers = new WorkerExecutor(input.model, input.artifacts, {
    projectRoot: input.root,
    parallelConcurrency: 1,
    registration: input.registration,
  });
  const runner = new OrchestrationRunner(engine, workers);
  return {
    root: input.root,
    artifacts: input.artifacts,
    model: input.model,
    registration: input.registration,
    checkpointer,
    engine,
    runner,
  };
}

function startRequest(input: {
  readonly root: string;
  readonly runId: string;
  readonly constraints: ScaP11CandidateStartV1;
}): StartRequest {
  const constraints = input.constraints;
  return {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: `session-${input.runId}`,
      playbook: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise the inactive P11 reporting candidate through the real engine.",
    constraints,
    project_root: input.root,
    trust_profile: "hardened-untrusted",
    input_artifacts: {
      schema_version: 2,
      artifacts: slotsForP11(constraints),
    },
  };
}

function registration(
  store: ArtifactStore,
  runId: string,
  repairBudget: number
): PlaybookRegistration {
  return createScaP11ReportingProductionCompositionV1({
    store,
    scorer_qualification_ref: persistScaP11FixtureQualification(store, runId),
    repair_budget: repairBudget,
  }).registration;
}

describe("SCA P11 real-engine lifecycle", () => {
  it("runs the provider-free review/repair path, then replays byte-identically after restart with no new calls", async () => {
    const root = tempRoot();
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const runId = "run-p11-engine-complete";
    const lineage = buildScaP11Lineage({
      store: artifacts,
      run_id: runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: true,
    });
    const model = new ScriptedP11ModelClient(artifacts);
    const harness = engineHarness({
      root,
      artifacts,
      registration: registration(artifacts, runId, 1),
      model,
    });
    const request = startRequest({ root, runId, constraints: lineage.constraints });
    const terminal = await harness.runner.runUntilBoundary(harness.engine.handle(request));
    expect(terminal.action).toBe("incomplete");
    const result = validateScaP11TerminalV1(terminalBody(asTerminal(terminal)));
    expect(result.status).toBe("reporting_complete");
    expect(result.phase_gate_passed).toBe(false);
    expect(result.release_eligible).toBe(false);

    // Exactly one review and one repair provider opening; the child revision exists and no third.
    expect(model.states).toEqual([
      SCA_P11_REVIEWING_STATE,
      SCA_P11_REPAIRING_STATE,
      SCA_P11_REVIEWING_STATE,
    ]);
    expect(
      artifacts.refFor(runId, "SCA-P11", null, "sca-p11-report-json", "sca-p11-report-json", 2)
    ).not.toBeNull();
    expect(
      artifacts.refFor(runId, "SCA-P11", null, "sca-p11-report-json", "sca-p11-report-json", 3)
    ).toBeNull();
    const calls = model.states.length;

    // Restart: reopen the durable checkpoint, re-derive the exact terminal, and make zero new calls.
    harness.checkpointer.close();
    const reopened = new Checkpointer(path.join(root, "orchestration.db"));
    const restart = engineHarness({
      root,
      artifacts,
      registration: registration(artifacts, runId, 1),
      model,
      checkpointer: reopened,
    });
    const recovered = await restart.runner.runUntilBoundary(
      restart.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: request.identity,
      })
    );
    expect(recovered.action).toBe("incomplete");
    expect(canonicalJson(terminalBody(asTerminal(recovered)))).toBe(
      canonicalJson(terminalBody(asTerminal(terminal)))
    );
    expect(model.states.length).toBe(calls);
    expect(reopened.loadRunById(runId)?.status).toBe("incomplete");
    reopened.close();
  }, 60_000);

  it("cancellation durably emits a non-positive terminal with no report and zero provider calls", async () => {
    const root = tempRoot();
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const runId = "run-p11-engine-cancel";
    const lineage = buildScaP11Lineage({
      store: artifacts,
      run_id: runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: true,
    });
    const model = new ScriptedP11ModelClient(artifacts);
    const harness = engineHarness({
      root,
      artifacts,
      registration: registration(artifacts, runId, 1),
      model,
    });
    const request = startRequest({ root, runId, constraints: lineage.constraints });
    const initial = harness.engine.handle(request);
    expect(initial.action).toBe("invoke_agent");
    const identity = request.identity;
    const cancelled = harness.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity,
      reason: "operator cancelled before any provider opening",
    });
    expect(cancelled.action).toBe("cancelled");
    const terminal = validateScaP11TerminalV1(terminalBody(asTerminal(cancelled)));
    expect(terminal.status).toBe("cancelled");
    expect(terminal.report_ref).toBeNull();
    expect(terminal.p12_transition_ref).toBeNull();
    expect(model.states.length).toBe(0);

    harness.checkpointer.close();
    const reopened = new Checkpointer(path.join(root, "orchestration.db"));
    const restart = engineHarness({
      root,
      artifacts,
      registration: registration(artifacts, runId, 1),
      model,
      checkpointer: reopened,
    });
    const recovered = restart.engine.handle({ schema_version: 2, action: "recover", identity });
    expect(recovered.action).toBe("cancelled");
    expect(canonicalJson(terminalBody(asTerminal(recovered)))).toBe(
      canonicalJson(terminalBody(asTerminal(cancelled)))
    );
    expect(model.states.length).toBe(0);
    reopened.close();
  }, 60_000);

  it("declares a renewable deterministic-host liveness lease and never exhausts it on a completed run", async () => {
    const root = tempRoot();
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const runId = "run-p11-engine-liveness";
    const reg = registration(artifacts, runId, 1);
    const lineage = buildScaP11Lineage({
      store: artifacts,
      run_id: runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: true,
    });
    const model = new ScriptedP11ModelClient(artifacts);
    const harness = engineHarness({ root, artifacts, registration: reg, model });
    const livenessRun = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: "run-p11-liveness-policy",
        session_id: "session-p11-liveness-policy",
        playbook: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      },
      goal: "Resolve the deterministic-host liveness policy.",
      constraints: {},
      projectRoot: root,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
      initialArtifacts: [],
    });
    const policy = required(reg.liveness.resolve(livenessRun), "liveness policy");
    if (policy.schema_version !== 3) throw new Error("expected a v3 progress-lease policy");
    expect(policy).toMatchObject({
      schema_version: 3,
      preset: "deterministic-host",
      scope: "sca-p11-candidate",
      lease_registry_id: "penny-inactivity-leases-v1",
      renewal_policy: "trusted_host_activity_or_convergence_v1",
    });
    expect(Number.isFinite(policy.unknown_provider_phase_inactivity_ms)).toBe(true);
    expect(policy.unknown_provider_phase_inactivity_ms).toBeGreaterThan(0);
    const terminal = await harness.runner.runUntilBoundary(
      harness.engine.handle(startRequest({ root, runId, constraints: lineage.constraints }))
    );
    expect(terminal.action).toBe("incomplete");
    // The completed run leaves no open worker lease behind.
    expect(harness.engine.liveness.recoverOpenWorkers(runId)).toBeNull();
    harness.checkpointer.close();
  }, 60_000);
});
