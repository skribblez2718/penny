import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { Checkpointer, canonicalJson, sha256 } from "../dist/checkpointer.js";
import { sealOperationId } from "../dist/playbooks/seal-attempt.js";
import {
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
  validateRegistrationContract,
} from "../dist/playbooks/registry.js";
import { sealPolicySha256 } from "../dist/skill-contracts/sealing.js";
import {
  validateContract,
  type Directive,
  type InputArtifacts,
  type JsonValue,
  type RunIdentity,
} from "../dist/contracts.js";
import { OrchestrationEngine } from "../dist/engine.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../dist/model-client.js";
import {
  ResearchContextOwnerV2,
  type ResearchContextProviderHandlersV2,
} from "../dist/research-context.js";
import type { OrdinaryHostFaultV1 } from "../dist/playbooks/registry.js";
import {
  ResearchHostInterruptionError,
  ResearchPlaybook,
  evaluateResearchLatestCoreDod,
  renderResearchCompatibility,
  researchSummarySchema,
} from "../dist/playbooks/research.js";
import {
  researchSemanticDraftPromptContract,
  validateCanonicalGroundedSynthesisBytes,
  validateResearchRequest,
  validateSemanticCoreRef,
} from "../dist/skill-contracts/research.js";
import {
  OrchestrationRunner,
  WorkerExecutor,
  parsePersistedRoutingSummary,
} from "../dist/worker.js";
import { requireRecord } from "./helpers/narrowing.js";
import { persistEvidenceContext } from "./helpers/evidence-context.js";
import { researchSemanticDraftFixture } from "./helpers/research-semantic-draft.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p3-product-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function compatibilityDirectory(root: string): string {
  return path.join(
    root,
    "research",
    `what-does-p3-activate-${sha256("What does P3 activate?").slice(0, 8)}`
  );
}

function runCompatibilityDirectory(root: string, runId: string): string {
  return path.join(compatibilityDirectory(root), `run-${sha256(runId)}`);
}

function identity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: "session-p3-product",
    playbook: "research",
    engine_owner: "typescript",
  };
}

function start(
  root: string,
  runId: string,
  mode: "quick" | "standard" | "deep",
  inputArtifacts?: InputArtifacts
) {
  return {
    schema_version: 2,
    action: "start",
    identity: identity(runId),
    goal: "What does P3 activate?",
    constraints: { mode },
    ...(inputArtifacts === undefined ? {} : { input_artifacts: inputArtifacts }),
    project_root: root,
    trust_profile: "trusted-interactive",
  };
}

function buildDraft(
  invocation: AgentInvocation,
  artifacts: ArtifactStore,
  options: ProductClientOptions
) {
  return researchSemanticDraftFixture(invocation, artifacts, {
    title: "P3 activated research",
    executiveSummary: "The semantic core is authoritative and renders are derived.",
    claimStatement:
      options.claimStatement ??
      (options.omissionOracle === undefined
        ? "P3 activates a semantic-core product."
        : "All widgets are red."),
    sectionHeading: "Activation",
    sectionBody: "The sealed core precedes Vera, optional Carren, and deterministic rendering.",
    ...(options.qualified === undefined ? {} : { qualified: options.qualified }),
    ...(options.blocking === undefined ? {} : { blocking: options.blocking }),
    ...(options.absentExcerpt === undefined ? {} : { absentExcerpt: options.absentExcerpt }),
    ...(options.citedSlots === undefined ? {} : { citedSlots: options.citedSlots }),
  });
}

interface ProductClientOptions {
  readonly claimStatement?: string;
  readonly validationFailures?: readonly ("evidence" | "synthesis")[];
  readonly planWidth?: number;
  readonly citedSlots?: readonly number[];
  readonly repairCitedSlots?: readonly number[];
  readonly omissionOracle?: "validating" | "critiquing_report";
  readonly synthesisRouting?: "incomplete" | "clarification" | "uncertain";
  readonly qualityFailures?: number;
  readonly sealFailures?: number;
  readonly sealFailureAtCalls?: readonly number[];
  readonly qualified?: boolean;
  readonly blocking?: boolean;
  readonly emptySynthesis?: boolean;
  readonly absentExcerpt?: boolean;
  readonly verificationOutcome?:
    | "unverifiable"
    | "clarification"
    | "uncertain"
    | "missing_judgment";
  readonly changedCandidate?: boolean;
  readonly repeatEvidence?: boolean;
  readonly draftFramingNoise?: boolean;
  readonly routingMutation?: "verdict" | "finding" | "evidence" | "confidence" | "clarification";
}

class ProductClient implements ModelClient {
  readonly states: string[] = [];
  readonly invocations: AgentInvocation[] = [];
  readonly synthesisTasks: string[] = [];
  private validationCalls = 0;
  private qualityCalls = 0;
  private synthesisCalls = 0;

  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly options: ProductClientOptions = {}
  ) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.states.push(invocation.stateId);
    this.invocations.push(invocation);
    if (invocation.executionPurpose === "routing_repair") {
      const validating = invocation.stateId === "validating";
      const details: Record<string, JsonValue> = {
        verdict: validating ? "FAIL" : "NEEDS_REVISION",
        ...(validating ? { unsupported_claims: ["claim-0001"] } : { issues: ["revise quality"] }),
        evidence: ["exact"],
      };
      switch (this.options.routingMutation) {
        case "verdict":
          details.verdict = validating ? "PASS" : "APPROVE";
          break;
        case "finding":
          details[validating ? "unsupported_claims" : "issues"] = ["changed finding"];
          break;
        case "evidence":
          details.evidence = ["changed evidence"];
          break;
        case "clarification":
          details.needs_clarification = true;
          details.clarifying_questions = ["Changed scope?"];
          break;
      }
      return {
        text: `SUMMARY:${JSON.stringify({ confidence: this.options.routingMutation === "confidence" ? "PROBABLE" : "CERTAIN", ...details })}`,
      };
    }
    switch (invocation.stateId) {
      case "planning": {
        const details = {
          plan_steps:
            this.options.planWidth === undefined
              ? ["one", "two"]
              : Array.from({ length: this.options.planWidth }, (_, i) => `angle ${i + 1}`),
          plan_complete: true,
        };
        return {
          text: `plan\nSUMMARY:${JSON.stringify({ confidence: "CERTAIN", ...details })}`,
          confidence: "CERTAIN",
          details,
        };
      }
      case "critiquing_plan":
        return {
          text: 'approved\nSUMMARY:{"confidence":"CERTAIN","verdict":"APPROVE","issues":[],"evidence":["exact"]}',
          confidence: "CERTAIN",
          details: { verdict: "APPROVE", issues: [], evidence: ["exact"] },
        };
      case "critiquing_report": {
        this.qualityCalls += 1;
        const omission = this.omittedContradiction(invocation);
        const pass = !omission && this.qualityCalls > (this.options.qualityFailures ?? 0);
        const details = {
          verdict: pass ? "APPROVE" : "NEEDS_REVISION",
          issues: pass
            ? []
            : [omission ? "material uncited counterexample omitted" : "revise quality"],
          evidence: [
            omission ? "sq2 exact bytes contradict the unqualified sealed claim" : "exact",
          ],
        };
        return {
          text: `quality review\nSUMMARY:${JSON.stringify({ confidence: "CERTAIN", ...details })}`,
          confidence: "CERTAIN",
          details,
        };
      }
      case "researching": {
        const observation =
          this.options.omissionOracle === undefined
            ? this.options.repeatEvidence === true
              ? "The captured source documents one bounded semantic-core product."
              : `evidence ${invocation.workflowSession?.branch_id ?? "single"}`
            : invocation.workflowSession?.branch_id === "sq2"
              ? "FIXTURE COUNTEREXAMPLE: widget B is blue."
              : "FIXTURE ASSERTION: all widgets are red.";
        return {
          text: `${observation}\nSUMMARY:{"confidence":"CERTAIN","explore_complete":true}`,
          confidence: "CERTAIN",
          details: { explore_complete: true },
        };
      }
      case "synthesizing": {
        this.synthesisCalls += 1;
        this.synthesisTasks.push(invocation.task);
        if (this.options.synthesisRouting !== undefined) {
          const routing = this.options.synthesisRouting;
          // Deliberately disagree with the side-channel details/confidence: the real
          // WorkerExecutor must route only from the captured exact assistant footer.
          return {
            text: `SUMMARY:${JSON.stringify({
              synthesis_complete: routing === "uncertain",
              confidence: routing === "uncertain" ? "UNCERTAIN" : "POSSIBLE",
              ...(routing === "clarification"
                ? {
                    needs_clarification: true,
                    clarifying_questions: ["Which source scope is intended?"],
                  }
                : {}),
            })}`,
            confidence: "CERTAIN",
            details: { synthesis_complete: true },
          };
        }
        if (this.options.emptySynthesis === true) {
          return {
            text: "",
            confidence: "CERTAIN",
            details: { synthesis_complete: true },
          };
        }
        const draft = buildDraft(invocation, this.artifacts, {
          ...this.options,
          ...(this.options.changedCandidate === true
            ? {
                claimStatement: `The fixture candidate discloses ${this.synthesisCalls} distinct limitations.`,
              }
            : {}),
          ...(this.synthesisCalls > 1 && this.options.repairCitedSlots !== undefined
            ? { citedSlots: this.options.repairCitedSlots }
            : {}),
          absentExcerpt:
            this.synthesisCalls <= (this.options.sealFailures ?? 0) ||
            this.options.sealFailureAtCalls?.includes(this.synthesisCalls) === true ||
            this.options.absentExcerpt === true,
        });
        return {
          text: `${this.options.draftFramingNoise === true ? JSON.stringify(draft, null, 2) : canonicalJson(draft)}\nSUMMARY:${JSON.stringify({ confidence: this.options.draftFramingNoise === true ? "PROBABLE" : "CERTAIN", synthesis_complete: true })}`,
          confidence: "CERTAIN",
          details: { synthesis_complete: true },
        };
      }
      case "validating": {
        if (this.options.verificationOutcome === "missing_judgment")
          return { text: 'Verification report\nSUMMARY:{"confidence":"CERTAIN"}' };
        if (this.options.verificationOutcome === "unverifiable")
          return {
            text: 'Required source-fidelity verification is unavailable; no product defect established.\nSUMMARY:{"verdict":"UNVERIFIABLE","gap_kind":"verification_incomplete","repair_owner":"none","unsupported_claims":[],"evidence":["Required source-fidelity check is unavailable"],"confidence":"UNCERTAIN"}',
          };
        if (this.options.verificationOutcome === "uncertain")
          return {
            text: 'User-only ambiguity prevents a grounded judgment.\nSUMMARY:{"verdict":"FAIL","unsupported_claims":[],"evidence":["Ambiguous source scope"],"confidence":"UNCERTAIN"}',
          };
        if (this.options.verificationOutcome === "clarification")
          return {
            text: 'User-only scope decision needed.\nSUMMARY:{"verdict":"FAIL","unsupported_claims":[],"evidence":["Admitted scope needs a user decision"],"needs_clarification":true,"clarifying_questions":["Which source scope is intended?"],"confidence":"POSSIBLE"}',
          };
        const omission = this.omittedContradiction(invocation);
        const failure = omission
          ? "synthesis"
          : this.options.validationFailures?.[this.validationCalls];
        this.validationCalls += 1;
        const details =
          failure === undefined
            ? { verdict: "PASS" as const, unsupported_claims: [], evidence: ["exact"] }
            : {
                verdict: "FAIL" as const,
                unsupported_claims: [
                  omission ? "material uncited counterexample omitted" : "claim-0001",
                ],
                evidence: [
                  omission ? "sq2 exact bytes contradict the unqualified sealed claim" : "exact",
                ],
                ...(failure === "evidence" ? { evidence_needed: ["targeted source"] } : {}),
              };
        return {
          text: `${failure === undefined ? "grounded" : "not grounded"}\nSUMMARY:${JSON.stringify({ confidence: "CERTAIN", ...details })}`,
          confidence: "CERTAIN",
          details,
        };
      }
    }
    throw new Error(`unexpected product fixture state '${invocation.stateId}'`);
  }

  private omittedContradiction(invocation: AgentInvocation): boolean {
    if (this.options.omissionOracle !== invocation.stateId) return false;
    const coreRef = invocation.inputArtifacts.find((ref) => ref.kind === "semantic-core");
    if (coreRef === undefined) throw new Error("oracle missing exact sealed core");
    const core = validateCanonicalGroundedSynthesisBytes(
      this.artifacts.readById(coreRef.artifact_id),
      coreRef
    );
    const counterexample = invocation.inputArtifacts.find(
      (ref) =>
        ref.phase === "researching" &&
        this.artifacts
          .readById(ref.artifact_id)
          .includes("FIXTURE COUNTEREXAMPLE: widget B is blue.")
    );
    if (counterexample === undefined) throw new Error("oracle missing considered counterexample");
    return (
      core.claims.some(
        (claim) => claim.statement === "All widgets are red." && claim.qualifications.length === 0
      ) &&
      core.contradictions.length === 0 &&
      !core.provenance.evidence_artifacts.some(
        (ref) => ref.artifact_id === counterexample.artifact_id
      )
    );
  }
}

