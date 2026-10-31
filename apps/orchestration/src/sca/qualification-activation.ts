import { TextDecoder } from "node:util";

import { Type } from "typebox";

import {
  currentArtifactRef,
  type ArtifactStore,
  type ArtifactHostStore,
} from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import {
  OpaqueIdSchema,
  Sha256Schema,
  assertOpaqueId,
  assertRfc3339Utc,
} from "../skill-contracts/common.js";
import {
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
  skillContractSha256,
  validateRegistrationContract,
  type PlaybookRegistration,
} from "../playbooks/registry.js";
import { SCA_PHASE_REGISTRY } from "./phase-registry.js";
import {
  SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
  SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
  validateScaActivationAuthorityV1,
  validateScaActivationIssuanceV1,
  type ScaActivationIssuanceV1,
  type ScaActivationScopeV1,
} from "./qualification-activation-contracts.js";
import {
  requireScaPhaseGatePassV3,
  type ScaArtifactContractV1,
  type ScaPhaseQualificationDefinitionV1,
} from "./qualification-gate.js";

const ACTIVATION_PHASE = "sca-activation-admission";
const MAX_ACTIVATION_ARTIFACT_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 256 * 1_048_576;
const CANDIDATE_NAME = /(?:^|[-_.:])candidate(?:$|[-_.:])/iu;
const ProposedStartSchema = Type.Object(
  {
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    production_playbook_name: OpaqueIdSchema,
    qualification_run_id: OpaqueIdSchema,
    activation_run_id: OpaqueIdSchema,
    proposed_start_sha256: Sha256Schema,
    qualification_ref: ArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    authority_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
const StartDigestProjectionSchema = Type.Omit(ProposedStartSchema, [
  "proposed_start_sha256",
  "authority_ref",
]);

/** The authority ref is excluded to avoid a digest cycle. Only these closed fields
 * bind the proposed start; neither the request's digest nor host claims are inputs. */
export function scaProposedStartSha256(
  proposed: Pick<
    ScaProposedActivationStartV1,
    | "tenant_id"
    | "project_id"
    | "phase_id"
    | "production_playbook_name"
    | "qualification_run_id"
    | "activation_run_id"
    | "qualification_ref"
    | "gate_ref"
  >
): string {
  const projection = {
    tenant_id: proposed.tenant_id,
    project_id: proposed.project_id,
    phase_id: proposed.phase_id,
    production_playbook_name: proposed.production_playbook_name,
    qualification_run_id: proposed.qualification_run_id,
    activation_run_id: proposed.activation_run_id,
    qualification_ref: currentArtifactRef(proposed.qualification_ref),
    gate_ref: currentArtifactRef(proposed.gate_ref),
  };
  validateContract(StartDigestProjectionSchema, projection, "activation start digest projection");
  return sha256(canonicalJson(projection));
}

/** Host-only snapshot. All values must be derived from current host policy/registry,
 * never from the proposed start or an artifact. The implementation binding covers
 * executable evaluator, admission, and adapter code beyond the serialized policy data. */
export interface ScaActivationHostSnapshotV1 {
  readonly store: ArtifactStore;
  /** Read-only attenuation, never a replacement store identity or issuer owner. */
  readonly artifact_reads?: ArtifactHostStore;
  readonly partition_project_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly phase_id: string;
  readonly production_playbook_name: string;
  /** Current active registration resolved by the trusted host, not artifact/request data. */
  readonly registration: PlaybookRegistration | null;
  readonly registration_class: "production" | "candidate";
  /** Host proof of the qualification subject's class, bound by qualification policy. */
  readonly qualified_subject_class: "production" | "candidate";
  readonly host_implementation_binding_sha256: string;
  readonly qualification_definition: ScaPhaseQualificationDefinitionV1;
  readonly issuer_policy_id: string;
  readonly issuance_contract: ScaArtifactContractV1;
  readonly authority_contract: ScaArtifactContractV1;
  readonly revocation_generation: number;
  readonly now: string;
}

export interface ScaActivationHostV1 {
  sample(): ScaActivationHostSnapshotV1;
  /** Trusted EXTERNAL issuer-owner boundary: must authenticate exact stored issuance
   * bytes/ref in an independent operator-owned durable ledger AND check principal,
   * issuer policy, issuer-owned issued_at and non-revocation. No concrete durable
   * issuer/revocation owner is provided here. False/missing/throwing must deny.
   * A self-digest, artifact producer label or qualification reviewer is not issuance. */
  verifyIssuance(input: {
    readonly record: ScaActivationIssuanceV1;
    readonly ref: ArtifactRef;
    readonly scope: ScaActivationScopeV1;
    readonly policy_id: string;
  }): boolean;
}

/** Host-only asynchronous sampling. Preparation is awaited BEFORE any issuer consume
 * transaction. It neither installs nor consumes authority and has no model/tool ingress. */
export interface ScaAsyncActivationHostV1 {
  sample(): Promise<ScaActivationHostSnapshotV1>;
  verifyIssuance: ScaActivationHostV1["verifyIssuance"];
}
export async function prepareScaAsyncActivationHostV1(
  host: ScaAsyncActivationHostV1
): Promise<ScaActivationHostV1> {
  const first = await host.sample();
  const second = await host.sample();
  let reads = 0;
  return {
    sample() {
      if (++reads === 1) return first;
      if (reads === 2) return second;
      throw new Error("sca_async_prepared_snapshot_already_used");
    },
    verifyIssuance: (claim) => host.verifyIssuance(claim),
  };
}
export async function requireScaActivationAdmissionAsyncV1(input: {
  host: ScaAsyncActivationHostV1;
  proposed: ScaProposedActivationStartV1;
}) {
  return requireScaActivationAdmissionV1({
    host: await prepareScaAsyncActivationHostV1(input.host),
    proposed: input.proposed,
  });
}
export interface ScaProposedActivationStartV1 {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly phase_id: string;
  readonly production_playbook_name: string;
  readonly qualification_run_id: string;
  readonly activation_run_id: string;
  readonly proposed_start_sha256: string;
  readonly qualification_ref: ArtifactRef;
  readonly gate_ref: ArtifactRef;
  readonly authority_ref: ArtifactRef;
}

/** Snapshot only. It grants no continuing authority. A future start MUST recheck
 * current state immediately before effects; one-shot use needs a separate durable
 * compare-and-set owner, not this read-only verifier. */
export interface VerifiedScaActivationAdmissionViewV1 {
  readonly authority_id: string;
  readonly authority_sha256: string;
  readonly issuance_sha256: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly phase_id: string;
  readonly production_playbook_name: string;
  readonly qualification_run_id: string;
  readonly activation_run_id: string;
  readonly qualification_artifact_content_sha256: string;
  readonly gate_artifact_content_sha256: string;
  readonly implementation_identity_artifact_content_sha256: string;
  readonly qualification_policy_data_sha256: string;
  readonly registration_contract_sha256: string;
  readonly runtime_registration_sha256: string;
  readonly host_implementation_binding_sha256: string;
  readonly proposed_start_sha256: string;
  readonly revocation_generation: number;
  readonly checked_at: string;
  readonly expires_at: string;
}

export class ScaActivationAdmissionError extends Error {
  constructor(
    readonly code: "invalid_request" | "evidence_denied" | "authority_denied" | "stale_host_state"
  ) {
    super(code);
    this.name = "ScaActivationAdmissionError";
  }
}

function deny(code: ScaActivationAdmissionError["code"]): never {
  throw new ScaActivationAdmissionError(code);
}

function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return equal(currentArtifactRef(left), currentArtifactRef(right));
}

function sortedRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((a, b) =>
    Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id))
  );
}

