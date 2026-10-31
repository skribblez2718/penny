import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import {
  assertScaP05InputMetadata,
  parseScaP04PersistedSpecialistResult,
} from "../dist/sca/p05-admission.js";
import {
  SCA_P05_CHALLENGER_RESULT_V1_SCHEMA,
  SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
  SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
  SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
  SCA_P05_OBLIGATION_IDS,
  SCA_P05_REQUIRED_MODEL,
  SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA,
  scaP05EvidenceAtomId,
  scaP05HypothesisId,
  scaP05ObservableId,
  scaP05SourceSegmentId,
  validateScaP05ChallengerResultV1,
  validateScaP05ConstructorResultV1,
  validateScaP05CognitivePayloadV1,
  validateScaP05DisclosureScopeV1,
  validateScaP05HypothesisAgainstPayload,
  validateScaP05HypothesisRevisionV1,
  validateScaP05SuccessorLedgerV1,
  withSelfDigest,
  type ScaP05CognitivePayloadV1,
  type ScaP05HypothesisBodyV1,
} from "../dist/sca/p05-contracts.js";

function ref(id: string, schema = "penny.test.v1"): ArtifactRef {
  const digest = sha256(id);
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: "run-p05-contract",
    phase: "SCA-P05",
    branch_id: null,
    kind: "test-evidence",
    operation_id: id,
    version: 1,
    producer: "host:test",
    media_type: "application/json",
    content_schema: { schema_id: schema, schema_version: 1 },
    byte_length: id.length,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

const SOURCE_SHA = "a".repeat(64);
const SELECTED = `p04i_${"b".repeat(64)}`;
const SOURCE_REF = ref("source");
const COHORT_REF = ref("cohort", "penny.sca-p05-accepted-cohort.v1");
const SCOPE_REF = ref("scope", SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA);
const SEGMENT_TEXT = "if (actor.isAdmin) { allow(input); }";
const SEGMENT_SHA = sha256(Buffer.from(SEGMENT_TEXT, "utf8"));
const SEGMENT_ID = scaP05SourceSegmentId({
  origin_ref: SOURCE_REF,
  source_path: "src/auth.ts",
  start_line: 1,
  end_line_exclusive: 2,
  visible_text_sha256: SEGMENT_SHA,
});
const ATOM_VALUE_SHA = sha256(canonicalJson(SEGMENT_TEXT));
const ATOM_ID = scaP05EvidenceAtomId({
  origin_ref: SOURCE_REF,
  selector: `source-segment:${SEGMENT_ID}`,
  value_sha256: ATOM_VALUE_SHA,
});
const HYPOTHESIS_ID = scaP05HypothesisId(SOURCE_SHA, SELECTED);

function body(): ScaP05HypothesisBodyV1 {
  const support = "Authorization guard is bypassed for the controlled input.";
  const refute = "The exact guard rejects the same actor, state, and input.";
  return {
    hypothesis_id: HYPOTHESIS_ID,
    selected_item_id: SELECTED,
    bounded_claim: "A non-admin actor may reach the protected operation through this path.",
    actor: { claim: "A non-admin authenticated actor", evidence_atom_ids: [ATOM_ID] },
    controlled_input: { claim: "The actor-controlled request value", evidence_atom_ids: [ATOM_ID] },
    relevant_state: { claim: "The actor lacks the admin state", evidence_atom_ids: [ATOM_ID] },
    causal_path: [
      {
        ordinal: 1,
        causal_link: "The controlled value reaches the authorization branch.",
        state_before: "Request received",
        state_after: "Authorization branch evaluated",
        basis: "observed",
        evidence_atom_ids: [ATOM_ID],
      },
    ],
    security_sensitive_outcome: {
      claim: "The protected operation is allowed",
      evidence_atom_ids: [ATOM_ID],
    },
    competing_benign_explanation: {
      explanation: "A prior exact admin guard always prevents the path.",
      discriminating_observation: "Observe whether the guard rejects the same request.",
      evidence_atom_ids: [ATOM_ID],
    },
    expected_supporting_observations: [
      {
        observable_id: scaP05ObservableId({
          selected_item_id: SELECTED,
          kind: "supporting",
          ordinal: 1,
        }),
        observation: support,
        expected_if_claim: true,
        evidence_mode: "graph",
        basis_atom_ids: [ATOM_ID],
      },
    ],
    expected_refuting_observations: [
      {
        observable_id: scaP05ObservableId({
          selected_item_id: SELECTED,
          kind: "refuting",
          ordinal: 1,
        }),
        observation: refute,
        expected_if_claim: false,
        evidence_mode: "application",
        basis_atom_ids: [ATOM_ID],
      },
    ],
    next_evidence_need: {
      question: "Does the guard dominate the protected operation?",
      evidence_mode: "graph",
      target: "The authorization branch and protected operation",
      discriminating_result: "A path exists without the guard dominating it.",
    },
    stopping_conditions: {
      supported: "Stop when the complete causal path is observed.",
      refuted: "Stop when the exact control dominates all paths.",
      inconclusive: "Stop when admitted evidence cannot distinguish the alternatives.",
    },
    reopening_conditions: [
      {
        trigger: "Source or graph evidence changes.",
        changed_basis_required: "A new exact snapshot or invalidated control.",
      },
    ],
  };
}

function payload(): ScaP05CognitivePayloadV1 {
  return validateScaP05CognitivePayloadV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: "run-p05-contract",
        phase_id: "SCA-P05" as const,
        call_id: "constructor",
        role: "hypothesis_constructor" as const,
        purpose: "p05_hypothesis_construction" as const,
        required_model: SCA_P05_REQUIRED_MODEL,
        accepted_cohort_ref: COHORT_REF,
        source_snapshot_ref: SOURCE_REF,
        source_snapshot_sha256: SOURCE_SHA,
        assigned_item_ids: [SELECTED],
        items: [
          {
            selected_item_id: SELECTED,
            expected_hypothesis_id: HYPOTHESIS_ID,
            normalized_locator: "source:src/auth.ts",
            source_path: "src/auth.ts",
            package_coordinate: null,
            selection_rationale_code: "select_for_p05",
            evidence_atom_ids: [ATOM_ID],
          },
        ],
        evidence_atoms: [
          {
            atom_id: ATOM_ID,
            selected_item_id: SELECTED,
            atom_kind: "source_segment" as const,
            origin_ref: SOURCE_REF,
            selector: `source-segment:${SEGMENT_ID}`,
            value_sha256: ATOM_VALUE_SHA,
            value: SEGMENT_TEXT,
          },
        ],
        constructor_result_ref: null,
        constructor_result: null,
        disclosure_scope_ref: SCOPE_REF,
        content_mode: "authorized_segments_and_exact_evidence_atoms" as const,
      },
      "payload_sha256"
    )
  );
}

