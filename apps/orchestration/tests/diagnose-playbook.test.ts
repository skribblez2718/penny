import { explicitSealPolicy } from "./helpers/explicit-cycle-policy.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DIAGNOSE_PLAYBOOK_REGISTRATION,
  DIAGNOSE_PLAYBOOK_NAME,
  DiagnosePlaybook,
  FeedbackRouteEvidenceV1Schema,
  OrchestrationService,
  canonicalJson,
  initializePennyState,
  validateDiagnosis,
  validateDiagnosisProductEnvelope,
  validateDiagnosisProductIntegrity,
  validateDiagnosisValidityReceipt,
  validateContract,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type DiagnosisDraftV1,
  type DiagnosisRequestV1,
  type Directive,
  type JsonValue,
  type ModelClient,
  type PlaybookRegistration,
} from "../dist/index.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
let sequence = 0;

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-diagnose-playbook-"));
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

function request(mode: "proposal_only" | "none" = "proposal_only"): DiagnosisRequestV1 {
  return {
    schema_version: 1,
    problem_statement: "Why are reads stale after an update?",
    symptoms: [{ statement: "A read returns the previous value." }],
    supplied_observations: [
      { statement: "The cached path returns the previous value." },
      { statement: "The origin returns the updated value." },
    ],
    environment_facts: [{ statement: "The read path has an expiring cache." }],
    hard_constraints: [{ statement: "Execute no tests and begin no remediation." }],
    non_goals: [{ statement: "Do not recommend a fix." }],
    known_uncertainties: [{ statement: "The invalidation event is unobserved." }],
    permitted_test_boundary: { mode },
  };
}

function identity(runId: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook: DIAGNOSE_PLAYBOOK_NAME,
    engine_owner: "typescript" as const,
  };
}

function start(runId: string, mode: "proposal_only" | "none" = "proposal_only") {
  const value = request(mode);
  const { problem_statement: goal, ...constraints } = value;
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId),
    goal,
    constraints,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}

function coverage() {
  return {
    problem_statement_covered: true as const,
    symptom_indexes: [0],
    observation_indexes: [0, 1],
    environment_fact_indexes: [0],
    hard_constraint_indexes: [0],
    non_goal_indexes: [0],
    known_uncertainty_indexes: [0],
    permitted_test_boundary_covered: true as const,
  };
}

function hypothesis(id: string, rank: number, status: "supported" | "plausible" | "ruled_out") {
  return {
    hypothesis_id: id,
    rank,
    statement: `${id} explains the symptom.`,
    status,
    symptom_indexes: [0],
    supporting_observation_indexes: status === "supported" ? [0, 1] : [],
    contradicting_observation_indexes: status === "ruled_out" ? [1] : [],
    supporting_environment_fact_indexes: status === "supported" ? [0] : [],
    contradicting_environment_fact_indexes: [],
    hard_constraint_indexes: [0],
    reasoning: `${id} is ${status} from supplied evidence.`,
  };
}

function supportedDraft(
  reasoning = "The supplied evidence supports cache staleness."
): DiagnosisDraftV1 {
  return {
    schema_version: 1,
    disposition: "supported",
    applicability_reason: "The request asks for a causal diagnosis.",
    hypothesis_set_complete: true,
    hypotheses: [hypothesis("hyp_cache", 1, "supported"), hypothesis("hyp_origin", 2, "ruled_out")],
    primary_supported_hypothesis_id: "hyp_cache",
    reasoning,
    uncertainty: [],
    proposed_discriminating_checks: [],
    request_coverage: coverage(),
    confidence: "PROBABLE",
    remediation_started: false,
    tests_executed: false,
  };
}

function inconclusiveDraft(): DiagnosisDraftV1 {
  return {
    ...supportedDraft(),
    disposition: "inconclusive",
    hypotheses: [
      hypothesis("hyp_cache", 1, "plausible"),
      hypothesis("hyp_replica", 2, "plausible"),
    ],
    primary_supported_hypothesis_id: null,
    reasoning: "The supplied evidence cannot distinguish cache staleness and replica lag.",
    uncertainty: ["The stale interval by path is unknown."],
    proposed_discriminating_checks: [],
    confidence: "UNCERTAIN",
  };
}

function persistedDraft(draft: DiagnosisDraftV1): string {
  return `DIAGNOSIS_CORE:${canonicalJson(draft)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`;
}

function stageComplete(body: string): string {
  return `${body}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`;
}

function veraPass(): string {
  return `Verification report.\nSUMMARY:${JSON.stringify({
    confidence: "CERTAIN",
    verdict: "PASS",
    gap_kind: "none",
    repair_owner: "none",
    findings: [],
    evidence: ["The exact latest DiagnosisV1 and source lineage are valid."],
    strategy_delta: "Admit this exact diagnosis without executing tests or remediation.",
  })}`;
}

function veraUnverifiable(): string {
  return `Verification evidence unavailable.\nSUMMARY:${JSON.stringify({
    confidence: "UNCERTAIN",
    verdict: "UNVERIFIABLE",
    gap_kind: "verification_incomplete",
    repair_owner: "none",
    findings: ["Required semantic verification support is unavailable."],
    evidence: ["The supplied basis cannot establish the required claim; no defect is established."],
    strategy_delta: "Stop incomplete; obtain verification support outside this author loop.",
  })}`;
}

async function toVera(
  service: OrchestrationService,
  runId: string,
  contextualRef?: ArtifactRef
): Promise<Extract<Directive, { action: "invoke_agent" }>> {
  let directive = service.handle({
    ...start(runId),
    ...(contextualRef === undefined
      ? {}
      : {
          input_artifacts: {
            schema_version: 2,
            artifacts: [{ slot: "contextual-product", designation: "context", ref: contextualRef }],
          },
        }),
  });
  for (let index = 0; index < 3; index += 1) {
    const [result] = await service.workers.execute(directive);
    if (result === undefined) throw new Error("fixture phase result is absent");
    directive = service.handle({
      schema_version: 2,
      action: "step",
      identity: identity(runId),
      result,
    });
  }
  if (directive.action !== "invoke_agent" || directive.state_id !== "verifying_diagnosis")
    throw new Error("fixture did not reach Vera");
  return directive;
}

function veraGap(kind: "analysis_gap" | "evidence_gap" | "diagnosis_product_gap"): string {
  return `Verification failure.\nSUMMARY:${JSON.stringify({
    confidence: "PROBABLE",
    verdict: "FAIL",
    gap_kind: kind,
    repair_owner: kind === "diagnosis_product_gap" ? "demetri" : "annie",
    findings: [`The exact diagnosis has a ${kind}.`],
    evidence: ["The current product disagrees with its exact supplied basis."],
    strategy_delta: `Replace the ${kind} without tests or remediation.`,
  })}`;
}

class ScriptedDiagnoseClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private next = 0;

  constructor(private readonly outputs: readonly string[]) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const text = this.outputs[this.next];
    this.next += 1;
    if (text === undefined) throw new Error("scripted Diagnose output is exhausted");
    return { text };
  }
}

type TerminalDirective = Extract<Directive, { result: Record<string, JsonValue> }>;

function complete(value: Directive): TerminalDirective {
  if (value.action !== "complete") {
    throw new Error(`expected complete directive, received '${value.action}'`);
  }
  return value;
}

function readJson(service: OrchestrationService, artifactId: string): unknown {
  return JSON.parse(service.artifacts.readById(artifactId).toString("utf8"));
}

function exactInput(
  invocation: AgentInvocation | undefined,
  phase: string,
  kind: string
): ArtifactRef {
  if (invocation === undefined) throw new Error(`missing invocation for ${phase}:${kind}`);
  const matches = invocation.inputArtifacts.filter(
    (ref) => ref.phase === phase && ref.kind === kind
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`expected one exact input for ${phase}:${kind}, found ${matches.length}`);
  }
  return matches[0];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("orchestrated diagnose workflow", () => {
  it("completes the exact Annie → Ida → Demetri → seal → Vera → host admission flow", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Causal decomposition."),
      stageComplete("Competing hypotheses."),
      persistedDraft(supportedDraft()),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-diagnose-happy-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "decomposing_causes",
      "generating_hypotheses",
      "adjudicating_diagnosis",
      "verifying_diagnosis",
    ]);
    expect(client.invocations.map((invocation) => invocation.agent)).toEqual([
      "annie",
      "ida",
      "demetri",
      "vera",
    ]);
    expect(client.invocations.some((invocation) => invocation.agent === "carren")).toBe(false);
    expect(
      client.invocations.map((invocation) => invocation.inputArtifacts.map((ref) => ref.phase))
    ).toEqual([
      ["intake"],
      ["intake", "decomposing_causes"],
      ["intake", "decomposing_causes", "generating_hypotheses"],
      [
        "intake",
        "decomposing_causes",
        "generating_hypotheses",
        "adjudicating_diagnosis",
        "sealing_diagnosis",
      ],
    ]);

    const product = terminal.result.output_artifact_ref;
    if (product === null || typeof product !== "object" || Array.isArray(product)) {
      throw new Error("diagnosis product ref is absent");
    }
    expect(validateDiagnosis(readJson(service, String(product.artifact_id)))).toMatchObject({
      disposition: "supported",
      primary_supported_hypothesis_id: "hyp_cache",
      tests_executed: false,
      remediation_started: false,
    });
    const validity = terminal.artifacts.find(
      (artifact) => artifact.kind === "diagnosis-validity-receipt"
    );
    const integrity = terminal.artifacts.find(
      (artifact) => artifact.kind === "diagnosis-product-integrity"
    );
    const envelope = terminal.artifacts.find(
      (artifact) => artifact.kind === "diagnosis-product-envelope"
    );
    if (validity === undefined || integrity === undefined || envelope === undefined) {
      throw new Error("exact diagnosis product graph is incomplete");
    }
    expect(validateDiagnosisValidityReceipt(readJson(service, validity.artifact_id))).toMatchObject(
      {
        verdict: "PASS",
        reviewer: "vera",
        diagnosis_ref: { artifact_id: product.artifact_id },
        tests_executed: false,
        remediation_started: false,
      }
    );
    expect(
      validateDiagnosisProductIntegrity(readJson(service, integrity.artifact_id))
    ).toMatchObject({
      status: "PASS",
      diagnosis_ref: { artifact_id: product.artifact_id },
      tests_executed: false,
      remediation_started: false,
    });
    expect(validateDiagnosisProductEnvelope(readJson(service, envelope.artifact_id))).toMatchObject(
      {
        status: "complete",
        diagnosis_ref: { artifact_id: product.artifact_id },
        validity_receipt_ref: { artifact_id: validity.artifact_id },
        integrity_ref: { artifact_id: integrity.artifact_id },
      }
    );
    expect(terminal).toMatchObject({
      action: "complete",
      met: true,
      unresolved: [],
      result: { tests_executed: false, remediation_started: false },
    });
    expect(service.checkpointer.completionAdmission(terminal.identity.run_id)).toBeDefined();
  });

  it("terminalizes UNVERIFIABLE durably without author repair, validity receipt or admission", async () => {
    const env = environment();
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      persistedDraft(supportedDraft()),
      veraUnverifiable(),
    ]);
    sequence += 1;
    const runId = `run-diagnose-unverifiable-${sequence}`;
    let terminal: Directive;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
      });
      terminal = await service.execute(start(runId));
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: {
          incomplete_reason: "verification_incomplete",
          verification_findings: ["Required semantic verification support is unavailable."],
          verification_evidence_limitations: [
            "The supplied basis cannot establish the required claim; no defect is established.",
          ],
          verification_report_refs: [expect.objectContaining({ phase: "verifying_diagnosis" })],
        },
      });
      expect(client.invocations.map((item) => item.agent)).toEqual([
        "annie",
        "ida",
        "demetri",
        "vera",
      ]);
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("checkpoint absent");
      expect(context.iteration).toBe(0);
      expect(
        context.selectedArtifacts.some((ref) => ref.kind === "diagnosis-validity-receipt")
      ).toBe(false);
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      if (terminal.action !== "incomplete") throw new Error("expected incomplete verification");
      expect(terminal.artifacts.map((ref) => ref.kind)).toEqual(["semantic-core", "agent-output"]);
    }
    const recoveredClient = new ScriptedDiagnoseClient([]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    expect(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
    expect(recoveredClient.invocations).toEqual([]);
  });

  it("refuses a judgment-free source instead of acquiring PASS through routing repair", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      persistedDraft(supportedDraft()),
      'Verification report.\nSUMMARY:{"confidence":"PROBABLE"}',
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-diagnose-routing-refusal-${sequence}`));
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(client.invocations.map((item) => item.agent)).toEqual([
      "annie",
      "ida",
      "demetri",
      "vera",
    ]);
    expect(service.checkpointer.completionAdmission(terminal.identity.run_id)).toBeUndefined();
    if (terminal.action !== "incomplete") throw new Error("expected source judgment refusal");
    expect(terminal.artifacts.some((ref) => ref.kind === "diagnosis-validity-receipt")).toBe(false);
  });

  it("binds current pre-review native check evidence and recovers the exact task; cancellation stays final", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      persistedDraft(supportedDraft()),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-diagnose-checks-${sequence}`;
    const pending = await toVera(service, runId);
    const evidence = pending.task.split("\n\nHOST_MECHANICAL_CHECKS:")[1];
    if (evidence === undefined) throw new Error("pre-review checks absent");
    const value: unknown = JSON.parse(evidence);
    expect(canonicalJson(value)).toBe(evidence);
    expect(value).toEqual({
      schema_version: 1,
      product_ref: pending.input_artifacts.artifacts[4]?.ref,
      source_refs: pending.input_artifacts.artifacts.slice(0, 4).map((entry) => entry.ref),
      checks: [
        "exact_source_ref_custody",
        "canonical_request",
        "parsed_authored_draft",
        "canonical_product_bytes_and_digest",
        "exact_source_lineage",
        "authored_no_action_literals",
      ],
      scope: "host_mechanical_only_not_semantic_or_effect_absence",
    });
    expect(
      service.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(pending);
    const terminal = service.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity(runId),
      reason: "fixture cancellation before review",
    });
    expect(terminal).toMatchObject({ action: "cancelled", met: false });
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
    expect(client.invocations.map((item) => item.agent)).toEqual(["annie", "ida", "demetri"]);
    expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
  });

  it("recovers frozen mechanical evidence with owner-enriched contextual guidance intact", async () => {
    const env = environment();
    const client = new ScriptedDiagnoseClient([
      stageComplete("Producer decomposition."),
      stageComplete("Producer hypotheses."),
      persistedDraft(supportedDraft()),
      veraPass(),
      stageComplete("Consumer decomposition."),
      stageComplete("Consumer hypotheses."),
      persistedDraft(supportedDraft()),
    ]);
    sequence += 1;
    const runId = `run-diagnose-context-recovery-${sequence}`;
    let pending: Extract<Directive, { action: "invoke_agent" }>;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookName: DIAGNOSE_PLAYBOOK_NAME,
      });
      const producer = complete(await service.execute(start(`${runId}-producer`)));
      const product = producer.artifacts.find((ref) => ref.kind === "semantic-core");
      if (product === undefined) throw new Error("producer product absent");
      pending = await toVera(service, runId, product);
      expect(pending.task).toContain("NONBINDING exact contextual artifacts");
      expect(pending.input_artifacts.artifacts).toContainEqual(
        expect.objectContaining({ designation: "context", ref: product })
      );
    }
    const recoveredClient = new ScriptedDiagnoseClient([]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookName: DIAGNOSE_PLAYBOOK_NAME,
    });
    expect(
      recovered.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(pending);
    expect(recoveredClient.invocations).toEqual([]);
    expect(
      recovered.handle({
        schema_version: 2,
        action: "cancel",
        identity: identity(runId),
        reason: "fixture end",
      })
    ).toMatchObject({ action: "cancelled", met: false });
  });

  it("rejects a signed review made against a tampered host-check task", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      persistedDraft(supportedDraft()),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-diagnose-task-binding-${sequence}`;
    const pending = await toVera(service, runId);
    const [result] = await service.workers.execute({
      ...pending,
      task: `${pending.task}\nUnchecked extra host claim.`,
    });
    if (result === undefined) throw new Error("review result absent");
    expect(() =>
      service.handle({ schema_version: 2, action: "step", identity: identity(runId), result })
    ).toThrow(/trusted_invocation_digest/u);
    expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("checkpoint absent");
    expect(context.selectedArtifacts.some((ref) => ref.kind === "diagnosis-validity-receipt")).toBe(
      false
    );
    const cancelled = service.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity(runId),
      reason: "fixture end",
    });
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(cancelled);
  });

  it.each(["ref_digest", "native_lineage", "task_evidence"] as const)(
    "denies invalid pre-review %s without an author loop",
    async (failure) => {
      const client = new ScriptedDiagnoseClient([
        stageComplete("Decomposition."),
        stageComplete("Hypotheses."),
        persistedDraft(supportedDraft()),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
      });
      sequence += 1;
      const runId = `run-diagnose-invalid-checks-${sequence}`;
      await toVera(service, runId);
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("checkpoint absent");
      if (failure === "ref_digest") {
        context.selectedArtifacts = context.selectedArtifacts.map((ref) =>
          ref.phase === "decomposing_causes" ? { ...ref, content_digest: "f".repeat(64) } : ref
        );
      } else if (failure === "native_lineage") {
        const original = context.selectedArtifacts.find(
          (ref) => ref.phase === "decomposing_causes"
        );
        if (original === undefined) throw new Error("decomposition absent");
        const replacement = service.artifacts.persist({
          metadata: {
            ...service.artifacts.metadata(original),
            operation_id: "fixture-substituted-decomposition",
            version: 1,
            parent_ref: null,
          },
          content: stageComplete(
            "Different decomposition with valid custody but wrong product lineage."
          ),
        });
        context.selectedArtifacts = context.selectedArtifacts.map((ref) =>
          ref.artifact_id === original.artifact_id ? replacement : ref
        );
      } else {
        const pending = context.pendingDirective;
        if (pending?.action !== "invoke_agent") throw new Error("pending review absent");
        context.pendingDirective = {
          ...pending,
          task: pending.task.replace(
            '"scope":"host_mechanical_only_not_semantic_or_effect_absence"',
            '"scope":"unchecked"'
          ),
        };
      }
      service.checkpointer.saveRun(context, "fixture_lineage_corruption", {});
      const terminal = await service.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: { incomplete_reason: "host_mechanical_validation_failed" },
      });
      expect(client.invocations.map((item) => item.agent)).toEqual(["annie", "ida", "demetri"]);
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
    }
  );

  it.each([
    { kind: "analysis_gap", operand: "decomposition" },
    { kind: "analysis_gap", operand: "hypotheses" },
    { kind: "evidence_gap", operand: "decomposition" },
    { kind: "evidence_gap", operand: "hypotheses" },
  ] as const)(
    "does not infer a stall for $kind when only upstream $operand changes",
    async ({ kind, operand }) => {
      const gap = veraGap(kind);
      const draft = persistedDraft(supportedDraft());
      const client = new ScriptedDiagnoseClient([
        stageComplete("Initial decomposition."),
        stageComplete("Initial hypotheses."),
        draft,
        gap,
        stageComplete(
          operand === "decomposition" ? "Revised causal links." : "Initial decomposition."
        ),
        stageComplete(operand === "hypotheses" ? "Revised alternatives." : "Initial hypotheses."),
        draft,
        gap,
        stageComplete(
          operand === "decomposition" ? "Further revised causal links." : "Initial decomposition."
        ),
        stageComplete(
          operand === "hypotheses" ? "Further revised alternatives." : "Initial hypotheses."
        ),
        draft,
        veraPass(),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
      });
      sequence += 1;
      const runId = `run-diagnose-upstream-${sequence}`;
      complete(await service.execute(start(runId)));
      const reviews = client.invocations.filter((item) => item.agent === "vera");
      expect(reviews).toHaveLength(3);
      const analyses = reviews.map((review) =>
        exactInput(
          review,
          operand === "decomposition" ? "decomposing_causes" : "generating_hypotheses",
          "agent-output"
        )
      );
      expect(new Set(analyses.map((ref) => ref.content_digest)).size).toBe(3);
      for (const review of reviews) {
        const ref = exactInput(review, "adjudicating_diagnosis", "diagnosis-draft");
        expect(service.artifacts.readById(ref.artifact_id).toString("utf8")).toBe(draft);
      }
      const routes = service.checkpointer.events(runId).flatMap((event) => {
        const route = event.payload.feedback_route_evidence_v1;
        return route === undefined ? [] : [route];
      });
      expect(routes).toEqual([
        expect.objectContaining({
          disposition: "repair",
          repair_progress_v1: { branch_id: null, fingerprint: null },
        }),
        expect.objectContaining({
          disposition: "repair",
          repair_progress_v1: { branch_id: null, fingerprint: null },
        }),
      ]);
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("checkpoint absent");
      expect(context.iteration).toBe(2);
    }
  );

  it.each([
    { change: "same_bytes", operand: "decomposition" },
    { change: "same_bytes", operand: "hypotheses" },
    { change: "substance", operand: "decomposition" },
    { change: "substance", operand: "hypotheses" },
    { change: "transport_only", operand: "decomposition" },
    { change: "transport_only", operand: "hypotheses" },
  ] as const)(
    "handles product-gap recurrence across an upstream repair with $change $operand",
    async ({ change, operand }) => {
      const decomposition = stageComplete("Initial decomposition.");
      const hypotheses = stageComplete("Initial hypotheses.");
      const analysis = operand === "decomposition" ? decomposition : hypotheses;
      const replacement =
        change === "same_bytes"
          ? analysis
          : change === "substance"
            ? stageComplete("Observation 1 rules out the origin as the stale-read source.")
            : analysis
                .replace(
                  "\nSUMMARY:",
                  "\nSource ref: revised-ref; receipt: revised-receipt; revision: 2.\nSUMMARY:"
                )
                .replace('"PROBABLE"', '"CERTAIN"');
      const draft = persistedDraft(supportedDraft());
      const gap = veraGap("diagnosis_product_gap");
      const client = new ScriptedDiagnoseClient([
        decomposition,
        hypotheses,
        draft,
        gap,
        draft,
        veraGap("analysis_gap"),
        operand === "decomposition" ? replacement : decomposition,
        operand === "hypotheses" ? replacement : hypotheses,
        draft,
        gap,
        ...(change === "same_bytes" ? [] : [draft, gap, draft, veraPass()]),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
      });
      sequence += 1;
      const runId = `run-diagnose-product-basis-${sequence}`;
      const terminal = await service.execute(start(runId));
      expect(terminal).toMatchObject(
        change === "same_bytes"
          ? { action: "incomplete", met: false, result: { incomplete_reason: "repair_stalled" } }
          : { action: "complete", met: true }
      );
      const reviews = client.invocations.filter((item) => item.agent === "vera");
      expect(reviews).toHaveLength(change === "same_bytes" ? 3 : 5);
      const before = exactInput(
        reviews[0],
        operand === "decomposition" ? "decomposing_causes" : "generating_hypotheses",
        "agent-output"
      );
      const after = exactInput(
        reviews[2],
        operand === "decomposition" ? "decomposing_causes" : "generating_hypotheses",
        "agent-output"
      );
      expect(after.artifact_id).not.toBe(before.artifact_id);
      expect(after.content_digest === before.content_digest).toBe(change === "same_bytes");
      for (const review of reviews) {
        const ref = exactInput(review, "adjudicating_diagnosis", "diagnosis-draft");
        expect(service.artifacts.readById(ref.artifact_id).toString("utf8")).toBe(draft);
      }
      const routes = service.checkpointer.events(runId).flatMap((event) => {
        const route = event.payload.feedback_route_evidence_v1;
        return route === undefined ? [] : [route];
      });
      const firstRoute = validateContract(FeedbackRouteEvidenceV1Schema, routes[0], "first repair");
      if (firstRoute.repair_progress_v1 === undefined) throw new Error("progress evidence absent");
      expect(firstRoute.disposition).toBe("repair");
      expect(firstRoute.repair_progress_v1.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(routes[1]).toMatchObject({
        disposition: "repair",
        repair_progress_v1: { fingerprint: null },
      });
      expect(routes[2]).toMatchObject(
        change === "same_bytes"
          ? { disposition: "stalled" }
          : { disposition: "repair", repair_progress_v1: { fingerprint: null } }
      );
      if (change !== "same_bytes") {
        expect(routes[3]).toMatchObject({
          disposition: "repair",
          repair_progress_v1: { fingerprint: null },
        });
      }
    }
  );

  it("stalls an identical semantic candidate and failure despite ID renames, revisions and strategy prose", async () => {
    const renamed = supportedDraft();
    const replacement = {
      ...renamed,
      hypotheses: renamed.hypotheses.map((hypothesis, index) => ({
        ...hypothesis,
        hypothesis_id: `renamed_${index}`,
      })),
      primary_supported_hypothesis_id: "renamed_0",
    };
    const env = environment();
    const gap = veraGap("diagnosis_product_gap");
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      persistedDraft(supportedDraft()),
      gap,
      persistedDraft(replacement),
      gap.replace(
        "Replace the diagnosis_product_gap without tests or remediation.",
        "A different strategy claim with identical failure."
      ),
    ]);
    sequence += 1;
    const runId = `run-diagnose-stall-${sequence}`;
    let terminal: Directive;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
      });
      terminal = await service.execute(start(runId));
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: {
          incomplete_reason: "repair_stalled",
          repair_stall: {
            feedback_report_refs: [expect.objectContaining({ phase: "verifying_diagnosis" })],
          },
        },
      });
      expect(client.invocations.map((item) => item.agent)).toEqual([
        "annie",
        "ida",
        "demetri",
        "vera",
        "demetri",
        "vera",
      ]);
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("checkpoint absent");
      expect(context.iteration).toBe(1);
      expect(context.selectedArtifacts.filter((ref) => ref.kind === "semantic-core")).toHaveLength(
        2
      );
      expect(
        context.selectedArtifacts.filter(
          (ref) => ref.phase === "verifying_diagnosis" && ref.kind === "agent-output"
        )
      ).toHaveLength(2);
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
    }
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedDiagnoseClient([]),
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    expect(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
  });

  it("continues on changed semantic candidates with the same failure and rechecks each sealed product", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      persistedDraft(supportedDraft("First.")),
      veraGap("diagnosis_product_gap"),
      persistedDraft(supportedDraft("Changed meaning.")),
      veraGap("diagnosis_product_gap"),
      persistedDraft(supportedDraft("Further changed meaning.")),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-diagnose-changed-${sequence}`)));
    const reviews = client.invocations.filter((item) => item.agent === "vera");
    expect(reviews).toHaveLength(3);
    const products = reviews.map((review) =>
      review.inputArtifacts.find((ref) => ref.kind === "semantic-core")
    );
    expect(new Set(products.map((ref) => ref?.artifact_id)).size).toBe(3);
    for (const review of reviews) {
      const evidence = review.task.split("\n\nHOST_MECHANICAL_CHECKS:")[1];
      if (evidence === undefined) throw new Error("current mechanical evidence absent");
      const checks: unknown = JSON.parse(evidence);
      expect(checks).toMatchObject({
        product_ref: review.inputArtifacts.find((ref) => ref.kind === "semantic-core"),
      });
    }
    expect(terminal.result.output_artifact_ref).toEqual(products[2]);
  });

  it("routes Vera analysis/evidence repair through Annie then Ida then Demetri and reseals", async () => {
    for (const kind of ["analysis_gap", "evidence_gap"] as const) {
      const first = supportedDraft("Initial analysis is incomplete.");
      const revised = supportedDraft(`Revised after ${kind}.`);
      const client = new ScriptedDiagnoseClient([
        stageComplete("Initial decomposition."),
        stageComplete("Initial hypotheses."),
        persistedDraft(first),
        veraGap(kind),
        stageComplete("Replacement decomposition."),
        stageComplete("Replacement hypotheses."),
        persistedDraft(revised),
        veraPass(),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
      });
      sequence += 1;
      const terminal = complete(await service.execute(start(`run-diagnose-${kind}-${sequence}`)));
      expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
        "decomposing_causes",
        "generating_hypotheses",
        "adjudicating_diagnosis",
        "verifying_diagnosis",
        "decomposing_causes",
        "generating_hypotheses",
        "adjudicating_diagnosis",
        "verifying_diagnosis",
      ]);
      expect(client.invocations[4]?.inputArtifacts.map((ref) => ref.phase)).toEqual([
        "intake",
        "decomposing_causes",
        "generating_hypotheses",
        "adjudicating_diagnosis",
        "sealing_diagnosis",
        "verifying_diagnosis",
      ]);
      expect(client.invocations[5]?.inputArtifacts.map((ref) => ref.phase)).toEqual([
        "intake",
        "decomposing_causes",
        "adjudicating_diagnosis",
        "sealing_diagnosis",
        "verifying_diagnosis",
      ]);
      expect(client.invocations[6]?.inputArtifacts.map((ref) => ref.phase)).toEqual([
        "intake",
        "decomposing_causes",
        "generating_hypotheses",
        "adjudicating_diagnosis",
        "sealing_diagnosis",
        "verifying_diagnosis",
      ]);
      const firstVera = client.invocations[3];
      const annie = client.invocations[4];
      const ida = client.invocations[5];
      const demetri = client.invocations[6];
      const secondVera = client.invocations[7];
      const priorDraft = exactInput(firstVera, "adjudicating_diagnosis", "diagnosis-draft");
      const priorProduct = exactInput(firstVera, "sealing_diagnosis", "semantic-core");
      const priorReport = exactInput(annie, "verifying_diagnosis", "agent-output");
      expect(priorReport.artifact_id).toBe(
        exactInput(demetri, "verifying_diagnosis", "agent-output").artifact_id
      );
      for (const invocation of [annie, ida, demetri]) {
        expect(
          exactInput(invocation, "adjudicating_diagnosis", "diagnosis-draft").artifact_id
        ).toBe(priorDraft.artifact_id);
        expect(exactInput(invocation, "sealing_diagnosis", "semantic-core").artifact_id).toBe(
          priorProduct.artifact_id
        );
        expect(exactInput(invocation, "verifying_diagnosis", "agent-output").artifact_id).toBe(
          priorReport.artifact_id
        );
      }
      expect(exactInput(ida, "decomposing_causes", "agent-output").artifact_id).toBe(
        exactInput(demetri, "decomposing_causes", "agent-output").artifact_id
      );
      const revisedProduct = exactInput(secondVera, "sealing_diagnosis", "semantic-core");
      expect(revisedProduct.artifact_id).not.toBe(priorProduct.artifact_id);
      expect(exactInput(secondVera, "verifying_diagnosis", "agent-output").artifact_id).toBe(
        priorReport.artifact_id
      );
      expect(terminal.result.output_artifact_ref).toMatchObject({
        artifact_id: revisedProduct.artifact_id,
      });
      const validity = terminal.artifacts.find(
        (artifact) => artifact.kind === "diagnosis-validity-receipt"
      );
      const latestReport = terminal.artifacts.find(
        (artifact) => artifact.phase === "verifying_diagnosis" && artifact.kind === "agent-output"
      );
      if (validity === undefined || latestReport === undefined) {
        throw new Error("revised product has no current verification graph");
      }
      expect(latestReport.artifact_id).not.toBe(priorReport.artifact_id);
      expect(
        validateDiagnosisValidityReceipt(readJson(service, validity.artifact_id))
      ).toMatchObject({
        verdict: "PASS",
        diagnosis_ref: { artifact_id: revisedProduct.artifact_id },
        vera_report_ref: { artifact_id: latestReport.artifact_id },
      });
      expect(terminal).toMatchObject({ action: "complete", met: true, unresolved: [] });
      expect(terminal.result).toMatchObject({ tests_executed: false, remediation_started: false });
    }
  });

  it("excludes stale seal feedback through a later Vera repair without treating it as approval", async () => {
    const invalid = { ...supportedDraft(), tests_executed: true };
    const client = new ScriptedDiagnoseClient([
      stageComplete("Initial decomposition."),
      stageComplete("Initial hypotheses."),
      `DIAGNOSIS_CORE:${canonicalJson(invalid)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      persistedDraft(supportedDraft("Corrected after seal feedback.")),
      veraGap("analysis_gap"),
      stageComplete("Repair decomposition."),
      stageComplete("Repair hypotheses."),
      persistedDraft(supportedDraft("Corrected after Vera review.")),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(
      await service.execute(start(`run-diagnose-feedback-continuity-${sequence}`))
    );
    const feedback = exactInput(client.invocations[3], "sealing_diagnosis", "seal-diagnostic");
    const priorProduct = exactInput(client.invocations[4], "sealing_diagnosis", "semantic-core");
    const veraReport = exactInput(client.invocations[5], "verifying_diagnosis", "agent-output");
    for (const invocation of client.invocations.slice(5, 8)) {
      expect(
        invocation.inputArtifacts.some((ref) => ref.artifact_id === feedback.artifact_id)
      ).toBe(false);
      expect(exactInput(invocation, "sealing_diagnosis", "semantic-core").artifact_id).toBe(
        priorProduct.artifact_id
      );
      expect(exactInput(invocation, "verifying_diagnosis", "agent-output").artifact_id).toBe(
        veraReport.artifact_id
      );
    }
    const revisedProduct = exactInput(client.invocations[8], "sealing_diagnosis", "semantic-core");
    expect(revisedProduct.artifact_id).not.toBe(priorProduct.artifact_id);
    expect(terminal.result.output_artifact_ref).toMatchObject({
      artifact_id: revisedProduct.artifact_id,
    });
    expect(terminal).toMatchObject({ action: "complete", met: true });
  });

  it("routes a Vera product gap directly to Demetri and accepts a valid no-check inconclusive boundary", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      persistedDraft(supportedDraft("Needs product correction.")),
      veraGap("diagnosis_product_gap"),
      persistedDraft(inconclusiveDraft()),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(
      await service.execute(start(`run-diagnose-product-gap-${sequence}`, "none"))
    );
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "decomposing_causes",
      "generating_hypotheses",
      "adjudicating_diagnosis",
      "verifying_diagnosis",
      "adjudicating_diagnosis",
      "verifying_diagnosis",
    ]);
    expect(client.invocations[4]?.inputArtifacts.map((ref) => ref.phase)).toEqual([
      "intake",
      "decomposing_causes",
      "generating_hypotheses",
      "adjudicating_diagnosis",
      "sealing_diagnosis",
      "verifying_diagnosis",
    ]);
    const product = terminal.result.output_artifact_ref;
    if (product === null || typeof product !== "object" || Array.isArray(product)) {
      throw new Error("diagnosis product ref is absent");
    }
    expect(validateDiagnosis(readJson(service, String(product.artifact_id)))).toMatchObject({
      disposition: "inconclusive",
      proposed_discriminating_checks: [],
      tests_executed: false,
      remediation_started: false,
    });
  });

  it("uses one host seal-feedback repair and never runs the malformed draft", async () => {
    const invalid = {
      ...supportedDraft(),
      tests_executed: true,
    };
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      `DIAGNOSIS_CORE:${canonicalJson(invalid)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      persistedDraft(supportedDraft("Replacement after seal feedback.")),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-diagnose-seal-repair-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "decomposing_causes",
      "generating_hypotheses",
      "adjudicating_diagnosis",
      "adjudicating_diagnosis",
      "verifying_diagnosis",
    ]);
    const repairedDraftInput = client.invocations[3];
    const feedback = exactInput(repairedDraftInput, "sealing_diagnosis", "seal-diagnostic");
    const rejected = exactInput(repairedDraftInput, "adjudicating_diagnosis", "diagnosis-draft");
    expect(readJson(service, feedback.artifact_id)).toMatchObject({
      rejected_draft_ref: { artifact_id: rejected.artifact_id },
    });
    expect(terminal.artifacts.some((artifact) => artifact.kind === "seal-diagnostic")).toBe(false);
    expect(terminal.result).toMatchObject({ tests_executed: false, remediation_started: false });
  });

  it("recovers after host seal persistence without creating a duplicate diagnosis revision", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistration = {
      ...DIAGNOSE_PLAYBOOK_REGISTRATION,
      construct: (options) =>
        new DiagnosePlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === "sealing_diagnosis:artifact-persistence") {
              interrupted = true;
              throw new Error("injected diagnosis seal interruption");
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-diagnose-seal-recovery-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDiagnoseClient([
          stageComplete("Decomposition."),
          stageComplete("Hypotheses."),
          persistedDraft(supportedDraft()),
        ]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(
        /injected diagnosis seal interruption/u
      );
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_diagnosis");
    }
    const recoveredClient = new ScriptedDiagnoseClient([veraPass()]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    const terminal = complete(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    const products = terminal.artifacts.filter(
      (artifact) => artifact.kind === "semantic-core" && artifact.phase === "sealing_diagnosis"
    );
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ version: 1 });
    expect(recoveredClient.invocations.map((invocation) => invocation.stateId)).toEqual([
      "verifying_diagnosis",
    ]);
  });

  it("recovers an interrupted deterministic validity/integrity admission window without a model call", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistration = {
      ...DIAGNOSE_PLAYBOOK_REGISTRATION,
      construct: (options) =>
        new DiagnosePlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === "verifying_diagnosis:integrity-persistence") {
              interrupted = true;
              throw new Error("injected diagnosis integrity interruption");
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-diagnose-integrity-recovery-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDiagnoseClient([
          stageComplete("Decomposition."),
          stageComplete("Hypotheses."),
          persistedDraft(supportedDraft()),
          veraPass(),
        ]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(
        /injected diagnosis integrity interruption/u
      );
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("verifying_diagnosis");
    }
    const recoveredClient = new ScriptedDiagnoseClient([]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    const terminal = complete(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    expect(recoveredClient.invocations).toEqual([]);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "diagnosis-validity-receipt")
    ).toHaveLength(1);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "diagnosis-product-integrity")
    ).toHaveLength(1);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "diagnosis-product-envelope")
    ).toHaveLength(1);
  });

  it("exhausts both long Vera gap routes as incomplete despite earlier sealed products", async () => {
    for (const kind of ["analysis_gap", "evidence_gap"] as const) {
      const outputs = [
        stageComplete("First decomposition."),
        stageComplete("First hypotheses."),
        persistedDraft(supportedDraft("First diagnosis.")),
      ];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        outputs.push(veraGap(kind));
        if (attempt < 3) {
          outputs.push(stageComplete(`Decomposition ${attempt + 2}.`));
          outputs.push(stageComplete(`Hypotheses ${attempt + 2}.`));
          outputs.push(persistedDraft(supportedDraft(`Diagnosis ${attempt + 2}.`)));
        }
      }
      const client = new ScriptedDiagnoseClient(outputs);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" },
        modelClient: client,
        playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
      });
      sequence += 1;
      const terminal = await service.execute(
        start(`run-diagnose-long-exhaust-${kind}-${sequence}`)
      );
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: {
          incomplete_reason: "repair_budget_exhausted",
          exhaustion_reason: `verifying_diagnosis:${kind}`,
          tests_executed: false,
          remediation_started: false,
        },
      });
      expect(client.invocations.filter((invocation) => invocation.agent === "vera")).toHaveLength(
        4
      );
      const lastAnnie = client.invocations[12];
      const lastIda = client.invocations[13];
      const lastDemetri = client.invocations[14];
      const lastVera = client.invocations[15];
      const previousVera = client.invocations[11];
      const previousProduct = exactInput(previousVera, "sealing_diagnosis", "semantic-core");
      const previousReport = exactInput(lastAnnie, "verifying_diagnosis", "agent-output");
      for (const invocation of [lastAnnie, lastIda, lastDemetri]) {
        expect(exactInput(invocation, "sealing_diagnosis", "semantic-core").artifact_id).toBe(
          previousProduct.artifact_id
        );
        expect(exactInput(invocation, "verifying_diagnosis", "agent-output").artifact_id).toBe(
          previousReport.artifact_id
        );
      }
      if (terminal.action !== "incomplete") throw new Error("expected incomplete diagnosis");
      expect(terminal.result.output_artifact_ref).toMatchObject({
        artifact_id: exactInput(lastVera, "sealing_diagnosis", "semantic-core").artifact_id,
      });
      expect(
        terminal.artifacts.some((artifact) => artifact.kind === "diagnosis-validity-receipt")
      ).toBe(false);
    }
  });

  it("terminates repeated product gaps as bounded non-positive incomplete", async () => {
    const outputs = [stageComplete("Decomposition."), stageComplete("Hypotheses.")];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      outputs.push(persistedDraft(supportedDraft(`Attempt ${attempt + 1}.`)));
      outputs.push(veraGap("diagnosis_product_gap"));
    }
    const client = new ScriptedDiagnoseClient(outputs);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" },
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-diagnose-exhaust-${sequence}`));
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        incomplete_reason: "repair_budget_exhausted",
        exhausted: true,
        exhaustion_reason: "verifying_diagnosis:diagnosis_product_gap",
        tests_executed: false,
        remediation_started: false,
      },
    });
    expect(client.invocations.filter((invocation) => invocation.agent === "demetri")).toHaveLength(
      4
    );
    expect(client.invocations.some((invocation) => invocation.agent === "carren")).toBe(false);
  });
  it("gives a reviewer replacement a fresh seal correction, without stale diagnostic input", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      `DIAGNOSIS_CORE:${canonicalJson({ ...supportedDraft("bad first"), tests_executed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      persistedDraft(supportedDraft("first corrected")),
      veraGap("analysis_gap"),
      stageComplete("Fresh decomposition."),
      stageComplete("Fresh hypotheses."),
      `DIAGNOSIS_CORE:${canonicalJson({ ...supportedDraft("bad second"), tests_executed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      persistedDraft(supportedDraft("second corrected")),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-diagnose-epoch-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "decomposing_causes",
      "generating_hypotheses",
      "adjudicating_diagnosis",
      "adjudicating_diagnosis",
      "verifying_diagnosis",
      "decomposing_causes",
      "generating_hypotheses",
      "adjudicating_diagnosis",
      "adjudicating_diagnosis",
      "verifying_diagnosis",
    ]);
    const firstCorrection = client.invocations[3];
    const secondInitial = client.invocations[7];
    const secondCorrection = client.invocations[8];
    if (
      firstCorrection === undefined ||
      secondInitial === undefined ||
      secondCorrection === undefined
    ) {
      throw new Error("correction ledger is incomplete");
    }
    const first = firstCorrection.inputArtifacts.find((ref) => ref.kind === "seal-diagnostic");
    const second = secondCorrection.inputArtifacts.find((ref) => ref.kind === "seal-diagnostic");
    if (first === undefined || second === undefined)
      throw new Error("exact diagnostics were not selected");
    expect(secondInitial.inputArtifacts.some((ref) => ref.artifact_id === first.artifact_id)).toBe(
      false
    );
    expect(
      secondCorrection.inputArtifacts.some((ref) => ref.artifact_id === first.artifact_id)
    ).toBe(false);
    expect(second.artifact_id).not.toBe(first.artifact_id);
    expect(readJson(service, first.artifact_id)).toMatchObject({
      epoch_anchor_ref: null,
      rejection_ordinal: 1,
      corrections_used: 0,
      disposition: "correction_offered",
    });
    const secondDiagnostic = readJson(service, second.artifact_id);
    expect(secondDiagnostic).toMatchObject({
      epoch_anchor_ref: { kind: "semantic-core", run_id: terminal.identity.run_id },
      rejection_ordinal: 1,
      previous_diagnostic_ref: null,
      corrections_used: 0,
      disposition: "correction_offered",
    });
    expect(terminal.result.output_artifact_ref).toMatchObject({ kind: "semantic-core" });
    expect(terminal.result.seal_diagnostics).toBeUndefined();
  });

  it("persists the final rejection as an exact, replayable diagnostic, not a product", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      `DIAGNOSIS_CORE:${canonicalJson({ ...supportedDraft("first invalid"), tests_executed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      `DIAGNOSIS_CORE:${canonicalJson({ ...supportedDraft("second invalid"), tests_executed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: explicitSealPolicy(DIAGNOSE_PLAYBOOK_REGISTRATION, 1),
    });
    sequence += 1;
    const runId = `run-diagnose-final-seal-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        incomplete_reason: "seal_repair_exhausted",
        output_kind: "rejected_draft",
        output_artifact_ref: { kind: "diagnosis-draft" },
        seal_diagnostics: {
          corrections_used: 1,
          correction_limit: 1,
          disposition: "exhausted",
          epoch_anchor_ref: null,
        },
      },
    });
    if (terminal.action !== "incomplete") throw new Error("final rejection was not incomplete");
    const projection = terminal.result.seal_diagnostics;
    if (projection === null || typeof projection !== "object" || Array.isArray(projection)) {
      throw new Error("final diagnostic projection is absent");
    }
    const last = projection.latest_diagnostic_ref;
    if (last === null || typeof last !== "object" || Array.isArray(last)) {
      throw new Error("final diagnostic ref is absent");
    }
    const rejected = projection.rejected_draft_ref;
    if (rejected === null || typeof rejected !== "object" || Array.isArray(rejected)) {
      throw new Error("rejected draft ref is absent");
    }
    const record = readJson(service, String(last.artifact_id));
    expect(record).toMatchObject({
      rejection_ordinal: 2,
      corrections_used: 1,
      disposition: "exhausted",
      rejected_draft_ref: { artifact_id: rejected.artifact_id },
      previous_diagnostic_ref: { kind: "seal-diagnostic" },
    });
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
    expect(
      client.invocations.filter((invocation) => invocation.stateId === "adjudicating_diagnosis")
    ).toHaveLength(2);
  });

  it("ignores imported higher-version products and wrong-run/stale seal diagnostics", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      `DIAGNOSIS_CORE:${canonicalJson({ ...supportedDraft(), tests_executed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      persistedDraft(supportedDraft("corrected")),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-diagnose-wrong-run-${sequence}`;
    const terminal = complete(await service.execute(start(runId)));
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("completed context is absent");
    const own = context.selectedArtifacts.find(
      (ref) => ref.kind === "semantic-core" && ref.phase === "sealing_diagnosis"
    );
    const prior = context.selectedArtifacts.find((ref) => ref.kind === "seal-diagnostic");
    if (own === undefined || prior === undefined)
      throw new Error("expected own product and diagnostic");
    context.selectedArtifacts.push({
      ...own,
      run_id: "imported-other-run",
      version: own.version + 200,
    });
    context.selectedArtifacts.push({ ...prior, run_id: "imported-other-run", version: 200 });
    context.stateId = "adjudicating_diagnosis";
    context.previousState = "verifying_diagnosis";
    const playbook = new DiagnosePlaybook(undefined, service.artifacts);
    const directive = playbook.dispatch(context);
    expect(directive.action).toBe("invoke_agent");
    if (directive.action !== "invoke_agent") throw new Error("author dispatch is absent");
    expect(
      directive.input_artifacts.artifacts.some((entry) => entry.ref.kind === "seal-diagnostic")
    ).toBe(false);
    expect(
      directive.input_artifacts.artifacts.filter((entry) => entry.ref.kind === "semantic-core")
    ).toEqual([
      {
        slot: directive.input_artifacts.artifacts.find(
          (entry) => entry.ref.artifact_id === own.artifact_id
        )?.slot,
        ref: own,
      },
    ]);
    expect(terminal.result.output_artifact_ref).toMatchObject({ artifact_id: own.artifact_id });
  });

  it("adopts a persisted seal diagnostic after a normal host fault before checkpoint", async () => {
    const env = environment();
    sequence += 1;
    const runId = `run-diagnose-diagnostic-replay-${sequence}`;
    let faulted = false;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDiagnoseClient([
          stageComplete("Decomposition."),
          stageComplete("Hypotheses."),
          `DIAGNOSIS_CORE:${canonicalJson({ ...supportedDraft(), tests_executed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
        ]),
        playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
        hostFault: (event) => {
          if (!faulted && event.point === "sealing_diagnosis:feedback-persistence") {
            faulted = true;
            throw new Error("injected seal diagnostic interruption");
          }
        },
      });
      await expect(first.execute(start(runId))).rejects.toThrow(
        /injected seal diagnostic interruption/u
      );
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_diagnosis");
    }
    expect(faulted).toBe(true);
    const client = new ScriptedDiagnoseClient([
      persistedDraft(supportedDraft("recovered correction")),
      veraPass(),
    ]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    const terminal = complete(
      await recovered.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      })
    );
    expect(client.invocations.map((invocation) => invocation.stateId)[0]).toBe(
      "adjudicating_diagnosis"
    );
    const diagnostic = client.invocations[0]?.inputArtifacts.find(
      (ref) => ref.kind === "seal-diagnostic"
    );
    if (diagnostic === undefined) throw new Error("adopted diagnostic is absent");
    expect(
      recovered.artifacts.refFor(
        runId,
        "sealing_diagnosis",
        null,
        "seal-diagnostic",
        diagnostic.operation_id,
        1
      )
    ).toEqual(diagnostic);
    expect(readJson(recovered, diagnostic.artifact_id)).toMatchObject({
      rejection_ordinal: 1,
      corrections_used: 0,
      disposition: "correction_offered",
    });
    expect(terminal.met).toBe(true);
  });

  it("keeps the last sealed product separate from an exhausted rejected replacement", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      persistedDraft(supportedDraft()),
      veraGap("analysis_gap"),
      stageComplete("Fresh decomposition."),
      stageComplete("Fresh hypotheses."),
      `DIAGNOSIS_CORE:${canonicalJson({ ...supportedDraft("bad replacement"), tests_executed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      `DIAGNOSIS_CORE:${canonicalJson({ ...supportedDraft("bad correction"), tests_executed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: explicitSealPolicy(DIAGNOSE_PLAYBOOK_REGISTRATION, 1),
    });
    sequence += 1;
    const runId = `run-diagnose-second-epoch-exhausted-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        incomplete_reason: "seal_repair_exhausted",
        output_kind: "rejected_draft",
        seal_diagnostics: {
          correction_limit: 1,
          corrections_used: 1,
          disposition: "exhausted",
          epoch_anchor_ref: { kind: "semantic-core", run_id: runId },
        },
      },
    });
    if (terminal.action !== "incomplete") throw new Error("final rejection must be incomplete");
    const context = service.checkpointer.loadRunById(runId);
    const anchor = context?.selectedArtifacts.find((ref) => ref.kind === "semantic-core");
    if (anchor === undefined) throw new Error("first sealed product is absent");
    expect(terminal.result.output_artifact_ref).not.toMatchObject({
      artifact_id: anchor.artifact_id,
    });
    expect(terminal.result.seal_diagnostics).toMatchObject({
      epoch_anchor_ref: { artifact_id: anchor.artifact_id },
      rejected_draft_ref: terminal.result.output_artifact_ref,
    });
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
  });
  it("refuses a corrupted selected diagnostic before another author dispatch", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      `DIAGNOSIS_CORE:${canonicalJson({ ...supportedDraft(), tests_executed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      `DIAGNOSIS_CORE:${canonicalJson({ ...supportedDraft("still invalid"), tests_executed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: explicitSealPolicy(DIAGNOSE_PLAYBOOK_REGISTRATION, 1),
    });
    sequence += 1;
    const runId = `run-diagnose-corrupt-diagnostic-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("incomplete");
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("saved context is absent");
    const index = context.selectedArtifacts.map((ref) => ref.kind).lastIndexOf("seal-diagnostic");
    if (index < 0) throw new Error("saved diagnostic is absent");
    const original = context.selectedArtifacts[index];
    if (original === undefined) throw new Error("saved diagnostic ref is absent");
    context.selectedArtifacts[index] = { ...original, content_digest: "f".repeat(64) };
    context.stateId = "adjudicating_diagnosis";
    const playbook = new DiagnosePlaybook(undefined, service.artifacts);
    expect(() => playbook.dispatch(context)).toThrow(/diagnostic/u);
    expect(
      client.invocations.filter((invocation) => invocation.stateId === "adjudicating_diagnosis")
    ).toHaveLength(2);
  });
  it("continues productive seal and review repair beyond the former imposed limits", async () => {
    const client = new ScriptedDiagnoseClient([
      stageComplete("Decomposition."),
      stageComplete("Hypotheses."),
      ...Array.from(
        { length: 4 },
        (_value, index) =>
          `Correction ${index}\n` +
          persistedDraft(supportedDraft()).replace(
            /(?:ASSESSMENT_DRAFT|DIAGNOSIS_CORE|DECISION_CORE|STRATEGY_CORE|PRODUCED_ARTIFACT_DRAFT):/u,
            "BROKEN_CORE:"
          )
      ),
      persistedDraft(supportedDraft()),
      ...Array.from({ length: 4 }, (_value, index) => [
        veraGap("diagnosis_product_gap"),
        persistedDraft(supportedDraft(`Changed diagnosis ${index + 1}.`)),
      ]).flat(),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-diagnose-productive-unlimited-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("complete");
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("productive run checkpoint missing");
    expect(context.maxSteps).toBeNull();
    expect(context.maxIterations).toBeNull();
    expect(context.iteration).toBe(4);
    expect(context.selectedArtifacts.filter((ref) => ref.kind === "seal-diagnostic")).toHaveLength(
      4
    );
    expect(
      client.invocations.filter((invocation) => invocation.stateId === "adjudicating_diagnosis")
    ).toHaveLength(9);
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: terminal.identity })
    ).toEqual(terminal);
  });
});
