import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateContract, type ArtifactRef } from "../dist/contracts.js";
import { SCA_P02_PHASE_REGISTRATION } from "../dist/sca/p02-playbook.js";
import { ScaP02V3DefinitionSnapshotSchema } from "../dist/sca/p03-p02-qualification-guard.js";
import * as predecessorGuard from "../dist/sca/p03-p02-qualification-guard.js";
import * as formalGuard from "../dist/sca/p03-qualification-guard.js";
import * as activation from "../dist/sca/qualification-activation.js";
import * as operational from "../dist/sca/p03-operational-replay.js";
import {
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_KIND,
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_OPERATION_ID,
} from "../dist/sca/p03-bootstrap-contracts.js";
import {
  SCA_P03_QUERY_IDS,
  scaP03QualificationObservationSha256V2,
  withScaP03Digest,
} from "../dist/sca/p03-contracts.js";
import {
  createScaP03ActivationHostV1,
  measureScaP03CurrentHostBinding,
  type ScaP03CurrentBootstrapSampleV1,
  type ScaP03CurrentHostInputV1,
} from "../dist/sca/p03-activation-host.js";
import { SCA_P03_IMPLEMENTATION_SOURCE_PATHS } from "../dist/sca/p03-qualification.js";
import { SCA_P03_PHASE_REGISTRATION } from "../dist/sca/p03-playbook.js";
import {
  setupScaP03QualificationFixture,
  fixtureScaP03Request,
  persistScaP03FixtureJson,
} from "./helpers/sca-p03-qualification-fixture.js";

afterEach(() => vi.restoreAllMocks());

