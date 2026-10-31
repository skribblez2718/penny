import {
  checkImageAsset,
  imageAssetMedia,
  verifyImageAssetUpload,
  type ImageAssetAuthority,
} from "./asset-authority.js";
import { backendMask, compositeRevision, referenceOperands } from "./reference-media.js";
import { ImageRevisionTransformationV1Schema } from "./reference-contracts.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { TextDecoder } from "node:util";

import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, HostOperationArtifactContractV1 } from "../contracts.js";
import {
  hostOperationLeaseProfileSha256,
  type HostOperationAdapterTerminalV1,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
  type HostOperationDispositionV1,
  type HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import {
  DEFAULT_PNG_MEDIA_LIMITS,
  HARD_PNG_MEDIA_LIMITS,
  PngMediaError,
  sanitizePng,
  type PngMediaLimits,
} from "../png-media.js";
import {
  validateImageGenerationOperationReceipt,
  validateImageGenerationOperationRequest,
  validateImageSubmittedGraph,
  validateImageValidationReceipt,
  validateImagegenProfileSnapshot,
  type ImageGenerationOperationReceiptV1,
  type ImageGenerationOperationRequestV1,
  type ImageValidationReceiptV1,
} from "../skill-contracts/imagegen.js";
import type { ImagegenProfileRegistry, ImagegenStorageAdmission } from "./types.js";
import { assertImageSubmittedGraphMatchesProfile } from "./graph-builder.js";
import { ComfyClientError, ComfyHttpClient, type ComfyClientLimitsV1 } from "./comfy-client.js";

export const COMFY_IMAGEGEN_OPERATION_KIND = "imagegen.comfyui-generate.v1" as const;
export const COMFY_IMAGEGEN_ADAPTER_ID = "imagegen.comfyui-adapter.v1" as const;

export const IMAGE_GENERATION_OPERATION_REQUEST_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "generation_request",
  artifact_kind: "image-generation-operation-request",
  schema_id: "penny.image-generation-operation-request.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export const IMAGE_GENERATION_OPERATION_RECEIPT_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "generation_receipt",
  artifact_kind: "image-generation-operation-receipt",
  schema_id: "penny.image-generation-operation-receipt.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export const IMAGE_VALIDATION_RECEIPT_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "validation_receipt",
  artifact_kind: "image-validation-receipt",
  schema_id: "penny.image-validation-receipt.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export const IMAGE_RAW_RESULT_CONTRACT = {
  schema_version: 1,
  port_name: "raw_result",
  artifact_kind: "image-raw-result",
  schema_id: "penny.image-raw-result.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1;
export const IMAGE_REVISION_TRANSFORMATION_CONTRACT = {
  schema_version: 1,
  port_name: "revision_transformation",
  artifact_kind: "image-revision-transformation",
  schema_id: "penny.image-revision-transformation.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1;

export const GENERATED_IMAGE_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "generated_image",
  artifact_kind: "generated-image",
  schema_id: "penny.generated-image.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export function createComfyImagegenDeclaration(input: {
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
    operation_kind: COMFY_IMAGEGEN_OPERATION_KIND,
    adapter_id: COMFY_IMAGEGEN_ADAPTER_ID,
    request: IMAGE_GENERATION_OPERATION_REQUEST_CONTRACT,
    result: IMAGE_GENERATION_OPERATION_RECEIPT_CONTRACT,
    backend_binding_id: input.backend_binding_id,
    capability_classes: ["artifact_store", "registered_loopback_http"],
    lease_profile: {
      ...leaseBody,
      profile_sha256: hostOperationLeaseProfileSha256(leaseBody),
    },
    operation_inactivity_ms: input.operation_inactivity_ms,
    max_request_bytes: input.max_request_bytes,
    max_input_artifacts: 8,
    max_input_bytes: input.max_input_bytes,
    output_contracts: [
      IMAGE_VALIDATION_RECEIPT_CONTRACT,
      GENERATED_IMAGE_CONTRACT,
      IMAGE_RAW_RESULT_CONTRACT,
      IMAGE_REVISION_TRANSFORMATION_CONTRACT,
    ],
    max_output_artifacts: 5,
    max_output_bytes: input.max_output_bytes,
    max_progress_events: input.max_progress_events,
    max_pre_acceptance_retries: 1,
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

function releasedFailure(reasonCode: string, retryable: boolean): HostOperationDispositionV1 {
  return {
    outcome: "failed",
    remote_disposition: "proven_not_accepted",
    lease_disposition: "released",
    retryable,
    reason_code: reasonCode,
  };
}

function terminalRemoteFailure(reasonCode: string): HostOperationDispositionV1 {
  return {
    outcome: "failed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: reasonCode,
  };
}

function remoteUnknown(reasonCode: string): HostOperationDispositionV1 {
  return {
    outcome: "remote_unknown",
    remote_disposition: "may_continue",
    lease_disposition: "quarantined",
    retryable: false,
    reason_code: reasonCode,
  };
}

function cancelledAfterTerminalDisposition(): HostOperationDispositionV1 {
  return {
    outcome: "cancelled",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: "cancelled_after_remote_terminal",
  };
}

function completedDisposition(): HostOperationDispositionV1 {
  return {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  };
}

function pngLimits(
  request: ImageGenerationOperationRequestV1,
  maxImageBytes: number,
  maxPixels: number
): PngMediaLimits {
  const decompressed = request.dimensions.height * (request.dimensions.width * 4 + 1);
  return {
    ...DEFAULT_PNG_MEDIA_LIMITS,
    maxSourceBytes: Math.min(maxImageBytes, HARD_PNG_MEDIA_LIMITS.maxSourceBytes),
    maxWidth: request.dimensions.width,
    maxHeight: request.dimensions.height,
    maxPixels: Math.min(maxPixels, HARD_PNG_MEDIA_LIMITS.maxPixels),
    maxCompressedBytes: Math.min(maxImageBytes, HARD_PNG_MEDIA_LIMITS.maxCompressedBytes),
    maxDecompressedBytes: Math.min(
      Math.max(1, decompressed),
      HARD_PNG_MEDIA_LIMITS.maxDecompressedBytes
    ),
  };
}

function clientLimits(
  profile: ReturnType<ImagegenProfileRegistry["resolve"]>["profile"]
): ComfyClientLimitsV1 {
  return {
    max_request_bytes: profile.limits.max_request_json_bytes,
    max_readiness_bytes: profile.limits.max_history_json_bytes,
    max_inventory_bytes: profile.limits.max_inventory_json_bytes,
    max_history_bytes: profile.limits.max_history_json_bytes,
    max_image_bytes: profile.limits.max_image_bytes,
    connect_timeout_ms: profile.limits.connect_timeout_ms,
    read_timeout_ms: profile.limits.read_timeout_ms,
  };
}

async function waitForPoll(signal: AbortSignal, intervalMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let completed = false;
    const finish = (): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
  if (signal.aborted) throw signal.reason;
}

function terminalWithoutArtifacts(
  disposition: HostOperationDispositionV1
): HostOperationAdapterTerminalV1 {
  return { disposition, operation_result_ref: null, output_artifacts: [] };
}

export interface ComfyImagegenAdapterOptionsV1 {
  readonly profiles: ImagegenProfileRegistry;
  readonly storage: ImagegenStorageAdmission;
  readonly assets?: ImageAssetAuthority;
  readonly cache_results?: boolean;
  readonly client_factory?: (
    endpoint: ReturnType<ImagegenProfileRegistry["resolve"]>["profile"]["endpoint"],
    limits: ComfyClientLimitsV1
  ) => ComfyHttpClient;
}

/** Host-only registered adapter for one exact prepared graph and one PNG output. */
export class ComfyImagegenOperationAdapter implements HostOperationAdapterV1 {
  readonly adapter_id = COMFY_IMAGEGEN_ADAPTER_ID;
  private readonly clientFactory: NonNullable<ComfyImagegenAdapterOptionsV1["client_factory"]>;

  private readonly options: ComfyImagegenAdapterOptionsV1;
  constructor(options: ComfyImagegenAdapterOptionsV1) {
    this.options = Object.freeze({ ...options });
    this.clientFactory =
      options.client_factory ?? ((endpoint, limits) => new ComfyHttpClient(endpoint, limits));
  }

  inspectRequest(input: Parameters<HostOperationAdapterV1["inspectRequest"]>[0]) {
    const request = validateImageGenerationOperationRequest(
      exactJson(input.request_bytes, "image generation operation request")
    );
    const resolved = this.options.profiles.resolve(request.profile_id);
    if (
      request.profile_sha256 !== resolved.profile.profile_sha256 ||
      input.directive.input_artifacts.artifacts.length !==
        2 + (request.reference === undefined ? 0 : referenceOperands(request.reference).length) ||
      !input.directive.input_artifacts.artifacts.some(
        (binding) =>
          binding.slot === "profile_snapshot" && sameRef(binding.ref, request.profile_snapshot_ref)
      ) ||
      !input.directive.input_artifacts.artifacts.some(
        (binding) =>
          binding.slot === "submitted_graph" && sameRef(binding.ref, request.submitted_graph_ref)
      )
    ) {
      throw new Error("image generation operation request binding drifted");
    }
    if (request.run_id !== input.directive.identity.run_id)
      throw new Error("generation run binding mismatch");
    if (request.asset !== undefined) {
      if (this.options.assets === undefined || request.max_renders === undefined)
        throw new Error("current asset authority missing");
      checkImageAsset(
        this.options.assets,
        request.asset,
        request.run_id,
        resolved.profile.profile_sha256,
        request.max_renders
      );
    }
    if (
      request.reference !== undefined &&
      canonicalJson(request.reference.asset) !== canonicalJson(request.asset)
    )
      throw new Error("generation reference asset mismatch");
    return {
      schema_version: 1 as const,
      operation_kind: input.directive.operation_kind,
      adapter_id: this.adapter_id,
      backend_binding_id: input.declaration.backend_binding_id,
      backend_key_sha256: resolved.backend_key_sha256,
    };
  }

  async run(context: HostOperationExecutionContextV1): Promise<HostOperationAdapterTerminalV1> {
    const request = validateImageGenerationOperationRequest(
      exactJson(context.request_bytes, "image generation operation request")
    );
    const resolved = this.options.profiles.resolve(request.profile_id);
    if (
      resolved.profile.profile_sha256 !== request.profile_sha256 ||
      resolved.backend_key_sha256 !== context.directive.policy_binding.backend_key_sha256
    ) {
      return terminalWithoutArtifacts(releasedFailure("profile_drift", false));
    }
    const snapshotInput = context.readInput("profile_snapshot");
    const graphInput = context.readInput("submitted_graph");
    if (
      !sameRef(snapshotInput.ref, request.profile_snapshot_ref) ||
      !sameRef(graphInput.ref, request.submitted_graph_ref) ||
      sha256(snapshotInput.bytes) !== snapshotInput.ref.content_digest ||
      sha256(graphInput.bytes) !== request.submitted_graph_sha256
    ) {
      return terminalWithoutArtifacts(releasedFailure("operation_input_drift", false));
    }
    const snapshot = validateImagegenProfileSnapshot(
      exactJson(snapshotInput.bytes, "imagegen profile snapshot")
    );
    const submitted = validateImageSubmittedGraph(
      exactJson(graphInput.bytes, "imagegen submitted graph")
    );
    if (
      canonicalJson(snapshot) !== canonicalJson(resolved.snapshot) ||
      submitted.profile_sha256 !== request.profile_sha256 ||
      !sameRef(submitted.profile_snapshot_ref, request.profile_snapshot_ref) ||
      submitted.slot !== request.slot ||
      submitted.revision !== request.revision ||
      submitted.effective_seed !== request.effective_seed ||
      canonicalJson(submitted.dimensions) !== canonicalJson(request.dimensions)
    ) {
      return terminalWithoutArtifacts(releasedFailure("prepared_graph_drift", false));
    }
    // Validate before constructing any transport, including on durable prompt recovery. Throwing
    // leaves lifecycle-aware failure/quarantine classification with the existing operation owner.
    assertImageSubmittedGraphMatchesProfile({
      profile_snapshot: snapshot,
      submitted_graph: submitted,
    });
    const profile = resolved.profile;
    const assetAuthority = this.options.assets;
    const checkAsset = () => {
      if (request.asset !== undefined) {
        if (
          assetAuthority === undefined ||
          request.max_renders === undefined ||
          request.slot !== 0 ||
          request.revision >= request.max_renders
        )
          throw new Error("asset call ceiling or authority missing");
        checkImageAsset(
          assetAuthority,
          request.asset,
          request.run_id,
          profile.profile_sha256,
          request.max_renders
        );
      }
    };
    checkAsset();
    let referenceMedia: ReturnType<ImageAssetAuthority["media"]> | undefined;
    if (request.reference !== undefined) {
      if (
        assetAuthority === undefined ||
        request.asset === undefined ||
        canonicalJson(request.reference) !== canonicalJson(submitted.reference)
      )
        throw new Error("revision asset binding missing");
      referenceMedia = imageAssetMedia(assetAuthority, request.asset);
      const r = request.reference,
        c = profile.revision_capability;
      if (
        c === undefined ||
        r.source_ref.content_digest !== sha256(referenceMedia.source) ||
        (referenceMedia.mask === null) !== (r.edit_mask_ref === null) ||
        (referenceMedia.mask !== null &&
          r.edit_mask_ref?.content_digest !== sha256(referenceMedia.mask))
      )
        throw new Error("revision canonical mask mismatch");
      if (
        referenceMedia.mask !== null &&
        (c.backend_mask_polarity === null ||
          r.backend_mask_ref?.content_digest !==
            sha256(backendMask(referenceMedia.mask, c.backend_mask_polarity)))
      )
        throw new Error("backend mask polarity drift");
      for (const ref of referenceOperands(r))
        if (!context.directive.input_artifacts.artifacts.some((x) => sameRef(x.ref, ref)))
          throw new Error("missing exact revision operand");
      for (const [index, ref] of r.uploads.entries()) {
        const u = verifyImageAssetUpload(
          assetAuthority,
          ref,
          request.run_id,
          resolved.backend_key_sha256
        );
        const png = index === 0 ? r.source_ref : r.backend_mask_ref;
        if (
          png === null ||
          png === undefined ||
          !sameRef(u.request.png_ref, png) ||
          canonicalJson(u.request.asset) !== canonicalJson(request.asset) ||
          u.request.profile_id !== request.profile_id ||
          !sameRef(u.request.profile_snapshot_ref, request.profile_snapshot_ref) ||
          u.request.role !== (index === 0 ? "source" : "mask") ||
          u.verified_sha256 !== png.content_digest ||
          u.locator.filename !== `${png.content_digest}.png` ||
          u.locator.subfolder !== c.input_subfolder
        )
          throw new Error("revision upload role/locator/lineage drift");
      }
      await context.readCachedResult();
    } else if (profile.revision_capability !== undefined || submitted.reference !== undefined)
      throw new Error("revision profile requires exact source input binding");
    checkAsset();
    const client = this.clientFactory(profile.endpoint, clientLimits(profile));
    let promptId = context.journal.remote_correlation_id;
    let pollCount = context.journal.fetched?.poll_count ?? 0;

    if (promptId === null) {
      let submissionBegan = false;
      try {
        await client.ready({
          signal: context.signal,
          report_activity: context.reportActivity,
        });
        checkAsset();
        const inventory = await client.inventory({
          signal: context.signal,
          report_activity: context.reportActivity,
        });
        checkAsset();
        const fallbackApplied = submitted.fallback_disposition.status === "applied";
        const expectedInventorySha =
          fallbackApplied && profile.fallback !== null
            ? profile.fallback.object_info_sha256
            : profile.required_inventory.object_info_sha256;
        const missingClasses = profile.required_inventory.class_types.filter(
          (classType) => !inventory.class_types.has(classType)
        );
        const missingModels = profile.required_inventory.model_ids.filter(
          (modelId) => !inventory.scalar_strings.has(modelId)
        );
        const fallbackModels = profile.fallback?.when_model_ids_absent ?? [];
        const fallbackValid =
          fallbackApplied &&
          profile.fallback !== null &&
          missingClasses.length === 0 &&
          missingModels.length > 0 &&
          missingModels.every((modelId) => fallbackModels.includes(modelId)) &&
          profile.fallback.required_model_ids.every((modelId) =>
            inventory.scalar_strings.has(modelId)
          );
        if (
          inventory.sha256 !== expectedInventorySha ||
          missingClasses.length > 0 ||
          (!fallbackApplied && missingModels.length > 0) ||
          (fallbackApplied && !fallbackValid)
        ) {
          return terminalWithoutArtifacts(releasedFailure("backend_inventory_drift", false));
        }
        if (request.reference !== undefined) {
          if (assetAuthority === undefined) throw new Error("asset authority missing");
          for (const ref of request.reference.uploads) {
            const u = verifyImageAssetUpload(
              assetAuthority,
              ref,
              request.run_id,
              resolved.backend_key_sha256
            );
            checkAsset();
            const readback = await client.fetchMedia({
              media: u.locator,
              max_bytes: profile.limits.max_image_bytes,
              accept: "image/png",
              signal: context.signal,
              report_activity: context.reportActivity,
            });
            if (
              readback.status !== 200 ||
              readback.media_type !== "image/png" ||
              readback.bytes.byteLength !== u.request.png_ref.byte_length ||
              sha256(readback.bytes) !== u.verified_sha256
            )
              throw new Error("original remote input changed before submit");
          }
        }
        checkAsset();
        context.beginSubmission();
        submissionBegan = true;
        try {
          promptId = await client.submit({
            graph: submitted.graph,
            client_id: context.directive.operation_id,
            signal: context.signal,
            report_activity: context.reportActivity,
          });
        } catch (error) {
          if (
            error instanceof ComfyClientError &&
            error.submission_disposition === "proven_not_accepted"
          ) {
            return terminalWithoutArtifacts(releasedFailure("submission_not_accepted", true));
          }
          throw error;
        }
        context.recordRemoteAccepted(promptId);
      } catch (error) {
        if (error instanceof Error && error.name === "HostOperationSimulatedCrashError") {
          throw error;
        }
        if (!submissionBegan) {
          if (context.signal.aborted) throw error;
          const reason =
            error instanceof ComfyClientError && error.code === "BACKEND_TIMEOUT"
              ? "readiness_timeout"
              : "readiness_failed";
          return terminalWithoutArtifacts(releasedFailure(reason, true));
        }
        throw error;
      }
    }

    checkAsset();
    if (promptId === null) throw new Error("accepted image generation lacks its prompt ID");
    let descriptor: Awaited<ReturnType<ComfyHttpClient["history"]>> | undefined;
    let transientFailures = 0;
    if (context.journal.lifecycle === "fetched") {
      // The fetched milestone is immutable. Recovery performs one bounded history re-read only to
      // reconstruct the backend image descriptor, preserving the original durable poll count so
      // recordFetched can prove that the re-fetched bytes are the exact prior output.
      try {
        checkAsset();
        descriptor = await client.history({
          prompt_id: promptId,
          output_node_id: profile.mutations.output_node_id,
          signal: context.signal,
          report_activity: context.reportActivity,
        });
      } catch (error) {
        if (context.signal.aborted) throw error;
        return terminalWithoutArtifacts(terminalRemoteFailure("recovery_history_unavailable"));
      }
      if (descriptor.state !== "completed") {
        return terminalWithoutArtifacts(
          terminalRemoteFailure(
            descriptor.state === "failed" ? descriptor.reason_code : "recovery_history_incomplete"
          )
        );
      }
    } else {
      while (pollCount < profile.limits.max_poll_attempts) {
        if (context.signal.aborted) throw context.signal.reason;
        pollCount += 1;
        try {
          checkAsset();
          descriptor = await client.history({
            prompt_id: promptId,
            output_node_id: profile.mutations.output_node_id,
            signal: context.signal,
            report_activity: context.reportActivity,
          });
          transientFailures = 0;
        } catch (error) {
          if (context.signal.aborted) throw error;
          transientFailures += 1;
          if (transientFailures > profile.limits.max_transient_poll_failures) {
            return terminalWithoutArtifacts(remoteUnknown("polling_outcome_unknown"));
          }
          await waitForPoll(context.signal, profile.limits.poll_interval_ms);
          continue;
        }
        if (descriptor.state === "pending") {
          await waitForPoll(context.signal, profile.limits.poll_interval_ms);
          continue;
        }
        if (descriptor.state === "failed") {
          return terminalWithoutArtifacts(terminalRemoteFailure(descriptor.reason_code));
        }
        break;
      }
    }
    if (descriptor?.state !== "completed") {
      return terminalWithoutArtifacts(remoteUnknown("polling_exhausted_without_terminal_state"));
    }

    let fetched: Awaited<ReturnType<ComfyHttpClient["fetchImage"]>>;
    try {
      checkAsset();
      fetched = await client.fetchImage({
        image: descriptor.image,
        signal: context.signal,
        report_activity: context.reportActivity,
      });
    } catch {
      if (context.signal.aborted) {
        return terminalWithoutArtifacts(cancelledAfterTerminalDisposition());
      }
      return terminalWithoutArtifacts(terminalRemoteFailure("terminal_image_fetch_failed"));
    }
    if (fetched.status < 200 || fetched.status >= 300) {
      return terminalWithoutArtifacts(terminalRemoteFailure("terminal_image_fetch_unavailable"));
    }
    checkAsset();
    const rawSha256 = sha256(fetched.bytes);
    let fetchedIdentity: Uint8Array = fetched.bytes;
    if (request.reference !== undefined) {
      fetchedIdentity = Buffer.from(
        canonicalJson({
          schema_id: "penny.image-revision-cache.v1",
          schema_version: 1,
          request_sha256: context.directive.request_sha256,
          prompt_id_sha256: sha256(promptId),
          descriptor: descriptor.image,
          media_type: fetched.media_type,
          raw_sha256: rawSha256,
          raw_base64: Buffer.from(fetched.bytes).toString("base64"),
        })
      );
      const cached = await context.readCachedResult();
      if (
        context.journal.lifecycle === "fetched" &&
        (cached === null || !Buffer.from(cached.bytes).equals(Buffer.from(fetchedIdentity)))
      )
        throw new Error("revision recovery original descriptor/bytes drift");
      this.options.storage.commit({
        reservation_id: request.reservation_id,
        commit_key: `revision-cache-${request.slot}-${request.revision}`,
        byte_length: 2 * fetchedIdentity.byteLength + 1024,
      });
      await context.cacheResult(fetchedIdentity);
    } else if (this.options.cache_results === true) await context.cacheResult(fetched.bytes);
    checkAsset();
    context.recordFetched({
      schema_version: 1,
      content_sha256: sha256(fetchedIdentity),
      byte_length: fetchedIdentity.byteLength,
      item_count: 1,
      poll_count: pollCount,
    });

    let validation: ImageValidationReceiptV1;
    let canonicalImage: Uint8Array | undefined;
    let transformation:
      | ReturnType<typeof validateSkillSchema<typeof ImageRevisionTransformationV1Schema>>
      | undefined;
    if (fetched.media_type !== "image/png") {
      validation = validateImageValidationReceipt({
        schema_id: "penny.image-validation-receipt.v1",
        schema_version: 1,
        slot: request.slot,
        revision: request.revision,
        status: "invalid",
        response_status: fetched.status,
        response_media_type: fetched.media_type ?? "missing",
        raw_sha256: rawSha256,
        raw_byte_length: fetched.bytes.byteLength,
        canonical_sha256: null,
        canonical_byte_length: null,
        dimensions: null,
        decoder: "penny.png-media.v1",
        reason_code: "wrong_media_type",
      });
    } else {
      try {
        const sanitized = sanitizePng(
          fetched.bytes,
          pngLimits(request, profile.limits.max_image_bytes, profile.limits.max_pixels)
        );
        if (
          sanitized.info.width !== request.dimensions.width ||
          sanitized.info.height !== request.dimensions.height
        ) {
          throw new Error("generated image dimensions differ from the exact request");
        }
        canonicalImage = sanitized.bytes;
        if (request.reference !== undefined) {
          if (referenceMedia === undefined) throw new Error("revision original media missing");
          const final = compositeRevision(
            referenceMedia.source,
            sanitized.bytes,
            referenceMedia.mask
          );
          canonicalImage = final.bytes;
          transformation = validateSkillSchema(
            ImageRevisionTransformationV1Schema,
            {
              schema_id: "penny.image-revision-transformation.v1",
              schema_version: 1,
              binding: request.reference,
              method: referenceMedia.mask === null ? "img2img" : "inpaint",
              raw_sha256: rawSha256,
              final_sha256: sha256(final.bytes),
              descriptor_sha256: sha256(canonicalJson(descriptor.image)),
              outside_pixels_verified: final.outside,
              preservation: referenceMedia.mask === null ? "semantic_review" : "exact_outside",
            },
            "revision transformation"
          );
        }
        validation = validateImageValidationReceipt({
          schema_id: "penny.image-validation-receipt.v1",
          schema_version: 1,
          slot: request.slot,
          revision: request.revision,
          status: "valid",
          response_status: fetched.status,
          response_media_type: "image/png",
          raw_sha256: rawSha256,
          raw_byte_length: fetched.bytes.byteLength,
          canonical_sha256: sha256(canonicalImage),
          canonical_byte_length: canonicalImage.byteLength,
          dimensions: { width: sanitized.info.width, height: sanitized.info.height },
          decoder: "penny.png-media.v1",
          reason_code: null,
        });
      } catch (error) {
        canonicalImage = undefined;
        transformation = undefined;
        validation = validateImageValidationReceipt({
          schema_id: "penny.image-validation-receipt.v1",
          schema_version: 1,
          slot: request.slot,
          revision: request.revision,
          status: "invalid",
          response_status: fetched.status,
          response_media_type: "image/png",
          raw_sha256: rawSha256,
          raw_byte_length: fetched.bytes.byteLength,
          canonical_sha256: null,
          canonical_byte_length: null,
          dimensions: null,
          decoder: "penny.png-media.v1",
          reason_code:
            error instanceof PngMediaError ? "png_decode_refused" : "image_policy_mismatch",
        });
      }
    }

    if (request.reference !== undefined) {
      this.options.storage.commit({
        reservation_id: request.reservation_id,
        commit_key: `raw-result-${request.slot}-${request.revision}`,
        byte_length: fetched.bytes.byteLength,
      });
    }
    if (transformation !== undefined)
      this.options.storage.commit({
        reservation_id: request.reservation_id,
        commit_key: `revision-transform-${request.slot}-${request.revision}`,
        byte_length: Buffer.byteLength(canonicalJson(transformation)),
      });
    const imageBytes = canonicalImage?.byteLength ?? 0;
    const storageCommit = this.options.storage.commit({
      reservation_id: request.reservation_id,
      commit_key: `generated-image-${request.slot}-${request.revision}`,
      byte_length: imageBytes,
    });
    const receipt: ImageGenerationOperationReceiptV1 = validateImageGenerationOperationReceipt({
      schema_id: "penny.image-generation-operation-receipt.v1",
      schema_version: 1,
      run_id: request.run_id,
      reservation_id: request.reservation_id,
      profile_sha256: request.profile_sha256,
      submitted_graph_ref: request.submitted_graph_ref,
      slot: request.slot,
      revision: request.revision,
      effective_seed: request.effective_seed,
      status: canonicalImage === undefined ? "downloaded_invalid" : "persisted",
      prompt_id_sha256: sha256(promptId),
      poll_count: pollCount,
      validation,
      storage_commit_id: storageCommit.commit_id,
    });
    const validationContent = canonicalJson(validation);
    const receiptContent = canonicalJson(receipt);
    this.options.storage.commit({
      reservation_id: request.reservation_id,
      commit_key: `validation-receipt-${request.slot}-${request.revision}`,
      byte_length: Buffer.byteLength(validationContent, "utf8"),
    });
    this.options.storage.commit({
      reservation_id: request.reservation_id,
      commit_key: `generation-receipt-${request.slot}-${request.revision}`,
      byte_length: Buffer.byteLength(receiptContent, "utf8"),
    });
    const disposition =
      canonicalImage === undefined
        ? terminalRemoteFailure("downloaded_invalid")
        : completedDisposition();
    checkAsset();
    const persisted = context.persist({
      disposition,
      operation_result: {
        contract: IMAGE_GENERATION_OPERATION_RECEIPT_CONTRACT,
        media_type: "application/json",
        content: receiptContent,
      },
      outputs: [
        ...(request.reference === undefined
          ? []
          : [
              {
                contract: IMAGE_RAW_RESULT_CONTRACT,
                media_type: "application/octet-stream",
                content: fetched.bytes,
              },
            ]),
        ...(transformation === undefined
          ? []
          : [
              {
                contract: IMAGE_REVISION_TRANSFORMATION_CONTRACT,
                media_type: "application/json",
                content: canonicalJson(transformation),
              },
            ]),
        {
          contract: IMAGE_VALIDATION_RECEIPT_CONTRACT,
          media_type: "application/json",
          content: validationContent,
        },
        ...(canonicalImage === undefined
          ? []
          : [
              {
                contract: GENERATED_IMAGE_CONTRACT,
                media_type: "image/png",
                content: canonicalImage,
              },
            ]),
      ],
    });
    return {
      disposition,
      operation_result_ref: persisted.operation_result_ref,
      output_artifacts: persisted.output_artifacts,
    };
  }
}