function contractMatches(
  ref: ArtifactRef,
  contract: ScaArtifactContractV1,
  schemaId: string
): boolean {
  return (
    contract.schema_id === schemaId &&
    contract.schema_version === 1 &&
    contract.max_bytes > 0 &&
    contract.max_bytes <= MAX_ACTIVATION_ARTIFACT_BYTES &&
    ref.kind === contract.artifact_kind &&
    ref.producer === contract.producer &&
    ref.media_type === contract.media_type &&
    ref.content_schema?.schema_id === schemaId &&
    ref.content_schema.schema_version === 1 &&
    ref.byte_length > 0 &&
    ref.byte_length <= contract.max_bytes
  );
}

function readActivation<Value>(input: {
  readonly store: ArtifactHostStore;
  readonly ref: ArtifactRef;
  readonly contract: ScaArtifactContractV1;
  readonly schema_id: string;
  readonly run_id: string;
  readonly upstream: readonly ArtifactRef[] | null;
  readonly validate: (value: unknown) => Value;
}): Value {
  const ref = currentArtifactRef(input.ref);
  if (
    !contractMatches(ref, input.contract, input.schema_id) ||
    ref.run_id !== input.run_id ||
    ref.phase !== ACTIVATION_PHASE ||
    ref.version !== 1 ||
    ref.branch_id !== null
  )
    deny("authority_denied");
  const stored = input.store.refById(ref.artifact_id);
  if (stored === undefined || !sameRef(stored, ref)) deny("authority_denied");
  const metadata = input.store.metadata(ref);
  if (
    metadata.schema_version !== 2 ||
    metadata.parent_ref !== null ||
    (input.upstream !== null && !equal(metadata.upstream_refs, sortedRefs(input.upstream))) ||
    metadata.version !== ref.version ||
    metadata.run_id !== ref.run_id ||
    metadata.phase !== ref.phase ||
    metadata.branch_id !== ref.branch_id ||
    metadata.kind !== ref.kind ||
    metadata.operation_id !== ref.operation_id ||
    metadata.producer !== ref.producer ||
    metadata.media_type !== ref.media_type ||
    !equal(metadata.content_schema ?? null, ref.content_schema ?? null)
  )
    deny("authority_denied");
  const bytes = input.store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest)
    deny("authority_denied");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) deny("authority_denied");
  return input.validate(value);
}

