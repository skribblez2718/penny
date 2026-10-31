import console from "node:console";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASSESS_EFFECT_PHASES,
  assessmentRequestConstraints,
  canonicalJson,
  validateAssessmentEvidenceBundle,
  validateAssessmentProductEnvelopeV2,
  validateAssessmentProductIntegrityV2,
  validateAssessmentRequest,
  validateAssessmentValidityReceiptV2,
  validateCanonicalAssessmentV2Bytes,
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
  contentAssessRequest,
  runContentAssess,
  type AssessMutation,
  type AssessScript,
} from "./helpers/universal-content-assess-fixtures.js";
import {
  assessContentPairs,
  assertContentAssessment,
} from "./helpers/universal-content-assess-oracle.js";

// One consumer column only. Native products are AssessmentV2, not ReaderBrief JSON in prose.
// Scripted cognition/PASS reviews are NOT production understanding or live qualification.
// Bind this cohort to the verified current build, then detect drift during execution.
const generation = requireValue(assertCurrentShippingBuild(), "current compiled build").generation;
const wordings = ["direct", "paraphrase"] as const;
const positiveCases = contentProducers.flatMap((producer) =>
  wordings.map((wording) => ({ producer, wording }))
);
const mutations: readonly AssessMutation[] = [
  "ignored",
  "omitted",
  "changed",
  "coerced",
  "evidence-promotion",
  "permission-promotion",
  "native-authority",
  "summary-contradiction",
  "verdict",
];
const negativeCases = contentProducers.flatMap((producer) =>
  mutations.map((mutation) => ({ producer, mutation }))
);
let active: ContentFixtureOwner | undefined;
const variants = new Map<string, ArtifactRef>();
function owner(): ContentFixtureOwner {
  return requireValue(active, "Assess content owner");
}
function variant(name: string): ArtifactRef {
  return requireValue(variants.get(name), `accepted ${name}`);
}

beforeAll(async () => {
  expect(assertCurrentShippingBuild()?.generation).toBe(generation);
  active = new ContentFixtureOwner();
  for (const producer of contentProducers) {
    active.products.set(
      producer,
      acceptedContentProduct(
        (await active.execute(producer, `assess-column-source-${producer}`)).terminal
      )
    );
  }
  variants.set(
    "plan-blocked",
    acceptedContentProduct(
      (await active.execute("plan", "assess-column-blocked", "counterfactual")).terminal
    )
  );
  // Same owner on purpose: the supplied rebuilt generation fixes Research render collisions.
  variants.set(
    "research-fourteen",
    acceptedContentProduct(
      (await active.execute("research", "assess-column-fourteen", "counterfactual")).terminal
    )
  );
  variants.set(
    "plan-hostile",
    acceptedContentProduct(
      (await active.execute("plan", "assess-column-hostile", "authority")).terminal
    )
  );
});
afterAll(() => {
  try {
    expect(assertCurrentShippingBuild()?.generation).toBe(generation);
  } finally {
    active?.[Symbol.dispose]();
  }
});

