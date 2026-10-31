import { deriveScaP03InitialCustodyV1 } from "../../orchestration/dist/sca/p03-initial-authorization.js";
import { measureScaP02CurrentHostBinding } from "../../orchestration/dist/sca/p02-activation-host.js";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCA_P02_CANDIDATE_PLAYBOOK_NAME } from "../../orchestration/dist/sca/p02-playbook.js";
import { ArtifactStore, previewArtifactRef } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  validateContract,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../../orchestration/dist/contracts.js";
import {
  SCA_P02_QUALIFICATION_ARTIFACTS,
  SCA_P02_QUALIFICATION_CHECKS,
  SCA_P02_QUALIFICATION_CRITERION_IDS,
  SCA_P02_IMPLEMENTATION_SOURCE_PATHS,
  buildScaP02CriterionDefinitionV1,
  buildScaP02ImplementationIdentityV1,
  buildScaP02QualificationEvidenceV1,
  createScaP02QualificationDefinitionV1,
} from "../../orchestration/dist/sca/p02-qualification.js";
import {
  SCA_P02_V3_AUTHORITY,
  SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
  SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA,
  SCA_P02_V3_GATE_KIND,
  requireScaP03AcceptedP02Qualification,
  createScaP02QualificationDefinitionFromSnapshot,
  ScaP02V3DefinitionSnapshotSchema,
} from "../../orchestration/dist/sca/p03-p02-qualification-guard.js";
import {
  SCA_PHASE_GATE_RECORD_V3_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
  SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
  sealScaPhaseReviewReceiptV1,
  sealScaPhaseReviewerAuthorityV1,
} from "../../orchestration/dist/sca/qualification-gate-contracts.js";
import {
  evaluateScaPhaseGateV3,
  evaluateScaPhaseQualificationV3,
  inspectScaQualificationSubjectV1,
  type ScaArtifactContractV1,
} from "../../orchestration/dist/sca/qualification-gate.js";
import {
  SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
  SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
  sealScaActivationAuthorityV1,
  sealScaActivationIssuanceV1,
  type ScaActivationScopeV1,
} from "../../orchestration/dist/sca/qualification-activation-contracts.js";
import {
  scaProposedStartSha256,
  scaQualificationPolicyDataSha256,
} from "../../orchestration/dist/sca/qualification-activation.js";
import {
  createScaP03ApprovedInputReaderV1,
  ScaP03PredecessorLimitsV1Schema,
  loadScaP03PredecessorInputsV1,
  replayScaP03HistoricalP02AuthorityV1,
  selectScaP03PredecessorRootToolV1,
  validateScaP03RecordedRootClosureV1,
  measureScaP03PredecessorCurrentHostBindingV1,
  type ScaP03PredecessorInputsV1,
  type ScaP03HistoricalP02InputsV1,
  type ScaP03PredecessorResultV1,
} from "../src/p03-predecessor-inputs.js";
import { validateScaToolchainIdentityV1 } from "../../orchestration/dist/sca/p01-policy-contracts.js";
import {
  ScaP01JoernRuntimeClosureV1Schema,
  scaP01JoernImageClosureV1,
} from "../src/p01-joern-root.js";

