import { Type, type Static } from "typebox";

import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";

const MAX_ANALYZERS = 64;
const MAX_OBSERVATIONS = 100_000;
const MAX_REFS = 64;
const MAX_TEXT = 8_192;
const MAX_PATH = 4_096;

export const SCA_STATIC_NORMALIZATION_INPUT_SCHEMA = "penny.sca-static-normalization-input.v1";
export const SCA_M1_MANIFEST_SCHEMA = "penny.sca-m1-manifest.v1";

export const SCA_R1_M1_REQUIRED_ANALYZERS = Object.freeze([
  { analyzer_id: "source_census", analyzer_kind: "source_census" },
  { analyzer_id: "syntax_php", analyzer_kind: "syntax_inventory" },
  { analyzer_id: "syntax_javascript_typescript", analyzer_kind: "syntax_inventory" },
  { analyzer_id: "semgrep_php", analyzer_kind: "semgrep" },
  { analyzer_id: "semgrep_javascript_typescript", analyzer_kind: "semgrep" },
  { analyzer_id: "dependency_composer", analyzer_kind: "dependency_inventory" },
  { analyzer_id: "dependency_npm", analyzer_kind: "dependency_inventory" },
  { analyzer_id: "osv_composer", analyzer_kind: "osv" },
  { analyzer_id: "osv_npm", analyzer_kind: "osv" },
  { analyzer_id: "gitleaks", analyzer_kind: "secret_scanner" },
] as const);

const ScaStaticAnalyzerKindV1Schema = Type.Union([
  Type.Literal("source_census"),
  Type.Literal("syntax_inventory"),
  Type.Literal("semgrep"),
  Type.Literal("codeql"),
  Type.Literal("dependency_inventory"),
  Type.Literal("osv"),
  Type.Literal("secret_scanner"),
]);

const ScaStaticAnalyzerStatusV1Schema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("partial"),
  Type.Literal("failed"),
  Type.Literal("unsupported"),
  Type.Literal("unavailable"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
]);

const ScaStaticObservationKindV1Schema = Type.Union([
  Type.Literal("coverage"),
  Type.Literal("candidate"),
  Type.Literal("dependency"),
  Type.Literal("advisory"),
  Type.Literal("secret_candidate"),
  Type.Literal("parse_gap"),
  Type.Literal("unsupported"),
  Type.Literal("tool_failure"),
]);

const NullableTextSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  Type.Null(),
]);
const NullablePathSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: MAX_PATH }),
  Type.Null(),
]);
const NullableLineSchema = Type.Union([
  Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  Type.Null(),
]);

export const ScaStaticObservationInputV1Schema = Type.Object(
  {
    observation_kind: ScaStaticObservationKindV1Schema,
    path: NullablePathSchema,
    start_line: NullableLineSchema,
    end_line: NullableLineSchema,
    rule_id: NullableTextSchema,
    weakness_id: NullableTextSchema,
    package_coordinate: NullableTextSchema,
    advisory_id: NullableTextSchema,
    message: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    evidence_sha256: Sha256Schema,
    raw_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: MAX_REFS }),
  },
  { additionalProperties: false }
);

export const ScaStaticAnalyzerRunInputV1Schema = Type.Object(
  {
    analyzer_id: OpaqueIdSchema,
    analyzer_kind: ScaStaticAnalyzerKindV1Schema,
    status: ScaStaticAnalyzerStatusV1Schema,
    tool_sha256: Type.Union([Sha256Schema, Type.Null()]),
    configuration_sha256: Type.Union([Sha256Schema, Type.Null()]),
    raw_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: MAX_REFS }),
    observations: Type.Array(ScaStaticObservationInputV1Schema, { maxItems: MAX_OBSERVATIONS }),
    failure_code: NullableTextSchema,
  },
  { additionalProperties: false }
);

export const ScaStaticNormalizationInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_STATIC_NORMALIZATION_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    source_snapshot_ref: ArtifactRefSchema,
    model_invocation_count: Type.Literal(0),
    analyzer_runs: Type.Array(ScaStaticAnalyzerRunInputV1Schema, {
      minItems: 1,
      maxItems: MAX_ANALYZERS,
    }),
  },
  { additionalProperties: false }
);

