import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DECIDE_CANDIDATE_REGISTRATION,
  DECIDE_PLAYBOOK_NAME,
  DECIDE_UNSEALED_EVALUATION_NAME,
  DECIDE_UNSEALED_EVALUATION_REGISTRATION,
  DecidePlaybook,
  OrchestrationService,
  canonicalJson,
  initializePennyState,
  validateEvidenceAdmission,
  validateDecision,
  validateDecisionProductEnvelope,
  validateDecisionProductIntegrity,
  validateReviewReceipt,
  type AgentCompletion,
  type AgentInvocation,
  type Directive,
  type JsonValue,
  type ModelClient,
  type PlaybookRegistrationV1,
} from "../src/index.js";
import {
  decisionDraft,
  decisionRequest,
  persistedDecisionDraft,
} from "./fixtures/decision-fixtures.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
let sequence = 0;

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-decide-playbook-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return env;
}

function identity(runId: string, playbook = DECIDE_PLAYBOOK_NAME) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook,
    engine_owner: "typescript" as const,
  };
}

function start(runId: string, playbook = DECIDE_PLAYBOOK_NAME) {
  const request = decisionRequest();
  const { decision_question: goal, ...constraints } = request;
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId, playbook),
    goal,
    constraints,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}

class ScriptedDecideClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private next = 0;

  constructor(private readonly outputs: readonly string[]) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const output = this.outputs[this.next];
    this.next += 1;
    if (output === undefined) throw new Error("scripted Decide output is exhausted");
    return { text: output };
  }
}

type TerminalDirective = Extract<Directive, { result: Record<string, JsonValue> }>;

function completeDirective(value: Directive): TerminalDirective {
  if (value.action !== "complete") {
    throw new Error(`expected complete directive, received '${value.action}'`);
  }
  return value;
}

function outputRef(value: TerminalDirective) {
  const ref = value.result.output_artifact_ref;
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
    throw new Error("terminal output ref is absent");
  }
  return ref;
}

function summary(details: Record<string, JsonValue>): string {
  return `Report body.\nSUMMARY:${JSON.stringify({ confidence: "PROBABLE", ...details })}`;
}

function routingOnly(output: string): string {
  const marker = output.lastIndexOf("SUMMARY:");
  if (marker < 0) throw new Error("scripted routing summary is absent");
  return output.slice(marker);
}

function analysisPass(label = "All alternatives mapped."): string {
  return summary({
    analysis_complete: true,
    gap_kind: "none",
    repair_owner: "none",
    findings: [label],
    strategy_delta: "Proceed with the bounded decision assessment.",
  });
}

function analysisEvidenceGap(): string {
  return summary({
    analysis_complete: false,
    gap_kind: "evidence_gap",
    repair_owner: "echo",
    findings: ["The admitted quote evidence must be inspected."],
    strategy_delta: "Inspect the exact admitted quote source only.",
  });
}

function evidencePacket(): string {
  return summary({
    evidence_complete: false,
    findings: ["The admitted source does not contain the final quote."],
    unresolved: ["Option B's final quote remains absent."],
  });
}

function veraPass(): string {
  return summary({
    verdict: "PASS",
    gap_kind: "none",
    repair_owner: "none",
    findings: [],
    evidence: ["Exact latest DecisionV2 satisfies request and lineage checks."],
    strategy_delta: "Advance the exact product to independent quality critique.",
  });
}

function veraGap(kind: "evidence_gap" | "analysis_gap" | "product_gap"): string {
  const owner = kind === "evidence_gap" ? "echo" : kind === "analysis_gap" ? "annie" : "demetri";
  return summary({
    verdict: "FAIL",
    gap_kind: kind,
    repair_owner: owner,
    findings: [`Vera found a ${kind}.`],
    evidence: ["Exact latest product check failed."],
    strategy_delta: `Repair the ${kind} and preserve exact lineage.`,
  });
}

function carrenApprove(minor = false): string {
  return summary({
    verdict: "APPROVE",
    gap_kind: "none",
    repair_owner: "none",
    findings: minor ? [{ severity: "minor", message: "One phrase could be shorter." }] : [],
    evidence: ["The Vera-passed decision is balanced and decision-useful."],
    strategy_delta: "Approve the exact latest product.",
  });
}

