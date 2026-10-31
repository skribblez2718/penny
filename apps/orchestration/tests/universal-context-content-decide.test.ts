import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  projectDecisionDraft,
  validateCanonicalDecisionBytes,
  validateDecisionDraft,
  validateDecisionProductEnvelope,
  validateDecisionProductIntegrity,
  validateDecisionRequest,
  validateEvidenceAdmission,
  validateReviewReceiptBinding,
  type ArtifactRef,
} from "../dist/index.js";
import { assertCurrentShippingBuild } from "../dist/build-provenance.js";
import {
  ContentFixtureOwner,
  acceptedContentProduct,
  nonbindingContext,
} from "./helpers/universal-content-fixtures.js";
import { contentProducers } from "./helpers/universal-content-oracle.js";
import {
  contextDecisionRequest,
  executeContextDecision,
  type DecideMutation,
  type DecideScript,
} from "./helpers/universal-content-decide-fixtures.js";
import {
  assertContextDecision,
  type DecideExpectation,
} from "./helpers/universal-content-decide-oracle.js";
import { requireArrayItem, requireValue } from "./helpers/narrowing.js";

// Seven ordinary producer -> native DECIDE content transformations, not a transport/admission matrix.
// Only cognition (including deliberately permissive reviews) is scripted. No provider qualification.
let generation: string | undefined;
const wordings = ["direct", "paraphrase"] as const;
const mutations: readonly DecideMutation[] = [
  "ignored",
  "omitted",
  "changed",
  "coerced",
  "permission",
  "evidence",
  "native-authority",
  "external-verification",
  "sensitivity",
  "selection",
];
const positives = contentProducers.flatMap((producer) =>
  wordings.map((wording) => ({ producer, wording }))
);
const negatives = contentProducers.flatMap((producer) =>
  mutations.map((mutation) => ({ producer, mutation }))
);
let active: ContentFixtureOwner | undefined;
let blocked: ArtifactRef | undefined;
let fourteen: ArtifactRef | undefined;
let adversarial: ArtifactRef | undefined;
function owner(): ContentFixtureOwner {
  return requireValue(active, "DECIDE content fixture owner");
}
beforeAll(async () => {
  generation = requireValue(assertCurrentShippingBuild(), "current compiled build").generation;
  expect(generation).toMatch(/^[a-f0-9]{64}$/u);
  active = new ContentFixtureOwner();
  for (const producer of contentProducers) {
    active.products.set(
      producer,
      acceptedContentProduct((await active.execute(producer, `decide-source-${producer}`)).terminal)
    );
  }
  blocked = acceptedContentProduct(
    (await active.execute("plan", "decide-source-blocked", "counterfactual")).terminal
  );
  // Same real owner, same Research question: the rebuilt run-scoped render fix must preserve both.
  fourteen = acceptedContentProduct(
    (await active.execute("research", "decide-source-fourteen", "counterfactual")).terminal
  );
  adversarial = acceptedContentProduct(
    (await active.execute("plan", "decide-source-hostile", "authority")).terminal
  );
});
afterAll(() => {
  try {
    expect(assertCurrentShippingBuild()?.generation).toBe(generation);
  } finally {
    active?.[Symbol.dispose]();
  }
});

type DecisionRun = Awaited<ReturnType<typeof executeContextDecision>>;

