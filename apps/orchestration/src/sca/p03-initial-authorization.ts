import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { currentArtifactRef, type ArtifactHostStore } from "../artifact-store.js";
import type { HostOperationExecutionContextV1 } from "../host-operations/contracts.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";

/** Explicit inner budgets; none of the specification's proposed partitions are defaults. */
export const ScaP03InitialResourcesV1Schema = Type.Object(
  {
    cpus: Type.Number({ exclusiveMinimum: 0, maximum: 2 }),
    memory_bytes: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
    pids: Type.Integer({ minimum: 1, maximum: 64 }),
    tmp_bytes: Type.Integer({ minimum: 1, maximum: 67_108_864 }),
    work_bytes: Type.Integer({ minimum: 1, maximum: 67_108_864 }),
    command_output_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    concurrency: Type.Literal(1),
    inactivity_ms: Type.Literal(60_000),
    cleanup_grace_ms: Type.Integer({ minimum: 1, maximum: 60_000 }),
    max_commands: Type.Integer({ minimum: 1, maximum: 1024 }),
    max_source_bytes: Type.Integer({ minimum: 1, maximum: 67_108_864 }),
    max_source_files: Type.Integer({ minimum: 1, maximum: 128 }),
    max_graph_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    max_query_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    max_query_items: Type.Integer({ minimum: 1, maximum: 1024 }),
    max_page_items: Type.Integer({ minimum: 1, maximum: 1024 }),
    max_pages_per_query: Type.Integer({ minimum: 1, maximum: 64 }),
    max_ast_depth: Type.Integer({ minimum: 1, maximum: 256 }),
    max_ast_nodes: Type.Integer({ minimum: 1, maximum: 4096 }),
    max_num_def: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    jvm_heap_bytes: Type.Integer({ minimum: 1, maximum: 536_870_912 }),
    max_host_workspace_bytes: Type.Integer({ minimum: 1, maximum: 134_217_728 }),
    max_evidence_bytes: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
  },
  { additionalProperties: false }
);
export type ScaP03InitialResourcesV1 = Static<typeof ScaP03InitialResourcesV1Schema>;
export const SCA_P03_INITIAL_PROPOSAL_SCHEMA = "penny.sca-p03-initial-proposal.v1";
const initialProposalCommon = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_INITIAL_PROPOSAL_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    invocation_nonce: OpaqueIdSchema,
    approval_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    principal_id: OpaqueIdSchema,
    policy_id: OpaqueIdSchema,
    installation_id: OpaqueIdSchema,
    revocation_generation: Type.Integer({ minimum: 1 }),
    state_authority_sha256: Sha256Schema,
    backend_resource_sha256: Sha256Schema,
    deployment_sha256: Sha256Schema,
    configuration_sha256: Sha256Schema,
    evidence_destination_sha256: Sha256Schema,
    fixture_cohort_sha256: Sha256Schema,
    issued_at: Rfc3339UtcSchema,
    not_before: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,

    resources: ScaP03InitialResourcesV1Schema,
    input_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 512 }),
  },
  { additionalProperties: false }
);
/** The sealed purpose commits to a different, closed input preimage. A fixture proposal
 * cannot be relabeled as permission to verify a sealed bootstrap. Both use ONLY the
 * canonical initial operation identity, never a caller-selected directive. */
export const ScaP03InitialProposalV1Schema = Type.Union([
  Type.Object(
    { ...initialProposalCommon.properties, effect: Type.Literal("fixture_qualification") },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...initialProposalCommon.properties,
      effect: Type.Literal("bootstrap_verification"),
      sealed_bootstrap_inputs_ref: ArtifactRefSchema,
    },
    { additionalProperties: false }
  ),
]);
export type ScaP03InitialProposalV1 = Static<typeof ScaP03InitialProposalV1Schema>;

