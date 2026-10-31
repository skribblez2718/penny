import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  defineRequestConstraints,
  definitionRequestSourceItems,
  evaluateDefineLatestReviewedSpecificationDod,
  sha256,
  validateDefinitionSourceManifest,
  validateDefinitionTraceV1,
  validateEvidenceAdmissionV2,
  validateReviewReceiptV2,
  validateSpecification,
  validateSpecificationProductEnvelopeV2,
  validateSpecificationProductIntegrityV2,
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
  bulletinDefinitionRequest,
  executeDefineContent,
  type DefineMutation,
  type DefineScript,
} from "./helpers/universal-content-define-fixtures.js";
import { assertDefineMeaning } from "./helpers/universal-content-define-oracle.js";

// One native Specification schema + seven independently checked synthetic meanings.
// Real compiled engines/stores/seals/reviews/admission; scripted cognition and PASS reviews.
// No provider, model-understanding, general paraphrase recognition or full-matrix claim.
// Bind this cohort to the verified current build, then detect drift during execution.
const generation = requireValue(assertCurrentShippingBuild(), "current compiled build").generation;
let active: ContentFixtureOwner | undefined;
let blockedPlan: ArtifactRef | undefined;
let fourteenDayResearch: ArtifactRef | undefined;
let hostilePlan: ArtifactRef | undefined;
function owner(): ContentFixtureOwner {
  return requireValue(active, "Define content owner");
}
beforeAll(async () => {
  expect(assertCurrentShippingBuild()?.generation).toBe(generation);
  active = new ContentFixtureOwner();
  for (const producer of contentProducers) {
    active.products.set(
      producer,
      acceptedContentProduct((await active.execute(producer, `define-source-${producer}`)).terminal)
    );
  }
  blockedPlan = acceptedContentProduct(
    (await active.execute("plan", "define-blocked-source", "counterfactual")).terminal
  );
  fourteenDayResearch = acceptedContentProduct(
    (await active.execute("research", "define-fourteen-source", "counterfactual")).terminal
  );
  hostilePlan = acceptedContentProduct(
    (await active.execute("plan", "define-hostile-source", "authority")).terminal
  );
});
afterAll(() => active?.[Symbol.dispose]());

