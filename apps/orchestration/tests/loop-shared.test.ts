import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../dist/artifact-store.js";
import { Checkpointer, canonicalJson, sha256 } from "../dist/checkpointer.js";
import {
  validateDirective,
  type Confidence,
  type Directive,
  type JsonValue,
  type PhaseResult,
  type RunIdentity,
  type SkillContract,
} from "../dist/contracts.js";
import type { RunContext } from "../dist/context.js";
import { OrchestrationEngine } from "../dist/engine.js";
import type { Playbook } from "../dist/playbooks/playbook.js";
import {
  runtimeRegistrationSha256,
  validateRegistrationContract,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { RESEARCH_SKILL_CONTRACT } from "../dist/playbooks/research.js";
import { trustedInvocationDigest } from "../dist/receipts.js";
import { researchLivenessPolicy } from "../dist/liveness.js";
import { validateSourceRoutingSummary } from "../dist/source-routing-summary.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

function isSqliteModule(value: unknown): value is typeof import("node:sqlite") {
  return (
    value !== null &&
    typeof value === "object" &&
    "DatabaseSync" in value &&
    typeof value.DatabaseSync === "function"
  );
}
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const identity: RunIdentity = {
  schema_version: 2,
  run_id: "loop-shared-run",
  session_id: "loop-shared-session",
  playbook: "loop-shared-fixture",
  engine_owner: "typescript",
};
const contract: SkillContract = {
  ...RESEARCH_SKILL_CONTRACT,
  name: identity.playbook,
  repair_routing: {
    schema_version: 1,
    routes: [
      {
        schema_version: 1,
        origin_state: "review",
        feedback_kind: "product_gap",
        repair: { action: "transition", target_state: "review" },
        budget: { counter: "iteration", limit_source: "run.max_iterations", reserved_attempts: 0 },
        on_exhaustion: { action: "transition", target_state: "review", reset_counter: false },
      },
    ],
  },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: ["review"],
    required_visited_states: ["review"],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: "penny.loop-shared.result",
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "allow_any" },
  },
};
const schema = Type.Object(
  {
    verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL"), Type.Literal("UNVERIFIABLE")]),
    candidate: Type.String(),
    checks: Type.Array(Type.String()),
  },
  { additionalProperties: false }
);
const failed = (candidate = "candidate-A") => ({
  verdict: "FAIL",
  candidate,
  checks: ["criterion-1"],
});
const unknown = { verdict: "UNVERIFIABLE", candidate: "candidate-A", checks: ["criterion-1"] };
function footer(details: Record<string, JsonValue>, confidence: Confidence = "CERTAIN"): string {
  return `Exact fixture report\nSUMMARY:${JSON.stringify({ confidence, ...details })}`;
}
function terminal(
  context: RunContext,
  action: "complete" | "incomplete" | "cancelled",
  reason: string
): Directive {
  const next = validateDirective({
    schema_version: 2,
    action,
    identity: context.identity,
    status: action,
    met: action === "complete",
    result: {
      reason,
      best_partial_artifact_refs: context.selectedArtifacts.filter(
        (ref) => ref.kind === "partial-product"
      ),
    },
    artifacts: context.selectedArtifacts,
    unresolved: action === "complete" ? [] : [reason],
  });
  context.status = action;
  context.met = action === "complete";
  context.pendingDirective = next;
  context.terminalDirective = next;
  return next;
}
interface Options {
  preserve?: boolean;
  progress?: boolean;
  parallel?: boolean;
  missing?: "fingerprint" | "terminal" | "evaluation";
  fingerprint?: "invalid" | "null";
  positiveStall?: boolean;
  binaryVerdicts?: boolean;
  oneBranch?: boolean;
}
class FixturePlaybook implements Playbook {
  constructor(private readonly options: Options) {
    if (options.missing === "evaluation") delete this.evaluateRepair;
    if (options.missing === "fingerprint") delete this.repairProgressFingerprint;
    if (options.missing === "terminal") delete this.terminalizeRepairStall;
  }
  initialize(context: RunContext): Directive {
    context.transition("review");
    return this.dispatch(context);
  }
  dispatch(context: RunContext): Directive {
    const assignment = (branch: string | null) => ({
      state_id: "review",
      agent: "vera",
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      task: "Review the exact fixture candidate.",
      input_artifacts: { schema_version: 2, artifacts: [] },
      output_artifact: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: "review",
        branch_id: branch,
        kind: "agent-output",
        operation_id: `review-${context.stepCount}-${branch ?? "single"}`,
        version: 1,
        producer: "agent:vera",
        media_type: "text/plain",
        parent_ref: null,
        upstream_refs: [],
      },
    });
    const next = this.options.parallel
      ? validateDirective({
          schema_version: 2,
          action: "invoke_agents_parallel",
          identity: context.identity,
          state_id: "review",
          branches: (this.options.oneBranch
            ? [context.iteration % 2 === 0 ? "left" : "right"]
            : ["left", "right"]
          ).map((branch_id) => ({ ...assignment(branch_id), branch_id })),
        })
      : validateDirective({
          schema_version: 2,
          action: "invoke_agent",
          identity: context.identity,
          ...assignment(null),
        });
    context.pendingDirective = next;
    if (next.action === "invoke_agents_parallel")
      context.pendingBranches = next.branches.map((branch) => ({
        branch_id: branch.branch_id,
        state_id: branch.state_id,
        agent: branch.agent,
        attempt: branch.attempt,
        completed: false,
        confidence: null,
        result: null,
        artifact: null,
      }));
    return next;
  }
  resume(context: RunContext): Directive {
    return this.dispatch(context);
  }
  cancel(context: RunContext): Directive {
    return terminal(context, "cancelled", "operator cancellation");
  }
  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
  acceptSummary(context: RunContext, details: Record<string, JsonValue>): Directive {
    return terminal(
      context,
      details.verdict === "PASS" ? "complete" : "incomplete",
      "accepted source judgment"
    );
  }
  aggregateBranches(details: readonly Record<string, JsonValue>[]): Record<string, JsonValue> {
    const failure = details.find((value) => value.verdict !== "PASS");
    const result = failure ?? details[0];
    if (result === undefined) throw new Error("missing aggregate result");
    return result;
  }
  evaluateRepair?: NonNullable<Playbook["evaluateRepair"]> = (_context, _state, details) =>
    details.verdict !== "FAIL"
      ? null
      : {
          schema_version: 2,
          kind: "product_gap",
          detail: canonicalJson(details.checks),
          findings: [],
          strategy_delta: `Revise candidate using check evidence ${details.candidate}`,
        };
  repairProgressFingerprint?: NonNullable<Playbook["repairProgressFingerprint"]> = (
    _context,
    _state,
    details
  ) =>
    this.options.fingerprint === "invalid"
      ? "not-a-sha256"
      : this.options.fingerprint === "null"
        ? null
        : sha256(canonicalJson({ candidate: details.candidate, checks: details.checks }));
  terminalizeRepairStall?: NonNullable<Playbook["terminalizeRepairStall"]> = (context) =>
    terminal(
      context,
      this.options.positiveStall ? "complete" : "incomplete",
      "measured exact recurrence; not budget exhaustion"
    );
  routingRepair(context: RunContext, original: PhaseResult): Directive {
    context.stepCount += 1;
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: original.state_id,
      agent: original.agent,
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      task: "Repair routing metadata only, preserving the exact SUMMARY.",
      execution_purpose: "routing_repair",
      routing_repair_binding: {
        schema_version: 1,
        source_receipt_id: original.worker_receipt.receipt_id,
        source_result_sha256: sha256(canonicalJson(original)),
        source_state_id: original.state_id,
        source_branch_id: original.branch_id ?? null,
        source_agent: original.agent,
        source_attempt: original.attempt,
        source_artifact_ref: original.output_artifact,
      },
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "source", ref: original.output_artifact }],
      },
      output_artifact: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: original.state_id,
        branch_id: null,
        kind: "routing-metadata",
        operation_id: `repair-${original.output_artifact.artifact_id}`,
        version: 1,
        producer: "agent:vera",
        media_type: "text/plain",
        parent_ref: null,
        upstream_refs: [original.output_artifact],
      },
    });
    context.pendingDirective = next;
    return next;
  }
}
function registration(options: Options): PlaybookRegistration {
  return {
    name: identity.playbook,
    contract,
    ingress: "dedicated_tool",
    liveness: {
      resolver_id: contract.budget_policy.resolver_id,
      resolve: () => researchLivenessPolicy("standard"),
      thinking_policy: "agent_ssot",
    },
    ...(options.progress ? { repair_progress_policy: "exact_fingerprint_v1" } : {}),
    worker: {
      kind: "catalog-agent",
      workflow_name: identity.playbook,
      guidance: contract.guidance,
      guidance_required: true,
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
      phases: new Map([
        [
          "review",
          {
            agent: "vera",
            result_schema_id: "penny.loop-shared.summary",
            result_schema_version: 1,
            schema: options.binaryVerdicts
              ? Type.Object(
                  {
                    ...schema.properties,
                    verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]),
                  },
                  { additionalProperties: false }
                )
              : schema,
            ...(options.preserve
              ? { routing_repair_policy: "preserve_source_summary_v1" as const }
              : {}),
          },
        ],
      ]),
    },
    completionReceiptPredicates: new Map(),
    construct: () => new FixturePlaybook(options),
  };
}
function open(root: string, options: Options) {
  const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactStore: artifacts,
    artifactReader: artifacts,
    artifactRevisions: artifacts,
    playbookName: identity.playbook,
    playbookRegistration: registration(options),
  });
  return { root, checkpointer, artifacts, engine };
}
function setup(options: Options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "penny-loop-shared-"));
  roots.push(root);
  const runtime = open(root, options);
  const first = runtime.engine.handle({
    schema_version: 2,
    action: "start",
    identity,
    goal: "Fixture shared repair contracts",
    constraints: {},
    project_root: root,
    trust_profile: "trusted-interactive",
  });
  // A real immutable partial, selected before result acceptance; not invented by terminalization.
  const partial = runtime.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: identity.run_id,
      phase: "review",
      branch_id: null,
      kind: "partial-product",
      operation_id: "best-partial",
      version: 1,
      producer: "host:fixture",
      media_type: "text/plain",
      parent_ref: null,
      upstream_refs: [],
    },
    content: "best partial candidate",
  });
  const context = runtime.checkpointer.loadRun(identity);
  context.selectedArtifacts.push(partial);
  runtime.checkpointer.saveRun(context, "fixture_partial_selected", {});
  return { ...runtime, first, partial };
}
type Runtime = ReturnType<typeof open>;
function result(
  runtime: Runtime,
  pending: Directive,
  details: Record<string, JsonValue>,
  options: {
    text?: string;
    branch?: string;
    confidence?: Confidence;
  } = {}
): PhaseResult {
  const assignment =
    pending.action === "invoke_agent"
      ? pending
      : pending.action === "invoke_agents_parallel"
        ? pending.branches.find((branch) => branch.branch_id === options.branch)
        : undefined;
  if (assignment === undefined) throw new Error("expected exact worker assignment");
  const branchId = options.branch ?? null;
  const output = runtime.artifacts.persist({
    metadata: assignment.output_artifact,
    content: options.text ?? footer(details),
  });
  const binding = assignment.routing_repair_binding;
  const worker_receipt = runtime.engine.receiptAuthority.sign({
    schema_version: 2,
    receipt_id: `receipt-${assignment.attempt}-${branchId ?? "single"}`,
    run_id: identity.run_id,
    state_id: assignment.state_id,
    branch_id: branchId,
    agent: assignment.agent,
    attempt: assignment.attempt,
    worker_id: "fixture-worker",
    executor: "pi-sdk",
    command: ["pi-sdk", assignment.agent],
    model: null,
    working_directory: runtime.root,
    trust_profile: assignment.trust_profile,
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:00.000Z",
    exit_code: 0,
    output_digest: output.content_digest,
    output_artifact_ref: output,
    trusted_invocation_digest: trustedInvocationDigest({
      identity,
      state_id: assignment.state_id,
      branch_id: branchId,
      agent: assignment.agent,
      attempt: assignment.attempt,
      trust_profile: assignment.trust_profile,
      model_override: null,
      task_sha256: sha256(assignment.task),
      input_artifacts: assignment.input_artifacts,
      output_artifact: assignment.output_artifact,
      ...(binding === undefined
        ? {}
        : {
            execution_purpose: "routing_repair",
            routing_repair_binding_sha256: sha256(canonicalJson(binding)),
          }),
    }),
  });
  return {
    schema_version: 2,
    run_id: identity.run_id,
    state_id: assignment.state_id,
    agent: assignment.agent,
    attempt: assignment.attempt,
    ...(branchId === null ? {} : { branch_id: branchId }),
    confidence: options.confidence ?? "CERTAIN",
    details,
    output_artifact: output,
    worker_receipt,
  };
}
const step = (runtime: Runtime, value: PhaseResult) =>
  runtime.engine.handle({ schema_version: 2, action: "step", identity, result: value });
