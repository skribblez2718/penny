import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OrchestrationService,
  canonicalJson,
  initializePennyState,
  planSpecificationSourceIndex,
  sha256,
  specificationStrategySourceItems,
  validatePlanSpecificationSourceIndex,
  validateStrategyV2,
  type AgentInvocation,
  type ArtifactRef,
  type ModelClient,
  type StrategyCoreV2,
} from "../dist/index.js";
import { densePlanSpecificationFixture } from "./fixtures/plan-source-index-fixtures.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-plan-source-index-"));
  roots.push(root);
  const env = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return env;
}
function persistSpecification(service: OrchestrationService, operation = "source") {
  const fixture = densePlanSpecificationFixture();
  const bytes = Buffer.from(canonicalJson(fixture.specification));
  const ref = service.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: "synthetic-define",
      phase: "sealing_specification",
      branch_id: null,
      kind: "specification",
      operation_id: operation,
      version: 1,
      producer: "host:specification-sealer",
      media_type: "application/json",
      content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: bytes,
  });
  return { ...fixture, bytes, ref };
}
function identity(runId: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook: "plan",
    engine_owner: "typescript" as const,
  };
}
function start(runId: string, ref: ArtifactRef) {
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId),
    goal: "Plan synthetic readiness without execution.",
    constraints: {
      schema_version: 2,
      specification_assurance: "semantic_only",
      request: {
        schema_version: 1,
        desired_outcomes: ["Synthetic readiness is reviewable."],
        current_state: { status: "unavailable", reason: "No additional state is needed." },
        hard_constraints: [],
        non_goals: [],
        known_uncertainties: [],
        prior_decisions: [],
      },
    },
    input_artifacts: {
      schema_version: 2 as const,
      artifacts: [{ slot: "prior_specification", ref }],
    },
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}
function summary(details: object) {
  return `Synthetic cognition fixture.\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", ...details })}`;
}
function indexRef(refs: readonly ArtifactRef[]) {
  const ref = refs.find((entry) => entry.kind === "plan-specification-source-index");
  if (ref === undefined) throw new Error("missing_input:plan-specification-source-index");
  return ref;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Plan exact specification source-index artifact transport", () => {
  it("dispatches and reviews an admitted dense specification under the unchanged task envelope with all exact rows", async () => {
    const invocations: AgentInvocation[] = [];
    const reads: string[] = [];
    const client: ModelClient = {
      // Fixture cognition only; the real engine, admission, custody, transitions and reviews run.
      async runAgent(invocation) {
        invocations.push(invocation);
        const ref = indexRef(invocation.inputArtifacts);
        const specificationRef = invocation.inputArtifacts.find(
          (entry) => entry.kind === "specification"
        );
        if (specificationRef === undefined) throw new Error("missing_input:prior-specification");
        const sourceBytes = service.artifacts.readById(specificationRef.artifact_id);
        const bytes = service.artifacts.readById(ref.artifact_id);
        const index = validatePlanSpecificationSourceIndex(
          JSON.parse(bytes.toString("utf8")),
          sourceBytes,
          specificationRef
        );
        reads.push(ref.artifact_id);
        expect(invocation.task.length).toBeLessThanOrEqual(32_768);
        expect(invocation.task).not.toContain('"source_item_id":');
        expect(invocation.task).toContain(
          "fully read both prior-specification and plan-specification-source-index"
        );
        const pending = service.checkpointer.loadRunById("dense-plan")?.pendingDirective;
        if (pending?.action !== "invoke_agent")
          throw new Error("pending worker directive is absent");
        expect(pending.input_artifacts.artifacts).toContainEqual({
          slot: "plan-specification-source-index",
          ref,
        });
        expect(pending.output_artifact.upstream_refs).toContainEqual(ref);
        if (invocation.stateId === "orienting_strategy")
          return {
            text: summary({
              orientation_complete: true,
              gap_kind: "none",
              repair_owner: "none",
              findings: [],
              strategy_delta: "Preserve exact source semantics.",
            }),
          };
        if (invocation.stateId === "strategizing") {
          const core: StrategyCoreV2 = {
            schema_version: 2,
            disposition: "ready",
            applicability_reason: "Synthetic planning readiness is supported.",
            outcomes: [
              {
                statement: "Synthetic readiness is reviewable.",
                desired_outcome_indexes: [0],
                success_signal: "Every mandatory source item is preserved.",
              },
            ],
            dependencies: [],
            request_coverage: {
              current_state_fact_indexes: [],
              input_artifact_slots: [0],
              hard_constraint_indexes: [],
              non_goal_indexes: [],
              uncertainty_indexes: [],
              prior_decision_indexes: [],
              blocked_desired_outcome_indexes: [],
            },
            blockers: [],
            confidence: "CERTAIN",
            source_item_coverage: index.entries
              .filter((entry) => entry.required)
              .map((entry) => ({
                source_item_index: entry.index,
                disposition: "addressed",
                strategy_outcome_indexes: [0],
                rationale: "Preserved in readiness.",
              })),
            unsupported_strategy_elements: [],
          };
          return {
            text: `Complete synthetic strategy.\nSTRATEGY_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`,
          };
        }
        return {
          text: summary({
            verdict: invocation.stateId === "verifying_strategy" ? "PASS" : "APPROVE",
            gap_kind: "none",
            repair_owner: "none",
            findings: [],
            evidence: ["Exact synthetic subject checked."],
            strategy_delta: "Preserve this exact product.",
          }),
        };
      },
    };
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      playbookName: "plan",
      modelClient: client,
    });
    const source = persistSpecification(service);
    expect(source.specification.requirements).toHaveLength(128);
    expect(source.specification.constraints).toHaveLength(64);
    expect(source.specification.non_goals).toHaveLength(32);
    const oldInlineRows = specificationStrategySourceItems(source.specification).map(
      (entry, index) => ({ index, ...entry })
    );
    expect(canonicalJson(oldInlineRows).length).toBeGreaterThan(32_768);
    const terminal = await service.execute(start("dense-plan", source.ref));
    expect(terminal.action).toBe("complete");
    const context = service.checkpointer.loadRunById("dense-plan");
    if (context === undefined) throw new Error("dense Plan context is absent");
    const ref = indexRef(context.selectedArtifacts);
    const bytes = service.artifacts.readById(ref.artifact_id);
    const index = validatePlanSpecificationSourceIndex(
      JSON.parse(bytes.toString("utf8")),
      source.bytes,
      source.ref
    );
    expect(index.specification_ref).toEqual(source.ref);
    expect(index.specification_sha256).toBe(sha256(source.bytes));
    expect(ref.content_digest).toBe(sha256(bytes));
    expect(index.entries).toHaveLength(228);
    expect(
      index.entries.map(({ index: ordinal, source_locator, source_value_sha256, ...entry }) => {
        const [collection, offset] = source_locator.slice(1).split("/");
        const sourceJson: unknown = JSON.parse(source.bytes.toString("utf8"));
        if (
          typeof sourceJson !== "object" ||
          sourceJson === null ||
          collection === undefined ||
          offset === undefined
        )
          throw new Error("source locator invalid");
        const rows: unknown = Reflect.get(sourceJson, collection);
        if (!Array.isArray(rows)) throw new Error("source locator collection absent");
        expect(source_value_sha256).toBe(sha256(canonicalJson(rows[Number(offset)])));
        expect(ordinal).toBe(
          index.entries.findIndex((candidate) => candidate.source_item_id === entry.source_item_id)
        );
        return entry;
      })
    ).toEqual(specificationStrategySourceItems(source.specification));
    expect(new Set(index.entries.map((entry) => entry.source_item_type)).size).toBe(7);
    expect(service.artifacts.metadata(ref).upstream_refs).toEqual([source.ref]);
    expect(canonicalJson(context.snapshot())).not.toContain('"source_locator":');
    expect(canonicalJson(service.artifacts.metadata(ref))).not.toContain('"entries":');
    expect(service.artifacts.readById(source.ref.artifact_id)).toEqual(source.bytes);
    expect(invocations.map((invocation) => invocation.stateId)).toEqual([
      "orienting_strategy",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
    expect(reads).toEqual(Array.from({ length: 4 }, () => ref.artifact_id));
    const product = context.selectedArtifacts.find((entry) => entry.kind === "strategy");
    if (product === undefined) throw new Error("dense strategy is absent");
    const strategy = validateStrategyV2(
      JSON.parse(service.artifacts.readById(product.artifact_id).toString("utf8")),
      {
        specification: source.specification,
        specificationArtifactId: source.ref.artifact_id,
        strictSourceValidation: true,
      }
    );
    expect(strategy.source_item_coverage).toHaveLength(
      index.entries.filter((entry) => entry.required).length
    );
    expect(service.checkpointer.completionAdmission("dense-plan")).toBeDefined();
  });

  it("rejects truncated, corrupt, reordered, wrong-locator and wrong-source indexes without changing semantic coverage", () => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      playbookName: "plan",
    });
    const source = persistSpecification(service);
    const other = persistSpecification(service, "other-source");
    const index = planSpecificationSourceIndex(source.bytes, source.ref);
    expect(validatePlanSpecificationSourceIndex(index, source.bytes, source.ref)).toEqual(index);
    for (const invalid of [
      { ...index, entries: index.entries.slice(1) },
      { ...index, specification_sha256: "0".repeat(64) },
      { ...index, entries: [...index.entries].reverse() },
      {
        ...index,
        entries: index.entries.map((entry, ordinal) =>
          ordinal === 0 ? { ...entry, source_locator: "/requirements/999" } : entry
        ),
      },
      {
        ...index,
        entries: index.entries.map((entry, ordinal) =>
          ordinal === 0 ? { ...entry, required: !entry.required } : entry
        ),
      },
      { ...index, specification_ref: other.ref },
      { ...index, schema_version: 2 },
    ])
      expect(() =>
        validatePlanSpecificationSourceIndex(invalid, source.bytes, source.ref)
      ).toThrow();
    expect(() => validatePlanSpecificationSourceIndex(index, source.bytes, other.ref)).toThrow();
    expect(() => planSpecificationSourceIndex(Buffer.from("{}"), source.ref)).toThrow();
  });

  it("adopts an interrupted exact index before first dispatch and retains the same ref on restart", () => {
    const env = environment();
    const requestRunId = "interrupted-source-index";
    let expected: ArtifactRef | undefined;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookName: "plan",
      });
      const source = persistSpecification(service);
      const persist = service.artifacts.persist.bind(service.artifacts);
      const interrupted = vi.spyOn(service.artifacts, "persist").mockImplementation((input) => {
        const ref = persist(input);
        if (input.metadata.kind === "plan-specification-source-index") {
          expected = ref;
          throw new Error("fixture interrupted after source-index persistence");
        }
        return ref;
      });
      expect(() => service.engine.handle(start(requestRunId, source.ref))).toThrow(
        "fixture interrupted"
      );
      expect(service.checkpointer.loadRunById(requestRunId)).toBeUndefined();
      interrupted.mockRestore();
      const first = service.engine.handle(start(requestRunId, source.ref));
      if (first.action !== "invoke_agent") throw new Error("adopted dispatch is absent");
      expect(indexRef(first.input_artifacts.artifacts.map((entry) => entry.ref))).toEqual(expected);
    }
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "plan",
    });
    const next = recovered.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(requestRunId),
    });
    if (next.action !== "invoke_agent") throw new Error("recovered dispatch is absent");
    expect(indexRef(next.input_artifacts.artifacts.map((entry) => entry.ref))).toEqual(expected);
    if (expected === undefined) throw new Error("interrupted index was not persisted");
    expect(
      recovered.artifacts.lastVersion(
        requestRunId,
        "intake",
        null,
        expected.kind,
        expected.operation_id
      )
    ).toBe(1);
  });

  it("refuses a wrong-source orphan at the deterministic index coordinates before run creation", () => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      playbookName: "plan",
    });
    const source = persistSpecification(service);
    const other = persistSpecification(service, "wrong-source");
    const runId = "wrong-source-orphan";
    const operation = `plan-specification-source-index:${sha256(runId).slice(0, 32)}`;
    service.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: runId,
        phase: "intake",
        branch_id: null,
        kind: "plan-specification-source-index",
        operation_id: operation,
        version: 1,
        producer: "host:request-admission",
        media_type: "application/json",
        content_schema: {
          schema_id: "penny.plan-specification-source-index.v1",
          schema_version: 1,
        },
        parent_ref: null,
        upstream_refs: [other.ref],
      },
      content: canonicalJson(planSpecificationSourceIndex(other.bytes, other.ref)),
    });
    expect(() => service.engine.handle(start(runId, source.ref))).toThrow(
      "source index deterministic persistence diverged"
    );
    expect(service.checkpointer.loadRunById(runId)).toBeUndefined();
  });

  it.each([
    "missing-selection",
    "missing-object",
    "corrupt-bytes",
    "missing-worker-input",
    "wrong-worker-slot",
  ] as const)("refuses %s on the actual engine recovery path before cognition", async (failure) => {
    const runAgent = vi.fn<ModelClient["runAgent"]>();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      playbookName: "plan",
      modelClient: { runAgent },
    });
    const source = persistSpecification(service);
    const first = service.engine.handle(start(`negative-${failure}`, source.ref));
    if (first.action !== "invoke_agent") throw new Error("first worker dispatch absent");
    const ref = indexRef(first.input_artifacts.artifacts.map((entry) => entry.ref));
    const context = service.checkpointer.loadRunById(first.identity.run_id);
    if (context === undefined) throw new Error("negative context is absent");
    if (failure === "missing-selection") {
      context.selectedArtifacts = context.selectedArtifacts.filter(
        (entry) => entry.artifact_id !== ref.artifact_id
      );
      service.checkpointer.saveRun(context, "fixture_missing_selection", {});
    } else if (failure === "missing-worker-input" || failure === "wrong-worker-slot") {
      context.pendingDirective = {
        ...first,
        input_artifacts: {
          schema_version: 2,
          artifacts:
            failure === "missing-worker-input"
              ? first.input_artifacts.artifacts.filter(
                  (entry) => entry.ref.artifact_id !== ref.artifact_id
                )
              : first.input_artifacts.artifacts.map((entry) =>
                  entry.ref.artifact_id === ref.artifact_id
                    ? { ...entry, slot: "wrong-source-index-slot" }
                    : entry
                ),
        },
      };
      service.checkpointer.saveRun(context, "fixture_invalid_worker_input", {});
    } else {
      const read = service.artifacts.readById.bind(service.artifacts);
      vi.spyOn(service.artifacts, "readById").mockImplementation((id) => {
        if (id !== ref.artifact_id) return read(id);
        if (failure === "missing-object") throw new Error("fixture missing source-index object");
        return Buffer.from("{}");
      });
    }
    await expect(
      service.execute({ schema_version: 2, action: "recover", identity: first.identity })
    ).rejects.toThrow();
    expect(runAgent).not.toHaveBeenCalled();
  });
});
