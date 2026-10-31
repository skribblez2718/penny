import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFINE_PLAYBOOK_REGISTRATION,
  DefinePlaybook,
  OrchestrationService,
  RunContext,
  canonicalJson,
  sha256,
  defineRequestConstraints,
  definitionQuestionId,
  evaluateDefineLatestReviewedSpecificationDod,
  initializePennyState,
  validateDefinitionTraceV1,
  validateReviewReceiptV2,
  validateSpecificationProductIntegrityV2,
  validateSpecificationProductEnvelopeV2,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
} from "../dist/index.js";
import {
  genericSpecificationFixture,
  persistedSpecificationDraftV3,
} from "./fixtures/define-fixtures.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-define-stage3-"));
  roots.push(root);
  const env = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_ENABLED: "false",
    PI_OBSERVABILITY_AUTO_START: "false",
  };
  initializePennyState(projectRoot, { env });
  return env;
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
const orientation = (route: "author" | "evidence" = "author") =>
  `Framed from the request.\nSUMMARY:${canonicalJson({
    confidence: "CERTAIN",
    orientation_complete: true,
    gap_kind: "none",
    repair_owner: "none",
    selected_profile_id: "generic",
    profile_selection_basis: "Caller requested generic.",
    route,
    route_reason: "The route follows the outstanding question.",
    clarification_questions: [],
    evidence_questions: route === "evidence" ? ["Which exact standard applies?"] : [],
    findings: [],
    specification_delta: "Preserve all caller boundaries.",
  })}`;
const pass = `Specification is valid.\nSUMMARY:${canonicalJson({
  confidence: "CERTAIN",
  verdict: "PASS",
  gap_kind: "none",
  repair_owner: "none",
  findings: [],
  evidence: ["Exact source, support and product were checked."],
  specification_delta: "No change required.",
})}`;
const approve = `Specification is usable.\nSUMMARY:${canonicalJson({
  confidence: "CERTAIN",
  verdict: "APPROVE",
  gap_kind: "none",
  repair_owner: "none",
  findings: [],
  evidence: ["Latest valid specification is coherent."],
  specification_delta: "No revision required.",
})}`;
const echo = `Evidence is unavailable.\nSUMMARY:${canonicalJson({
  confidence: "POSSIBLE",
  evidence_complete: false,
  findings: [],
  unresolved: ["No exact answer is established."],
})}`;
function blockedDraft(): Uint8Array {
  const fixture = genericSpecificationFixture();
  const question = "Which exact standard applies?";
  return persistedSpecificationDraftV3(
    {
      ...fixture.draft,
      disposition: "blocked",
      planning_readiness_reason: "A material evidence question remains open.",
      open_questions: [{ question, owner: "evidence", blocking: true, source_item_indexes: [0] }],
    },
    fixture.request,
    [
      {
        target: {
          kind: "discovered_question",
          question_id: definitionQuestionId({
            requestId: fixture.request.request_id,
            question,
            owner: "evidence",
            sourceItemIndex: null,
            material: true,
          }),
        },
        status: "pending",
        claim: "Evidence did not resolve this question.",
        rationale: "The admitted Echo output reports the gap.",
        support: [],
      },
    ]
  );
}
function readyOutputs(): string[] {
  return [
    orientation(),
    Buffer.from(persistedSpecificationDraftV3(genericSpecificationFixture().draft)).toString(
      "utf8"
    ),
    pass,
    approve,
  ];
}
function completionInput(service: OrchestrationService, runId: string) {
  const context = service.checkpointer.loadRunById(runId);
  if (context === undefined || context.terminalDirective?.action !== "complete")
    throw new Error("positive Define run missing");
  const terminal = context.terminalDirective;
  const product = terminal.artifacts.find((ref) => ref.kind === "specification");
  if (product === undefined) throw new Error("product missing");
  return {
    checkpointer: service.checkpointer,
    context,
    terminal,
    originState: "admitting_specification",
    latestProduct: {
      selector: "terminal_artifact" as const,
      schema_id: "penny.specification.v1",
      product_schema_version: 1,
      product_id: product.artifact_id,
      sha256: product.content_digest,
    },
    artifactReader: service.artifacts,
    projectRoot,
  };
}