function runtime(
  root: string,
  options: ProductClientOptions = {},
  researchHostFault?: (point: string) => void,
  contextProviders?: ResearchContextProviderHandlersV2,
  hostFault?: OrdinaryHostFaultV1
) {
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
  const researchContext =
    contextProviders === undefined
      ? undefined
      : new ResearchContextOwnerV2(artifacts, contextProviders);
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    maxSteps: null,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactRevisions: artifacts,
    artifactStore: artifacts,
    artifactReader: artifacts,
    ...(researchHostFault === undefined ? {} : { researchHostFault }),
    ...(hostFault === undefined ? {} : { hostFault }),
    ...(researchContext === undefined ? {} : { researchContext }),
  });
  const client = new ProductClient(artifacts, options);
  const workers = new WorkerExecutor(client, artifacts, {
    projectRoot: root,
    parallelConcurrency: 2,
    registration: engine.registration,
    ...(researchContext === undefined ? {} : { researchContext }),
  });
  return { artifacts, checkpointer, engine, client, workers };
}

function terminalResult(directive: Directive): Record<string, JsonValue> {
  if (
    directive.action !== "complete" &&
    directive.action !== "incomplete" &&
    directive.action !== "cancelled" &&
    directive.action !== "error"
  ) {
    throw new Error(`expected terminal, received '${directive.action}'`);
  }
  return directive.result;
}

async function advanceToReview(
  stack: ReturnType<typeof runtime>,
  initial: Directive,
  state: "validating" | "critiquing_report"
): Promise<Extract<Directive, { action: "invoke_agent" }>> {
  stack.workers.setReceiptAuthority(stack.engine.receiptAuthority);
  stack.workers.setLivenessController(stack.engine.liveness);
  let current = initial;
  while (current.action === "invoke_agent" || current.action === "invoke_agents_parallel") {
    if (current.action === "invoke_agent" && current.state_id === state) return current;
    const results = await stack.workers.execute(stack.engine.authorizeDispatch(current));
    for (const result of results)
      current = stack.engine.handle({
        schema_version: 2,
        action: "step",
        identity: initial.identity,
        result,
      });
  }
  throw new Error(`expected ${state}, received ${current.action}`);
}

describe("Research truthful review loop", () => {
  it("registers immutable Vera/Carren judgments and exact repair progress without changing discovery phases", () => {
    const registration = PLAYBOOK_REGISTRY.get("research");
    if (registration?.worker.kind !== "catalog-agent") throw new Error("Research catalog missing");
    expect(registration.repair_progress_policy).toBe("exact_fingerprint_v1");
    for (const state of ["validating", "critiquing_plan", "critiquing_report"])
      expect(registration.worker.phases.get(state)?.routing_repair_policy).toBe(
        "preserve_source_summary_v1"
      );
    for (const state of ["planning", "researching", "synthesizing"])
      expect(registration.worker.phases.get(state)?.routing_repair_policy).toBeUndefined();
    const negative = {
      verdict: "UNVERIFIABLE",
      gap_kind: "verification_incomplete",
      repair_owner: "none",
      unsupported_claims: [],
      evidence: ["check unavailable"],
    };
    expect(() =>
      validateContract(researchSummarySchema("validating"), negative, "negative")
    ).not.toThrow();
    for (const invalid of [
      { ...negative, repair_owner: "synthia" },
      { ...negative, gap_kind: "synthesis_gap" },
      { ...negative, evidence_needed: ["new source"] },
      { ...negative, evidence: [] },
      { ...negative, invented: true },
    ])
      expect(() =>
        validateContract(researchSummarySchema("validating"), invalid, "negative")
      ).toThrow();
  });

  it.each(["quick", "deep"] as const)(
    "keeps truthful %s UNVERIFIABLE durable with exact core/report and no positive receipt or admission",
    async (mode) => {
      const root = temporaryRoot();
      const runId = `unverifiable-${mode}`;
      const first = runtime(root, { verificationOutcome: "unverifiable" });
      const terminal = await new OrchestrationRunner(first.engine, first.workers).runUntilBoundary(
        first.engine.handle(start(root, runId, mode))
      );
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: { grounded: false, incomplete_reason: "verification_incomplete" },
      });
      const run = first.checkpointer.loadRun(identity(runId));
      const core = run.selectedArtifacts.find((ref) => ref.kind === "semantic-core");
      const report = run.selectedArtifacts.find(
        (ref) => ref.phase === "validating" && ref.kind === "agent-output"
      );
      if (core === undefined || report === undefined)
        throw new Error("negative core/report missing");
      expect(terminalResult(terminal)).toMatchObject({
        output_artifact_ref: core,
        reviewed_core_ref: core,
        verification_report_ref: report,
      });
      if (terminal.action !== "incomplete") throw new Error("negative terminal missing");
      expect(terminal.artifacts).toContainEqual(core);
      expect(terminal.artifacts).toContainEqual(report);
      expect(first.artifacts.readById(report.artifact_id).toString()).toContain(
        '"verdict":"UNVERIFIABLE"'
      );
      expect(
        run.selectedArtifacts.some((ref) =>
          ["product-receipt", "product-envelope", "deterministic-render"].includes(ref.kind)
        )
      ).toBe(false);
      expect(first.client.states.filter((state) => state === "synthesizing")).toHaveLength(1);
      expect(first.client.states).not.toContain("critiquing_report");
      expect(
        first.checkpointer
          .events(runId)
          .some((event) => event.payload.feedback_route_evidence_v1 !== undefined)
      ).toBe(false);
      expect(first.checkpointer.completionAdmission(runId)).toBeUndefined();
      first.artifacts.close();
      first.checkpointer.close();
      const recovered = runtime(root);
      try {
        expect(
          recovered.engine.handle({
            schema_version: 2,
            action: "recover",
            identity: identity(runId),
          })
        ).toEqual(terminal);
        expect(recovered.client.states).toEqual([]);
        expect(recovered.checkpointer.completionAdmission(runId)).toBeUndefined();
      } finally {
        recovered.artifacts.close();
        recovered.checkpointer.close();
      }
    }
  );

  it("preserves genuine FAIL clarification, exact gate recovery, and resumed synthesis before fresh review", async () => {
    const root = temporaryRoot();
    const runId = "native-review-clarification";
    const first = runtime(root, { verificationOutcome: "clarification" });
    const gate = await new OrchestrationRunner(first.engine, first.workers).runUntilBoundary(
      first.engine.handle(start(root, runId, "quick"))
    );
    if (gate.action !== "await_user") throw new Error(`expected native gate, got ${gate.action}`);
    expect(gate.questions.map((question) => question.prompt)).toEqual([
      "Which source scope is intended?",
    ]);
    expect(
      first.checkpointer
        .events(runId)
        .some((event) => event.payload.feedback_route_evidence_v1 !== undefined)
    ).toBe(false);
    first.artifacts.close();
    first.checkpointer.close();
    const recovered = runtime(root);
    try {
      expect(
        recovered.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(gate);
      const next = recovered.engine.handle({
        schema_version: 2,
        action: "respond",
        identity: identity(runId),
        gate_id: gate.gate_id,
        challenge: gate.challenge,
        response: "Use the admitted public source scope.",
      });
      expect(next).toMatchObject({ action: "invoke_agent", state_id: "synthesizing" });
      const terminal = await new OrchestrationRunner(
        recovered.engine,
        recovered.workers
      ).runUntilBoundary(next);
      expect(terminal.action).toBe("complete");
      expect(recovered.client.states).toEqual(["synthesizing", "validating"]);
    } finally {
      recovered.artifacts.close();
      recovered.checkpointer.close();
    }
  });

  it("keeps native UNCERTAIN review on clarification rather than semantic repair", async () => {
    const root = temporaryRoot();
    const runId = "uncertain-review";
    const stack = runtime(root, { verificationOutcome: "uncertain" });
    try {
      const gate = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, runId, "quick"))
      );
      expect(gate).toMatchObject({ action: "await_user", state_id: "awaiting_clarification" });
      expect(stack.client.states).toEqual(["researching", "synthesizing", "validating"]);
      expect(
        stack.checkpointer
          .events(runId)
          .some((event) => event.payload.feedback_route_evidence_v1 !== undefined)
      ).toBe(false);
      expect(stack.checkpointer.completionAdmission(runId)).toBeUndefined();
    } finally {
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  });

  it.each(["validating", "critiquing_report"] as const)(
    "binds current native mechanical evidence to %s, exact recovery and signed task; cancellation stays final",
    async (state) => {
      const root = temporaryRoot();
      const runId = `checks-${state}`;
      const stack = runtime(root);
      try {
        const pending = await advanceToReview(
          stack,
          stack.engine.handle(start(root, runId, "deep")),
          state
        );
        const line = pending.task
          .split("\n")
          .find((value) => value.startsWith("HOST_MECHANICAL_CHECKS:"));
        if (line === undefined) throw new Error("host evidence missing");
        const checks = requireRecord(
          JSON.parse(line.slice("HOST_MECHANICAL_CHECKS:".length)),
          "mechanical checks"
        );
        const core = pending.input_artifacts.artifacts.find(
          ({ ref }) => ref.kind === "semantic-core"
        );
        if (core === undefined) throw new Error("review core missing");
        expect(checks["product_ref"]).toEqual(core.ref);
        expect(checks["scope"]).toBe("host_mechanical_only_not_semantic_or_effect_absence");
        expect(checks["checks"]).toEqual([
          "exact_source_ref_and_byte_custody",
          "canonical_admitted_request",
          "typed_semantic_draft_and_relations",
          "captured_excerpt_containment_and_hashes",
          "canonical_core_bytes_and_digest",
          "exact_core_projection_and_source_lineage",
          "considered_history_and_cited_active_provenance",
        ]);
        const sources = checks["source_refs"];
        if (!Array.isArray(sources)) throw new Error("source bindings missing");
        for (const source of sources) {
          const binding = requireRecord(source, "source binding");
          expect(
            pending.input_artifacts.artifacts.map(({ ref }) => ({
              artifact_id: ref.artifact_id,
              content_digest: ref.content_digest,
            }))
          ).toContainEqual(binding);
        }
        expect(
          stack.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
        ).toEqual(pending);
        const [result] = await stack.workers.execute({
          ...pending,
          task: pending.task.replace(
            '"scope":"host_mechanical_only_not_semantic_or_effect_absence"',
            '"scope":"unchecked"'
          ),
        });
        if (result === undefined) throw new Error("signed review missing");
        expect(() =>
          stack.engine.handle({
            schema_version: 2,
            action: "step",
            identity: identity(runId),
            result,
          })
        ).toThrow(/trusted_invocation_digest/u);
        expect(stack.checkpointer.completionAdmission(runId)).toBeUndefined();
        const cancelled = stack.engine.handle({
          schema_version: 2,
          action: "cancel",
          identity: identity(runId),
          reason: "fixture cancellation",
        });
        expect(cancelled.action).toBe("cancelled");
        expect(
          stack.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
        ).toEqual(cancelled);
      } finally {
        stack.artifacts.close();
        stack.checkpointer.close();
      }
    }
  );

  it.each(["ref_digest", "native_projection", "task_evidence"] as const)(
    "denies invalid %s mechanical evidence before review without author repair",
    async (failure) => {
      const root = temporaryRoot();
      const runId = `invalid-checks-${failure}`;
      const stack = runtime(root);
      try {
        await advanceToReview(
          stack,
          stack.engine.handle(start(root, runId, "quick")),
          "validating"
        );
        const run = stack.checkpointer.loadRun(identity(runId));
        if (failure === "ref_digest") {
          run.selectedArtifacts = run.selectedArtifacts.map((ref) =>
            ref.phase === "synthesizing" ? { ...ref, content_digest: "f".repeat(64) } : ref
          );
        } else if (failure === "native_projection") {
          const original = run.selectedArtifacts.find((ref) => ref.phase === "synthesizing");
          if (original === undefined) throw new Error("draft missing");
          const replacement = stack.artifacts.persist({
            metadata: {
              ...stack.artifacts.metadata(original),
              operation_id: "fixture-substituted-draft",
              version: 1,
              parent_ref: null,
            },
            content: stack.artifacts
              .readById(original.artifact_id)
              .toString()
              .replace("P3 activated research", "Different current draft title"),
          });
          run.selectedArtifacts = run.selectedArtifacts.map((ref) =>
            ref.artifact_id === original.artifact_id ? replacement : ref
          );
        } else {
          const pending = run.pendingDirective;
          if (pending?.action !== "invoke_agent") throw new Error("pending review missing");
          run.pendingDirective = {
            ...pending,
            task: pending.task.replace("HOST_MECHANICAL_CHECKS:", "UNCHECKED:"),
          };
        }
        stack.checkpointer.saveRun(run, "fixture_corruption", {});
        const terminal = stack.engine.handle({
          schema_version: 2,
          action: "recover",
          identity: identity(runId),
        });
        expect(terminal).toMatchObject({
          action: "incomplete",
          met: false,
          result: { incomplete_reason: "host_mechanical_validation_failed" },
        });
        expect(stack.client.states).toEqual(["researching", "synthesizing"]);
        expect(stack.checkpointer.completionAdmission(runId)).toBeUndefined();
        expect(
          stack.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
        ).toEqual(terminal);
      } finally {
        stack.artifacts.close();
        stack.checkpointer.close();
      }
    }
  );

  it.each(["validating", "critiquing_report"] as const)(
    "refuses all structured %s judgment mutations during routing correction",
    async (state) => {
      for (const routingMutation of [
        "verdict",
        "finding",
        "evidence",
        "confidence",
        "clarification",
      ] as const) {
        const root = temporaryRoot();
        const runId = `mutation-${state}-${routingMutation}`;
        const stack = runtime(root, {
          routingMutation,
          validationFailures: state === "validating" ? ["synthesis"] : [],
          qualityFailures: state === "critiquing_report" ? 1 : 0,
        });
        try {
          const pending = await advanceToReview(
            stack,
            stack.engine.handle(start(root, runId, "deep")),
            state
          );
          const [source] = await stack.workers.execute(pending);
          if (source === undefined) throw new Error("source review missing");
          const repair = stack.engine.handle({
            schema_version: 2,
            action: "step",
            identity: identity(runId),
            result: { ...source, details: {} },
          });
          expect(repair).toMatchObject({
            action: "invoke_agent",
            execution_purpose: "routing_repair",
          });
          const [replacement] = await stack.workers.execute(repair);
          if (replacement === undefined) throw new Error("replacement missing");
          const terminal = stack.engine.handle({
            schema_version: 2,
            action: "step",
            identity: identity(runId),
            result: replacement,
          });
          expect(terminal).toMatchObject({ action: "incomplete", met: false });
          expect(stack.checkpointer.completionAdmission(runId)).toBeUndefined();
          const run = stack.checkpointer.loadRun(identity(runId));
          expect(run.selectedArtifacts).toContainEqual(source.output_artifact);
          expect(run.selectedArtifacts.some((ref) => ref.kind === "product-envelope")).toBe(false);
        } finally {
          stack.artifacts.close();
          stack.checkpointer.close();
        }
      }
    }
  );

  it("refuses a judgment-free verifier without dispatching futile routing or semantic repair", async () => {
    const root = temporaryRoot();
    const stack = runtime(root, { verificationOutcome: "missing_judgment" });
    try {
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, "missing-judgment", "quick"))
      );
      expect(terminal).toMatchObject({ action: "incomplete", met: false });
      expect(stack.client.states).toEqual(["researching", "synthesizing", "validating"]);
      expect(stack.checkpointer.completionAdmission("missing-judgment")).toBeUndefined();
    } finally {
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  });

  it.each([false, true])(
    "treats changed uncited captured evidence as potential progress: %s",
    async (changed) => {
      const root = temporaryRoot();
      const runId = `changed-evidence-${changed}`;
      const stack = runtime(root, {
        citedSlots: [0],
        repeatEvidence: !changed,
        validationFailures: ["evidence", "evidence"],
      });
      try {
        const terminal = await new OrchestrationRunner(
          stack.engine,
          stack.workers
        ).runUntilBoundary(stack.engine.handle(start(root, runId, "quick")));
        expect(terminal.action).toBe(changed ? "complete" : "incomplete");
        if (!changed) expect(terminalResult(terminal)["incomplete_reason"]).toBe("repair_stalled");
        expect(stack.client.states.filter((state) => state === "validating")).toHaveLength(
          changed ? 3 : 2
        );
      } finally {
        stack.artifacts.close();
        stack.checkpointer.close();
      }
    }
  );

  it.each(["validating", "critiquing_report"] as const)(
    "permits meaningful changed %s candidates despite identical structured failures",
    async (state) => {
      const root = temporaryRoot();
      const runId = `changed-candidate-${state}`;
      const stack = runtime(root, {
        changedCandidate: true,
        validationFailures: state === "validating" ? ["synthesis", "synthesis"] : [],
        qualityFailures: state === "critiquing_report" ? 2 : 0,
      });
      try {
        const terminal = await new OrchestrationRunner(
          stack.engine,
          stack.workers
        ).runUntilBoundary(stack.engine.handle(start(root, runId, "deep")));
        expect(terminal).toMatchObject({ action: "complete", met: true });
        const fingerprints = stack.checkpointer.events(runId).flatMap((event) => {
          const raw = event.payload.feedback_route_evidence_v1;
          if (raw === undefined) return [];
          const value = requireRecord(raw, "repair evidence");
          expect(value["disposition"]).toBe("repair");
          return [requireRecord(value["repair_progress_v1"], "progress")["fingerprint"]];
        });
        expect(fingerprints).toHaveLength(2);
        expect(new Set(fingerprints).size).toBe(2);
        expect(stack.client.states.filter((entry) => entry === state)).toHaveLength(3);
      } finally {
        stack.artifacts.close();
        stack.checkpointer.close();
      }
    }
  );

  it("fingerprints complete failed details and captured native semantic content, not strategy claims", async () => {
    const root = temporaryRoot();
    const runId = "fingerprint-details";
    const stack = runtime(root);
    try {
      await advanceToReview(stack, stack.engine.handle(start(root, runId, "quick")), "validating");
      const context = stack.checkpointer.loadRun(identity(runId));
      const playbook = new ResearchPlaybook(
        stack.artifacts,
        undefined,
        stack.artifacts,
        stack.checkpointer
      );
      const failure = {
        verdict: "FAIL",
        unsupported_claims: ["claim-0001"],
        evidence: ["exact"],
        evidence_needed: ["primary source"],
      };
      const original = playbook.repairProgressFingerprint(context, "validating", failure);
      expect(original).toMatch(/^[a-f0-9]{64}$/u);
      expect(
        playbook.repairProgressFingerprint(context, "validating", {
          ...failure,
          strategy_delta: "Different strategy wording",
        })
      ).toBe(original);
      for (const changed of [
        { ...failure, evidence: ["new captured finding"] },
        { ...failure, unsupported_claims: ["claim-0002"] },
        { ...failure, evidence_needed: ["contradiction source"] },
      ])
        expect(playbook.repairProgressFingerprint(context, "validating", changed)).not.toBe(
          original
        );
    } finally {
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  });

  it("retains exact failure recurrence across restart and ignores draft JSON/footer framing", async () => {
    const root = temporaryRoot();
    const runId = "restart-recurrence";
    const first = runtime(root, { validationFailures: ["synthesis"] });
    const pending = await advanceToReview(
      first,
      first.engine.handle(start(root, runId, "quick")),
      "validating"
    );
    const [failure] = await first.workers.execute(pending);
    if (failure === undefined) throw new Error("first failure missing");
    expect(
      first.engine.handle({
        schema_version: 2,
        action: "step",
        identity: identity(runId),
        result: failure,
      })
    ).toMatchObject({ action: "invoke_agent", state_id: "synthesizing" });
    first.artifacts.close();
    first.checkpointer.close();
    const recovered = runtime(root, { validationFailures: ["synthesis"], draftFramingNoise: true });
    try {
      const next = recovered.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      const review = await advanceToReview(recovered, next, "validating");
      const [result] = await recovered.workers.execute(review);
      if (result === undefined) throw new Error("second failure missing");
      const terminal = recovered.engine.handle({
        schema_version: 2,
        action: "step",
        identity: identity(runId),
        result,
      });
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: { incomplete_reason: "repair_stalled" },
      });
      expect(
        recovered.checkpointer.events(runId).filter((event) => {
          const evidence = event.payload.feedback_route_evidence_v1;
          return (
            evidence !== null &&
            typeof evidence === "object" &&
            !Array.isArray(evidence) &&
            evidence.disposition === "repair"
          );
        })
      ).toHaveLength(1);
      expect(recovered.checkpointer.completionAdmission(runId)).toBeUndefined();
      expect(
        recovered.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
    } finally {
      recovered.artifacts.close();
      recovered.checkpointer.close();
    }
  });
});

