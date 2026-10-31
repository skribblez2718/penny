import { canonicalJson, sha256 } from "../canonical-json.js";
import path from "node:path";
import { realpathSync } from "node:fs";

import { Type, type Static } from "typebox";

import { validateContract, type JsonValue } from "../contracts.js";
import { SCA_MODEL_ALIAS } from "../sca/model-identity.js";
import { ScaAnalysisToolsSchema } from "../sca/ordinary-contracts.js";
import { ScaAdvancedInputsSchema } from "../sca/ordinary-advanced-contracts.js";
import { Sha256Schema } from "./common.js";

const MAX_SCOPE_ITEMS = 256;
const MAX_TEXT = 32_768;

export const SCA_REQUEST_SCHEMA = "penny.sca-request.v1";

const ScopePathSchema = Type.String({ minLength: 1, maxLength: 4_096 });

export const ScaRequestV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    purpose: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    source_root: Type.String({ minLength: 1, maxLength: 4_096 }),
    source_snapshot_sha256: Type.Optional(Sha256Schema),
    analysis_tools: Type.Optional(ScaAnalysisToolsSchema),
    advanced: Type.Optional(ScaAdvancedInputsSchema),
    scope: Type.Object(
      {
        include: Type.Array(ScopePathSchema, { maxItems: MAX_SCOPE_ITEMS }),
        exclude: Type.Array(ScopePathSchema, { maxItems: MAX_SCOPE_ITEMS }),
      },
      { additionalProperties: false }
    ),
    execution_mode: Type.Union([
      Type.Literal("static_only"),
      Type.Literal("propose_stronger_evidence"),
    ]),
    model: Type.Literal(SCA_MODEL_ALIAS),
  },
  { additionalProperties: false }
);

export const ScaCallerConstraintsV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    source_root: ScaRequestV1Schema.properties.source_root,
    source_snapshot_sha256: ScaRequestV1Schema.properties.source_snapshot_sha256,
    analysis_tools: ScaRequestV1Schema.properties.analysis_tools,
    advanced: ScaRequestV1Schema.properties.advanced,
    scope: ScaRequestV1Schema.properties.scope,
    execution_mode: ScaRequestV1Schema.properties.execution_mode,
    model: ScaRequestV1Schema.properties.model,
  },
  { additionalProperties: false }
);

export type ScaRequestV1 = Readonly<Static<typeof ScaRequestV1Schema>>;
export type ScaCallerConstraintsV1 = Readonly<Static<typeof ScaCallerConstraintsV1Schema>>;

export class ScaRequestError extends Error {
  constructor(
    readonly code: "invalid_request" | "unsafe_source_root",
    message: string
  ) {
    super(message);
    this.name = "ScaRequestError";
  }
}