const ScaNormalizedStaticObservationV1Schema = Type.Object(
  {
    observation_id: Type.String({ pattern: "^scaobs_[a-f0-9]{64}$" }),
    correlation_id: Type.String({ pattern: "^scacor_[a-f0-9]{64}$" }),
    analyzer_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: MAX_ANALYZERS }),
    analyzer_kinds: Type.Array(ScaStaticAnalyzerKindV1Schema, {
      minItems: 1,
      maxItems: MAX_ANALYZERS,
    }),
    observation_kind: ScaStaticObservationKindV1Schema,
    path: NullablePathSchema,
    start_line: NullableLineSchema,
    end_line: NullableLineSchema,
    rule_id: NullableTextSchema,
    weakness_id: NullableTextSchema,
    package_coordinate: NullableTextSchema,
    advisory_id: NullableTextSchema,
    message: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    evidence_sha256: Sha256Schema,
    raw_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: MAX_REFS }),
  },
  { additionalProperties: false }
);

const ScaM1BlockerV1Schema = Type.Object(
  {
    analyzer_id: OpaqueIdSchema,
    analyzer_kind: ScaStaticAnalyzerKindV1Schema,
    reason: Type.Union([
      Type.Literal("missing"),
      Type.Literal("partial"),
      Type.Literal("failed"),
      Type.Literal("unsupported"),
      Type.Literal("unavailable"),
      Type.Literal("cancelled"),
      Type.Literal("timed_out"),
    ]),
    failure_code: NullableTextSchema,
  },
  { additionalProperties: false }
);

const ScaM1AnalyzerReceiptV1Schema = Type.Object(
  {
    analyzer_id: OpaqueIdSchema,
    analyzer_kind: ScaStaticAnalyzerKindV1Schema,
    status: ScaStaticAnalyzerStatusV1Schema,
    tool_sha256: Type.Union([Sha256Schema, Type.Null()]),
    configuration_sha256: Type.Union([Sha256Schema, Type.Null()]),
    raw_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: MAX_REFS }),
    observation_ids: Type.Array(Type.String({ pattern: "^scaobs_[a-f0-9]{64}$" }), {
      maxItems: MAX_OBSERVATIONS,
    }),
    failure_code: NullableTextSchema,
  },
  { additionalProperties: false }
);

export const ScaM1ManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_M1_MANIFEST_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    source_snapshot_ref: ArtifactRefSchema,
    milestone: Type.Literal("M1_STATIC_FOUNDATION"),
    release_eligible: Type.Literal(false),
    model_invocation_count: Type.Literal(0),
    status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    required_analyzers: Type.Array(
      Type.Object(
        {
          analyzer_id: OpaqueIdSchema,
          analyzer_kind: ScaStaticAnalyzerKindV1Schema,
        },
        { additionalProperties: false }
      ),
      {
        minItems: SCA_R1_M1_REQUIRED_ANALYZERS.length,
        maxItems: SCA_R1_M1_REQUIRED_ANALYZERS.length,
      }
    ),
    analyzers: Type.Array(ScaM1AnalyzerReceiptV1Schema, {
      minItems: 1,
      maxItems: MAX_ANALYZERS,
    }),
    observations: Type.Array(ScaNormalizedStaticObservationV1Schema, {
      maxItems: MAX_OBSERVATIONS,
    }),
    blockers: Type.Array(ScaM1BlockerV1Schema, { maxItems: SCA_R1_M1_REQUIRED_ANALYZERS.length }),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaStaticObservationInputV1 = Static<typeof ScaStaticObservationInputV1Schema>;
export type ScaStaticAnalyzerRunInputV1 = Static<typeof ScaStaticAnalyzerRunInputV1Schema>;
export type ScaStaticNormalizationInputV1 = Static<typeof ScaStaticNormalizationInputV1Schema>;
export type ScaM1ManifestV1 = Static<typeof ScaM1ManifestV1Schema>;

type NormalizedObservation = ScaM1ManifestV1["observations"][number];
type M1Blocker = ScaM1ManifestV1["blockers"][number];
type UnsignedManifest = Omit<ScaM1ManifestV1, "manifest_sha256">;

