import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import type {
  HostOperationAdapterTerminalV1,
  HostOperationAdapterV1,
  HostOperationExecutionContextV1,
  HostOperationRequestInspectionV1,
} from "../../orchestration/dist/host-operations/contracts.js";
import {
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
} from "../../orchestration/dist/sca/p01-contracts.js";
import {
  validateScaP01RuleBundleV1,
  validateScaP01SelectedRuleManifestV1,
  validateScaP01ToolMeasurementReceiptV1,
  validateScaToolchainIdentityV1,
} from "../../orchestration/dist/sca/p01-policy-contracts.js";
import {
  SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
  SCA_P02_INPUT_SLOTS,
  SCA_P02_INVENTORY_RESULT_V1_SCHEMA,
  SCA_P02_OPERATION_IDS,
  SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA,
  SCA_P02_OSV_NPM_RESULT_V1_SCHEMA,
  SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA,
  SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
  scaP02AggregateProfileSha256,
  validateScaP02IsolationEvidenceV1,
  validateScaP02OperationProfilesV1,
  admitScaP02OperationResultV1,
  buildScaP02RawEvidenceV1,
  deriveScaP02ProvenanceV1,
  validateScaP02OperationRequestV1,
  type ScaP02AnalyzerId,
  type ScaP02AnalyzerResultV1,
  type ScaP02ComponentValidationAuthorityV1,
  type ScaP02GitleaksRequestV1,
  type ScaP02InventoryRequestV1,
  type ScaP02InventoryResultV1,
  type ScaP02OperationKind,
  type ScaP02OperationProfilesV1,
  type ScaP02OperationRequestV1,
  type ScaP02OperationResultV1,
  type ScaP02OsvComposerRequestV1,
  type ScaP02OsvNpmRequestV1,
  type ScaP02RawEvidenceV1,
  type ScaP02RawRecordV1,
  type ScaP02SemgrepJsTsRequestV1,
  type ScaP02SemgrepPhpRequestV1,
} from "../../orchestration/dist/sca/p02-contracts.js";
import {
  buildScaDependencyInventoryV2,
  validateScaDependencyInventoryResultV2,
} from "./adapters/dependency-inventory-v2.js";
import { runScaGitleaksV1, validateScaGitleaksResultV1 } from "./adapters/gitleaks.js";
import { matchesIssuedP02OsvTransport } from "./p02-osv-host.js";
import {
  evaluateScaOsvV2Freshness,
  planScaOsvV2,
  queryScaOsvV2,
  type ScaOsvV2Transport,
} from "./adapters/osv-v2.js";
import { runScaSemgrepV1, validateScaSemgrepResultV1 } from "./adapters/semgrep.js";
import {
  buildScaSourceCensusV1,
  validateScaSourceCensusResultV1,
} from "./adapters/source-census.js";
import {
  buildScaTreeSitterIndexV2,
  validateScaTreeSitterIndexResultV2,
} from "./adapters/tree-sitter-index.js";
import {
  buildScaP02CustodySummaryV1,
  buildScaP02DependencyInventoryInputV2,
  buildScaP02GitleaksComponentRequestV1,
  buildScaP02OsvComponentRequestV2,
  buildScaP02SemgrepComponentRequestV1,
  buildScaP02SourceCensusInputV1,
  buildScaP02TreeSitterInputV2,
  minimizeScaP02GitleaksEvidenceV1,
  scaP02DependencyHandoffV1,
  selectScaP02ScannerRulesV1,
} from "./p02-component-inputs.js";
import {
  matchesP02HostFactoryRunnerV1,
  type P02ControlledProcessRunnerV1,
} from "./p02-host-process-runner.js";
import { materializeScaSourceCustodyV1 } from "./source-custody-materializer.js";
import {
  matchesP02ControlledInventoryRunnerV1,
  type P02ControlledInventoryRunnerV1,
} from "./p02-host-inventory-runner.js";

export {
  minimizeScaP02GitleaksEvidenceV1,
  selectScaP02ScannerRulesV1,
} from "./p02-component-inputs.js";

const BLOCKER_SCHEMA = "penny.sca-p02-adapter-blocker.v1";
const INVENTORY_RAW = Object.freeze({
  census: "source-census",
  tree: "tree-sitter-php",
  dependency: "dependency-npm",
} as const);

interface ScaP02IsolationRuntimeCommonV1 {
  readonly isolation_id: string;
  readonly runtime_id: string;
  readonly implementation_identity_sha256: string;
  readonly deployment_identity_sha256: string;
  readonly profile_id: string;
  readonly profile_sha256: string;
  run<T>(input: {
    readonly operation_kind: ScaP02OperationKind;
    readonly signal: AbortSignal;
    readonly execute: () => Promise<T>;
  }): Promise<T>;
}

export type ScaP02IsolationRuntimeV1 = ScaP02IsolationRuntimeCommonV1 &
  (
    | Readonly<{
        runtime_kind: "simulated_test_runtime";
        qualification_scope: "deterministic_test_only";
        simulation_label: "simulated_test_seam";
      }>
    | Readonly<{
        runtime_kind: "host_qualified";
        qualification_scope: "live_qualified";
        operation_profiles: ScaP02OperationProfilesV1;
        host_attestation_id: string;
        host_attestation_sha256: string;
        host_attestation_ref: ArtifactRef;
      }>
  );

export interface ScaP02OperationAdapterOptionsV1 {
  /** Host-owned semantic authority. Adapter execution fails closed when absent. */
  readonly component_validation_authority?: ScaP02ComponentValidationAuthorityV1;
  readonly isolation?: ScaP02IsolationRuntimeV1;
  readonly controlled_inventory_runner?: P02ControlledInventoryRunnerV1;
  readonly controlled_process_runners?: Readonly<
    Partial<Record<"semgrep_php" | "semgrep_js_ts" | "gitleaks", P02ControlledProcessRunnerV1>>
  >;
  /** Each ecosystem receives its own exact factory-issued transport capability. */
  readonly osv_transports?: Readonly<
    Partial<
      Record<
        "osv_composer" | "osv_npm",
        Readonly<{
          readonly transport_id: string;
          readonly transport: ScaOsvV2Transport;
        }>
      >
    >
  >;
  readonly now?: () => Date;
  readonly local_recovery?: Readonly<{
    prove_prior_process_terminated(input: {
      readonly operation_kind: "inventory" | "semgrep_php" | "semgrep_js_ts" | "gitleaks";
      readonly request_sha256: string;
      readonly prior_correlation_id: string;
    }): boolean;
  }>;
  readonly fault?: (point: "after_result_cached", operationKind: ScaP02OperationKind) => void;
}

