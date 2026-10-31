import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { Type, type Static } from "typebox";

import type { ArtifactStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { Sha256Schema } from "../skill-contracts/common.js";
import type { SqliteScaActivationOwner } from "./activation-owner.js";
import { SCA_P02_PHASE_REGISTRATION } from "./p02-playbook.js";
import { requireScaP03AcceptedP02Qualification } from "./p03-p02-qualification-guard.js";
import { SCA_P03_PHASE_PLAYBOOK_NAME, SCA_P03_PHASE_REGISTRATION } from "./p03-playbook.js";
import {
  SCA_P03_IMPLEMENTATION_SOURCE_PATHS,
  scaP03SourceManifestSha256,
} from "./p03-qualification.js";
import {
  createScaP03QualificationDefinitionFromSnapshot,
  requireScaP03AcceptedQualification,
} from "./p03-qualification-guard.js";
import {
  readScaP03CurrentArtifact,
  readScaP03CurrentJson,
  requireScaP03OperationalCohort,
  requireScaP03OperationalSummary,
} from "./p03-operational-replay.js";
import {
  validateScaP03AttestationBindingV3,
  validateScaP03BootstrapQualificationRecordV3,
  SCA_P03_PRODUCTION_EVALUATOR,
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_KIND,
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_OPERATION_ID,
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA,
  validateScaP03BootstrapReviewV3,
  validateScaP03ExternalReviewReceiptV2,
  validateScaP03ProductionQualificationRecordV1,
} from "./p03-bootstrap-contracts.js";
import { validateScaP03HostIsolationAttestationV1 } from "./p03-contracts.js";
import type { SqliteScaPhaseActivationRegistry } from "./phase-activation.js";
import {
  requireScaActivationAdmissionV1,
  type ScaActivationHostV1,
  type ScaProposedActivationStartV1,
} from "./qualification-activation.js";
import type { ScaArtifactContractV1 } from "./qualification-gate.js";

export const ScaP03CurrentBootstrapSampleV1Schema = Type.Object(
  {
    handoff_sha256: Sha256Schema,
    proof_sha256: Sha256Schema,
    selection_sha256: Sha256Schema,
    deployment_identity_sha256: Sha256Schema,
    production_binding_sha256: Sha256Schema,
    production_record_ref: ArtifactRefSchema,
    record_ref: ArtifactRefSchema,
    binding_ref: ArtifactRefSchema,
    review_ref: ArtifactRefSchema,
    attestation_ref: ArtifactRefSchema,
    attempt_ref: ArtifactRefSchema,
    cleanup_ref: ArtifactRefSchema,
    isolation_ref: ArtifactRefSchema,
    receipt_ref: ArtifactRefSchema,
    external_review_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type ScaP03CurrentBootstrapSampleV1 = Readonly<
  Static<typeof ScaP03CurrentBootstrapSampleV1Schema>
>;

export interface ScaP03CurrentHostInputV1 {
  readonly project_root: string;
  readonly store: ArtifactStore;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly operational_summary_ref: ArtifactRef;
  readonly operational_gate_ref: ArtifactRef;
  readonly p04_transition_ref: ArtifactRef;
  /** Trusted live host boundary, NOT caller data or persisted PASS labels. Each invocation must
   * freshly verify the sealed handoff, current selection, V3 bootstrap proof, deployment, and
   * signature using the closed bootstrap host authority; throw if fresh verification is unavailable.
   * The generic activation architecture samples synchronously. An asynchronous verifier must be
   * bridged by the host, never by caching a historical proof inside this factory. */
  readonly sample_current_bootstrap: () => ScaP03CurrentBootstrapSampleV1;
  readonly p02_activation: {
    readonly host: ScaActivationHostV1;
    readonly proposed: ScaProposedActivationStartV1;
    readonly registry: Pick<SqliteScaPhaseActivationRegistry, "resolve">;
  };
  readonly now?: () => Date;
}
export interface ScaP03CurrentHostBindingV1 {
  readonly source_manifest_sha256: string;
  readonly host_binding_sha256: string;
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function bootstrapBinding(
  input: ScaP03CurrentHostInputV1,
  request: ReturnType<typeof requireScaP03OperationalCohort>["request"]
) {
  const sample = validateContract(
    ScaP03CurrentBootstrapSampleV1Schema,
    input.sample_current_bootstrap(),
    "P03 current bootstrap sample"
  );
  const json = (ref: ArtifactRef) =>
    readScaP03CurrentJson(input.store, ref, "P03 bootstrap proof ref");
  const productionRecord = validateScaP03ProductionQualificationRecordV1(
    json(sample.production_record_ref)
  );
  const productionMetadata = input.store.metadata(sample.production_record_ref);
  const expectedProductionUpstreams = [
    request.accepted_p01.request_ref,
    request.accepted_p01.obligation_ledger_ref,
    request.accepted_p01.campaign_manifest_core_ref,
    request.accepted_p01.admission_evidence_ref,
    request.accepted_p01.p01_gate_ref,
    request.accepted_p01.campaign_manifest_ref,
    ...request.accepted_p01.frozen_refs,
    sample.record_ref,
    sample.review_ref,
    sample.binding_ref,
    sample.attestation_ref,
  ]
    .filter(
      (ref, index, refs) =>
        refs.findIndex((candidate) => candidate.artifact_id === ref.artifact_id) === index
    )
    .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  if (
    productionRecord.production_bindings_sha256 !== sample.production_binding_sha256 ||
    !same(productionRecord.accepted_p01, request.accepted_p01) ||
    !same(productionRecord.bootstrap_record_ref, sample.record_ref) ||
    !same(productionRecord.bootstrap_review_ref, sample.review_ref) ||
    !same(productionRecord.bootstrap_binding_ref, sample.binding_ref) ||
    !same(productionRecord.host_attestation_ref, sample.attestation_ref) ||
    productionMetadata.phase !== "SCA-P03" ||
    productionMetadata.kind !== SCA_P03_PRODUCTION_QUALIFICATION_RECORD_KIND ||
    productionMetadata.operation_id !== SCA_P03_PRODUCTION_QUALIFICATION_RECORD_OPERATION_ID ||
    productionMetadata.producer !== SCA_P03_PRODUCTION_EVALUATOR ||
    productionMetadata.content_schema?.schema_id !==
      SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA ||
    productionMetadata.content_schema.schema_version !== 1 ||
    !same(productionMetadata.upstream_refs, expectedProductionUpstreams)
  )
    throw new Error("P03 production qualification record or custody changed");
  const record = validateScaP03BootstrapQualificationRecordV3(json(sample.record_ref));
  const binding = validateScaP03AttestationBindingV3(json(sample.binding_ref));
  const review = validateScaP03BootstrapReviewV3(json(sample.review_ref));
  const receipt = validateScaP03ExternalReviewReceiptV2(
    readScaP03CurrentArtifact(input.store, sample.receipt_ref, "P03 bootstrap reviewer receipt")
  );
  const attestation = validateScaP03HostIsolationAttestationV1(json(sample.attestation_ref));
  const proof = {
    record_ref: sample.record_ref,
    binding_ref: sample.binding_ref,
    review_ref: sample.review_ref,
    attestation_ref: sample.attestation_ref,
    attempt_ref: sample.attempt_ref,
    cleanup_ref: sample.cleanup_ref,
    isolation_ref: sample.isolation_ref,
    receipt_ref: sample.receipt_ref,
    external_review_ref: sample.external_review_ref,
    source_oracle_ref: record.source_oracle_ref,
    source_oracle_validation_ref: record.source_oracle_validation_ref,
    parser_identity_sha256: record.parser_identity_sha256,
    implementation_source_refs: record.implementation_source_refs,
    implementation_closure_sha256: record.implementation_closure_sha256,
    runtime_package_closure_sha256: record.runtime_package_closure_sha256,
    selection_sha256: sample.selection_sha256,
  };
  if (
    sha256(canonicalJson(proof)) !== sample.proof_sha256 ||
    record.evidence_class !== "live" ||
    review.evidence_class !== "live" ||
    !record.exact_expected_observations ||
    !record.cleanup_verified ||
    !record.host_isolation_verified ||
    record.observations.some((entry) => entry.status !== "passed") ||
    receipt.decision !== "PASS" ||
    record.deployment_identity_sha256 !== sample.deployment_identity_sha256 ||
    attestation.deployment_identity_sha256 !== sample.deployment_identity_sha256 ||
    attestation.runtime_tree_sha256 !== record.runtime_tree_sha256 ||
    attestation.implementation_identity_sha256 !== record.implementation_identity_sha256 ||
    !same(sample.attestation_ref, request.host_isolation_attestation_ref) ||
    !same(binding.host_attestation_ref, sample.attestation_ref) ||
    !same(binding.qualification_record_ref, sample.record_ref) ||
    !same(binding.review_ref, sample.review_ref) ||
    !same(binding.attempt_witness_ref, sample.attempt_ref) ||
    !same(review.record_ref, sample.record_ref) ||
    !same(review.reviewer_receipt_ref, sample.receipt_ref) ||
    !same(review.attempt_witness_ref, sample.attempt_ref) ||
    !same(receipt.record_ref, sample.record_ref) ||
    !same(receipt.attempt_ref, sample.attempt_ref) ||
    !same(receipt.cleanup_ref, sample.cleanup_ref) ||
    !same(receipt.isolation_ref, sample.isolation_ref) ||
    !same(receipt.external_review_ref, sample.external_review_ref) ||
    !same(record.attempt_witness_ref, sample.attempt_ref) ||
    !same(record.cleanup_evidence_ref, sample.cleanup_ref) ||
    !same(record.host_isolation_evidence_ref, sample.isolation_ref)
  )
    throw new Error("P03 current bootstrap proof or deployment binding changed");
  for (const [actual, expected] of [
    [record.source_oracle_ref, request.source_oracle_ref],
    [record.source_oracle_validation_ref, request.source_oracle_validation_ref],
    [record.runtime_identity_ref, request.joern_runtime_identity_ref],
    [record.implementation_identity_ref, request.implementation_identity_ref],
    [record.qualification_profile_ref, request.qualification_profile_ref],
    [record.baseline_query_set_ref, request.baseline_query_set_ref],
    [record.runtime_policy_ref, request.runtime_policy_ref],
  ] as const)
    if (!same(actual, expected)) throw new Error("P03 bootstrap operational inputs changed");
  for (const ref of [
    sample.production_record_ref,
    sample.record_ref,
    sample.binding_ref,
    sample.review_ref,
    sample.attestation_ref,
    sample.attempt_ref,
    sample.cleanup_ref,
    sample.isolation_ref,
    sample.receipt_ref,
    sample.external_review_ref,
    ...record.implementation_source_refs,
    ...record.runtime_package_refs,
  ]) {
    readScaP03CurrentArtifact(input.store, ref, "P03 current bootstrap custody");
    for (const upstream of input.store.metadata(ref).upstream_refs)
      readScaP03CurrentArtifact(input.store, upstream, "P03 current bootstrap provenance");
  }
  return sample;
}

/** Current fixed source bytes + operational cohort + verified bootstrap + durably active predecessor. */
export function measureScaP03CurrentHostBinding(
  input: ScaP03CurrentHostInputV1
): ScaP03CurrentHostBindingV1 {
  const summary = requireScaP03OperationalSummary({
    store: input.store,
    summary_ref: input.operational_summary_ref,
    gate_ref: input.operational_gate_ref,
    transition_ref: input.p04_transition_ref,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
  });
  const operational = requireScaP03OperationalCohort({
    store: input.store,
    gate_ref: input.operational_gate_ref,
    transition_ref: input.p04_transition_ref,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    trusted_clock: input.now ?? (() => new Date()),
  });
  const predecessor = operational.request.accepted_p02;
  const p02 = requireScaP03AcceptedP02Qualification({
    store: input.store,
    definition_ref: predecessor.qualification_definition_ref,
    gate_ref: predecessor.qualification_gate_ref,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    accepted_p02_refs: [
      summary.p02_operational_summary_ref,
      predecessor.gate_ref,
      predecessor.transition_ref,
    ],
  });
  const { host, proposed, registry } = input.p02_activation;
  if (
    proposed.phase_id !== "SCA-P02" ||
    proposed.production_playbook_name !== "sca-p02" ||
    !same(proposed.gate_ref, predecessor.qualification_gate_ref) ||
    !same(proposed.qualification_ref, p02.qualification_ref)
  )
    throw new Error("P03 accepted P02 activation predecessor changed");
  const { checked_at: _checkedAt, ...activation } = requireScaActivationAdmissionV1({
    host,
    proposed,
  });
  if (registry.resolve({ host, proposed }) !== SCA_P02_PHASE_REGISTRATION)
    throw new Error("P03 predecessor is not durably active accepted P02");
  const bootstrap = bootstrapBinding(input, operational.request);
  if (
    bootstrap.handoff_sha256 !== summary.bootstrap_handoff_sha256 ||
    bootstrap.proof_sha256 !== summary.bootstrap_proof_sha256 ||
    bootstrap.deployment_identity_sha256 !== summary.deployment_identity_sha256
  )
    throw new Error("P03 bootstrap handoff, proof or deployment drift");
  const root = realpathSync(path.resolve(input.project_root));
  const sourceFiles = SCA_P03_IMPLEMENTATION_SOURCE_PATHS.map((relative) => {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`))
      throw new Error("P03 source escaped project root");
    if (realpathSync(absolute) !== absolute) throw new Error("P03 source path is symlinked");
    const descriptor = openSync(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.size < 1 || before.size > 64 * 1_048_576)
        throw new Error("P03 source is not a bounded regular file");
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      const named = lstatSync(absolute);
      if (
        realpathSync(absolute) !== absolute ||
        named.dev !== after.dev ||
        named.ino !== after.ino ||
        before.size !== bytes.byteLength ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("P03 source changed while measured");
      return { path: relative, sha256: sha256(bytes), byte_length: bytes.byteLength };
    } finally {
      closeSync(descriptor);
    }
  });
  const manifest = scaP03SourceManifestSha256(sourceFiles);
  return {
    source_manifest_sha256: manifest,
    host_binding_sha256: sha256(
      canonicalJson({
        source_files: sourceFiles,
        source_manifest_sha256: manifest,
        operational_summary_ref: input.operational_summary_ref,
        operational_summary: summary,
        operational_gate_ref: input.operational_gate_ref,
        p04_transition_ref: input.p04_transition_ref,
        p02_definition_ref: predecessor.qualification_definition_ref,
        p02_gate_ref: predecessor.qualification_gate_ref,
        p02_activation_binding_sha256: sha256(canonicalJson(activation)),
        bootstrap,
      })
    ),
  };
}

/** Sampling is read-only; only the existing generic issuance/authority/phase owner may activate. */
export function createScaP03ActivationHostV1(
  input: ScaP03CurrentHostInputV1 & {
    readonly partition_project_id: string;
    readonly definition_ref: ArtifactRef;
    readonly gate_ref: ArtifactRef;
    readonly issuer_policy_id: string;
    readonly issuance_contract: ScaArtifactContractV1;
    readonly authority_contract: ScaArtifactContractV1;
    readonly revocation_generation: number;
    readonly owner: Pick<SqliteScaActivationOwner, "verifyIssuance">;
  }
): ScaActivationHostV1 {
  return {
    sample: () => {
      const snapshot = requireScaP03AcceptedQualification({
        store: input.store,
        definition_ref: input.definition_ref,
        gate_ref: input.gate_ref,
        tenant_id: input.tenant_id,
        project_id: input.project_id,
        operational_summary_ref: input.operational_summary_ref,
        operational_gate_ref: input.operational_gate_ref,
        p04_transition_ref: input.p04_transition_ref,
        ...(input.now === undefined ? {} : { trusted_clock: input.now }),
      });
      const measured = measureScaP03CurrentHostBinding(input);
      if (
        snapshot.current_source_manifest_sha256 !== measured.source_manifest_sha256 ||
        snapshot.current_host_binding_sha256 !== measured.host_binding_sha256
      )
        throw new Error("P03 activation current-tree binding changed");
      return {
        store: input.store,
        partition_project_id: input.partition_project_id,
        tenant_id: input.tenant_id,
        project_id: input.project_id,
        phase_id: "SCA-P03",
        production_playbook_name: SCA_P03_PHASE_PLAYBOOK_NAME,
        registration: SCA_P03_PHASE_REGISTRATION,
        registration_class: "production",
        qualified_subject_class: "production",
        host_implementation_binding_sha256: measured.host_binding_sha256,
        qualification_definition: createScaP03QualificationDefinitionFromSnapshot(snapshot),
        issuer_policy_id: input.issuer_policy_id,
        issuance_contract: input.issuance_contract,
        authority_contract: input.authority_contract,
        revocation_generation: input.revocation_generation,
        now: (input.now ?? (() => new Date()))().toISOString(),
      };
    },
    verifyIssuance: (verification) => input.owner.verifyIssuance(verification),
  };
}