const RUN = "p02-v3-guard-run";
const TENANT = "tenant-p03-guard";
const PROJECT = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVISION = "p02-v3-revision";
const HOST = sha256("current-host");
const TIME = [
  "2026-09-26T00:00:00Z",
  "2026-09-26T00:01:00Z",
  "2026-09-26T00:02:00Z",
  "2026-09-26T00:03:00Z",
] as const;
const roots: string[] = [];
const stores: ArtifactStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function sorted(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((a, b) =>
    Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id))
  );
}
function persist(
  store: ArtifactStore,
  operation: string,
  kind: string,
  producer: string,
  value: unknown,
  upstream: readonly ArtifactRef[] = [],
  schema?: string,
  schemaVersion = 1,
  phase = "SCA-P02"
): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: RUN,
    phase,
    branch_id: null,
    kind,
    operation_id: operation,
    version: 1,
    parent_ref: null,
    producer,
    media_type: "application/json",
    ...(schema === undefined
      ? {}
      : { content_schema: { schema_id: schema, schema_version: schemaVersion } }),
    upstream_refs: sorted(upstream),
  };
  return store.persist({ metadata, content: canonicalJson(value) });
}
function descriptor(
  kind: string,
  schema: string,
  producer: string,
  version = 1
): ScaArtifactContractV1 {
  return {
    artifact_kind: kind,
    schema_id: schema,
    schema_version: version,
    producer,
    media_type: "application/json",
    max_bytes: 4 * 1_048_576,
  };
}
// Adapted from the existing P02 V3 guard fixture. Deterministic schema evidence only; NOT live observations.
function setup(gaps: readonly string[] = [], nativeOrder = false) {
  const root = mkdtempSync(path.join(tmpdir(), "p03-p02-qualification-"));
  roots.push(root);
  const store = new ArtifactStore(path.join(root, "artifacts"), {
    projectId: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  stores.push(store);
  const formal = persist(store, "review", "agent-output", "agent:vera", { review: "independent" });
  const reviewer = {
    authority: "penny:sca-p02-independent-review-authority",
    identity: "agent:vera",
    lineage: formal.artifact_id,
  };
  const identity = buildScaP02ImplementationIdentityV1({
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    implementation_revision: REVISION,
    host_binding_sha256: HOST,
    implementer_identity_id: "p02-implementer",
    implementer_lineage_id: "p02-implementer-lineage",
    source_files: SCA_P02_IMPLEMENTATION_SOURCE_PATHS.map((file) => ({
      path: file,
      sha256: sha256(file),
      byte_length: Buffer.byteLength(file),
    })),
  });
  const identityRef = persist(
    store,
    "identity",
    SCA_P02_QUALIFICATION_ARTIFACTS.identity.artifact_kind,
    SCA_P02_QUALIFICATION_ARTIFACTS.identity.producer,
    identity,
    [],
    identity.schema_id
  );
  const operational = persist(
    store,
    "operational-gate",
    "sca-p02-gate",
    "host:sca-p02-candidate",
    {
      status: "passed",
    },
    [],
    "penny.sca-p02-gate.v1"
  );
  const transition = persist(
    store,
    "transition",
    "sca-p02-p03-transition",
    "host:sca-p02-candidate",
    { status: "nonterminal" },
    [],
    "penny.sca-p02-p03-transition.v1",
    1,
    SCA_P02_CANDIDATE_PLAYBOOK_NAME
  );
  const candidate = (operation: string, kind: string, schema: string, version = 1) =>
    persist(store, operation, kind, "host:sca-p02-candidate", { operation }, [], schema, version);
  // Opaque historical native evidence: no producer-specific canonical JSON or sort rule.
  const nativeRefs = sorted([formal, identityRef]).reverse();
  const nativeEvidence = nativeOrder
    ? store.persist({
        metadata: {
          ...store.metadata(operational),
          operation_id: "native-inventory",
          kind: "sca-p02-inventory-result",
          upstream_refs: nativeRefs,
        },
        content: canonicalJson({ fixture: "native opaque inventory" }) + "\n",
      })
    : undefined;
  const operationalCohort = {
    transition_ref: transition,
    p02_request_ref: candidate("request", "sca-p02-candidate-request", "penny.sca-p02-request.v1"),
    gate_ref: operational,
    m1_ref: candidate("m1", "sca-m1-record", "penny.sca-m1-record.v2", 2),
    coverage_matrix_ref: candidate(
      "coverage",
      "sca-p02-coverage-matrix",
      "penny.sca-p02-coverage-matrix.v1"
    ),
    evidence_manifest_ref: candidate(
      "manifest",
      "sca-p02-evidence-manifest",
      "penny.sca-p02-evidence-manifest.v1"
    ),
    successor_ledger_ref: candidate(
      "ledger",
      "sca-p02-successor-obligation-ledger",
      "penny.sca-p02-successor-obligation-ledger.v1"
    ),
    evidence_refs: Array.from({ length: 26 }, (_, i) =>
      i === 0 && nativeEvidence !== undefined
        ? nativeEvidence
        : candidate(`evidence-${i}`, "sca-p02-proof", "penny.sca-p02-proof.v1")
    ),
  };
  const cohortRefs = [
    operationalCohort.transition_ref,
    operationalCohort.p02_request_ref,
    operationalCohort.gate_ref,
    operationalCohort.m1_ref,
    operationalCohort.coverage_matrix_ref,
    operationalCohort.evidence_manifest_ref,
    operationalCohort.successor_ledger_ref,
    ...operationalCohort.evidence_refs,
  ];
  const summary = persist(
    store,
    "collector",
    "sca-p02-operational-qualification-input",
    "host:sca-p02-qualification-custodian",
    { cohort: "current" },
    cohortRefs,
    "penny.sca-p02-formal-collector-summary.v1"
  );
  const inputs = sorted([summary, formal]);
  const definitions = SCA_P02_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
    criterion_id,
    ref: persist(
      store,
      `criterion-${criterion_id}`,
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.producer,
      buildScaP02CriterionDefinitionV1({
        tenant_id: TENANT,
        project_id: PROJECT,
        run_id: RUN,
        implementation_revision: REVISION,
        criterion_id,
      }),
      [identityRef, ...inputs],
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.schema_id
    ),
  }));
  const requiredDefinition = (index: number) => {
    const found = definitions[index];
    if (found === undefined) throw new Error("P02 fixture definition missing");
    return found.ref;
  };
  const definitionRefs = {
    "p02-containment-egress-and-minimization": requiredDefinition(0),
    "p02-current-predecessor-and-implementation": requiredDefinition(1),
    "p02-required-variants-and-lifecycle": requiredDefinition(2),
    "p02-six-operation-deterministic-coverage": requiredDefinition(3),
  };
  const contracts = {
    implementation_identity: descriptor(
      SCA_P02_QUALIFICATION_ARTIFACTS.identity.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.identity.schema_id,
      SCA_P02_QUALIFICATION_ARTIFACTS.identity.producer
    ),
    criterion_definition: descriptor(
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.schema_id,
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.producer
    ),
    criterion_evidence: descriptor(
      SCA_P02_QUALIFICATION_ARTIFACTS.evidence.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.evidence.schema_id,
      SCA_P02_QUALIFICATION_ARTIFACTS.evidence.producer
    ),
    reviewer_authority: descriptor(
      "sca-p02-phase-reviewer-authority",
      SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
      "host:sca-p02-qualification-review-authority"
    ),
    reviewer_receipt: descriptor(
      "sca-p02-phase-review-receipt",
      SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
      "host:sca-p02-qualification-review-authority"
    ),
    qualification: descriptor(
      "sca-p02-phase-qualification-v3",
      SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
      SCA_P02_V3_AUTHORITY,
      3
    ),
    gate: descriptor(
      SCA_P02_V3_GATE_KIND,
      SCA_PHASE_GATE_RECORD_V3_SCHEMA,
      SCA_P02_V3_AUTHORITY,
      3
    ),
  };
  const binding = (ref: ArtifactRef) => {
    const metadata = store.metadata(ref);
    return { ref, parent_ref: metadata.parent_ref, upstream_refs: [...metadata.upstream_refs] };
  };
  const definition = createScaP02QualificationDefinitionV1({
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    implementation_revision: REVISION,
    current_host_binding_sha256: HOST,
    current_source_manifest_sha256: identity.source_manifest_sha256,
    max_unique_artifact_bytes: 16 * 1_048_576,
    max_json_artifact_bytes: 4 * 1_048_576,
    reviewer_authority_id: reviewer.authority,
    reviewer_identity_id: reviewer.identity,
    reviewer_lineage_id: reviewer.lineage,
    implementation_identity: binding(identityRef),
    qualified_inputs: inputs.map(binding),
    criterion_definition_refs: definitionRefs,
    reviewer_authority_contract: contracts.reviewer_authority,
    reviewer_receipt_contract: contracts.reviewer_receipt,
    qualification_record_contract: contracts.qualification,
    gate_record_contract: contracts.gate,
  });
  const subject = inspectScaQualificationSubjectV1({ store, definition });
  const evidence = SCA_P02_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
    criterion_id,
    evidence_refs: [
      persist(
        store,
        `evidence-${criterion_id}`,
        contracts.criterion_evidence.artifact_kind,
        contracts.criterion_evidence.producer,
        buildScaP02QualificationEvidenceV1({
          tenant_id: TENANT,
          project_id: PROJECT,
          run_id: RUN,
          implementation_revision: REVISION,
          host_binding_sha256: HOST,
          implementer_identity_id: "p02-implementer",
          implementer_lineage_id: "p02-implementer-lineage",
          criterion_id,
          subject_sha256: subject.subject_sha256,
          supporting_refs: inputs,
          observations: SCA_P02_QUALIFICATION_CHECKS[criterion_id].map((check_id) => ({
            check_id,
            observed: true,
          })),
        }),
        [identityRef, ...inputs, definitionRefs[criterion_id]],
        contracts.criterion_evidence.schema_id
      ),
    ],
  }));
  const evidenceRefs = sorted(evidence.flatMap((item) => item.evidence_refs));
  const subjectRefs = [identityRef, ...inputs, ...definitions.map((item) => item.ref)];
  const reviewFields = {
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    phase_id: "SCA-P02",
    implementation_revision: REVISION,
    implementation_assurance_scope: "host_derived_binding" as const,
    reviewer_identity_id: reviewer.identity,
    reviewer_lineage_id: reviewer.lineage,
    subject_sha256: subject.subject_sha256,
    evidence_refs: evidenceRefs,
  };
  const authority = persist(
    store,
    "authority",
    contracts.reviewer_authority.artifact_kind,
    contracts.reviewer_authority.producer,
    sealScaPhaseReviewerAuthorityV1({
      schema_id: SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
      schema_version: 1,
      authority_id: reviewer.authority,
      ...reviewFields,
      decision: "authorized",
      issued_at: TIME[0],
    }),
    [...subjectRefs, ...evidenceRefs],
    contracts.reviewer_authority.schema_id
  );
  const receipt = persist(
    store,
    "receipt",
    contracts.reviewer_receipt.artifact_kind,
    contracts.reviewer_receipt.producer,
    sealScaPhaseReviewReceiptV1({
      schema_id: SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      receipt_id: "p02-review-receipt",
      ...reviewFields,
      reviewer_authority_ref: authority,
      criterion_results: SCA_P02_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
        criterion_id,
        status: "PASS" as const,
      })),
      decision: "PASS",
      reviewed_at: TIME[1],
    }),
    [...subjectRefs, ...evidenceRefs, authority],
    contracts.reviewer_receipt.schema_id
  );
  const qualification = evaluateScaPhaseQualificationV3({
    store,
    definition,
    criterion_evidence: evidence,
    reviewer_authority_ref: authority,
    reviewer_receipt_ref: receipt,
    remaining_gaps: gaps,
    recorded_at: TIME[2],
  });
  const qualificationRef = persist(
    store,
    "qualification",
    contracts.qualification.artifact_kind,
    contracts.qualification.producer,
    qualification,
    [...subjectRefs, ...evidenceRefs, authority, receipt],
    contracts.qualification.schema_id,
    3
  );
  const gate = evaluateScaPhaseGateV3({
    store,
    definition,
    qualification_ref: qualificationRef,
    evaluated_at: TIME[3],
  });
  const gateRef = persist(
    store,
    "gate",
    contracts.gate.artifact_kind,
    contracts.gate.producer,
    gate,
    [qualificationRef],
    contracts.gate.schema_id,
    3
  );
  const unsigned = {
    schema_id: SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA,
    schema_version: 1 as const,
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    phase_id: "SCA-P02" as const,
    implementation_revision: REVISION,
    required_assurance_scope: "host_derived_binding" as const,
    current_host_binding_sha256: HOST,
    current_source_manifest_sha256: identity.source_manifest_sha256,
    max_unique_artifact_bytes: 16 * 1_048_576,
    max_json_artifact_bytes: 4 * 1_048_576,
    reviewer_authority_id: reviewer.authority,
    reviewer_identity_id: reviewer.identity,
    reviewer_lineage_id: reviewer.lineage,
    source_policy_module: "apps/orchestration/src/sca/p02-qualification.ts" as const,
    criterion_ids: [...SCA_P02_QUALIFICATION_CRITERION_IDS],
    contracts,
    implementation_identity: binding(identityRef),
    qualified_inputs: inputs.map(binding),
    criterion_definition_refs: definitionRefs,
    reviewer_authority_ref: authority,
    reviewer_receipt_ref: receipt,
    formal_review_ref: formal,
    qualification_ref: qualificationRef,
    gate_ref: gateRef,
    subject_sha256: subject.subject_sha256,
    activation_performed: false as const,
    registration_performed: false as const,
    p03_admission_performed: false as const,
  };
  const snapshot = { ...unsigned, definition_snapshot_sha256: sha256(canonicalJson(unsigned)) };
  const provenance = [gateRef, qualificationRef, authority, receipt, formal];
  const snapshotRef = persist(
    store,
    "snapshot",
    SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
    SCA_P02_V3_AUTHORITY,
    snapshot,
    provenance,
    SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA
  );
  const check = (
    ref = snapshotRef,
    gate_ref = gateRef,
    accepted_p02_refs: readonly ArtifactRef[] = [operational, transition]
  ) =>
    requireScaP03AcceptedP02Qualification({
      store,
      definition_ref: ref,
      gate_ref,
      tenant_id: TENANT,
      project_id: PROJECT,
      accepted_p02_refs,
    });
  const altered = (change: (value: typeof unsigned) => unknown) => {
    const value = change(unsigned);
    const payload =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== "definition_snapshot_sha256")
          )
        : { invalid: value };
    const newRef = persist(
      store,
      `snapshot-${sha256(canonicalJson(payload)).slice(0, 10)}`,
      SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
      SCA_P02_V3_AUTHORITY,
      { ...payload, definition_snapshot_sha256: sha256(canonicalJson(payload)) },
      provenance,
      SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA
    );
    return () => check(newRef);
  };
  return {
    root,
    store,
    snapshot,
    snapshotRef,
    gateRef,
    qualificationRef,
    authority,
    receipt,
    formal,
    operational,
    transition,
    operationalCohort,
    check,
    altered,
  };
}

