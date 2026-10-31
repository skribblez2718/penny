import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256,
  validateCanonicalProducedArtifactV2Bytes,
  validateProduceRequest,
  validateProduceQualityReceiptV2,
  validateProduceValidityReceiptV2,
  validateProduceProductIntegrityV2,
  validateProduceProductEnvelopeV2,
  type ArtifactRef,
} from "../dist/index.js";
import { assertCurrentShippingBuild } from "../dist/build-provenance.js";
import { validateProduceMechanicalChecks } from "../dist/skill-contracts/produce.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { requireArrayItem, requireValue } from "./helpers/narrowing.js";
import {
  ContentFixtureOwner,
  acceptedContentProduct,
  nonbindingContext,
  type ContentMutation,
  type ReaderScript,
} from "./helpers/universal-content-fixtures.js";
import {
  assertReaderBrief,
  contentProducers,
  produceContentPairs,
  otherConsumerContentPairs,
} from "./helpers/universal-content-oracle.js";

// UO-CONTENT-1 owns seven real-native producer families -> Produce.
// This is executable, independent fixture-oracle evidence, NOT production-model understanding.
// The other six consumer columns have separate native suites; this suite does not claim them.
const positiveCases = contentProducers.flatMap((producer) =>
  (["direct", "paraphrase"] as const).map((wording) => ({ producer, wording }))
);
const mutations: readonly ContentMutation[] = [
  "ignored",
  "omitted",
  "changed",
  "coerced",
  "authority",
  "summary-contradiction",
];
const negativeCases = contentProducers.flatMap((producer) =>
  mutations.map((mutation) => ({ producer, mutation }))
);
let generation: string | undefined;
let active: ContentFixtureOwner | undefined;
let blockedPlan: ArtifactRef | undefined;
let adversarialPlan: ArtifactRef | undefined;
function owner(): ContentFixtureOwner {
  return requireValue(active, "content owner");
}

beforeAll(async () => {
  // Fresh Vitest process loads and checks the current compiled generation; never rebuild here.
  generation = requireValue(assertCurrentShippingBuild(), "current compiled build").generation;
  expect(generation).toMatch(/^[a-f0-9]{64}$/u);
  active = new ContentFixtureOwner();
  for (const producer of contentProducers) {
    const { terminal } = await active.execute(producer, `content-source-${producer}`);
    active.products.set(producer, acceptedContentProduct(terminal));
  }
  blockedPlan = acceptedContentProduct(
    (await active.execute("plan", "content-source-plan-blocked", "counterfactual")).terminal
  );
  adversarialPlan = acceptedContentProduct(
    (await active.execute("plan", "content-source-plan-authority", "authority")).terminal
  );
});
afterAll(() => {
  try {
    expect(assertCurrentShippingBuild()?.generation).toBe(generation);
  } finally {
    active?.[Symbol.dispose]();
  }
});

type ContentRun = Awaited<ReturnType<ContentFixtureOwner["execute"]>>;