describe("P3 deterministic renderer golden", () => {
  it("preserves exact historical layout bytes for retained v1 products", () => {
    const fixture = new URL("./fixtures/research-p3-render-golden/", import.meta.url);
    const coreBytes = readFileSync(new URL("core.json", fixture));
    const manifestValue: unknown = JSON.parse(
      readFileSync(new URL("manifest.json", fixture), "utf8")
    );
    const manifest = requireRecord(manifestValue, "render manifest");
    const core = validateCanonicalGroundedSynthesisBytes(coreBytes);
    const semanticCore = validateSemanticCoreRef(manifest["semantic_core"]);
    const rendered = renderResearchCompatibility({ core, semanticCore, layout: "legacy" });
    for (const [name, file] of [
      ["report", "report.md"],
      ["sources", "sources.md"],
      ["readme", "README.md"],
    ] as const) {
      const expected = readFileSync(new URL(file, fixture));
      expect(Buffer.from(rendered[name], "utf8")).toEqual(expected);
      expect(expected.toString("utf8").normalize("NFC")).toBe(expected.toString("utf8"));
      expect(expected.toString("utf8")).not.toContain("\r");
      expect(expected.toString("utf8")).toMatch(/[^\n]\n$/u);
    }
  });
});

describe("Research batch C functional seams", () => {
  it.each(["quick", "deep"] as const)(
    "passes the exact admitted scope to every early %s worker",
    async (mode) => {
      const root = temporaryRoot();
      const stack = runtime(root);
      try {
        const runId = `scope-${mode}`;
        const scope = {
          include: ["public source records"],
          exclude: ["private applicant records"],
        };
        const terminal = await new OrchestrationRunner(
          stack.engine,
          stack.workers
        ).runUntilBoundary(
          stack.engine.handle({ ...start(root, runId, mode), constraints: { mode, scope } })
        );
        expect(terminal.action).toBe("complete");
        const run = stack.checkpointer.loadRunById(runId);
        if (run === undefined) throw new Error("missing scope run");
        const request = run.selectedArtifacts.find((ref) => ref.kind === "research-request");
        if (request === undefined) throw new Error("missing admitted scope");
        expect(
          validateResearchRequest(
            JSON.parse(stack.artifacts.readById(request.artifact_id).toString())
          ).scope
        ).toEqual(scope);
        const early = stack.client.invocations.filter((call) =>
          ["planning", "critiquing_plan", "researching"].includes(call.stateId)
        );
        expect(early.map((call) => call.stateId)).toEqual(
          mode === "quick"
            ? ["researching"]
            : ["planning", "critiquing_plan", "researching", "researching"]
        );
        for (const call of early)
          expect(call.inputArtifacts.filter((ref) => ref.kind === "research-request")).toEqual([
            request,
          ]);
      } finally {
        stack.artifacts.close();
        stack.checkpointer.close();
      }
    }
  );

  it("binds seal corrections and evidence repair to the current epoch, excluding stale refs", async () => {
    const root = temporaryRoot();
    const stack = runtime(root, {
      sealFailures: 1,
      sealFailureAtCalls: [3],
      validationFailures: ["evidence", "evidence"],
    });
    try {
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, "epoch-inputs", "quick"))
      );
      expect(terminal.action).toBe("complete");
      const authors = stack.client.invocations.filter((call) => call.stateId === "synthesizing");
      expect(authors).toHaveLength(5);
      const diagnosticIds: string[] = [];
      for (const index of [1, 3]) {
        const author = authors[index];
        if (author === undefined) throw new Error("missing seal correction author");
        const diagnostics = author.inputArtifacts.filter((ref) => ref.kind === "seal-diagnostic");
        expect(diagnostics).toHaveLength(1);
        const diagnosticRef = diagnostics[0];
        if (diagnosticRef === undefined) throw new Error("missing exact diagnostic");
        diagnosticIds.push(diagnosticRef.artifact_id);
        const diagnostic = requireRecord(
          JSON.parse(stack.artifacts.readById(diagnosticRef.artifact_id).toString()),
          "diagnostic"
        );
        expect(author.inputArtifacts).toContainEqual(diagnostic["rejected_draft_ref"]);
        expect(diagnostic["epoch_anchor_ref"]).toEqual(
          index === 1 ? null : author.inputArtifacts.find((ref) => ref.kind === "semantic-core")
        );
      }
      expect(new Set(diagnosticIds).size).toBe(2);
      for (const index of [0, 2, 4]) {
        const author = authors[index];
        if (author === undefined) throw new Error("missing author epoch");
        expect(author.inputArtifacts.filter((ref) => ref.kind === "seal-diagnostic")).toEqual([]);
      }
      const reviews = stack.client.invocations.filter((call) => call.stateId === "validating");
      const repairs = stack.client.invocations
        .filter((call) => call.stateId === "researching")
        .slice(1);
      expect(repairs).toHaveLength(2);
      for (const [index, repair] of repairs.entries()) {
        const reviewed = reviews[index]?.inputArtifacts.find((ref) => ref.kind === "semantic-core");
        if (reviewed === undefined) throw new Error("missing reviewed core");
        expect(repair.inputArtifacts.filter((ref) => ref.kind === "semantic-core")).toEqual([
          reviewed,
        ]);
        expect(repair.inputArtifacts.filter((ref) => ref.kind === "seal-diagnostic")).toEqual([]);
      }
      const firstCore = reviews[0]?.inputArtifacts.find((ref) => ref.kind === "semantic-core");
      if (firstCore === undefined) throw new Error("missing first reviewed core");
      expect(repairs[1]?.inputArtifacts).not.toContainEqual(firstCore);
      const run = stack.checkpointer.loadRunById("epoch-inputs");
      if (run === undefined) throw new Error("missing history");
      expect(
        run.selectedArtifacts
          .filter((ref) => ref.kind === "seal-diagnostic")
          .map((ref) => ref.artifact_id)
      ).toEqual(diagnosticIds);
    } finally {
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  });

  it.each(["incomplete", "clarification", "uncertain"] as const)(
    "routes captured %s synthesis through the real worker parser without sealing a fake draft",
    async (synthesisRouting) => {
      const root = temporaryRoot();
      const stack = runtime(root, { synthesisRouting });
      try {
        const runId = `truthful-${synthesisRouting}`;
        const boundary = await new OrchestrationRunner(
          stack.engine,
          stack.workers
        ).runUntilBoundary(stack.engine.handle(start(root, runId, "quick")));
        expect(boundary.action).toBe("await_user");
        const run = stack.checkpointer.loadRunById(runId);
        if (run === undefined) throw new Error("missing negative synthesis run");
        expect(
          run.selectedArtifacts.some(
            (ref) => ref.kind === "semantic-core" || ref.kind === "seal-diagnostic"
          )
        ).toBe(false);
        expect(
          stack.checkpointer.stateVisits(runId).some((visit) => visit.state_id === "sealing_core")
        ).toBe(false);
        const source = run.selectedArtifacts.find((ref) => ref.phase === "synthesizing");
        if (source === undefined) throw new Error("missing captured negative synthesis");
        const routing = parsePersistedRoutingSummary(
          stack.artifacts.readById(source.artifact_id).toString()
        );
        if (routing === undefined) throw new Error("negative SUMMARY did not parse");
        expect(routing.confidence).toBe(
          synthesisRouting === "uncertain" ? "UNCERTAIN" : "POSSIBLE"
        );
        expect(routing.details["synthesis_complete"]).toBe(synthesisRouting === "uncertain");
        if (synthesisRouting === "clarification")
          expect(routing.details["clarifying_questions"]).toEqual([
            "Which source scope is intended?",
          ]);
        expect(
          stack.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
        ).toEqual(boundary);
      } finally {
        stack.artifacts.close();
        stack.checkpointer.close();
      }
    }
  );

  it("rejects malformed negative SUMMARY values and unknown keys with the actual parser and closed synthesis schema", () => {
    for (const footer of [
      '{"synthesis_complete":false,"confidence":"INVENTED"}',
      '{"synthesis_complete":false,"confidence":"POSSIBLE"} trailing prose',
    ])
      expect(parsePersistedRoutingSummary(`SUMMARY:${footer}`)).toBeUndefined();
    for (const details of [
      { synthesis_complete: "false", confidence: "POSSIBLE" },
      { synthesis_complete: false, confidence: "POSSIBLE", invented: true },
      { synthesis_complete: false, confidence: "POSSIBLE", clarifying_questions: [""] },
    ]) {
      const parsed = parsePersistedRoutingSummary(`SUMMARY:${JSON.stringify(details)}`);
      if (parsed === undefined) throw new Error("expected syntactically valid SUMMARY");
      expect(() =>
        validateContract(
          researchSummarySchema("synthesizing"),
          parsed.details,
          "negative synthesis"
        )
      ).toThrow();
    }
  });

  it.each([
    [false, "standard"],
    [true, "standard"],
    [true, "deep"],
  ] as const)(
    "reaches admitted width 64 with compact exact-ID slots; extra repair branch=%s, mode=%s retains all evidence",
    async (repair, mode) => {
      const root = temporaryRoot();
      const stack = runtime(root, {
        planWidth: 64,
        ...(repair ? { validationFailures: ["evidence"], repairCitedSlots: [0, 64] } : {}),
      });
      try {
        const runId = `width64-${repair}-${mode}`;
        const terminal = await new OrchestrationRunner(
          stack.engine,
          stack.workers
        ).runUntilBoundary(
          stack.engine.handle({
            ...start(root, runId, mode),
            constraints: { mode, max_sub_queries: 64, max_fan_width: 64 },
          })
        );
        expect(terminal).toMatchObject({
          action: "complete",
          met: true,
        });
        const authors = stack.client.invocations.filter((call) => call.stateId === "synthesizing");
        expect(authors).toHaveLength(repair ? 2 : 1);
        const author = authors[0];
        if (author === undefined) throw new Error("width64 synthesis not reached");
        expect(author.task.length).toBeLessThanOrEqual(32768);
        const slotsText = author.task.split("OWNER_SELECTED_EVIDENCE_SLOTS:")[1]?.split("\n\n")[0];
        if (slotsText === undefined) throw new Error("missing compact slots");
        const slots = requireRecord(JSON.parse(slotsText), "compact evidence slots");
        const echoes = stack.checkpointer
          .loadRunById(runId)
          ?.selectedArtifacts.filter((ref) => ref.phase === "researching")
          .slice(0, 64);
        if (echoes === undefined) throw new Error("missing accepted Echo history");
        expect(echoes).toHaveLength(64);
        expect(slots["evidence_artifacts"]).toEqual(
          echoes.map((ref, slot) => ({
            evidence_artifact_slot: slot,
            artifact_id: ref.artifact_id,
          }))
        );
        expect(author.task).not.toContain('"store_ref"');
        const run = stack.checkpointer.loadRunById(runId);
        if (run === undefined) throw new Error("missing wide evidence history");
        const history = run.selectedArtifacts.filter((ref) => ref.phase === "researching");
        expect(history).toHaveLength(repair ? 65 : 64);
        for (const ref of history) expect(stack.artifacts.refById(ref.artifact_id)).toEqual(ref);
        const coreRef = run.selectedArtifacts.find((ref) => ref.kind === "semantic-core");
        if (coreRef === undefined) throw new Error("width64 core not sealed");
        const core = validateCanonicalGroundedSynthesisBytes(
          stack.artifacts.readById(coreRef.artifact_id),
          coreRef
        );
        expect(core.provenance.evidence_artifacts).toEqual(echoes);
        expect(new Set(core.evidence.map((item) => item.evidence_artifact_id))).toEqual(
          new Set(echoes.map((ref) => ref.artifact_id))
        );
        if (repair) {
          const extra = stack.client.invocations
            .filter((call) => call.stateId === "researching")
            .at(-1);
          if (extra === undefined) throw new Error("real extra branch not dispatched");
          expect(extra.workflowSession?.branch_id).toBe("sq65");
          expect(extra.inputArtifacts.filter((ref) => ref.kind === "semantic-core")).toEqual([
            coreRef,
          ]);
          const repairedAuthor = authors[1];
          const repairedValidator = stack.client.invocations.filter(
            (call) => call.stateId === "validating"
          )[1];
          const latestCoreRef = run.selectedArtifacts
            .filter((ref) => ref.kind === "semantic-core")
            .at(-1);
          if (
            repairedAuthor === undefined ||
            repairedValidator === undefined ||
            latestCoreRef === undefined
          )
            throw new Error("missing repaired core/author/fresh Vera");
          const repairedSlotsText = repairedAuthor.task
            .split("OWNER_SELECTED_EVIDENCE_SLOTS:")[1]
            ?.split("\n\n")[0];
          if (repairedSlotsText === undefined) throw new Error("missing repaired slots");
          expect(
            requireRecord(JSON.parse(repairedSlotsText), "repair slots")["evidence_artifacts"]
          ).toEqual(
            history.map((ref, slot) => ({
              evidence_artifact_slot: slot,
              artifact_id: ref.artifact_id,
            }))
          );
          const reportReviewer = stack.client.invocations.find(
            (call) => call.stateId === "critiquing_report"
          );
          if (mode === "deep" && reportReviewer === undefined)
            throw new Error("missing latest-core Carren");
          for (const call of [
            repairedAuthor,
            repairedValidator,
            ...(reportReviewer === undefined ? [] : [reportReviewer]),
          ]) {
            expect(call.inputArtifacts.filter((ref) => ref.phase === "researching")).toHaveLength(
              65
            );
            for (const ref of history) expect(call.inputArtifacts).toContainEqual(ref);
            expect(call.inputArtifacts.some((ref) => ref.kind === "research-request")).toBe(true);
          }
          expect(
            repairedValidator.inputArtifacts.filter((ref) => ref.kind === "semantic-core")
          ).toEqual([latestCoreRef]);
          if (reportReviewer !== undefined) {
            expect(
              reportReviewer.inputArtifacts.filter((ref) => ref.kind === "semantic-core")
            ).toEqual([latestCoreRef]);
          }
          expect(latestCoreRef.artifact_id).not.toBe(coreRef.artifact_id);
          const repairedCore = validateCanonicalGroundedSynthesisBytes(
            stack.artifacts.readById(latestCoreRef.artifact_id),
            latestCoreRef
          );
          const active = [history[0], history[64]];
          expect(repairedCore.provenance.evidence_artifacts).toEqual(active);
          expect(new Set(repairedCore.evidence.map((item) => item.evidence_artifact_id))).toEqual(
            new Set(
              active.map((ref) => {
                if (ref === undefined) throw new Error("missing cited old0/new64");
                return ref.artifact_id;
              })
            )
          );
          expect(
            stack.artifacts
              .metadata(latestCoreRef)
              .upstream_refs.filter((ref) => ref.phase === "researching")
          ).toEqual(active);
          expect(
            stack.artifacts
              .metadata(repairedCore.provenance.synthesis_source_artifact)
              .upstream_refs.filter((ref) => ref.phase === "researching")
          ).toHaveLength(65);
          expect(terminalResult(terminal)["output_artifact_ref"]).toEqual(latestCoreRef);
          const suffix = [
            "validating",
            "researching",
            "synthesizing",
            "validating",
            ...(mode === "deep" ? ["critiquing_report"] : []),
          ];
          expect(stack.client.states.slice(-suffix.length)).toEqual(suffix);
        }
        expect(
          stack.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
        ).toEqual(terminal);
      } finally {
        stack.artifacts.close();
        stack.checkpointer.close();
      }
    }
  );

  it.each(["ref-count", "task-metadata"] as const)(
    "refuses complete-history %s transport overflow without trimming refs (dispatcher unit boundary)",
    async (bound) => {
      const root = temporaryRoot();
      const stack = runtime(root, { synthesisRouting: "incomplete" });
      try {
        const runId = `history-transport-${bound}`;
        const paused = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
          stack.engine.handle(start(root, runId, "quick"))
        );
        expect(paused.action).toBe("await_user");
        const context = stack.checkpointer.loadRunById(runId);
        if (context === undefined) throw new Error("missing exact context");
        context.transition("synthesizing");
        const playbook = new ResearchPlaybook(stack.artifacts, undefined, stack.artifacts);
        const baseline = playbook.dispatch(context);
        if (baseline.action !== "invoke_agent")
          throw new Error("missing baseline dispatcher inputs");
        const extraCount =
          bound === "ref-count" ? 257 - baseline.input_artifacts.artifacts.length : 239;
        for (let index = 0; index < extraCount; index += 1) {
          context.selectedArtifacts.push(
            stack.artifacts.persist({
              metadata: {
                schema_version: 2,
                run_id: runId,
                phase: "researching",
                branch_id: `extra-${index}`,
                kind: "agent-output",
                operation_id: `transport-history-${index}`,
                version: 1,
                producer: "agent:echo",
                media_type: "text/plain",
                parent_ref: null,
                upstream_refs: [],
              },
              content: `exact observation ${index}`,
            })
          );
        }
        const retained = structuredClone(context.selectedArtifacts);
        const refusal = playbook.dispatch(context);
        expect(refusal).toMatchObject({ action: "incomplete", met: false });
        expect(JSON.stringify(terminalResult(refusal))).toContain(
          bound === "ref-count"
            ? "257 exact inputs exceed the 256-ref"
            : "32768-character transport bound"
        );
        expect(context.selectedArtifacts).toEqual(retained);
        for (const ref of retained) expect(stack.artifacts.refById(ref.artifact_id)).toEqual(ref);
      } finally {
        stack.artifacts.close();
        stack.checkpointer.close();
      }
    }
  );

  it("keeps old revisions and earlier slots addressable after appending same-operation evidence (dispatcher unit boundary)", async () => {
    const root = temporaryRoot();
    const stack = runtime(root, { synthesisRouting: "incomplete" });
    try {
      const runId = "history-revision-slot";
      const paused = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, runId, "quick"))
      );
      expect(paused.action).toBe("await_user");
      const context = stack.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("missing revision fixture");
      const old = context.selectedArtifacts.find((ref) => ref.phase === "researching");
      if (old === undefined) throw new Error("missing old revision");
      const revision = stack.artifacts.persist({
        metadata: { ...stack.artifacts.metadata(old), version: old.version + 1, parent_ref: old },
        content: "a changed exact observation, not a replacement for old bytes",
      });
      context.selectedArtifacts.push(revision);
      context.transition("synthesizing");
      const author = new ResearchPlaybook(stack.artifacts, undefined, stack.artifacts).dispatch(
        context
      );
      if (author.action !== "invoke_agent") throw new Error("missing revision author");
      const tableText = author.task.split("OWNER_SELECTED_EVIDENCE_SLOTS:")[1]?.split("\n\n")[0];
      if (tableText === undefined) throw new Error("missing revision slot table");
      expect(requireRecord(JSON.parse(tableText), "revision slots")["evidence_artifacts"]).toEqual([
        { evidence_artifact_slot: 0, artifact_id: old.artifact_id },
        { evidence_artifact_slot: 1, artifact_id: revision.artifact_id },
      ]);
      expect(author.input_artifacts.artifacts.map((binding) => binding.ref)).toContainEqual(old);
      expect(author.input_artifacts.artifacts.map((binding) => binding.ref)).toContainEqual(
        revision
      );
    } finally {
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  });

  it("refuses a core actually citing 65 distinct artifacts without discarding history or retrying capacity", async () => {
    const root = temporaryRoot();
    const stack = runtime(root, { planWidth: 64, validationFailures: ["evidence"] });
    try {
      const runId = "width65-all-cited-refusal";
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle({
          ...start(root, runId, "standard"),
          constraints: { mode: "standard", max_sub_queries: 64, max_fan_width: 64 },
        })
      );
      expect(terminal).toMatchObject({ action: "incomplete", met: false });
      expect(JSON.stringify(terminalResult(terminal))).toContain("65 distinct Echo artifacts");
      expect(terminalResult(terminal)["product_envelope_ref"]).toBeUndefined();
      expect(stack.client.states.filter((state) => state === "synthesizing")).toHaveLength(2);
      expect(stack.client.states.filter((state) => state === "validating")).toHaveLength(1);
      const run = stack.checkpointer.loadRunById(runId);
      if (run === undefined) throw new Error("missing capacity checkpoint");
      const history = run.selectedArtifacts.filter((ref) => ref.phase === "researching");
      expect(history).toHaveLength(65);
      for (const ref of history) expect(stack.artifacts.refById(ref.artifact_id)).toEqual(ref);
      expect(run.selectedArtifacts.filter((ref) => ref.kind === "semantic-core")).toHaveLength(1);
      expect(
        stack.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
    } finally {
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  });

  it.each(["validating", "critiquing_report"] as const)(
    "%s can reject a material contradiction omitted from active provenance using the full considered history (fixture oracle, not model qualification)",
    async (reviewState) => {
      const root = temporaryRoot();
      const stack = runtime(root, { planWidth: 64, citedSlots: [0], omissionOracle: reviewState });
      try {
        const runId = `omitted-conflict-${reviewState}`;
        const terminal = await new OrchestrationRunner(
          stack.engine,
          stack.workers
        ).runUntilBoundary(
          stack.engine.handle({
            ...start(root, runId, "deep"),
            constraints: {
              mode: "deep",
              max_sub_queries: 64,
              max_fan_width: 64,
              max_iterations: 1,
              scope: { include: ["all widget colors"], exclude: [] },
            },
          })
        );
        expect(terminal).toMatchObject({ action: "incomplete", met: false });
        expect(JSON.stringify(terminalResult(terminal))).toContain(
          "material uncited counterexample omitted"
        );
        const reviewer = stack.client.invocations.find((call) => call.stateId === reviewState);
        if (reviewer === undefined) throw new Error("missing oracle review");
        expect(reviewer.inputArtifacts.filter((ref) => ref.phase === "researching")).toHaveLength(
          64
        );
        expect(reviewer.inputArtifacts.some((ref) => ref.kind === "research-request")).toBe(true);
        const coreRef = reviewer.inputArtifacts.find((ref) => ref.kind === "semantic-core");
        if (coreRef === undefined) throw new Error("missing oracle core");
        const core = validateCanonicalGroundedSynthesisBytes(
          stack.artifacts.readById(coreRef.artifact_id),
          coreRef
        );
        expect(core.provenance.evidence_artifacts).toHaveLength(1);
        expect(core.contradictions).toEqual([]);
        expect(terminalResult(terminal)["product_envelope_ref"]).toBeUndefined();
      } finally {
        stack.artifacts.close();
        stack.checkpointer.close();
      }
    }
  );

  it("renders every golden claim with support and bidirectional claim/evidence/source navigation", () => {
    const fixture = new URL("./fixtures/research-p3-render-golden/", import.meta.url);
    const core = validateCanonicalGroundedSynthesisBytes(
      readFileSync(new URL("core.json", fixture))
    );
    const manifest = requireRecord(
      JSON.parse(readFileSync(new URL("manifest.json", fixture), "utf8")),
      "manifest"
    );
    const semanticCore = validateSemanticCoreRef(manifest["semantic_core"]);
    const rendered = renderResearchCompatibility({ core, semanticCore });
    expect(renderResearchCompatibility({ core, semanticCore })).toEqual(rendered);
    for (const claim of core.claims) {
      expect(rendered.report).toContain(claim.statement);
      expect(rendered.report).toContain(`<a id="${claim.claim_id}"></a>`);
      expect(rendered.report).toContain(`- Support: \`${claim.support_status}\``);
      expect(rendered.report).toContain(`- Confidence: ${claim.confidence}`);
      for (const qualification of claim.qualifications)
        expect(rendered.report).toContain(qualification);
      for (const id of claim.evidence_ids) {
        expect(rendered.report).toContain(`(sources.md#${id})`);
        expect(rendered.sources).toContain(`(report.md#${claim.claim_id})`);
      }
    }
    for (const evidence of core.evidence) {
      expect(rendered.sources).toContain(`<a id="${evidence.evidence_id}"></a>`);
      expect(rendered.sources).toContain(`(sources.md#${evidence.source_id})`);
      expect(rendered.sources).toContain(evidence.locator);
      expect(rendered.sources).toContain(evidence.evidence_artifact_id);
    }
    for (const source of core.sources) {
      expect(rendered.sources).toContain(`<a id="${source.source_id}"></a>`);
      expect(rendered.sources).toContain(source.title);
      expect(rendered.sources).toContain(source.locator);
    }
    expect(rendered.readme).toContain("[report.md](report.md)");
    expect(rendered.readme).toContain("[sources.md](sources.md)");
  });

  it.each(["legacy", "mixed", "tampered"] as const)(
    "adopts only an exact complete historical render layout on restart: %s",
    async (variant) => {
      const root = temporaryRoot();
      const runId = `historical-render-${variant}`;
      const first = runtime(root, {}, (point) => {
        if (point === "validating:grounding-receipt-persistence")
          throw new ResearchHostInterruptionError(point);
      });
      try {
        await expect(
          new OrchestrationRunner(first.engine, first.workers).runUntilBoundary(
            first.engine.handle(start(root, runId, "quick"))
          )
        ).rejects.toThrow(ResearchHostInterruptionError);
        const run = first.checkpointer.loadRunById(runId);
        if (run === undefined) throw new Error("missing historical render checkpoint");
        const coreRef = run.selectedArtifacts.find((ref) => ref.kind === "semantic-core");
        if (coreRef === undefined) throw new Error("missing historical core");
        const core = validateCanonicalGroundedSynthesisBytes(
          first.artifacts.readById(coreRef.artifact_id),
          coreRef
        );
        const semanticCore = validateSemanticCoreRef({
          schema_version: 1,
          schema_id: "penny.grounded-synthesis.v1",
          product_schema_version: 1,
          artifact_ref: coreRef,
          sha256: coreRef.content_digest,
        });
        const legacy = renderResearchCompatibility({ core, semanticCore, layout: "legacy" });
        const current = renderResearchCompatibility({ core, semanticCore });
        const body = {
          schema_version: 1,
          renderer_id: "penny.research.compat-markdown.v1",
          operation_identity: `research-render:${sha256(runId).slice(0, 32)}:${coreRef.artifact_id}`,
          receipt_time: "2026-08-26T00:00:00Z",
          target_directory: path.relative(root, compatibilityDirectory(root)),
          semantic_core: semanticCore,
          targets: (["report", "sources", "readme"] as const).map((name) => {
            const content =
              variant === "mixed" && name === "report"
                ? current[name]
                : variant === "tampered" && name === "report"
                  ? legacy[name] + "Invented claim.\n"
                  : legacy[name];
            return {
              render_name: name,
              target_relative_path: name === "readme" ? "README.md" : `${name}.md`,
              content,
              content_sha256: sha256(content),
              byte_length: Buffer.byteLength(content),
            };
          }),
        };
        // Seed the exact orphan operation a historical binary would have persisted.
        // Recovery must adopt it, not mutate it or substitute newly rendered bytes.
        first.artifacts.persist({
          metadata: {
            schema_version: 2,
            run_id: runId,
            phase: "rendering",
            branch_id: null,
            kind: "render-intent",
            operation_id: `research-render-intent:${sha256(runId).slice(0, 32)}`,
            version: 1,
            producer: "host:compat-renderer",
            media_type: "application/json",
            parent_ref: null,
            upstream_refs: [coreRef],
          },
          content: canonicalJson(body),
        });
      } finally {
        first.artifacts.close();
        first.checkpointer.close();
      }
      const resumed = runtime(root);
      try {
        const terminal = await new OrchestrationRunner(
          resumed.engine,
          resumed.workers
        ).runUntilBoundary(
          resumed.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
        );
        expect(terminal).toMatchObject({
          action: variant === "legacy" ? "complete" : "incomplete",
          met: variant === "legacy",
        });
        expect(resumed.client.invocations).toEqual([]);
        if (variant === "legacy") {
          const run = resumed.checkpointer.loadRunById(runId);
          const coreRef = run?.selectedArtifacts.find((ref) => ref.kind === "semantic-core");
          if (coreRef === undefined) throw new Error("missing replay core");
          const core = validateCanonicalGroundedSynthesisBytes(
            resumed.artifacts.readById(coreRef.artifact_id),
            coreRef
          );
          const semanticCore = validateSemanticCoreRef({
            schema_version: 1,
            schema_id: "penny.grounded-synthesis.v1",
            product_schema_version: 1,
            artifact_ref: coreRef,
            sha256: coreRef.content_digest,
          });
          const expected = renderResearchCompatibility({ core, semanticCore, layout: "legacy" });
          expect(readFileSync(path.join(compatibilityDirectory(root), "report.md"), "utf8")).toBe(
            expected.report
          );
          expect(readFileSync(path.join(compatibilityDirectory(root), "sources.md"), "utf8")).toBe(
            expected.sources
          );
          expect(readFileSync(path.join(compatibilityDirectory(root), "README.md"), "utf8")).toBe(
            expected.readme
          );
        }
        expect(
          resumed.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
        ).toEqual(terminal);
      } finally {
        resumed.artifacts.close();
        resumed.checkpointer.close();
      }
    }
  );

  it("documents every active input port, including contextual evidence", () => {
    const registration = PLAYBOOK_REGISTRY.get("research");
    if (registration === undefined) throw new Error("Research registration missing");
    const reference = readFileSync(
      new URL("../../../.pi/skills/research/resources/reference.md", import.meta.url),
      "utf8"
    );
    const table = reference.split("## Closed request and ports")[1]?.split("## Presets")[0];
    if (table === undefined) throw new Error("reference port table missing");
    const documented = table
      .split("\n")
      .map((line) => line.split("|").map((cell) => cell.trim()))
      .filter((cells) => cells[2] === "input")
      .map((cells) => cells[1]);
    expect(documented.sort()).toEqual(
      [
        "`request`",
        ...registration.contract.io.input_ports.map((port) => `\`${port.name}\``),
      ].sort()
    );
  });
});

