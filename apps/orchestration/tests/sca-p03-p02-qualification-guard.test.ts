import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import {
  SCA_P02_IMPLEMENTATION_SOURCE_PATHS,
  SCA_P02_QUALIFICATION_ARTIFACTS,
  SCA_P02_QUALIFICATION_CHECKS,
  SCA_P02_QUALIFICATION_CRITERION_IDS,
  buildScaP02CriterionDefinitionV1,
  buildScaP02ImplementationIdentityV1,
  buildScaP02QualificationEvidenceV1,
  createScaP02QualificationDefinitionV1,
} from "../dist/sca/p02-qualification.js";
import {
  admitScaP03Candidate,
  scaP03InputArtifacts,
  ScaP03AdmissionError,
} from "../dist/sca/p03-admission.js";
import {
  scaP03P01BindingSha256,
  scaP03P02BindingSha256,
  scaP03RuntimeBindingSha256,
  validateScaP03RequestV2,
  withScaP03Digest,
} from "../dist/sca/p03-contracts.js";
import {
  admitScaP04Candidate,
  scaP04InputArtifacts,
  ScaP04AdmissionError,
} from "../dist/sca/p04-admission.js";
import { createScaP04Request } from "../dist/sca/p04-admission.js";
import { SCA_P04_REQUIRED_MODEL } from "../dist/sca/p04-contracts.js";
import {
  SCA_P02_V3_AUTHORITY,
  SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
  SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA,
  SCA_P02_V3_GATE_KIND,
  requireScaP03AcceptedP02Qualification,
} from "../dist/sca/p03-p02-qualification-guard.js";
import {
  SCA_PHASE_GATE_RECORD_V3_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
  SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
  sealScaPhaseReviewReceiptV1,
  sealScaPhaseReviewerAuthorityV1,
} from "../dist/sca/qualification-gate-contracts.js";
import {
  evaluateScaPhaseGateV3,
  evaluateScaPhaseQualificationV3,
  inspectScaQualificationSubjectV1,
  type ScaArtifactContractV1,
} from "../dist/sca/qualification-gate.js";

