import { isUtf8 } from "node:buffer";
import { basename, dirname, extname, join } from "node:path";

import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract, type ArtifactRef } from "../../orchestration/dist/contracts.js";
import type { ScaP01SourceCustodyCorpusV1 } from "../../orchestration/dist/sca/p01-contracts.js";
import type { ScaP01RuleBundleV1 } from "../../orchestration/dist/sca/p01-policy-contracts.js";
import {
  SCA_P02_SOURCE_CENSUS_IDENTITY,
  type ScaP02GitleaksRequestV1,
  type ScaP02InventoryRequestV1,
  type ScaP02OsvComposerRequestV1,
  type ScaP02OsvNpmRequestV1,
  type ScaP02SemgrepJsTsRequestV1,
  type ScaP02SemgrepPhpRequestV1,
} from "../../orchestration/dist/sca/p02-contracts.js";
import { Sha256Schema } from "../../orchestration/dist/skill-contracts/common.js";
import type { ScaDependencyInventoryResultV2 } from "./adapters/dependency-inventory-v2.js";
import { inspectInstalledTreeSitterIdentitiesV2 } from "./adapters/tree-sitter-index.js";

export const SCA_P02_GITLEAKS_MINIMIZED_RESULT_V1_SCHEMA =
  "penny.sca-p02-gitleaks-minimized-result.v1";
export const SCA_P02_CUSTODY_SUMMARY_V1_SCHEMA = "penny.sca-p02-custody-summary.v1";

export const ScaP02CustodySummaryV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_CUSTODY_SUMMARY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    file_manifest_sha256: Sha256Schema,
    custody_sha256: Sha256Schema,
    tree_sha256: Sha256Schema,
    file_count: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    byte_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    filesystem_modes_prepared_read_only: Type.Literal(true),
  },
  { additionalProperties: false }
);
export type ScaP02CustodySummaryV1 = Static<typeof ScaP02CustodySummaryV1Schema>;

export function validateScaP02CustodySummaryV1(value: unknown): ScaP02CustodySummaryV1 {
  return validateContract(ScaP02CustodySummaryV1Schema, value, "SCA P02 custody summary");
}

export function buildScaP02CustodySummaryV1(input: {
  readonly file_manifest_ref: ArtifactRef;
  readonly custody_ref: ArtifactRef;
  readonly custody: ScaP01SourceCustodyCorpusV1;
}): ScaP02CustodySummaryV1 {
  return validateScaP02CustodySummaryV1({
    schema_id: SCA_P02_CUSTODY_SUMMARY_V1_SCHEMA,
    schema_version: 1,
    file_manifest_sha256: input.file_manifest_ref.content_digest,
    custody_sha256: input.custody_ref.content_digest,
    tree_sha256: input.custody.tree_sha256,
    file_count: input.custody.file_count,
    byte_count: input.custody.byte_count,
    filesystem_modes_prepared_read_only: true,
  });
}

const NullableTextSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 4_096 }),
  Type.Null(),
]);
const NullableShaSchema = Type.Union([Sha256Schema, Type.Null()]);
export const ScaP02GitleaksMinimizedResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_GITLEAKS_MINIMIZED_RESULT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    configuration_sha256: Sha256Schema,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("findings"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("cancelled"),
      Type.Literal("output_limit"),
      Type.Literal("unavailable"),
    ]),
    tool_version: NullableTextSchema,
    runtime_identity: NullableTextSchema,
    runtime_sha256: NullableShaSchema,
    invocation_sha256: NullableShaSchema,
    exit_code: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
    error_code: Type.Union([
      Type.Literal("none"),
      Type.Literal("service_unavailable"),
      Type.Literal("scanner_failed"),
      Type.Literal("invalid_output"),
      Type.Literal("timeout"),
      Type.Literal("cancelled"),
      Type.Literal("output_limit"),
      Type.Literal("configuration_drift"),
    ]),
    finding_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    raw_stdout_sha256: Sha256Schema,
    raw_stderr_sha256: Sha256Schema,
    truncated: Type.Boolean(),
    findings: Type.Array(
      Type.Object(
        {
          rule_id: Type.String({ minLength: 1, maxLength: 256 }),
          file: Type.Union([Type.String({ minLength: 1, maxLength: 4_096 }), Type.Null()]),
          start_line: Type.Union([
            Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
            Type.Null(),
          ]),
          end_line: Type.Union([Type.Integer({ minimum: 1, maximum: 1_000_000_000 }), Type.Null()]),
          original_fingerprint_sha256: Sha256Schema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_000_000 }
    ),
  },
  { additionalProperties: false }
);
export type ScaP02GitleaksMinimizedResultV1 = Static<typeof ScaP02GitleaksMinimizedResultV1Schema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function scaP02AdmittedLanguageV1(candidatePath: string): string | null {
  const extension = extname(candidatePath).toLowerCase();
  if (extension === ".php") return "php";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "javascript";
  if (extension === ".jsx") return "jsx";
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "typescript";
  if (extension === ".tsx") return "tsx";
  return null;
}