describe("P3 semantic product activation", () => {
  it.each([
    ["quick", ["researching", "synthesizing", "validating"]],
    ["standard", ["planning", "researching", "researching", "synthesizing", "validating"]],
    [
      "deep",
      [
        "planning",
        "critiquing_plan",
        "researching",
        "researching",
        "synthesizing",
        "validating",
        "critiquing_report",
      ],
    ],
  ] as const)(
    "completes %s with latest core, graph, renders, and exact topology",
    async (mode, expectedStates) => {
      const root = temporaryRoot();
      const stack = runtime(root);
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, `run-p3-${mode}`, mode))
      );
      expect(terminal).toMatchObject({ action: "complete", met: true, status: "complete" });
      expect(stack.client.states).toEqual(expectedStates);
      const result = terminalResult(terminal);
      const output = requireRecord(result["output_artifact_ref"], "terminal semantic core");
      expect(output["kind"]).toBe("semantic-core");
      expect(output["phase"]).toBe("sealing_core");
      expect(result["product_envelope_ref"]).toMatchObject({ kind: "product-envelope" });
      expect(result["report_files"]).toEqual(
        ["report.md", "sources.md", "README.md"].map((file) =>
          path.join(runCompatibilityDirectory(root, `run-p3-${mode}`), file)
        )
      );
      const visits = stack.checkpointer
        .stateVisits(`run-p3-${mode}`)
        .map((visit) => visit.state_id);
      expect(visits).toContain("sealing_core");
      expect(visits.at(-1)).toBe("rendering");
      expect(visits.indexOf("synthesizing")).toBeLessThan(visits.indexOf("sealing_core"));
      expect(visits.indexOf("sealing_core")).toBeLessThan(visits.indexOf("validating"));
      if (mode === "deep") {
        expect(visits.indexOf("validating")).toBeLessThan(visits.lastIndexOf("critiquing_report"));
      }
      const synthesisTask = stack.client.synthesisTasks.at(-1);
      if (synthesisTask === undefined) throw new Error("semantic drafting task was not captured");
      expect(synthesisTask).toContain(
        `MECHANICALLY_PROJECTED_RESEARCH_SEMANTIC_DRAFT_CONTRACT:${researchSemanticDraftPromptContract()}`
      );
      expect(synthesisTask).toContain("OWNER_SELECTED_EVIDENCE_SLOTS:");
      expect(synthesisTask).toContain("one closed ResearchSemanticDraftV1 JSON value");
      expect(synthesisTask).toContain("do not emit request/provenance fields");
      expect(synthesisTask).not.toContain("GroundedSynthesisV1 candidate");
      expect(synthesisTask).not.toContain("first line(s)");
      const selected = stack.checkpointer.loadRunById(`run-p3-${mode}`)?.selectedArtifacts ?? [];
      for (const artifact of selected.filter((ref) => ref.phase === "researching")) {
        expect(synthesisTask).toContain(artifact.artifact_id);
      }
      const requestRef = selected.find((artifact) => artifact.phase === "intake");
      if (requestRef === undefined) throw new Error("admitted request ref is absent");
      expect(synthesisTask).not.toContain(requestRef.content_digest);
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  );

  it("preserves one EvidenceContext ref without flattening the native request, core, or task prose", async () => {
    const root = temporaryRoot();
    const runId = "run-p3-evidence-context";
    const stack = runtime(root);
    const evidenceContext = persistEvidenceContext(stack.artifacts, "research-playbook");
    const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
      stack.engine.handle(
        start(root, runId, "deep", {
          schema_version: 2,
          artifacts: [{ slot: "evidence_context", ref: evidenceContext.ref }],
        })
      )
    );
    expect(terminal.action).toBe("complete");
    const run = stack.checkpointer.loadRunById(runId);
    if (run === undefined) throw new Error("completed Research run is absent");
    const requestRef = run.selectedArtifacts.find(
      (artifact) => artifact.kind === "research-request" && artifact.phase === "intake"
    );
    if (requestRef === undefined) throw new Error("admitted ResearchRequestV1 ref is absent");
    const nativeRequest = validateResearchRequest(
      JSON.parse(stack.artifacts.readById(requestRef.artifact_id).toString("utf8"))
    );
    expect(nativeRequest.schema_id).toBe("penny.research-request.v1");
    expect(nativeRequest.question).toBe("What does P3 activate?");
    expect(nativeRequest.mode).toBe("deep");
    expect(nativeRequest.input_products).toEqual([]);
    expect(stack.artifacts.metadata(requestRef).upstream_refs).toEqual([evidenceContext.ref]);

    const result = terminalResult(terminal);
    const output = requireRecord(result["output_artifact_ref"], "terminal semantic core");
    const outputRef = stack.artifacts.refById(String(output["artifact_id"]));
    if (outputRef === undefined) throw new Error("terminal GroundedSynthesisV1 ref is absent");
    const core = validateCanonicalGroundedSynthesisBytes(
      stack.artifacts.readById(outputRef.artifact_id),
      outputRef
    );
    expect(core.request.normalized_question).toBe(nativeRequest.question);
    expect(core.provenance.context_trace_sha256).toBe(sha256(canonicalJson([evidenceContext.ref])));
    expect(
      core.provenance.evidence_artifacts.some(
        (artifact) => artifact.artifact_id === evidenceContext.ref.artifact_id
      )
    ).toBe(false);
    expect(
      stack.artifacts
        .metadata(outputRef)
        .upstream_refs.filter(
          (artifact) => artifact.artifact_id === evidenceContext.ref.artifact_id
        )
    ).toEqual([evidenceContext.ref]);

    expect(stack.client.states).toEqual([
      "planning",
      "critiquing_plan",
      "researching",
      "researching",
      "synthesizing",
      "validating",
      "critiquing_report",
    ]);
    for (const invocation of stack.client.invocations) {
      expect(
        invocation.inputArtifacts.filter(
          (artifact) => artifact.artifact_id === evidenceContext.ref.artifact_id
        )
      ).toEqual([evidenceContext.ref]);
      expect(invocation.task).not.toContain(evidenceContext.statementMarker);
    }
    stack.artifacts.close();
    stack.checkpointer.close();
  });

  it("rejects an empty semantic-draft turn before persistence or routing repair", async () => {
    const root = temporaryRoot();
    const runId = "run-p4-empty-semantic-draft";
    const stack = runtime(root, { emptySynthesis: true });
    await expect(
      new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, runId, "quick"))
      )
    ).rejects.toThrow(/no non-empty final assistant text/u);
    const run = stack.checkpointer.loadRunById(runId);
    expect(run?.stateId).toBe("synthesizing");
    expect(run?.pendingDirective?.action).toBe("invoke_agent");
    expect(
      run?.selectedArtifacts.filter((artifact) =>
        ["synthesizing", "sealing_core", "validating", "rendering", "product-envelope"].includes(
          artifact.phase
        )
      )
    ).toEqual([]);
    expect(
      run?.selectedArtifacts.some((artifact) =>
        ["semantic-core", "product-envelope", "deterministic-render"].includes(artifact.kind)
      )
    ).toBe(false);
    expect(
      stack.checkpointer.events(runId).some((event) => event.eventType.startsWith("routing_repair"))
    ).toBe(false);
    stack.artifacts.close();
    stack.checkpointer.close();
  });

  it("keeps terminal truth and completion-gate digest equal across context modes", async () => {
    const documentContent = "P4 normative document context.";
    const kbContent = "P4 private approved advisory context sentinel.";
    const documentBinding = {
      slot: "domain_guidance",
      binding_kind: "versioned_document",
      selected_by: "caller",
      source_id: "p4-document-source",
      document_id: "p4-document",
      revision_id: "p4-document-revision",
      expected_sha256: sha256(documentContent),
    } as const;
    const kbBinding = {
      slot: "standard_guidance",
      binding_kind: "approved_kb_result",
      selected_by: "host",
      source_id: "p4-kb-source",
      kb_profile_id: "p4-kb-profile",
      result_id: "p4-approved-result",
      expected_sha256: sha256(kbContent),
    } as const;
    const documentResolution: ResearchContextProviderHandlersV2["admission_resolutions"][number] = {
      schema_id: "penny.research-context-resolution.v2",
      schema_version: 2,
      source_kind: "versioned_document",
      source_id: "p4-document-source",
      content: documentContent,
      media_type: "text/markdown",
      role: "normative",
      scope_id: "p4-context-scope",
      revision: {
        kind: "document",
        document_id: "p4-document",
        revision_id: "p4-document-revision",
      },
      freshness: { status: "not_time_sensitive" },
      upstream_locators: [
        { source_id: "p4-document-source", locator: "https://example.invalid/p4-document" },
      ],
      provider: {
        provider_id: "p4-document-provider",
        configuration_sha256: "a".repeat(64),
        eligibility_record_id: "p4-document-eligibility",
        eligibility_sha256: "b".repeat(64),
      },
      verification_disposition: "accepted_for_scope",
      conflict: { status: "none" },
      eligibility: {
        status: "eligible",
        checked_at: "2026-09-01T00:00:00Z",
        valid_from: "2026-01-01T00:00:00Z",
        valid_through: "9999-12-31T23:59:59Z",
      },
      approval: { status: "not_required" },
    };
    const kbResolution: ResearchContextProviderHandlersV2["admission_resolutions"][number] = {
      schema_id: "penny.research-context-resolution.v2",
      schema_version: 2,
      source_kind: "approved_kb_result",
      source_id: "p4-kb-source",
      content: kbContent,
      media_type: "text/markdown",
      role: "advisory",
      scope_id: "p4-context-scope",
      revision: {
        kind: "approved_kb",
        kb_profile_id: "p4-kb-profile",
        result_id: "p4-approved-result",
        approval_id: "p4-kb-approval",
        approval_sha256: "e".repeat(64),
      },
      freshness: { status: "not_time_sensitive" },
      upstream_locators: [{ source_id: "p4-kb-source", locator: "kb-result:p4-approved-result" }],
      provider: {
        provider_id: "p4-kb-provider",
        configuration_sha256: "c".repeat(64),
        eligibility_record_id: "p4-kb-eligibility",
        eligibility_sha256: "d".repeat(64),
      },
      verification_disposition: "advisory_only",
      conflict: { status: "none" },
      eligibility: {
        status: "eligible",
        checked_at: "2026-09-01T00:00:00Z",
        valid_from: "2026-01-01T00:00:00Z",
        valid_through: "9999-12-31T23:59:59Z",
      },
      approval: {
        status: "approved",
        checked_at: "2026-09-01T00:00:00Z",
        valid_from: "2026-01-01T00:00:00Z",
        valid_through: "9999-12-31T23:59:59Z",
      },
    };
    const providers: ResearchContextProviderHandlersV2 = {
      resolver_contract_version: 2,
      provider_execution: "trusted_in_process",
      admission_resolutions: [documentResolution, kbResolution],
      versionedDocument: async () => documentResolution,
      approvedKbResult: async () => kbResolution,
    };
    const modes = [
      { label: "none", bindings: [], providers: undefined },
      { label: "document", bindings: [documentBinding], providers },
      { label: "approved-kb", bindings: [kbBinding], providers },
      { label: "combined", bindings: [documentBinding, kbBinding], providers },
    ] as const;
    const truth: unknown[] = [];
    const gateDigests: string[] = [];
    for (const mode of modes) {
      const root = temporaryRoot();
      const runId = `run-p4-context-${mode.label}`;
      const stack = runtime(root, {}, undefined, mode.providers);
      const request = {
        ...start(root, runId, "quick"),
        constraints: { mode: "quick", context_bindings: [...mode.bindings] },
      };
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(request)
      );
      truth.push({
        action: terminal.action,
        status: "status" in terminal ? terminal.status : undefined,
        met: "met" in terminal ? terminal.met : undefined,
        unresolved: "unresolved" in terminal ? terminal.unresolved : undefined,
      });
      const admission = stack.checkpointer.completionAdmission(runId);
      if (admission === undefined) throw new Error(`${mode.label} completion admission is absent`);
      gateDigests.push(admission.gate_digest);
      if (terminal.action !== "complete") {
        throw new Error(`${mode.label} expected complete terminal, received '${terminal.action}'`);
      }
      expect(terminal.artifacts.some((ref) => ref.kind === "semantic-core")).toBe(true);
      if (mode.label === "approved-kb" || mode.label === "combined") {
        expect(canonicalJson(terminal)).not.toContain(kbContent);
        expect(canonicalJson(stack.checkpointer.events(runId))).not.toContain(kbContent);
        for (const artifact of terminal.artifacts) {
          expect(stack.artifacts.read(artifact).toString("utf8")).not.toContain(kbContent);
        }
        const reportFiles = terminal.result.report_files;
        if (!Array.isArray(reportFiles)) throw new Error(`${mode.label} report files are absent`);
        for (const file of reportFiles) {
          expect(readFileSync(String(file), "utf8")).not.toContain(kbContent);
        }
      }
      stack.artifacts.close();
      stack.checkpointer.close();
    }
    expect(new Set(truth.map((value) => canonicalJson(value))).size).toBe(1);
    expect(new Set(gateDigests).size).toBe(1);
  });

  it.each([
    [
      "evidence",
      { validationFailures: ["evidence"] },
      ["validating", "researching", "synthesizing", "validating"],
    ],
    [
      "synthesis",
      { validationFailures: ["synthesis"] },
      ["validating", "synthesizing", "validating"],
    ],
    ["core sealing", { sealFailures: 1 }, ["synthesizing", "synthesizing", "validating"]],
  ] as const)(
    "routes one %s repair through typed drafting, sealing, and Vera",
    async (_name, options, suffix) => {
      const root = temporaryRoot();
      const stack = runtime(root, options);
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, `run-p3-repair-${_name.replace(/ /gu, "-")}`, "standard"))
      );
      expect(terminal).toMatchObject({ action: "complete", met: true });
      expect(stack.client.states.slice(-suffix.length)).toEqual(suffix);
      if (_name !== "core sealing") {
        const syntheses = stack.client.invocations.filter(
          (invocation) => invocation.stateId === "synthesizing"
        );
        const validators = stack.client.invocations.filter(
          (invocation) => invocation.stateId === "validating"
        );
        const firstValidator = validators[0];
        const repairedSynthesis = syntheses.at(-1);
        const nextValidator = validators.at(-1);
        if (
          firstValidator === undefined ||
          repairedSynthesis === undefined ||
          nextValidator === undefined
        ) {
          throw new Error("validation repair invocations are absent");
        }
        const priorCore = firstValidator.inputArtifacts.find(
          (ref) => ref.kind === "semantic-core" && ref.phase === "sealing_core"
        );
        if (priorCore === undefined) throw new Error("prior sealed core is absent");
        const repairCores = repairedSynthesis.inputArtifacts.filter(
          (ref) => ref.kind === "semantic-core" && ref.phase === "sealing_core"
        );
        expect(repairCores).toEqual([priorCore]);
        expect(repairedSynthesis.inputArtifacts.some((ref) => ref.phase === "validating")).toBe(
          true
        );
        const newCore = nextValidator.inputArtifacts.find(
          (ref) => ref.kind === "semantic-core" && ref.phase === "sealing_core"
        );
        expect(newCore?.artifact_id).not.toBe(priorCore.artifact_id);
        expect(newCore?.artifact_id).toBe(
          requireRecord(terminalResult(terminal)["output_artifact_ref"], "terminal core")[
            "artifact_id"
          ]
        );
        expect(
          nextValidator.inputArtifacts.filter((ref) => ref.phase === "validating")
        ).toHaveLength(1);
        const evidenceSlots = (task: string) =>
          task.match(/OWNER_SELECTED_EVIDENCE_SLOTS:(\{[^\n]+\})/u)?.[1];
        const firstSlots = syntheses[0] && evidenceSlots(syntheses[0].task);
        if (firstSlots === undefined) throw new Error("first evidence slots are absent");
        const repairedSlots = evidenceSlots(repairedSynthesis.task);
        if (repairedSlots === undefined) throw new Error("repair evidence slots are absent");
        const firstEvidence = requireRecord(JSON.parse(firstSlots), "first evidence slots")[
          "evidence_artifacts"
        ];
        const repairedEvidence = requireRecord(JSON.parse(repairedSlots), "repair evidence slots")[
          "evidence_artifacts"
        ];
        if (!Array.isArray(firstEvidence) || !Array.isArray(repairedEvidence)) {
          throw new Error("evidence slot lists are absent");
        }
        expect(repairedEvidence.slice(0, firstEvidence.length)).toEqual(firstEvidence);
        expect(
          repairedEvidence.map(
            (entry) => requireRecord(entry, "evidence slot")["evidence_artifact_slot"]
          )
        ).toEqual(repairedEvidence.map((_entry, index) => index));
        expect(repairedSynthesis.task).toContain("historical review reports are feedback");
      }
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  );

  it("routes Carren quality repair through a new core and mandatory Vera re-entry", async () => {
    const root = temporaryRoot();
    const stack = runtime(root, { qualityFailures: 1 });
    const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
      stack.engine.handle(start(root, "run-p3-quality-repair", "deep"))
    );
    expect(terminal).toMatchObject({ action: "complete", met: true });
    expect(stack.client.states.slice(-5)).toEqual([
      "validating",
      "critiquing_report",
      "synthesizing",
      "validating",
      "critiquing_report",
    ]);
    const visits = stack.checkpointer
      .stateVisits("run-p3-quality-repair")
      .map((visit) => visit.state_id);
    const lastCarren = visits.lastIndexOf("critiquing_report");
    const priorVera = visits.lastIndexOf("validating", lastCarren - 1);
    const latestSeal = visits.lastIndexOf("sealing_core", lastCarren - 1);
    expect(latestSeal).toBeLessThan(priorVera);
    expect(priorVera).toBeLessThan(lastCarren);
    const syntheses = stack.client.invocations.filter(
      (invocation) => invocation.stateId === "synthesizing"
    );
    const validators = stack.client.invocations.filter(
      (invocation) => invocation.stateId === "validating"
    );
    const critiques = stack.client.invocations.filter(
      (invocation) => invocation.stateId === "critiquing_report"
    );
    const firstVera = validators[0];
    const firstCarren = critiques[0];
    const repairAuthor = syntheses[1];
    const nextVera = validators[1];
    const nextCarren = critiques[1];
    if (
      firstVera === undefined ||
      firstCarren === undefined ||
      repairAuthor === undefined ||
      nextVera === undefined ||
      nextCarren === undefined
    ) {
      throw new Error("quality repair invocations are absent");
    }
    const firstCore = firstVera.inputArtifacts.find((ref) => ref.phase === "sealing_core");
    const currentCore = nextVera.inputArtifacts.find((ref) => ref.phase === "sealing_core");
    const earlierCarren = repairAuthor.inputArtifacts.find(
      (ref) => ref.phase === "critiquing_report"
    );
    const earlierVera = repairAuthor.inputArtifacts.find((ref) => ref.phase === "validating");
    if (
      firstCore === undefined ||
      currentCore === undefined ||
      earlierCarren === undefined ||
      earlierVera === undefined
    ) {
      throw new Error("quality repair predecessors are absent");
    }
    expect(repairAuthor.inputArtifacts.filter((ref) => ref.phase === "sealing_core")).toEqual([
      firstCore,
    ]);
    expect(repairAuthor.inputArtifacts).toContainEqual(earlierVera);
    const evidenceSlots = (task: string) =>
      task.match(/OWNER_SELECTED_EVIDENCE_SLOTS:(\{[^\n]+\})/u)?.[1];
    const firstSlots = syntheses[0] && evidenceSlots(syntheses[0].task);
    if (firstSlots === undefined) throw new Error("first evidence slots are absent");
    expect(evidenceSlots(repairAuthor.task)).toBe(firstSlots);
    expect(nextVera.inputArtifacts.filter((ref) => ref.phase === "sealing_core")).toEqual([
      currentCore,
    ]);
    expect(nextVera.inputArtifacts).toContainEqual(earlierVera);
    expect(nextCarren.inputArtifacts).toContainEqual(earlierCarren);
    expect(nextCarren.inputArtifacts.filter((ref) => ref.phase === "sealing_core")).toEqual([
      currentCore,
    ]);
    expect(currentCore.artifact_id).not.toBe(firstCore.artifact_id);
    expect(
      requireRecord(terminalResult(terminal)["output_artifact_ref"], "terminal core")["artifact_id"]
    ).toBe(currentCore.artifact_id);
    expect(nextVera.task).toContain("prior PASS cannot validate the current core");
    expect(nextCarren.task).toContain("prior approval cannot approve the current core");
    stack.artifacts.close();
    stack.checkpointer.close();
  });

  it.each(["symlink", "nonregular", "postwrite-drift"] as const)(
    "returns non-positive for unsafe materialization: %s",
    async (fault) => {
      const root = temporaryRoot();
      // Inject the fault into this run's actual target, not the historical shared layout.
      const directory = runCompatibilityDirectory(root, `run-unsafe-${fault}`);
      mkdirSync(directory, { recursive: true });
      if (fault === "symlink") {
        const outside = path.join(root, "outside-report.md");
        writeFileSync(outside, "outside\n");
        symlinkSync(outside, path.join(directory, "report.md"));
      } else if (fault === "nonregular") {
        mkdirSync(path.join(directory, "report.md"));
      }
      const stack = runtime(
        root,
        {},
        fault === "postwrite-drift"
          ? (point) => {
              if (point === "rendering:directory-fsync:report") {
                writeFileSync(path.join(directory, "report.md"), "drift\n");
              }
            }
          : undefined
      );
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, `run-unsafe-${fault}`, "quick"))
      );
      expect(terminal).toMatchObject({ action: "incomplete", met: false });
      if (terminal.action === "incomplete") {
        expect(terminal.artifacts.some((artifact) => artifact.kind === "product-envelope")).toBe(
          false
        );
        expect(terminal.result.output_artifact_ref).toMatchObject({ kind: "semantic-core" });
      }
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  );

  it("rejects same-digest latest-core and graph-artifact substitution", async () => {
    const root = temporaryRoot();
    const stack = runtime(root);
    const runId = "run-p3-substitution";
    const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
      stack.engine.handle(start(root, runId, "quick"))
    );
    if (terminal.action !== "complete") throw new Error("expected complete substitution fixture");
    const context = stack.checkpointer.loadRun(identity(runId));
    const core = terminal.artifacts.find((artifact) => artifact.kind === "semantic-core");
    if (core === undefined) throw new Error("substitution fixture core is absent");
    const base = {
      checkpointer: stack.checkpointer,
      context,
      terminal,
      originState: "rendering",
      latestProduct: {
        selector: "terminal_artifact" as const,
        schema_id: "penny.grounded-synthesis.v1",
        product_schema_version: 1,
        product_id: core.artifact_id,
        sha256: core.content_digest,
      },
      artifactReader: stack.artifacts,
      projectRoot: root,
    };
    expect(evaluateResearchLatestCoreDod(base).passed).toBe(true);
    const withoutRender = {
      ...terminal,
      artifacts: terminal.artifacts.filter((artifact) => artifact.kind !== "deterministic-render"),
    };
    expect(evaluateResearchLatestCoreDod({ ...base, terminal: withoutRender }).passed).toBe(false);
    expect(
      evaluateResearchLatestCoreDod({
        ...base,
        latestProduct: {
          ...base.latestProduct,
          product_id: `art_${"0".repeat(64)}`,
        },
      }).passed
    ).toBe(false);
    stack.artifacts.close();
    stack.checkpointer.close();
  });

  it("admits disclosed qualified success but blocks a blocking core before envelope creation", async () => {
    for (const [name, options, expected] of [
      ["qualified", { qualified: true }, { action: "complete", met: true }],
      ["blocking", { blocking: true }, { action: "incomplete", met: false }],
    ] as const) {
      const root = temporaryRoot();
      const stack = runtime(root, options);
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, `run-p3-${name}`, "quick"))
      );
      expect(terminal).toMatchObject(expected);
      const result = terminalResult(terminal);
      if (name === "qualified") {
        expect(result["qualified"]).toBe(true);
      } else if (
        terminal.action === "incomplete" ||
        terminal.action === "cancelled" ||
        terminal.action === "error"
      ) {
        expect(terminal.artifacts.some((artifact) => artifact.kind === "product-envelope")).toBe(
          false
        );
      }
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  });
});