const recover = (runtime: Runtime) =>
  runtime.engine.handle({ schema_version: 2, action: "recover", identity });
function close(runtime: Runtime) {
  runtime.checkpointer.close();
  runtime.artifacts.close();
}
function routeEvidence(runtime: Runtime) {
  return runtime.checkpointer
    .events(identity.run_id)
    .flatMap((event) =>
      event.payload.feedback_route_evidence_v1 === undefined
        ? []
        : [event.payload.feedback_route_evidence_v1]
    );
}

describe("strict pure source SUMMARY preservation", () => {
  it("validates complete meaning independently and preserves arrays, confidence and field values", () => {
    const source = Buffer.from(footer(unknown));
    expect(validateSourceRoutingSummary(source, schema)).toEqual({
      confidence: "CERTAIN",
      details: unknown,
    });
    expect(
      validateSourceRoutingSummary(source, schema, {
        confidence: "CERTAIN",
        details: { checks: unknown.checks, candidate: unknown.candidate, verdict: unknown.verdict },
      })
    ).toBeDefined();
    for (const details of [
      { ...unknown, verdict: "FAIL" },
      { ...unknown, verdict: "PASS" },
      { ...unknown, checks: [] },
      { ...unknown, candidate: "other" },
    ])
      expect(
        validateSourceRoutingSummary(source, schema, { confidence: "CERTAIN", details })
      ).toBeUndefined();
    expect(
      validateSourceRoutingSummary(source, schema, { confidence: "PROBABLE", details: unknown })
    ).toBeUndefined();
  });
  it("rejects reordered arrays, nested duplicate keys, and invalid UTF-8", () => {
    const ordered = { ...unknown, checks: ["first", "second"] };
    expect(
      validateSourceRoutingSummary(Buffer.from(footer(ordered)), schema, {
        confidence: "CERTAIN",
        details: { ...ordered, checks: ["second", "first"] },
      })
    ).toBeUndefined();
    const nested = Type.Object(
      { payload: Type.Record(Type.String(), Type.String()) },
      { additionalProperties: false }
    );
    expect(
      validateSourceRoutingSummary(
        Buffer.from('SUMMARY:{"confidence":"CERTAIN","payload":{"key":"one","key":"two"}}'),
        nested
      )
    ).toBeUndefined();
    expect(
      validateSourceRoutingSummary(
        Buffer.concat([Buffer.from([0xff]), Buffer.from(footer(unknown))]),
        schema
      )
    ).toBeUndefined();
  });
  it.each([
    "Report only",
    'SUMMARY:{"verdict":"PASS","candidate":"A","checks":[]}',
    `${footer(unknown)}\n${footer(failed())}`,
    `${footer(unknown)}\ntrailing prose`,
    'SUMMARY:{"confidence":"CERTAIN","verdict":"UNVERIFIABLE","verdict":"PASS","candidate":"A","checks":[]}',
    'SUMMARY:{"confidence":"CERTAIN","verdict":"UNVERIFIABLE","\\u0076erdict":"PASS","candidate":"A","checks":[]}',
    footer({ ...unknown, extra: true }),
    `\ufeff${footer(unknown)}`,
    `${footer(unknown)}\n\n`,
  ])("rejects missing/ambiguous/invalid original without inventing a verdict: %s", (text) => {
    expect(validateSourceRoutingSummary(Buffer.from(text), schema)).toBeUndefined();
  });
});