// Host unit fixture: operational/P02 replay and durable P02 authority are separately qualified
// boundaries and are injected here. Bootstrap contracts/custody/proof hashing and fixed source
// measurement below are real. No fixture is a live qualification or an activation.
function hostFixture() {
  const f = setupScaP03QualificationFixture();
  let request = fixtureScaP03Request(f);
  const persist = (
    operation: string,
    kind: string,
    producer: string,
    value: unknown,
    schema: string,
    upstream: readonly ArtifactRef[] = []
  ) =>
    persistScaP03FixtureJson(
      f.store,
      operation,
      kind,
      producer,
      value,
      upstream,
      schema,
      Number(schema.slice(-1)),
      "SCA-P03"
    );
  const dummy = (name: string) =>
    persist(
      name,
      `sca-p03-${name}`,
      "host:test-bootstrap",
      { fixture: name },
      `penny.sca-p03-${name}.v1`
    );
  const attempt = dummy("attempt");
  const cleanup = dummy("cleanup");
  const isolation = dummy("isolation");
  const sources = [dummy("implementation-source")];
  const deployment = sha256("deployment");
  const release = sha256("release");
  const profile = sha256("profile");
  const attestation = persist(
    "real-attestation",
    "sca-p03-host-isolation-attestation",
    "host:sca-p03-isolation-qualification",
    {
      schema_id: "penny.sca-p03-host-isolation-attestation.v1",
      schema_version: 1,
      attestation_id: "test-attestation",
      source_oracle_ref: request.source_oracle_ref,
      source_oracle_validation_ref: request.source_oracle_validation_ref,
      parser_identity_sha256: sha256("parser"),
      runtime_kind: "host_qualified_joern",
      runtime_id: "test-runtime",
      isolation_id: "test-isolation",
      implementation_identity_sha256: sha256("implementation"),
      deployment_identity_sha256: deployment,
      profile_id: "test-profile",
      profile_sha256: profile,
      runtime_tree_sha256: sha256("runtime-tree"),
      qualification_scope: "live_qualified",
      qualified: true,
      attested_at: "2026-09-26T00:00:00Z",
    },
    "penny.sca-p03-host-isolation-attestation.v1"
  );
  request = { ...request, host_isolation_attestation_ref: attestation };
  const observations = (["php", "javascript", "typescript"] as const).flatMap((language) =>
    SCA_P03_QUERY_IDS.map((query_id) => {
      const core = {
        fixture_id: null,
        fixture_sha256: null,
        query_id,
        frontend_language: language === "php" ? ("PHP" as const) : ("JSSRC" as const),
        release_sha256: release,
        blocker_code: null,
        observations: [],
      };
      return {
        case_id: `${language}-${query_id}`,
        language,
        query_id,
        frontend_language: core.frontend_language,
        status: "passed",
        blocker_code: null,
        fixture_id: null,
        fixture_sha256: null,
        observation_count: 0,
        observations: [],
        observed_sha256: scaP03QualificationObservationSha256V2(core),
      };
    })
  );
  const recordBody = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-bootstrap-qualification-record.v3",
      schema_version: 3,
      evidence_class: "live",
      fixture_corpus_ref: request.fixture_corpus_ref,
      source_oracle_ref: request.source_oracle_ref,
      source_oracle_validation_ref: request.source_oracle_validation_ref,
      source_oracle_review_ref: dummy("oracle-review"),
      parser_identity_sha256: sha256("parser"),
      baseline_query_set_ref: request.baseline_query_set_ref,
      qualification_profile_ref: request.qualification_profile_ref,
      runtime_policy_ref: request.runtime_policy_ref,
      implementation_identity_ref: request.implementation_identity_ref,
      runtime_identity_ref: request.joern_runtime_identity_ref,
      cleanup_evidence_ref: cleanup,
      host_isolation_evidence_ref: isolation,
      fixture_content_refs: request.fixture_content_refs,
      query_script_refs: request.query_script_refs,
      query_plan_refs: request.query_plan_refs,
      runtime_package_refs: request.runtime_package_refs,
      runtime_id: "test-runtime",
      isolation_id: "test-isolation",
      runtime_tree_sha256: sha256("runtime-tree"),
      joern_version: "4.0.627",
      max_num_def: 100,
      implementation_identity_sha256: sha256("implementation"),
      deployment_identity_sha256: deployment,
      profile_id: "test-profile",
      profile_sha256: profile,
      release_id: "test-release",
      release_sha256: release,
      executed_query_release_sha256: release,
      observations,
      exact_expected_observations: true,
      cleanup_verified: true,
      host_isolation_verified: true,
      evaluated_at: "2026-09-26T00:00:00Z",
      attempt_witness_ref: attempt,
      implementation_closure_sha256: sha256("implementation-closure"),
      runtime_package_closure_sha256: sha256("packages"),
      implementation_source_refs: sources,
    },
    "record_sha256"
  );
  const record = persist(
    "bootstrap-record",
    "sca-p03-bootstrap-record",
    "host:sca-p03-bootstrap-evaluator",
    recordBody,
    recordBody.schema_id,
    [attempt, cleanup, isolation]
  );
  const external = dummy("external-review");
  const receiptBody = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-bootstrap-reviewer-receipt.v2",
      schema_version: 2,
      external_review_id: "test-external",
      external_review_ref: external,
      record_ref: record,
      attempt_ref: attempt,
      cleanup_ref: cleanup,
      isolation_ref: isolation,
      reviewer_id: "test-reviewer",
      reviewer_authority_id: "test-review-authority",
      evaluator_id: "test-evaluator",
      attester_id: "test-attester",
      reviewed_at: "2026-09-26T00:01:00Z",
      decision: "PASS",
    },
    "receipt_sha256"
  );
  const receipt = persist(
    "bootstrap-receipt",
    "sca-p03-bootstrap-reviewer-receipt",
    "host:sca-p03-bootstrap-reviewer",
    receiptBody,
    receiptBody.schema_id,
    [record]
  );
  const reviewBody = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-bootstrap-review.v3",
      schema_version: 3,
      evidence_class: "live",
      record_ref: record,
      source_oracle_ref: request.source_oracle_ref,
      source_oracle_validation_ref: request.source_oracle_validation_ref,
      reviewer_id: "test-reviewer",
      reviewer_authority_id: "test-review-authority",
      reviewer_receipt_ref: receipt,
      decision: "PASS",
      reviewed_at: "2026-09-26T00:01:00Z",
      attempt_witness_ref: attempt,
      implementation_source_refs: sources,
    },
    "review_sha256"
  );
  const review = persist(
    "bootstrap-review",
    "sca-p03-bootstrap-review",
    "host:sca-p03-bootstrap-reviewer",
    reviewBody,
    reviewBody.schema_id,
    [record, receipt]
  );
  const bindingBody = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-attestation-binding.v3",
      schema_version: 3,
      host_attestation_ref: attestation,
      qualification_record_ref: record,
      review_ref: review,
      source_oracle_ref: request.source_oracle_ref,
      source_oracle_validation_ref: request.source_oracle_validation_ref,
      parser_identity_sha256: sha256("parser"),
      attempt_witness_ref: attempt,
      implementation_source_refs: sources,
    },
    "binding_sha256"
  );
  const binding = persist(
    "bootstrap-binding",
    "sca-p03-attestation-binding",
    "host:sca-p03-bootstrap-attester",
    bindingBody,
    bindingBody.schema_id,
    [record, review, attestation]
  );
  const productionBindingSha256 = sha256("production-binding");
  const productionRecordBody = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-production-qualification-record.v1",
      schema_version: 1,
      run_id: f.run,
      production_bindings_sha256: productionBindingSha256,
      accepted_p01: request.accepted_p01,
      bootstrap_record_ref: record,
      bootstrap_review_ref: review,
      bootstrap_binding_ref: binding,
      host_attestation_ref: attestation,
    },
    "record_sha256"
  );
  const productionUpstreams = [
    request.accepted_p01.request_ref,
    request.accepted_p01.obligation_ledger_ref,
    request.accepted_p01.campaign_manifest_core_ref,
    request.accepted_p01.admission_evidence_ref,
    request.accepted_p01.p01_gate_ref,
    request.accepted_p01.campaign_manifest_ref,
    ...request.accepted_p01.frozen_refs,
    record,
    review,
    binding,
    attestation,
  ]
    .filter(
      (ref, index, refs) =>
        refs.findIndex((candidate) => candidate.artifact_id === ref.artifact_id) === index
    )
    .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  const productionRecord = persist(
    SCA_P03_PRODUCTION_QUALIFICATION_RECORD_OPERATION_ID,
    SCA_P03_PRODUCTION_QUALIFICATION_RECORD_KIND,
    "host:sca-p03-production-evaluator",
    productionRecordBody,
    productionRecordBody.schema_id,
    productionUpstreams
  );
  let bootstrap: ScaP03CurrentBootstrapSampleV1 = {
    handoff_sha256: sha256("handoff"),
    selection_sha256: sha256("selection"),
    deployment_identity_sha256: deployment,
    production_binding_sha256: productionBindingSha256,
    production_record_ref: productionRecord,
    proof_sha256: sha256(
      canonicalJson({
        record_ref: record,
        binding_ref: binding,
        review_ref: review,
        attestation_ref: attestation,
        attempt_ref: attempt,
        cleanup_ref: cleanup,
        isolation_ref: isolation,
        receipt_ref: receipt,
        external_review_ref: external,
        source_oracle_ref: request.source_oracle_ref,
        source_oracle_validation_ref: request.source_oracle_validation_ref,
        parser_identity_sha256: sha256("parser"),
        implementation_source_refs: sources,
        implementation_closure_sha256: sha256("implementation-closure"),
        runtime_package_closure_sha256: sha256("packages"),
        selection_sha256: sha256("selection"),
      })
    ),
    record_ref: record,
    binding_ref: binding,
    review_ref: review,
    attestation_ref: attestation,
    attempt_ref: attempt,
    cleanup_ref: cleanup,
    isolation_ref: isolation,
    receipt_ref: receipt,
    external_review_ref: external,
  };
  const summaryBody = operational.readScaP03CurrentJson(f.store, f.summary, "test summary");
  if (summaryBody === null || typeof summaryBody !== "object")
    throw new Error("missing test summary");
  const summary = persist(
    "measured-summary",
    "sca-p03-operational-qualification-input",
    "host:sca-p03-qualification-custodian",
    { ...summaryBody, bootstrap_proof_sha256: bootstrap.proof_sha256 },
    "penny.sca-p03-formal-collector-summary.v1",
    [f.operational, f.transition, f.p02Summary]
  );
  vi.spyOn(operational, "requireScaP03OperationalCohort").mockImplementation(() => ({
    request,
    refs: [f.operational, f.transition],
  }));
  const {
    operational_cohort: _cohort,
    p04_admission_performed: _admission,
    ...p02Projection
  } = f.snapshot;
  const p02Snapshot = validateContract(
    ScaP02V3DefinitionSnapshotSchema,
    {
      ...p02Projection,
      schema_id: "penny.sca-p02-v3-definition-snapshot.v1",
      phase_id: "SCA-P02",
      source_policy_module: "apps/orchestration/src/sca/p02-qualification.ts",
      p03_admission_performed: false,
      criterion_ids: [
        "p02-containment-egress-and-minimization",
        "p02-current-predecessor-and-implementation",
        "p02-required-variants-and-lifecycle",
        "p02-six-operation-deterministic-coverage",
      ],
      criterion_definition_refs: {
        "p02-containment-egress-and-minimization": f.operational,
        "p02-current-predecessor-and-implementation": f.operational,
        "p02-required-variants-and-lifecycle": f.operational,
        "p02-six-operation-deterministic-coverage": f.operational,
      },
    },
    "test-only P02 snapshot projection"
  );
  const p02Guard = vi
    .spyOn(predecessorGuard, "requireScaP03AcceptedP02Qualification")
    .mockReturnValue(p02Snapshot);
  let activationDigest = sha256("durable-p02-activation");
  vi.spyOn(activation, "requireScaActivationAdmissionV1").mockImplementation(() => ({
    authority_id: "p02-authority",
    authority_sha256: activationDigest,
    issuance_sha256: sha256("issuance"),
    tenant_id: f.tenant,
    project_id: f.project,
    phase_id: "SCA-P02",
    production_playbook_name: "sca-p02",
    qualification_run_id: f.run,
    activation_run_id: "p02-activation",
    qualification_artifact_content_sha256: f.qualificationRef.content_digest,
    gate_artifact_content_sha256: request.accepted_p02.qualification_gate_ref.content_digest,
    implementation_identity_artifact_content_sha256: sha256("identity"),
    qualification_policy_data_sha256: sha256("policy"),
    registration_contract_sha256: sha256("contract"),
    runtime_registration_sha256: sha256("registration"),
    host_implementation_binding_sha256: sha256("p02-host"),
    proposed_start_sha256: sha256("start"),
    revocation_generation: 0,
    checked_at: "2026-09-26T00:03:00Z",
    expires_at: "2026-09-27T00:00:00Z",
  }));
  const resolve = vi.fn(() => SCA_P02_PHASE_REGISTRATION);
  let samples = 0;
  const input: ScaP03CurrentHostInputV1 = {
    project_root: path.join(f.root, "source"),
    store: f.store,
    tenant_id: f.tenant,
    project_id: f.project,
    operational_summary_ref: summary,
    operational_gate_ref: f.operational,
    p04_transition_ref: f.transition,
    sample_current_bootstrap: () => {
      samples++;
      return bootstrap;
    },
    p02_activation: {
      host: {
        sample() {
          throw new Error("authority replay is isolated in this test");
        },
        verifyIssuance: () => false,
      },
      proposed: {
        tenant_id: f.tenant,
        project_id: f.project,
        phase_id: "SCA-P02",
        production_playbook_name: "sca-p02",
        qualification_run_id: f.run,
        activation_run_id: "p02-activation",
        proposed_start_sha256: sha256("start"),
        qualification_ref: f.qualificationRef,
        gate_ref: request.accepted_p02.qualification_gate_ref,
        authority_ref: request.accepted_p02.qualification_definition_ref,
      },
      registry: { resolve },
    },
    now: () => new Date("2026-09-26T00:03:00Z"),
  };
  for (const relative of SCA_P03_IMPLEMENTATION_SOURCE_PATHS) {
    const absolute = path.join(input.project_root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `measured:${relative}`);
  }
  const measured = measureScaP03CurrentHostBinding(input);
  const formalSnapshot = validateContract(
    formalGuard.ScaP03V3DefinitionSnapshotSchema,
    {
      ...f.snapshot,
      current_host_binding_sha256: measured.host_binding_sha256,
      current_source_manifest_sha256: measured.source_manifest_sha256,
    },
    "host test snapshot"
  );
  const replay = vi
    .spyOn(formalGuard, "requireScaP03AcceptedQualification")
    .mockReturnValue(formalSnapshot);
  const verifyIssuance = vi.fn(() => false);
  const host = createScaP03ActivationHostV1({
    ...input,
    partition_project_id: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    definition_ref: f.snapshotRef,
    gate_ref: f.gateRef,
    issuer_policy_id: "test-issuer-policy",
    revocation_generation: 0,
    issuance_contract: f.snapshot.contracts.reviewer_authority,
    authority_contract: f.snapshot.contracts.reviewer_authority,
    owner: { verifyIssuance },
  });
  return {
    f,
    input,
    host,
    productionRecord,
    measured,
    replay,
    p02Guard,
    resolve,
    verifyIssuance,
    samples: () => samples,
    driftBootstrap: (change: Partial<ScaP03CurrentBootstrapSampleV1>) => {
      bootstrap = { ...bootstrap, ...change };
    },
    driftActivation: () => {
      activationDigest = sha256("replaced-p02-activation");
    },
  };
}