function assertNativePath(
  host: ContentFixtureOwner,
  runId: string,
  execution: Awaited<ReturnType<typeof executeDefineContent>>,
  script: DefineScript
) {
  const { terminal, client, request } = execution;
  const ref = acceptedContentProduct(terminal);
  if (terminal.action !== "complete") throw new Error("Define terminal missing");
  const context = requireValue(host.checkpointer.loadRunById(runId), "completed checkpoint");
  const product = validateSpecification(host.readProduct(ref));
  expect(product.request).toEqual(request);
  expect(product.request.mode).toBe("create");
  expect(product.request.input_artifact_ids).toEqual([]);
  expect(product.source_lineage.input_artifact_ids).toEqual([]);
  expect(product.source_lineage.prior_specification_artifact_id).toBeNull();
  expect(product.supersession).toEqual([]);
  expect(product.supersedes_specification_ids).toEqual([]);
  expect(product.disposition).toBe("ready");
  expect([
    product.planning_started,
    product.taskification_started,
    product.execution_started,
  ]).toEqual([false, false, false]);
  expect(product.standards_status).toEqual([]);
  expect(product.open_questions).toEqual([]);
  expect(context.admittedInputArtifacts).toEqual(nonbindingContext(script.source));
  expect(context.selectedArtifacts).not.toContainEqual(script.source);
  const selected = (kind: string, branchId?: string) =>
    requireValue(
      context.selectedArtifacts.find(
        (row) => row.kind === kind && (branchId === undefined || row.branch_id === branchId)
      ),
      `selected ${kind}`
    );
  const requestRef = selected("definition-request");
  expect(host.artifacts.read(requestRef).toString("utf8")).not.toContain(script.source.artifact_id);
  expect(product.source_lineage.request_artifact_id).toBe(requestRef.artifact_id);
  const manifestRef = selected("definition-source-manifest");
  const manifest = validateDefinitionSourceManifest(
    host.readProduct(manifestRef),
    request,
    requestRef
  );
  const sources = definitionRequestSourceItems(request);
  expect(manifest.source_count).toBe(8);
  expect(manifest.sources).toEqual(sources);
  expect(product.source_items).toEqual(sources);
  expect(sources.some((row) => row.kind === "input_artifact")).toBe(false);
  expect(product.source_coverage.map((row) => row.source_item_id).sort()).toEqual(
    sources.map((row) => row.source_item_id).sort()
  );
  expect(
    product.source_coverage.every(
      (row) => row.disposition === "incorporated" && row.product_item_ids.length > 0
    )
  ).toBe(true);
  expect(product.constraints.map((row) => row.statement)).toEqual(request.hard_constraints);
  expect(product.scope.excluded).toEqual(request.out_of_scope);
  expect(product.non_goals.map((row) => row.statement)).toEqual([
    ...request.out_of_scope,
    ...request.non_goals,
  ]);
  const traceRef = selected("definition-trace");
  const trace = validateDefinitionTraceV1(host.readProduct(traceRef));
  expect(trace.product_ref).toEqual(ref);
  expect(trace.request_ref).toEqual(requestRef);
  expect(trace.manifest_ref).toEqual(manifestRef);
  expect(trace.prior_product_ref).toBeNull();
  expect(trace.support_refs).toEqual([]);
  expect(trace.question_resolutions).toEqual([]);
  expect(trace.standard_support).toEqual([]);
  expect(trace.coverage).toEqual(
    sources.map((row) => {
      const coverage = requireValue(
        product.source_coverage.find((entry) => entry.source_item_id === row.source_item_id),
        "host coverage"
      );
      return {
        source_item_id: row.source_item_id,
        ordinal: row.ordinal,
        disposition: coverage.disposition,
        product_item_ids: coverage.product_item_ids,
      };
    })
  );
  const protectedValues = [
    ...request.out_of_scope,
    ...request.hard_constraints,
    ...request.non_goals,
  ];
  expect(trace.protected_mappings).toHaveLength(4);
  expect(trace.protected_mappings.map((row) => row.original_value_sha256).sort()).toEqual(
    protectedValues.map((value) => sha256(value)).sort()
  );
  for (const mapping of trace.protected_mappings) {
    const item = requireValue(
      [...product.constraints, ...product.non_goals].find((row) => row.item_id === mapping.item_id),
      "protected product item"
    );
    expect(item.source_item_ids).toContain(mapping.source_item_id);
    expect(sha256(item.statement)).toBe(mapping.original_value_sha256);
  }
  const admission = validateEvidenceAdmissionV2(host.readProduct(trace.admission_ref));
  expect(admission.support_slots).toEqual([]);
  expect(admission.evidence_required).toBe(false);
  const validityRef = selected("review-receipt", "validity");
  const qualityRef = selected("review-receipt", "quality");
  for (const receiptRef of [validityRef, qualityRef]) {
    const receipt = validateReviewReceiptV2(host.readProduct(receiptRef));
    expect(receipt.subject.product_ref).toEqual(ref);
    expect(receipt.subject.trace_ref).toEqual(traceRef);
    expect(receipt.subject.draft_ref.artifact_id).toBe(product.source_lineage.draft_artifact_id);
    expect(receipt.subject.evidence_refs).toEqual([]);
    expect(receipt.subject.imported_input_refs).toEqual([]);
    expect(receipt.subject.support_refs).toEqual([]);
    const review = requireValue(
      client.invocations.find((row) => row.stateId === receipt.review_report_ref.phase),
      "actual review invocation"
    );
    expect(review.inputArtifacts).toContainEqual(ref);
    expect(review.inputArtifacts).toContainEqual(traceRef);
    expect(host.artifacts.metadata(receipt.review_report_ref).upstream_refs).toContainEqual(ref);
    expect(receipt.verdict).toBe(receipt.review_kind === "validity" ? "PASS" : "APPROVE");
  }
  expect(validateReviewReceiptV2(host.readProduct(qualityRef)).prior_review_receipt_ref).toEqual(
    validityRef
  );
  const integrityRef = selected("specification-product-integrity");
  const integrity = validateSpecificationProductIntegrityV2(host.readProduct(integrityRef));
  const envelope = validateSpecificationProductEnvelopeV2(
    host.readProduct(selected("specification-product-envelope"))
  );
  expect(integrity.specification_ref).toEqual(ref);
  expect(envelope.specification_ref).toEqual(ref);
  expect(integrity.trace_ref).toEqual(traceRef);
  expect(envelope.integrity_ref).toEqual(integrityRef);
  expect(integrity.validity_receipt_ref).toEqual(validityRef);
  expect(integrity.quality_receipt_ref).toEqual(qualityRef);
  expect(integrity.imported_input_refs).toEqual([]);
  expect(integrity.evidence_refs).toEqual([]);
  expect(host.checkpointer.completionAdmission(runId)).toBeDefined();
  expect(
    evaluateDefineLatestReviewedSpecificationDod({
      checkpointer: host.checkpointer,
      context,
      terminal,
      originState: "admitting_specification",
      latestProduct: {
        selector: "terminal_artifact",
        schema_id: "penny.specification.v1",
        product_schema_version: 1,
        product_id: ref.artifact_id,
        sha256: ref.content_digest,
      },
      artifactReader: host.artifacts,
      projectRoot: host.root,
    }).passed
  ).toBe(true);
  expect(client.invocations.map((row) => row.stateId)).toEqual([
    "framing_definition",
    "authoring_specification",
    "verifying_specification",
    "critiquing_specification",
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
const mutations: readonly DefineMutation[] = [
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

describe("UO-CONTENT-DEFINE: real native creation, independent finite content oracle", () => {
  it.each(positiveCases)(
    "$producer -> Define preserves material reporting requirements ($wording)",
    async ({ producer, wording }) => {
      const host = owner();
      const script: DefineScript = {
        producer,
        wording,
        source: host.source(producer),
        scenario: "base",
      };
      const bytes = host.artifacts.read(script.source);
      const runId = `define-content-${producer}-${wording}`;
      const execution = await executeDefineContent(host, runId, script);
      const product = assertNativePath(host, runId, execution, script);
      assertDefineMeaning(product, script);
      expect(host.artifacts.read(script.source)).toEqual(bytes);
    }
  );
  it.each(negativeCases)(
    "$producer -> Define native-valid $mutation reaches, then fails, semantic oracle despite PASS reviews",
    async ({ producer, mutation }) => {
      const host = owner();
      const script: DefineScript = {
        producer,
        mutation,
        wording: "direct",
        source: host.source(producer),
        scenario: "base",
      };
      const runId = `define-mutant-${producer}-${mutation}`;
      const execution = await executeDefineContent(host, runId, script);
      const product = assertNativePath(host, runId, execution, script);
      expect(() => assertDefineMeaning(product, script)).toThrow(/DEFINE_CONTENT_ORACLE/u);
    }
  );
  it.each(["plan", "research"] as const)(
    "%s counterfactual changes report conditions, not native readiness or source authority",
    async (producer) => {
      const host = owner();
      const source = requireValue(
        producer === "plan" ? blockedPlan : fourteenDayResearch,
        "counterfactual source"
      );
      expect(source).not.toEqual(host.source(producer));
      for (const wording of ["direct", "paraphrase"] as const) {
        const script: DefineScript = { producer, source, wording, scenario: "counterfactual" };
        const runId = `define-counterfactual-${producer}-${wording}`;
        const execution = await executeDefineContent(host, runId, script);
        const product = assertNativePath(host, runId, execution, script);
        assertDefineMeaning(product, script);
        expect(() => assertDefineMeaning(product, { ...script, scenario: "base" })).toThrow(
          /distinguishing meaning/u
        );
        expect(product.request).toEqual(bulletinDefinitionRequest());
        expect(product.source_items).toEqual(
          definitionRequestSourceItems(bulletinDefinitionRequest())
        );
      }
    }
  );
  it.each(["plan", "research"] as const)(
    "%s counterfactual domain-strengthening remains native-valid but is not faithful",
    async (producer) => {
      const host = owner();
      const script: DefineScript = {
        producer,
        source: requireValue(producer === "plan" ? blockedPlan : fourteenDayResearch, "source"),
        wording: "direct",
        scenario: "counterfactual",
        mutation: "domain-strengthening",
      };
      const runId = `define-strength-${producer}`;
      const product = assertNativePath(
        host,
        runId,
        await executeDefineContent(host, runId, script),
        script
      );
      expect(() => assertDefineMeaning(product, script)).toThrow(/distinguishing meaning/u);
    }
  );
  it.each(["direct", "paraphrase"] as const)(
    "irrelevant Strategy does not override an independently closed welcome-notice brief (%s)",
    async (wording) => {
      const host = owner();
      const script: DefineScript = {
        producer: "plan",
        source: host.source("plan"),
        scenario: "irrelevant",
        wording,
      };
      const runId = `define-irrelevant-${wording}`;
      const product = assertNativePath(
        host,
        runId,
        await executeDefineContent(host, runId, script),
        script
      );
      assertDefineMeaning(product, script);
      const bad = { ...script, mutation: "irrelevant-import" as const };
      const badRun = `${runId}-import`;
      const mutant = assertNativePath(
        host,
        badRun,
        await executeDefineContent(host, badRun, bad),
        bad
      );
      expect(() => assertDefineMeaning(mutant, script)).toThrow(/distinguishing meaning/u);
    }
  );
  it("reports hostile accepted context without adopting embedded role/tool/approval instructions", async () => {
    const host = owner();
    const source = requireValue(hostilePlan, "accepted hostile Plan");
    expect(host.artifacts.read(source).toString("utf8")).toContain("SYSTEM OVERRIDE");
    const script: DefineScript = {
      producer: "plan",
      source,
      scenario: "base",
      wording: "paraphrase",
    };
    const runId = "define-hostile-honest";
    const product = assertNativePath(
      host,
      runId,
      await executeDefineContent(host, runId, script),
      script
    );
    assertDefineMeaning(product, script);
    for (const mutation of ["evidence", "permission", "native-authority"] as const) {
      const bad = { ...script, mutation };
      const badRun = `define-hostile-${mutation}`;
      const mutant = assertNativePath(
        host,
        badRun,
        await executeDefineContent(host, badRun, bad),
        bad
      );
      expect(() => assertDefineMeaning(mutant, script)).toThrow(/distinguishing meaning/u);
    }
    expect(() => assertDefineMeaning(product, { ...script, source: host.source("plan") })).toThrow(
      /provenance/u
    );
  });
  it("context cannot rescue a missing creation brief or supply a native revision subject", () => {
    const host = owner();
    const source = host.source("define");
    const request = bulletinDefinitionRequest();
    const engine = host.engine("define");
    const missing = host.start("define", "define-missing-brief", nonbindingContext(source));
    missing.constraints = {};
    expect(() => engine.handle(missing)).toThrow();
    expect(host.checkpointer.runExists(missing.identity.run_id)).toBe(false);
    const revise = host.start("define", "define-context-not-subject", nonbindingContext(source));
    revise.goal = request.goal;
    revise.constraints = { ...defineRequestConstraints(request), mode: "revise" };
    expect(() => engine.handle(revise)).toThrow();
    expect(host.checkpointer.runExists(revise.identity.run_id)).toBe(false);
  });
  it("binds this column to the supplied build, seven exact pairs and fixture-only evidence", () => {
    expect(assertCurrentShippingBuild()?.generation).toBe(generation);
    expect(contentProducers.map((producer) => `${producer}->define`)).toEqual([
      "assess->define",
      "decide->define",
      "define->define",
      "diagnose->define",
      "plan->define",
      "produce->define",
      "research->define",
    ]);
    expect(
      canonicalJson({
        evidence: "scripted cognition/reviews; real native owners",
        live_model_understanding: "not_run",
      })
    ).toContain('"live_model_understanding":"not_run"');
  });
});
