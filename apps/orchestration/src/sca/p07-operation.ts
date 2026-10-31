import { TextDecoder } from "node:util";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type {
  ArtifactRef,
  HostOperationArtifactContractV1,
  InvokeHostOperationDirectiveV1,
  RunIdentity,
} from "../contracts.js";
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  validateHostOperationDeclaration,
  type HostOperationAdapterV1,
  type HostOperationAdapterTerminalV1,
  type HostOperationDeclarationV1,
  type HostOperationDispositionV1,
  type HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import {
  classifyScaBrokerJobProgressV1,
  scaBrokerExecuteRequestSha256,
  validateScaBrokerCancelResultV1,
  validateScaBrokerExecuteAcceptedResult,
  validateScaBrokerPollResult,
  validateScaBrokerReceiptV1,
  type ScaBrokerCancelRequestV1,
  type ScaBrokerCancelResultV1,
  type ScaBrokerExecuteAcceptedResult,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerJobProgressV1,
  type ScaBrokerPollRequestV1,
  type ScaBrokerPollResult,
  type ScaBrokerReceiptV1,
} from "./broker-contracts.js";
import {
  SCA_P07_HOST_REQUEST_SCHEMA,
  SCA_P07_HOST_RESULT_SCHEMA,
  SCA_P07_EXECUTION_PLAN_SCHEMA,
  SCA_P07_ADMISSION_SCHEMA,
  withP07Digest,
  validateScaP07AdmissionV1,
  validateScaP07ExecutionPlanV1,
  validateScaP07HostRequestV1,
  validateScaP07HostResultV1,
  type ScaP07ExecutionPlanV1,
  type ScaP07HostRequestV1,
} from "./p07-contracts.js";

export const SCA_P07_OPERATION_KIND = "sca.p07-broker-execute.v1" as const;
export const SCA_P07_ADAPTER_ID = "sca.p07-broker-adapter.v1" as const;
export const SCA_P07_REQUEST_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "p07_host_request",
  artifact_kind: "sca-p07-host-request",
  schema_id: SCA_P07_HOST_REQUEST_SCHEMA,
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);
export const SCA_P07_RESULT_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "p07_host_result",
  artifact_kind: "sca-p07-host-result",
  schema_id: SCA_P07_HOST_RESULT_SCHEMA,
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

/** Candidate only: never installed into PLAYBOOK_REGISTRY by this module. */
export function createScaP07HostDeclaration(input: {
  readonly backend_binding_id: string;
  readonly lease_profile_id: string;
  readonly lease_duration_ms: number;
  readonly lease_renew_after_ms: number;
  readonly queue_inactivity_ms: number;
  readonly operation_inactivity_ms: number;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
}): HostOperationDeclarationV1 {
  const lease = {
    profile_id: input.lease_profile_id,
    profile_version: 1 as const,
    duration_ms: input.lease_duration_ms,
    renew_after_ms: input.lease_renew_after_ms,
    queue_inactivity_ms: input.queue_inactivity_ms,
  };
  return validateHostOperationDeclaration({
    schema_version: 1,
    operation_kind: SCA_P07_OPERATION_KIND,
    adapter_id: SCA_P07_ADAPTER_ID,
    request: SCA_P07_REQUEST_CONTRACT,
    result: SCA_P07_RESULT_CONTRACT,
    backend_binding_id: input.backend_binding_id,
    capability_classes: ["artifact_store", "registered_loopback_http"],
    lease_profile: { ...lease, profile_sha256: hostOperationLeaseProfileSha256(lease) },
    operation_inactivity_ms: input.operation_inactivity_ms,
    max_request_bytes: 262_144,
    max_input_artifacts: 2,
    max_input_bytes: input.max_input_bytes,
    max_output_artifacts: 1,
    max_output_bytes: input.max_output_bytes,
    max_progress_events: 1024,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "registered_remote_cancel_then_observe_v1",
  });
}

