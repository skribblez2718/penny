import type { ArtifactRef } from "../contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ConfinedMediaRunner } from "../host-operations/confined-media-runner.js";
import type { HostOperationAdapterV1 } from "../host-operations/contracts.js";
import { isCanonicalHostOperationExecutionContextV1 } from "../host-operations/owner.js";
import { sameRef, type FoundationLimitsV1 } from "./bounds.js";
import {
  AvMediaPolicyV1Schema,
  AvMediaRequestV1Schema,
  AV_MEDIA_REQUEST_CONTRACT,
  AV_MEDIA_RESULT_CONTRACT,
  validateAvMediaPolicy,
  validateAvMediaRequest,
  type AvMediaPolicyV1,
} from "./av-media-contracts.js";
import { avRefuse } from "./av-media-container.js";
import { decodeAvMediaBytes } from "./av-media-decode.js";
import {
  MEDIA_FRAME_CONTRACT,
  MEDIA_PCM_CONTRACT,
  MediaFrameSelectionV1Schema,
  parseMediaJson,
} from "./media-contracts.js";

export interface AvMediaAdapterBindingV1 {
  readonly adapter_id: string;
  readonly backend_binding_id: string;
  readonly backend_key_sha256: string;
  readonly policy_ref: ArtifactRef;
  readonly policy: AvMediaPolicyV1;
  readonly runner: ConfinedMediaRunner;
  readonly limits: FoundationLimitsV1;
}
/** Unregistered raw primitive. The existing owner alone creates raw artifacts and receipts.
 * No gate/rights/production adapter, caller PASS hook, runtime, signer or store is created here. */
export function createAvMediaDecodeAdapter(
  binding: AvMediaAdapterBindingV1
): HostOperationAdapterV1 {
  if (!ConfinedMediaRunner.isTrusted(binding.runner)) avRefuse("concrete runner binding required");
  const b = {
    ...binding,
    policy: validateAvMediaPolicy(structuredClone(binding.policy)),
    policy_ref: structuredClone(binding.policy_ref),
    limits: structuredClone(binding.limits),
  };
  if (
    sha256(canonicalJson(b.policy)) !== b.policy_ref.content_digest ||
    Buffer.byteLength(canonicalJson(b.policy)) !== b.policy_ref.byte_length ||
    b.policy_ref.media_type !== "application/json" ||
    b.policy_ref.content_schema?.schema_id !== b.policy.schema_id ||
    b.policy_ref.content_schema.schema_version !== b.policy.schema_version
  )
    avRefuse("policy binding digest");
  const parse = (bytes: Uint8Array) =>
    validateAvMediaRequest(parseMediaJson(AvMediaRequestV1Schema, bytes, b.limits), b.policy);
  const inspect: HostOperationAdapterV1["inspectRequest"] = (input) => {
    const r = parse(input.request_bytes),
      d = input.directive;
    if (
      d.operation_kind !== "media_decode_extract" ||
      d.operation_id !== r.operation_id ||
      canonicalJson(d.expected_result) !== canonicalJson(AV_MEDIA_RESULT_CONTRACT) ||
      canonicalJson(input.declaration.request) !== canonicalJson(AV_MEDIA_REQUEST_CONTRACT) ||
      !sameRef(r.decode_policy_ref, b.policy_ref)
    )
      avRefuse("registration/request identity");
    if (
      canonicalJson(d.input_artifacts.artifacts) !==
      canonicalJson([
        { slot: "media", ref: r.media_ref },
        { slot: "decode-policy", ref: r.decode_policy_ref },
        { slot: "frame-selection", ref: r.frame_selection_ref },
      ])
    )
      avRefuse("exact input slots");
    return {
      schema_version: 1,
      operation_kind: "media_decode_extract",
      adapter_id: b.adapter_id,
      backend_binding_id: b.backend_binding_id,
      backend_key_sha256: b.backend_key_sha256,
    };
  };
  return {
    adapter_id: b.adapter_id,
    inspectRequest: inspect,
    async run(context) {
      if (!isCanonicalHostOperationExecutionContextV1(context))
        avRefuse("original owner execution custody required");
      inspect({
        directive: context.directive,
        declaration: context.declaration,
        request_bytes: context.request_bytes,
        input_artifacts: context.directive.input_artifacts,
      });
      if (context.journal.lifecycle !== "lease_acquired")
        avRefuse("interrupted local decode requires fresh explicit operation");
      const request = parse(context.request_bytes);
      const policy = parseMediaJson(
        AvMediaPolicyV1Schema,
        context.readInput("decode-policy").bytes,
        b.limits
      );
      if (canonicalJson(policy) !== canonicalJson(b.policy)) avRefuse("current policy drift");
      const selection = parseMediaJson(
        MediaFrameSelectionV1Schema,
        context.readInput("frame-selection").bytes,
        b.limits
      );
      context.beginSubmission();
      let closed = false;
      context.registerRemoteCancellation(async () =>
        closed
          ? { remote_disposition: "proven_terminal", reason_code: "local_av_processes_closed" }
          : { remote_disposition: "may_continue", reason_code: "local_av_cleanup_pending" }
      );
      let decoded;
      try {
        decoded = await decodeAvMediaBytes({
          runner: b.runner,
          request,
          bytes: context.readInput("media").bytes,
          policy,
          selection,
          limits: b.limits,
          signal: context.signal,
        }).finally(() => {
          closed = true;
        });
      } catch {
        context.signal.throwIfAborted();
        return {
          disposition: {
            outcome: "failed",
            remote_disposition: "proven_terminal",
            lease_disposition: "released",
            retryable: false,
            reason_code: "av_media_decode_refused",
          },
          operation_result_ref: null,
          output_artifacts: [],
        };
      }
      context.reportActivity("full_av_decode", 1);
      const text = canonicalJson(decoded.result);
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(text),
        byte_length: Buffer.byteLength(text),
        item_count: decoded.outputs.length,
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
          contract: AV_MEDIA_RESULT_CONTRACT,
          media_type: "application/json",
          content: text,
        },
        outputs: decoded.outputs.map((o) => ({
          contract: o.media_type === "image/png" ? MEDIA_FRAME_CONTRACT : MEDIA_PCM_CONTRACT,
          media_type: o.media_type,
          content: o.bytes,
        })),
      });
      return { disposition, ...persisted };
    },
  };
}
