import { validateContract, type ArtifactRef } from "../../orchestration/src/contracts.js";
import { canonicalJson, sha256 } from "../../orchestration/src/canonical-json.js";
import {
  ScaStaticAnalyzerRunInputV1Schema,
  type ScaStaticAnalyzerRunInputV1,
  type ScaStaticObservationInputV1,
} from "../../orchestration/src/sca/static-normalization.js";
import {
  ScaDependencyInventoryResultV1Schema,
  type ScaDependencyInventoryResultV1,
} from "./adapters/dependency-inventory.js";
import { ScaOsvResultV1Schema, type ScaOsvResultV1 } from "./adapters/osv.js";
import { ScaSemgrepResultV1Schema, type ScaSemgrepResultV1 } from "./adapters/semgrep.js";
import {
  ScaSourceCensusResultV1Schema,
  type ScaSourceCensusResultV1,
} from "./adapters/source-census.js";
import {
  ScaSyntaxInventoryResultV1Schema,
  type ScaSyntaxInventoryResultV1,
} from "./adapters/syntax-inventory.js";

export interface ScaNormalizationBindingV1 {
  readonly analyzer_id: string;
  readonly raw_ref: ArtifactRef;
  readonly implementation_sha256: string;
}

export class ScaServiceNormalizationError extends Error {
  constructor(
    readonly code: "invalid_result" | "invalid_path" | "invalid_finding" | "unsupported_result",
    message: string
  ) {
    super(message);
    this.name = "ScaServiceNormalizationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function repositoryPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new ScaServiceNormalizationError("invalid_path", "normalized source path is missing");
  }
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value !== value.normalize("NFC") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ScaServiceNormalizationError(
      "invalid_path",
      "normalized source path is not canonical"
    );
  }
  return value;
}

function positiveLine(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ScaServiceNormalizationError("invalid_finding", `${label} is invalid`);
  }
  return value;
}

function boundedMessage(value: unknown, fallback: string): string {
  const message = typeof value === "string" && value.length > 0 ? value : fallback;
  if (Buffer.byteLength(message, "utf8") > 8_192) {
    throw new ScaServiceNormalizationError("invalid_finding", "normalized message is oversized");
  }
  return message;
}

function weaknessFromMetadata(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const cwe = value.cwe;
  if (typeof cwe === "string" && cwe.length > 0) return cwe;
  if (isUnknownArray(cwe)) {
    const first = cwe.find((entry) => typeof entry === "string" && entry.length > 0);
    return typeof first === "string" ? first : null;
  }
  return null;
}

function failureObservation(
  message: string,
  digest: string,
  rawRef: ArtifactRef
): ScaStaticObservationInputV1 {
  return {
    observation_kind: "tool_failure",
    path: null,
    start_line: null,
    end_line: null,
    rule_id: null,
    weakness_id: null,
    package_coordinate: null,
    advisory_id: null,
    message,
    evidence_sha256: digest,
    raw_refs: [rawRef],
  };
}

function analyzerRun(value: unknown): ScaStaticAnalyzerRunInputV1 {
  return validateContract(ScaStaticAnalyzerRunInputV1Schema, value, "SCA normalized analyzer run");
}

function semgrepStatus(result: ScaSemgrepResultV1): ScaStaticAnalyzerRunInputV1["status"] {
  if (result.status === "succeeded" || result.status === "findings") return "succeeded";
  if (result.status === "unavailable") return "unavailable";
  if (result.status === "timed_out") return "timed_out";
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "output_limit") return "partial";
  return "failed";
}

