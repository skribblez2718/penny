import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import { ComfyInputNameSchema, assertComfyJson } from "../dist/comfy/input-contracts.js";
import {
  requireComfyGraphInventory,
  requirePinnedComfyInventory,
} from "../dist/comfy/graph-inventory.js";
import {
  validateVideogenProfile,
  validateVideoSubmittedGraph,
  type VideogenProfileV1,
} from "../dist/videogen/contracts.js";
import {
  buildVideoSubmittedGraph,
  assertSubmittedGraphMatchesProfile,
} from "../dist/videogen/graph-builder.js";
import {
  syntheticVideogenProfile,
  syntheticVideogenInventory,
} from "./helpers/videogen-fixtures.js";
import { ComfyVideogenOperationAdapter } from "../dist/videogen/operation-owner.js";
import { StaticVideogenProfileRegistry } from "../dist/videogen/profile-registry.js";
import { previewArtifactRef } from "../dist/artifact-store.js";

function profile(): VideogenProfileV1 {
  const p = syntheticVideogenProfile({ port: 1 });
  const output = p.source_graph["7"];
  if (!output) throw new Error("output missing");
  output.inputs["format"] = "mp4";
  output.inputs["format.codec"] = "h264";
  const policy = p.node_classes.find((n) => n.class_type === "SaveVideo");
  if (!policy) throw new Error("policy missing");
  policy.inputs.push(
    { input_name: "format", value_type: "string", semantic: "data" },
    { input_name: "format.codec", value_type: "string", semantic: "data" }
  );
  const { profile_sha256: _old, ...body } = p;
  body.source_graph_sha256 = sha256(canonicalJson(body.source_graph));
  return validateVideogenProfile({ ...body, profile_sha256: sha256(canonicalJson(body)) });
}
function inventory() {
  return {
    ...syntheticVideogenInventory(),
    SaveVideo: {
      input: {
        required: {
          filename_prefix: ["STRING", { default: "video/synthetic" }],
          format: [
            "COMFY_DYNAMICCOMBO_V3",
            {
              default: "mp4",
              options: [
                {
                  key: "mp4",
                  inputs: {
                    required: {
                      codec: [
                        "COMFY_DYNAMICCOMBO_V3",
                        {
                          default: "h264",
                          options: [
                            { key: "h264", inputs: { required: {} } },
                            { key: "av1", inputs: { required: {} } },
                          ],
                        },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  };
}
describe("bounded literal Comfy video input keys", () => {
  it.each([
    "format.codec",
    "a.b.c.d.e.f.g.h",
    "ordinary_input",
    "a".repeat(64),
    "_private.segment2",
  ])("accepts literal %s", (key) => {
    expect(validateSkillSchema(ComfyInputNameSchema, key, "input")).toBe(key);
  });
  it.each([
    "",
    ".a",
    "a.",
    "a..b",
    "a/b",
    "a\\b",
    "a[0]",
    "a\u0000b",
    "é",
    "a b",
    "a:b",
    "1bad",
    "a.2bad",
    "a.b.c.d.e.f.g.h.i",
    "a".repeat(65),
    "__proto__",
    "constructor",
    "prototype",
    "format.__proto__",
    "constructor.x",
    "a.prototype.b",
  ])("refuses %s", (key) => {
    expect(() => validateSkillSchema(ComfyInputNameSchema, key, "input")).toThrow();
  });
  it("rejects null/custom prototypes, accessors, cycles, sparse arrays, unsafe nested keys and nonfinite representation", () => {
    for (const value of [
      Object.create(null),
      new Date(),
      {
        get x() {
          throw new Error("getter executed");
        },
      },
      new Array<unknown>(3),
      JSON.parse('{"a.__proto__.b":1}'),
      { n: NaN },
      { n: Infinity },
    ])
      expect(() => assertComfyJson(value)).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic["x"] = cyclic;
    expect(() => assertComfyJson(cyclic)).toThrow("complexity");
    expect(() => assertComfyJson({ format: null })).not.toThrow();
    const p = profile();
    const output = p.source_graph["7"];
    if (!output) throw new Error("output missing");
    output.inputs["format.codec"] = null;
    expect(() => validateVideogenProfile(p)).toThrow();
  });
  it("requires every declared source input, validates nested enum/default and detects pinned inventory drift", () => {
    const p = profile();
    const good = inventory();
    expect(() => requireComfyGraphInventory(p.source_graph, good)).not.toThrow();
    const out = p.source_graph["7"];
    if (!out) throw new Error("output missing");
    delete out.inputs["format.codec"];
    expect(() => requireComfyGraphInventory(p.source_graph, good)).toThrow(
      "required input missing"
    );
    expect(() =>
      validateVideogenProfile({ ...p, source_graph_sha256: sha256(canonicalJson(p.source_graph)) })
    ).toThrow();
    out.inputs["format.codec"] = "not-a-codec";
    expect(() => requireComfyGraphInventory(p.source_graph, good)).toThrow("enum mismatch");
    out.inputs["format.codec"] = "h264";
    expect(() =>
      requirePinnedComfyInventory(p.source_graph, good, {
        ...good,
        SaveVideo: { ...good.SaveVideo, changed: true },
      })
    ).toThrow("inventory drift");
    expect(() =>
      requireComfyGraphInventory(p.source_graph, {
        ...good,
        SaveVideo: {
          input: { required: { format: ["COMBO", { options: ["mp4"], default: "invalid" }] } },
        },
      })
    ).toThrow("default invalid");
    out.inputs["format.other"] = "x";
    expect(() => requireComfyGraphInventory(p.source_graph, good)).toThrow("unknown or unselected");
  });
  it("prepared graphs preserve dotted literals and refuse any unapproved change", () => {
    const p = profile();
    const snapshot = {
      schema_id: "penny.videogen-profile-snapshot.v1" as const,
      schema_version: 1 as const,
      profile: p,
      approved_profile_sha256: p.profile_sha256,
      source_graph_sha256: p.source_graph_sha256,
    };
    const ref = previewArtifactRef({
      metadata: {
        schema_version: 2,
        run_id: "test",
        phase: "test",
        branch_id: null,
        kind: "snapshot",
        operation_id: "snapshot",
        version: 1,
        producer: "host:test",
        media_type: "application/json",
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(snapshot),
    });
    const submitted = buildVideoSubmittedGraph({
      run_id: "test",
      shot_id: "test",
      profile_snapshot: snapshot,
      profile_snapshot_ref: ref,
      spec: {
        mode: "t2v",
        positive_prompt: "x",
        negative_prompt: "",
        seed: 1,
        dimensions: { width: 64, height: 64 },
        frame_count: 3,
        fps: 3,
      },
      input_upload_receipt: null,
      input_upload_receipt_ref: null,
    });
    expect(() =>
      assertSubmittedGraphMatchesProfile({
        submitted,
        profile_snapshot: snapshot,
        profile_snapshot_ref: ref,
      })
    ).not.toThrow();
    const out = submitted.graph["7"];
    if (!out) throw new Error("output missing");
    expect(out.inputs["format.codec"]).toBe("h264");
    out.inputs["format.codec"] = "av1";
    expect(() =>
      assertSubmittedGraphMatchesProfile({
        submitted,
        profile_snapshot: snapshot,
        profile_snapshot_ref: ref,
      })
    ).toThrow("outside the registered");
    const unsafeGraph: unknown = JSON.parse(
      '{"1":{"class_type":"SaveVideo","inputs":{"a.constructor":1}}}'
    );
    const malicious = { ...submitted, graph: unsafeGraph };
    expect(() => validateVideoSubmittedGraph(malicious)).toThrow();
  });
  it("does not silently use legacy HTTP without explicit opt-in", () => {
    const p = profile();
    const profiles = new StaticVideogenProfileRegistry({
      profiles: [p],
      approved_profile_sha256_by_id: new Map([[p.profile_id, p.profile_sha256]]),
    });
    expect(() => new ComfyVideogenOperationAdapter({ profiles })).toThrow("legacy opt-in");
    expect(() => new ComfyVideogenOperationAdapter({ profiles, legacy_http: true })).not.toThrow();
  });
});