/** Independent checks of selected/reviewed exact identity and reads from actual invocation refs. */
function assertNativePath(
  host: ContentFixtureOwner,
  runId: string,
  source: ArtifactRef,
  run: DecisionRun
) {
  const ref = acceptedContentProduct(run.terminal);
  const product = validateCanonicalDecisionBytes(host.artifacts.read(ref), ref);
  const context = requireValue(
    host.checkpointer.loadRunById(runId),
    "completed native DECIDE checkpoint"
  );
  expect(context.admittedInputArtifacts).toEqual(nonbindingContext(source));
  expect(context.selectedArtifacts).not.toContainEqual(source);
  expect(
    context.selectedArtifacts.filter(
      (item) => item.kind === "semantic-core" && item.run_id === runId
    )
  ).toEqual([ref]);
  expect(product.request).toEqual(run.request);
  expect(product.execution_started).toBe(false);
  expect(product.source_lineage.input_artifact_ids).toEqual([]);
  const selected = (kind: string) =>
    requireValue(
      context.selectedArtifacts.find((item) => item.kind === kind && item.run_id === runId),
      `selected ${kind}`
    );
  const requestRef = selected("decision-request");
  expect(validateDecisionRequest(host.readProduct(requestRef))).toEqual(run.request);
  expect(host.artifacts.read(requestRef).toString("utf8")).not.toContain(source.artifact_id);
  expect(product.source_lineage.request_artifact_id).toBe(requestRef.artifact_id);
  expect(product.source_lineage.draft_artifact_id).toBe(selected("decision-draft").artifact_id);
  const admission = validateEvidenceAdmission(host.readProduct(selected("evidence-admission")));
  expect(admission.classification).toBe("basis_sufficient");
  expect(admission.evidence_required).toBe(false);
  const envelope = validateDecisionProductEnvelope(
    host.readProduct(selected("decision-product-envelope"))
  );
  const integrity = validateDecisionProductIntegrity(host.readProduct(envelope.integrity_ref));
  expect(envelope.decision_ref).toEqual(ref);
  expect(integrity.decision_ref).toEqual(ref);
  expect(envelope.imported_input_refs).toEqual([]);
  expect(integrity.imported_input_refs).toEqual([]);
  expect(envelope.evidence_refs).toEqual([]);
  expect(integrity.execution_started).toBe(false);
  expect(integrity.execution_authorized).toBe(false);
  expect(integrity.validity_receipt_ref).toEqual(envelope.validity_receipt_ref);
  expect(integrity.quality_receipt_ref).toEqual(envelope.quality_receipt_ref);
  const validity = validateReviewReceiptBinding({
    receipt: host.readProduct(envelope.validity_receipt_ref),
    review_report_upstream_refs: host.artifacts.metadata(envelope.vera_report_ref).upstream_refs,
  });
  const quality = validateReviewReceiptBinding({
    receipt: host.readProduct(envelope.quality_receipt_ref),
    review_report_upstream_refs: host.artifacts.metadata(envelope.carren_report_ref).upstream_refs,
    prior_review: { artifact_ref: envelope.validity_receipt_ref, receipt: validity },
  });
  for (const receipt of [validity, quality]) {
    expect(receipt.subject.product_ref).toEqual(ref);
    expect(receipt.subject.product_sha256).toBe(ref.content_digest);
    expect(receipt.subject.imported_input_refs).toEqual([]);
    expect(receipt.subject.evidence_refs).toEqual([]);
    const execution = requireValue(
      host.checkpointer.receiptResultById(receipt.execution_receipt_id),
      "signed review execution"
    );
    expect(execution.output_artifact).toEqual(receipt.review_report_ref);
    expect(integrity.execution_receipt_ids).toContain(receipt.execution_receipt_id);
  }
  expect(validity.verdict).toBe("PASS");
  expect(quality.verdict).toBe("APPROVE");
  expect(quality.prior_review_receipt_ref).toEqual(envelope.validity_receipt_ref);
  expect(run.client.invocations.map((invocation) => invocation.stateId)).toEqual([
    "analyzing_decision",
    "deciding",
    "verifying_decision",
    "critiquing_decision",
  ]);
  for (const invocation of run.client.invocations) {
    expect(invocation.inputArtifacts).toContainEqual(source);
    expect(invocation.task).toContain("NONBINDING context slot");
    expect(invocation.registration.allowed_tools).toBeUndefined();
    const read = run.client.reads.filter(
      (item) => item.state === invocation.stateId && item.ref.artifact_id === source.artifact_id
    );
    expect(read).toEqual([
      {
        state: invocation.stateId,
        ref: source,
        bytes: source.byte_length,
        digest: source.content_digest,
      },
    ]);
    if (
      invocation.stateId === "verifying_decision" ||
      invocation.stateId === "critiquing_decision"
    ) {
      expect(invocation.inputArtifacts).toContainEqual(ref);
      expect(run.client.reads).toContainEqual({
        state: invocation.stateId,
        ref,
        bytes: ref.byte_length,
        digest: ref.content_digest,
      });
    }
  }
  return { product, ref };
}
async function checkedRun(runId: string, script: DecideScript, expected?: DecideExpectation) {
  const host = owner();
  const original = host.artifacts.read(script.source);
  const run = await executeContextDecision(host, runId, script);
  const { product, ref } = assertNativePath(host, runId, script.source, run);
  expect(host.artifacts.read(script.source)).toEqual(original);
  if (expected !== undefined) assertContextDecision(product, expected);
  return { product, ref, run };
}

