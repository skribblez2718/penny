import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DIAGNOSE_CANDIDATE_REGISTRATION,
  DIAGNOSE_PLAYBOOK_NAME,
  DiagnosePlaybook,
  OrchestrationService,
  canonicalJson,
  initializePennyState,
  validateDiagnosis,
  validateDiagnosisProductEnvelope,
  validateDiagnosisProductIntegrity,
  validateDiagnosisValidityReceipt,
  type AgentCompletion,
  type AgentInvocation,
  type DiagnosisDraftV1,
  type DiagnosisRequestV1,
  type Directive,
  type JsonValue,
  type ModelClient,
  type PlaybookRegistrationV1,
} from "../src/index.js";

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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("orchestrated diagnose candidate", () => {
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
      playbookRegistration: DIAGNOSE_CANDIDATE_REGISTRATION,
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
        playbookRegistration: DIAGNOSE_CANDIDATE_REGISTRATION,
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
      ]);
      expect(client.invocations[6]?.inputArtifacts.map((ref) => ref.phase)).toEqual([
        "intake",
        "decomposing_causes",
        "generating_hypotheses",
      ]);
      expect(
        terminal.artifacts.filter(
          (artifact) => artifact.kind === "semantic-core" && artifact.phase === "sealing_diagnosis"
        )
      ).toHaveLength(1);
      expect(terminal.result).toMatchObject({ tests_executed: false, remediation_started: false });
    }
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
      playbookRegistration: DIAGNOSE_CANDIDATE_REGISTRATION,
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
      playbookRegistration: DIAGNOSE_CANDIDATE_REGISTRATION,
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
    expect(terminal.artifacts.some((artifact) => artifact.kind === "diagnosis-seal-feedback")).toBe(
      false
    );
    expect(terminal.result).toMatchObject({ tests_executed: false, remediation_started: false });
  });

  it("recovers after host seal persistence without creating a duplicate diagnosis revision", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistrationV1 = {
      ...DIAGNOSE_CANDIDATE_REGISTRATION,
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
      playbookRegistration: DIAGNOSE_CANDIDATE_REGISTRATION,
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
    const registration: PlaybookRegistrationV1 = {
      ...DIAGNOSE_CANDIDATE_REGISTRATION,
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
      playbookRegistration: DIAGNOSE_CANDIDATE_REGISTRATION,
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

  it("terminates repeated product gaps as bounded non-positive incomplete", async () => {
    const outputs = [stageComplete("Decomposition."), stageComplete("Hypotheses.")];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      outputs.push(persistedDraft(supportedDraft(`Attempt ${attempt + 1}.`)));
      outputs.push(veraGap("diagnosis_product_gap"));
    }
    const client = new ScriptedDiagnoseClient(outputs);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DIAGNOSE_CANDIDATE_REGISTRATION,
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
});