describe("Research registered seal policy", () => {
  it("binds the unspecified allowance into the runtime digest and refuses policy drift", () => {
    const registration = PLAYBOOK_REGISTRY.get("research");
    if (registration?.seal_policy === undefined) throw new Error("Research seal policy missing");
    expect(registration.seal_policy).toMatchObject({
      skill: "research",
      draft_phase: "synthesizing",
      seal_phase: "sealing_core",
      correction_limit: null,
      diagnostic_schema: "penny.seal-diagnostic.v1",
    });
    expect(registration.host_states).toContain("sealing_core");
    expect(validateRegistrationContract(registration)).toBe(registration.contract);
    const drift = {
      ...registration,
      seal_policy: { ...registration.seal_policy, correction_limit: 3 },
    };
    expect(runtimeRegistrationSha256(drift)).not.toBe(runtimeRegistrationSha256(registration));
    // Synthetic registrations remain structurally valid; the saved digest (not a
    // global name check) rejects a changed policy on a bound run.
    expect(validateRegistrationContract(drift)).toBe(registration.contract);
  });

  it("exactly replays a completed run after a seal-policy change without mutation", async () => {
    const root = temporaryRoot();
    const runId = "run-research-policy-drift";
    const stack = runtime(root);
    const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
      stack.engine.handle(start(root, runId, "quick"))
    );
    expect(terminal.action).toBe("complete");
    const before = stack.checkpointer.loadRunById(runId)?.snapshot();
    const registration = PLAYBOOK_REGISTRY.get("research");
    if (registration?.seal_policy === undefined) throw new Error("Research seal policy missing");
    const changed = {
      ...registration,
      seal_policy: { ...registration.seal_policy, correction_limit: 3 },
    };
    const driftedEngine = new OrchestrationEngine(stack.checkpointer, {
      projectRoot: root,
      maxSteps: null,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactRevisions: stack.artifacts,
      artifactStore: stack.artifacts,
      artifactReader: stack.artifacts,
      playbookRegistry: new Map([["research", changed]]),
    });
    const replay = driftedEngine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(replay).toEqual(terminal);
    expect(stack.checkpointer.loadRunById(runId)?.snapshot()).toEqual(before);
    stack.artifacts.close();
    stack.checkpointer.close();
  });

  it.each([1, 5])(
    "retains the admitted %i-attempt override across diagnostic recovery",
    async (attempts) => {
      const root = temporaryRoot();
      const runId = `run-research-budget-${attempts}`;
      let interrupted = false;
      const first = runtime(root, { sealFailures: attempts }, (point) => {
        if (point === "sealing_core:diagnostic-persistence" && !interrupted) {
          interrupted = true;
          throw new ResearchHostInterruptionError(point);
        }
      });
      await expect(
        new OrchestrationRunner(first.engine, first.workers).runUntilBoundary(
          first.engine.handle({
            ...start(root, runId, "quick"),
            constraints: {
              mode: "quick",
              budget_overrides: { max_evaluator_attempts_per_loop: attempts },
            },
          })
        )
      ).rejects.toThrow(ResearchHostInterruptionError);
      expect(interrupted).toBe(true);
      first.artifacts.close();
      first.checkpointer.close();

      const resumed = runtime(root, { sealFailures: attempts });
      const terminal = await new OrchestrationRunner(
        resumed.engine,
        resumed.workers
      ).runUntilBoundary(
        resumed.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
      );
      expect(terminal).toMatchObject({ action: "incomplete", met: false });
      // The first rejected draft was captured before the interrupted host checkpoint;
      // recovery adopts its diagnostic and charges only the allowed replacement drafts.
      expect(resumed.client.states.filter((state) => state === "synthesizing")).toHaveLength(
        attempts - 1
      );
      const diagnostics = resumed.checkpointer
        .events(runId)
        .filter((event) => event.eventType === "research_semantic_core_rejected");
      expect(diagnostics).toHaveLength(attempts);
      const projection = requireRecord(
        terminalResult(terminal)["seal_diagnostics"],
        "seal diagnostics"
      );
      expect(projection["correction_limit"]).toBe(attempts - 1);
      expect(projection["corrections_used"]).toBe(attempts - 1);
      const diagnosticRef = requireRecord(
        projection["latest_diagnostic_ref"],
        "latest diagnostic ref"
      );
      const diagnostic = requireRecord(
        JSON.parse(
          resumed.artifacts.readById(String(diagnosticRef["artifact_id"])).toString("utf8")
        ),
        "last seal diagnostic"
      );
      const registered = PLAYBOOK_REGISTRY.get("research")?.seal_policy;
      if (registered === undefined) throw new Error("Research seal policy missing");
      expect(diagnostic["policy_sha256"]).toBe(
        sealPolicySha256({ ...registered, correction_limit: attempts - 1 })
      );
      expect(
        resumed.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      resumed.artifacts.close();
      resumed.checkpointer.close();
    }
  );
});

