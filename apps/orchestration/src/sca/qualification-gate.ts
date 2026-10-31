import { TextDecoder } from "node:util";

import { currentArtifactRef, type ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { assertText } from "../skill-contracts/common.js";
import {
  SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
  SCA_PHASE_GATE_RECORD_V3_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
  SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
  deriveScaQualificationStatus,
  sealScaPhaseGateRecordV3,
  sealScaPhaseQualificationRecordV3,
  validateScaPhaseCriterionDefinitionV1,
  validateScaPhaseGateRecordV3,
  validateScaPhaseQualificationRecordV3,
  validateScaPhaseReviewReceiptV1,
  validateScaPhaseReviewerAuthorityV1,
  type ScaImplementationAssuranceScope,
  type ScaPhaseGateRecordV3,
  type ScaPhaseQualificationCriterionV3,
  type ScaPhaseQualificationRecordV3,
  type ScaPhaseReviewReceiptV1,
  type ScaPhaseReviewerAuthorityV1,
  type ScaQualificationCriterionStatus,
  type ScaQualificationEvidenceClass,
} from "./qualification-gate-contracts.js";

const MAX_JSON_ARTIFACT_BYTES = 16 * 1_048_576;
const MAX_MATERIAL_ARTIFACT_BYTES = 64 * 1_048_576;
const MAX_CRITERIA = 64;
const MAX_EVIDENCE_REFS_PER_CRITERION = 64;
const MAX_GAP_BYTES = 4_096;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ARTIFACT_KIND_PATTERN = /^[a-z][a-z0-9-]*$/u;
const SCHEMA_ID_PATTERN = /^penny\.[a-z0-9-]+\.v([1-9][0-9]*)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UNSAFE_ID_VALUES = new Set(["__proto__", "constructor", "prototype"]);

export interface ScaArtifactContractV1 {
  readonly artifact_kind: string;
  readonly schema_id: string;
  readonly schema_version: number;
  readonly producer: string;
  readonly media_type: string;
  readonly max_bytes: number;
}

export interface ScaValidatedJsonArtifactContractV1<Value> extends ScaArtifactContractV1 {
  readonly validate: (value: unknown) => Value;
}

export interface ScaImplementationIdentityClaimsV1 {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly phase_id: string;
  readonly implementation_revision: string;
  readonly assurance_scope: ScaImplementationAssuranceScope;
  readonly host_binding_sha256: string | null;
  readonly implementer_identity_id: string;
  readonly implementer_lineage_id: string;
}

export interface ScaCriterionEvidenceClaimsV1 extends ScaImplementationIdentityClaimsV1 {
  readonly criterion_id: string;
  readonly subject_sha256: string;
  readonly observations: readonly {
    readonly check_id: string;
    readonly observed: boolean | null;
  }[];
}

export interface ScaCriterionEvidenceContractV1 extends ScaValidatedJsonArtifactContractV1<ScaCriterionEvidenceClaimsV1> {
  readonly evidence_class: ScaQualificationEvidenceClass;
  /** Trusted host evaluator; never read a PASS label from the evidence as authority. */
  readonly evaluate: (
    claims: readonly ScaCriterionEvidenceClaimsV1[]
  ) => ScaQualificationCriterionStatus;
}

/** Host-owned exact custody expectation for one qualification subject slot. */
export interface ScaArtifactBindingV1 {
  readonly ref: ArtifactRef;
  readonly parent_ref: ArtifactRef | null;
  readonly upstream_refs: readonly ArtifactRef[];
}

export interface ScaPhaseCriterionDefinitionBindingV1 {
  readonly criterion_id: string;
  readonly definition_ref: ArtifactRef;
  readonly definition_contract: ScaArtifactContractV1;
  readonly evidence_contract: ScaCriterionEvidenceContractV1;
}

/** Trusted in-process phase registration, supplied by the host, not parsed from qualification evidence.
 * The host must sample the current implementation binding and reviewer policy at verification time.
 * This record is qualification policy, never runtime activation authority.
 */
export interface ScaPhaseQualificationDefinitionV1 {
  readonly schema_version: 1;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly phase_id: string;
  readonly implementation_revision: string;
  readonly required_assurance_scope: ScaImplementationAssuranceScope;
  /** Current binding from the host, not from the artifact or a caller-selected label. */
  readonly current_host_binding_sha256: string | null;
  readonly max_unique_artifact_bytes: number;
  readonly reviewer_authority_id: string;
  readonly reviewer_identity_id: string;
  readonly reviewer_lineage_id: string;
  readonly implementation_identity: ScaArtifactBindingV1;
  readonly implementation_identity_contract: ScaValidatedJsonArtifactContractV1<ScaImplementationIdentityClaimsV1>;
  readonly qualified_inputs: readonly ScaArtifactBindingV1[];
  readonly criteria: readonly ScaPhaseCriterionDefinitionBindingV1[];
  readonly reviewer_authority_contract: ScaArtifactContractV1;
  readonly reviewer_receipt_contract: ScaArtifactContractV1;
  readonly qualification_record_contract: ScaArtifactContractV1;
  readonly gate_record_contract: ScaArtifactContractV1;
}

export interface ScaCriterionEvidenceRefsV1 {
  readonly criterion_id: string;
  readonly evidence_refs: readonly ArtifactRef[];
}

export interface ScaQualificationSubjectV1 {
  readonly schema_version: 1;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly phase_id: string;
  readonly implementation_revision: string;
  readonly implementation_assurance_scope: ScaImplementationAssuranceScope;
  readonly implementation_identity_ref: ArtifactRef;
  readonly qualified_input_refs: readonly ArtifactRef[];
  readonly implementer_identity_id: string;
  readonly implementer_lineage_id: string;
  readonly criteria: readonly {
    readonly criterion_id: string;
    readonly definition_ref: ArtifactRef;
    readonly required_evidence_class: ScaQualificationEvidenceClass;
    readonly required_evidence_count: number;
  }[];
  readonly subject_sha256: string;
}

export class ScaQualificationGateError extends Error {
  constructor(
    readonly code:
      | "invalid_definition"
      | "artifact_contract_mismatch"
      | "artifact_bytes_mismatch"
      | "qualification_mismatch"
      | "reviewer_mismatch"
      | "gate_blocked",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScaQualificationGateError";
  }
}

function fail(
  code: ScaQualificationGateError["code"],
  message: string,
  options?: ErrorOptions
): never {
  throw new ScaQualificationGateError(code, message, options);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameRefs(left: readonly ArtifactRef[], right: readonly ArtifactRef[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sortedRefs(refs: readonly ArtifactRef[], label: string): ArtifactRef[] {
  const normalized = refs.map((ref, index) => {
    try {
      return currentArtifactRef(ref, `${label}[${index}]`);
    } catch (error) {
      fail(
        "invalid_definition",
        error instanceof Error ? error.message : `${label}[${index}] is invalid`,
        { cause: error }
      );
    }
  });
  const ids = normalized.map((ref) => ref.artifact_id);
  if (new Set(ids).size !== ids.length) {
    fail("invalid_definition", `${label} contains duplicate artifact refs`);
  }
  return [...normalized].sort((left, right) => compareUtf8(left.artifact_id, right.artifact_id));
}

function sortedStrings(values: readonly string[], label: string): string[] {
  for (const [index, value] of values.entries()) {
    try {
      assertText(value, `${label}[${index}]`, {
        minBytes: 1,
        maxBytes: MAX_GAP_BYTES,
        trimmedNonEmpty: true,
      });
    } catch (error) {
      fail(
        "qualification_mismatch",
        error instanceof Error ? error.message : `${label}[${index}] is invalid`,
        { cause: error }
      );
    }
  }
  if (new Set(values).size !== values.length) {
    fail("qualification_mismatch", `${label} contains duplicate values`);
  }
  return [...values].sort(compareUtf8);
}

function assertOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID_PATTERN.test(value) || value.includes("..") || UNSAFE_ID_VALUES.has(value)) {
    fail("invalid_definition", `${label} is not a canonical opaque ID`);
  }
}

function assertArtifactContract(contract: ScaArtifactContractV1, label: string): void {
  if (
    !ARTIFACT_KIND_PATTERN.test(contract.artifact_kind) ||
    Number(SCHEMA_ID_PATTERN.exec(contract.schema_id)?.[1]) !== contract.schema_version ||
    !Number.isSafeInteger(contract.schema_version) ||
    contract.schema_version < 1 ||
    !OPAQUE_ID_PATTERN.test(contract.producer) ||
    contract.media_type.length === 0 ||
    contract.media_type.length > 256 ||
    !Number.isSafeInteger(contract.max_bytes) ||
    contract.max_bytes < 1 ||
    contract.max_bytes > MAX_JSON_ARTIFACT_BYTES
  ) {
    fail("invalid_definition", `${label} is not a bounded canonical artifact contract`);
  }
}

function assertFrameworkContract(
  contract: ScaArtifactContractV1,
  schemaId: string,
  schemaVersion: number,
  label: string
): void {
  assertArtifactContract(contract, label);
  if (contract.schema_id !== schemaId || contract.schema_version !== schemaVersion) {
    fail("invalid_definition", `${label} does not bind the framework schema`);
  }
}

function orderedCriteria(
  definition: ScaPhaseQualificationDefinitionV1
): ScaPhaseCriterionDefinitionBindingV1[] {
  const criteria = [...definition.criteria].sort((left, right) =>
    compareUtf8(left.criterion_id, right.criterion_id)
  );
  const ids = criteria.map((criterion) => criterion.criterion_id);
  if (criteria.length === 0 || criteria.length > MAX_CRITERIA || new Set(ids).size !== ids.length) {
    fail("invalid_definition", "phase definition criteria must be non-empty and unique");
  }
  return criteria;
}

function canonicalBinding(binding: ScaArtifactBindingV1, label: string): ScaArtifactBindingV1 {
  try {
    if (binding.upstream_refs.length > 1_024) {
      fail("invalid_definition", `${label} has too many upstream refs`);
    }
    const ref = currentArtifactRef(binding.ref, `${label} ref`);
    const parent =
      binding.parent_ref === null
        ? null
        : currentArtifactRef(binding.parent_ref, `${label} parent ref`);
    if ((ref.version === 1) !== (parent === null)) {
      fail("invalid_definition", `${label} parent does not match its revision`);
    }
    if (
      parent !== null &&
      (parent.run_id !== ref.run_id ||
        parent.phase !== ref.phase ||
        parent.branch_id !== ref.branch_id ||
        parent.kind !== ref.kind ||
        parent.operation_id !== ref.operation_id ||
        parent.version !== ref.version - 1 ||
        canonicalJson(parent.content_schema ?? null) !== canonicalJson(ref.content_schema ?? null))
    ) {
      fail("invalid_definition", `${label} parent is not the preceding revision`);
    }
    return {
      ref,
      parent_ref: parent,
      upstream_refs: sortedRefs(binding.upstream_refs, `${label} upstream refs`),
    };
  } catch (error) {
    if (error instanceof ScaQualificationGateError) throw error;
    fail("invalid_definition", `${label} is not a canonical artifact binding`, { cause: error });
  }
}

function validateDefinition(definition: ScaPhaseQualificationDefinitionV1): {
  readonly implementation_binding: ScaArtifactBindingV1;
  readonly input_bindings: readonly ScaArtifactBindingV1[];
  readonly input_refs: readonly ArtifactRef[];
  readonly criteria: readonly ScaPhaseCriterionDefinitionBindingV1[];
} {
  for (const [value, label] of [
    [definition.tenant_id, "tenant_id"],
    [definition.project_id, "project_id"],
    [definition.run_id, "run_id"],
    [definition.phase_id, "phase_id"],
    [definition.implementation_revision, "implementation_revision"],
  ] as const) {
    assertOpaqueId(value, `phase definition ${label}`);
  }
  if (definition.schema_version !== 1) {
    fail("invalid_definition", "phase definition schema_version must be 1");
  }
  for (const [value, label] of [
    [definition.reviewer_authority_id, "reviewer_authority_id"],
    [definition.reviewer_identity_id, "reviewer_identity_id"],
    [definition.reviewer_lineage_id, "reviewer_lineage_id"],
  ] as const)
    assertOpaqueId(value, label);
  if (definition.reviewer_identity_id === definition.reviewer_lineage_id) {
    fail("invalid_definition", "reviewer identity and lineage must differ");
  }
  if (
    definition.required_assurance_scope === "declaration_only"
      ? definition.current_host_binding_sha256 !== null
      : !SHA256_PATTERN.test(definition.current_host_binding_sha256 ?? "")
  ) {
    fail(
      "invalid_definition",
      "host current binding must be absent only for declaration-only scope"
    );
  }
  if (
    !Number.isSafeInteger(definition.max_unique_artifact_bytes) ||
    definition.max_unique_artifact_bytes < 1 ||
    definition.max_unique_artifact_bytes > 256 * 1_048_576
  ) {
    fail("invalid_definition", "max unique artifact bytes must be bounded");
  }
  assertArtifactContract(
    definition.implementation_identity_contract,
    "implementation identity contract"
  );
  assertFrameworkContract(
    definition.reviewer_authority_contract,
    SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
    1,
    "reviewer authority contract"
  );
  assertFrameworkContract(
    definition.reviewer_receipt_contract,
    SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
    1,
    "reviewer receipt contract"
  );
  assertFrameworkContract(
    definition.qualification_record_contract,
    SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
    3,
    "qualification record contract"
  );
  assertFrameworkContract(
    definition.gate_record_contract,
    SCA_PHASE_GATE_RECORD_V3_SCHEMA,
    3,
    "gate record contract"
  );
  const inputBindings = definition.qualified_inputs
    .map((binding, index) => canonicalBinding(binding, `qualified input[${index}]`))
    .sort((left, right) => compareUtf8(left.ref.artifact_id, right.ref.artifact_id));
  const inputRefs = sortedRefs(
    inputBindings.map((binding) => binding.ref),
    "qualified input refs"
  );
  if (inputRefs.length === 0 || inputRefs.length > 1_024) {
    fail("invalid_definition", "qualified input refs must contain 1..1024 exact refs");
  }
  const implementationBinding = canonicalBinding(
    definition.implementation_identity,
    "implementation identity"
  );
  const implementationRef = implementationBinding.ref;
  const criteria = orderedCriteria(definition);
  const definitionRefs: ArtifactRef[] = [];
  for (const criterion of criteria) {
    assertOpaqueId(criterion.criterion_id, "criterion_id");
    assertFrameworkContract(
      criterion.definition_contract,
      SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
      1,
      `${criterion.criterion_id} definition contract`
    );
    assertArtifactContract(
      criterion.evidence_contract,
      `${criterion.criterion_id} evidence contract`
    );
    try {
      definitionRefs.push(
        currentArtifactRef(criterion.definition_ref, `${criterion.criterion_id} definition ref`)
      );
    } catch (error) {
      fail(
        "invalid_definition",
        error instanceof Error
          ? error.message
          : `${criterion.criterion_id} definition ref is invalid`,
        { cause: error }
      );
    }
  }
  const closureIds = [
    implementationRef.artifact_id,
    ...inputRefs.map((ref) => ref.artifact_id),
    ...definitionRefs.map((ref) => ref.artifact_id),
  ];
  if (new Set(closureIds).size !== closureIds.length) {
    fail(
      "invalid_definition",
      "implementation, input, and criterion definition refs must be distinct"
    );
  }
  return {
    implementation_binding: implementationBinding,
    input_bindings: inputBindings,
    input_refs: inputRefs,
    criteria,
  };
}

function assertRefContract(ref: ArtifactRef, contract: ScaArtifactContractV1, label: string): void {
  if (
    ref.kind !== contract.artifact_kind ||
    ref.content_schema?.schema_id !== contract.schema_id ||
    ref.content_schema.schema_version !== contract.schema_version ||
    ref.producer !== contract.producer ||
    ref.media_type !== contract.media_type ||
    ref.byte_length < 1 ||
    ref.byte_length > contract.max_bytes
  ) {
    fail(
      "artifact_contract_mismatch",
      `${label} does not match its exact kind, schema, producer, media type, and byte contract`
    );
  }
}

/** Unique refs are charged before reads. Repeated verification of the same ref is free. */
class ClosureBudget {
  private readonly seen = new Map<string, string>();
  private total = 0;
  constructor(private readonly limit: number) {}

  reserve(refs: readonly ArtifactRef[]): void {
    for (const ref of refs) {
      const prior = this.seen.get(ref.artifact_id);
      const signature = canonicalJson(ref);
      if (prior !== undefined && prior !== signature) {
        fail("artifact_contract_mismatch", "closure reuses an artifact ID with different metadata");
      }
      if (prior === undefined) {
        if (
          !Number.isSafeInteger(ref.byte_length) ||
          ref.byte_length < 1 ||
          ref.byte_length > this.limit - this.total
        ) {
          fail("artifact_contract_mismatch", "unique artifact byte budget exceeded");
        }
        this.total += ref.byte_length;
        this.seen.set(ref.artifact_id, signature);
      }
    }
  }
}

/** Generic V3 custody: identity/input topology is bound per host-owned slot.
 * Framework records remain first revisions: definition=identity+all inputs,
 * evidence=identity+all inputs+its definition, authority=subject refs+all evidence,
 * receipt=subject refs+all evidence+authority, qualification=subject refs+all
 * evidence+authority+receipt, gate=qualification only. No implicit transitive refs.
 */
function readExactBytes(
  store: ArtifactHostStore,
  refValue: ArtifactRef,
  label: string,
  maxBytes: number,
  upstreamRefs: readonly ArtifactRef[] | null,
  parentRef: ArtifactRef | null,
  budget: ClosureBudget
): Buffer {
  let ref: ArtifactRef;
  try {
    ref = currentArtifactRef(refValue, label);
  } catch (error) {
    fail("artifact_contract_mismatch", `${label} ref is invalid`, { cause: error });
  }
  if (ref.byte_length < 1 || ref.byte_length > maxBytes) {
    fail("artifact_contract_mismatch", `${label} exceeds its bounded byte contract`);
  }
  budget.reserve([ref]);
  const expectedUpstream =
    upstreamRefs === null ? null : sortedRefs(upstreamRefs, `${label} upstream refs`);
  let bytes: Buffer;
  try {
    const stored = store.refById(ref.artifact_id);
    if (stored === undefined || !sameRef(stored, ref)) {
      fail("artifact_contract_mismatch", `${label} is absent or its exact stored ref changed`);
    }
    const metadata = store.metadata(ref);
    if (
      metadata.schema_version !== 2 ||
      (metadata.parent_ref === null
        ? parentRef !== null
        : parentRef === null || !sameRef(metadata.parent_ref, parentRef)) ||
      metadata.version !== ref.version ||
      metadata.run_id !== ref.run_id ||
      metadata.phase !== ref.phase ||
      metadata.branch_id !== ref.branch_id ||
      metadata.kind !== ref.kind ||
      metadata.operation_id !== ref.operation_id ||
      metadata.producer !== ref.producer ||
      metadata.media_type !== ref.media_type ||
      canonicalJson(metadata.content_schema ?? null) !==
        canonicalJson(ref.content_schema ?? null) ||
      (expectedUpstream !== null && !sameRefs(metadata.upstream_refs, expectedUpstream))
    ) {
      fail(
        "artifact_contract_mismatch",
        `${label} persisted provenance does not match exact closure`
      );
    }
    bytes = store.readById(ref.artifact_id);
  } catch (error) {
    if (error instanceof ScaQualificationGateError) throw error;
    fail("artifact_bytes_mismatch", `${label} failed exact-byte verification`, { cause: error });
  }
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    fail("artifact_bytes_mismatch", `${label} digest or byte length changed`);
  }
  return bytes;
}

function parseCanonicalJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("artifact_contract_mismatch", `${label} is not valid UTF-8`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail("artifact_contract_mismatch", `${label} is not valid JSON`, { cause: error });
  }
  if (canonicalJson(value) !== text) {
    fail("artifact_contract_mismatch", `${label} is not canonical JSON`);
  }
  return value;
}

