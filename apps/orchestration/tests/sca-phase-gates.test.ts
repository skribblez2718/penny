import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type, type Static } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore, currentArtifactRef } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  validateContract,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../dist/contracts.js";
import { PLAYBOOK_REGISTRY } from "../dist/playbooks/registry.js";
import {
  SCA_P01_QUALIFICATION_VARIANT_IDS,
  SCA_P01_REQUIRED_CRITERION_IDS,
  SCA_PHASE_GATE_RECORD_V2_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
  validateScaPhaseGateRecordV2,
  validateScaPhaseQualificationRecordV2,
  type ScaPhaseGateRecordV2,
  type ScaPhaseQualificationRecordV2,
} from "../dist/sca/p01-contracts.js";
import {
  inspectLegacyScaP01GateRecordRelationshipV2,
  inspectLegacyScaP01QualificationV2,
} from "../dist/sca/qualification-gate-p01-compat.js";
import {
  SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
  SCA_PHASE_GATE_RECORD_V3_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
  SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
  ScaImplementationAssuranceScopeSchema,
  ScaQualificationCriterionStatusSchema,
  sealScaPhaseCriterionDefinitionV1,
  sealScaPhaseReviewReceiptV1,
  sealScaPhaseReviewerAuthorityV1,
  validateScaPhaseQualificationRecordV3,
  type ScaPhaseQualificationRecordV3,
} from "../dist/sca/qualification-gate-contracts.js";
import {
  evaluateScaPhaseGateV3,
  evaluateScaPhaseQualificationV3,
  inspectScaQualificationSubjectV1,
  requireScaPhaseGatePassV3,
  rederiveInlineScaPhaseQualificationV3,
  type ScaArtifactBindingV1,
  type ScaArtifactContractV1,
  type ScaCriterionEvidenceClaimsV1,
  type ScaCriterionEvidenceContractV1,
  type ScaImplementationIdentityClaimsV1,
  type ScaPhaseQualificationDefinitionV1,
  type ScaValidatedJsonArtifactContractV1,
} from "../dist/sca/qualification-gate.js";

const TENANT_ID = "tenant-sca-phase-gate";
const PROJECT_ID = "project-sca-phase-gate";
const STORE_PROJECT_ID = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN_ID = "run-sca-phase-gate";
const PHASE_ID = "SCA-P02";
const IMPLEMENTATION_REVISION = "implementation-r1";
const HOST_BINDING = sha256("host current implementation revision");
const REVIEWER_AUTHORITY = "review-authority-trusted";
const IMPLEMENTER_IDENTITY = "implementer-phase-gate";
const IMPLEMENTER_LINEAGE = "lineage-phase-gate";
const REVIEWER_IDENTITY = "reviewer-independent";
const REVIEWER_LINEAGE = "lineage-reviewer-independent";
const ISSUED_AT = "2026-09-22T10:00:00Z";
const REVIEWED_AT = "2026-09-22T10:01:00Z";
const RECORDED_AT = "2026-09-22T10:02:00Z";
const EVALUATED_AT = "2026-09-22T10:03:00Z";
const JSON_MEDIA_TYPE = "application/json";
const MAX_BYTES = 1_048_576;
const CRITERION_IDS = ["AC-T01.artifact-integrity", "AC-T02.independent-review"] as const;

const ImplementationIdentitySchema = Type.Object(
  {
    schema_id: Type.Literal("penny.test-sca-implementation-identity.v1"),
    schema_version: Type.Literal(1),
    tenant_id: Type.String(),
    project_id: Type.String(),
    run_id: Type.String(),
    phase_id: Type.String(),
    implementation_revision: Type.String(),
    assurance_scope: ScaImplementationAssuranceScopeSchema,
    implementer_identity_id: Type.String(),
    implementer_lineage_id: Type.String(),
    host_binding_sha256: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false }
);
type TestImplementationIdentity = Static<typeof ImplementationIdentitySchema>;

const CriterionEvidenceSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.test-sca-live-evidence.v1"),
    schema_version: Type.Literal(1),
    tenant_id: Type.String(),
    project_id: Type.String(),
    run_id: Type.String(),
    phase_id: Type.String(),
    implementation_revision: Type.String(),
    assurance_scope: ScaImplementationAssuranceScopeSchema,
    implementer_identity_id: Type.String(),
    implementer_lineage_id: Type.String(),
    host_binding_sha256: Type.Union([Type.String(), Type.Null()]),
    criterion_id: Type.String(),
    subject_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    reported_status: ScaQualificationCriterionStatusSchema,
    observed: Type.Union([Type.Boolean(), Type.Null()]),
    capture_mode: Type.Literal("live-observed"),
  },
  { additionalProperties: false }
);
type TestCriterionEvidence = Static<typeof CriterionEvidenceSchema>;

const roots: string[] = [];
const stores: ArtifactStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function first<Value>(values: readonly Value[], label: string): Value {
  const value = values[0];
  if (value === undefined) throw new Error(`${label} is empty`);
  return value;
}

function temporaryStore(label: string): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), `penny-sca-phase-gate-${label}-`));
  roots.push(root);
  const store = new ArtifactStore(path.join(root, "artifacts"), { projectId: STORE_PROJECT_ID });
  stores.push(store);
  return store;
}

function sortRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((left, right) =>
    Buffer.compare(Buffer.from(left.artifact_id, "utf8"), Buffer.from(right.artifact_id, "utf8"))
  );
}

function metadata(input: {
  readonly runId?: string;
  readonly kind: string;
  readonly operationId: string;
  readonly producer: string;
  readonly schemaId?: string;
  readonly schemaVersion?: number;
  readonly mediaType?: string;
  readonly upstreamRefs?: readonly ArtifactRef[];
  readonly parentRef?: ArtifactRef | null;
  readonly version?: number;
}): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: input.runId ?? RUN_ID,
    phase: "sca-phase-qualification-test",
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: input.version ?? 1,
    producer: input.producer,
    media_type: input.mediaType ?? JSON_MEDIA_TYPE,
    ...(input.schemaId === undefined
      ? {}
      : {
          content_schema: {
            schema_id: input.schemaId,
            schema_version: input.schemaVersion ?? 1,
          },
        }),
    parent_ref: input.parentRef ?? null,
    upstream_refs: sortRefs(input.upstreamRefs ?? []),
  };
}

function persistJson(
  store: ArtifactStore,
  input: Parameters<typeof metadata>[0] & { readonly value: unknown }
): ArtifactRef {
  return store.persist({
    metadata: metadata(input),
    content: canonicalJson(input.value),
  });
}

