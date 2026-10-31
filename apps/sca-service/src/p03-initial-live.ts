import { Type, type Static } from "typebox";
import type { ScaP03BootstrapVerificationReaderV1 } from "./p03-bootstrap.js";
import { parseScaP03ConsumedJsonV1 } from "./p03-consumed-fixture-custody.js";
import type { HostOperationUseValidatorV1 } from "../../orchestration/dist/host-operations/owner.js";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  type ArtifactRef,
} from "../../orchestration/dist/contracts.js";
import type {
  HostOperationAdapterV1,
  HostOperationExecutionContextV1,
} from "../../orchestration/dist/host-operations/contracts.js";
import {
  ScaP03InitialAuthorizationV1,
  ScaP03InitialProposalBindingV1,
  assertScaP03InitialControlRefV1,
  readScaP03InitialExact,
  readScaP03InitialProposalV1,
  type ScaP03InitialProposalV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import {
  readScaP03InitialGate,
  createScaP03InitialQualificationRegistrationV1,
} from "../../orchestration/dist/sca/p03-initial-qualification.js";
import {
  ScaP03RequestV2Schema,
  ScaP03QualificationCaseV2Schema,
  validateScaP03QualificationFixtureContentV1,
  validateScaP03QualificationFixtureCorpusV2,
  validateScaP03QualificationProfileV2,
  validateScaP03BaselineQuerySetV2,
  validateScaP03QueryScriptV2,
  validateScaP03QueryPlanV2,
  validateScaP03QueryBindingAgainstPlanV2,
  scaP03OracleBoundReleaseSha256V2,
  SCA_P03_PRODUCTION_INPUT_CONTRACTS,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
} from "../../orchestration/dist/sca/p03-contracts.js";
import { validateScaP03P01RuntimeRootV1 } from "../../orchestration/dist/sca/p03-p01-runtime-root.js";
import { scaProposedStartSha256 } from "../../orchestration/dist/sca/qualification-activation.js";
import { OpaqueIdSchema, Sha256Schema } from "../../orchestration/dist/skill-contracts/common.js";
import { createScaP03BoundVerificationReaderV1 } from "./p03-verification-reader.js";
import { createScaP03ApprovedInputReaderV1 } from "./p03-predecessor-inputs.js";
import { ScaP03InitialNativeHostV1 } from "./p03-initial-host.js";
import {
  createScaP03DockerOwnedInitialCandidateV1,
  type DockerRunnerV1,
} from "./p03-docker-runtime.js";
import { createScaP03OwnedDockerTransportV1 } from "./p03-live-transport.js";
import { ScaP03HostWitnessSinkV1 } from "./p03-bootstrap-witness.js";
import { ScaP03WorkspaceRegistryV1 } from "./p03-bootstrap-workspaces.js";
import { revalidateP03SourceOracle } from "./p03-oracle-authority.js";
import { sampleScaP03ProductionBootstrapV1 } from "./p03-bootstrap-cli.js";
import { ScaP03CurrentBootstrapSampleV1Schema } from "../../orchestration/dist/sca/p03-activation-host.js";

/** Pre-live preimages, not a frozen production binding. No seal, runtime identity,
 * host attestation, handoff, current selection, or active P03 authority can enter. */
export const ScaP03PreLiveInputsV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-pre-live-inputs.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    accepted_p01: ScaP03RequestV2Schema.properties.accepted_p01,
    accepted_p02: ScaP03RequestV2Schema.properties.accepted_p02,
    // Exact CURRENT eligible P02 authority/proposal operands are required, but these
    // references alone never establish eligibility or authentication.
    p02_authority_ref: ArtifactRefSchema,
    p02_issuance_ref: ArtifactRefSchema,
    // Native activation operand is an inline closed object, not invented original artifact custody.
    p02_proposed_start: Type.Object(
      {
        tenant_id: OpaqueIdSchema,
        project_id: OpaqueIdSchema,
        phase_id: Type.Literal("SCA-P02"),
        production_playbook_name: Type.Literal("sca-p02"),
        qualification_run_id: OpaqueIdSchema,
        activation_run_id: OpaqueIdSchema,
        proposed_start_sha256: Sha256Schema,
        qualification_ref: ArtifactRefSchema,
        gate_ref: ArtifactRefSchema,
        authority_ref: ArtifactRefSchema,
      },
      { additionalProperties: false }
    ),
    root_tool_id: OpaqueIdSchema,
    toolchain_ref: ArtifactRefSchema,
    root_executable_ref: ArtifactRefSchema,
    root_measurement_ref: ArtifactRefSchema,
    fixture_corpus_ref: ArtifactRefSchema,
    fixture_content_refs: Type.Array(ArtifactRefSchema, { minItems: 3, maxItems: 3 }),
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_review_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    qualification_profile_ref: ArtifactRefSchema,
    baseline_query_set_ref: ArtifactRefSchema,
    query_script_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    query_plan_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    deployment_sha256: Sha256Schema,
    configuration_sha256: Sha256Schema,
    evidence_destination_sha256: Sha256Schema,
    resource_policy_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP03PreLiveInputsV1 = Static<typeof ScaP03PreLiveInputsV1Schema>;
/** Sealed proof operands are a separate purpose, never fixture preparation. */
export const ScaP03SealedBootstrapInputsV1Schema = Type.Object(
  {
    ...Type.Pick(ScaP03PreLiveInputsV1Schema, [
      "schema_version",
      "run_id",
      "tenant_id",
      "project_id",
      "accepted_p01",
      "accepted_p02",
      "p02_authority_ref",
      "p02_issuance_ref",
      "p02_proposed_start",
      "root_tool_id",
      "toolchain_ref",
      "root_executable_ref",
      "root_measurement_ref",
      "deployment_sha256",
      "configuration_sha256",
      "evidence_destination_sha256",
      "resource_policy_sha256",
    ]).properties,
    schema_id: Type.Literal("penny.sca-p03-sealed-bootstrap-inputs.v1"),
    manifest_sha256: Sha256Schema,
    source_manifest_sha256: Sha256Schema,
    sealed_handoff_sha256: Sha256Schema,
    production_record_ref: ArtifactRefSchema,
    record_ref: ArtifactRefSchema,
    binding_ref: ArtifactRefSchema,
    review_ref: ArtifactRefSchema,
    attestation_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type ScaP03SealedBootstrapInputsV1 = Static<typeof ScaP03SealedBootstrapInputsV1Schema>;
export const ScaP03NativeInputsV1Schema = Type.Union([
  ScaP03PreLiveInputsV1Schema,
  ScaP03SealedBootstrapInputsV1Schema,
]);
export const ScaP03SealedBootstrapEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-initial-evidence.v1"),
    schema_version: Type.Literal(1),
    evidence_stage: Type.Literal("sealed_bootstrap_verification"),
    status: Type.Literal("verified"),
    run_id: OpaqueIdSchema,
    invocation_nonce: OpaqueIdSchema,
    request_sha256: Sha256Schema,
    sealed_bootstrap_inputs_ref: ArtifactRefSchema,
    manifest_sha256: Sha256Schema,
    sample: ScaP03CurrentBootstrapSampleV1Schema,
    measurement_scope: Type.Union([
      Type.Literal("live_observed"),
      Type.Literal("deterministic_transport_test"),
    ]),
    cleanup: Type.Literal("owned_absence_observed"),
    formal_qualification_granted: Type.Literal(false),
    activation_granted: Type.Literal(false),
    p04_dispatch_permitted: Type.Literal(false),
  },
  { additionalProperties: false }
);

function readSealedPreimages(input: {
  store: ArtifactStore;
  authorization: ScaP03InitialAuthorizationV1;
  native_host: ScaP03InitialNativeHostV1;
  proposal: ScaP03InitialProposalV1;
  context: HostOperationExecutionContextV1;
}) {
  const { proposal, context } = input;
  const gate = readScaP03InitialGate(
    input.store,
    context.readInput("initial_proposal").ref,
    context.readInput("initial_transport").ref
  );
  input.authorization.assertEffect(context, proposal, gate);
  if (proposal.effect !== "bootstrap_verification") throw new Error("p03_sealed_purpose_required");
  const ref = proposal.sealed_bootstrap_inputs_ref;
  if (
    ref.kind !== "sca-p03-sealed-bootstrap-inputs" ||
    ref.producer !== "host:sca-p03-initial-authorization" ||
    ref.content_schema?.schema_id !== "penny.sca-p03-sealed-bootstrap-inputs.v1" ||
    ref.content_schema.schema_version !== 1
  )
    throw new Error("p03_sealed_inputs_ref_invalid");
  const reader = createScaP03BoundVerificationReaderV1(context, input.store);
  const bytes = reader.read(ref);
  if (bytes.byteLength > 1_048_576) throw new Error("p03_sealed_inputs_limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (text !== canonicalJson(value)) throw new Error("p03_sealed_inputs_noncanonical");
  const m = validateContract(ScaP03SealedBootstrapInputsV1Schema, value, "P03 sealed inputs");
  validateScaP03P01RuntimeRootV1({ store: reader, ...m });
  for (const proof of [
    m.production_record_ref,
    m.record_ref,
    m.binding_ref,
    m.review_ref,
    m.attestation_ref,
  ])
    reader.read(proof);
  input.native_host.assertSealedInputs(m, proposal);
  return { m, gate };
}

async function verifySealedBootstrap(input: {
  store: ArtifactStore;
  authorization: ScaP03InitialAuthorizationV1;
  native_host: ScaP03InitialNativeHostV1;
  proposal: ScaP03InitialProposalV1;
  context: HostOperationExecutionContextV1;
  deterministic_test_transport?: DockerRunnerV1;
}) {
  const { context, proposal } = input;
  const { m, gate } = readSealedPreimages(input);
  if (context.journal.lifecycle !== "lease_acquired")
    throw new Error("p03_sealed_uncertain_prior_effect");
  const c = input.native_host.capsule;
  if (c.schema_id !== "penny.sca-p03-sealed-bootstrap-capsule.v1")
    throw new Error("p03_sealed_capsule_required");
  const sample = await sampleScaP03ProductionBootstrapV1(c.verification, {
    ...input,
    gate,
    sealed_inputs: m,
  });
  input.authorization.assertEffect(context, proposal, gate);
  input.native_host.assertSealedInputs(m, proposal);
  const result = validateContract(
    ScaP03SealedBootstrapEvidenceV1Schema,
    {
      schema_id: "penny.sca-p03-initial-evidence.v1",
      schema_version: 1,
      evidence_stage: "sealed_bootstrap_verification",
      status: "verified",
      run_id: proposal.run_id,
      invocation_nonce: proposal.invocation_nonce,
      request_sha256: context.directive.request_sha256,
      sealed_bootstrap_inputs_ref:
        proposal.effect === "bootstrap_verification" ? proposal.sealed_bootstrap_inputs_ref : null,
      manifest_sha256: m.manifest_sha256,
      sample,
      measurement_scope:
        input.deterministic_test_transport === undefined
          ? "live_observed"
          : "deterministic_transport_test",
      cleanup: "owned_absence_observed",
      formal_qualification_granted: false,
      activation_granted: false,
      p04_dispatch_permitted: false,
    },
    "P03 sealed verification evidence"
  );
  const content = canonicalJson(result);
  if (Buffer.byteLength(content) > proposal.resources.max_evidence_bytes)
    throw new Error("p03_sealed_evidence_limit");
  context.recordFetched({
    schema_version: 1,
    content_sha256: sha256(content),
    byte_length: Buffer.byteLength(content),
    item_count: 1,
    poll_count: 0,
  });
  const disposition = {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  } as const;
  return {
    disposition,
    ...context.persist({
      disposition,
      operation_result: {
        contract: context.declaration.result,
        media_type: "application/json",
        content,
      },
    }),
  };
}

export const ScaP03InitialPreparedProbeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-initial-prepared-probe.v1"),
    schema_version: Type.Literal(1),
    status: Type.Literal("blocked"),
    evidence_stage: Type.Literal("pre_live_preparation_only"),
    run_id: OpaqueIdSchema,
    invocation_nonce: OpaqueIdSchema,
    pre_live_inputs_ref: ArtifactRefSchema,
    query_release_sha256: Sha256Schema,
    predecessor_current_admission: Type.Literal("not_performed"),
    environment_measurement: Type.Literal("not_performed"),
    fixture_execution: Type.Literal("not_performed"),
    cleanup: Type.Literal("no_effects_created"),
    missing_input: Type.Tuple([
      Type.Literal("trusted_current_p02_owner_admission"),
      Type.Literal("protected_private_deployment_capsule"),
      Type.Literal("initial_owned_environment_and_fixture_collector"),
    ]),
    formal_qualification_granted: Type.Literal(false),
    activation_granted: Type.Literal(false),
    p04_dispatch_permitted: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type ScaP03InitialPreparedProbeV1 = Static<typeof ScaP03InitialPreparedProbeV1Schema>;

/** Read-only prepared-probe seam. The circular live adapter/owner factories are removed.
 * This does NOT dispatch Docker, mint a live sampler, authenticate P02, or persist a
 * positive observation. Future host composition must admit current P02 with its native
 * owner, measure protected deployment, then collect through the canonical operation guard. */
function readInitialPreimages(input: {
  readonly store: ArtifactStore;
  readonly authorization: ScaP03InitialAuthorizationV1;
  readonly proposal: ScaP03InitialProposalV1;
  readonly context: HostOperationExecutionContextV1;
}) {
  if (
    !(input.store instanceof ArtifactStore) ||
    !(input.authorization instanceof ScaP03InitialAuthorizationV1)
  )
    throw new Error("p03_initial_canonical_owners_required");
  const { context, proposal } = input;
  const proposalRef = context.readInput("initial_proposal").ref;
  const transportRef = context.readInput("initial_transport").ref;
  const gate = readScaP03InitialGate(input.store, proposalRef, transportRef);
  input.authorization.assertEffect(context, proposal, gate);
  const reader = createScaP03BoundVerificationReaderV1(context, input.store);
  const checked = replayScaP03InitialFixturePreimagesV1({ proposal, reader });
  input.authorization.assertEffect(context, proposal, gate);
  return checked;
}

/** Pure historical operand replay. No current authorization, host state, or execution context. */
export function replayScaP03InitialFixturePreimagesV1(input: {
  readonly proposal: ScaP03InitialProposalV1;
  readonly reader: ScaP03BootstrapVerificationReaderV1;
}) {
  const { proposal, reader } = input;
  // The manifest is one exact proposal-bound proof slot, not an ambient path or scan.
  const manifests = proposal.input_refs.filter((ref) => ref.kind === "sca-p03-pre-live-inputs");
  const manifestRef = manifests[0];
  if (
    manifests.length !== 1 ||
    manifestRef === undefined ||
    manifestRef.run_id !== proposal.run_id ||
    manifestRef.producer !== "host:sca-p03-initial-authorization" ||
    manifestRef.content_schema?.schema_id !== "penny.sca-p03-pre-live-inputs.v1" ||
    manifestRef.content_schema.schema_version !== 1
  )
    throw new Error("p03_initial_pre_live_manifest_required");
  const body = (ref: ArtifactRef): unknown => {
    const bytes = reader.read(ref);
    if (bytes.byteLength > 4 * 1_048_576) throw new Error("p03_initial_preimage_limit");
    return parseScaP03ConsumedJsonV1(bytes, 4 * 1_048_576);
  };
  const m = validateContract(ScaP03PreLiveInputsV1Schema, body(manifestRef), "P03 pre-live inputs");
  if (
    proposal.effect !== "fixture_qualification" ||
    m.run_id !== proposal.run_id ||
    m.project_id !== proposal.project_id ||
    m.deployment_sha256 !== proposal.deployment_sha256 ||
    m.configuration_sha256 !== proposal.configuration_sha256 ||
    m.evidence_destination_sha256 !== proposal.evidence_destination_sha256 ||
    m.resource_policy_sha256 !== sha256(canonicalJson(proposal.resources)) ||
    m.fixture_corpus_ref.content_digest !== proposal.fixture_cohort_sha256
  )
    throw new Error("p03_initial_pre_live_binding_mismatch");
  // Read only bound slots; the trusted profile still owes fresh native P02 admission.
  validateScaP03P01RuntimeRootV1({ store: reader, ...m });
  if (
    m.p02_proposed_start.tenant_id !== m.tenant_id ||
    m.p02_proposed_start.project_id !== m.project_id ||
    canonicalJson(m.p02_proposed_start.authority_ref) !== canonicalJson(m.p02_authority_ref) ||
    canonicalJson(m.p02_proposed_start.gate_ref) !==
      canonicalJson(m.accepted_p02.qualification_gate_ref) ||
    m.p02_proposed_start.proposed_start_sha256 !== scaProposedStartSha256(m.p02_proposed_start)
  )
    throw new Error("p03_initial_p02_proposal_mismatch");
  reader.read(m.p02_proposed_start.qualification_ref);
  for (const ref of [
    m.p02_authority_ref,
    m.p02_issuance_ref,
    m.accepted_p02.transition_ref,
    m.accepted_p02.p02_request_ref,
    m.accepted_p02.gate_ref,
    m.accepted_p02.m1_ref,
    m.accepted_p02.coverage_matrix_ref,
    m.accepted_p02.evidence_manifest_ref,
    m.accepted_p02.successor_ledger_ref,
    ...m.accepted_p02.evidence_refs,
    m.accepted_p02.qualification_definition_ref,
    m.accepted_p02.qualification_gate_ref,
  ])
    reader.read(ref);
  const check = (
    ref: ArtifactRef,
    contract: Readonly<{
      kind: string;
      producer: string;
      content_schema: { schema_id: string; schema_version: number };
    }>,
    upstream: readonly ArtifactRef[] = []
  ) => {
    const metadata = reader.metadata(ref);
    if (
      ref.run_id !== m.run_id ||
      ref.phase !== "SCA-P03" ||
      ref.branch_id !== null ||
      ref.version !== 1 ||
      ref.kind !== contract.kind ||
      ref.producer !== contract.producer ||
      ref.media_type !== "application/json" ||
      canonicalJson(ref.content_schema) !== canonicalJson(contract.content_schema) ||
      metadata.parent_ref !== null ||
      metadata.domain_revision_parent_ref != null ||
      canonicalJson(metadata.upstream_refs) !== canonicalJson(upstream)
    )
      throw new Error("p03_initial_preimage_provenance_invalid");
  };
  for (const ref of m.fixture_content_refs)
    check(ref, SCA_P03_PRODUCTION_INPUT_CONTRACTS.fixture_content);
  check(
    m.fixture_corpus_ref,
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.fixture_corpus,
    m.fixture_content_refs
  );
  check(m.qualification_profile_ref, SCA_P03_PRODUCTION_INPUT_CONTRACTS.qualification_profile);
  for (const ref of m.query_script_refs)
    check(ref, SCA_P03_PRODUCTION_INPUT_CONTRACTS.query_script);
  for (const ref of m.query_plan_refs) check(ref, SCA_P03_PRODUCTION_INPUT_CONTRACTS.query_plan);
  check(m.baseline_query_set_ref, SCA_P03_PRODUCTION_INPUT_CONTRACTS.baseline_query_set, [
    ...m.query_script_refs,
    ...m.query_plan_refs,
  ]);
  check(m.source_oracle_ref, {
    kind: "sca-p03-source-oracle",
    producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
    content_schema: { schema_id: SCA_P03_SOURCE_ORACLE_SCHEMA, schema_version: 2 },
  });
  check(
    m.source_oracle_review_ref,
    {
      kind: "sca-p03-source-oracle-review",
      producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
      content_schema: { schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA, schema_version: 1 },
    },
    [m.source_oracle_ref]
  );
  check(
    m.source_oracle_validation_ref,
    {
      kind: "sca-p03-source-oracle-validation",
      producer: SCA_P03_SOURCE_ORACLE_VALIDATOR,
      content_schema: { schema_id: SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA, schema_version: 1 },
    },
    [
      m.source_oracle_ref,
      m.fixture_corpus_ref,
      ...m.fixture_content_refs,
      m.source_oracle_review_ref,
    ].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id))
  );
  const corpus = validateScaP03QualificationFixtureCorpusV2(body(m.fixture_corpus_ref));
  if (canonicalJson(corpus.fixture_content_refs) !== canonicalJson(m.fixture_content_refs))
    throw new Error("p03_initial_fixture_cohort_mismatch");
  const fixtures = m.fixture_content_refs.map((ref, i) => {
    const f = validateScaP03QualificationFixtureContentV1(body(ref));
    if (f.fixture_id !== corpus.fixture_ids[i] || f.language !== corpus.languages[i])
      throw new Error("p03_initial_fixture_cohort_mismatch");
    return { ...f, ref, bytes: Buffer.from(f.content_base64, "base64") };
  });
  const profile = validateScaP03QualificationProfileV2(body(m.qualification_profile_ref));
  // Bound typed oracle JSON before the owning parsers recurse into its original bytes.
  for (const ref of [
    m.source_oracle_ref,
    m.source_oracle_review_ref,
    m.source_oracle_validation_ref,
  ])
    body(ref);
  const oracle = revalidateP03SourceOracle({
    run_id: m.run_id,
    oracle_ref: m.source_oracle_ref,
    oracle_bytes: reader.read(m.source_oracle_ref),
    review_ref: m.source_oracle_review_ref,
    review_bytes: reader.read(m.source_oracle_review_ref),
    receipt_ref: m.source_oracle_validation_ref,
    receipt_bytes: reader.read(m.source_oracle_validation_ref),
    corpus_ref: m.fixture_corpus_ref,
    corpus,
    fixtures,
  });
  const set = validateScaP03BaselineQuerySetV2(body(m.baseline_query_set_ref));
  const queries = set.ordered_queries.map((entry, i) => {
    const scriptRef = m.query_script_refs[i];
    const planRef = m.query_plan_refs[i];
    if (
      scriptRef === undefined ||
      planRef === undefined ||
      canonicalJson(entry.script_ref) !== canonicalJson(scriptRef) ||
      canonicalJson(entry.plan_ref) !== canonicalJson(planRef) ||
      entry.script_sha256 !== scriptRef.content_digest ||
      entry.plan_sha256 !== planRef.content_digest
    )
      throw new Error("p03_initial_query_preimage_mismatch");
    const script = validateScaP03QueryScriptV2(body(scriptRef));
    const plan = validateScaP03QueryPlanV2(body(planRef));
    return {
      query_id: entry.query_id,
      script_id: script.script_id,
      script_sha256: script.content_sha256,
      binding: validateScaP03QueryBindingAgainstPlanV2({
        release_id: set.release_id,
        query_id: entry.query_id,
        script,
        plan,
      }),
      plan,
    };
  });
  const r = proposal.resources;
  if (
    fixtures.length > r.max_source_files ||
    fixtures.reduce((n, f) => n + f.bytes.byteLength, 0) > r.max_source_bytes ||
    queries.some(
      (q) => q.plan.max_ast_depth > r.max_ast_depth || q.plan.max_ast_nodes > r.max_ast_nodes
    ) ||
    oracle.validated_receipt.status !== "PASS" ||
    profile.fidelity_requirements.length === 0
  )
    throw new Error("p03_initial_preimage_resources_invalid");
  const release = scaP03OracleBoundReleaseSha256V2({
    query_set_id: set.query_set_id,
    release_id: set.release_id,
    query_set_sha256: set.query_set_sha256,
    queries,
    oracle_ref: m.fixture_corpus_ref,
    oracle: corpus,
  });
  return {
    m,
    manifestRef,
    fixtures,
    profile,
    oracle,
    corpus,
    query_release: {
      query_set_id: set.query_set_id,
      release_id: set.release_id,
      release_sha256: release,
      queries,
    },
  };
}

