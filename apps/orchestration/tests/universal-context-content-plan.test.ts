import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalizePlanRequest,
  evaluatePlanLatestReviewedStrategyDod,
  planRequestConstraints,
  planRequestItemIds,
  sha256,
  validateCompositionAssurance,
  validateEvidenceAdmission,
  validatePlanSpecificationSourceIndex,
  validateReviewReceipt,
  validateStrategyProductEnvelope,
  validateStrategyProductIntegrity,
  validateStrategyV2,
  type ArtifactRef,
} from "../dist/index.js";
import { assertCurrentShippingBuild } from "../dist/build-provenance.js";
import { requireValue } from "./helpers/narrowing.js";
import {
  ContentFixtureOwner,
  acceptedContentProduct,
  nonbindingContext,
} from "./helpers/universal-content-fixtures.js";
import { contentProducers } from "./helpers/universal-content-oracle.js";
import {
  bulletinPlanRequest,
  executePlanContent,
  type PlanMutation,
  type PlanScript,
} from "./helpers/universal-content-plan-fixtures.js";
import { assertPlanMeaning } from "./helpers/universal-content-plan-oracle.js";

// One native strategy family, seven compact synthetic meanings. Cognition/reviews are scripted;
// engine transitions, custody, sealing, exact review subjects and completion admission are real.
// No provider, live understanding, general paraphrase or full-matrix qualification claim.
// Bind this cohort to the verified current build, then detect drift during execution.
const generation = requireValue(assertCurrentShippingBuild(), "current compiled build").generation;
let active: ContentFixtureOwner | undefined;
let blockedPlan: ArtifactRef | undefined;
let fourteenDayResearch: ArtifactRef | undefined;
let hostilePlan: ArtifactRef | undefined;
function owner(): ContentFixtureOwner {
  return requireValue(active, "Plan content owner");
}
beforeAll(async () => {
  expect(assertCurrentShippingBuild()?.generation).toBe(generation);
  active = new ContentFixtureOwner();
  for (const producer of contentProducers)
    active.products.set(
      producer,
      acceptedContentProduct((await active.execute(producer, `plan-source-${producer}`)).terminal)
    );
  blockedPlan = acceptedContentProduct(
    (await active.execute("plan", "plan-blocked-source", "counterfactual")).terminal
  );
  fourteenDayResearch = acceptedContentProduct(
    (await active.execute("research", "plan-fourteen-source", "counterfactual")).terminal
  );
  hostilePlan = acceptedContentProduct(
    (await active.execute("plan", "plan-hostile-source", "authority")).terminal
  );
});
afterAll(() => active?.[Symbol.dispose]());

