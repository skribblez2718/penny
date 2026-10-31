import { Type, type Static, type TSchema } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract } from "../contracts.js";
import {
  ScaP03QualificationCaseV2Schema,
  SCA_P03_MAX_QUALIFICATION_TOTAL_BYTES,
  SCA_P03_QUERY_IDS,
  validateScaP03QualificationCaseObservationsV2,
} from "./p03-contracts.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";

export const SCA_P03_BOOTSTRAP_RECORD_V2_SCHEMA = "penny.sca-p03-bootstrap-qualification-record.v2";
export const SCA_P03_BOOTSTRAP_REVIEW_V2_SCHEMA = "penny.sca-p03-bootstrap-review.v2";
export const SCA_P03_ATTESTATION_BINDING_V2_SCHEMA = "penny.sca-p03-attestation-binding.v2";

const EvidenceClass = Type.Union([Type.Literal("live"), Type.Literal("deterministic_test_only")]);
/** A host-owned comparison record. A candidate can produce observations, not this decision. */
export const ScaP03BootstrapQualificationRecordV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_BOOTSTRAP_RECORD_V2_SCHEMA),
    schema_version: Type.Literal(2),
    evidence_class: EvidenceClass,
    fixture_corpus_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    source_oracle_review_ref: ArtifactRefSchema,
    parser_identity_sha256: Sha256Schema,
    baseline_query_set_ref: ArtifactRefSchema,
    qualification_profile_ref: ArtifactRefSchema,
    runtime_policy_ref: ArtifactRefSchema,
    implementation_identity_ref: ArtifactRefSchema,
    runtime_identity_ref: ArtifactRefSchema,
    cleanup_evidence_ref: ArtifactRefSchema,
    host_isolation_evidence_ref: ArtifactRefSchema,
    fixture_content_refs: Type.Array(ArtifactRefSchema, { minItems: 3, maxItems: 256 }),
    query_script_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    query_plan_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    runtime_package_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
    runtime_id: OpaqueIdSchema,
    isolation_id: OpaqueIdSchema,
    runtime_tree_sha256: Sha256Schema,
    joern_version: Type.String({ minLength: 1, maxLength: 256 }),
    max_num_def: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    implementation_identity_sha256: Sha256Schema,
    deployment_identity_sha256: Sha256Schema,
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    release_id: OpaqueIdSchema,
    release_sha256: Sha256Schema,
    executed_query_release_sha256: Sha256Schema,
    observations: Type.Array(ScaP03QualificationCaseV2Schema, { minItems: 21, maxItems: 21 }),
    exact_expected_observations: Type.Boolean(),
    cleanup_verified: Type.Boolean(),
    host_isolation_verified: Type.Boolean(),
    evaluated_at: Rfc3339UtcSchema,
    record_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_BOOTSTRAP_RECORD_V2_SCHEMA }
);
export type ScaP03BootstrapQualificationRecordV2 = Readonly<
  Static<typeof ScaP03BootstrapQualificationRecordV2Schema>
>;

/** Receipt bytes are checked by a trusted host verifier, not by the candidate or the record. */
export const ScaP03BootstrapReviewV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_BOOTSTRAP_REVIEW_V2_SCHEMA),
    schema_version: Type.Literal(2),
    evidence_class: EvidenceClass,
    record_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    reviewer_id: OpaqueIdSchema,
    reviewer_authority_id: OpaqueIdSchema,
    reviewer_receipt_ref: ArtifactRefSchema,
    decision: Type.Literal("PASS"),
    reviewed_at: Rfc3339UtcSchema,
    review_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_BOOTSTRAP_REVIEW_V2_SCHEMA }
);
export type ScaP03BootstrapReviewV2 = Readonly<Static<typeof ScaP03BootstrapReviewV2Schema>>;