function readJsonArtifact<Value>(input: {
  readonly store: ArtifactHostStore;
  readonly ref: ArtifactRef;
  readonly contract: ScaArtifactContractV1;
  readonly label: string;
  readonly validate: (value: unknown) => Value;
  readonly upstream_refs: readonly ArtifactRef[] | null;
  readonly parent_ref?: ArtifactRef | null;
  readonly budget: ClosureBudget;
}): Value {
  assertRefContract(input.ref, input.contract, input.label);
  const bytes = readExactBytes(
    input.store,
    input.ref,
    input.label,
    Math.min(input.contract.max_bytes, MAX_JSON_ARTIFACT_BYTES),
    input.upstream_refs,
    input.parent_ref ?? null,
    input.budget
  );
  try {
    return input.validate(parseCanonicalJson(bytes, input.label));
  } catch (error) {
    if (error instanceof ScaQualificationGateError) throw error;
    fail("artifact_contract_mismatch", `${input.label} failed semantic validation`, {
      cause: error,
    });
  }
}

function assertIdentityClaims(
  claims: ScaImplementationIdentityClaimsV1,
  definition: ScaPhaseQualificationDefinitionV1,
  label: string
): void {
  if (
    claims.tenant_id !== definition.tenant_id ||
    claims.project_id !== definition.project_id ||
    claims.run_id !== definition.run_id ||
    claims.phase_id !== definition.phase_id ||
    claims.implementation_revision !== definition.implementation_revision ||
    claims.assurance_scope !== definition.required_assurance_scope ||
    claims.host_binding_sha256 !== definition.current_host_binding_sha256
  ) {
    fail(
      "qualification_mismatch",
      `${label} does not bind the exact phase identity, revision, assurance scope and host current binding`
    );
  }
  if (
    claims.implementer_identity_id === claims.implementer_lineage_id ||
    !OPAQUE_ID_PATTERN.test(claims.implementer_identity_id) ||
    !OPAQUE_ID_PATTERN.test(claims.implementer_lineage_id) ||
    claims.implementer_identity_id.includes("..") ||
    claims.implementer_lineage_id.includes("..") ||
    UNSAFE_ID_VALUES.has(claims.implementer_identity_id) ||
    UNSAFE_ID_VALUES.has(claims.implementer_lineage_id)
  ) {
    fail("qualification_mismatch", `${label} implementer identity or lineage is invalid`);
  }
}