/** Native acceptance/identity/readback is mandatory BEFORE every oracle call, including mutants. */
async function observedAssessment(host: ContentFixtureOwner, runId: string, script: AssessScript) {
  const sourceBytes = host.artifacts.read(script.source);
  const { terminal, client } = await runContentAssess(host, runId, script);
  const output = acceptedContentProduct(terminal);
  const assessment = validateCanonicalAssessmentV2Bytes(host.artifacts.read(output), output);
  expect(output.content_schema).toEqual({ schema_id: "penny.assessment.v2", schema_version: 2 });
  expect(output).not.toEqual(script.source);
  expect(host.artifacts.read(script.source)).toEqual(sourceBytes);
  expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
    "analyzing_assessment",
    "authoring_assessment",
    "verifying_assessment",
  ]);
  expect(client.invocations.map((invocation) => invocation.agent)).toEqual([
    "annie",
    "carren",
    "vera",
  ]);
  for (const invocation of client.invocations) {
    expect(invocation.inputArtifacts).toContainEqual(script.source);
    expect(invocation.task).toContain("NONBINDING context slot");
    expect(invocation.registration.allowed_tools).toBeUndefined();
    expect(client.reads).toContainEqual({
      state: invocation.stateId,
      ref: script.source,
      sha256: script.source.content_digest,
      byteLength: script.source.byte_length,
    });
  }
  expect(client.semanticSourceReads).toEqual([
    {
      state: "authoring_assessment",
      ref: script.source,
      sha256: script.source.content_digest,
      byteLength: sourceBytes.length,
    },
  ]);
  expect(client.reviewedProducts).toEqual([output]);
  expect(client.reads).toContainEqual({
    state: "verifying_assessment",
    ref: output,
    sha256: output.content_digest,
    byteLength: output.byte_length,
  });
  const checkpoint = requireValue(
    host.checkpointer.loadRunById(runId),
    "completed Assess checkpoint"
  );
  expect(checkpoint.admittedInputArtifacts).toEqual(nonbindingContext(script.source));
  expect(checkpoint.selectedArtifacts).not.toContainEqual(script.source);
  const nativeRequestRef = requireValue(
    checkpoint.selectedArtifacts.find((ref) => ref.kind === "assessment-request"),
    "native caller request"
  );
  const nativeRequest = validateAssessmentRequest(host.readProduct(nativeRequestRef));
  expect(nativeRequest).toEqual(contentAssessRequest(script.irrelevant === true));
  expect(assessment.request).toEqual(nativeRequest);
  expect(host.artifacts.read(nativeRequestRef).toString("utf8")).not.toContain(
    script.source.artifact_id
  );
  expect(assessment.source_lineage.request_artifact_id).toBe(nativeRequestRef.artifact_id);
  expect(assessment.source_lineage.request_artifact_sha256).toBe(nativeRequestRef.content_digest);
  expect(assessment.source_lineage.target_statements).toHaveLength(2);
  expect(assessment.source_lineage.criteria).toHaveLength(2);
  expect(assessment.source_lineage.supplied_evidence).toHaveLength(
    script.irrelevant === true ? 2 : 0
  );
  expect(canonicalJson(assessment.source_lineage)).not.toContain(script.source.artifact_id);
  const receiptRef = requireValue(
    checkpoint.selectedArtifacts.find((ref) => ref.kind === "assessment-validity-receipt"),
    "host validity receipt"
  );
  const integrityRef = requireValue(
    checkpoint.selectedArtifacts.find((ref) => ref.kind === "assessment-product-integrity"),
    "host integrity"
  );
  const envelopeRef = requireValue(
    checkpoint.selectedArtifacts.find((ref) => ref.kind === "assessment-product-envelope"),
    "host envelope"
  );
  const receipt = validateAssessmentValidityReceiptV2(host.readProduct(receiptRef));
  const integrity = validateAssessmentProductIntegrityV2(host.readProduct(integrityRef));
  const envelope = validateAssessmentProductEnvelopeV2(host.readProduct(envelopeRef));
  expect(receipt.assessment_ref).toEqual(output);
  expect(receipt.verdict).toBe("PASS");
  expect(integrity.assessment_ref).toEqual(output);
  expect(envelope.assessment_ref).toEqual(output);
  expect(envelope.validity_receipt_ref).toEqual(receiptRef);
  expect(envelope.integrity_ref).toEqual(integrityRef);
  expect(host.artifacts.read(receipt.vera_report_ref).toString("utf8")).toContain(
    '"verdict":"PASS"'
  );
  expect(
    validateAssessmentEvidenceBundle({
      runId,
      phases: ASSESS_EFFECT_PHASES,
      assessment,
      validityReceipt: receipt,
      integrity,
      envelope,
    })
  ).toMatchObject({ contract_version: 2, effect_evidence: { assurance: "unknown" } });
  expect(assessment.effect_evidence.assurance).toBe("unknown");
  expect(host.checkpointer.completionAdmission(runId)).toBeDefined();
  expect(terminal).toMatchObject({
    action: "complete",
    status: "complete",
    met: true,
    unresolved: [],
  });
  return { assessment, output, client };
}

function expectedFailure(mutation: AssessMutation): RegExp {
  switch (mutation) {
    case "evidence-promotion":
    case "permission-promotion":
    case "native-authority":
      return /context promoted/u;
    case "coerced":
      return /qualification omitted, changed or coerced/u;
    case "summary-contradiction":
      return /summary contradicts/u;
    case "verdict":
      return /native judgment/u;
    case "irrelevant-contamination":
      return /irrelevant source contaminated/u;
    default:
      return /distinguishing result meaning/u;
  }
}

