import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, JsonValue } from "../contracts.js";
import type { ImagegenGraphV1, ImagegenMutationAddressV1 } from "../skill-contracts/imagegen.js";
import {
  assertRefEqual,
  validateVideoReferenceUploadReceipt,
  validateVideoSubmittedGraph,
  validateVideogenProfileSnapshot,
  validateVideogenRenderSpec,
  type VideoReferenceUploadReceiptV1,
  type VideoSubmittedGraphV1,
  type VideogenProfileSnapshotV1,
  type VideogenProfileV1,
  type VideogenRenderSpecV1,
} from "./contracts.js";

type MutableGraph = Record<
  string,
  { class_type: string; inputs: Record<string, JsonValue>; _meta?: Record<string, JsonValue> }
>;

function cloneJson(value: JsonValue): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneJson);
  const cloned: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) cloned[key] = cloneJson(child);
  return cloned;
}

function cloneRecord(value: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const cloned: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) cloned[key] = cloneJson(child);
  return cloned;
}

function cloneGraph(graph: ImagegenGraphV1): MutableGraph {
  const cloned: MutableGraph = {};
  for (const [nodeId, node] of Object.entries(graph)) {
    cloned[nodeId] = {
      class_type: node.class_type,
      inputs: cloneRecord(node.inputs),
      ...(node._meta === undefined ? {} : { _meta: cloneRecord(node._meta) }),
    };
  }
  return cloned;
}

function setInput(
  graph: ReturnType<typeof cloneGraph>,
  address: ImagegenMutationAddressV1,
  value: JsonValue
): void {
  const node = graph[address.node_id];
  if (node === undefined || !Object.hasOwn(node.inputs, address.input_name)) {
    throw new Error(`videogen mutation '${address.node_id}.${address.input_name}' is absent`);
  }
  node.inputs[address.input_name] = value;
}

function getInput(
  graph: ImagegenGraphV1,
  address: ImagegenMutationAddressV1,
  label: string
): JsonValue {
  const node = graph[address.node_id];
  const value = node?.inputs[address.input_name];
  if (value === undefined) throw new Error(`${label} is absent from the submitted graph`);
  return value;
}

function assertProfileAllows(profile: VideogenProfileV1, spec: VideogenRenderSpecV1): void {
  if (profile.mode !== spec.mode) throw new Error("videogen mode does not match the profile");
  if (
    !profile.dimensions.some(
      (candidate) =>
        candidate.width === spec.dimensions.width && candidate.height === spec.dimensions.height
    )
  ) {
    throw new Error("videogen dimensions are outside the registered profile policy");
  }
  if (!profile.frame_counts.includes(spec.frame_count)) {
    throw new Error("videogen frame count is outside the registered profile policy");
  }
  if (!profile.fps_values.includes(spec.fps)) {
    throw new Error("videogen frame rate is outside the registered profile policy");
  }
  if (
    Buffer.byteLength(spec.positive_prompt, "utf8") > profile.limits.max_prompt_bytes ||
    Buffer.byteLength(spec.negative_prompt, "utf8") > profile.limits.max_prompt_bytes
  ) {
    throw new Error("videogen prompt exceeds the registered byte limit");
  }
}

function expectedFilenamePrefix(runId: string, shotId: string): string {
  return `video/penny/${sha256(canonicalJson({ run_id: runId, shot_id: shotId })).slice(0, 32)}`;
}