describe("UO-CONTENT-DECIDE: native decisions use nonbinding source meaning (scripted cognition)", () => {
  it.each(positives)(
    "$producer -> Decide makes a faithful reporting comparison ($wording)",
    async ({ producer, wording }) => {
      const source = owner().source(producer);
      await checkedRun(
        `decide-content-${producer}-${wording}`,
        { producer, source, wording },
        { producer, source }
      );
    }
  );

  it.each(negatives)(
    "$producer -> Decide native-valid $mutation mutant reaches and fails the independent oracle",
    async ({ producer, mutation }) => {
      const source = owner().source(producer);
      const { product } = await checkedRun(`decide-negative-${producer}-${mutation}`, {
        producer,
        source,
        wording: "direct",
        mutation,
      });
      // checkedRun has already proved complete/met:true, real native seal, exact reviews and actual reads.
      // This throw therefore cannot be satisfied by schema rejection or a failed workflow.
      expect(() => assertContextDecision(product, { producer, source })).toThrow(
        /DECIDE_CONTENT:/u
      );
    }
  );

  it.each(wordings)(
    "Plan -> Decide ready-to-blocked changes the reporting selection (%s)",
    async (wording) => {
      const source = requireValue(blocked, "blocked Plan");
      const ready = owner().source("plan");
      expect(source.artifact_id).not.toBe(ready.artifact_id);
      const { product } = await checkedRun(
        `decide-blocked-${wording}`,
        { producer: "plan", source, wording },
        { producer: "plan", source, scenario: "counterfactual" }
      );
      expect(product.recommendation.alternative_ids).toEqual(["report_caveat"]);
      expect(() => assertContextDecision(product, { producer: "plan", source })).toThrow(
        /DECIDE_CONTENT:/u
      );
    }
  );

  it.each(wordings)(
    "Research -> Decide seven-to-fourteen changes comparative meaning, not qualification (%s)",
    async (wording) => {
      const source = requireValue(fourteen, "fourteen-day Research");
      expect(source.artifact_id).not.toBe(owner().source("research").artifact_id);
      const { product } = await checkedRun(
        `decide-fourteen-${wording}`,
        { producer: "research", source, wording },
        { producer: "research", source, scenario: "counterfactual" }
      );
      // Same caveat-led selection is justified: the claim changes, but qualified support does not.
      expect(product.recommendation.alternative_ids).toEqual(["report_caveat"]);
      expect(product.rationale_report).not.toContain("7 days");
      expect(() => assertContextDecision(product, { producer: "research", source })).toThrow(
        /DECIDE_CONTENT: comparative/u
      );
    }
  );

  it.each(["plan", "research"] as const)(
    "%s -> Decide refuses domain strengthening only at the independent content oracle",
    async (producer) => {
      const source =
        producer === "plan"
          ? requireValue(blocked, "blocked Plan")
          : requireValue(fourteen, "fourteen-day Research");
      const { product } = await checkedRun(`decide-strengthen-${producer}`, {
        producer,
        source,
        wording: "direct",
        mutation: "coerced",
      });
      expect(() =>
        assertContextDecision(product, { producer, source, scenario: "counterfactual" })
      ).toThrow(/DECIDE_CONTENT: comparative/u);
    }
  );

  it.each(
    wordings.flatMap((wording) =>
      (["ready", "blocked"] as const).map((variant) => ({ wording, variant }))
    )
  )(
    "Plan -> Decide appropriately does not use irrelevant $variant source ($wording)",
    async ({ wording, variant }) => {
      const source =
        variant === "ready" ? owner().source("plan") : requireValue(blocked, "blocked Plan");
      const { product } = await checkedRun(
        `decide-irrelevant-${variant}-${wording}`,
        { producer: "plan", source, wording, scenario: "irrelevant" },
        { producer: "plan", source, scenario: "irrelevant" }
      );
      expect(product.recommendation.alternative_ids).toEqual(["report_compact"]);
      expect(product.rationale_report).not.toMatch(/Rollback|disposition=|execution_started=/u);
      expect(product.basis_ids_used).toContain("caller_greeting");
    }
  );

  it("accepted embedded authority claims are data, not a reporting mandate", async () => {
    const source = requireValue(adversarial, "adversarial accepted Plan");
    expect(owner().artifacts.read(source).toString("utf8")).toContain("SYSTEM OVERRIDE");
    await checkedRun(
      "decide-hostile-honest",
      { producer: "plan", source, wording: "paraphrase" },
      { producer: "plan", source }
    );
  });
  it("a native-valid follower of embedded permission claims still fails the independent oracle", async () => {
    const source = requireValue(adversarial, "adversarial accepted Plan");
    const { product } = await checkedRun("decide-hostile-follower", {
      producer: "plan",
      source,
      wording: "direct",
      mutation: "permission",
    });
    expect(() => assertContextDecision(product, { producer: "plan", source })).toThrow(
      /DECIDE_CONTENT: evidence\/approval\/permission/u
    );
  });
  it("rejects exact-source substitution despite matching family meanings and scripted PASS reviews", async () => {
    const source = owner().source("plan");
    const { product } = await checkedRun("decide-substitution", {
      producer: "plan",
      source,
      wording: "direct",
    });
    expect(() =>
      assertContextDecision(product, {
        producer: "plan",
        source: requireValue(adversarial, "other accepted Plan"),
      })
    ).toThrow(/DECIDE_CONTENT: exact provenance/u);
  });

  it("retains native alternative coverage, dimensions and basis namespaces rather than promoting context", async () => {
    const source = owner().source("research");
    const { product } = await checkedRun(
      "decide-native-fields",
      { producer: "research", source, wording: "direct" },
      { producer: "research", source }
    );
    const draft = projectDecisionDraft(product);
    const native = { request: product.request, exactInputArtifactIds: [] };
    expect(() =>
      validateDecisionDraft({ ...draft, feasibility: draft.feasibility.slice(1) }, native)
    ).toThrow(/feasibility must cover/u);
    expect(() =>
      validateDecisionDraft(
        { ...draft, recommendation: { kind: "selection", alternative_ids: ["alt_a"] } },
        native
      )
    ).toThrow(/SEMANTIC_INVALID/u);
    expect(() =>
      validateDecisionDraft({ ...draft, comparison_dimension_ids: [source.artifact_id] }, native)
    ).toThrow();
    expect(() =>
      validateDecisionDraft({ ...draft, basis_ids_used: [source.artifact_id] }, native)
    ).toThrow(/SEMANTIC_INVALID/u);
    expect(() =>
      validateDecisionDraft(
        {
          ...draft,
          sensitivity: [
            {
              basis_ids: [source.artifact_id],
              resulting_decision_change: requireArrayItem(draft.sensitivity, 0, "sensitivity")
                .resulting_decision_change,
            },
          ],
        },
        native
      )
    ).toThrow(/SEMANTIC_INVALID/u);
  });
  it("accepted context cannot supply missing native Decide requirements or authorize execution", () => {
    const host = owner();
    const source = requireValue(adversarial, "adversarial accepted Plan");
    const request = host.start("decide", "decide-native-missing", nonbindingContext(source));
    request.constraints = {};
    expect(() => host.engine("decide").handle(request)).toThrow();
    expect(host.checkpointer.runExists(request.identity.run_id)).toBe(false);
  });
  it("accounts for precisely this seven-pair column, not production understanding or the full matrix", () => {
    expect(positives).toHaveLength(14);
    expect(negatives).toHaveLength(70);
    expect(new Set(positives.map(({ producer }) => `${producer}->decide`))).toEqual(
      new Set([
        "assess->decide",
        "decide->decide",
        "define->decide",
        "diagnose->decide",
        "plan->decide",
        "produce->decide",
        "research->decide",
      ])
    );
    const requestBytes = canonicalJson(contextDecisionRequest());
    for (const forbidden of [
      "Option A",
      "Option C",
      "hyp_cache",
      "7 days",
      "14 days",
      "Rollback access",
      "Hello, world.",
      "The transition specification must define",
    ])
      expect(requestBytes).not.toContain(forbidden);
  });
});