/** Canonical qualification POLICY DATA only: refs, values, contracts and evidence
 * classes. Callback bodies (validate/evaluate and start admission) are NOT hashed
 * here; the separately checked current host implementation binding must cover them. */
export function scaQualificationPolicyDataSha256(
  definition: ScaPhaseQualificationDefinitionV1
): string {
  const data = {
    tenant_id: definition.tenant_id,
    project_id: definition.project_id,
    run_id: definition.run_id,
    phase_id: definition.phase_id,
    implementation_revision: definition.implementation_revision,
    required_assurance_scope: definition.required_assurance_scope,
    current_host_binding_sha256: definition.current_host_binding_sha256,
    reviewer_authority_id: definition.reviewer_authority_id,
    reviewer_identity_id: definition.reviewer_identity_id,
    reviewer_lineage_id: definition.reviewer_lineage_id,
    implementation_identity: definition.implementation_identity,
    qualified_inputs: definition.qualified_inputs,
    criteria: definition.criteria.map((criterion) => ({
      criterion_id: criterion.criterion_id,
      definition_ref: criterion.definition_ref,
      definition_contract: criterion.definition_contract,
      evidence_contract: {
        artifact_kind: criterion.evidence_contract.artifact_kind,
        schema_id: criterion.evidence_contract.schema_id,
        schema_version: criterion.evidence_contract.schema_version,
        producer: criterion.evidence_contract.producer,
        media_type: criterion.evidence_contract.media_type,
        max_bytes: criterion.evidence_contract.max_bytes,
        evidence_class: criterion.evidence_contract.evidence_class,
      },
    })),
    implementation_identity_contract: {
      artifact_kind: definition.implementation_identity_contract.artifact_kind,
      schema_id: definition.implementation_identity_contract.schema_id,
      schema_version: definition.implementation_identity_contract.schema_version,
      producer: definition.implementation_identity_contract.producer,
      media_type: definition.implementation_identity_contract.media_type,
      max_bytes: definition.implementation_identity_contract.max_bytes,
    },
    reviewer_authority_contract: definition.reviewer_authority_contract,
    reviewer_receipt_contract: definition.reviewer_receipt_contract,
    qualification_record_contract: definition.qualification_record_contract,
    gate_record_contract: definition.gate_record_contract,
    max_unique_artifact_bytes: definition.max_unique_artifact_bytes,
  };
  return sha256(canonicalJson(data));
}