/** V1 attestation stays on the P03 wire; this V2 binding makes its bootstrap proof auditable. */
export const ScaP03AttestationBindingV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_ATTESTATION_BINDING_V2_SCHEMA),
    schema_version: Type.Literal(2),
    host_attestation_ref: ArtifactRefSchema,
    qualification_record_ref: ArtifactRefSchema,
    review_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    parser_identity_sha256: Sha256Schema,
    binding_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_ATTESTATION_BINDING_V2_SCHEMA }
);
export type ScaP03AttestationBindingV2 = Readonly<Static<typeof ScaP03AttestationBindingV2Schema>>;

function validateSelfDigest<T extends TSchema>(schema: T, value: unknown, key: string): Static<T> {
  const checked = validateContract(schema, value, "P03 bootstrap evidence");
  const digest = Object.fromEntries(Object.entries(checked).filter(([name]) => name !== key));
  if (Reflect.get(checked, key) !== sha256(canonicalJson(digest)))
    throw new Error("p03_bootstrap_digest_mismatch");
  return checked;
}

export const validateScaP03BootstrapQualificationRecordV2 = (
  value: unknown
): ScaP03BootstrapQualificationRecordV2 => {
  const record = validateSelfDigest(
    ScaP03BootstrapQualificationRecordV2Schema,
    value,
    "record_sha256"
  );
  if (
    Buffer.byteLength(
      canonicalJson(record.observations.map((entry) => entry.observations)),
      "utf8"
    ) > SCA_P03_MAX_QUALIFICATION_TOTAL_BYTES
  )
    throw new Error("p03_bootstrap_observations_exceed_bound");
  const expectedKeys = (["php", "javascript", "typescript"] as const).flatMap((language) =>
    SCA_P03_QUERY_IDS.map((query_id) => `${language}\u0000${query_id}`)
  );
  if (
    record.observations.some(
      (entry, index) => `${entry.language}\u0000${entry.query_id}` !== expectedKeys[index]
    )
  )
    throw new Error("p03_bootstrap_observation_order_drift");
  for (const entry of record.observations)
    validateScaP03QualificationCaseObservationsV2(
      entry,
      record.executed_query_release_sha256,
      undefined,
      record.source_oracle_validation_ref
    );
  return record;
};
export const validateScaP03BootstrapReviewV2 = (value: unknown): ScaP03BootstrapReviewV2 =>
  validateSelfDigest(ScaP03BootstrapReviewV2Schema, value, "review_sha256");
export const validateScaP03AttestationBindingV2 = (value: unknown): ScaP03AttestationBindingV2 =>
  validateSelfDigest(ScaP03AttestationBindingV2Schema, value, "binding_sha256");

// V3 is a new wire family. V2 fixtures remain replayable only via the deterministic
// verification seam; an old record cannot be silently upgraded to live evidence.
export const SCA_P03_ATTEMPT_WITNESS_V1_SCHEMA = "penny.sca-p03-attempt-witness.v1";
export const SCA_P03_CLEANUP_EVIDENCE_V2_SCHEMA = "penny.sca-p03-bootstrap-cleanup-evidence.v2";
export const SCA_P03_ISOLATION_EVIDENCE_V2_SCHEMA = "penny.sca-p03-bootstrap-isolation-evidence.v2";
export const SCA_P03_REVIEW_RECEIPT_V2_SCHEMA = "penny.sca-p03-bootstrap-reviewer-receipt.v2";
export const SCA_P03_SELECTION_V1_SCHEMA = "penny.sca-p03-bootstrap-selection.v1";