function subjectUnsigned(
  input: Omit<ScaQualificationSubjectV1, "subject_sha256">
): Omit<ScaQualificationSubjectV1, "subject_sha256"> {
  return input;
}

function inspectSubject(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly budget: ClosureBudget;
}): ScaQualificationSubjectV1 {
  const validatedDefinition = validateDefinition(input.definition);
  input.budget.reserve([
    validatedDefinition.implementation_binding.ref,
    ...validatedDefinition.input_refs,
    ...validatedDefinition.criteria.map((criterion) => criterion.definition_ref),
  ]);
  const identity = readJsonArtifact({
    upstream_refs: validatedDefinition.implementation_binding.upstream_refs,
    parent_ref: validatedDefinition.implementation_binding.parent_ref,
    budget: input.budget,
    store: input.store,
    ref: validatedDefinition.implementation_binding.ref,
    contract: input.definition.implementation_identity_contract,
    label: "implementation identity",
    validate: input.definition.implementation_identity_contract.validate,
  });
  assertIdentityClaims(identity, input.definition, "implementation identity");
  for (const binding of validatedDefinition.input_bindings) {
    readExactBytes(
      input.store,
      binding.ref,
      `qualified input ${binding.ref.artifact_id}`,
      MAX_MATERIAL_ARTIFACT_BYTES,
      binding.upstream_refs,
      binding.parent_ref,
      input.budget
    );
  }
  const criteria = validatedDefinition.criteria.map((criterion) => {
    const trusted = readJsonArtifact({
      store: input.store,
      ref: criterion.definition_ref,
      contract: criterion.definition_contract,
      label: `${criterion.criterion_id} definition`,
      validate: validateScaPhaseCriterionDefinitionV1,
      upstream_refs: [
        validatedDefinition.implementation_binding.ref,
        ...validatedDefinition.input_refs,
      ],
      budget: input.budget,
    });
    if (
      trusted.tenant_id !== input.definition.tenant_id ||
      trusted.project_id !== input.definition.project_id ||
      trusted.run_id !== input.definition.run_id ||
      trusted.phase_id !== input.definition.phase_id ||
      trusted.implementation_revision !== input.definition.implementation_revision ||
      trusted.required_assurance_scope !== input.definition.required_assurance_scope ||
      trusted.criterion_id !== criterion.criterion_id ||
      trusted.required_evidence_class !== criterion.evidence_contract.evidence_class
    ) {
      fail(
        "qualification_mismatch",
        `${criterion.criterion_id} trusted definition is stale or cross-bound`
      );
    }
    return {
      criterion_id: criterion.criterion_id,
      definition_ref: currentArtifactRef(criterion.definition_ref),
      required_evidence_class: trusted.required_evidence_class,
      required_evidence_count: trusted.required_evidence_count,
    };
  });
  const unsigned = subjectUnsigned({
    schema_version: 1,
    tenant_id: input.definition.tenant_id,
    project_id: input.definition.project_id,
    run_id: input.definition.run_id,
    phase_id: input.definition.phase_id,
    implementation_revision: input.definition.implementation_revision,
    implementation_assurance_scope: input.definition.required_assurance_scope,
    implementation_identity_ref: validatedDefinition.implementation_binding.ref,
    qualified_input_refs: validatedDefinition.input_refs,
    implementer_identity_id: identity.implementer_identity_id,
    implementer_lineage_id: identity.implementer_lineage_id,
    criteria,
  });
  return { ...unsigned, subject_sha256: sha256(canonicalJson(unsigned)) };
}