function currentRegistrationDigests(snapshot: ScaActivationHostSnapshotV1): {
  readonly contract: string;
  readonly runtime: string;
} | null {
  const registration = snapshot.registration;
  if (
    registration === null ||
    snapshot.registration_class !== "production" ||
    registration.name !== snapshot.production_playbook_name ||
    CANDIDATE_NAME.test(registration.name)
  )
    return null;
  const registered =
    PLAYBOOK_REGISTRY.get(registration.name) ?? SCA_PHASE_REGISTRY.get(registration.name);
  if (registered !== registration) return null;
  validateRegistrationContract(registration);
  return {
    contract: skillContractSha256(registration.contract),
    runtime: runtimeRegistrationSha256(registration),
  };
}

function snapshotIdentity(snapshot: ScaActivationHostSnapshotV1): unknown {
  return {
    partition_project_id: snapshot.partition_project_id,
    tenant_id: snapshot.tenant_id,
    project_id: snapshot.project_id,
    phase_id: snapshot.phase_id,
    production_playbook_name: snapshot.production_playbook_name,
    registration_class: snapshot.registration_class,
    qualified_subject_class: snapshot.qualified_subject_class,
    registration_digests: currentRegistrationDigests(snapshot),
    host_implementation_binding_sha256: snapshot.host_implementation_binding_sha256,
    qualification_policy_data_sha256: scaQualificationPolicyDataSha256(
      snapshot.qualification_definition
    ),
    issuer_policy_id: snapshot.issuer_policy_id,
    issuance_contract: snapshot.issuance_contract,
    authority_contract: snapshot.authority_contract,
    revocation_generation: snapshot.revocation_generation,
  };
}