const ContainerName = Type.String({ pattern: "^penny-p03-[a-f0-9-]{36}$", maxLength: 46 });
const ContainerId = Type.String({ pattern: "^[a-f0-9]{64}$" });
const WitnessExecution = Type.Object(
  {
    ordinal: Type.Integer({ minimum: 0, maximum: 255 }),
    name: ContainerName,
    id: Type.Union([ContainerId, Type.Null()]),
    create_sha256: Sha256Schema,
    created: Type.Boolean(),
    started: Type.Boolean(),
    exec_completed: Type.Boolean(),
    requires_readback: Type.Boolean(),
    inspect_sha256: Type.Union([Sha256Schema, Type.Null()]),
    confinement_sha256: Type.Union([Sha256Schema, Type.Null()]),
    confinement_projection: Type.Union([
      Type.String({ minLength: 2, maxLength: 8192 }),
      Type.Null(),
    ]),
    command_sha256: Type.Union([Sha256Schema, Type.Null()]),
    response_sha256: Type.Union([Sha256Schema, Type.Null()]),
    readback_sha256: Type.Union([Sha256Schema, Type.Null()]),
    removed: Type.Boolean(),
    absence_observed: Type.Boolean(),
    disposition: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("create_reply_lost"),
    ]),
  },
  { additionalProperties: false }
);
const Identity = Type.Object(
  {
    runtime_id: OpaqueIdSchema,
    isolation_id: OpaqueIdSchema,
    implementation_sha256: Sha256Schema,
    runtime_package_sha256: Sha256Schema,
    deployment_sha256: Sha256Schema,
    docker_executable_sha256: Sha256Schema,
    docker_client_version: Type.String({ minLength: 1, maxLength: 64 }),
    docker_server_version: Type.String({ minLength: 1, maxLength: 64 }),
    image_id: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    joern_version: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false }
);
export const ScaP03AttemptWitnessV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_ATTEMPT_WITNESS_V1_SCHEMA),
    schema_version: Type.Literal(1),
    attempt_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    candidate_sha256: Sha256Schema,
    identity: Identity,
    workspace_sha256: Sha256Schema,
    started_at: Rfc3339UtcSchema,
    ended_at: Rfc3339UtcSchema,
    executions: Type.Array(WitnessExecution, { minItems: 0, maxItems: 256 }),
    workspace_absent: Type.Boolean(),
    disposition: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    witness_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_ATTEMPT_WITNESS_V1_SCHEMA }
);
export type ScaP03AttemptWitnessV1 = Readonly<Static<typeof ScaP03AttemptWitnessV1Schema>>;

export const ScaP03CleanupEvidenceV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_CLEANUP_EVIDENCE_V2_SCHEMA),
    schema_version: Type.Literal(2),
    attempt_ref: ArtifactRefSchema,
    record_input_sha256: Sha256Schema,
    verifier_id: OpaqueIdSchema,
    observed_at: Rfc3339UtcSchema,
    containers: Type.Array(
      Type.Object(
        { name: ContainerName, id: Type.Union([ContainerId, Type.Null()]), absent: Type.Boolean() },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 256 }
    ),
    workspace_absent_or_empty: Type.Boolean(),
    complete_census: Type.Boolean(),
    decision: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]),
    evidence_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_CLEANUP_EVIDENCE_V2_SCHEMA }
);
export type ScaP03CleanupEvidenceV2 = Readonly<Static<typeof ScaP03CleanupEvidenceV2Schema>>;

export const ScaP03IsolationEvidenceV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_ISOLATION_EVIDENCE_V2_SCHEMA),
    schema_version: Type.Literal(2),
    attempt_ref: ArtifactRefSchema,
    policy_ref: ArtifactRefSchema,
    verifier_id: OpaqueIdSchema,
    observed_at: Rfc3339UtcSchema,
    identity: Identity,
    containers: Type.Array(
      Type.Object(
        { name: ContainerName, id: ContainerId, confinement_sha256: Sha256Schema },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 256 }
    ),
    decision: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]),
    evidence_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_ISOLATION_EVIDENCE_V2_SCHEMA }
);
export type ScaP03IsolationEvidenceV2 = Readonly<Static<typeof ScaP03IsolationEvidenceV2Schema>>;