/** Inline subject projection only; this does not verify a persisted qualification or gate. */
export function inspectScaQualificationSubjectV1(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
}): ScaQualificationSubjectV1 {
  return inspectSubject({
    ...input,
    budget: new ClosureBudget(input.definition.max_unique_artifact_bytes),
  });
}

function orderedEvidence(
  values: readonly ScaCriterionEvidenceRefsV1[],
  definition: ScaPhaseQualificationDefinitionV1
): ScaCriterionEvidenceRefsV1[] {
  const ordered = [...values].sort((left, right) =>
    compareUtf8(left.criterion_id, right.criterion_id)
  );
  const expectedIds = orderedCriteria(definition).map((criterion) => criterion.criterion_id);
  const actualIds = ordered.map((criterion) => criterion.criterion_id);
  if (
    new Set(actualIds).size !== actualIds.length ||
    canonicalJson(actualIds) !== canonicalJson(expectedIds)
  ) {
    fail(
      "qualification_mismatch",
      "criterion evidence must cover the exact required criterion set"
    );
  }
  return ordered;
}

function evaluateCriterionEvidence(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly subject: ScaQualificationSubjectV1;
  readonly criterion_evidence: readonly ScaCriterionEvidenceRefsV1[];
  readonly budget: ClosureBudget;
}): readonly ScaPhaseQualificationCriterionV3[] {
  const criteria = orderedCriteria(input.definition);
  const evidence = orderedEvidence(input.criterion_evidence, input.definition);
  input.budget.reserve(evidence.flatMap((entry) => entry.evidence_refs));
  const allEvidenceIds: string[] = [];
  const results = evidence.map((entry, index) => {
    const criterion = criteria[index];
    const subjectCriterion = input.subject.criteria[index];
    if (
      criterion === undefined ||
      subjectCriterion === undefined ||
      criterion.criterion_id !== entry.criterion_id ||
      subjectCriterion.criterion_id !== entry.criterion_id
    ) {
      fail("qualification_mismatch", "criterion evidence ordering is inconsistent");
    }
    const refs = sortedRefs(entry.evidence_refs, `${entry.criterion_id} evidence refs`);
    if (
      refs.length !== subjectCriterion.required_evidence_count ||
      refs.length > MAX_EVIDENCE_REFS_PER_CRITERION
    ) {
      fail(
        "qualification_mismatch",
        `${entry.criterion_id} evidence does not have the exact required cardinality`
      );
    }
    allEvidenceIds.push(...refs.map((ref) => ref.artifact_id));
    const claims = refs.map((ref) =>
      readJsonArtifact({
        store: input.store,
        ref,
        contract: criterion.evidence_contract,
        label: `${entry.criterion_id} evidence ${ref.artifact_id}`,
        validate: criterion.evidence_contract.validate,
        upstream_refs: [
          input.subject.implementation_identity_ref,
          ...input.subject.qualified_input_refs,
          subjectCriterion.definition_ref,
        ],
        budget: input.budget,
      })
    );
    for (const claim of claims) {
      assertIdentityClaims(claim, input.definition, `${entry.criterion_id} evidence`);
      if (
        claim.criterion_id !== entry.criterion_id ||
        claim.subject_sha256 !== input.subject.subject_sha256 ||
        claim.implementer_identity_id !== input.subject.implementer_identity_id ||
        claim.implementer_lineage_id !== input.subject.implementer_lineage_id
      ) {
        fail(
          "qualification_mismatch",
          `${entry.criterion_id} evidence is stale, reused, or cross-bound`
        );
      }
    }
    if (claims.some((claim) => claim.observations.length === 0)) {
      fail("qualification_mismatch", `${entry.criterion_id} has no typed observations`);
    }
    const status = criterion.evidence_contract.evaluate(claims);
    if (status !== "PASS" && status !== "FAIL" && status !== "BLOCKED") {
      fail("qualification_mismatch", `${entry.criterion_id} evaluator returned an invalid status`);
    }
    return {
      criterion_id: entry.criterion_id,
      definition_ref: subjectCriterion.definition_ref,
      evidence_refs: refs,
      evidence_class: criterion.evidence_contract.evidence_class,
      status,
    };
  });
  if (new Set(allEvidenceIds).size !== allEvidenceIds.length) {
    fail("qualification_mismatch", "evidence refs must be distinct across criteria");
  }
  return results;
}

