import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";

const MAX_PATH = 4_096;
const MAX_TEXT = 262_144;
const MAX_ITEMS = 10_000;

export const SCA_CONTEXT_ASSEMBLY_INPUT_SCHEMA = "penny.sca-context-assembly-input.v1";
export const SCA_IMMUTABLE_ANALYSIS_CONTEXT_SCHEMA = "penny.sca-immutable-analysis-context.v1";

const ScaModelProfileIdV1Schema = Type.Union([
  Type.Literal("primary_a"),
  Type.Literal("primary_b"),
  Type.Literal("critic"),
]);

const SourcePathSchema = Type.String({ minLength: 1, maxLength: MAX_PATH });
const NullablePathSchema = Type.Union([SourcePathSchema, Type.Null()]);
const NullableLineSchema = Type.Union([
  Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  Type.Null(),
]);

const ScaContextCandidateV1Schema = Type.Object(
  {
    candidate_id: OpaqueIdSchema,
    observation_sha256: Sha256Schema,
    observation_kind: Type.Union([
      Type.Literal("candidate"),
      Type.Literal("advisory"),
      Type.Literal("secret_candidate"),
      Type.Literal("parse_gap"),
      Type.Literal("unsupported"),
      Type.Literal("tool_failure"),
    ]),
    path: NullablePathSchema,
    start_line: NullableLineSchema,
    end_line: NullableLineSchema,
    summary: Type.String({ minLength: 1, maxLength: 8_192 }),
  },
  { additionalProperties: false }
);