function assertNativePath(
  host: ContentFixtureOwner,
  runId: string,
  execution: Awaited<ReturnType<typeof executePlanContent>>,
  script: PlanScript
) {
  const { terminal, client, request } = execution;
  const ref = acceptedContentProduct(terminal);
  if (terminal.action !== "complete") throw new Error("Plan terminal absent");
  const context = requireValue(host.checkpointer.loadRunById(runId), "completed checkpoint");
  const product = validateStrategyV2(host.readProduct(ref));
  expect(product.request).toEqual(request);
  expect(product.request.prior_decisions).toEqual([
    {
      statement: "The caller chose descriptive communication only.",
      binding_effect: "No operational implementation or publication authorization.",
    },
  ]);
  expect(product.request.input_artifact_ids).toEqual([]);
  expect(product.source_lineage.input_artifact_ids).toEqual([]);
  expect(product.source_item_coverage).toEqual([]);
  expect(product.unsupported_strategy_elements).toEqual([]);
  expect(product.execution_started).toBe(false);
  expect(terminal.result.execution_started).toBe(false);
  expect(terminal.result.execution_authorized).toBe(false);
  expect(product.disposition).toBe("ready");
  expect(context.admittedInputArtifacts).toEqual(nonbindingContext(script.source));
  expect(context.selectedArtifacts).not.toContainEqual(script.source);
  expect(
    context.selectedArtifacts.some((row) => row.kind === "plan-specification-source-index")
  ).toBe(false);
  const ids = planRequestItemIds(request);
  expect(product.request_coverage).toEqual({
    current_state_fact_ids: [...ids.current_state_fact_ids].sort(),
    input_artifact_ids: [],
    hard_constraint_ids: [...ids.hard_constraint_ids].sort(),
    non_goal_ids: [...ids.non_goal_ids].sort(),
    uncertainty_ids: [...ids.uncertainty_ids].sort(),
    prior_decision_ids: [...ids.prior_decision_ids].sort(),
    blocked_desired_outcome_ids: [],
  });
  expect(product.outcomes.flatMap((row) => row.desired_outcome_ids).sort()).toEqual(
    [...ids.desired_outcome_ids].sort()
  );
  const selected = (kind: string, branch?: string) =>
    requireValue(
      context.selectedArtifacts.find(
        (row) => row.kind === kind && (branch === undefined || row.branch_id === branch)
      ),
      `selected ${kind}`
    );
  const requestRef = selected("plan-request");
  expect(host.readProduct(requestRef)).toEqual(request);
  expect(host.artifacts.read(requestRef).toString("utf8")).not.toContain(script.source.artifact_id);
  expect(host.artifacts.metadata(requestRef).upstream_refs).toEqual([]);
  expect(product.source_lineage.request_artifact_id).toBe(requestRef.artifact_id);
  const assuranceRef = selected("composition-assurance");
  const assurance = validateCompositionAssurance(host.readProduct(assuranceRef));
  expect(assurance.mode).toBe("not_applicable");
  expect(assurance.scope).toEqual(["no_specification_input"]);
  expect(assurance.specification_ref).toBeNull();
  expect(assurance.producer).toBeNull();
  expect(assurance.checked_artifacts).toEqual([]);
  const admissionRef = selected("evidence-admission");
  const admission = validateEvidenceAdmission(host.readProduct(admissionRef));
  expect(admission.evidence_required).toBe(false);
  expect(admission.classification).toBe("basis_sufficient");
  expect(admission.source_artifact_ref.kind).not.toBe(script.source.kind);
  expect(admission.source_artifact_ref.artifact_id).not.toBe(script.source.artifact_id);
  const validityRef = selected("review-receipt", "validity");
  const qualityRef = selected("review-receipt", "quality");
  for (const receiptRef of [validityRef, qualityRef]) {
    const receipt = validateReviewReceipt(host.readProduct(receiptRef));
    expect(receipt.subject.product_ref).toEqual(ref);
    expect(receipt.subject.product_sha256).toBe(ref.content_digest);
    expect(receipt.subject.request_ref).toEqual(requestRef);
    expect(receipt.subject.specification_assurance_ref).toEqual(assuranceRef);
    expect(receipt.subject.admission_ref).toEqual(admissionRef);
    expect(receipt.subject.draft_ref.artifact_id).toBe(product.source_lineage.draft_artifact_id);
    expect(receipt.subject.evidence_refs).toEqual([]);
    expect(receipt.subject.imported_input_refs).toEqual([]);
    const review = requireValue(
      client.invocations.find((row) => row.stateId === receipt.review_report_ref.phase),
      "actual review invocation"
    );
    expect(review.inputArtifacts).toContainEqual(ref);
    expect(review.inputArtifacts).toContainEqual(receipt.subject.draft_ref);
    expect(host.artifacts.metadata(receipt.review_report_ref).upstream_refs).toContainEqual(ref);
    expect(receipt.verdict).toBe(receipt.review_kind === "validity" ? "PASS" : "APPROVE");
  }
  expect(validateReviewReceipt(host.readProduct(qualityRef)).prior_review_receipt_ref).toEqual(
    validityRef
  );
  const integrityRef = selected("strategy-product-integrity");
  const integrity = validateStrategyProductIntegrity(host.readProduct(integrityRef));
  const envelope = validateStrategyProductEnvelope(
    host.readProduct(selected("strategy-product-envelope"))
  );
  expect(integrity.strategy_ref).toEqual(ref);
  expect(envelope.strategy_ref).toEqual(ref);
  expect(envelope.integrity_ref).toEqual(integrityRef);
  expect(integrity.validity_receipt_ref).toEqual(validityRef);
  expect(integrity.quality_receipt_ref).toEqual(qualityRef);
  expect(integrity.specification_assurance_ref).toEqual(assuranceRef);
  expect(integrity.imported_input_refs).toEqual([]);
  expect(integrity.evidence_refs).toEqual([]);
  expect(integrity.execution_started).toBe(false);
  expect(integrity.execution_authorized).toBe(false);
  expect(host.checkpointer.completionAdmission(runId)).toBeDefined();
  expect(
    evaluatePlanLatestReviewedStrategyDod({
      checkpointer: host.checkpointer,
      context,
      terminal,
      originState: "admitting_strategy",
      latestProduct: {
        selector: "terminal_artifact",
        schema_id: "penny.strategy.v2",
        product_schema_version: 2,
        product_id: ref.artifact_id,
        sha256: ref.content_digest,
      },
      artifactReader: host.artifacts,
      projectRoot: host.root,
    }).passed
  ).toBe(true);
  expect(client.invocations.map((row) => row.stateId)).toEqual([
    "orienting_strategy",
    "strategizing",
    "verifying_strategy",
    "critiquing_strategy",
  ]);
  for (const [invocationIndex, invocation] of client.invocations.entries()) {
    expect(invocation.task).toContain("NONBINDING context slot");
    expect(invocation.inputArtifacts).toContainEqual(script.source);
    expect(invocation.registration.allowed_tools).toBeUndefined();
    const reads = client.reads.filter((row) => row.invocationIndex === invocationIndex);
    expect(reads.map((row) => row.ref)).toEqual(invocation.inputArtifacts);
    for (const read of reads) {
      expect(read.bytes).toEqual(host.artifacts.read(read.ref));
      expect(read.bytes.length).toBe(read.ref.byte_length);
      expect(sha256(read.bytes)).toBe(read.ref.content_digest);
    }
  }
  expect(
    client.reads.filter((row) => row.ref.artifact_id === script.source.artifact_id)
  ).toHaveLength(4);
  return product;
}
const positiveCases = contentProducers.flatMap((producer) =>
  (["direct", "paraphrase"] as const).map((wording) => ({ producer, wording }))
);
const mutations: readonly PlanMutation[] = [
  "ignored",
  "omitted",
  "changed",
  "coerced",
  "evidence",
  "permission",
  "native-authority",
  "summary-contradiction",
];
const negativeCases = contentProducers.flatMap((producer) =>
  mutations.map((mutation) => ({ producer, mutation }))
);

