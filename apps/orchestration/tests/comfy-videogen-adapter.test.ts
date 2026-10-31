import { join } from "node:path";
import { HostEffectFixture } from "./helpers/host-effect-fixture.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { FileHostOperationResultCache } from "../dist/host-operations/result-cache.js";
import { verifyHostResultWrapper } from "../dist/host-operations/effect-protocol.js";
import {
  VideoGenerationOperationRequestV1Schema,
  VideoReferenceUploadOperationRequestV1Schema,
} from "../dist/videogen/contracts.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { ComfyHttpClient } from "../dist/comfy/client.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, InvokeHostOperationDirectiveV1 } from "../dist/contracts.js";
import type {
  HostOperationAdapterV1,
  HostOperationCallRecordV1,
  HostOperationDeclarationV1,
  HostOperationExecutionContextV1,
  HostOperationFetchedV1,
  HostOperationPersistenceInputV1,
  HostOperationRemoteCancellationResultV1,
} from "../dist/host-operations/contracts.js";
import { encodeCanonicalPng } from "../dist/png-media.js";
import {
  validateVideoGenerationOperationReceipt,
  validateVideoReferenceUploadOperationRequest,
  validateVideoReferenceUploadReceipt,
  validateVideoValidationReceipt,
  validateVideogenProfileSnapshot,
  type VideoReferenceUploadReceiptV1,
} from "../dist/videogen/contracts.js";
import { buildVideoSubmittedGraph } from "../dist/videogen/graph-builder.js";
import {
  ComfyVideogenOperationAdapter,
  createComfyVideogenDeclaration,
} from "../dist/videogen/operation-owner.js";
import {
  VideogenPromptCancellationAuthorityV1,
  decodeVideogenFetchedCache,
  encodeVideogenFetchedCache,
  isConcreteVideogenPromptCancellationAuthorityV1,
} from "../dist/videogen/render-safety.js";
import { requireValue } from "./helpers/narrowing.js";
import { syntheticCancellationEvidence } from "./videogen-render-safety-fixtures.js";
import { StaticVideogenProfileRegistry } from "../dist/videogen/profile-registry.js";
import {
  ComfyVideogenUploadOperationAdapter,
  VIDEO_REFERENCE_UPLOAD_RECEIPT_CONTRACT,
  createComfyVideoUploadDeclaration,
} from "../dist/videogen/upload-operation.js";
import {
  syntheticVideogenInventory,
  syntheticVideogenProfile,
} from "./helpers/videogen-fixtures.js";

const VIDEO = readFileSync(new URL("./fixtures/videogen/tiny-h264.mp4", import.meta.url));
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

function respondJson(response: ServerResponse, value: unknown): void {
  const body = canonicalJson(value);
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (typeof value === "string" || value instanceof Uint8Array) {
      chunks.push(Buffer.from(value));
    } else {
      throw new Error("HTTP test body emitted a non-byte chunk");
    }
  }
  return Buffer.concat(chunks);
}

function artifactRef(input: {
  readonly id: string;
  readonly kind: string;
  readonly media_type: string;
  readonly schema_id: string;
  readonly bytes: Uint8Array;
}): ArtifactRef {
  const digest = sha256(input.bytes);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(input.id)}`,
    kind: input.kind,
    run_id: "run-video-test",
    phase: "production",
    branch_id: "shot-1",
    operation_id: input.id,
    version: 1,
    producer: "test:videogen-adapter",
    content_digest: digest,
    byte_length: input.bytes.byteLength,
    media_type: input.media_type,
    content_schema: { schema_id: input.schema_id, schema_version: 1 },
    store_ref: `artifact://sha256/${digest}`,
  };
}

interface TestContextV1 {
  readonly context: HostOperationExecutionContextV1;
  readonly persisted: HostOperationPersistenceInputV1[];
  readonly fetched: HostOperationFetchedV1[];
  readonly accepted: readonly string[];
  readonly cancellations: readonly ((
    signal: AbortSignal
  ) => Promise<HostOperationRemoteCancellationResultV1>)[];
}

