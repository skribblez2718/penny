import { ManagedComputeRelay } from "../host-operations/managed-compute-relay.js";
import { HOST_RECEIPTED_RESULT_CONTRACT } from "../host-operations/effect-protocol.js";
import { TextDecoder } from "node:util";

import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, HostOperationArtifactContractV1 } from "../contracts.js";
import { ComfyClientError, ComfyHttpClient, type ComfyClientLimitsV1 } from "../comfy/client.js";
import {
  hostOperationLeaseProfileSha256,
  type HostOperationAdapterTerminalV1,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
  type HostOperationDispositionV1,
  type HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import { DEFAULT_PNG_MEDIA_LIMITS, HARD_PNG_MEDIA_LIMITS, sanitizePng } from "../png-media.js";
import {
  validateVideoReferenceUploadOperationRequest,
  validateVideoReferenceUploadReceipt,
  validateVideogenProfileSnapshot,
  type VideoReferenceUploadReceiptV1,
} from "./contracts.js";
import type { VideogenProfileRegistry } from "./profile-registry.js";

export const COMFY_VIDEO_UPLOAD_OPERATION_KIND = "videogen.comfyui-upload-reference.v1" as const;
export const COMFY_VIDEO_UPLOAD_ADAPTER_ID = "videogen.comfyui-upload-adapter.v1" as const;

export const VIDEO_REFERENCE_UPLOAD_REQUEST_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "upload_request",
  artifact_kind: "video-reference-upload-operation-request",
  schema_id: "penny.video-reference-upload-operation-request.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export const VIDEO_REFERENCE_UPLOAD_RECEIPT_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "upload_receipt",
  artifact_kind: "video-reference-upload-receipt",
  schema_id: "penny.video-reference-upload-receipt.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export function createComfyVideoUploadDeclaration(input: {
  readonly managed?: boolean;
  readonly effect_protocol?: "request_intent_v1";
  readonly backend_binding_id: string;
  readonly lease_profile_id: string;
  readonly lease_duration_ms: number;
  readonly lease_renew_after_ms: number;
  readonly queue_inactivity_ms: number;
  readonly operation_inactivity_ms: number;
  readonly max_request_bytes: number;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
  readonly max_progress_events: number;
}): HostOperationDeclarationV1 {
  const leaseBody = {
    profile_id: input.lease_profile_id,
    profile_version: 1 as const,
    duration_ms: input.lease_duration_ms,
    renew_after_ms: input.lease_renew_after_ms,
    queue_inactivity_ms: input.queue_inactivity_ms,
  };
  return {
    schema_version: 1,
    operation_kind:
      input.effect_protocol === undefined ? COMFY_VIDEO_UPLOAD_OPERATION_KIND : "reference_upload",
    adapter_id: COMFY_VIDEO_UPLOAD_ADAPTER_ID,
    request: VIDEO_REFERENCE_UPLOAD_REQUEST_CONTRACT,
    ...(input.effect_protocol === undefined
      ? {}
      : {
          effect_protocol: input.effect_protocol,
          result_selection_policy: "unselected",
          receipt_citing_result: HOST_RECEIPTED_RESULT_CONTRACT,
        }),
    result: VIDEO_REFERENCE_UPLOAD_RECEIPT_CONTRACT,
    backend_binding_id: input.backend_binding_id,
    capability_classes: ["artifact_store", "registered_loopback_http"],
    lease_profile: {
      ...leaseBody,
      profile_sha256: hostOperationLeaseProfileSha256(leaseBody),
    },
    operation_inactivity_ms: input.operation_inactivity_ms,
    max_request_bytes: input.max_request_bytes,
    max_input_artifacts: 2,
    max_input_bytes: input.max_input_bytes,
    max_output_artifacts: input.effect_protocol === undefined ? 1 : 2,
    max_output_bytes: input.max_output_bytes,
    max_progress_events: input.max_progress_events,
    max_pre_acceptance_retries: input.managed ? 0 : 1,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
}

function exactJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  if (canonicalJson(value) !== text) throw new Error(`${label} is not canonical JSON`);
  return value;
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function disposition(
  outcome: "completed" | "failed" | "remote_unknown",
  reasonCode: string | null,
  retryable = false
): HostOperationDispositionV1 {
  if (outcome === "completed") {
    return {
      outcome,
      remote_disposition: "proven_terminal",
      lease_disposition: "released",
      retryable: false,
      reason_code: null,
    };
  }
  if (outcome === "remote_unknown") {
    return {
      outcome,
      remote_disposition: "may_continue",
      lease_disposition: "quarantined",
      retryable: false,
      reason_code: reasonCode ?? "remote_upload_unknown",
    };
  }
  return {
    outcome,
    remote_disposition: "proven_not_accepted",
    lease_disposition: "released",
    retryable,
    reason_code: reasonCode ?? "upload_failed",
  };
}

function terminalWithoutArtifacts(
  terminalDisposition: HostOperationDispositionV1
): HostOperationAdapterTerminalV1 {
  return { disposition: terminalDisposition, operation_result_ref: null, output_artifacts: [] };
}

function clientLimits(
  profile: ReturnType<VideogenProfileRegistry["resolve"]>["profile"]
): ComfyClientLimitsV1 {
  return {
    max_request_bytes: profile.limits.max_request_json_bytes,
    max_readiness_bytes: profile.limits.max_history_json_bytes,
    max_inventory_bytes: profile.limits.max_inventory_json_bytes,
    max_history_bytes: profile.limits.max_history_json_bytes,
    max_image_bytes: profile.limits.max_upload_bytes,
    max_upload_bytes: profile.limits.max_upload_bytes,
    max_video_bytes: profile.limits.max_video_bytes,
    connect_timeout_ms: profile.limits.connect_timeout_ms,
    read_timeout_ms: profile.limits.read_timeout_ms,
  };
}

export interface ComfyVideogenUploadAdapterOptionsV1 {
  readonly profiles: VideogenProfileRegistry;
  readonly managed_relay?: ManagedComputeRelay;
  readonly legacy_http?: true;
  readonly client_factory?: (
    endpoint: ReturnType<VideogenProfileRegistry["resolve"]>["profile"]["endpoint"],
    limits: ComfyClientLimitsV1
  ) => ComfyHttpClient;
}

/** Host-only upload of one exact canonical PNG to one registered loopback backend. */
export class ComfyVideogenUploadOperationAdapter implements HostOperationAdapterV1 {
  readonly adapter_id = COMFY_VIDEO_UPLOAD_ADAPTER_ID;
  private readonly clientFactory: NonNullable<
    ComfyVideogenUploadAdapterOptionsV1["client_factory"]
  >;

  constructor(private readonly options: ComfyVideogenUploadAdapterOptionsV1) {
    if (!options.managed_relay && options.legacy_http !== true)
      throw new Error("Comfy upload HTTP requires explicit legacy opt-in without managed binding");
    if (
      options.managed_relay &&
      (!(options.managed_relay instanceof ManagedComputeRelay) || options.client_factory)
    )
      throw new Error("Comfy managed upload binding invalid");
    this.clientFactory =
      options.client_factory ??
      ((endpoint, limits) => new ComfyHttpClient(endpoint, limits, options.managed_relay));
  }

  inspectRequest(input: Parameters<HostOperationAdapterV1["inspectRequest"]>[0]) {
    const request = validateVideoReferenceUploadOperationRequest(
      exactJson(input.request_bytes, "video reference upload operation request")
    );
    const resolved = this.options.profiles.resolve(request.profile_id);
    const slots = input.directive.input_artifacts.artifacts.map((binding) => binding.slot).sort();
    if (
      (request.operation_id !== undefined &&
        request.operation_id !== input.directive.operation_id) ||
      request.run_id !== input.directive.identity.run_id ||
      request.profile_sha256 !== resolved.profile.profile_sha256 ||
      canonicalJson(slots) !== canonicalJson(["canonical_png", "profile_snapshot"]) ||
      !input.directive.input_artifacts.artifacts.some(
        (binding) =>
          binding.slot === "profile_snapshot" && sameRef(binding.ref, request.profile_snapshot_ref)
      ) ||
      !input.directive.input_artifacts.artifacts.some(
        (binding) =>
          binding.slot === "canonical_png" && sameRef(binding.ref, request.canonical_png_ref)
      )
    ) {
      throw new Error("video reference upload operation request binding drifted");
    }
    return {
      schema_version: 1 as const,
      operation_kind: input.directive.operation_kind,
      adapter_id: this.adapter_id,
      backend_binding_id: input.declaration.backend_binding_id,
      backend_key_sha256: resolved.backend_key_sha256,
    };
  }

  async prepare(context: HostOperationExecutionContextV1): Promise<void> {
    await this.options.managed_relay?.prepare(context);
  }
  close(): void {
    this.options.managed_relay?.disconnect();
  }

  async run(context: HostOperationExecutionContextV1): Promise<HostOperationAdapterTerminalV1> {
    const request = validateVideoReferenceUploadOperationRequest(
      exactJson(context.request_bytes, "video reference upload operation request")
    );
    const resolved = this.options.profiles.resolve(request.profile_id);
    if (
      resolved.profile.profile_sha256 !== request.profile_sha256 ||
      resolved.backend_key_sha256 !== context.directive.policy_binding.backend_key_sha256
    ) {
      return terminalWithoutArtifacts(disposition("failed", "profile_drift"));
    }
    if (resolved.profile.mode !== "i2v") {
      return terminalWithoutArtifacts(disposition("failed", "upload_requires_i2v_profile"));
    }
    const snapshotInput = context.readInput("profile_snapshot");
    const pngInput = context.readInput("canonical_png");
    if (
      !sameRef(snapshotInput.ref, request.profile_snapshot_ref) ||
      !sameRef(pngInput.ref, request.canonical_png_ref) ||
      sha256(snapshotInput.bytes) !== snapshotInput.ref.content_digest ||
      snapshotInput.ref.media_type !== "application/json" ||
      snapshotInput.ref.content_schema?.schema_id !== "penny.videogen-profile-snapshot.v1" ||
      snapshotInput.ref.content_schema.schema_version !== 1 ||
      sha256(pngInput.bytes) !== request.canonical_png_sha256 ||
      pngInput.ref.media_type !== "image/png"
    ) {
      return terminalWithoutArtifacts(disposition("failed", "operation_input_drift"));
    }
    const snapshot = validateVideogenProfileSnapshot(
      exactJson(snapshotInput.bytes, "videogen profile snapshot")
    );
    try {
      this.options.profiles.verifySnapshot(snapshot);
    } catch {
      return terminalWithoutArtifacts(disposition("failed", "profile_snapshot_drift"));
    }
    const profile = resolved.profile;
    let canonicalPng: Uint8Array;
    try {
      const sanitized = sanitizePng(pngInput.bytes, {
        ...DEFAULT_PNG_MEDIA_LIMITS,
        maxSourceBytes: Math.min(
          profile.limits.max_upload_bytes,
          HARD_PNG_MEDIA_LIMITS.maxSourceBytes
        ),
      });
      if (sha256(sanitized.bytes) !== sha256(pngInput.bytes)) {
        return terminalWithoutArtifacts(disposition("failed", "input_png_not_canonical"));
      }
      canonicalPng = sanitized.bytes;
    } catch {
      return terminalWithoutArtifacts(disposition("failed", "input_png_invalid"));
    }

    const filename = `${request.canonical_png_sha256}.png`;
    const expectedDescriptor = {
      filename,
      subfolder: profile.input_subfolder,
      type: "input" as const,
    };
    const correlationId = `upload-${request.canonical_png_sha256}`;
    const client = this.clientFactory(profile.endpoint, clientLimits(profile));
    if (context.journal.remote_correlation_id === null) {
      let submissionBegan = false;
      try {
        await client.ready({ signal: context.signal, report_activity: context.reportActivity });
        context.beginSubmission();
        submissionBegan = true;
        const descriptor = await client.uploadImage({
          bytes: canonicalPng,
          filename,
          subfolder: profile.input_subfolder,
          signal: context.signal,
          report_activity: context.reportActivity,
        });
        if (canonicalJson(descriptor) !== canonicalJson(expectedDescriptor)) {
          throw new ComfyClientError(
            "BACKEND_RESPONSE_INVALID",
            "backend upload descriptor drifted",
            "unknown"
          );
        }
        context.recordRemoteAccepted(correlationId);
      } catch (error) {
        if (error instanceof Error && error.name === "HostOperationSimulatedCrashError")
          throw error;
        if (!submissionBegan) {
          if (context.signal.aborted) throw error;
          return terminalWithoutArtifacts(disposition("failed", "upload_readiness_failed", true));
        }
        if (
          error instanceof ComfyClientError &&
          error.submission_disposition === "proven_not_accepted"
        ) {
          return terminalWithoutArtifacts(disposition("failed", "upload_not_accepted", true));
        }
        throw error;
      }
    } else if (context.journal.remote_correlation_id !== correlationId) {
      return terminalWithoutArtifacts(disposition("remote_unknown", "upload_correlation_drift"));
    }

    let fetched: Awaited<ReturnType<ComfyHttpClient["fetchMedia"]>>;
    try {
      fetched = await client.fetchMedia({
        media: expectedDescriptor,
        max_bytes: profile.limits.max_upload_bytes,
        accept: "image/png",
        signal: context.signal,
        report_activity: context.reportActivity,
      });
    } catch {
      if (context.signal.aborted) throw context.signal.reason;
      return terminalWithoutArtifacts(
        disposition("remote_unknown", "uploaded_input_verification_failed")
      );
    }
    if (
      fetched.status < 200 ||
      fetched.status >= 300 ||
      fetched.media_type !== "image/png" ||
      sha256(fetched.bytes) !== request.canonical_png_sha256 ||
      fetched.bytes.byteLength !== canonicalPng.byteLength
    ) {
      return terminalWithoutArtifacts(
        disposition("remote_unknown", "uploaded_input_identity_mismatch")
      );
    }
    await context.cacheResult(fetched.bytes);
    context.recordFetched({
      schema_version: 1,
      content_sha256: request.canonical_png_sha256,
      byte_length: canonicalPng.byteLength,
      item_count: 1,
      poll_count: 1,
    });
    const receipt: VideoReferenceUploadReceiptV1 = validateVideoReferenceUploadReceipt({
      schema_id: "penny.video-reference-upload-receipt.v1",
      schema_version: 1,
      run_id: request.run_id,
      profile_id: request.profile_id,
      profile_sha256: request.profile_sha256,
      canonical_png_ref: request.canonical_png_ref,
      canonical_png_sha256: request.canonical_png_sha256,
      canonical_png_bytes: canonicalPng.byteLength,
      remote_descriptor: expectedDescriptor,
      status: "uploaded_verified",
    });
    const completed = disposition("completed", null);
    const persisted = context.persist({
      disposition: completed,
      operation_result: {
        contract: VIDEO_REFERENCE_UPLOAD_RECEIPT_CONTRACT,
        media_type: "application/json",
        content: canonicalJson(receipt),
      },
    });
    return {
      disposition: completed,
      operation_result_ref: persisted.operation_result_ref,
      output_artifacts: persisted.output_artifacts,
    };
  }
}
