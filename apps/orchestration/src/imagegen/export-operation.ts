import { TextDecoder } from "node:util";

import { canonicalJson, sha256 } from "../canonical-json.js";
import type { HostOperationArtifactContractV1 } from "../contracts.js";
import {
  hostOperationLeaseProfileSha256,
  type HostOperationAdapterTerminalV1,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
  type HostOperationDispositionV1,
  type HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import {
  ImagegenExportReceiptV1Schema,
  validateImagegenExportOperationRequest,
} from "../skill-contracts/imagegen.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import type { ImagegenExportRegistry } from "./types.js";

export const IMAGEGEN_EXPORT_OPERATION_KIND = "imagegen.atomic-export.v1" as const;
export const IMAGEGEN_EXPORT_ADAPTER_ID = "imagegen.atomic-export-adapter.v1" as const;

export const IMAGEGEN_EXPORT_OPERATION_REQUEST_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "export_request",
  artifact_kind: "imagegen-export-operation-request",
  schema_id: "penny.imagegen-export-operation-request.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export const IMAGEGEN_EXPORT_OPERATION_RECEIPT_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "export_receipt",
  artifact_kind: "imagegen-export-receipt",
  schema_id: "penny.image-export-receipt.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export function createImagegenExportDeclaration(input: {
  readonly backend_binding_id: string;
  readonly lease_profile_id: string;
  readonly lease_duration_ms: number;
  readonly lease_renew_after_ms: number;
  readonly queue_inactivity_ms: number;
  readonly operation_inactivity_ms: number;
  readonly max_request_bytes: number;
  readonly max_input_artifacts: number;
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
    operation_kind: IMAGEGEN_EXPORT_OPERATION_KIND,
    adapter_id: IMAGEGEN_EXPORT_ADAPTER_ID,
    request: IMAGEGEN_EXPORT_OPERATION_REQUEST_CONTRACT,
    result: IMAGEGEN_EXPORT_OPERATION_RECEIPT_CONTRACT,
    backend_binding_id: input.backend_binding_id,
    capability_classes: ["artifact_store", "registered_export_root"],
    lease_profile: {
      ...leaseBody,
      profile_sha256: hostOperationLeaseProfileSha256(leaseBody),
    },
    operation_inactivity_ms: input.operation_inactivity_ms,
    max_request_bytes: input.max_request_bytes,
    max_input_artifacts: input.max_input_artifacts,
    max_input_bytes: input.max_input_bytes,
    max_output_artifacts: 1,
    max_output_bytes: input.max_output_bytes,
    max_progress_events: input.max_progress_events,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "atomic_local_publication_v1",
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

function completedDisposition(): HostOperationDispositionV1 {
  return {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  };
}

function failedDisposition(): HostOperationDispositionV1 {
  return {
    outcome: "failed",
    remote_disposition: "proven_not_accepted",
    lease_disposition: "released",
    retryable: false,
    reason_code: "export_failed",
  };
}

function terminalWithoutArtifacts(
  disposition: HostOperationDispositionV1
): HostOperationAdapterTerminalV1 {
  return { disposition, operation_result_ref: null, output_artifacts: [] };
}

/** Host-only adapter for complete-set atomic publication under a registered destination. */
export class ImagegenExportOperationAdapter implements HostOperationAdapterV1 {
  readonly adapter_id = IMAGEGEN_EXPORT_ADAPTER_ID;

  constructor(private readonly exports: ImagegenExportRegistry) {}

  inspectRequest(input: Parameters<HostOperationAdapterV1["inspectRequest"]>[0]) {
    const request = validateImagegenExportOperationRequest(
      exactJson(input.request_bytes, "imagegen export operation request")
    );
    this.exports.resolve(request.export);
    if (request.run_id !== input.directive.identity.run_id) {
      throw new Error("imagegen export operation request names the wrong run");
    }
    const bindings = input.directive.input_artifacts.artifacts;
    if (
      bindings.length !== request.files.length ||
      request.files.some((file, index) => {
        const binding = bindings.find((candidate) => candidate.slot === `file-${index}`);
        return (
          binding === undefined || canonicalJson(binding.ref) !== canonicalJson(file.source_ref)
        );
      })
    ) {
      throw new Error("imagegen export operation request binding drifted");
    }
    return {
      schema_version: 1 as const,
      operation_kind: input.directive.operation_kind,
      adapter_id: this.adapter_id,
      backend_binding_id: input.declaration.backend_binding_id,
      backend_key_sha256: sha256(canonicalJson({ destination_id: request.export.destination_id })),
    };
  }

  async run(context: HostOperationExecutionContextV1): Promise<HostOperationAdapterTerminalV1> {
    const request = validateImagegenExportOperationRequest(
      exactJson(context.request_bytes, "imagegen export operation request")
    );
    if (request.run_id !== context.directive.identity.run_id) {
      return terminalWithoutArtifacts(failedDisposition());
    }
    if (context.signal.aborted) throw context.signal.reason;
    try {
      const exactFiles = request.files.map((file, index) => {
        const input = context.readInput(`file-${index}`);
        if (
          canonicalJson(input.ref) !== canonicalJson(file.source_ref) ||
          sha256(input.bytes) !== file.source_ref.content_digest
        ) {
          throw new Error("imagegen export exact input drifted");
        }
        return { file, bytes: input.bytes };
      });
      context.beginSubmission();
      const receipt = validateSkillSchema(
        ImagegenExportReceiptV1Schema,
        this.exports.export({
          intent: request.export,
          files: request.files,
          selected_filename: request.selected_filename,
          readArtifact: (ref) => {
            const exact = exactFiles.find(
              (candidate) => canonicalJson(candidate.file.source_ref) === canonicalJson(ref)
            );
            if (exact === undefined)
              throw new Error("imagegen export requested an unbound artifact");
            return exact.bytes;
          },
        }),
        "ImagegenExportReceiptV1"
      );
      const receiptContent = canonicalJson(receipt);
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(receiptContent),
        byte_length: Buffer.byteLength(receiptContent, "utf8"),
        item_count: receipt.files.length,
        poll_count: 1,
      });
      const disposition = completedDisposition();
      const persisted = context.persist({
        disposition,
        operation_result: {
          contract: IMAGEGEN_EXPORT_OPERATION_RECEIPT_CONTRACT,
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
      return terminalWithoutArtifacts(failedDisposition());
    }
  }
}