function requiredComponentAuthority(
  options: ScaP02OperationAdapterOptionsV1
): ScaP02ComponentValidationAuthorityV1 {
  const authority = options.component_validation_authority;
  if (authority === undefined || typeof authority.validateComponents !== "function") {
    throw new Error("sca_p02_component_validation_authority_unavailable");
  }
  return authority;
}

function parseCanonical(bytes: Uint8Array, label: string): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not JSON`, { cause: error });
  }
  if (canonicalJson(value) !== text) throw new Error(`${label} is not canonical JSON`);
  return value;
}

interface EvidenceBundle {
  readonly evidence: ScaP02RawEvidenceV1;
  readonly raw_records: readonly ScaP02RawRecordV1[];
}

function rawEvidence(input: {
  readonly analyzerId: ScaP02AnalyzerId;
  readonly value: Readonly<Record<string, unknown>>;
  readonly retention?: "exact" | "minimized";
  readonly originalSha256?: string;
  readonly originalByteLength?: number;
}): EvidenceBundle {
  return buildScaP02RawEvidenceV1({
    analyzer_id: input.analyzerId,
    value: input.value,
    ...(input.retention === undefined ? {} : { retention: input.retention }),
    ...(input.originalSha256 === undefined
      ? {}
      : { original_content_sha256: input.originalSha256 }),
    ...(input.originalByteLength === undefined
      ? {}
      : { original_byte_length: input.originalByteLength }),
  });
}

function provenance(bundles: readonly EvidenceBundle[]) {
  const rawEvidenceValues = bundles.map((bundle) => bundle.evidence);
  const rawRecords = bundles.flatMap((bundle) => bundle.raw_records);
  const graph = deriveScaP02ProvenanceV1({
    raw_evidence: rawEvidenceValues,
    raw_records: rawRecords,
  });
  return {
    raw_evidence: rawEvidenceValues,
    raw_records: rawRecords,
    normalized_observations: [...graph.normalized_observations],
    correlations: [...graph.correlations],
  };
}

function isolationResultBinding(request: ScaP02OperationRequestV1) {
  return {
    isolation_id: request.isolation_id,
    isolation_runtime_id: request.isolation_runtime_id,
    isolation_runtime_kind: request.isolation_runtime_kind,
    isolation_qualification_scope: request.isolation_qualification_scope,
    isolation_profile_id: request.isolation_profile_id,
    isolation_profile_sha256: request.isolation_profile_sha256,
    isolation_implementation_sha256: request.isolation_implementation_sha256,
    isolation_deployment_sha256: request.isolation_deployment_sha256,
    isolation_host_attestation_id: request.isolation_host_attestation_id,
    isolation_host_attestation_sha256: request.isolation_host_attestation_sha256,
    isolation_host_attestation_ref: request.isolation_host_attestation_ref,
  };
}

function analyzer(
  analyzerId: ScaP02AnalyzerId,
  input: {
    readonly applicability?: "applicable" | "not_applicable";
    readonly blockers?: readonly string[];
    readonly fresh?: boolean | null;
  } = {}
): ScaP02AnalyzerResultV1 {
  const blockers = [...(input.blockers ?? [])].sort();
  return {
    analyzer_id: analyzerId,
    applicability: input.applicability ?? "applicable",
    status: blockers.length === 0 ? "complete" : "blocked",
    fresh: input.fresh ?? blockers.length === 0,
    blocker_codes: blockers,
  };
}

function blockedAnalyzers(kind: ScaP02OperationKind, code: string): ScaP02AnalyzerResultV1[] {
  const ids: Readonly<Record<ScaP02OperationKind, readonly ScaP02AnalyzerId[]>> = {
    inventory: [
      "source-census",
      "tree-sitter-php",
      "tree-sitter-js-ts",
      "dependency-composer",
      "dependency-npm",
    ],
    semgrep_php: ["semgrep-php"],
    semgrep_js_ts: ["semgrep-js-ts"],
    gitleaks: ["gitleaks"],
    osv_composer: ["osv-composer"],
    osv_npm: ["osv-npm"],
  };
  return ids[kind].map((id) =>
    analyzer(id, { blockers: [code], fresh: kind.startsWith("osv_") ? false : null })
  );
}

function resultSchema(kind: ScaP02OperationKind): string {
  return {
    inventory: SCA_P02_INVENTORY_RESULT_V1_SCHEMA,
    semgrep_php: SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
    semgrep_js_ts: SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA,
    gitleaks: SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
    osv_composer: SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA,
    osv_npm: SCA_P02_OSV_NPM_RESULT_V1_SCHEMA,
  }[kind];
}

function blockedResult(
  kind: ScaP02OperationKind,
  request: ScaP02OperationRequestV1,
  code: string,
  now: () => Date,
  authority: ScaP02ComponentValidationAuthorityV1
): ScaP02OperationResultV1 {
  const blocker = {
    schema_id: BLOCKER_SCHEMA,
    schema_version: 1,
    operation_kind: kind,
    blocker_codes: [code],
  } as const;
  const analyzerResults = blockedAnalyzers(kind, code);
  const bundles = analyzerResults.map((entry) =>
    rawEvidence({ analyzerId: entry.analyzer_id, value: blocker })
  );
  const graph = provenance(bundles);
  const common = {
    schema_version: 1,
    run_id: request.run_id,
    request_sha256: request.request_sha256,
    source_binding_sha256:
      "source_snapshot_sha256" in request
        ? request.source_snapshot_sha256
        : request.p01_binding_sha256,
    ...isolationResultBinding(request),
    status: "blocked" as const,
    analyzer_results: analyzerResults,
    ...graph,
    freshness: { fetched_at: null, max_age_seconds: null, expires_at: null },
    completed_at: now().toISOString(),
  };
  switch (kind) {
    case "inventory":
      return admitScaP02OperationResultV1(
        kind,
        request,
        {
          ...common,
          schema_id: SCA_P02_INVENTORY_RESULT_V1_SCHEMA,
          operation_kind: kind,
          operation_id: SCA_P02_OPERATION_IDS.inventory,
          dependency_coordinates: [],
          dependency_mappings: [],
          ecosystem_states: [
            { ecosystem: "Packagist", state: "malformed" },
            { ecosystem: "npm", state: "malformed" },
          ],
        },
        authority
      );
    case "semgrep_php":
      return admitScaP02OperationResultV1(
        kind,
        request,
        {
          ...common,
          schema_id: SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
          operation_kind: kind,
          operation_id: SCA_P02_OPERATION_IDS.semgrep_php,
        },
        authority
      );
    case "semgrep_js_ts":
      return admitScaP02OperationResultV1(
        kind,
        request,
        {
          ...common,
          schema_id: SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA,
          operation_kind: kind,
          operation_id: SCA_P02_OPERATION_IDS.semgrep_js_ts,
        },
        authority
      );
    case "gitleaks":
      return admitScaP02OperationResultV1(
        kind,
        request,
        {
          ...common,
          schema_id: SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
          operation_kind: kind,
          operation_id: SCA_P02_OPERATION_IDS.gitleaks,
        },
        authority
      );
    case "osv_composer":
      return admitScaP02OperationResultV1(
        kind,
        request,
        {
          ...common,
          schema_id: SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA,
          operation_kind: kind,
          operation_id: SCA_P02_OPERATION_IDS.osv_composer,
        },
        authority
      );
    case "osv_npm":
      return admitScaP02OperationResultV1(
        kind,
        request,
        {
          ...common,
          schema_id: SCA_P02_OSV_NPM_RESULT_V1_SCHEMA,
          operation_kind: kind,
          operation_id: SCA_P02_OPERATION_IDS.osv_npm,
        },
        authority
      );
  }
}

function sourceMaterial(context: HostOperationExecutionContextV1) {
  const manifest = context.readInput(SCA_P02_INPUT_SLOTS.source_file_manifest);
  const custody = context.readInput(SCA_P02_INPUT_SLOTS.source_custody);
  return {
    manifest: validateScaP01SourceFileManifestV1(
      parseCanonical(manifest.bytes, "P02 source file manifest")
    ),
    custody: validateScaP01SourceCustodyCorpusV1(
      parseCanonical(custody.bytes, "P02 source custody")
    ),
    manifestRef: manifest.ref,
    custodyRef: custody.ref,
  };
}

function executableAuthority(
  context: HostOperationExecutionContextV1,
  request: ScaP02SemgrepPhpRequestV1 | ScaP02SemgrepJsTsRequestV1 | ScaP02GitleaksRequestV1
): void {
  const toolchain = validateScaToolchainIdentityV1(
    parseCanonical(context.readInput(SCA_P02_INPUT_SLOTS.toolchain).bytes, "P02 toolchain")
  );
  const measurement = validateScaP01ToolMeasurementReceiptV1(
    parseCanonical(
      context.readInput(SCA_P02_INPUT_SLOTS.tool_measurement).bytes,
      "P02 tool measurement"
    )
  );
  const executable = context.readInput(SCA_P02_INPUT_SLOTS.tool_executable);
  const tool = toolchain.tools.find(
    (candidate) => candidate.tool_id === request.executable.tool_id
  );
  if (
    tool === undefined ||
    tool.role !== "scanner" ||
    tool.version !== request.executable.version ||
    tool.executable_sha256 !== request.executable.executable_sha256 ||
    executable.ref.content_digest !== request.executable.executable_sha256 ||
    measurement.tool_id !== tool.tool_id ||
    measurement.role !== tool.role ||
    measurement.version !== tool.version ||
    measurement.executable_sha256 !== tool.executable_sha256 ||
    canonicalJson(measurement.executable_ref) !== canonicalJson(executable.ref) ||
    canonicalJson(tool.executable_ref) !== canonicalJson(executable.ref)
  ) {
    throw new Error("unqualified_runtime");
  }
}

async function assertExecutableIdentity(input: {
  readonly executable_path: string;
  readonly executable_sha256: string;
}): Promise<void> {
  const stat = await lstat(input.executable_path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unqualified_runtime");
  const handle = await open(input.executable_path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (sha256(bytes) !== input.executable_sha256) throw new Error("unqualified_runtime");
}

async function inventoryOperation(
  context: HostOperationExecutionContextV1,
  request: ScaP02InventoryRequestV1,
  now: () => Date,
  authority: ScaP02ComponentValidationAuthorityV1,
  controlledRunner?: P02ControlledInventoryRunnerV1,
  liveRequired = false
): Promise<ScaP02InventoryResultV1> {
  if (liveRequired && controlledRunner === undefined)
    throw Error("controlled_inventory_unavailable");
  const source = sourceMaterial(context);
  const stagingRoot = join(
    request.staging_parent,
    `${request.operation_id}-${request.request_sha256.slice(0, 16)}`
  );
  const materialized = await materializeScaSourceCustodyV1(
    {
      schema_id: "penny.sca-source-custody-materialization-input.v1",
      schema_version: 1,
      file_manifest_sha256: source.manifestRef.content_digest,
      custody_sha256: source.custodyRef.content_digest,
      file_manifest: source.manifest,
      custody: source.custody,
    },
    {
      staging_root: stagingRoot,
      signal: context.signal,
      on_file_materialized: (count) => context.reportActivity("source_materialized", count),
    }
  );
  try {
    const censusInput = buildScaP02SourceCensusInputV1(request, source.custody);
    const census = validateScaSourceCensusResultV1(buildScaSourceCensusV1(censusInput));
    const treeInput = buildScaP02TreeSitterInputV2(request, source.custody);
    if (
      sha256(canonicalJson(censusInput.tool)) !== request.source_census_identity_sha256 ||
      sha256(canonicalJson(treeInput.tool)) !== request.tree_sitter_identity_sha256
    ) {
      throw new Error("internal_component_identity_drift");
    }
    const tree = validateScaTreeSitterIndexResultV2(
      controlledRunner === undefined
        ? buildScaTreeSitterIndexV2(treeInput)
        : await controlledRunner.run(
            { request, source_root: stagingRoot, tree_input: treeInput },
            context.signal
          ),
      treeInput,
      controlledRunner === undefined ? {} : { deterministic_rebuild: false }
    );
    const dependencyInput = buildScaP02DependencyInventoryInputV2(request, source.custody);
    const dependency = validateScaDependencyInventoryResultV2(
      buildScaDependencyInventoryV2(dependencyInput),
      dependencyInput
    );
    const phpFiles = tree.files.filter((file) => file.admitted_language === "php");
    const jsFiles = tree.files.filter((file) => file.admitted_language !== "php");
    const treeBlockers = (files: typeof tree.files): string[] =>
      files.some((file) => file.status !== "parsed" || file.truncated)
        ? ["tree_sitter_incomplete"]
        : [];
    const ecosystem = (name: "Packagist" | "npm") => {
      const entry = dependency.ecosystems.find((candidate) => candidate.ecosystem === name);
      if (entry === undefined) throw new Error(`dependency_${name.toLowerCase()}_state_absent`);
      return entry;
    };
    const depAnalyzer = (id: ScaP02AnalyzerId, name: "Packagist" | "npm") => {
      const state = ecosystem(name).state;
      if (state === "absent") return analyzer(id, { applicability: "not_applicable", fresh: true });
      return analyzer(id, {
        blockers: state === "supported" ? [] : [`dependency_${state}`],
        fresh: state === "supported",
      });
    };
    const analyzers = [
      analyzer("source-census"),
      analyzer("tree-sitter-php", {
        applicability: phpFiles.length === 0 ? "not_applicable" : "applicable",
        blockers: phpFiles.length === 0 ? [] : treeBlockers(phpFiles),
        fresh: phpFiles.length === 0 || treeBlockers(phpFiles).length === 0,
      }),
      analyzer("tree-sitter-js-ts", {
        applicability: jsFiles.length === 0 ? "not_applicable" : "applicable",
        blockers: jsFiles.length === 0 ? [] : treeBlockers(jsFiles),
        fresh: jsFiles.length === 0 || treeBlockers(jsFiles).length === 0,
      }),
      depAnalyzer("dependency-composer", "Packagist"),
      depAnalyzer("dependency-npm", "npm"),
    ];
    const { coordinates, mappings } = scaP02DependencyHandoffV1(dependency);
    const custodySummary = buildScaP02CustodySummaryV1({
      file_manifest_ref: source.manifestRef,
      custody_ref: source.custodyRef,
      custody: source.custody,
    });
    if (
      materialized.receipt.file_manifest_sha256 !== custodySummary.file_manifest_sha256 ||
      materialized.receipt.custody_sha256 !== custodySummary.custody_sha256 ||
      materialized.receipt.tree_sha256 !== custodySummary.tree_sha256 ||
      materialized.receipt.file_count !== custodySummary.file_count ||
      materialized.receipt.byte_count !== custodySummary.byte_count ||
      materialized.receipt.filesystem_modes_prepared_read_only !==
        custodySummary.filesystem_modes_prepared_read_only
    ) {
      throw new Error("source_custody_materialization_receipt_drift");
    }
    const bundles = [
      rawEvidence({ analyzerId: INVENTORY_RAW.census, value: census }),
      rawEvidence({ analyzerId: "tree-sitter-php", value: tree }),
      rawEvidence({ analyzerId: "tree-sitter-js-ts", value: tree }),
      rawEvidence({ analyzerId: "dependency-composer", value: dependency }),
      rawEvidence({ analyzerId: INVENTORY_RAW.dependency, value: dependency }),
      rawEvidence({ analyzerId: "source-census", value: custodySummary }),
    ];
    const graph = provenance(bundles);
    const result: ScaP02InventoryResultV1 = {
      schema_id: SCA_P02_INVENTORY_RESULT_V1_SCHEMA,
      schema_version: 1,
      run_id: request.run_id,
      operation_id: SCA_P02_OPERATION_IDS.inventory,
      operation_kind: "inventory",
      request_sha256: request.request_sha256,
      source_binding_sha256: request.source_snapshot_sha256,
      ...isolationResultBinding(request),
      status: analyzers.some((entry) => entry.status === "blocked") ? "blocked" : "complete",
      analyzer_results: analyzers,
      ...graph,
      freshness: { fetched_at: null, max_age_seconds: null, expires_at: null },
      dependency_coordinates: coordinates,
      dependency_mappings: mappings,
      ecosystem_states: [
        { ecosystem: "Packagist", state: ecosystem("Packagist").state },
        { ecosystem: "npm", state: ecosystem("npm").state },
      ],
      completed_at: now().toISOString(),
    };
    const validated = admitScaP02OperationResultV1("inventory", request, result, authority);
    if (validated.operation_kind !== "inventory") {
      throw new Error("inventory_result_operation_kind_drift");
    }
    return validated;
  } finally {
    await materialized.cleanup();
  }
}

async function privateAuxRoot(parent: string, operationId: string, requestSha: string) {
  const root = join(parent, `${operationId}-aux-${requestSha.slice(0, 16)}`);
  try {
    await quarantineAux(root);
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error;
  }
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  return root;
}

async function quarantineAux(root: string): Promise<void> {
  await rename(root, `${root}.penny-quarantine-${randomBytes(16).toString("hex")}`);
}

function scannerRules(
  context: HostOperationExecutionContextV1,
  languages: readonly string[],
  oneRuleId?: string,
  excludedRuleIds: readonly string[] = []
) {
  const bundle = validateScaP01RuleBundleV1(
    parseCanonical(context.readInput(SCA_P02_INPUT_SLOTS.rule_bundle).bytes, "P02 rule bundle")
  );
  const selected = validateScaP01SelectedRuleManifestV1(
    parseCanonical(
      context.readInput(SCA_P02_INPUT_SLOTS.selected_rule_manifest).bytes,
      "P02 selected rule manifest"
    )
  );
  return selectScaP02ScannerRulesV1({
    rules: bundle.rules,
    selected_rule_ids: selected.selected_rule_ids,
    languages,
    ...(oneRuleId === undefined ? {} : { one_rule_id: oneRuleId }),
    excluded_rule_ids: excludedRuleIds,
  });
}

async function semgrepOperation(
  context: HostOperationExecutionContextV1,
  request: ScaP02SemgrepPhpRequestV1 | ScaP02SemgrepJsTsRequestV1,
  kind: "semgrep_php" | "semgrep_js_ts",
  now: () => Date,
  authority: ScaP02ComponentValidationAuthorityV1,
  runner?: P02ControlledProcessRunnerV1
): Promise<ScaP02OperationResultV1> {
  executableAuthority(context, request);
  await assertExecutableIdentity(request.executable);
  const source = sourceMaterial(context);
  const sourceRoot = join(
    request.staging_parent,
    `${request.operation_id}-source-${request.request_sha256.slice(0, 16)}`
  );
  const materialized = await materializeScaSourceCustodyV1(
    {
      schema_id: "penny.sca-source-custody-materialization-input.v1",
      schema_version: 1,
      file_manifest_sha256: source.manifestRef.content_digest,
      custody_sha256: source.custodyRef.content_digest,
      file_manifest: source.manifest,
      custody: source.custody,
    },
    { staging_root: sourceRoot, signal: context.signal }
  );
  const auxRoot = await privateAuxRoot(
    request.staging_parent,
    request.operation_id,
    request.request_sha256
  );
  try {
    const configRoot = join(auxRoot, "config");
    const scratchRoot = join(auxRoot, "scratch");
    await mkdir(configRoot, { mode: 0o700 });
    await mkdir(scratchRoot, { mode: 0o700 });
    const rules = scannerRules(context, request.languages, undefined, request.excluded_rule_ids);
    if (
      rules.length === 0 ||
      canonicalJson(
        rules.map((rule) => ({ rule_id: rule.rule_id, content_sha256: rule.content_sha256 }))
      ) !== canonicalJson(request.selected_rule_bindings)
    ) {
      throw new Error("selected_rule_binding_drift");
    }
    const outputs = [];
    for (const [index, rule] of rules.entries()) {
      if (context.signal.aborted) throw new Error("cancelled");
      const path = join(configRoot, `rule-${String(index).padStart(6, "0")}.yaml`);
      const bytes = Buffer.from(rule.content_base64, "base64");
      await writeFile(path, bytes, { mode: 0o400, flag: "wx" });
      const componentRequest = buildScaP02SemgrepComponentRequestV1({
        request,
        rule,
        rule_index: index,
      });
      if (
        componentRequest.source_root !== sourceRoot ||
        componentRequest.scratch_root !== scratchRoot ||
        componentRequest.rule_config !== path
      ) {
        throw new Error("deterministic_component_path_drift");
      }
      const output = validateScaSemgrepResultV1(
        await runScaSemgrepV1(componentRequest, context.signal, runner),
        componentRequest
      );
      outputs.push(output);
      context.reportActivity("scanner_rule_completed", index + 1);
    }
    const analyzerId = kind === "semgrep_php" ? "semgrep-php" : "semgrep-js-ts";
    const blocked = outputs.some(
      (output) =>
        output.truncated ||
        output.error_code !== "none" ||
        (output.status !== "succeeded" && output.status !== "findings")
    );
    const bundles = outputs.map((output) => rawEvidence({ analyzerId, value: output }));
    const graph = provenance(bundles);
    const result = {
      schema_id: resultSchema(kind),
      schema_version: 1,
      run_id: request.run_id,
      operation_id: request.operation_id,
      operation_kind: kind,
      request_sha256: request.request_sha256,
      source_binding_sha256: request.source_snapshot_sha256,
      ...isolationResultBinding(request),
      status: blocked ? "blocked" : "complete",
      analyzer_results: [analyzer(analyzerId, { blockers: blocked ? ["semgrep_incomplete"] : [] })],
      ...graph,
      freshness: { fetched_at: null, max_age_seconds: null, expires_at: null },
      completed_at: now().toISOString(),
    } as const;
    return admitScaP02OperationResultV1(kind, request, result, authority);
  } finally {
    await materialized.cleanup();
    await quarantineAux(auxRoot);
  }
}

async function gitleaksOperation(
  context: HostOperationExecutionContextV1,
  request: ScaP02GitleaksRequestV1,
  now: () => Date,
  authority: ScaP02ComponentValidationAuthorityV1,
  runner?: P02ControlledProcessRunnerV1
): Promise<ScaP02OperationResultV1> {
  executableAuthority(context, request);
  await assertExecutableIdentity(request.executable);
  const source = sourceMaterial(context);
  const sourceRoot = join(
    request.staging_parent,
    `${request.operation_id}-source-${request.request_sha256.slice(0, 16)}`
  );
  const materialized = await materializeScaSourceCustodyV1(
    {
      schema_id: "penny.sca-source-custody-materialization-input.v1",
      schema_version: 1,
      file_manifest_sha256: source.manifestRef.content_digest,
      custody_sha256: source.custodyRef.content_digest,
      file_manifest: source.manifest,
      custody: source.custody,
    },
    { staging_root: sourceRoot, signal: context.signal }
  );
  const auxRoot = await privateAuxRoot(
    request.staging_parent,
    request.operation_id,
    request.request_sha256
  );
  try {
    const rule = scannerRules(context, [], request.configuration_rule_binding.rule_id)[0];
    if (
      rule === undefined ||
      rule.content_sha256 !== request.configuration_rule_binding.content_sha256
    ) {
      throw new Error("selected_configuration_binding_drift");
    }
    const configurationPath = join(auxRoot, "gitleaks.toml");
    await writeFile(configurationPath, Buffer.from(rule.content_base64, "base64"), {
      mode: 0o400,
      flag: "wx",
    });
    const componentRequest = buildScaP02GitleaksComponentRequestV1({ request, rule });
    if (
      componentRequest.source_root !== sourceRoot ||
      componentRequest.configuration_path !== configurationPath
    ) {
      throw new Error("deterministic_component_path_drift");
    }
    const output = validateScaGitleaksResultV1(
      await runScaGitleaksV1(componentRequest, context.signal, runner),
      componentRequest
    );
    const blocked =
      output.truncated ||
      output.error_code !== "none" ||
      (output.status !== "succeeded" && output.status !== "findings");
    const minimized = minimizeScaP02GitleaksEvidenceV1(output.raw_stdout, output);
    const originalBytes = Buffer.from(canonicalJson(output), "utf8");
    const bundle = rawEvidence({
      analyzerId: "gitleaks",
      value: minimized,
      retention: "minimized",
      originalSha256: sha256(originalBytes),
      originalByteLength: originalBytes.byteLength,
    });
    const graph = provenance([bundle]);
    const result = {
      schema_id: SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
      schema_version: 1,
      run_id: request.run_id,
      operation_id: request.operation_id,
      operation_kind: "gitleaks",
      request_sha256: request.request_sha256,
      source_binding_sha256: request.source_snapshot_sha256,
      ...isolationResultBinding(request),
      status: blocked ? "blocked" : "complete",
      analyzer_results: [
        analyzer("gitleaks", { blockers: blocked ? ["gitleaks_incomplete"] : [] }),
      ],
      ...graph,
      freshness: { fetched_at: null, max_age_seconds: null, expires_at: null },
      completed_at: now().toISOString(),
    } as const;
    return admitScaP02OperationResultV1("gitleaks", request, result, authority);
  } finally {
    await materialized.cleanup();
    await quarantineAux(auxRoot);
  }
}

async function osvOperation(
  request: ScaP02OsvComposerRequestV1 | ScaP02OsvNpmRequestV1,
  kind: "osv_composer" | "osv_npm",
  options: ScaP02OperationAdapterOptionsV1,
  signal: AbortSignal,
  now: () => Date,
  authority: ScaP02ComponentValidationAuthorityV1
): Promise<ScaP02OperationResultV1> {
  if (request.coordinates.length === 0) {
    return unavailableOsvResult(request, kind, now, authority);
  }
  const selectedTransport = options.osv_transports?.[kind];
  if (
    selectedTransport === undefined ||
    selectedTransport.transport_id !== request.transport_id ||
    selectedTransport.transport.ip_confinement !== "external_worker_enforced" ||
    !matchesIssuedP02OsvTransport(
      selectedTransport.transport,
      request,
      buildScaP02OsvComponentRequestV2(request)
    ) ||
    request.max_batch_size !== 128 ||
    request.max_concurrency !== 2
  ) {
    throw new Error("osv_isolation_unavailable");
  }
  const componentRequest = buildScaP02OsvComponentRequestV2(request);
  const plan = planScaOsvV2(componentRequest);
  const output = await queryScaOsvV2(componentRequest, {
    transport: selectedTransport.transport,
    signal,
    now,
  });
  const freshness = evaluateScaOsvV2Freshness(output, now(), componentRequest, plan);
  const complete =
    output.status === "succeeded" && output.error_code === "none" && freshness === "fresh";
  const analyzerId = kind === "osv_composer" ? "osv-composer" : "osv-npm";
  const bundles = [
    rawEvidence({ analyzerId, value: plan }),
    rawEvidence({ analyzerId, value: output }),
  ];
  const graph = provenance(bundles);
  const expiresAt =
    output.fetched_at === null || output.max_age_seconds === null
      ? null
      : new Date(Date.parse(output.fetched_at) + output.max_age_seconds * 1_000).toISOString();
  const result = {
    schema_id: resultSchema(kind),
    schema_version: 1,
    run_id: request.run_id,
    operation_id: request.operation_id,
    operation_kind: kind,
    request_sha256: request.request_sha256,
    source_binding_sha256: request.p01_binding_sha256,
    ...isolationResultBinding(request),
    status: complete ? "complete" : "blocked",
    analyzer_results: [
      analyzer(analyzerId, {
        blockers: complete ? [] : [freshness === "stale" ? "osv_stale" : "osv_incomplete"],
        fresh: freshness === "fresh",
      }),
    ],
    ...graph,
    freshness: {
      fetched_at: output.fetched_at,
      max_age_seconds: output.max_age_seconds,
      expires_at: expiresAt,
    },
    completed_at: now().toISOString(),
  } as const;
  return admitScaP02OperationResultV1(kind, request, result, authority);
}

function unavailableOsvResult(
  request: ScaP02OsvComposerRequestV1 | ScaP02OsvNpmRequestV1,
  kind: "osv_composer" | "osv_npm",
  now: () => Date,
  authority: ScaP02ComponentValidationAuthorityV1
): ScaP02OperationResultV1 {
  if (request.coordinates.length === 0) {
    const analyzerId = kind === "osv_composer" ? "osv-composer" : "osv-npm";
    const bundle = rawEvidence({
      analyzerId,
      value: {
        schema_id: BLOCKER_SCHEMA,
        schema_version: 1,
        operation_kind: kind,
        blocker_codes: [],
      },
    });
    const graph = provenance([bundle]);
    const result = {
      schema_id: resultSchema(kind),
      schema_version: 1,
      run_id: request.run_id,
      operation_id: request.operation_id,
      operation_kind: kind,
      request_sha256: request.request_sha256,
      source_binding_sha256: request.p01_binding_sha256,
      ...isolationResultBinding(request),
      status: "complete",
      analyzer_results: [analyzer(analyzerId, { applicability: "not_applicable", fresh: true })],
      ...graph,
      freshness: { fetched_at: null, max_age_seconds: null, expires_at: null },
      completed_at: now().toISOString(),
    } as const;
    return admitScaP02OperationResultV1(kind, request, result, authority);
  }
  return blockedResult(kind, request, "osv_isolation_unavailable", now, authority);
}

function inspect(kind: ScaP02OperationKind, input: HostOperationRequestInspectionV1) {
  const request = validateScaP02OperationRequestV1(
    kind,
    parseCanonical(input.request_bytes, `SCA P02 ${kind} operation request`)
  );
  return {
    schema_version: 1 as const,
    operation_kind: input.directive.operation_kind,
    adapter_id: input.declaration.adapter_id,
    backend_binding_id: input.declaration.backend_binding_id,
    backend_key_sha256: request.request_sha256,
  };
}

async function persistResult(
  context: HostOperationExecutionContextV1,
  request: ScaP02OperationRequestV1,
  result: ScaP02OperationResultV1,
  options: ScaP02OperationAdapterOptionsV1,
  alreadyCached: boolean
): Promise<HostOperationAdapterTerminalV1> {
  const bytes = Buffer.from(canonicalJson(result), "utf8");
  const cached = await context.cacheResult(bytes);
  if (cached.content_sha256 !== sha256(bytes) || cached.byte_length !== bytes.byteLength) {
    throw new Error("operation_result_cache_binding_failed");
  }
  if (!alreadyCached) options.fault?.("after_result_cached", request.operation_kind);
  if (context.journal.lifecycle !== "persisting") {
    context.recordFetched({
      schema_version: 1,
      content_sha256: cached.content_sha256,
      byte_length: cached.byte_length,
      item_count: result.raw_evidence.length,
      poll_count: 0,
    });
  }
  const disposition = {
    outcome: "completed" as const,
    remote_disposition: "proven_terminal" as const,
    lease_disposition: "released" as const,
    retryable: false as const,
    reason_code: null,
  };
  const persisted = context.persist({
    disposition,
    operation_result: {
      contract: context.declaration.result,
      media_type: "application/json",
      content: bytes,
    },
  });
  return {
    disposition,
    operation_result_ref: persisted.operation_result_ref,
    output_artifacts: persisted.output_artifacts,
  };
}

function deterministicOperationClock(createdAt: string): () => Date {
  const epoch = Date.parse(createdAt);
  if (!Number.isFinite(epoch))
    throw new Error("host operation journal has an invalid creation time");
  let tick = 0;
  return () => new Date(epoch + tick++);
}

type P02SubmissionDisposition =
  | Readonly<{ disposition: "new" }>
  | Readonly<{
      disposition: "resumed";
      lifecycle: "submitted" | "fetched" | "persisting";
      correlation_id: string;
    }>;

function beginOrResume(
  context: HostOperationExecutionContextV1,
  request: ScaP02OperationRequestV1
): P02SubmissionDisposition {
  // Submission callbacks advance the live canonical journal. Recovery requirements
  // belong to the entry state, not the submitted state created by this invocation.
  const entry = context.journal;
  const correlationId = `p02_${request.request_sha256}`;
  if (entry.lifecycle === "lease_acquired") {
    context.beginSubmission();
    context.recordRemoteAccepted(correlationId);
    return { disposition: "new" };
  }
  if (
    (entry.lifecycle !== "submitted" &&
      entry.lifecycle !== "fetched" &&
      entry.lifecycle !== "persisting") ||
    entry.remote_correlation_id !== correlationId ||
    entry.remote_correlation_sha256 !== sha256(correlationId)
  ) {
    throw new Error("host operation journal cannot resume this deterministic adapter");
  }
  return {
    disposition: "resumed",
    lifecycle: entry.lifecycle,
    correlation_id: correlationId,
  };
}

type BoundOperationRequest =
  | Readonly<{ kind: "inventory"; request: ScaP02InventoryRequestV1 }>
  | Readonly<{ kind: "semgrep_php"; request: ScaP02SemgrepPhpRequestV1 }>
  | Readonly<{ kind: "semgrep_js_ts"; request: ScaP02SemgrepJsTsRequestV1 }>
  | Readonly<{ kind: "gitleaks"; request: ScaP02GitleaksRequestV1 }>
  | Readonly<{
      kind: "osv_composer";
      request: ScaP02OsvComposerRequestV1;
    }>
  | Readonly<{ kind: "osv_npm"; request: ScaP02OsvNpmRequestV1 }>;

function bindOperationRequest(kind: ScaP02OperationKind, bytes: Uint8Array): BoundOperationRequest {
  const request = validateScaP02OperationRequestV1(
    kind,
    parseCanonical(bytes, `SCA P02 ${kind} operation request`)
  );
  switch (request.operation_kind) {
    case "inventory":
      return { kind: request.operation_kind, request };
    case "semgrep_php":
      return { kind: request.operation_kind, request };
    case "semgrep_js_ts":
      return { kind: request.operation_kind, request };
    case "gitleaks":
      return { kind: request.operation_kind, request };
    case "osv_composer":
      return { kind: request.operation_kind, request };
    case "osv_npm":
      return { kind: request.operation_kind, request };
  }
}

function liveIsolationMatchesEvidence(
  context: HostOperationExecutionContextV1,
  request: ScaP02OperationRequestV1,
  runtime: Extract<ScaP02IsolationRuntimeV1, { qualification_scope: "live_qualified" }>
): boolean {
  const profiles = validateScaP02OperationProfilesV1(runtime.operation_profiles);
  const input = context.readInput(SCA_P02_INPUT_SLOTS.isolation_evidence);
  if (
    canonicalJson(input.ref) !== canonicalJson(request.isolation_evidence_ref) ||
    sha256(input.bytes) !== input.ref.content_digest
  )
    return false;
  const evidence = validateScaP02IsolationEvidenceV1(
    parseCanonical(input.bytes, "P02 live isolation evidence")
  );
  return (
    evidence.qualification_scope === "live_qualified" &&
    runtime.profile_sha256 === scaP02AggregateProfileSha256(profiles) &&
    canonicalJson(profiles) === canonicalJson(evidence.operation_profiles) &&
    runtime.profile_sha256 === evidence.profile_sha256 &&
    runtime.isolation_id === evidence.isolation_id &&
    runtime.runtime_id === evidence.runtime_id &&
    runtime.runtime_kind === evidence.runtime_kind &&
    runtime.profile_id === evidence.profile_id &&
    runtime.implementation_identity_sha256 === evidence.implementation_identity_sha256 &&
    runtime.deployment_identity_sha256 === evidence.deployment_identity_sha256 &&
    runtime.host_attestation_id === evidence.host_attestation_id &&
    runtime.host_attestation_sha256 === evidence.host_attestation_sha256 &&
    canonicalJson(runtime.host_attestation_ref) === canonicalJson(evidence.host_attestation_ref)
  );
}

function createAdapter(
  kind: ScaP02OperationKind,
  options: ScaP02OperationAdapterOptionsV1
): HostOperationAdapterV1 {
  const adapterId = `sca-p02-${kind.replaceAll("_", "-")}-adapter-v1`;
  return {
    adapter_id: adapterId,
    inspectRequest: (input) => inspect(kind, input),
    async run(context) {
      const bound = bindOperationRequest(kind, context.request_bytes);
      if (bound.kind !== kind) throw new Error("operation_request_kind_drift");
      const request = bound.request;
      const componentAuthority = requiredComponentAuthority(options);
      context.signal.throwIfAborted();
      const isolation = options.isolation;
      const liveRuntime = isolation?.qualification_scope === "live_qualified";
      const liveEvidenceMatches =
        liveRuntime && request.isolation_qualification_scope === "live_qualified"
          ? liveIsolationMatchesEvidence(context, request, isolation)
          : !liveRuntime;
      if (
        liveRuntime !== (request.isolation_qualification_scope === "live_qualified") ||
        (liveRuntime &&
          (!liveEvidenceMatches ||
            isolation.operation_profiles[bound.kind] !== request.isolation_profile_sha256 ||
            isolation.isolation_id !== request.isolation_id ||
            isolation.runtime_id !== request.isolation_runtime_id ||
            isolation.runtime_kind !== request.isolation_runtime_kind ||
            isolation.profile_id !== request.isolation_profile_id ||
            isolation.implementation_identity_sha256 !== request.isolation_implementation_sha256 ||
            isolation.deployment_identity_sha256 !== request.isolation_deployment_sha256 ||
            isolation.host_attestation_id !== request.isolation_host_attestation_id ||
            isolation.host_attestation_sha256 !== request.isolation_host_attestation_sha256 ||
            canonicalJson(isolation.host_attestation_ref) !==
              canonicalJson(request.isolation_host_attestation_ref)))
      ) {
        throw new Error("live_isolation_profile_binding_invalid");
      }
      const submission = beginOrResume(context, request);
      const now = options.now ?? deterministicOperationClock(context.journal.created_at);
      const cached = await context.readCachedResult();
      if (cached !== null) {
        const cachedResult = admitScaP02OperationResultV1(
          bound.kind,
          request,
          parseCanonical(cached.bytes, `cached SCA P02 ${bound.kind} result`),
          componentAuthority
        );
        return persistResult(context, request, cachedResult, options, true);
      }
      if (
        submission.disposition === "resumed" &&
        (submission.lifecycle === "fetched" || submission.lifecycle === "persisting")
      ) {
        throw new Error("cached_operation_result_missing_after_fetch");
      }
      if (submission.disposition === "resumed" && submission.lifecycle === "submitted") {
        if (bound.kind === "osv_composer" || bound.kind === "osv_npm") {
          throw new Error("osv_submission_outcome_uncertain");
        }
        if (
          options.local_recovery?.prove_prior_process_terminated({
            operation_kind: bound.kind,
            request_sha256: request.request_sha256,
            prior_correlation_id: submission.correlation_id,
          }) !== true
        ) {
          throw new Error("local_prior_process_termination_unproven");
        }
      }
      let result: ScaP02OperationResultV1;
      const inventoryRunner = options.controlled_inventory_runner;
      const closedRuntimeShape =
        isolation !== undefined &&
        (liveRuntime
          ? !("simulation_label" in isolation) &&
            request.isolation_host_attestation_id === isolation.host_attestation_id &&
            request.isolation_host_attestation_sha256 === isolation.host_attestation_sha256 &&
            canonicalJson(request.isolation_host_attestation_ref) ===
              canonicalJson(isolation.host_attestation_ref)
          : isolation.runtime_kind === "simulated_test_runtime" &&
            isolation.simulation_label === "simulated_test_seam" &&
            request.isolation_host_attestation_id === null &&
            request.isolation_host_attestation_sha256 === null &&
            request.isolation_host_attestation_ref === null);
      if (
        isolation === undefined ||
        !closedRuntimeShape ||
        !liveEvidenceMatches ||
        isolation.isolation_id !== request.isolation_id ||
        isolation.runtime_id !== request.isolation_runtime_id ||
        isolation.runtime_kind !== request.isolation_runtime_kind ||
        isolation.qualification_scope !== request.isolation_qualification_scope ||
        isolation.profile_id !== request.isolation_profile_id ||
        (liveRuntime
          ? isolation.operation_profiles[bound.kind] !== request.isolation_profile_sha256
          : isolation.profile_sha256 !== request.isolation_profile_sha256) ||
        isolation.implementation_identity_sha256 !== request.isolation_implementation_sha256 ||
        isolation.deployment_identity_sha256 !== request.isolation_deployment_sha256
      ) {
        result =
          bound.kind === "osv_composer" || bound.kind === "osv_npm"
            ? unavailableOsvResult(bound.request, bound.kind, now, componentAuthority)
            : blockedResult(
                bound.kind,
                bound.request,
                "isolation_unavailable",
                now,
                componentAuthority
              );
      } else if (
        liveRuntime &&
        ((bound.kind === "inventory" &&
          (inventoryRunner === undefined ||
            !matchesP02ControlledInventoryRunnerV1(
              inventoryRunner,
              bound.request,
              sourceMaterial(context).manifestRef.content_digest,
              sourceMaterial(context).custodyRef.content_digest
            ))) ||
          (bound.kind !== "inventory" &&
            bound.kind !== "osv_composer" &&
            bound.kind !== "osv_npm" &&
            (!matchesP02HostFactoryRunnerV1(
              options.controlled_process_runners?.[bound.kind],
              bound.request
            ) ||
              options.controlled_process_runners?.[bound.kind]?.profile_sha256 !==
                isolation.operation_profiles[bound.kind] ||
              options.controlled_process_runners?.[bound.kind]?.deployment_sha256 !==
                request.isolation_deployment_sha256)))
      ) {
        result = blockedResult(
          bound.kind,
          bound.request,
          bound.kind === "inventory"
            ? "controlled_inventory_unavailable"
            : "controlled_process_unavailable",
          now,
          componentAuthority
        );
      } else {
        try {
          result = await isolation.run({
            operation_kind: bound.kind,
            signal: context.signal,
            execute: async () => {
              switch (bound.kind) {
                case "inventory":
                  return inventoryOperation(
                    context,
                    bound.request,
                    now,
                    componentAuthority,
                    liveRuntime ? inventoryRunner : undefined,
                    liveRuntime
                  );
                case "semgrep_php":
                  return semgrepOperation(
                    context,
                    bound.request,
                    bound.kind,
                    now,
                    componentAuthority,
                    liveRuntime ? options.controlled_process_runners?.[bound.kind] : undefined
                  );
                case "semgrep_js_ts":
                  return semgrepOperation(
                    context,
                    bound.request,
                    bound.kind,
                    now,
                    componentAuthority,
                    liveRuntime ? options.controlled_process_runners?.[bound.kind] : undefined
                  );
                case "gitleaks":
                  return gitleaksOperation(
                    context,
                    bound.request,
                    now,
                    componentAuthority,
                    liveRuntime ? options.controlled_process_runners?.[bound.kind] : undefined
                  );
                case "osv_composer":
                case "osv_npm":
                  return osvOperation(
                    bound.request,
                    bound.kind,
                    options,
                    context.signal,
                    now,
                    componentAuthority
                  );
              }
            },
          });
        } catch (error) {
          if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            throw error;
          }
          const code =
            error instanceof Error && /^[a-z][a-z0-9_]*$/u.test(error.message)
              ? error.message
              : "adapter_execution_failed";
          result = blockedResult(bound.kind, bound.request, code, now, componentAuthority);
        }
      }
      context.signal.throwIfAborted();
      const validated = admitScaP02OperationResultV1(
        bound.kind,
        request,
        result,
        componentAuthority
      );
      return persistResult(context, request, validated, options, false);
    },
  };
}

export function createScaP02OperationAdaptersV1(
  options: ScaP02OperationAdapterOptionsV1 = {}
): ReadonlyMap<string, HostOperationAdapterV1> {
  const kinds = [
    "inventory",
    "semgrep_php",
    "semgrep_js_ts",
    "gitleaks",
    "osv_composer",
    "osv_npm",
  ] as const satisfies readonly ScaP02OperationKind[];
  const adapters = kinds.map((kind) => createAdapter(kind, options));
  return new Map(adapters.map((adapter) => [adapter.adapter_id, adapter]));
}
