import type { TextToolResult, ToolResultBudget } from "../lib/tool-result-budget.js";
import type { ArtifactRef } from "./owner-client.js";
import { Type, type Static } from "typebox";

export const ARTIFACT_SCHEMA_VERSION = 2 as const;
export const ARTIFACT_OPERATION = "artifact_read" as const;

export type ArtifactErrorCode =
  | "ARTIFACT_CONFIG_INVALID"
  | "ARTIFACT_INVALID_ID"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "ARTIFACT_ENCODING_INVALID"
  | "ARTIFACT_RANGE_INVALID"
  | "ARTIFACT_RESULT_BUDGET_EXCEEDED";

export type { ArtifactRef };

export const ArtifactReadParamsSchema = Type.Object(
  {
    artifact: Type.String({
      pattern: "^art_[a-f0-9]{64}$",
      description: "Exact immutable artifact ID",
    }),
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
  },
  { additionalProperties: false }
);

export type ArtifactReadParams = Static<typeof ArtifactReadParamsSchema>;

export interface ArtifactRuntimeConfig {
  artifactRoot: string;
  projectId: string;
  budget: ToolResultBudget;
}

export interface ArtifactTelemetry {
  info(event: string, context: Record<string, unknown>): void;
  warn(event: string, context: Record<string, unknown>): void;
}

export interface ArtifactRuntimeDependencies {
  telemetry?: ArtifactTelemetry;
}

export interface ArtifactExecution {
  result: TextToolResult;
  code: "OK" | ArtifactErrorCode;
}

export class ArtifactReadError extends Error {
  constructor(
    readonly code: ArtifactErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ArtifactReadError";
  }
}
