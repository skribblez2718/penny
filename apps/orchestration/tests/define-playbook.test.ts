import { explicitSealPolicy } from "./helpers/explicit-cycle-policy.js";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactRefSchema,
  DEFINE_PLAYBOOK_NAME,
  DEFINE_PLAYBOOK_REGISTRATION,
  DEFINE_START_ADMISSION,
  DefinePlaybook,
  OrchestrationService,
  canonicalJson,
  canonicalizeDefinitionRequest,
  defineRequestConstraints,
  evaluateDefineLatestReviewedSpecificationDod,
  initializePennyState,
  specificationLineagePromptContract,
  persistedSpecificationDraftV3 as serializeKeyedDraftV3,
  validateContract,
  validateDefinitionRequest,
  validateDefinitionSourceManifest,
  validateDefinitionFrameV2,
  validateDefinitionTraceV1,
  definitionQuestionId,
  validateDefinitionClarificationChallenge,
  validateDefinitionClarificationResponse,
  sha256,
  validateSpecification,
  validateSpecificationProductEnvelopeV2,
  DEFINE_SEAL_POLICY,
  skillContractSha256,
  runtimeRegistrationSha256,
  validateSpecificationProductIntegrityV2,
  validateReviewReceiptV2,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type ModelClient,
  type PlaybookRegistration,
  type SpecificationDraftV1,
  type SpecificationDraftV3,
} from "../dist/index.js";
import { sealOperationId } from "../dist/playbooks/seal-attempt.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import {
  sealPolicySha256,
  runSealPolicy,
  validateSealDiagnostic,
} from "../dist/skill-contracts/sealing.js";
import { persistEvidenceContext } from "./helpers/evidence-context.js";
import { requireRecord } from "./helpers/narrowing.js";
import {
  genericDefinitionRequest,
  genericDefinitionFrame,
  genericSpecificationCore,
  genericSpecificationFixture,
  fortySixSourceFixture,
  persistedSpecificationDraftV3,
  keyedSpecificationDraft,
  answeredDefinitionClaim,
} from "./fixtures/define-fixtures.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
let sequence = 0;

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-define-playbook-"));
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class ScriptedDefineClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  onInvocation?: () => void;
  private index = 0;

  constructor(private readonly outputs: readonly string[]) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    this.onInvocation?.();
    const text = this.outputs[this.index];
    this.index += 1;
    if (text === undefined) throw new Error("scripted Define output is exhausted");
    return { text };
  }
}

function start(runId: string) {
  const request = genericDefinitionRequest();
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: {
      schema_version: 2 as const,
      run_id: runId,
      session_id: runId,
      playbook: DEFINE_PLAYBOOK_NAME,
      engine_owner: "typescript" as const,
    },
    goal: request.goal,
    constraints: defineRequestConstraints(request),
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}

function orientation(
  route: "author" | "clarify" | "evidence" = "author",
  questions: readonly string[] = ["Which audience is authoritative for acceptance?"]
): string {
  return [
    "The request uses the generic profile and preserves the no-execution boundary.",
    `SUMMARY:${JSON.stringify({
      confidence: "CERTAIN",
      orientation_complete: true,
      gap_kind: "none",
      repair_owner: "none",
      selected_profile_id: "generic",
      profile_selection_basis: "The caller explicitly selected the generic profile.",
      route,
      route_reason:
        route === "author"
          ? "The supplied intent is complete enough to author."
          : route === "clarify"
            ? "The caller must resolve the authoritative audience."
            : "One externally resolvable fact needs bounded inspection.",
      clarification_questions: route === "clarify" ? [...questions] : [],
      evidence_questions: route === "evidence" ? ["Which exact standard applies?"] : [],
      findings: [],
      specification_delta: "No prior specification is being revised.",
    })}`,
  ].join("\n");
}

function veraPass(): string {
  return [
    "The sealed specification satisfies the request and the closed contract.",
    `SUMMARY:${JSON.stringify({
      confidence: "CERTAIN",
      verdict: "PASS",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["Exact request, frame, draft, product, and source coverage agree."],
      specification_delta: "No repair is required.",
    })}`,
  ].join("\n");
}

function carrenApprove(): string {
  return [
    "The specification is coherent, usable, and appropriately bounded.",
    `SUMMARY:${JSON.stringify({
      confidence: "CERTAIN",
      verdict: "APPROVE",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["The Vera-passed product remains clear and planning-ready."],
      specification_delta: "No revision is required.",
    })}`,
  ].join("\n");
}

function defineReviewGap(
  reviewer: "vera" | "carren",
  kind: "evidence_gap" | "analysis_gap" | "product_gap"
): string {
  return [
    `The reviewed product needs a ${kind} repair.`,
    `SUMMARY:${JSON.stringify({
      confidence: "PROBABLE",
      verdict: reviewer === "vera" ? "FAIL" : "NEEDS_REVISION",
      gap_kind: kind,
      repair_owner: kind === "evidence_gap" ? "echo" : kind === "analysis_gap" ? "piper" : "rhea",
      findings:
        reviewer === "vera"
          ? [`Vera found a ${kind}.`]
          : [{ severity: "major", message: `Carren found a ${kind}.` }],
      evidence: ["The reviewed product needs correction."],
      specification_delta: `Repair the ${kind} across the full specification.`,
    })}`,
  ].join("\n");
}

function readJson(service: OrchestrationService, artifactId: string): unknown {
  return JSON.parse(service.artifacts.readById(artifactId).toString("utf8"));
}

function sealDiagnostic(service: OrchestrationService, ref: ArtifactRef) {
  return validateSealDiagnostic(
    readJson(service, ref.artifact_id),
    runSealPolicy(service.checkpointer.loadRunById(ref.run_id) ?? {}, DEFINE_SEAL_POLICY)
  );
}

function selectedRefs(
  context: { readonly selectedArtifacts: readonly ArtifactRef[] },
  kind: string
) {
  return context.selectedArtifacts.filter((ref) => ref.kind === kind);
}

function sealAddress(
  runId: string,
  draft: ArtifactRef,
  anchor: ArtifactRef | null,
  operation: "seal_product" | "seal_diagnostic"
) {
  return sealOperationId({
    operation,
    run_id: runId,
    branch_id: null,
    phase: "sealing_specification",
    epoch_anchor_ref: anchor,
    draft_ref: draft,
    policy_sha256: sealPolicySha256(DEFINE_SEAL_POLICY),
  });
}

function defineRegistrationWithHostFault(hostFault: (point: string) => void): PlaybookRegistration {
  return {
    ...DEFINE_PLAYBOOK_REGISTRATION,
    construct: (options) =>
      new DefinePlaybook(
        options.artifactRevisions,
        options.artifactStore,
        options.checkpointer,
        hostFault
      ),
  };
}

function productForDraft(runId: string, draft: ArtifactRef, anchor: ArtifactRef | null) {
  return sealAddress(runId, draft, anchor, "seal_product");
}