describe("UO-CONTENT-PLAN: native communication strategy with independent finite meaning oracle", () => {
  it.each(positiveCases)(
    "$producer -> Plan source-sensitive readiness ($wording)",
    async ({ producer, wording }) => {
      const host = owner();
      const script: PlanScript = {
        producer,
        wording,
        source: host.source(producer),
        scenario: "base",
      };
      const bytes = host.artifacts.read(script.source);
      const runId = `plan-content-${producer}-${wording}`;
      const product = assertNativePath(
        host,
        runId,
        await executePlanContent(host, runId, script),
        script
      );
      assertPlanMeaning(product, script);
      expect(host.artifacts.read(script.source)).toEqual(bytes);
    }
  );
  it.each(negativeCases)(
    "$producer -> Plan native-valid $mutation fails meaning despite scripted PASS reviews",
    async ({ producer, mutation }) => {
      const host = owner();
      const script: PlanScript = {
        producer,
        mutation,
        wording: "direct",
        source: host.source(producer),
        scenario: "base",
      };
      const runId = `plan-mutant-${producer}-${mutation}`;
      const product = assertNativePath(
        host,
        runId,
        await executePlanContent(host, runId, script),
        script
      );
      expect(() => assertPlanMeaning(product, script)).toThrow(/PLAN_CONTENT_ORACLE/u);
    }
  );
  it.each(["plan", "research"] as const)(
    "%s counterfactual changes readiness predicates, not caller scope or native authority",
    async (producer) => {
      const host = owner();
      const source = requireValue(
        producer === "plan" ? blockedPlan : fourteenDayResearch,
        "counterfactual"
      );
      expect(source).not.toEqual(host.source(producer));
      for (const wording of ["direct", "paraphrase"] as const) {
        const script: PlanScript = { producer, source, wording, scenario: "counterfactual" };
        const runId = `plan-counterfactual-${producer}-${wording}`;
        const product = assertNativePath(
          host,
          runId,
          await executePlanContent(host, runId, script),
          script
        );
        assertPlanMeaning(product, script);
        expect(() => assertPlanMeaning(product, { ...script, scenario: "base" })).toThrow(
          /distinguishing meaning/u
        );
        expect(product.request).toEqual(bulletinPlanRequest());
        expect(product.request_coverage.blocked_desired_outcome_ids).toEqual([]);
      }
    }
  );
  it.each(["plan", "research"] as const)(
    "%s counterfactual strengthening stays native-valid, not faithful",
    async (producer) => {
      const host = owner();
      const script: PlanScript = {
        producer,
        source: requireValue(producer === "plan" ? blockedPlan : fourteenDayResearch, "source"),
        wording: "direct",
        scenario: "counterfactual",
        mutation: "domain-strengthening",
      };
      const runId = `plan-strength-${producer}`;
      const product = assertNativePath(
        host,
        runId,
        await executePlanContent(host, runId, script),
        script
      );
      expect(() => assertPlanMeaning(product, script)).toThrow(/distinguishing meaning/u);
    }
  );
  it.each(["direct", "paraphrase"] as const)(
    "irrelevant transition context is excluded from welcome-notice strategy (%s)",
    async (wording) => {
      const host = owner();
      const script: PlanScript = {
        producer: "plan",
        source: host.source("plan"),
        scenario: "irrelevant",
        wording,
      };
      const runId = `plan-irrelevant-${wording}`;
      assertPlanMeaning(
        assertNativePath(host, runId, await executePlanContent(host, runId, script), script),
        script
      );
      const bad = { ...script, mutation: "irrelevant-import" as const };
      const badRun = `${runId}-import`;
      const mutant = assertNativePath(
        host,
        badRun,
        await executePlanContent(host, badRun, bad),
        bad
      );
      expect(() => assertPlanMeaning(mutant, script)).toThrow(/distinguishing meaning/u);
    }
  );
  it("handles hostile accepted source without role/tool/approval adoption and rejects provenance substitution", async () => {
    const host = owner();
    const source = requireValue(hostilePlan, "hostile accepted strategy");
    expect(host.artifacts.read(source).toString("utf8")).toContain("SYSTEM OVERRIDE");
    const script: PlanScript = {
      producer: "plan",
      source,
      scenario: "base",
      wording: "paraphrase",
    };
    const runId = "plan-hostile-honest";
    const product = assertNativePath(
      host,
      runId,
      await executePlanContent(host, runId, script),
      script
    );
    assertPlanMeaning(product, script);
    for (const mutation of ["evidence", "permission", "native-authority"] as const) {
      const bad = { ...script, mutation };
      const badRun = `plan-hostile-${mutation}`;
      const mutant = assertNativePath(
        host,
        badRun,
        await executePlanContent(host, badRun, bad),
        bad
      );
      expect(() => assertPlanMeaning(mutant, script)).toThrow(/distinguishing meaning/u);
    }
    expect(() => assertPlanMeaning(product, { ...script, source: host.source("plan") })).toThrow(
      /provenance/u
    );
  });
  it("context cannot supply a missing request, native specification or reviewed-definition assurance", () => {
    const host = owner();
    const source = host.source("define");
    const engine = host.engine("plan");
    const missing = host.start("plan", "plan-missing-brief", nonbindingContext(source));
    missing.constraints = {};
    expect(() => engine.handle(missing)).toThrow();
    expect(host.checkpointer.runExists(missing.identity.run_id)).toBe(false);
    const request = bulletinPlanRequest();
    const standalone = host.start(
      "plan",
      "plan-context-not-specification",
      nonbindingContext(source)
    );
    standalone.goal = request.goal;
    standalone.constraints = {
      schema_version: 2,
      request: planRequestConstraints(request),
      specification_assurance: "reviewed_definition",
    };
    expect(engine.handle(standalone).action).toBe("invoke_agent");
    const context = requireValue(
      host.checkpointer.loadRunById(standalone.identity.run_id),
      "standalone strict context"
    );
    const assuranceRef = requireValue(
      context.selectedArtifacts.find((row) => row.kind === "composition-assurance"),
      "assurance"
    );
    expect(validateCompositionAssurance(host.readProduct(assuranceRef)).mode).toBe(
      "not_applicable"
    );
    expect(
      context.selectedArtifacts.some((row) => row.kind === "plan-specification-source-index")
    ).toBe(false);
    // Canonical copied specification lacks a completed producer/review graph. A separately
    // accepted contextual Define cannot lend its assurance to this native operand.
    const detached = host.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "plan-detached-native-spec",
        phase: "sealing_specification",
        branch_id: null,
        kind: "specification",
        operation_id: "detached",
        version: 1,
        producer: "host:specification-sealer",
        media_type: "application/json",
        content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: host.artifacts.read(source),
    });
    const strict = host.start("plan", "plan-context-cannot-lend-assurance", {
      schema_version: 2,
      artifacts: [
        { slot: "prior_specification", ref: detached },
        { slot: "reader-context", designation: "context", ref: source },
      ],
    });
    strict.goal = request.goal;
    strict.constraints = standalone.constraints;
    expect(() => engine.handle(strict)).toThrow();
    expect(host.checkpointer.runExists(strict.identity.run_id)).toBe(false);
    // Explicit semantic-only admission indexes the native specification alone. Context cannot
    // add rows even when it has the same canonical bytes and a completed producer graph.
    const indexes = [false, true].map((withContext) => {
      const start = host.start("plan", `plan-index-${withContext}`, {
        schema_version: 2,
        artifacts: [
          { slot: "prior_specification", ref: detached },
          ...(withContext
            ? [{ slot: "reader-context", designation: "context" as const, ref: source }]
            : []),
        ],
      });
      start.goal = request.goal;
      start.constraints = {
        schema_version: 2,
        request: planRequestConstraints(request),
        specification_assurance: "semantic_only",
      };
      expect(engine.handle(start).action).toBe("invoke_agent");
      const run = requireValue(host.checkpointer.loadRunById(start.identity.run_id), "index run");
      const indexRef = requireValue(
        run.selectedArtifacts.find((row) => row.kind === "plan-specification-source-index"),
        "native source index"
      );
      const index = validatePlanSpecificationSourceIndex(
        host.readProduct(indexRef),
        host.artifacts.read(detached),
        detached
      );
      expect(index.specification_ref).toEqual(detached);
      expect(index.entries.some((row) => row.source_item_id === source.artifact_id)).toBe(false);
      const nativeRequest = requireValue(
        run.selectedArtifacts.find((row) => row.kind === "plan-request"),
        "native request"
      );
      expect(host.readProduct(nativeRequest)).toEqual(
        canonicalizePlanRequest({
          goal: request.goal,
          constraints: planRequestConstraints(request),
          exactInputArtifactIds: [detached.artifact_id],
        })
      );
      return index;
    });
    expect(indexes[0]).toEqual(indexes[1]);
  });
  it("pins the fixed generation, exact seven pairs and fixture-only limits", () => {
    expect(assertCurrentShippingBuild()?.generation).toBe(generation);
    expect(contentProducers.map((producer) => `${producer}->plan`)).toEqual([
      "assess->plan",
      "decide->plan",
      "define->plan",
      "diagnose->plan",
      "plan->plan",
      "produce->plan",
      "research->plan",
    ]);
    expect(
      canonicalJson({
        cognition: "scripted",
        reviews: "scripted",
        native_owners: "real",
        live_model_understanding: "not_run",
      })
    ).toContain('"live_model_understanding":"not_run"');
  });
});
