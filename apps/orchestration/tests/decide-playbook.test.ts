import { explicitSealPolicy } from "./helpers/explicit-cycle-policy.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ArtifactRefSchema,
  DECIDE_PLAYBOOK_REGISTRATION,
  DECIDE_PLAYBOOK_NAME,
  DecidePlaybook,
  OrchestrationService,
  canonicalJson,
  validateContract,
  sha256,
  trustedInvocationDigest,
  parsePersistedDecisionDraft,
  initializePennyState,
  validateEvidenceAdmission,
  validateDecision,
  validateDecisionProductEnvelope,
  validateDecisionRequest,
  validateDecisionProductIntegrity,
  validateReviewReceipt,
  type AgentCompletion,
  type AgentInvocation,
  type Directive,
  type InputArtifacts,
  type JsonValue,
  type ModelClient,
  type PlaybookRegistration,
} from "../dist/index.js";
import {
  decisionDraft,
  decisionRequest,
  persistedDecisionDraft,
} from "./fixtures/decision-fixtures.js";
import { decideCurrentSealDiagnosticRef } from "../dist/playbooks/decide.js";
import { persistEvidenceContext } from "./helpers/evidence-context.js";

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

function start(runId: string, playbook = DECIDE_PLAYBOOK_NAME, inputArtifacts?: InputArtifacts) {
  const request = decisionRequest();
  const { decision_question: goal, ...constraints } = request;
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId, playbook),
    goal,
    constraints,
    ...(inputArtifacts === undefined ? {} : { input_artifacts: inputArtifacts }),
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}

class ScriptedDecideClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  onInvocation?: () => void;
  private next = 0;

  constructor(private readonly outputs: readonly string[]) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    this.onInvocation?.();
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