function persistMaterial(
  store: ArtifactStore,
  operationId: string,
  content: string,
  options: { readonly parentRef?: ArtifactRef; readonly upstreamRefs?: readonly ArtifactRef[] } = {}
): ArtifactRef {
  return store.persist({
    metadata: metadata({
      kind: "sca-qualified-input",
      operationId,
      producer: "host:test-input-custody",
      mediaType: "application/octet-stream",
      version: options.parentRef === undefined ? 1 : 2,
      ...(options.parentRef === undefined ? {} : { parentRef: options.parentRef }),
      ...(options.upstreamRefs === undefined ? {} : { upstreamRefs: options.upstreamRefs }),
    }),
    content,
  });
}

function artifactContract(input: {
  readonly artifactKind: string;
  readonly schemaId: string;
  readonly schemaVersion?: number;
  readonly producer: string;
  readonly mediaType?: string;
}): ScaArtifactContractV1 {
  return {
    artifact_kind: input.artifactKind,
    schema_id: input.schemaId,
    schema_version: input.schemaVersion ?? 1,
    producer: input.producer,
    media_type: input.mediaType ?? JSON_MEDIA_TYPE,
    max_bytes: MAX_BYTES,
  };
}

function implementationClaims(value: unknown): ScaImplementationIdentityClaimsV1 {
  const identity = validateContract(
    ImplementationIdentitySchema,
    value,
    "test implementation identity"
  );
  return {
    tenant_id: identity.tenant_id,
    project_id: identity.project_id,
    run_id: identity.run_id,
    phase_id: identity.phase_id,
    implementation_revision: identity.implementation_revision,
    assurance_scope: identity.assurance_scope,
    implementer_identity_id: identity.implementer_identity_id,
    implementer_lineage_id: identity.implementer_lineage_id,
    host_binding_sha256: identity.host_binding_sha256,
  };
}

function evidenceClaims(value: unknown): ScaCriterionEvidenceClaimsV1 {
  const evidence = validateContract(CriterionEvidenceSchema, value, "test criterion evidence");
  return {
    tenant_id: evidence.tenant_id,
    project_id: evidence.project_id,
    run_id: evidence.run_id,
    phase_id: evidence.phase_id,
    implementation_revision: evidence.implementation_revision,
    assurance_scope: evidence.assurance_scope,
    implementer_identity_id: evidence.implementer_identity_id,
    implementer_lineage_id: evidence.implementer_lineage_id,
    criterion_id: evidence.criterion_id,
    subject_sha256: evidence.subject_sha256,
    host_binding_sha256: evidence.host_binding_sha256,
    observations: [{ check_id: "host-verified-check", observed: evidence.observed }],
  };
}

function implementationContract(): ScaValidatedJsonArtifactContractV1<ScaImplementationIdentityClaimsV1> {
  return {
    ...artifactContract({
      artifactKind: "sca-implementation-identity",
      schemaId: "penny.test-sca-implementation-identity.v1",
      producer: "host:test-implementation-authority",
    }),
    validate: implementationClaims,
  };
}

function liveEvidenceContract(): ScaCriterionEvidenceContractV1 {
  return {
    ...artifactContract({
      artifactKind: "sca-live-qualification-evidence",
      schemaId: "penny.test-sca-live-evidence.v1",
      producer: "host:test-live-evidence-authority",
    }),
    evidence_class: "live",
    validate: evidenceClaims,
    evaluate: (claims) =>
      claims.some((claim) => claim.observations.some((o) => o.observed === false))
        ? "FAIL"
        : claims.some((claim) => claim.observations.some((o) => o.observed === null))
          ? "BLOCKED"
          : "PASS",
  };
}

function frameworkContracts() {
  return {
    reviewerAuthority: artifactContract({
      artifactKind: "sca-phase-reviewer-authority",
      schemaId: SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
      producer: "host:test-review-authority",
    }),
    reviewerReceipt: artifactContract({
      artifactKind: "sca-phase-review-receipt",
      schemaId: SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
      producer: "host:test-review-authority",
    }),
    qualification: artifactContract({
      artifactKind: "sca-phase-qualification-v3",
      schemaId: SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
      schemaVersion: 3,
      producer: "host:test-qualification-authority",
    }),
    gate: artifactContract({
      artifactKind: "sca-phase-gate-v3",
      schemaId: SCA_PHASE_GATE_RECORD_V3_SCHEMA,
      schemaVersion: 3,
      producer: "host:test-qualification-authority",
    }),
  };
}

interface TestMaterial {
  readonly store: ArtifactStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly subjectSha256: string;
  readonly evidenceRefs: readonly ArtifactRef[];
  readonly criterionEvidence: readonly {
    readonly criterion_id: string;
    readonly evidence_refs: readonly ArtifactRef[];
  }[];
  readonly reviewerAuthorityRef: ArtifactRef;
  readonly reviewerReceiptRef: ArtifactRef;
  readonly qualification: ScaPhaseQualificationRecordV3;
  readonly qualificationRef: ArtifactRef;
  readonly gateRef: ArtifactRef;
}

function subjectRefs(definition: ScaPhaseQualificationDefinitionV1): ArtifactRef[] {
  return [
    definition.implementation_identity.ref,
    ...definition.qualified_inputs.map((binding) => binding.ref),
    ...definition.criteria.map((criterion) => criterion.definition_ref),
  ];
}

function bindStored(store: ArtifactStore, ref: ArtifactRef): ScaArtifactBindingV1 {
  const stored = store.metadata(ref);
  return { ref, parent_ref: stored.parent_ref, upstream_refs: stored.upstream_refs };
}