function semgrepObservations(
  result: ScaSemgrepResultV1,
  rawRef: ArtifactRef
): readonly ScaStaticObservationInputV1[] {
  if (result.status !== "succeeded" && result.status !== "findings") {
    return [failureObservation(`Semgrep ${result.error_code}`, result.raw_stdout_sha256, rawRef)];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.raw_stdout);
  } catch {
    throw new ScaServiceNormalizationError("invalid_result", "Semgrep raw output is invalid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
    throw new ScaServiceNormalizationError("invalid_result", "Semgrep results are missing");
  }
  return parsed.results.map((finding): ScaStaticObservationInputV1 => {
    if (
      !isRecord(finding) ||
      typeof finding.check_id !== "string" ||
      !isRecord(finding.start) ||
      !isRecord(finding.end)
    ) {
      throw new ScaServiceNormalizationError("invalid_finding", "Semgrep finding is invalid");
    }
    const extra = isRecord(finding.extra) ? finding.extra : {};
    const evidenceSha256 = sha256(canonicalJson(finding));
    return {
      observation_kind: "candidate",
      path: repositoryPath(finding.path),
      start_line: positiveLine(finding.start.line, "Semgrep start line"),
      end_line: positiveLine(finding.end.line, "Semgrep end line"),
      rule_id: finding.check_id,
      weakness_id: weaknessFromMetadata(extra.metadata),
      package_coordinate: null,
      advisory_id: null,
      message: boundedMessage(extra.message, finding.check_id),
      evidence_sha256: evidenceSha256,
      raw_refs: [rawRef],
    };
  });
}

export function normalizeScaSemgrepRunV1(
  value: unknown,
  binding: ScaNormalizationBindingV1
): ScaStaticAnalyzerRunInputV1 {
  const result = validateContract(ScaSemgrepResultV1Schema, value, "SCA Semgrep result");
  const status = semgrepStatus(result);
  return analyzerRun({
    analyzer_id: binding.analyzer_id,
    analyzer_kind: "semgrep",
    status,
    tool_sha256: result.runtime_sha256,
    configuration_sha256: result.rule_config_sha256,
    raw_refs: [binding.raw_ref],
    observations: semgrepObservations(result, binding.raw_ref),
    failure_code: status === "succeeded" ? null : result.error_code,
  });
}

export function normalizeScaSourceCensusRunV1(
  value: unknown,
  binding: ScaNormalizationBindingV1
): ScaStaticAnalyzerRunInputV1 {
  const result: ScaSourceCensusResultV1 = validateContract(
    ScaSourceCensusResultV1Schema,
    value,
    "SCA source census result"
  );
  const observations = result.entries.map(
    (entry): ScaStaticObservationInputV1 => ({
      observation_kind: "coverage",
      path: entry.path,
      start_line: null,
      end_line: null,
      rule_id: null,
      weakness_id: null,
      package_coordinate: null,
      advisory_id: null,
      message: `${entry.language}:${entry.content_kind}:${entry.byte_length}`,
      evidence_sha256: entry.sha256,
      raw_refs: [binding.raw_ref],
    })
  );
  return analyzerRun({
    analyzer_id: binding.analyzer_id,
    analyzer_kind: "source_census",
    status: "succeeded",
    tool_sha256: result.tool.implementation_sha256,
    configuration_sha256: null,
    raw_refs: [binding.raw_ref],
    observations,
    failure_code: null,
  });
}

export function normalizeScaSyntaxInventoryRunV1(
  value: unknown,
  binding: ScaNormalizationBindingV1
): ScaStaticAnalyzerRunInputV1 {
  const result: ScaSyntaxInventoryResultV1 = validateContract(
    ScaSyntaxInventoryResultV1Schema,
    value,
    "SCA syntax inventory result"
  );
  const status: ScaStaticAnalyzerRunInputV1["status"] =
    result.status === "succeeded"
      ? "succeeded"
      : result.status === "unavailable"
        ? "unavailable"
        : result.status === "unsupported"
          ? "unsupported"
          : result.status === "partial"
            ? "partial"
            : "failed";
  const observations = result.files.map(
    (file): ScaStaticObservationInputV1 => ({
      observation_kind:
        file.status === "parsed"
          ? "coverage"
          : file.status === "unsupported"
            ? "unsupported"
            : "parse_gap",
      path: file.path,
      start_line: null,
      end_line: null,
      rule_id: null,
      weakness_id: null,
      package_coordinate: null,
      advisory_id: null,
      message:
        file.diagnostics.map((diagnostic) => diagnostic.message).join("; ") ||
        `${file.language}:${file.status}`,
      evidence_sha256: sha256(canonicalJson(file)),
      raw_refs: [binding.raw_ref],
    })
  );
  return analyzerRun({
    analyzer_id: binding.analyzer_id,
    analyzer_kind: "syntax_inventory",
    status,
    tool_sha256: result.tool.implementation_sha256,
    configuration_sha256: result.tool.grammar_bundle_sha256,
    raw_refs: [binding.raw_ref],
    observations:
      observations.length > 0
        ? observations
        : status === "succeeded"
          ? []
          : [
              failureObservation(
                `syntax inventory ${result.status}`,
                result.inventory_sha256,
                binding.raw_ref
              ),
            ],
    failure_code: status === "succeeded" ? null : (result.tool.unavailable_reason ?? result.status),
  });
}

