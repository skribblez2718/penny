import { TextDecoder } from "node:util";

import { Type, type Static } from "typebox";

import {
  currentArtifactRef,
  previewArtifactRef,
  type ArtifactHostStore,
} from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  SCA_P02_QUALIFICATION_ARTIFACTS,
  SCA_P02_QUALIFICATION_CRITERION_IDS,
  createScaP02QualificationDefinitionV1,
} from "./p02-qualification.js";
import {
  SCA_PHASE_GATE_RECORD_V3_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
  SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
} from "./qualification-gate-contracts.js";
import {
  inspectScaQualificationSubjectV1,
  requireScaPhaseGatePassV3,
} from "./qualification-gate.js";

export const SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA =
  "penny.sca-p02-v3-definition-snapshot.v1" as const;
export const SCA_P02_V3_DEFINITION_SNAPSHOT_KIND = "sca-p02-v3-definition-snapshot" as const;
export const SCA_P02_V3_GATE_KIND = "sca-p02-phase-gate-v3" as const;
export const SCA_P02_V3_AUTHORITY = "host:sca-p02-qualification-authority" as const;
const JSON_LIMIT = 4 * 1_048_576;
const CLOSURE_LIMIT = 16 * 1_048_576;

const BindingSchema = Type.Object(
  {
    ref: ArtifactRefSchema,
    parent_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    upstream_refs: Type.Array(ArtifactRefSchema, { maxItems: 1024 }),
  },
  { additionalProperties: false }
);
const ContractSchema = Type.Object(
  {
    artifact_kind: Type.String({ minLength: 1 }),
    schema_id: Type.String({ minLength: 1 }),
    schema_version: Type.Integer({ minimum: 1 }),
    producer: Type.String({ minLength: 1 }),
    media_type: Type.String({ minLength: 1 }),
    max_bytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);
const CriteriaSchema = Type.Object(
  {
    "p02-containment-egress-and-minimization": ArtifactRefSchema,
    "p02-current-predecessor-and-implementation": ArtifactRefSchema,
    "p02-required-variants-and-lifecycle": ArtifactRefSchema,
    "p02-six-operation-deterministic-coverage": ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export const ScaP02V3DefinitionSnapshotSchema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal("SCA-P02"),
    implementation_revision: OpaqueIdSchema,
    required_assurance_scope: Type.Literal("host_derived_binding"),
    current_host_binding_sha256: Sha256Schema,
    current_source_manifest_sha256: Sha256Schema,
    max_unique_artifact_bytes: Type.Literal(CLOSURE_LIMIT),
    max_json_artifact_bytes: Type.Literal(JSON_LIMIT),
    reviewer_authority_id: OpaqueIdSchema,
    reviewer_identity_id: OpaqueIdSchema,
    reviewer_lineage_id: OpaqueIdSchema,
    source_policy_module: Type.Literal("apps/orchestration/src/sca/p02-qualification.ts"),
    criterion_ids: Type.Tuple([
      Type.Literal("p02-containment-egress-and-minimization"),
      Type.Literal("p02-current-predecessor-and-implementation"),
      Type.Literal("p02-required-variants-and-lifecycle"),
      Type.Literal("p02-six-operation-deterministic-coverage"),
    ]),
    contracts: Type.Object(
      {
        implementation_identity: ContractSchema,
        criterion_definition: ContractSchema,
        criterion_evidence: ContractSchema,
        reviewer_authority: ContractSchema,
        reviewer_receipt: ContractSchema,
        qualification: ContractSchema,
        gate: ContractSchema,
      },
      { additionalProperties: false }
    ),
    implementation_identity: BindingSchema,
    qualified_inputs: Type.Array(BindingSchema, { minItems: 1, maxItems: 1024 }),
    criterion_definition_refs: CriteriaSchema,
    reviewer_authority_ref: ArtifactRefSchema,
    reviewer_receipt_ref: ArtifactRefSchema,
    formal_review_ref: ArtifactRefSchema,
    qualification_ref: ArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    subject_sha256: Sha256Schema,
    definition_snapshot_sha256: Sha256Schema,
    activation_performed: Type.Literal(false),
    registration_performed: Type.Literal(false),
    p03_admission_performed: Type.Literal(false),
  },
  { additionalProperties: false, $id: SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA }
);
export type ScaP02V3DefinitionSnapshot = Readonly<Static<typeof ScaP02V3DefinitionSnapshotSchema>>;

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function ordered(refs: readonly ArtifactRef[], label: string): void {
  const ids = refs.map((ref) => currentArtifactRef(ref, label).artifact_id);
  if (
    ids.some(
      (id, index) =>
        index > 0 && Buffer.compare(Buffer.from(ids[index - 1] ?? ""), Buffer.from(id)) >= 0
    )
  ) {
    throw new Error(`${label} must be sorted and unique`);
  }
}
function contract(kind: string, schema_id: string, schema_version: number, producer: string) {
  return {
    artifact_kind: kind,
    schema_id,
    schema_version,
    producer,
    media_type: "application/json",
    max_bytes: JSON_LIMIT,
  };
}
function exactRef(store: ArtifactHostStore, ref: ArtifactRef, label: string): void {
  currentArtifactRef(ref, label);
  if (
    ref.version !==
      store.lastVersion(ref.run_id, ref.phase, ref.branch_id, ref.kind, ref.operation_id) ||
    !same(store.refById(ref.artifact_id), ref)
  ) {
    throw new Error(`${label} is missing or not the current revision`);
  }
}
function binding(
  store: ArtifactHostStore,
  value: Static<typeof BindingSchema>,
  label: string
): void {
  exactRef(store, value.ref, label);
  if ((value.parent_ref === null) !== (value.ref.version === 1))
    throw new Error(`${label} parent revision mismatch`);
  if (value.parent_ref !== null) {
    currentArtifactRef(value.parent_ref);
    if (
      value.parent_ref.version !== value.ref.version - 1 ||
      !same(
        store.refFor(
          value.ref.run_id,
          value.ref.phase,
          value.ref.branch_id,
          value.ref.kind,
          value.ref.operation_id,
          value.ref.version - 1
        ),
        value.parent_ref
      )
    ) {
      throw new Error(`${label} parent is not the preceding revision`);
    }
  }
  ordered(value.upstream_refs, `${label} upstream refs`);
  for (const ref of value.upstream_refs) exactRef(store, ref, `${label} upstream`);
  if (
    !same(store.metadata(value.ref).parent_ref, value.parent_ref) ||
    !same(store.metadata(value.ref).upstream_refs, value.upstream_refs)
  ) {
    throw new Error(`${label} persisted provenance mismatch`);
  }
}

export function createScaP02QualificationDefinitionFromSnapshot(
  snapshot: ScaP02V3DefinitionSnapshot
): ReturnType<typeof createScaP02QualificationDefinitionV1> {
  return createScaP02QualificationDefinitionV1({
    tenant_id: snapshot.tenant_id,
    project_id: snapshot.project_id,
    run_id: snapshot.run_id,
    implementation_revision: snapshot.implementation_revision,
    current_host_binding_sha256: snapshot.current_host_binding_sha256,
    current_source_manifest_sha256: snapshot.current_source_manifest_sha256,
    max_unique_artifact_bytes: snapshot.max_unique_artifact_bytes,
    max_json_artifact_bytes: snapshot.max_json_artifact_bytes,
    reviewer_authority_id: snapshot.reviewer_authority_id,
    reviewer_identity_id: snapshot.reviewer_identity_id,
    reviewer_lineage_id: snapshot.reviewer_lineage_id,
    implementation_identity: snapshot.implementation_identity,
    qualified_inputs: snapshot.qualified_inputs,
    criterion_definition_refs: snapshot.criterion_definition_refs,
    reviewer_authority_contract: snapshot.contracts.reviewer_authority,
    reviewer_receipt_contract: snapshot.contracts.reviewer_receipt,
    qualification_record_contract: snapshot.contracts.qualification,
    gate_record_contract: snapshot.contracts.gate,
  });
}

/** Direct, non-registering P03 admission boundary. The snapshot is a recipe, not authority. */
export function requireScaP03AcceptedP02Qualification(input: {
  readonly store: ArtifactHostStore;
  readonly definition_ref: ArtifactRef;
  readonly gate_ref: ArtifactRef;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly accepted_p02_refs: readonly ArtifactRef[];
}): ScaP02V3DefinitionSnapshot {
  const { store, definition_ref, gate_ref } = input;
  for (const [ref, kind, schema, producer] of [
    [
      definition_ref,
      SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
      SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA,
      SCA_P02_V3_AUTHORITY,
    ],
    [gate_ref, SCA_P02_V3_GATE_KIND, SCA_PHASE_GATE_RECORD_V3_SCHEMA, SCA_P02_V3_AUTHORITY],
  ] as const) {
    exactRef(store, ref, kind);
    if (
      ref.kind !== kind ||
      ref.producer !== producer ||
      ref.media_type !== "application/json" ||
      ref.content_schema?.schema_id !== schema ||
      ref.content_schema.schema_version !== (ref === gate_ref ? 3 : 1) ||
      ref.phase !== "SCA-P02" ||
      ref.branch_id !== null ||
      ref.byte_length > JSON_LIMIT
    ) {
      throw new Error(`${kind} contract mismatch`);
    }
  }
  const bytes = store.readById(definition_ref.artifact_id);
  if (
    bytes.byteLength !== definition_ref.byte_length ||
    sha256(bytes) !== definition_ref.content_digest ||
    !same(
      previewArtifactRef({ metadata: store.metadata(definition_ref), content: bytes }),
      definition_ref
    )
  ) {
    throw new Error("P02 snapshot custody mismatch");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new Error("P02 snapshot must be canonical JSON");
  const snapshot = validateContract(
    ScaP02V3DefinitionSnapshotSchema,
    parsed,
    "P02 V3 definition snapshot"
  );
  const { definition_snapshot_sha256: _digest, ...unsigned } = snapshot;
  if (
    snapshot.definition_snapshot_sha256 !== sha256(canonicalJson(unsigned)) ||
    snapshot.tenant_id !== input.tenant_id ||
    snapshot.project_id !== input.project_id ||
    snapshot.run_id !== definition_ref.run_id ||
    snapshot.run_id !== gate_ref.run_id ||
    !same(snapshot.gate_ref, gate_ref) ||
    snapshot.reviewer_lineage_id !== snapshot.formal_review_ref.artifact_id ||
    snapshot.reviewer_identity_id === snapshot.reviewer_lineage_id ||
    !same(snapshot.criterion_ids, SCA_P02_QUALIFICATION_CRITERION_IDS)
  ) {
    throw new Error("P02 snapshot digest, subject, reviewer or gate binding mismatch");
  }
  const expectedContracts = {
    implementation_identity: contract(
      SCA_P02_QUALIFICATION_ARTIFACTS.identity.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.identity.schema_id,
      1,
      SCA_P02_QUALIFICATION_ARTIFACTS.identity.producer
    ),
    criterion_definition: contract(
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.schema_id,
      1,
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.producer
    ),
    criterion_evidence: contract(
      SCA_P02_QUALIFICATION_ARTIFACTS.evidence.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.evidence.schema_id,
      1,
      SCA_P02_QUALIFICATION_ARTIFACTS.evidence.producer
    ),
    reviewer_authority: contract(
      "sca-p02-phase-reviewer-authority",
      SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
      1,
      "host:sca-p02-qualification-review-authority"
    ),
    reviewer_receipt: contract(
      "sca-p02-phase-review-receipt",
      SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
      1,
      "host:sca-p02-qualification-review-authority"
    ),
    qualification: contract(
      "sca-p02-phase-qualification-v3",
      SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
      3,
      SCA_P02_V3_AUTHORITY
    ),
    gate: contract(SCA_P02_V3_GATE_KIND, SCA_PHASE_GATE_RECORD_V3_SCHEMA, 3, SCA_P02_V3_AUTHORITY),
  };
  if (!same(snapshot.contracts, expectedContracts))
    throw new Error("P02 qualification contracts changed");
  binding(store, snapshot.implementation_identity, "P02 implementation");
  ordered(
    snapshot.qualified_inputs.map((item) => item.ref),
    "P02 qualified inputs"
  );
  for (const item of snapshot.qualified_inputs) binding(store, item, "P02 qualified input");
  const criteriaRefs = SCA_P02_QUALIFICATION_CRITERION_IDS.map(
    (id) => snapshot.criterion_definition_refs[id]
  );
  const subjectRefs = [
    snapshot.implementation_identity.ref,
    ...snapshot.qualified_inputs.map((item) => item.ref),
    ...criteriaRefs,
  ];
  if (new Set(subjectRefs.map((ref) => ref.artifact_id)).size !== subjectRefs.length)
    throw new Error("P02 subject refs overlap");
  for (const ref of criteriaRefs) {
    exactRef(store, ref, "P02 criterion");
    if (
      ref.run_id !== snapshot.run_id ||
      ref.phase !== "SCA-P02" ||
      ref.kind !== expectedContracts.criterion_definition.artifact_kind ||
      ref.producer !== expectedContracts.criterion_definition.producer ||
      ref.content_schema?.schema_id !== expectedContracts.criterion_definition.schema_id ||
      ref.content_schema.schema_version !== 1 ||
      ref.byte_length > JSON_LIMIT
    )
      throw new Error("P02 criterion ref contract mismatch");
  }
  for (const [ref, expected] of [
    [snapshot.implementation_identity.ref, expectedContracts.implementation_identity],
    [snapshot.reviewer_authority_ref, expectedContracts.reviewer_authority],
    [snapshot.reviewer_receipt_ref, expectedContracts.reviewer_receipt],
    [snapshot.qualification_ref, expectedContracts.qualification],
    [snapshot.gate_ref, expectedContracts.gate],
  ] as const) {
    exactRef(store, ref, "P02 qualification lineage");
    if (
      ref.run_id !== snapshot.run_id ||
      ref.phase !== "SCA-P02" ||
      ref.kind !== expected.artifact_kind ||
      ref.producer !== expected.producer ||
      ref.media_type !== expected.media_type ||
      ref.content_schema?.schema_id !== expected.schema_id ||
      ref.content_schema.schema_version !== expected.schema_version ||
      ref.byte_length > JSON_LIMIT
    )
      throw new Error("P02 qualification lineage contract mismatch");
  }
  exactRef(store, snapshot.formal_review_ref, "P02 formal review");
  if (
    snapshot.formal_review_ref.producer !== snapshot.reviewer_identity_id ||
    snapshot.formal_review_ref.kind !== "agent-output"
  )
    throw new Error("P02 formal review lineage mismatch");
  // A qualified collector may name its operational cohort through exact persisted
  // upstream refs; those refs need not themselves be direct qualification inputs.
  const accepted = input.accepted_p02_refs.map((ref) => {
    exactRef(store, ref, "accepted P02 operational ref");
    return canonicalJson(ref);
  });
  if (
    accepted.length === 0 ||
    !snapshot.qualified_inputs.some((item) => {
      const closure = new Set([item.ref, ...item.upstream_refs].map((ref) => canonicalJson(ref)));
      return accepted.every((ref) => closure.has(ref));
    })
  ) {
    throw new Error("P02 qualification does not cover one exact accepted operational cohort");
  }
  const definition = createScaP02QualificationDefinitionFromSnapshot(snapshot);
  const subject = inspectScaQualificationSubjectV1({ store, definition });
  if (
    subject.subject_sha256 !== snapshot.subject_sha256 ||
    subject.criteria.some(
      (criterion) =>
        criterion.required_evidence_class !== "live" || criterion.required_evidence_count !== 1
    )
  ) {
    throw new Error("P02 qualified subject differs from its policy snapshot");
  }
  const gate = requireScaPhaseGatePassV3({ store, definition, gate_ref });
  if (
    !same(gate.qualification_ref, snapshot.qualification_ref) ||
    !same(gate.reviewer_authority_ref, snapshot.reviewer_authority_ref) ||
    !same(gate.reviewer_receipt_ref, snapshot.reviewer_receipt_ref) ||
    gate.criterion_results.length !== SCA_P02_QUALIFICATION_CRITERION_IDS.length ||
    gate.criterion_results.some((criterion) => criterion.status !== "PASS") ||
    gate.remaining_gaps.length !== 0
  ) {
    throw new Error("P02 V3 gate is not the exact passed four-criterion qualification");
  }
  // Snapshot provenance must point at the verified gate; any other immediate
  // ancestors must belong to the reconstructed subject or review closure.
  const provenance = store.metadata(definition_ref);
  const required = canonicalJson(snapshot.gate_ref);
  const allowed = new Set([
    required,
    ...[
      snapshot.qualification_ref,
      snapshot.reviewer_authority_ref,
      snapshot.reviewer_receipt_ref,
      snapshot.formal_review_ref,
    ].map((ref) => canonicalJson(ref)),
    ...subjectRefs.map((ref) => canonicalJson(ref)),
    ...snapshot.qualified_inputs.flatMap((item) =>
      item.upstream_refs.map((ref) => canonicalJson(ref))
    ),
    ...snapshot.implementation_identity.upstream_refs.map((ref) => canonicalJson(ref)),
    ...store.metadata(snapshot.qualification_ref).upstream_refs.map((ref) => canonicalJson(ref)),
  ]);
  ordered(provenance.upstream_refs, "P02 snapshot provenance refs");
  const observed = new Set(provenance.upstream_refs.map((ref) => canonicalJson(ref)));
  if (
    provenance.parent_ref !== null ||
    !observed.has(required) ||
    [...observed].some((ref) => !allowed.has(ref))
  ) {
    throw new Error("P02 snapshot provenance closure mismatch");
  }
  return snapshot;
}