const LIMITS = {
  max_refs: 1024,
  max_artifact_bytes: 64 * 1048576,
  max_json_bytes: 4 * 1048576,
  max_total_bytes: 256 * 1048576,
};
const ACTIVATION_RUN = "isolated-historical-activation";
const ISSUER = "host:test-external-issuer";

function historyFixture(
  f: ReturnType<typeof setup>,
  change?: (scope: ScaActivationScopeV1) => ScaActivationScopeV1,
  nativeOrder = false
) {
  const definition = validateContract(
    ScaP02V3DefinitionSnapshotSchema,
    f.snapshot,
    "deterministic snapshot fixture"
  );
  const projection = {
    tenant_id: TENANT,
    project_id: PROJECT,
    phase_id: "SCA-P02",
    production_playbook_name: "sca-p02",
    qualification_run_id: RUN,
    activation_run_id: ACTIVATION_RUN,
    qualification_ref: f.qualificationRef,
    gate_ref: f.gateRef,
  };
  const base: ScaActivationScopeV1 = {
    ...projection,
    authority_id: "test-operator-authority",
    nonce: "test-historical-nonce",
    decision: "authorize_activation_admission",
    implementation_identity_ref: definition.implementation_identity.ref,
    qualification_policy_data_sha256: scaQualificationPolicyDataSha256(
      createScaP02QualificationDefinitionFromSnapshot(definition)
    ),
    registration_contract_sha256: sha256("recorded-registration-contract-not-current-measurement"),
    runtime_registration_sha256: sha256("recorded-registration-runtime-not-current-measurement"),
    host_implementation_binding_sha256: HOST,
    operator_principal_id: "operator-not-reviewer",
    issuer_policy_id: "isolated-issuer-policy",
    proposed_start_sha256: scaProposedStartSha256(projection),
    issued_at: "2026-09-26T00:04:00Z",
    not_before: "2026-09-26T00:04:00Z",
    expires_at: "2026-09-27T00:04:00Z",
    revocation_generation: 1,
  };
  const scope = change === undefined ? base : change(base);
  const write = (
    operation: string,
    kind: string,
    schema: string,
    value: unknown,
    upstream: readonly ArtifactRef[]
  ) =>
    f.store.persist({
      metadata: {
        schema_version: 2,
        run_id: ACTIVATION_RUN,
        phase: "sca-activation-admission",
        branch_id: null,
        kind,
        operation_id: `${operation}-${sha256(canonicalJson(value)).slice(0, 12)}`,
        version: 1,
        parent_ref: null,
        producer: ISSUER,
        media_type: "application/json",
        content_schema: { schema_id: schema, schema_version: 1 },
        upstream_refs: nativeOrder ? sorted(upstream).reverse() : sorted(upstream),
      },
      content: canonicalJson(value),
    });
  const upstream = [scope.gate_ref, scope.qualification_ref, scope.implementation_identity_ref];
  const issuance = sealScaActivationIssuanceV1({
    schema_id: SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
    schema_version: 1,
    issuance_id: "historical-issuance",
    authority_id: scope.authority_id,
    operator_principal_id: scope.operator_principal_id,
    issuer_policy_id: scope.issuer_policy_id,
    scope_sha256: sha256(canonicalJson(scope)),
    issued_at: scope.issued_at,
  });
  const issuanceRef = write(
    "issuance",
    "sca-activation-issuance",
    issuance.schema_id,
    issuance,
    upstream
  );
  const authority = sealScaActivationAuthorityV1({
    schema_id: SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
    schema_version: 1,
    scope,
    issuance_record_ref: issuanceRef,
  });
  const authorityRef = write(
    "authority",
    "sca-activation-authority",
    authority.schema_id,
    authority,
    [...upstream, issuanceRef]
  );
  const operands: ScaP03HistoricalP02InputsV1 = {
    schema_id: "penny.sca-p03-historical-p02-inputs.v1",
    schema_version: 1,
    store_root: f.store.root,
    tenant_id: TENANT,
    project_id: PROJECT,
    limits: LIMITS,
    definition_ref: f.snapshotRef,
    gate_ref: f.gateRef,
    qualification_ref: f.qualificationRef,
    historical_issuance_ref: issuanceRef,
    historical_authority_ref: authorityRef,
    issuance_producer: ISSUER,
    authority_producer: ISSUER,
    accepted_p02_refs: [f.operational, f.transition],
  };
  return { operands, authority, issuance, write };
}
function fullOperands(
  f: ReturnType<typeof setup>,
  h: ReturnType<typeof historyFixture>
): ScaP03PredecessorInputsV1 {
  const request = persist(
    f.store,
    "loader-request",
    "sca-p02-candidate-request",
    "host:sca-p02-candidate",
    {
      schema_id: "penny.sca-p02-request.v1",
      schema_version: 1,
      tenant_id: TENANT,
      project_id: PROJECT,
      run_id: RUN,
      accepted_p01: {
        request_ref: f.operational,
        obligation_ledger_ref: f.operational,
        campaign_manifest_core_ref: f.operational,
        admission_evidence_ref: f.operational,
        p01_gate_ref: f.operational,
        campaign_manifest_ref: f.operational,
        frozen_refs: [f.operational],
      },
      runtime_policy_ref: f.operational,
      isolation_evidence_ref: f.operational,
      isolation_host_attestation_ref: null,
      requested_at: TIME[0],
    },
    [],
    "penny.sca-p02-request.v1",
    1,
    SCA_P02_CANDIDATE_PLAYBOOK_NAME
  );
  const { accepted_p02_refs: cohort, ...context } = h.operands;
  void cohort;
  return {
    ...context,
    schema_id: "penny.sca-p03-predecessor-inputs.v1",
    request_ref: request,
    transition_ref: f.transition,
  };
}
function refused(value: ScaP03PredecessorResultV1<unknown>, code?: string) {
  expect(value.status).toBe("refused");
  if (value.status === "ready") throw new Error("unexpected readiness");
  if (code !== undefined) expect(value.diagnostics[0]?.code).toBe(code);
}

