import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ASSESS_EFFECT_PHASES,
  ASSESS_PLAYBOOK_REGISTRATION,
  ASSESS_PLAYBOOK_NAME,
  AssessPlaybook,
  OrchestrationService,
  UNKNOWN_EFFECT_LIMITATION,
  canonicalJson,
  evaluateAssessLatestVerifiedAssessmentDod,
  initializePennyState,
  sha256,
  unknownEffectEvidenceGraph,
  validateAssessmentV2,
  validateAssessmentEvidenceBundle,
  validateAssessmentProductEnvelopeV2,
  validateAssessmentProductIntegrityV2,
  validateAssessmentValidityReceiptV2,
  validateEffectEvidenceGraph,
  type AgentCompletion,
  type AgentInvocation,
  type AssessmentDraftV2,
  type AssessmentRequestV1,
  type Directive,
  type EffectEvidenceRequestV1,
  type JsonValue,
  type ModelClient,
  type PlaybookRegistrationV1,
} from "../src/index.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
let sequence = 0;

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-assess-playbook-"));
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

function request(): AssessmentRequestV1 {
  return {
    schema_version: 1,
    assessment_purpose: "Assess the supplied release note.",
    target: [
      { statement: "Maintenance starts Tuesday at 09:00 UTC." },
      { statement: "Thanks for your patience." },
    ],
    criteria: [
      { statement: "States the maintenance time clearly.", importance: "required" },
      { statement: "Uses a courteous tone.", importance: "advisory" },
    ],
    supplied_evidence: [
      { statement: "The note names Tuesday at 09:00 UTC." },
      { statement: "The note thanks its audience." },
    ],
    hard_constraints: [{ statement: "Do not externally verify the schedule." }],
    non_goals: [{ statement: "Do not rewrite or send the note." }],
    known_uncertainties: [{ statement: "The audience was not specified." }],
  };
}

function identity(runId: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook: ASSESS_PLAYBOOK_NAME,
    engine_owner: "typescript" as const,
  };
}

function start(runId: string) {
  const value = request();
  const { assessment_purpose: goal, ...constraints } = value;
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
    assessment_purpose_covered: true as const,
    target_statement_indexes: [0, 1],
    criterion_indexes: [0, 1],
    supplied_evidence_indexes: [0, 1],
    hard_constraint_indexes: [0],
    non_goal_indexes: [0],
    known_uncertainty_indexes: [0],
  };
}

function meetsDraft(summary = "The note satisfies both criteria."): AssessmentDraftV2 {
  return {
    schema_version: 2,
    disposition: "meets",
    criterion_outcomes: [
      {
        criterion_index: 0,
        verdict: "met",
        supporting_evidence_indexes: [0],
        contradicting_evidence_indexes: [],
        rationale: "The supplied material states a precise maintenance time.",
      },
      {
        criterion_index: 1,
        verdict: "met",
        supporting_evidence_indexes: [1],
        contradicting_evidence_indexes: [],
        rationale: "The supplied material contains a courteous close.",
      },
    ],
    summary,
    strengths: [
      {
        statement: "The note is precise and courteous.",
        criterion_indexes: [0, 1],
        evidence_indexes: [0, 1],
      },
    ],
    gaps: [],
    improvement_suggestions: [],
    assumptions: [],
    uncertainties: [],
    request_coverage: coverage(),
    confidence: "PROBABLE",
  };
}

function inconclusiveDraft(): AssessmentDraftV2 {
  return {
    ...meetsDraft("The supplied material is insufficient for a required conclusion."),
    disposition: "inconclusive",
    criterion_outcomes: [
      {
        criterion_index: 0,
        verdict: "not_assessable",
        supporting_evidence_indexes: [],
        contradicting_evidence_indexes: [],
        rationale: "The required timing criterion cannot be assessed from the supplied material.",
      },
      {
        criterion_index: 1,
        verdict: "met",
        supporting_evidence_indexes: [1],
        contradicting_evidence_indexes: [],
        rationale: "The note includes a courteous close.",
      },
    ],
    strengths: [
      {
        statement: "The note is courteous.",
        criterion_indexes: [1],
        evidence_indexes: [1],
      },
    ],
    uncertainties: ["The supplied material does not establish the required maintenance time."],
    confidence: "UNCERTAIN",
  };
}