function qualificationCriterionResults(
  criteria: readonly ScaPhaseQualificationCriterionV3[]
): readonly { readonly criterion_id: string; readonly status: ScaQualificationCriterionStatus }[] {
  return criteria.map((criterion) => ({
    criterion_id: criterion.criterion_id,
    status: criterion.status,
  }));
}

function allEvidenceRefs(criteria: readonly ScaPhaseQualificationCriterionV3[]): ArtifactRef[] {
  return sortedRefs(
    criteria.flatMap((criterion) => criterion.evidence_refs),
    "complete qualification evidence refs"
  );
}

function assertReviewIdentity(
  value: ScaPhaseReviewerAuthorityV1 | ScaPhaseReviewReceiptV1,
  definition: ScaPhaseQualificationDefinitionV1,
  subject: ScaQualificationSubjectV1,
  label: string
): void {
  if (
    value.tenant_id !== definition.tenant_id ||
    value.project_id !== definition.project_id ||
    value.run_id !== definition.run_id ||
    value.phase_id !== definition.phase_id ||
    value.implementation_revision !== definition.implementation_revision ||
    value.implementation_assurance_scope !== definition.required_assurance_scope ||
    value.subject_sha256 !== subject.subject_sha256
  ) {
    fail("reviewer_mismatch", `${label} is stale or bound to another qualification subject`);
  }
  const implementerIds = new Set([subject.implementer_identity_id, subject.implementer_lineage_id]);
  if (
    implementerIds.has(value.reviewer_identity_id) ||
    implementerIds.has(value.reviewer_lineage_id) ||
    value.reviewer_identity_id === value.reviewer_lineage_id
  ) {
    fail("reviewer_mismatch", `${label} is not independent from the implementer`);
  }
  if (
    value.reviewer_identity_id !== definition.reviewer_identity_id ||
    value.reviewer_lineage_id !== definition.reviewer_lineage_id
  ) {
    fail("reviewer_mismatch", `${label} is not bound to the host reviewer policy`);
  }
}