function testContext(input: {
  readonly declaration: HostOperationDeclarationV1;
  readonly directive: InvokeHostOperationDirectiveV1;
  readonly request_bytes: Uint8Array;
  readonly inputs: ReadonlyMap<string, { readonly ref: ArtifactRef; readonly bytes: Uint8Array }>;
  readonly lifecycle?: HostOperationCallRecordV1["lifecycle"];
  readonly remote_correlation_id?: string | null;
  readonly prior_fetched?: HostOperationFetchedV1 | null;
  readonly cached_bytes?: Uint8Array | null;
}): TestContextV1 {
  const persisted: HostOperationPersistenceInputV1[] = [];
  const fetched: HostOperationFetchedV1[] = [];
  const accepted: string[] = [];
  const cancellations: Array<
    (signal: AbortSignal) => Promise<HostOperationRemoteCancellationResultV1>
  > = [];
  let cachedBytes = input.cached_bytes ?? null;
  const lifecycle = input.lifecycle ?? "lease_acquired";
  const timestamp = "2026-09-27T00:00:00.000Z";
  const journal: HostOperationCallRecordV1 = {
    schema_version: 1,
    operation_record_id: "video-operation-record",
    project_id: "project-test",
    identity: input.directive.identity,
    state_id: input.directive.state_id,
    attempt: input.directive.attempt,
    operation_id: input.directive.operation_id,
    operation_kind: input.directive.operation_kind,
    directive: input.directive,
    directive_sha256: sha256(canonicalJson(input.directive)),
    registration_sha256: input.directive.registration_sha256,
    request_ref: input.directive.request_ref,
    request_sha256: input.directive.request_sha256,
    input_artifacts: input.directive.input_artifacts,
    expected_result: input.directive.expected_result,
    policy_binding: input.directive.policy_binding,
    lifecycle,
    lease: null,
    lease_expires_at_ms: null,
    queue_inactivity_expires_at_ms: Date.now() + 10_000,
    operation_inactivity_expires_at_ms: Date.now() + 60_000,
    remote_correlation_id: input.remote_correlation_id ?? null,
    remote_correlation_sha256:
      input.remote_correlation_id === undefined || input.remote_correlation_id === null
        ? null
        : sha256(input.remote_correlation_id),
    fetched: input.prior_fetched ?? null,
    persistence_plan: null,
    operation_result_ref: null,
    output_artifacts: [],
    disposition: null,
    lease_disposition_receipt_id: null,
    platform_result_ref: null,
    host_receipt_ref: null,
    progress_event_count: 0,
    started_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const context: HostOperationExecutionContextV1 = {
    directive: input.directive,
    declaration: input.declaration,
    request_bytes: input.request_bytes,
    journal,
    signal: new AbortController().signal,
    reportActivity: () => undefined,
    readInput: (slot) => {
      const found = input.inputs.get(slot);
      if (found === undefined) throw new Error(`missing test input '${slot}'`);
      return found;
    },
    emitProgress: () => undefined,
    beginSubmission: () => undefined,
    recordRemoteAccepted: (value) => accepted.push(value),
    cacheResult: async (bytes) => {
      cachedBytes = Buffer.from(bytes);
      return {
        schema_version: 1,
        request_sha256: input.directive.request_sha256,
        content_sha256: sha256(bytes),
        byte_length: bytes.byteLength,
        bytes: Buffer.from(bytes),
      };
    },
    readCachedResult: async () =>
      cachedBytes === null
        ? null
        : {
            schema_version: 1,
            request_sha256: input.directive.request_sha256,
            content_sha256: sha256(cachedBytes),
            byte_length: cachedBytes.byteLength,
            bytes: Buffer.from(cachedBytes),
          },
    recordFetched: (value) => {
      if (
        cachedBytes !== null &&
        (sha256(cachedBytes) !== value.content_sha256 ||
          cachedBytes.byteLength !== value.byte_length)
      ) {
        throw new Error("test cache does not match fetched milestone");
      }
      fetched.push(value);
    },
    persist: (value) => {
      persisted.push(value);
      const resultBytes = Buffer.from(value.operation_result.content);
      const resultRef = artifactRef({
        id: "operation-result",
        kind: value.operation_result.contract.artifact_kind,
        media_type: value.operation_result.media_type,
        schema_id: value.operation_result.contract.schema_id,
        bytes: resultBytes,
      });
      const outputs = (value.outputs ?? []).map((output, index) => {
        const bytes = Buffer.from(output.content);
        return artifactRef({
          id: `operation-output-${index}`,
          kind: output.contract.artifact_kind,
          media_type: output.media_type,
          schema_id: output.contract.schema_id,
          bytes,
        });
      });
      return { operation_result_ref: resultRef, output_artifacts: outputs };
    },
    registerRemoteCancellation: (callback) => cancellations.push(callback),
  };
  return { context, persisted, fetched, accepted, cancellations };
}

function directive(input: {
  readonly declaration: HostOperationDeclarationV1;
  readonly request_ref: ArtifactRef;
  readonly inputs: { readonly slot: string; readonly ref: ArtifactRef }[];
  readonly backend_key_sha256: string;
}): InvokeHostOperationDirectiveV1 {
  return {
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity: {
      schema_version: 2,
      run_id: "run-video-test",
      session_id: "session-video-test",
      playbook: "videogen-test-playbook",
      engine_owner: "typescript",
    },
    state_id: "state-video-test",
    attempt: 1,
    operation_id: "video-operation",
    operation_kind: input.declaration.operation_kind,
    registration_sha256: "a".repeat(64),
    request_ref: input.request_ref,
    request_sha256: input.request_ref.content_digest,
    input_artifacts: { schema_version: 2, artifacts: input.inputs },
    expected_result: input.declaration.result,
    policy_binding: {
      schema_version: 1,
      declaration_sha256: "b".repeat(64),
      adapter_id: input.declaration.adapter_id,
      backend_binding_id: input.declaration.backend_binding_id,
      backend_key_sha256: input.backend_key_sha256,
      lease_profile_id: input.declaration.lease_profile.profile_id,
      lease_profile_sha256: input.declaration.lease_profile.profile_sha256,
      operation_inactivity_ms: input.declaration.operation_inactivity_ms,
    },
  };
}

function snapshotFixture(port: number, mode: "t2v" | "i2v") {
  const profile = syntheticVideogenProfile({ port, mode });
  const registry = new StaticVideogenProfileRegistry({
    profiles: [profile],
    approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
  });
  const snapshot = validateVideogenProfileSnapshot({
    schema_id: "penny.videogen-profile-snapshot.v1",
    schema_version: 1,
    profile,
    approved_profile_sha256: profile.profile_sha256,
    source_graph_sha256: profile.source_graph_sha256,
  });
  const bytes = Buffer.from(canonicalJson(snapshot));
  const ref = artifactRef({
    id: `profile-${mode}`,
    kind: "videogen-profile-snapshot",
    media_type: "application/json",
    schema_id: "penny.videogen-profile-snapshot.v1",
    bytes,
  });
  return { profile, registry, snapshot, bytes, ref };
}

function generationFixture(input: {
  readonly port: number;
  readonly lifecycle?: HostOperationCallRecordV1["lifecycle"];
  readonly remote_correlation_id?: string;
  readonly prior_fetched?: HostOperationFetchedV1;
  readonly cached_bytes?: Uint8Array;
  readonly upload?: { readonly receipt: VideoReferenceUploadReceiptV1; readonly ref: ArtifactRef };
}) {
  const base = snapshotFixture(input.port, input.upload === undefined ? "t2v" : "i2v");
  const submitted = buildVideoSubmittedGraph({
    run_id: "run-video-test",
    shot_id: "shot-1",
    profile_snapshot: base.snapshot,
    profile_snapshot_ref: base.ref,
    spec: {
      mode: base.profile.mode,
      positive_prompt: "a blue square moves slowly",
      negative_prompt: "flicker",
      seed: 91,
      dimensions: { width: 64, height: 64 },
      frame_count: 3,
      fps: 3,
    },
    input_upload_receipt: input.upload?.receipt ?? null,
    input_upload_receipt_ref: input.upload?.ref ?? null,
  });
  const graphBytes = Buffer.from(canonicalJson(submitted));
  const graphRef = artifactRef({
    id: "video-submitted-graph",
    kind: "video-submitted-graph",
    media_type: "application/json",
    schema_id: "penny.video-submitted-graph.v1",
    bytes: graphBytes,
  });
  const operationRequest = {
    schema_id: "penny.video-generation-operation-request.v1",
    schema_version: 1,
    run_id: submitted.run_id,
    shot_id: submitted.shot_id,
    profile_id: submitted.profile_id,
    profile_sha256: submitted.profile_sha256,
    profile_snapshot_ref: base.ref,
    submitted_graph_ref: graphRef,
    submitted_graph_sha256: sha256(graphBytes),
    mode: submitted.mode,
    dimensions: submitted.dimensions,
    frame_count: submitted.frame_count,
    fps: submitted.fps,
  };
  const requestBytes = Buffer.from(canonicalJson(operationRequest));
  const requestRef = artifactRef({
    id: "video-generation-request",
    kind: "video-generation-operation-request",
    media_type: "application/json",
    schema_id: "penny.video-generation-operation-request.v1",
    bytes: requestBytes,
  });
  const declaration = createComfyVideogenDeclaration({
    backend_binding_id: "synthetic-video-backend",
    lease_profile_id: "synthetic-video-lease",
    lease_duration_ms: 60_000,
    lease_renew_after_ms: 10_000,
    queue_inactivity_ms: 5_000,
    operation_inactivity_ms: 120_000,
    max_request_bytes: 65_536,
    max_input_bytes: 262_144,
    max_output_bytes: 2_000_000,
    max_progress_events: 32,
  });
  const operationDirective = directive({
    declaration,
    request_ref: requestRef,
    inputs: [
      { slot: "profile_snapshot", ref: base.ref },
      { slot: "submitted_graph", ref: graphRef },
      ...(input.upload === undefined
        ? []
        : [{ slot: "input_upload_receipt", ref: input.upload.ref }]),
    ],
    backend_key_sha256: base.registry.resolve(base.profile.profile_id).backend_key_sha256,
  });
  const test = testContext({
    declaration,
    directive: operationDirective,
    request_bytes: requestBytes,
    inputs: new Map([
      ["profile_snapshot", { ref: base.ref, bytes: base.bytes }],
      ["submitted_graph", { ref: graphRef, bytes: graphBytes }],
      ...(input.upload === undefined
        ? []
        : [
            [
              "input_upload_receipt",
              {
                ref: input.upload.ref,
                bytes: Buffer.from(canonicalJson(input.upload.receipt)),
              },
            ] satisfies [string, { ref: ArtifactRef; bytes: Uint8Array }],
          ]),
    ]),
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
    ...(input.remote_correlation_id === undefined
      ? {}
      : { remote_correlation_id: input.remote_correlation_id }),
    ...(input.prior_fetched === undefined ? {} : { prior_fetched: input.prior_fetched }),
    ...(input.cached_bytes === undefined ? {} : { cached_bytes: input.cached_bytes }),
  });
  return {
    ...base,
    submitted,
    graphBytes,
    graphRef,
    adapter: new ComfyVideogenOperationAdapter({ legacy_http: true, profiles: base.registry }),
    ...test,
  };
}

function uploadFixture(port: number) {
  const base = snapshotFixture(port, "i2v");
  const png = encodeCanonicalPng({
    width: 2,
    height: 2,
    rgba: Uint8Array.from([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]),
  });
  const pngRef = artifactRef({
    id: "canonical-video-reference",
    kind: "canonical-png",
    media_type: "image/png",
    schema_id: "penny.canonical-png.v1",
    bytes: png,
  });
  const request = validateVideoReferenceUploadOperationRequest({
    schema_id: "penny.video-reference-upload-operation-request.v1",
    schema_version: 1,
    run_id: "run-video-test",
    profile_id: base.profile.profile_id,
    profile_sha256: base.profile.profile_sha256,
    profile_snapshot_ref: base.ref,
    canonical_png_ref: pngRef,
    canonical_png_sha256: sha256(png),
  });
  const requestBytes = Buffer.from(canonicalJson(request));
  const requestRef = artifactRef({
    id: "video-upload-request",
    kind: "video-reference-upload-operation-request",
    media_type: "application/json",
    schema_id: "penny.video-reference-upload-operation-request.v1",
    bytes: requestBytes,
  });
  const declaration = createComfyVideoUploadDeclaration({
    backend_binding_id: "synthetic-video-backend",
    lease_profile_id: "synthetic-video-upload-lease",
    lease_duration_ms: 60_000,
    lease_renew_after_ms: 10_000,
    queue_inactivity_ms: 5_000,
    operation_inactivity_ms: 60_000,
    max_request_bytes: 65_536,
    max_input_bytes: 2_000_000,
    max_output_bytes: 65_536,
    max_progress_events: 16,
  });
  const uploadDirective = directive({
    declaration,
    request_ref: requestRef,
    inputs: [
      { slot: "profile_snapshot", ref: base.ref },
      { slot: "canonical_png", ref: pngRef },
    ],
    backend_key_sha256: base.registry.resolve(base.profile.profile_id).backend_key_sha256,
  });
  const test = testContext({
    declaration,
    directive: uploadDirective,
    request_bytes: requestBytes,
    inputs: new Map([
      ["profile_snapshot", { ref: base.ref, bytes: base.bytes }],
      ["canonical_png", { ref: pngRef, bytes: png }],
    ]),
  });
  return {
    ...base,
    png,
    pngRef,
    adapter: new ComfyVideogenUploadOperationAdapter({
      legacy_http: true,
      profiles: base.registry,
    }),
    ...test,
  };
}

/** Deterministic protocol evidence only: never deployed qualification. */
function cancelAuthorityInput(fixture: ReturnType<typeof generationFixture>) {
  return syntheticCancellationEvidence(fixture.registry.resolve(fixture.profile.profile_id));
}

async function runAdapter(
  adapter: HostOperationAdapterV1,
  context: HostOperationExecutionContextV1
) {
  return await adapter.run(context);
}

describe("host-only Comfy video generation adapter", () => {
  it("preflights, submits, polls, caches, validates, and persists one exact MP4", async () => {
    let posts = 0;
    let polls = 0;
    const port = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") respondJson(response, syntheticVideogenInventory());
      else if (request.url === "/prompt") {
        posts += 1;
        request.resume();
        respondJson(response, { prompt_id: "prompt-video-1", number: 1, node_errors: {} });
      } else if (request.url === "/history/prompt-video-1") {
        polls += 1;
        respondJson(
          response,
          polls === 1
            ? {}
            : {
                "prompt-video-1": {
                  status: { completed: true, status_str: "success" },
                  outputs: {
                    "7": {
                      images: [{ filename: "video.mp4", subfolder: "video/penny", type: "output" }],
                    },
                  },
                },
              }
        );
      } else if (request.url?.startsWith("/view?")) {
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": VIDEO.byteLength,
        });
        response.end(VIDEO);
      } else response.writeHead(404).end();
    });
    const fixture = generationFixture({ port });
    const terminal = await runAdapter(fixture.adapter, fixture.context);
    expect(terminal.disposition.outcome).toBe("completed");
    expect(posts).toBe(1);
    expect(fixture.accepted).toEqual(["prompt-video-1"]);
    const cached = requireValue(await fixture.context.readCachedResult(), "durable envelope");
    const decoded = decodeVideogenFetchedCache(
      cached.bytes,
      fixture.context.declaration.max_output_bytes
    );
    expect(decoded.header).toEqual({
      schema_id: "penny.videogen-fetched-cache.v1",
      schema_version: 1,
      operation_record_id: fixture.context.journal.operation_record_id,
      directive_sha256: sha256(canonicalJson(fixture.context.directive)),
      request_sha256: fixture.context.directive.request_sha256,
      prompt_id_sha256: sha256("prompt-video-1"),
      remote_descriptor: { filename: "video.mp4", subfolder: "video/penny", type: "output" },
      media_type: "video/mp4",
      video_sha256: sha256(VIDEO),
      video_byte_length: VIDEO.byteLength,
    });
    expect(Buffer.from(decoded.video).equals(VIDEO)).toBe(true);
    expect(fixture.fetched).toEqual([
      {
        schema_version: 1,
        content_sha256: sha256(cached.bytes),
        byte_length: cached.bytes.byteLength,
        item_count: 1,
        poll_count: 2,
      },
    ]);
    expect(terminal.output_artifacts.map((entry) => entry.kind)).toEqual([
      "video-validation-receipt",
      "generated-video",
    ]);
    const receipt = validateVideoGenerationOperationReceipt(
      JSON.parse(Buffer.from(fixture.persisted[0]?.operation_result.content ?? "").toString("utf8"))
    );
    expect(receipt.status).toBe("persisted");
    expect(receipt.validation).toMatchObject({
      status: "valid",
      metadata: { width: 64, height: 64, frame_count: 3, fps: 3 },
    });
    const validation = validateVideoValidationReceipt(
      JSON.parse(Buffer.from(fixture.persisted[0]?.outputs?.[0]?.content ?? "").toString("utf8"))
    );
    expect(validation.validation.status).toBe("valid");
    expect(fixture.cancellations).toHaveLength(1);
  });

  it("persists an invalid receipt but no video for non-MP4 output", async () => {
    const invalid = Buffer.from("not a video");
    const port = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") respondJson(response, syntheticVideogenInventory());
      else if (request.url === "/prompt") {
        request.resume();
        respondJson(response, { prompt_id: "prompt-invalid", number: 1, node_errors: {} });
      } else if (request.url === "/history/prompt-invalid") {
        respondJson(response, {
          "prompt-invalid": {
            status: { completed: true, status_str: "success" },
            outputs: {
              "7": { images: [{ filename: "bad.mp4", subfolder: "", type: "output" }] },
            },
          },
        });
      } else if (request.url?.startsWith("/view?")) {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(invalid);
      } else response.writeHead(404).end();
    });
    const fixture = generationFixture({ port });
    const terminal = await runAdapter(fixture.adapter, fixture.context);
    expect(terminal.disposition).toMatchObject({
      outcome: "failed",
      reason_code: "downloaded_invalid",
    });
    expect(terminal.output_artifacts.map((entry) => entry.kind)).toEqual([
      "video-validation-receipt",
    ]);
    const receipt = validateVideoGenerationOperationReceipt(
      JSON.parse(Buffer.from(fixture.persisted[0]?.operation_result.content ?? "").toString("utf8"))
    );
    expect(receipt).toMatchObject({
      status: "downloaded_invalid",
      validation: { status: "invalid", reason_code: "wrong_media_type" },
    });
  });

  it("recovers an accepted prompt without submitting a duplicate", async () => {
    let posts = 0;
    const port = await listen((request, response) => {
      if (request.url === "/prompt") {
        posts += 1;
        response.writeHead(500).end();
      } else if (request.url === "/history/prompt-recovered") {
        respondJson(response, {
          "prompt-recovered": {
            status: { completed: true, status_str: "success" },
            outputs: {
              "7": {
                images: [{ filename: "recovered.mp4", subfolder: "", type: "output" }],
              },
            },
          },
        });
      } else if (request.url?.startsWith("/view?")) {
        response.writeHead(200, { "Content-Type": "video/mp4" });
        response.end(VIDEO);
      } else response.writeHead(404).end();
    });
    const fixture = generationFixture({
      port,
      lifecycle: "submitted",
      remote_correlation_id: "prompt-recovered",
    });
    const terminal = await runAdapter(fixture.adapter, fixture.context);
    expect(terminal.disposition.outcome).toBe("completed");
    expect(posts).toBe(0);
  });

  it("recovers the durable fetched bytes without resubmitting or changing the fetch milestone", async () => {
    let posts = 0;
    const port = await listen((request, response) => {
      if (request.url === "/prompt") {
        posts += 1;
        response.writeHead(500).end();
      } else if (request.url === "/history/prompt-fetched") {
        respondJson(response, {
          "prompt-fetched": {
            status: { completed: true, status_str: "success" },
            outputs: {
              "7": {
                images: [{ filename: "fetched.mp4", subfolder: "", type: "output" }],
              },
            },
          },
        });
      } else if (request.url?.startsWith("/view?")) {
        response.writeHead(200, { "Content-Type": "video/mp4" });
        response.end(VIDEO);
      } else response.writeHead(404).end();
    });
    const fixture = generationFixture({ port });
    const cache = encodeVideogenFetchedCache(
      {
        schema_id: "penny.videogen-fetched-cache.v1",
        schema_version: 1,
        operation_record_id: fixture.context.journal.operation_record_id,
        directive_sha256: sha256(canonicalJson(fixture.context.directive)),
        request_sha256: fixture.context.directive.request_sha256,
        prompt_id_sha256: sha256("prompt-fetched"),
        remote_descriptor: { filename: "fetched.mp4", subfolder: "", type: "output" },
        media_type: "video/mp4",
        video_sha256: sha256(VIDEO),
        video_byte_length: VIDEO.byteLength,
      },
      VIDEO,
      fixture.context.declaration.max_output_bytes
    );
    await fixture.context.cacheResult(cache);
    const priorFetched: HostOperationFetchedV1 = {
      schema_version: 1,
      content_sha256: sha256(cache),
      byte_length: cache.byteLength,
      item_count: 1,
      poll_count: 7,
    };
    const terminal = await runAdapter(fixture.adapter, {
      ...fixture.context,
      journal: {
        ...fixture.context.journal,
        lifecycle: "fetched",
        remote_correlation_id: "prompt-fetched",
        remote_correlation_sha256: sha256("prompt-fetched"),
        fetched: priorFetched,
      },
    });
    expect(terminal.disposition.outcome).toBe("completed");
    expect(posts).toBe(0);
    expect(fixture.fetched).toEqual([priorFetched]);
    const receipt = validateVideoGenerationOperationReceipt(
      JSON.parse(Buffer.from(fixture.persisted[0]?.operation_result.content ?? "").toString("utf8"))
    );
    expect(receipt.poll_count).toBe(7);
  });

  it("constructor evidence cannot interrupt; polling exhaustion still needs exact terminal observation", async () => {
    let interruptedPrompt: string | null = null;
    let histories = 0;
    const port = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") respondJson(response, syntheticVideogenInventory());
      else if (request.url === "/prompt") {
        request.resume();
        respondJson(response, { prompt_id: "prompt-timeout", number: 1, node_errors: {} });
      } else if (request.url === "/interrupt") {
        void requestBody(request).then((bytes) => {
          const parsed: unknown = JSON.parse(bytes.toString("utf8"));
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            "prompt_id" in parsed &&
            typeof parsed.prompt_id === "string"
          ) {
            interruptedPrompt = parsed.prompt_id;
          }
          respondJson(response, {});
        });
      } else if (request.url === "/history/prompt-timeout") {
        histories += 1;
        respondJson(
          response,
          histories <= 8
            ? {}
            : {
                "prompt-timeout": {
                  status: { completed: true, status_str: "error" },
                  outputs: {},
                },
              }
        );
      } else response.writeHead(404).end();
    });
    const fixture = generationFixture({ port });
    const adapter = new ComfyVideogenOperationAdapter({
      legacy_http: true,
      profiles: fixture.registry,
      cancellation_authority: new VideogenPromptCancellationAuthorityV1(
        cancelAuthorityInput(fixture)
      ),
    });
    const terminal = await runAdapter(adapter, fixture.context);
    expect(interruptedPrompt).toBeNull();
    expect(histories).toBe(9);
    expect(terminal.disposition).toMatchObject({
      outcome: "failed",
      remote_disposition: "proven_terminal",
      reason_code: "polling_exhausted_terminal_observed",
    });
  });

  it("fails inventory drift and duplicate terminal outputs before downloading", async () => {
    for (const mode of ["inventory", "duplicate"] as const) {
      let posts = 0;
      let views = 0;
      const port = await listen((request, response) => {
        if (request.url === "/system_stats") respondJson(response, { ready: true });
        else if (request.url === "/object_info") {
          respondJson(
            response,
            mode === "inventory"
              ? syntheticVideogenInventory("wrong-model.safetensors")
              : syntheticVideogenInventory()
          );
        } else if (request.url === "/prompt") {
          posts += 1;
          request.resume();
          respondJson(response, { prompt_id: "prompt-duplicate", number: 1, node_errors: {} });
        } else if (request.url === "/history/prompt-duplicate") {
          respondJson(response, {
            "prompt-duplicate": {
              status: { completed: true, status_str: "success" },
              outputs: {
                "7": {
                  images: [
                    { filename: "one.mp4", subfolder: "", type: "output" },
                    { filename: "two.mp4", subfolder: "", type: "output" },
                  ],
                },
              },
            },
          });
        } else if (request.url?.startsWith("/view?")) {
          views += 1;
          response.writeHead(500).end();
        } else response.writeHead(404).end();
      });
      const fixture = generationFixture({ port });
      const terminal = await runAdapter(fixture.adapter, fixture.context);
      expect(terminal.disposition.outcome).toBe("failed");
      if (mode === "inventory") expect(posts).toBe(0);
      expect(views).toBe(0);
    }
  });
});