export const ScaP03ExternalReviewReceiptV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_REVIEW_RECEIPT_V2_SCHEMA),
    schema_version: Type.Literal(2),
    external_review_id: OpaqueIdSchema,
    external_review_ref: ArtifactRefSchema,
    record_ref: ArtifactRefSchema,
    attempt_ref: ArtifactRefSchema,
    cleanup_ref: ArtifactRefSchema,
    isolation_ref: ArtifactRefSchema,
    reviewer_id: OpaqueIdSchema,
    reviewer_authority_id: OpaqueIdSchema,
    evaluator_id: OpaqueIdSchema,
    attester_id: OpaqueIdSchema,
    reviewed_at: Rfc3339UtcSchema,
    decision: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]),
    receipt_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_REVIEW_RECEIPT_V2_SCHEMA }
);
export type ScaP03ExternalReviewReceiptV2 = Readonly<
  Static<typeof ScaP03ExternalReviewReceiptV2Schema>
>;

export const ScaP03CurrentSelectionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_SELECTION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    record_ref: ArtifactRefSchema,
    binding_ref: ArtifactRefSchema,
    deployment_sha256: Sha256Schema,
    selected_at: Rfc3339UtcSchema,
    status: Type.Union([Type.Literal("selected"), Type.Literal("revoked")]),
    selection_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_SELECTION_V1_SCHEMA }
);
export type ScaP03CurrentSelectionV1 = Readonly<Static<typeof ScaP03CurrentSelectionV1Schema>>;

export function parseScaP03BootstrapEvidence<T extends TSchema>(
  schema: T,
  bytes: Uint8Array,
  digestKey: string
): Static<T> {
  if (bytes.byteLength > 1024 * 1024 || bytes.byteLength === 0)
    throw new Error("p03_evidence_size_invalid");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("p03_evidence_json_invalid");
  }
  const checked = validateSelfDigest(schema, value, digestKey);
  if (canonicalJson(checked) !== text) throw new Error("p03_evidence_noncanonical");
  return checked;
}

function orderedUnique(names: readonly string[]): boolean {
  return names.every((name, i) => i === 0 || name > (names[i - 1] ?? ""));
}
export function validateScaP03AttemptWitnessV1(bytes: Uint8Array): ScaP03AttemptWitnessV1 {
  const value = parseScaP03BootstrapEvidence(ScaP03AttemptWitnessV1Schema, bytes, "witness_sha256");
  if (
    Date.parse(value.ended_at) < Date.parse(value.started_at) ||
    value.executions.some((entry, i) => entry.ordinal !== i) ||
    new Set(value.executions.map((entry) => entry.name)).size !== value.executions.length ||
    (value.disposition === "completed" && value.executions.length === 0) ||
    (value.disposition === "completed" &&
      (!value.workspace_absent ||
        value.executions.some((entry) => !entry.removed || !entry.absence_observed))) ||
    (value.disposition === "completed" &&
      value.executions.some(
        (entry) =>
          entry.disposition !== "completed" ||
          !entry.removed ||
          !entry.absence_observed ||
          entry.id === null ||
          !entry.created ||
          !entry.started ||
          !entry.exec_completed ||
          entry.inspect_sha256 === null ||
          entry.confinement_sha256 === null ||
          entry.confinement_projection === null ||
          entry.command_sha256 === null ||
          entry.response_sha256 === null ||
          (entry.requires_readback && entry.readback_sha256 === null)
      ))
  )
    throw new Error("p03_witness_incomplete");
  return value;
}
export function validateScaP03CleanupEvidenceV2(bytes: Uint8Array): ScaP03CleanupEvidenceV2 {
  const value = parseScaP03BootstrapEvidence(
    ScaP03CleanupEvidenceV2Schema,
    bytes,
    "evidence_sha256"
  );
  if (
    !orderedUnique(value.containers.map((c) => c.name)) ||
    (value.decision === "PASS" &&
      (!value.complete_census ||
        !value.workspace_absent_or_empty ||
        value.containers.some((c) => !c.absent)))
  )
    throw new Error("p03_cleanup_incomplete");
  return value;
}
export function validateScaP03IsolationEvidenceV2(bytes: Uint8Array): ScaP03IsolationEvidenceV2 {
  const value = parseScaP03BootstrapEvidence(
    ScaP03IsolationEvidenceV2Schema,
    bytes,
    "evidence_sha256"
  );
  if (!orderedUnique(value.containers.map((c) => c.name)))
    throw new Error("p03_isolation_order_invalid");
  return value;
}
export function validateScaP03ExternalReviewReceiptV2(
  bytes: Uint8Array
): ScaP03ExternalReviewReceiptV2 {
  const value = parseScaP03BootstrapEvidence(
    ScaP03ExternalReviewReceiptV2Schema,
    bytes,
    "receipt_sha256"
  );
  if (
    new Set([value.reviewer_id, value.evaluator_id, value.attester_id]).size !== 3 ||
    value.reviewer_authority_id === value.evaluator_id ||
    value.reviewer_authority_id === value.attester_id
  )
    throw new Error("p03_review_role_collision");
  return value;
}
export function validateScaP03CurrentSelectionV1(bytes: Uint8Array): ScaP03CurrentSelectionV1 {
  return parseScaP03BootstrapEvidence(ScaP03CurrentSelectionV1Schema, bytes, "selection_sha256");
}