describe("active trace-bound Define review and completion", () => {
  it("admits a reviewed ready product only with exact V2 receipts, integrity, envelope and trace", async () => {
    using service = new OrchestrationService({
      projectRoot,
      env: environment(),
      modelClient: new Client(readyOutputs()),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    const runId = "define-stage3-ready";
    const terminal = await service.execute(start(runId));
    if (terminal.action !== "complete") throw new Error("Define did not complete");
    const input = completionInput(service, runId);
    expect(service.checkpointer.completionAdmission(runId)).toBeDefined();
    expect(evaluateDefineLatestReviewedSpecificationDod(input).passed).toBe(true);
    const ref = (kind: string, branchId: string | null = null) => {
      const found = terminal.artifacts.find(
        (row) => row.kind === kind && row.branch_id === branchId
      );
      if (found === undefined) throw new Error(`${kind} missing`);
      return found;
    };
    const trace = ref("definition-trace", "trace");
    const product = ref("specification");
    expect(
      validateDefinitionTraceV1(
        JSON.parse(service.artifacts.readById(trace.artifact_id).toString("utf8"))
      ).product_ref
    ).toEqual(product);
    for (const kind of ["validity", "quality"]) {
      const receipt = validateReviewReceiptV2(
        JSON.parse(
          service.artifacts.readById(ref("review-receipt", kind).artifact_id).toString("utf8")
        )
      );
      expect(receipt.subject.trace_ref).toEqual(trace);
      expect(service.artifacts.metadata(receipt.review_report_ref).upstream_refs).toContainEqual(
        trace
      );
    }
    const integrity = validateSpecificationProductIntegrityV2(
      JSON.parse(
        service.artifacts
          .readById(ref("specification-product-integrity", "integrity").artifact_id)
          .toString("utf8")
      )
    );
    const envelope = validateSpecificationProductEnvelopeV2(
      JSON.parse(
        service.artifacts
          .readById(ref("specification-product-envelope").artifact_id)
          .toString("utf8")
      )
    );
    expect(integrity.trace_ref).toEqual(trace);
    expect(envelope.trace_ref).toEqual(trace);
    expect(envelope.integrity_ref).toEqual(ref("specification-product-integrity", "integrity"));
    const selected = [...input.context.selectedArtifacts];
    const reviewer = new DefinePlaybook(undefined, service.artifacts, service.checkpointer);
    input.context.stateId = "verifying_specification";
    input.context.selectedArtifacts = selected.filter((row) => row.kind !== "definition-trace");
    expect(reviewer.dispatch(RunContext.fromSnapshot(input.context.snapshot()))).toMatchObject({
      action: "incomplete",
      met: false,
      result: { incomplete_reason: "host_mechanical_check_failed" },
    });
    expect(evaluateDefineLatestReviewedSpecificationDod(input).passed).toBe(false);
    input.context.selectedArtifacts = selected.map((row) =>
      row.kind === "definition-trace" ? { ...row, content_digest: "f".repeat(64) } : row
    );
    input.context.stateId = "verifying_specification";
    expect(reviewer.dispatch(RunContext.fromSnapshot(input.context.snapshot()))).toMatchObject({
      action: "incomplete",
      met: false,
      result: { incomplete_reason: "host_mechanical_check_failed" },
    });
    expect(evaluateDefineLatestReviewedSpecificationDod(input).passed).toBe(false);
    input.context.selectedArtifacts = selected;
    input.context.stateId = "complete";
    expect(
      evaluateDefineLatestReviewedSpecificationDod({
        ...input,
        terminal: {
          ...input.terminal,
          artifacts: input.terminal.artifacts.filter((row) => row.kind !== "definition-trace"),
        },
      }).passed
    ).toBe(false);
  });

  it("completes a reviewed blocked specification without turning an unsupported question into ready", async () => {
    const client = new Client([
      orientation("evidence"),
      echo,
      Buffer.from(blockedDraft()).toString("utf8"),
      pass,
      approve,
    ]);
    using service = new OrchestrationService({
      projectRoot,
      env: environment(),
      modelClient: client,
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    const runId = "define-stage3-blocked";
    const terminal = await service.execute(start(runId));
    if (terminal.action !== "complete") throw new Error("Define did not complete");
    const input = completionInput(service, runId);
    const product = terminal.artifacts.find((ref) => ref.kind === "specification");
    const traceRef = terminal.artifacts.find((ref) => ref.kind === "definition-trace");
    if (product === undefined || traceRef === undefined) throw new Error("blocked graph missing");
    const specification: unknown = JSON.parse(
      service.artifacts.readById(product.artifact_id).toString("utf8")
    );
    expect(specification).toMatchObject({
      disposition: "blocked",
      planning_handoff: { planning_ready: false },
    });
    const trace = validateDefinitionTraceV1(
      JSON.parse(service.artifacts.readById(traceRef.artifact_id).toString("utf8"))
    );
    expect(trace.readiness.blocking_question_ids).toHaveLength(1);
    expect(trace.question_resolutions[0]?.status).toBe("pending");
    expect(evaluateDefineLatestReviewedSpecificationDod(input).passed).toBe(true);
  });

  it("recovers after a V2 receipt write without replacing it or skipping the review order", async () => {
    const vars = environment();
    const runId = "define-stage3-recovery";
    let fault = true;
    const registration = {
      ...DEFINE_PLAYBOOK_REGISTRATION,
      construct: (options: Parameters<typeof DEFINE_PLAYBOOK_REGISTRATION.construct>[0]) =>
        new DefinePlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (point === "verifying_specification:receipt-persistence" && fault) {
              fault = false;
              throw new Error("receipt crash");
            }
          }
        ),
    };
    using first = new OrchestrationService({
      projectRoot,
      env: vars,
      modelClient: new Client(readyOutputs()),
      playbookRegistration: registration,
    });
    await expect(first.execute(start(runId))).rejects.toThrow("receipt crash");
    const before = first.checkpointer.loadRunById(runId);
    expect(before?.selectedArtifacts.some((ref) => ref.kind === "review-receipt")).toBe(false);
    const receipt = first.artifacts.refFor(
      runId,
      "verifying_specification",
      "validity",
      "review-receipt",
      `define-review-receipt-validity:${sha256(runId).slice(0, 32)}`,
      1
    );
    if (receipt === null) throw new Error("orphan validity receipt missing");
    expect(
      validateReviewReceiptV2(
        JSON.parse(first.artifacts.readById(receipt.artifact_id).toString("utf8"))
      ).review_kind
    ).toBe("validity");
    using recovered = new OrchestrationService({
      projectRoot,
      env: vars,
      modelClient: new Client([approve]),
      playbookRegistration: DEFINE_PLAYBOOK_REGISTRATION,
    });
    expect(
      (
        await recovered.execute({
          schema_version: 2,
          action: "recover",
          identity: start(runId).identity,
        })
      ).action
    ).toBe("complete");
    const context = recovered.checkpointer.loadRunById(runId);
    expect(
      context?.selectedArtifacts.filter(
        (ref) => ref.kind === "review-receipt" && ref.branch_id === "validity"
      )
    ).toEqual([receipt]);
    expect(
      evaluateDefineLatestReviewedSpecificationDod(completionInput(recovered, runId)).passed
    ).toBe(true);
  });
});
