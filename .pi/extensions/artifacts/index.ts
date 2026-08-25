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

export default function artifactExtension(pi: ExtensionAPI): void {
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
      "Read one exact immutable artifact by ID.",
      "Artifact IDs are internal communication addresses, not grants, and reads do not expire.",
      "This tool cannot list, search, discover, or guess artifacts.",
      "Use next_range for bounded continuation until truncated is false.",
    ].join(" "),
    parameters: ArtifactReadParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let config: ArtifactRuntimeConfig;
      try {
        config = loadArtifactRuntimeConfig(ctx.cwd, process.env);
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
  ArtifactReadParams,
  ArtifactRef,
  ArtifactRuntimeConfig,
} from "./types.js";
