import { ArtifactStore, previewArtifactRef } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { Checkpointer } from "../../orchestration/dist/checkpointer.js";
import {
  validateContract,
  type ArtifactRef,
  type InvokeHostOperationDirectiveV1,
} from "../../orchestration/dist/contracts.js";
import {
  validateHostOperationReceipt,
  validateHostOperationResult,
  type HostOperationAdapterV1,
} from "../../orchestration/dist/host-operations/contracts.js";
import {
  SCA_P03_VERIFICATION_DECLARATION,
  SCA_P03_VERIFICATION_OPERATION,
  SCA_P03_VERIFICATION_RESULT_SCHEMA,
  ScaP03VerificationResultV1Schema,
  readScaP03VerificationRequestV1,
  scaP03VerificationInputsV1,
} from "../../orchestration/dist/sca/p03-bootstrap-verification.js";
import { sampleScaP03ProductionBootstrapDeterministicTestOnlyV1 } from "./p03-bootstrap-cli.js";
import type { ScaP03ProbeCommandV1 } from "./p03-bootstrap-local-probe.js";
import type { ScaP03ProductionSampleInputV1 } from "./p03-production-sampler.js";

import { OrchestrationService } from "../../orchestration/dist/service.js";
import {
  ScaP03InitialAuthorizationV1,
  ScaP03InitialProposalBindingV1,
  assertScaP03InitialControlRefV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import { readScaP03InitialGate } from "../../orchestration/dist/sca/p03-initial-qualification.js";
import {
  ScaP03SealedBootstrapEvidenceV1Schema,
  ScaP03SealedBootstrapInputsV1Schema,
  createScaP03InitialUseValidatorV1,
} from "./p03-initial-live.js";
import { createScaP03ApprovedInputReaderV1 } from "./p03-predecessor-inputs.js";
import { ScaP03InitialNativeHostV1 } from "./p03-initial-host.js";

/** Offline qualification only: the only substituted capability is Docker command observations.
 * Real proof parsing/custody, engine checkpoint, journal, lease, settlement and consumption run.
 * No live adapter or human-approval surrogate is supplied by this factory. */
export function createScaP03BootstrapVerificationDeterministicTestOnlyAdapterV1(input: {
  readonly store: ArtifactStore;
  readonly sample_input: ScaP03ProductionSampleInputV1;
  readonly approved_backend_resource_sha256: string;
  readonly docker_observations: ScaP03ProbeCommandV1;
}): HostOperationAdapterV1 {
  const sampleInput = structuredClone(input.sample_input);
  const store = input.store;
  const observations = input.docker_observations;
  const backend = input.approved_backend_resource_sha256;
  const declaration = SCA_P03_VERIFICATION_DECLARATION;
  return Object.freeze({
    adapter_id: declaration.adapter_id,
    inspectRequest({ directive, request_bytes, input_artifacts }) {
      const request = readScaP03VerificationRequestV1(request_bytes);
      if (
        request.run_id !== directive.identity.run_id ||
        request.manifest_sha256 !== sampleInput.manifest_sha256 ||
        request.backend_resource_sha256 !== backend ||
        directive.operation_id !== `verify-bootstrap:${request.invocation_nonce}` ||
        canonicalJson(input_artifacts) !== canonicalJson(scaP03VerificationInputsV1(request))
      )
        throw new Error("p03_verification_request_binding_invalid");
      return {
        schema_version: 1,
        operation_kind: SCA_P03_VERIFICATION_OPERATION,
        adapter_id: declaration.adapter_id,
        backend_binding_id: declaration.backend_binding_id,
        backend_key_sha256: backend,
      };
    },
    async run(context) {
      // No effects at inspectRequest or construction. The global guard commits before this
      // verifier can create a temporary Docker config/probe; journal failure leaves it guarded.
      context.beginSubmission();
      const request = readScaP03VerificationRequestV1(context.request_bytes);
      const sample = await sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(
        sampleInput,
        observations,
        { context, store }
      );
      context.signal.throwIfAborted();
      const result = validateContract(
        ScaP03VerificationResultV1Schema,
        {
          schema_id: SCA_P03_VERIFICATION_RESULT_SCHEMA,
          schema_version: 1,
          run_id: request.run_id,
          invocation_nonce: request.invocation_nonce,
          request_sha256: context.directive.request_sha256,
          sample,
        },
        "P03 verification result"
      );
      const content = canonicalJson(result);
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
        operation_result: { contract: declaration.result, media_type: "application/json", content },
      });
      return { disposition, ...persisted };
    },
  } satisfies HostOperationAdapterV1);
}