describe("host-only Comfy video reference upload adapter", () => {
  it("uploads one canonical PNG, re-fetches its exact bytes, and persists a receipt", async () => {
    let uploads = 0;
    let expectedPng = Buffer.alloc(0);
    const port = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/upload/image") {
        uploads += 1;
        request.resume();
        respondJson(response, {
          name: `${sha256(expectedPng)}.png`,
          subfolder: "penny/videogen",
          type: "input",
        });
      } else if (request.url?.startsWith("/view?")) {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(expectedPng);
      } else response.writeHead(404).end();
    });
    const fixture = uploadFixture(port);
    expectedPng = Buffer.from(fixture.png);
    const terminal = await runAdapter(fixture.adapter, fixture.context);
    expect(terminal.disposition.outcome).toBe("completed");
    expect(uploads).toBe(1);
    expect(fixture.accepted).toEqual([`upload-${sha256(fixture.png)}`]);
    const receipt = validateVideoReferenceUploadReceipt(
      JSON.parse(Buffer.from(fixture.persisted[0]?.operation_result.content ?? "").toString("utf8"))
    );
    expect(receipt).toMatchObject({
      status: "uploaded_verified",
      canonical_png_sha256: sha256(fixture.png),
      remote_descriptor: {
        filename: `${sha256(fixture.png)}.png`,
        subfolder: "penny/videogen",
        type: "input",
      },
    });
    expect(fixture.context.directive.expected_result).toEqual(
      VIDEO_REFERENCE_UPLOAD_RECEIPT_CONTRACT
    );
  });

  it("recovers an accepted upload by exact locator without uploading a duplicate", async () => {
    let uploads = 0;
    let expectedPng = Buffer.alloc(0);
    const port = await listen((request, response) => {
      if (request.url === "/upload/image") {
        uploads += 1;
        response.writeHead(500).end();
      } else if (request.url?.startsWith("/view?")) {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(expectedPng);
      } else response.writeHead(404).end();
    });
    const fixture = uploadFixture(port);
    expectedPng = Buffer.from(fixture.png);
    const correlationId = `upload-${sha256(fixture.png)}`;
    const recoveredContext: HostOperationExecutionContextV1 = {
      ...fixture.context,
      journal: {
        ...fixture.context.journal,
        lifecycle: "submitted",
        remote_correlation_id: correlationId,
        remote_correlation_sha256: sha256(correlationId),
      },
    };
    const terminal = await runAdapter(fixture.adapter, recoveredContext);
    expect(terminal.disposition.outcome).toBe("completed");
    expect(uploads).toBe(0);
  });

  it("treats a post-request disconnect as ambiguous instead of retrying", async () => {
    const port = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/upload/image") request.socket.destroy();
      else response.writeHead(404).end();
    });
    const fixture = uploadFixture(port);
    await expect(runAdapter(fixture.adapter, fixture.context)).rejects.toMatchObject({
      submission_disposition: "unknown",
    });
  });
});

