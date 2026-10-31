import {
  validateScaP03RequestV2,
  withScaP03Digest,
  scaP03P01BindingSha256,
  scaP03P02BindingSha256,
  scaP03RuntimeBindingSha256,
} from "../../dist/sca/p03-contracts.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach } from "vitest";

import { ArtifactStore } from "../../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../../dist/contracts.js";
import {
  SCA_P03_IMPLEMENTATION_SOURCE_PATHS,
  SCA_P03_QUALIFICATION_ARTIFACTS,
  SCA_P03_QUALIFICATION_CHECKS,
  SCA_P03_QUALIFICATION_CRITERION_IDS,
  buildScaP03CriterionDefinitionV1,
  buildScaP03ImplementationIdentityV1,
  buildScaP03QualificationEvidenceV1,
  createScaP03QualificationDefinitionV1,
} from "../../dist/sca/p03-qualification.js";
import {
  SCA_P03_V3_AUTHORITY,
  SCA_P03_V3_DEFINITION_SNAPSHOT_KIND,
  SCA_P03_V3_DEFINITION_SNAPSHOT_SCHEMA,
  SCA_P03_V3_GATE_KIND,
  requireScaP03AcceptedQualification,
} from "../../dist/sca/p03-qualification-guard.js";
import {
  SCA_PHASE_GATE_RECORD_V3_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
  SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
  sealScaPhaseReviewReceiptV1,
  sealScaPhaseReviewerAuthorityV1,
} from "../../dist/sca/qualification-gate-contracts.js";
import {
  evaluateScaPhaseGateV3,
  evaluateScaPhaseQualificationV3,
  inspectScaQualificationSubjectV1,
  type ScaArtifactContractV1,
} from "../../dist/sca/qualification-gate.js";