/** Read-only diagnostic. Actual native composition registers the collector below. */
export function prepareScaP03InitialProbeV1(
  input: Parameters<typeof readInitialPreimages>[0]
): ScaP03InitialPreparedProbeV1 {
  const { manifestRef, query_release } = readInitialPreimages(input);
  const { proposal } = input;
  return validateContract(
    ScaP03InitialPreparedProbeV1Schema,
    {
      schema_id: "penny.sca-p03-initial-prepared-probe.v1",
      schema_version: 1,
      status: "blocked",
      evidence_stage: "pre_live_preparation_only",
      run_id: proposal.run_id,
      invocation_nonce: proposal.invocation_nonce,
      pre_live_inputs_ref: manifestRef,
      query_release_sha256: query_release.release_sha256,
      predecessor_current_admission: "not_performed",
      environment_measurement: "not_performed",
      fixture_execution: "not_performed",
      cleanup: "no_effects_created",
      missing_input: [
        "trusted_current_p02_owner_admission",
        "protected_private_deployment_capsule",
        "initial_owned_environment_and_fixture_collector",
      ],
      formal_qualification_granted: false,
      activation_granted: false,
      p04_dispatch_permitted: false,
    },
    "P03 initial prepared probe"
  );
}

/** Install on the canonical owner: every recovery/cache/settled/consumed path rechecks current
 * authority without running a probe before the journal/lease. */