function decode(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error("P07 noncanonical JSON");
  return value;
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function checkItem(
  request: ScaP07HostRequestV1,
  plan: ScaP07ExecutionPlanV1,
  admission: ReturnType<typeof validateScaP07AdmissionV1>
): void {
  const item = plan.items[request.item_index];
  if (
    item === undefined ||
    !same(item.action_record_ref, request.action_record_ref) ||
    !same(item.broker_request, request.broker_request) ||
    item.broker_request_sha256 !== request.broker_request_sha256 ||
    admission.request_hashes[request.item_index] !== request.broker_request_sha256 ||
    !same(admission.plan_ref, request.plan_ref) ||
    !same(plan.authority_ref, admission.authority_ref) ||
    !same(plan.transition_ref, admission.transition_ref)
  )
    throw new Error("P07 host request differs from admitted plan");
}
function terminal(disposition: HostOperationDispositionV1): HostOperationAdapterTerminalV1 {
  return { disposition, operation_result_ref: null, output_artifacts: [] };
}
function outcome(receipt: ScaBrokerReceiptV1): HostOperationDispositionV1 {
  switch (receipt.terminal_status) {
    case "succeeded":
      return {
        outcome: "completed",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
        retryable: false,
        reason_code: null,
      };
    case "failed":
      return {
        outcome: "remote_unknown",
        remote_disposition: "may_continue",
        lease_disposition: "quarantined",
        retryable: false,
        reason_code: "broker_failure_containment_unproven",
      };
    case "cancelled":
      return {
        outcome: "cancelled",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
        retryable: false,
        reason_code: "broker_terminal_cancelled",
      };
    case "timed_out":
      return {
        outcome: "timed_out",
        remote_disposition: "may_continue",
        lease_disposition: "quarantined",
        retryable: false,
        reason_code: "broker_timeout_containment_unproven",
      };
  }
}
function unknownRemote(): HostOperationDispositionV1 {
  return {
    outcome: "remote_unknown",
    remote_disposition: "may_continue",
    lease_disposition: "quarantined",
    retryable: false,
    reason_code: "broker_terminal_unproven",
  };
}

/** Broker transport is injected by the host; this adapter has no provider/model surface. */
export interface ScaP07BrokerClientV1 {
  execute(
    request: ScaBrokerExecuteRequestV1,
    signal: AbortSignal
  ): Promise<ScaBrokerExecuteAcceptedResult>;
  /** Terminal poll results are validated against the exact execute request that accepted the job. */
  poll(
    request: ScaBrokerPollRequestV1,
    execute_request: ScaBrokerExecuteRequestV1,
    signal: AbortSignal
  ): Promise<ScaBrokerPollResult>;
  /** Terminal cancel results are validated against the exact execute request that accepted the job. */
  cancel(
    request: ScaBrokerCancelRequestV1,
    execute_request: ScaBrokerExecuteRequestV1,
    signal: AbortSignal
  ): Promise<ScaBrokerCancelResultV1>;
}

export interface ScaP07CurrentAdmissionCheckV1 {
  readonly request: ScaP07HostRequestV1;
  readonly plan: ScaP07ExecutionPlanV1;
  readonly plan_ref: ArtifactRef;
  readonly admission: ReturnType<typeof validateScaP07AdmissionV1>;
  readonly admission_ref: ArtifactRef;
}

export function createScaP07HostAdapter(input: {
  readonly client: ScaP07BrokerClientV1;
  readonly backend_key_sha256: string;
  /** Owner-provided use-time check; must reject superseded authority/admission before any I/O. */
  readonly assertCurrentAdmission: (
    admitted: ScaP07CurrentAdmissionCheckV1
  ) => void | Promise<void>;
  readonly now?: () => Date;
}): HostOperationAdapterV1 {
  const now = input.now ?? (() => new Date());
  return {
    adapter_id: SCA_P07_ADAPTER_ID,
    inspectRequest(inspected) {
      const request = validateScaP07HostRequestV1(decode(inspected.request_bytes));
      if (
        inspected.directive.operation_kind !== SCA_P07_OPERATION_KIND ||
        inspected.declaration.adapter_id !== SCA_P07_ADAPTER_ID ||
        inspected.input_artifacts.artifacts.length !== 2 ||
        !inspected.input_artifacts.artifacts.some(
          (entry) => entry.slot === "plan" && same(entry.ref, request.plan_ref)
        ) ||
        !inspected.input_artifacts.artifacts.some(
          (entry) => entry.slot === "admission" && same(entry.ref, request.admission_ref)
        )
      )
        throw new Error("P07 host request input or declaration drift");
      return {
        schema_version: 1,
        operation_kind: SCA_P07_OPERATION_KIND,
        adapter_id: SCA_P07_ADAPTER_ID,
        backend_binding_id: inspected.declaration.backend_binding_id,
        backend_key_sha256: input.backend_key_sha256,
      };
    },
    async run(context: HostOperationExecutionContextV1): Promise<HostOperationAdapterTerminalV1> {
      const request = validateScaP07HostRequestV1(decode(context.request_bytes));
      const planInput = context.readInput("plan");
      const admissionInput = context.readInput("admission");
      if (
        !same(planInput.ref, request.plan_ref) ||
        !same(admissionInput.ref, request.admission_ref) ||
        context.directive.policy_binding.backend_key_sha256 !== input.backend_key_sha256
      )
        throw new Error("P07 runtime input drift");
      const plan = validateScaP07ExecutionPlanV1(decode(planInput.bytes));
      const admission = validateScaP07AdmissionV1(decode(admissionInput.bytes));
      checkItem(request, plan, admission);
      await input.assertCurrentAdmission({
        request,
        plan,
        plan_ref: planInput.ref,
        admission,
        admission_ref: admissionInput.ref,
      });
      const broker = request.broker_request;
      const hash = scaBrokerExecuteRequestSha256(broker);
      const binding = {
        tenant_id: broker.tenant_id,
        project_id: broker.project_id,
        run_id: broker.run_id,
        job_id: broker.job_id,
        attempt: broker.attempt,
        idempotency_key: broker.idempotency_key,
        tool_name: broker.tool_name,
        operation: broker.operation,
        request_sha256: hash,
      };
      context.registerRemoteCancellation(async (signal) => {
        const at = now();
        const cancelRequest = {
          schema_id: "penny.sca-broker-cancel-request.v1" as const,
          schema_version: 1 as const,
          ...binding,
          requested_at: at.toISOString(),
          deadline_at: new Date(at.getTime() + 1000).toISOString(),
          timeout_ms: 1000,
          reason: "parent_cancelled" as const,
        };
        try {
          const result = validateScaBrokerCancelResultV1(
            await input.client.cancel(cancelRequest, broker, signal),
            cancelRequest,
            broker
          );
          if (result.outcome !== "terminal" || result.receipt === null) {
            return { remote_disposition: "may_continue", reason_code: "broker_cancel_unproven" };
          }
          const disposition = outcome(result.receipt);
          return disposition.remote_disposition === "proven_terminal"
            ? { remote_disposition: "proven_terminal", reason_code: "broker_cancel_terminal" }
            : {
                remote_disposition: "may_continue",
                reason_code: "broker_cancel_containment_unproven",
              };
        } catch {
          return { remote_disposition: "may_continue", reason_code: "broker_cancel_unknown" };
        }
      });
      if (context.signal.aborted) throw new Error("P07 cancelled before broker submission");
      if (context.journal.lifecycle === "fetched" || context.journal.lifecycle === "persisting") {
        const cached = await context.readCachedResult();
        if (
          cached === null ||
          cached.request_sha256 !== context.directive.request_sha256 ||
          cached.content_sha256 !== sha256(cached.bytes) ||
          cached.byte_length !== cached.bytes.byteLength ||
          context.journal.fetched === null ||
          cached.content_sha256 !== context.journal.fetched.content_sha256 ||
          cached.byte_length !== context.journal.fetched.byte_length
        )
          throw new Error("P07 fetched milestone lacks exact cached receipt");
        return persistReceipt(context, request, cached.bytes);
      }
      let lastProgress: ScaBrokerJobProgressV1 | null = null;
      if (context.journal.lifecycle === "submitted") {
        const cached = await context.readCachedResult();
        if (cached !== null) {
          if (
            cached.request_sha256 !== context.directive.request_sha256 ||
            cached.content_sha256 !== sha256(cached.bytes) ||
            cached.byte_length !== cached.bytes.byteLength
          )
            throw new Error("P07 submitted milestone has a divergent cached receipt");
          validateScaP07HostResultV1(decode(cached.bytes), request);
          context.recordFetched({
            schema_version: 1,
            content_sha256: cached.content_sha256,
            byte_length: cached.byte_length,
            item_count: 1,
            poll_count: 0,
          });
          return persistReceipt(context, request, cached.bytes);
        }
      }
      if (context.journal.remote_correlation_id === null) {
        context.beginSubmission();
        const accepted = validateScaBrokerExecuteAcceptedResult(
          await input.client.execute(broker, context.signal),
          broker
        );
        if (accepted.status !== "accepted") throw new Error("P07 broker did not accept request");
        if ("progress" in accepted) lastProgress = accepted.progress;
        context.recordRemoteAccepted(broker.job_id);
      } else if (context.journal.remote_correlation_id !== broker.job_id) {
        throw new Error("P07 remote correlation drift");
      }
      for (let count = 0; ; count++) {
        if (context.signal.aborted) throw new Error("P07 broker polling cancelled");
        const at = now();
        const pollRequest = {
          schema_id: "penny.sca-broker-poll-request.v1" as const,
          schema_version: 1 as const,
          ...binding,
          requested_at: at.toISOString(),
          deadline_at: new Date(at.getTime() + 1000).toISOString(),
          poll_timeout_ms: 1000,
        };
        let poll: ScaBrokerPollResult;
        try {
          poll = validateScaBrokerPollResult(
            await input.client.poll(pollRequest, broker, context.signal),
            pollRequest,
            broker
          );
        } catch (error) {
          if (context.signal.aborted) throw error;
          return terminal(unknownRemote());
        }
        if ("progress" in poll) {
          const prior = lastProgress;
          lastProgress = poll.progress;
          let advanced = false;
          try {
            advanced =
              prior !== null && classifyScaBrokerJobProgressV1(prior, poll.progress) === "advanced";
          } catch {
            return terminal(unknownRemote());
          }
          if (advanced) {
            context.reportActivity("sca_broker_progress");
            context.emitProgress({
              progress_class: "adapter_progress",
              completed_units: poll.progress.work_units,
              detail_code: "broker_progress",
              metadata: {
                broker_sequence: poll.progress.sequence,
                output_bytes: poll.progress.output_bytes,
                result_items: poll.progress.result_items,
              },
            });
          }
        }
        if (poll.status === "accepted" || poll.status === "running") {
          // Unchanged polling state does not renew inactivity.
          continue;
        }
        if (poll.receipt === null) throw new Error("P07 terminal poll lacks receipt");
        const receipt = validateScaBrokerReceiptV1(poll.receipt, broker);
        const result = validateScaP07HostResultV1(
          withP07Digest(
            {
              schema_id: SCA_P07_HOST_RESULT_SCHEMA,
              schema_version: 1 as const,
              request_sha256: request.request_sha256,
              plan_ref: request.plan_ref,
              admission_ref: request.admission_ref,
              action_record_ref: request.action_record_ref,
              receipt,
            },
            "result_sha256"
          ),
          request
        );
        const bytes = Buffer.from(canonicalJson(result));
        await context.cacheResult(bytes);
        context.recordFetched({
          schema_version: 1,
          content_sha256: sha256(bytes),
          byte_length: bytes.byteLength,
          item_count: 1,
          poll_count: count + 1,
        });
        return persistReceipt(context, request, bytes);
      }
    },
  };
}
function persistReceipt(
  context: HostOperationExecutionContextV1,
  request: ScaP07HostRequestV1,
  bytes: Uint8Array
): HostOperationAdapterTerminalV1 {
  const result = validateScaP07HostResultV1(decode(bytes), request);
  const disposition = outcome(result.receipt);
  const persisted = context.persist({
    disposition,
    operation_result: {
      contract: SCA_P07_RESULT_CONTRACT,
      media_type: "application/json",
      content: bytes,
    },
  });
  return {
    disposition,
    operation_result_ref: persisted.operation_result_ref,
    output_artifacts: persisted.output_artifacts,
  };
}

/** Pure ordered projection. Caller persists each exact host request before invoking this helper. */
export function scaP07HostDirectives(input: {
  readonly plan: ScaP07ExecutionPlanV1;
  readonly plan_ref: ArtifactRef;
  readonly admission: ReturnType<typeof validateScaP07AdmissionV1>;
  readonly admission_ref: ArtifactRef;
  readonly requests: readonly { readonly ref: ArtifactRef; readonly value: ScaP07HostRequestV1 }[];
  readonly identity: RunIdentity;
  readonly state_id: string;
  readonly attempt: number;
  readonly registration_sha256: string;
  readonly declaration: HostOperationDeclarationV1;
  readonly backend_key_sha256: string;
}): InvokeHostOperationDirectiveV1[] {
  const plan = validateScaP07ExecutionPlanV1(input.plan);
  const admission = validateScaP07AdmissionV1(input.admission);
  if (
    !same(admission.plan_ref, input.plan_ref) ||
    !same(input.plan_ref.content_digest, sha256(canonicalJson(plan))) ||
    !same(input.admission_ref.content_digest, sha256(canonicalJson(admission))) ||
    input.plan_ref.kind !== "sca-p07-execution-plan" ||
    input.plan_ref.content_schema?.schema_id !== SCA_P07_EXECUTION_PLAN_SCHEMA ||
    input.admission_ref.kind !== "sca-p07-admission" ||
    input.admission_ref.content_schema?.schema_id !== SCA_P07_ADMISSION_SCHEMA ||
    input.plan_ref.run_id !== input.identity.run_id ||
    input.admission_ref.run_id !== input.identity.run_id ||
    input.requests.length !== plan.items.length ||
    input.identity.run_id !== plan.transition_ref.run_id
  )
    throw new Error("P07 directive cohort mismatch");
  const declaration = validateHostOperationDeclaration(input.declaration);
  if (
    declaration.operation_kind !== SCA_P07_OPERATION_KIND ||
    declaration.adapter_id !== SCA_P07_ADAPTER_ID ||
    !same(declaration.request, SCA_P07_REQUEST_CONTRACT) ||
    !same(declaration.result, SCA_P07_RESULT_CONTRACT)
  )
    throw new Error("P07 inactive declaration mismatch");
  return input.requests.map(({ ref, value }, index) => {
    const request = validateScaP07HostRequestV1(value);
    checkItem(request, plan, admission);
    if (
      request.item_index !== index ||
      !same(request.plan_ref, input.plan_ref) ||
      !same(request.admission_ref, input.admission_ref) ||
      ref.kind !== SCA_P07_REQUEST_CONTRACT.artifact_kind ||
      ref.run_id !== input.identity.run_id ||
      ref.content_schema?.schema_id !== SCA_P07_HOST_REQUEST_SCHEMA ||
      ref.content_schema.schema_version !== 1 ||
      ref.content_digest !== sha256(canonicalJson(request))
    )
      throw new Error("P07 directive request ref mismatch");
    return {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: input.identity,
      state_id: input.state_id,
      attempt: input.attempt,
      operation_id: `p07-${sha256(canonicalJson({ action_record_ref: request.action_record_ref, job_id: request.broker_request.job_id, attempt: request.broker_request.attempt }))}`,
      operation_kind: SCA_P07_OPERATION_KIND,
      registration_sha256: input.registration_sha256,
      request_ref: ref,
      request_sha256: ref.content_digest,
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "plan", ref: input.plan_ref },
          { slot: "admission", ref: input.admission_ref },
        ],
      },
      expected_result: SCA_P07_RESULT_CONTRACT,
      policy_binding: hostOperationPolicyBinding(declaration, input.backend_key_sha256),
    };
  });
}