describe("bounded VG-WP-010 render safety", () => {
  it.each(["matching", "swapped", "deleted", "short", "wrong-type"] as const)(
    "rechecks the original I2V upload immediately before prompt: %s",
    async (state) => {
      const requests: string[] = [];
      let png = Buffer.alloc(0);
      let uploaded = false;
      let render = false;
      let guarded = false;
      const port = await listen((request, response) => {
        const path = request.url ?? "";
        requests.push(path);
        if (path === "/system_stats") respondJson(response, { ready: true });
        else if (path === "/object_info") respondJson(response, syntheticVideogenInventory());
        else if (path === "/upload/image") {
          uploaded = true;
          request.resume();
          respondJson(response, {
            name: `${sha256(png)}.png`,
            subfolder: "penny/videogen",
            type: "input",
          });
        } else if (path.startsWith("/view?")) {
          const query = new URL(path, "http://127.0.0.1").searchParams;
          if (query.get("type") === "output") {
            response.writeHead(200, { "Content-Type": "video/mp4" }).end(VIDEO);
          } else {
            expect(uploaded).toBe(true);
            expect(query.get("filename")).toBe(`${sha256(png)}.png`);
            expect(query.get("subfolder")).toBe("penny/videogen");
            if (render) expect(guarded).toBe(true);
            if (render && state === "deleted") response.writeHead(404).end();
            else
              response
                .writeHead(200, {
                  "Content-Type": render && state === "wrong-type" ? "text/plain" : "image/png",
                })
                .end(
                  render && state === "swapped"
                    ? Buffer.alloc(png.byteLength, 7)
                    : render && state === "short"
                      ? png.subarray(0, png.byteLength - 1)
                      : png
                );
          }
        } else if (path === "/prompt") {
          request.resume();
          respondJson(response, { prompt_id: "safe-i2v", number: 1, node_errors: {} });
        } else if (path === "/history/safe-i2v")
          respondJson(response, {
            "safe-i2v": {
              status: { completed: true, status_str: "success" },
              outputs: {
                "7": { images: [{ filename: "clip.mp4", subfolder: "", type: "output" }] },
              },
            },
          });
        else response.writeHead(404).end();
      });
      const upload = uploadFixture(port);
      png = Buffer.from(upload.png);
      const uploadedResult = await runAdapter(upload.adapter, upload.context);
      expect(uploadedResult.disposition.outcome).toBe("completed");
      const persisted = upload.persisted[0];
      if (persisted === undefined || uploadedResult.operation_result_ref === null)
        throw new Error("upload receipt missing");
      const receipt = validateVideoReferenceUploadReceipt(
        JSON.parse(Buffer.from(persisted.operation_result.content).toString("utf8"))
      );
      const fixture = generationFixture({
        port,
        upload: { receipt, ref: uploadedResult.operation_result_ref },
      });
      render = true;
      requests.length = 0;
      const result = await runAdapter(fixture.adapter, {
        ...fixture.context,
        beginSubmission: () => {
          guarded = true;
        },
      });
      const promptIndex = requests.indexOf("/prompt");
      if (state === "matching") {
        expect(result.disposition.outcome).toBe("completed");
        expect(requests.slice(0, promptIndex)).toEqual([
          "/system_stats",
          "/object_info",
          `/view?filename=${sha256(png)}.png&subfolder=penny%2Fvideogen&type=input`,
        ]);
        expect(promptIndex).toBe(3);
      } else {
        expect(promptIndex).toBe(-1);
        expect(result.disposition).toMatchObject({
          outcome: "failed",
          remote_disposition: "proven_not_accepted",
          retryable: false,
        });
      }
      expect(requests.filter((path) => path === "/upload/image")).toEqual([]);
    }
  );

  it.each(["missing", "backend-drift", "profile-drift"] as const)(
    "never interrupts without matching host identity: %s",
    async (qualification) => {
      let interrupts = 0;
      const paths: string[] = [];
      const port = await listen((request, response) => {
        const path = request.url ?? "";
        paths.push(path);
        if (path === "/system_stats") respondJson(response, { ready: true });
        else if (path === "/object_info") respondJson(response, syntheticVideogenInventory());
        else if (path === "/prompt") {
          request.resume();
          respondJson(response, { prompt_id: "owned-prompt", number: 1, node_errors: {} });
        } else if (path === "/interrupt") {
          interrupts += 1; // This fake endpoint would interrupt every owner's job.
          request.resume();
          respondJson(response, {});
        } else if (path === "/history/owned-prompt") respondJson(response, {});
        else response.writeHead(404).end();
      });
      const fixture = generationFixture({ port });
      const authorityInput = cancelAuthorityInput(fixture);
      const current = authorityInput.current_bindings[0];
      const registered = authorityInput.registrations[0];
      if (current === undefined || registered === undefined)
        throw new Error("missing synthetic authority");
      if (qualification !== "missing") {
        const changed =
          qualification === "backend-drift"
            ? { backend_key_sha256: sha256("different worker") }
            : { profile_sha256: sha256("different profile version") };
        const evidence: unknown = JSON.parse(registered.evidence_json);
        if (evidence === null || typeof evidence !== "object") throw new Error("invalid evidence");
        Object.assign(current, changed);
        Object.assign(registered.binding, changed);
        registered.evidence_json = canonicalJson({ ...evidence, binding: registered.binding });
        registered.approved_evidence_sha256 = sha256(registered.evidence_json);
      }
      const adapter = new ComfyVideogenOperationAdapter({
        legacy_http: true,
        profiles: fixture.registry,
        ...(qualification === "missing"
          ? {}
          : { cancellation_authority: new VideogenPromptCancellationAuthorityV1(authorityInput) }),
      });
      const result = await runAdapter(adapter, fixture.context);
      expect(interrupts).toBe(0);
      expect(result.disposition).toMatchObject({
        outcome: "remote_unknown",
        lease_disposition: "quarantined",
        remote_disposition: "may_continue",
      });
      const observe = fixture.cancellations[0];
      if (observe === undefined) throw new Error("cleanup observer absent");
      expect(await observe(new AbortController().signal)).toMatchObject({
        remote_disposition: "may_continue",
      });
      expect(interrupts).toBe(0);
      expect(paths.filter((path) => path === "/prompt")).toHaveLength(1);
      expect(
        paths.some((path) => path.startsWith("/history/") && path !== "/history/owned-prompt")
      ).toBe(false);
    }
  );

  it.each(["missing-history", "false-completed", "foreign-history"] as const)(
    "external exact-target 2xx interrupt does not prove stop or grant authority: %s",
    async (state) => {
      const bodies: string[] = [];
      const paths: string[] = [];
      const port = await listen((request, response) => {
        const path = request.url ?? "";
        paths.push(path);
        if (path === "/system_stats") respondJson(response, { ready: true });
        else if (path === "/object_info") respondJson(response, syntheticVideogenInventory());
        else if (path === "/prompt") {
          request.resume();
          respondJson(response, { prompt_id: "ambiguous-stop", number: 1, node_errors: {} });
        } else if (path === "/interrupt")
          void requestBody(request).then((body) => {
            bodies.push(body.toString("utf8"));
            respondJson(response, {});
          });
        else if (path === "/history/ambiguous-stop")
          respondJson(
            response,
            state === "missing-history"
              ? {}
              : state === "foreign-history"
                ? {
                    "another-owner": {
                      status: { completed: true, status_str: "error" },
                      outputs: {},
                    },
                  }
                : {
                    "ambiguous-stop": {
                      status: { completed: false, status_str: "error" },
                      outputs: {},
                    },
                  }
          );
        else response.writeHead(404).end();
      });
      const fixture = generationFixture({ port });
      const adapter = new ComfyVideogenOperationAdapter({
        legacy_http: true,
        profiles: fixture.registry,
        cancellation_authority: new VideogenPromptCancellationAuthorityV1(
          cancelAuthorityInput(fixture)
        ),
      });
      // A direct local protocol test is not a cancellation authorization or live qualification.
      const client = new ComfyHttpClient(fixture.profile.endpoint, {
        max_request_bytes: 65_536,
        max_readiness_bytes: 65_536,
        max_inventory_bytes: 65_536,
        max_history_bytes: 65_536,
        max_image_bytes: 65_536,
        max_upload_bytes: 65_536,
        max_video_bytes: 2_000_000,
        connect_timeout_ms: 1_000,
        read_timeout_ms: 1_000,
      });
      await client.interrupt({ prompt_id: "ambiguous-stop", signal: new AbortController().signal });
      const result = await runAdapter(adapter, fixture.context);
      expect(result.disposition).toMatchObject({
        outcome: "remote_unknown",
        lease_disposition: "quarantined",
      });
      // Foreign history fails polling before exhaustion, so cleanup is exercised separately.
      if (state === "foreign-history") {
        const observe = fixture.cancellations[0];
        if (observe === undefined) throw new Error("observer absent");
        expect(await observe(new AbortController().signal)).toMatchObject({
          remote_disposition: "may_continue",
        });
      }
      expect(bodies).toEqual([canonicalJson({ prompt_id: "ambiguous-stop" })]);
      expect(
        paths
          .filter((path) => path.startsWith("/history/"))
          .every((path) => path === "/history/ambiguous-stop")
      ).toBe(true);
      expect(paths.filter((path) => path === "/prompt")).toHaveLength(1);
    }
  );

  it("observes exact terminal history without interrupt when qualification is absent", async () => {
    let histories = 0;
    let interrupts = 0;
    const port = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") respondJson(response, syntheticVideogenInventory());
      else if (request.url === "/prompt") {
        request.resume();
        respondJson(response, { prompt_id: "naturally-stopped", number: 1, node_errors: {} });
      } else if (request.url === "/interrupt") {
        interrupts += 1;
        request.resume();
        respondJson(response, {});
      } else if (request.url === "/history/naturally-stopped") {
        histories += 1;
        respondJson(
          response,
          histories <= 8
            ? {}
            : {
                "naturally-stopped": {
                  status: { completed: true, status_str: "error" },
                  outputs: {},
                },
              }
        );
      } else response.writeHead(404).end();
    });
    const fixture = generationFixture({ port });
    const result = await runAdapter(fixture.adapter, fixture.context);
    expect(interrupts).toBe(0);
    expect(histories).toBe(9);
    expect(result.disposition).toMatchObject({
      outcome: "failed",
      remote_disposition: "proven_terminal",
      lease_disposition: "released",
    });
  });

  it("rejects unqualified, forged, stale-version and mismatched evidence at host construction", () => {
    const fixture = generationFixture({ port: 1 }); // Never connected.
    const valid = cancelAuthorityInput(fixture);
    const registration = valid.registrations[0];
    const binding = valid.current_bindings[0];
    if (registration === undefined || binding === undefined)
      throw new Error("synthetic registration absent");
    expect(() => new VideogenPromptCancellationAuthorityV1(true)).toThrow();
    expect(() => new VideogenPromptCancellationAuthorityV1({ qualifies: () => true })).toThrow();
    expect(() => new VideogenPromptCancellationAuthorityV1({ ...valid, extra: true })).toThrow();
    expect(
      () =>
        new VideogenPromptCancellationAuthorityV1({
          ...valid,
          registrations: [
            { ...registration, approved_evidence_sha256: sha256("unapproved evidence") },
          ],
        })
    ).toThrow();
    expect(
      () =>
        new VideogenPromptCancellationAuthorityV1({
          ...valid,
          current_bindings: [{ ...binding, deployed_version_sha256: sha256("upgraded server") }],
        })
    ).toThrow();
    expect(
      () =>
        new VideogenPromptCancellationAuthorityV1({
          ...valid,
          registrations: [{ ...registration, binding: { ...binding, profile_schema_version: 2 } }],
        })
    ).toThrow();
    const authority = new VideogenPromptCancellationAuthorityV1(valid);
    binding.profile_sha256 = sha256("mutated original input");
    registration.evidence_json = "{}";
    expect(isConcreteVideogenPromptCancellationAuthorityV1(authority)).toBe(true);
    expect(Object.isFrozen(authority)).toBe(true);
  });
});