export const SCA_P03_BOOTSTRAP_RECORD_V3_SCHEMA = "penny.sca-p03-bootstrap-qualification-record.v3";
export const SCA_P03_BOOTSTRAP_REVIEW_V3_SCHEMA = "penny.sca-p03-bootstrap-review.v3";
export const SCA_P03_ATTESTATION_BINDING_V3_SCHEMA = "penny.sca-p03-attestation-binding.v3";
export const ScaP03BootstrapQualificationRecordV3Schema = Type.Object(
  {
    ...ScaP03BootstrapQualificationRecordV2Schema.properties,
    schema_id: Type.Literal(SCA_P03_BOOTSTRAP_RECORD_V3_SCHEMA),
    schema_version: Type.Literal(3),
    attempt_witness_ref: ArtifactRefSchema,
    implementation_closure_sha256: Sha256Schema,
    runtime_package_closure_sha256: Sha256Schema,
    implementation_source_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false, $id: SCA_P03_BOOTSTRAP_RECORD_V3_SCHEMA }
);
export type ScaP03BootstrapQualificationRecordV3 = Readonly<
  Static<typeof ScaP03BootstrapQualificationRecordV3Schema>
>;
export const ScaP03BootstrapReviewV3Schema = Type.Object(
  {
    ...ScaP03BootstrapReviewV2Schema.properties,
    schema_id: Type.Literal(SCA_P03_BOOTSTRAP_REVIEW_V3_SCHEMA),
    schema_version: Type.Literal(3),
    attempt_witness_ref: ArtifactRefSchema,
    implementation_source_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false, $id: SCA_P03_BOOTSTRAP_REVIEW_V3_SCHEMA }
);
export type ScaP03BootstrapReviewV3 = Readonly<Static<typeof ScaP03BootstrapReviewV3Schema>>;
export const ScaP03AttestationBindingV3Schema = Type.Object(
  {
    ...ScaP03AttestationBindingV2Schema.properties,
    schema_id: Type.Literal(SCA_P03_ATTESTATION_BINDING_V3_SCHEMA),
    schema_version: Type.Literal(3),
    attempt_witness_ref: ArtifactRefSchema,
    implementation_source_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false, $id: SCA_P03_ATTESTATION_BINDING_V3_SCHEMA }
);
export type ScaP03AttestationBindingV3 = Readonly<Static<typeof ScaP03AttestationBindingV3Schema>>;

export const SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA =
  "penny.sca-p03-production-qualification-record.v1" as const;
export const SCA_P03_PRODUCTION_QUALIFICATION_RECORD_KIND =
  "sca-p03-production-qualification-record" as const;
export const SCA_P03_PRODUCTION_QUALIFICATION_RECORD_OPERATION_ID =
  "production-qualification-record" as const;