// No Docker, keys, live state, models, downloads or production issuance. Every store is isolated scratch.
describe("exact P03 predecessor inspection", () => {
  it("accepts intact unsorted native provenance and opaque newline bytes without rewriting evidence", () => {
    const f = setup([], true);
    const h = historyFixture(f, undefined, true);
    const historicalMetadata = f.store.metadata(h.operands.historical_authority_ref);
    expect(historicalMetadata.upstream_refs).not.toEqual(sorted(historicalMetadata.upstream_refs));
    const ref = f.operationalCohort.evidence_refs[0];
    if (ref === undefined) throw new Error("native fixture absent");
    const before = f.store.metadata(ref);
    const bytes = f.store.read(ref);
    expect(before.upstream_refs).not.toEqual(sorted(before.upstream_refs));
    expect(bytes.at(-1)).toBe(10);
    const write = vi.spyOn(ArtifactStore.prototype, "persist");
    const outcome = replayScaP03HistoricalP02AuthorityV1(h.operands);
    expect(outcome.status).toBe("ready");
    expect(write).not.toHaveBeenCalled();
    expect(f.store.metadata(ref)).toEqual(before);
    expect(f.store.read(ref)).toEqual(bytes);
  });

  it("uses the persisted candidate phase, never conceptual qualification phase_id", () => {
    const f = setup();
    const h = historyFixture(f);
    const input = fullOperands(f, h);
    expect(input.request_ref.phase).toBe(SCA_P02_CANDIDATE_PLAYBOOK_NAME);
    expect(input.transition_ref.phase).toBe(SCA_P02_CANDIDATE_PLAYBOOK_NAME);
    // This deliberately incomplete P01 body must pass the artifact contract and reach P01 replay.
    refused(loadScaP03PredecessorInputsV1(input), "p01_replay_denied");
    const metadata = f.store.metadata(input.request_ref);
    const wrongPhase = f.store.persist({
      metadata: { ...metadata, phase: "SCA-P02", operation_id: "conceptual-phase" },
      content: f.store.read(input.request_ref),
    });
    const outcome = loadScaP03PredecessorInputsV1({ ...input, request_ref: wrongPhase });
    expect(outcome).toEqual({
      status: "refused",
      diagnostics: [{ code: "ref_mismatch", operand: "artifact_contract" }],
    });
  });
  it("replays real source-defined P02 formal qualification with expired historical authority, without admission", () => {
    const f = setup();
    const h = historyFixture(f);
    const before = f.store.metadata(h.operands.historical_authority_ref);
    const objects = readdirSync(path.join(f.store.root, "objects", "sha256"));
    const persistSpy = vi.spyOn(ArtifactStore.prototype, "persist");
    const selectSpy = vi.spyOn(ArtifactStore.prototype, "select");
    const outcome = replayScaP03HistoricalP02AuthorityV1(h.operands);
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error(JSON.stringify(outcome));
    expect(outcome.value.definition).toEqual(f.check());
    expect(outcome.value.qualification_replay).toBe("passed");
    expect(outcome.value.usable_authority).toBe("unknown");
    expect(outcome.value.activation_allowed).toBe(false);
    expect(outcome.value.current_host_binding_replay).toBe("not_run");
    expect(outcome.value.authority.scope.expires_at).toBe("2026-09-27T00:04:00Z");
    const proposal = outcome.value.proposed_start;
    expect(proposal.provenance).toBe("derived_not_persisted_artifact");
    expect(proposal.value.proposed_start_sha256).toBe(h.authority.scope.proposed_start_sha256);
    expect(scaProposedStartSha256(proposal.value)).toBe(proposal.value.proposed_start_sha256);
    expect(proposal.canonical_sha256).toBe(sha256(canonicalJson(proposal.value)));
    expect(proposal.value).not.toHaveProperty("artifact_id");
    expect(proposal.value.authority_ref).toEqual(h.operands.historical_authority_ref);
    expect(persistSpy).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
    expect(f.store.metadata(h.operands.historical_authority_ref)).toEqual(before);
    expect(readdirSync(path.join(f.store.root, "objects", "sha256"))).toEqual(objects);
  });

  it("does not accept an active/consumed row declaration or an arbitrary verifier as current authority", () => {
    const f = setup();
    const h = historyFixture(f);
    for (const extra of [
      { phase_status: "active", issuance_status: "consumed" },
      { verify_authority: () => true },
      { now: "2026-09-26T00:05:00Z" },
    ])
      refused(replayScaP03HistoricalP02AuthorityV1({ ...h.operands, ...extra }), "invalid_input");
    const beforeNotBefore = historyFixture(f, (s) => ({
      ...s,
      not_before: "2026-09-26T23:04:00Z",
    }));
    const outcome = replayScaP03HistoricalP02AuthorityV1(beforeNotBefore.operands);
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("valid historical interval refused");
    expect(outcome.value.usable_authority).toBe("unknown");
  });

  it("requires all direct operands before touching a store and never discovers names", () => {
    const f = setup();
    const h = historyFixture(f);
    const full = fullOperands(f, h);
    const reads = vi.spyOn(ArtifactStore.prototype, "refById");
    for (const key of [
      "request_ref",
      "definition_ref",
      "gate_ref",
      "qualification_ref",
      "historical_issuance_ref",
      "historical_authority_ref",
      "transition_ref",
      "store_root",
      "project_id",
      "tenant_id",
      "limits",
      "issuance_producer",
      "authority_producer",
    ] as const) {
      const incomplete = Object.fromEntries(Object.entries(full).filter(([name]) => name !== key));
      expect(loadScaP03PredecessorInputsV1(incomplete)).toEqual({
        status: "missing_input",
        diagnostics: [{ code: "missing_input", operand: key }],
      });
    }
    expect(reads).not.toHaveBeenCalled();
    refused(
      loadScaP03PredecessorInputsV1({ ...full, guessed_name: "latest-root" }),
      "invalid_input"
    );
  });

  it("reads original octet-stream JSON by the actual native read(ref), without wrapping or media rewriting", () => {
    const f = setup();
    const h = historyFixture(f);
    const input = fullOperands(f, h);
    const rootBytes = Buffer.from(canonicalJson(recordedRoot()));
    const originalRoot = f.store.persist({
      metadata: {
        ...f.store.metadata(f.operational),
        operation_id: "original-octet-root",
        kind: "sca-p01-tool-executable-package",
        producer: "host:sca-tool-executable-custody",
        media_type: "application/octet-stream",
        content_schema: {
          schema_id: "penny.sca-p01-tool-executable-package.v1",
          schema_version: 1,
        },
        upstream_refs: [],
      },
      content: rootBytes,
    });
    const readSpy = vi.spyOn(ArtifactStore.prototype, "read");
    const persistSpy = vi.spyOn(ArtifactStore.prototype, "persist");
    const selectedSpy = vi.spyOn(ArtifactStore.prototype, "selected");
    refused(loadScaP03PredecessorInputsV1({ ...input, request_ref: originalRoot }), "ref_mismatch");
    expect(readSpy).toHaveBeenCalledWith(originalRoot);
    const index = readSpy.mock.calls.findIndex(
      ([ref]) => ref.artifact_id === originalRoot.artifact_id
    );
    const readResult = readSpy.mock.results[index];
    if (readResult === undefined || readResult.type !== "return")
      throw new Error("root native read absent");
    expect(readResult.value).toEqual(rootBytes);
    expect(f.store.refById(originalRoot.artifact_id)).toEqual(originalRoot);
    expect(originalRoot.media_type).toBe("application/octet-stream");
    expect(persistSpy).not.toHaveBeenCalled();
    expect(selectedSpy).not.toHaveBeenCalled();
  });

  it("denies wrong project partitions and cross-project historical scopes", () => {
    const f = setup();
    const h = historyFixture(f);
    refused(
      replayScaP03HistoricalP02AuthorityV1({ ...h.operands, project_id: `prj_${"b".repeat(32)}` }),
      "store_denied"
    );
    const crossed = historyFixture(f, (s) => ({ ...s, project_id: `prj_${"b".repeat(32)}` }));
    refused(replayScaP03HistoricalP02AuthorityV1(crossed.operands), "historical_binding_denied");
    const crossedTenant = historyFixture(f, (s) => ({ ...s, tenant_id: "other-tenant" }));
    refused(
      replayScaP03HistoricalP02AuthorityV1(crossedTenant.operands),
      "historical_binding_denied"
    );
    const input = fullOperands(f, h);
    refused(
      loadScaP03PredecessorInputsV1({ ...input, tenant_id: "other-tenant" }),
      "historical_binding_denied"
    );
    // This structurally valid but non-accepted P01 set must not be reconstructed or silently accepted.
    refused(loadScaP03PredecessorInputsV1(input), "p01_replay_denied");
  });

  it("refuses missing refs, substituted full metadata, changed bytes and corrupt version addresses", () => {
    const f = setup();
    const h = historyFixture(f);
    const missing = previewArtifactRef({
      metadata: { ...f.store.metadata(f.snapshotRef), operation_id: "never-persisted" },
      content: canonicalJson(f.snapshot),
    });
    expect(
      replayScaP03HistoricalP02AuthorityV1({ ...h.operands, definition_ref: missing }).status
    ).toBe("missing_input");
    for (const change of [
      { version: 2 },
      { producer: "host:substitution" },
      { phase: "SCA-P03" },
      { byte_length: f.snapshotRef.byte_length + 1 },
      {
        content_digest: sha256("substituted"),
        store_ref: `artifact://sha256/${sha256("substituted")}`,
      },
      { content_schema: { schema_id: "penny.changed.v1", schema_version: 1 } },
      { media_type: "application/octet-stream" },
      { extra: true },
    ])
      refused(
        replayScaP03HistoricalP02AuthorityV1({
          ...h.operands,
          definition_ref: { ...f.snapshotRef, ...change },
        })
      );
    const originalRead = ArtifactStore.prototype.read;
    vi.spyOn(ArtifactStore.prototype, "read").mockImplementation(function (
      this: ArtifactStore,
      ref
    ) {
      return ref.artifact_id === f.snapshotRef.artifact_id
        ? Buffer.from("{}")
        : originalRead.call(this, ref);
    });
    refused(replayScaP03HistoricalP02AuthorityV1(h.operands), "ref_mismatch");
  });

  it("refuses native-invalid metadata and tampered expected historical lineage even when preview agrees", () => {
    const f = setup();
    const h = historyFixture(f);
    const realMetadata = ArtifactStore.prototype.metadata;
    for (const mutate of [
      (m: OutputArtifactMetadata) => ({ ...m, extra: "must-be-closed" }),
      (m: OutputArtifactMetadata) => ({ ...m, parent_ref: f.gateRef }),
      (m: OutputArtifactMetadata) => {
        const first = m.upstream_refs[0];
        if (first === undefined) throw new Error("required provenance missing");
        return { ...m, upstream_refs: [...m.upstream_refs, first] };
      },
      (m: OutputArtifactMetadata) => ({
        ...m,
        // Actual foreign expected-history ref, not merely a legitimate native order.
        upstream_refs: [...m.upstream_refs.slice(1), f.snapshotRef],
      }),
    ]) {
      const spy = vi.spyOn(ArtifactStore.prototype, "metadata").mockImplementation(function (
        this: ArtifactStore,
        ref
      ) {
        const m = realMetadata.call(this, ref);
        if (ref.artifact_id !== h.operands.historical_authority_ref.artifact_id) return m;
        // Malformed fixtures enter via unknown and are checked by the real metadata validator.
        return mutate(m);
      });
      refused(replayScaP03HistoricalP02AuthorityV1(h.operands), "metadata_denied");
      spy.mockRestore();
    }
  });

  it("rechecks provenance and original bytes so caches cannot hide mid-replay drift", () => {
    const f = setup();
    const h = historyFixture(f);
    const actualMetadata = ArtifactStore.prototype.metadata;
    let metadataReads = 0;
    const metadataSpy = vi.spyOn(ArtifactStore.prototype, "metadata").mockImplementation(function (
      this: ArtifactStore,
      ref
    ) {
      const metadata = actualMetadata.call(this, ref);
      if (
        ref.artifact_id === h.operands.historical_authority_ref.artifact_id &&
        ++metadataReads > 1
      )
        return { ...metadata, upstream_refs: [] };
      return metadata;
    });
    refused(replayScaP03HistoricalP02AuthorityV1(h.operands), "metadata_denied");
    expect(metadataReads).toBeGreaterThan(1);
    metadataSpy.mockRestore();
    const actualRead = ArtifactStore.prototype.read;
    let byteReads = 0;
    vi.spyOn(ArtifactStore.prototype, "read").mockImplementation(function (
      this: ArtifactStore,
      ref
    ) {
      const bytes = actualRead.call(this, ref);
      if (ref.artifact_id === h.operands.historical_authority_ref.artifact_id && ++byteReads > 1)
        return Buffer.from("changed-after-first-read");
      return bytes;
    });
    refused(replayScaP03HistoricalP02AuthorityV1(h.operands), "ref_mismatch");
    expect(byteReads).toBeGreaterThan(1);
  });

  it("refuses missing or foreign historical provenance with correctly sealed immutable bytes", () => {
    const f = setup();
    const h = historyFixture(f);
    for (const upstream of [
      [],
      [f.gateRef],
      [f.gateRef, f.qualificationRef, h.operands.historical_issuance_ref, f.snapshotRef],
    ]) {
      const substituted = h.write(
        `bad-lineage-${upstream.length}`,
        "sca-activation-authority",
        SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
        { ...h.authority },
        upstream
      );
      refused(
        replayScaP03HistoricalP02AuthorityV1({
          ...h.operands,
          historical_authority_ref: substituted,
        }),
        "metadata_denied"
      );
    }
  });

  it("refuses resealed historical scope changes, identity substitution, chronology and proposal mismatches", () => {
    const f = setup();
    for (const mutate of [
      (s: ScaActivationScopeV1) => ({ ...s, proposed_start_sha256: sha256("different-proposal") }),
      (s: ScaActivationScopeV1) => ({ ...s, qualification_run_id: "other-qualification-run" }),
      (s: ScaActivationScopeV1) => ({ ...s, activation_run_id: "other-activation-run" }),
      (s: ScaActivationScopeV1) => ({ ...s, phase_id: "SCA-P03" }),
      (s: ScaActivationScopeV1) => ({ ...s, production_playbook_name: "sca-p02-candidate" }),
      (s: ScaActivationScopeV1) => ({ ...s, qualification_ref: f.operational }),
      (s: ScaActivationScopeV1) => ({ ...s, gate_ref: f.operational }),
      (s: ScaActivationScopeV1) => ({ ...s, implementation_identity_ref: f.operational }),
      (s: ScaActivationScopeV1) => ({
        ...s,
        qualification_policy_data_sha256: sha256("changed-policy"),
      }),
      (s: ScaActivationScopeV1) => ({
        ...s,
        host_implementation_binding_sha256: sha256("changed-host"),
      }),
      (s: ScaActivationScopeV1) => ({
        ...s,
        operator_principal_id: f.snapshot.reviewer_identity_id,
      }),
      (s: ScaActivationScopeV1) => ({ ...s, issuer_policy_id: f.snapshot.reviewer_authority_id }),
      (s: ScaActivationScopeV1) => ({ ...s, issued_at: TIME[0] }),
    ]) {
      const h = historyFixture(f, mutate);
      refused(replayScaP03HistoricalP02AuthorityV1(h.operands), "historical_binding_denied");
    }
  });

  it("refuses issuance self-digest corruption and wrong authority/issuance relationship", () => {
    const f = setup();
    const h = historyFixture(f);
    const corrupted = h.write(
      "broken-issuance",
      "sca-activation-issuance",
      SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
      { ...h.issuance, issuance_sha256: sha256("wrong") },
      [f.gateRef, f.qualificationRef, h.authority.scope.implementation_identity_ref]
    );
    refused(
      replayScaP03HistoricalP02AuthorityV1({ ...h.operands, historical_issuance_ref: corrupted }),
      "historical_binding_denied"
    );
    const other = historyFixture(f, (s) => ({ ...s, nonce: "another-nonce" }));
    refused(
      replayScaP03HistoricalP02AuthorityV1({
        ...h.operands,
        historical_issuance_ref: other.operands.historical_issuance_ref,
      }),
      "historical_binding_denied"
    );
  });

  it("uses source guard refusals for altered recipes, gapped qualification, and cross-cohort inputs", () => {
    const f = setup();
    const h = historyFixture(f);
    refused(
      replayScaP03HistoricalP02AuthorityV1({ ...h.operands, accepted_p02_refs: [f.snapshotRef] }),
      "qualification_replay_denied"
    );
    const recipe = persist(
      f.store,
      "altered-source-recipe",
      SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
      SCA_P02_V3_AUTHORITY,
      { ...f.snapshot, definition_snapshot_sha256: sha256("wrong") },
      [f.gateRef],
      SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA
    );
    refused(
      replayScaP03HistoricalP02AuthorityV1({ ...h.operands, definition_ref: recipe }),
      "qualification_replay_denied"
    );
    const blocked = setup(["unresolved-required-evidence"]);
    const blockedHistory = historyFixture(blocked);
    refused(
      replayScaP03HistoricalP02AuthorityV1(blockedHistory.operands),
      "qualification_replay_denied"
    );
    // Blocked source guard itself is also the oracle, not a test-only positive callback.
    expect(blocked.check).toThrow();
  });

  it("bounds aggregate bytes, JSON bytes and unique refs before native byte reads", () => {
    const f = setup();
    const h = historyFixture(f);
    for (const limits of [
      { ...LIMITS, max_refs: 1 },
      { ...LIMITS, max_artifact_bytes: f.snapshotRef.byte_length - 1 },
      { ...LIMITS, max_json_bytes: f.snapshotRef.byte_length - 1 },
      { ...LIMITS, max_total_bytes: f.snapshotRef.byte_length - 1 },
    ])
      refused(replayScaP03HistoricalP02AuthorityV1({ ...h.operands, limits }), "budget_exceeded");
    const reads = vi.spyOn(ArtifactStore.prototype, "read");
    refused(
      replayScaP03HistoricalP02AuthorityV1({
        ...h.operands,
        limits: { ...LIMITS, max_json_bytes: 1 },
      }),
      "budget_exceeded"
    );
    expect(reads).not.toHaveBeenCalled();
    for (const bad of [
      { ...LIMITS, max_refs: 1025 },
      { ...LIMITS, max_json_bytes: 0 },
      { ...LIMITS, max_total_bytes: Number.MAX_SAFE_INTEGER },
      { ...LIMITS, unbounded: true },
    ])
      refused(
        replayScaP03HistoricalP02AuthorityV1({ ...h.operands, limits: bad }),
        "invalid_input"
      );
  });

  it("denies noncanonical, duplicate-key, invalid UTF-8, excessive nesting and malformed JSON", () => {
    const f = setup();
    const h = historyFixture(f);
    const metadata = f.store.metadata(f.snapshotRef);
    const payloads: (string | Buffer)[] = [
      JSON.stringify(f.snapshot, null, 2),
      '{"duplicate":1,"duplicate":1}',
      Buffer.from([0xff, 0xfe]),
      "[".repeat(65) + "0" + "]".repeat(65),
      '{"truncated":',
      "{}\n",
    ];
    for (const [index, content] of payloads.entries()) {
      const ref = f.store.persist({
        metadata: { ...metadata, operation_id: `invalid-json-${index}` },
        content,
      });
      refused(
        replayScaP03HistoricalP02AuthorityV1({ ...h.operands, definition_ref: ref }),
        index === 3 ? "budget_exceeded" : "noncanonical_json"
      );
    }
  });

  it("keeps current measurement separately callable and refuses an arbitrary freshness callback", () => {
    const f = setup();
    const h = historyFixture(f);
    const predecessor = fullOperands(f, h);
    const callback = vi.fn(() => ({ observed: true }));
    refused(
      measureScaP03PredecessorCurrentHostBindingV1({
        predecessor_inputs: predecessor,
        project_root: f.root,
        operational_summary_ref: f.operational,
        sampler: callback,
      }),
      "invalid_input"
    );
    expect(callback).not.toHaveBeenCalled();
    expect(
      measureScaP03PredecessorCurrentHostBindingV1({
        predecessor_inputs: predecessor,
        project_root: f.root,
      })
    ).toEqual({
      status: "missing_input",
      diagnostics: [{ code: "missing_input", operand: "operational_summary_ref" }],
    });
  });
});

