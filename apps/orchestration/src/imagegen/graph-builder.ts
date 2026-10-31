import type { ImageInputBindingV1, ImageAssetRequestV1 } from "./reference-contracts.js";
import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, JsonValue } from "../contracts.js";
import {
  IMAGEGEN_MAX_PROMPT_BYTES,
  ImagegenGraphV1Schema,
  imagegenEffectiveSeed,
  profilePermitsDimensions,
  validateImageGenerationOperationRequest,
  validateImageSubmittedGraph,
  validateImagegenProfileSnapshot,
  type ImageDimensionsV1,
  type ImageGenerationOperationRequestV1,
  type ImageSubmittedGraphV1,
  type ImagegenGraphV1,
  type ImagegenMutationAddressV1,
  type ImagegenProfileSnapshotV1,
} from "../skill-contracts/imagegen.js";
import {
  SkillSchemaValidationError,
  assertText,
  validateSkillSchema,
} from "../skill-contracts/common.js";
import type { ImagegenStorageAdmission } from "./types.js";

export const IMAGEGEN_GRAPH_BUILDER_SCHEMA_ID = "penny.image-graph-builder.v1" as const;

function graphWithInput(
  graph: ImagegenGraphV1,
  address: ImagegenMutationAddressV1,
  value: JsonValue
): ImagegenGraphV1 {
  const node = graph[address.node_id];
  if (node === undefined || !Object.hasOwn(node.inputs, address.input_name)) {
    throw new Error("imagegen graph mutation address drifted from the approved profile");
  }
  return validateSkillSchema(
    ImagegenGraphV1Schema,
    Object.fromEntries(
      Object.entries(graph).map(([nodeId, candidate]) => [
        nodeId,
        nodeId === address.node_id
          ? {
              class_type: candidate.class_type,
              inputs: { ...candidate.inputs, [address.input_name]: value },
            }
          : { class_type: candidate.class_type, inputs: { ...candidate.inputs } },
      ])
    ),
    "submitted imagegen graph"
  );
}

function promptWithinProfile(value: string, label: string, input: ImagegenProfileSnapshotV1): void {
  const limits = input.profile.limits;
  if (
    value.length > limits.max_prompt_characters ||
    Buffer.byteLength(value, "utf8") > limits.max_prompt_bytes ||
    Buffer.byteLength(value, "utf8") > IMAGEGEN_MAX_PROMPT_BYTES
  ) {
    throw new SkillSchemaValidationError(label, ["prompt exceeds the approved profile limit"]);
  }
  assertText(value, label, {
    minBytes: 1,
    maxBytes: limits.max_prompt_bytes,
    multiline: true,
    trimmedNonEmpty: true,
  });
}