const ScaSourceChunkV1Schema = Type.Object(
  {
    path: SourcePathSchema,
    source_sha256: Sha256Schema,
    chunk_sha256: Sha256Schema,
    start_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    end_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    content: Type.String({ maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

const ScaStructuredContextV1Schema = Type.Object(
  {
    context_kind: Type.Union([
      Type.Literal("ast_summary"),
      Type.Literal("call_graph"),
      Type.Literal("symbol_table"),
      Type.Literal("dependency_path"),
      Type.Literal("framework_summary"),
    ]),
    path: NullablePathSchema,
    content_sha256: Sha256Schema,
    content: Type.String({ maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

export const ScaContextAssemblyInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_CONTEXT_ASSEMBLY_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m1_manifest_sha256: Sha256Schema,
    plan_sha256: Sha256Schema,
    target_id: Type.String({ pattern: "^scatarget_[a-f0-9]{64}$" }),
    profile_id: ScaModelProfileIdV1Schema,
    target_candidate_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_ITEMS }),
    target_required_files: Type.Array(SourcePathSchema, { maxItems: MAX_ITEMS }),
    admitted_context_paths: Type.Array(SourcePathSchema, { maxItems: MAX_ITEMS }),
    candidates: Type.Array(ScaContextCandidateV1Schema, { maxItems: MAX_ITEMS }),
    source_chunks: Type.Array(ScaSourceChunkV1Schema, { maxItems: MAX_ITEMS }),
    structured_context: Type.Array(ScaStructuredContextV1Schema, { maxItems: MAX_ITEMS }),
    analysis_policy_sha256: Sha256Schema,
    limits: Type.Object(
      {
        max_context_bytes: Type.Integer({ minimum: 1, maximum: 134_217_728 }),
        max_source_chunks: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
        max_structured_items: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const ScaImmutableAnalysisContextV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_IMMUTABLE_ANALYSIS_CONTEXT_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m1_manifest_sha256: Sha256Schema,
    plan_sha256: Sha256Schema,
    target_id: Type.String({ pattern: "^scatarget_[a-f0-9]{64}$" }),
    profile_id: ScaModelProfileIdV1Schema,
    trust_label: Type.Literal("untrusted_source_data"),
    analysis_policy_sha256: Sha256Schema,
    candidates: Type.Array(ScaContextCandidateV1Schema, { maxItems: MAX_ITEMS }),
    source_chunks: Type.Array(ScaSourceChunkV1Schema, { maxItems: MAX_ITEMS }),
    structured_context: Type.Array(ScaStructuredContextV1Schema, { maxItems: MAX_ITEMS }),
    context_byte_length: Type.Integer({ minimum: 0, maximum: 134_217_728 }),
    context_id: Type.String({ pattern: "^scactx_[a-f0-9]{64}$" }),
    context_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaContextAssemblyInputV1 = Static<typeof ScaContextAssemblyInputV1Schema>;
export type ScaImmutableAnalysisContextV1 = Static<typeof ScaImmutableAnalysisContextV1Schema>;

type UnsignedContext = Omit<
  ScaImmutableAnalysisContextV1,
  "context_id" | "context_sha256" | "context_byte_length"
>;

export class ScaImmutableContextError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "path_collision"
      | "candidate_coverage_mismatch"
      | "file_coverage_mismatch"
      | "unadmitted_path"
      | "invalid_range"
      | "digest_mismatch"
      | "limit_exceeded",
    message: string
  ) {
    super(message);
    this.name = "ScaImmutableContextError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validatePath(candidate: string): void {
  const segments = candidate.split("/");
  if (
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/u.test(candidate) ||
    candidate !== candidate.normalize("NFC") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ScaImmutableContextError("unadmitted_path", "SCA context path is not canonical");
  }
}

function uniqueSorted(values: readonly string[], code: ScaImmutableContextError["code"]): string[] {
  if (new Set(values).size !== values.length) {
    throw new ScaImmutableContextError(code, "SCA context identifiers must be unique");
  }
  return [...values].sort(compareUtf8);
}

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...left].sort(compareUtf8)) === canonicalJson([...right].sort(compareUtf8));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function contextDigest(unsigned: UnsignedContext, byteLength: number, contextId: string): string {
  return sha256(
    canonicalJson({ ...unsigned, context_byte_length: byteLength, context_id: contextId })
  );
}

export function buildScaImmutableAnalysisContextV1(value: unknown): ScaImmutableAnalysisContextV1 {
  let input: ScaContextAssemblyInputV1;
  try {
    input = validateContract(ScaContextAssemblyInputV1Schema, value, "SCA context assembly input");
  } catch (error) {
    throw new ScaImmutableContextError(
      "invalid_input",
      error instanceof Error ? error.message : "SCA context assembly input is invalid"
    );
  }
  const targetCandidateIds = uniqueSorted(
    input.target_candidate_ids,
    "candidate_coverage_mismatch"
  );
  const observedCandidateIds = uniqueSorted(
    input.candidates.map((candidate) => candidate.candidate_id),
    "candidate_coverage_mismatch"
  );
  if (!exactSet(targetCandidateIds, observedCandidateIds)) {
    throw new ScaImmutableContextError(
      "candidate_coverage_mismatch",
      "SCA context candidate set differs from its target"
    );
  }
  const requiredFiles = uniqueSorted(input.target_required_files, "file_coverage_mismatch");
  const admittedPaths = new Set(uniqueSorted(input.admitted_context_paths, "path_collision"));
  for (const file of [...requiredFiles, ...admittedPaths]) validatePath(file);
  if (!requiredFiles.every((file) => admittedPaths.has(file))) {
    throw new ScaImmutableContextError(
      "file_coverage_mismatch",
      "SCA target file is not in the admitted context path set"
    );
  }
  for (const candidate of input.candidates) {
    if (candidate.path !== null && !admittedPaths.has(candidate.path)) {
      throw new ScaImmutableContextError(
        "unadmitted_path",
        "SCA candidate references an unadmitted source path"
      );
    }
    if (
      (candidate.start_line === null) !== (candidate.end_line === null) ||
      (candidate.start_line !== null &&
        candidate.end_line !== null &&
        candidate.end_line < candidate.start_line)
    ) {
      throw new ScaImmutableContextError("invalid_range", "SCA candidate line range is invalid");
    }
  }
  if (
    input.source_chunks.length > input.limits.max_source_chunks ||
    input.structured_context.length > input.limits.max_structured_items
  ) {
    throw new ScaImmutableContextError("limit_exceeded", "SCA context item limit exceeded");
  }
  for (const chunk of input.source_chunks) {
    validatePath(chunk.path);
    if (!admittedPaths.has(chunk.path)) {
      throw new ScaImmutableContextError(
        "unadmitted_path",
        "SCA source chunk path is not admitted for this target"
      );
    }
    if (chunk.end_line < chunk.start_line || sha256(chunk.content) !== chunk.chunk_sha256) {
      throw new ScaImmutableContextError(
        chunk.end_line < chunk.start_line ? "invalid_range" : "digest_mismatch",
        "SCA source chunk range or digest is invalid"
      );
    }
  }
  for (const context of input.structured_context) {
    if (context.path !== null) {
      validatePath(context.path);
      if (!admittedPaths.has(context.path)) {
        throw new ScaImmutableContextError(
          "unadmitted_path",
          "SCA structured context path is not admitted for this target"
        );
      }
    }
    if (sha256(context.content) !== context.content_sha256) {
      throw new ScaImmutableContextError(
        "digest_mismatch",
        "SCA structured context digest mismatch"
      );
    }
  }
  const chunkPaths = new Set(input.source_chunks.map((chunk) => chunk.path));
  if (!requiredFiles.every((file) => chunkPaths.has(file))) {
    throw new ScaImmutableContextError(
      "file_coverage_mismatch",
      "SCA context lacks source content for a required target file"
    );
  }

  const unsigned: UnsignedContext = {
    schema_id: SCA_IMMUTABLE_ANALYSIS_CONTEXT_SCHEMA,
    schema_version: 1,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    run_id: input.run_id,
    source_snapshot_sha256: input.source_snapshot_sha256,
    m1_manifest_sha256: input.m1_manifest_sha256,
    plan_sha256: input.plan_sha256,
    target_id: input.target_id,
    profile_id: input.profile_id,
    trust_label: "untrusted_source_data",
    analysis_policy_sha256: input.analysis_policy_sha256,
    candidates: input.candidates
      .map((candidate) => ({ ...candidate }))
      .sort((left, right) => compareUtf8(left.candidate_id, right.candidate_id)),
    source_chunks: input.source_chunks
      .map((chunk) => ({ ...chunk }))
      .sort((left, right) =>
        compareUtf8(
          `${left.path}\u0000${String(left.start_line).padStart(16, "0")}`,
          `${right.path}\u0000${String(right.start_line).padStart(16, "0")}`
        )
      ),
    structured_context: input.structured_context
      .map((context) => ({ ...context }))
      .sort((left, right) =>
        compareUtf8(
          `${left.context_kind}\u0000${left.path ?? ""}\u0000${left.content_sha256}`,
          `${right.context_kind}\u0000${right.path ?? ""}\u0000${right.content_sha256}`
        )
      ),
  };
  const contentBytes = Buffer.byteLength(canonicalJson(unsigned), "utf8");
  if (contentBytes > input.limits.max_context_bytes) {
    throw new ScaImmutableContextError("limit_exceeded", "SCA context byte limit exceeded");
  }
  const contextId = `scactx_${sha256(
    canonicalJson({
      run_id: input.run_id,
      target_id: input.target_id,
      profile_id: input.profile_id,
      source_snapshot_sha256: input.source_snapshot_sha256,
      plan_sha256: input.plan_sha256,
    })
  )}`;
  const context = validateContract(
    ScaImmutableAnalysisContextV1Schema,
    {
      ...unsigned,
      context_byte_length: contentBytes,
      context_id: contextId,
      context_sha256: contextDigest(unsigned, contentBytes, contextId),
    },
    "SCA immutable analysis context"
  );
  return deepFreeze(context);
}

export function validateScaImmutableAnalysisContextV1(
  value: unknown
): ScaImmutableAnalysisContextV1 {
  const context = validateContract(
    ScaImmutableAnalysisContextV1Schema,
    value,
    "SCA immutable analysis context"
  );
  const {
    context_id: observedId,
    context_sha256: observedDigest,
    context_byte_length: observedLength,
    ...unsigned
  } = context;
  const expectedId = `scactx_${sha256(
    canonicalJson({
      run_id: context.run_id,
      target_id: context.target_id,
      profile_id: context.profile_id,
      source_snapshot_sha256: context.source_snapshot_sha256,
      plan_sha256: context.plan_sha256,
    })
  )}`;
  if (
    expectedId !== observedId ||
    Buffer.byteLength(canonicalJson(unsigned), "utf8") !== observedLength ||
    contextDigest(unsigned, observedLength, observedId) !== observedDigest
  ) {
    throw new ScaImmutableContextError(
      "digest_mismatch",
      "SCA immutable analysis context identity or digest mismatch"
    );
  }
  return deepFreeze(context);
}