function persistedDraft(draft: AssessmentDraftV2): string {
  return `ASSESSMENT_DRAFT:${canonicalJson(draft)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`;
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
    evidence: [
      "The exact current AssessmentV2 satisfies coverage, index, disposition, and lineage checks.",
    ],
    strategy_delta: "Admit only this exact current assessment product.",
  })}`;
}

function veraGap(kind: "analysis_gap" | "evidence_gap" | "assessment_product_gap"): string {
  return `Verification failure.\nSUMMARY:${JSON.stringify({
    confidence: "PROBABLE",
    verdict: "FAIL",
    gap_kind: kind,
    repair_owner: kind === "assessment_product_gap" ? "carren" : "annie",
    findings: [`The exact assessment has a ${kind}.`],
    evidence: ["The current product disagrees with its exact supplied basis."],
    strategy_delta: `Replace the ${kind} without external verification or actions.`,
  })}`;
}

function completeNoEventEffects(requestValue: EffectEvidenceRequestV1) {
  const base = structuredClone(
    unknownEffectEvidenceGraph({ runId: requestValue.run_id, phases: requestValue.phases })
  );
  return validateEffectEvidenceGraph(
    {
      ...base,
      categories: base.categories.map((entry) => ({
        ...entry,
        observation: {
          status: "observed",
          scope: entry.policy.scope,
          coverage: "complete",
          result: "no_event",
          evidence_refs: [
            {
              evidence_id: `synthetic-trace:${requestValue.run_id}:${entry.category}`,
              evidence_sha256: sha256(`${requestValue.run_id}:${entry.category}`),
              media_type: "application/json",
            },
          ],
        },
      })),
      assurance: "bounded_no_violation",
      limitations: [],
    },
    { runId: requestValue.run_id, phases: requestValue.phases }
  );
}

function routingOnly(output: string): string {
  const marker = output.lastIndexOf("SUMMARY:");
  if (marker < 0) throw new Error("scripted routing summary is absent");
  return output.slice(marker);
}

class ScriptedAssessClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private next = 0;

  constructor(private readonly outputs: readonly string[]) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const text = this.outputs[this.next];
    this.next += 1;
    if (text === undefined) throw new Error("scripted Assess output is exhausted");
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

describe("orchestrated assess workflow", () => {
  it("rejects every caller artifact envelope before model work", async () => {
    const client = new ScriptedAssessClient([]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    await expect(
      service.execute({
        ...start(`run-assess-artifact-reject-${sequence}`),
        input_artifacts: { schema_version: 2, artifacts: [] },
      })
    ).rejects.toThrow(/accepts a closed inline target and no caller artifact inputs/u);
    expect(client.invocations).toEqual([]);
  });

  it("completes host → Annie → Carren → seal → Vera → host admission with exact evidence", async () => {
    const client = new ScriptedAssessClient([
      stageComplete("Criterion and evidence decomposition."),
      persistedDraft(meetsDraft()),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-assess-happy-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_assessment",
      "authoring_assessment",
      "verifying_assessment",
    ]);
    expect(client.invocations.map((invocation) => invocation.agent)).toEqual([
      "annie",
      "carren",
      "vera",
    ]);
    expect(
      client.invocations.map((invocation) => invocation.inputArtifacts.map((ref) => ref.phase))
    ).toEqual([
      ["intake"],
      ["intake", "analyzing_assessment"],
      ["intake", "analyzing_assessment", "authoring_assessment", "sealing_assessment"],
    ]);
    const product = terminal.result.output_artifact_ref;
    if (product === null || typeof product !== "object" || Array.isArray(product)) {
      throw new Error("assessment product ref is absent");
    }
    expect(validateAssessmentV2(readJson(service, String(product.artifact_id)))).toMatchObject({
      disposition: "meets",
      effect_evidence: { assurance: "unknown" },
    });
    const validity = terminal.artifacts.find(
      (artifact) => artifact.kind === "assessment-validity-receipt"
    );
    const integrity = terminal.artifacts.find(
      (artifact) => artifact.kind === "assessment-product-integrity"
    );
    const envelope = terminal.artifacts.find(
      (artifact) => artifact.kind === "assessment-product-envelope"
    );
    if (validity === undefined || integrity === undefined || envelope === undefined) {
      throw new Error("exact assessment product graph is incomplete");
    }
    expect(
      validateAssessmentValidityReceiptV2(readJson(service, validity.artifact_id))
    ).toMatchObject({
      verdict: "PASS",
      reviewer: "vera",
      assessment_ref: { artifact_id: product.artifact_id },
      effect_evidence: { assurance: "unknown" },
    });
    expect(
      validateAssessmentProductIntegrityV2(readJson(service, integrity.artifact_id))
    ).toMatchObject({
      status: "PASS",
      assessment_ref: { artifact_id: product.artifact_id },
      effect_evidence: { assurance: "unknown" },
    });
    expect(
      validateAssessmentProductEnvelopeV2(readJson(service, envelope.artifact_id))
    ).toMatchObject({
      status: "complete",
      assessment_ref: { artifact_id: product.artifact_id },
      validity_receipt_ref: { artifact_id: validity.artifact_id },
      integrity_ref: { artifact_id: integrity.artifact_id },
    });
    expect(
      validateAssessmentEvidenceBundle({
        runId: terminal.identity.run_id,
        phases: ASSESS_EFFECT_PHASES,
        assessment: readJson(service, String(product.artifact_id)),
        validityReceipt: readJson(service, validity.artifact_id),
        integrity: readJson(service, integrity.artifact_id),
        envelope: readJson(service, envelope.artifact_id),
      })
    ).toMatchObject({ contract_version: 2, effect_evidence: { assurance: "unknown" } });
    expect(
      terminal.artifacts.some((artifact) =>
        /carren.*approval|approval.*carren/iu.test(artifact.kind)
      )
    ).toBe(false);
    expect(terminal).toMatchObject({
      action: "complete",
      met: true,
      unresolved: [],
      result: {
        effect_assurance: "unknown",
        effect_limitation: UNKNOWN_EFFECT_LIMITATION,
      },
    });
    expect(service.checkpointer.completionAdmission(terminal.identity.run_id)).toBeDefined();

    const missingEffectLimitation = structuredClone(terminal);
    delete missingEffectLimitation.result.effect_limitation;
    const completedContext = service.checkpointer.loadRunById(terminal.identity.run_id);
    if (completedContext === undefined) throw new Error("completed Assess context is absent");
    expect(
      evaluateAssessLatestVerifiedAssessmentDod({
        checkpointer: service.checkpointer,
        context: completedContext,
        terminal: missingEffectLimitation,
        originState: "admitting_assessment",
        latestProduct: {
          selector: "terminal_artifact",
          schema_id: "penny.assessment.v2",
          product_schema_version: 2,
          product_id: String(product.artifact_id),
          sha256: String(product.content_digest),
        },
        artifactReader: service.artifacts,
        projectRoot: PROJECT_ROOT,
      })
    ).toEqual({ passed: false, evidence_refs: [] });

    const staleVeraContext = service.checkpointer.loadRunById(terminal.identity.run_id);
    if (staleVeraContext === undefined) throw new Error("completed Assess context is absent");
    staleVeraContext.selectedArtifacts = staleVeraContext.selectedArtifacts.map((artifact) =>
      artifact.phase === "verifying_assessment" && artifact.producer === "agent:vera"
        ? { ...artifact, artifact_id: `art_${"f".repeat(64)}` }
        : artifact
    );
    expect(
      evaluateAssessLatestVerifiedAssessmentDod({
        checkpointer: service.checkpointer,
        context: staleVeraContext,
        terminal,
        originState: "admitting_assessment",
        latestProduct: {
          selector: "terminal_artifact",
          schema_id: "penny.assessment.v2",
          product_schema_version: 2,
          product_id: String(product.artifact_id),
          sha256: String(product.content_digest),
        },
        artifactReader: service.artifacts,
        projectRoot: PROJECT_ROOT,
      })
    ).toEqual({ passed: false, evidence_refs: [] });
  });

  it("admits one synthetic complete no-event trace as bounded evidence without claiming confinement", async () => {
    const requests: EffectEvidenceRequestV1[] = [];
    const client = new ScriptedAssessClient([
      stageComplete("Criterion and evidence decomposition."),
      persistedDraft(meetsDraft()),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
      effectEvidenceProvider: {
        collect: (requestValue) => {
          requests.push(requestValue);
          return completeNoEventEffects(requestValue);
        },
      },
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-assess-trace-${sequence}`)));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      phases: ASSESS_EFFECT_PHASES,
      subject: "worker_and_task_effects",
      host_artifact_writes: "excluded",
    });
    expect(terminal.result).toMatchObject({
      effect_assurance: "bounded_no_violation",
      effect_limitation: null,
      effect_evidence: {
        assurance: "bounded_no_violation",
        host_artifact_writes: { included_in_worker_effect_assurance: false },
      },
    });
    expect(String(terminal.result.effect_scope_notice)).toMatch(/does not establish full/u);
  });

  it("counts a malformed Vera summary repaired as routing metadata as one execution group", async () => {
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
      persistedDraft(meetsDraft()),
      `Verification report.\nSUMMARY:{"confidence":"PROBABLE"}`,
      routingOnly(veraPass()),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-assess-routing-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_assessment",
      "authoring_assessment",
      "verifying_assessment",
      "verifying_assessment",
    ]);
    expect(client.invocations[3]?.executionPurpose).toBe("routing_repair");
    expect(terminal.result).toMatchObject({
      effect_assurance: "unknown",
      effect_limitation: UNKNOWN_EFFECT_LIMITATION,
    });
  });

  it("routes analysis/evidence gaps through Annie then Carren, reseals, and reverifies", async () => {
    for (const kind of ["analysis_gap", "evidence_gap"] as const) {
      const client = new ScriptedAssessClient([
        stageComplete("Initial analysis."),
        persistedDraft(meetsDraft("Initial assessment.")),
        veraGap(kind),
        stageComplete(`Replacement analysis after ${kind}.`),
        persistedDraft(meetsDraft(`Replacement assessment after ${kind}.`)),
        veraPass(),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
      });
      sequence += 1;
      const terminal = complete(await service.execute(start(`run-assess-${kind}-${sequence}`)));
      expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
        "analyzing_assessment",
        "authoring_assessment",
        "verifying_assessment",
        "analyzing_assessment",
        "authoring_assessment",
        "verifying_assessment",
      ]);
      expect(
        terminal.artifacts.filter(
          (artifact) => artifact.kind === "semantic-core" && artifact.phase === "sealing_assessment"
        )
      ).toEqual([expect.objectContaining({ version: 2 })]);
      expect(terminal.result).toMatchObject({
        effect_assurance: "unknown",
        effect_limitation: UNKNOWN_EFFECT_LIMITATION,
      });
    }
  });

  it("routes an assessment product gap directly to Carren and accepts inconclusive completion", async () => {
    const client = new ScriptedAssessClient([
      stageComplete("Initial analysis."),
      persistedDraft(meetsDraft("Needs product correction.")),
      veraGap("assessment_product_gap"),
      persistedDraft(inconclusiveDraft()),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-assess-product-gap-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_assessment",
      "authoring_assessment",
      "verifying_assessment",
      "authoring_assessment",
      "verifying_assessment",
    ]);
    const product = terminal.result.output_artifact_ref;
    if (product === null || typeof product !== "object" || Array.isArray(product)) {
      throw new Error("assessment product ref is absent");
    }
    expect(product).toMatchObject({ version: 2 });
    expect(validateAssessmentV2(readJson(service, String(product.artifact_id)))).toMatchObject({
      disposition: "inconclusive",
      effect_evidence: { assurance: "unknown" },
    });
  });

  it("uses one host seal-feedback repair and never admits a consequence claim", async () => {
    const invalid = { ...meetsDraft(), external_actions_performed: true };
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
      `ASSESSMENT_DRAFT:${canonicalJson(invalid)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      persistedDraft(meetsDraft("Replacement after host seal feedback.")),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-assess-seal-repair-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_assessment",
      "authoring_assessment",
      "authoring_assessment",
      "verifying_assessment",
    ]);
    expect(terminal.result).toMatchObject({
      effect_assurance: "unknown",
      effect_limitation: UNKNOWN_EFFECT_LIMITATION,
    });
  });

  it("recovers host-sealed assessment persistence without duplicating the product revision", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistrationV1 = {
      ...ASSESS_PLAYBOOK_REGISTRATION,
      construct: (options) =>
        new AssessPlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === "sealing_assessment:artifact-persistence") {
              interrupted = true;
              throw new Error("injected assessment seal interruption");
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-assess-seal-recovery-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedAssessClient([
          stageComplete("Analysis."),
          persistedDraft(meetsDraft()),
        ]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(
        /injected assessment seal interruption/u
      );
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_assessment");
    }
    const recoveredClient = new ScriptedAssessClient([veraPass()]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    const terminal = complete(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    expect(
      terminal.artifacts.filter(
        (artifact) => artifact.kind === "semantic-core" && artifact.phase === "sealing_assessment"
      )
    ).toEqual([expect.objectContaining({ version: 1 })]);
    expect(recoveredClient.invocations.map((invocation) => invocation.stateId)).toEqual([
      "verifying_assessment",
    ]);
  });

  it("recovers interrupted validity/integrity admission without another model call", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistrationV1 = {
      ...ASSESS_PLAYBOOK_REGISTRATION,
      construct: (options) =>
        new AssessPlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === "admitting_assessment:integrity-persistence") {
              interrupted = true;
              throw new Error("injected assessment integrity interruption");
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-assess-integrity-recovery-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedAssessClient([
          stageComplete("Analysis."),
          persistedDraft(meetsDraft()),
          veraPass(),
        ]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(
        /injected assessment integrity interruption/u
      );
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("admitting_assessment");
    }
    const recoveredClient = new ScriptedAssessClient([]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    const terminal = complete(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    expect(recoveredClient.invocations).toEqual([]);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "assessment-validity-receipt")
    ).toHaveLength(1);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "assessment-product-integrity")
    ).toHaveLength(1);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "assessment-product-envelope")
    ).toHaveLength(1);
    const validity = terminal.artifacts.find(
      (artifact) => artifact.kind === "assessment-validity-receipt"
    );
    if (validity === undefined) throw new Error("recovered validity receipt is absent");
    const recoveredEffects = validateAssessmentValidityReceiptV2(
      readJson(recovered, validity.artifact_id)
    ).effect_evidence;
    expect(terminal.result.effect_evidence).toEqual(recoveredEffects);
    expect(terminal.result.effect_limitation).toBe(UNKNOWN_EFFECT_LIMITATION);
  });

  it("terminates repeated product gaps as bounded non-positive incomplete", async () => {
    const outputs = [stageComplete("Analysis.")];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      outputs.push(persistedDraft(meetsDraft(`Attempt ${attempt + 1}.`)));
      outputs.push(veraGap("assessment_product_gap"));
    }
    const client = new ScriptedAssessClient(outputs);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-assess-exhaust-${sequence}`));
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        incomplete_reason: "repair_budget_exhausted",
        exhausted: true,
        exhaustion_reason: "verifying_assessment:assessment_product_gap",
        effect_assurance: "unknown",
        effect_limitation: UNKNOWN_EFFECT_LIMITATION,
      },
    });
    expect(client.invocations.filter((invocation) => invocation.agent === "carren")).toHaveLength(
      4
    );
  });
});