async function reachState(
  service: OrchestrationService,
  runId: string,
  target: string,
  inputArtifacts?: InputArtifacts
): Promise<Directive> {
  let next = service.engine.handle(start(runId, DECIDE_PLAYBOOK_NAME, inputArtifacts));
  while (next.action === "invoke_agent" && next.state_id !== target) {
    const [result] = await service.workers.execute(next);
    if (result === undefined) throw new Error("worker result absent");
    next = service.engine.handle({
      schema_version: 2,
      action: "step",
      identity: identity(runId),
      result,
    });
  }
  if (next.action !== "invoke_agent" || next.state_id !== target)
    throw new Error(`expected ${target}`);
  return next;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("orchestrated decide workflow", () => {
  it("passes the reviewed product and both reports to evidence repair without promoting them to proof", async () => {
    const client = new ScriptedDecideClient([
      analysisPass(),
      persistedDecisionDraft("selected"),
      veraPass(),
      carrenGap("evidence_gap"),
      analysisEvidenceGap(),
      evidencePacket(),
      persistedDecisionDraft("ranked"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-decide-evidence-repair-${sequence}`;
    const terminal = completeDirective(await service.execute(start(runId)));
    expect(outputRef(terminal)).toMatchObject({ version: 1 });
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_decision",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
      "analyzing_decision",
      "gathering_decision_evidence",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
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
    const products = context.selectedArtifacts.filter(
      (ref) => ref.phase === "sealing_decision" && ref.kind === "semantic-core"
    );
    expect(products).toHaveLength(2);
    expect(products.map((ref) => ref.version)).toEqual([1, 1]);
    expect(new Set(products.map((ref) => ref.artifact_id)).size).toBe(2);
    expect(new Set(products.map((ref) => ref.operation_id)).size).toBe(2);
    for (const ref of products) {
      expect(
        service.artifacts.refFor(
          runId,
          "sealing_decision",
          null,
          "semantic-core",
          ref.operation_id,
          1
        )
      ).toEqual(ref);
    }
    const [firstProduct, finalProduct] = products;
    if (firstProduct === undefined || finalProduct === undefined)
      throw new Error("repaired products are absent");
    expect(outputRef(terminal).artifact_id).toBe(finalProduct.artifact_id);
    const veraReport = find("verifying_decision", "agent-output", 1);
    const carrenReport = find("critiquing_decision", "agent-output", 1);
    for (const index of [4, 5, 6]) {
      const invocation = client.invocations[index];
      if (invocation === undefined) throw new Error(`missing repair invocation ${index}`);
      expect(invocation.inputArtifacts).toEqual(
        expect.arrayContaining([firstProduct, veraReport, carrenReport])
      );
      expect(invocation.inputArtifacts.filter((ref) => ref.kind === "semantic-core")).toEqual([
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
    expect(validateReviewReceipt(readJson(service, quality.artifact_id))).toMatchObject({
      subject: { product_ref: { artifact_id: finalProduct.artifact_id } },
      prior_review_receipt_ref: { artifact_id: validity.artifact_id },
    });
  });

  it("carries the exact reviewed product and both historical reports through alternating Carren and Vera gaps", async () => {
    const client = new ScriptedDecideClient([
      analysisPass(),
      persistedDecisionDraft("selected"),
      veraPass(),
      carrenGap("analysis_gap"),
      analysisPass("Replacement analysis addresses the quality gap."),
      persistedDecisionDraft("ranked"),
      veraGap("product_gap"),
      persistedDecisionDraft("unresolved"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-decide-alternating-repair-${sequence}`;
    // Input slots are stable exact-ID addresses; the first create has no local product.
    const productSlots: string[][] = [];
    client.onInvocation = () => {
      const pending = service.checkpointer.loadRunById(runId)?.pendingDirective;
      if (pending?.action !== "invoke_agent") throw new Error("pending invocation is absent");
      productSlots.push(
        pending.input_artifacts.artifacts
          .filter((entry) => entry.ref.kind === "semantic-core")
          .map((entry) => `${entry.slot}:${entry.ref.artifact_id}`)
      );
    };

    const terminal = completeDirective(await service.execute(start(runId)));
    const finalRef = outputRef(terminal);
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_decision",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
      "analyzing_decision",
      "deciding",
      "verifying_decision",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
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
    const products = context.selectedArtifacts.filter(
      (ref) => ref.phase === "sealing_decision" && ref.kind === "semantic-core"
    );
    expect(products).toHaveLength(3);
    expect(products.map((ref) => ref.version)).toEqual([1, 1, 1]);
    expect(new Set(products.map((ref) => ref.artifact_id)).size).toBe(3);
    expect(new Set(products.map((ref) => ref.operation_id)).size).toBe(3);
    for (const ref of products) {
      expect(
        service.artifacts.refFor(
          runId,
          "sealing_decision",
          null,
          "semantic-core",
          ref.operation_id,
          1
        )
      ).toEqual(ref);
    }
    const veraReports = [1, 2, 3].map((version) =>
      at("verifying_decision", "agent-output", version)
    );
    const carrenReports = [1, 2].map((version) =>
      at("critiquing_decision", "agent-output", version)
    );
    expect(finalRef).toMatchObject({ artifact_id: products[2]?.artifact_id, version: 1 });
    const inputIds = (index: number) =>
      client.invocations[index]?.inputArtifacts.map((ref) => ref.artifact_id);
    const expectInput = (
      index: number,
      productOrder: number,
      veraVersion: number,
      carrenVersion: number
    ) => {
      const invocation = client.invocations[index];
      if (invocation === undefined) throw new Error(`invocation ${index} is absent`);
      const productRef = products[productOrder - 1];
      const veraRef = veraReports[veraVersion - 1];
      const carrenRef = carrenReports[carrenVersion - 1];
      if (productRef === undefined || veraRef === undefined || carrenRef === undefined) {
        throw new Error("exact repair inputs are absent");
      }
      const ids = invocation.inputArtifacts.map((ref) => ref.artifact_id);
      expect(ids).toEqual(
        expect.arrayContaining([productRef.artifact_id, veraRef.artifact_id, carrenRef.artifact_id])
      );
      expect(invocation.inputArtifacts.filter((ref) => ref.kind === "semantic-core")).toEqual([
        productRef,
      ]);
      expect(
        invocation.inputArtifacts.filter(
          (ref) => ref.phase === "verifying_decision" && ref.kind === "agent-output"
        )
      ).toEqual([veraRef]);
      expect(
        invocation.inputArtifacts.filter(
          (ref) => ref.phase === "critiquing_decision" && ref.kind === "agent-output"
        )
      ).toEqual([carrenRef]);
    };
    expect(
      client.invocations[1]?.inputArtifacts.filter((ref) => ref.kind === "semantic-core")
    ).toEqual([]);
    expect(inputIds(1)).not.toContain(products[0]?.artifact_id);
    expect(productSlots[1]).toEqual([]);
    expect(productSlots[5]).toEqual([`latest-decision:${products[0]?.artifact_id}`]);
    expect(productSlots[7]).toEqual([`latest-decision:${products[1]?.artifact_id}`]);
    // Framing/analysis and each author see the sealed subject, not just its draft.
    expectInput(4, 1, 1, 1);
    expectInput(5, 1, 1, 1);
    expectInput(6, 2, 1, 1);
    expectInput(7, 2, 2, 1);
    expectInput(8, 3, 2, 1);
    expectInput(9, 3, 3, 1);
    expect(client.invocations[7]?.task).toContain("historical feedback, never approval");
    // Final PASS/APPROVE and host receipts bind the third sealed product, never a prior review.
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
    expect(validateReviewReceipt(readJson(service, validity.artifact_id))).toMatchObject({
      verdict: "PASS",
      subject: { product_ref: { artifact_id: products[2]?.artifact_id } },
    });
    expect(validateReviewReceipt(readJson(service, quality.artifact_id))).toMatchObject({
      verdict: "APPROVE",
      subject: { product_ref: { artifact_id: products[2]?.artifact_id } },
      prior_review_receipt_ref: { artifact_id: validity.artifact_id },
    });
    const integrity = context.selectedArtifacts.find(
      (ref) => ref.kind === "decision-product-integrity"
    );
    const envelope = context.selectedArtifacts.find(
      (ref) => ref.kind === "decision-product-envelope"
    );
    if (integrity === undefined || envelope === undefined)
      throw new Error("current completion graph is absent");
    expect(
      validateDecisionProductIntegrity(readJson(service, integrity.artifact_id))
    ).toMatchObject({
      status: "PASS",
      decision_ref: { artifact_id: products[2]?.artifact_id },
      vera_report_ref: { artifact_id: finalVeraReport.artifact_id },
      carren_report_ref: { artifact_id: finalCarrenReport.artifact_id },
      validity_receipt_ref: { artifact_id: validity.artifact_id },
      quality_receipt_ref: { artifact_id: quality.artifact_id },
    });
    expect(validateDecisionProductEnvelope(readJson(service, envelope.artifact_id))).toMatchObject({
      status: "complete",
      decision_ref: { artifact_id: products[2]?.artifact_id },
      integrity_ref: { artifact_id: integrity.artifact_id },
    });
    expect(service.checkpointer.completionAdmission(runId)).toBeDefined();
  });

  it.each(["selected", "ranked", "no_feasible_option", "unresolved", "not_applicable"] as const)(
    "completes a reviewed canonical %s DecisionV2 and exact product envelope",
    async (outcome) => {
      const env = environment();
      const client = new ScriptedDecideClient(happyOutputs(outcome));
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
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

  it("preserves one EvidenceContext ref without flattening the native request, decision, or task prose", async () => {
    sequence += 1;
    const runId = `run-decide-evidence-context-${sequence}`;
    const client = new ScriptedDecideClient([
      analysisEvidenceGap(),
      evidencePacket(),
      persistedDecisionDraft("unresolved"),
      veraPass(),
      carrenApprove(true),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    const evidenceContext = persistEvidenceContext(service.artifacts, "decide-playbook");
    const terminal = completeDirective(
      await service.execute(
        start(runId, DECIDE_PLAYBOOK_NAME, {
          schema_version: 2,
          artifacts: [{ slot: "evidence_context", ref: evidenceContext.ref }],
        })
      )
    );
    const run = service.checkpointer.loadRunById(runId);
    if (run === undefined) throw new Error("completed Decide run is absent");
    const requestRef = run.selectedArtifacts.find(
      (artifact) => artifact.kind === "decision-request" && artifact.phase === "intake"
    );
    if (requestRef === undefined) throw new Error("admitted DecisionRequestV1 ref is absent");
    const nativeRequest = validateDecisionRequest(readJson(service, requestRef.artifact_id));
    expect(nativeRequest).toEqual(decisionRequest());
    expect(service.artifacts.metadata(requestRef).upstream_refs).toEqual([evidenceContext.ref]);

    const terminalRef = outputRef(terminal);
    const productRef = terminal.artifacts.find(
      (artifact) => artifact.artifact_id === String(terminalRef.artifact_id)
    );
    if (productRef === undefined) throw new Error("terminal DecisionV2 ref is absent");
    const decision = validateDecision(readJson(service, productRef.artifact_id));
    expect(decision.request).toEqual(nativeRequest);
    expect(decision.source_lineage.input_artifact_ids).toEqual([evidenceContext.ref.artifact_id]);
    expect(
      service.artifacts
        .metadata(productRef)
        .upstream_refs.filter(
          (artifact) => artifact.artifact_id === evidenceContext.ref.artifact_id
        )
    ).toEqual([evidenceContext.ref]);

    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_decision",
      "gathering_decision_evidence",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
    ]);
    for (const invocation of client.invocations) {
      expect(
        invocation.inputArtifacts.filter(
          (artifact) => artifact.artifact_id === evidenceContext.ref.artifact_id
        )
      ).toEqual([evidenceContext.ref]);
      expect(invocation.task).not.toContain(evidenceContext.statementMarker);
    }
    const admissionRef = terminal.artifacts.find(
      (artifact) => artifact.kind === "evidence-admission"
    );
    if (admissionRef === undefined) throw new Error("Decision EvidenceAdmissionV1 ref is absent");
    const admission = validateEvidenceAdmission(readJson(service, admissionRef.artifact_id));
    expect(admission.domain).toBe("decision");
    expect(admission.source_artifact_ref.artifact_id).not.toBe(evidenceContext.ref.artifact_id);
  });

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
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
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
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
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

  it("routes Vera product_gap to Demetri, reseals a distinct product, and re-verifies before Carren", async () => {
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
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
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
    expect(outputRef(terminal)).toMatchObject({ version: 1 });
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
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
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
    expect(outputRef(terminal)).toMatchObject({ version: 1 });
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
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-decide-major-approve-${sequence}`));
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_decision",
      "deciding",
      "verifying_decision",
      "critiquing_decision",
    ]);
    expect(
      client.invocations.some((invocation) => invocation.executionPurpose === "routing_repair")
    ).toBe(false);
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
      playbookRegistration: explicitSealPolicy(DECIDE_PLAYBOOK_REGISTRATION, 1),
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

  it("offers a new correction only after a same-run sealed product, not from old feedback", async () => {
    const client = new ScriptedDecideClient([
      analysisPass(),
      persistedDecisionDraft("selected").replace("DECISION_CORE:", "BROKEN_CORE:"),
      persistedDecisionDraft("selected"),
      veraGap("product_gap"),
      persistedDecisionDraft("selected").replace("DECISION_CORE:", "BROKEN_CORE:"),
      persistedDecisionDraft("ranked"),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-decide-epoch-${sequence}`;
    const terminal = completeDirective(await service.execute(start(runId)));
    expect(outputRef(terminal)).toMatchObject({ kind: "semantic-core", version: 1 });
    const authors = client.invocations.filter((entry) => entry.stateId === "deciding");
    expect(authors).toHaveLength(4);
    expect(authors[1]?.inputArtifacts.filter((ref) => ref.kind === "seal-diagnostic")).toHaveLength(
      1
    );
    expect(authors[2]?.inputArtifacts.filter((ref) => ref.kind === "seal-diagnostic")).toHaveLength(
      0
    );
    expect(authors[3]?.inputArtifacts.filter((ref) => ref.kind === "seal-diagnostic")).toHaveLength(
      1
    );
    const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts;
    if (selected === undefined) throw new Error("run checkpoint absent");
    const diagnostics = selected.filter((ref) => ref.kind === "seal-diagnostic");
    expect(diagnostics).toHaveLength(2);
    const first: unknown = readJson(service, diagnostics[0]?.artifact_id ?? "missing");
    const second: unknown = readJson(service, diagnostics[1]?.artifact_id ?? "missing");
    expect(first).toMatchObject({
      rejection_ordinal: 1,
      epoch_anchor_ref: null,
      corrections_used: 0,
    });
    expect(second).toMatchObject({
      rejection_ordinal: 1,
      corrections_used: 0,
      epoch_anchor_ref: selected.find((ref) => ref.kind === "semantic-core" && ref.version === 1),
    });
    const snapshot = service.checkpointer.loadRunById(runId);
    if (snapshot === undefined) throw new Error("run checkpoint absent");
    const imported = selected.find((ref) => ref.kind === "semantic-core" && ref.version === 1);
    if (imported === undefined) throw new Error("first product absent");
    snapshot.selectedArtifacts.push({ ...imported, run_id: "foreign-run", version: 100 });
    const secondDiagnostic = diagnostics[1];
    if (secondDiagnostic === undefined) throw new Error("second diagnostic absent");
    snapshot.selectedArtifacts.push({ ...secondDiagnostic, run_id: "foreign-run", version: 101 });
    expect(decideCurrentSealDiagnosticRef(snapshot)).toBeUndefined();
    expect(client.invocations.map((entry) => entry.stateId).slice(-3)).toEqual([
      "deciding",
      "verifying_decision",
      "critiquing_decision",
    ]);
  });

  it("persists the final rejection and labels its exact draft, not an accepted product", async () => {
    const client = new ScriptedDecideClient([
      analysisPass(),
      persistedDecisionDraft("selected").replace("DECISION_CORE:", "BROKEN_CORE:"),
      persistedDecisionDraft("selected").replace("DECISION_CORE:", "BROKEN_CORE:"),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: explicitSealPolicy(DECIDE_PLAYBOOK_REGISTRATION, 1),
    });
    sequence += 1;
    const runId = `run-decide-final-seal-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("negative terminal absent");
    expect(terminal.result).toMatchObject({
      met: false,
      output_artifact_label: "rejected draft (not a sealed product)",
      seal_diagnostics: { corrections_used: 1, correction_limit: 1, disposition: "exhausted" },
    });
    const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts;
    if (selected === undefined) throw new Error("run checkpoint absent");
    const diagnostics = selected.filter((ref) => ref.kind === "seal-diagnostic");
    expect(diagnostics).toHaveLength(2);
    const last = diagnostics[1];
    if (last === undefined) throw new Error("final seal diagnostic absent");
    expect(readJson(service, last.artifact_id)).toMatchObject({
      rejected_draft_ref: terminal.result.output_artifact_ref,
      previous_diagnostic_ref: diagnostics[0],
      rejection_ordinal: 2,
    });
    expect(terminal.result.seal_diagnostics).toMatchObject({ latest_diagnostic_ref: last });
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("run checkpoint absent");
    // Wrong-run feedback with a higher version cannot consume this epoch's allowance.
    context.selectedArtifacts.push({ ...last, run_id: "foreign-run", version: 100 });
    expect(decideCurrentSealDiagnosticRef(context)).toEqual(last);
  });

  it("adopts an interrupted first diagnostic before dispatching its only correction", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistration = {
      ...DECIDE_PLAYBOOK_REGISTRATION,
      construct: (options) =>
        new DecidePlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === "sealing_decision:feedback-persistence") {
              interrupted = true;
              throw new Error("injected diagnostic interruption");
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-decide-diagnostic-recover-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDecideClient([
          analysisPass(),
          persistedDecisionDraft("selected").replace("DECISION_CORE:", "BROKEN_CORE:"),
        ]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(
        /injected diagnostic interruption/u
      );
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_decision");
    }
    const client = new ScriptedDecideClient([
      persistedDecisionDraft("selected"),
      veraPass(),
      carrenApprove(),
    ]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    const terminal = completeDirective(
      await recovered.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      })
    );
    expect(outputRef(terminal)).toMatchObject({ kind: "semantic-core", version: 1 });
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "deciding",
      "verifying_decision",
      "critiquing_decision",
    ]);
    expect(
      recovered.checkpointer
        .loadRunById(runId)
        ?.selectedArtifacts.filter((ref) => ref.kind === "seal-diagnostic")
    ).toHaveLength(1);
  });

  it("recovers after host sealing persistence and continues the review graph", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistration = {
      ...DECIDE_PLAYBOOK_REGISTRATION,
      construct: (options) =>
        new DecidePlaybook(
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
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
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
      persistedDraftValue({ ...decisionDraft(), rationale_report: `Changed rationale 1.` }),
      veraGap("product_gap"),
      persistedDraftValue({ ...decisionDraft(), rationale_report: `Changed rationale 2.` }),
      veraGap("product_gap"),
      persistedDraftValue({ ...decisionDraft(), rationale_report: `Changed rationale 3.` }),
      veraGap("product_gap"),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: { ...env, PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" },
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
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
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
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
    const registration: PlaybookRegistration = {
      ...DECIDE_PLAYBOOK_REGISTRATION,
      construct: (options) =>
        new DecidePlaybook(
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
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
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
    const routes = DECIDE_PLAYBOOK_REGISTRATION.contract.repair_routing.routes;
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

  it("fails closed for active drift and exactly replays a historical terminal", async () => {
    const env = environment();
    sequence += 1;
    let activeIdentity: Directive["identity"];
    let terminal: TerminalDirective;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDecideClient(happyOutputs("selected")),
        playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
      });
      const active = service.handle(start(`run-decide-active-contract-binding-${sequence}`));
      expect(active.action).toBe("invoke_agent");
      activeIdentity = active.identity;
      terminal = completeDirective(
        await service.execute(start(`run-decide-terminal-contract-binding-${sequence}`))
      );
    }
    const worker = DECIDE_PLAYBOOK_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
    const deciding = worker.phases.get("deciding");
    if (deciding === undefined) throw new Error("deciding registration phase is absent");
    const drifted: PlaybookRegistration = {
      ...DECIDE_PLAYBOOK_REGISTRATION,
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
    for (const action of ["status", "recover"] as const) {
      expect(
        await replay.execute({ schema_version: 2, action, identity: activeIdentity })
      ).toMatchObject({
        action: "error",
        result: { code: "REGISTRATION_CONTRACT_MISMATCH", checkpoint_unchanged: true },
      });
      expect(
        await replay.execute({ schema_version: 2, action, identity: terminal.identity })
      ).toEqual(terminal);
    }
  });

  it("refuses in-process mutation of the registration snapshot after start", () => {
    const worker = DECIDE_PLAYBOOK_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
    const phases = new Map(worker.phases);
    const mutableRegistration: PlaybookRegistration = {
      ...DECIDE_PLAYBOOK_REGISTRATION,
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

  it("cancels without dispatch and reports honest no-execution state", () => {
    const env = environment();
    const client = new ScriptedDecideClient([]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
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
      reason: "caller stopped deciding",
    });
    expect(cancelled).toMatchObject({
      action: "cancelled",
      met: false,
      result: { execution_started: false, execution_authorized: false },
    });
    expect(DECIDE_PLAYBOOK_REGISTRATION.contract.behavior.stopping).toEqual({
      budget_exhaustion: "incomplete",
      cancellation: "cancelled",
      blocking_ambiguity: "incomplete",
    });
    expect(canonicalJson(DECIDE_PLAYBOOK_REGISTRATION.contract)).not.toMatch(
      /await_user|awaiting_user/iu
    );
    expect(client.invocations).toHaveLength(0);
  });
  it("continues productive seal and review repair beyond the former imposed limits", async () => {
    const client = new ScriptedDecideClient([
      analysisPass(),
      ...Array.from(
        { length: 4 },
        (_value, index) =>
          `Correction ${index}\n` +
          persistedDecisionDraft("selected").replace(
            /(?:ASSESSMENT_DRAFT|DIAGNOSIS_CORE|DECISION_CORE|STRATEGY_CORE|PRODUCED_ARTIFACT_DRAFT):/u,
            "BROKEN_CORE:"
          )
      ),
      persistedDecisionDraft("selected"),
      ...Array.from({ length: 4 }, (_value, index) => [
        veraGap("product_gap"),
        persistedDraftValue({
          ...decisionDraft(),
          rationale_report: `Changed rationale ${index}.`,
        }),
      ]).flat(),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-decide-productive-unlimited-${sequence}`;
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
      client.invocations.filter((invocation) => invocation.stateId === "deciding")
    ).toHaveLength(9);
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: terminal.identity })
    ).toEqual(terminal);
  });
  it.each(["NORMAL", "VALID_INCONCLUSIVE"])(
    "keeps UNVERIFIABLE distinct from a valid product (%s) and recovers durably",
    async (variant) => {
      const env = environment();
      const runId = `run-decide-unverifiable-${++sequence}`;
      const report = summary({
        verdict: "UNVERIFIABLE",
        gap_kind: "verification_incomplete",
        repair_owner: "none",
        findings: ["Available evidence cannot establish this claim."],
        evidence: ["The admitted basis does not supply an independent observation."],
        strategy_delta:
          "Retain the product and report; do not reauthor for a verification limitation.",
      });
      let terminal: Directive;
      {
        const client = new ScriptedDecideClient([
          analysisPass(),
          variant === "NORMAL"
            ? persistedDecisionDraft("selected")
            : persistedDecisionDraft("unresolved"),
          report,
        ]);
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          modelClient: client,
          playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
        });
        terminal = await service.execute(start(runId));
        expect(terminal).toMatchObject({
          action: "incomplete",
          met: false,
          result: {
            incomplete_reason: "verification_incomplete",
            verification_findings: ["Available evidence cannot establish this claim."],
            evidence_limitations: [
              "The admitted basis does not supply an independent observation.",
            ],
          },
        });
        if (terminal.action !== "incomplete") throw new Error("negative terminal absent");
        expect(
          terminal.artifacts.some(
            (ref) => ref.phase === "verifying_decision" && ref.kind === "agent-output"
          )
        ).toBe(true);
        expect(terminal.result.best_partial_artifact_refs).toHaveLength(1);
        const context = service.checkpointer.loadRunById(runId);
        if (context === undefined) throw new Error("durable run absent");
        expect(context.selectedArtifacts.some((ref) => ref.kind === "review-receipt")).toBe(false);
        expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
        expect(client.invocations.map((entry) => entry.stateId)).toEqual([
          "analyzing_decision",
          "deciding",
          "verifying_decision",
        ]);
      }
      const client = new ScriptedDecideClient([]);
      using recovered = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
      });
      expect(
        await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      expect(client.invocations).toHaveLength(0);
      expect(recovered.checkpointer.completionAdmission(runId)).toBeUndefined();
    }
  );

  it.each(["verifying_decision", "critiquing_decision"])(
    "preserves the complete structured source judgment through routing-only repair at %s",
    async (state) => {
      const source = state === "verifying_decision" ? veraPass() : carrenApprove();
      const client = new ScriptedDecideClient([
        analysisPass(),
        persistedDecisionDraft("selected"),
        ...(state === "critiquing_decision" ? [veraPass()] : []),
        source,
        routingOnly(source),
        ...(state === "verifying_decision" ? [carrenApprove()] : []),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
      });
      const runId = `run-decide-preserved-${++sequence}`;
      const pending = await reachState(service, runId, state);
      const [captured] = await service.workers.execute(pending);
      if (captured === undefined) throw new Error("captured result absent");
      const repair = service.engine.handle({
        schema_version: 2,
        action: "step",
        identity: identity(runId),
        result: { ...captured, details: {} },
      });
      expect(repair).toMatchObject({ action: "invoke_agent", execution_purpose: "routing_repair" });
      const terminal = completeDirective(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      );
      expect(terminal.met).toBe(true);
      const receipt = terminal.artifacts.find(
        (ref) =>
          ref.kind === "review-receipt" &&
          ref.branch_id === (state === "verifying_decision" ? "validity" : "quality")
      );
      if (receipt === undefined) throw new Error("positive receipt absent");
      expect(
        validateReviewReceipt(readJson(service, receipt.artifact_id)).review_report_ref
      ).toEqual(captured.output_artifact);
      expect(
        service.artifacts.readById(captured.output_artifact.artifact_id).toString("utf8")
      ).toBe(source);
    }
  );

  it.each([
    ["verifying_decision", "verdict"],
    ["verifying_decision", "unverifiable"],
    ["verifying_decision", "evidence"],
    ["verifying_decision", "confidence"],
    ["critiquing_decision", "verdict"],
    ["critiquing_decision", "evidence"],
    ["critiquing_decision", "strategy_delta"],
  ])("refuses source judgment mutation at %s (%s)", async (state, field) => {
    const source =
      field === "unverifiable"
        ? summary({
            verdict: "UNVERIFIABLE",
            gap_kind: "verification_incomplete",
            repair_owner: "none",
            findings: ["Verification evidence unavailable."],
            evidence: ["No independent observation."],
            strategy_delta: "Preserve limitations, not an author repair.",
          })
        : state === "verifying_decision"
          ? veraGap("product_gap")
          : carrenGap("product_gap");
    let replacement =
      field === "verdict"
        ? state === "verifying_decision"
          ? veraPass()
          : carrenApprove()
        : source;
    if (field === "unverifiable") replacement = veraGap("product_gap");
    if (field === "evidence")
      replacement = replacement
        .replace("Exact latest product check failed.", "Different check.")
        .replace("The exact latest product has a material quality defect.", "Different check.");
    if (field === "confidence")
      replacement = replacement.replace('"confidence":"PROBABLE"', '"confidence":"CERTAIN"');
    if (field === "strategy_delta")
      replacement = replacement.replace(
        "before another complete review cycle.",
        "with a different plan."
      );
    const client = new ScriptedDecideClient([
      analysisPass(),
      persistedDecisionDraft("selected"),
      ...(state === "critiquing_decision" ? [veraPass()] : []),
      source,
      routingOnly(replacement),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    const runId = `run-decide-mutation-${++sequence}`;
    const pending = await reachState(service, runId, state);
    const [captured] = await service.workers.execute(pending);
    if (captured === undefined) throw new Error("captured result absent");
    service.engine.handle({
      schema_version: 2,
      action: "step",
      identity: identity(runId),
      result: { ...captured, details: {} },
    });
    const terminal = await service.execute({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(client.invocations.at(-1)?.executionPurpose).toBe("routing_repair");
    expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
    expect(
      service.checkpointer
        .events(runId)
        .some((event) => event.eventType === "routing_repair_accepted")
    ).toBe(false);
  });

  it("binds native mechanical evidence to the current product and signed verifier task only", async () => {
    const client = new ScriptedDecideClient([
      analysisPass(),
      persistedDecisionDraft("selected"),
      veraGap("product_gap"),
      persistedDraftValue({ ...decisionDraft(), rationale_report: `Changed rationale fixture.` }),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    const runId = `run-decide-mechanics-${++sequence}`;
    const first = await reachState(service, runId, "verifying_decision");
    if (first.action !== "invoke_agent") throw new Error("verifier absent");
    const [checked] = await service.workers.execute(first);
    if (checked === undefined) throw new Error("signed verifier result absent");
    expect(checked.worker_receipt.trusted_invocation_digest).toBe(
      trustedInvocationDigest({
        identity: first.identity,
        state_id: first.state_id,
        branch_id: null,
        agent: first.agent,
        attempt: first.attempt,
        trust_profile: first.trust_profile,
        model_override: first.model_override ?? null,
        task_sha256: sha256(first.task),
        input_artifacts: first.input_artifacts,
        output_artifact: first.output_artifact,
      })
    );
    service.engine.handle({
      schema_version: 2,
      action: "step",
      identity: identity(runId),
      result: checked,
    });
    const terminal = completeDirective(
      await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    const reviews = client.invocations.filter((entry) => entry.stateId === "verifying_decision");
    expect(reviews).toHaveLength(2);
    const statements: string[] = [];
    for (const invocation of reviews) {
      const line = invocation.task
        .split("\n")
        .find((entry) => entry.startsWith("HOST_MECHANICAL_CHECKS:"));
      if (line === undefined) throw new Error("mechanical evidence absent");
      const product = invocation.inputArtifacts.find(
        (ref) => ref.phase === "sealing_decision" && ref.kind === "semantic-core"
      );
      const draftRef = invocation.inputArtifacts.find((ref) => ref.kind === "decision-draft");
      if (product === undefined || draftRef === undefined)
        throw new Error("mechanical inputs absent");
      expect(line).toContain(`"product_ref":${canonicalJson(product)}`);
      expect(line).toContain('"scope":"host_mechanical_only_not_semantic_or_effect_absence"');
      expect(line).toContain('"source_refs":');
      for (const ref of invocation.inputArtifacts.filter((ref) =>
        ["decision-request", "decision-draft", "evidence-admission"].includes(ref.kind)
      ))
        expect(line).toContain(canonicalJson(ref));
      const requestRef = invocation.inputArtifacts.find((ref) => ref.kind === "decision-request");
      if (requestRef === undefined) throw new Error("request absent");
      const parsed = parsePersistedDecisionDraft(service.artifacts.readById(draftRef.artifact_id), {
        request: readJson(service, requestRef.artifact_id),
        exactInputArtifactIds: [],
      });
      const parsedDigest = sha256(canonicalJson(parsed.draft));
      expect(line).toContain(
        canonicalJson({ kind: "canonical_parsed_decision_draft", sha256: parsedDigest })
      );
      expect(parsedDigest).not.toBe(draftRef.content_digest);
      statements.push(line);
    }
    expect(statements[0]).not.toBe(statements[1]);
    expect(
      client.invocations
        .filter((entry) => entry.stateId !== "verifying_decision")
        .every(
          (entry) =>
            !entry.task.split("\n").some((line) => line.startsWith("HOST_MECHANICAL_CHECKS:"))
        )
    ).toBe(true);
    expect(terminal.met).toBe(true);
  });

  it.each([false, true])(
    "fails mechanical validation closed before verifier dispatch (recovery=%s)",
    async (recovery) => {
      const env = environment();
      const runId = `run-decide-mechanical-failure-${++sequence}`;
      let invalid = false;
      const client = new ScriptedDecideClient([analysisPass(), persistedDecisionDraft("selected")]);
      const registration: PlaybookRegistration = {
        ...DECIDE_PLAYBOOK_REGISTRATION,
        construct: (options) => {
          const store = options.artifactStore;
          if (store === undefined) throw new Error("host store absent");
          const read = store.readById.bind(store);
          vi.spyOn(store, "readById").mockImplementation((id) => {
            const bytes = read(id);
            return invalid && store.refById(id)?.kind === "semantic-core"
              ? Buffer.concat([bytes, Buffer.from(" ")])
              : bytes;
          });
          return new DecidePlaybook(
            options.artifactRevisions,
            store,
            options.checkpointer,
            (point) => {
              if (!recovery && point === "sealing_decision:artifact-persistence") invalid = true;
            }
          );
        },
      };
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: registration,
      });
      let terminal: Directive;
      if (recovery) {
        await reachState(service, runId, "verifying_decision");
        invalid = true;
        terminal = await service.execute({
          schema_version: 2,
          action: "recover",
          identity: identity(runId),
        });
      } else terminal = await service.execute(start(runId));
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: { incomplete_reason: "host_mechanical_validation_failed" },
      });
      expect(client.invocations.map((entry) => entry.stateId)).toEqual([
        "analyzing_decision",
        "deciding",
      ]);
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      invalid = false;
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
    }
  );

  it.each(["verifying_decision", "critiquing_decision"])(
    "stalls the exact parsed candidate and repeated failed checks at %s across restart",
    async (reviewer) => {
      const env = environment();
      const runId = `run-decide-stall-${++sequence}`;
      const gap =
        reviewer === "verifying_decision" ? veraGap("product_gap") : carrenGap("product_gap");
      {
        const client = new ScriptedDecideClient([
          analysisPass(),
          persistedDecisionDraft("selected"),
          ...(reviewer === "critiquing_decision" ? [veraPass()] : []),
          gap,
        ]);
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          modelClient: client,
          playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
        });
        const pending = await reachState(service, runId, reviewer);
        const [result] = await service.workers.execute(pending);
        if (result === undefined) throw new Error("first failed check absent");
        expect(
          service.engine.handle({
            schema_version: 2,
            action: "step",
            identity: identity(runId),
            result,
          })
        ).toMatchObject({ action: "invoke_agent", state_id: "deciding" });
      }
      // New bytes, new raw digest and product identities do not make a new semantic candidate.
      const same = persistedDecisionDraft("selected").replace("CORE:{", "CORE:{ ");
      const repeated = gap
        .replace("preserve exact lineage.", "use a different strategy.")
        .replace("before another complete review cycle.", "using a different strategy.");
      const client = new ScriptedDecideClient([
        same,
        ...(reviewer === "critiquing_decision" ? [veraPass()] : []),
        repeated,
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
      });
      const terminal = await service.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: {
          incomplete_reason: "repair_stalled",
          stalled: true,
          repair_stall: {
            origin_state: reviewer,
            feedback_kind: "product_gap",
          },
        },
      });
      if (terminal.action !== "incomplete") throw new Error("stall terminal absent");
      const stall = terminal.result.repair_stall;
      if (stall === null || typeof stall !== "object" || Array.isArray(stall))
        throw new Error("stall diagnostics absent");
      expect(stall.feedback_report_refs).toHaveLength(1);
      expect(client.invocations.filter((entry) => entry.stateId === "deciding")).toHaveLength(1);
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("stall checkpoint absent");
      expect(context.iteration).toBe(1);
      expect(context.maxIterations).toBeNull();
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      const calls = client.invocations.length;
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      expect(client.invocations).toHaveLength(calls);
    }
  );

  it.each(["verifying_decision", "critiquing_decision"])(
    "continues changed candidates but detects A/B/A recurrence at %s",
    async (reviewer) => {
      for (const recurrence of [false, true]) {
        const gap =
          reviewer === "verifying_decision" ? veraGap("product_gap") : carrenGap("product_gap");
        const a = persistedDecisionDraft("selected");
        const b = persistedDraftValue({
          ...decisionDraft(),
          rationale_report: `Changed rationale fixture.`,
        });
        const cycle = (candidate: string, failed: boolean) => [
          candidate,
          ...(reviewer === "critiquing_decision"
            ? [veraPass(), failed ? gap : carrenApprove()]
            : [failed ? gap : veraPass(), ...(failed ? [] : [carrenApprove()])]),
        ];
        const client = new ScriptedDecideClient([
          analysisPass(),
          ...cycle(a, true),
          ...cycle(b, true),
          ...cycle(a, recurrence),
        ]);
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env: environment(),
          modelClient: client,
          playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
        });
        const terminal = await service.execute(start(`run-decide-recurrence-${++sequence}`));
        expect(terminal.action).toBe(recurrence ? "incomplete" : "complete");
        if (recurrence)
          expect(terminal).toMatchObject({ result: { incomplete_reason: "repair_stalled" } });
        expect(client.invocations.filter((entry) => entry.stateId === "deciding")).toHaveLength(3);
      }
    }
  );

  it.each([
    "intact",
    "changed",
    "missing",
    "duplicate",
    "conflicting_duplicate",
    "indented_duplicate",
    "incomplete_line",
  ])(
    "recovers frozen contextual verifier evidence across restart or refuses %s evidence",
    async (mode) => {
      const env = environment();
      const runId = `run-decide-context-mechanical-${++sequence}`;
      let original: Extract<Directive, { action: "invoke_agent" }>;
      {
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          modelClient: new ScriptedDecideClient([
            analysisPass(),
            persistedDecisionDraft("selected"),
            veraPass(),
            carrenApprove(),
            analysisPass(),
            persistedDecisionDraft("selected"),
          ]),
          playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
        });
        // Context is an actually completed, reviewed native product, not a forged fixture ref.
        const producer = completeDirective(await service.execute(start(`${runId}-producer`)));
        const contextRef = validateContract(
          ArtifactRefSchema,
          producer.result.output_artifact_ref,
          "accepted context"
        );
        const pending = await reachState(service, runId, "verifying_decision", {
          schema_version: 2,
          artifacts: [{ slot: "restart-context", designation: "context", ref: contextRef }],
        });
        if (pending.action !== "invoke_agent")
          throw new Error("pending contextual verifier absent");
        original = structuredClone(pending);
        const statement = pending.task
          .split("\n")
          .find((line) => line.startsWith("HOST_MECHANICAL_CHECKS:"));
        if (statement === undefined) throw new Error("mechanical statement absent");
        expect(pending.task.indexOf("NONBINDING exact contextual artifacts")).toBeGreaterThan(
          pending.task.indexOf(statement)
        );
        expect(pending.task.endsWith(statement)).toBe(false);
        expect(pending.input_artifacts.artifacts).toContainEqual({
          slot: "restart-context",
          designation: "context",
          ref: contextRef,
        });
        if (mode !== "intact") {
          const context = service.checkpointer.loadRunById(runId);
          if (context?.pendingDirective?.action !== "invoke_agent")
            throw new Error("checkpoint absent");
          const task = original.task;
          context.pendingDirective.task =
            mode === "changed"
              ? task.replace(
                  statement,
                  statement.replace('"schema_version":1', '"schema_version":2')
                )
              : mode === "missing"
                ? task.replace(statement, "")
                : mode === "duplicate"
                  ? `${task}\n${statement}`
                  : mode === "conflicting_duplicate"
                    ? `${task.replace(statement, "HOST_MECHANICAL_CHECKS:{}")}\n${statement}`
                    : mode === "indented_duplicate"
                      ? `${task}\n ${statement}`
                      : task.replace(statement, `${statement} trailing bytes`);
          service.checkpointer.saveRun(context, "fixture_frozen_task_tampered", {});
        }
      }
      const client = new ScriptedDecideClient([veraPass(), carrenApprove()]);
      using recovered = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
      });
      const next = recovered.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      if (mode === "intact") {
        if (next.action !== "invoke_agent") throw new Error("contextual recovery refused");
        expect(next.task).toBe(original.task);
        expect(next.input_artifacts).toEqual(original.input_artifacts);
        const saved = recovered.checkpointer.loadRunById(runId);
        expect(saved?.pendingDirective).toEqual(next);
        completeDirective(
          await recovered.execute({
            schema_version: 2,
            action: "recover",
            identity: identity(runId),
          })
        );
        expect(client.invocations[0]?.task).toBe(original.task);
        expect(recovered.checkpointer.completionAdmission(runId)).toBeDefined();
      } else {
        expect(next).toMatchObject({
          action: "incomplete",
          met: false,
          result: { incomplete_reason: "host_mechanical_validation_failed" },
        });
        expect(client.invocations).toHaveLength(0);
        expect(recovered.checkpointer.completionAdmission(runId)).toBeUndefined();
        expect(
          recovered.engine.handle({
            schema_version: 2,
            action: "recover",
            identity: identity(runId),
          })
        ).toEqual(next);
      }
    }
  );

  it.each([
    ["verifying_decision", "analysis_gap"],
    ["critiquing_decision", "analysis_gap"],
    ["verifying_decision", "evidence_gap"],
    ["critiquing_decision", "evidence_gap"],
  ] as const)(
    "measures changed upstream content then identical replacement recurrence at %s/%s across restart",
    async (reviewer, kind) => {
      const env = environment();
      const runId = `run-decide-upstream-${++sequence}`;
      const gap = reviewer === "verifying_decision" ? veraGap(kind) : carrenGap(kind);
      // Only substantive report prose changes. Routing fields, draft and failed checks stay exact.
      const reports = (changed: boolean) =>
        kind === "analysis_gap"
          ? [
              analysisPass().replace(
                "Report body.",
                changed
                  ? "Option B now has an independently supported cost."
                  : "Option B cost is only an assumption."
              ),
            ]
          : [
              analysisEvidenceGap(),
              evidencePacket().replace(
                "Report body.",
                changed
                  ? "A second source establishes the missing fact."
                  : "The first source does not establish the missing fact."
              ),
            ];
      const cycle = (changed: boolean) => [
        ...reports(changed),
        persistedDecisionDraft("selected"),
        ...(reviewer === "critiquing_decision" ? [veraPass()] : []),
        gap,
      ];
      {
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          modelClient: new ScriptedDecideClient(cycle(false)),
          playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
        });
        const pending = await reachState(service, runId, reviewer);
        const [result] = await service.workers.execute(pending);
        if (result === undefined) throw new Error("first failed review absent");
        expect(
          service.engine.handle({
            schema_version: 2,
            action: "step",
            identity: identity(runId),
            result,
          })
        ).toMatchObject({ action: "invoke_agent", state_id: "analyzing_decision" });
      }
      const client = new ScriptedDecideClient([...cycle(true), ...cycle(true)]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
      });
      let pending = service.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      while (pending.action === "invoke_agent" && pending.state_id !== reviewer) {
        const [result] = await service.workers.execute(pending);
        if (result === undefined) throw new Error("repair result absent");
        pending = service.engine.handle({
          schema_version: 2,
          action: "step",
          identity: identity(runId),
          result,
        });
      }
      if (pending.action !== "invoke_agent" || pending.state_id !== reviewer)
        throw new Error("second review absent");
      const [result] = await service.workers.execute(pending);
      if (result === undefined) throw new Error("second failed review absent");
      expect(
        service.engine.handle({
          schema_version: 2,
          action: "step",
          identity: identity(runId),
          result,
        })
      ).toMatchObject({ action: "invoke_agent", state_id: "analyzing_decision" });
      const beforeRecurrence = service.checkpointer.loadRunById(runId);
      if (beforeRecurrence === undefined) throw new Error("repair checkpoint absent");
      const usedBeforeRecurrence = beforeRecurrence.iteration;
      const terminal = await service.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: {
          incomplete_reason: "repair_stalled",
          repair_stall: { origin_state: reviewer, feedback_kind: kind },
        },
      });
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("stall checkpoint absent");
      // Evidence-gap routing itself has a registered charge; the repeated reviewer has none.
      expect(context.iteration).toBe(usedBeforeRecurrence + (kind === "evidence_gap" ? 1 : 0));
      const operandState =
        kind === "analysis_gap" ? "analyzing_decision" : "gathering_decision_evidence";
      const operands = context.selectedArtifacts.filter(
        (ref) => ref.phase === operandState && ref.kind === "agent-output"
      );
      expect(operands).toHaveLength(3);
      const drafts = context.selectedArtifacts.filter((ref) => ref.kind === "decision-draft");
      expect(drafts).toHaveLength(3);
      expect(new Set(drafts.map((ref) => ref.content_digest)).size).toBe(1);
      const reviews = context.selectedArtifacts.filter(
        (ref) => ref.phase === reviewer && ref.kind === "agent-output"
      );
      expect(reviews).toHaveLength(3);
      expect(new Set(reviews.map((ref) => ref.content_digest)).size).toBe(1);
      const [first, changed, replacement] = operands;
      if (first === undefined || changed === undefined || replacement === undefined)
        throw new Error("upstream operands absent");
      expect(changed.artifact_id).not.toBe(first.artifact_id);
      expect(changed.content_digest).not.toBe(first.content_digest);
      expect(replacement.artifact_id).not.toBe(changed.artifact_id);
      expect(replacement.content_digest).toBe(changed.content_digest);
      for (const operand of [changed, replacement]) {
        const review = client.invocations.find(
          (entry) =>
            entry.stateId === reviewer &&
            entry.inputArtifacts.some((ref) => ref.artifact_id === operand.artifact_id)
        );
        if (review === undefined)
          throw new Error("review did not receive its exact changed/replacement operand");
      }
      expect(client.invocations.filter((entry) => entry.stateId === "deciding")).toHaveLength(2);
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      const calls = client.invocations.length;
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      expect(client.invocations).toHaveLength(calls);
    }
  );

  it("declines recurrence measurement when upstream semantic content cannot be verified", async () => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedDecideClient([analysisPass(), persistedDecisionDraft("selected")]),
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    const runId = `run-decide-unmeasurable-${++sequence}`;
    await reachState(service, runId, "verifying_decision");
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("review checkpoint absent");
    const playbook = new DecidePlaybook(service.artifacts, service.artifacts, service.checkpointer);
    const details = {
      verdict: "FAIL",
      gap_kind: "analysis_gap",
      repair_owner: "annie",
      findings: ["Unchanged finding."],
      evidence: ["Same check."],
      strategy_delta: "Try again.",
    };
    expect(playbook.repairProgressFingerprint(context, "verifying_decision", details)).toMatch(
      /^[a-f0-9]{64}$/u
    );
    const read = service.artifacts.readById.bind(service.artifacts);
    vi.spyOn(service.artifacts, "readById").mockImplementation((id) =>
      service.artifacts.refById(id)?.phase === "analyzing_decision"
        ? Buffer.from("Unavailable source content.")
        : read(id)
    );
    expect(playbook.repairProgressFingerprint(context, "verifying_decision", details)).toBeNull();
    expect(
      new DecidePlaybook().repairProgressFingerprint(context, "verifying_decision", details)
    ).toBeNull();
  });

  it("recomputes the identical pending mechanical statement across a fresh owner restart", async () => {
    const env = environment();
    const runId = `run-decide-mechanical-restart-${++sequence}`;
    let originalTask: string;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedDecideClient([analysisPass(), persistedDecisionDraft("selected")]),
        playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
      });
      const pending = await reachState(service, runId, "verifying_decision");
      if (pending.action !== "invoke_agent") throw new Error("pending verifier absent");
      originalTask = pending.task;
    }
    const client = new ScriptedDecideClient([veraPass(), carrenApprove()]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    completeDirective(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    const invocation = client.invocations[0];
    if (invocation === undefined) throw new Error("recovered verifier absent");
    expect(invocation.task).toBe(originalTask);
    expect(invocation.task).toContain("HOST_MECHANICAL_CHECKS:");
  });

  it("refuses mechanically inconsistent exact draft/product lineage without author repair", async () => {
    const client = new ScriptedDecideClient([analysisPass(), persistedDecisionDraft("selected")]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: DECIDE_PLAYBOOK_REGISTRATION,
    });
    const runId = `run-decide-lineage-failure-${++sequence}`;
    const pending = await reachState(service, runId, "verifying_decision");
    const context = service.checkpointer.loadRunById(runId);
    if (pending.action !== "invoke_agent" || context === undefined)
      throw new Error("pending review absent");
    const draftRef = pending.input_artifacts.artifacts.find(
      (entry) => entry.ref.kind === "decision-draft"
    )?.ref;
    if (draftRef === undefined) throw new Error("draft absent");
    const metadata = service.artifacts.metadata(draftRef);
    if (metadata.schema_version !== 2) throw new Error("expected current draft metadata");
    const replacement = service.artifacts.persist({
      metadata: { ...metadata, version: metadata.version + 1, parent_ref: draftRef },
      content: persistedDraftValue({
        ...decisionDraft(),
        rationale_report: "Changed source rationale.",
      }),
    });
    context.selectedArtifacts.push(replacement);
    service.checkpointer.saveRun(context, "fixture_divergent_draft_selected", {});
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
    expect(client.invocations).toHaveLength(2);
    expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
  });
  it("keeps verification inability closed and separate from repair-owned failures", () => {
    const worker = DECIDE_PLAYBOOK_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("catalog worker absent");
    const phase = worker.phases.get("verifying_decision");
    if (phase === undefined) throw new Error("verification schema absent");
    const details = {
      verdict: "UNVERIFIABLE",
      gap_kind: "verification_incomplete",
      repair_owner: "none",
      findings: ["Verification capability unavailable."],
      evidence: ["No independent observation."],
      strategy_delta: "Retain limitations without author repair.",
    };
    expect(validateContract(phase.schema, details, "verification inability")).toEqual(details);
    for (const invalid of [
      { ...details, verdict: "PASS" },
      { ...details, verdict: "FAIL" },
      { ...details, gap_kind: "product_gap" },
      { ...details, repair_owner: "echo" },
      { ...details, findings: [] },
      { ...details, evidence: [] },
      { ...details, invented: true },
    ])
      expect(() =>
        validateContract(phase.schema, invalid, "invalid verification inability")
      ).toThrow();
  });
});