describe("Research core diagnostics and reviewer-issue history", () => {
  it.each(["quick", "standard", "deep"] as const)(
    "keeps %s productive beyond former mode, review and seal limits",
    async (mode) => {
      const root = temporaryRoot();
      const stack = runtime(root, {
        sealFailures: 4,
        validationFailures: ["evidence", "evidence", "evidence", "evidence", "synthesis"],
        qualityFailures: mode === "deep" ? 4 : 0,
        changedCandidate: true,
      });
      const runId = `run-unlimited-research-${mode}`;
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, runId, mode))
      );
      expect(terminal).toMatchObject({ action: "complete", met: true });
      const context = stack.checkpointer.loadRun(identity(runId));
      expect(context.maxSteps).toBeNull();
      expect(context.maxIterations).toBeNull();
      expect(context.research.max_research_rounds).toBeNull();
      expect(context.research.research_round).toBe(5);
      expect(
        stack.client.states.filter((state) => state === "synthesizing").length
      ).toBeGreaterThan(8);
      const diagnostics = context.selectedArtifacts.filter((ref) => ref.kind === "seal-diagnostic");
      expect(diagnostics).toHaveLength(4);
      expect(
        JSON.parse(
          stack.artifacts.readById(diagnostics[3]?.artifact_id ?? "missing").toString("utf8")
        )
      ).toMatchObject({
        correction_limit: null,
        rejection_ordinal: 4,
        corrections_used: 3,
        disposition: "correction_offered",
      });
      expect(
        stack.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  );

  it.each([
    ["validating", { validationFailures: ["synthesis", "synthesis", "synthesis"] }],
    ["critiquing_report", { qualityFailures: 3 }],
  ] as const)(
    "stalls repeated %s candidate-plus-failure despite new artifact revisions",
    async (state, options) => {
      const root = temporaryRoot();
      const stack = runtime(root, options);
      const runId = `run-review-history-${state}`;
      const boundary = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle({
          ...start(root, runId, state === "validating" ? "standard" : "deep"),
          constraints: { mode: state === "validating" ? "standard" : "deep", max_iterations: 3 },
        })
      );
      expect(boundary).toMatchObject({ action: "incomplete", met: false });
      expect(terminalResult(boundary)["incomplete_reason"]).toBe("repair_stalled");
      expect(stack.client.states.filter((entry) => entry === state)).toHaveLength(2);
      const run = stack.checkpointer.loadRunById(runId);
      if (run === undefined) throw new Error("research checkpoint missing");
      const cores = run.selectedArtifacts.filter(
        (ref) => ref.kind === "semantic-core" && ref.phase === "sealing_core"
      );
      expect(cores).toHaveLength(2);
      expect(new Set(cores.map((ref) => ref.artifact_id)).size).toBe(2);
      expect(
        stack.client.states.filter((entry) => entry === "validating").length
      ).toBeGreaterThanOrEqual(2);
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  );

  it("binds a post-review correction to the old core and re-enters Vera and Carren before rendering", async () => {
    const root = temporaryRoot();
    const stack = runtime(root, { validationFailures: ["synthesis"], sealFailureAtCalls: [2] });
    const runId = "run-post-review-seal-correction";
    const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
      stack.engine.handle(start(root, runId, "deep"))
    );
    expect(terminal).toMatchObject({ action: "complete", met: true });
    expect(stack.client.states.filter((state) => state === "synthesizing")).toHaveLength(3);
    const validators = stack.client.invocations.filter(
      (invocation) => invocation.stateId === "validating"
    );
    expect(validators).toHaveLength(2);
    const firstCore = validators[0]?.inputArtifacts.find(
      (ref) => ref.kind === "semantic-core" && ref.phase === "sealing_core"
    );
    const latestCore = validators[1]?.inputArtifacts.find(
      (ref) => ref.kind === "semantic-core" && ref.phase === "sealing_core"
    );
    if (firstCore === undefined || latestCore === undefined)
      throw new Error("Vera core binding missing");
    expect(firstCore.artifact_id).not.toBe(latestCore.artifact_id);
    expect(stack.artifacts.metadata(latestCore).parent_ref).toEqual(firstCore);
    const quality = stack.client.invocations.filter(
      (invocation) => invocation.stateId === "critiquing_report"
    );
    expect(quality).toHaveLength(1);
    expect(
      quality[0]?.inputArtifacts.some((ref) => ref.artifact_id === latestCore.artifact_id)
    ).toBe(true);
    expect(terminalResult(terminal)["output_artifact_ref"]).toEqual(latestCore);
    const run = stack.checkpointer.loadRunById(runId);
    if (run === undefined) throw new Error("research run missing");
    const diagnosticRef = run.selectedArtifacts.find((ref) => ref.kind === "seal-diagnostic");
    if (diagnosticRef === undefined) throw new Error("post-review diagnostic missing");
    const value: unknown = JSON.parse(
      stack.artifacts.readById(diagnosticRef.artifact_id).toString("utf8")
    );
    const diagnostic = requireRecord(value, "post-review diagnostic");
    expect(diagnostic["epoch_anchor_ref"]).toEqual(firstCore);
    expect(diagnostic["rejection_ordinal"]).toBe(1);
    expect(
      quality[0]?.inputArtifacts.some((ref) => ref.artifact_id === firstCore.artifact_id)
    ).toBe(false);
    stack.artifacts.close();
    stack.checkpointer.close();
  });

  it("persists the last rejected draft's exact diagnostic under the explicit two-correction allowance", async () => {
    const root = temporaryRoot();
    const stack = runtime(root, { sealFailures: 3 });
    const runId = "run-research-final-seal-diagnostic";
    const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
      stack.engine.handle({
        ...start(root, runId, "quick"),
        constraints: { mode: "quick", max_iterations: 3 },
      })
    );
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(stack.client.states.filter((state) => state === "synthesizing")).toHaveLength(3);
    const result = terminalResult(terminal);
    const projection = requireRecord(result["seal_diagnostics"], "Research seal diagnostics");
    expect(projection["corrections_used"]).toBe(2);
    expect(projection["correction_limit"]).toBe(2);
    expect(projection["disposition"]).toBe("exhausted");
    expect(result["output_kind"]).toBe("rejected_draft");
    const latest = requireRecord(projection["latest_diagnostic_ref"], "latest diagnostic ref");
    const diagnosticRef = stack.artifacts.refById(String(latest["artifact_id"]));
    if (diagnosticRef === undefined) throw new Error("last diagnostic artifact missing");
    const value: unknown = JSON.parse(
      stack.artifacts.readById(diagnosticRef.artifact_id).toString("utf8")
    );
    const diagnostic = requireRecord(value, "last diagnostic");
    expect(diagnostic["rejection_ordinal"]).toBe(3);
    expect(diagnostic["failure_class"]).toBe("PROJECTION_INVALID");
    expect(diagnostic["rejected_draft_ref"]).toEqual(projection["rejected_draft_ref"]);
    expect(diagnostic["epoch_anchor_ref"]).toBeNull();
    const policy = PLAYBOOK_REGISTRY.get("research")?.seal_policy;
    if (policy === undefined) throw new Error("registered Research seal policy missing");
    expect(diagnostic["policy_sha256"]).toBe(sealPolicySha256({ ...policy, correction_limit: 2 }));
    expect(diagnostic["previous_diagnostic_ref"]).not.toBeNull();
    expect(
      stack.checkpointer
        .events(runId)
        .filter((event) => event.eventType === "research_semantic_core_rejected")
    ).toHaveLength(3);
    expect(
      stack.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
    stack.artifacts.close();
    stack.checkpointer.close();
  });

  it("treats corrupt exact diagnostic bytes as custody failure, not a new Synthia correction", async () => {
    const root = temporaryRoot();
    const runId = "run-research-diagnostic-corruption";
    const first = runtime(root, { sealFailures: 1 }, undefined, undefined, (event) => {
      if (event.point === "sealing_core:diagnostic-persistence")
        throw new ResearchHostInterruptionError(event.point);
    });
    await expect(
      new OrchestrationRunner(first.engine, first.workers).runUntilBoundary(
        first.engine.handle(start(root, runId, "quick"))
      )
    ).rejects.toThrow(ResearchHostInterruptionError);
    // The interrupted write is not checkpoint-selected; find the exact candidate by
    // its deterministic draft/policy address, not by scanning for a nearby artifact.
    const draft = first.checkpointer
      .loadRunById(runId)
      ?.selectedArtifacts.find((item) => item.phase === "synthesizing");
    if (draft === undefined) throw new Error("checkpointed rejected draft missing");
    const policy = PLAYBOOK_REGISTRY.get("research")?.seal_policy;
    if (policy === undefined) throw new Error("registered Research seal policy missing");
    const diagnostic = first.artifacts.refFor(
      runId,
      "sealing_core",
      null,
      "seal-diagnostic",
      sealOperationId({
        operation: "seal_diagnostic",
        run_id: runId,
        branch_id: null,
        phase: "sealing_core",
        epoch_anchor_ref: null,
        draft_ref: draft,
        policy_sha256: sealPolicySha256(policy),
      }),
      1
    );
    if (diagnostic === null) throw new Error("interrupted diagnostic missing");
    writeFileSync(
      path.join(
        root,
        "artifacts",
        "objects",
        "sha256",
        diagnostic.content_digest.slice(0, 2),
        diagnostic.content_digest.slice(2)
      ),
      "corrupt"
    );
    first.artifacts.close();
    first.checkpointer.close();
    const recovered = runtime(root, { sealFailures: 0 });
    expect(() =>
      recovered.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toThrow(/research seal diagnostic host fault/);
    expect(recovered.client.states).toEqual([]);
    expect(
      recovered.checkpointer
        .events(runId)
        .filter((event) => event.eventType === "research_semantic_core_rejected")
    ).toHaveLength(0);
    recovered.artifacts.close();
    recovered.checkpointer.close();
  });

  it("adopts a persisted diagnostic after a generic host interruption without charging another rejection", async () => {
    const root = temporaryRoot();
    const runId = "run-research-diagnostic-adoption";
    let interrupted = false;
    const first = runtime(root, { sealFailures: 1 }, undefined, undefined, (event) => {
      if (event.point === "sealing_core:diagnostic-persistence" && !interrupted) {
        interrupted = true;
        throw new ResearchHostInterruptionError(event.point);
      }
    });
    await expect(
      new OrchestrationRunner(first.engine, first.workers).runUntilBoundary(
        first.engine.handle(start(root, runId, "quick"))
      )
    ).rejects.toThrow(ResearchHostInterruptionError);
    expect(interrupted).toBe(true);
    first.artifacts.close();
    first.checkpointer.close();
    const second = runtime(root, { sealFailures: 0 });
    const terminal = await new OrchestrationRunner(second.engine, second.workers).runUntilBoundary(
      second.engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    expect(terminal).toMatchObject({ action: "complete", met: true });
    const rejected = second.checkpointer
      .events(runId)
      .filter((event) => event.eventType === "research_semantic_core_rejected");
    expect(rejected).toHaveLength(1);
    const ref = second.artifacts.refById(String(rejected[0]?.payload.diagnostic_artifact_id));
    if (ref === undefined) throw new Error("adopted diagnostic ref missing");
    expect(ref.version).toBe(1);
    second.artifacts.close();
    second.checkpointer.close();
  });
});