function persistReview(input: {
  readonly material: Pick<TestMaterial, "store" | "definition" | "subjectSha256" | "evidenceRefs">;
  readonly operationSuffix: string;
  readonly authorityId?: string;
  readonly criterionStatus?: "PASS" | "FAIL" | "BLOCKED";
  readonly reviewerIdentity?: string;
  readonly reviewerLineage?: string;
  readonly authoritySubjectSha256?: string;
  readonly receiptSubjectSha256?: string;
}): { readonly authorityRef: ArtifactRef; readonly receiptRef: ArtifactRef } {
  const reviewerIdentity = input.reviewerIdentity ?? REVIEWER_IDENTITY;
  const reviewerLineage = input.reviewerLineage ?? REVIEWER_LINEAGE;
  const criterionResults = CRITERION_IDS.map((criterion_id) => ({
    criterion_id,
    status: input.criterionStatus ?? ("PASS" as const),
  }));
  const authority = sealScaPhaseReviewerAuthorityV1({
    schema_id: SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
    schema_version: 1,
    authority_id: input.authorityId ?? REVIEWER_AUTHORITY,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    run_id: RUN_ID,
    phase_id: PHASE_ID,
    implementation_revision: IMPLEMENTATION_REVISION,
    implementation_assurance_scope: input.material.definition.required_assurance_scope,
    reviewer_identity_id: reviewerIdentity,
    reviewer_lineage_id: reviewerLineage,
    subject_sha256: input.authoritySubjectSha256 ?? input.material.subjectSha256,
    evidence_refs: [...input.material.evidenceRefs],
    decision: "authorized",
    issued_at: ISSUED_AT,
  });
  const authorityRef = persistJson(input.material.store, {
    kind: input.material.definition.reviewer_authority_contract.artifact_kind,
    operationId: `review-authority-${input.operationSuffix}`,
    producer: input.material.definition.reviewer_authority_contract.producer,
    schemaId: input.material.definition.reviewer_authority_contract.schema_id,
    value: authority,
    upstreamRefs: [...subjectRefs(input.material.definition), ...input.material.evidenceRefs],
  });
  const receipt = sealScaPhaseReviewReceiptV1({
    schema_id: SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
    schema_version: 1,
    receipt_id: `review-receipt-${input.operationSuffix}`,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    run_id: RUN_ID,
    phase_id: PHASE_ID,
    implementation_revision: IMPLEMENTATION_REVISION,
    implementation_assurance_scope: input.material.definition.required_assurance_scope,
    reviewer_authority_ref: authorityRef,
    reviewer_identity_id: reviewerIdentity,
    reviewer_lineage_id: reviewerLineage,
    subject_sha256: input.receiptSubjectSha256 ?? input.material.subjectSha256,
    evidence_refs: [...input.material.evidenceRefs],
    criterion_results: criterionResults,
    decision: input.criterionStatus ?? "PASS",
    reviewed_at: REVIEWED_AT,
  });
  const receiptRef = persistJson(input.material.store, {
    kind: input.material.definition.reviewer_receipt_contract.artifact_kind,
    operationId: `review-receipt-${input.operationSuffix}`,
    producer: input.material.definition.reviewer_receipt_contract.producer,
    schemaId: input.material.definition.reviewer_receipt_contract.schema_id,
    value: receipt,
    upstreamRefs: [
      authorityRef,
      ...subjectRefs(input.material.definition),
      ...input.material.evidenceRefs,
    ],
  });
  return { authorityRef, receiptRef };
}

function buildMaterial(
  label: string,
  options: {
    readonly observed?: boolean | null;
    readonly gaps?: readonly string[];
    readonly reportedStatus?: "PASS" | "FAIL" | "BLOCKED";
    readonly versionedInput?: boolean;
  } = {}
): TestMaterial {
  const store = temporaryStore(label);
  const upstreamRef = options.versionedInput
    ? persistMaterial(store, "predecessor-input", "predecessor custody")
    : undefined;
  const implementation: TestImplementationIdentity = {
    schema_id: "penny.test-sca-implementation-identity.v1",
    schema_version: 1,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    run_id: RUN_ID,
    phase_id: PHASE_ID,
    implementation_revision: IMPLEMENTATION_REVISION,
    assurance_scope: "host_derived_binding",
    implementer_identity_id: IMPLEMENTER_IDENTITY,
    implementer_lineage_id: IMPLEMENTER_LINEAGE,
    host_binding_sha256: HOST_BINDING,
  };
  const implementationRef = persistJson(store, {
    kind: "sca-implementation-identity",
    operationId: "implementation-identity",
    producer: "host:test-implementation-authority",
    schemaId: implementation.schema_id,
    value: implementation,
    upstreamRefs: upstreamRef === undefined ? [] : [upstreamRef],
  });
  const firstInputRef = persistMaterial(store, "qualified-input", "exact qualified input bytes", {
    upstreamRefs: upstreamRef === undefined ? [] : [upstreamRef],
  });
  const qualifiedInputRef = options.versionedInput
    ? persistMaterial(store, "qualified-input", "revised qualified input bytes", {
        parentRef: firstInputRef,
        upstreamRefs: [firstInputRef, upstreamRef].filter(
          (ref): ref is ArtifactRef => ref !== undefined
        ),
      })
    : firstInputRef;
  const criterionBindings = CRITERION_IDS.map((criterionId, index) => {
    const criterion = sealScaPhaseCriterionDefinitionV1({
      schema_id: SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
      schema_version: 1,
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      run_id: RUN_ID,
      phase_id: PHASE_ID,
      implementation_revision: IMPLEMENTATION_REVISION,
      required_assurance_scope: "host_derived_binding",
      criterion_id: criterionId,
      required_evidence_class: "live",
      required_evidence_count: 1,
    });
    const definitionRef = persistJson(store, {
      kind: "sca-phase-criterion-definition",
      operationId: `criterion-definition-${String(index + 1)}`,
      producer: "host:test-criterion-authority",
      schemaId: SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
      value: criterion,
      upstreamRefs: [implementationRef, qualifiedInputRef],
    });
    return {
      criterion_id: criterionId,
      definition_ref: definitionRef,
      definition_contract: artifactContract({
        artifactKind: "sca-phase-criterion-definition",
        schemaId: SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
        producer: "host:test-criterion-authority",
      }),
      evidence_contract: liveEvidenceContract(),
    };
  });
  const contracts = frameworkContracts();
  const definition: ScaPhaseQualificationDefinitionV1 = {
    schema_version: 1,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    run_id: RUN_ID,
    phase_id: PHASE_ID,
    implementation_revision: IMPLEMENTATION_REVISION,
    required_assurance_scope: "host_derived_binding",
    current_host_binding_sha256: HOST_BINDING,
    max_unique_artifact_bytes: 16 * 1_048_576,
    reviewer_authority_id: REVIEWER_AUTHORITY,
    reviewer_identity_id: REVIEWER_IDENTITY,
    reviewer_lineage_id: REVIEWER_LINEAGE,
    implementation_identity: bindStored(store, implementationRef),
    implementation_identity_contract: implementationContract(),
    qualified_inputs: [bindStored(store, qualifiedInputRef)],
    criteria: criterionBindings,
    reviewer_authority_contract: contracts.reviewerAuthority,
    reviewer_receipt_contract: contracts.reviewerReceipt,
    qualification_record_contract: contracts.qualification,
    gate_record_contract: contracts.gate,
  };
  const subject = inspectScaQualificationSubjectV1({ store, definition });
  const criterionEvidence = CRITERION_IDS.map((criterionId, index) => {
    const evidence: TestCriterionEvidence = {
      schema_id: "penny.test-sca-live-evidence.v1",
      schema_version: 1,
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      run_id: RUN_ID,
      phase_id: PHASE_ID,
      implementation_revision: IMPLEMENTATION_REVISION,
      assurance_scope: "host_derived_binding",
      implementer_identity_id: IMPLEMENTER_IDENTITY,
      implementer_lineage_id: IMPLEMENTER_LINEAGE,
      host_binding_sha256: HOST_BINDING,
      criterion_id: criterionId,
      subject_sha256: subject.subject_sha256,
      reported_status: options.reportedStatus ?? "PASS",
      observed: options.observed === undefined ? true : options.observed,
      capture_mode: "live-observed",
    };
    const evidenceRef = persistJson(store, {
      kind: "sca-live-qualification-evidence",
      operationId: `criterion-evidence-${String(index + 1)}`,
      producer: "host:test-live-evidence-authority",
      schemaId: evidence.schema_id,
      value: evidence,
      upstreamRefs: [
        implementationRef,
        qualifiedInputRef,
        criterionBindings[index]?.definition_ref,
      ].filter((ref): ref is ArtifactRef => ref !== undefined),
    });
    return { criterion_id: criterionId, evidence_refs: [evidenceRef] };
  });
  const evidenceRefs = sortRefs(criterionEvidence.flatMap((entry) => entry.evidence_refs));
  const review = persistReview({
    material: { store, definition, subjectSha256: subject.subject_sha256, evidenceRefs },
    operationSuffix: "valid",
    criterionStatus:
      options.observed === false ? "FAIL" : options.observed === null ? "BLOCKED" : "PASS",
  });
  const qualification = evaluateScaPhaseQualificationV3({
    store,
    definition,
    criterion_evidence: criterionEvidence,
    reviewer_authority_ref: review.authorityRef,
    reviewer_receipt_ref: review.receiptRef,
    remaining_gaps: options.gaps ?? [],
    recorded_at: RECORDED_AT,
  });
  const qualificationRef = persistJson(store, {
    kind: definition.qualification_record_contract.artifact_kind,
    operationId: "phase-qualification",
    producer: definition.qualification_record_contract.producer,
    schemaId: definition.qualification_record_contract.schema_id,
    schemaVersion: definition.qualification_record_contract.schema_version,
    value: qualification,
    upstreamRefs: [
      ...subjectRefs(definition),
      ...evidenceRefs,
      review.authorityRef,
      review.receiptRef,
    ],
  });
  const gate = evaluateScaPhaseGateV3({
    store,
    definition,
    qualification_ref: qualificationRef,
    evaluated_at: EVALUATED_AT,
  });
  const gateRef = persistJson(store, {
    kind: definition.gate_record_contract.artifact_kind,
    operationId: "phase-gate",
    producer: definition.gate_record_contract.producer,
    schemaId: definition.gate_record_contract.schema_id,
    schemaVersion: definition.gate_record_contract.schema_version,
    value: gate,
    upstreamRefs: [qualificationRef],
  });
  return {
    store,
    definition,
    subjectSha256: subject.subject_sha256,
    evidenceRefs,
    criterionEvidence,
    reviewerAuthorityRef: review.authorityRef,
    reviewerReceiptRef: review.receiptRef,
    qualification,
    qualificationRef,
    gateRef,
  };
}