const RUN = "p02-v3-guard-run";
const TENANT = "tenant-p03-guard";
const PROJECT = "project-p03-guard";
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
function setup(gaps: readonly string[] = []) {
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
    "penny.sca-p02-p03-transition.v1"
  );
  const candidate = (operation: string, kind: string, schema: string, version = 1) =>
    persist(store, operation, kind, "host:sca-p02-candidate", { operation }, [], schema, version);
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
      candidate(`evidence-${i}`, "sca-p02-proof", "penny.sca-p02-proof.v1")
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
  const definitionRefs = {
    "p02-containment-egress-and-minimization": definitions[0]?.ref ?? identityRef,
    "p02-current-predecessor-and-implementation": definitions[1]?.ref ?? identityRef,
    "p02-required-variants-and-lifecycle": definitions[2]?.ref ?? identityRef,
    "p02-six-operation-deterministic-coverage": definitions[3]?.ref ?? identityRef,
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

describe("inactive P03 P02 V3 qualification guard", () => {
  it("replays a fully persisted passed V3 closure and binds the operational cohort", () => {
    const f = setup();
    expect(f.check().subject_sha256).toBe(f.snapshot.subject_sha256);
    expect(f.check().gate_ref).toEqual(f.gateRef);
    expect(() => f.check(f.snapshotRef, f.operational)).toThrow();
    expect(() => f.check(f.snapshotRef, f.gateRef, [f.operational, f.qualificationRef])).toThrow();
    expect(() =>
      f.check(f.snapshotRef, f.gateRef, [{ ...f.operational, content_digest: sha256("spoof") }])
    ).toThrow();
  });

  it("maps a cross-cohort qualification failure to invalid_p02_binding before P02 replay", () => {
    const f = setup();
    const dummy = (
      name: string,
      kind = `sca-${name}`,
      schema = `penny.sca-${name}.v1`,
      producer = "host:p03-test"
    ) =>
      persist(
        f.store,
        `p03-${name}`,
        kind,
        producer,
        { name },
        [],
        schema,
        schema.endsWith(".v2") ? 2 : 1
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
      ...f.operationalCohort,
      qualification_definition_ref: f.snapshotRef,
      qualification_gate_ref: f.gateRef,
      evidence_refs: [...f.operationalCohort.evidence_refs.slice(0, -1), dummy("foreign-cohort")],
    };
    const p03 = (name: string, kind: string, schema: string, producer: string) =>
      dummy(name, kind, schema, producer);
    const queryAuthority = "host:sca-p03-query-authority";
    const qualificationAuthority = "host:sca-p03-qualification-authority";
    const base = {
      schema_id: "penny.sca-p03-request.v2" as const,
      schema_version: 2 as const,
      tenant_id: TENANT,
      project_id: PROJECT,
      run_id: "p03-guard-run",
      phase_id: "SCA-P03" as const,
      accepted_p01: p01,
      accepted_p02: p02,
      source_snapshot_ref: dummy("source"),
      source_snapshot_sha256: sha256(canonicalJson({ name: "source" })),
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
      host_isolation_attestation_ref: null,
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
      requested_at: TIME[3],
    };
    const request = validateScaP03RequestV2(
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
    try {
      admitScaP03Candidate({
        store: f.store,
        request,
        input_artifacts: scaP03InputArtifacts(request),
        trusted_clock: () => new Date(TIME[3]),
      });
      throw new Error("P03 unexpectedly admitted a cross-cohort qualification");
    } catch (error) {
      expect(error).toBeInstanceOf(ScaP03AdmissionError);
      if (!(error instanceof ScaP03AdmissionError)) throw error;
      expect(`${error.code}: ${error.message}`).toBe(
        "invalid_p02_binding: P03 requires the exact accepted P02 V3 qualification"
      );
    }
    // A P04 transition cannot turn this same failed P03 request into accepted lineage.
    const p03Output = (name: string, kind: string, schema: string, value: unknown = { name }) =>
      persist(
        f.store,
        `output-${name}`,
        kind,
        "host:sca-p03-candidate",
        value,
        [],
        schema,
        schema.endsWith(".v2") ? 2 : 1,
        "SCA-P03"
      );
    const p03RequestRef = p03Output(
      "request",
      "sca-p03-candidate-request",
      "penny.sca-p03-request.v2",
      request
    );
    const transition = withScaP03Digest(
      {
        schema_id: "penny.sca-p03-p04-transition.v2",
        schema_version: 2,
        tenant_id: TENANT,
        project_id: PROJECT,
        run_id: RUN,
        phase_id: "SCA-P03",
        p01_binding_sha256: request.p01_binding_sha256,
        p02_binding_sha256: request.p02_binding_sha256,
        p03_runtime_binding_sha256: request.p03_runtime_binding_sha256,
        source_snapshot_ref: request.source_snapshot_ref,
        source_snapshot_sha256: request.source_snapshot_sha256,
        from_phase_id: "SCA-P03",
        to_phase_id: "SCA-P04",
        p03_request_ref: p03RequestRef,
        source_oracle_ref: request.source_oracle_ref,
        source_oracle_validation_ref: request.source_oracle_validation_ref,
        p02_m1_ref: p02.m1_ref,
        p02_evidence_manifest_ref: p02.evidence_manifest_ref,
        entry_admission_ref: p03Output(
          "entry",
          "sca-p03-entry-admission",
          "penny.sca-p03-entry-admission.v2"
        ),
        qualification_record_ref: p03Output(
          "qualification",
          "sca-p03-qualification-record",
          "penny.sca-p03-qualification-record.v2"
        ),
        graph_manifest_ref: p03Output(
          "graph-manifest",
          "sca-p03-graph-manifest",
          "penny.sca-p03-graph-manifest.v1"
        ),
        graph_support_matrix_ref: p03Output(
          "graph-support",
          "sca-p03-graph-support-matrix",
          "penny.sca-p03-graph-support-matrix.v2"
        ),
        baseline_query_aggregate_ref: p03Output(
          "query-aggregate",
          "sca-p03-baseline-query-aggregate",
          "penny.sca-p03-baseline-query-aggregate.v2"
        ),
        candidate_packet_ref: p03Output(
          "packet",
          "sca-p03-graph-candidate-packet",
          "penny.sca-p03-graph-candidate-packet.v2"
        ),
        coverage_matrix_ref: p03Output(
          "coverage",
          "sca-p03-coverage-matrix",
          "penny.sca-p03-coverage-matrix.v1"
        ),
        evidence_manifest_ref: p03Output(
          "manifest",
          "sca-p03-evidence-manifest",
          "penny.sca-p03-evidence-manifest.v2"
        ),
        successor_ledger_ref: p03Output(
          "ledger",
          "sca-p03-successor-obligation-ledger",
          "penny.sca-p03-successor-obligation-ledger.v1"
        ),
        zero_model_evidence_ref: p03Output(
          "zero-model",
          "sca-p03-zero-model-evidence",
          "penny.sca-p03-zero-model-evidence.v1"
        ),
        gate_ref: p03Output("gate", "sca-p03-gate", "penny.sca-p03-gate.v1"),
        p04_entry_authorized: true,
        campaign_terminal: false,
        release_eligible: false,
        transitioned_at: TIME[3],
      },
      "transition_sha256"
    );
    const transitionRef = p03Output(
      "transition",
      "sca-p03-p04-transition",
      "penny.sca-p03-p04-transition.v2",
      transition
    );
    const p04 = (name: string, kind: string, schema: string, value: unknown) =>
      persist(
        f.store,
        `p04-${name}`,
        kind,
        "host:sca-p04-candidate",
        value,
        [],
        schema,
        1,
        "SCA-P04"
      );
    const identityRef = p04(
      "identity",
      "sca-p04-implementation-identity",
      "penny.sca-p04-implementation-identity.v1",
      {
        schema_id: "penny.sca-p04-implementation-identity.v1",
        schema_version: 1,
        phase_id: "SCA-P04",
        implementation_revision: "p04-revision",
        contracts_sha256: sha256("contracts"),
        prompts_sha256: sha256("prompts"),
        identity_scope: "caller_declaration_not_runtime_attestation",
        host_issued: true,
        required_model: SCA_P04_REQUIRED_MODEL,
      }
    );
    const policyRef = p04("policy", "sca-p04-runtime-policy", "penny.sca-p04-runtime-policy.v1", {
      schema_id: "penny.sca-p04-runtime-policy.v1",
      schema_version: 1,
      phase_id: "SCA-P04",
      qualification_scope: "live_only",
      max_population_items: 100,
      max_payload_bytes_per_call: 1_000_000,
      max_selected_items: 10,
      specialist_count: 2,
      independent_contexts_required: true,
      semantic_reconciliation_call: false,
      required_tools: [],
      required_model: SCA_P04_REQUIRED_MODEL,
      host_issued: true,
    });
    const p04Request = createScaP04Request({
      tenant_id: TENANT,
      project_id: PROJECT,
      run_id: RUN,
      p03_transition_ref: transitionRef,
      implementation_identity_ref: identityRef,
      runtime_policy_ref: policyRef,
      requested_at: TIME[3],
    });
    try {
      admitScaP04Candidate({
        store: f.store,
        request: p04Request,
        input_artifacts: scaP04InputArtifacts(p04Request),
        trusted_clock: () => new Date(TIME[3]),
      });
      throw new Error("P04 unexpectedly bypassed the failed P03 qualification guard");
    } catch (error) {
      expect(error).toBeInstanceOf(ScaP04AdmissionError);
      if (!(error instanceof ScaP04AdmissionError)) throw error;
      expect(error.code).toBe("cross_cohort_substitution");
      expect(error.message).toContain(
        "P03 persisted request upstream closure differs from admitted inputs"
      );
    }
  });

  it("rejects re-digested budget, contract, flag, source, reviewer, gate, subject and ref-set changes", () => {
    const f = setup();
    const s = f.snapshot;
    for (const change of [
      () => ({ ...s, extra: true }),
      () => ({ ...s, max_unique_artifact_bytes: 32 * 1_048_576 }),
      () => ({ ...s, max_json_artifact_bytes: 1_048_576 }),
      () => ({
        ...s,
        contracts: { ...s.contracts, gate: { ...s.contracts.gate, producer: "host:impostor" } },
      }),
      () => ({ ...s, activation_performed: true }),
      () => ({ ...s, registration_performed: true }),
      () => ({ ...s, p03_admission_performed: true }),
      () => ({ ...s, source_policy_module: "../escape" }),
      () => ({ ...s, reviewer_lineage_id: "impostor" }),
      () => ({ ...s, current_host_binding_sha256: sha256("stale") }),
      () => ({ ...s, current_source_manifest_sha256: sha256("stale") }),
      () => ({ ...s, implementation_revision: "stale" }),
      () => ({ ...s, gate_ref: f.operational }),
      () => ({ ...s, qualification_ref: f.operational }),
      () => ({ ...s, formal_review_ref: f.operational }),
      () => ({ ...s, reviewer_receipt_ref: f.operational }),
      () => ({ ...s, subject_sha256: sha256("other") }),
      () => ({ ...s, qualified_inputs: [...s.qualified_inputs].reverse() }),
      () => ({ ...s, qualified_inputs: [...s.qualified_inputs, s.qualified_inputs[0]] }),
      () => ({
        ...s,
        criterion_definition_refs: {
          ...s.criterion_definition_refs,
          "p02-required-variants-and-lifecycle": f.operational,
        },
      }),
      () => ({
        ...s,
        implementation_identity: { ...s.implementation_identity, upstream_refs: [f.operational] },
      }),
    ]) {
      expect(f.altered(change)).toThrow();
    }
  });

  it("rejects blocked/gapped V3 gates and stale or wrong upstream closure", () => {
    const blocked = setup(["outstanding"]);
    expect(() => blocked.check()).toThrow();
    const f = setup();
    const wrongProvenance = persist(
      f.store,
      "wrong-snapshot",
      SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
      SCA_P02_V3_AUTHORITY,
      f.snapshot,
      [f.operational],
      SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA
    );
    expect(() => f.check(wrongProvenance)).toThrow();
    const foreign = persist(f.store, "foreign-provenance", "foreign-evidence", "host:foreign", {
      foreign: true,
    });
    const splicedProvenance = persist(
      f.store,
      "spliced-snapshot",
      SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
      SCA_P02_V3_AUTHORITY,
      f.snapshot,
      [f.gateRef, f.qualificationRef, f.authority, f.receipt, f.formal, foreign],
      SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA
    );
    expect(() => f.check(splicedProvenance)).toThrow();
    const gateMetadata = f.store.metadata(f.gateRef);
    f.store.persist({
      metadata: {
        ...gateMetadata,
        version: 2,
        parent_ref: f.gateRef,
        upstream_refs: [f.qualificationRef],
      },
      content: canonicalJson({ supersedes: f.gateRef.artifact_id }),
    });
    expect(() => f.check()).toThrow(/current revision/u);
    const stale = {
      ...f.snapshot,
      qualified_inputs: f.snapshot.qualified_inputs.map((item, index) =>
        index === 0 ? { ...item, ref: { ...item.ref, version: item.ref.version + 1 } } : item
      ),
    };
    expect(f.altered(() => stale)).toThrow();
  });
});
