import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OrchestrationService,
  DefinePlaybook,
  DEFINE_PLAYBOOK_REGISTRATION,
  canonicalJson,
  sha256,
  MAX_DEFINITION_TRACE_BYTES,
  evidenceAdmissionV2Id,
  DEFINE_SEAL_POLICY,
  type DefinitionTraceV1,
  type EvidenceAdmissionV2,
  defineRequestConstraints,
  definitionQuestionId,
  initializePennyState,
  validateDefinitionTraceV1,
  validateEvidenceAdmissionV2,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
  type SpecificationDraftV3,
} from "../dist/index.js";
import { sealOperationId } from "../dist/playbooks/seal-attempt.js";
import { sealPolicySha256 } from "../dist/skill-contracts/sealing.js";
import {
  genericSpecificationFixture,
  persistedSpecificationDraftV3,
} from "./fixtures/define-fixtures.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function env(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-define-stage2-"));
  roots.push(root);
  const vars = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(projectRoot, { env: vars });
  return vars;
}
function draft(supportClaims: SpecificationDraftV3["support_claims"] = []): string {
  const fixture = genericSpecificationFixture();
  return Buffer.from(
    persistedSpecificationDraftV3(fixture.draft, fixture.request, supportClaims)
  ).toString("utf8");
}
function start(runId: string) {
  const request = genericSpecificationFixture().request;
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: {
      schema_version: 2 as const,
      run_id: runId,
      session_id: runId,
      playbook: "define",
      engine_owner: "typescript" as const,
    },
    goal: request.goal,
    constraints: defineRequestConstraints(request),
    project_root: projectRoot,
    trust_profile: "hardened-untrusted" as const,
  };
}
class Client implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  constructor(private readonly outputs: readonly string[]) {}
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const text = this.outputs[this.invocations.length - 1];
    if (text === undefined) throw new Error("unexpected Define worker");
    return { text };
  }
}
const orientation = `Framed for authoring.\nSUMMARY:${canonicalJson({
  confidence: "CERTAIN",
  orientation_complete: true,
  gap_kind: "none",
  repair_owner: "none",
  selected_profile_id: "generic",
  profile_selection_basis: "Caller chose generic.",
  route: "author",
  route_reason: "No missing facts.",
  clarification_questions: [],
  evidence_questions: [],
  findings: [],
  specification_delta: "No change.",
})}`;