export class ScaStaticNormalizationError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "binding_mismatch"
      | "analyzer_collision"
      | "invalid_observation"
      | "artifact_ref_mismatch"
      | "digest_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaStaticNormalizationError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalArtifactRef(value: ArtifactRef, runId: string): ArtifactRef {
  const ref = validateContract(ArtifactRefSchema, value, "SCA static artifact ref");
  const identity = {
    branch_id: ref.branch_id,
    kind: ref.kind,
    operation_id: ref.operation_id,
    phase: ref.phase,
    run_id: ref.run_id,
    version: ref.version,
  };
  if (
    ref.run_id !== runId ||
    ref.artifact_id !== `art_${sha256(canonicalJson(identity))}` ||
    ref.store_ref !== `artifact://sha256/${ref.content_digest}`
  ) {
    throw new ScaStaticNormalizationError(
      "artifact_ref_mismatch",
      "SCA static artifact ref does not match its run or canonical identity"
    );
  }
  return ref;
}

function validateLocation(observation: ScaStaticObservationInputV1): void {
  const lines = [observation.start_line, observation.end_line];
  if (
    (observation.path === null && lines.some((line) => line !== null)) ||
    (observation.start_line === null) !== (observation.end_line === null) ||
    (observation.start_line !== null &&
      observation.end_line !== null &&
      observation.end_line < observation.start_line)
  ) {
    throw new ScaStaticNormalizationError(
      "invalid_observation",
      "SCA static observation location is inconsistent"
    );
  }
}

function exactObservationPreimage(
  analyzerKind: ScaStaticAnalyzerRunInputV1["analyzer_kind"],
  observation: ScaStaticObservationInputV1
) {
  return {
    analyzer_kind: analyzerKind,
    observation_kind: observation.observation_kind,
    path: observation.path,
    start_line: observation.start_line,
    end_line: observation.end_line,
    rule_id: observation.rule_id,
    weakness_id: observation.weakness_id,
    package_coordinate: observation.package_coordinate,
    advisory_id: observation.advisory_id,
    message: observation.message,
    evidence_sha256: observation.evidence_sha256,
  };
}

function correlationPreimage(observation: ScaStaticObservationInputV1) {
  return {
    observation_kind: observation.observation_kind,
    path: observation.path,
    start_line: observation.start_line,
    end_line: observation.end_line,
    weakness_id: observation.weakness_id,
    package_coordinate: observation.package_coordinate,
    advisory_id: observation.advisory_id,
  };
}

function uniqueSortedRefs(refs: readonly ArtifactRef[], runId: string): ArtifactRef[] {
  const byIdentity = new Map<string, ArtifactRef>();
  for (const value of refs) {
    const ref = canonicalArtifactRef(value, runId);
    byIdentity.set(canonicalJson(ref), ref);
  }
  return [...byIdentity.values()].sort((left, right) =>
    compareUtf8(left.artifact_id, right.artifact_id)
  );
}

function normalizeObservations(
  runs: readonly ScaStaticAnalyzerRunInputV1[],
  runId: string
): readonly NormalizedObservation[] {
  const normalized = new Map<string, NormalizedObservation>();
  for (const run of runs) {
    for (const observation of run.observations) {
      validateLocation(observation);
      const observationId = `scaobs_${sha256(canonicalJson(exactObservationPreimage(run.analyzer_kind, observation)))}`;
      const existing = normalized.get(observationId);
      if (existing === undefined) {
        normalized.set(observationId, {
          observation_id: observationId,
          correlation_id: `scacor_${sha256(canonicalJson(correlationPreimage(observation)))}`,
          analyzer_ids: [run.analyzer_id],
          analyzer_kinds: [run.analyzer_kind],
          ...observation,
          raw_refs: uniqueSortedRefs(observation.raw_refs, runId),
        });
        continue;
      }
      normalized.set(observationId, {
        ...existing,
        analyzer_ids: [...new Set([...existing.analyzer_ids, run.analyzer_id])].sort(compareUtf8),
        analyzer_kinds: [...new Set([...existing.analyzer_kinds, run.analyzer_kind])].sort(
          compareUtf8
        ),
        raw_refs: uniqueSortedRefs([...existing.raw_refs, ...observation.raw_refs], runId),
      });
    }
  }
  if (normalized.size > MAX_OBSERVATIONS) {
    throw new ScaStaticNormalizationError(
      "invalid_observation",
      "SCA normalized observation limit exceeded"
    );
  }
  return [...normalized.values()].sort((left, right) =>
    compareUtf8(left.observation_id, right.observation_id)
  );
}