/** Existing inspection ceilings, independent of generated evidence and execution authority. */
export const SCA_P03_INPUT_MAX_REFS = 512;
export const SCA_P03_INPUT_MAX_ARTIFACT_BYTES = 67_108_864;
export const SCA_P03_INPUT_MAX_JSON_BYTES = 4_194_304;
export const SCA_P03_INPUT_MAX_TOTAL_BYTES = 268_435_456;
export const SCA_P03_INITIAL_CONTROL_MAX_BYTES = 1_048_576;
export function deriveScaP03InitialCustodyV1(refs: readonly ArtifactRef[]) {
  if (refs.length < 1 || refs.length > SCA_P03_INPUT_MAX_REFS)
    throw new Error("p03_initial_custody_ref_limit");
  let total = 0;
  for (const [i, value] of refs.entries()) {
    const ref = currentArtifactRef(value);
    if (
      (i > 0 && ref.artifact_id <= (refs[i - 1]?.artifact_id ?? "")) ||
      !Number.isSafeInteger(ref.byte_length) ||
      ref.byte_length > SCA_P03_INPUT_MAX_ARTIFACT_BYTES ||
      (ref.media_type === "application/json" && ref.byte_length > SCA_P03_INPUT_MAX_JSON_BYTES)
    )
      throw new Error("p03_initial_custody_ref_invalid");
    total += ref.byte_length;
    if (!Number.isSafeInteger(total) || total > SCA_P03_INPUT_MAX_TOTAL_BYTES)
      throw new Error("p03_initial_custody_total_limit");
  }
  if (total <= 0) throw new Error("p03_initial_custody_total_limit");
  return Object.freeze({
    max_refs: refs.length,
    max_total_bytes: total,
    max_artifact_bytes: SCA_P03_INPUT_MAX_ARTIFACT_BYTES,
    max_json_bytes: SCA_P03_INPUT_MAX_JSON_BYTES,
  });
}
export function assertScaP03InitialControlRefV1(ref: ArtifactRef, kind: string): void {
  currentArtifactRef(ref);
  if (
    ref.byte_length > SCA_P03_INITIAL_CONTROL_MAX_BYTES ||
    ref.kind !== `sca-p03-initial-${kind}` ||
    ref.content_schema?.schema_id !== `penny.sca-p03-initial-${kind}.v1` ||
    ref.content_schema.schema_version !== 1 ||
    ref.producer !== "host:sca-p03-initial-authorization" ||
    ref.media_type !== "application/json" ||
    ref.version !== 1 ||
    ref.branch_id !== null
  )
    throw new Error("p03_initial_control_ref_invalid");
}
/** Owned exact configuration, never cached permission. Every use rechecks native bytes. */
export class ScaP03InitialProposalBindingV1 {
  private readonly ownedRef: ArtifactRef;
  private readonly ownedProposal: ScaP03InitialProposalV1;
  constructor(
    private readonly store: ArtifactHostStore,
    ref: ArtifactRef
  ) {
    assertScaP03InitialControlRefV1(ref, "proposal");
    this.ownedRef = structuredClone(ref);
    this.ownedProposal = readScaP03InitialProposalV1(readScaP03InitialExact(store, ref));
    if (ref.run_id !== this.ownedProposal.run_id) throw new Error("p03_initial_pin_invalid");
  }
  get proposal_ref(): ArtifactRef {
    return structuredClone(this.ownedRef);
  }
  get proposal(): ScaP03InitialProposalV1 {
    return structuredClone(this.ownedProposal);
  }
  assertRef(ref: ArtifactRef): void {
    if (canonicalJson(ref) !== canonicalJson(this.ownedRef))
      throw new Error("p03_initial_foreign_proposal");
  }
  assertRun(run: string): void {
    if (run !== this.ownedProposal.run_id) throw new Error("p03_initial_foreign_run");
  }
  assertProposal(proposal: ScaP03InitialProposalV1): void {
    if (canonicalJson(proposal) !== canonicalJson(this.ownedProposal))
      throw new Error("p03_initial_foreign_proposal");
  }
  readControl(ref: ArtifactRef, kind: string): Uint8Array {
    assertScaP03InitialControlRefV1(ref, kind);
    this.assertRun(ref.run_id);
    if (kind === "proposal") this.assertRef(ref);
    return readScaP03InitialExact(this.store, ref);
  }
  read(store: ArtifactHostStore, ref: ArtifactRef): ScaP03InitialProposalV1 {
    this.assertRef(ref);
    const proposal = readScaP03InitialProposalV1(readScaP03InitialExact(store, ref));
    this.assertProposal(proposal);
    return proposal;
  }
}