export function createScaP03InitialUseValidatorV1(input: {
  store: ArtifactStore;
  authorization: ScaP03InitialAuthorizationV1;
  binding: ScaP03InitialProposalBindingV1;
  native_host?: ScaP03InitialNativeHostV1;
}): HostOperationUseValidatorV1 {
  if (!(input.binding instanceof ScaP03InitialProposalBindingV1))
    throw new Error("p03_initial_pin_required");
  const preflight: NonNullable<HostOperationUseValidatorV1["preflightRefs"]> = ({
    directive,
    declaration,
  }) => {
    input.binding.assertRef(directive.request_ref);
    input.binding.assertRun(directive.identity.run_id);
    const proposal = input.binding.proposal;
    const expected =
      createScaP03InitialQualificationRegistrationV1(input).host_operations?.declarations[0];
    if (
      canonicalJson(expected) !== canonicalJson(declaration) ||
      directive.operation_id !== `initial:${proposal.approval_id}:${proposal.invocation_nonce}` ||
      directive.policy_binding.backend_key_sha256 !== proposal.backend_resource_sha256
    )
      throw new Error("p03_initial_use_binding_invalid");
    const refs = directive.input_artifacts.artifacts;
    if (refs.length !== proposal.input_refs.length + 3)
      throw new Error("p03_initial_use_slots_invalid");
    const ids = new Set<string>(),
      slots = new Set<string>();
    for (const operand of refs) {
      if (ids.has(operand.ref.artifact_id) || slots.has(operand.slot))
        throw new Error("p03_initial_use_slots_invalid");
      ids.add(operand.ref.artifact_id);
      slots.add(operand.slot);
    }
    for (const kind of ["proposal", "transport", "witness"]) {
      const ref = refs.find((r) => r.slot === `initial_${kind}`)?.ref;
      if (ref === undefined) throw new Error("p03_initial_use_input_missing");
      assertScaP03InitialControlRefV1(ref, kind);
      if (ref.run_id !== proposal.run_id) throw new Error("p03_initial_use_binding_invalid");
      if (kind === "proposal") input.binding.assertRef(ref);
    }
    for (const [i, ref] of proposal.input_refs.entries()) {
      const actual = refs.find((r) => r.slot === `proof_${String(i).padStart(3, "0")}`)?.ref;
      if (canonicalJson(actual ?? null) !== canonicalJson(ref))
        throw new Error("p03_initial_use_closure_changed");
    }
  };
  return {
    preflightRefs: preflight,
    validateUse({ directive, declaration, request_bytes, signal }) {
      signal.throwIfAborted();
      preflight({ directive, declaration });
      const proposal = input.binding.read(input.store, directive.request_ref);
      if (canonicalJson(readScaP03InitialProposalV1(request_bytes)) !== canonicalJson(proposal))
        throw new Error("p03_initial_use_binding_invalid");
      input.store.assertBoundProject(proposal.project_id);
      const find = (slot: string) => {
        const ref = directive.input_artifacts.artifacts.find((a) => a.slot === slot)?.ref;
        if (ref === undefined) throw new Error("p03_initial_use_input_missing");
        return ref;
      };
      // Exact bounded controls and authentic witness precede dependent inspection.
      const binding = readScaP03InitialGate(
        input.store,
        directive.request_ref,
        find("initial_transport")
      );
      const witnessMetadata = input.store.metadata(find("initial_witness"));
      if (
        witnessMetadata.parent_ref !== null ||
        witnessMetadata.domain_revision_parent_ref != null ||
        canonicalJson(witnessMetadata.upstream_refs) !==
          canonicalJson([directive.request_ref, find("initial_transport")])
      )
        throw new Error("p03_initial_witness_custody_invalid");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        readScaP03InitialExact(input.store, find("initial_witness"))
      );
      const value: unknown = JSON.parse(text);
      if (
        canonicalJson(value) !== text ||
        input.authorization.admit(proposal, binding, value).decision !== "approve"
      )
        throw new Error("p03_initial_approval_required");
      if (proposal.effect === "bootstrap_verification") {
        if (!(input.native_host instanceof ScaP03InitialNativeHostV1))
          throw new Error("p03_sealed_native_use_validator_required");
        const reader = createScaP03ApprovedInputReaderV1(input.store, proposal.input_refs);
        const manifest = validateContract(
          ScaP03SealedBootstrapInputsV1Schema,
          reader.json(proposal.sealed_bootstrap_inputs_ref, "sealed_inputs"),
          "P03 sealed use inputs"
        );
        reader.finish();
        input.native_host.assertSealedInputs(manifest, proposal);
      }
    },
  };
}

