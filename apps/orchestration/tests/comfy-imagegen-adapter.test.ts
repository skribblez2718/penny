import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, InvokeHostOperationDirectiveV1 } from "../dist/contracts.js";
import {
  ComfyClientError,
  ComfyHttpClient,
  type ComfyClientLimitsV1,
} from "../dist/imagegen/comfy-client.js";
import { buildImageSubmittedGraph } from "../dist/imagegen/graph-builder.js";
import {
  ComfyImagegenOperationAdapter,
  IMAGE_GENERATION_OPERATION_RECEIPT_CONTRACT,
  createComfyImagegenDeclaration,
} from "../dist/imagegen/operation-owner.js";
import { StaticImagegenProfileRegistry } from "../dist/imagegen/profile-registry.js";
import { SqliteImagegenStorageAdmission } from "../dist/imagegen/storage-admission.js";
import type {
  HostOperationCallRecordV1,
  HostOperationExecutionContextV1,
  HostOperationPersistenceInputV1,
} from "../dist/host-operations/contracts.js";
import { encodeCanonicalPng } from "../dist/png-media.js";
import {
  validateImageGenerationOperationReceipt,
  validateImageGenerationOperationRequest,
  validateImagegenRequest,
  type ImageSubmittedGraphV1,
} from "../dist/skill-contracts/imagegen.js";
import {
  SYNTHETIC_NODE_POLICIES,
  syntheticInventory,
  syntheticProfile,
} from "./helpers/imagegen-fixtures.js";

const servers: Array<ReturnType<typeof createServer>> = [];
const stores: SqliteImagegenStorageAdmission[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLIENT_LIMITS: ComfyClientLimitsV1 = {
  max_request_bytes: 65_536,
  max_readiness_bytes: 65_536,
  max_inventory_bytes: 65_536,
  max_history_bytes: 65_536,
  max_image_bytes: 1_048_576,
  connect_timeout_ms: 1_000,
  read_timeout_ms: 1_000,
};

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ readonly port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("test server has no TCP port");
  return { port: address.port };
}

function respondJson(response: ServerResponse, value: unknown): void {
  const body = canonicalJson(value);
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function artifactRef(input: {
  readonly id: string;
  readonly kind: string;
  readonly media_type: string;
  readonly schema_id: string;
  readonly bytes: Uint8Array;
}): ArtifactRef {
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(input.id)}`,
    kind: input.kind,
    run_id: "run-comfy-test",
    phase: "production",
    branch_id: "slot-1",
    operation_id: input.id,
    version: 1,
    producer: "test:imagegen-adapter",
    content_digest: sha256(input.bytes),
    byte_length: input.bytes.byteLength,
    media_type: input.media_type,
    content_schema: { schema_id: input.schema_id, schema_version: 1 },
    store_ref: `artifact://sha256/${sha256(input.bytes)}`,
  };
}

