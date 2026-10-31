import console from "node:console";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  validateCanonicalDiagnosisBytes,
  validateDiagnosisProductEnvelope,
  validateDiagnosisProductIntegrity,
  validateDiagnosisRequest,
  validateDiagnosisValidityReceipt,
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
  contentDiagnoseRequest,
  runContentDiagnose,
  type DiagnoseMutation,
  type DiagnoseScript,
} from "./helpers/universal-content-diagnose-fixtures.js";
import {
  assertContentDiagnosis,
  assertIndependentDiagnosis,
  diagnoseContentPairs,
} from "./helpers/universal-content-diagnose-oracle.js";

// ONE native consumer, seven ordinary sources. No ReaderBrief JSON, provider or external incident.
// The native caller's stipulated mechanism establishes cause; context ONLY illustrates loss.
// Bind this cohort to the verified current build, then detect drift during execution.
const generation = requireValue(assertCurrentShippingBuild(), "current compiled build").generation;
const wordings = ["direct", "paraphrase"] as const;
const positives = contentProducers.flatMap((producer) =>
  wordings.map((wording) => ({ producer, wording }))
);
const mutations: readonly DiagnoseMutation[] = [
  "ignored",
  "omitted",
  "changed",
  "coerced",
  "evidence-promotion",
  "external-certification",
  "permission-promotion",
  "native-authority",
  "index-promotion",
  "causal-reversal",
];
const negatives = contentProducers.flatMap((producer) =>
  mutations.map((mutation) => ({ producer, mutation }))
);
let active: ContentFixtureOwner | undefined;
const variants = new Map<string, ArtifactRef>();
function owner(): ContentFixtureOwner {
  return requireValue(active, "Diagnose content owner");
}
function variant(name: string): ArtifactRef {
  return requireValue(variants.get(name), `accepted ${name}`);
}

