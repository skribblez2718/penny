import { randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { RunContext } from "../context.js";
import {
  ArtifactRefSchema,
  validateContract,
  validateDirective,
  type ArtifactRef,
  type Directive,
  type JsonValue,
} from "../contracts.js";
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  type HostOperationDeclarationV1,
} from "../host-operations/contracts.js";
import type { PlaybookCore } from "../playbooks/playbook.js";
import type { PlaybookRegistration } from "../playbooks/registry.js";
import { SCA_P03_VERIFICATION_REGISTRATION } from "./p03-bootstrap-verification.js";
import {
  readScaP03InitialExact,
  readScaP03InitialProposalV1,
  ScaP03InitialAuthorizationV1,
  type ScaP03InitialGateBindingV1,
  ScaP03InitialProposalBindingV1,
  deriveScaP03InitialCustodyV1,
  assertScaP03InitialControlRefV1,
  SCA_P03_INITIAL_CONTROL_MAX_BYTES,
  type ScaP03InitialProposalV1,
} from "./p03-initial-authorization.js";

export const SCA_P03_INITIAL_NAME = "sca-p03-initial-qualification";
export const SCA_P03_INITIAL_GATE_STATE = "sca_p03_awaiting_initial_approval";
export const SCA_P03_INITIAL_WORK_STATE = "sca_p03_initial_qualification";
export const SCA_P03_INITIAL_OPERATION = "sca.p03.initial-qualification.v1";
export const ScaP03InitialConstraintsV1Schema = Type.Object(
  { proposal_ref: ArtifactRefSchema },
  { additionalProperties: false }
);
export const ScaP03InitialTransportV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-initial-transport.v1"),
    schema_version: Type.Literal(1),
    proposal_ref: ArtifactRefSchema,
    gate_id: Type.String({ maxLength: 256 }),
    challenge: Type.String({ maxLength: 256 }),
    questions: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          label: Type.String(),
          prompt: Type.String({ maxLength: 1_048_576 }),
          options: Type.Array(
            Type.Object(
              { value: Type.String(), label: Type.String() },
              { additionalProperties: false }
            ),
            { minItems: 3, maxItems: 3 }
          ),
          allowOther: Type.Literal(false),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 1 }
    ),
  },
  { additionalProperties: false }
);
export type ScaP03InitialTransportV1 = Static<typeof ScaP03InitialTransportV1Schema>;
export function scaP03InitialOperationInputs(
  proposal_ref: ArtifactRef,
  transport_ref: ArtifactRef,
  witness_ref: ArtifactRef,
  refs: readonly ArtifactRef[]
) {
  return {
    schema_version: 2 as const,
    artifacts: [
      { slot: "initial_proposal", ref: proposal_ref },
      { slot: "initial_transport", ref: transport_ref },
      { slot: "initial_witness", ref: witness_ref },
      ...refs.map((ref, i) => ({ slot: `proof_${String(i).padStart(3, "0")}`, ref })),
    ],
  };
}
export function readScaP03InitialGate(
  store: ArtifactHostStore,
  proposal_ref: ArtifactRef,
  transport_ref: ArtifactRef
): ScaP03InitialGateBindingV1 {
  assertScaP03InitialControlRefV1(proposal_ref, "proposal");
  assertScaP03InitialControlRefV1(transport_ref, "transport");
  const metadata = store.metadata(transport_ref);
  if (
    metadata.parent_ref !== null ||
    metadata.domain_revision_parent_ref != null ||
    canonicalJson(metadata.upstream_refs) !== canonicalJson([proposal_ref])
  )
    throw new Error("p03_initial_transport_custody_invalid");
  const proposal = readScaP03InitialProposalV1(readScaP03InitialExact(store, proposal_ref));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    readScaP03InitialExact(store, transport_ref)
  );
  const raw: unknown = JSON.parse(text);
  const transport = validateContract(ScaP03InitialTransportV1Schema, raw, "P03 initial transport");
  if (
    canonicalJson(raw) !== text ||
    proposal_ref.run_id !== proposal.run_id ||
    transport_ref.run_id !== proposal.run_id ||
    canonicalJson(transport.questions) !==
      canonicalJson(renderScaP03InitialQuestionsV1(proposal)) ||
    canonicalJson(transport.proposal_ref) !== canonicalJson(proposal_ref)
  )
    throw new Error("p03_initial_transport_stale");
  return {
    proposal_ref,
    transport_ref,
    gate_id: transport.gate_id,
    challenge: transport.challenge,
    rendered_questions_digest: sha256(canonicalJson(transport.questions)),
  };
}
/** Single rendering used by both trusted initialization and persisted gate reconstruction. */
export function renderScaP03InitialQuestionsV1(
  proposal: ScaP03InitialProposalV1
): ScaP03InitialTransportV1["questions"] {
  const custody = deriveScaP03InitialCustodyV1(proposal.input_refs);
  return [
    {
      id: "initial",
      label: "P03 initial permission",
      prompt: `Approve ONLY this exact bounded initial P03 proposal. Read-only input custody: ${custody.max_refs} approved input artifacts, ${custody.max_total_bytes} unique input bytes. Hard ceilings: 67,108,864 bytes/artifact (64 MiB), 4,194,304 bytes/JSON (4 MiB), 268,435,456 total bytes (256 MiB). Separate controls: three controls, each at most 1,048,576 bytes (3 MiB total). Generated evidence remains limited to ${proposal.resources.max_evidence_bytes} bytes. This does not bound lifetime I/O or peak memory and grants no formal qualification, activation, or P04 permission.\n${canonicalJson(proposal)}`,
      options: [
        { value: "deny", label: "Deny (no effects)" },
        { value: "refine", label: "Refine (new exact proposal required)" },
        { value: "approve", label: "Approve this exact bounded operation" },
      ],
      allowOther: false,
    },
  ];
}
function initialDeclaration(proposal: ScaP03InitialProposalV1): HostOperationDeclarationV1 {
  const resources = proposal.resources;
  const custody = deriveScaP03InitialCustodyV1(proposal.input_refs);
  const lease = {
    profile_id: "sca-p03-initial-backend-lease-v1",
    profile_version: 1 as const,
    duration_ms: 60_000,
    renew_after_ms: 20_000,
    queue_inactivity_ms: 60_000,
  };
  return {
    schema_version: 1,
    operation_kind: SCA_P03_INITIAL_OPERATION,
    adapter_id: "sca-p03-initial-qualification-adapter-v1",
    request: {
      schema_version: 1,
      port_name: "initial_proposal",
      artifact_kind: "sca-p03-initial-proposal",
      schema_id: "penny.sca-p03-initial-proposal.v1",
      schema_version_required: 1,
    },
    result: {
      schema_version: 1,
      port_name: "initial_evidence",
      artifact_kind: "sca-p03-initial-evidence",
      schema_id: "penny.sca-p03-initial-evidence.v1",
      schema_version_required: 1,
    },
    backend_binding_id: "sca-p03-approved-backend-v1",
    capability_classes: ["artifact_store"],
    lease_profile: { ...lease, profile_sha256: hostOperationLeaseProfileSha256(lease) },
    operation_inactivity_ms: 60_000,
    max_request_bytes: 1_048_576,
    max_input_artifacts: custody.max_refs + 3,
    max_input_bytes: custody.max_total_bytes + 3 * SCA_P03_INITIAL_CONTROL_MAX_BYTES,
    max_output_artifacts: 1,
    max_output_bytes: resources.max_evidence_bytes,
    max_progress_events: resources.max_commands * 4,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
}
class InitialQualificationPlaybook implements PlaybookCore {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly authorization: ScaP03InitialAuthorizationV1,
    private readonly registration: PlaybookRegistration,
    private readonly binding: ScaP03InitialProposalBindingV1
  ) {}
  private proposal(context: RunContext) {
    const { proposal_ref } = validateContract(
      ScaP03InitialConstraintsV1Schema,
      context.constraints,
      "P03 initial constraints"
    );
    this.binding.assertRun(context.identity.run_id);
    const proposal = this.binding.read(this.store, proposal_ref);
    if (
      proposal.run_id !== context.identity.run_id ||
      proposal_ref.run_id !== proposal.run_id ||
      proposal_ref.kind !== "sca-p03-initial-proposal" ||
      proposal_ref.producer !== "host:sca-p03-initial-authorization" ||
      canonicalJson(proposal.resources) !== canonicalJson(this.binding.proposal.resources)
    )
      throw new Error("p03_initial_proposal_binding_invalid");
    this.authorization.assertProposal(proposal);
    for (const ref of proposal.input_refs) readScaP03InitialExact(this.store, ref);
    return { proposal_ref, proposal };
  }
  private persist(
    context: RunContext,
    kind: string,
    schema_id: string,
    content: unknown,
    upstream: ArtifactRef[]
  ): ArtifactRef {
    const serialized = canonicalJson(content);
    if (Buffer.byteLength(serialized) > SCA_P03_INITIAL_CONTROL_MAX_BYTES)
      throw new Error("p03_initial_control_limit");
    const ref = this.store.persist({
      metadata: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: SCA_P03_INITIAL_GATE_STATE,
        branch_id: null,
        kind,
        operation_id: `initial:${kind}`,
        version: 1,
        producer: "host:sca-p03-initial-authorization",
        media_type: "application/json",
        content_schema: { schema_id, schema_version: 1 },
        parent_ref: null,
        upstream_refs: upstream,
      },
      content: serialized,
    });
    readScaP03InitialExact(this.store, ref);
    context.selectedArtifacts.push(ref);
    return ref;
  }
  initialize(context: RunContext): Directive {
    const { proposal_ref, proposal } = this.proposal(context);
    const gate_id = `initial:${proposal.approval_id}`;
    const challenge = randomBytes(32).toString("hex");
    const transport: ScaP03InitialTransportV1 = {
      schema_id: "penny.sca-p03-initial-transport.v1",
      schema_version: 1,
      proposal_ref,
      gate_id,
      challenge,
      questions: renderScaP03InitialQuestionsV1(proposal),
    };
    validateContract(ScaP03InitialTransportV1Schema, transport, "P03 initial transport");
    const transport_ref = this.persist(
      context,
      "sca-p03-initial-transport",
      transport.schema_id,
      transport,
      [proposal_ref]
    );
    context.transition(SCA_P03_INITIAL_GATE_STATE);
    context.status = "awaiting_user";
    const gate = validateDirective({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: SCA_P03_INITIAL_GATE_STATE,
      gate_id,
      challenge,
      payload_digest: transport_ref.content_digest,
      questions: [
        {
          id: "initial",
          prompt: `Trusted native questionnaire required for proposal ${proposal_ref.artifact_id}; transport ${transport_ref.artifact_id}. Ordinary answers grant no authority.`,
        },
      ],
    });
    context.pendingDirective = gate;
    return gate;
  }
  dispatch(context: RunContext): Directive {
    this.binding.assertRun(context.identity.run_id);
    if (context.pendingDirective !== null) return context.pendingDirective;
    if (context.stateId !== SCA_P03_INITIAL_WORK_STATE)
      throw new Error("p03_initial_state_invalid");
    // Settlement is observation-only. Expiry/revocation stops effects, not durable
    // consumption of the already-settled operation or its non-positive receipt.
    if (
      context.selectedArtifacts.some(
        (ref) => ref.kind === "host-operation-receipt" && ref.phase === SCA_P03_INITIAL_WORK_STATE
      )
    )
      return this.terminal(
        context,
        "incomplete",
        "Initial evidence only; final signed bootstrap/sealed handoff/formal gates/activation and P04 remain blocked."
      );
    const { proposal_ref, proposal } = this.proposal(context);
    const transport_ref = context.selectedArtifacts.find(
      (ref) => ref.kind === "sca-p03-initial-transport"
    );
    const witness_ref = context.selectedArtifacts.find(
      (ref) => ref.kind === "sca-p03-initial-witness"
    );
    const declaration = this.registration.host_operations?.declarations[0];
    if (transport_ref === undefined || witness_ref === undefined || declaration === undefined)
      throw new Error("p03_initial_witness_missing");
    // The engine binds the effective registration (including native YAML authority).
    // The construction closure is only the declaration seed, not that runtime digest.
    const registrationSha256 = context.registrationContractBinding?.registration_sha256;
    if (registrationSha256 === undefined) throw new Error("p03_initial_registration_required");
    const directive = validateDirective({
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: context.identity,
      state_id: SCA_P03_INITIAL_WORK_STATE,
      attempt: 1,
      operation_id: `initial:${proposal.approval_id}:${proposal.invocation_nonce}`,
      operation_kind: SCA_P03_INITIAL_OPERATION,
      registration_sha256: registrationSha256,
      request_ref: proposal_ref,
      request_sha256: proposal_ref.content_digest,
      input_artifacts: scaP03InitialOperationInputs(
        proposal_ref,
        transport_ref,
        witness_ref,
        proposal.input_refs
      ),
      expected_result: declaration.result,
      policy_binding: hostOperationPolicyBinding(declaration, proposal.backend_resource_sha256),
    });
    context.pendingDirective = directive;
    return directive;
  }
  resume(context: RunContext, response: JsonValue): Directive {
    const pending = context.pendingDirective;
    const { proposal_ref, proposal } = this.proposal(context);
    const transport_ref = context.selectedArtifacts.find(
      (ref) => ref.kind === "sca-p03-initial-transport"
    );
    if (pending?.action !== "await_user" || transport_ref === undefined)
      throw new Error("p03_initial_gate_missing");
    const binding = readScaP03InitialGate(this.store, proposal_ref, transport_ref);
    if (
      binding.gate_id !== pending.gate_id ||
      binding.challenge !== pending.challenge ||
      transport_ref.content_digest !== pending.payload_digest
    )
      throw new Error("p03_initial_gate_stale");
    const event = this.authorization.admit(proposal, binding, response);
    this.persist(context, "sca-p03-initial-witness", "penny.sca-p03-initial-witness.v1", event, [
      proposal_ref,
      transport_ref,
    ]);
    if (event.decision !== "approve")
      return this.terminal(
        context,
        "incomplete",
        `Initial permission ${event.decision}; no effects.`
      );
    context.pendingDirective = null;
    context.status = "running";
    context.transition(SCA_P03_INITIAL_WORK_STATE);
    return this.dispatch(context);
  }
  private terminal(
    context: RunContext,
    action: "incomplete" | "cancelled",
    reason: string
  ): Directive {
    const terminal = validateDirective({
      schema_version: 2,
      action,
      identity: context.identity,
      status: action,
      met: false,
      result: { reason, evidence_stage: "initial_only", p04_dispatch_permitted: false },
      artifacts: context.selectedArtifacts,
      unresolved: [reason],
    });
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    context.status = action;
    context.met = false;
    return terminal;
  }
  cancel(context: RunContext, reason: string): Directive {
    return this.terminal(context, "cancelled", reason);
  }
  acceptSummary(context: RunContext): Directive {
    return this.terminal(context, "incomplete", "Model results forbidden");
  }
  rebindPendingDirective(context: RunContext): Directive | null {
    this.binding.assertRun(context.identity.run_id);
    const { proposal_ref } = validateContract(
      ScaP03InitialConstraintsV1Schema,
      context.constraints,
      "P03 initial constraints"
    );
    this.binding.assertRef(proposal_ref);
    return context.pendingDirective;
  }
}
/** Private injected registration, absent from public registry/catalog. No final P03 authority dependency. */
export function createScaP03InitialQualificationRegistrationV1(input: {
  authorization: ScaP03InitialAuthorizationV1;
  binding: ScaP03InitialProposalBindingV1;
}): PlaybookRegistration {
  if (!(input.authorization instanceof ScaP03InitialAuthorizationV1))
    throw new Error("p03_initial_authorization_required");
  if (!(input.binding instanceof ScaP03InitialProposalBindingV1))
    throw new Error("p03_initial_pin_required");
  const binding = input.binding;
  input.authorization.assertPinnedRef(binding.proposal_ref);
  const base = SCA_P03_VERIFICATION_REGISTRATION;
  const contract = {
    ...base.contract,
    name: SCA_P03_INITIAL_NAME,
    objective:
      "Initial bounded operator-approved P03 qualification; evidence only, never activation or P04.",
    completion_gate: {
      ...base.contract.completion_gate,
      allowed_terminal_origins: [SCA_P03_INITIAL_WORK_STATE],
      required_visited_states: [SCA_P03_INITIAL_GATE_STATE, SCA_P03_INITIAL_WORK_STATE],
    },
  };
  const registration: PlaybookRegistration = {
    ...base,
    name: SCA_P03_INITIAL_NAME,
    contract,
    worker: {
      kind: "none",
      workflow_name: SCA_P03_INITIAL_NAME,
      guidance: contract.guidance,
      guidance_required: true,
      result_transport: "host_typed",
      opening_policy: "none",
      model_policy: "none",
      phases: new Map<string, never>(),
    },
    host_states: [SCA_P03_INITIAL_GATE_STATE, SCA_P03_INITIAL_WORK_STATE],
    host_operations: {
      schema_version: 1,
      max_active_per_run: 1,
      declarations: [initialDeclaration(binding.proposal)],
    },
    construct(options) {
      if (options.artifactStore === undefined) throw new Error("p03_initial_store_required");
      return new InitialQualificationPlaybook(
        options.artifactStore,
        input.authorization,
        registration,
        binding
      );
    },
  };
  return registration;
}
