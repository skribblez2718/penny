import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../dist/canonical-json.js";
import { KdenliveFixtureRegistry } from "../../dist/videogen/kdenlive-registry.js";
import { type NativeXmlLimits } from "../../dist/videogen/native-xml.js";
import { type EditDecisionV1 } from "../../dist/videogen/edit-contracts.js";
import { type NativeWriteInput } from "../../dist/videogen/kdenlive-writer.js";
import { editFixture, time } from "./videogen-edit-fixtures.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./videogen-foundation-fixtures.js";
export const XML_LIMITS: NativeXmlLimits = {
  max_bytes: 262144,
  max_nodes: 8192,
  max_depth: 16,
  max_text: 65536,
};
export function saved(name: string): Buffer {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/videogen/native/${name}`, import.meta.url))
  );
}
export function registry(): KdenliveFixtureRegistry {
  return new KdenliveFixtureRegistry({
    editor_build_digest: sha256("test build pin; not qualification"),
    mlt_build_digest: sha256("test MLT pin; not qualification"),
    limits: XML_LIMITS,
    fixtures: ["single.kdenlive", "caption.kdenlive", "ordered.kdenlive"].map((n) => {
      const bytes = saved(n);
      return { bytes, sha256: sha256(bytes) };
    }),
  });
}
export function nativeInput(f: FoundationFixture): NativeWriteInput & { edit: EditDecisionV1 } {
  const e = editFixture(f),
    clip = e.edit.tracks[0]?.items.find((i) => i.kind === "clip");
  if (clip?.kind !== "clip") throw new Error("fixture clip missing");
  const edit: EditDecisionV1 = {
    ...e.edit,
    canvas: {
      ...e.edit.canvas,
      width: 512,
      height: 288,
      fps: { numerator: 25, denominator: 1 },
      color_space: "601",
    },
    tracks: [
      {
        track_id: "picture",
        kind: "video",
        order: 0,
        items: [
          {
            ...clip,
            source_in: time(0),
            source_out: time(2),
            timeline_start: time(0),
            timeline_end: time(2),
            frame_in: 0,
            frame_out: 50,
          },
        ],
      },
    ],
    mix_buses: [],
    end_time: time(2),
    cut_boundaries: [],
  };
  return {
    registry: registry(),
    fixture_digest: sha256(saved("single.kdenlive")),
    edit,
    assets: [
      {
        source_ref: e.video,
        relative_path: "assets/video.mp4",
        bytes: f.store.read(e.video),
        duration_frames: 50,
      },
    ],
    limits: FOUNDATION_LIMITS,
    max_frames: 10000,
  };
}
