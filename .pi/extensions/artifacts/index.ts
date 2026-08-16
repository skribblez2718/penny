/**
 * Constrained, read-only artifact access for model workers.
 *
 * Grants and caller identity come only from trusted process invocation context;
 * model arguments can identify an artifact or continuation but cannot grant it.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { createLogger } from "../../lib/logger/logger.js";
import {
  configurationErrorResult,
  executeArtifactRead,
  loadArtifactRuntimeConfig,
} from "./artifact-runtime.js";
import type { ArtifactReadParams, ArtifactRuntimeConfig, ArtifactTelemetry } from "./types.js";

const logger = createLogger("artifacts");

const CanonicalStringSchema = Type.String({
  minLength: 1,
  pattern: "^(?!\\s)(?!.*\\s$)(?!.*[\\u0000-\\u001F\\u007F]).+$",
});

const ArtifactRefSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_id: Type.String({
      pattern: "^art_[a-f0-9]{64}$",
      description: "Canonical immutable artifact owner identity",
    }),
    run_id: CanonicalStringSchema,
    phase: CanonicalStringSchema,
    branch_id: Type.Union([CanonicalStringSchema, Type.Null()]),
    kind: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    operation_id: CanonicalStringSchema,
    version: Type.Integer({ minimum: 1 }),
    producer: CanonicalStringSchema,
    consumer_scope: Type.Array(CanonicalStringSchema, { uniqueItems: true }),
    media_type: CanonicalStringSchema,
    byte_length: Type.Integer({ minimum: 0 }),
    content_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    store_ref: Type.String({ pattern: "^artifact://sha256/[a-f0-9]{64}$" }),
  },
  { additionalProperties: false }
);

const ArtifactReadParamsSchema = Type.Object(
  {
    artifact: Type.Union(
      [
        Type.String({
          pattern: "^art_[a-f0-9]{64}$",
          description: "Canonical immutable artifact owner identity",
        }),
        ArtifactRefSchema,
      ],
      {
        description:
          "Exact artifact ID or immutable artifact ref already supplied by the execution owner",
      }
    ),
    range: Type.Optional(
      Type.Object(
        {
          start: Type.Integer({
            minimum: 0,
            description: "Inclusive UTF-8 byte offset",
          }),
          end: Type.Optional(
            Type.Integer({
              minimum: 0,
              description: "Exclusive UTF-8 byte offset; defaults to artifact end",
            })
          ),
        },
        { additionalProperties: false }
      )
    ),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4096,
        description: "Opaque continuation cursor returned by a prior artifact_read",
      })
    ),
  },
  { additionalProperties: false }
);

export default function artifactExtension(pi: ExtensionAPI): void {
  let config: ArtifactRuntimeConfig | undefined;
  let configError: unknown;
  try {
    // Read process.env inside the factory, after Penny's environment extension.
    config = loadArtifactRuntimeConfig(process.env);
  } catch (error) {
    configError = error;
  }

  const telemetry: ArtifactTelemetry = {
    info(event, context) {
      logger.info(event, context);
    },
    warn(event, context) {
      logger.warn(event, context);
    },
  };

  pi.registerTool({
    name: "artifact_read",
    label: "Artifact Read",
    description: [
      "Read one exact immutable artifact already granted by the execution owner.",
      "Use only with an artifact ID/ref or opaque continuation you were given.",
      "This tool cannot list, search, discover, guess, or grant artifacts.",
      "Byte ranges are UTF-8 and use an inclusive start and exclusive end.",
    ].join(" "),
    parameters: ArtifactReadParamsSchema,
    async execute(_toolCallId: string, params: ArtifactReadParams) {
      if (!config) {
        const execution = configurationErrorResult(configError);
        telemetry.warn("artifact_read_failed", {
          errorCode: execution.code,
          configurationReady: false,
          compactionCorrelation: { status: "not_evaluated", keys: [] },
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
  ArtifactEnvelope,
  ArtifactInvocation,
  ArtifactReadParams,
  ArtifactRef,
  ArtifactRuntimeConfig,
} from "./types.js";
