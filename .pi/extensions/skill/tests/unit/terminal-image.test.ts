import { createHash } from "node:crypto";

import { canonicalJson, encodeCanonicalPng } from "@penny/orchestration";
import { describe, expect, it } from "vitest";

import type { ArtifactRef } from "../../artifact-client.js";
import { terminalImagePresentation } from "../../terminal-image.js";

function fixture(): { readonly ref: ArtifactRef; readonly bytes: Buffer } {
  const bytes = Buffer.from(
    encodeCanonicalPng({
      width: 1,
      height: 1,
      rgba: Uint8Array.from([90, 80, 70, 255]),
    })
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    ref: {
      schema_version: 2,
      artifact_id: `art_${"a".repeat(64)}`,
      run_id: "run-image",
      phase: "complete",
      branch_id: null,
      kind: "selected-image",
      operation_id: "selected-image-v1",
      version: 1,
      producer: "host:image-fixture",
      media_type: "image/png",
      byte_length: bytes.length,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    },
  };
}

describe("synthetic terminal image presentation", () => {
  it("returns bounded identity metadata plus the exact Pi image content block", () => {
    const item = fixture();
    const result = terminalImagePresentation({
      skillName: "synthetic-image",
      ref: item.ref,
      bytes: item.bytes,
    });
    expect(result.content).toHaveLength(2);
    const metadataContent = result.content[0];
    const imageContent = result.content[1];
    if (metadataContent?.type !== "text" || imageContent?.type !== "image") {
      throw new Error("terminal image result has the wrong content shape");
    }
    expect(JSON.parse(metadataContent.text)).toMatchObject({
      ok: true,
      type: "skill_image_output",
      skill_name: "synthetic-image",
      artifact_ref: { artifact_id: item.ref.artifact_id },
      media_type: "image/png",
      content_digest: item.ref.content_digest,
      image: { width: 1, height: 1, channels: 4, pixel_count: 1 },
    });
    expect(metadataContent.text).not.toContain(item.bytes.toString("base64"));
    expect(metadataContent.text).not.toContain("/tmp/");
    expect(imageContent).toEqual({
      type: "image",
      data: item.bytes.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("presents the exact selected imagegen semantic artifact without changing its identity", () => {
    const item = fixture();
    const identity = {
      branch_id: null,
      kind: "generated-image",
      operation_id: "imagegen-slot-0-revision-0",
      phase: "generating_candidate",
      run_id: item.ref.run_id,
      version: 1,
    };
    const ref = {
      ...item.ref,
      ...identity,
      artifact_id: `art_${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`,
    };
    const result = terminalImagePresentation({ skillName: "imagegen", ref, bytes: item.bytes });
    const metadata = result.content[0];
    const image = result.content[1];
    if (metadata?.type !== "text" || image?.type !== "image") {
      throw new Error("imagegen terminal presentation has the wrong content shape");
    }
    expect(JSON.parse(metadata.text)).toMatchObject({
      skill_name: "imagegen",
      artifact_ref: {
        artifact_id: ref.artifact_id,
        kind: "generated-image",
        phase: "generating_candidate",
      },
      content_digest: ref.content_digest,
    });
    expect(image.data).toBe(item.bytes.toString("base64"));
  });

  it("rejects wrong media and malformed PNG bytes", () => {
    const item = fixture();
    expect(() =>
      terminalImagePresentation({
        skillName: "synthetic-image",
        ref: { ...item.ref, media_type: "application/octet-stream" },
        bytes: item.bytes,
      })
    ).toThrow(/media_type image\/png/u);
    expect(() =>
      terminalImagePresentation({
        skillName: "synthetic-image",
        ref: item.ref,
        bytes: Buffer.from("not-png"),
      })
    ).toThrow(/signature/u);
  });
});
