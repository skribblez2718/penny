import { canonicalJson, sha256 } from "../canonical-json.js";
import type { HostOperationArtifactContractV1 } from "../contracts.js";
import type {
  HostOperationAdapterV1,
  HostOperationDeclarationV1,
  HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import { ComfyHttpClient } from "./comfy-client.js";
import { createComfyImagegenDeclaration } from "./operation-owner.js";
import { validateImagegenProfileSnapshot } from "../skill-contracts/imagegen.js";
import {
  validateImageInputUploadRequest,
  validateImageInputUploadReceipt,
} from "./reference-contracts.js";
import { backendMask } from "./reference-media.js";
import {
  assertImageAssetAuthority,
  checkImageAsset,
  imageAssetMedia,
  type ImageAssetAuthority,
} from "./asset-authority.js";
import type { ImagegenStorageAdmission } from "./types.js";
import type { ImagegenProfileRegistry } from "./types.js";
export const IMAGE_INPUT_UPLOAD_KIND = "imagegen.comfyui-upload-input.v1";
export const IMAGE_INPUT_UPLOAD_ADAPTER = "imagegen.comfyui-input-adapter.v1";
export const IMAGE_INPUT_UPLOAD_REQUEST = {
  schema_version: 1,
  port_name: "input_upload_request",
  artifact_kind: "image-input-upload-request",
  schema_id: "penny.image-input-upload-request.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1;
export const IMAGE_INPUT_UPLOAD_RECEIPT = {
  schema_version: 1,
  port_name: "input_upload_receipt",
  artifact_kind: "image-input-upload-receipt",
  schema_id: "penny.image-input-upload-receipt.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1;
export function imageInputUploadDeclaration(
  input: Parameters<typeof createComfyImagegenDeclaration>[0]
): HostOperationDeclarationV1 {
  return {
    ...createComfyImagegenDeclaration(input),
    operation_kind: IMAGE_INPUT_UPLOAD_KIND,
    adapter_id: IMAGE_INPUT_UPLOAD_ADAPTER,
    request: IMAGE_INPUT_UPLOAD_REQUEST,
    result: IMAGE_INPUT_UPLOAD_RECEIPT,
    max_input_artifacts: 2,
    output_contracts: [],
    max_output_artifacts: 1,
    max_pre_acceptance_retries: 0,
    result_selection_policy: "unselected",
  };
}
export class ImageInputUploadAdapter implements HostOperationAdapterV1 {
  readonly adapter_id = IMAGE_INPUT_UPLOAD_ADAPTER;
  private readonly options: {
    profiles: ImagegenProfileRegistry;
    assets: ImageAssetAuthority;
    storage: ImagegenStorageAdmission;
  };
  constructor(options: {
    profiles: ImagegenProfileRegistry;
    assets: ImageAssetAuthority;
    storage: ImagegenStorageAdmission;
  }) {
    assertImageAssetAuthority(options.assets);
    this.options = Object.freeze({ ...options });
  }
  inspectRequest(input: Parameters<HostOperationAdapterV1["inspectRequest"]>[0]) {
    const r = validateImageInputUploadRequest(
      JSON.parse(Buffer.from(input.request_bytes).toString("utf8"))
    );
    const resolved = this.options.profiles.resolve(r.profile_id);
    checkImageAsset(
      this.options.assets,
      r.asset,
      r.run_id,
      resolved.profile.profile_sha256,
      r.max_renders
    );
    if (
      r.run_id !== input.directive.identity.run_id ||
      input.directive.input_artifacts.artifacts.length !== 2 ||
      !input.directive.input_artifacts.artifacts.some(
        (x) =>
          x.slot === "profile_snapshot" &&
          canonicalJson(x.ref) === canonicalJson(r.profile_snapshot_ref)
      ) ||
      !input.directive.input_artifacts.artifacts.some(
        (x) => x.slot === "canonical_png" && canonicalJson(x.ref) === canonicalJson(r.png_ref)
      )
    )
      throw new Error("input upload request binding mismatch");
    return {
      schema_version: 1 as const,
      operation_kind: input.directive.operation_kind,
      adapter_id: this.adapter_id,
      backend_binding_id: input.declaration.backend_binding_id,
      backend_key_sha256: resolved.backend_key_sha256,
    };
  }
  async run(context: HostOperationExecutionContextV1) {
    const r = validateImageInputUploadRequest(
      JSON.parse(Buffer.from(context.request_bytes).toString("utf8"))
    );
    const resolved = this.options.profiles.resolve(r.profile_id),
      p = resolved.profile,
      c = p.revision_capability;
    const snapshot = validateImagegenProfileSnapshot(
      JSON.parse(Buffer.from(context.readInput("profile_snapshot").bytes).toString("utf8"))
    );
    if (
      c === undefined ||
      canonicalJson(snapshot) !== canonicalJson(resolved.snapshot) ||
      resolved.backend_key_sha256 !== context.directive.policy_binding.backend_key_sha256
    )
      throw new Error("upload profile drift");
    checkImageAsset(this.options.assets, r.asset, r.run_id, p.profile_sha256, r.max_renders);
    const media = imageAssetMedia(this.options.assets, r.asset);
    const expected =
      r.role === "source"
        ? media.source
        : media.mask === null || c.backend_mask_polarity === null
          ? null
          : backendMask(media.mask, c.backend_mask_polarity);
    const bytes = context.readInput("canonical_png").bytes;
    if (
      expected === null ||
      sha256(expected) !== r.png_ref.content_digest ||
      sha256(bytes) !== sha256(expected)
    )
      throw new Error("upload source/mask exact lineage mismatch");
    const locator = {
      filename: `${sha256(bytes)}.png`,
      subfolder: c.input_subfolder,
      type: "input" as const,
    };
    const client = new ComfyHttpClient(p.endpoint, {
      max_request_bytes: p.limits.max_request_json_bytes,
      max_readiness_bytes: p.limits.max_history_json_bytes,
      max_inventory_bytes: p.limits.max_inventory_json_bytes,
      max_history_bytes: p.limits.max_history_json_bytes,
      max_image_bytes: p.limits.max_image_bytes,
      max_upload_bytes: p.limits.max_image_bytes,
      connect_timeout_ms: p.limits.connect_timeout_ms,
      read_timeout_ms: p.limits.read_timeout_ms,
    });
    const correlation = `image-input-${sha256(canonicalJson(locator))}`;
    if (context.journal.remote_correlation_id === null) {
      await client.ready({ signal: context.signal, report_activity: context.reportActivity });
      checkImageAsset(this.options.assets, r.asset, r.run_id, p.profile_sha256, r.max_renders);
      context.beginSubmission();
      const uploaded = await client.uploadImage({
        bytes,
        filename: locator.filename,
        subfolder: locator.subfolder,
        signal: context.signal,
        report_activity: context.reportActivity,
      });
      if (canonicalJson(uploaded) !== canonicalJson(locator))
        throw new Error("uploaded input locator drift");
      context.recordRemoteAccepted(correlation);
    } else if (context.journal.remote_correlation_id !== correlation)
      throw new Error("upload recovery correlation drift");
    checkImageAsset(this.options.assets, r.asset, r.run_id, p.profile_sha256, r.max_renders);
    const fetched = await client.fetchMedia({
      media: locator,
      max_bytes: p.limits.max_image_bytes,
      accept: "image/png",
      signal: context.signal,
      report_activity: context.reportActivity,
    });
    if (
      fetched.status !== 200 ||
      fetched.media_type !== "image/png" ||
      fetched.bytes.byteLength !== bytes.byteLength ||
      sha256(fetched.bytes) !== sha256(bytes)
    )
      throw new Error("uploaded input readback mismatch");
    checkImageAsset(this.options.assets, r.asset, r.run_id, p.profile_sha256, r.max_renders);
    this.options.storage.commit({
      reservation_id: r.reservation_id,
      commit_key: `input-cache-${r.role}`,
      byte_length: 2 * fetched.bytes.byteLength + 1024,
    });
    await context.cacheResult(fetched.bytes);
    checkImageAsset(this.options.assets, r.asset, r.run_id, p.profile_sha256, r.max_renders);
    context.recordFetched({
      schema_version: 1,
      content_sha256: sha256(bytes),
      byte_length: bytes.byteLength,
      item_count: 1,
      poll_count: 1,
    });
    const receipt = validateImageInputUploadReceipt({
      schema_id: "penny.image-input-upload-receipt.v1",
      schema_version: 1,
      operation_record_id: context.journal.operation_record_id,
      request: r,
      locator,
      verified_sha256: sha256(bytes),
    });
    checkImageAsset(this.options.assets, r.asset, r.run_id, p.profile_sha256, r.max_renders);
    this.options.storage.commit({
      reservation_id: r.reservation_id,
      commit_key: `input-receipt-${r.role}`,
      byte_length: Buffer.byteLength(canonicalJson(receipt)) + Buffer.byteLength(canonicalJson(r)),
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
        contract: IMAGE_INPUT_UPLOAD_RECEIPT,
        media_type: "application/json",
        content: canonicalJson(receipt),
      },
    });
    return {
      disposition,
      operation_result_ref: persisted.operation_result_ref,
      output_artifacts: persisted.output_artifacts,
    };
  }
}