export function buildVideoSubmittedGraph(input: {
  readonly run_id: string;
  readonly shot_id: string;
  readonly profile_snapshot: VideogenProfileSnapshotV1;
  readonly profile_snapshot_ref: ArtifactRef;
  readonly spec: VideogenRenderSpecV1;
  readonly input_upload_receipt: VideoReferenceUploadReceiptV1 | null;
  readonly input_upload_receipt_ref: ArtifactRef | null;
}): VideoSubmittedGraphV1 {
  const snapshot = validateVideogenProfileSnapshot(input.profile_snapshot);
  const spec = validateVideogenRenderSpec(input.spec);
  const profile = snapshot.profile;
  assertProfileAllows(profile, spec);
  const graph = cloneGraph(profile.source_graph);
  setInput(graph, profile.mutations.positive_prompt, spec.positive_prompt);
  setInput(graph, profile.mutations.negative_prompt, spec.negative_prompt);
  setInput(graph, profile.mutations.seed, spec.seed);
  setInput(graph, profile.mutations.width, spec.dimensions.width);
  setInput(graph, profile.mutations.height, spec.dimensions.height);
  setInput(graph, profile.mutations.frame_count, spec.frame_count);
  setInput(graph, profile.mutations.fps, spec.fps);
  setInput(graph, profile.mutations.batch_size, 1);
  setInput(
    graph,
    profile.mutations.filename_prefix,
    expectedFilenamePrefix(input.run_id, input.shot_id)
  );

  let inputDescriptor: VideoSubmittedGraphV1["input_descriptor"] = null;
  if (profile.mode === "i2v") {
    if (
      input.input_upload_receipt === null ||
      input.input_upload_receipt_ref === null ||
      profile.mutations.input_image === null
    ) {
      throw new Error("i2v graph construction requires one verified input upload receipt");
    }
    const receipt = validateVideoReferenceUploadReceipt(input.input_upload_receipt);
    if (
      receipt.run_id !== input.run_id ||
      receipt.profile_id !== profile.profile_id ||
      receipt.profile_sha256 !== profile.profile_sha256
    ) {
      throw new Error("input upload receipt is not bound to this i2v graph");
    }
    inputDescriptor = receipt.remote_descriptor;
    setInput(
      graph,
      profile.mutations.input_image,
      `${receipt.remote_descriptor.subfolder}/${receipt.remote_descriptor.filename}`
    );
  } else if (input.input_upload_receipt !== null || input.input_upload_receipt_ref !== null) {
    throw new Error("t2v graph construction must not receive an input upload receipt");
  }

  const graphBytes = Buffer.byteLength(canonicalJson(graph), "utf8");
  if (graphBytes > profile.limits.max_graph_bytes) {
    throw new Error("prepared videogen graph exceeds the registered byte limit");
  }
  return validateVideoSubmittedGraph({
    schema_id: "penny.video-submitted-graph.v1",
    schema_version: 1,
    run_id: input.run_id,
    shot_id: input.shot_id,
    profile_id: profile.profile_id,
    profile_sha256: profile.profile_sha256,
    profile_snapshot_ref: input.profile_snapshot_ref,
    mode: spec.mode,
    dimensions: spec.dimensions,
    frame_count: spec.frame_count,
    fps: spec.fps,
    seed: spec.seed,
    input_upload_receipt_ref: input.input_upload_receipt_ref,
    input_descriptor: inputDescriptor,
    output_node_id: profile.mutations.output_node_id,
    graph,
  });
}