export function validateScaRequestV1(value: unknown): ScaRequestV1 {
  let request: ScaRequestV1;
  try {
    request = validateContract(ScaRequestV1Schema, value, "SCA request");
  } catch (error) {
    throw new ScaRequestError(
      "invalid_request",
      error instanceof Error ? error.message : "SCA request is invalid"
    );
  }
  if (!path.isAbsolute(request.source_root) || request.source_root.includes("\0")) {
    throw new ScaRequestError(
      "unsafe_source_root",
      "SCA source root must be an absolute NUL-free path"
    );
  }
  for (const entries of [request.scope.include, request.scope.exclude]) {
    if (
      new Set(entries).size !== entries.length ||
      entries.some(
        (entry) =>
          path.isAbsolute(entry) ||
          entry.includes("\0") ||
          path.posix.normalize(entry) !== entry ||
          entry === ".." ||
          entry.startsWith("../")
      )
    ) {
      throw new ScaRequestError(
        "invalid_request",
        "SCA scope paths must be unique normalized repository-relative paths"
      );
    }
  }
  const advanced = request.advanced;
  if (advanced !== undefined) {
    if (Buffer.byteLength(canonicalJson(advanced)) > 16 * 1024 * 1024)
      throw new ScaRequestError("invalid_request", "Advanced input byte limit exceeded");
    if (
      request.execution_mode === "static_only" &&
      (advanced.application_tests.length > 0 ||
        advanced.promotions.length > 0 ||
        advanced.rescans.length > 0)
    )
      throw new ScaRequestError(
        "invalid_request",
        "Static-only requests cannot authorize application execution, promotion or rescan"
      );
    for (const entries of [
      advanced.application_tests.map((x) => x.id),
      advanced.learning.map((x) => x.id),
      advanced.promotions.map((x) => x.validation_id),
      advanced.rescans.map((x) => x.validation_id),
    ])
      if (new Set(entries).size !== entries.length)
        throw new ScaRequestError("invalid_request", "Duplicate advanced selection");
    for (const grant of advanced.promotions)
      if (!advanced.learning.some((x) => x.id === grant.validation_id))
        throw new ScaRequestError(
          "invalid_request",
          "Promotion requires an admitted validation selector"
        );
    for (const grant of advanced.rescans)
      if (!advanced.promotions.some((x) => x.validation_id === grant.validation_id))
        throw new ScaRequestError(
          "invalid_request",
          "Rescan requires separate promotion and rescan operands"
        );
    for (const learning of advanced.learning) {
      if (learning.fixture_truth_sha256 !== sha256(canonicalJson(learning.fixtures)))
        throw new ScaRequestError("invalid_request", "Independent fixture truth digest mismatch");
      if (
        learning.fixtures.length > 0 &&
        learning.limits.max_processes <
          (learning.offline_validation === undefined ? 1 : 2) + 2 * learning.fixtures.length
      )
        throw new ScaRequestError("invalid_request", "Insufficient empirical process allowance");
    }
  }
  const tools = request.analysis_tools;
  const paths = [
    ...(advanced?.application_tests.flatMap((x) => [
      x.harness.path,
      ...x.test_inputs.map((i) => i.file.path),
      ...(x.stdin === null ? [] : [x.stdin.path]),
    ]) ?? []),
    ...(advanced?.learning.flatMap((x) => [
      x.baseline.rules_path,
      x.tool.executable,
      ...(x.offline_validation === undefined
        ? []
        : [
            x.offline_validation.python.executable,
            x.offline_validation.core.executable,
            x.offline_validation.metachecks.rules_path,
            ...(x.offline_validation.core_library_directory === undefined
              ? []
              : [x.offline_validation.core_library_directory]),
          ]),
    ]) ?? []),
    ...(advanced?.promotions.map((x) => x.namespace) ?? []),
    tools?.advisory_results?.path,
    tools?.semgrep?.tool.executable,
    tools?.semgrep?.rules_path,
    tools?.gitleaks?.tool.executable,
    tools?.gitleaks?.rules_path,
    tools?.graph?.php_frontend?.executable,
    tools?.graph?.js_frontend?.executable,
    tools?.graph?.joern.executable,
    ...(tools?.graph?.queries.map((query) => query.script_path) ?? []),
  ];
  for (const selected of paths) {
    if (
      selected !== undefined &&
      (!path.isAbsolute(selected) ||
        selected.includes("\0") ||
        withinTarget(selected, request.source_root))
    ) {
      throw new ScaRequestError(
        "invalid_request",
        "Analysis tools/rules must be explicit absolute paths outside the target tree"
      );
    }
  }
  if (
    new Set(tools?.graph?.queries.map((query) => query.id)).size !==
    (tools?.graph?.queries.length ?? 0)
  )
    throw new ScaRequestError("invalid_request", "Graph query IDs must be unique");
  return request;
}

export function canonicalizeScaRequestV1(value: {
  readonly goal: string;
  readonly constraints: Readonly<Record<string, JsonValue>>;
}): ScaRequestV1 {
  return validateScaRequestV1({ purpose: value.goal, ...value.constraints });
}

export function scaRequestConstraints(request: ScaRequestV1): Record<string, JsonValue> {
  return validateContract(
    ScaCallerConstraintsV1Schema,
    {
      schema_version: request.schema_version,
      source_root: request.source_root,
      ...(request.source_snapshot_sha256 === undefined
        ? {}
        : { source_snapshot_sha256: request.source_snapshot_sha256 }),
      ...(request.analysis_tools === undefined ? {} : { analysis_tools: request.analysis_tools }),
      ...(request.advanced === undefined ? {} : { advanced: request.advanced }),
      scope: request.scope,
      execution_mode: request.execution_mode,
      model: request.model,
    },
    "SCA runtime constraints"
  );
}

function withinTarget(candidate: string, root: string): boolean {
  const canonical = (entry: string) => {
    try {
      return realpathSync(entry);
    } catch {
      return path.resolve(entry);
    }
  };
  const relative = path.relative(canonical(root), canonical(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