function resealQualification(
  record: ScaPhaseQualificationRecordV3,
  changes: Partial<ScaPhaseQualificationRecordV3>
): unknown {
  const { qualification_sha256: _discarded, ...unsigned } = { ...record, ...changes };
  return {
    ...unsigned,
    qualification_sha256: sha256(canonicalJson(unsigned)),
  };
}

function objectPath(store: ArtifactStore, ref: ArtifactRef): string {
  return path.join(
    store.root,
    "objects",
    "sha256",
    ref.content_digest.slice(0, 2),
    ref.content_digest.slice(2)
  );
}

function syntheticRef(input: {
  readonly runId: string;
  readonly operationId: string;
  readonly kind: string;
  readonly schemaId: string;
}): ArtifactRef {
  const identity = {
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    phase: "SCA-P01",
    run_id: input.runId,
    version: 1,
  };
  const digest = sha256(`bytes:${input.runId}:${input.operationId}`);
  return currentArtifactRef({
    schema_version: 2,
    artifact_id: `art_${sha256(canonicalJson(identity))}`,
    run_id: input.runId,
    phase: "SCA-P01",
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: "host:p01-golden",
    media_type: JSON_MEDIA_TYPE,
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    byte_length: 1,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  });
}

function legacyP01Golden(): {
  readonly qualification: ScaPhaseQualificationRecordV2;
  readonly qualificationRef: ArtifactRef;
  readonly gate: ScaPhaseGateRecordV2;
} {
  const qualificationRun = "run-p01-qualification-golden";
  const campaignRun = "run-p01-campaign-golden";
  const commonRef = (operationId: string, kind = "sca-p01-input") =>
    syntheticRef({
      runId: qualificationRun,
      operationId,
      kind,
      schemaId: "penny.test-p01-golden.v1",
    });
  const qualification = validateScaPhaseQualificationRecordV2({
    schema_id: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
    schema_version: 2,
    record_kind: "implementation_qualification",
    tenant_id: "tenant-p01-golden",
    project_id: "project-p01-golden",
    run_id: qualificationRun,
    phase_id: "SCA-P01",
    implementation_revision: "p01-golden-r1",
    qualification_profile_ref: commonRef("qualification-profile"),
    source_snapshot_ref: commonRef("source-snapshot"),
    implementation_ref: commonRef("implementation"),
    implementer_identity_id: "implementer-p01-golden",
    implementer_lineage_id: "lineage-p01-golden",
    reviewer_authority_ref: commonRef("reviewer-authority"),
    reviewer_receipt_ref: commonRef("reviewer-receipt"),
    criteria: SCA_P01_REQUIRED_CRITERION_IDS.map((criterionId, criterionIndex) => ({
      criterion_id: criterionId,
      status: "PASS",
      variants: SCA_P01_QUALIFICATION_VARIANT_IDS.map((variantId, variantIndex) => ({
        variant_id: variantId,
        fixture_ref: commonRef(
          `fixture-${String(criterionIndex + 1)}-${String(variantIndex + 1)}`,
          "sca-qualification-fixture"
        ),
        evidence_ref: commonRef(
          `evidence-${String(criterionIndex + 1)}-${String(variantIndex + 1)}`,
          "sca-qualification-evidence"
        ),
        applicability: "applicable",
        status: "PASS",
      })),
    })),
    remaining_gaps: [],
    status: "PASS",
    recorded_at: RECORDED_AT,
  });
  const qualificationRef = syntheticRef({
    runId: qualificationRun,
    operationId: "qualification-record",
    kind: "sca-phase-qualification",
    schemaId: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
  });
  const campaignRef = (operationId: string, kind: string) =>
    syntheticRef({
      runId: campaignRun,
      operationId,
      kind,
      schemaId: "penny.test-p01-campaign.v1",
    });
  const gate = validateScaPhaseGateRecordV2({
    schema_id: SCA_PHASE_GATE_RECORD_V2_SCHEMA,
    schema_version: 2,
    tenant_id: qualification.tenant_id,
    project_id: qualification.project_id,
    run_id: campaignRun,
    phase_id: "SCA-P01",
    implementation_revision: qualification.implementation_revision,
    request_ref: campaignRef("request", "sca-admission-request"),
    obligation_ledger_ref: campaignRef("ledger", "sca-obligation-ledger"),
    manifest_core_ref: campaignRef("manifest-core", "sca-campaign-manifest-core"),
    qualification_ref: qualificationRef,
    admission_evidence_ref: campaignRef("admission-evidence", "sca-p01-admission-evidence"),
    criterion_results: SCA_P01_REQUIRED_CRITERION_IDS.map((criterion_id) => ({
      criterion_id,
      status: "PASS",
    })),
    status: "passed",
    evaluated_at: EVALUATED_AT,
  });
  return { qualification, qualificationRef, gate };
}

