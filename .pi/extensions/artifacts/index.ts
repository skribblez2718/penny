import { registerTool } from "../../lib/pi-tool-registration.js";
/** Direct, non-expiring reads of exact immutable artifact IDs. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../lib/logger/logger.js";
import {
  configurationErrorResult,
  executeArtifactRead,
  loadArtifactRuntimeConfig,
} from "./artifact-runtime.js";
import {
  ArtifactReadParamsSchema,
  type ArtifactRuntimeConfig,
  type ArtifactTelemetry,
} from "./types.js";

const logger = createLogger("artifacts");

/** Host-selected worker state. Captured in closure, never part of the model tool parameters. */
export function createArtifactReadExtension(host: {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  return (pi: ExtensionAPI): void => registerArtifactReader(pi, host);
}
export default function artifactExtension(pi: ExtensionAPI): void {
  registerArtifactReader(pi);
}
function registerArtifactReader(
  pi: ExtensionAPI,
  host?: { readonly projectRoot: string; readonly env: NodeJS.ProcessEnv }
): void {
  const telemetry: ArtifactTelemetry = {
    info(event, context) {
      logger.info(event, context);
    },
    warn(event, context) {
      logger.warn(event, context);
    },
  };

  registerTool(pi, {
    name: "artifact_read",
    label: "Artifact Read",
    description: [
      "Read one exact immutable text or canonical PNG artifact by ID.",
      "Artifact IDs are internal communication addresses, not grants, and reads do not expire.",
      "This tool cannot list, search, discover, or guess artifacts.",
      "Use next_range for bounded text continuation until truncated is false; PNG reads do not accept ranges.",
    ].join(" "),
    parameters: ArtifactReadParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let config: ArtifactRuntimeConfig;
      try {
        config = loadArtifactRuntimeConfig(host?.projectRoot ?? ctx.cwd, host?.env ?? process.env);
      } catch (error) {
        const execution = configurationErrorResult(error);
        telemetry.warn("artifact_read_failed", {
          errorCode: execution.code,
          configurationReady: false,
        });
        return execution.result;
      }
      return (await executeArtifactRead(config, params, { telemetry })).result;
    },
  });
}

export {
  ArtifactReadParamsSchema,
  configurationErrorResult,
  executeArtifactRead,
  loadArtifactRuntimeConfig,
};
export type {
  ArtifactExecution,
  ArtifactImageToolResult,
  ArtifactReadParams,
  ArtifactRef,
  ArtifactRuntimeConfig,
  ArtifactToolResult,
} from "./types.js";
