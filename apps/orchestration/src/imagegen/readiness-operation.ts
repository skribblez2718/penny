import { checkImageAssetRun, type ImageAssetAuthority } from "./asset-authority.js";
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
  validateImagegenProfileSnapshot,
  validateImagegenReadinessReceipt,
  validateImagegenReadinessRequest,
} from "../skill-contracts/imagegen.js";
import type { ImagegenProfileRegistry } from "./types.js";
import { ComfyHttpClient, type ComfyClientLimitsV1 } from "./comfy-client.js";

export const COMFY_IMAGEGEN_READINESS_OPERATION_KIND = "imagegen.comfyui-readiness.v1" as const;
export const COMFY_IMAGEGEN_READINESS_ADAPTER_ID = "imagegen.comfyui-readiness-adapter.v1" as const;

export const IMAGEGEN_READINESS_REQUEST_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "readiness_request",
  artifact_kind: "imagegen-readiness-request",
  schema_id: "penny.imagegen-readiness-request.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export const IMAGEGEN_READINESS_RECEIPT_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "readiness_receipt",
  artifact_kind: "imagegen-readiness-receipt",
  schema_id: "penny.imagegen-readiness-receipt.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export function createComfyImagegenReadinessDeclaration(input: {
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
    operation_kind: COMFY_IMAGEGEN_READINESS_OPERATION_KIND,
    adapter_id: COMFY_IMAGEGEN_READINESS_ADAPTER_ID,
    request: IMAGEGEN_READINESS_REQUEST_CONTRACT,
    result: IMAGEGEN_READINESS_RECEIPT_CONTRACT,
    backend_binding_id: input.backend_binding_id,
    capability_classes: ["artifact_store", "registered_loopback_http"],
    lease_profile: {
      ...leaseBody,
      profile_sha256: hostOperationLeaseProfileSha256(leaseBody),
    },
    operation_inactivity_ms: input.operation_inactivity_ms,
    max_request_bytes: input.max_request_bytes,
    max_input_artifacts: 1,
    max_input_bytes: input.max_input_bytes,
    max_output_artifacts: 1,
    max_output_bytes: input.max_output_bytes,
    max_progress_events: input.max_progress_events,
    max_pre_acceptance_retries: 1,
    recovery_semantics: "disposable_v1",
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

function completedDisposition(): HostOperationDispositionV1 {
  return {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  };
}

function failedDisposition(reasonCode: string): HostOperationDispositionV1 {
  return {
    outcome: "failed",
    remote_disposition: "proven_not_accepted",
    lease_disposition: "released",
    retryable: true,
    reason_code: reasonCode,
  };
}

function terminalWithoutArtifacts(
  disposition: HostOperationDispositionV1
): HostOperationAdapterTerminalV1 {
  return { disposition, operation_result_ref: null, output_artifacts: [] };
}

export interface ComfyImagegenReadinessAdapterOptionsV1 {
  readonly profiles: ImagegenProfileRegistry;
  readonly assets?: ImageAssetAuthority;
  /** Required when the host owner enforces its durable result cache. */
  readonly cache_results?: boolean;
  readonly client_factory?: (
    endpoint: ReturnType<ImagegenProfileRegistry["resolve"]>["profile"]["endpoint"],
    limits: ComfyClientLimitsV1
  ) => ComfyHttpClient;
}

/** Host-only readiness adapter. It performs no remote submission and records any approved fallback. */
export class ComfyImagegenReadinessAdapter implements HostOperationAdapterV1 {
  readonly adapter_id = COMFY_IMAGEGEN_READINESS_ADAPTER_ID;
  private readonly clientFactory: NonNullable<
    ComfyImagegenReadinessAdapterOptionsV1["client_factory"]
  >;

  private readonly options: ComfyImagegenReadinessAdapterOptionsV1;
  constructor(options: ComfyImagegenReadinessAdapterOptionsV1) {
    this.options = Object.freeze({ ...options });
    this.clientFactory =
      options.client_factory ?? ((endpoint, limits) => new ComfyHttpClient(endpoint, limits));
  }