export function normalizeScaDependencyRunV1(
  value: unknown,
  binding: ScaNormalizationBindingV1
): ScaStaticAnalyzerRunInputV1 {
  const result: ScaDependencyInventoryResultV1 = validateContract(
    ScaDependencyInventoryResultV1Schema,
    value,
    "SCA dependency inventory result"
  );
  const status: ScaStaticAnalyzerRunInputV1["status"] =
    result.status === "succeeded"
      ? "succeeded"
      : result.status === "unsupported"
        ? "unsupported"
        : result.status === "partial"
          ? "partial"
          : "failed";
  const observations = result.coordinates.map(
    (dependency): ScaStaticObservationInputV1 => ({
      observation_kind: "dependency",
      path: dependency.manifest_path,
      start_line: null,
      end_line: null,
      rule_id: null,
      weakness_id: null,
      package_coordinate: `${dependency.ecosystem}:${dependency.name}@${dependency.version}`,
      advisory_id: null,
      message: `${dependency.scope} dependency ${dependency.name}@${dependency.version}`,
      evidence_sha256: sha256(canonicalJson(dependency)),
      raw_refs: [binding.raw_ref],
    })
  );
  return analyzerRun({
    analyzer_id: binding.analyzer_id,
    analyzer_kind: "dependency_inventory",
    status,
    tool_sha256: binding.implementation_sha256,
    configuration_sha256: null,
    raw_refs: [binding.raw_ref],
    observations:
      observations.length > 0 || status === "succeeded"
        ? observations
        : [
            failureObservation(
              `dependency inventory ${result.status}`,
              result.inventory_sha256,
              binding.raw_ref
            ),
          ],
    failure_code: status === "succeeded" ? null : `dependency_inventory_${result.status}`,
  });
}

export function normalizeScaOsvRunV1(
  value: unknown,
  binding: ScaNormalizationBindingV1
): ScaStaticAnalyzerRunInputV1 {
  const result: ScaOsvResultV1 = validateContract(ScaOsvResultV1Schema, value, "SCA OSV result");
  const status: ScaStaticAnalyzerRunInputV1["status"] =
    result.status === "succeeded"
      ? "succeeded"
      : result.status === "unavailable"
        ? "unavailable"
        : result.status === "partial"
          ? "partial"
          : "failed";
  const observations = result.advisories.flatMap((advisory) =>
    advisory.affected.length === 0
      ? [
          {
            observation_kind: "advisory" as const,
            path: null,
            start_line: null,
            end_line: null,
            rule_id: null,
            weakness_id: null,
            package_coordinate: null,
            advisory_id: advisory.id,
            message: `OSV advisory ${advisory.id}`,
            evidence_sha256: advisory.raw_sha256,
            raw_refs: [binding.raw_ref],
          },
        ]
      : advisory.affected.map(
          (coordinate): ScaStaticObservationInputV1 => ({
            observation_kind: "advisory",
            path: null,
            start_line: null,
            end_line: null,
            rule_id: null,
            weakness_id: null,
            package_coordinate: `${coordinate.ecosystem}:${coordinate.name}@${coordinate.version}`,
            advisory_id: advisory.id,
            message: `OSV advisory ${advisory.id}`,
            evidence_sha256: advisory.raw_sha256,
            raw_refs: [binding.raw_ref],
          })
        )
  );
  return analyzerRun({
    analyzer_id: binding.analyzer_id,
    analyzer_kind: "osv",
    status,
    tool_sha256: binding.implementation_sha256,
    configuration_sha256: null,
    raw_refs: [binding.raw_ref],
    observations:
      observations.length > 0 || status === "succeeded"
        ? observations
        : [failureObservation(`OSV ${result.error_code}`, result.result_sha256, binding.raw_ref)],
    failure_code: status === "succeeded" ? null : result.error_code,
  });
}
