import path from "node:path";
import { expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, InvokeHostOperationDirectiveV1 } from "../dist/contracts.js";
import {
  hostOperationPolicyBinding,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
} from "../dist/host-operations/contracts.js";
import { hostCapacityWorkerKey } from "../dist/host-operations/capacity-contracts.js";
import { buildImageSubmittedGraph } from "../dist/imagegen/graph-builder.js";
import {
  ComfyImagegenOperationAdapter,
  createComfyImagegenDeclaration,
} from "../dist/imagegen/operation-owner.js";
import { SqliteImagegenStorageAdmission } from "../dist/imagegen/storage-admission.js";
import { encodeCanonicalPng } from "../dist/png-media.js";
import { buildVideoSubmittedGraph } from "../dist/videogen/graph-builder.js";
import {
  validateVideogenProfileSnapshot,
  validateVideoReferenceUploadReceipt,
} from "../dist/videogen/contracts.js";
import {
  ComfyVideogenOperationAdapter,
  createComfyVideogenDeclaration,
} from "../dist/videogen/operation-owner.js";
import {
  ComfyVideogenUploadOperationAdapter,
  createComfyVideoUploadDeclaration,
} from "../dist/videogen/upload-operation.js";
import { CapacityFixture } from "./helpers/capacity-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";
import { workerProfiles } from "./videogen-worker-identity-fixtures.js";

const declarationOptions = {
  backend_binding_id: "synthetic-comfy-service",
  lease_profile_id: "synthetic-shared-lease",
  lease_duration_ms: 100000,
  lease_renew_after_ms: 20000,
  queue_inactivity_ms: 10000,
  operation_inactivity_ms: 100000,
  max_request_bytes: 65536,
  max_input_bytes: 262144,
  max_output_bytes: 2000000,
  max_progress_events: 32,
};
function noBackend(): never {
  throw new Error("identity inspection must not open a backend");
}

