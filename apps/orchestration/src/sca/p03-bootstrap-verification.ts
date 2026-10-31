import { Type, type Static } from "typebox";
import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { RunContext } from "../context.js";
import {
  ArtifactRefSchema,
  validateContract,
  validateDirective,
  type Directive,
  type SkillContract,
} from "../contracts.js";
import {
  hostOperationPolicyBinding,
  type HostOperationDeclarationV1,
} from "../host-operations/contracts.js";
import type { PlaybookCore } from "../playbooks/playbook.js";
import { runtimeRegistrationSha256, type PlaybookRegistration } from "../playbooks/registry.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import { ScaP03CurrentBootstrapSampleV1Schema } from "./p03-activation-host.js";
import {
  SCA_P03_CANDIDATE_SKILL_CONTRACT,
  SCA_P03_OPERATION_DECLARATIONS,
} from "./p03-playbook.js";

// Not an activated phase or a catalog skill. Production issuance/transport remain fail-closed.
export const SCA_P03_VERIFICATION_NAME = "sca-p03-bootstrap-verification-offline";
export const SCA_P03_VERIFICATION_STATE = "sca_p03_verifying_bootstrap";
export const SCA_P03_VERIFICATION_OPERATION = "sca.p03.verify-production-bootstrap.v1";
export const SCA_P03_VERIFICATION_REQUEST_SCHEMA =
  "penny.sca-p03-bootstrap-verification-request.v1";
export const SCA_P03_VERIFICATION_RESULT_SCHEMA = "penny.sca-p03-bootstrap-verification-result.v1";
export const ScaP03VerificationRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_VERIFICATION_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    invocation_nonce: OpaqueIdSchema,
    manifest_sha256: Sha256Schema,
    // Approved resource identity, NOT request/run/project/nonce/authority identity.
    backend_resource_sha256: Sha256Schema,
    input_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 512 }),
  },
  { additionalProperties: false }
);
export type ScaP03VerificationRequestV1 = Static<typeof ScaP03VerificationRequestV1Schema>;
export const ScaP03VerificationResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_VERIFICATION_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    invocation_nonce: OpaqueIdSchema,
    request_sha256: Sha256Schema,
    sample: ScaP03CurrentBootstrapSampleV1Schema,
  },
  { additionalProperties: false }
);
export type ScaP03VerificationResultV1 = Static<typeof ScaP03VerificationResultV1Schema>;
export const ScaP03VerificationConstraintsV1Schema = Type.Object(
  { request_ref: ArtifactRefSchema },
  { additionalProperties: false }
);

export function readScaP03VerificationRequestV1(bytes: Uint8Array): ScaP03VerificationRequestV1 {
  if (bytes.byteLength > SCA_P03_VERIFICATION_DECLARATION.max_request_bytes) {
    throw new Error("p03_verification_request_limit");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error("p03_verification_request_noncanonical");
  const request = validateContract(
    ScaP03VerificationRequestV1Schema,
    value,
    "P03 verification request"
  );
  if (
    new Set(request.input_refs.map((ref) => ref.artifact_id)).size !== request.input_refs.length ||
    request.input_refs.some(
      (ref, i) => i > 0 && ref.artifact_id <= (request.input_refs[i - 1]?.artifact_id ?? "")
    )
  )
    throw new Error("p03_verification_input_refs_invalid");
  return request;
}
export function scaP03VerificationInputsV1(request: ScaP03VerificationRequestV1) {
  return {
    schema_version: 2 as const,
    artifacts: request.input_refs.map((ref, i) => ({
      slot: `proof_${String(i).padStart(3, "0")}`,
      ref,
    })),
  };
}

const inherited = SCA_P03_OPERATION_DECLARATIONS.qualify;
export const SCA_P03_VERIFICATION_DECLARATION: HostOperationDeclarationV1 = Object.freeze({
  ...inherited,
  operation_kind: SCA_P03_VERIFICATION_OPERATION,
  adapter_id: "sca-p03-bootstrap-verification-adapter-v1",
  request: {
    schema_version: 1 as const,
    port_name: "verification_request",
    artifact_kind: "sca-p03-bootstrap-verification-request",
    schema_id: SCA_P03_VERIFICATION_REQUEST_SCHEMA,
    schema_version_required: 1,
  },
  result: {
    schema_version: 1 as const,
    port_name: "verification_result",
    artifact_kind: "sca-p03-bootstrap-verification-result",
    schema_id: SCA_P03_VERIFICATION_RESULT_SCHEMA,
    schema_version_required: 1,
  },
  max_output_artifacts: 1,
  max_output_bytes: 1_048_576,
  max_pre_acceptance_retries: 0,
  recovery_semantics: "journaled_remote_submission_v1",
});
const contract: SkillContract = {
  ...SCA_P03_CANDIDATE_SKILL_CONTRACT,
  name: SCA_P03_VERIFICATION_NAME,
  objective:
    "Offline qualification of canonical guarded production-bootstrap proof replay; never activation or formal qualification.",
  io: {
    request: {
      ...SCA_P03_CANDIDATE_SKILL_CONTRACT.io.request,
      schema_id: "penny.sca-p03-bootstrap-verification-start.v1",
    },
    input_ports: [],
    active_output_ports: [
      {
        schema_version: 1,
        name: "verification_result",
        direction: "output",
        transport: "artifact",
        schema_id: SCA_P03_VERIFICATION_RESULT_SCHEMA,
        schema_version_required: 1,
        artifact_kind: SCA_P03_VERIFICATION_DECLARATION.result.artifact_kind,
        source: "skill",
        min_items: 0,
        max_items: 1,
        semantic_product: false,
      },
    ],
  },
  behavior: {
    ...SCA_P03_CANDIDATE_SKILL_CONTRACT.behavior,
    approval: { policy: "existing_host_gates", additional_approval_required: true },
  },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.sca-p03-verification-offline.v1",
    resolver_id: "scaP03VerificationResolverV1",
    admission_id: "scaP03VerificationAdmissionV1",
    snapshot_id: "scaP03VerificationSnapshotV1",
  },
  completion_gate: {
    ...SCA_P03_CANDIDATE_SKILL_CONTRACT.completion_gate,
    allowed_terminal_origins: [SCA_P03_VERIFICATION_STATE],
    required_visited_states: [SCA_P03_VERIFICATION_STATE],
  },
};