function recordedRoot() {
  // Independent distinct manifest/config identities; use the real owner's pure image projection.
  const imageRef = `fixture/local-runtime@sha256:${sha256("manifest")}`;
  const image = scaP01JoernImageClosureV1(
    {
      Id: `sha256:${sha256("config-blob")}`,
      RepoDigests: [imageRef],
      Config: { Env: [], Volumes: null },
      RootFS: {
        Type: "layers",
        Layers: [`sha256:${sha256("layer-a")}`, `sha256:${sha256("layer-b")}`],
      },
      Os: "linux",
      Architecture: "amd64",
      Variant: null,
    },
    imageRef
  );
  const version = "4.1.2";
  const packages = [
    { component: "joern-cli", filename: `io.joern.joern-cli-${version}.jar` },
    { component: "php2cpg", filename: `io.joern.php2cpg-${version}.jar` },
    { component: "php2cpg", filename: `io.joern.php2cpg-${version}-launcher.jar` },
    { component: "jssrc2cpg", filename: `io.joern.jssrc2cpg-${version}.jar` },
    { component: "jssrc2cpg", filename: `io.joern.jssrc2cpg-${version}-launcher.jar` },
  ].map((p) => ({
    ...p,
    path_sha256: sha256(`inside-image:${p.filename}`),
    content_sha256: sha256(`package-bytes:${p.filename}`),
  }));
  return validateContract(
    ScaP01JoernRuntimeClosureV1Schema,
    {
      schema_id: "penny.sca-p01-joern-runtime-closure.v1",
      schema_version: 1,
      representation: "docker-local-runtime-closure",
      image_ref: imageRef,
      image,
      image_closure_sha256: sha256(canonicalJson(image)),
      docker_executable_sha256: sha256("docker-bytes"),
      docker_client_version: "29.1.1",
      docker_server_version: "29.1.1",
      package_root_sha256: sha256("image-package-root"),
      joern_version: version,
      packages,
      launcher: {
        path_sha256: sha256("launcher-path"),
        content_sha256: sha256("launcher"),
        help_sha256: sha256("recorded-help"),
        help_bytes: 32,
      },
      init: { path_sha256: sha256("init-path"), content_sha256: sha256("init-bytes") },
      confinement: {
        network: "none",
        readonly_rootfs: true,
        privileged: false,
        cap_drop: "ALL",
        no_new_privileges: true,
        uid: 1001,
        gid: 1001,
        memory_bytes: 1024 ** 3,
        cpus: 2,
        pids: 64,
        tmpfs_bytes: 64 * 1024 ** 2,
        inactivity_ms: 60000,
        max_command_output_bytes: 1024 ** 2,
      },
      cleanup: "verified-absent",
    },
    "recorded closure fixture"
  );
}
function toolchain(f: ReturnType<typeof setup>, twoComplete = false) {
  const tool = (id: string, languages: readonly string[], role = "parser") => ({
    tool_id: id,
    role,
    version: "4.1.2",
    executable_ref: f.operational,
    executable_sha256: f.operational.content_digest,
    measurement_receipt_ref: f.transition,
    languages,
    target_execution: "forbidden",
    network_access: "denied",
    acquisition: "preinstalled-only",
  });
  return validateScaToolchainIdentityV1({
    schema_id: "penny.sca-toolchain-identity.v1",
    schema_version: 1,
    toolchain_id: "fixture-toolchain",
    trust_status: "host-declared",
    status: "approved",
    analysis_profile_id: "fixture-profile",
    source_posture: "read-only",
    package_acquisition: "forbidden",
    target_startup: "forbidden",
    tools: [
      tool("generic-parser-with-no-name-keyword", ["javascript", "php", "typescript"]),
      tool(
        "joern-name-but-not-complete",
        twoComplete ? ["javascript", "php", "typescript"] : ["php"]
      ),
    ],
  });
}
describe("recorded root semantics and exclusive toolchain derivation", () => {
  it("selects only the unique complete parser or caller's explicit exact tool ID", () => {
    const f = setup();
    const t = toolchain(f);
    expect(selectScaP03PredecessorRootToolV1(t).tool_id).toBe(
      "generic-parser-with-no-name-keyword"
    );
    expect(
      selectScaP03PredecessorRootToolV1(t, "generic-parser-with-no-name-keyword").executable_ref
    ).toEqual(f.operational);
    expect(() => selectScaP03PredecessorRootToolV1(t, "joern-name-but-not-complete")).toThrow();
    try {
      selectScaP03PredecessorRootToolV1(toolchain(f, true));
      throw new Error("ambiguous root was silently selected");
    } catch (error) {
      expect(error).toMatchObject({ code: "missing_input", operand: "root_tool_id" });
    }
    expect(
      selectScaP03PredecessorRootToolV1(toolchain(f, true), "joern-name-but-not-complete").tool_id
    ).toBe("joern-name-but-not-complete");
    expect(() =>
      selectScaP03PredecessorRootToolV1(
        { ...t, tools: t.tools.map((tool) => ({ ...tool, tool_id: "duplicate-id" })) },
        "duplicate-id"
      )
    ).toThrow();
    const scanner = { ...t, tools: t.tools.map((tool) => ({ ...tool, role: "scanner" })) };
    expect(() => selectScaP03PredecessorRootToolV1(scanner)).toThrow();
  });
  it("retains every recorded pin and confinement value, without inferring manifest=config identity", () => {
    const root = recordedRoot();
    expect(validateScaP03RecordedRootClosureV1(root, root.joern_version)).toBe(root);
    expect(root.image_ref.split("@")[1]).not.toBe(root.image.image_id);
    expect(root.image_closure_sha256).toBe(sha256(canonicalJson(root.image)));
    expect(root.confinement.tmpfs_bytes).toBe(64 * 1024 ** 2);
    expect(root.cleanup).toBe("verified-absent");
  });
  it("rejects corrupt version, package, container, platform and image closure pins even after outer artifact rehash", () => {
    const root = recordedRoot();
    for (const invalid of [
      { ...root, joern_version: "5.0.0" },
      { ...root, extra: true },
      { ...root, cleanup: "unknown" },
      { ...root, image_ref: "mutable:tag" },
      { ...root, image_ref: `fixture/local-runtime:tag@sha256:${sha256("manifest")}` },
      { ...root, image_closure_sha256: sha256("wrong") },
      {
        ...root,
        image: { ...root.image, config_blob_sha256: sha256("different") },
        image_closure_sha256: sha256(
          canonicalJson({ ...root.image, config_blob_sha256: sha256("different") })
        ),
      },
      { ...root, image: { ...root.image, os: "windows" } },
      {
        ...root,
        packages: root.packages.map((p) =>
          p.component === "php2cpg" ? { ...p, filename: p.filename.replace("4.1.2", "4.1.3") } : p
        ),
      },
      { ...root, packages: root.packages.map((p) => ({ ...p, path_sha256: sha256("same-path") })) },
      { ...root, confinement: { ...root.confinement, network: "bridge" } },
      { ...root, confinement: { ...root.confinement, readonly_rootfs: false } },
      { ...root, confinement: { ...root.confinement, uid: 0 } },
      { ...root, confinement: { ...root.confinement, cpus: 17 } },
      { ...root, docker_client_version: "arbitrary-banner" },
    ])
      expect(() => validateScaP03RecordedRootClosureV1(invalid, "4.1.2")).toThrow();
    expect(() => validateScaP03RecordedRootClosureV1(root, "4.1.3")).toThrow();
  });
});