/** Exact current-product custody, independent of the semantic oracle (including for mutants). */
function assertRealReaderPath(
  host: ContentFixtureOwner,
  runId: string,
  source: ArtifactRef,
  run: ContentRun
) {
  const ref = acceptedContentProduct(run.terminal);
  const product = validateCanonicalProducedArtifactV2Bytes(host.artifacts.read(ref), ref);
  const context = requireValue(host.checkpointer.loadRunById(runId), "completed reader checkpoint");
  expect(context.terminalDirective).toEqual(run.terminal);
  expect(context.admittedInputArtifacts).toEqual(nonbindingContext(source));
  expect(context.selectedArtifacts).not.toContainEqual(source);
  const selected = (kind: string, phase?: string) => {
    const matches = context.selectedArtifacts.filter(
      (item) =>
        item.run_id === runId && item.kind === kind && (phase === undefined || item.phase === phase)
    );
    // These fixtures have no repair/revision: an extra candidate must not hide stale binding.
    expect(matches).toHaveLength(1);
    return requireArrayItem(matches, 0, `current ${kind}/${phase ?? "native"}`);
  };
  expect(selected("semantic-core")).toEqual(ref);
  const request = selected("produce-request");
  const approach = selected("artifact-approach");
  const decision = selected("artifact-approach-decision");
  const draft = selected("produced-artifact-draft");
  const subject = [request, approach, decision, draft, ref];
  const mechanicalChecks = selected("produce-mechanical-checks", "sealing_artifact");
  const mechanicalEvidence = validateProduceMechanicalChecks(host.readProduct(mechanicalChecks));
  expect(mechanicalChecks.producer).toBe("host:produce-product-validator");
  expect(mechanicalEvidence).toMatchObject({
    status: "PASS",
    run_id: runId,
    request_ref: request,
    approach_ref: approach,
    decision_ref: decision,
    draft_ref: draft,
    product_ref: ref,
    product_effect_evidence_sha256: sha256(canonicalJson(product.effect_evidence)),
    scope: "host_mechanical_only_not_semantic_or_effect_absence",
  });
  expect(host.artifacts.metadata(mechanicalChecks).upstream_refs).toEqual(subject);
  expect(canonicalJson(mechanicalEvidence)).not.toContain(source.artifact_id);
  const carren = selected("agent-output", "critiquing_artifact");
  const vera = selected("agent-output", "verifying_artifact");
  const qualityRef = selected("produce-quality-receipt");
  const validityRef = selected("produce-validity-receipt");
  const integrityRef = selected("produce-product-integrity");
  const envelopeRef = selected("produce-product-envelope");
  // Context remains a separate nonbinding operand, not native input/source authority.
  expect(host.artifacts.read(request).toString("utf8")).not.toContain(source.artifact_id);
  expect(product.request).toEqual(validateProduceRequest(host.readProduct(request)));
  expect(canonicalJson(product.source_lineage)).not.toContain(source.artifact_id);
  expect(product.source_lineage).toMatchObject({
    request_artifact_id: request.artifact_id,
    request_artifact_sha256: request.content_digest,
    approach_artifact_id: approach.artifact_id,
    approach_artifact_sha256: approach.content_digest,
    decision_artifact_id: decision.artifact_id,
    decision_artifact_sha256: decision.content_digest,
    draft_artifact_id: draft.artifact_id,
    draft_artifact_sha256: draft.content_digest,
  });
  const quality = validateProduceQualityReceiptV2(host.readProduct(qualityRef));
  const validity = validateProduceValidityReceiptV2(host.readProduct(validityRef));
  const integrity = validateProduceProductIntegrityV2(host.readProduct(integrityRef));
  const envelope = validateProduceProductEnvelopeV2(host.readProduct(envelopeRef));
  for (const value of [quality, validity, integrity, envelope]) {
    expect(value.request_ref).toEqual(request);
    expect(value.approach_ref).toEqual(approach);
    expect(value.decision_ref).toEqual(decision);
    expect(value.draft_ref).toEqual(draft);
    expect(value.product_ref).toEqual(ref);
    expect(value.product_ref.content_digest).toBe(ref.content_digest);
    expect(value.carren_report_ref).toEqual(carren);
    expect(value.effect_evidence).toEqual(quality.effect_evidence);
  }
  expect(quality.run_id).toBe(runId);
  expect(validity.run_id).toBe(runId);
  expect(envelope.run_id).toBe(runId);
  for (const value of [validity, integrity, envelope]) {
    expect(value.vera_report_ref).toEqual(vera);
    expect(value.quality_receipt_ref).toEqual(qualityRef);
  }
  expect(integrity.validity_receipt_ref).toEqual(validityRef);
  expect(envelope.validity_receipt_ref).toEqual(validityRef);
  expect(envelope.integrity_ref).toEqual(integrityRef);
  expect(integrity.product_effect_evidence_sha256).toBe(
    sha256(canonicalJson(product.effect_evidence))
  );
  expect(product.effect_evidence.assurance).toBe("unknown");
  expect(quality.effect_evidence.assurance).toBe("unknown");
  expect(quality.verdict).toBe("APPROVE");
  expect(validity.verdict).toBe("PASS");
  expect(integrity.status).toBe("PASS");
  expect(envelope.status).toBe("complete");

  expect(run.client.invocations.map((invocation) => invocation.stateId)).toEqual([
    "exploring_artifact_approaches",
    "selecting_artifact_approach",
    "materializing_artifact",
    "critiquing_artifact",
    "verifying_artifact",
  ]);
  for (const invocation of run.client.invocations) {
    expect(invocation.inputArtifacts).toContainEqual(source);
    expect(invocation.task).toContain("NONBINDING context slot");
    expect(invocation.registration.allowed_tools).toBeUndefined();
    // The observations come from ArtifactStore.read buffers, not from refs echoed by a stub.
    // This proves full source reads in all five phases and exact product bytes in both reviews.
    expect(run.client.reads.filter((read) => read.state === invocation.stateId)).toEqual(
      invocation.inputArtifacts.map((input) => ({
        state: invocation.stateId,
        ref: input,
        byteLength: input.byte_length,
        sha256: input.content_digest,
      }))
    );
  }
  for (const { receipt, state, agent, report, verdict, upstreams } of [
    {
      receipt: quality,
      state: "critiquing_artifact",
      agent: "carren",
      report: carren,
      verdict: "APPROVE",
      upstreams: subject,
    },
    {
      receipt: validity,
      state: "verifying_artifact",
      agent: "vera",
      report: vera,
      verdict: "PASS",
      upstreams: [...subject, carren, mechanicalChecks],
    },
  ]) {
    const invocation = requireValue(
      run.client.invocations.find((item) => item.stateId === state),
      `current ${agent} invocation`
    );
    expect(invocation.agent).toBe(agent);
    expect(
      invocation.inputArtifacts.filter((input) => input.artifact_id !== source.artifact_id)
    ).toEqual(upstreams);
    expect(host.artifacts.metadata(report).upstream_refs).toEqual(upstreams);
    expect(run.client.reads).toContainEqual({
      state,
      ref,
      byteLength: ref.byte_length,
      sha256: ref.content_digest,
    });
    const execution = requireValue(
      host.checkpointer.receiptResultById(receipt.execution_receipt_id),
      `signed ${agent} execution`
    );
    const signed = TEST_RECEIPT_AUTHORITY.verify(execution.worker_receipt);
    expect(execution).toMatchObject({
      run_id: runId,
      state_id: state,
      agent,
      output_artifact: report,
      details: { verdict, gap_kind: "none", repair_owner: "none" },
    });
    expect(execution.branch_id).toBeUndefined();
    expect(receipt.execution_result_sha256).toBe(sha256(canonicalJson(execution)));
    expect(receipt.created_at).toBe(signed.ended_at);
    expect(signed).toMatchObject({
      receipt_id: receipt.execution_receipt_id,
      run_id: runId,
      state_id: state,
      agent,
      branch_id: null,
      attempt: execution.attempt,
      exit_code: 0,
      working_directory: host.root,
      trust_profile: "hardened-untrusted",
      output_artifact_ref: report,
      output_digest: report.content_digest,
    });
    expect(sha256(host.artifacts.read(report))).toBe(signed.output_digest);
    expect(integrity.execution_receipt_ids).toContain(receipt.execution_receipt_id);
  }
  const executions = integrity.execution_receipt_ids.map((id) =>
    requireValue(host.checkpointer.receiptResultById(id), "integrity execution result")
  );
  expect(executions.map((execution) => execution.output_artifact)).toEqual([
    approach,
    decision,
    draft,
    carren,
    vera,
  ]);
  const admission = requireValue(
    host.checkpointer.completionAdmission(runId),
    "positive Produce admission"
  );
  expect(admission).toMatchObject({
    run_id: runId,
    origin_state: "admitting_artifact",
    terminal_digest: sha256(canonicalJson(run.terminal)),
    latest_product: {
      selector: "terminal_artifact",
      schema_id: "penny.produced-artifact.v2",
      product_schema_version: 2,
      product_id: ref.artifact_id,
      sha256: ref.content_digest,
    },
    unresolved_count: 0,
  });
  for (const execution of executions) {
    expect(admission.evidence_refs).toContainEqual({
      kind: "execution_receipt",
      reference_id: execution.worker_receipt.receipt_id,
      sha256: sha256(canonicalJson(execution)),
    });
  }
  return { product, ref };
}