function admit(
  host: ScaActivationHostV1,
  requested: ScaProposedActivationStartV1
): VerifiedScaActivationAdmissionViewV1 {
  try {
    validateContract(ProposedStartSchema, requested, "proposed activation start");
    for (const id of [
      requested.tenant_id,
      requested.project_id,
      requested.phase_id,
      requested.production_playbook_name,
      requested.qualification_run_id,
      requested.activation_run_id,
    ])
      assertOpaqueId(id, "proposed activation ID");
    for (const ref of [requested.qualification_ref, requested.gate_ref, requested.authority_ref]) {
      currentArtifactRef(ref);
    }
  } catch {
    deny("invalid_request");
  }
  const first = host.sample();
  first.store.assertBoundProject(first.partition_project_id);
  const def = first.qualification_definition;
  const registrationDigests = currentRegistrationDigests(first);
  const firstIdentity = snapshotIdentity(first);
  const policyDataSha256 = scaQualificationPolicyDataSha256(def);
  const proposedStartSha256 = scaProposedStartSha256(requested);
  if (
    registrationDigests === null ||
    first.qualified_subject_class !== "production" ||
    requested.production_playbook_name !== first.production_playbook_name ||
    requested.proposed_start_sha256 !== proposedStartSha256 ||
    requested.tenant_id !== first.tenant_id ||
    requested.project_id !== first.project_id ||
    requested.phase_id !== first.phase_id ||
    requested.qualification_run_id === requested.activation_run_id ||
    def.tenant_id !== first.tenant_id ||
    def.project_id !== first.project_id ||
    def.max_unique_artifact_bytes > MAX_TOTAL_BYTES - 2 * MAX_ACTIVATION_ARTIFACT_BYTES ||
    def.phase_id !== first.phase_id ||
    def.run_id !== requested.qualification_run_id ||
    def.current_host_binding_sha256 !== first.host_implementation_binding_sha256 ||
    def.required_assurance_scope === "declaration_only" ||
    def.criteria.length === 0 ||
    def.criteria.some((criterion) => criterion.evidence_contract.evidence_class !== "live")
  )
    deny("evidence_denied");

  let gate: ReturnType<typeof requireScaPhaseGatePassV3>;
  try {
    gate = requireScaPhaseGatePassV3({
      store: first.artifact_reads ?? first.store,
      definition: def,
      gate_ref: requested.gate_ref,
    });
  } catch {
    deny("evidence_denied");
  }
  if (
    !sameRef(gate.qualification_ref, requested.qualification_ref) ||
    !sameRef(gate.implementation_identity_ref, def.implementation_identity.ref) ||
    gate.implementation_assurance_scope === "declaration_only" ||
    gate.criterion_results.length !== def.criteria.length ||
    gate.criterion_results.some((result) => result.status !== "PASS") ||
    gate.remaining_gaps.length !== 0 ||
    requested.qualification_ref.run_id !== requested.qualification_run_id ||
    requested.gate_ref.run_id !== requested.qualification_run_id
  )
    deny("evidence_denied");

  const authority = readActivation({
    store: first.artifact_reads ?? first.store,
    ref: requested.authority_ref,
    contract: first.authority_contract,
    schema_id: SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
    run_id: requested.activation_run_id,
    upstream: null, // authority upstream is checked against its parsed contents below
    validate: validateScaActivationAuthorityV1,
  });
  const scope = authority.scope;
  // No caller-selected value can stand in for the host-current production binding.
  if (
    scope.tenant_id !== first.tenant_id ||
    scope.project_id !== first.project_id ||
    scope.phase_id !== first.phase_id ||
    scope.production_playbook_name !== first.production_playbook_name ||
    scope.qualification_run_id !== requested.qualification_run_id ||
    scope.activation_run_id !== requested.activation_run_id ||
    scope.proposed_start_sha256 !== proposedStartSha256 ||
    !sameRef(scope.gate_ref, requested.gate_ref) ||
    !sameRef(scope.qualification_ref, requested.qualification_ref) ||
    !sameRef(scope.implementation_identity_ref, def.implementation_identity.ref) ||
    scope.qualification_policy_data_sha256 !== policyDataSha256 ||
    scope.registration_contract_sha256 !== registrationDigests.contract ||
    scope.runtime_registration_sha256 !== registrationDigests.runtime ||
    scope.host_implementation_binding_sha256 !== first.host_implementation_binding_sha256 ||
    scope.issuer_policy_id !== first.issuer_policy_id ||
    scope.revocation_generation !== first.revocation_generation ||
    scope.operator_principal_id === def.reviewer_identity_id ||
    scope.operator_principal_id === def.reviewer_lineage_id ||
    scope.issuer_policy_id === def.reviewer_authority_id ||
    scope.authority_id === def.reviewer_authority_id
  )
    deny("authority_denied");
  const upstream = [scope.gate_ref, scope.qualification_ref, scope.implementation_identity_ref];
  // Inspect the stored authority metadata *after* parsing its exact issuance reference.
  const authorityMetadata = (first.artifact_reads ?? first.store).metadata(requested.authority_ref);
  if (
    !equal(
      authorityMetadata.upstream_refs,
      sortedRefs([...upstream, authority.issuance_record_ref])
    )
  ) {
    deny("authority_denied");
  }
  const record = readActivation({
    store: first.artifact_reads ?? first.store,
    ref: authority.issuance_record_ref,
    contract: first.issuance_contract,
    schema_id: SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
    run_id: requested.activation_run_id,
    upstream,
    validate: validateScaActivationIssuanceV1,
  });
  if (
    record.authority_id !== scope.authority_id ||
    record.operator_principal_id !== scope.operator_principal_id ||
    record.issuer_policy_id !== first.issuer_policy_id ||
    record.scope_sha256 !== sha256(canonicalJson(scope)) ||
    record.issued_at !== scope.issued_at ||
    !host.verifyIssuance({
      record,
      ref: authority.issuance_record_ref,
      scope,
      policy_id: first.issuer_policy_id,
    })
  )
    deny("authority_denied");
  // The immutable store is re-read as well as host policy; never rely on an inline
  // parsed grant or its self-digest across the decision window.
  const finalRecord = readActivation({
    store: first.artifact_reads ?? first.store,
    ref: authority.issuance_record_ref,
    contract: first.issuance_contract,
    schema_id: SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
    run_id: requested.activation_run_id,
    upstream,
    validate: validateScaActivationIssuanceV1,
  });
  const finalAuthority = readActivation({
    store: first.artifact_reads ?? first.store,
    ref: requested.authority_ref,
    contract: first.authority_contract,
    schema_id: SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
    run_id: requested.activation_run_id,
    upstream: [...upstream, authority.issuance_record_ref],
    validate: validateScaActivationAuthorityV1,
  });
  if (!equal(finalRecord, record) || !equal(finalAuthority, authority)) deny("authority_denied");
  const second = host.sample();
  second.store.assertBoundProject(second.partition_project_id);
  if (
    second.store !== first.store ||
    currentRegistrationDigests(second) === null ||
    !equal(snapshotIdentity(second), firstIdentity) ||
    !host.verifyIssuance({
      record,
      ref: authority.issuance_record_ref,
      scope,
      policy_id: second.issuer_policy_id,
    })
  ) {
    deny("stale_host_state");
  }
  assertRfc3339Utc(second.now, "activation trusted now");
  const now = Date.parse(second.now);
  if (
    Date.parse(gate.evaluated_at) > Date.parse(record.issued_at) ||
    Date.parse(record.issued_at) > now ||
    Date.parse(scope.not_before) > now ||
    now >= Date.parse(scope.expires_at)
  ) {
    deny("authority_denied");
  }
  return Object.freeze({
    authority_id: scope.authority_id,
    authority_sha256: authority.authority_sha256,
    issuance_sha256: record.issuance_sha256,
    tenant_id: scope.tenant_id,
    project_id: scope.project_id,
    phase_id: scope.phase_id,
    production_playbook_name: scope.production_playbook_name,
    qualification_run_id: scope.qualification_run_id,
    activation_run_id: scope.activation_run_id,
    qualification_artifact_content_sha256: requested.qualification_ref.content_digest,
    gate_artifact_content_sha256: requested.gate_ref.content_digest,
    implementation_identity_artifact_content_sha256:
      scope.implementation_identity_ref.content_digest,
    qualification_policy_data_sha256: scope.qualification_policy_data_sha256,
    registration_contract_sha256: scope.registration_contract_sha256,
    runtime_registration_sha256: scope.runtime_registration_sha256,
    host_implementation_binding_sha256: scope.host_implementation_binding_sha256,
    proposed_start_sha256: scope.proposed_start_sha256,
    revocation_generation: scope.revocation_generation,
    checked_at: second.now,
    expires_at: scope.expires_at,
  });
}

/** Read-only admission; never persist, register, dispatch, consume or call a broker.
 * The host supplies a project-bound store, the current active registration and
 * separately authenticated issuance policy. No concrete durable issuer/revocation
 * owner or start-time one-shot CAS exists here: future operator-gated integration
 * must implement both and recheck immediately before effects. No start is granted. */
export function requireScaActivationAdmissionV1(input: {
  readonly host: ScaActivationHostV1;
  readonly proposed: ScaProposedActivationStartV1;
}): VerifiedScaActivationAdmissionViewV1 {
  try {
    return admit(input.host, input.proposed);
  } catch (error) {
    if (error instanceof ScaActivationAdmissionError) throw error;
    deny("authority_denied");
  }
}