/** Pure structured graph mutation. User/model text is assigned only as an input value. */
export function buildImageSubmittedGraph(input: {
  readonly profile_snapshot: ImagegenProfileSnapshotV1;
  readonly profile_snapshot_ref: ArtifactRef;
  readonly slot: number;
  readonly revision: number;
  readonly base_seed: number;
  readonly positive_prompt: string;
  readonly negative_prompt: string;
  readonly dimensions?: ImageDimensionsV1;
  readonly apply_fallback?: boolean;
  readonly reference?: ImageInputBindingV1;
}): ImageSubmittedGraphV1 {
  const snapshot = validateImagegenProfileSnapshot(input.profile_snapshot);
  const profile = snapshot.profile;
  promptWithinProfile(input.positive_prompt, "imagegen positive prompt", snapshot);
  promptWithinProfile(input.negative_prompt, "imagegen negative prompt", snapshot);
  const dimensions = input.dimensions ?? profile.default_dimensions;
  if (!profilePermitsDimensions(profile, dimensions)) {
    throw new SkillSchemaValidationError("imagegen dimensions", [
      "dimensions are outside the approved profile policy",
    ]);
  }
  let graph = validateSkillSchema(
    ImagegenGraphV1Schema,
    JSON.parse(canonicalJson(profile.source_graph)),
    "approved imagegen source graph"
  );
  let fallbackDisposition: ImageSubmittedGraphV1["fallback_disposition"] = {
    status: "not_applied",
  };
  if (input.apply_fallback === true) {
    const fallback = profile.fallback;
    if (fallback === null) throw new Error("imagegen profile has no approved fallback rewrite");
    for (const rewrite of fallback.rewrites) {
      graph = graphWithInput(graph, rewrite, rewrite.value);
    }
    fallbackDisposition = { status: "applied", fallback_id: fallback.fallback_id };
  }
  const effectiveSeed = imagegenEffectiveSeed(input.base_seed, input.slot);
  const values: ReadonlyArray<readonly [ImagegenMutationAddressV1, JsonValue]> = [
    [profile.mutations.positive_prompt, input.positive_prompt],
    [profile.mutations.negative_prompt, input.negative_prompt],
    [profile.mutations.seed, effectiveSeed],
    [profile.mutations.width, dimensions.width],
    [profile.mutations.height, dimensions.height],
    [profile.mutations.batch_size, 1],
    [
      profile.mutations.filename_prefix,
      `imagegen-${input.slot}-${input.revision}-${sha256(
        canonicalJson({ seed: effectiveSeed, dimensions })
      ).slice(0, 16)}`,
    ],
  ];
  for (const [address, value] of values) graph = graphWithInput(graph, address, value);
  if (profile.revision_capability !== undefined) {
    const ref = input.reference,
      c = profile.revision_capability;
    if (
      ref === undefined ||
      ref.asset.input.kind !== "revision" ||
      canonicalJson(ref.source_ref) !== canonicalJson(ref.asset.input.source_ref) ||
      (ref.asset.input.area.kind === "whole") !== (c.method === "img2img") ||
      (c.method === "img2img") !== (ref.edit_mask_ref === null && ref.backend_mask_ref === null) ||
      ref.uploads.length !== (c.method === "img2img" ? 1 : 2)
    )
      throw new Error("revision profile/source/mask method mismatch");
    const name = (digest: string) =>
      `${c.input_subfolder.length === 0 ? "" : c.input_subfolder + "/"}${digest}.png`;
    graph = graphWithInput(graph, c.source_port, name(ref.source_ref.content_digest));
    if (c.mask_port !== null) {
      if (ref.backend_mask_ref === null) throw new Error("missing backend mask");
      graph = graphWithInput(graph, c.mask_port, name(ref.backend_mask_ref.content_digest));
    }
  } else if (input.reference !== undefined)
    throw new Error("fresh profile does not support revision inputs");
  const graphBytes = Buffer.byteLength(canonicalJson(graph), "utf8");
  if (graphBytes > profile.limits.max_graph_bytes) {
    throw new Error("submitted imagegen graph exceeds the approved profile byte limit");
  }
  return validateImageSubmittedGraph({
    schema_id: "penny.image-submitted-graph.v1",
    schema_version: 1,
    builder_schema_id: IMAGEGEN_GRAPH_BUILDER_SCHEMA_ID,
    profile_snapshot_ref: input.profile_snapshot_ref,
    profile_sha256: profile.profile_sha256,
    source_graph_sha256: profile.source_graph_sha256,
    submitted_graph_sha256: sha256(canonicalJson(graph)),
    slot: input.slot,
    revision: input.revision,
    effective_seed: effectiveSeed,
    dimensions,
    fallback_disposition: fallbackDisposition,
    graph,
    ...(input.reference === undefined ? {} : { reference: input.reference }),
  });
}

/**
 * Rebuild the entire prepared document from the approved source and its closed value ports.
 * A self-consistent submitted digest proves byte identity, not permission to change the graph.
 * This checks structure/settings on both fresh execution and accepted-operation recovery; it
 * does not authenticate prompt intent or confer source-image/revision authority.
 */
export function assertImageSubmittedGraphMatchesProfile(input: {
  readonly profile_snapshot: ImagegenProfileSnapshotV1;
  readonly submitted_graph: ImageSubmittedGraphV1;
}): void {
  const snapshot = validateImagegenProfileSnapshot(input.profile_snapshot);
  const submitted = validateImageSubmittedGraph(input.submitted_graph);
  const prompts = snapshot.profile.mutations;
  const positive =
    submitted.graph[prompts.positive_prompt.node_id]?.inputs[prompts.positive_prompt.input_name];
  const negative =
    submitted.graph[prompts.negative_prompt.node_id]?.inputs[prompts.negative_prompt.input_name];
  if (typeof positive !== "string" || typeof negative !== "string") {
    throw new Error("submitted imagegen graph lacks its approved prompt value ports");
  }
  // Invert the existing unsigned-32-bit per-slot derivation. The enclosing operation separately
  // binds effective_seed; reconstruction here verifies the graph, not a new seed authorization.
  const baseSeed = (submitted.effective_seed - submitted.slot) >>> 0;
  const expected = buildImageSubmittedGraph({
    profile_snapshot: snapshot,
    profile_snapshot_ref: submitted.profile_snapshot_ref,
    slot: submitted.slot,
    revision: submitted.revision,
    base_seed: baseSeed,
    positive_prompt: positive,
    negative_prompt: negative,
    dimensions: submitted.dimensions,
    apply_fallback: submitted.fallback_disposition.status === "applied",
    ...(submitted.reference === undefined ? {} : { reference: submitted.reference }),
  });
  if (canonicalJson(expected) !== canonicalJson(submitted)) {
    throw new Error("submitted imagegen graph does not match approved source mutations");
  }
}