function expectBodyMutationRejected(mutate: (value: object) => void): void {
  const candidate = structuredClone(body());
  mutate(candidate);
  expect(() => validateScaP05HypothesisAgainstPayload(candidate, payload())).toThrow();
}

describe("SCA P05 closed falsifiable-hypothesis contracts", () => {
  it("accepts a complete source-bound causal hypothesis", () => {
    expect(() => validateScaP05HypothesisAgainstPayload(body(), payload())).not.toThrow();
    expect(
      validateScaP05ConstructorResultV1({
        schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
        schema_version: 1,
        role: "hypothesis_constructor",
        payload_sha256: "c".repeat(64),
        assigned_item_ids: [SELECTED],
        items: [{ selected_item_id: SELECTED, disposition: "formed", hypothesis: body() }],
        complete: true,
      }).items
    ).toHaveLength(1);
  });

  it("rejects one-defect mutants missing every material hypothesis element", () => {
    expectBodyMutationRejected((value) => Reflect.deleteProperty(value, "actor"));
    expectBodyMutationRejected((value) => Reflect.deleteProperty(value, "controlled_input"));
    expectBodyMutationRejected((value) => Reflect.deleteProperty(value, "relevant_state"));
    expectBodyMutationRejected((value) => Reflect.set(value, "causal_path", []));
    expectBodyMutationRejected((value) =>
      Reflect.deleteProperty(value, "security_sensitive_outcome")
    );
    expectBodyMutationRejected((value) =>
      Reflect.deleteProperty(value, "competing_benign_explanation")
    );
    expectBodyMutationRejected((value) => Reflect.set(value, "expected_refuting_observations", []));
    expectBodyMutationRejected((value) => Reflect.deleteProperty(value, "next_evidence_need"));
    expectBodyMutationRejected((value) => Reflect.deleteProperty(value, "stopping_conditions"));
    expectBodyMutationRejected((value) => Reflect.set(value, "reopening_conditions", []));
  });

  it("requires a concrete textual reopening basis, never a boolean flag", () => {
    for (const changedBasis of [true, false, "", "   "]) {
      expectBodyMutationRejected((value) =>
        Reflect.set(value, "reopening_conditions", [
          { trigger: "New exact evidence is available.", changed_basis_required: changedBasis },
        ])
      );
    }
    expect(() => validateScaP05HypothesisAgainstPayload(body(), payload())).not.toThrow();
  });

  it("rejects unauthorized evidence and a body without source binding", () => {
    const forged = structuredClone(body());
    forged.actor.evidence_atom_ids = [`p05a_${"f".repeat(64)}`];
    expect(() => validateScaP05HypothesisAgainstPayload(forged, payload())).toThrow(
      /unauthorized evidence atom/u
    );
    const originalPayload = payload();
    const firstAtom = originalPayload.evidence_atoms[0];
    if (firstAtom === undefined) throw new Error("expected one source atom");
    const noSource = {
      ...originalPayload,
      evidence_atoms: [{ ...firstAtom, atom_kind: "control_record" as const }],
    };
    expect(() => validateScaP05HypothesisAgainstPayload(body(), noSource)).toThrow(
      /lacks an exact source binding/u
    );
  });

  it("rejects blank semantics, disconnected causal states, and forged observable identities", () => {
    expectBodyMutationRejected((value) => Reflect.set(value, "bounded_claim", "   "));
    expectBodyMutationRejected((value) =>
      Reflect.set(value, "causal_path", [
        ...body().causal_path,
        {
          ordinal: 2,
          causal_link: "The operation executes.",
          state_before: "A disconnected state",
          state_after: "Protected data changes",
          basis: "inferred",
          evidence_atom_ids: [ATOM_ID],
        },
      ])
    );
    expectBodyMutationRejected((value) => {
      const [first, ...rest] = body().expected_supporting_observations;
      if (first === undefined) throw new Error("expected one supporting observation");
      return Reflect.set(value, "expected_supporting_observations", [
        { ...first, observable_id: `p05o_${"0".repeat(64)}_supporting_0001` },
        ...rest,
      ]);
    });
  });

  it("requires exhaustive constructor/challenger accounting and complete challenger revisions", () => {
    expect(() =>
      validateScaP05ConstructorResultV1({
        schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
        schema_version: 1,
        role: "hypothesis_constructor",
        payload_sha256: "d".repeat(64),
        assigned_item_ids: [SELECTED],
        items: [],
        complete: true,
      })
    ).toThrow();
    expect(() =>
      validateScaP05ChallengerResultV1({
        schema_id: SCA_P05_CHALLENGER_RESULT_V1_SCHEMA,
        schema_version: 1,
        role: "falsification_challenger",
        payload_sha256: "e".repeat(64),
        assigned_item_ids: [SELECTED],
        items: [
          {
            selected_item_id: SELECTED,
            hypothesis_id: HYPOTHESIS_ID,
            decision: "revise_for_investigation",
            replacement_hypothesis: { ...body(), causal_path: [] },
            control_atom_ids: [],
            changed_fields: ["causal_path"],
            rationale: "The causal path required revision.",
          },
        ],
        complete: true,
      })
    ).toThrow();
  });

  it("enforces immutable revision parent shape and exact body digest", () => {
    const valid = withSelfDigest(
      {
        schema_id: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
        schema_version: 1 as const,
        hypothesis_id: HYPOTHESIS_ID,
        revision: 1 as const,
        parent_revision_ref: null,
        parent_revision_sha256: null,
        body: body(),
        body_sha256: sha256(canonicalJson(body())),
        source_snapshot_ref: SOURCE_REF,
        source_snapshot_sha256: SOURCE_SHA,
        p04_transition_ref: ref("transition"),
        selected_item_id: SELECTED,
        cognitive_payload_ref: ref("payload"),
        model_output_ref: ref("model-output"),
        evidence_atom_ids: [ATOM_ID],
        change_reason_codes: ["initial_constructor"],
        changed_fields: [],
        created_at: "2026-09-21T00:00:00.000Z",
      },
      "revision_sha256"
    );
    expect(() => validateScaP05HypothesisRevisionV1(valid)).not.toThrow();
    expect(() =>
      validateScaP05HypothesisRevisionV1({ ...valid, body_sha256: "0".repeat(64) })
    ).toThrow(/body binding/u);
  });

  it("requires exact P05-owned input operation and version metadata", () => {
    const schemaId = "penny.sca-p05-implementation-identity.v1";
    const identityRef: ArtifactRef = {
      ...ref("p05-identity", schemaId),
      run_id: "run-p05-contract",
      phase: "SCA-P05",
      kind: "sca-p05-implementation-identity",
      operation_id: "sca-p05-implementation-identity",
      producer: "host:sca-p05-candidate",
    };
    const expected = {
      run_id: "run-p05-contract",
      kind: "sca-p05-implementation-identity",
      operation_id: "sca-p05-implementation-identity",
      schema_id: schemaId,
    };
    expect(() => assertScaP05InputMetadata(identityRef, expected)).not.toThrow();
    expect(() => assertScaP05InputMetadata({ ...identityRef, version: 2 }, expected)).toThrow(
      /metadata/u
    );
    expect(() =>
      assertScaP05InputMetadata({ ...identityRef, operation_id: "substituted" }, expected)
    ).toThrow(/metadata/u);
  });

  it("matches guarded-worker acceptance for exact SUMMARY or raw P04 phase JSON", () => {
    const p04Id = `p04i_${"1".repeat(64)}`;
    const p04Result = {
      schema_id: "penny.sca-p04-specialist-result.v1",
      schema_version: 1,
      specialist_id: "scanner_dependency_lead",
      role: "scanner_and_dependency_leads",
      population_sha256: "2".repeat(64),
      assigned_item_ids: [p04Id],
      results: [
        {
          stable_id: p04Id,
          recommendation: "select",
          reason_code: "select_for_p05",
          evidence_status: "bounded_but_usable",
          evidence_refs: [SOURCE_REF],
          p05_question_codes: ["inspect_source_surface"],
          uncertainty_code: "bounded_metadata_only",
        },
      ],
      discoveries: [],
      branch_gap_codes: [],
      complete: true,
    };
    const raw = canonicalJson(p04Result);
    expect(parseScaP04PersistedSpecialistResult(raw)).toEqual(p04Result);
    expect(parseScaP04PersistedSpecialistResult(`SUMMARY:${raw}`)).toEqual(p04Result);
    const withConfidence = canonicalJson({ confidence: "PROBABLE", ...p04Result });
    expect(parseScaP04PersistedSpecialistResult(`SUMMARY:${withConfidence}`)).toEqual(p04Result);
    expect(() => parseScaP04PersistedSpecialistResult(`prose\nSUMMARY:${raw}`)).toThrow();
    expect(() => parseScaP04PersistedSpecialistResult(`SUMMARY:${raw}\nSUMMARY:${raw}`)).toThrow();
    expect(() => parseScaP04PersistedSpecialistResult(`SUMMARY:${raw}\ntrailing`)).toThrow();
  });

  it("requires canonical successor-obligation order", () => {
    const obligations = SCA_P05_OBLIGATION_IDS.map((obligationId) => ({
      obligation_id: obligationId,
      class: "required-result" as const,
      status: "satisfied" as const,
      evidence_refs: [SOURCE_REF],
      blocker_codes: [],
    }));
    const ledgerBody = {
      schema_id: SCA_P05_SUCCESSOR_LEDGER_V1_SCHEMA,
      schema_version: 1 as const,
      phase_id: "SCA-P05" as const,
      run_id: "run-p05-contract",
      predecessor_ledger_ref: SOURCE_REF,
      predecessor_ledger_sha256: SOURCE_REF.content_digest,
      obligations,
      all_required_satisfied: true,
      pending_phase_ids: [
        "SCA-P06" as const,
        "SCA-P07" as const,
        "SCA-P08" as const,
        "SCA-P09" as const,
        "SCA-P10" as const,
        "SCA-P11" as const,
        "SCA-P12" as const,
      ],
      append_only: true as const,
      release_eligible: false as const,
      campaign_complete: false as const,
      campaign_completion_claimed: false as const,
    };
    expect(() =>
      validateScaP05SuccessorLedgerV1(withSelfDigest(ledgerBody, "ledger_sha256"))
    ).not.toThrow();
    expect(() =>
      validateScaP05SuccessorLedgerV1(
        withSelfDigest({ ...ledgerBody, obligations: [...obligations].reverse() }, "ledger_sha256")
      )
    ).toThrow(/obligation set mismatch/u);
  });

  it("requires explicit logging/retention treatment and closes allow/blocker semantics", () => {
    const segment = {
      segment_id: SEGMENT_ID,
      selected_item_id: SELECTED,
      origin_ref: SOURCE_REF,
      source_path: "src/auth.ts",
      start_line: 1,
      end_line_exclusive: 2,
      transformation: "verbatim" as const,
      visible_text_sha256: SEGMENT_SHA,
      visible_text_utf8: SEGMENT_TEXT,
      redaction_ranges: [],
      secrets_status: "absent" as const,
      personal_data_status: "absent" as const,
      allowed: true as const,
    };
    const scope = withSelfDigest(
      {
        schema_id: SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: "run-p05-contract",
        phase_id: "SCA-P05" as const,
        source_snapshot_ref: SOURCE_REF,
        source_snapshot_sha256: SOURCE_REF.content_digest,
        required_model: SCA_P05_REQUIRED_MODEL,
        destination_class: "cloud" as const,
        purposes: ["p05_hypothesis_construction" as const, "p05_falsification_challenge" as const],
        source_segments: [segment],
        evidence_permissions: [
          {
            atom_id: ATOM_ID,
            selected_item_id: SELECTED,
            atom_kind: "source_segment" as const,
            origin_ref: SOURCE_REF,
            selector: `source-segment:${SEGMENT_ID}`,
            value_sha256: ATOM_VALUE_SHA,
            allowed: true as const,
          },
        ],
        provider_retention_status: "known" as const,
        provider_retention_days: 0,
        provider_logging_status: "disabled" as const,
        provider_logging_days: 0,
        provider_training_use: "prohibited" as const,
        max_payload_bytes_per_call: 700_000,
        max_provider_calls: 2 as const,
        authority_ref: ref("authority"),
        decision: "allow" as const,
        blocker_codes: [],
      },
      "scope_sha256"
    );
    expect(() => validateScaP05DisclosureScopeV1(scope)).not.toThrow();
    expect(() =>
      validateScaP05DisclosureScopeV1({ ...scope, blocker_codes: ["unknown_logging"] })
    ).toThrow(/self digest|decision\/blocker/u);
    const missingLogging = structuredClone(scope);
    Reflect.deleteProperty(missingLogging, "provider_logging_status");
    expect(() => validateScaP05DisclosureScopeV1(missingLogging)).toThrow();
  });
});