describe("provider-free orchestrated Define workflow", () => {
  it("closes verification incapability independently from repairable product defects", () => {
    const worker = DEFINE_PLAYBOOK_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("Define catalog worker missing");
    const phase = worker.phases.get("verifying_specification");
    if (phase === undefined) throw new Error("Define verifier schema missing");
    const incomplete = {
      verdict: "UNVERIFIABLE",
      gap_kind: "verification_incomplete",
      repair_owner: "none",
      findings: ["Verification capability unavailable."],
      evidence: ["Only host mechanics are available."],
      specification_delta: "Preserve exact work.",
    };
    expect(validateSkillSchema(phase.schema, incomplete, "Define Vera")).toEqual(incomplete);
    for (const invalid of [
      { ...incomplete, repair_owner: "rhea" },
      { ...incomplete, gap_kind: "product_gap" },
      { ...incomplete, verdict: "FAIL" },
      { ...incomplete, findings: [] },
      { ...incomplete, evidence: [] },
      { ...incomplete, needs_clarification: true },
    ])
      expect(() => validateSkillSchema(phase.schema, invalid, "Define Vera")).toThrow();
    expect(phase.routing_repair_policy).toBe("preserve_source_summary_v1");
    expect(worker.phases.get("critiquing_specification")?.routing_repair_policy).toBe(
      "preserve_source_summary_v1"
    );
    expect(DEFINE_PLAYBOOK_REGISTRATION.repair_progress_policy).toBe("exact_fingerprint_v1");
  });
  it("keeps verification incapability incomplete with the exact product/report across reopen", async () => {
    const fixture = genericSpecificationFixture();
    const report =
      'Verification evidence is unavailable; no product defect is established.\nSUMMARY:{"confidence":"UNCERTAIN","verdict":"UNVERIFIABLE","gap_kind":"verification_incomplete","repair_owner":"none","findings":["Independent verification capability is unavailable."],"evidence":["Host mechanics do not establish semantic validity."],"specification_delta":"Preserve this exact product; do not reauthor it."}';
    const client = new ScriptedDefineClient([
      orientation(),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      report,
    ]);
    const env = environment();
    sequence += 1;
    const runId = `run-define-unverifiable-${sequence}`;
    const terminal = await (async () => {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
      });
      const result = await service.execute(start(runId));
      expect(result).toMatchObject({
        action: "incomplete",
        met: false,
        result: { incomplete_reason: "verification_incomplete" },
      });
      if (result.action !== "incomplete") throw new Error("expected incomplete");
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("missing incomplete checkpoint");
      const product = selectedRefs(context, "specification")[0];
      const feedback = context.selectedArtifacts.find(
        (ref) => ref.phase === "verifying_specification"
      );
      if (product === undefined || feedback === undefined)
        throw new Error("missing retained evidence");
      expect(result.result.output_artifact_ref).toEqual(product);
      expect(result.artifacts).toContainEqual(feedback);
      expect(service.artifacts.readById(feedback.artifact_id).toString("utf8")).toBe(report);
      expect(selectedRefs(context, "review-receipt")).toEqual([]);
      expect(context.iteration).toBe(0);
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      return result;
    })();
    using reopened = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedDefineClient([]),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    expect(
      await reopened.execute({ schema_version: 2, action: "recover", identity: terminal.identity })
    ).toEqual(terminal);
    expect(
      await reopened.execute({ schema_version: 2, action: "status", identity: terminal.identity })
    ).toEqual(terminal);
    expect(client.invocations.map((i) => i.stateId)).toEqual([
      "framing_definition",
      "authoring_specification",
      "verifying_specification",
    ]);
  });

  it("supplies current mechanical evidence, preserves contextual recovery, and refuses invalid trace without author repair", async () => {
    const fixture = genericSpecificationFixture();
    const draft = Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8");
    const client = new ScriptedDefineClient([
      orientation(),
      draft,
      veraPass(),
      carrenApprove(),
      orientation(),
      draft,
    ]);
    const env = environment();
    sequence += 1;
    const request = start(`run-define-mechanical-${sequence}`);
    const pending = await (async () => {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
      });
      const prior = await service.execute(start(`${request.identity.run_id}-context`));
      if (prior.action !== "complete") throw new Error("context producer did not complete");
      const source = selectedRefs(service.checkpointer.loadRun(prior.identity), "specification").at(
        -1
      );
      if (source === undefined) throw new Error("accepted context product missing");
      let next = service.engine.handle({
        ...request,
        input_artifacts: {
          schema_version: 2,
          artifacts: [{ slot: "nonbinding-source", designation: "context", ref: source }],
        },
      });
      for (let i = 0; i < 2; i += 1) {
        const result = (await service.workers.execute(next))[0];
        if (result === undefined) throw new Error("worker result missing");
        next = service.engine.handle({
          schema_version: 2,
          action: "step",
          identity: request.identity,
          result,
        });
      }
      if (next.action !== "invoke_agent" || next.state_id !== "verifying_specification")
        throw new Error("missing Vera");
      expect(next.task).toContain("NONBINDING exact contextual artifacts");
      expect(next.input_artifacts.artifacts).toContainEqual({
        slot: "nonbinding-source",
        designation: "context",
        ref: source,
      });
      const line = next.task
        .split("\n")
        .find((value) => value.startsWith("HOST_MECHANICAL_CHECKS:"));
      if (line === undefined) throw new Error("mechanical evidence absent");
      const value: unknown = JSON.parse(line.slice("HOST_MECHANICAL_CHECKS:".length));
      expect(value).toMatchObject({
        schema_version: 1,
        product_ref: next.input_artifacts.artifacts.find(
          (item) => item.slot === "latest-specification"
        )?.ref,
        scope: "host_mechanical_only_not_semantic_or_effect_absence",
      });
      const evidence = requireRecord(value, "host mechanical evidence");
      expect(evidence.source_refs).toContainEqual(
        next.input_artifacts.artifacts.find((item) => item.slot === "definition-trace")?.ref
      );
      expect(evidence.checks).toContainEqual({
        check: "definition_trace_projection_and_support",
        status: "passed",
      });
      expect(line.slice("HOST_MECHANICAL_CHECKS:".length)).toBe(canonicalJson(value));
      expect(
        next.input_artifacts.artifacts.some(
          (item) => item.ref.kind === "specification-product-integrity"
        )
      ).toBe(false);
      return next;
    })();
    using reopened = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedDefineClient([]),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    expect(
      reopened.engine.handle({ schema_version: 2, action: "recover", identity: request.identity })
    ).toEqual(pending);
    const context = reopened.checkpointer.loadRun(request.identity);
    const traceRef = context.selectedArtifacts.find((ref) => ref.kind === "definition-trace");
    if (traceRef === undefined) throw new Error("current trace missing");
    const trace = validateDefinitionTraceV1(readJson(reopened, traceRef.artifact_id));
    // Valid schema and real immutable custody are insufficient: native trace reprojection must fail.
    const { projection_sha256: _projection, ...traceBody } = trace;
    const forgedBody = {
      ...traceBody,
      coverage: trace.coverage.map((entry, index) =>
        index === 0 ? { ...entry, product_item_ids: [] } : entry
      ),
    };
    const forged = reopened.artifacts.persist({
      metadata: {
        ...reopened.artifacts.metadata(traceRef),
        operation_id: `fixture-invalid-trace:${sha256(traceRef.artifact_id)}`,
        version: 1,
        parent_ref: null,
      },
      content: canonicalJson({
        ...forgedBody,
        projection_sha256: sha256(canonicalJson(forgedBody)),
      }),
    });
    validateDefinitionTraceV1(readJson(reopened, forged.artifact_id));
    context.selectedArtifacts = context.selectedArtifacts.map((ref) =>
      ref.artifact_id === traceRef.artifact_id ? forged : ref
    );
    reopened.checkpointer.saveRun(context, "fixture_invalid_host_trace", {});
    const denied = reopened.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: request.identity,
    });
    expect(denied).toMatchObject({
      action: "incomplete",
      met: false,
      result: { incomplete_reason: "host_mechanical_check_failed" },
    });
    expect(
      reopened.engine.handle({ schema_version: 2, action: "recover", identity: request.identity })
    ).toEqual(denied);
    expect(reopened.checkpointer.completionAdmission(request.identity.run_id)).toBeUndefined();
  });

  it.each(["vera", "carren"] as const)(
    "refuses %s source SUMMARY judgment mutation during routing repair",
    async (reviewer) => {
      const fixture = genericSpecificationFixture();
      const original =
        reviewer === "vera"
          ? defineReviewGap("vera", "product_gap")
          : defineReviewGap("carren", "product_gap");
      const client = new ScriptedDefineClient([
        orientation(),
        Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
        ...(reviewer === "carren" ? [veraPass()] : []),
        original,
        reviewer === "vera" ? veraPass() : carrenApprove(),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
      });
      sequence += 1;
      const request = start(`run-define-routing-mutation-${sequence}`);
      let next = service.engine.handle(request);
      const target = reviewer === "vera" ? "verifying_specification" : "critiquing_specification";
      while (next.action === "invoke_agent" && next.state_id !== target) {
        const result = (await service.workers.execute(next))[0];
        if (result === undefined) throw new Error("worker result missing");
        next = service.engine.handle({
          schema_version: 2,
          action: "step",
          identity: request.identity,
          result,
        });
      }
      if (next.action !== "invoke_agent" || next.state_id !== target)
        throw new Error("review not reached");
      const result = (await service.workers.execute(next))[0];
      if (result === undefined) throw new Error("review result missing");
      // The exact source contains a valid complete judgment; only transported metadata is malformed.
      next = service.engine.handle({
        schema_version: 2,
        action: "step",
        identity: request.identity,
        result: { ...result, details: {} },
      });
      expect(next).toMatchObject({ action: "invoke_agent", execution_purpose: "routing_repair" });
      const repaired = (await service.workers.execute(next))[0];
      if (repaired === undefined) throw new Error("repair result missing");
      const refused = service.engine.handle({
        schema_version: 2,
        action: "step",
        identity: request.identity,
        result: repaired,
      });
      expect(refused).toMatchObject({
        action: "incomplete",
        met: false,
        result: { reason_code: "source_summary_unpreservable" },
      });
      expect(service.artifacts.readById(result.output_artifact.artifact_id).toString("utf8")).toBe(
        original
      );
      expect(service.checkpointer.completionAdmission(request.identity.run_id)).toBeUndefined();
      expect(service.checkpointer.loadRun(request.identity).iteration).toBe(0);
    }
  );

  it.each(["vera", "carren"] as const)(
    "stalls identical %s candidate/failure across reopen despite new refs, framing and strategy prose",
    async (reviewer) => {
      const fixture = genericSpecificationFixture();
      const draft = Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8");
      const gap = defineReviewGap(reviewer, "product_gap");
      const client = new ScriptedDefineClient([
        orientation(),
        draft,
        ...(reviewer === "carren" ? [veraPass()] : []),
        gap,
        Buffer.from(
          persistedSpecificationDraftV3({
            ...fixture.draft,
            specification_report: "Different report framing, same semantic specification.",
          })
        ).toString("utf8"),
        ...(reviewer === "carren" ? [veraPass()] : []),
        gap.replace(
          "Repair the product_gap across the full specification.",
          "Use a different proposed strategy."
        ),
      ]);
      const env = environment();
      sequence += 1;
      const request = start(`run-define-exact-stall-${sequence}`);
      const pending = await (async () => {
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          modelClient: client,
          playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
        });
        let next = service.engine.handle(request);
        const target = reviewer === "vera" ? "verifying_specification" : "critiquing_specification";
        let reviews = 0;
        while (next.action === "invoke_agent") {
          if (next.state_id === target && ++reviews === 2) return next;
          const result = (await service.workers.execute(next))[0];
          if (result === undefined) throw new Error("missing exact repair result");
          next = service.engine.handle({
            schema_version: 2,
            action: "step",
            identity: request.identity,
            result,
          });
        }
        throw new Error("second review not reached");
      })();
      using reopened = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
      });
      expect(
        reopened.engine.handle({ schema_version: 2, action: "recover", identity: request.identity })
      ).toEqual(pending);
      const terminal = await reopened.execute({
        schema_version: 2,
        action: "recover",
        identity: request.identity,
      });
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: { incomplete_reason: "repair_stalled", stalled: true },
      });
      const context = reopened.checkpointer.loadRun(request.identity);
      expect(context.iteration).toBe(1);
      const products = selectedRefs(context, "specification");
      expect(products).toHaveLength(2);
      expect(products[0]?.artifact_id).not.toBe(products[1]?.artifact_id);
      if (terminal.action !== "incomplete") throw new Error("expected stalled incomplete");
      expect(terminal.result.output_artifact_ref).toEqual(products[1]);
      for (const [index, invocation] of client.invocations
        .filter((i) => i.stateId === "verifying_specification")
        .entries()) {
        expect(invocation.task).toContain(`"product_ref":${canonicalJson(products[index])}`);
      }
      expect(reopened.checkpointer.completionAdmission(request.identity.run_id)).toBeUndefined();
      expect(
        await reopened.execute({ schema_version: 2, action: "recover", identity: request.identity })
      ).toEqual(terminal);
      expect(client.invocations.map((i) => i.stateId)).toEqual([
        "framing_definition",
        "authoring_specification",
        "verifying_specification",
        ...(reviewer === "carren" ? ["critiquing_specification"] : []),
        "authoring_specification",
        "verifying_specification",
        ...(reviewer === "carren" ? ["critiquing_specification"] : []),
      ]);
    }
  );
  it("refuses an unrepresentable exclusion before creating a run or invoking a worker", async () => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedDefineClient([]),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-unrepresentable-${sequence}`;
    const request = start(runId);
    await expect(
      service.execute({
        ...request,
        constraints: { ...request.constraints, out_of_scope: ["x".repeat(2_049)] },
      })
    ).rejects.toThrow("DEFINITION_PROTECTED_CONTENT_UNREPRESENTABLE");
    expect(service.checkpointer.loadRunById(runId)).toBeUndefined();
    expect(
      service.artifacts.refFor(runId, "intake", null, "definition-request", "definition-request", 1)
    ).toBeNull();
  });
  it("adopts the same request and manifest before any run or framing worker exists", () => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedDefineClient([]),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-prestart-manifest-${sequence}`;
    const assurance = {
      artifacts: service.artifacts,
      checkpointer: service.checkpointer,
      project_id: service.config.projectId,
      project_root: PROJECT_ROOT,
      supported_define_registration_sha256: runtimeRegistrationSha256(service.engine.registration),
      consumer: {
        run_id: runId,
        registration_name: "define",
        contract_sha256: skillContractSha256(service.engine.registration.contract),
        registration_sha256: runtimeRegistrationSha256(service.engine.registration),
      },
    };
    const prepared = DEFINE_START_ADMISSION.prepare(start(runId), { assurance });
    const first = DEFINE_START_ADMISSION.materialize(prepared, {
      run_id: runId,
      artifactStore: service.artifacts,
      assurance,
    });
    expect(first.map((ref) => ref.kind)).toEqual([
      "definition-request",
      "definition-source-manifest",
      "composition-assurance",
    ]);
    expect(service.checkpointer.loadRunById(runId)).toBeUndefined();
    const second = DEFINE_START_ADMISSION.materialize(prepared, {
      run_id: runId,
      artifactStore: service.artifacts,
      assurance,
    });
    expect(second).toEqual(first);
    const request = first[0];
    const manifest = first[1];
    if (request === undefined || manifest === undefined)
      throw new Error("materialization is incomplete");
    expect(
      validateDefinitionSourceManifest(
        readJson(service, manifest.artifact_id),
        genericDefinitionRequest(),
        request
      ).sources
    ).toHaveLength(6);
    expect(
      service.artifacts.refFor(
        runId,
        "intake",
        null,
        "definition-source-manifest",
        manifest.operation_id,
        2
      )
    ).toBeNull();
  });

  it("passes the reviewed product and both reports to evidence repair without promoting them to proof", async () => {
    const fixture = genericSpecificationFixture();
    const client = new ScriptedDefineClient([
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      veraPass(),
      defineReviewGap("carren", "evidence_gap"),
      orientation("evidence"),
      'Bounded evidence identifies the applicable standard.\nSUMMARY:{"confidence":"CERTAIN","evidence_complete":true,"findings":["The source resolves the question."],"unresolved":[]}',
      Buffer.from(
        persistedSpecificationDraftV3(fixture.draft, fixture.request, [
          {
            target: {
              kind: "discovered_question",
              question_id: definitionQuestionId({
                requestId: fixture.request.request_id,
                owner: "evidence",
                sourceItemIndex: null,
                question: "Which exact standard applies?",
                material: true,
              }),
            },
            status: "resolved",
            claim: "The source answers the question.",
            rationale: "Exact Echo bytes support the answer.",
            support: [
              { support_slot: 0, locator: { kind: "utf8_byte_range", start: 0, end_exclusive: 7 } },
            ],
          },
        ])
      ).toString("utf8"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-evidence-repair-${sequence}`;
    const terminal = await service.execute(start(runId));
    if (terminal.action !== "complete") throw new Error(`repair ended: ${canonicalJson(terminal)}`);
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "framing_definition",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
      "framing_definition",
      "gathering_definition_evidence",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("repaired run is absent");
    const find = (phase: string, kind: string, version: number) => {
      const ref = context.selectedArtifacts.find(
        (entry) => entry.phase === phase && entry.kind === kind && entry.version === version
      );
      if (ref === undefined) throw new Error(`missing ${phase} ${kind} v${version}`);
      return ref;
    };
    const products = selectedRefs(context, "specification");
    const firstProduct = products[0];
    const finalProduct = products[1];
    if (firstProduct === undefined || finalProduct === undefined)
      throw new Error("expected two sealed products");
    expect(products.map((ref) => ref.version)).toEqual([1, 1]);
    expect(firstProduct.operation_id).not.toBe(finalProduct.operation_id);
    const drafts = selectedRefs(context, "specification-draft");
    const firstDraft = drafts[0];
    const finalDraft = drafts[1];
    if (firstDraft === undefined || finalDraft === undefined)
      throw new Error("review drafts absent");
    expect(firstProduct.operation_id).toBe(productForDraft(runId, firstDraft, null));
    expect(finalProduct.operation_id).toBe(productForDraft(runId, finalDraft, firstProduct));
    const veraReport = find("verifying_specification", "agent-output", 1);
    const carrenReport = find("critiquing_specification", "agent-output", 1);
    for (const index of [4, 5, 6]) {
      const invocation = client.invocations[index];
      if (invocation === undefined) throw new Error(`missing repair invocation ${index}`);
      expect(invocation.inputArtifacts).toEqual(
        expect.arrayContaining([firstProduct, veraReport, carrenReport])
      );
      expect(invocation.inputArtifacts.filter((ref) => ref.kind === "specification")).toEqual([
        firstProduct,
      ]);
    }
    expect(client.invocations[7]?.inputArtifacts).toContainEqual(finalProduct);
    const validity = context.selectedArtifacts.find(
      (ref) => ref.kind === "review-receipt" && ref.branch_id === "validity" && ref.version === 2
    );
    const quality = context.selectedArtifacts.find(
      (ref) => ref.kind === "review-receipt" && ref.branch_id === "quality" && ref.version === 1
    );
    if (validity === undefined || quality === undefined)
      throw new Error("repaired receipt chain is absent");
    expect(validateReviewReceiptV2(readJson(service, quality.artifact_id))).toMatchObject({
      subject: { product_ref: { artifact_id: finalProduct.artifact_id } },
      prior_review_receipt_ref: { artifact_id: validity.artifact_id },
    });
  });

  it("carries the exact reviewed product and both historical reports through alternating Carren and Vera gaps", async () => {
    const fixture = genericSpecificationFixture();
    const client = new ScriptedDefineClient([
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      veraPass(),
      defineReviewGap("carren", "analysis_gap"),
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      defineReviewGap("vera", "product_gap"),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-alternating-repair-${sequence}`;
    // Input slots are stable exact-ID addresses; the first create has no local product.
    const productSlots: string[][] = [];
    client.onInvocation = () => {
      const pending = service.checkpointer.loadRunById(runId)?.pendingDirective;
      if (pending?.action !== "invoke_agent") throw new Error("pending invocation is absent");
      productSlots.push(
        pending.input_artifacts.artifacts
          .filter((entry) => entry.ref.kind === "specification")
          .map((entry) => `${entry.slot}:${entry.ref.artifact_id}`)
      );
    };

    const terminal = await service.execute(start(runId));
    if (terminal.action !== "complete") throw new Error(`repair ended: ${canonicalJson(terminal)}`);
    const finalRef = validateContract(
      ArtifactRefSchema,
      terminal.result.output_artifact_ref,
      "repaired specification"
    );
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "framing_definition",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
      "framing_definition",
      "authoring_specification",
      "verifying_specification",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("repaired run is absent");
    const at = (phase: string, artifactKind: string, version: number) => {
      const ref = context.selectedArtifacts.find(
        (artifact) =>
          artifact.phase === phase && artifact.kind === artifactKind && artifact.version === version
      );
      if (ref === undefined) throw new Error(`missing ${phase} ${artifactKind} v${version}`);
      return ref;
    };
    const products = selectedRefs(context, "specification");
    expect(products).toHaveLength(3);
    expect(products.map((ref) => ref.version)).toEqual([1, 1, 1]);
    expect(new Set(products.map((ref) => ref.operation_id)).size).toBe(3);
    const traces = selectedRefs(context, "definition-trace");
    expect(traces).toHaveLength(3);
    for (const [index, traceRef] of traces.entries()) {
      const trace = validateDefinitionTraceV1(readJson(service, traceRef.artifact_id));
      expect(trace.product_ref).toEqual(products[index]);
    }
    expect(client.invocations[8]?.inputArtifacts).toContainEqual(traces[2]);
    expect(client.invocations[9]?.inputArtifacts).toContainEqual(traces[2]);
    expect(client.invocations[8]?.inputArtifacts).not.toContainEqual(traces[1]);
    const drafts = selectedRefs(context, "specification-draft");
    for (const [index, product] of products.entries()) {
      const draft = drafts[index];
      if (draft === undefined) throw new Error("review draft absent");
      expect(product.operation_id).toBe(productForDraft(runId, draft, products[index - 1] ?? null));
    }
    const veraReports = [1, 2, 3].map((version) =>
      at("verifying_specification", "agent-output", version)
    );
    const carrenReports = [1, 2].map((version) =>
      at("critiquing_specification", "agent-output", version)
    );
    expect(finalRef).toMatchObject({ artifact_id: products[2]?.artifact_id, version: 1 });
    const inputIds = (index: number) =>
      client.invocations[index]?.inputArtifacts.map((ref) => ref.artifact_id);
    const expectInput = (
      index: number,
      productVersion: number,
      veraVersion: number,
      carrenVersion: number
    ) => {
      const invocation = client.invocations[index];
      if (invocation === undefined) throw new Error(`invocation ${index} is absent`);
      const productRef = products[productVersion - 1];
      const veraRef = veraReports[veraVersion - 1];
      const carrenRef = carrenReports[carrenVersion - 1];
      if (productRef === undefined || veraRef === undefined || carrenRef === undefined) {
        throw new Error("exact repair inputs are absent");
      }
      const ids = invocation.inputArtifacts.map((ref) => ref.artifact_id);
      expect(ids).toEqual(
        expect.arrayContaining([productRef.artifact_id, veraRef.artifact_id, carrenRef.artifact_id])
      );
      expect(invocation.inputArtifacts.filter((ref) => ref.kind === "specification")).toEqual([
        productRef,
      ]);
      expect(
        invocation.inputArtifacts.filter(
          (ref) => ref.phase === "verifying_specification" && ref.kind === "agent-output"
        )
      ).toEqual([veraRef]);
      expect(
        invocation.inputArtifacts.filter(
          (ref) => ref.phase === "critiquing_specification" && ref.kind === "agent-output"
        )
      ).toEqual([carrenRef]);
    };
    expect(
      client.invocations[1]?.inputArtifacts.filter((ref) => ref.kind === "specification")
    ).toEqual([]);
    expect(inputIds(1)).not.toContain(products[0]?.artifact_id);
    expect(productSlots[1]).toEqual([]);
    expect(productSlots[5]).toEqual([`latest-specification:${products[0]?.artifact_id}`]);
    expect(productSlots[7]).toEqual([`latest-specification:${products[1]?.artifact_id}`]);
    // Framing/analysis and each author see the sealed subject, not just its draft.
    expectInput(4, 1, 1, 1);
    expectInput(5, 1, 1, 1);
    expectInput(6, 2, 1, 1);
    expectInput(7, 2, 2, 1);
    expectInput(8, 3, 2, 1);
    expectInput(9, 3, 3, 1);
    expect(client.invocations[7]?.task).toContain("historical feedback, never approval");
    // Final PASS/APPROVE and host receipts bind the third checkpoint-selected product.
    const finalVeraReport = veraReports[2];
    const finalCarrenReport = carrenReports[1];
    if (finalVeraReport === undefined || finalCarrenReport === undefined)
      throw new Error("final reports are absent");
    expect(service.artifacts.metadata(finalVeraReport).upstream_refs).toContainEqual(products[2]);
    expect(service.artifacts.metadata(finalCarrenReport).upstream_refs).toContainEqual(products[2]);
    const validity = context.selectedArtifacts.find(
      (ref) => ref.kind === "review-receipt" && ref.branch_id === "validity" && ref.version === 2
    );
    const quality = context.selectedArtifacts.find(
      (ref) => ref.kind === "review-receipt" && ref.branch_id === "quality" && ref.version === 1
    );
    if (validity === undefined || quality === undefined)
      throw new Error("current review receipts are absent");
    expect(validateReviewReceiptV2(readJson(service, validity.artifact_id))).toMatchObject({
      verdict: "PASS",
      subject: { product_ref: { artifact_id: products[2]?.artifact_id }, trace_ref: traces[2] },
    });
    expect(validateReviewReceiptV2(readJson(service, quality.artifact_id))).toMatchObject({
      verdict: "APPROVE",
      subject: { product_ref: { artifact_id: products[2]?.artifact_id } },
      prior_review_receipt_ref: { artifact_id: validity.artifact_id },
    });
    const integrity = context.selectedArtifacts.find(
      (ref) => ref.kind === "specification-product-integrity"
    );
    const envelope = context.selectedArtifacts.find(
      (ref) => ref.kind === "specification-product-envelope"
    );
    if (integrity === undefined || envelope === undefined)
      throw new Error("current completion graph is absent");
    expect(
      validateSpecificationProductIntegrityV2(readJson(service, integrity.artifact_id))
    ).toMatchObject({
      status: "PASS",
      specification_ref: { artifact_id: products[2]?.artifact_id },
      vera_report_ref: { artifact_id: finalVeraReport.artifact_id },
      carren_report_ref: { artifact_id: finalCarrenReport.artifact_id },
      validity_receipt_ref: { artifact_id: validity.artifact_id },
      quality_receipt_ref: { artifact_id: quality.artifact_id },
    });
    expect(
      validateSpecificationProductEnvelopeV2(readJson(service, envelope.artifact_id))
    ).toMatchObject({
      status: "complete",
      specification_ref: { artifact_id: products[2]?.artifact_id },
      integrity_ref: { artifact_id: integrity.artifact_id },
    });
    expect(service.checkpointer.completionAdmission(runId)).toBeDefined();
  });

  it("exhausts the existing finite semantic repair budget without treating a reviewed draft as success", async () => {
    const fixture = genericSpecificationFixture();
    const drafts = Array.from({ length: 4 }, (_, index) =>
      Buffer.from(
        persistedSpecificationDraftV3({
          ...fixture.draft,
          requirements: fixture.draft.requirements.map((entry, i) =>
            i === 0
              ? { ...entry, statement: `${entry.statement} Candidate constraint ${index}.` }
              : entry
          ),
        })
      ).toString("utf8")
    );
    const client = new ScriptedDefineClient([
      orientation("author"),
      ...drafts.flatMap((draft) => [draft, defineReviewGap("vera", "product_gap")]),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" },
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-define-semantic-exhaust-${sequence}`));
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        incomplete_reason: "repair_budget_exhausted",
        exhausted: true,
        exhaustion_reason: "verifying_specification:product_gap",
      },
    });
    expect(
      client.invocations.filter((entry) => entry.stateId === "authoring_specification")
    ).toHaveLength(4);
    expect(
      client.invocations.filter((entry) => entry.stateId === "verifying_specification")
    ).toHaveLength(4);
    expect(client.invocations.some((entry) => entry.stateId === "critiquing_specification")).toBe(
      false
    );
  });

  it("completes one reviewed canonical SpecificationV1 without planning or execution", async () => {
    const fixture = genericSpecificationFixture();
    const client = new ScriptedDefineClient([
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-ready-${sequence}`;
    const directive = await service.execute(start(runId));
    expect(directive.action).toBe("complete");
    if (directive.action !== "complete") throw new Error("Define did not complete");
    const terminal = directive;
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "framing_definition",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);
    const ref = validateContract(
      ArtifactRefSchema,
      terminal.result.output_artifact_ref,
      "Define terminal output artifact ref"
    );
    const specification = validateSpecification(readJson(service, ref.artifact_id));
    expect(specification.disposition).toBe("ready");
    expect(specification.planning_handoff.planning_ready).toBe(true);
    expect(specification.planning_started).toBe(false);
    expect(specification.taskification_started).toBe(false);
    expect(specification.execution_started).toBe(false);
    expect(terminal.result).toMatchObject({
      execution_started: false,
      execution_authorized: false,
    });
    const integrityRef = terminal.artifacts.find(
      (artifact) => artifact.kind === "specification-product-integrity"
    );
    const envelopeRef = terminal.artifacts.find(
      (artifact) => artifact.kind === "specification-product-envelope"
    );
    if (integrityRef === undefined || envelopeRef === undefined) {
      throw new Error("Define completion artifacts are absent");
    }
    const frameRef = terminal.artifacts.find((artifact) => artifact.kind === "definition-frame");
    if (frameRef === undefined) throw new Error("Define frame artifact is absent");
    expect(service.artifacts.metadata(ref).upstream_refs).toContainEqual(frameRef);
    expect(specification.source_lineage).not.toHaveProperty("frame_ref");
    expect(
      validateSpecificationProductIntegrityV2(readJson(service, integrityRef.artifact_id))
    ).toMatchObject({
      status: "PASS",
      frame_ref: frameRef,
    });
    expect(
      validateSpecificationProductEnvelopeV2(readJson(service, envelopeRef.artifact_id))
    ).toMatchObject({
      status: "complete",
      frame_ref: frameRef,
    });
    for (const state of [
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]) {
      const invocation = client.invocations.find((entry) => entry.stateId === state);
      if (invocation === undefined) throw new Error(`Define ${state} invocation is absent`);
      expect(invocation.task).toContain(
        `MECHANICALLY_PROJECTED_SPECIFICATION_LINEAGE_CONTRACT:${specificationLineagePromptContract()}`
      );
      expect(invocation.inputArtifacts).toContainEqual(frameRef);
    }
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("Define completed context is absent");
    const input = {
      checkpointer: service.checkpointer,
      context,
      terminal,
      originState: "admitting_specification",
      latestProduct: {
        selector: "terminal_artifact" as const,
        schema_id: "penny.specification.v1",
        product_schema_version: 1,
        product_id: ref.artifact_id,
        sha256: ref.content_digest,
      },
      artifactReader: service.artifacts,
      projectRoot: PROJECT_ROOT,
    };
    expect(evaluateDefineLatestReviewedSpecificationDod(input).passed).toBe(true);
    const originalRefs = [...context.selectedArtifacts];
    context.selectedArtifacts = originalRefs.filter(
      (artifact) => artifact.kind !== "definition-frame"
    );
    expect(evaluateDefineLatestReviewedSpecificationDod(input)).toEqual({
      passed: false,
      evidence_refs: [],
    });
    context.selectedArtifacts = originalRefs.map((artifact) =>
      artifact.kind === "definition-frame"
        ? { ...artifact, content_digest: "f".repeat(64) }
        : artifact
    );
    expect(evaluateDefineLatestReviewedSpecificationDod(input)).toEqual({
      passed: false,
      evidence_refs: [],
    });
  });

  it("seals a complete reciprocal source index when one source supports more than 64 items", async () => {
    const fixture = genericSpecificationFixture();
    const additionalConstraints = Array.from(
      { length: 64 - fixture.draft.constraints.length },
      (_unused, index) => ({
        statement: `High-fanout bounded constraint ${index + 1}.`,
        source_item_indexes: [0],
      })
    );
    const highFanoutDraft: SpecificationDraftV1 = {
      ...fixture.draft,
      constraints: [...fixture.draft.constraints, ...additionalConstraints],
    };
    const client = new ScriptedDefineClient([
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(highFanoutDraft)).toString("utf8"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-define-high-fanout-${sequence}`));
    if (terminal.action !== "complete") {
      throw new Error(`high-fanout run ended: ${canonicalJson(terminal)}`);
    }
    const productRef = validateContract(
      ArtifactRefSchema,
      terminal.result.output_artifact_ref,
      "high-fanout product"
    );
    const specification = validateSpecification(readJson(service, productRef.artifact_id));
    const sourceId = specification.source_items[0]?.source_item_id;
    if (sourceId === undefined) throw new Error("high-fanout source is absent");
    const coverage = specification.source_coverage.find(
      (entry) => entry.source_item_id === sourceId
    );
    if (coverage === undefined) throw new Error("high-fanout coverage is absent");
    expect(coverage.product_item_ids.length).toBeGreaterThan(64);
  });

  it("repairs one induced coverage failure in a 44-requirement, 32-criterion, 60-source draft without regenerating it", async () => {
    const controlThemes = [
      "authorization",
      "audit retention",
      "input validation",
      "idempotent retry",
      "rollback readiness",
      "service-level monitoring",
      "data minimization",
      "dependency isolation",
      "incident escalation",
      "operator handoff",
      "configuration integrity",
    ] as const;
    const request = canonicalizeDefinitionRequest({
      goal: "Define a dense but bounded operational specification.",
      constraints: {
        schema_version: 1,
        mode: "create",
        requested_profile_id: "generic",
        desired_outcomes: ["Every dense requirement is observable."],
        audiences: ["Operational reviewers"],
        in_scope: ["Dense specification review"],
        out_of_scope: [],
        hard_constraints: Array.from({ length: 54 }, (_, index) => {
          const theme = controlThemes[index % controlThemes.length];
          return `${theme} control ${Math.floor(index / controlThemes.length) + 1} remains mandatory.`;
        }),
        non_goals: ["Do not execute the dense specification."],
        known_assumptions: [{ statement: "The dense fixture remains bounded.", material: false }],
        known_uncertainties: [],
        prior_decisions: [],
        standard_hints: [],
      },
      exactInputArtifactIds: [],
    });
    const frame = genericDefinitionFrame(request);
    const requirements = Array.from({ length: 44 }, (_, index) => {
      const theme = controlThemes[index % controlThemes.length];
      return {
        statement: `${theme} behavior ${Math.floor(index / controlThemes.length) + 1} must have a reviewable operating condition.`,
        category: ["outcome", "constraint", "quality"][index % 3] ?? "outcome",
        priority: "must" as const,
        objective_indexes: [index % 4],
        source_item_indexes: [1, 4 + index],
      };
    });
    const acceptanceCriteria = Array.from({ length: 32 }, (_, index) => {
      const requirement_indexes = index < 12 ? [index * 2, index * 2 + 1] : [24 + (index - 12)];
      return {
        statement: `Review the operating evidence for control group ${index + 1}.`,
        observation: `A reviewer can distinguish pass, fail, and missing evidence for requirement set ${requirement_indexes.join(",")}.`,
        requirement_indexes,
        source_item_indexes: [1, 4 + (requirement_indexes[0] ?? 0)],
      };
    });
    const denseDraft: SpecificationDraftV1 = {
      specification_report:
        "A dense provider-free specification used to exercise stable relational repair.",
      ...genericSpecificationCore(frame),
      scope: { included: [...request.in_scope], excluded: [] },
      audiences: [...request.audiences],
      objectives: Array.from({ length: 4 }, (_, index) => ({
        statement: `Dense objective ${index + 1} is ready for review.`,
        source_item_indexes: index === 0 ? [0, 2, 3] : [1],
      })),
      requirements,
      acceptance_criteria: acceptanceCriteria,
      constraints: request.hard_constraints.map((statement, index) => ({
        statement,
        source_item_indexes: [4 + index],
      })),
      non_goals: [
        { statement: request.non_goals[0] ?? "missing non-goal", source_item_indexes: [58] },
      ],
      assumptions: [
        {
          statement: request.known_assumptions[0]?.statement ?? "missing assumption",
          source_item_indexes: [59],
        },
      ],
      source_coverage: Array.from({ length: 60 }, (_, source_item_index) => ({
        source_item_index,
        disposition: "incorporated" as const,
        rationale: `Dense source ${source_item_index} is linked by an exact semantic item.`,
      })),
    };
    const keyed = keyedSpecificationDraft(denseDraft, request);
    const broken: SpecificationDraftV3 = {
      ...keyed,
      specification: {
        ...keyed.specification,
        acceptance_criteria: keyed.specification.acceptance_criteria.map((entry) =>
          entry.draft_key === "ac-12"
            ? {
                ...entry,
                requirement_keys: entry.requirement_keys.filter((key) => key !== "req-24"),
              }
            : entry
        ),
      },
    };
    class DenseRepairClient implements ModelClient {
      readonly invocations: AgentInvocation[] = [];
      private authorings = 0;

      async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
        this.invocations.push(invocation);
        if (invocation.stateId === "framing_definition") return { text: orientation("author") };
        if (invocation.stateId === "authoring_specification") {
          this.authorings += 1;
          if (this.authorings === 1) {
            return { text: Buffer.from(serializeKeyedDraftV3(broken)).toString("utf8") };
          }
          expect(invocation.task).toContain("SpecificationDraftRepairV1");
          const base = invocation.inputArtifacts.find((ref) => ref.kind === "specification-draft");
          const diagnostic = invocation.inputArtifacts.find(
            (ref) => ref.kind === "seal-diagnostic"
          );
          if (base === undefined || diagnostic === undefined) {
            throw new Error("dense repair lacks exact base or diagnostic");
          }
          return {
            text: `SPECIFICATION_REPAIR:${canonicalJson({
              schema_id: "penny.specification-draft-repair.v1",
              schema_version: 1,
              base_draft_ref: base,
              base_draft_sha256: base.content_digest,
              diagnostic_ref: diagnostic,
              operations: [
                {
                  operation: "add_acceptance_criterion",
                  criterion: {
                    draft_key: "ac-repair-24",
                    statement: "Audit retention behavior 3 has an observable acceptance condition.",
                    observation:
                      "A reviewer can distinguish pass, fail, and missing retention evidence.",
                    requirement_keys: ["req-24"],
                    source_item_indexes: [1],
                  },
                },
              ],
            })}\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", complete: true })}`,
          };
        }
        if (invocation.stateId === "verifying_specification") return { text: veraPass() };
        if (invocation.stateId === "critiquing_specification") return { text: carrenApprove() };
        throw new Error(`unexpected dense Define state '${invocation.stateId}'`);
      }
    }
    const client = new DenseRepairClient();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-dense-keyed-repair-${sequence}`;
    const terminal = await service.execute({
      ...start(runId),
      goal: request.goal,
      constraints: defineRequestConstraints(request),
    });
    if (terminal.action !== "complete") {
      throw new Error(`dense repair ended: ${canonicalJson(terminal)}`);
    }
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("dense repair context is absent");
    const diagnosticRef = context.selectedArtifacts.find((ref) => ref.kind === "seal-diagnostic");
    if (diagnosticRef === undefined) throw new Error("dense repair diagnostic is absent");
    const diagnostic = sealDiagnostic(service, diagnosticRef);
    expect(diagnostic.issues).toContainEqual(
      expect.objectContaining({
        code: "UNCOVERED_REQUIREMENT",
        path: "/specification/requirements/by-key/req-24/acceptance_coverage",
      })
    );
    expect(client.invocations[2]?.task).toContain("SpecificationDraftRepairV1");
    const materialized = context.selectedArtifacts.find(
      (ref) =>
        ref.kind === "specification-draft" && ref.producer === "host:specification-draft-repair"
    );
    const repairRef = context.selectedArtifacts.find(
      (ref) => ref.kind === "specification-draft-repair"
    );
    if (materialized === undefined || repairRef === undefined) {
      throw new Error("dense repair materialization is absent");
    }
    expect(service.artifacts.metadata(materialized).upstream_refs).toEqual([
      diagnostic.rejected_draft_ref,
      repairRef,
      diagnosticRef,
    ]);
    expect(terminal.artifacts).toContainEqual(diagnostic.rejected_draft_ref);
    expect(terminal.artifacts).toContainEqual(repairRef);
    expect(terminal.artifacts).toContainEqual(diagnosticRef);
    const productRef = validateContract(
      ArtifactRefSchema,
      terminal.result.output_artifact_ref,
      "dense repaired product"
    );
    const product = validateSpecification(readJson(service, productRef.artifact_id));
    expect(product.source_items).toHaveLength(60);
    expect(product.requirements).toHaveLength(44);
    expect(product.acceptance_criteria).toHaveLength(33);
    const traceRef = terminal.artifacts.find((ref) => ref.kind === "definition-trace");
    const integrityRef = terminal.artifacts.find(
      (ref) => ref.kind === "specification-product-integrity"
    );
    if (traceRef === undefined || integrityRef === undefined) {
      throw new Error("dense repaired trace or integrity evidence is absent");
    }
    const trace = validateDefinitionTraceV1(readJson(service, traceRef.artifact_id));
    const integrity = validateSpecificationProductIntegrityV2(
      readJson(service, integrityRef.artifact_id)
    );
    expect(trace.product_ref).toEqual(productRef);
    expect(trace.coverage).toHaveLength(60);
    expect(integrity.draft_ref).toEqual(materialized);
    expect(integrity.execution_receipt_ids).toHaveLength(5);
    expect(
      product.requirements.every((requirement) =>
        product.acceptance_criteria.some((criterion) =>
          criterion.requirement_ids.includes(requirement.item_id)
        )
      )
    ).toBe(true);
  });

  it("binds otherwise identical standards to their own draft-key evidence in the trace", async () => {
    const outputs: string[] = [];
    const client = new ScriptedDefineClient(outputs);
    const env = environment();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    const imported = persistEvidenceContext(service.artifacts, "define-standard-trace");
    const base = genericDefinitionRequest();
    const request = canonicalizeDefinitionRequest({
      goal: base.goal,
      constraints: {
        ...defineRequestConstraints(base),
        standard_hints: [
          {
            category: "audit",
            standard: "Shared audit control",
            relevance: "Two independent evidence sources inform the same named control.",
          },
        ],
      },
      exactInputArtifactIds: [imported.ref.artifact_id],
    });
    const frame = genericDefinitionFrame(request);
    const core = genericSpecificationCore(frame);
    const question = "Which exact standard applies?";
    const questionId = definitionQuestionId({
      requestId: request.request_id,
      owner: "evidence",
      sourceItemIndex: null,
      question,
      material: true,
    });
    const draft: SpecificationDraftV1 = {
      specification_report:
        "The audit control is represented twice because each row carries different exact evidence.",
      ...core,
      standards_status: [
        {
          category: "audit",
          standard: "Shared audit control",
          status: "satisfied_with_evidence",
          rationale: "Exact admitted evidence supports this control instance.",
          evidence_artifact_slots: [],
          source_item_indexes: [6],
        },
        {
          category: "audit",
          standard: "Shared audit control",
          status: "satisfied_with_evidence",
          rationale: "Exact admitted evidence supports this control instance.",
          evidence_artifact_slots: [],
          source_item_indexes: [6, 7],
        },
      ],
      source_coverage: [
        ...core.source_coverage,
        {
          source_item_index: 6,
          disposition: "incorporated",
          rationale: "The supplied audit standard is represented by exact evidence-bound rows.",
        },
        {
          source_item_index: 7,
          disposition: "incorporated",
          rationale: "The imported evidence context is linked to both evidence-bound rows.",
        },
      ],
    };
    const claims: SpecificationDraftV3["support_claims"] = [
      {
        target: { kind: "discovered_question", question_id: questionId },
        status: "resolved",
        claim: "The exact native evidence identifies the applicable standard.",
        rationale: "The selected Echo bytes state the standard.",
        support: [
          {
            support_slot: 0,
            locator: { kind: "utf8_byte_range", start: 0, end_exclusive: 6 },
          },
        ],
      },
      {
        target: { kind: "standard", standard_key: "standard-1" },
        claim: "Native evidence supports the first audit-control row.",
        support: [
          {
            support_slot: 0,
            locator: { kind: "utf8_byte_range", start: 0, end_exclusive: 6 },
          },
        ],
      },
      {
        target: { kind: "standard", standard_key: "standard-2" },
        claim: "Imported evidence supports the second audit-control row.",
        support: [
          {
            support_slot: 1,
            locator: { kind: "json_pointer", pointer: "/entries/0/statement" },
          },
        ],
      },
    ];
    const echo = `Native evidence names the shared audit control.\nSUMMARY:${canonicalJson({
      confidence: "CERTAIN",
      evidence_complete: true,
      findings: ["The standard is identified."],
      unresolved: [],
    })}`;
    outputs.push(
      orientation("evidence"),
      echo,
      Buffer.from(persistedSpecificationDraftV3(draft, request, claims)).toString("utf8"),
      veraPass(),
      carrenApprove()
    );
    sequence += 1;
    const runId = `run-define-standard-key-trace-${sequence}`;
    const terminal = await service.execute({
      ...start(runId),
      goal: request.goal,
      constraints: defineRequestConstraints(request),
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "evidence_context", ref: imported.ref }],
      },
    });
    if (terminal.action !== "complete") {
      const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts ?? [];
      const diagnostics = selected
        .filter((ref) => ref.kind === "seal-diagnostic")
        .map((ref) => readJson(service, ref.artifact_id));
      throw new Error(`standard trace ended: ${canonicalJson({ terminal, diagnostics })}`);
    }
    const traceRef = terminal.artifacts.find((ref) => ref.kind === "definition-trace");
    const nativeRef = terminal.artifacts.find(
      (ref) => ref.phase === "gathering_definition_evidence" && ref.kind === "agent-output"
    );
    if (traceRef === undefined || nativeRef === undefined) {
      throw new Error("standard trace operands are absent");
    }
    const trace = validateDefinitionTraceV1(readJson(service, traceRef.artifact_id));
    const nativeRow = trace.standard_support.find(
      (row) => row.claim === "Native evidence supports the first audit-control row."
    );
    const importedRow = trace.standard_support.find(
      (row) => row.claim === "Imported evidence supports the second audit-control row."
    );
    expect(nativeRow?.support[0]?.ref).toEqual(nativeRef);
    expect(importedRow?.support[0]?.ref).toEqual(imported.ref);
    expect(nativeRow?.standard_item_id).not.toBe(importedRow?.standard_item_id);
  });

  it("terminalizes an unrelated closed repair as exact invalid work instead of a host error", async () => {
    const fixture = genericSpecificationFixture();
    const keyed = keyedSpecificationDraft(fixture.draft, fixture.request);
    const broken: SpecificationDraftV3 = {
      ...keyed,
      specification: {
        ...keyed.specification,
        acceptance_criteria: keyed.specification.acceptance_criteria.filter(
          (criterion) => criterion.draft_key !== "ac-3"
        ),
      },
    };
    class InvalidRepairClient implements ModelClient {
      readonly invocations: AgentInvocation[] = [];
      private authorings = 0;

      async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
        this.invocations.push(invocation);
        if (invocation.stateId === "framing_definition") return { text: orientation("author") };
        if (invocation.stateId !== "authoring_specification") {
          throw new Error(`unexpected invalid-repair state '${invocation.stateId}'`);
        }
        this.authorings += 1;
        if (this.authorings === 1) {
          return { text: Buffer.from(serializeKeyedDraftV3(broken)).toString("utf8") };
        }
        const base = invocation.inputArtifacts.find((ref) => ref.kind === "specification-draft");
        const diagnostic = invocation.inputArtifacts.find((ref) => ref.kind === "seal-diagnostic");
        if (base === undefined || diagnostic === undefined) {
          throw new Error("invalid repair lacks exact operands");
        }
        return {
          text: `SPECIFICATION_REPAIR:${canonicalJson({
            schema_id: "penny.specification-draft-repair.v1",
            schema_version: 1,
            base_draft_ref: base,
            base_draft_sha256: base.content_digest,
            diagnostic_ref: diagnostic,
            operations: [
              {
                operation: "add_acceptance_criterion",
                criterion: {
                  draft_key: "ac-unrelated",
                  statement: "Restate an already covered outcome.",
                  observation: "The first requirement remains covered.",
                  requirement_keys: ["req-1"],
                  source_item_indexes: [1],
                },
              },
            ],
          })}\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", complete: true })}`,
        };
      }
    }
    const client = new InvalidRepairClient();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-invalid-closed-repair-${sequence}`;
    const terminal = await service.execute(start(runId));
    if (terminal.action !== "incomplete") {
      throw new Error(`invalid closed repair ended: ${canonicalJson(terminal)}`);
    }
    expect(terminal.result).toMatchObject({
      met: false,
      incomplete_reason: "seal_repair_invalid",
      stalled: true,
      stall_reason: "seal_defect",
    });
    expect(terminal.unresolved.join("\n")).toContain("cannot add unrelated requirement links");
    const repair = terminal.artifacts.find((ref) => ref.kind === "specification-draft-repair");
    const diagnostic = terminal.artifacts.find((ref) => ref.kind === "seal-diagnostic");
    if (repair === undefined || diagnostic === undefined) {
      throw new Error("invalid repair terminal lacks exact negative artifacts");
    }
    expect(service.artifacts.readById(repair.artifact_id).toString("utf8")).toContain(
      '"requirement_keys":["req-1"]'
    );
    expect(
      terminal.artifacts.some(
        (ref) =>
          ref.kind === "specification-draft" && ref.producer === "host:specification-draft-repair"
      )
    ).toBe(false);
    expect(client.invocations).toHaveLength(3);
  });

  it("terminalizes a narrow repair whose derived draft exceeds the criterion bound", async () => {
    const fixture = genericSpecificationFixture();
    const keyed = keyedSpecificationDraft(fixture.draft, fixture.request);
    const template = keyed.specification.acceptance_criteria[0];
    if (template === undefined) throw new Error("overflow criterion template is absent");
    const broken: SpecificationDraftV3 = {
      ...keyed,
      specification: {
        ...keyed.specification,
        acceptance_criteria: [
          ...keyed.specification.acceptance_criteria.filter(
            (criterion) => criterion.draft_key !== "ac-3"
          ),
          ...Array.from({ length: 254 }, (_, index) => ({
            ...template,
            draft_key: `ac-overflow-${index + 1}`,
            statement: `Existing bounded criterion ${index + 1}.`,
            observation: `Existing observation ${index + 1} remains reviewable.`,
          })),
        ],
      },
    };
    class OverflowRepairClient implements ModelClient {
      private authorings = 0;

      async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
        if (invocation.stateId === "framing_definition") return { text: orientation("author") };
        if (invocation.stateId !== "authoring_specification") {
          throw new Error(`unexpected overflow-repair state '${invocation.stateId}'`);
        }
        this.authorings += 1;
        if (this.authorings === 1) {
          return { text: Buffer.from(serializeKeyedDraftV3(broken)).toString("utf8") };
        }
        const base = invocation.inputArtifacts.find((ref) => ref.kind === "specification-draft");
        const diagnostic = invocation.inputArtifacts.find((ref) => ref.kind === "seal-diagnostic");
        if (base === undefined || diagnostic === undefined) {
          throw new Error("overflow repair lacks exact operands");
        }
        return {
          text: `SPECIFICATION_REPAIR:${canonicalJson({
            schema_id: "penny.specification-draft-repair.v1",
            schema_version: 1,
            base_draft_ref: base,
            base_draft_sha256: base.content_digest,
            diagnostic_ref: diagnostic,
            operations: [
              {
                operation: "add_acceptance_criterion",
                criterion: {
                  draft_key: "ac-overflow-repair",
                  statement: "The third requirement is observable.",
                  observation: "Requirement req-3 has exact review evidence.",
                  requirement_keys: ["req-3"],
                  source_item_indexes: [0],
                },
              },
            ],
          })}\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", complete: true })}`,
        };
      }
    }
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new OverflowRepairClient(),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-define-overflow-repair-${sequence}`));
    if (terminal.action !== "incomplete") {
      throw new Error(`overflow repair ended: ${canonicalJson(terminal)}`);
    }
    expect(terminal.result).toMatchObject({
      met: false,
      incomplete_reason: "seal_repair_invalid",
      stalled: true,
    });
    expect(terminal.artifacts.some((ref) => ref.kind === "specification-draft-repair")).toBe(true);
    expect(
      terminal.artifacts.some(
        (ref) =>
          ref.kind === "specification-draft" && ref.producer === "host:specification-draft-repair"
      )
    ).toBe(false);
  });

  it("repairs incomplete source rows without requiring a model-authored reverse reference table", async () => {
    const fixture = genericSpecificationFixture();
    const hostProjectedDraft: SpecificationDraftV1 = {
      ...fixture.draft,
      source_coverage: fixture.draft.source_coverage.map((entry) => ({
        ...entry,
        product_item_refs: [],
      })),
    };
    const incompleteDraft: SpecificationDraftV1 = {
      ...hostProjectedDraft,
      source_coverage: hostProjectedDraft.source_coverage.slice(0, -1),
    };
    const client = new ScriptedDefineClient([
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(incompleteDraft)).toString("utf8"),
      Buffer.from(persistedSpecificationDraftV3(hostProjectedDraft)).toString("utf8"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-source-repair-${sequence}`;
    const terminal = await service.execute(start(runId));
    if (terminal.action !== "complete") {
      throw new Error(`source repair ended: ${canonicalJson(terminal)}`);
    }
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "framing_definition",
      "authoring_specification",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("source repair context is absent");
    const feedbackRefs = context.selectedArtifacts.filter((ref) => ref.kind === "seal-diagnostic");
    expect(feedbackRefs).toHaveLength(1);
    const firstFeedbackRef = feedbackRefs[0];
    if (firstFeedbackRef === undefined) throw new Error("source repair feedback is absent");
    expect(sealDiagnostic(service, firstFeedbackRef).rejection_ordinal).toBe(1);
    expect(sealDiagnostic(service, firstFeedbackRef).issues).toContainEqual({
      code: "MISSING_SOURCE_ORDINAL",
      path: "/specification/source_coverage/by-ordinal/5",
      detail: "Source coverage omits ordinal 5 (non_goal).",
      source_ordinals: [5],
    });
    const repairInvocation = client.invocations[2];
    if (repairInvocation === undefined) throw new Error("source repair invocation is absent");
    expect(repairInvocation.inputArtifacts).toContainEqual(firstFeedbackRef);
    const productRef = validateContract(
      ArtifactRefSchema,
      terminal.result.output_artifact_ref,
      "source repair product"
    );
    const specification = validateSpecification(readJson(service, productRef.artifact_id));
    expect(specification.source_coverage).toHaveLength(specification.source_items.length);
    expect(specification.source_coverage.every((entry) => entry.product_item_ids.length > 0)).toBe(
      true
    );
  });

  it("returns projected-ID collisions to Rhea before any product is persisted", async () => {
    const fixture = genericSpecificationFixture();
    const objective = fixture.draft.objectives[0];
    if (objective === undefined) throw new Error("objective fixture is absent");
    const collision: SpecificationDraftV1 = {
      ...fixture.draft,
      objectives: [...fixture.draft.objectives, { ...objective, source_item_indexes: [1] }],
    };
    const client = new ScriptedDefineClient([
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(collision)).toString("utf8"),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-collision-repair-${sequence}`;
    const terminal = await service.execute(start(runId));
    if (terminal.action !== "complete")
      throw new Error(`collision run ended: ${canonicalJson(terminal)}`);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("collision run is absent");
    const feedback = context.selectedArtifacts.find((ref) => ref.kind === "seal-diagnostic");
    if (feedback === undefined) throw new Error("projection diagnostic is absent");
    const projectionDiagnostic = sealDiagnostic(service, feedback);
    expect(projectionDiagnostic.failure_class).toBe("PROJECTION_INVALID");
    expect(
      projectionDiagnostic.issues.some(
        (issue) => issue.detail === "objective projected stable ID collision at indexes 0 and 1"
      )
    ).toBe(true);
    const products = context.selectedArtifacts.filter((ref) => ref.kind === "specification");
    expect(products).toHaveLength(1);
    expect(products[0]?.version).toBe(1);
    expect(client.invocations[2]?.inputArtifacts).toContainEqual(feedback);
  });

  it("supplies the same admitted 46-source manifest through correction and both reviews", async () => {
    const fixture = fortySixSourceFixture();
    const client = new ScriptedDefineClient([
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(fixture.replacement, fixture.request)).toString(
        "utf8"
      ),
      Buffer.from(persistedSpecificationDraftV3(fixture.repaired, fixture.request)).toString(
        "utf8"
      ),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-manifest-46-${sequence}`;
    const terminal = await service.execute({
      ...start(runId),
      goal: fixture.request.goal,
      constraints: defineRequestConstraints(fixture.request),
    });
    if (terminal.action !== "complete")
      throw new Error(`manifest run ended: ${canonicalJson(terminal)}`);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("manifest run is absent");
    const manifestRef = context.selectedArtifacts.find(
      (ref) => ref.kind === "definition-source-manifest"
    );
    const requestRef = context.selectedArtifacts.find((ref) => ref.kind === "definition-request");
    if (manifestRef === undefined || requestRef === undefined)
      throw new Error("admitted source namespace is absent");
    expect(manifestRef.version).toBe(1);
    expect(
      validateDefinitionSourceManifest(
        readJson(service, manifestRef.artifact_id),
        fixture.request,
        requestRef
      ).source_count
    ).toBe(46);
    expect(service.artifacts.metadata(manifestRef).upstream_refs).toEqual([requestRef]);
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "framing_definition",
      "authoring_specification",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);
    for (const invocation of client.invocations) {
      expect(invocation.inputArtifacts).toContainEqual(manifestRef);
      expect(invocation.inputArtifacts).toContainEqual(requestRef);
    }
    const feedback = context.selectedArtifacts.find((ref) => ref.kind === "seal-diagnostic");
    if (feedback === undefined) throw new Error("46-source rejection is absent");
    const diagnostic = sealDiagnostic(service, feedback);
    for (const [ordinal, kind] of [
      [42, "prior_decision"],
      [43, "standard_hint"],
      [44, "standard_hint"],
      [45, "standard_hint"],
    ] as const) {
      expect(diagnostic.issues).toContainEqual(
        expect.objectContaining({
          code: "MISSING_SOURCE_ORDINAL",
          path: `/specification/source_coverage/by-ordinal/${ordinal}`,
          detail: `Source coverage omits ordinal ${ordinal} (${kind}).`,
          source_ordinals: [ordinal],
        })
      );
    }
    const product = validateContract(
      ArtifactRefSchema,
      terminal.result.output_artifact_ref,
      "46-source product"
    );
    expect(
      validateSpecification(readJson(service, product.artifact_id)).source_coverage
    ).toHaveLength(46);
    for (const kind of [
      "definition-frame",
      "specification",
      "specification-product-integrity",
      "specification-product-envelope",
    ]) {
      const ref = context.selectedArtifacts.find((entry) => entry.kind === kind);
      if (ref === undefined) throw new Error(`missing ${kind} completion binding`);
      expect(service.artifacts.metadata(ref).upstream_refs).toContainEqual(manifestRef);
    }
    expect(terminal.artifacts).toContainEqual(manifestRef);
    expect(service.checkpointer.completionAdmission(runId)).toBeDefined();
  });

  it("persists the final seal diagnostic when two corrections remain invalid", async () => {
    const fixture = genericSpecificationFixture();
    const firstDraft: SpecificationDraftV1 = {
      ...fixture.draft,
      source_coverage: fixture.draft.source_coverage.slice(0, -1),
    };
    const secondDraft: SpecificationDraftV1 = {
      ...fixture.draft,
      requirements: fixture.draft.requirements.map((entry, index) =>
        index === 0 ? { ...entry, objective_indexes: [63] } : entry
      ),
    };
    const thirdDraft: SpecificationDraftV1 = {
      ...fixture.draft,
      acceptance_criteria: fixture.draft.acceptance_criteria.map((entry, index) =>
        index === 0 ? { ...entry, requirement_indexes: [127] } : entry
      ),
    };
    const client = new ScriptedDefineClient([
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(firstDraft)).toString("utf8"),
      Buffer.from(persistedSpecificationDraftV3(secondDraft)).toString("utf8"),
      Buffer.from(persistedSpecificationDraftV3(thirdDraft)).toString("utf8"),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: explicitSealPolicy(DEFINE_PLAYBOOK_REGISTRATION, 2),
    });
    sequence += 1;
    const runId = `run-define-seal-exhausted-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("seal exhaustion was not incomplete");
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "framing_definition",
      "authoring_specification",
      "authoring_specification",
      "authoring_specification",
    ]);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("seal exhaustion context is absent");
    const feedbackRefs = context.selectedArtifacts.filter((ref) => ref.kind === "seal-diagnostic");
    expect(feedbackRefs.map((ref) => sealDiagnostic(service, ref).rejection_ordinal)).toEqual([
      1, 2, 3,
    ]);
    const firstFeedbackRef = feedbackRefs[0];
    const secondFeedbackRef = feedbackRefs[1];
    const finalFeedbackRef = feedbackRefs[2];
    if (
      firstFeedbackRef === undefined ||
      secondFeedbackRef === undefined ||
      finalFeedbackRef === undefined
    ) {
      throw new Error("seal diagnostic revisions are absent");
    }
    expect(sealDiagnostic(service, firstFeedbackRef).rejection_ordinal).toBe(1);
    expect(sealDiagnostic(service, firstFeedbackRef).issues).toContainEqual({
      code: "MISSING_SOURCE_ORDINAL",
      path: "/specification/source_coverage/by-ordinal/5",
      detail: "Source coverage omits ordinal 5 (non_goal).",
      source_ordinals: [5],
    });
    const finalFeedback = sealDiagnostic(service, finalFeedbackRef);
    expect(sealDiagnostic(service, secondFeedbackRef).rejection_ordinal).toBe(2);
    expect(finalFeedback.rejection_ordinal).toBe(3);
    expect(finalFeedback.failure_class).toBe("SEMANTIC_INVALID");
    expect(finalFeedback.issues).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_REQUIREMENT_KEY" })
    );
    const finalFeedbackMetadata = service.artifacts.metadata(finalFeedbackRef);
    expect(finalFeedbackMetadata.parent_ref).toBeNull();
    expect(finalFeedbackMetadata.upstream_refs).toContainEqual(secondFeedbackRef);
    expect(terminal.unresolved).toContain(
      `latest seal diagnostic: ${finalFeedbackRef.artifact_id}`
    );
    expect(terminal.result.seal_diagnostics).toMatchObject({
      latest_diagnostic_ref: finalFeedbackRef,
      rejected_draft_ref: finalFeedback.rejected_draft_ref,
      corrections_used: 2,
      correction_limit: 2,
      disposition: "exhausted",
    });
    expect(terminal.result).toMatchObject({
      met: false,
      incomplete_reason: "seal_repair_exhausted",
      exhausted: true,
      exhaustion_reason: "seal_defect",
    });
  });

  it("grants one seal correction to a later review-repair epoch without carrying stale feedback", async () => {
    const fixture = genericSpecificationFixture();
    const invalidInitial: SpecificationDraftV1 = {
      ...fixture.draft,
      source_coverage: fixture.draft.source_coverage.slice(0, -1),
    };
    const invalidReviewRepair: SpecificationDraftV1 = {
      ...fixture.draft,
      supersession_intents: [
        {
          prior_item_id: `spec-requirement-${"a".repeat(64)}`,
          replacement: { kind: "requirement", index: 0 },
          reason: "Incorrectly treats the same-run reviewed product as an imported prior revision.",
        },
      ],
    };
    const client = new ScriptedDefineClient([
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(invalidInitial)).toString("utf8"),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      defineReviewGap("vera", "product_gap"),
      Buffer.from(persistedSpecificationDraftV3(invalidReviewRepair)).toString("utf8"),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-seal-epoch-repair-${sequence}`;
    const terminal = await service.execute(start(runId));
    if (terminal.action !== "complete") {
      throw new Error(`seal epoch repair ended: ${canonicalJson(terminal)}`);
    }
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "framing_definition",
      "authoring_specification",
      "authoring_specification",
      "verifying_specification",
      "authoring_specification",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("seal epoch repair context is absent");
    const feedbackRefs = context.selectedArtifacts.filter((ref) => ref.kind === "seal-diagnostic");
    expect(feedbackRefs.map((ref) => sealDiagnostic(service, ref).rejection_ordinal)).toEqual([
      1, 1,
    ]);
    const firstFeedback = feedbackRefs[0];
    const secondFeedback = feedbackRefs[1];
    if (firstFeedback === undefined || secondFeedback === undefined) {
      throw new Error("seal epoch feedback is absent");
    }
    expect(client.invocations[2]?.inputArtifacts).toContainEqual(firstFeedback);
    expect(client.invocations[4]?.inputArtifacts).not.toContainEqual(firstFeedback);
    expect(client.invocations[5]?.inputArtifacts).toContainEqual(secondFeedback);
    expect(client.invocations[5]?.inputArtifacts).not.toContainEqual(firstFeedback);
    expect(sealDiagnostic(service, secondFeedback).issues).toContainEqual(
      expect.objectContaining({ detail: "create request cannot contain supersession intents" })
    );
    const finalProduct = validateContract(
      ArtifactRefSchema,
      terminal.result.output_artifact_ref,
      "seal epoch final product"
    );
    expect(finalProduct.version).toBe(1);
  });

  it("stalls an unchanged reviewed replacement diagnostic without spending the second correction", async () => {
    const fixture = genericSpecificationFixture();
    const invalid: SpecificationDraftV1 = {
      ...fixture.draft,
      source_coverage: fixture.draft.source_coverage.slice(0, -1),
    };
    const client = new ScriptedDefineClient([
      orientation("author"),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      defineReviewGap("vera", "product_gap"),
      Buffer.from(persistedSpecificationDraftV3(invalid)).toString("utf8"),
      Buffer.from(persistedSpecificationDraftV3(invalid)).toString("utf8"),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-reviewed-seal-exhausted-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("incomplete");
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "framing_definition",
      "authoring_specification",
      "verifying_specification",
      "authoring_specification",
      "authoring_specification",
    ]);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("reviewed epoch context absent");
    const anchor = selectedRefs(context, "specification")[0];
    const diagnostics = selectedRefs(context, "seal-diagnostic");
    if (anchor === undefined || diagnostics[0] === undefined || diagnostics[1] === undefined)
      throw new Error("reviewed epoch seal evidence absent");
    const first = sealDiagnostic(service, diagnostics[0]);
    const final = sealDiagnostic(service, diagnostics[1]);
    expect(diagnostics.map((ref) => ref.version)).toEqual([1, 1]);
    expect(diagnostics[0].operation_id).toBe(
      sealAddress(runId, first.rejected_draft_ref, anchor, "seal_diagnostic")
    );
    expect(diagnostics[1].operation_id).toBe(
      sealAddress(runId, final.rejected_draft_ref, anchor, "seal_diagnostic")
    );
    expect(first).toMatchObject({
      epoch_anchor_ref: anchor,
      rejection_ordinal: 1,
      corrections_used: 0,
      disposition: "correction_offered",
    });
    expect(final).toMatchObject({
      epoch_anchor_ref: anchor,
      rejection_ordinal: 2,
      corrections_used: 1,
      correction_limit: null,
      disposition: "stalled",
      stall_reason: "identical_rejected_digest",
      previous_diagnostic_ref: diagnostics[0],
    });
    expect(client.invocations[4]?.inputArtifacts).toContainEqual(diagnostics[0]);
    if (terminal.action !== "incomplete") throw new Error("expected negative terminal");
    expect(terminal.result.seal_diagnostics).toMatchObject({
      latest_diagnostic_ref: diagnostics[1],
      rejected_draft_ref: final.rejected_draft_ref,
      epoch_anchor_ref: anchor,
      corrections_used: 1,
      correction_limit: null,
      disposition: "stalled",
    });
    expect(terminal.result).toMatchObject({
      incomplete_reason: "seal_repair_stalled",
      stalled: true,
      stall_reason: "identical_rejected_digest",
    });
    expect(terminal.result.output_artifact_ref).toEqual(anchor);
  });

  it("recovers exact first seal feedback after interruption without duplicating its revision", async () => {
    const env = environment();
    const fixture = genericSpecificationFixture();
    const incompleteDraft: SpecificationDraftV1 = {
      ...fixture.draft,
      source_coverage: fixture.draft.source_coverage.slice(0, -1),
    };
    let interrupted = false;
    const registration = defineRegistrationWithHostFault((point) => {
      if (!interrupted && point === "sealing_specification:feedback-persistence") {
        interrupted = true;
        throw new Error("injected first feedback interruption");
      }
    });
    sequence += 1;
    const runId = `run-define-first-feedback-recovery-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDefineClient([
          orientation("author"),
          Buffer.from(persistedSpecificationDraftV3(incompleteDraft)).toString("utf8"),
        ]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(
        /injected first feedback interruption/u
      );
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_specification");
      const manifest = first.checkpointer
        .loadRunById(runId)
        ?.selectedArtifacts.find((ref) => ref.kind === "definition-source-manifest");
      if (manifest === undefined) throw new Error("pre-interruption manifest is absent");
      expect(
        first.artifacts.refFor(
          runId,
          "intake",
          null,
          "definition-source-manifest",
          manifest.operation_id,
          1
        )
      ).toEqual(manifest);
    }
    const recoveredClient = new ScriptedDefineClient([
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      veraPass(),
      carrenApprove(),
    ]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    const terminal = await recovered.execute({
      schema_version: 2,
      action: "recover",
      identity: start(runId).identity,
    });
    expect(terminal.action).toBe("complete");
    expect(recoveredClient.invocations.map((entry) => entry.stateId)).toEqual([
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);
    const context = recovered.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("first feedback recovery context is absent");
    const feedbackRefs = context.selectedArtifacts.filter((ref) => ref.kind === "seal-diagnostic");
    expect(feedbackRefs.map((ref) => ref.version)).toEqual([1]);
    const manifests = context.selectedArtifacts.filter(
      (ref) => ref.kind === "definition-source-manifest"
    );
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.version).toBe(1);
    for (const invocation of recoveredClient.invocations)
      expect(invocation.inputArtifacts).toContainEqual(manifests[0]);
  });

  it("adopts the exact sealed product and manifest after a pre-checkpoint interruption", async () => {
    const env = environment();
    const fixture = genericSpecificationFixture();
    let interrupted = false;
    const registration = defineRegistrationWithHostFault((point) => {
      if (!interrupted && point === "sealing_specification:artifact-persistence") {
        interrupted = true;
        throw new Error("injected product interruption");
      }
    });
    sequence += 1;
    const runId = `run-define-product-recovery-${sequence}`;
    let orphan: ArtifactRef | null = null;
    let manifest: ArtifactRef | undefined;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDefineClient([
          orientation("author"),
          Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
        ]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(/injected product interruption/u);
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_specification");
      const before = first.checkpointer.loadRunById(runId);
      const draft = before?.selectedArtifacts.find((ref) => ref.kind === "specification-draft");
      if (draft === undefined) throw new Error("interrupted draft is absent");
      orphan = first.artifacts.refFor(
        runId,
        "sealing_specification",
        null,
        "specification",
        productForDraft(runId, draft, null),
        1
      );
      manifest = first.checkpointer
        .loadRunById(runId)
        ?.selectedArtifacts.find((ref) => ref.kind === "definition-source-manifest");
      if (orphan === null || manifest === undefined)
        throw new Error("interrupted artifacts are absent");
    }
    const client = new ScriptedDefineClient([veraPass(), carrenApprove()]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    const terminal = await recovered.execute({
      schema_version: 2,
      action: "recover",
      identity: start(runId).identity,
    });
    if (terminal.action !== "complete")
      throw new Error(`product recovery ended: ${canonicalJson(terminal)}`);
    expect(terminal.result.output_artifact_ref).toEqual(orphan);
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "verifying_specification",
      "critiquing_specification",
    ]);
    expect(client.invocations[0]?.inputArtifacts).toContainEqual(manifest);
    const context = recovered.checkpointer.loadRunById(runId);
    expect(context?.selectedArtifacts.filter((ref) => ref.kind === "specification")).toEqual([
      orphan,
    ]);
    expect(
      context?.selectedArtifacts.filter((ref) => ref.kind === "definition-source-manifest")
    ).toEqual([manifest]);
    expect(
      recovered.artifacts.refFor(
        runId,
        "sealing_specification",
        null,
        "specification",
        orphan.operation_id,
        2
      )
    ).toBeNull();
  });

  it("recovers the final seal diagnostic and terminalizes without a third correction", async () => {
    const env = environment();
    const fixture = genericSpecificationFixture();
    const firstDraft: SpecificationDraftV1 = {
      ...fixture.draft,
      source_coverage: fixture.draft.source_coverage.slice(0, -1),
    };
    const secondDraft: SpecificationDraftV1 = {
      ...fixture.draft,
      requirements: fixture.draft.requirements.map((entry, index) =>
        index === 0 ? { ...entry, objective_indexes: [63] } : entry
      ),
    };
    const thirdDraft: SpecificationDraftV1 = {
      ...fixture.draft,
      acceptance_criteria: fixture.draft.acceptance_criteria.map((entry, index) =>
        index === 0 ? { ...entry, requirement_indexes: [127] } : entry
      ),
    };
    let feedbackPersistenceCount = 0;
    const registration = explicitSealPolicy(
      defineRegistrationWithHostFault((point) => {
        if (point !== "sealing_specification:feedback-persistence") return;
        feedbackPersistenceCount += 1;
        if (feedbackPersistenceCount === 3) {
          throw new Error("injected final feedback interruption");
        }
      }),
      2
    );
    sequence += 1;
    const runId = `run-define-final-feedback-recovery-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDefineClient([
          orientation("author"),
          Buffer.from(persistedSpecificationDraftV3(firstDraft)).toString("utf8"),
          Buffer.from(persistedSpecificationDraftV3(secondDraft)).toString("utf8"),
          Buffer.from(persistedSpecificationDraftV3(thirdDraft)).toString("utf8"),
        ]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(
        /injected final feedback interruption/u
      );
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_specification");
    }
    const recoveredClient = new ScriptedDefineClient([]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: explicitSealPolicy(DEFINE_PLAYBOOK_REGISTRATION, 2),
    });
    const terminal = await recovered.execute({
      schema_version: 2,
      action: "recover",
      identity: start(runId).identity,
    });
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") {
      throw new Error(`final feedback recovery ended: ${canonicalJson(terminal)}`);
    }
    expect(recoveredClient.invocations).toHaveLength(0);
    const context = recovered.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("final feedback recovery context is absent");
    const feedbackRefs = context.selectedArtifacts.filter((ref) => ref.kind === "seal-diagnostic");
    expect(
      feedbackRefs.map(
        (ref) =>
          validateSealDiagnostic(
            readJson(recovered, ref.artifact_id),
            runSealPolicy(recovered.checkpointer.loadRunById(ref.run_id) ?? {}, DEFINE_SEAL_POLICY)
          ).rejection_ordinal
      )
    ).toEqual([1, 2, 3]);
    const finalFeedbackRef = feedbackRefs[2];
    if (finalFeedbackRef === undefined) throw new Error("recovered final feedback is absent");
    expect(terminal.unresolved).toContain(
      `latest seal diagnostic: ${finalFeedbackRef.artifact_id}`
    );
  });

  it("revises an exact cross-run sealed specification without confusing its phase or version with the current product", async () => {
    const prior = genericSpecificationFixture();
    const outputs: string[] = [];
    const client = new ScriptedDefineClient(outputs);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    let priorRef: ArtifactRef | undefined;
    // A prior run may have more sealed revisions than the new run. Its canonical phase
    // and higher version must neither exclude it from imports nor select it as local output.
    for (let version = 1; version <= 4; version += 1) {
      priorRef = service.artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: "prior-define-revision-fixture",
          phase: "sealing_specification",
          branch_id: null,
          kind: "specification",
          operation_id: "prior-sealed-specification",
          version,
          producer: "host:specification-sealer",
          media_type: "application/json",
          content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
          parent_ref: priorRef ?? null,
          upstream_refs: [],
        },
        content: canonicalJson(prior.specification),
      });
    }
    if (priorRef === undefined) throw new Error("prior specification fixture is absent");
    const constraints = { ...defineRequestConstraints(prior.request), mode: "revise" as const };
    const request = canonicalizeDefinitionRequest({
      goal: prior.request.goal,
      constraints,
      exactInputArtifactIds: [priorRef.artifact_id],
    });
    const frame = genericDefinitionFrame(request);
    const core = genericSpecificationCore(frame);
    const draft: SpecificationDraftV1 = {
      ...core,
      specification_report:
        "This complete replacement preserves the prior specification's semantics.",
      objectives: core.objectives.map((entry, index) =>
        index === 0 ? { ...entry, source_item_indexes: [...entry.source_item_indexes, 6] } : entry
      ),
      source_coverage: [
        ...core.source_coverage,
        {
          source_item_index: 6,
          disposition: "incorporated",
          product_item_refs: [{ kind: "objective", index: 0 }],
          rationale: "The exact prior specification anchors the replacement.",
        },
      ],
    };
    outputs.push(
      orientation("author"),
      Buffer.from(
        persistedSpecificationDraftV3(
          {
            ...draft,
            source_coverage: draft.source_coverage.slice(0, -1),
          },
          request
        )
      ).toString("utf8"),
      Buffer.from(persistedSpecificationDraftV3(draft, request)).toString("utf8"),
      veraPass(),
      carrenApprove()
    );
    sequence += 1;
    const runId = `run-define-revise-${sequence}`;
    const startRequest = {
      ...start(runId),
      constraints,
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "prior-specification", ref: priorRef }],
      },
    };
    const opening = service.engine.handle(startRequest);
    if (opening.action !== "invoke_agent") throw new Error("revision did not dispatch framing");
    expect(opening.input_artifacts.artifacts).toContainEqual({
      slot: "prior-specification",
      ref: priorRef,
    });
    expect(
      opening.input_artifacts.artifacts.some((entry) => entry.slot === "latest-specification")
    ).toBe(false);
    const requestRef = opening.input_artifacts.artifacts.find(
      (entry) => entry.slot === "definition-request"
    )?.ref;
    if (requestRef === undefined) throw new Error("revision request ref is absent");
    expect(
      validateDefinitionRequest(readJson(service, requestRef.artifact_id)).input_artifact_ids
    ).toEqual([priorRef.artifact_id]);
    // Recover the exact pending directive through the real runner, not a reconstructed start.
    const terminal = await service.execute({
      schema_version: 2,
      action: "recover",
      identity: startRequest.identity,
    });
    if (terminal.action !== "complete")
      throw new Error(`revision ended: ${canonicalJson(terminal)}`);
    const productRef = validateContract(
      ArtifactRefSchema,
      terminal.result.output_artifact_ref,
      "revision product"
    );
    expect(productRef.run_id).toBe(runId);
    expect(productRef.version).toBe(1);
    expect(productRef.artifact_id).not.toBe(priorRef.artifact_id);
    const revised = validateSpecification(readJson(service, productRef.artifact_id), {
      priorSpecification: prior.specification,
    });
    expect(revised.source_lineage.input_artifact_ids).toEqual([priorRef.artifact_id]);
    expect(revised.source_lineage.prior_specification_artifact_id).toBe(priorRef.artifact_id);
    expect(revised.supersedes_specification_ids).toEqual([prior.specification.specification_id]);
    expect(revised.requirements).toEqual(prior.specification.requirements);
    for (const invocation of client.invocations) {
      expect(invocation.inputArtifacts).toContainEqual(priorRef);
    }
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "framing_definition",
      "authoring_specification",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);
    const currentContext = service.checkpointer.loadRunById(runId);
    if (currentContext === undefined) throw new Error("revision context is absent");
    const diagnostics = selectedRefs(currentContext, "seal-diagnostic");
    const drafts = selectedRefs(currentContext, "specification-draft");
    if (diagnostics[0] === undefined || drafts[0] === undefined || drafts[1] === undefined)
      throw new Error("revision correction evidence is absent");
    expect(diagnostics).toHaveLength(1);
    expect(sealDiagnostic(service, diagnostics[0]).epoch_anchor_ref).toBeNull();
    expect(diagnostics[0].operation_id).toBe(
      sealAddress(runId, drafts[0], null, "seal_diagnostic")
    );
    expect(productRef.operation_id).toBe(productForDraft(runId, drafts[1], null));
    expect(client.invocations[2]?.inputArtifacts).toContainEqual(diagnostics[0]);
    const reviewDirective = currentContext.selectedArtifacts.find(
      (ref) => ref.kind === "agent-output" && ref.phase === "verifying_specification"
    );
    if (reviewDirective === undefined) throw new Error("revision review is absent");
    expect(service.artifacts.metadata(reviewDirective).upstream_refs).toContainEqual(productRef);
    expect(service.artifacts.metadata(reviewDirective).upstream_refs).toContainEqual(priorRef);
  });

  it("maps partial and multi-question replies, carries exact refs through reframing, and stores only gate digests", async () => {
    const env = environment();
    const questions = ["Who accepts the result?", "Which region applies?"];
    const fixture = genericSpecificationFixture();
    const client = new ScriptedDefineClient([
      orientation("clarify", questions),
      orientation("clarify", questions),
      orientation("author"),
      Buffer.from(
        persistedSpecificationDraftV3(fixture.draft, fixture.request, [
          answeredDefinitionClaim(fixture.request, questions[0] ?? "missing"),
          {
            ...answeredDefinitionClaim(fixture.request, questions[1] ?? "missing"),
            support: [
              {
                support_slot: 1,
                locator: { kind: "json_pointer", pointer: "/answers/0/answer_text" },
              },
            ],
          },
        ])
      ).toString("utf8"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-v2-partial-${sequence}`;
    const first = await service.execute(start(runId));
    if (first.action !== "await_user") throw new Error("first gate absent");
    expect(first.questions).toHaveLength(2);
    const firstContext = service.checkpointer.loadRunById(runId);
    if (firstContext === undefined) throw new Error("first context absent");
    const requestRef = selectedRefs(firstContext, "definition-request")[0];
    const orientationRef = selectedRefs(firstContext, "agent-output")[0];
    const frameRef = selectedRefs(firstContext, "definition-frame")[0];
    const challengeRef = selectedRefs(firstContext, "definition-clarification-challenge")[0];
    if (
      requestRef === undefined ||
      orientationRef === undefined ||
      frameRef === undefined ||
      challengeRef === undefined
    )
      throw new Error("first V2 evidence absent");
    const frame = validateDefinitionFrameV2(
      readJson(service, frameRef.artifact_id),
      readJson(service, requestRef.artifact_id),
      requestRef,
      orientationRef
    );
    expect(frameRef.content_schema?.schema_id).toBe("penny.definition-frame.v2");
    const challenge = validateDefinitionClarificationChallenge(
      readJson(service, challengeRef.artifact_id),
      frame
    );
    expect(challenge.question_ids).toEqual(first.questions.map((q) => q.id));
    expect(first.payload_digest).toBe(challengeRef.content_digest);
    expect(first.challenge).toBe(challenge.challenge_id);
    await expect(
      service.execute({
        schema_version: 2,
        action: "respond",
        identity: start(runId).identity,
        gate_id: first.gate_id,
        challenge: first.challenge,
        response: "unstructured multi reply",
      })
    ).rejects.toThrow(/question-ID map/u);
    const firstQuestion = first.questions[0];
    const secondQuestion = first.questions[1];
    if (firstQuestion === undefined || secondQuestion === undefined)
      throw new Error("two questions absent");
    const privateAnswer = "PRIVATE_REGION_BODY_8e0d";
    const second = await service.execute({
      schema_version: 2,
      action: "respond",
      identity: start(runId).identity,
      gate_id: first.gate_id,
      challenge: first.challenge,
      response: { [firstQuestion.id]: privateAnswer },
    });
    if (second.action !== "await_user") throw new Error("partial gate did not reframe");
    expect(second.questions.map((q) => q.id)).toEqual([secondQuestion.id]);
    const partialContext = service.checkpointer.loadRunById(runId);
    if (partialContext === undefined) throw new Error("partial context absent");
    const responseRef = selectedRefs(partialContext, "definition-clarification-response")[0];
    if (responseRef === undefined) throw new Error("partial response absent");
    const mapped = validateDefinitionClarificationResponse({
      value: readJson(service, responseRef.artifact_id),
      challenge,
      challengeRef,
    });
    expect(mapped.answers).toEqual([
      { question_id: firstQuestion.id, disposition: "answered", answer_text: privateAnswer },
      { question_id: secondQuestion.id, disposition: "not_answered", answer_text: null },
    ]);
    expect(client.invocations[1]?.inputArtifacts).toContainEqual(responseRef);
    expect(client.invocations[1]?.task).not.toContain(privateAnswer);
    expect(JSON.stringify(partialContext.snapshot())).not.toContain(privateAnswer);
    expect(JSON.stringify(service.checkpointer.events(runId))).not.toContain(privateAnswer);
    const stateRoot = env.PENNY_STATE_ROOT;
    if (stateRoot === undefined) throw new Error("test state root absent");
    const [project] = readdirSync(path.join(stateRoot, "projects"));
    if (project === undefined) throw new Error("project partition absent");
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (sqlite === undefined) throw new Error("node:sqlite unavailable");
    using db = new sqlite.DatabaseSync(
      path.join(stateRoot, "projects", project, "orchestration", "orchestration.db"),
      { readOnly: true }
    );
    expect(
      db
        .prepare("SELECT response_json FROM gates WHERE run_id=? AND gate_id=?")
        .get(runId, first.gate_id)
    ).toEqual({ response_json: null });
    expect(
      JSON.stringify(db.prepare("SELECT payload_json FROM events WHERE run_id=?").all(runId))
    ).not.toContain(privateAnswer);
    expect(
      JSON.stringify(db.prepare("SELECT context_json FROM runs WHERE run_id=?").get(runId))
    ).not.toContain(privateAnswer);
    const last = await service.execute({
      schema_version: 2,
      action: "respond",
      identity: start(runId).identity,
      gate_id: second.gate_id,
      challenge: second.challenge,
      response: "PRIVATE_SECOND_93fa",
    });
    expect(last.action).toBe("complete");
    expect(client.invocations[2]?.inputArtifacts).toContainEqual(responseRef);
    const completed = service.checkpointer.loadRunById(runId);
    if (completed === undefined) throw new Error("completed context absent");
    const supportRefs = selectedRefs(completed, "definition-clarification-response");
    expect(supportRefs).toHaveLength(2);
    for (const reviewer of ["verifying_specification", "critiquing_specification"]) {
      const invocation = client.invocations.find((entry) => entry.stateId === reviewer);
      if (invocation === undefined) throw new Error(`${reviewer} invocation missing`);
      expect(invocation.inputArtifacts).toEqual(expect.arrayContaining(supportRefs));
    }
    for (const kind of ["validity", "quality"]) {
      const receiptRef = selectedRefs(completed, "review-receipt").find(
        (ref) => ref.branch_id === kind
      );
      if (receiptRef === undefined) throw new Error(`${kind} receipt missing`);
      const receipt = validateReviewReceiptV2(readJson(service, receiptRef.artifact_id));
      expect(receipt.subject.support_refs).toEqual(supportRefs);
      expect(service.artifacts.metadata(receipt.review_report_ref).upstream_refs).toEqual(
        expect.arrayContaining(supportRefs)
      );
    }
    const finalFrameRef = selectedRefs(completed, "definition-frame").at(-1);
    const finalOrientation = selectedRefs(completed, "agent-output")
      .filter((ref) => ref.phase === "framing_definition")
      .at(-1);
    if (finalFrameRef === undefined || finalOrientation === undefined)
      throw new Error("final frame absent");
    const finalFrame = validateDefinitionFrameV2(
      readJson(service, finalFrameRef.artifact_id),
      readJson(service, requestRef.artifact_id),
      requestRef,
      finalOrientation
    );
    expect(finalFrame.questions.map((q) => q.question_id)).toEqual(
      first.questions.map((q) => q.id)
    );
    const lastProposingOrientation = selectedRefs(partialContext, "agent-output")
      .filter((ref) => ref.phase === "framing_definition")
      .at(-1);
    expect(finalFrame.questions.map((q) => q.origin_ref)).toEqual([
      lastProposingOrientation,
      lastProposingOrientation,
    ]);
  });

  it("authors an honestly blocked product after a decline without re-challenging it", async () => {
    const questions = ["Who accepts the result?", "Which region applies?"];
    const fixture = genericSpecificationFixture();
    const declinedId = definitionQuestionId({
      requestId: fixture.request.request_id,
      owner: "caller",
      sourceItemIndex: null,
      question: questions[0] ?? "missing",
      material: true,
    });
    const answeredId = definitionQuestionId({
      requestId: fixture.request.request_id,
      owner: "caller",
      sourceItemIndex: null,
      question: questions[1] ?? "missing",
      material: true,
    });
    const blockedDraft = {
      ...fixture.draft,
      disposition: "blocked" as const,
      open_questions: [
        {
          question: questions[0] ?? "missing",
          owner: "caller" as const,
          blocking: true,
          source_item_indexes: [0],
        },
      ],
      planning_readiness_reason: "A material caller-owned question was explicitly declined.",
    };
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedDefineClient([
        orientation("clarify", questions),
        orientation("clarify", questions),
        Buffer.from(
          persistedSpecificationDraftV3(blockedDraft, fixture.request, [
            {
              target: { kind: "discovered_question", question_id: declinedId },
              status: "declined",
              claim: "The caller explicitly declined to answer this material question.",
              rationale: "The exact clarification response records the decline.",
              support: [],
            },
            {
              target: { kind: "discovered_question", question_id: answeredId },
              status: "resolved",
              claim: "The caller supplied the applicable region.",
              rationale: "The exact clarification response contains the answer.",
              support: [
                {
                  support_slot: 0,
                  locator: { kind: "json_pointer", pointer: "/answers/1/answer_text" },
                },
              ],
            },
          ])
        ).toString("utf8"),
        veraPass(),
        carrenApprove(),
      ]),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-v2-declined-${sequence}`;
    const gate = await service.execute(start(runId));
    if (gate.action !== "await_user") throw new Error("gate absent");
    const firstQuestion = gate.questions[0];
    const secondQuestion = gate.questions[1];
    if (firstQuestion === undefined || secondQuestion === undefined)
      throw new Error("two questions absent");
    const terminal = await service.execute({
      schema_version: 2,
      action: "respond",
      identity: start(runId).identity,
      gate_id: gate.gate_id,
      challenge: gate.challenge,
      response: { [firstQuestion.id]: null, [secondQuestion.id]: "Region A" },
    });
    if (terminal.action !== "complete")
      throw new Error(`declined blocked product ended ${canonicalJson(terminal)}`);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("decline context absent");
    const responseRef = selectedRefs(context, "definition-clarification-response")[0];
    if (responseRef === undefined) throw new Error("declined response absent");
    const row = readJson(service, responseRef.artifact_id);
    expect(JSON.stringify(row)).toContain('"disposition":"declined"');
    expect(selectedRefs(context, "definition-clarification-challenge")).toHaveLength(1);
  });

  it("requires a blocked product when reframing a declined material question straight to author", async () => {
    const questionText = "Which deployment window applies?";
    const fixture = genericSpecificationFixture();
    const questionId = definitionQuestionId({
      requestId: fixture.request.request_id,
      owner: "caller",
      sourceItemIndex: null,
      question: questionText,
      material: true,
    });
    const blockedDraft = {
      ...fixture.draft,
      disposition: "blocked" as const,
      open_questions: [
        {
          question: questionText,
          owner: "caller" as const,
          blocking: true,
          source_item_indexes: [0],
        },
      ],
      planning_readiness_reason: "The caller declined the material deployment-window question.",
    };
    const client = new ScriptedDefineClient([
      orientation("clarify", [questionText]),
      orientation("author", [questionText]),
      Buffer.from(
        persistedSpecificationDraftV3(blockedDraft, fixture.request, [
          {
            target: { kind: "discovered_question", question_id: questionId },
            status: "declined",
            claim: "The caller declined to choose a deployment window.",
            rationale: "The exact clarification response records the decline.",
            support: [],
          },
        ])
      ).toString("utf8"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-v2-declined-author-${sequence}`;
    const gate = await service.execute(start(runId));
    if (gate.action !== "await_user") throw new Error("gate absent");
    const question = gate.questions[0];
    if (question === undefined) throw new Error("question absent");
    const terminal = await service.execute({
      schema_version: 2,
      action: "respond",
      identity: start(runId).identity,
      gate_id: gate.gate_id,
      challenge: gate.challenge,
      response: { [question.id]: null },
    });
    if (terminal.action !== "complete")
      throw new Error(`declined author product ended ${canonicalJson(terminal)}`);
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "framing_definition",
      "framing_definition",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);
    const context = service.checkpointer.loadRun(start(runId).identity);
    const lastFrame = selectedRefs(context, "definition-frame").at(-1);
    const lastOrientation = selectedRefs(context, "agent-output")
      .filter((ref) => ref.phase === "framing_definition")
      .at(-1);
    const requestRef = selectedRefs(context, "definition-request")[0];
    if (lastFrame === undefined || lastOrientation === undefined || requestRef === undefined)
      throw new Error("reframed evidence absent");
    const frame = validateDefinitionFrameV2(
      readJson(service, lastFrame.artifact_id),
      readJson(service, requestRef.artifact_id),
      requestRef,
      lastOrientation
    );
    expect(frame.questions.map((q) => q.question_id)).toContain(question.id);
  });

  it("adopts the exact challenge after a pre-checkpoint crash before awaiting the caller", async () => {
    const env = environment();
    sequence += 1;
    const runId = `run-define-v2-challenge-restart-${sequence}`;
    let faulted = false;
    const registration = defineRegistrationWithHostFault((point) => {
      if (point === "definition_readiness_gate:challenge-persistence" && !faulted) {
        faulted = true;
        throw new Error("injected challenge crash");
      }
    });
    let orphan: ArtifactRef | undefined;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDefineClient([orientation("clarify")]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(/injected challenge crash/u);
      const before = first.checkpointer.loadRun(start(runId).identity);
      expect(before.stateId).toBe("definition_readiness_gate");
      expect(selectedRefs(before, "definition-clarification-challenge")).toHaveLength(0);
      const frame = selectedRefs(before, "definition-frame")[0];
      if (frame === undefined) throw new Error("frame absent at crash");
      const gateId = `definition-gate-${sha256(
        canonicalJson({
          run_id: runId,
          frame_ref: frame,
          gate_visit: before.stepCount,
        })
      )}`;
      const operationId = `definition-challenge:${sha256(canonicalJson({ run_id: runId, gate_id: gateId }))}`;
      orphan =
        first.artifacts.refFor(
          runId,
          "definition_readiness_gate",
          gateId,
          "definition-clarification-challenge",
          operationId,
          1
        ) ?? undefined;
      expect(orphan).toBeDefined();
    }
    using restarted = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedDefineClient([]),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    const gate = await restarted.execute({
      schema_version: 2,
      action: "recover",
      identity: start(runId).identity,
    });
    if (gate.action !== "await_user") throw new Error("challenge was not recovered");
    expect(gate.payload_digest).toBe(orphan?.content_digest);
    expect(
      selectedRefs(
        restarted.checkpointer.loadRun(start(runId).identity),
        "definition-clarification-challenge"
      )
    ).toEqual([orphan]);
    expect(
      restarted.artifacts.refFor(
        runId,
        "definition_readiness_gate",
        gate.gate_id,
        "definition-clarification-challenge",
        orphan?.operation_id ?? "missing",
        2
      )
    ).toBeNull();
  });

  it("adopts a pre-checkpoint response at its fixed identity and conflicts on changed bytes", async () => {
    const env = environment();
    sequence += 1;
    const runId = `run-define-v2-adoption-${sequence}`;
    let fail = true;
    const registration = defineRegistrationWithHostFault((point) => {
      if (point === "awaiting_clarification:response-persistence" && fail) {
        fail = false;
        throw new Error("injected response crash");
      }
    });
    let gateId = "";
    let challenge = "";
    let orphan: ArtifactRef | null = null;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDefineClient([orientation("clarify")]),
        playbookRegistration: registration,
      });
      const gate = await first.execute(start(runId));
      if (gate.action !== "await_user") throw new Error("gate absent");
      gateId = gate.gate_id;
      challenge = gate.challenge;
      await expect(
        first.execute({
          schema_version: 2,
          action: "respond",
          identity: start(runId).identity,
          gate_id: gateId,
          challenge,
          response: "PRIVATE_FIRST_42bf",
        })
      ).rejects.toThrow(/injected response crash/u);
      const operationId = `definition-response:${sha256(canonicalJson({ run_id: runId, gate_id: gateId }))}`;
      orphan = first.artifacts.refFor(
        runId,
        "awaiting_clarification",
        gateId,
        "definition-clarification-response",
        operationId,
        1
      );
      expect(orphan).not.toBeNull();
      expect(
        selectedRefs(
          first.checkpointer.loadRun(start(runId).identity),
          "definition-clarification-response"
        )
      ).toHaveLength(0);
    }
    using restarted = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedDefineClient([
        orientation("author"),
        Buffer.from(
          persistedSpecificationDraftV3(
            genericSpecificationFixture().draft,
            genericSpecificationFixture().request,
            [
              answeredDefinitionClaim(
                genericSpecificationFixture().request,
                "Which audience is authoritative for acceptance?"
              ),
            ]
          )
        ).toString("utf8"),
        veraPass(),
        carrenApprove(),
      ]),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    await expect(
      restarted.execute({
        schema_version: 2,
        action: "respond",
        identity: start(runId).identity,
        gate_id: gateId,
        challenge,
        response: "CHANGED_PRIVATE_19ee",
      })
    ).rejects.toThrow(/conflict/u);
    expect(
      await restarted.execute({
        schema_version: 2,
        action: "recover",
        identity: start(runId).identity,
      })
    ).toMatchObject({ action: "await_user", gate_id: gateId, challenge });
    const result = await restarted.execute({
      schema_version: 2,
      action: "respond",
      identity: start(runId).identity,
      gate_id: gateId,
      challenge,
      response: "PRIVATE_FIRST_42bf",
    });
    expect(result.action).toBe("complete");
    const context = restarted.checkpointer.loadRun(start(runId).identity);
    expect(selectedRefs(context, "definition-clarification-response")).toEqual([orphan]);
  });

  it("adopts an exactly repeated committed response after restart and rejects changed bytes", async () => {
    const env = environment();
    sequence += 1;
    const runId = `run-define-v2-response-retry-${sequence}`;
    let gateId = "";
    let challenge = "";
    {
      const fixture = genericSpecificationFixture();
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDefineClient([
          orientation("clarify"),
          orientation("author"),
          Buffer.from(
            persistedSpecificationDraftV3(fixture.draft, fixture.request, [
              answeredDefinitionClaim(
                fixture.request,
                "Which audience is authoritative for acceptance?"
              ),
            ])
          ).toString("utf8"),
          veraPass(),
          carrenApprove(),
        ]),
        playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
      });
      const gate = await first.execute(start(runId));
      if (gate.action !== "await_user") throw new Error("gate absent");
      gateId = gate.gate_id;
      challenge = gate.challenge;
      const terminal = await first.execute({
        schema_version: 2,
        action: "respond",
        identity: start(runId).identity,
        gate_id: gateId,
        challenge,
        response: "PRIVATE_COMMITTED_57ac",
      });
      expect(terminal.action).toBe("complete");
    }
    {
      using restarted = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDefineClient([]),
        playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
      });
      await expect(
        restarted.execute({
          schema_version: 2,
          action: "respond",
          identity: start(runId).identity,
          gate_id: gateId,
          challenge,
          response: "CHANGED_PRIVATE_31bf",
        })
      ).rejects.toThrow(/already answered differently/u);
      const replay = await restarted.execute({
        schema_version: 2,
        action: "respond",
        identity: start(runId).identity,
        gate_id: gateId,
        challenge,
        response: "PRIVATE_COMMITTED_57ac",
      });
      expect(replay.action).toBe("complete");
    }
    const stateRoot = env.PENNY_STATE_ROOT;
    if (stateRoot === undefined) throw new Error("state root absent");
    const [project] = readdirSync(path.join(stateRoot, "projects"));
    if (project === undefined) throw new Error("project partition absent");
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (sqlite === undefined) throw new Error("node:sqlite unavailable");
    using db = new sqlite.DatabaseSync(
      path.join(stateRoot, "projects", project, "orchestration", "orchestration.db")
    );
    expect(
      db
        .prepare(
          "DELETE FROM events WHERE run_id=? AND payload_json LIKE '%completion_admission_v1%'"
        )
        .run(runId).changes
    ).toBe(1);
    using corrupt = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedDefineClient([]),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    await expect(
      corrupt.execute({
        schema_version: 2,
        action: "respond",
        identity: start(runId).identity,
        gate_id: gateId,
        challenge,
        response: "PRIVATE_COMMITTED_57ac",
      })
    ).rejects.toThrow(/missing completion admission evidence/u);
    await expect(
      corrupt.execute({
        schema_version: 2,
        action: "cancel",
        identity: start(runId).identity,
        reason: "must not bypass corrupt completion proof",
      })
    ).rejects.toThrow(/missing completion admission evidence/u);
  });

  it("returns a durable clarification gate when caller-owned intent is ambiguous", async () => {
    const client = new ScriptedDefineClient([orientation("clarify")]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-clarify-${sequence}`;
    const directive = await service.execute(start(runId));
    expect(directive).toMatchObject({
      action: "await_user",
      state_id: "awaiting_clarification",
      questions: [{ prompt: "Which audience is authoritative for acceptance?" }],
    });
    if (directive.action !== "await_user") throw new Error("Define did not await clarification");
    expect(client.invocations.map((entry) => entry.stateId)).toEqual(["framing_definition"]);
    const durable = service.checkpointer.loadRunById(runId);
    expect(
      durable?.selectedArtifacts.some((artifact) => artifact.kind === "definition-frame")
    ).toBe(true);
    expect(durable?.selectedArtifacts.some((artifact) => artifact.kind === "specification")).toBe(
      false
    );
  });
  it("continues productive seal and review repair beyond the former imposed limits", async () => {
    const fixture = genericSpecificationFixture();
    const invalidDrafts: SpecificationDraftV1[] = [
      { ...fixture.draft, source_coverage: fixture.draft.source_coverage.slice(0, -1) },
      {
        ...fixture.draft,
        requirements: fixture.draft.requirements.map((entry, index) =>
          index === 0 ? { ...entry, objective_indexes: [63] } : entry
        ),
      },
      {
        ...fixture.draft,
        acceptance_criteria: fixture.draft.acceptance_criteria.map((entry, index) =>
          index === 0 ? { ...entry, requirement_indexes: [127] } : entry
        ),
      },
      {
        ...fixture.draft,
        supersession_intents: [
          {
            prior_item_id: `spec-requirement-${"a".repeat(64)}`,
            replacement: { kind: "requirement", index: 0 },
            reason: "Invalid prior revision for a create request.",
          },
        ],
      },
    ];
    const client = new ScriptedDefineClient([
      orientation("author"),
      ...invalidDrafts.map((value) =>
        Buffer.from(persistedSpecificationDraftV3(value)).toString("utf8")
      ),
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      ...Array.from({ length: 4 }, (_, index) => [
        defineReviewGap("vera", "product_gap"),
        Buffer.from(
          persistedSpecificationDraftV3({
            ...fixture.draft,
            requirements: fixture.draft.requirements.map((entry, i) =>
              i === 0
                ? { ...entry, statement: `${entry.statement} Candidate constraint ${index}.` }
                : entry
            ),
          })
        ).toString("utf8"),
      ]).flat(),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-define-productive-unlimited-${sequence}`;
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
      client.invocations.filter((invocation) => invocation.stateId === "authoring_specification")
    ).toHaveLength(9);
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: terminal.identity })
    ).toEqual(terminal);
  });
});
