import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import {
  validateVideogenProfile,
  type VideogenProfileBodyV1,
  type VideogenProfileV1,
} from "../../dist/videogen/contracts.js";

export function syntheticVideogenInventory(modelId = "synthetic-video-model.safetensors") {
  return {
    ModelLoader: {
      input: { required: { model_name: [[modelId], { default: modelId }] } },
    },
    PositiveText: { input: { required: { text: ["STRING", { multiline: true }] } } },
    NegativeText: { input: { required: { text: ["STRING", { multiline: true }] } } },
    VideoLatent: {
      input: {
        required: {
          width: ["INT", { default: 64 }],
          height: ["INT", { default: 64 }],
          length: ["INT", { default: 3 }],
          batch_size: ["INT", { default: 1 }],
        },
      },
    },
    Sampler: { input: { required: { seed: ["INT", { default: 7 }] } } },
    CreateVideo: { input: { required: { fps: ["INT", { default: 3 }] } } },
    SaveVideo: {
      input: { required: { filename_prefix: ["STRING", { default: "video/synthetic" }] } },
    },
    LoadImage: { input: { required: { image: ["STRING", { default: "placeholder.png" }] } } },
  };
}

export function syntheticVideogenProfile(input: {
  readonly port: number;
  readonly mode?: "t2v" | "i2v";
  readonly model_id?: string;
}): VideogenProfileV1 {
  const mode = input.mode ?? "t2v";
  const modelId = input.model_id ?? "synthetic-video-model.safetensors";
  const sourceGraph = {
    "1": { class_type: "ModelLoader", inputs: { model_name: modelId } },
    "2": { class_type: "PositiveText", inputs: { text: "source positive" } },
    "3": { class_type: "NegativeText", inputs: { text: "source negative" } },
    "4": {
      class_type: "VideoLatent",
      inputs: { width: 64, height: 64, length: 3, batch_size: 1 },
    },
    "5": { class_type: "Sampler", inputs: { seed: 7 } },
    "6": { class_type: "CreateVideo", inputs: { fps: 3 } },
    "7": { class_type: "SaveVideo", inputs: { filename_prefix: "video/synthetic" } },
    ...(mode === "i2v"
      ? { "8": { class_type: "LoadImage", inputs: { image: "placeholder.png" } } }
      : {}),
  };
  const classTypes = Object.values(sourceGraph).map((node) => node.class_type);
  const body = {
    schema_id: "penny.videogen-profile.v1" as const,
    schema_version: 1 as const,
    profile_id: `synthetic-${mode}`,
    source_graph_sha256: sha256(canonicalJson(sourceGraph)),
    mode,
    endpoint: { scheme: "http" as const, host: "127.0.0.1" as const, port: input.port },
    source_graph: sourceGraph,
    node_classes: [
      {
        class_type: "ModelLoader",
        execution_class: "pure_compute" as const,
        inputs: [
          {
            input_name: "model_name",
            value_type: "string" as const,
            semantic: "registered_asset" as const,
          },
        ],
      },
      {
        class_type: "PositiveText",
        execution_class: "pure_compute" as const,
        inputs: [{ input_name: "text", value_type: "string" as const, semantic: "data" as const }],
      },
      {
        class_type: "NegativeText",
        execution_class: "pure_compute" as const,
        inputs: [{ input_name: "text", value_type: "string" as const, semantic: "data" as const }],
      },
      {
        class_type: "VideoLatent",
        execution_class: "pure_compute" as const,
        inputs: [
          { input_name: "width", value_type: "integer" as const, semantic: "data" as const },
          { input_name: "height", value_type: "integer" as const, semantic: "data" as const },
          { input_name: "length", value_type: "integer" as const, semantic: "data" as const },
          { input_name: "batch_size", value_type: "integer" as const, semantic: "data" as const },
        ],
      },
      {
        class_type: "Sampler",
        execution_class: "pure_compute" as const,
        inputs: [{ input_name: "seed", value_type: "integer" as const, semantic: "data" as const }],
      },
      {
        class_type: "CreateVideo",
        execution_class: "pure_compute" as const,
        inputs: [{ input_name: "fps", value_type: "integer" as const, semantic: "data" as const }],
      },
      {
        class_type: "SaveVideo",
        execution_class: "backend_output" as const,
        inputs: [
          {
            input_name: "filename_prefix",
            value_type: "string" as const,
            semantic: "data" as const,
          },
        ],
      },
      ...(mode === "i2v"
        ? [
            {
              class_type: "LoadImage",
              execution_class: "pure_compute" as const,
              inputs: [
                { input_name: "image", value_type: "string" as const, semantic: "data" as const },
              ],
            },
          ]
        : []),
    ],
    mutations: {
      positive_prompt: { node_id: "2", input_name: "text" },
      negative_prompt: { node_id: "3", input_name: "text" },
      seed: { node_id: "5", input_name: "seed" },
      width: { node_id: "4", input_name: "width" },
      height: { node_id: "4", input_name: "height" },
      frame_count: { node_id: "4", input_name: "length" },
      fps: { node_id: "6", input_name: "fps" },
      batch_size: { node_id: "4", input_name: "batch_size" },
      filename_prefix: { node_id: "7", input_name: "filename_prefix" },
      input_image: mode === "i2v" ? { node_id: "8", input_name: "image" } : null,
      output_node_id: "7",
    },
    dimensions: [{ width: 64, height: 64 }],
    frame_counts: [3],
    fps_values: [3],
    required_inventory: { class_types: classTypes, model_ids: [modelId] },
    input_subfolder: "penny/videogen",
    limits: {
      max_prompt_bytes: 16_384,
      max_graph_bytes: 65_536,
      max_request_json_bytes: 65_536,
      max_inventory_json_bytes: 65_536,
      max_history_json_bytes: 65_536,
      max_upload_bytes: 1_048_576,
      max_video_bytes: 1_048_576,
      poll_interval_ms: 1,
      max_poll_attempts: 8,
      max_transient_poll_failures: 1,
      connect_timeout_ms: 1_000,
      read_timeout_ms: 1_000,
    },
  } satisfies VideogenProfileBodyV1;
  return validateVideogenProfile({ ...body, profile_sha256: sha256(canonicalJson(body)) });
}