class ScaP03VerificationPlaybook implements PlaybookCore {
  constructor(private readonly store: ArtifactHostStore) {}
  initialize(context: RunContext): Directive {
    context.transition(SCA_P03_VERIFICATION_STATE);
    return this.dispatch(context);
  }
  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    const { request_ref: ref } = validateContract(
      ScaP03VerificationConstraintsV1Schema,
      context.constraints,
      "P03 verification start"
    );
    if (canonicalJson(this.store.refById(ref.artifact_id)) !== canonicalJson(ref))
      throw new Error("p03_verification_request_ref_stale");
    const bytes = this.store.readById(ref.artifact_id);
    if (sha256(bytes) !== ref.content_digest)
      throw new Error("p03_verification_request_bytes_stale");
    const request = readScaP03VerificationRequestV1(bytes);
    if (request.run_id !== context.identity.run_id || ref.run_id !== request.run_id)
      throw new Error("p03_verification_run_mismatch");
    const receipt = context.selectedArtifacts.find(
      (candidate) =>
        candidate.run_id === request.run_id &&
        candidate.phase === SCA_P03_VERIFICATION_STATE &&
        candidate.kind === "host-operation-receipt"
    );
    if (receipt !== undefined) return this.terminal(context, "operation_settled_offline_only");
    const directive = validateDirective({
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: context.identity,
      state_id: SCA_P03_VERIFICATION_STATE,
      attempt: 1,
      operation_id: `verify-bootstrap:${request.invocation_nonce}`,
      operation_kind: SCA_P03_VERIFICATION_OPERATION,
      registration_sha256: runtimeRegistrationSha256(SCA_P03_VERIFICATION_REGISTRATION),
      request_ref: ref,
      request_sha256: ref.content_digest,
      input_artifacts: scaP03VerificationInputsV1(request),
      expected_result: SCA_P03_VERIFICATION_DECLARATION.result,
      policy_binding: hostOperationPolicyBinding(
        SCA_P03_VERIFICATION_DECLARATION,
        request.backend_resource_sha256
      ),
    });
    context.pendingDirective = directive;
    return directive;
  }
  private terminal(context: RunContext, reason: string): Directive {
    const terminal = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: { reason },
      artifacts: context.selectedArtifacts,
      unresolved: [
        "Offline operation evidence is not formal qualification, approval, issuance, or activation.",
      ],
    });
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    context.status = "incomplete";
    context.met = false;
    return terminal;
  }
  resume(context: RunContext): Directive {
    return this.terminal(context, "operator_approval_composition_unavailable");
  }
  cancel(context: RunContext, reason: string): Directive {
    const terminal = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: { reason: "cancelled" },
      artifacts: context.selectedArtifacts,
      unresolved: [reason],
    });
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    context.status = "cancelled";
    context.met = false;
    context.pendingBranches = [];
    return terminal;
  }
  acceptSummary(context: RunContext): Directive {
    return this.terminal(context, "model_result_forbidden");
  }
  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}

/** Inject only at the existing runner/service boundary. No public registry/index change. */
export const SCA_P03_VERIFICATION_REGISTRATION: PlaybookRegistration = {
  name: SCA_P03_VERIFICATION_NAME,
  contract,
  ingress: "dedicated_tool",
  liveness: {
    resolver_id: contract.budget_policy.resolver_id,
    resolve: () => undefined,
    thinking_policy: "agent_ssot",
  },
  worker: {
    kind: "none",
    workflow_name: SCA_P03_VERIFICATION_NAME,
    guidance: contract.guidance,
    guidance_required: true,
    result_transport: "host_typed",
    opening_policy: "none",
    model_policy: "none",
    phases: new Map<string, never>(),
  },
  host_states: [SCA_P03_VERIFICATION_STATE],
  host_operations: {
    schema_version: 1,
    max_active_per_run: 1,
    declarations: [SCA_P03_VERIFICATION_DECLARATION],
  },
  completionReceiptPredicates: new Map(),
  construct(options) {
    if (options.artifactStore === undefined) throw new Error("p03_verification_store_unavailable");
    return new ScaP03VerificationPlaybook(options.artifactStore);
  },
};