export function assertSubmittedGraphMatchesProfile(input: {
  readonly submitted: VideoSubmittedGraphV1;
  readonly profile_snapshot: VideogenProfileSnapshotV1;
  readonly profile_snapshot_ref: ArtifactRef;
  readonly input_upload_receipt?: VideoReferenceUploadReceiptV1;
  readonly input_upload_receipt_ref?: ArtifactRef;
}): void {
  const submitted = validateVideoSubmittedGraph(input.submitted);
  const snapshot = validateVideogenProfileSnapshot(input.profile_snapshot);
  const profile = snapshot.profile;
  assertRefEqual(submitted.profile_snapshot_ref, input.profile_snapshot_ref, "profile snapshot");
  if (
    submitted.profile_id !== profile.profile_id ||
    submitted.profile_sha256 !== profile.profile_sha256 ||
    submitted.mode !== profile.mode ||
    submitted.output_node_id !== profile.mutations.output_node_id
  ) {
    throw new Error("submitted graph identity does not match the registered profile");
  }
  const positivePrompt = getInput(
    submitted.graph,
    profile.mutations.positive_prompt,
    "positive prompt"
  );
  const negativePrompt = getInput(
    submitted.graph,
    profile.mutations.negative_prompt,
    "negative prompt"
  );
  if (typeof positivePrompt !== "string" || typeof negativePrompt !== "string") {
    throw new Error("submitted graph prompts must remain strings");
  }
  assertProfileAllows(profile, {
    mode: submitted.mode,
    positive_prompt: positivePrompt,
    negative_prompt: negativePrompt,
    seed: submitted.seed,
    dimensions: submitted.dimensions,
    frame_count: submitted.frame_count,
    fps: submitted.fps,
  });
  const expectedValues: ReadonlyArray<readonly [ImagegenMutationAddressV1, JsonValue, string]> = [
    [profile.mutations.seed, submitted.seed, "seed"],
    [profile.mutations.width, submitted.dimensions.width, "width"],
    [profile.mutations.height, submitted.dimensions.height, "height"],
    [profile.mutations.frame_count, submitted.frame_count, "frame count"],
    [profile.mutations.fps, submitted.fps, "fps"],
    [profile.mutations.batch_size, 1, "batch size"],
    [
      profile.mutations.filename_prefix,
      expectedFilenamePrefix(submitted.run_id, submitted.shot_id),
      "filename prefix",
    ],
  ];
  for (const [address, expected, label] of expectedValues) {
    if (canonicalJson(getInput(submitted.graph, address, label)) !== canonicalJson(expected)) {
      throw new Error(`submitted graph ${label} is not bound to its immutable metadata`);
    }
  }

  if (profile.mode === "i2v") {
    if (
      submitted.input_descriptor === null ||
      submitted.input_upload_receipt_ref === null ||
      input.input_upload_receipt === undefined ||
      input.input_upload_receipt_ref === undefined ||
      profile.mutations.input_image === null
    ) {
      throw new Error("i2v submitted graph is missing its verified input upload binding");
    }
    const receipt = validateVideoReferenceUploadReceipt(input.input_upload_receipt);
    assertRefEqual(
      submitted.input_upload_receipt_ref,
      input.input_upload_receipt_ref,
      "input upload receipt"
    );
    if (
      canonicalJson(submitted.input_descriptor) !== canonicalJson(receipt.remote_descriptor) ||
      getInput(submitted.graph, profile.mutations.input_image, "input image") !==
        `${receipt.remote_descriptor.subfolder}/${receipt.remote_descriptor.filename}`
    ) {
      throw new Error("i2v submitted graph is not bound to the verified upload descriptor");
    }
  } else if (
    submitted.input_descriptor !== null ||
    submitted.input_upload_receipt_ref !== null ||
    input.input_upload_receipt !== undefined ||
    input.input_upload_receipt_ref !== undefined
  ) {
    throw new Error("t2v submitted graph contains an unexpected input upload binding");
  }

  const normalized = cloneGraph(submitted.graph);
  const mutable = [
    profile.mutations.positive_prompt,
    profile.mutations.negative_prompt,
    profile.mutations.seed,
    profile.mutations.width,
    profile.mutations.height,
    profile.mutations.frame_count,
    profile.mutations.fps,
    profile.mutations.batch_size,
    profile.mutations.filename_prefix,
    ...(profile.mutations.input_image === null ? [] : [profile.mutations.input_image]),
  ];
  for (const address of mutable) {
    setInput(
      normalized,
      address,
      getInput(profile.source_graph, address, "profile mutation source value")
    );
  }
  if (canonicalJson(normalized) !== canonicalJson(profile.source_graph)) {
    throw new Error("submitted graph changes content outside the registered mutation allowlist");
  }
  if (Buffer.byteLength(canonicalJson(submitted.graph), "utf8") > profile.limits.max_graph_bytes) {
    throw new Error("submitted graph exceeds the registered byte limit");
  }
}