describe("real engine source-preserving metadata repair", () => {
  it.each([false, true])(
    "refuses UNVERIFIABLE to FAIL or PASS with exact custody (parallel=%s)",
    (parallel) => {
      for (const verdict of ["FAIL", "PASS"]) {
        const r = setup({ preserve: true, parallel });
        let pending = r.first;
        let sibling: PhaseResult | undefined;
        if (parallel) {
          sibling = result(r, pending, { ...unknown, verdict: "PASS" }, { branch: "left" });
          pending = step(r, sibling);
        }
        // Deliberately simulate lost transport metadata, not lost semantic meaning.
        const source = result(
          r,
          pending,
          {},
          { text: footer(unknown), ...(parallel ? { branch: "right" } : {}) }
        );
        const repair = step(r, source);
        expect(repair.action).toBe(parallel ? "invoke_agents_parallel" : "invoke_agent");
        const before = r.checkpointer.loadRun(identity).snapshot();
        close(r);
        const reopened = open(r.root, { preserve: true, parallel });
        expect(recover(reopened)).toEqual(repair);
        const proposed = result(
          reopened,
          repair,
          { ...unknown, verdict },
          parallel ? { branch: "right" } : {}
        );
        const refused = step(reopened, proposed);
        expect(refused).toMatchObject({
          action: "incomplete",
          met: false,
          result: {
            reason_code: "source_summary_unpreservable",
            feedback_report_refs: [source.output_artifact],
          },
        });
        expect(reopened.checkpointer.loadRun(identity).iteration).toBe(0);
        expect(reopened.checkpointer.completionAdmission(identity.run_id)).toBeUndefined();
        expect(routeEvidence(reopened)).toEqual([]);
        expect(step(reopened, proposed)).toEqual(refused);
        expect(recover(reopened)).toEqual(refused);
        expect(reopened.artifacts.readById(source.output_artifact.artifact_id).toString()).toBe(
          footer(unknown)
        );
        if (parallel) {
          expect(reopened.checkpointer.loadRun(identity).pendingBranches[0]).toEqual(
            before.pending_branches[0]
          );
          if (sibling === undefined || !("artifacts" in refused))
            throw new Error("missing accepted sibling");
          expect(refused.artifacts).toContainEqual(sibling.output_artifact);
        }
        close(reopened);
      }
    }
  );
  it.each([false, true])(
    "accepts only identical complete SUMMARY and preserves siblings (parallel=%s)",
    (parallel) => {
      const r = setup({ preserve: true, parallel });
      let pending = r.first;
      let sibling: PhaseResult | undefined;
      if (parallel) {
        sibling = result(r, pending, unknown, { branch: "left" });
        pending = step(r, sibling);
      }
      const source = result(
        r,
        pending,
        {},
        { text: footer(unknown), ...(parallel ? { branch: "right" } : {}) }
      );
      const repair = step(r, source);
      const accepted = result(r, repair, unknown, parallel ? { branch: "right" } : {});
      const next = step(r, accepted);
      expect(next).toMatchObject({
        action: "incomplete",
        met: false,
        result: { reason: "accepted source judgment" },
      });
      expect(recover(r)).toEqual(next);
      expect(r.checkpointer.events(identity.run_id).at(-1)?.eventType).toBe(
        "routing_repair_accepted"
      );
      expect(r.checkpointer.loadRun(identity).selectedArtifacts).toContainEqual(
        source.output_artifact
      );
      if (sibling)
        expect(r.checkpointer.loadRun(identity).selectedArtifacts).toContainEqual(
          sibling.output_artifact
        );
      expect(r.artifacts.readById(source.output_artifact.artifact_id).toString()).toBe(
        footer(unknown)
      );
      close(r);
    }
  );
  it("cannot acquire FAIL/PASS when the original UNVERIFIABLE is outside the original phase schema", () => {
    const r = setup({ preserve: true, binaryVerdicts: true });
    const source = result(r, r.first, unknown);
    const next = step(r, source);
    expect(next).toMatchObject({
      action: "incomplete",
      met: false,
      result: { reason_code: "source_summary_unpreservable" },
    });
    expect(r.checkpointer.loadRun(identity).iteration).toBe(0);
    expect(r.checkpointer.completionAdmission(identity.run_id)).toBeUndefined();
    expect(routeEvidence(r)).toEqual([]);
    close(r);
  });
  it("accepts a fully identical PASS repair through normal admission", () => {
    const r = setup({ preserve: true });
    const pass = { ...unknown, verdict: "PASS" };
    const source = result(r, r.first, {}, { text: footer(pass) });
    const repair = step(r, source);
    expect(step(r, result(r, repair, pass))).toMatchObject({ action: "complete", met: true });
    expect(r.checkpointer.completionAdmission(identity.run_id)).toBeDefined();
    close(r);
  });
  it("accepts one repaired parallel branch without losing its pending sibling on reopen", () => {
    const r = setup({ preserve: true, parallel: true });
    const source = result(r, r.first, {}, { text: footer(unknown), branch: "left" });
    const repair = step(r, source);
    const repaired = result(r, repair, unknown, { branch: "left" });
    const pending = step(r, repaired);
    expect(pending).toMatchObject({
      action: "invoke_agents_parallel",
      branches: [{ branch_id: "right" }],
    });
    const completed = r.checkpointer.loadRun(identity).pendingBranches[0];
    expect(completed).toMatchObject({
      completed: true,
      result: unknown,
      artifact: source.output_artifact,
    });
    close(r);
    const reopened = open(r.root, { preserve: true, parallel: true });
    expect(recover(reopened)).toEqual(pending);
    expect(reopened.checkpointer.loadRun(identity).pendingBranches[0]).toEqual(completed);
    expect(step(reopened, result(reopened, pending, unknown, { branch: "right" }))).toMatchObject({
      action: "incomplete",
    });
    close(reopened);
  });
  it.each([
    "Report without judgment",
    footer({ ...unknown, verdict: "NOT_ADMITTED" }),
    `${footer(unknown)}\n${footer(failed())}`,
  ])("durably refuses invalid original before futile dispatch: %s", (text) => {
    const r = setup({ preserve: true });
    const source = result(r, r.first, {}, { text });
    const next = step(r, source);
    expect(next).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        reason_code: "source_summary_unpreservable",
        best_partial_artifact_refs: [r.partial],
      },
    });
    expect(r.checkpointer.loadRun(identity).iteration).toBe(0);
    expect(routeEvidence(r)).toEqual([]);
    expect(step(r, source)).toEqual(next);
    close(r);
    const reopened = open(r.root, { preserve: true });
    expect(recover(reopened)).toEqual(next);
    close(reopened);
  });
  it.each([false, true])(
    "rejects changes to confidence/all detail fields (parallel=%s)",
    (parallel) => {
      for (const changed of ["confidence", "candidate", "checks"]) {
        const r = setup({ preserve: true, parallel });
        const source = result(
          r,
          r.first,
          {},
          { text: footer(unknown), ...(parallel ? { branch: "left" } : {}) }
        );
        const repair = step(r, source);
        const proposed = result(
          r,
          repair,
          changed === "candidate"
            ? { ...unknown, candidate: "other" }
            : changed === "checks"
              ? { ...unknown, checks: [] }
              : unknown,
          {
            ...(parallel ? { branch: "left" } : {}),
            ...(changed === "confidence" ? { confidence: "PROBABLE" } : {}),
          }
        );
        expect(step(r, proposed)).toMatchObject({
          action: "incomplete",
          result: { reason_code: "source_summary_unpreservable" },
        });
        close(r);
      }
    }
  );
});