function readAndVerifyReview(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly subject: ScaQualificationSubjectV1;
  readonly reviewer_authority_ref: ArtifactRef;
  readonly reviewer_receipt_ref: ArtifactRef;
  readonly criteria: readonly ScaPhaseQualificationCriterionV3[];
  readonly budget: ClosureBudget;
}): {
  readonly authority: ScaPhaseReviewerAuthorityV1;
  readonly receipt: ScaPhaseReviewReceiptV1;
} {
  if (sameRef(input.reviewer_authority_ref, input.reviewer_receipt_ref)) {
    fail("reviewer_mismatch", "reviewer authority and receipt must be distinct artifacts");
  }
  const evidenceRefs = allEvidenceRefs(input.criteria);
  const subjectRefs = [
    input.subject.implementation_identity_ref,
    ...input.subject.qualified_input_refs,
    ...input.subject.criteria.map((criterion) => criterion.definition_ref),
  ];
  input.budget.reserve([...evidenceRefs, input.reviewer_authority_ref, input.reviewer_receipt_ref]);
  const authority = readJsonArtifact({
    upstream_refs: [...subjectRefs, ...evidenceRefs],
    budget: input.budget,
    store: input.store,
    ref: input.reviewer_authority_ref,
    contract: input.definition.reviewer_authority_contract,
    label: "reviewer authority",
    validate: validateScaPhaseReviewerAuthorityV1,
  });
  const receipt = readJsonArtifact({
    upstream_refs: [...subjectRefs, ...evidenceRefs, input.reviewer_authority_ref],
    budget: input.budget,
    store: input.store,
    ref: input.reviewer_receipt_ref,
    contract: input.definition.reviewer_receipt_contract,
    label: "review receipt",
    validate: validateScaPhaseReviewReceiptV1,
  });
  assertReviewIdentity(authority, input.definition, input.subject, "reviewer authority");
  assertReviewIdentity(receipt, input.definition, input.subject, "review receipt");
  const criterionResults = qualificationCriterionResults(input.criteria);
  const expectedDecision = deriveScaQualificationStatus(criterionResults, []);
  if (
    authority.authority_id !== input.definition.reviewer_authority_id ||
    authority.decision !== "authorized" ||
    !sameRefs(authority.evidence_refs, evidenceRefs) ||
    !sameRef(receipt.reviewer_authority_ref, input.reviewer_authority_ref) ||
    receipt.reviewer_identity_id !== authority.reviewer_identity_id ||
    receipt.reviewer_lineage_id !== authority.reviewer_lineage_id ||
    !sameRefs(receipt.evidence_refs, evidenceRefs) ||
    canonicalJson(receipt.criterion_results) !== canonicalJson(criterionResults) ||
    receipt.decision !== expectedDecision ||
    Date.parse(receipt.reviewed_at) < Date.parse(authority.issued_at)
  ) {
    fail(
      "reviewer_mismatch",
      "reviewer authority and receipt do not bind the same subject, evidence, and decision"
    );
  }
  return { authority, receipt };
}