/** Every completed reader (positive, mutant, counterfactual, irrelevant) gets the same custody checks. */
async function checkedRun(host: ContentFixtureOwner, runId: string, script: ReaderScript) {
  const original = host.artifacts.read(script.source);
  const run = await host.execute("produce", runId, "base", script);
  const checked = assertRealReaderPath(host, runId, script.source, run);
  expect(host.artifacts.read(script.source)).toEqual(original);
  return checked;
}

describe("UO-CONTENT-1 independent content oracles (scripted cognition, real native owners)", () => {
  it("distinguishes its seven Produce pairs from the forty-two pairs owned by other native suites", () => {
    expect(produceContentPairs).toEqual(
      contentProducers.map((producer) => ({ producer, consumer: "produce" }))
    );
    expect(otherConsumerContentPairs).toHaveLength(42);
    expect(
      new Set(
        [...produceContentPairs, ...otherConsumerContentPairs].map(
          ({ producer, consumer }) => `${producer}->${consumer}`
        )
      ).size
    ).toBe(49);
    expect([...new Set(otherConsumerContentPairs.map(({ consumer }) => consumer))]).toEqual([
      "assess",
      "decide",
      "define",
      "diagnose",
      "plan",
      "research",
    ]);
  });

  it.each(positiveCases)(
    "$producer -> Produce preserves distinguishing native meaning ($wording)",
    async ({ producer, wording }) => {
      const host = owner();
      const source = host.source(producer);
      const runId = `content-${producer}-${wording}`;
      const { product } = await checkedRun(host, runId, {
        producer,
        source,
        scenario: "base",
        wording,
      });
      assertReaderBrief(product, { producer, source, scenario: "base" });
    }
  );

  it.each(negativeCases)(
    "$producer -> Produce oracle rejects $mutation despite scripted native review acceptance",
    async ({ producer, mutation }) => {
      const host = owner();
      const source = host.source(producer);
      const { product: nativeProduct } = await checkedRun(
        host,
        `content-negative-${producer}-${mutation}`,
        {
          producer,
          source,
          scenario: "base",
          wording: "direct",
          mutation,
        }
      );
      // Intentionally demonstrate the difference: native schema/seal/reviews can complete with
      // scripted reviewers; only the separately authored task-content oracle rejects this mutant.
      expect(() =>
        assertReaderBrief(nativeProduct, { producer, source, scenario: "base" })
      ).toThrow(
        mutation === "coerced" || mutation === "authority"
          ? /promoted/u
          : mutation === "summary-contradiction"
            ? /summary does not preserve/u
            : /distinguishing meaning/u
      );
    }
  );

  it.each(["direct", "paraphrase"] as const)(
    "Plan -> Produce honors a genuinely blocked counterfactual (%s)",
    async (wording) => {
      const host = owner();
      const source = requireValue(blockedPlan, "accepted blocked StrategyV2");
      expect(source.artifact_id).not.toBe(host.source("plan").artifact_id);
      const { product } = await checkedRun(host, `content-blocked-${wording}`, {
        producer: "plan",
        source,
        scenario: "counterfactual",
        wording,
      });
      const brief = assertReaderBrief(product, {
        producer: "plan",
        source,
        scenario: "counterfactual",
      });
      expect(brief.facts["disposition"]).toBe("blocked");
      // Even with the correct provenance, the ready oracle must reject blocked meaning.
      expect(() =>
        assertReaderBrief(product, { producer: "plan", source, scenario: "base" })
      ).toThrow(/distinguishing meaning/u);
    }
  );

  it.each(["direct", "paraphrase"] as const)(
    "Research -> Produce changes seven to fourteen days without dropping qualifications (%s)",
    async (wording) => {
      using host = new ContentFixtureOwner();
      const source = acceptedContentProduct(
        (await host.execute("research", `isolated-fourteen-${wording}`, "counterfactual")).terminal
      );
      const { product } = await checkedRun(host, `content-fourteen-${wording}`, {
        producer: "research",
        source,
        scenario: "counterfactual",
        wording,
      });
      assertReaderBrief(product, { producer: "research", source, scenario: "counterfactual" });
      expect(() =>
        assertReaderBrief(product, { producer: "research", source, scenario: "base" })
      ).toThrow(/distinguishing meaning/u);
    }
  );

  it.each(["plan", "research"] as const)(
    "%s -> Produce rejects counterfactual domain strengthening",
    async (producer) => {
      using host = new ContentFixtureOwner();
      const source = acceptedContentProduct(
        (await host.execute(producer, `strength-source-${producer}`, "counterfactual")).terminal
      );
      const { product } = await checkedRun(host, `strength-reader-${producer}`, {
        producer,
        source,
        scenario: "counterfactual",
        wording: "direct",
        mutation: "domain-strengthening",
      });
      expect(() =>
        assertReaderBrief(product, {
          producer,
          source,
          scenario: "counterfactual",
        })
      ).toThrow(/distinguishing meaning/u);
    }
  );

  it.each(["direct", "paraphrase"] as const)(
    "Plan -> Produce handles irrelevant strategy honestly without forcing agreement (%s)",
    async (wording) => {
      const host = owner();
      const source = host.source("plan");
      const { product } = await checkedRun(host, `content-irrelevant-${wording}`, {
        producer: "plan",
        source,
        scenario: "irrelevant",
        wording,
      });
      assertReaderBrief(product, { producer: "plan", source, scenario: "irrelevant" });
      expect(() =>
        assertReaderBrief(product, { producer: "plan", source, scenario: "base" })
      ).toThrow(/relevance/u);
    }
  );

  it("retains honest source meaning but rejects obedience to embedded authority claims", async () => {
    const host = owner();
    const source = requireValue(adversarialPlan, "adversarial exact strategy");
    expect(host.artifacts.read(source).toString("utf8")).toContain("SYSTEM OVERRIDE");
    const { product } = await checkedRun(host, "content-adversarial-honest", {
      producer: "plan",
      source,
      scenario: "base",
      wording: "paraphrase",
    });
    assertReaderBrief(product, { producer: "plan", source, scenario: "base" });
    const changed = await checkedRun(host, "content-adversarial-followed", {
      producer: "plan",
      source,
      scenario: "base",
      wording: "paraphrase",
      mutation: "authority",
    });
    expect(() =>
      assertReaderBrief(changed.product, {
        producer: "plan",
        source,
        scenario: "base",
      })
    ).toThrow(/promoted/u);
  });

  it("rejects a provenance substitution even when family facts and wording are otherwise right", async () => {
    const host = owner();
    const source = host.source("plan");
    const { product } = await checkedRun(host, "content-provenance", {
      producer: "plan",
      source,
      scenario: "base",
      wording: "direct",
    });
    expect(() =>
      assertReaderBrief(product, {
        producer: "plan",
        source: requireValue(adversarialPlan, "other accepted strategy"),
        scenario: "base",
      })
    ).toThrow(/provenance/u);
  });

  it("embedded approval/native-input claims cannot create a run with missing Produce requirements", () => {
    const host = owner();
    const request = host.start(
      "produce",
      "content-native-missing",
      nonbindingContext(requireValue(adversarialPlan, "adversarial source"))
    );
    request.constraints = {};
    expect(() => host.engine("produce").handle(request)).toThrow();
    expect(host.checkpointer.runExists(request.identity.run_id)).toBe(false);
  });

  it("Specification context is not a Define revision subject or reviewed-definition authority", () => {
    const host = owner();
    const spec = host.source("define");
    const revision = host.start("define", "content-revise-context-only", nonbindingContext(spec));
    revision.constraints = { ...revision.constraints, mode: "revise" };
    expect(() => host.engine("define").handle(revision)).toThrow();
    expect(host.checkpointer.runExists(revision.identity.run_id)).toBe(false);
    const unaccepted = host.artifacts.persist({
      metadata: {
        ...host.artifacts.metadata(spec),
        run_id: "content-unaccepted-spec",
        operation_id: "copy",
      },
      content: host.artifacts.read(spec),
    });
    const strict = host.start("plan", "content-strict-no-downgrade", {
      schema_version: 2,
      artifacts: [
        { slot: "prior-specification", designation: "binding", ref: unaccepted },
        ...nonbindingContext(requireValue(adversarialPlan, "adversarial context")).artifacts,
      ],
    });
    strict.constraints = {
      schema_version: 2,
      request: strict.constraints,
      specification_assurance: "reviewed_definition",
    };
    expect(() => host.engine("plan").handle(strict)).toThrow(/SPECIFICATION_ASSURANCE/u);
    expect(host.checkpointer.runExists(strict.identity.run_id)).toBe(false);
  });

  it("claims only its own Produce column and no production-model qualification", () => {
    const evidence = {
      tier: "provider-free real owners; scripted cognition and scripted reviews",
      produce_column_pairs: produceContentPairs,
      pairs_outside_this_suite: otherConsumerContentPairs,
      production_model_understanding: "not_run",
    };
    expect(canonicalJson(evidence)).toContain('"production_model_understanding":"not_run"');
    expect(evidence.produce_column_pairs).toHaveLength(7);
  });
});