describe("P03 current-host activation factory (read-only)", () => {
  it("accepts the exact production-seal artifact slot and remeasures on every sample", () => {
    const f = hostFixture();
    expect(f.f.store.metadata(f.productionRecord)).toMatchObject({
      kind: SCA_P03_PRODUCTION_QUALIFICATION_RECORD_KIND,
      operation_id: SCA_P03_PRODUCTION_QUALIFICATION_RECORD_OPERATION_ID,
    });
    expect(measureScaP03CurrentHostBinding(f.input)).toEqual(f.measured);
    expect(f.host.sample().registration).toBe(SCA_P03_PHASE_REGISTRATION);
    expect(f.host.sample().host_implementation_binding_sha256).toBe(f.measured.host_binding_sha256);
    expect(f.samples()).toBe(4);
    expect(f.replay).toHaveBeenCalledTimes(2);
    expect(f.resolve).toHaveBeenCalledTimes(4);
  });
  it("detects changed and missing fixed source bytes", () => {
    const f = hostFixture();
    const source = path.join(f.input.project_root, SCA_P03_IMPLEMENTATION_SOURCE_PATHS[0]);
    const original = readFileSync(source);
    writeFileSync(source, "mutated");
    expect(() => f.host.sample()).toThrow(/current-tree binding/u);
    writeFileSync(source, original);
    expect(f.host.sample().registration).toBe(SCA_P03_PHASE_REGISTRATION);
    rmSync(source);
    expect(() => f.host.sample()).toThrow();
    const outside = path.join(f.f.root, "outside-source");
    writeFileSync(outside, original);
    symlinkSync(outside, source);
    expect(() => f.host.sample()).toThrow(/symlinked/u);
  });
  it.each([
    "handoff_sha256",
    "proof_sha256",
    "selection_sha256",
    "deployment_identity_sha256",
    "production_binding_sha256",
  ] as const)("fails on current bootstrap %s drift", (field) => {
    const f = hostFixture();
    f.driftBootstrap({ [field]: sha256("drift") });
    expect(() => f.host.sample()).toThrow(/bootstrap|deployment|production/u);
  });
  it("fails on predecessor qualification, durable activation replacement or revocation", () => {
    const f = hostFixture();
    f.driftActivation();
    expect(() => f.host.sample()).toThrow(/current-tree binding/u);
    f.resolve.mockImplementation(() => {
      throw new Error("P02 revoked");
    });
    expect(() => f.host.sample()).toThrow(/revoked/u);
    f.p02Guard.mockImplementation(() => {
      throw new Error("P02 qualification stale");
    });
    expect(() => f.host.sample()).toThrow(/qualification stale/u);
  });
  it("fails before sampling if P03 formal replay is stale or unavailable", () => {
    const f = hostFixture();
    f.replay.mockImplementation(() => {
      throw new Error("P03 formal replay denied");
    });
    expect(() => f.host.sample()).toThrow(/formal replay denied/u);
    expect(f.samples()).toBe(1);
  });
  it("refuses unavailable fresh bootstrap verification rather than accepting cached proof", () => {
    const f = hostFixture();
    expect(() =>
      measureScaP03CurrentHostBinding({
        ...f.input,
        sample_current_bootstrap() {
          throw new Error("fresh verification unavailable");
        },
      })
    ).toThrow(/fresh verification unavailable/u);
  });
  it("refuses a substituted production qualification record", () => {
    const f = hostFixture();
    const ref = f.input.sample_current_bootstrap().production_record_ref;
    f.driftBootstrap({
      production_record_ref: { ...ref, content_digest: sha256("substitution") },
    });
    expect(() => f.host.sample()).toThrow();
  });
  it("refuses substituted or stale bootstrap proof refs", () => {
    const f = hostFixture();
    const ref = f.input.sample_current_bootstrap().record_ref;
    f.driftBootstrap({ record_ref: { ...ref, content_digest: sha256("substitution") } });
    expect(() => f.host.sample()).toThrow();
    f.driftBootstrap({ record_ref: ref });
    f.f.store.persist({
      metadata: { ...f.f.store.metadata(ref), version: 2, parent_ref: ref },
      content: f.f.store.readById(ref.artifact_id),
    });
    expect(() => f.host.sample()).toThrow(/stale revision/u);
  });
});