function evaluateQualification(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly criterion_evidence: readonly ScaCriterionEvidenceRefsV1[];
  readonly reviewer_authority_ref: ArtifactRef;
  readonly reviewer_receipt_ref: ArtifactRef;
  readonly remaining_gaps: readonly string[];
  readonly recorded_at: string;
  readonly budget: ClosureBudget;
}): ScaPhaseQualificationRecordV3 {
  validateDefinition(input.definition);
  if (
    input.criterion_evidence.length !== input.definition.criteria.length ||
    input.criterion_evidence.some(
      (entry) =>
        entry.evidence_refs.length < 1 ||
        entry.evidence_refs.length > MAX_EVIDENCE_REFS_PER_CRITERION
    )
  ) {
    fail("qualification_mismatch", "criterion evidence fan-out exceeds the trusted definition");
  }
  input.budget.reserve([
    input.definition.implementation_identity.ref,
    ...input.definition.qualified_inputs.map((binding) => binding.ref),
    ...input.definition.criteria.map((criterion) => criterion.definition_ref),
    ...input.criterion_evidence.flatMap((criterion) => criterion.evidence_refs),
    input.reviewer_authority_ref,
    input.reviewer_receipt_ref,
  ]);
  const subject = inspectSubject({
    store: input.store,
    definition: input.definition,
    budget: input.budget,
  });
  const criteria = evaluateCriterionEvidence({
    store: input.store,
    definition: input.definition,
    subject,
    criterion_evidence: input.criterion_evidence,
    budget: input.budget,
  });
  const review = readAndVerifyReview({
    store: input.store,
    definition: input.definition,
    subject,
    reviewer_authority_ref: input.reviewer_authority_ref,
    reviewer_receipt_ref: input.reviewer_receipt_ref,
    criteria,
    budget: input.budget,
  });
  if (Date.parse(input.recorded_at) < Date.parse(review.receipt.reviewed_at)) {
    fail("qualification_mismatch", "qualification predates its review receipt");
  }
  const remainingGaps = sortedStrings(input.remaining_gaps, "qualification remaining gaps");
  const status = deriveScaQualificationStatus(criteria, remainingGaps);
  return sealScaPhaseQualificationRecordV3({
    schema_id: SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
    schema_version: 3,
    record_kind: "implementation_qualification",
    tenant_id: input.definition.tenant_id,
    project_id: input.definition.project_id,
    run_id: input.definition.run_id,
    phase_id: input.definition.phase_id,
    implementation_revision: input.definition.implementation_revision,
    implementation_assurance_scope: input.definition.required_assurance_scope,
    implementation_identity_ref: subject.implementation_identity_ref,
    qualified_input_refs: [...subject.qualified_input_refs],
    implementer_identity_id: subject.implementer_identity_id,
    implementer_lineage_id: subject.implementer_lineage_id,
    reviewer_authority_ref: currentArtifactRef(input.reviewer_authority_ref),
    reviewer_receipt_ref: currentArtifactRef(input.reviewer_receipt_ref),
    criteria: criteria.map((criterion) => ({
      ...criterion,
      evidence_refs: [...criterion.evidence_refs],
    })),
    remaining_gaps: remainingGaps,
    status,
    recorded_at: input.recorded_at,
  });
}

/** Inline re-derivation only; no persisted qualification record is read here. */
export function evaluateScaPhaseQualificationV3(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly criterion_evidence: readonly ScaCriterionEvidenceRefsV1[];
  readonly reviewer_authority_ref: ArtifactRef;
  readonly reviewer_receipt_ref: ArtifactRef;
  readonly remaining_gaps: readonly string[];
  readonly recorded_at: string;
}): ScaPhaseQualificationRecordV3 {
  return evaluateQualification({
    ...input,
    budget: new ClosureBudget(input.definition.max_unique_artifact_bytes),
  });
}

function verifyQualification(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly qualification: unknown;
  readonly budget: ClosureBudget;
}): ScaPhaseQualificationRecordV3 {
  let qualification: ScaPhaseQualificationRecordV3;
  try {
    qualification = validateScaPhaseQualificationRecordV3(input.qualification);
  } catch (error) {
    fail("qualification_mismatch", "qualification record failed validation", { cause: error });
  }
  const expected = evaluateQualification({
    budget: input.budget,
    store: input.store,
    definition: input.definition,
    criterion_evidence: qualification.criteria.map((criterion) => ({
      criterion_id: criterion.criterion_id,
      evidence_refs: criterion.evidence_refs,
    })),
    reviewer_authority_ref: qualification.reviewer_authority_ref,
    reviewer_receipt_ref: qualification.reviewer_receipt_ref,
    remaining_gaps: qualification.remaining_gaps,
    recorded_at: qualification.recorded_at,
  });
  if (canonicalJson(expected) !== canonicalJson(qualification)) {
    fail(
      "qualification_mismatch",
      "qualification record does not equal the fully re-derived artifact closure"
    );
  }
  return qualification;
}