export function buildScaP02SourceCensusInputV1(
  request: ScaP02InventoryRequestV1,
  custody: ScaP01SourceCustodyCorpusV1
) {
  return {
    schema_id: "penny.sca-source-census-input.v1",
    schema_version: 1 as const,
    source_snapshot_sha256: request.source_snapshot_sha256,
    tool: SCA_P02_SOURCE_CENSUS_IDENTITY,
    files: custody.files.map((file) => {
      const bytes = Buffer.from(file.content_base64, "base64");
      return {
        path: file.path,
        byte_length: file.byte_count,
        sha256: file.content_sha256,
        content_kind: isUtf8(bytes) ? ("text" as const) : ("binary" as const),
        generated: false,
      };
    }),
    limits: {
      max_files: request.tree_sitter.max_files,
      max_total_bytes: request.tree_sitter.max_total_bytes,
    },
  } as const;
}

export function buildScaP02TreeSitterInputV2(
  request: ScaP02InventoryRequestV1,
  custody: ScaP01SourceCustodyCorpusV1
) {
  return {
    schema_id: "penny.sca-tree-sitter-index-input.v2",
    schema_version: 2 as const,
    source_snapshot_sha256: request.source_snapshot_sha256,
    tool: inspectInstalledTreeSitterIdentitiesV2(),
    limits: {
      max_files: request.tree_sitter.max_files,
      max_source_bytes_per_file: request.tree_sitter.max_file_bytes,
      max_total_source_bytes: request.tree_sitter.max_total_bytes,
      max_nodes_per_file: request.tree_sitter.max_nodes_per_file,
      max_depth: request.tree_sitter.max_depth,
      max_diagnostics_per_file: request.tree_sitter.max_diagnostics_per_file,
      max_symbols_per_file: request.tree_sitter.max_symbols_per_file,
      parse_timeout_micros: request.tree_sitter.parse_timeout_micros,
      query_match_limit: request.tree_sitter.query_match_limit,
    },
    files: custody.files.flatMap((file) => {
      const language = scaP02AdmittedLanguageV1(file.path);
      return language === null
        ? []
        : [
            {
              path: file.path,
              encoding: "base64" as const,
              content_base64: file.content_base64,
              byte_count: file.byte_count,
              source_sha256: file.content_sha256,
              admitted_language: language,
            },
          ];
    }),
  } as const;
}

export function buildScaP02DependencyInventoryInputV2(
  request: ScaP02InventoryRequestV1,
  custody: ScaP01SourceCustodyCorpusV1
) {
  return {
    schema_id: "penny.sca-dependency-inventory-input.v2",
    schema_version: 2 as const,
    source_snapshot_sha256: request.source_snapshot_sha256,
    ecosystems: ["Packagist", "npm"] as const,
    documents: custody.files.flatMap((file) => {
      const base = basename(file.path);
      if (!["composer.json", "composer.lock", "package.json", "package-lock.json"].includes(base)) {
        return [];
      }
      const project = dirname(file.path).replaceAll("\\", "/");
      return [
        {
          ecosystem: base.startsWith("composer") ? ("Packagist" as const) : ("npm" as const),
          project_path: project === "." ? "." : project,
          role:
            base === "composer.lock" || base === "package-lock.json"
              ? ("lockfile" as const)
              : ("manifest" as const),
          path: file.path,
          sha256: file.content_sha256,
          content: Buffer.from(file.content_base64, "base64").toString("utf8"),
        },
      ];
    }),
  } as const;
}

export function selectScaP02ScannerRulesV1<
  Rule extends Readonly<{ rule_id: string; language: string }>,