describe("durable conservative repair progress", () => {
  it("detects A/B/A across metadata repair, new receipts, reopen and replay without budget exhaustion", () => {
    const r = setup({ preserve: true, progress: true });
    let pending = r.first;
    for (const candidate of ["A", "B"]) {
      const source = result(r, pending, {}, { text: footer(failed(candidate)) });
      const repair = step(r, source);
      const accepted = result(r, repair, failed(candidate));
      pending = step(r, accepted);
      expect(pending.action).toBe("invoke_agent");
      expect(step(r, accepted)).toEqual(pending);
    }
    expect(r.checkpointer.loadRun(identity).iteration).toBe(2);
    expect(routeEvidence(r)).toHaveLength(2);
    close(r);
    const reopened = open(r.root, { preserve: true, progress: true });
    expect(recover(reopened)).toEqual(pending);
    const recurring = result(reopened, pending, failed("A"));
    const stalled = step(reopened, recurring);
    expect(stalled).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        reason: "measured exact recurrence; not budget exhaustion",
        best_partial_artifact_refs: [r.partial],
        repair_stall: { feedback_report_refs: [recurring.output_artifact] },
      },
    });
    expect(reopened.checkpointer.loadRun(identity).iteration).toBe(2);
    expect(routeEvidence(reopened)).toHaveLength(3);
    expect(routeEvidence(reopened).at(-1)).toMatchObject({
      disposition: "stalled",
      repair_progress_v1: {
        branch_id: null,
        fingerprint: sha256(canonicalJson({ candidate: "A", checks: ["criterion-1"] })),
      },
      budget: { used_before: 2, used_after: 2, limit: null },
    });
    expect(reopened.checkpointer.completionAdmission(identity.run_id)).toBeUndefined();
    expect(step(reopened, recurring)).toEqual(stalled);
    close(reopened);
    const replayed = open(r.root, { preserve: true, progress: true });
    expect(recover(replayed)).toEqual(stalled);
    close(replayed);
  });
  it("scopes identical fingerprints by logical branch, including one-branch parallel recurrence", () => {
    const r = setup({ progress: true, parallel: true, oneBranch: true });
    const left = step(r, result(r, r.first, failed(), { branch: "left" }));
    const right = step(r, result(r, left, failed(), { branch: "right" }));
    expect(left.action).toBe("invoke_agents_parallel");
    expect(right.action).toBe("invoke_agents_parallel");
    expect(routeEvidence(r)).toMatchObject([
      { disposition: "repair", repair_progress_v1: { branch_id: "left" } },
      { disposition: "repair", repair_progress_v1: { branch_id: "right" } },
    ]);
    const stalled = step(r, result(r, right, failed(), { branch: "left" }));
    expect(stalled).toMatchObject({ action: "incomplete", met: false });
    expect(routeEvidence(r).at(-1)).toMatchObject({
      disposition: "stalled",
      repair_progress_v1: { branch_id: "left" },
    });
    expect(r.checkpointer.loadRun(identity).iteration).toBe(2);
    close(r);
  });
  it("retains both siblings when a fan aggregate recurs after metadata acceptance", () => {
    const r = setup({ progress: true, preserve: true, parallel: true });
    let pending = r.first;
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const sibling = result(
        r,
        pending,
        { ...failed("sibling"), verdict: "PASS" },
        { branch: "left" }
      );
      pending = step(r, sibling);
      const source = result(r, pending, {}, { text: footer(failed()), branch: "right" });
      pending = step(r, source);
      pending = step(r, result(r, pending, failed(), { branch: "right" }));
      if (!("artifacts" in pending) && cycle === 1) throw new Error("expected stalled aggregate");
      if (cycle === 1 && "artifacts" in pending) {
        expect(pending.artifacts).toContainEqual(sibling.output_artifact);
        expect(pending.artifacts).toContainEqual(source.output_artifact);
      }
    }
    expect(pending).toMatchObject({ action: "incomplete", met: false });
    expect(routeEvidence(r).at(-1)).toMatchObject({
      disposition: "stalled",
      repair_progress_v1: { branch_id: null },
    });
    expect(r.checkpointer.loadRun(identity).iteration).toBe(1);
    close(r);
  });
  it("allows changed measured candidates to continue without a guessed iteration or step ceiling", () => {
    const r = setup({ progress: true });
    let pending = r.first;
    for (let candidate = 0; candidate < 105; candidate += 1) {
      const accepted = result(r, pending, failed(`semantic-candidate-${candidate}`));
      pending = step(r, accepted);
      expect(pending.action).toBe("invoke_agent");
    }
    expect(r.checkpointer.loadRun(identity)).toMatchObject({
      iteration: 105,
      maxIterations: null,
      maxSteps: null,
    });
    expect(routeEvidence(r)).toHaveLength(105);
    expect(step(r, result(r, pending, { ...failed("final"), verdict: "PASS" }))).toMatchObject({
      action: "complete",
      met: true,
    });
    close(r);
  });
  it.each([
    "invalid",
    "missing-fingerprint",
    "missing-terminal",
    "missing-evaluation",
    "positive-terminal",
  ])("negative terminal on malformed/missing opted capability: %s", (mode) => {
    const options: Options = {
      progress: true,
      ...(mode === "invalid" ? { fingerprint: "invalid" } : {}),
      ...(mode === "missing-fingerprint" ? { missing: "fingerprint" } : {}),
      ...(mode === "missing-terminal" ? { missing: "terminal" } : {}),
      ...(mode === "missing-evaluation" ? { missing: "evaluation" } : {}),
      ...(mode === "positive-terminal" ? { positiveStall: true } : {}),
    };
    const r = setup(options);
    let next = step(r, result(r, r.first, failed()));
    if (mode === "positive-terminal") next = step(r, result(r, next, failed()));
    expect(next).toMatchObject({ action: "incomplete", met: false });
    expect(r.checkpointer.completionAdmission(identity.run_id)).toBeUndefined();
    expect(recover(r)).toEqual(next);
    close(r);
  });
  it("null measurement is not evidence of stagnation; unopted behavior remains unchanged", () => {
    for (const options of [{ progress: true, fingerprint: "null" }, {}] satisfies Options[]) {
      const r = setup(options);
      let pending = r.first;
      for (let round = 0; round < 3; round += 1) pending = step(r, result(r, pending, failed()));
      expect(pending.action).toBe("invoke_agent");
      expect(r.checkpointer.loadRun(identity).iteration).toBe(3);
      if (!options.progress)
        expect(canonicalJson(routeEvidence(r))).not.toContain("repair_progress_v1");
      close(r);
    }
  });
  it("cancellation fences late metadata repair and does not observe or route it", () => {
    const r = setup({ preserve: true, progress: true });
    const repair = step(r, result(r, r.first, {}, { text: footer(failed()) }));
    const late = result(r, repair, failed());
    const cancelled = r.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity,
      reason: "operator stop",
    });
    expect(() => step(r, late)).toThrow(/already terminal/u);
    expect(routeEvidence(r)).toEqual([]);
    expect(recover(r)).toEqual(cancelled);
    close(r);
  });
  it("commits fingerprint and receipt atomically; failed acceptance leaves neither", () => {
    const r = setup({ progress: true });
    const accepted = result(r, r.first, failed());
    const sqlite: unknown = process.getBuiltinModule("node:" + "sqlite");
    if (!isSqliteModule(sqlite)) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(path.join(r.root, "orchestration.db"));
    db.exec(
      "CREATE TRIGGER fixture_commit_failure BEFORE INSERT ON events WHEN NEW.event_type = 'phase_result_accepted' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END;"
    );
    expect(() => step(r, accepted)).toThrow("fixture commit failure");
    expect(routeEvidence(r)).toEqual([]);
    expect(r.checkpointer.receiptResult(accepted.worker_receipt)).toBeUndefined();
    expect(r.checkpointer.loadRun(identity).iteration).toBe(0);
    db.exec("DROP TRIGGER fixture_commit_failure");
    db.close();
    expect(step(r, accepted).action).toBe("invoke_agent");
    expect(routeEvidence(r)).toHaveLength(1);
    close(r);
  });
});

describe("registration compatibility", () => {
  it("binds explicit opt-ins to identity without serializing absent declarations", () => {
    const legacy = registration({});
    const opted = registration({ preserve: true, progress: true });
    expect(validateRegistrationContract(opted)).toEqual(contract);
    expect(runtimeRegistrationSha256(legacy)).not.toBe(runtimeRegistrationSha256(opted));
    expect(runtimeRegistrationSha256(registration({ preserve: true }))).not.toBe(
      runtimeRegistrationSha256(legacy)
    );
    expect(runtimeRegistrationSha256(registration({ progress: true }))).not.toBe(
      runtimeRegistrationSha256(legacy)
    );
    const r = setup({});
    close(r);
    const changed = open(r.root, { preserve: true });
    expect(recover(changed)).toMatchObject({ action: "error" });
    close(changed);
  });
});