describe("active Define stage 2", () => {
  it("seals V2 admission and product-bound trace before any review, adopting a crash after trace persistence", async () => {
    const vars = env();
    const runId = "define-stage2-crash";
    const client = new Client([orientation, draft()]);
    const registration = {
      ...DEFINE_PLAYBOOK_REGISTRATION,
      construct: (options: Parameters<typeof DEFINE_PLAYBOOK_REGISTRATION.construct>[0]) =>
        new DefinePlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (point === "sealing_specification:trace-persistence") throw new Error("trace crash");
          }
        ),
    };
    using first = new OrchestrationService({
      projectRoot,
      env: vars,
      modelClient: client,
      playbookRegistration: registration,
    });
    await expect(first.execute(start(runId))).rejects.toThrow(/trace crash/u);
    const before = first.checkpointer.loadRunById(runId);
    expect(before?.stateId).toBe("sealing_specification");
    const admissionRef = before?.selectedArtifacts.find((ref) => ref.kind === "evidence-admission");
    if (admissionRef === undefined) throw new Error("admission missing");
    expect(
      validateEvidenceAdmissionV2(
        JSON.parse(first.artifacts.readById(admissionRef.artifact_id).toString("utf8"))
      ).support_slots
    ).toEqual([]);
    const draftRef = before?.selectedArtifacts.find((ref) => ref.kind === "specification-draft");
    if (draftRef === undefined) throw new Error("draft missing");
    const productOperation = sealOperationId({
      operation: "seal_product",
      run_id: runId,
      branch_id: null,
      phase: "sealing_specification",
      epoch_anchor_ref: null,
      draft_ref: draftRef,
      policy_sha256: sealPolicySha256(DEFINE_SEAL_POLICY),
    });
    const orphanProduct = first.artifacts.refFor(
      runId,
      "sealing_specification",
      null,
      "specification",
      productOperation,
      1
    );
    const orphanTrace = first.artifacts.refFor(
      runId,
      "sealing_specification",
      "trace",
      "definition-trace",
      `define-definition-trace:${sha256(runId).slice(0, 32)}`,
      1
    );
    expect(orphanProduct).not.toBeNull();
    expect(orphanTrace).not.toBeNull();
    const review = new Client([]);
    using second = new OrchestrationService({
      projectRoot,
      env: vars,
      modelClient: review,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    await expect(
      second.execute({ schema_version: 2, action: "recover", identity: start(runId).identity })
    ).rejects.toThrow(/unexpected Define worker/u);
    expect(review.invocations[0]?.stateId).toBe("verifying_specification");
    const selected = second.checkpointer.loadRunById(runId)?.selectedArtifacts ?? [];
    const traceRef = selected.find((ref) => ref.kind === "definition-trace");
    const product = selected.find((ref) => ref.kind === "specification");
    if (traceRef === undefined || product === undefined)
      throw new Error("review lacks trace or product");
    expect(review.invocations[0]?.inputArtifacts).toContainEqual(traceRef);
    expect(
      validateDefinitionTraceV1(
        JSON.parse(second.artifacts.readById(traceRef.artifact_id).toString("utf8"))
      ).product_ref
    ).toEqual(product);
    expect(second.artifacts.metadata(traceRef).upstream_refs).toContainEqual(product);
    expect(product).toEqual(orphanProduct);
    expect(traceRef).toEqual(orphanTrace);
    expect(client.invocations).toHaveLength(2);
  });
  it("adopts an orphan product when interrupted before trace, without a reviewer seeing an untraced product", async () => {
    const vars = env();
    const runId = "define-stage2-product-crash";
    const client = new Client([orientation, draft()]);
    const registration = {
      ...DEFINE_PLAYBOOK_REGISTRATION,
      construct: (options: Parameters<typeof DEFINE_PLAYBOOK_REGISTRATION.construct>[0]) =>
        new DefinePlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (point === "sealing_specification:artifact-persistence")
              throw new Error("product crash");
          }
        ),
    };
    using first = new OrchestrationService({
      projectRoot,
      env: vars,
      modelClient: client,
      playbookRegistration: registration,
    });
    await expect(first.execute(start(runId))).rejects.toThrow(/product crash/u);
    expect(
      first.checkpointer
        .loadRunById(runId)
        ?.selectedArtifacts.some((ref) => ref.kind === "specification")
    ).toBe(false);
    const draftRef = first.checkpointer
      .loadRunById(runId)
      ?.selectedArtifacts.find((ref) => ref.kind === "specification-draft");
    if (draftRef === undefined) throw new Error("draft missing");
    const operation = sealOperationId({
      operation: "seal_product",
      run_id: runId,
      branch_id: null,
      phase: "sealing_specification",
      epoch_anchor_ref: null,
      draft_ref: draftRef,
      policy_sha256: sealPolicySha256(DEFINE_SEAL_POLICY),
    });
    const orphan = first.artifacts.refFor(
      runId,
      "sealing_specification",
      null,
      "specification",
      operation,
      1
    );
    expect(orphan).not.toBeNull();
    expect(
      first.artifacts.refFor(
        runId,
        "sealing_specification",
        "trace",
        `definition-trace`,
        `define-definition-trace:${sha256(runId).slice(0, 32)}`,
        1
      )
    ).toBeNull();
    const review = new Client([]);
    using second = new OrchestrationService({
      projectRoot,
      env: vars,
      modelClient: review,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    await expect(
      second.execute({ schema_version: 2, action: "recover", identity: start(runId).identity })
    ).rejects.toThrow(/unexpected Define worker/u);
    const selected = second.checkpointer.loadRunById(runId)?.selectedArtifacts ?? [];
    expect(selected.find((ref) => ref.kind === "specification")).toEqual(orphan);
    expect(
      review.invocations[0]?.inputArtifacts.some((ref) => ref.kind === "definition-trace")
    ).toBe(true);
    expect(client.invocations).toHaveLength(2);
  });

  it("rejects an old draft on a new V2 start without persisting a product or trace", async () => {
    const vars = env();
    const runId = "define-stage2-old-draft";
    const client = new Client([
      orientation,
      Buffer.from(genericSpecificationFixture().draftBytes).toString("utf8"),
    ]);
    using service = new OrchestrationService({
      projectRoot,
      env: vars,
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    await expect(service.execute(start(runId))).rejects.toThrow(/unexpected Define worker/u);
    const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts ?? [];
    expect(selected.some((ref) => ref.kind === "seal-diagnostic")).toBe(true);
    expect(
      selected.some((ref) => ref.kind === "specification" || ref.kind === "definition-trace")
    ).toBe(false);
    expect(
      selected.find((ref) => ref.kind === "specification-draft")?.content_schema?.schema_id
    ).toBe("penny.specification-draft.v3");
    expect(client.invocations[1]?.task).toContain("SpecificationDraftV3");
  });

  it("rejects an erased protected caller constraint before product persistence", async () => {
    const { draft: template } = genericSpecificationFixture();
    const { specification_report, ...core } = template;
    const changed = {
      ...core,
      constraints: [{ statement: "Execution is optional.", source_item_indexes: [4] }],
      source_coverage: core.source_coverage.map(
        ({ source_item_index, disposition, rationale }) => ({
          source_item_index,
          disposition,
          rationale,
        })
      ),
    };
    const invalid = `${specification_report}\nSPECIFICATION_CORE:${canonicalJson({
      schema_version: 2,
      specification: changed,
      support_claims: [],
    })}\nSUMMARY:${canonicalJson({ confidence: core.confidence, complete: true })}`;
    const vars = env();
    const runId = "define-stage2-protected";
    using service = new OrchestrationService({
      projectRoot,
      env: vars,
      modelClient: new Client([orientation, invalid]),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    await expect(service.execute(start(runId))).rejects.toThrow(/unexpected Define worker/u);
    const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts ?? [];
    expect(
      selected.some((ref) => ref.kind === "specification" || ref.kind === "definition-trace")
    ).toBe(false);
    expect(selected.some((ref) => ref.kind === "seal-diagnostic")).toBe(true);
  });

  it("admits native evidence for a particular question, validates its exact locator and rejects a forged range", async () => {
    const question = "Which exact standard applies?";
    const questionId = definitionQuestionId({
      requestId: genericSpecificationFixture().request.request_id,
      owner: "evidence",
      sourceItemIndex: null,
      question,
      material: true,
    });
    const evidenceOrientation = orientation
      .replace('"route":"author"', '"route":"evidence"')
      .replace('"evidence_questions":[]', `"evidence_questions":["${question}"]`)
      .replace('"route_reason":"No missing facts."', '"route_reason":"Check the external fact."');
    const echo = `Source text for the question.\nSUMMARY:${canonicalJson({
      confidence: "CERTAIN",
      evidence_complete: true,
      findings: ["Source text supports the response."],
      unresolved: [],
    })}`;
    const claim = (end_exclusive: number): SpecificationDraftV3["support_claims"][number] => ({
      target: { kind: "discovered_question", question_id: questionId },
      status: "resolved",
      claim: "The exact source answers the question.",
      rationale: "See the selected Echo bytes.",
      support: [{ support_slot: 0, locator: { kind: "utf8_byte_range", start: 0, end_exclusive } }],
    });
    for (const [suffix, end] of [
      ["good", 6],
      ["invalid", 999999],
    ] as const) {
      const vars = env();
      const runId = `define-stage2-evidence-${suffix}`;
      const client = new Client([evidenceOrientation, echo, draft([claim(end)])]);
      using service = new OrchestrationService({
        projectRoot,
        env: vars,
        modelClient: client,
        playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
      });
      await expect(service.execute(start(runId))).rejects.toThrow(/unexpected Define worker/u);
      const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts ?? [];
      const admissionRef = [...selected].reverse().find((ref) => ref.kind === "evidence-admission");
      if (admissionRef === undefined) throw new Error("evidence admission missing");
      const admission = validateEvidenceAdmissionV2(
        JSON.parse(service.artifacts.readById(admissionRef.artifact_id).toString("utf8"))
      );
      expect(admission.support_slots).toHaveLength(1);
      expect(admission.support_slots[0]?.role).toBe("native_evidence");
      expect(admission.support_slots[0]?.allowed_uses).toContainEqual({
        kind: "discovered_question",
        question_id: questionId,
      });
      if (suffix === "good") {
        const traceRef = selected.find((ref) => ref.kind === "definition-trace");
        if (traceRef === undefined) throw new Error("evidence trace missing");
        const trace = validateDefinitionTraceV1(
          JSON.parse(service.artifacts.readById(traceRef.artifact_id).toString("utf8"))
        );
        expect(trace.question_resolutions[0]?.support[0]?.ref).toEqual(
          admission.support_slots[0]?.ref
        );
        expect(trace.readiness.blocking_question_ids).toEqual([]);
      } else {
        expect(
          selected.some((ref) => ref.kind === "specification" || ref.kind === "definition-trace")
        ).toBe(false);
        expect(selected.some((ref) => ref.kind === "seal-diagnostic")).toBe(true);
      }
    }
  });

  it("carries an answered caller challenge as an exact response slot across reframing", async () => {
    const question = "Which audience is authoritative for acceptance?";
    const questionId = definitionQuestionId({
      requestId: genericSpecificationFixture().request.request_id,
      owner: "caller",
      sourceItemIndex: null,
      question,
      material: true,
    });
    const clarify = orientation
      .replace('"route":"author"', '"route":"clarify"')
      .replace('"clarification_questions":[]', `"clarification_questions":["${question}"]`);
    const claim: SpecificationDraftV3["support_claims"][number] = {
      target: { kind: "discovered_question", question_id: questionId },
      status: "resolved",
      claim: "The caller supplied the audience.",
      rationale: "Bound to the answered challenge.",
      support: [
        { support_slot: 0, locator: { kind: "json_pointer", pointer: "/answers/0/answer_text" } },
      ],
    };
    const vars = env();
    const runId = "define-stage2-caller";
    const client = new Client([clarify, orientation, draft([claim])]);
    using service = new OrchestrationService({
      projectRoot,
      env: vars,
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    const pending = await service.execute(start(runId));
    if (pending.action !== "await_user") throw new Error("caller gate absent");
    await expect(
      service.execute({
        schema_version: 2,
        action: "respond",
        identity: start(runId).identity,
        gate_id: pending.gate_id,
        challenge: pending.challenge,
        response: "Transition planners are authoritative.",
      })
    ).rejects.toThrow(/unexpected Define worker/u);
    const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts ?? [];
    const admissionRef = [...selected].reverse().find((ref) => ref.kind === "evidence-admission");
    const traceRef = selected.find((ref) => ref.kind === "definition-trace");
    if (admissionRef === undefined || traceRef === undefined)
      throw new Error("caller admission or trace missing");
    const admission = validateEvidenceAdmissionV2(
      JSON.parse(service.artifacts.readById(admissionRef.artifact_id).toString("utf8"))
    );
    expect(admission.support_slots).toHaveLength(1);
    expect(admission.support_slots[0]?.role).toBe("caller_response");
    expect(admission.support_slots[0]?.challenge_ref?.kind).toBe(
      "definition-clarification-challenge"
    );
    const trace = validateDefinitionTraceV1(
      JSON.parse(service.artifacts.readById(traceRef.artifact_id).toString("utf8"))
    );
    expect(trace.question_resolutions[0]?.support[0]?.ref).toEqual(admission.support_slots[0]?.ref);
    expect(client.invocations[3]?.inputArtifacts).toContainEqual(traceRef);
  });

  it("seals an honest blocked product with a pending material evidence question", async () => {
    const question = "Which exact standard applies?";
    const questionId = definitionQuestionId({
      requestId: genericSpecificationFixture().request.request_id,
      owner: "evidence",
      sourceItemIndex: null,
      question,
      material: true,
    });
    const evidenceOrientation = orientation
      .replace('"route":"author"', '"route":"evidence"')
      .replace('"evidence_questions":[]', `"evidence_questions":["${question}"]`);
    const echo = `Evidence unavailable.\nSUMMARY:${canonicalJson({
      confidence: "POSSIBLE",
      evidence_complete: false,
      findings: [],
      unresolved: ["Evidence unavailable."],
    })}`;
    const { draft: template } = genericSpecificationFixture();
    const { specification_report, ...core } = template;
    const blocked = {
      specification_report,
      ...core,
      disposition: "blocked" as const,
      planning_readiness_reason: "The material question remains unresolved.",
      open_questions: [
        { question, owner: "evidence" as const, blocking: true, source_item_indexes: [0] },
      ],
    };
    const claim = {
      target: { kind: "discovered_question" as const, question_id: questionId },
      status: "pending" as const,
      claim: "No source resolves this question yet.",
      rationale: "The admitted source did not establish the answer.",
      support: [],
    };
    const fixture = genericSpecificationFixture();
    const bytes = Buffer.from(
      persistedSpecificationDraftV3(blocked, fixture.request, [claim])
    ).toString("utf8");
    const vars = env();
    const runId = "define-stage2-blocked";
    const review = new Client([evidenceOrientation, echo, bytes]);
    using service = new OrchestrationService({
      projectRoot,
      env: vars,
      modelClient: review,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    await expect(service.execute(start(runId))).rejects.toThrow(/unexpected Define worker/u);
    const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts ?? [];
    const traceRef = selected.find((ref) => ref.kind === "definition-trace");
    if (traceRef === undefined) throw new Error("blocked trace missing");
    const trace = validateDefinitionTraceV1(
      JSON.parse(service.artifacts.readById(traceRef.artifact_id).toString("utf8"))
    );
    expect(trace.readiness).toMatchObject({
      disposition: "blocked",
      blocking_question_ids: [questionId],
    });
    expect(trace.question_resolutions[0]?.status).toBe("pending");
    expect(review.invocations[3]?.inputArtifacts).toContainEqual(traceRef);
  });

  it("enforces 69/70 support slots and 64/65, 160/161 and 4 MiB/+1 trace limits", () => {
    const ref = {
      schema_version: 2 as const,
      artifact_id: `art_${"a".repeat(64)}`,
      run_id: "run-bounds",
      phase: "framing_definition",
      branch_id: null,
      kind: "agent-output",
      operation_id: "bounds",
      version: 1,
      producer: "agent:piper",
      media_type: "application/json",
      byte_length: 1,
      content_digest: "a".repeat(64),
      store_ref: `artifact://sha256/${"a".repeat(64)}`,
    };
    const body: Omit<EvidenceAdmissionV2, "admission_id"> = {
      schema_id: "penny.evidence-admission.v2",
      schema_version: 2,
      run_id: "run-bounds",
      domain: "specification",
      origin_state: "framing_definition",
      source_artifact_ref: ref,
      frame_ref: {
        ...ref,
        kind: "definition-frame",
        content_schema: { schema_id: "penny.definition-frame.v2", schema_version: 2 },
      },
      routing_result_sha256: "a".repeat(64),
      source_execution_receipt_ids: ["receipt"],
      classification: "basis_sufficient",
      evidence_required: false,
      minted_by: "host:evidence-gate",
      support_slots: Array.from({ length: 69 }, (_, i) => ({
        ref: {
          ...ref,
          run_id: `foreign-${i}`,
          artifact_id: `art_${i.toString(16).padStart(64, "0")}`,
        },
        role: "imported_evidence" as const,
        challenge_ref: null,
        allowed_uses: [{ kind: "standard_category" as const, category: "safety" }],
      })),
    };
    expect(
      validateEvidenceAdmissionV2({ ...body, admission_id: evidenceAdmissionV2Id(body) })
        .support_slots
    ).toHaveLength(69);
    const firstSlot = body.support_slots[0];
    if (firstSlot === undefined) throw new Error("support slot missing");
    const overflow: Omit<EvidenceAdmissionV2, "admission_id"> = {
      ...body,
      support_slots: [
        ...body.support_slots,
        {
          ...firstSlot,
          ref: { ...ref, run_id: "foreign-69", artifact_id: `art_${"f".repeat(64)}` },
        },
      ],
    };
    expect(() =>
      validateEvidenceAdmissionV2({ ...overflow, admission_id: evidenceAdmissionV2Id(overflow) })
    ).toThrow();
    const hash = (trace: Omit<DefinitionTraceV1, "projection_sha256">) => ({
      ...trace,
      projection_sha256: sha256(canonicalJson(trace)),
    });
    const traceBody = {
      schema_id: "penny.definition-trace.v1" as const,
      schema_version: 1 as const,
      registration_binding: {
        name: "define" as const,
        contract_sha256: "b".repeat(64),
        registration_sha256: "c".repeat(64),
      },
      request_ref: ref,
      manifest_ref: ref,
      frame_ref: body.frame_ref,
      admission_ref: {
        ...ref,
        content_schema: { schema_id: "penny.evidence-admission.v2", schema_version: 2 },
      },
      draft_ref: {
        ...ref,
        content_schema: { schema_id: "penny.specification-draft.v2", schema_version: 2 },
      },
      product_ref: { ...ref, kind: "specification" },
      prior_product_ref: null,
      support_refs: [],
      coverage: [
        {
          source_item_id: "source",
          ordinal: 0,
          disposition: "incorporated" as const,
          product_item_ids: [],
        },
      ],
      question_resolutions: Array.from({ length: 64 }, (_, i) => ({
        question_id: `q-${i}`,
        target: { kind: "discovered_question" as const, question_id: `q-${i}` },
        status: "pending" as const,
        claim: "pending",
        rationale: "unknown",
        support: [],
      })),
      standard_support: Array.from({ length: 64 }, (_, i) => ({
        standard_item_id: `s-${i}`,
        standard: "Standard",
        category: "safety",
        status: "identified" as const,
        claim: null,
        support: [],
      })),
      protected_mappings: Array.from({ length: 160 }, (_, i) => ({
        source_item_id: `source-${i}`,
        field_path: `hard_constraint[${i}]`,
        item_id: `item-${i}`,
        original_value_sha256: "d".repeat(64),
      })),
      readiness: {
        disposition: "blocked" as const,
        blocking_question_ids: [],
        unresolved_source_ids: [],
      },
    };
    expect(validateDefinitionTraceV1(hash(traceBody)).protected_mappings).toHaveLength(160);
    const firstQuestion = traceBody.question_resolutions[0];
    const firstStandard = traceBody.standard_support[0];
    const firstMapping = traceBody.protected_mappings[0];
    if (firstQuestion === undefined || firstStandard === undefined || firstMapping === undefined)
      throw new Error("trace rows missing");
    expect(() =>
      validateDefinitionTraceV1(
        hash({
          ...traceBody,
          question_resolutions: [...traceBody.question_resolutions, firstQuestion],
        })
      )
    ).toThrow();
    expect(() =>
      validateDefinitionTraceV1(
        hash({
          ...traceBody,
          standard_support: [...traceBody.standard_support, firstStandard],
        })
      )
    ).toThrow();
    expect(() =>
      validateDefinitionTraceV1(
        hash({
          ...traceBody,
          protected_mappings: [...traceBody.protected_mappings, firstMapping],
        })
      )
    ).toThrow();
    const large = {
      ...traceBody,
      coverage: Array.from({ length: 128 }, (_, ordinal) => ({
        source_item_id: `source-${ordinal}`,
        ordinal,
        disposition: "incorporated" as const,
        product_item_ids: Array.from(
          { length: 760 },
          (_, n) => `id-${ordinal}-${n}-${"x".repeat(106)}`
        ),
      })),
    };
    expect(Buffer.byteLength(canonicalJson(hash(large)))).toBeGreaterThan(
      MAX_DEFINITION_TRACE_BYTES
    );
    expect(() => validateDefinitionTraceV1(hash(large))).toThrow(/4 MiB/u);
  });
});