const ObservationSchema = Type.Object(
  {
    ordinal: Type.Integer({ minimum: 1, maximum: 2048 }),
    argv_sha256: Sha256Schema,
    output_base64: Type.String({ maxLength: 1_398_104 }),
    output_sha256: Sha256Schema,
    byte_length: Type.Integer({ minimum: 0, maximum: 1_048_576 }),
  },
  { additionalProperties: false }
);
export const ScaP03InitialEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-initial-evidence.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    invocation_nonce: OpaqueIdSchema,
    request_sha256: Sha256Schema,
    pre_live_inputs_ref: ArtifactRefSchema,
    input_refs: Type.Array(ArtifactRefSchema, { maxItems: 512 }),
    status: Type.Union([Type.Literal("observed"), Type.Literal("fixture_blocked")]),
    predecessor_current_admission: Type.Literal("native_current_owner"),
    measurement_scope: Type.Union([
      Type.Literal("live_observed"),
      Type.Literal("deterministic_transport_test"),
    ]),
    query_release_sha256: Sha256Schema,
    environment: Type.Object(
      {
        docker_executable_sha256: Sha256Schema,
        docker_client_version: Type.String({ maxLength: 64 }),
        docker_server_version: Type.String({ maxLength: 64 }),
        image_ref: Type.String({ maxLength: 512 }),
        image_id: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
        joern_version: Type.String({ maxLength: 64 }),
        php_frontend_version: Type.String({ maxLength: 64 }),
        javascript_frontend_version: Type.String({ maxLength: 64 }),
        jvm_version: Type.String({ maxLength: 64 }),
        php_runtime_version: Type.String({ maxLength: 64 }),
        helper_version: Type.String({ maxLength: 64 }),
      },
      { additionalProperties: false }
    ),
    cases: Type.Array(ScaP03QualificationCaseV2Schema, { minItems: 21, maxItems: 21 }),
    original_observations: Type.Array(ObservationSchema, { minItems: 1, maxItems: 2048 }),
    attempt_witness_base64: Type.String({ maxLength: 1_398_104 }),
    cleanup: Type.Literal("owned_absence_observed"),
    independent_review: Type.Literal("required"),
    formal_qualification_granted: Type.Literal(false),
    activation_granted: Type.Literal(false),
    p04_dispatch_permitted: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type ScaP03InitialEvidenceV1 = Static<typeof ScaP03InitialEvidenceV1Schema>;