export function validateScaP03InitialProposalV1(value: unknown): ScaP03InitialProposalV1 {
  const p = validateContract(ScaP03InitialProposalV1Schema, value, "P03 initial proposal");
  const r = p.resources;
  if (
    (p.effect === "bootstrap_verification" &&
      !p.input_refs.some(
        (ref) => canonicalJson(ref) === canonicalJson(p.sealed_bootstrap_inputs_ref)
      )) ||
    r.tmp_bytes + r.work_bytes > 67_108_864 ||
    r.jvm_heap_bytes > r.memory_bytes ||
    r.max_graph_bytes > r.work_bytes ||
    r.max_query_bytes > r.work_bytes ||
    Math.ceil(r.max_graph_bytes / 3) * 4 + 2 > r.command_output_bytes ||
    Math.ceil(r.max_query_bytes / 3) * 4 + 2 > r.command_output_bytes ||
    r.max_page_items > r.max_query_items ||
    r.max_source_bytes > r.max_host_workspace_bytes ||
    r.max_evidence_bytes < r.max_query_bytes ||
    Date.parse(p.issued_at) > Date.parse(p.not_before) ||
    Date.parse(p.not_before) >= Date.parse(p.expires_at) ||
    p.input_refs.some(
      (ref, i) => i > 0 && ref.artifact_id <= (p.input_refs[i - 1]?.artifact_id ?? "")
    )
  )
    throw new Error("p03_initial_proposal_bounds_invalid");
  deriveScaP03InitialCustodyV1(p.input_refs);
  return structuredClone(p);
}
export function readScaP03InitialProposalV1(bytes: Uint8Array): ScaP03InitialProposalV1 {
  if (bytes.byteLength > 1_048_576) throw new Error("p03_initial_proposal_limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error("p03_initial_proposal_noncanonical");
  return validateScaP03InitialProposalV1(value);
}
export const ScaP03InitialHumanEventV1Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    origin: Type.Literal("trusted-human-ui"),
    run_id: OpaqueIdSchema,
    gate_id: OpaqueIdSchema,
    challenge: OpaqueIdSchema,
    artifact_ref: ArtifactRefSchema,
    questionnaire_transport_ref: ArtifactRefSchema,
    rendered_questions_digest: Sha256Schema,
    actor: Type.Literal("human:interactive-questionnaire"),
    timestamp: Rfc3339UtcSchema,
    decision: Type.Union([Type.Literal("approve"), Type.Literal("deny"), Type.Literal("refine")]),
    response: Type.Union([Type.Literal("approve"), Type.Literal("deny"), Type.Literal("refine")]),
    signature: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP03InitialHumanEventV1 = Static<typeof ScaP03InitialHumanEventV1Schema>;
export interface ScaP03InitialGateBindingV1 {
  readonly proposal_ref: ArtifactRef;
  readonly transport_ref: ArtifactRef;
  readonly gate_id: string;
  readonly challenge: string;
  readonly rendered_questions_digest: string;
}
/** Host configuration/administrative authority, never a tool parameter or same-UID CLI claim.
 * A deployment must implement the actor mapping using an independently authenticated native
 * operator session. No default mapping exists, and HMAC alone does not prove this principal. */
export interface ScaP03TrustedInitialProfileV1 {
  current(): Readonly<{
    principal_id: string;
    policy_id: string;
    installation_id: string;
    project_id: string;
    state_authority_sha256: string;
    backend_resource_sha256: string;
    revocation_generation: number;
    revoked: boolean;
    permitted_effects: readonly ScaP03InitialProposalV1["effect"][];
  }>;
  authenticatedInteractivePrincipal(event: ScaP03InitialHumanEventV1): string | undefined;
  /** Existing predecessor/current-source/configuration admission. Read-only, no probes. */
  assertCurrentInputs(proposal: ScaP03InitialProposalV1): void;
  now(): Date;
}
export interface ScaP03InitialWitnessVerifierV1 {
  verify(value: unknown): boolean;
}

/** Authorization is re-evaluated, not a reusable bearer grant. One-shot association is owned
 * durably by the engine gate and the exact canonical operation record, not a private ledger. */
export class ScaP03InitialAuthorizationV1 {
  constructor(
    private readonly profile: ScaP03TrustedInitialProfileV1,
    private readonly verifier: ScaP03InitialWitnessVerifierV1,
    private readonly binding?: ScaP03InitialProposalBindingV1
  ) {}
  assertPinnedRef(ref: ArtifactRef): void {
    if (this.binding === undefined) throw new Error("p03_initial_pin_required");
    this.binding.assertRef(ref);
  }
  assertProposal(proposal: ScaP03InitialProposalV1): void {
    this.binding?.assertProposal(proposal);
    const p = validateScaP03InitialProposalV1(proposal);
    const current = this.profile.current();
    const now = this.profile.now().getTime();
    if (
      !Number.isFinite(now) ||
      current.revoked ||
      now < Date.parse(p.not_before) ||
      now >= Date.parse(p.expires_at) ||
      current.principal_id !== p.principal_id ||
      current.policy_id !== p.policy_id ||
      current.installation_id !== p.installation_id ||
      current.project_id !== p.project_id ||
      current.state_authority_sha256 !== p.state_authority_sha256 ||
      current.backend_resource_sha256 !== p.backend_resource_sha256 ||
      current.revocation_generation !== p.revocation_generation ||
      !current.permitted_effects.includes(p.effect)
    )
      throw new Error("p03_initial_authority_denied");
    this.profile.assertCurrentInputs(p);
  }
  admit(
    proposal: ScaP03InitialProposalV1,
    binding: ScaP03InitialGateBindingV1,
    value: unknown
  ): ScaP03InitialHumanEventV1 {
    // Schema first bounds nested refs and excludes partial/extra event fields before hashing.
    const event = validateContract(
      ScaP03InitialHumanEventV1Schema,
      value,
      "P03 initial UI witness"
    );
    const now = this.profile.now().getTime();
    if (
      !this.verifier.verify(event) ||
      event.run_id !== proposal.run_id ||
      event.gate_id !== binding.gate_id ||
      event.challenge !== binding.challenge ||
      canonicalJson(event.artifact_ref) !== canonicalJson(binding.proposal_ref) ||
      canonicalJson(event.questionnaire_transport_ref) !== canonicalJson(binding.transport_ref) ||
      event.rendered_questions_digest !== binding.rendered_questions_digest ||
      event.decision !== event.response ||
      Date.parse(event.timestamp) < Date.parse(proposal.issued_at) ||
      Date.parse(event.timestamp) > now ||
      Date.parse(event.timestamp) >= Date.parse(proposal.expires_at) ||
      this.profile.authenticatedInteractivePrincipal(event) !== proposal.principal_id
    )
      throw new Error("p03_initial_ui_witness_denied");
    this.assertProposal(proposal);
    return structuredClone(event);
  }
  assertEffect(
    context: HostOperationExecutionContextV1,
    proposal: ScaP03InitialProposalV1,
    binding: ScaP03InitialGateBindingV1
  ): void {
    context.signal.throwIfAborted();
    if (this.binding === undefined) throw new Error("p03_initial_pin_required");
    this.binding.assertRef(context.directive.request_ref);
    const proposalInput = context.readInput("initial_proposal");
    const transportInput = context.readInput("initial_transport");
    const witnessInput = context.readInput("initial_witness");
    if (
      context.journal.project_id !== proposal.project_id ||
      context.directive.identity.run_id !== proposal.run_id ||
      context.directive.operation_id !==
        `initial:${proposal.approval_id}:${proposal.invocation_nonce}` ||
      context.directive.policy_binding.backend_key_sha256 !== proposal.backend_resource_sha256 ||
      canonicalJson(proposalInput.ref) !== canonicalJson(binding.proposal_ref) ||
      canonicalJson(transportInput.ref) !== canonicalJson(binding.transport_ref) ||
      canonicalJson(readScaP03InitialProposalV1(proposalInput.bytes)) !== canonicalJson(proposal) ||
      witnessInput.ref.run_id !== proposal.run_id ||
      witnessInput.ref.producer !== "host:sca-p03-initial-authorization"
    )
      throw new Error("p03_initial_effect_binding_invalid");
    assertScaP03InitialControlRefV1(proposalInput.ref, "proposal");
    assertScaP03InitialControlRefV1(transportInput.ref, "transport");
    assertScaP03InitialControlRefV1(witnessInput.ref, "witness");
    for (const [kind, control] of [
      ["proposal", proposalInput],
      ["transport", transportInput],
      ["witness", witnessInput],
    ] as const) {
      const current = this.binding.readControl(control.ref, kind);
      if (sha256(current) !== sha256(control.bytes)) throw new Error("p03_initial_control_drift");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(witnessInput.bytes);
    const event: unknown = JSON.parse(text);
    if (
      canonicalJson(event) !== text ||
      this.admit(proposal, binding, event).decision !== "approve"
    )
      throw new Error("p03_initial_approval_required");
    for (const [i, ref] of proposal.input_refs.entries()) {
      const input = context.readInput(`proof_${String(i).padStart(3, "0")}`);
      if (
        canonicalJson(input.ref) !== canonicalJson(ref) ||
        input.bytes.byteLength !== ref.byte_length ||
        sha256(input.bytes) !== ref.content_digest
      )
        throw new Error("p03_initial_current_input_drift");
    }
  }
}
export function readScaP03InitialExact(store: ArtifactHostStore, ref: ArtifactRef): Uint8Array {
  currentArtifactRef(ref);
  if (ref.kind.startsWith("sca-p03-initial-"))
    assertScaP03InitialControlRefV1(ref, ref.kind.slice("sca-p03-initial-".length));
  if (canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref))
    throw new Error("p03_initial_ref_stale");
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest)
    throw new Error("p03_initial_bytes_stale");
  return bytes;
}
