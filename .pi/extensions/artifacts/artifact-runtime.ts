import {
  ArtifactStore,
  PngMediaError,
  canonicalPngImageContent,
  isSqliteCorruption,
  resolvePngMediaLimits,
} from "@penny/orchestration";

import {
  DEFAULT_TOOL_RESULT_BUDGET,
  ToolResultBudgetConfigError,
  ToolResultBudgetError,
  assessReleaseHeadroom,
  createTextToolResult,
  enforceToolResultBudget,
  fitUtf8ToolResult,
  isUtf8Boundary,
  measureToolResult,
  resolveToolResultBudget,
  type TextToolResult,
} from "../lib/tool-result-budget.js";
import { ArtifactClientError, resolveArtifactState } from "./owner-client.js";
import {
  ARTIFACT_SCHEMA_VERSION,
  ArtifactReadError,
  type ArtifactErrorCode,
  type ArtifactExecution,
  type ArtifactReadParams,
  type ArtifactRuntimeConfig,
  type ArtifactRuntimeDependencies,
} from "./types.js";

const ARTIFACT_ID_PATTERN = /^art_[a-f0-9]{64}$/;

export function loadArtifactRuntimeConfig(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>>
): ArtifactRuntimeConfig {
  let budget;
  let pngLimits;
  try {
    budget = resolveToolResultBudget(env);
    pngLimits = resolvePngMediaLimits(env);
  } catch (error) {
    if (
      error instanceof ToolResultBudgetConfigError ||
      (error instanceof PngMediaError && error.code === "PNG_CONFIG_INVALID")
    ) {
      throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", error.message);
    }
    throw error;
  }
  const state = resolveArtifactState(projectRoot, env);
  return {
    artifactRoot: state.paths.artifacts.root,
    projectId: state.projectId,
    budget,
    pngLimits,
  };
}

function validateRange(
  source: Buffer,
  range: ArtifactReadParams["range"]
): { start: number; end: number } {
  const start = range?.start ?? 0;
  const end = range?.end ?? source.length;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.length ||
    !isUtf8Boundary(source, start) ||
    !isUtf8Boundary(source, end)
  ) {
    throw new ArtifactReadError(
      "ARTIFACT_RANGE_INVALID",
      "Artifact byte range must use valid UTF-8 boundaries"
    );
  }
  return { start, end };
}

function errorExecution(
  code: ArtifactErrorCode,
  message: string,
  budget = DEFAULT_TOOL_RESULT_BUDGET
): ArtifactExecution & { result: TextToolResult } {
  const result = createTextToolResult(
    {
      schema_version: ARTIFACT_SCHEMA_VERSION,
      ok: false,
      type: "artifact_error",
      error: { code, message, retryable: false },
    },
    { isError: true }
  );
  try {
    enforceToolResultBudget(result, budget);
  } catch {
    const fallback = createTextToolResult(
      { ok: false, error: { code: "ARTIFACT_RESULT_BUDGET_EXCEEDED" } },
      { isError: true }
    );
    enforceToolResultBudget(fallback, budget);
    return { result: fallback, code: "ARTIFACT_RESULT_BUDGET_EXCEEDED" };
  }
  return { result, code };
}

function mapStoreError(error: unknown): ArtifactReadError {
  if (error instanceof ArtifactReadError) return error;
  if (error instanceof PngMediaError) {
    if (error.code === "PNG_NOT_CANONICAL") {
      return new ArtifactReadError("ARTIFACT_IMAGE_NOT_CANONICAL", error.message);
    }
    if (
      error.code === "PNG_SOURCE_TOO_LARGE" ||
      error.code === "PNG_ANCILLARY_TOO_LARGE" ||
      error.code === "PNG_DIMENSIONS_EXCEEDED" ||
      error.code === "PNG_PIXELS_EXCEEDED" ||
      error.code === "PNG_COMPRESSED_TOO_LARGE" ||
      error.code === "PNG_DECOMPRESSED_TOO_LARGE"
    ) {
      return new ArtifactReadError("ARTIFACT_IMAGE_LIMIT_EXCEEDED", error.message);
    }
    return new ArtifactReadError("ARTIFACT_IMAGE_INVALID", error.message);
  }
  if (isSqliteCorruption(error)) {
    return new ArtifactReadError(
      "ARTIFACT_STORE_CORRUPT",
      error instanceof Error ? error.message : "Artifact database is damaged"
    );
  }
  if (error instanceof ToolResultBudgetError) {
    return new ArtifactReadError(
      "ARTIFACT_RESULT_BUDGET_EXCEEDED",
      "Artifact result cannot fit the configured budget"
    );
  }
  const message = error instanceof Error ? error.message : "Artifact could not be read";
  if (
    /invalid manifest|manifest .*mismatch|schema validation|canonical identity|store_ref|configuration|owner|symbolic|wrong type|must be absolute/i.test(
      message
    )
  ) {
    return new ArtifactReadError("ARTIFACT_CONFIG_INVALID", message);
  }
  if (/verification|digest|byte.length/i.test(message)) {
    return new ArtifactReadError("ARTIFACT_DIGEST_MISMATCH", message);
  }
  if (/absent|missing/i.test(message)) {
    return new ArtifactReadError("ARTIFACT_MISSING", message);
  }
  return new ArtifactReadError("ARTIFACT_MISSING", "Artifact could not be read");
}

function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isTextualMediaType(mediaType: string): boolean {
  const essence = mediaTypeEssence(mediaType);
  return (
    essence.startsWith("text/") ||
    essence === "application/json" ||
    essence.endsWith("+json") ||
    essence === "application/xml" ||
    essence.endsWith("+xml") ||
    essence === "application/javascript" ||
    essence === "application/yaml" ||
    essence === "application/x-yaml" ||
    essence === "application/toml"
  );
}