>(input: {
  readonly rules: readonly Rule[];
  readonly selected_rule_ids: readonly string[];
  readonly languages: readonly string[];
  readonly one_rule_id?: string;
  readonly excluded_rule_ids?: readonly string[];
}): Rule[] {
  const selectedIds = new Set(input.selected_rule_ids);
  const excludedIds = new Set(input.excluded_rule_ids ?? []);
  return input.rules.filter(
    (rule) =>
      selectedIds.has(rule.rule_id) &&
      !excludedIds.has(rule.rule_id) &&
      (input.one_rule_id === undefined
        ? input.languages.includes(rule.language)
        : rule.rule_id === input.one_rule_id)
  );
}

type ScaP02ScannerRequestV1 = ScaP02SemgrepPhpRequestV1 | ScaP02SemgrepJsTsRequestV1;
type ScaP02RuleV1 = ScaP01RuleBundleV1["rules"][number];

function scannerRuntime(request: ScaP02ScannerRequestV1 | ScaP02GitleaksRequestV1) {
  return {
    state: "available" as const,
    executable: request.executable.executable_path,
    executable_sha256: request.executable.executable_sha256,
    fixed_arguments: [] as const,
    tool_version: request.executable.version,
    runtime_identity: request.executable.tool_id,
    runtime_sha256: sha256(canonicalJson(request.executable)),
  };
}

export function buildScaP02SemgrepComponentRequestV1(input: {
  readonly request: ScaP02ScannerRequestV1;
  readonly rule: ScaP02RuleV1;
  readonly rule_index: number;
}) {
  const sourceRoot = join(
    input.request.staging_parent,
    `${input.request.operation_id}-source-${input.request.request_sha256.slice(0, 16)}`
  );
  const auxRoot = join(
    input.request.staging_parent,
    `${input.request.operation_id}-aux-${input.request.request_sha256.slice(0, 16)}`
  );
  return {
    schema_id: "penny.sca-semgrep-request.v1",
    schema_version: 1 as const,
    source_snapshot_sha256: input.request.source_snapshot_sha256,
    source_root: sourceRoot,
    scratch_root: join(auxRoot, "scratch"),
    rule_config: join(auxRoot, "config", `rule-${String(input.rule_index).padStart(6, "0")}.yaml`),
    rule_config_sha256: input.rule.content_sha256,
    runtime: scannerRuntime(input.request),
    timeout_ms: input.request.timeout_ms,
    max_output_bytes: input.request.max_output_bytes,
  } as const;
}

export function buildScaP02GitleaksComponentRequestV1(input: {
  readonly request: ScaP02GitleaksRequestV1;
  readonly rule: ScaP02RuleV1;
}) {
  const sourceRoot = join(
    input.request.staging_parent,
    `${input.request.operation_id}-source-${input.request.request_sha256.slice(0, 16)}`
  );
  const auxRoot = join(
    input.request.staging_parent,
    `${input.request.operation_id}-aux-${input.request.request_sha256.slice(0, 16)}`
  );
  return {
    schema_id: "penny.sca-gitleaks-request.v1",
    schema_version: 1 as const,
    source_snapshot_sha256: input.request.source_snapshot_sha256,
    source_root: sourceRoot,
    configuration_path: join(auxRoot, "gitleaks.toml"),
    configuration_sha256: input.rule.content_sha256,
    runtime: scannerRuntime(input.request),
    timeout_ms: input.request.timeout_ms,
    max_output_bytes: input.request.max_output_bytes,
  } as const;
}

export function minimizeScaP02GitleaksEvidenceV1(
  stdout: string,
  result: Readonly<{
    source_snapshot_sha256: unknown;
    configuration_sha256: unknown;
    status: unknown;
    tool_version: unknown;
    runtime_identity: unknown;
    runtime_sha256: unknown;
    invocation_sha256: unknown;
    exit_code: unknown;
    error_code: unknown;
    finding_count: unknown;
    raw_stdout_sha256: unknown;
    raw_stderr_sha256: unknown;
    truncated: unknown;
  }>
) {
  let findings: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (Array.isArray(parsed)) findings = parsed;
  } catch {
    findings = [];
  }
  return {
    schema_id: SCA_P02_GITLEAKS_MINIMIZED_RESULT_V1_SCHEMA,
    schema_version: 1 as const,
    source_snapshot_sha256: result.source_snapshot_sha256,
    configuration_sha256: result.configuration_sha256,
    status: result.status,
    tool_version: result.tool_version,
    runtime_identity: result.runtime_identity,
    runtime_sha256: result.runtime_sha256,
    invocation_sha256: result.invocation_sha256,
    exit_code: result.exit_code,
    error_code: result.error_code,
    finding_count: result.finding_count,
    raw_stdout_sha256: result.raw_stdout_sha256,
    raw_stderr_sha256: result.raw_stderr_sha256,
    truncated: result.truncated,
    findings: findings.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      return [
        {
          rule_id: String(entry.RuleID ?? entry.rule_id ?? "unknown").slice(0, 256),
          file: typeof entry.File === "string" ? entry.File : null,
          start_line: typeof entry.StartLine === "number" ? entry.StartLine : null,
          end_line: typeof entry.EndLine === "number" ? entry.EndLine : null,
          original_fingerprint_sha256: sha256(canonicalJson(entry)),
        },
      ];
    }),
  };
}