describe("render-safety input and authority drift", () => {
  it.each(["profile_snapshot", "submitted_graph"])(
    "refuses changed exact %s bytes before backend I/O",
    async (slot) => {
      let requests = 0;
      const port = await listen((_request, response) => {
        requests += 1;
        response.writeHead(500).end();
      });
      const fixture = generationFixture({ port });
      const result = await runAdapter(fixture.adapter, {
        ...fixture.context,
        readInput: (name) => {
          const exact = fixture.context.readInput(name);
          return name === slot
            ? { ref: exact.ref, bytes: Buffer.concat([exact.bytes, Buffer.from(" ")]) }
            : exact;
        },
      });
      expect(requests).toBe(0);
      expect(result.disposition).toMatchObject({
        outcome: "failed",
        reason_code: "operation_input_drift",
      });
    }
  );

  it.each(["locator", "canonical-digest", "canonical-length", "receipt-length"] as const)(
    "refuses %s identity drift rather than finding another input",
    async (state) => {
      let requests = 0;
      const port = await listen((_request, response) => {
        requests += 1;
        response.writeHead(500).end();
      });
      const upload = uploadFixture(port);
      const receipt = validateVideoReferenceUploadReceipt({
        schema_id: "penny.video-reference-upload-receipt.v1",
        schema_version: 1,
        run_id: "run-video-test",
        profile_id: upload.profile.profile_id,
        profile_sha256: upload.profile.profile_sha256,
        canonical_png_ref: {
          ...upload.pngRef,
          ...(state === "canonical-digest" ? { content_digest: sha256("different PNG") } : {}),
          ...(state === "canonical-length" ? { byte_length: upload.png.byteLength + 1 } : {}),
        },
        canonical_png_sha256: sha256(upload.png),
        canonical_png_bytes: upload.png.byteLength + (state === "receipt-length" ? 1 : 0),
        remote_descriptor: {
          filename: state === "locator" ? "another.png" : `${sha256(upload.png)}.png`,
          subfolder: upload.profile.input_subfolder,
          type: "input",
        },
        status: "uploaded_verified",
      });
      const bytes = Buffer.from(canonicalJson(receipt));
      const ref = artifactRef({
        id: "synthetic-upload-receipt",
        kind: "video-reference-upload-receipt",
        schema_id: receipt.schema_id,
        media_type: "application/json",
        bytes,
      });
      const fixture = generationFixture({ port, upload: { receipt, ref } });
      const result = await runAdapter(fixture.adapter, fixture.context);
      expect(requests).toBe(0);
      expect(result.disposition).toMatchObject({
        outcome: "failed",
        reason_code: "input_upload_identity_drift",
      });
    }
  );

  it("disables a pinned cancellation registration when the host profile changes after acceptance", async () => {
    let drifted = false;
    let interrupts = 0;
    const port = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") respondJson(response, syntheticVideogenInventory());
      else if (request.url === "/prompt") {
        request.resume();
        drifted = true;
        respondJson(response, { prompt_id: "drifted-host", number: 1, node_errors: {} });
      } else if (request.url === "/history/drifted-host") respondJson(response, {});
      else if (request.url === "/interrupt") {
        interrupts += 1;
        request.resume();
        respondJson(response, {});
      } else response.writeHead(404).end();
    });
    const fixture = generationFixture({ port });
    const adapter = new ComfyVideogenOperationAdapter({
      legacy_http: true,
      profiles: {
        resolve: (id) => {
          const resolved = fixture.registry.resolve(id);
          return drifted
            ? {
                ...resolved,
                profile: { ...resolved.profile, profile_sha256: sha256("host-upgraded-profile") },
              }
            : resolved;
        },
        verifySnapshot: (snapshot) => fixture.registry.verifySnapshot(snapshot),
      },
      cancellation_authority: new VideogenPromptCancellationAuthorityV1(
        cancelAuthorityInput(fixture)
      ),
    });
    const result = await runAdapter(adapter, fixture.context);
    expect(interrupts).toBe(0);
    expect(result.disposition).toMatchObject({
      outcome: "remote_unknown",
      lease_disposition: "quarantined",
    });
  });
});