describe("common SCA qualification and phase gate", () => {
  it("derives a passed qualification and gate from exact live evidence", () => {
    const material = buildMaterial("happy");
    expect(material.qualification).toMatchObject({
      status: "PASS",
      implementation_assurance_scope: "host_derived_binding",
      remaining_gaps: [],
    });
    expect(material.qualification.qualification_sha256).toBe(
      sha256(
        canonicalJson(
          Object.fromEntries(
            Object.entries(material.qualification).filter(([key]) => key !== "qualification_sha256")
          )
        )
      )
    );
    expect(
      requireScaPhaseGatePassV3({
        store: material.store,
        definition: material.definition,
        gate_ref: material.gateRef,
      }).status
    ).toBe("passed");
  });

  it("accepts host-bound predecessor upstreams and a version-2 qualified input with its exact parent", () => {
    const material = buildMaterial("versioned-input", { versionedInput: true });
    const input = first(material.definition.qualified_inputs, "qualified inputs");
    expect(input.ref.version).toBe(2);
    expect(input.parent_ref?.version).toBe(1);
    expect(input.upstream_refs).toHaveLength(2);
    expect(material.definition.implementation_identity.upstream_refs).toHaveLength(1);
    expect(
      requireScaPhaseGatePassV3({
        store: material.store,
        definition: material.definition,
        gate_ref: material.gateRef,
      }).status
    ).toBe("passed");
  });

  it("denies stale parent and upstream bindings for predecessor inputs", () => {
    const material = buildMaterial("stale-input-bindings", { versionedInput: true });
    const input = first(material.definition.qualified_inputs, "qualified inputs");
    expect(() =>
      inspectScaQualificationSubjectV1({
        store: material.store,
        definition: {
          ...material.definition,
          qualified_inputs: [{ ...input, parent_ref: null }],
        },
      })
    ).toThrow(/parent does not match its revision/u);
    expect(() =>
      inspectScaQualificationSubjectV1({
        store: material.store,
        definition: {
          ...material.definition,
          qualified_inputs: [
            { ...input, upstream_refs: [first(input.upstream_refs, "upstreams")] },
          ],
        },
      })
    ).toThrow(/persisted provenance/u);
    expect(() =>
      inspectScaQualificationSubjectV1({
        store: material.store,
        definition: {
          ...material.definition,
          implementation_identity: {
            ...material.definition.implementation_identity,
            upstream_refs: [],
          },
        },
      })
    ).toThrow(/persisted provenance/u);
  });

  it("rejects malformed and cross-bound evidence lineage", () => {
    const material = buildMaterial("cross-bound");
    const original = first(material.criterionEvidence, "criterion evidence");
    const evidenceRef = first(original.evidence_refs, "criterion evidence refs");
    const parsed = validateContract(
      CriterionEvidenceSchema,
      JSON.parse(material.store.readById(evidenceRef.artifact_id).toString("utf8")),
      "stored evidence"
    );
    const crossBoundRef = persistJson(material.store, {
      kind: "sca-live-qualification-evidence",
      operationId: "cross-bound-evidence",
      producer: "host:test-live-evidence-authority",
      schemaId: parsed.schema_id,
      value: { ...parsed, run_id: "run-other-lineage" },
    });
    const malformedRef = persistJson(material.store, {
      kind: "sca-live-qualification-evidence",
      operationId: "malformed-evidence",
      producer: "host:test-live-evidence-authority",
      schemaId: parsed.schema_id,
      value: { schema_id: parsed.schema_id, schema_version: 1 },
    });
    const rest = material.criterionEvidence.slice(1);
    for (const replacement of [crossBoundRef, malformedRef]) {
      expect(() =>
        evaluateScaPhaseQualificationV3({
          store: material.store,
          definition: material.definition,
          criterion_evidence: [
            { criterion_id: original.criterion_id, evidence_refs: [replacement] },
            ...rest,
          ],
          reviewer_authority_ref: material.reviewerAuthorityRef,
          reviewer_receipt_ref: material.reviewerReceiptRef,
          remaining_gaps: [],
          recorded_at: RECORDED_AT,
        })
      ).toThrow();
    }
  });

  it("rejects altered immutable artifact bytes", () => {
    const material = buildMaterial("altered-bytes");
    const evidenceRef = first(material.evidenceRefs, "evidence refs");
    writeFileSync(objectPath(material.store, evidenceRef), "altered", { mode: 0o600 });
    expect(() =>
      requireScaPhaseGatePassV3({
        store: material.store,
        definition: material.definition,
        gate_ref: material.gateRef,
      })
    ).toThrow(/exact-byte verification|digest or byte length/u);
  });

  it("rejects missing, duplicate, and extra criteria even with refreshed self-digests", () => {
    const material = buildMaterial("criterion-set");
    const firstCriterion = first(material.qualification.criteria, "qualification criteria");
    const missing = resealQualification(material.qualification, {
      criteria: material.qualification.criteria.slice(0, 1),
    });
    const duplicate = resealQualification(material.qualification, {
      criteria: [firstCriterion, firstCriterion],
    });
    const extra = resealQualification(material.qualification, {
      criteria: [
        ...material.qualification.criteria,
        {
          ...firstCriterion,
          criterion_id: "AC-T99.extra",
        },
      ],
    });
    for (const candidate of [missing, duplicate, extra]) {
      expect(() =>
        rederiveInlineScaPhaseQualificationV3({
          store: material.store,
          definition: material.definition,
          qualification: candidate,
        })
      ).toThrow();
    }
  });

  it("never upgrades a declaration-only identity into host attestation", () => {
    const material = buildMaterial("declaration-only");
    const definition: ScaPhaseQualificationDefinitionV1 = {
      ...material.definition,
      required_assurance_scope: "declaration_only",
    };
    expect(() => inspectScaQualificationSubjectV1({ store: material.store, definition })).toThrow(
      /host current binding/u
    );
  });

  it("rejects fixture and narrative artifacts relabeled as live evidence", () => {
    const material = buildMaterial("non-live-evidence");
    const original = first(material.criterionEvidence, "criterion evidence");
    const rest = material.criterionEvidence.slice(1);
    for (const evidenceClass of ["fixture", "narrative"] as const) {
      const relabeledRef = persistJson(material.store, {
        kind: `sca-${evidenceClass}-evidence`,
        operationId: `${evidenceClass}-relabelled-live`,
        producer: `host:test-${evidenceClass}-evidence`,
        schemaId: `penny.test-sca-${evidenceClass}-evidence.v1`,
        value: {
          reported_class: "live",
          narrative: "This label is not live execution evidence.",
        },
      });
      expect(() =>
        evaluateScaPhaseQualificationV3({
          store: material.store,
          definition: material.definition,
          criterion_evidence: [
            { criterion_id: original.criterion_id, evidence_refs: [relabeledRef] },
            ...rest,
          ],
          reviewer_authority_ref: material.reviewerAuthorityRef,
          reviewer_receipt_ref: material.reviewerReceiptRef,
          remaining_gaps: [],
          recorded_at: RECORDED_AT,
        })
      ).toThrow(/exact kind, schema, producer/u);
    }
  });

  it("rejects reviewer identity overlap and lineage overlap independently", () => {
    const material = buildMaterial("review-overlap");
    const base = {
      store: material.store,
      definition: material.definition,
      subjectSha256: material.subjectSha256,
      evidenceRefs: material.evidenceRefs,
    };
    const identityOverlap = persistReview({
      material: base,
      operationSuffix: "identity-overlap",
      reviewerIdentity: IMPLEMENTER_IDENTITY,
    });
    const lineageOverlap = persistReview({
      material: base,
      operationSuffix: "lineage-overlap",
      reviewerLineage: IMPLEMENTER_LINEAGE,
    });
    for (const review of [identityOverlap, lineageOverlap]) {
      expect(() =>
        evaluateScaPhaseQualificationV3({
          store: material.store,
          definition: material.definition,
          criterion_evidence: material.criterionEvidence,
          reviewer_authority_ref: review.authorityRef,
          reviewer_receipt_ref: review.receiptRef,
          remaining_gaps: [],
          recorded_at: RECORDED_AT,
        })
      ).toThrow(/not independent/u);
    }
  });

  it("rejects authority/receipt subject mismatch and receipt reuse for another input set", () => {
    const material = buildMaterial("review-subject");
    const wrongSubject = "f".repeat(64);
    const mismatched = persistReview({
      material: {
        store: material.store,
        definition: material.definition,
        subjectSha256: material.subjectSha256,
        evidenceRefs: material.evidenceRefs,
      },
      operationSuffix: "subject-mismatch",
      receiptSubjectSha256: wrongSubject,
    });
    expect(() =>
      evaluateScaPhaseQualificationV3({
        store: material.store,
        definition: material.definition,
        criterion_evidence: material.criterionEvidence,
        reviewer_authority_ref: mismatched.authorityRef,
        reviewer_receipt_ref: mismatched.receiptRef,
        remaining_gaps: [],
        recorded_at: RECORDED_AT,
      })
    ).toThrow(/another qualification subject/u);

    const firstCriterion = first(material.criterionEvidence, "criterion evidence");
    const firstEvidenceRef = first(firstCriterion.evidence_refs, "criterion evidence refs");
    const evidenceValue: unknown = JSON.parse(
      material.store.readById(firstEvidenceRef.artifact_id).toString("utf8")
    );
    const replacementEvidenceRef = persistJson(material.store, {
      kind: "sca-live-qualification-evidence",
      operationId: "replacement-evidence-same-subject",
      producer: "host:test-live-evidence-authority",
      schemaId: "penny.test-sca-live-evidence.v1",
      value: evidenceValue,
      upstreamRefs: [
        material.definition.implementation_identity.ref,
        ...material.definition.qualified_inputs.map((binding) => binding.ref),
        first(material.definition.criteria, "criterion bindings").definition_ref,
      ],
    });
    expect(() =>
      evaluateScaPhaseQualificationV3({
        store: material.store,
        definition: material.definition,
        criterion_evidence: [
          {
            criterion_id: firstCriterion.criterion_id,
            evidence_refs: [replacementEvidenceRef],
          },
          ...material.criterionEvidence.slice(1),
        ],
        reviewer_authority_ref: material.reviewerAuthorityRef,
        reviewer_receipt_ref: material.reviewerReceiptRef,
        remaining_gaps: [],
        recorded_at: RECORDED_AT,
      })
    ).toThrow(/provenance|same subject, evidence, and decision/u);
  });

  it("produces deterministic self-digests and adopts exact replay bytes", () => {
    const material = buildMaterial("deterministic-replay");
    const replayedQualification = evaluateScaPhaseQualificationV3({
      store: material.store,
      definition: material.definition,
      criterion_evidence: material.criterionEvidence,
      reviewer_authority_ref: material.reviewerAuthorityRef,
      reviewer_receipt_ref: material.reviewerReceiptRef,
      remaining_gaps: [],
      recorded_at: RECORDED_AT,
    });
    expect(canonicalJson(replayedQualification)).toBe(canonicalJson(material.qualification));
    const adoptedRef = persistJson(material.store, {
      kind: material.definition.qualification_record_contract.artifact_kind,
      operationId: "phase-qualification",
      producer: material.definition.qualification_record_contract.producer,
      schemaId: material.definition.qualification_record_contract.schema_id,
      schemaVersion: 3,
      value: replayedQualification,
      upstreamRefs: material.store.metadata(material.qualificationRef).upstream_refs,
    });
    expect(adoptedRef).toEqual(material.qualificationRef);
    expect(
      evaluateScaPhaseGateV3({
        store: material.store,
        definition: material.definition,
        qualification_ref: adoptedRef,
        evaluated_at: EVALUATED_AT,
      }).gate_sha256
    ).toBe(
      validateContract(
        Type.Object({ gate_sha256: Type.String() }),
        JSON.parse(material.store.readById(material.gateRef.artifact_id).toString("utf8")),
        "stored gate digest"
      ).gate_sha256
    );
  });

  it("denies forged host attestations, stale current bindings and declaration-only attestation", () => {
    const material = buildMaterial("forged-binding");
    const forged = { ...material.definition, current_host_binding_sha256: sha256("forgery") };
    expect(() =>
      requireScaPhaseGatePassV3({
        store: material.store,
        definition: forged,
        gate_ref: material.gateRef,
      })
    ).toThrow(/host current binding/u);
    const declaration = {
      ...material.definition,
      required_assurance_scope: "declaration_only" as const,
      current_host_binding_sha256: null,
    };
    expect(() =>
      inspectScaQualificationSubjectV1({ store: material.store, definition: declaration })
    ).toThrow(/assurance scope/u);
    const identityRef = material.definition.implementation_identity.ref;
    const identity = validateContract(
      ImplementationIdentitySchema,
      JSON.parse(material.store.readById(identityRef.artifact_id).toString("utf8")),
      "identity"
    );
    const forgedRef = persistJson(material.store, {
      kind: identityRef.kind,
      operationId: "forged-identity",
      producer: identityRef.producer,
      schemaId: identity.schema_id,
      value: { ...identity, host_binding_sha256: sha256("other") },
    });
    const wrong = {
      ...material.definition,
      implementation_identity: bindStored(material.store, forgedRef),
    };
    expect(() =>
      inspectScaQualificationSubjectV1({ store: material.store, definition: wrong })
    ).toThrow(/host current binding/u);
    const independentRef = persistJson(material.store, {
      kind: identityRef.kind,
      operationId: "forged-independent-attestation",
      producer: identityRef.producer,
      schemaId: identity.schema_id,
      value: {
        ...identity,
        assurance_scope: "independent_attestation",
        host_binding_sha256: sha256("not-current"),
      },
    });
    expect(() =>
      inspectScaQualificationSubjectV1({
        store: material.store,
        definition: {
          ...material.definition,
          required_assurance_scope: "independent_attestation",
          implementation_identity: bindStored(material.store, independentRef),
        },
      })
    ).toThrow(/host current binding/u);
    expect(() =>
      inspectScaQualificationSubjectV1({
        store: material.store,
        definition: { ...material.definition, current_host_binding_sha256: null },
      })
    ).toThrow(/host current binding/u);
    const declaredRef = persistJson(material.store, {
      kind: identityRef.kind,
      operationId: "falsely-attested-declaration",
      producer: identityRef.producer,
      schemaId: identity.schema_id,
      value: { ...identity, assurance_scope: "declaration_only" },
    });
    expect(() =>
      inspectScaQualificationSubjectV1({
        store: material.store,
        definition: {
          ...declaration,
          implementation_identity: bindStored(material.store, declaredRef),
        },
      })
    ).toThrow(/host current binding/u);
  });

  it("uses typed observations, not a self-reported status, and blocks FAIL, BLOCKED and gaps", () => {
    for (const [label, options, expected] of [
      ["failure", { observed: false, reportedStatus: "PASS" as const }, "FAIL"],
      ["unavailable", { observed: null, reportedStatus: "PASS" as const }, "BLOCKED"],
      ["gaps", { gaps: ["missing host check"] }, "BLOCKED"],
      ["relabelled", { reportedStatus: "FAIL" as const }, "PASS"],
    ] as const) {
      const material = buildMaterial(label, options);
      expect(material.qualification.status).toBe(expected);
      const args = {
        store: material.store,
        definition: material.definition,
        gate_ref: material.gateRef,
      };
      if (expected === "PASS") expect(requireScaPhaseGatePassV3(args).status).toBe("passed");
      else expect(() => requireScaPhaseGatePassV3(args)).toThrow(/phase gate is not passed/u);
    }
  });

  it("rejects fabricated-but-distinct reviewer authority, identity and lineage", () => {
    const material = buildMaterial("fabricated-authority");
    for (const patch of [
      { authorityId: "forged-distinct-authority" },
      { reviewerIdentity: "forged-reviewer" },
      { reviewerLineage: "forged-lineage" },
    ]) {
      const review = persistReview({
        material,
        operationSuffix: `forged-${Object.values(patch)[0]}`,
        ...patch,
      });
      expect(() =>
        evaluateScaPhaseQualificationV3({
          store: material.store,
          definition: material.definition,
          criterion_evidence: material.criterionEvidence,
          reviewer_authority_ref: review.authorityRef,
          reviewer_receipt_ref: review.receiptRef,
          remaining_gaps: [],
          recorded_at: RECORDED_AT,
        })
      ).toThrow(/host reviewer policy|same subject, evidence, and decision/u);
    }
  });

  it("denies missing or substituted persisted upstream refs at each custody layer", () => {
    const material = buildMaterial("provenance-denials");
    const identity = material.definition.implementation_identity.ref;
    const inputRef = first(material.definition.qualified_inputs, "qualified inputs").ref;
    const criterion = first(material.definition.criteria, "criteria");
    const evidenceRef = first(material.evidenceRefs, "evidence");
    const scenarios = [
      [criterion.definition_ref, [identity]],
      [evidenceRef, [identity, inputRef]],
      [material.reviewerAuthorityRef, material.evidenceRefs],
      [material.reviewerReceiptRef, [material.reviewerAuthorityRef, ...material.evidenceRefs]],
      [material.qualificationRef, [identity, inputRef]],
      [material.gateRef, [identity]],
    ] as const;
    for (const [ref, upstreamRefs] of scenarios) {
      const storedValue: unknown = JSON.parse(
        material.store.readById(ref.artifact_id).toString("utf8")
      );
      const replacement = persistJson(material.store, {
        kind: ref.kind,
        operationId: `missing-${ref.operation_id}`,
        producer: ref.producer,
        schemaId: ref.content_schema?.schema_id ?? "missing-schema",
        schemaVersion: ref.content_schema?.schema_version ?? 1,
        value: storedValue,
        upstreamRefs,
      });
      const definition =
        ref.artifact_id === criterion.definition_ref.artifact_id
          ? {
              ...material.definition,
              criteria: [
                { ...criterion, definition_ref: replacement },
                ...material.definition.criteria.slice(1),
              ],
            }
          : material.definition;
      // A same-byte, differently persisted artifact must never acquire custody by its content alone.
      if (ref.artifact_id === material.gateRef.artifact_id) {
        expect(() =>
          requireScaPhaseGatePassV3({ store: material.store, definition, gate_ref: replacement })
        ).toThrow();
      } else if (ref.artifact_id === material.qualificationRef.artifact_id) {
        expect(() =>
          evaluateScaPhaseGateV3({
            store: material.store,
            definition,
            qualification_ref: replacement,
            evaluated_at: EVALUATED_AT,
          })
        ).toThrow(/provenance/u);
      } else if (ref.artifact_id === criterion.definition_ref.artifact_id) {
        expect(() =>
          inspectScaQualificationSubjectV1({ store: material.store, definition })
        ).toThrow(/provenance/u);
      } else if (ref.artifact_id === evidenceRef.artifact_id) {
        expect(() =>
          evaluateScaPhaseQualificationV3({
            store: material.store,
            definition,
            criterion_evidence: [
              { criterion_id: criterion.criterion_id, evidence_refs: [replacement] },
              ...material.criterionEvidence.slice(1),
            ],
            reviewer_authority_ref: material.reviewerAuthorityRef,
            reviewer_receipt_ref: material.reviewerReceiptRef,
            remaining_gaps: [],
            recorded_at: RECORDED_AT,
          })
        ).toThrow(/provenance/u);
      } else {
        expect(() =>
          evaluateScaPhaseQualificationV3({
            store: material.store,
            definition,
            criterion_evidence: material.criterionEvidence,
            reviewer_authority_ref:
              ref.artifact_id === material.reviewerAuthorityRef.artifact_id
                ? replacement
                : material.reviewerAuthorityRef,
            reviewer_receipt_ref:
              ref.artifact_id === material.reviewerReceiptRef.artifact_id
                ? replacement
                : material.reviewerReceiptRef,
            remaining_gaps: [],
            recorded_at: RECORDED_AT,
          })
        ).toThrow(/provenance/u);
      }
    }
  });

  it("denies non-null parent revision even when gate bytes and upstream refs are unchanged", () => {
    const material = buildMaterial("wrong-parent");
    const gateValue: unknown = JSON.parse(
      material.store.readById(material.gateRef.artifact_id).toString("utf8")
    );
    const base = metadata({
      kind: material.gateRef.kind,
      operationId: material.gateRef.operation_id,
      producer: material.gateRef.producer,
      schemaId: SCA_PHASE_GATE_RECORD_V3_SCHEMA,
      schemaVersion: 3,
      upstreamRefs: [material.qualificationRef],
    });
    const next = material.store.persist({
      metadata: { ...base, version: 2, parent_ref: material.gateRef },
      content: canonicalJson(gateValue),
    });
    expect(() =>
      requireScaPhaseGatePassV3({
        store: material.store,
        definition: material.definition,
        gate_ref: next,
      })
    ).toThrow(/persisted provenance/u);
  });

  it("bounds aggregate unique artifact bytes before completing the closure", () => {
    const material = buildMaterial("aggregate-budget");
    const total = [
      material.gateRef,
      material.qualificationRef,
      ...subjectRefs(material.definition),
      ...material.evidenceRefs,
      material.reviewerAuthorityRef,
      material.reviewerReceiptRef,
    ].reduce((sum, ref) => sum + ref.byte_length, 0);
    expect(() =>
      requireScaPhaseGatePassV3({
        store: material.store,
        definition: { ...material.definition, max_unique_artifact_bytes: total - 1 },
        gate_ref: material.gateRef,
      })
    ).toThrow(/unique artifact byte budget exceeded/u);
    expect(
      requireScaPhaseGatePassV3({
        store: material.store,
        definition: { ...material.definition, max_unique_artifact_bytes: total },
        gate_ref: material.gateRef,
      }).status
    ).toBe("passed");
  });

  it("rejects contradictory artifact schema IDs and versions", () => {
    const material = buildMaterial("schema-version");
    expect(() =>
      inspectScaQualificationSubjectV1({
        store: material.store,
        definition: {
          ...material.definition,
          implementation_identity_contract: {
            ...material.definition.implementation_identity_contract,
            schema_version: 2,
          },
        },
      })
    ).toThrow(/bounded canonical artifact contract/u);
  });

  it("reopens the exact store for replay and conflicts on changed persistence metadata", () => {
    const material = buildMaterial("reopen");
    const root = material.store.root;
    material.store.close();
    stores.splice(stores.indexOf(material.store), 1);
    const reopened = ArtifactStore.openExisting(root, { projectId: STORE_PROJECT_ID });
    stores.push(reopened);
    expect(
      requireScaPhaseGatePassV3({
        store: reopened,
        definition: material.definition,
        gate_ref: material.gateRef,
      }).status
    ).toBe("passed");
    const qualification = material.qualification;
    const base = {
      kind: material.qualificationRef.kind,
      operationId: material.qualificationRef.operation_id,
      producer: material.qualificationRef.producer,
      schemaId: material.qualificationRef.content_schema?.schema_id ?? "missing-schema",
      schemaVersion: material.qualificationRef.content_schema?.schema_version ?? 3,
      value: qualification,
    };
    expect(
      persistJson(reopened, {
        ...base,
        upstreamRefs: reopened.metadata(material.qualificationRef).upstream_refs,
      })
    ).toEqual(material.qualificationRef);
    expect(() => persistJson(reopened, { ...base, upstreamRefs: [material.gateRef] })).toThrow();
  });

  it("rejects a stale qualification self-digest", () => {
    const material = buildMaterial("stale-self-digest");
    expect(() =>
      validateScaPhaseQualificationRecordV3({
        ...material.qualification,
        recorded_at: "2026-09-22T10:02:01Z",
      })
    ).toThrow(/self-digest is stale/u);
  });
});