/** Re-derive an inline record; not a persisted-record custody check. */
export function rederiveInlineScaPhaseQualificationV3(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly qualification: unknown;
}): ScaPhaseQualificationRecordV3 {
  return verifyQualification({
    ...input,
    budget: new ClosureBudget(input.definition.max_unique_artifact_bytes),
  });
}

function assertStoredUpstream(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  refs: readonly ArtifactRef[]
): void {
  try {
    if (!sameRefs(store.metadata(ref).upstream_refs, sortedRefs(refs, "persisted upstream refs"))) {
      fail("artifact_contract_mismatch", "persisted provenance does not match exact closure");
    }
  } catch (error) {
    if (error instanceof ScaQualificationGateError) throw error;
    fail("artifact_contract_mismatch", "persisted provenance is unavailable", { cause: error });
  }
}

function qualificationUpstream(qualification: ScaPhaseQualificationRecordV3): ArtifactRef[] {
  return [
    qualification.implementation_identity_ref,
    ...qualification.qualified_input_refs,
    ...qualification.criteria.map((criterion) => criterion.definition_ref),
    ...qualification.criteria.flatMap((criterion) => criterion.evidence_refs),
    qualification.reviewer_authority_ref,
    qualification.reviewer_receipt_ref,
  ];
}

function readQualificationRecord(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly ref: ArtifactRef;
  readonly budget: ClosureBudget;
}): ScaPhaseQualificationRecordV3 {
  const qualification = readJsonArtifact({
    store: input.store,
    ref: input.ref,
    contract: input.definition.qualification_record_contract,
    label: "phase qualification record",
    validate: validateScaPhaseQualificationRecordV3,
    upstream_refs: null, // checked against the parsed record immediately below, before re-derivation
    budget: input.budget,
  });
  input.budget.reserve(qualificationUpstream(qualification));
  assertStoredUpstream(input.store, input.ref, qualificationUpstream(qualification));
  return qualification;
}

function evaluateGate(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly qualification_ref: ArtifactRef;
  readonly evaluated_at: string;
  readonly budget: ClosureBudget;
}): ScaPhaseGateRecordV3 {
  input.budget.reserve([input.qualification_ref]);
  const qualification = verifyQualification({
    budget: input.budget,
    store: input.store,
    definition: input.definition,
    qualification: readQualificationRecord({
      store: input.store,
      definition: input.definition,
      ref: input.qualification_ref,
      budget: input.budget,
    }),
  });
  if (Date.parse(input.evaluated_at) < Date.parse(qualification.recorded_at)) {
    fail("qualification_mismatch", "phase gate predates its qualification");
  }
  const criterionResults = qualificationCriterionResults(qualification.criteria);
  return sealScaPhaseGateRecordV3({
    schema_id: SCA_PHASE_GATE_RECORD_V3_SCHEMA,
    schema_version: 3,
    tenant_id: qualification.tenant_id,
    project_id: qualification.project_id,
    run_id: qualification.run_id,
    phase_id: qualification.phase_id,
    implementation_revision: qualification.implementation_revision,
    implementation_assurance_scope: qualification.implementation_assurance_scope,
    implementation_identity_ref: qualification.implementation_identity_ref,
    qualified_input_refs: [...qualification.qualified_input_refs],
    qualification_ref: currentArtifactRef(input.qualification_ref),
    reviewer_authority_ref: qualification.reviewer_authority_ref,
    reviewer_receipt_ref: qualification.reviewer_receipt_ref,
    criterion_results: criterionResults.map((result) => ({ ...result })),
    remaining_gaps: [...qualification.remaining_gaps],
    status: qualification.status === "PASS" ? "passed" : "blocked",
    evaluated_at: input.evaluated_at,
  });
}

/** Read a persisted qualification and re-derive an inline gate; no gate custody check. */
export function evaluateScaPhaseGateV3(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly qualification_ref: ArtifactRef;
  readonly evaluated_at: string;
}): ScaPhaseGateRecordV3 {
  return evaluateGate({
    ...input,
    budget: new ClosureBudget(input.definition.max_unique_artifact_bytes),
  });
}

export function verifyScaPhaseGateV3(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly gate_ref: ArtifactRef;
}): ScaPhaseGateRecordV3 {
  validateDefinition(input.definition);
  const budget = new ClosureBudget(input.definition.max_unique_artifact_bytes);
  budget.reserve([input.gate_ref]);
  const gate = readJsonArtifact({
    upstream_refs: null,
    budget,
    store: input.store,
    ref: input.gate_ref,
    contract: input.definition.gate_record_contract,
    label: "phase gate record",
    validate: validateScaPhaseGateRecordV3,
  });
  budget.reserve([gate.qualification_ref]);
  assertStoredUpstream(input.store, input.gate_ref, [gate.qualification_ref]);
  const expected = evaluateGate({
    budget,
    store: input.store,
    definition: input.definition,
    qualification_ref: gate.qualification_ref,
    evaluated_at: gate.evaluated_at,
  });
  if (canonicalJson(expected) !== canonicalJson(gate)) {
    fail("qualification_mismatch", "phase gate does not equal its fully re-derived qualification");
  }
  return gate;
}

export function requireScaPhaseGatePassV3(input: {
  readonly store: ArtifactHostStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly gate_ref: ArtifactRef;
}): ScaPhaseGateRecordV3 {
  const gate = verifyScaPhaseGateV3(input);
  if (gate.status !== "passed") {
    fail("gate_blocked", "phase gate is not passed");
  }
  return gate;
}
