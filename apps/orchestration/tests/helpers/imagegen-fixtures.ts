import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import {
  imagegenProfileSha256,
  validateImagegenProfile,
  type ImagegenProfileBodyV1,
  type ImagegenProfileV1,
} from "../../dist/skill-contracts/imagegen.js";
import type { ImagegenNodeClassSafetyPolicyV1 } from "../../dist/imagegen/types.js";

export const SYNTHETIC_NODE_POLICIES: readonly ImagegenNodeClassSafetyPolicyV1[] = [
  {
    schema_version: 1,
    class_type: "PromptNode",
    execution_class: "pure_compute",
    inputs: [
      { input_name: "positive", value_type: "string", semantic: "data" },
      { input_name: "negative", value_type: "string", semantic: "data" },
    ],
  },
  {
    schema_version: 1,
    class_type: "SamplerNode",
    execution_class: "pure_compute",
    inputs: [{ input_name: "seed", value_type: "integer", semantic: "data" }],
  },
  {
    schema_version: 1,
    class_type: "CanvasNode",
    execution_class: "pure_compute",
    inputs: [
      { input_name: "width", value_type: "integer", semantic: "data" },
      { input_name: "height", value_type: "integer", semantic: "data" },
      { input_name: "batch", value_type: "integer", semantic: "data" },
    ],
  },
  {
    schema_version: 1,
    class_type: "OutputNode",
    execution_class: "backend_output",
    inputs: [
      { input_name: "prefix", value_type: "string", semantic: "data" },
      { input_name: "asset", value_type: "string", semantic: "registered_asset" },
    ],
  },
];

export function syntheticInventory(assetId = "asset-primary"): Record<string, unknown> {
  return {
    PromptNode: { inputs: { positive: ["STRING"], negative: ["STRING"] } },
    SamplerNode: { inputs: { seed: ["INT"] } },
    CanvasNode: { inputs: { width: ["INT"], height: ["INT"], batch: ["INT"] } },
    OutputNode: { inputs: { prefix: ["STRING"], asset: [[assetId]] } },
  };
}

export function syntheticProfile(input: {
  readonly port: number;
  readonly profile_id?: string;
  readonly inventory?: Record<string, unknown>;
  readonly max_run_storage_bytes?: number;
  readonly fallback?: {
    readonly absent_model_id: string;
    readonly replacement_asset_id: string;
    readonly fallback_inventory: Record<string, unknown>;
  };
}): ImagegenProfileV1 {
  const graph = {
    "1": {
      class_type: "PromptNode",
      inputs: { positive: "source positive", negative: "source negative" },
      _meta: { title: "metadata removed before submission" },
    },
    "2": { class_type: "SamplerNode", inputs: { seed: 0 } },
    "3": { class_type: "CanvasNode", inputs: { width: 2, height: 2, batch: 7 } },
    "4": {
      class_type: "OutputNode",
      inputs: { prefix: "source-prefix", asset: "asset-primary" },
    },
  };
  const inventory = input.inventory ?? syntheticInventory();
  const body: ImagegenProfileBodyV1 = {
    schema_id: "penny.imagegen-profile.v1",
    schema_version: 1,
    profile_id: input.profile_id ?? "synthetic-profile",
    description: "Synthetic host-injected profile used only by hermetic contract tests.",
    source_graph_sha256: sha256(canonicalJson(graph)),
    endpoint: { scheme: "http", host: "127.0.0.1", port: input.port },
    source_graph: graph,
    node_classes: SYNTHETIC_NODE_POLICIES.map((policy) => ({
      class_type: policy.class_type,
      execution_class: policy.execution_class,
      inputs: [...policy.inputs],
    })),
    mutations: {
      positive_prompt: { node_id: "1", input_name: "positive" },
      negative_prompt: { node_id: "1", input_name: "negative" },
      seed: { node_id: "2", input_name: "seed" },
      width: { node_id: "3", input_name: "width" },
      height: { node_id: "3", input_name: "height" },
      batch_size: { node_id: "3", input_name: "batch" },
      filename_prefix: { node_id: "4", input_name: "prefix" },
      output_node_id: "4",
    },
    dimension_policy: { policy: "allowlist", values: [{ width: 2, height: 2 }] },
    default_dimensions: { width: 2, height: 2 },
    required_inventory: {
      object_info_sha256: sha256(canonicalJson(inventory)),
      class_types: ["PromptNode", "SamplerNode", "CanvasNode", "OutputNode"],
      model_ids: [input.fallback?.absent_model_id ?? "asset-primary"],
    },
    fallback:
      input.fallback === undefined
        ? null
        : {
            fallback_id: "synthetic-fallback",
            when_model_ids_absent: [input.fallback.absent_model_id],
            object_info_sha256: sha256(canonicalJson(input.fallback.fallback_inventory)),
            required_model_ids: [input.fallback.replacement_asset_id],
            rewrites: [
              {
                node_id: "4",
                input_name: "asset",
                value: input.fallback.replacement_asset_id,
              },
            ],
          },
    prompt_scaffold: {
      prefix: "illustration",
      suffix: "clean composition",
      wordless_negative: "letters, words, captions",
    },
    limits: {
      max_prompt_characters: 4_096,
      max_prompt_bytes: 16_384,
      max_graph_bytes: 65_536,
      max_request_json_bytes: 65_536,
      max_inventory_json_bytes: 65_536,
      max_history_json_bytes: 65_536,
      max_image_bytes: 1_048_576,
      max_pixels: 16,
      poll_interval_ms: 1,
      max_poll_attempts: 8,
      max_transient_poll_failures: 1,
      connect_timeout_ms: 1_000,
      read_timeout_ms: 1_000,
      candidate_inactivity_ms: 5_000,
      workflow_inactivity_ms: 30_000,
      max_run_storage_bytes: input.max_run_storage_bytes ?? 16_777_216,
      max_proven_pre_acceptance_retries: 1,
    },
  };
  return validateImagegenProfile({ ...body, profile_sha256: imagegenProfileSha256(body) });
}