describe("historical P01 compatibility and inactive candidates", () => {
  it("keeps P01 V2 schema IDs, canonical bytes, validation, and read-only adapter behavior", () => {
    const golden = legacyP01Golden();
    const qualificationBytes = canonicalJson(golden.qualification);
    const gateBytes = canonicalJson(golden.gate);
    const qualificationDigest = sha256(qualificationBytes);
    const gateDigest = sha256(gateBytes);
    expect([qualificationDigest, gateDigest]).toEqual([
      "2df92e086c4325b7e604cb081b7ed75610619d32aace50354a5ed9630c92a7a6",
      "100ed8a7fb3f782eba459d1679317a2e7ad9b9032f77e30ad345e7267f64d831",
    ]);

    expect(SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA).toBe(
      "penny.sca-phase-qualification-record.v2"
    );
    expect(SCA_PHASE_GATE_RECORD_V2_SCHEMA).toBe("penny.sca-phase-gate-record.v2");
    expect(inspectLegacyScaP01QualificationV2(golden.qualification)).toMatchObject({
      source_schema_id: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
      status: "PASS",
      implementation_assurance_scope: "declaration_only",
    });
    expect(
      inspectLegacyScaP01GateRecordRelationshipV2({
        qualification: golden.qualification,
        qualification_ref: golden.qualificationRef,
        gate: golden.gate,
      }).status
    ).toBe("passed");
    expect(canonicalJson(golden.qualification)).toBe(qualificationBytes);
    expect(canonicalJson(golden.gate)).toBe(gateBytes);
    expect(sha256(canonicalJson(validateScaPhaseQualificationRecordV2(golden.qualification)))).toBe(
      qualificationDigest
    );
    expect(sha256(canonicalJson(validateScaPhaseGateRecordV2(golden.gate)))).toBe(gateDigest);
    expect(golden.qualification).not.toHaveProperty("qualification_sha256");
    expect(golden.gate).not.toHaveProperty("gate_sha256");
  });

  it("leaves every phase candidate registration inactive", () => {
    for (const candidate of [
      "sca-p01-candidate",
      "sca-p02-candidate",
      "sca-p03-candidate",
      "sca-p04-candidate",
      "sca-p05-candidate",
      "sca-p06-candidate",
    ]) {
      expect(PLAYBOOK_REGISTRY.has(candidate)).toBe(false);
    }
  });
});