const RUN = "p03-v3-guard-run";
const TENANT = "tenant-p03-guard";
const PROJECT = "project-p03-guard";
const REVISION = "p03-v3-revision";
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
  phase = "SCA-P03"
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
export function setupScaP03QualificationFixture(
  options: {
    readonly gaps?: readonly string[];
    readonly hostBinding?: string;
    readonly sourceFiles?: Parameters<
      typeof buildScaP03ImplementationIdentityV1
    >[0]["source_files"];
  } = {}
) {
  const gaps = options.gaps ?? [];
  const hostBinding = options.hostBinding ?? HOST;
  const root = mkdtempSync(path.join(tmpdir(), "p03-p03-qualification-"));
  roots.push(root);
  const store = new ArtifactStore(path.join(root, "artifacts"), {
    projectId: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  stores.push(store);
  const formal = persist(store, "review", "agent-output", "agent:vera", { review: "independent" });
  const reviewer = {
    authority: "penny:sca-p03-independent-review-authority",
    identity: "agent:vera",
    lineage: formal.artifact_id,
  };
  const identity = buildScaP03ImplementationIdentityV1({
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    implementation_revision: REVISION,
    host_binding_sha256: hostBinding,
    implementer_identity_id: "p03-implementer",
    implementer_lineage_id: "p03-implementer-lineage",
    source_files:
      options.sourceFiles ??
      SCA_P03_IMPLEMENTATION_SOURCE_PATHS.map((file) => ({
        path: file,
        sha256: sha256(file),
        byte_length: Buffer.byteLength(file),
      })),
  });
  const identityRef = persist(
    store,
    "identity",
    SCA_P03_QUALIFICATION_ARTIFACTS.identity.artifact_kind,
    SCA_P03_QUALIFICATION_ARTIFACTS.identity.producer,
    identity,
    [],
    identity.schema_id
  );
  const operational = persist(
    store,
    "operational-gate",
    "sca-p03-gate",
    "host:sca-p03-candidate",
    { status: "passed" },
    [],
    "penny.sca-p03-gate.v1",
    1,
    "SCA-P03"
  );
  const transition = persist(
    store,
    "transition",
    "sca-p03-p04-transition",
    "host:sca-p03-candidate",
    { status: "nonterminal" },
    [operational],
    "penny.sca-p03-p04-transition.v2",
    2,
    "SCA-P03"
  );
  const p02Summary = persist(store, "p02-summary", "p02-summary", "host:test", { fixture: true });
  const summary = persist(
    store,
    "collector",
    "sca-p03-operational-qualification-input",
    "host:sca-p03-qualification-custodian",
    {
      schema_id: "penny.sca-p03-formal-collector-summary.v1",
      schema_version: 1,
      tenant_id: TENANT,
      project_id: PROJECT,
      run_id: RUN,
      status: "candidate_boundary_passed",
      aggregate_profile_sha256: sha256("profile"),
      gate_ref: operational,
      p04_transition_ref: transition,
      p02_operational_summary_ref: p02Summary,
      bootstrap_handoff_sha256: sha256("handoff"),
      bootstrap_proof_sha256: sha256("proof"),
      deployment_identity_sha256: sha256("deployment"),
    },
    [operational, transition, p02Summary],
    "penny.sca-p03-formal-collector-summary.v1",
    1,
    "SCA-P03"
  );
  const inputs = sorted([summary, formal]);
  const definitions = SCA_P03_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
    criterion_id,
    ref: persist(
      store,
      `criterion-${criterion_id}`,
      SCA_P03_QUALIFICATION_ARTIFACTS.definition.artifact_kind,
      SCA_P03_QUALIFICATION_ARTIFACTS.definition.producer,
      buildScaP03CriterionDefinitionV1({
        tenant_id: TENANT,
        project_id: PROJECT,
        run_id: RUN,
        implementation_revision: REVISION,
        criterion_id,
      }),
      [identityRef, ...inputs],
      SCA_P03_QUALIFICATION_ARTIFACTS.definition.schema_id
    ),
  }));
  const definitionRefs = {
    "AC-P03.baseline-queries": definitions[0]?.ref ?? identityRef,
    "AC-P03.graph-construction": definitions[1]?.ref ?? identityRef,
    "AC-P03.recovery-cancellation": definitions[2]?.ref ?? identityRef,
    "AC-P03.zero-model-ordering": definitions[3]?.ref ?? identityRef,
  };
  const contracts = {
    implementation_identity: descriptor(
      SCA_P03_QUALIFICATION_ARTIFACTS.identity.artifact_kind,
      SCA_P03_QUALIFICATION_ARTIFACTS.identity.schema_id,
      SCA_P03_QUALIFICATION_ARTIFACTS.identity.producer
    ),
    criterion_definition: descriptor(
      SCA_P03_QUALIFICATION_ARTIFACTS.definition.artifact_kind,
      SCA_P03_QUALIFICATION_ARTIFACTS.definition.schema_id,
      SCA_P03_QUALIFICATION_ARTIFACTS.definition.producer
    ),
    criterion_evidence: descriptor(
      SCA_P03_QUALIFICATION_ARTIFACTS.evidence.artifact_kind,
      SCA_P03_QUALIFICATION_ARTIFACTS.evidence.schema_id,
      SCA_P03_QUALIFICATION_ARTIFACTS.evidence.producer
    ),
    reviewer_authority: descriptor(
      "sca-p03-phase-reviewer-authority",
      SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
      "host:sca-p03-qualification-review-authority"
    ),
    reviewer_receipt: descriptor(
      "sca-p03-phase-review-receipt",
      SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
      "host:sca-p03-qualification-review-authority"
    ),
    qualification: descriptor(
      "sca-p03-phase-qualification-v3",
      SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
      SCA_P03_V3_AUTHORITY,
      3
    ),
    gate: descriptor(
      SCA_P03_V3_GATE_KIND,
      SCA_PHASE_GATE_RECORD_V3_SCHEMA,
      SCA_P03_V3_AUTHORITY,
      3
    ),
  };
  const binding = (ref: ArtifactRef) => {
    const metadata = store.metadata(ref);
    return { ref, parent_ref: metadata.parent_ref, upstream_refs: [...metadata.upstream_refs] };
  };
  const definition = createScaP03QualificationDefinitionV1({
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    implementation_revision: REVISION,
    current_host_binding_sha256: hostBinding,
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
  const evidence = SCA_P03_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
    criterion_id,
    evidence_refs: [
      persist(
        store,
        `evidence-${criterion_id}`,
        contracts.criterion_evidence.artifact_kind,
        contracts.criterion_evidence.producer,
        buildScaP03QualificationEvidenceV1({
          tenant_id: TENANT,
          project_id: PROJECT,
          run_id: RUN,
          implementation_revision: REVISION,
          host_binding_sha256: hostBinding,
          implementer_identity_id: "p03-implementer",
          implementer_lineage_id: "p03-implementer-lineage",
          criterion_id,
          subject_sha256: subject.subject_sha256,
          supporting_refs: inputs,
          observations: SCA_P03_QUALIFICATION_CHECKS[criterion_id].map((check_id) => ({
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
    phase_id: "SCA-P03",
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
      receipt_id: "p03-review-receipt",
      ...reviewFields,
      reviewer_authority_ref: authority,
      criterion_results: SCA_P03_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
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
    schema_id: SCA_P03_V3_DEFINITION_SNAPSHOT_SCHEMA,
    schema_version: 1 as const,
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    phase_id: "SCA-P03" as const,
    implementation_revision: REVISION,
    required_assurance_scope: "host_derived_binding" as const,
    current_host_binding_sha256: hostBinding,
    current_source_manifest_sha256: identity.source_manifest_sha256,
    max_unique_artifact_bytes: 16 * 1_048_576,
    max_json_artifact_bytes: 4 * 1_048_576,
    reviewer_authority_id: reviewer.authority,
    reviewer_identity_id: reviewer.identity,
    reviewer_lineage_id: reviewer.lineage,
    source_policy_module: "apps/orchestration/src/sca/p03-qualification.ts" as const,
    criterion_ids: [...SCA_P03_QUALIFICATION_CRITERION_IDS],
    contracts,
    implementation_identity: binding(identityRef),
    qualified_inputs: inputs.map(binding),
    operational_cohort: { summary_ref: summary, gate_ref: operational, transition_ref: transition },
    criterion_definition_refs: definitionRefs,
    reviewer_authority_ref: authority,
    reviewer_receipt_ref: receipt,
    formal_review_ref: formal,
    qualification_ref: qualificationRef,
    gate_ref: gateRef,
    subject_sha256: subject.subject_sha256,
    activation_performed: false as const,
    registration_performed: false as const,
    p04_admission_performed: false as const,
  };
  const snapshot = { ...unsigned, definition_snapshot_sha256: sha256(canonicalJson(unsigned)) };
  const provenance = [gateRef, qualificationRef, authority, receipt, formal];
  const snapshotRef = persist(
    store,
    "snapshot",
    SCA_P03_V3_DEFINITION_SNAPSHOT_KIND,
    SCA_P03_V3_AUTHORITY,
    snapshot,
    provenance,
    SCA_P03_V3_DEFINITION_SNAPSHOT_SCHEMA
  );
  const check = (
    ref = snapshotRef,
    gate_ref = gateRef,
    cohort = { summary_ref: summary, gate_ref: operational, transition_ref: transition }
  ) =>
    requireScaP03AcceptedQualification({
      store,
      definition_ref: ref,
      gate_ref,
      tenant_id: TENANT,
      project_id: PROJECT,
      operational_summary_ref: cohort.summary_ref,
      operational_gate_ref: cohort.gate_ref,
      p04_transition_ref: cohort.transition_ref,
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
      SCA_P03_V3_DEFINITION_SNAPSHOT_KIND,
      SCA_P03_V3_AUTHORITY,
      { ...payload, definition_snapshot_sha256: sha256(canonicalJson(payload)) },
      provenance,
      SCA_P03_V3_DEFINITION_SNAPSHOT_SCHEMA
    );
    return () => check(newRef);
  };
  return {
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
    summary,
    p02Summary,
    root,
    tenant: TENANT,
    project: PROJECT,
    run: RUN,
    check,
    altered,
  };
}

/** Structurally valid request for isolated host tests; it is never operationally admitted. */
export function fixtureScaP03Request(f: ReturnType<typeof setupScaP03QualificationFixture>) {
  const dummy = (
    name: string,
    kind = `sca-${name}`,
    schema = `penny.sca-${name}.v1`,
    producer = "host:test",
    phase = "SCA-P03"
  ) =>
    persist(
      f.store,
      `request-${name}`,
      kind,
      producer,
      { fixture: name },
      [],
      schema,
      schema.endsWith(".v3") ? 3 : schema.endsWith(".v2") ? 2 : 1,
      phase
    );
  const p01 = {
    request_ref: dummy("p01-request"),
    obligation_ledger_ref: dummy("p01-ledger"),
    campaign_manifest_core_ref: dummy("p01-core"),
    admission_evidence_ref: dummy("p01-admission"),
    p01_gate_ref: dummy("p01-gate"),
    campaign_manifest_ref: dummy("p01-manifest"),
    frozen_refs: [dummy("p01-frozen")],
  };
  const p02 = {
    transition_ref: dummy("p02-transition"),
    p02_request_ref: dummy("p02-request"),
    gate_ref: dummy("p02-gate"),
    m1_ref: dummy("p02-m1"),
    coverage_matrix_ref: dummy("p02-coverage"),
    evidence_manifest_ref: dummy("p02-manifest"),
    successor_ledger_ref: dummy("p02-ledger"),
    evidence_refs: Array.from({ length: 26 }, (_, i) => dummy(`p02-evidence-${i}`)),
    qualification_definition_ref: dummy(
      "p02-definition",
      "sca-p02-v3-definition-snapshot",
      "penny.sca-p02-v3-definition-snapshot.v1",
      "host:sca-p02-qualification-authority",
      "SCA-P02"
    ),
    qualification_gate_ref: dummy(
      "p02-formal-gate",
      "sca-p02-phase-gate-v3",
      "penny.sca-phase-gate-record.v3",
      "host:sca-p02-qualification-authority",
      "SCA-P02"
    ),
  };
  const p03 = (name: string, kind: string, schema: string, producer: string) =>
    dummy(name, kind, schema, producer);
  const qualificationAuthority = "host:sca-p03-qualification-authority";
  const queryAuthority = "host:sca-p03-query-authority";
  const source = dummy("source");
  const base = {
    schema_id: "penny.sca-p03-request.v2" as const,
    schema_version: 2 as const,
    tenant_id: f.tenant,
    project_id: f.project,
    run_id: f.run,
    phase_id: "SCA-P03" as const,
    accepted_p01: p01,
    accepted_p02: p02,
    source_snapshot_ref: source,
    source_snapshot_sha256: source.content_digest,
    runtime_policy_ref: p03(
      "runtime-policy",
      "sca-p03-runtime-policy",
      "penny.sca-p03-runtime-policy.v1",
      "host:sca-p03-runtime-policy"
    ),
    joern_runtime_identity_ref: p03(
      "runtime-identity",
      "sca-p03-joern-runtime-identity",
      "penny.sca-p03-joern-runtime-identity.v1",
      "host:sca-p03-runtime-identity"
    ),
    isolation_evidence_ref: p03(
      "isolation",
      "sca-p03-isolation-evidence",
      "penny.sca-p03-isolation-evidence.v1",
      "host:sca-p03-isolation-qualification"
    ),
    host_isolation_attestation_ref: p03(
      "attestation",
      "sca-p03-host-isolation-attestation",
      "penny.sca-p03-host-isolation-attestation.v1",
      "host:sca-p03-isolation-qualification"
    ),
    implementation_identity_ref: p03(
      "implementation",
      "sca-p03-implementation-identity",
      "penny.sca-p03-implementation-identity.v1",
      "host:sca-p03-implementation-identity"
    ),
    qualification_profile_ref: p03(
      "profile",
      "sca-p03-qualification-profile",
      "penny.sca-p03-qualification-profile.v2",
      qualificationAuthority
    ),
    fixture_corpus_ref: p03(
      "corpus",
      "sca-p03-qualification-fixture-corpus",
      "penny.sca-p03-qualification-fixture-corpus.v2",
      qualificationAuthority
    ),
    source_oracle_ref: p03(
      "oracle",
      "sca-p03-source-oracle",
      "penny.sca-p03-source-oracle.v2",
      "host:sca-p03-source-oracle-authority"
    ),
    source_oracle_validation_ref: p03(
      "oracle-receipt",
      "sca-p03-source-oracle-validation",
      "penny.sca-p03-source-oracle-validation.v1",
      "host:sca-p03-source-oracle-validator"
    ),
    fixture_content_refs: Array.from({ length: 3 }, (_, i) =>
      p03(
        `fixture-${i}`,
        "sca-p03-qualification-fixture-content",
        "penny.sca-p03-qualification-fixture-content.v1",
        qualificationAuthority
      )
    ),
    fidelity_complement_refs: [],
    baseline_query_set_ref: p03(
      "query-set",
      "sca-p03-baseline-query-set",
      "penny.sca-p03-baseline-query-set.v2",
      queryAuthority
    ),
    query_script_refs: Array.from({ length: 7 }, (_, i) =>
      p03(`script-${i}`, "sca-p03-query-script", "penny.sca-p03-query-script.v2", queryAuthority)
    ),
    query_plan_refs: Array.from({ length: 7 }, (_, i) =>
      p03(`plan-${i}`, "sca-p03-query-plan", "penny.sca-p03-query-plan.v2", queryAuthority)
    ),
    runtime_package_refs: [dummy("package")],
    requested_at: "2026-09-26T00:03:00Z",
  };
  return validateScaP03RequestV2(
    withScaP03Digest(
      {
        ...base,
        p01_binding_sha256: scaP03P01BindingSha256(base),
        p02_binding_sha256: scaP03P02BindingSha256(base),
        p03_runtime_binding_sha256: scaP03RuntimeBindingSha256(base),
      },
      "request_sha256"
    )
  );
}
export { persist as persistScaP03FixtureJson };