async function operationFixture(
  port: number,
  lifecycle: "lease_acquired" | "submitted" = "lease_acquired",
  mutateSubmitted: (value: ImageSubmittedGraphV1) => ImageSubmittedGraphV1 = (value) => value
) {
  const path = mkdtempSync(join(tmpdir(), "penny-comfy-adapter-"));
  roots.push(path);
  const inventory = syntheticInventory();
  const profile = syntheticProfile({ port, inventory });
  const profiles = new StaticImagegenProfileRegistry({
    profiles: [profile],
    approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
    node_class_policies: SYNTHETIC_NODE_POLICIES,
    default_profile_id: profile.profile_id,
  });
  const storage = new SqliteImagegenStorageAdmission({
    directory: path,
    ceiling_bytes: 16 * 1024 * 1024,
    warning_threshold_bytes: 12 * 1024 * 1024,
  });
  stores.push(storage);
  const reservation = storage.reserve({
    run_id: "run-comfy-test",
    admission_sha256: "d".repeat(64),
    requested_bytes: 2 * 1024 * 1024,
    requested_seed: 91,
  });
  const request = validateImagegenRequest({
    schema_id: "penny.imagegen-request.v1",
    schema_version: 1,
    goal: "Create a tiny image",
    raw_prompt: "blue circle",
    count: 1,
    profile_id: profile.profile_id,
    dimensions: { width: 2, height: 2 },
    seed: reservation.base_seed,
    max_revision_rounds: 1,
    export: null,
  });
  const snapshot = {
    schema_id: "penny.imagegen-profile-snapshot.v1" as const,
    schema_version: 1 as const,
    profile,
    approved_profile_sha256: profile.profile_sha256,
    source_graph_sha256: profile.source_graph_sha256,
  };
  const snapshotBytes = Buffer.from(canonicalJson(snapshot));
  const snapshotRef = artifactRef({
    id: "profile-snapshot",
    kind: "imagegen-profile-snapshot",
    media_type: "application/json",
    schema_id: "penny.imagegen-profile-snapshot.v1",
    bytes: snapshotBytes,
  });
  const submitted = mutateSubmitted(
    buildImageSubmittedGraph({
      profile_snapshot: snapshot,
      profile_snapshot_ref: snapshotRef,
      slot: 1,
      revision: 0,
      base_seed: request.seed,
      positive_prompt: "blue circle",
      negative_prompt: "noise",
    })
  );
  const submittedBytes = Buffer.from(canonicalJson(submitted));
  const graphRef = artifactRef({
    id: "submitted-graph",
    kind: "image-submitted-graph",
    media_type: "application/json",
    schema_id: "penny.image-submitted-graph.v1",
    bytes: submittedBytes,
  });
  const operationRequest = validateImageGenerationOperationRequest({
    schema_id: "penny.image-generation-operation-request.v1",
    schema_version: 1,
    run_id: "run-comfy-test",
    reservation_id: reservation.reservation_id,
    profile_id: profile.profile_id,
    profile_sha256: profile.profile_sha256,
    profile_snapshot_ref: snapshotRef,
    submitted_graph_ref: graphRef,
    submitted_graph_sha256: sha256(submittedBytes),
    slot: 1,
    revision: 0,
    effective_seed: submitted.effective_seed,
    dimensions: { width: 2, height: 2 },
  });
  const operationBytes = Buffer.from(canonicalJson(operationRequest));
  const operationRef = artifactRef({
    id: "operation-request",
    kind: "image-generation-operation-request",
    media_type: "application/json",
    schema_id: "penny.image-generation-operation-request.v1",
    bytes: operationBytes,
  });
  const declaration = createComfyImagegenDeclaration({
    backend_binding_id: "synthetic-backend",
    lease_profile_id: "synthetic-lease",
    lease_duration_ms: 10_000,
    lease_renew_after_ms: 5_000,
    queue_inactivity_ms: 5_000,
    operation_inactivity_ms: 20_000,
    max_request_bytes: 65_536,
    max_input_bytes: 256_000,
    max_output_bytes: 2_000_000,
    max_progress_events: 16,
  });
  const registrationSha = "e".repeat(64);
  const declarationSha = "f".repeat(64);
  const directive: InvokeHostOperationDirectiveV1 = {
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity: {
      schema_version: 2,
      run_id: "run-comfy-test",
      session_id: "session-comfy-test",
      playbook: "imagegen-test-playbook",
      engine_owner: "typescript",
    },
    state_id: "state-comfy-test",
    attempt: 1,
    operation_id: "generate-slot-1-revision-0",
    operation_kind: declaration.operation_kind,
    registration_sha256: registrationSha,
    request_ref: operationRef,
    request_sha256: operationRef.content_digest,
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "profile_snapshot", ref: snapshotRef },
        { slot: "submitted_graph", ref: graphRef },
      ],
    },
    expected_result: IMAGE_GENERATION_OPERATION_RECEIPT_CONTRACT,
    policy_binding: {
      schema_version: 1,
      declaration_sha256: declarationSha,
      adapter_id: declaration.adapter_id,
      backend_binding_id: declaration.backend_binding_id,
      backend_key_sha256: profiles.resolve(profile.profile_id).backend_key_sha256,
      lease_profile_id: declaration.lease_profile.profile_id,
      lease_profile_sha256: declaration.lease_profile.profile_sha256,
      operation_inactivity_ms: declaration.operation_inactivity_ms,
    },
  };
  const timestamp = "2026-09-16T00:00:00.000Z";
  const remoteId = lifecycle === "submitted" ? "prompt-recovered" : null;
  const journal: HostOperationCallRecordV1 = {
    schema_version: 1,
    operation_record_id: "operation-record",
    project_id: "project-test",
    identity: directive.identity,
    state_id: directive.state_id,
    attempt: directive.attempt,
    operation_id: directive.operation_id,
    operation_kind: directive.operation_kind,
    directive,
    directive_sha256: sha256(canonicalJson(directive)),
    registration_sha256: registrationSha,
    request_ref: operationRef,
    request_sha256: operationRef.content_digest,
    input_artifacts: directive.input_artifacts,
    expected_result: directive.expected_result,
    policy_binding: directive.policy_binding,
    lifecycle,
    lease: null,
    lease_expires_at_ms: null,
    queue_inactivity_expires_at_ms: Date.now() + 5_000,
    operation_inactivity_expires_at_ms: Date.now() + 20_000,
    remote_correlation_id: remoteId,
    remote_correlation_sha256: remoteId === null ? null : sha256(remoteId),
    fetched: null,
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
  const persisted: HostOperationPersistenceInputV1[] = [];
  let acceptedId: string | null = null;
  let submissionBegun = false;
  const inputs = new Map([
    ["profile_snapshot", { ref: snapshotRef, bytes: snapshotBytes }],
    ["submitted_graph", { ref: graphRef, bytes: submittedBytes }],
  ]);
  const context: HostOperationExecutionContextV1 = {
    directive,
    declaration,
    request_bytes: operationBytes,
    journal,
    signal: new AbortController().signal,
    reportActivity: () => undefined,
    readInput: (slot) => {
      const found = inputs.get(slot);
      if (found === undefined) throw new Error("missing test input");
      return found;
    },
    emitProgress: () => undefined,
    beginSubmission: () => {
      submissionBegun = true;
    },
    recordRemoteAccepted: (id) => {
      acceptedId = id;
    },
    cacheResult: async () => {
      throw new Error("imagegen fixture does not configure a result cache");
    },
    readCachedResult: async () => null,
    recordFetched: () => undefined,
    persist: (input) => {
      persisted.push(input);
      const receiptBytes = Buffer.from(input.operation_result.content);
      const receiptRef = artifactRef({
        id: "operation-receipt",
        kind: IMAGE_GENERATION_OPERATION_RECEIPT_CONTRACT.artifact_kind,
        media_type: input.operation_result.media_type,
        schema_id: IMAGE_GENERATION_OPERATION_RECEIPT_CONTRACT.schema_id,
        bytes: receiptBytes,
      });
      const outputRefs = (input.outputs ?? []).map((output, index) =>
        artifactRef({
          id: `generated-image-${index}`,
          kind: output.contract.artifact_kind,
          media_type: output.media_type,
          schema_id: output.contract.schema_id,
          bytes: Buffer.from(output.content),
        })
      );
      return { operation_result_ref: receiptRef, output_artifacts: outputRefs };
    },
    registerRemoteCancellation: () => undefined,
  };
  return {
    adapter: new ComfyImagegenOperationAdapter({ profiles, storage }),
    context,
    inventory,
    persisted,
    counters: {
      get acceptedId() {
        return acceptedId;
      },
      get submissionBegun() {
        return submissionBegun;
      },
    },
  };
}