function blockersFor(runs: readonly ScaStaticAnalyzerRunInputV1[]): readonly M1Blocker[] {
  const byId = new Map(runs.map((run) => [run.analyzer_id, run]));
  return SCA_R1_M1_REQUIRED_ANALYZERS.flatMap((required): readonly M1Blocker[] => {
    const run = byId.get(required.analyzer_id);
    if (run === undefined) return [{ ...required, reason: "missing", failure_code: null }];
    if (run.analyzer_kind !== required.analyzer_kind) {
      return [{ ...required, reason: "failed", failure_code: "analyzer_kind_mismatch" }];
    }
    if (run.status === "succeeded") return [];
    return [{ ...required, reason: run.status, failure_code: run.failure_code }];
  });
}

function manifestDigest(value: UnsignedManifest): string {
  return sha256(canonicalJson(value));
}

export function buildScaM1ManifestV1(value: unknown): ScaM1ManifestV1 {
  let input: ScaStaticNormalizationInputV1;
  try {
    input = validateContract(
      ScaStaticNormalizationInputV1Schema,
      value,
      "SCA static normalization input"
    );
  } catch (error) {
    throw new ScaStaticNormalizationError(
      "invalid_input",
      error instanceof Error ? error.message : "static normalization input is invalid"
    );
  }
  canonicalArtifactRef(input.source_snapshot_ref, input.run_id);
  if (
    input.source_snapshot_ref.kind !== "source-snapshot" ||
    input.source_snapshot_ref.content_digest !== input.source_snapshot_sha256
  ) {
    throw new ScaStaticNormalizationError(
      "binding_mismatch",
      "source snapshot ref does not match the static normalization input"
    );
  }
  const analyzerIds = input.analyzer_runs.map((run) => run.analyzer_id);
  if (new Set(analyzerIds).size !== analyzerIds.length) {
    throw new ScaStaticNormalizationError("analyzer_collision", "analyzer IDs must be unique");
  }
  for (const run of input.analyzer_runs) {
    uniqueSortedRefs(run.raw_refs, input.run_id);
    if (run.status === "succeeded" && run.failure_code !== null) {
      throw new ScaStaticNormalizationError(
        "invalid_input",
        "a successful analyzer cannot declare a failure code"
      );
    }
    if (run.status !== "succeeded" && run.failure_code === null) {
      throw new ScaStaticNormalizationError(
        "invalid_input",
        "a non-success analyzer must declare a failure code"
      );
    }
  }

  const observations = normalizeObservations(input.analyzer_runs, input.run_id);
  const blockers = blockersFor(input.analyzer_runs);
  const analyzers = input.analyzer_runs
    .map((run) => ({
      analyzer_id: run.analyzer_id,
      analyzer_kind: run.analyzer_kind,
      status: run.status,
      tool_sha256: run.tool_sha256,
      configuration_sha256: run.configuration_sha256,
      raw_refs: uniqueSortedRefs(run.raw_refs, input.run_id),
      observation_ids: observations
        .filter((observation) => observation.analyzer_ids.includes(run.analyzer_id))
        .map((observation) => observation.observation_id),
      failure_code: run.failure_code,
    }))
    .sort((left, right) => compareUtf8(left.analyzer_id, right.analyzer_id));

  const unsigned: UnsignedManifest = {
    schema_id: SCA_M1_MANIFEST_SCHEMA,
    schema_version: 1,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    run_id: input.run_id,
    source_snapshot_sha256: input.source_snapshot_sha256,
    source_snapshot_ref: input.source_snapshot_ref,
    milestone: "M1_STATIC_FOUNDATION",
    release_eligible: false,
    model_invocation_count: 0,
    status: blockers.length === 0 ? "passed" : "blocked",
    required_analyzers: [...SCA_R1_M1_REQUIRED_ANALYZERS],
    analyzers,
    observations: [...observations],
    blockers: [...blockers],
  };
  return validateContract(
    ScaM1ManifestV1Schema,
    { ...unsigned, manifest_sha256: manifestDigest(unsigned) },
    "SCA M1 manifest"
  );
}

export function validateScaM1ManifestV1(value: unknown): ScaM1ManifestV1 {
  const manifest = validateContract(ScaM1ManifestV1Schema, value, "SCA M1 manifest");
  const { manifest_sha256: observedDigest, ...unsigned } = manifest;
  if (manifestDigest(unsigned) !== observedDigest) {
    throw new ScaStaticNormalizationError("digest_mismatch", "SCA M1 manifest digest mismatch");
  }
  return manifest;
}
