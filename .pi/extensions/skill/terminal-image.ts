import {
  buildSkillImageOutputPresentation,
  type PngImageInfo,
  type PngMediaLimits,
} from "@penny/orchestration";

import type { ArtifactRef } from "./artifact-client.js";

import type { PngImageContent } from "@penny/orchestration";

export interface TerminalImagePresentation {
  readonly content: Array<{ type: "text"; text: string } | PngImageContent>;
  readonly imageInfo: PngImageInfo;
}

/**
 * Build the parent-facing result for one already re-read terminal PNG artifact.
 *
 * The rendering lives in orchestration so the opt-in imagegen critic qualification can exercise
 * the exact same parent skill result path without importing this extension package.
 * Base64 exists only in Pi's transient image content block, never metadata/details.
 */
export function terminalImagePresentation(input: {
  readonly skillName: string;
  readonly ref: ArtifactRef;
  readonly bytes: Uint8Array;
  readonly limits?: PngMediaLimits;
}): TerminalImagePresentation {
  return buildSkillImageOutputPresentation({
    skill_name: input.skillName,
    ref: input.ref,
    bytes: input.bytes,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  });
}
