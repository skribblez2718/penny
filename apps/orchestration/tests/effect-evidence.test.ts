import { describe, expect, it } from "vitest";

import {
  ASSESS_EFFECT_PHASES,
  AssessPlaybook,
  BOUNDED_EFFECT_NOTICE,
  EFFECT_CATEGORIES,
  EFFECT_POLICY_VIOLATION_LIMITATION,
  PRODUCE_EFFECT_PHASES,
  ProducePlaybook,
  RunContext,
  SEMANTIC_PRODUCT_VALIDATORS,
  UNKNOWN_EFFECT_LIMITATION,
  canonicalJson,
  collectEffectEvidence,
  effectEvidenceSha256,
  legacyUnverifiedEffectEvidence,
  readAssessmentProduct,
  readProducedArtifactProduct,
  sha256,
  unknownEffectEvidenceGraph,
  validateAssessmentEvidenceBundle,
  validateEffectEvidenceGraph,
  validateProduceEvidenceBundle,
  type ArtifactRef,
  type EffectEvidenceGraphV1,
} from "../src/index.js";

const RUN_ID = "run-effect-evidence";

function legacyRef(input: {
  readonly playbook: "assess" | "produce";
  readonly phase: string;
  readonly kind: string;
  readonly schemaId: string;
}): ArtifactRef {
  const digest = sha256(`${input.playbook}:${input.schemaId}`);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(input.schemaId)}`,
    run_id: `run-${input.playbook}-legacy-effect`,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: `legacy:${input.kind}`,
    version: 1,
    producer: input.playbook === "assess" ? "agent:carren" : "agent:skribble",
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    byte_length: 1,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function activeContext(playbook: "assess" | "produce", ref: ArtifactRef): RunContext {
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: ref.run_id,
      session_id: ref.run_id,
      playbook,
      engine_owner: "typescript",
    },
    goal: "legacy recovery test",
    constraints: { schema_version: 1 },
    projectRoot: "/tmp/effect-evidence-test",
    trustProfile: "hardened-untrusted",
    maxSteps: 16,
    initialArtifacts: [ref],
  });
  context.stateId = playbook === "assess" ? "sealing_assessment" : "sealing_artifact";
  return context;
}

function firstCategory(graph: EffectEvidenceGraphV1) {
  const first = graph.categories[0];
  if (first === undefined) throw new Error("effect graph must have a first category");
  return first;
}

function evidence(category: string, suffix: string) {
  return {
    evidence_id: `trace:${RUN_ID}:${category}:${suffix}`,
    evidence_sha256: sha256(`${category}:${suffix}`),
    media_type: "application/json",
  };
}

function withCompleteNoEvent(): EffectEvidenceGraphV1 {
  const base = structuredClone(
    unknownEffectEvidenceGraph({ runId: RUN_ID, phases: ASSESS_EFFECT_PHASES })
  );
  return validateEffectEvidenceGraph(
    {
      ...base,
      categories: base.categories.map((entry) => ({
        ...entry,
        observation: {
          status: "observed",
          scope: entry.policy.scope,
          coverage: "complete",
          result: "no_event",
          evidence_refs: [evidence(entry.category, "complete")],
        },
      })),
      assurance: "bounded_no_violation",
      limitations: [],
    },
    { runId: RUN_ID, phases: ASSESS_EFFECT_PHASES }
  );
}

function withPartialNoEvent(): EffectEvidenceGraphV1 {
  const base = structuredClone(
    unknownEffectEvidenceGraph({ runId: RUN_ID, phases: ASSESS_EFFECT_PHASES })
  );
  return validateEffectEvidenceGraph(
    {
      ...base,
      categories: base.categories.map((entry) => ({
        ...entry,
        observation: {
          status: "observed",
          scope: entry.policy.scope,
          coverage: "partial",
          result: "no_event",
          evidence_refs: [evidence(entry.category, "partial")],
        },
      })),
    },
    { runId: RUN_ID, phases: ASSESS_EFFECT_PHASES }
  );
}

function withPrevention(): EffectEvidenceGraphV1 {
  const base = structuredClone(
    unknownEffectEvidenceGraph({ runId: RUN_ID, phases: PRODUCE_EFFECT_PHASES })
  );
  return validateEffectEvidenceGraph(
    {
      ...base,
      categories: base.categories.map((entry) => ({
        ...entry,
        prevention: {
          status: "enforced",
          control_id: `sandbox:${entry.category}`,
          scope: entry.policy.scope,
          evidence_refs: [evidence(entry.category, "control")],
        },
      })),
      assurance: "bounded_no_violation",
      limitations: [],
    },
    { runId: RUN_ID, phases: PRODUCE_EFFECT_PHASES }
  );
}

function withViolation(): EffectEvidenceGraphV1 {
  const base = structuredClone(
    unknownEffectEvidenceGraph({ runId: RUN_ID, phases: PRODUCE_EFFECT_PHASES })
  );
  const categories = base.categories.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          observation: {
            status: "observed",
            scope: entry.policy.scope,
            coverage: "partial",
            result: "violation",
            evidence_refs: [evidence(entry.category, "violation")],
          },
        }
      : entry
  );
  return validateEffectEvidenceGraph(
    {
      ...base,
      categories,
      assurance: "policy_violation",
      limitations: [EFFECT_POLICY_VIOLATION_LIMITATION],
    },
    { runId: RUN_ID, phases: PRODUCE_EFFECT_PHASES }
  );
}

describe("versioned effect-evidence graph", () => {
  it("represents required-only policy as unknown without inventing observation or prevention", () => {
    const graph = unknownEffectEvidenceGraph({ runId: RUN_ID, phases: ASSESS_EFFECT_PHASES });
    expect(graph.categories.map((entry) => entry.category)).toEqual(EFFECT_CATEGORIES);
    expect(firstCategory(graph).policy.scope.workers).toEqual(["annie", "carren", "vera"]);
    expect(graph.categories).toSatisfy((entries: EffectEvidenceGraphV1["categories"]) =>
      entries.every(
        (entry) =>
          entry.policy.requires_absence === true &&
          entry.observation.status === "unknown" &&
          entry.observation.coverage === "none" &&
          entry.observation.result === "unknown" &&
          entry.observation.evidence_refs.length === 0 &&
          entry.prevention.status === "unknown" &&
          entry.prevention.evidence_refs.length === 0
      )
    );
    expect(graph).toMatchObject({
      assurance: "unknown",
      limitations: [UNKNOWN_EFFECT_LIMITATION],
      host_artifact_writes: {
        classification: "host_control_plane_artifact_persistence",
        included_in_worker_effect_assurance: false,
      },
    });
    expect(BOUNDED_EFFECT_NOTICE).toMatch(
      /does not establish full filesystem or process confinement/u
    );
  });

  it("keeps partial no-event observation unknown outside its scope", () => {
    const graph = withPartialNoEvent();
    expect(graph.assurance).toBe("unknown");
    expect(graph.limitations).toEqual([UNKNOWN_EFFECT_LIMITATION]);
    expect(() =>
      validateEffectEvidenceGraph({ ...graph, assurance: "bounded_no_violation", limitations: [] })
    ).toThrow(/assurance or limitations/u);
  });

  it("derives bounded no-violation only from complete no-event evidence for every category", () => {
    const graph = withCompleteNoEvent();
    expect(graph.assurance).toBe("bounded_no_violation");
    expect(graph.limitations).toEqual([]);
    expect(graph.categories.every((entry) => entry.observation.evidence_refs.length === 1)).toBe(
      true
    );
    const missing = structuredClone(graph);
    firstCategory(missing).observation.evidence_refs = [];
    expect(() => validateEffectEvidenceGraph(missing)).toThrow(/requires scope, coverage, result/u);
  });

  it("derives bounded no-violation from exact-scope prevention controls without pretending observation", () => {
    const graph = withPrevention();
    expect(graph.assurance).toBe("bounded_no_violation");
    expect(graph.categories.every((entry) => entry.observation.status === "unknown")).toBe(true);
    const missingControl = structuredClone(graph);
    firstCategory(missingControl).prevention.control_id = null;
    expect(() => validateEffectEvidenceGraph(missingControl)).toThrow(/requires a control/u);
  });

  it("degrades absent, unavailable, and malformed telemetry to unknown", () => {
    const absent = collectEffectEvidence({ runId: RUN_ID, phases: ASSESS_EFFECT_PHASES });
    const unavailable = collectEffectEvidence({
      runId: RUN_ID,
      phases: ASSESS_EFFECT_PHASES,
      provider: {
        collect() {
          throw new Error("telemetry unavailable");
        },
      },
    });
    const malformed = collectEffectEvidence({
      runId: RUN_ID,
      phases: ASSESS_EFFECT_PHASES,
      provider: { collect: () => ({ assurance: "bounded_no_violation" }) },
    });
    for (const graph of [absent, unavailable, malformed]) {
      expect(graph.assurance).toBe("unknown");
      expect(graph.limitations).toEqual([UNKNOWN_EFFECT_LIMITATION]);
    }
  });

  it("derives a blocking violation from an observed violating event", () => {
    const graph = withViolation();
    expect(graph.assurance).toBe("policy_violation");
    expect(graph.limitations).toEqual([EFFECT_POLICY_VIOLATION_LIMITATION]);
    expect(() =>
      validateEffectEvidenceGraph({
        ...graph,
        assurance: "unknown",
        limitations: [UNKNOWN_EFFECT_LIMITATION],
      })
    ).toThrow(/assurance or limitations/u);
  });

  it("rejects no-event claims with no monitoring and unknown states carrying invented refs", () => {
    const graph = structuredClone(
      unknownEffectEvidenceGraph({ runId: RUN_ID, phases: ASSESS_EFFECT_PHASES })
    );
    firstCategory(graph).observation.result = "no_event";
    expect(() => validateEffectEvidenceGraph(graph)).toThrow(/no invented evidence/u);

    const graphWithRef = structuredClone(
      unknownEffectEvidenceGraph({ runId: RUN_ID, phases: ASSESS_EFFECT_PHASES })
    );
    firstCategory(graphWithRef).observation.evidence_refs = [
      evidence("external_action", "invented"),
    ];
    expect(() => validateEffectEvidenceGraph(graphWithRef)).toThrow(/no invented evidence/u);
  });

  it("has canonical serialization and digest binding that are mutation-sensitive", () => {
    const graph = withCompleteNoEvent();
    const serialized = canonicalJson(graph);
    expect(validateEffectEvidenceGraph(JSON.parse(serialized))).toEqual(graph);
    expect(effectEvidenceSha256(JSON.parse(serialized))).toBe(effectEvidenceSha256(graph));
    const mutated = structuredClone(graph);
    const firstRef = firstCategory(mutated).observation.evidence_refs[0];
    if (firstRef === undefined) throw new Error("complete observation evidence ref is absent");
    firstRef.evidence_id += ":mutated";
    expect(effectEvidenceSha256(mutated)).not.toBe(effectEvidenceSha256(graph));
  });
});

describe("effect contract version compatibility", () => {
  it("registers both historical V1 and active V2 semantic products for composition", () => {
    expect([...SEMANTIC_PRODUCT_VALIDATORS.keys()]).toEqual(
      expect.arrayContaining([
        "penny.assessment.v1",
        "penny.assessment.v2",
        "penny.produced-artifact.v1",
        "penny.produced-artifact.v2",
      ])
    );
  });

  it("interprets historical false assertions only as legacy unverified unknown", () => {
    const legacy = legacyUnverifiedEffectEvidence({
      runId: RUN_ID,
      phases: ASSESS_EFFECT_PHASES,
    });
    expect(legacy.interpretation).toBe("legacy_unverified_assertion");
    expect(legacy.effect_evidence.assurance).toBe("unknown");
    expect(legacy.effect_evidence.limitations).toEqual([UNKNOWN_EFFECT_LIMITATION]);
  });

  it("refuses unknown/future product versions before attempting compatibility reconstruction", () => {
    expect(() =>
      readAssessmentProduct(
        { schema_id: "penny.assessment.v3", schema_version: 3 },
        { runId: RUN_ID, phases: ASSESS_EFFECT_PHASES }
      )
    ).toThrow(/VERSION_UNSUPPORTED/u);
    expect(() =>
      readProducedArtifactProduct(
        { schema_id: "penny.produced-artifact.v3", schema_version: 3 },
        { runId: RUN_ID, phases: PRODUCE_EFFECT_PHASES }
      )
    ).toThrow(/VERSION_UNSUPPORTED/u);
  });

  it("refuses active V1 Assess and Produce checkpoints without resealing them as V2", () => {
    const assessRef = legacyRef({
      playbook: "assess",
      phase: "authoring_assessment",
      kind: "assessment-draft",
      schemaId: "penny.assessment-draft.v1",
    });
    const assess = new AssessPlaybook().continueHost(activeContext("assess", assessRef));
    expect(assess).toMatchObject({
      event_type: "assessment_legacy_effect_checkpoint_refused",
      directive: {
        action: "incomplete",
        result: { incomplete_reason: "legacy_effect_evidence_unverified" },
      },
    });

    const produceRef = legacyRef({
      playbook: "produce",
      phase: "materializing_artifact",
      kind: "produced-artifact-draft",
      schemaId: "penny.produced-artifact-draft.v1",
    });
    const produce = new ProducePlaybook().continueHost(activeContext("produce", produceRef));
    expect(produce).toMatchObject({
      event_type: "produce_legacy_effect_checkpoint_refused",
      directive: {
        action: "incomplete",
        result: { incomplete_reason: "legacy_effect_evidence_unverified" },
      },
    });
  });

  it("refuses every old/new mixed evidence bundle pairing explicitly", () => {
    expect(() =>
      validateAssessmentEvidenceBundle({
        runId: RUN_ID,
        phases: ASSESS_EFFECT_PHASES,
        assessment: { schema_version: 1 },
        validityReceipt: { schema_version: 2 },
        integrity: { schema_version: 2 },
        envelope: { schema_version: 2 },
      })
    ).toThrow(/VERSION_PAIRING_UNSUPPORTED/u);
    expect(() =>
      validateProduceEvidenceBundle({
        runId: RUN_ID,
        phases: PRODUCE_EFFECT_PHASES,
        product: { schema_version: 2 },
        qualityReceipt: { schema_version: 1 },
        validityReceipt: { schema_version: 2 },
        integrity: { schema_version: 2 },
        envelope: { schema_version: 2 },
      })
    ).toThrow(/VERSION_PAIRING_UNSUPPORTED/u);
  });
});