export const SCA_P03_PRODUCTION_EVALUATOR = "host:sca-p03-production-evaluator" as const;
export const ScaP03AcceptedP01BindingsV1Schema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    obligation_ledger_ref: ArtifactRefSchema,
    campaign_manifest_core_ref: ArtifactRefSchema,
    admission_evidence_ref: ArtifactRefSchema,
    p01_gate_ref: ArtifactRefSchema,
    campaign_manifest_ref: ArtifactRefSchema,
    frozen_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 256 }),
  },
  { additionalProperties: false }
);
export type ScaP03AcceptedP01BindingsContractV1 = Readonly<
  Static<typeof ScaP03AcceptedP01BindingsV1Schema>
>;
export const ScaP03ProductionQualificationRecordV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    production_bindings_sha256: Sha256Schema,
    accepted_p01: ScaP03AcceptedP01BindingsV1Schema,
    bootstrap_record_ref: ArtifactRefSchema,
    bootstrap_review_ref: ArtifactRefSchema,
    bootstrap_binding_ref: ArtifactRefSchema,
    host_attestation_ref: ArtifactRefSchema,
    record_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA }
);
export type ScaP03ProductionQualificationRecordV1 = Readonly<
  Static<typeof ScaP03ProductionQualificationRecordV1Schema>
>;

export const validateScaP03ProductionQualificationRecordV1 = (
  value: unknown
): ScaP03ProductionQualificationRecordV1 => {
  const record = validateSelfDigest(
    ScaP03ProductionQualificationRecordV1Schema,
    value,
    "record_sha256"
  );
  const bootstrapRefs = [
    record.bootstrap_record_ref,
    record.bootstrap_review_ref,
    record.bootstrap_binding_ref,
    record.host_attestation_ref,
  ];
  if (
    bootstrapRefs.some((ref) => ref.run_id !== record.run_id) ||
    new Set(bootstrapRefs.map((ref) => ref.artifact_id)).size !== bootstrapRefs.length
  ) {
    throw new Error("p03_production_record_bootstrap_refs_invalid");
  }
  return record;
};

export const validateScaP03BootstrapQualificationRecordV3 = (
  value: unknown
): ScaP03BootstrapQualificationRecordV3 => {
  const record = validateSelfDigest(
    ScaP03BootstrapQualificationRecordV3Schema,
    value,
    "record_sha256"
  );
  if (
    Buffer.byteLength(canonicalJson(record.observations), "utf8") >
    SCA_P03_MAX_QUALIFICATION_TOTAL_BYTES
  )
    throw new Error("p03_bootstrap_observations_exceed_bound");
  const expected = (["php", "javascript", "typescript"] as const).flatMap((language) =>
    SCA_P03_QUERY_IDS.map((query_id) => `${language}\u0000${query_id}`)
  );
  if (
    record.observations.length !== expected.length ||
    record.observations.some(
      (entry, index) => `${entry.language}\u0000${entry.query_id}` !== expected[index]
    )
  )
    throw new Error("p03_bootstrap_observation_order_drift");
  for (const entry of record.observations)
    validateScaP03QualificationCaseObservationsV2(
      entry,
      record.executed_query_release_sha256,
      undefined,
      record.source_oracle_validation_ref
    );
  if (
    record.implementation_source_refs.reduce((total, ref) => total + ref.byte_length, 0) >
      32 * 1024 * 1024 ||
    record.implementation_source_refs.some(
      (ref, index) =>
        index > 0 &&
        ref.artifact_id <= (record.implementation_source_refs[index - 1]?.artifact_id ?? "")
    )
  )
    throw new Error("p03_implementation_source_refs_invalid");
  return record;
};
export const validateScaP03BootstrapReviewV3 = (value: unknown): ScaP03BootstrapReviewV3 =>
  validateSelfDigest(ScaP03BootstrapReviewV3Schema, value, "review_sha256");
export const validateScaP03AttestationBindingV3 = (value: unknown): ScaP03AttestationBindingV3 =>
  validateSelfDigest(ScaP03AttestationBindingV3Schema, value, "binding_sha256");