beforeAll(async () => {
  expect(assertCurrentShippingBuild()?.generation).toBe(generation);
  active = new ContentFixtureOwner();
  for (const producer of contentProducers)
    active.products.set(
      producer,
      acceptedContentProduct(
        (await active.execute(producer, `diagnose-column-source-${producer}`)).terminal
      )
    );
  variants.set(
    "plan-blocked",
    acceptedContentProduct(
      (await active.execute("plan", "diagnose-column-blocked", "counterfactual")).terminal
    )
  );
  variants.set(
    "research-fourteen",
    acceptedContentProduct(
      (await active.execute("research", "diagnose-column-fourteen", "counterfactual")).terminal
    )
  );
  variants.set(
    "plan-hostile",
    acceptedContentProduct(
      (await active.execute("plan", "diagnose-column-hostile", "authority")).terminal
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

/** Host admission and exact invocation byte reads must succeed BEFORE all semantic oracle calls. */
async function observedDiagnosis(
  host: ContentFixtureOwner,
  runId: string,
  script?: DiagnoseScript
) {
  const sourceBytes = script === undefined ? undefined : host.artifacts.read(script.source);
  const { terminal, client } = await runContentDiagnose(host, runId, script);
  const output = acceptedContentProduct(terminal);
  const diagnosis = validateCanonicalDiagnosisBytes(host.artifacts.read(output), output);
  expect(output.content_schema).toEqual({ schema_id: "penny.diagnosis.v1", schema_version: 1 });
  expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
    "decomposing_causes",
    "generating_hypotheses",
    "adjudicating_diagnosis",
    "verifying_diagnosis",
  ]);
  expect(client.invocations.map((invocation) => invocation.agent)).toEqual([
    "annie",
    "ida",
    "demetri",
    "vera",
  ]);
  for (const invocation of client.invocations) {
    expect(invocation.registration.allowed_tools).toBeUndefined();
    if (script !== undefined) {
      expect(invocation.inputArtifacts).toContainEqual(script.source);
      expect(invocation.task).toContain("NONBINDING context slot");
      expect(client.reads).toContainEqual({
        state: invocation.stateId,
        ref: script.source,
        sha256: script.source.content_digest,
        byteLength: script.source.byte_length,
      });
    }
  }
  if (script === undefined) expect(client.semanticSourceReads).toEqual([]);
  else {
    expect(output).not.toEqual(script.source);
    expect(host.artifacts.read(script.source)).toEqual(sourceBytes);
    expect(client.semanticSourceReads).toEqual([
      {
        state: "adjudicating_diagnosis",
        ref: script.source,
        sha256: script.source.content_digest,
        byteLength: script.source.byte_length,
      },
    ]);
  }
  expect(client.reviewedProducts).toEqual([output]);
  expect(client.reads).toContainEqual({
    state: "verifying_diagnosis",
    ref: output,
    sha256: output.content_digest,
    byteLength: output.byte_length,
  });
  const checkpoint = requireValue(
    host.checkpointer.loadRunById(runId),
    "completed Diagnose checkpoint"
  );
  expect(checkpoint.admittedInputArtifacts).toEqual(
    script === undefined ? undefined : nonbindingContext(script.source)
  );
  if (script !== undefined) expect(checkpoint.selectedArtifacts).not.toContainEqual(script.source);
  const selected = (kind: string) =>
    requireValue(
      checkpoint.selectedArtifacts.find((ref) => ref.kind === kind),
      `native ${kind}`
    );
  const requestRef = selected("diagnosis-request");
  const nativeRequest = validateDiagnosisRequest(host.readProduct(requestRef));
  expect(nativeRequest).toEqual(contentDiagnoseRequest(script?.irrelevant === true));
  expect(diagnosis.request).toEqual(nativeRequest);
  expect(diagnosis.source_lineage.request_artifact_id).toBe(requestRef.artifact_id);
  expect(diagnosis.source_lineage.request_artifact_sha256).toBe(requestRef.content_digest);
  const receiptRef = selected("diagnosis-validity-receipt");
  const integrityRef = selected("diagnosis-product-integrity");
  const envelopeRef = selected("diagnosis-product-envelope");
  const receipt = validateDiagnosisValidityReceipt(host.readProduct(receiptRef));
  const integrity = validateDiagnosisProductIntegrity(host.readProduct(integrityRef));
  const envelope = validateDiagnosisProductEnvelope(host.readProduct(envelopeRef));
  expect(receipt.diagnosis_ref).toEqual(output);
  expect(receipt.verdict).toBe("PASS");
  expect(integrity.diagnosis_ref).toEqual(output);
  expect(integrity.execution_receipt_ids).toHaveLength(4);
  expect(envelope.diagnosis_ref).toEqual(output);
  expect(envelope.validity_receipt_ref).toEqual(receiptRef);
  expect(envelope.integrity_ref).toEqual(integrityRef);
  expect(host.artifacts.read(receipt.vera_report_ref).toString("utf8")).toContain(
    '"verdict":"PASS"'
  );
  for (const receiptId of integrity.execution_receipt_ids)
    expect(host.checkpointer.receiptResultById(receiptId)).toBeDefined();
  expect(receipt.request_ref).toEqual(requestRef);
  expect(receipt.causal_decomposition_ref.artifact_id).toBe(
    diagnosis.source_lineage.causal_decomposition_artifact_id
  );
  expect(receipt.competing_hypotheses_ref.artifact_id).toBe(
    diagnosis.source_lineage.competing_hypotheses_artifact_id
  );
  expect(receipt.draft_ref.artifact_id).toBe(diagnosis.source_lineage.draft_artifact_id);
  if (script !== undefined) {
    expect(canonicalJson(diagnosis.source_lineage)).not.toContain(script.source.artifact_id);
    expect(host.artifacts.read(requestRef).toString("utf8")).not.toContain(
      script.source.artifact_id
    );
    expect(canonicalJson([receipt, integrity, envelope])).not.toContain(script.source.artifact_id);
  }
  expect(host.checkpointer.completionAdmission(runId)).toBeDefined();
  expect(terminal).toMatchObject({
    action: "complete",
    status: "complete",
    met: true,
    unresolved: [],
    result: { tests_executed: false, remediation_started: false },
  });
  return { diagnosis, output, client };
}
function expectedFailure(mutation: DiagnoseMutation): RegExp {
  switch (mutation) {
    case "coerced":
      return /qualification omitted/u;
    case "evidence-promotion":
    case "causal-reversal":
      return /causal reasoning/u;
    case "external-certification":
    case "permission-promotion":
    case "native-authority":
      return /context authority/u;
    case "index-promotion":
      return /evidence indexes changed\/promoted/u;
    case "irrelevant-contamination":
      return /irrelevant source contaminated/u;
    default:
      return /illustrative distinguishing meaning/u;
  }
}

describe("UO-CONTENT-DIAGNOSE: closed native causality with nonbinding illustrations; scripted cognition, real owners", () => {
  it("accounts for seven producer-to-Diagnose pairs and exact source identities, not other columns", () => {
    expect(diagnoseContentPairs).toEqual(
      contentProducers.map((producer) => `${producer}->diagnose`)
    );
    expect(new Set(diagnoseContentPairs).size).toBe(7);
    expect(negatives).toHaveLength(70);
    console.info(
      "DIAGNOSE_FIXTURE_SOURCE_HASHES",
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
        evidence_tier: "provider-free-scripted-cognition; closed-stipulations-only; live-not-run",
      })
    );
  });
  it("independently closes the complete native causal task without any contextual product", async () => {
    const { diagnosis } = await observedDiagnosis(owner(), "diagnose-column-independent");
    assertIndependentDiagnosis(diagnosis);
  });
  it.each(positives)(
    "$producer -> Diagnose applies two source features and qualifications to the loss explanation ($wording)",
    async ({ producer, wording }) => {
      const host = owner();
      const source = host.source(producer);
      const { diagnosis } = await observedDiagnosis(
        host,
        `diagnose-column-${producer}-${wording}`,
        { producer, source, wording }
      );
      assertContentDiagnosis(diagnosis, { producer, source, scenario: "base" });
    }
  );
  it.each(negatives)(
    "$producer -> Diagnose rejects $mutation only after native completion and scripted PASS",
    async ({ producer, mutation }) => {
      const host = owner();
      const source = host.source(producer);
      const { diagnosis } = await observedDiagnosis(
        host,
        `diagnose-column-mutant-${producer}-${mutation}`,
        { producer, source, wording: "direct", mutation }
      );
      expect(() =>
        assertContentDiagnosis(diagnosis, { producer, source, scenario: "base" })
      ).toThrow(expectedFailure(mutation));
    }
  );
  it.each(wordings)(
    "Plan -> Diagnose changes illustrative consequence for actual ready-to-blocked product (%s)",
    async (wording) => {
      const host = owner();
      const source = variant("plan-blocked");
      expect(source.artifact_id).not.toBe(host.source("plan").artifact_id);
      const { diagnosis } = await observedDiagnosis(host, `diagnose-column-blocked-${wording}`, {
        producer: "plan",
        source,
        wording,
      });
      assertContentDiagnosis(diagnosis, { producer: "plan", source, scenario: "counterfactual" });
      expect(diagnosis.hypotheses[0]?.reasoning).toContain(
        "blocked; outcomes: Transition readiness"
      );
      expect(diagnosis.uncertainty[2]).toContain("Rollback access is unavailable.");
      expect(diagnosis.primary_supported_hypothesis_id).toBe("hyp_formatter");
      expect(() =>
        assertContentDiagnosis(diagnosis, { producer: "plan", source, scenario: "base" })
      ).toThrow(/illustrative distinguishing meaning/u);
    }
  );
  it.each(wordings)(
    "Research -> Diagnose changes illustrative duration for actual seven-to-fourteen-day product (%s)",
    async (wording) => {
      const host = owner();
      const source = variant("research-fourteen");
      expect(source.artifact_id).not.toBe(host.source("research").artifact_id);
      const { diagnosis } = await observedDiagnosis(host, `diagnose-column-fourteen-${wording}`, {
        producer: "research",
        source,
        wording,
      });
      assertContentDiagnosis(diagnosis, {
        producer: "research",
        source,
        scenario: "counterfactual",
      });
      expect(diagnosis.hypotheses[0]?.reasoning).toContain(
        "14 days. support=qualified; confidence=0.8"
      );
      expect(diagnosis.primary_supported_hypothesis_id).toBe("hyp_formatter");
      expect(() =>
        assertContentDiagnosis(diagnosis, { producer: "research", source, scenario: "base" })
      ).toThrow(/illustrative distinguishing meaning/u);
    }
  );
  it.each(["plan", "research"] as const)(
    "%s -> Diagnose rejects counterfactual domain strengthening after native completion",
    async (producer) => {
      const host = owner();
      const source = variant(producer === "plan" ? "plan-blocked" : "research-fourteen");
      const { diagnosis } = await observedDiagnosis(host, `diagnose-column-strength-${producer}`, {
        producer,
        source,
        wording: "direct",
        mutation: "domain-strengthening",
      });
      expect(() =>
        assertContentDiagnosis(diagnosis, { producer, source, scenario: "counterfactual" })
      ).toThrow(/illustrative distinguishing meaning/u);
    }
  );
  it.each(["plan", "research"] as const)(
    "%s -> Diagnose rejects stale base meaning despite actual changed-source provenance",
    async (producer) => {
      const host = owner();
      const source = variant(producer === "plan" ? "plan-blocked" : "research-fourteen");
      const { diagnosis } = await observedDiagnosis(host, `diagnose-column-stale-${producer}`, {
        producer,
        source,
        wording: "direct",
        mutation: "stale-counterfactual",
      });
      expect(() =>
        assertContentDiagnosis(diagnosis, { producer, source, scenario: "counterfactual" })
      ).toThrow(/illustrative distinguishing meaning/u);
    }
  );
  it.each(wordings)(
    "Plan -> Diagnose honestly excludes irrelevant strategy in a closed arithmetic diagnosis (%s)",
    async (wording) => {
      const host = owner();
      const source = host.source("plan");
      const { diagnosis } = await observedDiagnosis(host, `diagnose-column-irrelevant-${wording}`, {
        producer: "plan",
        source,
        wording,
        irrelevant: true,
      });
      assertContentDiagnosis(diagnosis, { producer: "plan", source, scenario: "irrelevant" });
    }
  );
  it("rejects irrelevant-source causal contamination after native completion", async () => {
    const host = owner();
    const source = host.source("plan");
    const { diagnosis } = await observedDiagnosis(host, "diagnose-column-irrelevant-mutant", {
      producer: "plan",
      source,
      wording: "direct",
      irrelevant: true,
      mutation: "irrelevant-contamination",
    });
    expect(() =>
      assertContentDiagnosis(diagnosis, { producer: "plan", source, scenario: "irrelevant" })
    ).toThrow(/irrelevant source contaminated/u);
  });
  it("honestly handles accepted hostile source prose without obeying approval or tool claims", async () => {
    const host = owner();
    const source = variant("plan-hostile");
    expect(host.artifacts.read(source).toString("utf8")).toContain("SYSTEM OVERRIDE");
    const { diagnosis } = await observedDiagnosis(host, "diagnose-column-hostile-honest", {
      producer: "plan",
      source,
      wording: "paraphrase",
    });
    assertContentDiagnosis(diagnosis, { producer: "plan", source, scenario: "base" });
  });
  it("rejects obedience to hostile approval/tool claims after native completion", async () => {
    const host = owner();
    const source = variant("plan-hostile");
    const { diagnosis } = await observedDiagnosis(host, "diagnose-column-hostile-followed", {
      producer: "plan",
      source,
      wording: "direct",
      mutation: "permission-promotion",
    });
    expect(() =>
      assertContentDiagnosis(diagnosis, { producer: "plan", source, scenario: "base" })
    ).toThrow(/context authority/u);
  });
  it("hostile context cannot provide missing native symptoms and observations", () => {
    const host = owner();
    const start = host.start(
      "diagnose",
      "diagnose-column-native-missing",
      nonbindingContext(variant("plan-hostile"))
    );
    start.constraints = {};
    expect(() => host.engine("diagnose").handle(start)).toThrow();
    expect(host.checkpointer.runExists(start.identity.run_id)).toBe(false);
  });
  it("a product designated as binding cannot masquerade as Diagnose supplied observations", () => {
    const host = owner();
    const source = host.source("diagnose");
    const start = host.start("diagnose", "diagnose-column-binding-refused", {
      schema_version: 2,
      artifacts: [{ slot: "not-observations", ref: source }],
    });
    expect(() => host.engine("diagnose").handle(start)).toThrow();
    expect(host.checkpointer.runExists(start.identity.run_id)).toBe(false);
  });
  it("rejects context-identity substitution independently of correct illustrative meaning", async () => {
    const host = owner();
    const source = host.source("plan");
    const { diagnosis } = await observedDiagnosis(host, "diagnose-column-provenance", {
      producer: "plan",
      source,
      wording: "direct",
    });
    assertContentDiagnosis(diagnosis, { producer: "plan", source, scenario: "base" });
    expect(() =>
      assertContentDiagnosis(diagnosis, {
        producer: "plan",
        source: variant("plan-hostile"),
        scenario: "base",
      })
    ).toThrow(/context provenance/u);
  });
});