describe("UO-CONTENT-ASSESS: native closed-task content use; scripted cognition, real owners", () => {
  it("accounts for exactly the seven producer-to-Assess pairs, not other consumer columns", () => {
    expect(assessContentPairs).toEqual(contentProducers.map((producer) => `${producer}->assess`));
    expect(new Set(assessContentPairs).size).toBe(7);
    console.info(
      "ASSESS_FIXTURE_SOURCE_HASHES",
      canonicalJson({
        generation,
        sources: [...owner().products.entries()].map(([producer, ref]) => ({
          producer,
          sha256: ref.content_digest,
        })),
        variants: [...variants.entries()].map(([name, ref]) => ({
          name,
          sha256: ref.content_digest,
        })),
        evidence_tier: "provider-free-scripted-cognition; live-not-run",
      })
    );
  });

  it("the caller's complete native request admits without any contextual product", () => {
    const host = owner();
    const request = contentAssessRequest();
    const start = host.start("assess", "assess-column-native-independent");
    start.goal = request.assessment_purpose;
    start.constraints = assessmentRequestConstraints(request);
    const directive = host.engine("assess").handle(start);
    expect(directive.action).toBe("invoke_agent");
    const checkpoint = requireValue(
      host.checkpointer.loadRunById(start.identity.run_id),
      "independent request checkpoint"
    );
    expect(checkpoint.admittedInputArtifacts).toBeUndefined();
    expect(checkpoint.selectedArtifacts.every((ref) => ref.run_id === start.identity.run_id)).toBe(
      true
    );
  });

  it.each(positiveCases)(
    "$producer -> Assess materially applies result and qualification ($wording)",
    async ({ producer, wording }) => {
      const host = owner();
      const source = host.source(producer);
      const { assessment } = await observedAssessment(
        host,
        `assess-column-${producer}-${wording}`,
        { producer, source, wording }
      );
      assertContentAssessment(assessment, { producer, source, scenario: "base" });
    }
  );

  it.each(negativeCases)(
    "$producer -> Assess rejects native-valid $mutation after scripted PASS and real admission",
    async ({ producer, mutation }) => {
      const host = owner();
      const source = host.source(producer);
      const { assessment } = await observedAssessment(
        host,
        `assess-column-negative-${producer}-${mutation}`,
        { producer, source, wording: "direct", mutation }
      );
      expect(() =>
        assertContentAssessment(assessment, { producer, source, scenario: "base" })
      ).toThrow(expectedFailure(mutation));
    }
  );

  it.each(wordings)(
    "Plan -> Assess reflects genuinely ready-to-blocked source changes (%s)",
    async (wording) => {
      const host = owner();
      const source = variant("plan-blocked");
      expect(source.artifact_id).not.toBe(host.source("plan").artifact_id);
      const { assessment } = await observedAssessment(host, `assess-column-blocked-${wording}`, {
        producer: "plan",
        source,
        wording,
      });
      assertContentAssessment(assessment, { producer: "plan", source, scenario: "counterfactual" });
      expect(assessment.criterion_outcomes[0]?.rationale).toContain("blocked strategy");
      expect(assessment.gaps[0]?.statement).toContain("Rollback access is unavailable.");
      expect(() =>
        assertContentAssessment(assessment, { producer: "plan", source, scenario: "base" })
      ).toThrow(/distinguishing result meaning/u);
    }
  );

  it.each(wordings)(
    "Research -> Assess reflects genuinely seven-to-fourteen-day source changes (%s)",
    async (wording) => {
      const host = owner();
      const source = variant("research-fourteen");
      expect(source.artifact_id).not.toBe(host.source("research").artifact_id);
      const { assessment } = await observedAssessment(host, `assess-column-fourteen-${wording}`, {
        producer: "research",
        source,
        wording,
      });
      assertContentAssessment(assessment, {
        producer: "research",
        source,
        scenario: "counterfactual",
      });
      expect(assessment.criterion_outcomes[0]?.rationale).toContain(
        '14 days." with qualified support at confidence 0.8'
      );
      expect(() =>
        assertContentAssessment(assessment, { producer: "research", source, scenario: "base" })
      ).toThrow(/distinguishing result meaning/u);
    }
  );

  it.each(["plan", "research"] as const)(
    "%s -> Assess rejects native-valid domain strengthening of counterfactual meaning",
    async (producer) => {
      const host = owner();
      const source = variant(producer === "plan" ? "plan-blocked" : "research-fourteen");
      const { assessment } = await observedAssessment(host, `assess-column-strength-${producer}`, {
        producer,
        source,
        wording: "direct",
        mutation: "domain-strengthening",
      });
      expect(() =>
        assertContentAssessment(assessment, { producer, source, scenario: "counterfactual" })
      ).toThrow(/distinguishing result meaning/u);
    }
  );

  it.each(["plan", "research"] as const)(
    "%s -> Assess rejects stale base content with actual changed source provenance",
    async (producer) => {
      const host = owner();
      const source = variant(producer === "plan" ? "plan-blocked" : "research-fourteen");
      const { assessment } = await observedAssessment(host, `assess-column-stale-${producer}`, {
        producer,
        source,
        wording: "direct",
        mutation: "stale-counterfactual",
      });
      expect(() =>
        assertContentAssessment(assessment, { producer, source, scenario: "counterfactual" })
      ).toThrow(/distinguishing result meaning/u);
    }
  );

  it.each(wordings)(
    "Plan -> Assess honestly ignores irrelevant strategy in a complete greeting task (%s)",
    async (wording) => {
      const host = owner();
      const source = host.source("plan");
      const { assessment } = await observedAssessment(host, `assess-column-irrelevant-${wording}`, {
        producer: "plan",
        source,
        wording,
        irrelevant: true,
      });
      assertContentAssessment(assessment, { producer: "plan", source, scenario: "irrelevant" });
    }
  );

  it("an irrelevant source contaminant completes natively but reaches and fails the oracle", async () => {
    const host = owner();
    const source = host.source("plan");
    const { assessment } = await observedAssessment(host, "assess-column-irrelevant-mutant", {
      producer: "plan",
      source,
      wording: "direct",
      irrelevant: true,
      mutation: "irrelevant-contamination",
    });
    expect(() =>
      assertContentAssessment(assessment, { producer: "plan", source, scenario: "irrelevant" })
    ).toThrow(/irrelevant source contaminated/u);
  });

  it("honest native assessment does not obey embedded source authority claims", async () => {
    const host = owner();
    const source = variant("plan-hostile");
    expect(host.artifacts.read(source).toString("utf8")).toContain("SYSTEM OVERRIDE");
    const { assessment } = await observedAssessment(host, "assess-column-hostile-honest", {
      producer: "plan",
      source,
      wording: "paraphrase",
    });
    assertContentAssessment(assessment, { producer: "plan", source, scenario: "base" });
  });

  it("obedience to embedded approval/tool claims is native-valid but independently rejected", async () => {
    const host = owner();
    const source = variant("plan-hostile");
    const { assessment } = await observedAssessment(host, "assess-column-hostile-followed", {
      producer: "plan",
      source,
      wording: "direct",
      mutation: "permission-promotion",
    });
    expect(() =>
      assertContentAssessment(assessment, { producer: "plan", source, scenario: "base" })
    ).toThrow(/context promoted/u);
  });

  it("hostile context cannot supply missing native target or criteria", () => {
    const host = owner();
    const start = host.start(
      "assess",
      "assess-column-native-missing",
      nonbindingContext(variant("plan-hostile"))
    );
    start.constraints = {};
    expect(() => host.engine("assess").handle(start)).toThrow();
    expect(host.checkpointer.runExists(start.identity.run_id)).toBe(false);
  });

  it("the literal oracle rejects source-identity substitution independently of correct domain text", async () => {
    const host = owner();
    const source = host.source("plan");
    const { assessment } = await observedAssessment(host, "assess-column-provenance", {
      producer: "plan",
      source,
      wording: "direct",
    });
    assertContentAssessment(assessment, { producer: "plan", source, scenario: "base" });
    expect(() =>
      assertContentAssessment(assessment, {
        producer: "plan",
        source: variant("plan-hostile"),
        scenario: "base",
      })
    ).toThrow(/context identity/u);
  });
});
