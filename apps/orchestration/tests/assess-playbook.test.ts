import { explicitSealPolicy } from "./helpers/explicit-cycle-policy.js";
import { RunContext } from "../dist/context.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ASSESS_EFFECT_PHASES,
  ASSESS_PLAYBOOK_REGISTRATION,
  ASSESS_PLAYBOOK_NAME,
  AssessPlaybook,
  FeedbackRouteEvidenceV1Schema,
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
  validateContract,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type AssessmentDraftV2,
  type AssessmentRequestV1,
  type Directive,
  type EffectEvidenceRequestV1,
  type JsonValue,
  type ModelClient,
  type PlaybookRegistration,
} from "../dist/index.js";

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
  for (let index = 0; index < 2; index += 1) {
    const [result] = await service.workers.execute(directive);
    if (result === undefined) throw new Error("fixture phase result is absent");
    directive = service.handle({
      schema_version: 2,
      action: "step",
      identity: identity(runId),
      result,
    });
  }
  if (directive.action !== "invoke_agent" || directive.state_id !== "verifying_assessment")
    throw new Error("fixture did not reach Vera");
  return directive;
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

describe("orchestrated assess workflow", () => {
  it("refuses a missing frozen finite seal policy instead of widening it to unlimited", () => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedAssessClient([]),
      playbookRegistration: explicitSealPolicy(ASSESS_PLAYBOOK_REGISTRATION, 1),
    });
    sequence += 1;
    const runId = `run-assess-missing-seal-policy-${sequence}`;
    const active = service.handle(start(runId));
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("finite policy run missing");
    const snapshot = context.snapshot();
    delete snapshot.seal_correction_limit;
    service.checkpointer.saveRun(RunContext.fromSnapshot(snapshot), "test_policy_omission", {});
    expect(
      service.handle({ schema_version: 2, action: "recover", identity: active.identity })
    ).toMatchObject({ action: "error", result: { code: "REGISTRATION_CONTRACT_MISMATCH" } });
  });

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

  it("terminalizes UNVERIFIABLE durably without author repair, validity receipt or admission", async () => {
    const env = environment();
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
      persistedDraft(meetsDraft()),
      veraUnverifiable(),
    ]);
    sequence += 1;
    const runId = `run-assess-unverifiable-${sequence}`;
    let terminal: Directive;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
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
          verification_report_refs: [expect.objectContaining({ phase: "verifying_assessment" })],
        },
      });
      expect(client.invocations.map((item) => item.agent)).toEqual(["annie", "carren", "vera"]);
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("checkpoint absent");
      expect(context.iteration).toBe(0);
      expect(
        context.selectedArtifacts.some((ref) => ref.kind === "assessment-validity-receipt")
      ).toBe(false);
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      if (terminal.action !== "incomplete") throw new Error("expected incomplete verification");
      expect(terminal.artifacts.map((ref) => ref.kind)).toEqual(["semantic-core", "agent-output"]);
    }
    const recoveredClient = new ScriptedAssessClient([]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    expect(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
    expect(recoveredClient.invocations).toEqual([]);
  });

  it("binds current pre-review native check evidence and recovers the exact task; cancellation stays final", async () => {
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
      persistedDraft(meetsDraft()),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-assess-checks-${sequence}`;
    const pending = await toVera(service, runId);
    const [body, evidence] = pending.task.split("\n\nHOST_MECHANICAL_CHECKS:");
    if (body === undefined || evidence === undefined) throw new Error("pre-review checks absent");
    const value: unknown = JSON.parse(evidence);
    expect(canonicalJson(value)).toBe(evidence);
    expect(value).toEqual({
      schema_version: 1,
      product_ref: pending.input_artifacts.artifacts[3]?.ref,
      source_refs: pending.input_artifacts.artifacts.slice(0, 3).map((entry) => entry.ref),
      checks: [
        "exact_source_ref_custody",
        "canonical_request",
        "parsed_authored_draft",
        "canonical_product_bytes_and_digest",
        "exact_source_lineage",
        "effect_graph_shape_and_scope",
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
    expect(client.invocations.map((item) => item.agent)).toEqual(["annie", "carren"]);
    expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
  });

  it("recovers frozen mechanical evidence with owner-enriched contextual guidance intact", async () => {
    const env = environment();
    const client = new ScriptedAssessClient([
      stageComplete("Producer analysis."),
      persistedDraft(meetsDraft()),
      veraPass(),
      stageComplete("Consumer analysis."),
      persistedDraft(meetsDraft()),
    ]);
    sequence += 1;
    const runId = `run-assess-context-recovery-${sequence}`;
    let pending: Extract<Directive, { action: "invoke_agent" }>;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookName: ASSESS_PLAYBOOK_NAME,
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
    const recoveredClient = new ScriptedAssessClient([]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookName: ASSESS_PLAYBOOK_NAME,
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
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
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
    const runId = `run-assess-task-binding-${sequence}`;
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
    expect(
      context.selectedArtifacts.some((ref) => ref.kind === "assessment-validity-receipt")
    ).toBe(false);
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
      const client = new ScriptedAssessClient([
        stageComplete("Analysis."),
        persistedDraft(meetsDraft()),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
      });
      sequence += 1;
      const runId = `run-assess-invalid-checks-${sequence}`;
      await toVera(service, runId);
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("checkpoint absent");
      if (failure === "ref_digest") {
        context.selectedArtifacts = context.selectedArtifacts.map((ref) =>
          ref.phase === "analyzing_assessment" ? { ...ref, content_digest: "f".repeat(64) } : ref
        );
      } else if (failure === "native_lineage") {
        const original = context.selectedArtifacts.find(
          (ref) => ref.phase === "analyzing_assessment"
        );
        if (original === undefined) throw new Error("analysis absent");
        const replacement = service.artifacts.persist({
          metadata: {
            ...service.artifacts.metadata(original),
            operation_id: "fixture-substituted-analysis",
            version: 1,
            parent_ref: null,
          },
          content: stageComplete(
            "Different analysis with valid custody but wrong product lineage."
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
      expect(client.invocations.map((item) => item.agent)).toEqual(["annie", "carren"]);
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
    }
  );

  it.each(["analysis_gap", "evidence_gap"] as const)(
    "does not infer a stall for %s when only upstream analysis changes",
    async (kind) => {
      const gap = veraGap(kind);
      const draft = persistedDraft(meetsDraft());
      const client = new ScriptedAssessClient([
        stageComplete("The first criterion lacks an evidence mapping."),
        draft,
        gap,
        stageComplete("Criterion 0 maps to supplied evidence 0."),
        draft,
        gap,
        stageComplete("Both criteria now map to their supplied evidence."),
        draft,
        veraPass(),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
      });
      sequence += 1;
      const runId = `run-assess-upstream-${sequence}`;
      complete(await service.execute(start(runId)));
      const reviews = client.invocations.filter((item) => item.agent === "vera");
      expect(reviews).toHaveLength(3);
      const analyses = reviews.map((review) =>
        exactInput(review, "analyzing_assessment", "agent-output")
      );
      expect(new Set(analyses.map((ref) => ref.content_digest)).size).toBe(3);
      for (const review of reviews) {
        const ref = exactInput(review, "authoring_assessment", "assessment-draft");
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

  it.each(["same_bytes", "substance", "transport_only"] as const)(
    "handles product-gap recurrence across an analysis repair with %s upstream",
    async (change) => {
      const analysis = stageComplete("Criterion 0 maps to supplied evidence 0.");
      const replacement =
        change === "same_bytes"
          ? analysis
          : change === "substance"
            ? stageComplete("Criterion 0 contradicts supplied evidence 0.")
            : stageComplete(
                "Criterion 0 maps to supplied evidence 0.\nSource ref: revised-ref; receipt: revised-receipt; revision: 2."
              ).replace('"PROBABLE"', '"CERTAIN"');
      const draft = persistedDraft(meetsDraft());
      const gap = veraGap("assessment_product_gap");
      const client = new ScriptedAssessClient([
        analysis,
        draft,
        gap,
        draft,
        veraGap("analysis_gap"),
        replacement,
        draft,
        gap,
        ...(change === "same_bytes" ? [] : [draft, gap, draft, veraPass()]),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
      });
      sequence += 1;
      const runId = `run-assess-product-basis-${sequence}`;
      const terminal = await service.execute(start(runId));
      expect(terminal).toMatchObject(
        change === "same_bytes"
          ? { action: "incomplete", met: false, result: { incomplete_reason: "repair_stalled" } }
          : { action: "complete", met: true }
      );
      const reviews = client.invocations.filter((item) => item.agent === "vera");
      expect(reviews).toHaveLength(change === "same_bytes" ? 3 : 5);
      const before = exactInput(reviews[0], "analyzing_assessment", "agent-output");
      const after = exactInput(reviews[2], "analyzing_assessment", "agent-output");
      expect(after.artifact_id).not.toBe(before.artifact_id);
      expect(after.content_digest === before.content_digest).toBe(change === "same_bytes");
      for (const review of reviews) {
        const ref = exactInput(review, "authoring_assessment", "assessment-draft");
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

  it("stalls an identical semantic candidate and failure despite new revisions and strategy prose", async () => {
    const env = environment();
    const gap = veraGap("assessment_product_gap");
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
      persistedDraft(meetsDraft()),
      gap,
      persistedDraft(meetsDraft()),
      gap.replace(
        "Replace the assessment_product_gap without external verification or actions.",
        "A different strategy claim with identical failure."
      ),
    ]);
    sequence += 1;
    const runId = `run-assess-stall-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
      });
      const pending = await toVera(first, runId);
      const [result] = await first.workers.execute(pending);
      if (result === undefined) throw new Error("review result absent");
      expect(
        first.handle({ schema_version: 2, action: "step", identity: identity(runId), result })
      ).toMatchObject({ action: "invoke_agent", state_id: "authoring_assessment" });
      expect(
        first.checkpointer.events(runId).some((event) => {
          const value = event.payload.feedback_route_evidence_v1;
          return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            value.repair_progress_v1 !== undefined
          );
        })
      ).toBe(true);
    }
    let terminal: Directive;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
      });
      terminal = await service.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: {
          incomplete_reason: "repair_stalled",
          repair_stall: {
            feedback_report_refs: [expect.objectContaining({ phase: "verifying_assessment" })],
          },
        },
      });
      expect(client.invocations.map((item) => item.agent)).toEqual([
        "annie",
        "carren",
        "vera",
        "carren",
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
          (ref) => ref.phase === "verifying_assessment" && ref.kind === "agent-output"
        )
      ).toHaveLength(2);
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
    }
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedAssessClient([]),
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    expect(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
  });

  it("continues on changed semantic candidates with the same failure and rechecks each sealed product", async () => {
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
      persistedDraft(meetsDraft("First.")),
      veraGap("assessment_product_gap"),
      persistedDraft(meetsDraft("Changed meaning.")),
      veraGap("assessment_product_gap"),
      persistedDraft(meetsDraft("Further changed meaning.")),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-assess-changed-${sequence}`)));
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

  it("refuses a judgment-free source instead of acquiring PASS through routing repair", async () => {
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
    const terminal = await service.execute(start(`run-assess-routing-${sequence}`));
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_assessment",
      "authoring_assessment",
      "verifying_assessment",
    ]);
    expect(service.checkpointer.completionAdmission(terminal.identity.run_id)).toBeUndefined();
    if (terminal.action !== "incomplete") throw new Error("expected source judgment refusal");
    expect(terminal.artifacts.some((ref) => ref.kind === "assessment-validity-receipt")).toBe(
      false
    );
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
      const firstProduct = client.invocations[2]?.inputArtifacts.find(
        (ref) => ref.kind === "semantic-core" && ref.phase === "sealing_assessment"
      );
      const finalProduct = terminal.artifacts.filter(
        (ref) => ref.kind === "semantic-core" && ref.phase === "sealing_assessment"
      );
      expect(firstProduct).toMatchObject({ version: 1 });
      expect(finalProduct).toEqual([expect.objectContaining({ version: 1 })]);
      expect(finalProduct[0]?.artifact_id).not.toBe(firstProduct?.artifact_id);
      expect(finalProduct[0]?.operation_id).not.toBe(firstProduct?.operation_id);
      expect(client.invocations[5]?.inputArtifacts).toContainEqual(finalProduct[0]);
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
    expect(product).toMatchObject({ version: 1 });
    const firstVera = client.invocations[2];
    const repairAuthor = client.invocations[3];
    const nextVera = client.invocations[4];
    if (firstVera === undefined || repairAuthor === undefined || nextVera === undefined) {
      throw new Error("assessment repair invocations are absent");
    }
    const firstProduct = firstVera.inputArtifacts.find((ref) => ref.kind === "semantic-core");
    const firstReport = repairAuthor.inputArtifacts.find(
      (ref) => ref.phase === "verifying_assessment"
    );
    if (firstProduct === undefined || firstReport === undefined) {
      throw new Error("assessment repair predecessor is absent");
    }
    expect(firstProduct.version).toBe(1);
    expect(repairAuthor.inputArtifacts).toContainEqual(firstProduct);
    expect(product.artifact_id).not.toBe(firstProduct.artifact_id);
    expect(product.operation_id).not.toBe(firstProduct.operation_id);
    expect(service.artifacts.readById(firstReport.artifact_id).toString("utf8")).toContain(
      "assessment_product_gap"
    );
    expect(nextVera.inputArtifacts).toContainEqual(firstReport);
    expect(nextVera.inputArtifacts.find((ref) => ref.kind === "semantic-core")).toMatchObject({
      artifact_id: product.artifact_id,
      version: 1,
    });
    expect(nextVera.inputArtifacts.find((ref) => ref.kind === "assessment-draft")).toMatchObject({
      version: 2,
    });
    expect(nextVera.task).toContain("historical regression context only");
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
    const registration: PlaybookRegistration = {
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
    const registration: PlaybookRegistration = {
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
      env: { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" },
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
    const veraTurns = client.invocations.filter((invocation) => invocation.agent === "vera");
    const authorTurns = client.invocations.filter((invocation) => invocation.agent === "carren");
    for (let index = 1; index < veraTurns.length; index += 1) {
      const previousReport = authorTurns[index]?.inputArtifacts.find(
        (ref) => ref.phase === "verifying_assessment"
      );
      if (previousReport === undefined) throw new Error("previous Vera report is absent");
      expect(
        veraTurns[index]?.inputArtifacts.filter((ref) => ref.phase === "verifying_assessment")
      ).toEqual([previousReport]);
      expect(
        veraTurns[index]?.inputArtifacts.filter((ref) => ref.kind === "semantic-core")
      ).toHaveLength(1);
    }
  });
  it("gives a reviewer replacement a fresh seal correction, without stale diagnostic input", async () => {
    const client = new ScriptedAssessClient([
      stageComplete("First analysis."),
      `ASSESSMENT_DRAFT:${canonicalJson({ ...meetsDraft("bad first"), external_actions_performed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      persistedDraft(meetsDraft("first corrected")),
      veraGap("analysis_gap"),
      stageComplete("Fresh analysis."),
      `ASSESSMENT_DRAFT:${canonicalJson({ ...meetsDraft("bad second"), external_actions_performed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      persistedDraft(meetsDraft("second corrected")),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-assess-epoch-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_assessment",
      "authoring_assessment",
      "authoring_assessment",
      "verifying_assessment",
      "analyzing_assessment",
      "authoring_assessment",
      "authoring_assessment",
      "verifying_assessment",
    ]);
    const firstCorrection = client.invocations[2];
    const secondInitial = client.invocations[5];
    const secondCorrection = client.invocations[6];
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
    const client = new ScriptedAssessClient([
      stageComplete("First analysis."),
      `ASSESSMENT_DRAFT:${canonicalJson({ ...meetsDraft("first invalid"), external_actions_performed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      `ASSESSMENT_DRAFT:${canonicalJson({ ...meetsDraft("second invalid"), external_actions_performed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: explicitSealPolicy(ASSESS_PLAYBOOK_REGISTRATION, 1),
    });
    sequence += 1;
    const runId = `run-assess-final-seal-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        incomplete_reason: "seal_repair_exhausted",
        output_kind: "rejected_draft",
        output_artifact_ref: { kind: "assessment-draft" },
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
      client.invocations.filter((invocation) => invocation.stateId === "authoring_assessment")
    ).toHaveLength(2);
  });

  it("ignores imported higher-version products and wrong-run/stale seal diagnostics", async () => {
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
      `ASSESSMENT_DRAFT:${canonicalJson({ ...meetsDraft(), external_actions_performed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      persistedDraft(meetsDraft("corrected")),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-assess-wrong-run-${sequence}`;
    const terminal = complete(await service.execute(start(runId)));
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("completed context is absent");
    const own = context.selectedArtifacts.find(
      (ref) => ref.kind === "semantic-core" && ref.phase === "sealing_assessment"
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
    context.stateId = "authoring_assessment";
    context.previousState = "verifying_assessment";
    const playbook = new AssessPlaybook(undefined, service.artifacts);
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
    const runId = `run-assess-diagnostic-replay-${sequence}`;
    let faulted = false;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedAssessClient([
          stageComplete("Analysis."),
          `ASSESSMENT_DRAFT:${canonicalJson({ ...meetsDraft(), external_actions_performed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
        ]),
        playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
        hostFault: (event) => {
          if (!faulted && event.point === "sealing_assessment:feedback-persistence") {
            faulted = true;
            throw new Error("injected seal diagnostic interruption");
          }
        },
      });
      await expect(first.execute(start(runId))).rejects.toThrow(
        /injected seal diagnostic interruption/u
      );
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_assessment");
    }
    expect(faulted).toBe(true);
    const client = new ScriptedAssessClient([
      persistedDraft(meetsDraft("recovered correction")),
      veraPass(),
    ]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    const terminal = complete(
      await recovered.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      })
    );
    expect(client.invocations.map((invocation) => invocation.stateId)[0]).toBe(
      "authoring_assessment"
    );
    const diagnostic = client.invocations[0]?.inputArtifacts.find(
      (ref) => ref.kind === "seal-diagnostic"
    );
    if (diagnostic === undefined) throw new Error("adopted diagnostic is absent");
    expect(
      recovered.artifacts.refFor(
        runId,
        "sealing_assessment",
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
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
      persistedDraft(meetsDraft()),
      veraGap("analysis_gap"),
      stageComplete("Reanalysis."),
      `ASSESSMENT_DRAFT:${canonicalJson({ ...meetsDraft("bad replacement"), external_actions_performed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      `ASSESSMENT_DRAFT:${canonicalJson({ ...meetsDraft("bad correction"), external_actions_performed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: explicitSealPolicy(ASSESS_PLAYBOOK_REGISTRATION, 1),
    });
    sequence += 1;
    const runId = `run-assess-second-epoch-exhausted-${sequence}`;
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
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
      `ASSESSMENT_DRAFT:${canonicalJson({ ...meetsDraft(), external_actions_performed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      `ASSESSMENT_DRAFT:${canonicalJson({ ...meetsDraft("still invalid"), external_actions_performed: true })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: explicitSealPolicy(ASSESS_PLAYBOOK_REGISTRATION, 1),
    });
    sequence += 1;
    const runId = `run-assess-corrupt-diagnostic-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("incomplete");
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("saved context is absent");
    const index = context.selectedArtifacts.map((ref) => ref.kind).lastIndexOf("seal-diagnostic");
    if (index < 0) throw new Error("saved diagnostic is absent");
    const original = context.selectedArtifacts[index];
    if (original === undefined) throw new Error("saved diagnostic ref is absent");
    context.selectedArtifacts[index] = { ...original, content_digest: "f".repeat(64) };
    context.stateId = "authoring_assessment";
    const playbook = new AssessPlaybook(undefined, service.artifacts);
    expect(() => playbook.dispatch(context)).toThrow(/diagnostic/u);
    expect(
      client.invocations.filter((invocation) => invocation.stateId === "authoring_assessment")
    ).toHaveLength(2);
  });
  it("continues productive seal and review repair beyond the former imposed limits", async () => {
    const client = new ScriptedAssessClient([
      stageComplete("Analysis."),
      ...Array.from(
        { length: 4 },
        (_value, index) =>
          `Correction ${index}\n` +
          persistedDraft(meetsDraft()).replace(
            /(?:ASSESSMENT_DRAFT|DIAGNOSIS_CORE|DECISION_CORE|STRATEGY_CORE|PRODUCED_ARTIFACT_DRAFT):/u,
            "BROKEN_CORE:"
          )
      ),
      persistedDraft(meetsDraft()),
      ...Array.from({ length: 4 }, (_value, index) => [
        veraGap("assessment_product_gap"),
        persistedDraft(meetsDraft(`Changed assessment ${index + 1}.`)),
      ]).flat(),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: ASSESS_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-assess-productive-unlimited-${sequence}`;
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
      client.invocations.filter((invocation) => invocation.stateId === "authoring_assessment")
    ).toHaveLength(9);
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: terminal.identity })
    ).toEqual(terminal);
  });
});