describe("proposal-approved exact read attenuation", () => {
  it("preserves the 1024 historical ceiling without widening the 512 native ceiling", () => {
    expect(
      validateContract(
        ScaP03PredecessorLimitsV1Schema,
        {
          max_refs: 1024,
          max_artifact_bytes: 67_108_864,
          max_json_bytes: 4_194_304,
          max_total_bytes: 268_435_456,
        },
        "historical limits"
      ).max_refs
    ).toBe(1024);
    expect(() =>
      validateContract(
        ScaP03PredecessorLimitsV1Schema,
        { max_refs: 1025, max_artifact_bytes: 1, max_json_bytes: 1, max_total_bytes: 1 },
        "historical limits"
      )
    ).toThrow();
  });
  it("guards direct operands before opening the store with spare approved capacity", () => {
    const f = setup();
    const h = historyFixture(f);
    const input = fullOperands(f, h);
    const approved = sorted([
      input.request_ref,
      input.transition_ref,
      input.definition_ref,
      input.gate_ref,
      input.qualification_ref,
      input.historical_authority_ref,
      f.operational,
    ]);
    const reads = vi.spyOn(ArtifactStore.prototype, "read"),
      byId = vi.spyOn(ArtifactStore.prototype, "readById"),
      bound = vi.spyOn(ArtifactStore.prototype, "assertBoundProject");
    const output = loadScaP03PredecessorInputsV1(
      { ...input, limits: deriveScaP03InitialCustodyV1(approved) },
      approved
    );
    refused(output, "ref_mismatch");
    expect(reads).not.toHaveBeenCalled();
    expect(byId).not.toHaveBeenCalled();
    expect(bound).not.toHaveBeenCalled();
  });
  it("denies unlisted typed, ID, coordinate and current-P02 secondary reads before native resolution", () => {
    const f = setup();
    const h = historyFixture(f);
    const forbidden = h.operands.definition_ref;
    const spare = persist(f.store, "spare-coordinate", "opaque", "host:test", {
      spare: "x".repeat(forbidden.byte_length + 1),
    });
    const approved = sorted([f.operational, f.transition, spare]);
    const reader = createScaP03ApprovedInputReaderV1(f.store, approved);
    const resolve = vi.spyOn(f.store, "refById"),
      read = vi.spyOn(f.store, "read"),
      byId = vi.spyOn(f.store, "readById"),
      coordinate = vi.spyOn(f.store, "refFor"),
      latest = vi.spyOn(f.store, "lastVersion");
    expect(() => reader.json(forbidden, "nested")).toThrow("unapproved_ref");
    expect(() => reader.readById(forbidden.artifact_id)).toThrow("unapproved_id");
    expect(() => reader.refById(forbidden.artifact_id)).toThrow("unapproved_id");
    expect(resolve).not.toHaveBeenCalled();
    expect(() =>
      reader.refFor(
        forbidden.run_id,
        forbidden.phase,
        forbidden.branch_id,
        forbidden.kind,
        forbidden.operation_id,
        forbidden.version
      )
    ).toThrow("unapproved_coordinate");
    expect(() =>
      reader.lastVersion(
        forbidden.run_id,
        forbidden.phase,
        forbidden.branch_id,
        forbidden.kind,
        forbidden.operation_id
      )
    ).toThrow("unapproved_coordinate");
    expect(coordinate).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(() =>
      measureScaP02CurrentHostBinding({
        store: f.store,
        artifact_reads: reader,
        project_root: f.root,
        operational_summary_ref: forbidden,
      })
    ).toThrow("unapproved_id");
    expect(read).not.toHaveBeenCalled();
    expect(byId).not.toHaveBeenCalled();
  });
  it("indexes every coordinate field but keeps native latest authoritative for approved prefixes", () => {
    const f = setup();
    const parent = persist(f.store, "coordinate-parent", "opaque", "host:test", { version: 1 });
    const revision = f.store.persist({
      metadata: { ...f.store.metadata(parent), version: 2, parent_ref: parent },
      content: canonicalJson({ version: 2 }),
    });
    const spare = persist(f.store, "spare-latest", "opaque", "host:test", {
      spare: "unused capacity".repeat(100),
    });
    const reader = createScaP03ApprovedInputReaderV1(f.store, sorted([parent, spare]));
    const coordinate = vi.spyOn(f.store, "refFor"),
      latest = vi.spyOn(f.store, "lastVersion"),
      read = vi.spyOn(f.store, "read");
    const prefix = [
      parent.run_id,
      parent.phase,
      parent.branch_id,
      parent.kind,
      parent.operation_id,
    ] as const;
    for (const foreign of [
      { ...parent, run_id: "foreign-run" },
      { ...parent, phase: "foreign-phase" },
      { ...parent, branch_id: "foreign-branch" },
      { ...parent, kind: "foreign-kind" },
      { ...parent, operation_id: "foreign-operation" },
    ]) {
      const foreignPrefix = [
        foreign.run_id,
        foreign.phase,
        foreign.branch_id,
        foreign.kind,
        foreign.operation_id,
      ] as const;
      expect(() => reader.refFor(...foreignPrefix, parent.version)).toThrow(
        "unapproved_coordinate"
      );
      expect(() => reader.lastVersion(...foreignPrefix)).toThrow("unapproved_coordinate");
    }
    expect(() => reader.refFor(...prefix, revision.version)).toThrow("unapproved_coordinate");
    expect(coordinate).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    // Version 2 is intentionally NOT approved: the allowlist must not invent latest=1.
    expect(reader.lastVersion(...prefix)).toBe(2);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith(...prefix);
    expect(reader.refFor(...prefix, parent.version)).toEqual(parent);
    expect(coordinate).toHaveBeenCalledTimes(1);
    expect(coordinate).toHaveBeenCalledWith(...prefix, parent.version);
    coordinate.mockReturnValue(spare);
    expect(() => reader.refFor(...prefix, parent.version)).toThrow("exact_ref");
    coordinate.mockReturnValue({ ...parent, producer: "host:forged" });
    expect(() => reader.refFor(...prefix, parent.version)).toThrow("unapproved_ref");
    coordinate.mockRestore();
    const parentCoordinate = vi.spyOn(f.store, "refFor");
    const complete = createScaP03ApprovedInputReaderV1(f.store, sorted([parent, revision, spare]));
    complete.readById(revision.artifact_id);
    expect(parentCoordinate).toHaveBeenCalledTimes(1);
    expect(parentCoordinate).toHaveBeenCalledWith(...prefix, parent.version);
    complete.finish();
    expect(read.mock.calls.filter(([ref]) => ref.artifact_id === parent.artifact_id)).toHaveLength(
      2
    );
    expect(
      read.mock.calls.filter(([ref]) => ref.artifact_id === revision.artifact_id)
    ).toHaveLength(2);
  });
  it("denies followed upstream and parent links, retains byte/metadata readback and never writes", () => {
    const f = setup();
    const child = persist(f.store, "unlisted-child", "opaque", "host:test", { child: true });
    const parent = persist(f.store, "parent-operation", "opaque", "host:test", { parent: 1 }, [
      child,
    ]);
    const spare = persist(f.store, "spare", "opaque", "host:test", {
      spare: "unused capacity".repeat(50),
    });
    const read = vi.spyOn(f.store, "read"),
      write = vi.spyOn(f.store, "persist"),
      select = vi.spyOn(f.store, "select");
    const refs = sorted([parent, spare]);
    const reader = createScaP03ApprovedInputReaderV1(f.store, refs);
    reader.readById(parent.artifact_id);
    expect(() => reader.finish()).toThrow("unapproved_ref");
    expect(read.mock.calls.some(([ref]) => ref.artifact_id === child.artifact_id)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    write.mockRestore();
    const revision = f.store.persist({
      metadata: {
        ...f.store.metadata(parent),
        version: 2,
        parent_ref: parent,
        upstream_refs: [parent],
      },
      content: canonicalJson({ parent: 2 }),
    });
    read.mockClear();
    const coordinate = vi.spyOn(f.store, "refFor"),
      latest = vi.spyOn(f.store, "lastVersion");
    const revisions = createScaP03ApprovedInputReaderV1(f.store, sorted([revision, spare]));
    expect(() => revisions.readById(revision.artifact_id)).toThrow("unapproved_ref");
    expect(coordinate).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    expect(read.mock.calls.some(([ref]) => ref.artifact_id === parent.artifact_id)).toBe(false);
    const complete = createScaP03ApprovedInputReaderV1(f.store, sorted([parent, child, spare]));
    complete.readById(parent.artifact_id);
    read.mockClear();
    complete.finish();
    expect(read.mock.calls.some(([ref]) => ref.artifact_id === parent.artifact_id)).toBe(true);
    const metadata = f.store.metadata(parent);
    vi.spyOn(f.store, "metadata").mockImplementation((ref) =>
      ref.artifact_id === parent.artifact_id ? { ...metadata, upstream_refs: [] } : metadata
    );
    expect(() => complete.finish()).toThrow("changed_provenance");
  });
});
