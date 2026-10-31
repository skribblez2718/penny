import { OrchestrationService } from "../../orchestration/dist/service.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  JsonValueSchema,
  validateContract,
  validateDirective,
  type ArtifactRef,
} from "../../orchestration/dist/contracts.js";
import {
  ScaP03InitialAuthorizationV1,
  ScaP03InitialProposalBindingV1,
  assertScaP03InitialControlRefV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import {
  SCA_P03_INITIAL_NAME,
  SCA_P03_INITIAL_WORK_STATE,
  SCA_P03_INITIAL_OPERATION,
  scaP03InitialOperationInputs,
  readScaP03InitialGate,
} from "../../orchestration/dist/sca/p03-initial-qualification.js";
import { runtimeRegistrationSha256 } from "../../orchestration/dist/playbooks/registry.js";
import {
  hostOperationPolicyBinding,
  validateHostOperationDeclaration,
} from "../../orchestration/dist/host-operations/contracts.js";
import { readScaP03ConsumedFixtureEvidenceV1 } from "./p03-consumed-fixture-evidence.js";

export interface ScaP03InitialLiveCohortV1 {
  readonly service: OrchestrationService;
  readonly authorization: ScaP03InitialAuthorizationV1;
  /** The parent has already opened this exact native gate and inspected the closed cohort. */
  readonly proposal_ref: ArtifactRef;
  readonly binding: ScaP03InitialProposalBindingV1;
  readonly transport_ref: ArtifactRef;
  /** Original signed approval token in the parent's UI realm. Never an environment boolean. */
  readonly approval_token_ref: ArtifactRef;
}
/** Opt-in same-realm LIVE entry. No image pull, target execution or model invocation is added.
 * This drives ONLY the existing gated canonical operation; it does not run standalone Docker.
 * Caller owns the service and inspected native approval. No default inputs or approval exist. */
export async function runScaP03InitialLiveCohortV1(
  input: ScaP03InitialLiveCohortV1,
  signal: AbortSignal
) {
  if (
    !(input.service instanceof OrchestrationService) ||
    !(input.authorization instanceof ScaP03InitialAuthorizationV1) ||
    input.service.engine.registration.name !== SCA_P03_INITIAL_NAME
  )
    throw new Error("p03_live_native_composition_required");
  if (!(input.binding instanceof ScaP03InitialProposalBindingV1))
    throw new Error("p03_initial_pin_required");
  input.binding.assertRef(input.proposal_ref);
  input.authorization.assertPinnedRef(input.proposal_ref);
  assertScaP03InitialControlRefV1(input.transport_ref, "transport");
  assertScaP03InitialControlRefV1(input.approval_token_ref, "witness");
  const store = input.service.artifacts;
  const exact = (ref: ArtifactRef) => {
    if (canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref))
      throw new Error("p03_live_token_ref_invalid");
    const bytes = store.read(ref);
    if (sha256(bytes) !== ref.content_digest || bytes.byteLength !== ref.byte_length)
      throw new Error("p03_live_token_bytes_invalid");
    return bytes;
  };
  const proposal = input.binding.read(store, input.proposal_ref);
  if (
    proposal.effect !== "fixture_qualification" ||
    proposal.resources.memory_bytes !== 1_073_741_824
  )
    throw new Error("p03_live_first_cohort_bounds");
  const run = input.service.checkpointer.loadRunById(proposal.run_id);
  const pending = run?.pendingDirective;
  const binding = readScaP03InitialGate(store, input.proposal_ref, input.transport_ref);
  if (
    pending?.action !== "await_user" ||
    pending.gate_id !== binding.gate_id ||
    pending.challenge !== binding.challenge ||
    pending.payload_digest !== input.transport_ref.content_digest
  )
    throw new Error("p03_live_current_native_gate_required");
  if (
    input.approval_token_ref.run_id !== proposal.run_id ||
    input.approval_token_ref.producer !== "host:sca-p03-initial-authorization"
  )
    throw new Error("p03_live_native_approval_token_required");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(exact(input.approval_token_ref));
  const event: unknown = JSON.parse(text);
  if (
    canonicalJson(event) !== text ||
    input.authorization.admit(proposal, binding, event).decision !== "approve"
  )
    throw new Error("p03_live_native_approval_token_denied");
  const registrationSha256 = runtimeRegistrationSha256(input.service.engine.registration);
  await input.service.execute(
    {
      schema_version: 2,
      action: "respond",
      identity: pending.identity,
      gate_id: pending.gate_id,
      challenge: pending.challenge,
      response: validateContract(JsonValueSchema, event, "P03 LIVE native witness"),
    },
    signal
  );
  const record = input.service.checkpointer.hostOperationCallForDirective(
    proposal.run_id,
    SCA_P03_INITIAL_WORK_STATE,
    1,
    `initial:${proposal.approval_id}:${proposal.invocation_nonce}`
  );
  if (record === undefined) throw new Error("p03_live_consumed_observation_required");
  // The retained owner operation must still belong to this concrete service, not merely
  // to a caller-supplied declaration or an operation with a similar result label.
  const registration = input.service.engine.registration;
  const declarations = registration.host_operations?.declarations.filter(
    (declaration) => declaration.operation_kind === SCA_P03_INITIAL_OPERATION
  );
  const declaration = declarations?.[0];
  const retained = input.service.checkpointer.loadRunById(proposal.run_id);
  if (
    registration.name !== SCA_P03_INITIAL_NAME ||
    runtimeRegistrationSha256(registration) !== registrationSha256 ||
    retained?.registrationContractBinding?.registration_sha256 !== registrationSha256 ||
    declarations?.length !== 1 ||
    declaration === undefined
  )
    throw new Error("p03_live_owner_binding_mismatch");
  validateHostOperationDeclaration(declaration);
  const directive = validateDirective(record.directive);
  if (directive.action !== "invoke_host_operation")
    throw new Error("p03_live_owner_binding_mismatch");
  const witnessRef = directive.input_artifacts.artifacts.find(
    (artifact) => artifact.slot === "initial_witness"
  )?.ref;
  if (witnessRef === undefined) throw new Error("p03_live_owner_binding_mismatch");
  assertScaP03InitialControlRefV1(witnessRef, "witness");
  if (
    canonicalJson(directive.identity) !== canonicalJson(pending.identity) ||
    directive.state_id !== SCA_P03_INITIAL_WORK_STATE ||
    directive.attempt !== 1 ||
    directive.operation_id !== `initial:${proposal.approval_id}:${proposal.invocation_nonce}` ||
    directive.operation_kind !== SCA_P03_INITIAL_OPERATION ||
    directive.registration_sha256 !== registrationSha256 ||
    canonicalJson(directive.request_ref) !== canonicalJson(input.proposal_ref) ||
    directive.request_sha256 !== input.proposal_ref.content_digest ||
    canonicalJson(directive.expected_result) !== canonicalJson(declaration.result) ||
    canonicalJson(directive.policy_binding) !==
      canonicalJson(hostOperationPolicyBinding(declaration, proposal.backend_resource_sha256)) ||
    canonicalJson(directive.input_artifacts) !==
      canonicalJson(
        scaP03InitialOperationInputs(
          input.proposal_ref,
          input.transport_ref,
          witnessRef,
          proposal.input_refs
        )
      )
  )
    throw new Error("p03_live_owner_binding_mismatch");
  // The engine persists its own witness coordinate. Compare original submitted bytes,
  // not token-ref identity: the UI token is intentionally a different immutable artifact.
  if (!Buffer.from(exact(witnessRef)).equals(Buffer.from(text, "utf8")))
    throw new Error("p03_live_submitted_witness_mismatch");
  const verified = readScaP03ConsumedFixtureEvidenceV1({
    checkpointer: input.service.checkpointer,
    store,
    binding: input.binding,
    directive,
    declaration,
    expected_measurement_scope: "live_observed",
  });
  return {
    evidence: verified.evidence,
    result_ref: verified.result_ref,
    receipt_ref: verified.receipt_ref,
  };
}