function carrenGap(kind: "evidence_gap" | "analysis_gap" | "product_gap"): string {
  const owner = kind === "evidence_gap" ? "echo" : kind === "analysis_gap" ? "annie" : "demetri";
  return summary({
    verdict: "NEEDS_REVISION",
    gap_kind: kind,
    repair_owner: owner,
    findings: [{ severity: "major", message: `Carren found a ${kind}.` }],
    evidence: ["The exact latest product has a material quality defect."],
    strategy_delta: `Repair the ${kind} before another complete review cycle.`,
  });
}

function persistedDraftValue(draft: ReturnType<typeof decisionDraft>): string {
  const { rationale_report: rationaleReport, ...core } = draft;
  return `${rationaleReport}\nDECISION_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`;
}

function readJson(service: OrchestrationService, artifactId: string): unknown {
  return JSON.parse(service.artifacts.readById(artifactId).toString("utf8"));
}

function happyOutputs(outcome: Parameters<typeof persistedDecisionDraft>[0] = "selected") {
  return [analysisPass(), persistedDecisionDraft(outcome), veraPass(), carrenApprove(true)];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("orchestrated decide candidate", () => {
  it.each(["selected", "ranked", "no_feasible_option", "unresolved", "not_applicable"] as const)(
    "completes a reviewed canonical %s DecisionV2 and exact product envelope",
    async (outcome) => {
      const env = environment();
      const client = new ScriptedDecideClient(happyOutputs(outcome));
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
      });
      sequence += 1;
      const terminal = completeDirective(
        await service.execute(start(`run-decide-${outcome}-${sequence}`))
      );
      const ref = outputRef(terminal);
      expect(ref).toMatchObject({
        phase: "sealing_decision",
        kind: "semantic-core",
        producer: "host:decision-sealer",
        content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
      });
      expect(validateDecision(readJson(service, String(ref.artifact_id)))).toMatchObject({
        outcome,
        execution_started: false,
      });
      expect(terminal).toMatchObject({
        action: "complete",
        met: true,
        unresolved: [],
        result: { execution_started: false, execution_authorized: false },
      });
      expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
        "analyzing_decision",
        "deciding",
        "verifying_decision",
        "critiquing_decision",
      ]);
      expect(client.invocations.map((invocation) => invocation.agent)).toEqual([
        "annie",
        "demetri",
        "vera",
        "carren",
      ]);
      const admission = terminal.artifacts.find(
        (artifact) => artifact.kind === "evidence-admission"
      );
      const validity = terminal.artifacts.find(
        (artifact) => artifact.kind === "review-receipt" && artifact.branch_id === "validity"
      );
      const quality = terminal.artifacts.find(
        (artifact) => artifact.kind === "review-receipt" && artifact.branch_id === "quality"
      );
      const integrity = terminal.artifacts.find(
        (artifact) => artifact.kind === "decision-product-integrity"
      );
      const envelope = terminal.artifacts.find(
        (artifact) => artifact.kind === "decision-product-envelope"
      );
      if (
        admission === undefined ||
        validity === undefined ||
        quality === undefined ||
        integrity === undefined ||
        envelope === undefined
      ) {
        throw new Error("exact reviewed product graph is incomplete");
      }
      expect(validateEvidenceAdmission(readJson(service, admission.artifact_id))).toMatchObject({
        domain: "decision",
        classification: "basis_sufficient",
        evidence_required: false,
        source_artifact_ref: { phase: "analyzing_decision" },
      });
      expect(validateReviewReceipt(readJson(service, validity.artifact_id))).toMatchObject({
        review_kind: "validity",
        reviewer: "vera",
        verdict: "PASS",
      });
      expect(validateReviewReceipt(readJson(service, quality.artifact_id))).toMatchObject({
        review_kind: "quality",
        reviewer: "carren",
        verdict: "APPROVE",
        prior_review_receipt_ref: { artifact_id: validity.artifact_id },
      });
      expect(
        validateDecisionProductIntegrity(readJson(service, integrity.artifact_id))
      ).toMatchObject({
        status: "PASS",
        decision_ref: { artifact_id: ref.artifact_id },
        execution_started: false,
        execution_authorized: false,
        admission_ref: { artifact_id: admission.artifact_id },
      });
      expect(
        validateDecisionProductEnvelope(readJson(service, envelope.artifact_id))
      ).toMatchObject({
        status: "complete",
        decision_ref: { artifact_id: ref.artifact_id },
        integrity_ref: { artifact_id: integrity.artifact_id },
      });
      expect(service.checkpointer.completionAdmission(terminal.identity.run_id)).toBeDefined();
    }
  );

  it("routes only from persisted SUMMARY bytes and ignores forged completion details", async () => {
    const forged: ModelClient = {
      async runAgent(): Promise<AgentCompletion> {
        return {
          text: "Analysis body intentionally has no persisted routing summary.",
          confidence: "CERTAIN",
          details: {
            analysis_complete: true,
            gap_kind: "none",
            repair_owner: "none",
            findings: ["Forged metadata says complete."],
            strategy_delta: "This metadata must be ignored.",
          },
        };
      },
    };
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: forged,
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const assignment = service.handle(start(`run-decide-persisted-summary-${sequence}`));
    expect(assignment.action).toBe("invoke_agent");
    const [result] = await service.workers.execute(assignment);
    if (result === undefined) throw new Error("forged-details worker result is absent");
    expect(result.details).toEqual({});
    expect(
      service.artifacts.readById(result.output_artifact.artifact_id).toString("utf8")
    ).not.toContain("SUMMARY:");
  });

  it("routes one closed Annie evidence gap through Echo using admitted refs only", async () => {
    const env = environment();
    const client = new ScriptedDecideClient([
      analysisEvidenceGap(),
      evidencePacket(),
      persistedDecisionDraft("unresolved"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = completeDirective(
      await service.execute(start(`run-decide-evidence-gap-${sequence}`))
    );
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_decision",
      "gathering_decision_evidence",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
    ]);
    const echo = client.invocations[1];
    expect(echo?.agent).toBe("echo");
    expect(echo?.task).toContain("narrowly targeted read-only local inspection or web retrieval");
    expect(echo?.task).toContain("Record a precise source locator");
    expect(echo?.task).toContain("report the gap honestly as unresolved");
    expect(echo?.inputArtifacts.map((artifact) => artifact.phase)).toContain(
      "decision_evidence_gate"
    );
    expect(client.invocations[2]?.inputArtifacts.map((artifact) => artifact.phase)).toEqual(
      expect.arrayContaining(["decision_evidence_gate", "gathering_decision_evidence"])
    );
    expect(
      terminal.artifacts.some((artifact) => artifact.phase === "gathering_decision_evidence")
    ).toBe(true);
    const admission = terminal.artifacts.find((artifact) => artifact.kind === "evidence-admission");
    if (admission === undefined) throw new Error("decision evidence admission is absent");
    expect(validateEvidenceAdmission(readJson(service, admission.artifact_id))).toMatchObject({
      classification: "decision_sensitive_evidence_gap",
      evidence_required: true,
    });
    expect(
      validateDecision(readJson(service, String(outputRef(terminal).artifact_id))).outcome
    ).toBe("unresolved");
  });

  it("routes Vera product_gap to Demetri, reseals version 2, and re-verifies before Carren", async () => {
    const env = environment();
    const client = new ScriptedDecideClient([
      analysisPass(),
      persistedDecisionDraft("selected"),
      veraGap("product_gap"),
      persistedDecisionDraft("ranked"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = completeDirective(
      await service.execute(start(`run-decide-vera-product-gap-${sequence}`))
    );
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_decision",
      "deciding",
      "verifying_decision",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
    ]);
    expect(outputRef(terminal)).toMatchObject({ version: 2 });
    expect(
      validateDecision(readJson(service, String(outputRef(terminal).artifact_id))).outcome
    ).toBe("ranked");
    expect(client.invocations[3]?.inputArtifacts.map((artifact) => artifact.phase)).toEqual(
      expect.arrayContaining(["verifying_decision", "deciding"])
    );
  });

  it("routes Carren analysis_gap to Annie and invalidates the prior review chain", async () => {
    const env = environment();
    const client = new ScriptedDecideClient([
      analysisPass("Initial analysis."),
      persistedDecisionDraft("selected"),
      veraPass(),
      carrenGap("analysis_gap"),
      analysisPass("Replacement analysis repairs the quality gap."),
      persistedDecisionDraft("selected"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = completeDirective(
      await service.execute(start(`run-decide-carren-analysis-gap-${sequence}`))
    );
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_decision",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
      "analyzing_decision",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
    ]);
    expect(outputRef(terminal)).toMatchObject({ version: 2 });
    const validity = terminal.artifacts.find(
      (artifact) => artifact.kind === "review-receipt" && artifact.branch_id === "validity"
    );
    expect(validity).toMatchObject({ version: 2 });
    expect(
      terminal.artifacts.filter(
        (artifact) => artifact.kind === "review-receipt" && artifact.branch_id === "validity"
      )
    ).toHaveLength(1);
  });

  it("does not accept Carren APPROVE when a major finding is present", async () => {
    const majorApprove = summary({
      verdict: "APPROVE",
      gap_kind: "none",
      repair_owner: "none",
      findings: [{ severity: "major", message: "Material framing defect." }],
      evidence: ["The product overstates certainty."],
      strategy_delta: "Demetri must repair the product framing.",
    });
    const env = environment();
    const client = new ScriptedDecideClient([
      analysisPass(),
      persistedDecisionDraft("selected"),
      veraPass(),
      majorApprove,
      routingOnly(carrenGap("product_gap")),
      persistedDecisionDraft("selected"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = completeDirective(
      await service.execute(start(`run-decide-major-approve-${sequence}`))
    );
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_decision",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
      "critiquing_decision",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
    ]);
    expect(client.invocations[4]).toMatchObject({
      stateId: "critiquing_decision",
      executionPurpose: "routing_repair",
    });
    expect(outputRef(terminal)).toMatchObject({ version: 2 });
  });

  it("keeps request and orchestration refs out of semantic basis namespaces", async () => {
    const requestBasis = decisionDraft("selected");
    const env = environment();
    const client: ModelClient & { invocations: AgentInvocation[] } = {
      invocations: [],
      async runAgent(invocation) {
        this.invocations.push(invocation);
        if (invocation.stateId === "analyzing_decision") return { text: analysisPass() };
        const requestRef = invocation.inputArtifacts.find(
          (artifact) => artifact.kind === "decision-request"
        );
        if (requestRef === undefined) throw new Error("request ref absent");
        return {
          text: persistedDraftValue({
            ...requestBasis,
            basis_ids_used: [...requestBasis.basis_ids_used, requestRef.artifact_id],
          }),
        };
      },
    };
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-decide-request-basis-rejected-${sequence}`));
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_decision",
      "deciding",
      "deciding",
    ]);
  });

  it("recovers after host sealing persistence and continues the review graph", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistrationV1 = {
      ...DECIDE_CANDIDATE_REGISTRATION,
      construct: (options) =>
        new DecidePlaybook(
          true,
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === "sealing_decision:artifact-persistence") {
              interrupted = true;
              throw new Error("injected host interruption");
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-decide-recover-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDecideClient([analysisPass(), persistedDecisionDraft("selected")]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(/injected host interruption/u);
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_decision");
    }
    const recoveredClient = new ScriptedDecideClient([veraPass(), carrenApprove()]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    const terminal = completeDirective(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    expect(outputRef(terminal)).toMatchObject({ kind: "semantic-core", version: 1 });
    expect(recoveredClient.invocations.map((invocation) => invocation.stateId)).toEqual([
      "verifying_decision",
      "critiquing_decision",
    ]);
  });

  it("terminalizes repeated registered repair gaps honestly when the finite iteration budget is exhausted", async () => {
    const env = environment();
    const client = new ScriptedDecideClient([
      analysisPass(),
      persistedDecisionDraft("selected"),
      veraGap("product_gap"),
      persistedDecisionDraft("selected"),
      veraGap("product_gap"),
      persistedDecisionDraft("selected"),
      veraGap("product_gap"),
      persistedDecisionDraft("selected"),
      veraGap("product_gap"),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-decide-repair-exhaust-${sequence}`));
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        execution_started: false,
        execution_authorized: false,
        incomplete_reason: "repair_budget_exhausted",
        exhausted: true,
        exhaustion_reason: "verifying_decision:product_gap",
      },
    });
    if (terminal.action !== "incomplete") {
      throw new Error(`expected incomplete directive, received '${terminal.action}'`);
    }
    expect(terminal.unresolved).toEqual([
      "repair budget exhausted at verifying_decision:product_gap",
    ]);
    expect(
      client.invocations.filter((invocation) => invocation.stateId === "deciding")
    ).toHaveLength(4);
    expect(
      client.invocations.some((invocation) => invocation.stateId === "critiquing_decision")
    ).toBe(false);
  });

  it.each([
    {
      reason: "model_turn_budget_exhausted" as const,
      result: {
        incomplete_reason: "model_turn_budget_exhausted",
        exhausted: true,
        exhaustion_reason: "model_turn_budget_exhausted",
      },
    },
    {
      reason: "identical_error_stall" as const,
      result: {
        incomplete_reason: "identical_error_stall",
        stalled: true,
        stall_reason: "identical_error_stall",
      },
    },
  ])("preserves exact typed liveness reason $reason on incomplete", ({ reason, result }) => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedDecideClient([]),
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-decide-liveness-${reason}-${sequence}`;
    expect(service.handle(start(runId))).toMatchObject({ action: "invoke_agent" });
    const terminal = service.engine.exhaust(identity(runId), reason);
    expect(terminal).toMatchObject({
      action: "incomplete",
      status: "incomplete",
      met: false,
      result: {
        ...result,
        liveness: { terminal_reason: reason },
      },
      unresolved: [reason],
    });
  });

  it.each([
    {
      point: "verifying_decision:receipt-persistence",
      initial: [analysisPass(), persistedDecisionDraft("selected"), veraPass()],
      recovered: [carrenApprove()],
    },
    {
      point: "critiquing_decision:receipt-persistence",
      initial: [analysisPass(), persistedDecisionDraft("selected"), veraPass(), carrenApprove()],
      recovered: [],
    },
    {
      point: "critiquing_decision:integrity-persistence",
      initial: [analysisPass(), persistedDecisionDraft("selected"), veraPass(), carrenApprove()],
      recovered: [],
    },
    {
      point: "critiquing_decision:envelope-persistence",
      initial: [analysisPass(), persistedDecisionDraft("selected"), veraPass(), carrenApprove()],
      recovered: [],
    },
  ] as const)("recovers the deterministic host window after $point", async (scenario) => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistrationV1 = {
      ...DECIDE_CANDIDATE_REGISTRATION,
      construct: (options) =>
        new DecidePlaybook(
          true,
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === scenario.point) {
              interrupted = true;
              throw new Error(`injected interruption at ${point}`);
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-decide-window-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDecideClient(scenario.initial),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(/injected interruption/u);
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("critiquing_decision");
    }
    const recoveredClient = new ScriptedDecideClient(scenario.recovered);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    const terminal = completeDirective(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "review-receipt")
    ).toHaveLength(2);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "decision-product-integrity")
    ).toHaveLength(1);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "decision-product-envelope")
    ).toHaveLength(1);
    expect(recoveredClient.invocations.map((invocation) => invocation.stateId)).toEqual(
      scenario.recovered.length === 0 ? [] : ["critiquing_decision"]
    );
  });

  it("declares all engine-owned gap routes without reviewer-selected targets", () => {
    const routes = DECIDE_CANDIDATE_REGISTRATION.contract.repair_routing.routes;
    expect(
      routes.map(
        (route) => `${route.origin_state}:${route.feedback_kind}->${route.repair.target_state}`
      )
    ).toEqual([
      "analyzing_decision:evidence_gap->decision_evidence_gate",
      "verifying_decision:evidence_gap->analyzing_decision",
      "verifying_decision:analysis_gap->analyzing_decision",
      "verifying_decision:product_gap->deciding",
      "critiquing_decision:evidence_gap->analyzing_decision",
      "critiquing_decision:analysis_gap->analyzing_decision",
      "critiquing_decision:product_gap->deciding",
    ]);
    expect(routes.every((route) => route.on_exhaustion.target_state === "incomplete")).toBe(true);
    expect(routes.every((route) => route.on_exhaustion.reset_counter === false)).toBe(true);
  });

  it("fails closed when active or terminal replay uses a drifted candidate registration contract", async () => {
    const env = environment();
    sequence += 1;
    let activeIdentity: Directive["identity"];
    let terminal: TerminalDirective;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDecideClient(happyOutputs("selected")),
        playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
      });
      const active = service.handle(start(`run-decide-active-contract-binding-${sequence}`));
      expect(active.action).toBe("invoke_agent");
      activeIdentity = active.identity;
      terminal = completeDirective(
        await service.execute(start(`run-decide-terminal-contract-binding-${sequence}`))
      );
    }
    const worker = DECIDE_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
    const deciding = worker.phases.get("deciding");
    if (deciding === undefined) throw new Error("deciding registration phase is absent");
    const drifted: PlaybookRegistrationV1 = {
      ...DECIDE_CANDIDATE_REGISTRATION,
      worker: {
        ...worker,
        phases: new Map(worker.phases).set("deciding", {
          ...deciding,
          allowed_tools: ["artifact_read", "read"],
        }),
      },
    };
    using replay = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedDecideClient([]),
      playbookRegistration: drifted,
    });
    for (const identity of [activeIdentity, terminal.identity]) {
      for (const action of ["status", "recover"] as const) {
        expect(await replay.execute({ schema_version: 2, action, identity })).toMatchObject({
          action: "error",
          result: { code: "REGISTRATION_CONTRACT_MISMATCH", checkpoint_unchanged: true },
        });
      }
    }
  });

  it("refuses in-process mutation of the registration snapshot after start", () => {
    const worker = DECIDE_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
    const phases = new Map(worker.phases);
    const mutableRegistration: PlaybookRegistrationV1 = {
      ...DECIDE_CANDIDATE_REGISTRATION,
      worker: { ...worker, phases },
    };
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedDecideClient([]),
      playbookRegistration: mutableRegistration,
    });
    sequence += 1;
    const runId = `run-decide-in-process-registration-drift-${sequence}`;
    const pending = service.handle(start(runId));
    expect(pending.action).toBe("invoke_agent");
    const deciding = phases.get("deciding");
    if (deciding === undefined) throw new Error("deciding registration phase is absent");
    phases.set("deciding", { ...deciding, allowed_tools: ["artifact_read", "read"] });
    expect(
      service.handle({ schema_version: 2, action: "recover", identity: start(runId).identity })
    ).toMatchObject({
      action: "error",
      result: { code: "REGISTRATION_CONTRACT_MISMATCH", checkpoint_unchanged: true },
    });
    expect(service.checkpointer.loadRunById(runId)?.status).toBe("running");
  });

  it("retains the Demetri-only unsealed ablation without review or promotion semantics", async () => {
    const env = environment();
    const client = new ScriptedDecideClient([persistedDecisionDraft("selected")]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_UNSEALED_EVALUATION_REGISTRATION,
    });
    sequence += 1;
    const terminal = completeDirective(
      await service.execute(
        start(`run-decide-unsealed-${sequence}`, DECIDE_UNSEALED_EVALUATION_NAME)
      )
    );
    expect(outputRef(terminal)).toMatchObject({ kind: "decision-draft", phase: "deciding" });
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual(["deciding"]);
    expect(terminal.artifacts.some((artifact) => artifact.kind === "review-receipt")).toBe(false);
  });

  it("cancels without dispatch and reports honest no-execution state", () => {
    const env = environment();
    const client = new ScriptedDecideClient([]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-decide-cancel-${sequence}`;
    expect(service.handle(start(runId))).toMatchObject({
      action: "invoke_agent",
      state_id: "analyzing_decision",
      agent: "annie",
    });
    const cancelled = service.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity(runId),
      reason: "caller stopped evaluation",
    });
    expect(cancelled).toMatchObject({
      action: "cancelled",
      met: false,
      result: { execution_started: false, execution_authorized: false },
    });
    expect(DECIDE_CANDIDATE_REGISTRATION.contract.behavior.stopping).toEqual({
      budget_exhaustion: "incomplete",
      cancellation: "cancelled",
      blocking_ambiguity: "incomplete",
    });
    expect(canonicalJson(DECIDE_CANDIDATE_REGISTRATION.contract)).not.toMatch(
      /await_user|awaiting_user/iu
    );
    expect(client.invocations).toHaveLength(0);
  });
});