  inspectRequest(input: Parameters<HostOperationAdapterV1["inspectRequest"]>[0]) {
    const request = validateImagegenReadinessRequest(
      exactJson(input.request_bytes, "imagegen readiness request")
    );
    const resolved = this.options.profiles.resolve(request.profile_id);
    if (this.options.assets !== undefined)
      checkImageAssetRun(
        this.options.assets,
        input.directive.identity.run_id,
        resolved.profile.profile_sha256
      );
    if (
      request.profile_sha256 !== resolved.profile.profile_sha256 ||
      input.directive.input_artifacts.artifacts.length !== 1 ||
      !input.directive.input_artifacts.artifacts.some(
        (binding) =>
          binding.slot === "profile_snapshot" && sameRef(binding.ref, request.profile_snapshot_ref)
      )
    ) {
      throw new Error("imagegen readiness request binding drifted");
    }
    return {
      schema_version: 1 as const,
      operation_kind: input.directive.operation_kind,
      adapter_id: this.adapter_id,
      backend_binding_id: input.declaration.backend_binding_id,
      backend_key_sha256: resolved.backend_key_sha256,
    };
  }

  async run(context: HostOperationExecutionContextV1): Promise<HostOperationAdapterTerminalV1> {
    const request = validateImagegenReadinessRequest(
      exactJson(context.request_bytes, "imagegen readiness request")
    );
    const resolved = this.options.profiles.resolve(request.profile_id);
    const snapshotInput = context.readInput("profile_snapshot");
    if (
      resolved.profile.profile_sha256 !== request.profile_sha256 ||
      resolved.backend_key_sha256 !== context.directive.policy_binding.backend_key_sha256 ||
      !sameRef(snapshotInput.ref, request.profile_snapshot_ref) ||
      sha256(snapshotInput.bytes) !== snapshotInput.ref.content_digest
    ) {
      return terminalWithoutArtifacts(failedDisposition("readiness_input_drift"));
    }
    const snapshot = validateImagegenProfileSnapshot(
      exactJson(snapshotInput.bytes, "imagegen profile snapshot")
    );
    if (canonicalJson(snapshot) !== canonicalJson(resolved.snapshot)) {
      return terminalWithoutArtifacts(failedDisposition("profile_drift"));
    }

    const checkAsset = () => {
      if (this.options.assets !== undefined)
        checkImageAssetRun(
          this.options.assets,
          context.directive.identity.run_id,
          resolved.profile.profile_sha256
        );
      else if (resolved.profile.revision_capability !== undefined)
        throw new Error("revision readiness requires concrete asset authority");
    };
    checkAsset();
    try {
      const profile = resolved.profile;
      const client = this.clientFactory(profile.endpoint, clientLimits(profile));
      context.beginSubmission();
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
      const missingClasses = profile.required_inventory.class_types.filter(
        (classType) => !inventory.class_types.has(classType)
      );
      const missingModels = profile.required_inventory.model_ids.filter(
        (modelId) => !inventory.scalar_strings.has(modelId)
      );
      const primaryReady =
        inventory.sha256 === profile.required_inventory.object_info_sha256 &&
        missingClasses.length === 0 &&
        missingModels.length === 0;
      const fallback = profile.fallback;
      const fallbackReady =
        !primaryReady &&
        fallback !== null &&
        inventory.sha256 === fallback.object_info_sha256 &&
        missingClasses.length === 0 &&
        missingModels.length > 0 &&
        missingModels.every((modelId) => fallback.when_model_ids_absent.includes(modelId)) &&
        fallback.required_model_ids.every((modelId) => inventory.scalar_strings.has(modelId));
      if (!primaryReady && !fallbackReady) {
        return terminalWithoutArtifacts(failedDisposition("backend_inventory_drift"));
      }
      const receipt = validateImagegenReadinessReceipt({
        schema_id: "penny.imagegen-readiness-receipt.v1",
        schema_version: 1,
        status: "ready",
        profile_id: request.profile_id,
        profile_sha256: request.profile_sha256,
        profile_snapshot_ref: request.profile_snapshot_ref,
        inventory_sha256: inventory.sha256,
        fallback_disposition: fallbackReady
          ? { status: "applied", fallback_id: fallback.fallback_id }
          : { status: "not_applied" },
      });
      const receiptContent = canonicalJson(receipt);
      if (this.options.cache_results === true)
        await context.cacheResult(Buffer.from(receiptContent));
      checkAsset();
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(receiptContent),
        byte_length: Buffer.byteLength(receiptContent, "utf8"),
        item_count: 1,
        poll_count: 1,
      });
      const disposition = completedDisposition();
      const persisted = context.persist({
        disposition,
        operation_result: {
          contract: IMAGEGEN_READINESS_RECEIPT_CONTRACT,
          media_type: "application/json",
          content: receiptContent,
        },
      });
      return {
        disposition,
        operation_result_ref: persisted.operation_result_ref,
        output_artifacts: persisted.output_artifacts,
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return terminalWithoutArtifacts(failedDisposition("readiness_failed"));
    }
  }
}
