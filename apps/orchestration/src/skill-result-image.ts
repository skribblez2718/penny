import type { ArtifactRef } from "./contracts.js";
import {
  canonicalPngImageContent,
  type PngImageContent,
  type PngImageInfo,
  type PngMediaLimits,
} from "./png-media.js";

/**
 * Parent-skill-facing presentation of one already re-read terminal PNG artifact.
 *
 * This is the shared implementation behind the skill extension's
 * `terminalImagePresentation`. Keeping it here lets the opt-in imagegen critic
 * qualification exercise the exact rendering path the parent skill uses without
 * importing the extension package. Base64 exists only in Pi's transient image
 * content block, never in the bounded textual metadata.
 */
export interface SkillImageOutputPresentation {
  readonly content: Array<{ readonly type: "text"; readonly text: string } | PngImageContent>;
  readonly imageInfo: PngImageInfo;
}

export function buildSkillImageOutputPresentation(input: {
  readonly skill_name: string;
  readonly ref: ArtifactRef;
  readonly bytes: Uint8Array;
  readonly limits?: PngMediaLimits;
}): SkillImageOutputPresentation {
  if (input.ref.media_type !== "image/png") {
    throw new TypeError("terminal image presentation requires media_type image/png");
  }
  const image = canonicalPngImageContent(input.bytes, input.limits);
  const metadata = {
    schema_version: 2,
    ok: true,
    type: "skill_image_output",
    skill_name: input.skill_name,
    artifact_ref: input.ref,
    media_type: input.ref.media_type,
    total_bytes: input.ref.byte_length,
    content_digest: input.ref.content_digest,
    image: {
      width: image.info.width,
      height: image.info.height,
      channels: image.info.channels,
      pixel_count: image.info.pixelCount,
      decoded_bytes: image.info.decodedBytes,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(metadata) }, image.content],
    imageInfo: image.info,
  };
}
