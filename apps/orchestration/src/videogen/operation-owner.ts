import { AsyncLocalStorage } from "node:async_hooks";
import { ManagedComputeRelay } from "../host-operations/managed-compute-relay.js";
import {
  requireComfyGraphInventory,
  requirePinnedComfyInventory,
} from "../comfy/graph-inventory.js";
import { HOST_RECEIPTED_RESULT_CONTRACT } from "../host-operations/effect-protocol.js";
import { TextDecoder } from "node:util";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ComfyClientError, ComfyHttpClient, type ComfyClientLimitsV1 } from "../comfy/client.js";
import type { ArtifactRef, HostOperationArtifactContractV1 } from "../contracts.js";
import {
  hostOperationLeaseProfileSha256,
  type HostOperationAdapterTerminalV1,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
  type HostOperationDispositionV1,
  type HostOperationExecutionContextV1,
  type HostOperationRemoteCancellationResultV1,
} from "../host-operations/contracts.js";
import { validateMp4Video } from "../mp4-media.js";
import {
  validateVideoGenerationOperationReceipt,
  validateVideoGenerationOperationRequest,
  validateVideoReferenceUploadReceipt,
  validateVideoSubmittedGraph,
  validateVideoValidationReceipt,
  validateVideogenProfileSnapshot,
  type VideoGenerationOperationReceiptV1,
  type VideoValidationReceiptV1,
} from "./contracts.js";
import { assertSubmittedGraphMatchesProfile } from "./graph-builder.js";
import type { VideogenProfileRegistry } from "./profile-registry.js";
import {
  decodeVideogenFetchedCache,
  encodeVideogenFetchedCache,
  isConcreteVideogenPromptCancellationAuthorityV1,
  type VideogenPromptCancellationAuthorityV1,
} from "./render-safety.js";

export const COMFY_VIDEO_GENERATION_OPERATION_KIND = "videogen.comfyui-generate.v1" as const;
export const COMFY_VIDEO_GENERATION_ADAPTER_ID = "videogen.comfyui-adapter.v1" as const;

export const VIDEO_GENERATION_OPERATION_REQUEST_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "generation_request",
  artifact_kind: "video-generation-operation-request",
  schema_id: "penny.video-generation-operation-request.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export const VIDEO_GENERATION_OPERATION_RECEIPT_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "generation_receipt",
  artifact_kind: "video-generation-operation-receipt",
  schema_id: "penny.video-generation-operation-receipt.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export const VIDEO_VALIDATION_RECEIPT_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "validation_receipt",
  artifact_kind: "video-validation-receipt",
  schema_id: "penny.video-validation-receipt.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export const GENERATED_VIDEO_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "generated_video",
  artifact_kind: "generated-video",
  schema_id: "penny.generated-video.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);