export function validateScaP02GitleaksMinimizedResultV1(
  value: unknown,
  componentRequest: ReturnType<typeof buildScaP02GitleaksComponentRequestV1>
): ScaP02GitleaksMinimizedResultV1 {
  const result = validateContract(
    ScaP02GitleaksMinimizedResultV1Schema,
    value,
    "SCA P02 minimized Gitleaks evidence"
  );
  if (
    result.source_snapshot_sha256 !== componentRequest.source_snapshot_sha256 ||
    result.configuration_sha256 !== componentRequest.configuration_sha256 ||
    (componentRequest.runtime.state === "available" &&
      (result.tool_version !== componentRequest.runtime.tool_version ||
        result.runtime_identity !== componentRequest.runtime.runtime_identity ||
        result.runtime_sha256 !== componentRequest.runtime.runtime_sha256)) ||
    (result.error_code === "none") !==
      (["succeeded", "findings"].includes(result.status) && !result.truncated) ||
    (result.status === "findings") !== (result.finding_count > 0 && result.error_code === "none") ||
    result.finding_count !== result.findings.length
  ) {
    throw new Error("sca_p02_component_admission_failed:gitleaks_minimized_semantic_mismatch");
  }
  return result;
}

export function scaP02DependencyHandoffV1(dependency: ScaDependencyInventoryResultV2) {
  const coordinates = dependency.coordinates.map((coordinate) => ({
    query_id: coordinate.coordinate_id,
    package: {
      ecosystem: coordinate.ecosystem,
      name: coordinate.name,
      version: coordinate.version,
    },
  }));
  const coordinateById = new Map(
    dependency.coordinates.map((coordinate) => [coordinate.coordinate_id, coordinate])
  );
  const mappings = dependency.occurrences.flatMap((entry) => {
    if (entry.coordinate_id === null || entry.name === null || entry.version === null) return [];
    const coordinate = coordinateById.get(entry.coordinate_id);
    return coordinate === undefined
      ? []
      : [
          {
            query_id: coordinate.coordinate_id,
            occurrence_id: entry.occurrence_id,
            package: {
              ecosystem: coordinate.ecosystem,
              name: coordinate.name,
              version: coordinate.version,
            },
          },
        ];
  });
  return { coordinates, mappings } as const;
}

export function buildScaP02OsvComponentRequestV2(
  request: ScaP02OsvComposerRequestV1 | ScaP02OsvNpmRequestV1
) {
  const coordinateOccurrences = new Map<string, string[]>();
  for (const mapping of request.mappings) {
    const existing = coordinateOccurrences.get(mapping.query_id) ?? [];
    existing.push(mapping.occurrence_id);
    coordinateOccurrences.set(mapping.query_id, existing);
  }
  return {
    schema_id: "penny.sca-osv-request.v2",
    schema_version: 2 as const,
    source_snapshot_sha256: sha256(canonicalJson(request.coordinates)),
    dependency_inventory_sha256: sha256(
      canonicalJson({ coordinates: request.coordinates, mappings: request.mappings })
    ),
    coordinates: request.coordinates.map((entry) => ({
      coordinate_id: entry.query_id,
      ecosystem: entry.package.ecosystem,
      name: entry.package.name,
      version: entry.package.version,
    })),
    coordinate_occurrences: request.coordinates.map((entry) => ({
      coordinate_id: entry.query_id,
      occurrence_ids: [...(coordinateOccurrences.get(entry.query_id) ?? [])].sort(),
    })),
    network_policy: "fixed_osv_origin_authorized" as const,
    ip_confinement: "external_worker_required" as const,
    inactivity_timeout_ms: request.timeout_ms,
    max_response_bytes: request.max_response_bytes,
    concurrency: request.max_concurrency,
    max_advisory_requests: request.max_advisory_requests,
    max_age_seconds: request.freshness_max_age_seconds,
  } as const;
}