export async function executeArtifactRead(
  config: ArtifactRuntimeConfig,
  params: ArtifactReadParams,
  dependencies: ArtifactRuntimeDependencies = {}
): Promise<ArtifactExecution> {
  const startedAt = Date.now();
  const telemetry = dependencies.telemetry;
  let artifactId: string | undefined;
  try {
    artifactId = params.artifact;
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      throw new ArtifactReadError("ARTIFACT_INVALID_ID", "Artifact ID is invalid");
    }
    using store = ArtifactStore.openExisting(config.artifactRoot, {
      projectId: config.projectId,
    });
    const ref = store.refById(artifactId);
    if (ref === undefined) {
      throw new ArtifactReadError("ARTIFACT_MISSING", "Artifact is absent from the manifest");
    }
    const content = store.readById(artifactId);
    if (ref.media_type === "image/png") {
      if (params.range !== undefined) {
        throw new ArtifactReadError(
          "ARTIFACT_RANGE_UNSUPPORTED",
          "Byte ranges are unsupported for PNG image artifacts"
        );
      }
      const image = canonicalPngImageContent(content, config.pngLimits);
      const metadataResult = createTextToolResult({
        schema_version: ARTIFACT_SCHEMA_VERSION,
        ok: true,
        type: "artifact_image",
        artifact_ref: ref,
        phase: ref.phase,
        kind: ref.kind,
        producer: ref.producer,
        media_type: ref.media_type,
        total_bytes: ref.byte_length,
        content_digest: ref.content_digest,
        image: {
          width: image.info.width,
          height: image.info.height,
          channels: image.info.channels,
          pixel_count: image.info.pixelCount,
          decoded_bytes: image.info.decodedBytes,
        },
      });
      const measurement = enforceToolResultBudget(metadataResult, config.budget);
      const result = {
        content: [...metadataResult.content, image.content],
      };
      telemetry?.info("artifact_read_succeeded", {
        artifactId,
        runId: ref.run_id,
        phase: ref.phase,
        version: ref.version,
        mediaType: ref.media_type,
        contentDigest: ref.content_digest,
        totalBytes: ref.byte_length,
        width: image.info.width,
        height: image.info.height,
        pixelCount: image.info.pixelCount,
        serializedMetadataBytes: measurement.bytes,
        estimatedMetadataTokens: measurement.estimatedTokens,
        releaseHeadroom: assessReleaseHeadroom(measurement.estimatedTokens),
        durationMs: Date.now() - startedAt,
      });
      return { result, code: "OK" };
    }
    if (!isTextualMediaType(ref.media_type)) {
      throw new ArtifactReadError(
        "ARTIFACT_MEDIA_UNSUPPORTED",
        `Artifact media type '${ref.media_type}' is unsupported`
      );
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new ArtifactReadError("ARTIFACT_ENCODING_INVALID", "Artifact is not valid UTF-8");
    }
    const range = validateRange(content, params.range);
    const fitted = fitUtf8ToolResult({
      source: content,
      start: range.start,
      end: range.end,
      budget: config.budget,
      build: (returnedEnd, text, truncated) =>
        createTextToolResult({
          schema_version: ARTIFACT_SCHEMA_VERSION,
          ok: true,
          type: "artifact_read",
          artifact_ref: ref,
          phase: ref.phase,
          kind: ref.kind,
          producer: ref.producer,
          media_type: ref.media_type,
          total_bytes: ref.byte_length,
          requested_range: range,
          returned_range: { start: range.start, end: returnedEnd },
          returned_bytes: returnedEnd - range.start,
          content_digest: ref.content_digest,
          content: text,
          truncated,
          next_range: truncated ? { start: returnedEnd, end: range.end } : null,
        }),
    });
    telemetry?.info("artifact_read_succeeded", {
      artifactId,
      runId: ref.run_id,
      phase: ref.phase,
      version: ref.version,
      contentDigest: ref.content_digest,
      totalBytes: ref.byte_length,
      returnedStart: range.start,
      returnedEnd: fitted.end,
      serializedBytes: fitted.measurement.bytes,
      estimatedTokens: fitted.measurement.estimatedTokens,
      releaseHeadroom: assessReleaseHeadroom(fitted.measurement.estimatedTokens),
      truncated: fitted.truncated,
      durationMs: Date.now() - startedAt,
    });
    return { result: fitted.result, code: "OK" };
  } catch (error) {
    const mapped = mapStoreError(error);
    const execution = errorExecution(mapped.code, mapped.message, config.budget);
    const measurement = measureToolResult(execution.result);
    telemetry?.warn("artifact_read_failed", {
      artifactId,
      errorCode: execution.code,
      serializedBytes: measurement.bytes,
      estimatedTokens: measurement.estimatedTokens,
      releaseHeadroom: assessReleaseHeadroom(measurement.estimatedTokens),
      durationMs: Date.now() - startedAt,
    });
    return execution;
  }
}

export function configurationErrorResult(error: unknown): ArtifactExecution {
  if (error instanceof ArtifactClientError && error.code === "ARTIFACT_STORE_CORRUPT") {
    return errorExecution("ARTIFACT_STORE_CORRUPT", error.message);
  }
  const message =
    error instanceof ArtifactReadError ? error.message : "Artifact configuration is invalid";
  return errorExecution("ARTIFACT_CONFIG_INVALID", message);
}

export { currentArtifactRef as parseArtifactRef } from "@penny/orchestration";