it("retained imagegen, both video render profiles and reference-upload adapters project the same actual-worker key", () => {
  using f = new CapacityFixture();
  const p = workerProfiles();
  const project = requireValue(f.projects[0], "project");
  let index = 0;
  function persist(
    kind: string,
    schema_id: string,
    value: unknown,
    media_type = "application/json"
  ): ArtifactRef {
    return project.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "adapter-test",
        phase: "adapter-test",
        branch_id: null,
        kind,
        operation_id: `operand-${index++}`,
        version: 1,
        producer: "host:worker-identity-fixture",
        media_type,
        content_schema: { schema_id, schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: value instanceof Uint8Array ? value : canonicalJson(value),
    });
  }
  function inspect(
    adapter: HostOperationAdapterV1,
    declaration: HostOperationDeclarationV1,
    request: unknown,
    inputs: { slot: string; ref: ArtifactRef }[]
  ) {
    if (request === null || typeof request !== "object")
      throw new Error("fixture request must be an object");
    const bytes = Buffer.from(canonicalJson(request));
    const ref = persist(declaration.request.artifact_kind, declaration.request.schema_id, request);
    const directive: InvokeHostOperationDirectiveV1 = {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: {
        schema_version: 2,
        run_id: "adapter-test",
        session_id: "adapter-test-session",
        playbook: "research",
        engine_owner: "typescript",
      },
      state_id: "capacity-state",
      attempt: 1,
      operation_id: `inspect-${index++}`,
      operation_kind: declaration.operation_kind,
      registration_sha256: sha256("synthetic adapter inspection only"),
      request_ref: ref,
      request_sha256: ref.content_digest,
      input_artifacts: { schema_version: 2, artifacts: inputs },
      expected_result: declaration.result,
      policy_binding: hostOperationPolicyBinding(declaration, hostCapacityWorkerKey("worker-a")),
    };
    const input = {
      directive,
      declaration,
      request_bytes: bytes,
      input_artifacts: directive.input_artifacts,
    };
    const inspected = adapter.inspectRequest(input);
    expect(inspected.backend_key_sha256).toBe(hostCapacityWorkerKey("worker-a"));
    expect(inspected.adapter_id).toBe(declaration.adapter_id);
    expect(() =>
      adapter.inspectRequest({
        ...input,
        request_bytes: Buffer.from(canonicalJson({ ...request, profile_sha256: sha256("drift") })),
      })
    ).toThrow("drifted");
    return inspected;
  }
  using storage = new SqliteImagegenStorageAdmission({
    directory: path.join(f.root, "image-storage"),
    ceiling_bytes: 16777216,
    warning_threshold_bytes: 12582912,
  });
  const snapshot = p.images.resolve(p.image.profile_id).snapshot;
  const snapshotRef = persist("imagegen-profile-snapshot", snapshot.schema_id, snapshot);
  const graph = buildImageSubmittedGraph({
    profile_snapshot: snapshot,
    profile_snapshot_ref: snapshotRef,
    slot: 0,
    revision: 0,
    base_seed: 7,
    positive_prompt: "synthetic shapes",
    negative_prompt: "text",
  });
  const graphRef = persist("image-submitted-graph", graph.schema_id, graph);
  const imageBinding = inspect(
    new ComfyImagegenOperationAdapter({ profiles: p.images, storage, client_factory: noBackend }),
    createComfyImagegenDeclaration(declarationOptions),
    {
      schema_id: "penny.image-generation-operation-request.v1",
      schema_version: 1,
      run_id: "adapter-test",
      reservation_id: "synthetic-reservation",
      profile_id: p.image.profile_id,
      profile_sha256: p.image.profile_sha256,
      profile_snapshot_ref: snapshotRef,
      submitted_graph_ref: graphRef,
      submitted_graph_sha256: graphRef.content_digest,
      slot: 0,
      revision: 0,
      effective_seed: graph.effective_seed,
      dimensions: graph.dimensions,
    },
    [
      { slot: "profile_snapshot", ref: snapshotRef },
      { slot: "submitted_graph", ref: graphRef },
    ]
  );

  for (const profile of [p.first, p.second]) {
    const videoSnapshot = validateVideogenProfileSnapshot({
      schema_id: "penny.videogen-profile-snapshot.v1",
      schema_version: 1,
      profile,
      approved_profile_sha256: profile.profile_sha256,
      source_graph_sha256: profile.source_graph_sha256,
    });
    const profileRef = persist("videogen-profile-snapshot", videoSnapshot.schema_id, videoSnapshot);
    let uploaded = null;
    let uploadedRef: ArtifactRef | null = null;
    if (profile.mode === "i2v") {
      const png = encodeCanonicalPng({
        width: 1,
        height: 1,
        rgba: Uint8Array.from([0, 0, 255, 255]),
      });
      const pngRef = persist("canonical-png", "penny.canonical-png.v1", png, "image/png");
      const uploadBinding = inspect(
        new ComfyVideogenUploadOperationAdapter({
          legacy_http: true,
          profiles: p.videos,
          client_factory: noBackend,
        }),
        createComfyVideoUploadDeclaration(declarationOptions),
        {
          schema_id: "penny.video-reference-upload-operation-request.v1",
          schema_version: 1,
          run_id: "adapter-test",
          profile_id: profile.profile_id,
          profile_sha256: profile.profile_sha256,
          profile_snapshot_ref: profileRef,
          canonical_png_ref: pngRef,
          canonical_png_sha256: pngRef.content_digest,
        },
        [
          { slot: "profile_snapshot", ref: profileRef },
          { slot: "canonical_png", ref: pngRef },
        ]
      );
      expect(uploadBinding.backend_key_sha256).toBe(imageBinding.backend_key_sha256);
      // Synthetic prior receipt solely for pure graph preparation, not remote upload proof.
      uploaded = validateVideoReferenceUploadReceipt({
        schema_id: "penny.video-reference-upload-receipt.v1",
        schema_version: 1,
        run_id: "adapter-test",
        profile_id: profile.profile_id,
        profile_sha256: profile.profile_sha256,
        canonical_png_ref: pngRef,
        canonical_png_sha256: pngRef.content_digest,
        canonical_png_bytes: png.byteLength,
        remote_descriptor: {
          filename: `ref-${pngRef.content_digest}.png`,
          subfolder: profile.input_subfolder,
          type: "input",
        },
        status: "uploaded_verified",
      });
      uploadedRef = persist("video-reference-upload-receipt", uploaded.schema_id, uploaded);
    }
    const submitted = buildVideoSubmittedGraph({
      run_id: "adapter-test",
      shot_id: "synthetic-shot",
      profile_snapshot: videoSnapshot,
      profile_snapshot_ref: profileRef,
      spec: {
        mode: profile.mode,
        positive_prompt: "synthetic motion",
        negative_prompt: "flicker",
        seed: 7,
        dimensions: { width: 64, height: 64 },
        frame_count: 3,
        fps: 3,
      },
      input_upload_receipt: uploaded,
      input_upload_receipt_ref: uploadedRef,
    });
    const submittedRef = persist("video-submitted-graph", submitted.schema_id, submitted);
    const renderBinding = inspect(
      new ComfyVideogenOperationAdapter({
        legacy_http: true,
        profiles: p.videos,
        client_factory: noBackend,
      }),
      createComfyVideogenDeclaration(declarationOptions),
      {
        schema_id: "penny.video-generation-operation-request.v1",
        schema_version: 1,
        run_id: "adapter-test",
        shot_id: submitted.shot_id,
        profile_id: profile.profile_id,
        profile_sha256: profile.profile_sha256,
        profile_snapshot_ref: profileRef,
        submitted_graph_ref: submittedRef,
        submitted_graph_sha256: submittedRef.content_digest,
        mode: profile.mode,
        dimensions: submitted.dimensions,
        frame_count: submitted.frame_count,
        fps: submitted.fps,
      },
      [
        { slot: "profile_snapshot", ref: profileRef },
        { slot: "submitted_graph", ref: submittedRef },
        ...(uploadedRef === null ? [] : [{ slot: "input_upload_receipt", ref: uploadedRef }]),
      ]
    );
    expect(renderBinding.backend_key_sha256).toBe(imageBinding.backend_key_sha256);
  }
});