describe("bounded Comfy HTTP client", () => {
  it("propagates cancellation through a stalled response", async () => {
    const endpoint = await listen(() => undefined);
    const client = new ComfyHttpClient(
      { scheme: "http", host: "127.0.0.1", port: endpoint.port },
      CLIENT_LIMITS
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("test cancellation")), 10);
    await expect(client.ready({ signal: controller.signal })).rejects.toMatchObject({
      code: "BACKEND_CANCELLED",
    });
  });

  it("rejects traversal-shaped remote image descriptors", async () => {
    const endpoint = await listen((request, response) => {
      if (request.url === "/history/prompt-safe") {
        respondJson(response, {
          "prompt-safe": {
            status: { completed: true, status_str: "success" },
            outputs: {
              "4": { images: [{ filename: "../escape.png", subfolder: "", type: "output" }] },
            },
          },
        });
      } else response.writeHead(404).end();
    });
    const client = new ComfyHttpClient(
      { scheme: "http", host: "127.0.0.1", port: endpoint.port },
      CLIENT_LIMITS
    );
    await expect(
      client.history({
        prompt_id: "prompt-safe",
        output_node_id: "4",
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: "BACKEND_RESPONSE_INVALID" });
  });

  it("refuses redirects, compressed responses, malformed JSON, and oversized bodies", async () => {
    for (const mode of ["redirect", "compressed", "malformed", "oversized"] as const) {
      const endpoint = await listen((_request, response) => {
        if (mode === "redirect") {
          response.writeHead(302, { Location: "http://127.0.0.1/elsewhere" });
          response.end();
        } else if (mode === "compressed") {
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
          });
          response.end("not actually compressed");
        } else if (mode === "malformed") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end("{");
        } else {
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": "1000",
          });
          response.end("{}");
        }
      });
      const client = new ComfyHttpClient(
        { scheme: "http", host: "127.0.0.1", port: endpoint.port },
        { ...CLIENT_LIMITS, max_readiness_bytes: mode === "oversized" ? 8 : 65_536 }
      );
      await expect(client.ready({ signal: new AbortController().signal })).rejects.toBeInstanceOf(
        ComfyClientError
      );
    }
  });
});