function exactPersistJson(input: {
  readonly store: ArtifactHostStore;
  readonly metadata: Parameters<ArtifactHostStore["persist"]>[0]["metadata"];
  readonly value: unknown;
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const existing = input.store.refFor(
    input.metadata.run_id,
    input.metadata.phase,
    input.metadata.branch_id,
    input.metadata.kind,
    input.metadata.operation_id,
    input.metadata.version
  );
  const ref = existing ?? input.store.persist({ metadata: input.metadata, content });
  if (
    input.store.readById(ref.artifact_id).toString("utf8") !== content ||
    canonicalJson(input.store.metadata(ref)) !== canonicalJson(input.metadata)
  ) {
    throw new Error("imagegen prepared artifact conflicts with exact persisted bytes");
  }
  input.store.select(ref);
  return ref;
}

/**
 * Persists the exact graph before the host-operation request that can submit it. The storage commit
 * is idempotently journaled before artifact writes, so a crash can over-reserve but cannot bypass
 * the hard partition ceiling.
 */
export function prepareImageGenerationOperation(input: {
  readonly store: ArtifactHostStore;
  readonly storage: ImagegenStorageAdmission;
  readonly run_id: string;
  readonly reservation_id: string;
  readonly profile_snapshot: ImagegenProfileSnapshotV1;
  readonly profile_snapshot_ref: ArtifactRef;
  readonly prompt_plan_ref: ArtifactRef;
  readonly slot: number;
  readonly revision: number;
  readonly base_seed: number;
  readonly positive_prompt: string;
  readonly negative_prompt: string;
  readonly dimensions?: ImageDimensionsV1;
  readonly apply_fallback?: boolean;
  readonly reference?: ImageInputBindingV1;
  readonly asset?: ImageAssetRequestV1;
  readonly max_renders?: number;
}): {
  readonly submitted_graph: ImageSubmittedGraphV1;
  readonly submitted_graph_ref: ArtifactRef;
  readonly operation_request: ImageGenerationOperationRequestV1;
  readonly operation_request_ref: ArtifactRef;
} {
  const submittedGraph = buildImageSubmittedGraph(input);
  const graphContent = canonicalJson(submittedGraph);
  input.storage.commit({
    reservation_id: input.reservation_id,
    commit_key: `graph-${input.slot}-${input.revision}`,
    byte_length: Buffer.byteLength(graphContent, "utf8"),
  });
  const graphOperationId = `imagegen-graph-slot-${input.slot}`;
  const graphParent =
    input.revision === 0
      ? null
      : input.store.refFor(
          input.run_id,
          "preparing_generation",
          null,
          "image-submitted-graph",
          graphOperationId,
          input.revision
        );
  if (input.revision > 0 && graphParent === null) {
    throw new Error("imagegen graph revision lacks its exact preceding graph artifact");
  }
  const graphRef = exactPersistJson({
    store: input.store,
    metadata: {
      schema_version: 2,
      run_id: input.run_id,
      phase: "preparing_generation",
      branch_id: null,
      kind: "image-submitted-graph",
      operation_id: graphOperationId,
      version: input.revision + 1,
      producer: "host:imagegen-graph-builder",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.image-submitted-graph.v1",
        schema_version: 1,
      },
      parent_ref: graphParent,
      upstream_refs: [
        input.profile_snapshot_ref,
        input.prompt_plan_ref,
        ...(input.reference === undefined
          ? []
          : [
              input.reference.source_ref,
              ...(input.reference.edit_mask_ref === null ? [] : [input.reference.edit_mask_ref]),
              ...(input.reference.backend_mask_ref === null
                ? []
                : [input.reference.backend_mask_ref]),
              ...input.reference.uploads,
            ]),
      ],
    },
    value: submittedGraph,
  });
  const request = validateImageGenerationOperationRequest({
    schema_id: "penny.image-generation-operation-request.v1",
    schema_version: 1,
    run_id: input.run_id,
    reservation_id: input.reservation_id,
    profile_id: input.profile_snapshot.profile.profile_id,
    profile_sha256: submittedGraph.profile_sha256,
    profile_snapshot_ref: input.profile_snapshot_ref,
    submitted_graph_ref: graphRef,
    submitted_graph_sha256: graphRef.content_digest,
    slot: input.slot,
    revision: input.revision,
    effective_seed: submittedGraph.effective_seed,
    dimensions: submittedGraph.dimensions,
    ...(input.reference === undefined ? {} : { reference: input.reference }),
    ...(input.asset === undefined ? {} : { asset: input.asset, max_renders: input.max_renders }),
  });
  const requestContent = canonicalJson(request);
  input.storage.commit({
    reservation_id: input.reservation_id,
    commit_key: `operation-request-${input.slot}-${input.revision}`,
    byte_length: Buffer.byteLength(requestContent, "utf8"),
  });
  const requestRef = exactPersistJson({
    store: input.store,
    metadata: {
      schema_version: 2,
      run_id: input.run_id,
      phase: "preparing_generation",
      branch_id: null,
      kind: "image-generation-operation-request",
      operation_id: `imagegen-operation-request-${input.slot}-${input.revision}`,
      version: 1,
      producer: "host:imagegen-graph-builder",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.image-generation-operation-request.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: [input.profile_snapshot_ref, input.prompt_plan_ref, graphRef],
    },
    value: request,
  });
  return {
    submitted_graph: submittedGraph,
    submitted_graph_ref: graphRef,
    operation_request: request,
    operation_request_ref: requestRef,
  };
}