it("quarantines changed input during accepted recovery rather than claiming remote non-acceptance", async () => {
  let requests = 0;
  const port = await listen((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  const fixture = generationFixture({
    port,
    lifecycle: "submitted",
    remote_correlation_id: "still-running",
  });
  const result = await runAdapter(fixture.adapter, {
    ...fixture.context,
    readInput: (slot) => {
      const exact = fixture.context.readInput(slot);
      return slot === "profile_snapshot"
        ? { ref: exact.ref, bytes: Buffer.concat([exact.bytes, Buffer.from(" ")]) }
        : exact;
    },
  });
  expect(requests).toBe(0);
  expect(result.disposition).toMatchObject({
    outcome: "remote_unknown",
    remote_disposition: "may_continue",
    lease_disposition: "quarantined",
  });
});

describe("video fetched envelope identity independent of outer cache integrity", () => {
  it.each(["request", "prompt", "operation", "directive"] as const)(
    "rejects self-consistent cache with changed %s identity before HTTP",
    async (field) => {
      let requests = 0;
      const port = await listen((_request, response) => {
        requests += 1;
        response.writeHead(500).end();
      });
      const fixture = generationFixture({ port });
      const cache = encodeVideogenFetchedCache(
        {
          schema_id: "penny.videogen-fetched-cache.v1",
          schema_version: 1,
          operation_record_id:
            field === "operation"
              ? "foreign-operation"
              : fixture.context.journal.operation_record_id,
          directive_sha256:
            field === "directive"
              ? sha256("foreign directive")
              : sha256(canonicalJson(fixture.context.directive)),
          request_sha256:
            field === "request"
              ? sha256("foreign request")
              : fixture.context.directive.request_sha256,
          prompt_id_sha256: sha256(field === "prompt" ? "foreign-prompt" : "accepted-prompt"),
          remote_descriptor: { filename: "clip.mp4", subfolder: "", type: "output" },
          media_type: "video/mp4",
          video_sha256: sha256(VIDEO),
          video_byte_length: VIDEO.byteLength,
        },
        VIDEO,
        fixture.context.declaration.max_output_bytes
      );
      // Outer digest AND fetched milestone agree. Only the original exact identity can deny.
      await fixture.context.cacheResult(cache);
      const result = await fixture.adapter.run({
        ...fixture.context,
        journal: {
          ...fixture.context.journal,
          lifecycle: "fetched",
          remote_correlation_id: "accepted-prompt",
          remote_correlation_sha256: sha256("accepted-prompt"),
          fetched: {
            schema_version: 1,
            content_sha256: sha256(cache),
            byte_length: cache.byteLength,
            item_count: 1,
            poll_count: 7,
          },
        },
      });
      expect(result.disposition).toMatchObject({
        outcome: "remote_unknown",
        lease_disposition: "quarantined",
        reason_code: "fetched_result_cache_identity_invalid",
      });
      expect(requests).toBe(0);
      expect(fixture.fetched).toEqual([]);
      expect(fixture.persisted).toEqual([]);
      expect(fixture.accepted).toEqual([]);
    }
  );

  it("refuses a video that fits the media ceiling but whose complete cache envelope exceeds registration", async () => {
    const port = await listen((request, response) => {
      if (request.url === "/history/accepted-prompt")
        respondJson(response, {
          "accepted-prompt": {
            status: { completed: true, status_str: "success" },
            outputs: { "7": { images: [{ filename: "clip.mp4", subfolder: "", type: "output" }] } },
          },
        });
      else if (request.url?.startsWith("/view?"))
        response.writeHead(200, { "Content-Type": "video/mp4" }).end(VIDEO);
      else response.writeHead(500).end();
    });
    const fixture = generationFixture({
      port,
      lifecycle: "submitted",
      remote_correlation_id: "accepted-prompt",
    });
    const result = await fixture.adapter.run({
      ...fixture.context,
      declaration: { ...fixture.context.declaration, max_output_bytes: VIDEO.byteLength },
    });
    expect(result.disposition).toMatchObject({
      outcome: "failed",
      remote_disposition: "proven_terminal",
      reason_code: "fetched_result_cache_representation_limit",
    });
    expect(await fixture.context.readCachedResult()).toBeNull();
    expect(fixture.fetched).toEqual([]);
    expect(fixture.persisted).toEqual([]);
    expect(fixture.accepted).toEqual([]);
  });
});

describe("real owner video request-intent and wrapper integration", () => {
  for (const kind of ["render", "upload"] as const)
    it.each(["after_receipt", "after_wrapper_persist"] as const)(
      `${kind} recovers %s with one remote POST`,
      async (point) => {
        let posts = 0;
        const png = encodeCanonicalPng({ width: 2, height: 2, rgba: new Uint8Array(16).fill(255) });
        const port = await listen((request, response) => {
          if (request.url === "/system_stats") respondJson(response, { ready: true });
          else if (request.url === "/object_info")
            respondJson(response, syntheticVideogenInventory());
          else if (request.url === "/prompt") {
            posts++;
            request.resume();
            respondJson(response, {
              prompt_id: "protocol-video-prompt",
              number: 1,
              node_errors: {},
            });
          } else if (request.url === "/upload/image") {
            posts++;
            request.resume();
            respondJson(response, {
              name: `${sha256(png)}.png`,
              subfolder: "penny/videogen",
              type: "input",
            });
          } else if (request.url === "/history/protocol-video-prompt")
            respondJson(response, {
              "protocol-video-prompt": {
                status: { completed: true, status_str: "success" },
                outputs: {
                  "7": {
                    images: [
                      { filename: "protocol.mp4", subfolder: "video/penny", type: "output" },
                    ],
                  },
                },
              },
            });
          else if (request.url?.startsWith("/view?"))
            response
              .writeHead(200, { "Content-Type": kind === "render" ? "video/mp4" : "image/png" })
              .end(kind === "render" ? VIDEO : png);
          else response.writeHead(404).end();
        });
        const base = snapshotFixture(port, kind === "render" ? "t2v" : "i2v");
        const options = {
          effect_protocol: "request_intent_v1" as const,
          backend_binding_id: "protocol-video",
          lease_profile_id: "protocol-video",
          lease_duration_ms: 60_000,
          lease_renew_after_ms: 10_000,
          queue_inactivity_ms: 30_000,
          operation_inactivity_ms: 60_000,
          max_request_bytes: 65_536,
          max_input_bytes: 2_000_000,
          max_output_bytes: 2_000_000,
          max_progress_events: 32,
        };
        const declaration =
          kind === "render"
            ? createComfyVideogenDeclaration(options)
            : createComfyVideoUploadDeclaration(options);
        using f = new HostEffectFixture(
          declaration,
          base.registry.resolve(base.profile.profile_id).backend_key_sha256
        );
        const snapshotRef = f.ref(
          base.snapshot,
          "penny.videogen-profile-snapshot.v1",
          "videogen-profile-snapshot"
        );
        const submitted =
          kind === "render"
            ? buildVideoSubmittedGraph({
                run_id: f.runId,
                shot_id: "protocol-shot",
                profile_snapshot: base.snapshot,
                profile_snapshot_ref: snapshotRef,
                spec: {
                  mode: base.profile.mode,
                  positive_prompt: "blue square moves",
                  negative_prompt: "flicker",
                  seed: 91,
                  dimensions: { width: 64, height: 64 },
                  frame_count: 3,
                  fps: 3,
                },
                input_upload_receipt: null,
                input_upload_receipt_ref: null,
              })
            : { mode: "i2v", dimensions: { width: 64, height: 64 }, frame_count: 3, fps: 3 };
        const graph =
          kind === "render"
            ? f.ref(submitted, "penny.video-submitted-graph.v1", "video-submitted-graph")
            : f.ref(png, "penny.canonical-png.v1", "canonical-png", "image/png");
        const inputs = [
          { slot: "profile_snapshot", ref: snapshotRef },
          { slot: kind === "render" ? "submitted_graph" : "canonical_png", ref: graph },
        ];
        const common = {
          schema_id: declaration.request.schema_id,
          schema_version: 1,
          run_id: f.runId,
          profile_id: base.profile.profile_id,
          profile_sha256: base.profile.profile_sha256,
          profile_snapshot_ref: snapshotRef,
        };
        const request =
          kind === "render"
            ? {
                ...common,
                shot_id: "protocol-shot",
                submitted_graph_ref: graph,
                submitted_graph_sha256: graph.content_digest,
                mode: submitted.mode,
                dimensions: submitted.dimensions,
                frame_count: submitted.frame_count,
                fps: submitted.fps,
              }
            : { ...common, canonical_png_ref: graph, canonical_png_sha256: graph.content_digest };
        const prepared = f.prepare({
          request,
          request_schema:
            kind === "render"
              ? VideoGenerationOperationRequestV1Schema
              : VideoReferenceUploadOperationRequestV1Schema,
          input_refs: inputs.map((x) => x.ref),
          profile_snapshot_ref: snapshotRef,
        });
        const d = f.start(prepared, inputs),
          cache = await FileHostOperationResultCache.provision(join(f.root, "cache"));
        const adapter =
          kind === "render"
            ? new ComfyVideogenOperationAdapter({ legacy_http: true, profiles: base.registry })
            : new ComfyVideogenUploadOperationAdapter({
                legacy_http: true,
                profiles: base.registry,
              });
        await expect(
          f
            .owner(
              adapter,
              (where) => {
                if (where === point) throw new HostOperationSimulatedCrashError(where);
              },
              cache
            )
            .dispatch(f.engine, d)
        ).rejects.toThrow(HostOperationSimulatedCrashError);
        expect(posts).toBe(1);
        const prior = requireValue(
          f.checkpointer.hostOperationCallsForRun(f.runId)[0],
          "settled video record"
        );
        f.reopen();
        await f.owner(adapter, undefined, cache).dispatch(f.engine, d);
        const record = requireValue(
          f.checkpointer.hostOperationCallsForRun(f.runId)[0],
          "consumed video record"
        );
        expect(record.lifecycle).toBe("consumed");
        expect(record.disposition?.outcome).toBe("completed");
        expect(record.host_receipt_ref).toEqual(prior.host_receipt_ref);
        expect(record.operation_result_ref).toEqual(prior.operation_result_ref);
        verifyHostResultWrapper(f.store, record);
        expect(posts).toBe(1);
      }
    );
});