export function createComfyVideogenDeclaration(input: {
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
      input.effect_protocol === undefined ? COMFY_VIDEO_GENERATION_OPERATION_KIND : "video_render",
    adapter_id: COMFY_VIDEO_GENERATION_ADAPTER_ID,
    request: VIDEO_GENERATION_OPERATION_REQUEST_CONTRACT,
    ...(input.effect_protocol === undefined
      ? {}
      : {
          effect_protocol: input.effect_protocol,
          result_selection_policy: "unselected",
          receipt_citing_result: HOST_RECEIPTED_RESULT_CONTRACT,
        }),
    result: VIDEO_GENERATION_OPERATION_RECEIPT_CONTRACT,
    backend_binding_id: input.backend_binding_id,
    capability_classes: ["artifact_store", "registered_loopback_http"],
    lease_profile: {
      ...leaseBody,
      profile_sha256: hostOperationLeaseProfileSha256(leaseBody),
    },
    operation_inactivity_ms: input.operation_inactivity_ms,
    max_request_bytes: input.max_request_bytes,
    max_input_artifacts: 3,
    max_input_bytes: input.max_input_bytes,
    output_contracts: [VIDEO_VALIDATION_RECEIPT_CONTRACT, GENERATED_VIDEO_CONTRACT],
    max_output_artifacts: input.effect_protocol === undefined ? 3 : 4,
    max_output_bytes: input.max_output_bytes,
    max_progress_events: input.max_progress_events,
    max_pre_acceptance_retries: input.managed ? 0 : 1,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "registered_remote_cancel_then_observe_v1",
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

function failure(
  reasonCode: string,
  remote: "proven_not_accepted" | "proven_terminal" | "may_continue",
  retryable = false
): HostOperationDispositionV1 {
  if (remote === "may_continue") {
    return {
      outcome: "remote_unknown",
      remote_disposition: remote,
      lease_disposition: "quarantined",
      retryable: false,
      reason_code: reasonCode,
    };
  }
  return {
    outcome: "failed",
    remote_disposition: remote,
    lease_disposition: "released",
    retryable,
    reason_code: reasonCode,
  };
}

function completed(): HostOperationDispositionV1 {
  return {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  };
}

function terminalWithoutArtifacts(
  value: HostOperationDispositionV1
): HostOperationAdapterTerminalV1 {
  return { disposition: value, operation_result_ref: null, output_artifacts: [] };
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

async function waitForPoll(signal: AbortSignal, intervalMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
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

async function cancelAndObserve(input: {
  readonly client: ComfyHttpClient;
  readonly prompt_id: string;
  readonly output_node_id: string;
  readonly interval_ms: number;
  readonly signal: AbortSignal;
}): Promise<HostOperationRemoteCancellationResultV1> {
  // Interrupts are disabled: no independently host-owned current deployment selection
  // is available here. Neither reviewed constructor evidence nor profile/worker identity
  // proves current version or revocation. Observe only the exact accepted prompt.
  try {
    for (let attempt = 0; attempt < 3 && !input.signal.aborted; attempt += 1) {
      const history = await input.client.historyMedia({
        prompt_id: input.prompt_id,
        output_node_id: input.output_node_id,
        signal: input.signal,
      });
      if (history.state !== "pending") {
        return {
          remote_disposition: "proven_terminal",
          reason_code: "exact_prompt_observed_terminal",
        };
      }
      await waitForPoll(input.signal, input.interval_ms);
    }
  } catch {
    // Cleanup failure cannot prove that the exact prompt stopped.
  }
  return {
    remote_disposition: "may_continue",
    reason_code: "exact_prompt_terminal_unproven",
  };
}

export interface ComfyVideogenAdapterOptionsV1 {
  readonly profiles: VideogenProfileRegistry;
  readonly managed_relay?: ManagedComputeRelay;
  readonly grant_file?: string;
  readonly approved_inventory?: unknown;
  readonly legacy_http?: true;
  /** Retained reviewed evidence only. Without concrete current deployment custody, interrupts stay disabled. */
  readonly cancellation_authority?: VideogenPromptCancellationAuthorityV1;
  readonly client_factory?: (
    endpoint: ReturnType<VideogenProfileRegistry["resolve"]>["profile"]["endpoint"],
    limits: ComfyClientLimitsV1
  ) => ComfyHttpClient;
}

/** Host-only registered adapter for one exact prepared graph and one admitted MP4 output. */
export class ComfyVideogenOperationAdapter implements HostOperationAdapterV1 {
  readonly adapter_id = COMFY_VIDEO_GENERATION_ADAPTER_ID;
  private readonly clientFactory: NonNullable<ComfyVideogenAdapterOptionsV1["client_factory"]>;

  constructor(private readonly options: ComfyVideogenAdapterOptionsV1) {
    if (!options.managed_relay && options.legacy_http !== true)
      throw new Error("Comfy HTTP requires explicit legacy opt-in without managed binding");
    if (
      options.managed_relay &&
      (!(options.managed_relay instanceof ManagedComputeRelay) ||
        !options.grant_file ||
        !options.approved_inventory ||
        options.client_factory)
    )
      throw new Error("Comfy managed binding incomplete");
    if (
      options.cancellation_authority !== undefined &&
      !isConcreteVideogenPromptCancellationAuthorityV1(options.cancellation_authority)
    )
      throw new Error("video cancellation requires concrete host-pinned authority");
    this.clientFactory =
      options.client_factory ??
      ((endpoint, limits) => new ComfyHttpClient(endpoint, limits, options.managed_relay));
  }

  inspectRequest(input: Parameters<HostOperationAdapterV1["inspectRequest"]>[0]) {
    const request = validateVideoGenerationOperationRequest(
      exactJson(input.request_bytes, "video generation operation request")
    );
    const resolved = this.options.profiles.resolve(request.profile_id);
    const bindings = input.directive.input_artifacts.artifacts;
    const slots = bindings.map((binding) => binding.slot).sort();
    const expectedSlots =
      request.mode === "i2v"
        ? ["input_upload_receipt", "profile_snapshot", "submitted_graph"]
        : ["profile_snapshot", "submitted_graph"];
    if (
      (request.operation_id !== undefined &&
        request.operation_id !== input.directive.operation_id) ||
      request.run_id !== input.directive.identity.run_id ||
      request.profile_sha256 !== resolved.profile.profile_sha256 ||
      canonicalJson(slots) !== canonicalJson(expectedSlots) ||
      !bindings.some(
        (binding) =>
          binding.slot === "profile_snapshot" && sameRef(binding.ref, request.profile_snapshot_ref)
      ) ||
      !bindings.some(
        (binding) =>
          binding.slot === "submitted_graph" && sameRef(binding.ref, request.submitted_graph_ref)
      )
    ) {
      throw new Error("video generation operation request binding drifted");
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
    if (this.options.managed_relay) await this.options.managed_relay.prepare(context);
  }
  close(): void {
    this.options.managed_relay?.disconnect();
  }
  #opened = false;
  async run(context: HostOperationExecutionContextV1): Promise<HostOperationAdapterTerminalV1> {
    this.#opened = false;
    const result = await this.runPrepared(context);
    if (this.#opened && result.disposition.remote_disposition !== "may_continue")
      await this.options.managed_relay?.finish();
    return result;
  }
  private async runPrepared(
    context: HostOperationExecutionContextV1
  ): Promise<HostOperationAdapterTerminalV1> {
    // A failed input check is not proof that previously guarded/accepted work stopped.
    const inputFailure = (reasonCode: string): HostOperationAdapterTerminalV1 =>
      terminalWithoutArtifacts(
        failure(
          reasonCode,
          context.journal.lifecycle === "lease_acquired" &&
            context.journal.remote_correlation_id === null
            ? "proven_not_accepted"
            : "may_continue"
        )
      );
    const request = validateVideoGenerationOperationRequest(
      exactJson(context.request_bytes, "video generation operation request")
    );
    const resolved = this.options.profiles.resolve(request.profile_id);
    if (
      resolved.profile.profile_sha256 !== request.profile_sha256 ||
      resolved.backend_key_sha256 !== context.directive.policy_binding.backend_key_sha256
    ) {
      return inputFailure("profile_drift");
    }
    const snapshotInput = context.readInput("profile_snapshot");
    const graphInput = context.readInput("submitted_graph");
    if (
      !sameRef(snapshotInput.ref, request.profile_snapshot_ref) ||
      !sameRef(graphInput.ref, request.submitted_graph_ref) ||
      sha256(snapshotInput.bytes) !== snapshotInput.ref.content_digest ||
      snapshotInput.ref.media_type !== "application/json" ||
      snapshotInput.ref.content_schema?.schema_id !== "penny.videogen-profile-snapshot.v1" ||
      snapshotInput.ref.content_schema.schema_version !== 1 ||
      sha256(graphInput.bytes) !== request.submitted_graph_sha256 ||
      graphInput.ref.media_type !== "application/json" ||
      graphInput.ref.content_schema?.schema_id !== "penny.video-submitted-graph.v1" ||
      graphInput.ref.content_schema.schema_version !== 1
    ) {
      return inputFailure("operation_input_drift");
    }
    const snapshot = validateVideogenProfileSnapshot(
      exactJson(snapshotInput.bytes, "videogen profile snapshot")
    );
    const submitted = validateVideoSubmittedGraph(
      exactJson(graphInput.bytes, "videogen submitted graph")
    );
    try {
      this.options.profiles.verifySnapshot(snapshot);
    } catch {
      return inputFailure("profile_snapshot_drift");
    }
    if (
      submitted.run_id !== request.run_id ||
      submitted.shot_id !== request.shot_id ||
      submitted.profile_id !== request.profile_id ||
      submitted.profile_sha256 !== request.profile_sha256 ||
      submitted.mode !== request.mode ||
      submitted.frame_count !== request.frame_count ||
      submitted.fps !== request.fps ||
      canonicalJson(submitted.dimensions) !== canonicalJson(request.dimensions)
    ) {
      return inputFailure("prepared_graph_drift");
    }

    let uploadReceipt;
    let uploadReceiptRef;
    if (submitted.mode === "i2v") {
      const uploadInput = context.readInput("input_upload_receipt");
      if (
        sha256(uploadInput.bytes) !== uploadInput.ref.content_digest ||
        uploadInput.ref.media_type !== "application/json" ||
        uploadInput.ref.content_schema?.schema_id !== "penny.video-reference-upload-receipt.v1" ||
        uploadInput.ref.content_schema.schema_version !== 1
      ) {
        return inputFailure("input_upload_receipt_drift");
      }
      uploadReceipt = validateVideoReferenceUploadReceipt(
        exactJson(uploadInput.bytes, "video reference upload receipt")
      );
      uploadReceiptRef = uploadInput.ref;
      // Bind the receipt's canonical identity and original locator before any backend I/O.
      // The render has only exact receipt inputs; it must not discover the referenced PNG.
      if (
        uploadReceipt.run_id !== request.run_id ||
        uploadReceipt.profile_id !== request.profile_id ||
        uploadReceipt.profile_sha256 !== request.profile_sha256 ||
        uploadReceipt.canonical_png_sha256 !== uploadReceipt.canonical_png_ref.content_digest ||
        uploadReceipt.canonical_png_bytes !== uploadReceipt.canonical_png_ref.byte_length ||
        uploadReceipt.canonical_png_ref.media_type !== "image/png" ||
        uploadReceipt.canonical_png_bytes > resolved.profile.limits.max_upload_bytes ||
        uploadReceipt.remote_descriptor.filename !== `${uploadReceipt.canonical_png_sha256}.png` ||
        uploadReceipt.remote_descriptor.subfolder !== resolved.profile.input_subfolder
      ) {
        return inputFailure("input_upload_identity_drift");
      }
    }
    try {
      assertSubmittedGraphMatchesProfile({
        submitted,
        profile_snapshot: snapshot,
        profile_snapshot_ref: snapshotInput.ref,
        ...(uploadReceipt === undefined ? {} : { input_upload_receipt: uploadReceipt }),
        ...(uploadReceiptRef === undefined ? {} : { input_upload_receipt_ref: uploadReceiptRef }),
      });
    } catch {
      return inputFailure("prepared_graph_policy_mismatch");
    }

    const profile = resolved.profile;
    if (this.options.approved_inventory)
      requireComfyGraphInventory(submitted.graph, this.options.approved_inventory);
    const client = this.clientFactory(profile.endpoint, clientLimits(profile));
    let promptId = context.journal.remote_correlation_id;
    let pollCount = context.journal.fetched?.poll_count ?? 0;
    if (promptId === null) {
      let submissionBegan = false;
      try {
        await client.ready({ signal: context.signal, report_activity: context.reportActivity });
        const inventory = await client.inventory({
          signal: context.signal,
          report_activity: context.reportActivity,
        });
        if (this.options.approved_inventory)
          requirePinnedComfyInventory(
            submitted.graph,
            this.options.approved_inventory,
            inventory.object_info
          );
        if (
          profile.required_inventory.class_types.some(
            (entry) => !inventory.class_types.has(entry)
          ) ||
          profile.required_inventory.model_ids.some((entry) => !inventory.scalar_strings.has(entry))
        ) {
          return terminalWithoutArtifacts(
            failure("backend_inventory_drift", "proven_not_accepted")
          );
        }
        // The owner, not a request/journal assertion, checks the current shared fence.
        // Guard first so a crash during readback remains conservatively quarantined.
        context.beginSubmission();
        if (uploadReceipt !== undefined) {
          let readback: Awaited<ReturnType<ComfyHttpClient["fetchMedia"]>>;
          try {
            readback = await client.fetchMedia({
              media: uploadReceipt.remote_descriptor,
              max_bytes: profile.limits.max_upload_bytes,
              accept: "image/png",
              signal: context.signal,
              report_activity: context.reportActivity,
            });
          } catch {
            if (context.signal.aborted) throw context.signal.reason;
            return terminalWithoutArtifacts(
              failure("render_input_readback_failed", "proven_not_accepted")
            );
          }
          if (
            readback.status < 200 ||
            readback.status >= 300 ||
            readback.media_type !== "image/png" ||
            readback.bytes.byteLength !== uploadReceipt.canonical_png_bytes ||
            sha256(readback.bytes) !== uploadReceipt.canonical_png_sha256
          ) {
            return terminalWithoutArtifacts(
              failure("render_input_identity_mismatch", "proven_not_accepted")
            );
          }
        }
        // No intervening network call, wait, new upload/name, or locator discovery is allowed.
        submissionBegan = true;
        try {
          if (this.options.managed_relay) {
            if (!this.options.grant_file) throw new Error("managed grant binding absent");
            promptId = await this.options.managed_relay.open({
              grant_file: this.options.grant_file,
              operation_request_bytes: context.request_bytes,
              submitted_graph_bytes: graphInput.bytes,
            });
            this.#opened = true;
            const relay = this.options.managed_relay;
            context.registerRemoteCancellation(async () => {
              await relay.drainOwned();
              return {
                remote_disposition: "proven_terminal",
                reason_code: "managed_exact_job_drained",
              };
            });
            await relay.submit();
          } else
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
            return terminalWithoutArtifacts(
              failure("submission_not_accepted", "proven_not_accepted", true)
            );
          }
          throw error;
        }
        context.recordRemoteAccepted(promptId);
      } catch (error) {
        if (error instanceof Error && error.name === "HostOperationSimulatedCrashError")
          throw error;
        if (!submissionBegan) {
          if (context.signal.aborted) throw error;
          return terminalWithoutArtifacts(failure("readiness_failed", "proven_not_accepted", true));
        }
        throw error;
      }
    }
    if (promptId === null) throw new Error("accepted video generation lacks its prompt ID");
    if (!this.options.managed_relay)
      context.registerRemoteCancellation(
        AsyncLocalStorage.bind(
          async (signal: AbortSignal) =>
            await cancelAndObserve({
              client,
              prompt_id: promptId,
              output_node_id: profile.mutations.output_node_id,
              interval_ms: Math.min(profile.limits.poll_interval_ms, 1_000),
              signal,
            })
        )
      );

    let descriptor: Awaited<ReturnType<ComfyHttpClient["historyMedia"]>> | undefined;
    let cached: Awaited<ReturnType<HostOperationExecutionContextV1["readCachedResult"]>>;
    try {
      cached = await context.readCachedResult();
    } catch {
      if (context.signal.aborted) throw context.signal.reason;
      return terminalWithoutArtifacts(failure("fetched_result_cache_corrupt", "may_continue"));
    }
    const cacheIdentity = {
      operation_record_id: context.journal.operation_record_id,
      directive_sha256: sha256(canonicalJson(context.directive)),
      request_sha256: sha256(context.request_bytes),
      prompt_id_sha256: sha256(promptId),
    };
    let recoveredCache: ReturnType<typeof decodeVideogenFetchedCache> | undefined;
    if (cached !== null) {
      try {
        recoveredCache = decodeVideogenFetchedCache(
          cached.bytes,
          context.declaration.max_output_bytes
        );
        if (
          cached.request_sha256 !== context.directive.request_sha256 ||
          cached.content_sha256 !== sha256(cached.bytes) ||
          cached.byte_length !== cached.bytes.byteLength ||
          cacheIdentity.request_sha256 !== context.directive.request_sha256 ||
          recoveredCache.header.operation_record_id !== cacheIdentity.operation_record_id ||
          recoveredCache.header.directive_sha256 !== cacheIdentity.directive_sha256 ||
          recoveredCache.header.request_sha256 !== cacheIdentity.request_sha256 ||
          recoveredCache.header.prompt_id_sha256 !== cacheIdentity.prompt_id_sha256 ||
          (context.journal.fetched !== null &&
            (context.journal.fetched.content_sha256 !== cached.content_sha256 ||
              context.journal.fetched.byte_length !== cached.byte_length))
        )
          throw new Error("video fetched cache identity drifted");
      } catch {
        return terminalWithoutArtifacts(
          failure("fetched_result_cache_identity_invalid", "may_continue")
        );
      }
    }
    if (context.journal.lifecycle !== "fetched") {
      let transientFailures = 0;
      while (pollCount < profile.limits.max_poll_attempts) {
        if (context.signal.aborted) throw context.signal.reason;
        pollCount += 1;
        try {
          await this.options.managed_relay?.sample();
          descriptor = await client.historyMedia({
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
            return terminalWithoutArtifacts(failure("polling_outcome_unknown", "may_continue"));
          }
          await waitForPoll(context.signal, profile.limits.poll_interval_ms);
          continue;
        }
        if (descriptor.state === "pending") {
          await waitForPoll(context.signal, profile.limits.poll_interval_ms);
          continue;
        }
        if (descriptor.state === "failed") {
          return terminalWithoutArtifacts(failure(descriptor.reason_code, "proven_terminal"));
        }
        break;
      }
      if (descriptor?.state !== "completed") {
        const cancelled = await cancelAndObserve({
          client,
          prompt_id: promptId,
          output_node_id: profile.mutations.output_node_id,
          interval_ms: Math.min(profile.limits.poll_interval_ms, 1_000),
          signal: context.signal,
        });
        return terminalWithoutArtifacts(
          cancelled.remote_disposition === "proven_terminal"
            ? failure("polling_exhausted_terminal_observed", "proven_terminal")
            : failure("polling_exhausted_without_terminal_state", "may_continue")
        );
      }
    } else if (cached === null || context.journal.fetched === null) {
      return terminalWithoutArtifacts(failure("fetched_result_cache_missing", "may_continue"));
    }

    let videoBytes: Uint8Array;
    let responseMediaType = "video/mp4";
    let outputDescriptor = descriptor?.state === "completed" ? descriptor.media : null;
    if (recoveredCache !== undefined) {
      videoBytes = recoveredCache.video;
      if (context.journal.fetched !== null) {
        pollCount = context.journal.fetched.poll_count;
      }
      if (outputDescriptor === null) {
        let recovered: Awaited<ReturnType<ComfyHttpClient["historyMedia"]>>;
        try {
          recovered = await client.historyMedia({
            prompt_id: promptId,
            output_node_id: profile.mutations.output_node_id,
            signal: context.signal,
            report_activity: context.reportActivity,
          });
        } catch {
          if (context.signal.aborted) throw context.signal.reason;
          return terminalWithoutArtifacts(failure("recovery_history_unavailable", "may_continue"));
        }
        if (recovered.state !== "completed") {
          return terminalWithoutArtifacts(failure("recovery_history_incomplete", "may_continue"));
        }
        outputDescriptor = recovered.media;
      }
      // Compare the original durable locator BEFORE fetching or adopting current history.
      if (
        canonicalJson(outputDescriptor) !== canonicalJson(recoveredCache.header.remote_descriptor)
      ) {
        return terminalWithoutArtifacts(
          failure("recovery_descriptor_identity_mismatch", "may_continue")
        );
      }
      let verified: Awaited<ReturnType<ComfyHttpClient["fetchMedia"]>>;
      try {
        verified = await client.fetchMedia({
          media: outputDescriptor,
          max_bytes: profile.limits.max_video_bytes,
          accept: "video/mp4",
          signal: context.signal,
          report_activity: context.reportActivity,
        });
      } catch {
        if (context.signal.aborted) throw context.signal.reason;
        return terminalWithoutArtifacts(
          failure("recovery_video_verification_failed", "may_continue")
        );
      }
      if (
        verified.status < 200 ||
        verified.status >= 300 ||
        sha256(verified.bytes) !== recoveredCache.header.video_sha256 ||
        verified.bytes.byteLength !== recoveredCache.header.video_byte_length ||
        (verified.media_type === "video/mp4" ? "video/mp4" : "invalid") !==
          recoveredCache.header.media_type
      ) {
        return terminalWithoutArtifacts(
          failure("recovery_video_identity_mismatch", "may_continue")
        );
      }
      responseMediaType = verified.media_type ?? "missing";
    } else {
      if (outputDescriptor === null) {
        return terminalWithoutArtifacts(
          failure("terminal_output_descriptor_missing", "proven_terminal")
        );
      }
      let fetched: Awaited<ReturnType<ComfyHttpClient["fetchMedia"]>>;
      try {
        fetched = await client.fetchMedia({
          media: outputDescriptor,
          max_bytes: profile.limits.max_video_bytes,
          accept: "video/mp4",
          signal: context.signal,
          report_activity: context.reportActivity,
        });
      } catch {
        if (context.signal.aborted) throw context.signal.reason;
        return terminalWithoutArtifacts(failure("terminal_video_fetch_failed", "proven_terminal"));
      }
      if (fetched.status < 200 || fetched.status >= 300) {
        return terminalWithoutArtifacts(
          failure("terminal_video_fetch_unavailable", "proven_terminal")
        );
      }
      responseMediaType = fetched.media_type ?? "missing";
      videoBytes = fetched.bytes;
      let envelope: Uint8Array;
      try {
        envelope = encodeVideogenFetchedCache(
          {
            schema_id: "penny.videogen-fetched-cache.v1",
            schema_version: 1,
            ...cacheIdentity,
            remote_descriptor: outputDescriptor,
            media_type: responseMediaType === "video/mp4" ? "video/mp4" : "invalid",
            video_sha256: sha256(videoBytes),
            video_byte_length: videoBytes.byteLength,
          },
          videoBytes,
          context.declaration.max_output_bytes
        );
      } catch {
        return terminalWithoutArtifacts(
          failure("fetched_result_cache_representation_limit", "proven_terminal")
        );
      }
      cached = await context.cacheResult(envelope);
    }

    const validation =
      responseMediaType === "video/mp4"
        ? validateMp4Video(videoBytes, {
            width: request.dimensions.width,
            height: request.dimensions.height,
            frame_count: request.frame_count,
            fps: request.fps,
            max_bytes: profile.limits.max_video_bytes,
          })
        : {
            status: "invalid" as const,
            reason_code: "wrong_media_type",
            detail: "backend output does not use video/mp4",
            byte_length: videoBytes.byteLength,
            sha256: sha256(videoBytes),
          };
    if (cached === null) throw new Error("video fetched cache was not durably recorded");
    context.recordFetched({
      schema_version: 1,
      content_sha256: cached.content_sha256,
      byte_length: cached.byte_length,
      item_count: 1,
      poll_count: Math.max(1, pollCount),
    });
    if (outputDescriptor === null) throw new Error("terminal video descriptor was not recovered");
    const validationReceipt: VideoValidationReceiptV1 = validateVideoValidationReceipt({
      schema_id: "penny.video-validation-receipt.v1",
      schema_version: 1,
      run_id: request.run_id,
      shot_id: request.shot_id,
      prompt_id_sha256: sha256(promptId),
      validation,
    });
    const receipt: VideoGenerationOperationReceiptV1 = validateVideoGenerationOperationReceipt({
      schema_id: "penny.video-generation-operation-receipt.v1",
      schema_version: 1,
      run_id: request.run_id,
      shot_id: request.shot_id,
      profile_id: request.profile_id,
      profile_sha256: request.profile_sha256,
      submitted_graph_ref: request.submitted_graph_ref,
      submitted_graph_sha256: request.submitted_graph_sha256,
      prompt_id: promptId,
      remote_descriptor: outputDescriptor,
      poll_count: Math.max(1, pollCount),
      status: validation.status === "valid" ? "persisted" : "downloaded_invalid",
      validation,
    });
    const terminalDisposition =
      validation.status === "valid"
        ? completed()
        : failure("downloaded_invalid", "proven_terminal");
    const persisted = context.persist({
      disposition: terminalDisposition,
      operation_result: {
        contract: VIDEO_GENERATION_OPERATION_RECEIPT_CONTRACT,
        media_type: "application/json",
        content: canonicalJson(receipt),
      },
      outputs: [
        {
          contract: VIDEO_VALIDATION_RECEIPT_CONTRACT,
          media_type: "application/json",
          content: canonicalJson(validationReceipt),
        },
        ...(validation.status === "valid"
          ? [
              {
                contract: GENERATED_VIDEO_CONTRACT,
                media_type: "video/mp4",
                content: videoBytes,
              },
            ]
          : []),
      ],
    });
    return {
      disposition: terminalDisposition,
      operation_result_ref: persisted.operation_result_ref,
      output_artifacts: persisted.output_artifacts,
    };
  }
}