const RENDERING_FAULTS = [
  "sealing_core:artifact-persistence",
  "rendering:intent-persistence",
  ...(["report", "sources", "readme"] as const).flatMap((name) => [
    `rendering:render-artifact-persistence:${name}`,
    `rendering:prewrite:${name}`,
    `rendering:partial-temporary-write:${name}`,
    `rendering:file-fsync:${name}`,
    `rendering:rename:${name}`,
    `rendering:directory-fsync:${name}`,
  ]),
  "rendering:validation-receipt-persistence",
  "rendering:envelope-persistence",
  "rendering:final-checkpoint-admission",
] as const;

describe("P3 deterministic host crash recovery", () => {
  it("cooperatively cancels from a persisted host phase with the best exact core", async () => {
    const root = temporaryRoot();
    const runId = "run-host-cancel";
    const first = runtime(root, {}, (point) => {
      if (point === "rendering:intent-persistence") {
        throw new ResearchHostInterruptionError(point);
      }
    });
    await expect(
      new OrchestrationRunner(first.engine, first.workers).runUntilBoundary(
        first.engine.handle(start(root, runId, "quick"))
      )
    ).rejects.toThrow(ResearchHostInterruptionError);
    first.artifacts.close();
    first.checkpointer.close();

    const resumed = runtime(root);
    const cancelled = resumed.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity(runId),
      reason: "cancel deterministic host phase",
    });
    expect(cancelled).toMatchObject({ action: "cancelled", met: false });
    if (cancelled.action === "cancelled") {
      expect(cancelled.result.output_artifact_ref).toMatchObject({ kind: "semantic-core" });
      expect(cancelled.artifacts.some((artifact) => artifact.kind === "product-envelope")).toBe(
        false
      );
    }
    expect(
      resumed.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      })
    ).toEqual(cancelled);
    resumed.artifacts.close();
    resumed.checkpointer.close();
  });

  it.each(RENDERING_FAULTS)("converges after %s", async (faultPoint) => {
    const root = temporaryRoot();
    const runId = `run-fault-${sha256(faultPoint).slice(0, 16)}`;
    let interrupted = false;
    const first = runtime(root, {}, (point) => {
      if (!interrupted && point === faultPoint) {
        interrupted = true;
        throw new ResearchHostInterruptionError(point);
      }
    });
    await expect(
      new OrchestrationRunner(first.engine, first.workers).runUntilBoundary(
        first.engine.handle(start(root, runId, "quick"))
      )
    ).rejects.toThrow(ResearchHostInterruptionError);
    expect(interrupted).toBe(true);
    first.artifacts.close();
    first.checkpointer.close();

    const recovered = runtime(root);
    const resumed = recovered.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    const terminal = await new OrchestrationRunner(
      recovered.engine,
      recovered.workers
    ).runUntilBoundary(resumed);
    expect(terminal).toMatchObject({ action: "complete", status: "complete", met: true });
    const replay = recovered.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(canonicalJson(replay)).toBe(canonicalJson(terminal));
    const result = terminalResult(terminal);
    const files = result["report_files"];
    if (!Array.isArray(files)) throw new Error("recovered report files are malformed");
    const filePaths = files.map((file) => {
      if (typeof file !== "string") throw new Error("recovered report file is not a path");
      return file;
    });
    const firstBytes = filePaths.map((file) => readFileSync(file));
    const secondReplay = recovered.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(canonicalJson(secondReplay)).toBe(canonicalJson(terminal));
    expect(filePaths.map((file) => readFileSync(file))).toEqual(firstBytes);
    recovered.artifacts.close();
    recovered.checkpointer.close();
  });
});