/** Read only this invocation's canonical consumed proof/result/receipt. No selected-latest lookup,
 * artifact discovery or recovered historical sample can substitute for these exact operands. */
/** Canonical separately approved operator invocation. Exact operands are owned, not a
 * callback, historical lookup, selected-latest field, boolean, signing key or grant issuer. */
export class ScaP03NativeVerificationInvocationV1 {
  private readonly directive: InvokeHostOperationDirectiveV1;
  constructor(
    private readonly input: {
      service: OrchestrationService;
      directive: InvokeHostOperationDirectiveV1;
      authorization: ScaP03InitialAuthorizationV1;
      native_host: ScaP03InitialNativeHostV1;
      binding: ScaP03InitialProposalBindingV1;
    }
  ) {
    if (
      !(input.service instanceof OrchestrationService) ||
      !(input.authorization instanceof ScaP03InitialAuthorizationV1) ||
      !(input.native_host instanceof ScaP03InitialNativeHostV1)
    )
      throw new Error("p03_native_verification_owner_required");
    this.input = { ...input };
    this.directive = structuredClone(input.directive);
  }
  async collect() {
    const { service, authorization, native_host } = this.input;
    const directive = this.directive;
    this.input.binding.assertRef(directive.request_ref);
    this.input.binding.assertRun(directive.identity.run_id);
    authorization.assertPinnedRef(directive.request_ref);
    const pinned = this.input.binding.proposal;
    if (
      pinned.effect !== "bootstrap_verification" ||
      directive.operation_id !== `initial:${pinned.approval_id}:${pinned.invocation_nonce}`
    )
      throw new Error("p03_native_consumed_purpose_mismatch");
    const declaration = service.engine.registration.host_operations?.declarations[0];
    if (declaration === undefined) throw new Error("p03_initial_declaration_required");
    const validator = createScaP03InitialUseValidatorV1({
      store: service.artifacts,
      authorization,
      binding: this.input.binding,
      native_host,
    });
    if (validator.preflightRefs === undefined) throw new Error("p03_initial_preflight_required");
    validator.preflightRefs({ directive, declaration });
    assertScaP03InitialControlRefV1(directive.request_ref, "proposal");
    const store = service.artifacts;
    const exact = (ref: ArtifactRef): unknown => {
      if (canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref))
        throw new Error("p03_native_consumed_ref_stale");
      const bytes = store.read(ref);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(text);
      if (
        bytes.byteLength !== ref.byte_length ||
        sha256(bytes) !== ref.content_digest ||
        canonicalJson(value) !== text
      )
        throw new Error("p03_native_consumed_bytes_stale");
      return value;
    };
    const proposal = this.input.binding.read(store, directive.request_ref);
    if (
      proposal.effect !== "bootstrap_verification" ||
      directive.operation_id !== `initial:${proposal.approval_id}:${proposal.invocation_nonce}` ||
      directive.identity.run_id !== proposal.run_id ||
      directive.request_sha256 !== directive.request_ref.content_digest ||
      directive.policy_binding.backend_key_sha256 !== proposal.backend_resource_sha256
    )
      throw new Error("p03_native_consumed_purpose_mismatch");
    const slot = (name: string) => {
      const ref = directive.input_artifacts.artifacts.find((v) => v.slot === name)?.ref;
      if (ref === undefined) throw new Error("p03_native_consumed_input_missing");
      return ref;
    };
    for (const kind of ["proposal", "transport", "witness"])
      assertScaP03InitialControlRefV1(slot(`initial_${kind}`), kind);
    const gate = readScaP03InitialGate(store, slot("initial_proposal"), slot("initial_transport"));
    const assertCurrent = () => {
      if (
        authorization.admit(proposal, gate, exact(slot("initial_witness"))).decision !== "approve"
      )
        throw new Error("p03_native_consumed_human_required");
      const reader = createScaP03ApprovedInputReaderV1(store, proposal.input_refs);
      const m = validateContract(
        ScaP03SealedBootstrapInputsV1Schema,
        reader.json(proposal.sealed_bootstrap_inputs_ref, "sealed_inputs"),
        "P03 current native inputs"
      );
      reader.finish();
      native_host.assertSealedInputs(m, proposal);
    };
    assertCurrent();
    // Execution/recovery uses the SAME existing service owner. No effects run in an
    // activation SQLite consume transaction or an ordinary phase-host pre-use guard.
    await service.execute({ schema_version: 2, action: "recover", identity: directive.identity });
    assertCurrent();
    const record = service.checkpointer.hostOperationCallForDirective(
      directive.identity.run_id,
      directive.state_id,
      directive.attempt,
      directive.operation_id
    );
    if (
      record === undefined ||
      record.lifecycle !== "consumed" ||
      canonicalJson(record.directive) !== canonicalJson(directive) ||
      record.disposition?.outcome !== "completed" ||
      record.operation_result_ref === null ||
      record.platform_result_ref === null ||
      record.host_receipt_ref === null
    )
      throw new Error("p03_native_current_consumed_result_required");
    store.assertBoundProject(record.project_id);
    const result = validateContract(
      ScaP03SealedBootstrapEvidenceV1Schema,
      exact(record.operation_result_ref),
      "P03 native consumed verification"
    );
    const platform = validateHostOperationResult(exact(record.platform_result_ref));
    const receipt = validateHostOperationReceipt(exact(record.host_receipt_ref));
    for (const envelope of [platform, receipt])
      if (
        canonicalJson(envelope.identity) !== canonicalJson(directive.identity) ||
        envelope.operation_record_id !== record.operation_record_id ||
        envelope.state_id !== directive.state_id ||
        envelope.attempt !== directive.attempt ||
        envelope.operation_id !== directive.operation_id ||
        envelope.operation_kind !== directive.operation_kind ||
        envelope.registration_sha256 !== directive.registration_sha256 ||
        envelope.request_sha256 !== directive.request_sha256 ||
        canonicalJson(envelope.disposition) !== canonicalJson(record.disposition)
      )
        throw new Error("p03_native_consumed_owner_mismatch");
    if (
      result.run_id !== proposal.run_id ||
      result.invocation_nonce !== proposal.invocation_nonce ||
      result.request_sha256 !== directive.request_sha256 ||
      canonicalJson(result.sealed_bootstrap_inputs_ref) !==
        canonicalJson(proposal.sealed_bootstrap_inputs_ref) ||
      canonicalJson(platform.operation_result_ref) !== canonicalJson(record.operation_result_ref) ||
      canonicalJson(platform.lease) !== canonicalJson(record.lease) ||
      receipt.result_sha256 !== record.operation_result_ref.content_digest ||
      receipt.remote_correlation_sha256 !== record.remote_correlation_sha256 ||
      receipt.lease_disposition_receipt_id !== record.lease_disposition_receipt_id
    )
      throw new Error("p03_native_consumed_invocation_mismatch");
    return {
      sample: result.sample,
      result_ref: record.operation_result_ref,
      receipt_ref: record.host_receipt_ref,
      manifest_sha256: result.manifest_sha256,
      backend_resource_sha256: proposal.backend_resource_sha256,
    };
  }
}
export function readScaP03ConsumedVerificationV1(input: {
  readonly checkpointer: Checkpointer;
  readonly store: ArtifactStore;
  readonly directive: InvokeHostOperationDirectiveV1;
  readonly invocation_nonce: string;
}) {
  const directive = input.directive;
  const record = input.checkpointer.hostOperationCallForDirective(
    directive.identity.run_id,
    directive.state_id,
    directive.attempt,
    directive.operation_id
  );
  if (
    record === undefined ||
    record.lifecycle !== "consumed" ||
    canonicalJson(record.directive) !== canonicalJson(directive) ||
    record.disposition?.outcome !== "completed" ||
    record.operation_result_ref === null ||
    record.platform_result_ref === null ||
    record.host_receipt_ref === null
  )
    throw new Error("p03_verification_current_consumed_result_required");
  input.store.assertBoundProject(record.project_id);
  const exactJson = (ref: ArtifactRef): unknown => {
    if (canonicalJson(input.store.refById(ref.artifact_id)) !== canonicalJson(ref))
      throw new Error("p03_verification_consumed_ref_stale");
    const bytes = input.store.read(ref);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (
      bytes.length !== ref.byte_length ||
      sha256(bytes) !== ref.content_digest ||
      canonicalJson(previewArtifactRef({ metadata: input.store.metadata(ref), content: bytes })) !==
        canonicalJson(ref) ||
      canonicalJson(value) !== text
    )
      throw new Error("p03_verification_consumed_bytes_stale");
    return value;
  };
  const request = readScaP03VerificationRequestV1(
    Buffer.from(canonicalJson(exactJson(directive.request_ref)))
  );
  const result = validateContract(
    ScaP03VerificationResultV1Schema,
    exactJson(record.operation_result_ref),
    "P03 consumed verification"
  );
  const platform = validateHostOperationResult(exactJson(record.platform_result_ref));
  const receipt = validateHostOperationReceipt(exactJson(record.host_receipt_ref));
  if (
    request.invocation_nonce !== input.invocation_nonce ||
    result.invocation_nonce !== input.invocation_nonce ||
    request.run_id !== directive.identity.run_id ||
    result.run_id !== request.run_id ||
    result.request_sha256 !== directive.request_sha256 ||
    platform.operation_record_id !== record.operation_record_id ||
    receipt.operation_record_id !== record.operation_record_id ||
    canonicalJson(platform.identity) !== canonicalJson(directive.identity) ||
    canonicalJson(receipt.identity) !== canonicalJson(directive.identity) ||
    platform.state_id !== directive.state_id ||
    receipt.state_id !== directive.state_id ||
    platform.attempt !== directive.attempt ||
    receipt.attempt !== directive.attempt ||
    platform.operation_id !== directive.operation_id ||
    receipt.operation_id !== directive.operation_id ||
    platform.operation_kind !== directive.operation_kind ||
    receipt.operation_kind !== directive.operation_kind ||
    platform.registration_sha256 !== directive.registration_sha256 ||
    receipt.registration_sha256 !== directive.registration_sha256 ||
    canonicalJson(platform.lease) !== canonicalJson(record.lease) ||
    receipt.remote_correlation_sha256 !== record.remote_correlation_sha256 ||
    platform.request_sha256 !== directive.request_sha256 ||
    receipt.request_sha256 !== directive.request_sha256 ||
    canonicalJson(platform.operation_result_ref) !== canonicalJson(record.operation_result_ref) ||
    canonicalJson(platform.disposition) !== canonicalJson(record.disposition) ||
    canonicalJson(receipt.disposition) !== canonicalJson(record.disposition) ||
    receipt.result_sha256 !== record.operation_result_ref.content_digest ||
    receipt.lease_disposition_receipt_id !== record.lease_disposition_receipt_id
  )
    throw new Error("p03_verification_current_invocation_mismatch");
  return {
    sample: result.sample,
    result_ref: record.operation_result_ref,
    receipt_ref: record.host_receipt_ref,
  };
}