describe("host-only Comfy image generation adapter", () => {
  it.each(["lease_acquired", "submitted"] as const)(
    "rejects a digest-correct unapproved graph before any HTTP on %s",
    async (lifecycle) => {
      let requests = 0;
      const endpoint = await listen((_request, response) => {
        requests += 1;
        respondJson(response, {});
      });
      const fixture = await operationFixture(endpoint.port, lifecycle, (value) => {
        const graph = {
          ...value.graph,
          "4": {
            class_type: "OutputNode",
            inputs: { prefix: "escape-prefix", asset: "unapproved-asset" },
          },
        };
        return { ...value, graph, submitted_graph_sha256: sha256(canonicalJson(graph)) };
      });
      await expect(fixture.adapter.run(fixture.context)).rejects.toThrow(
        "does not match approved source mutations"
      );
      expect(requests).toBe(0);
      expect(fixture.counters.submissionBegun).toBe(false);
      expect(fixture.persisted).toEqual([]);
    }
  );
  it("preflights, submits one graph, polls, validates and sanitizes one PNG, then persists", async () => {
    const png = encodeCanonicalPng({
      width: 2,
      height: 2,
      rgba: Uint8Array.from([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]),
    });
    let posts = 0;
    let historyCalls = 0;
    const endpoint = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") respondJson(response, syntheticInventory());
      else if (request.url === "/prompt" && request.method === "POST") {
        posts += 1;
        request.resume();
        respondJson(response, { prompt_id: "prompt-success", number: 1, node_errors: {} });
      } else if (request.url === "/history/prompt-success") {
        historyCalls += 1;
        respondJson(
          response,
          historyCalls === 1
            ? {}
            : {
                "prompt-success": {
                  status: { completed: true, status_str: "success" },
                  outputs: {
                    "4": {
                      images: [{ filename: "image.png", subfolder: "", type: "output" }],
                    },
                  },
                },
              }
        );
      } else if (request.url?.startsWith("/view?")) {
        response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.byteLength });
        response.end(png);
      } else {
        response.writeHead(404).end();
      }
    });
    const fixture = await operationFixture(endpoint.port);
    const terminal = await fixture.adapter.run(fixture.context);
    expect(terminal.disposition.outcome).toBe("completed");
    expect(terminal.output_artifacts).toHaveLength(2);
    expect(terminal.output_artifacts.map((artifact) => artifact.kind)).toEqual([
      "image-validation-receipt",
      "generated-image",
    ]);
    expect(posts).toBe(1);
    expect(fixture.counters.submissionBegun).toBe(true);
    expect(fixture.counters.acceptedId).toBe("prompt-success");
    const persistence = fixture.persisted[0];
    expect(persistence?.outputs?.map((output) => output.media_type)).toEqual([
      "application/json",
      "image/png",
    ]);
    const receipt = validateImageGenerationOperationReceipt(
      JSON.parse(Buffer.from(persistence?.operation_result.content ?? "").toString("utf8"))
    );
    expect(receipt.validation.status).toBe("valid");
    expect(receipt.status).toBe("persisted");
  });

  it("persists a typed invalid receipt but no image for wrong media", async () => {
    const endpoint = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") respondJson(response, syntheticInventory());
      else if (request.url === "/prompt") {
        request.resume();
        respondJson(response, { prompt_id: "prompt-wrong-media", number: 1, node_errors: {} });
      } else if (request.url === "/history/prompt-wrong-media") {
        respondJson(response, {
          "prompt-wrong-media": {
            status: { completed: true, status_str: "success" },
            outputs: {
              "4": { images: [{ filename: "not-png", subfolder: "", type: "output" }] },
            },
          },
        });
      } else if (request.url?.startsWith("/view?")) {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("not an image");
      } else response.writeHead(404).end();
    });
    const fixture = await operationFixture(endpoint.port);
    const terminal = await fixture.adapter.run(fixture.context);
    expect(terminal.disposition.outcome).toBe("failed");
    expect(terminal.output_artifacts.map((artifact) => artifact.kind)).toEqual([
      "image-validation-receipt",
    ]);
    const persistence = fixture.persisted[0];
    const receipt = validateImageGenerationOperationReceipt(
      JSON.parse(Buffer.from(persistence?.operation_result.content ?? "").toString("utf8"))
    );
    expect(receipt.status).toBe("downloaded_invalid");
    expect(receipt.validation).toMatchObject({
      status: "invalid",
      reason_code: "wrong_media_type",
    });
  });

  it("rejects duplicate terminal images before fetching any output", async () => {
    let views = 0;
    const endpoint = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") respondJson(response, syntheticInventory());
      else if (request.url === "/prompt") {
        request.resume();
        respondJson(response, { prompt_id: "prompt-duplicate", number: 1, node_errors: {} });
      } else if (request.url === "/history/prompt-duplicate") {
        respondJson(response, {
          "prompt-duplicate": {
            status: { completed: true, status_str: "success" },
            outputs: {
              "4": {
                images: [
                  { filename: "one.png", subfolder: "", type: "output" },
                  { filename: "two.png", subfolder: "", type: "output" },
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
    const fixture = await operationFixture(endpoint.port);
    const terminal = await fixture.adapter.run(fixture.context);
    expect(terminal.disposition).toMatchObject({
      outcome: "failed",
      reason_code: "terminal_output_cardinality_invalid",
    });
    expect(terminal.output_artifacts).toEqual([]);
    expect(views).toBe(0);
  });

  it("fails inventory drift before submission", async () => {
    let posts = 0;
    const endpoint = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") {
        respondJson(response, syntheticInventory("different-asset"));
      } else if (request.url === "/prompt") {
        posts += 1;
        response.writeHead(500).end();
      } else response.writeHead(404).end();
    });
    const fixture = await operationFixture(endpoint.port);
    const terminal = await fixture.adapter.run(fixture.context);
    expect(terminal.disposition).toMatchObject({
      outcome: "failed",
      reason_code: "backend_inventory_drift",
    });
    expect(posts).toBe(0);
  });

  it("recovers an accepted prompt without submitting a duplicate", async () => {
    const png = encodeCanonicalPng({
      width: 2,
      height: 2,
      rgba: new Uint8Array(16).fill(255),
    });
    let posts = 0;
    const endpoint = await listen((request, response) => {
      if (request.url === "/prompt") {
        posts += 1;
        respondJson(response, { prompt_id: "unexpected", number: 1, node_errors: {} });
      } else if (request.url === "/history/prompt-recovered") {
        respondJson(response, {
          "prompt-recovered": {
            status: { completed: true, status_str: "success" },
            outputs: {
              "4": { images: [{ filename: "recovered.png", subfolder: "", type: "output" }] },
            },
          },
        });
      } else if (request.url?.startsWith("/view?")) {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(png);
      } else {
        respondJson(response, { ready: true });
      }
    });
    const fixture = await operationFixture(endpoint.port, "submitted");
    const terminal = await fixture.adapter.run(fixture.context);
    expect(terminal.disposition.outcome).toBe("completed");
    expect(posts).toBe(0);
    expect(fixture.counters.submissionBegun).toBe(false);
  });

  it("reconstructs a fetched descriptor without changing its durable poll count or resubmitting", async () => {
    const png = encodeCanonicalPng({
      width: 2,
      height: 2,
      rgba: new Uint8Array(16).fill(127),
    });
    let posts = 0;
    const endpoint = await listen((request, response) => {
      if (request.url === "/prompt") {
        posts += 1;
        respondJson(response, { prompt_id: "unexpected", number: 1, node_errors: {} });
      } else if (request.url === "/history/prompt-recovered") {
        respondJson(response, {
          "prompt-recovered": {
            status: { completed: true, status_str: "success" },
            outputs: {
              "4": { images: [{ filename: "recovered.png", subfolder: "", type: "output" }] },
            },
          },
        });
      } else if (request.url?.startsWith("/view?")) {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(png);
      } else {
        response.writeHead(404).end();
      }
    });
    const fixture = await operationFixture(endpoint.port, "submitted");
    const fetched = {
      schema_version: 1 as const,
      content_sha256: sha256(png),
      byte_length: png.byteLength,
      item_count: 1,
      poll_count: 7,
    };
    const context: HostOperationExecutionContextV1 = {
      ...fixture.context,
      journal: { ...fixture.context.journal, lifecycle: "fetched", fetched },
      recordFetched: (candidate) => {
        if (canonicalJson(candidate) !== canonicalJson(fetched)) {
          throw new Error("fetched milestone diverged during recovery");
        }
      },
    };

    const terminal = await fixture.adapter.run(context);

    expect(terminal.disposition.outcome).toBe("completed");
    expect(posts).toBe(0);
    const receipt = validateImageGenerationOperationReceipt(
      JSON.parse(Buffer.from(fixture.persisted[0]?.operation_result.content ?? "").toString("utf8"))
    );
    expect(receipt.poll_count).toBe(7);
  });

  it("treats ambiguous submission disconnects and server errors as unknown", async () => {
    for (const failure of ["disconnect", "server-error"] as const) {
      const endpoint = await listen((request, response) => {
        if (request.url === "/system_stats") respondJson(response, { ready: true });
        else if (request.url === "/object_info") respondJson(response, syntheticInventory());
        else if (request.url === "/prompt" && failure === "disconnect") request.socket.destroy();
        else if (request.url === "/prompt") response.writeHead(500).end("failed");
        else response.writeHead(404).end();
      });
      const fixture = await operationFixture(endpoint.port);
      await expect(fixture.adapter.run(fixture.context)).rejects.toMatchObject({
        submission_disposition: "unknown",
      });
    }
  });

  it("quarantines a malformed successful prompt identifier as ambiguous", async () => {
    const endpoint = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") respondJson(response, syntheticInventory());
      else if (request.url === "/prompt") {
        request.resume();
        respondJson(response, { prompt_id: "../unsafe", number: 1, node_errors: {} });
      } else response.writeHead(404).end();
    });
    const fixture = await operationFixture(endpoint.port);
    await expect(fixture.adapter.run(fixture.context)).rejects.toMatchObject({
      code: "BACKEND_PROMPT_ID_INVALID",
      submission_disposition: "unknown",
    });
  });

  it("permits bounded retry only for an explicit prompt validation rejection", async () => {
    const endpoint = await listen((request, response) => {
      if (request.url === "/system_stats") respondJson(response, { ready: true });
      else if (request.url === "/object_info") respondJson(response, syntheticInventory());
      else if (request.url === "/prompt") response.writeHead(400).end("invalid prompt");
      else response.writeHead(404).end();
    });
    const fixture = await operationFixture(endpoint.port);
    const terminal = await fixture.adapter.run(fixture.context);
    expect(terminal.disposition).toMatchObject({
      outcome: "failed",
      remote_disposition: "proven_not_accepted",
      retryable: true,
    });
  });
});