/** Trusted host-only adapter. All effectful work is deferred until the registered native gate
 * has admitted the exact witness and the canonical owner has acquired the approved backend.
 * An observation double is explicitly test-only transport, never a LIVE evidence claim. */
export function createScaP03InitialLiveAdapterV1(input: {
  readonly store: ArtifactStore;
  readonly authorization: ScaP03InitialAuthorizationV1;
  readonly native_host: ScaP03InitialNativeHostV1;
  readonly binding: ScaP03InitialProposalBindingV1;
  readonly deterministic_test_transport?: DockerRunnerV1;
}): HostOperationAdapterV1 {
  if (
    !(input.store instanceof ArtifactStore) ||
    !(input.authorization instanceof ScaP03InitialAuthorizationV1) ||
    !(input.native_host instanceof ScaP03InitialNativeHostV1)
  )
    throw new Error("p03_initial_native_admission_required");
  const declaration =
    createScaP03InitialQualificationRegistrationV1(input).host_operations?.declarations[0];
  if (declaration === undefined) throw new Error("p03_initial_declaration_required");
  return Object.freeze({
    adapter_id: declaration.adapter_id,
    inspectRequest({ directive, request_bytes }) {
      const proposal = readScaP03InitialProposalV1(request_bytes);
      input.binding.assertRef(directive.request_ref);
      input.binding.assertProposal(proposal);
      input.authorization.assertProposal(proposal);
      input.native_host.assertCapsule(proposal);
      if (
        directive.identity.run_id !== proposal.run_id ||
        directive.operation_id !== `initial:${proposal.approval_id}:${proposal.invocation_nonce}` ||
        canonicalJson(proposal.resources) !== canonicalJson(input.binding.proposal.resources)
      )
        throw new Error("p03_initial_inspection_binding_invalid");
      return {
        schema_version: 1,
        operation_kind: declaration.operation_kind,
        adapter_id: declaration.adapter_id,
        backend_binding_id: declaration.backend_binding_id,
        backend_key_sha256: proposal.backend_resource_sha256,
      };
    },
    async run(context) {
      input.binding.assertRef(context.directive.request_ref);
      const proposal = readScaP03InitialProposalV1(context.request_bytes);
      input.binding.assertProposal(proposal);
      if (proposal.effect === "bootstrap_verification")
        return verifySealedBootstrap({ ...input, proposal, context });
      const checked = readInitialPreimages({ ...input, proposal, context });
      const gate = readScaP03InitialGate(
        input.store,
        context.readInput("initial_proposal").ref,
        context.readInput("initial_transport").ref
      );
      const assertAuthority = () => {
        input.authorization.assertEffect(context, proposal, gate);
        input.native_host.assertCapsule(proposal);
        input.native_host.assertCurrentP02(checked.m, proposal);
      };
      assertAuthority();
      input.native_host.assertPredecessorClosure(checked.m, proposal);
      // A recovered submitted operation cannot rerun an uncertain local/container effect.
      if (context.journal.lifecycle !== "lease_acquired")
        throw new Error("p03_initial_uncertain_prior_effect_quarantine_required");
      const capsule = input.native_host.capsule;
      const raw =
        input.deterministic_test_transport ??
        createScaP03OwnedDockerTransportV1({
          endpoint: {
            executable: capsule.config.docker_executable,
            executable_sha256: capsule.config.expected_docker_executable_sha256,
            socket: capsule.docker_socket,
            image_ref: capsule.config.image_ref,
          },
          resources: proposal.resources,
          context,
          assertAuthority,
        });
      const observations: Static<typeof ObservationSchema>[] = [];
      let evidenceBytes = 0;
      const runner: DockerRunnerV1 = async (command) => {
        // Native authority/clock checks are independent of transport doubles.
        if (command.signal === context.signal) assertAuthority();
        const text = await raw(command);
        const bytes = Buffer.from(text, "utf8");
        const observation = {
          ordinal: observations.length + 1,
          argv_sha256: sha256(canonicalJson(command.argv)),
          output_base64: bytes.toString("base64"),
          output_sha256: sha256(bytes),
          byte_length: bytes.byteLength,
        };
        validateContract(ObservationSchema, observation, "P03 original observation");
        evidenceBytes += Buffer.byteLength(canonicalJson(observation));
        if (evidenceBytes > proposal.resources.max_evidence_bytes)
          throw new Error("p03_initial_evidence_budget");
        observations.push(observation);
        if (command.signal === context.signal)
          context.reportActivity("p03_initial_observation", bytes.byteLength + 1);
        return text;
      };
      const witnessIdentity = {
        runtime_id: capsule.config.runtime_id,
        isolation_id: capsule.config.isolation_id,
        implementation_sha256: capsule.config.implementation_identity_sha256,
        deployment_sha256: capsule.config.deployment_identity_sha256,
        docker_executable_sha256: capsule.config.expected_docker_executable_sha256,
        docker_client_version: capsule.config.expected_docker_client_version,
        docker_server_version: capsule.config.expected_docker_server_version,
        image_id: `sha256:${"0".repeat(64)}`,
        joern_version: capsule.config.expected_joern_version,
        runtime_package_sha256: sha256("unmeasured"),
      };
      const witness = new ScaP03HostWitnessSinkV1(
        {
          run_id: proposal.run_id,
          candidate_sha256: context.directive.request_sha256,
          identity: witnessIdentity,
        },
        ScaP03WorkspaceRegistryV1.inProcess()
      );
      let cleanupFinished: () => void = () => {
        throw new Error("p03_initial_cleanup_not_initialized");
      };
      const cleanupSettled = new Promise<void>((resolve) => {
        cleanupFinished = resolve;
      });
      // The canonical owner races cancellation against run(). Keep its lease fenced
      // until our already-owned cleanup has settled; never race a background finally
      // against parent consumption. Cleanup uncertainty still quarantines the backend.
      context.registerRemoteCancellation(async (signal) => {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void cleanupSettled.then(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          });
        });
        return {
          remote_disposition: "may_continue",
          reason_code: "p03_cancelled_cleanup_settled_review_required",
        };
      });
      try {
        const candidate = await createScaP03DockerOwnedInitialCandidateV1(capsule.config, runner, {
          context,
          resources: proposal.resources,
          authorization: input.authorization,
          proposal,
          gate,
          native_host: input.native_host,
          pre_live: checked.m,
          store: input.store,
          witness,
        });
        const environment = await candidate.measureEnvironment(context.signal);
        witnessIdentity.image_id = environment.image_id;
        const { docker_executable_bytes, ...versions } = environment;
        witnessIdentity.runtime_package_sha256 = sha256(canonicalJson(versions));
        const output = await candidate.qualify({
          fixtures: checked.fixtures,
          expected_cases: checked.corpus.expected_cases,
          source_oracle_validation_ref: checked.m.source_oracle_validation_ref,
          source_oracle_validation_receipt: checked.oracle.validated_receipt,
          query_release: checked.query_release,
          fidelity_requirements: checked.profile.fidelity_requirements,
          signal: context.signal,
        });
        assertAuthority();
        const result = validateContract(
          ScaP03InitialEvidenceV1Schema,
          {
            schema_id: "penny.sca-p03-initial-evidence.v1",
            schema_version: 1,
            run_id: proposal.run_id,
            invocation_nonce: proposal.invocation_nonce,
            request_sha256: context.directive.request_sha256,
            pre_live_inputs_ref: checked.manifestRef,
            input_refs: proposal.input_refs,
            status: output.cases.every((entry) => entry.status === "passed")
              ? "observed"
              : "fixture_blocked",
            predecessor_current_admission: "native_current_owner",
            measurement_scope:
              input.deterministic_test_transport === undefined
                ? "live_observed"
                : "deterministic_transport_test",
            query_release_sha256: output.executed_query_release_sha256,
            environment: { ...versions, docker_executable_sha256: sha256(docker_executable_bytes) },
            cases: output.cases,
            original_observations: observations,
            attempt_witness_base64: Buffer.from(witness.finalize("completed")).toString("base64"),
            cleanup: "owned_absence_observed",
            independent_review: "required",
            formal_qualification_granted: false,
            activation_granted: false,
            p04_dispatch_permitted: false,
          },
          "P03 initial observations"
        );
        const content = canonicalJson(result);
        if (Buffer.byteLength(content) > proposal.resources.max_evidence_bytes)
          throw new Error("p03_initial_evidence_budget");
        context.recordFetched({
          schema_version: 1,
          content_sha256: sha256(content),
          byte_length: Buffer.byteLength(content),
          item_count: 1,
          poll_count: 0,
        });
        const disposition = {
          outcome: "completed",
          remote_disposition: "proven_terminal",
          lease_disposition: "released",
          retryable: false,
          reason_code: null,
        } as const;
        const persisted = context.persist({
          disposition,
          operation_result: {
            contract: declaration.result,
            media_type: "application/json",
            content,
          },
        });
        return { disposition, ...persisted };
      } finally {
        cleanupFinished();
      }
    },
  } satisfies HostOperationAdapterV1);
}
