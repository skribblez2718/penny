import type { ArtifactReader } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  ArtifactRefSchema,
  type ArtifactRef,
  validateContract,
} from "../../orchestration/dist/contracts.js";
import {
  validateScaCampaignManifestCoreV1,
  validateScaCampaignSourceSnapshotV2,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceMaterialV1,
} from "../../orchestration/dist/sca/p01-contracts.js";
import {
  validateScaP01RuleBundleV1,
  validateScaP01SelectedRuleManifestV1,
  validateScaP01ToolMeasurementReceiptV1,
  validateScaToolchainIdentityV1,
} from "../../orchestration/dist/sca/p01-policy-contracts.js";
import {
  decodeScaP02RawEvidenceV1,
  scaP02P01BindingSha256,
  validateScaP02RequestV1,
  validateScaP02RuntimePolicyV1,
  type ScaP02ComponentValidationAuthorityV1,
  type ScaP02GitleaksRequestV1,
  type ScaP02InventoryRequestV1,
  type ScaP02InventoryResultV1,
  type ScaP02OperationRequestV1,
  type ScaP02OperationResultV1,
  type ScaP02OsvComposerRequestV1,
  type ScaP02OsvNpmRequestV1,
  type ScaP02SemgrepJsTsRequestV1,
  type ScaP02SemgrepPhpRequestV1,
} from "../../orchestration/dist/sca/p02-contracts.js";
import {
  buildScaDependencyInventoryV2,
  validateScaDependencyInventoryResultV2,
} from "./adapters/dependency-inventory-v2.js";
import {
  evaluateScaOsvV2Freshness,
  planScaOsvV2,
  validateScaOsvPlanV2,
  validateScaOsvResultV2,
} from "./adapters/osv-v2.js";
import { validateScaSemgrepResultV1 } from "./adapters/semgrep.js";
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
  SCA_P02_GITLEAKS_MINIMIZED_RESULT_V1_SCHEMA,
  scaP02DependencyHandoffV1,
  selectScaP02ScannerRulesV1,
  validateScaP02CustodySummaryV1,
  validateScaP02GitleaksMinimizedResultV1,
} from "./p02-component-inputs.js";

const BLOCKER_SCHEMA = "penny.sca-p02-adapter-blocker.v1";
const CUSTODY_SUMMARY_SCHEMA = "penny.sca-p02-custody-summary.v1";
const SOURCE_CENSUS_RESULT_SCHEMA = "penny.sca-source-census-result.v1";
const TREE_SITTER_RESULT_SCHEMA = "penny.sca-tree-sitter-index-result.v2";
const DEPENDENCY_RESULT_SCHEMA = "penny.sca-dependency-inventory-result.v2";
const SEMGREP_RESULT_SCHEMA = "penny.sca-semgrep-result.v1";
const OSV_PLAN_SCHEMA = "penny.sca-osv-plan.v2";
const OSV_RESULT_SCHEMA = "penny.sca-osv-result.v2";

function fail(message: string): never {
  throw new Error(`sca_p02_component_admission_failed:${message}`);
}

function equal(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) fail(label);
}

function exactBytes(reader: ArtifactReader, ref: ArtifactRef, label: string): Buffer {
  const validatedRef = validateContract(ArtifactRefSchema, ref, `${label} reference`);
  const storedRef = reader.refById(validatedRef.artifact_id);
  if (storedRef === undefined || canonicalJson(storedRef) !== canonicalJson(validatedRef)) {
    fail(`${label}_reference_mismatch`);
  }
  const bytes = reader.readById(validatedRef.artifact_id);
  if (
    bytes.byteLength !== validatedRef.byte_length ||
    sha256(bytes) !== validatedRef.content_digest
  ) {
    fail(`${label}_custody_mismatch`);
  }
  return bytes;
}

function exactJson(reader: ArtifactReader, ref: ArtifactRef, label: string): unknown {
  const bytes = exactBytes(reader, ref, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail(`${label}_not_json`);
  }
}

function schemaId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id: unknown = Reflect.get(value, "schema_id");
  return typeof id === "string" ? id : null;
}

function componentValues(result: ScaP02OperationResultV1): unknown[] {
  return result.raw_evidence.map((evidence) => decodeScaP02RawEvidenceV1(evidence).value);
}

function validateBlockerOnly(
  request: ScaP02OperationRequestV1,
  result: ScaP02OperationResultV1,
  values: readonly unknown[]
): boolean {
  if (!values.every((value) => schemaId(value) === BLOCKER_SCHEMA)) return false;
  for (const value of values) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Reflect.get(value, "schema_version") !== 1 ||
      Reflect.get(value, "operation_kind") !== request.operation_kind ||
      !Array.isArray(Reflect.get(value, "blocker_codes")) ||
      !Object.keys(value).every((key) =>
        ["schema_id", "schema_version", "operation_kind", "blocker_codes"].includes(key)
      )
    ) {
      fail("invalid_adapter_blocker");
    }
  }
  if (result.status === "blocked") return true;
  if (
    (request.operation_kind === "osv_composer" || request.operation_kind === "osv_npm") &&
    request.coordinates.length === 0 &&
    result.analyzer_results.every(
      (entry) =>
        entry.applicability === "not_applicable" &&
        entry.status === "complete" &&
        entry.fresh === true &&
        entry.blocker_codes.length === 0
    )
  ) {
    return true;
  }
  fail("blocker_evidence_cannot_authorize_complete_result");
}

function admittedP01(reader: ArtifactReader, request: ScaP02OperationRequestV1) {
  const p02Request = validateScaP02RequestV1(
    exactJson(reader, request.p02_request_ref, "p02_request")
  );
  if (
    p02Request.run_id !== request.run_id ||
    scaP02P01BindingSha256(p02Request) !== request.p01_binding_sha256 ||
    canonicalJson(p02Request.runtime_policy_ref) !== canonicalJson(request.runtime_policy_ref) ||
    canonicalJson(p02Request.isolation_evidence_ref) !==
      canonicalJson(request.isolation_evidence_ref) ||
    canonicalJson(p02Request.isolation_host_attestation_ref) !==
      canonicalJson(request.isolation_host_attestation_ref)
  ) {
    fail("operation_request_parent_lineage_mismatch");
  }
  const core = validateScaCampaignManifestCoreV1(
    exactJson(
      reader,
      p02Request.accepted_p01.campaign_manifest_core_ref,
      "p01_campaign_manifest_core"
    )
  );
  return { p02Request, core };
}

function admittedPolicy(reader: ArtifactReader, request: ScaP02OperationRequestV1) {
  const { p02Request } = admittedP01(reader, request);
  const policy = validateScaP02RuntimePolicyV1(
    exactJson(reader, request.runtime_policy_ref, "p02_runtime_policy")
  );
  if (
    canonicalJson(policy.isolation_evidence_ref) !==
    canonicalJson(p02Request.isolation_evidence_ref)
  ) {
    fail("runtime_policy_isolation_binding_drift");
  }
  return policy;
}

function admittedCustody(reader: ArtifactReader, request: ScaP02OperationRequestV1) {
  const { p02Request, core } = admittedP01(reader, request);
  if (
    !("source_snapshot_ref" in request) ||
    canonicalJson(request.source_snapshot_ref) !==
      canonicalJson(core.frozen_refs.source_snapshot_ref) ||
    request.source_snapshot_sha256 !== core.frozen_refs.source_snapshot_ref.content_digest
  ) {
    fail("source_snapshot_binding_mismatch");
  }
  const snapshot = validateScaCampaignSourceSnapshotV2(
    exactJson(reader, core.frozen_refs.source_snapshot_ref, "p01_source_snapshot")
  );
  const fileManifest = validateScaP01SourceFileManifestV1(
    exactJson(reader, core.frozen_refs.source_file_manifest_ref, "p01_source_file_manifest")
  );
  const custody = validateScaP01SourceCustodyCorpusV1(
    exactJson(reader, core.frozen_refs.source_custody_ref, "p01_source_custody")
  );
  validateScaP01SourceMaterialV1({
    snapshot,
    file_manifest_ref: core.frozen_refs.source_file_manifest_ref,
    file_manifest: fileManifest,
    custody_ref: core.frozen_refs.source_custody_ref,
    custody,
  });
  return { p02Request, core, snapshot, fileManifest, custody };
}

function admittedScannerTool(
  reader: ArtifactReader,
  request: ScaP02SemgrepPhpRequestV1 | ScaP02SemgrepJsTsRequestV1 | ScaP02GitleaksRequestV1
): void {
  const { core } = admittedP01(reader, request);
  const policy = admittedPolicy(reader, request);
  const expectedToolId =
    request.operation_kind === "gitleaks"
      ? policy.operation_tools.gitleaks_tool_id
      : policy.operation_tools.semgrep_tool_id;
  const policyExecutable = policy.executables.find(
    (candidate) => candidate.tool_id === expectedToolId
  );
  const expectedMaxOutputBytes =
    request.operation_kind === "gitleaks"
      ? policy.gitleaks_max_output_bytes
      : policy.semgrep_max_output_bytes;
  if (
    policyExecutable === undefined ||
    expectedToolId !== request.executable.tool_id ||
    canonicalJson(policyExecutable) !== canonicalJson(request.executable) ||
    request.staging_parent !== policy.staging_parent ||
    request.timeout_ms !== policy.process_timeout_ms ||
    request.max_output_bytes !== expectedMaxOutputBytes ||
    (request.operation_kind === "gitleaks" &&
      request.configuration_rule_binding.rule_id !== policy.gitleaks_configuration_rule_id)
  ) {
    fail("scanner_runtime_policy_binding_drift");
  }

  const toolchain = validateScaToolchainIdentityV1(
    exactJson(reader, core.frozen_refs.toolchain_ref, "p01_toolchain")
  );
  const tool = toolchain.tools.find((candidate) => candidate.tool_id === expectedToolId);
  if (
    tool === undefined ||
    tool.role !== "scanner" ||
    tool.version !== request.executable.version ||
    tool.executable_sha256 !== request.executable.executable_sha256 ||
    !core.frozen_refs.tool_executable_refs.some(
      (ref) => canonicalJson(ref) === canonicalJson(tool.executable_ref)
    ) ||
    !core.frozen_refs.tool_measurement_receipt_refs.some(
      (ref) => canonicalJson(ref) === canonicalJson(tool.measurement_receipt_ref)
    )
  ) {
    fail("scanner_frozen_toolchain_binding_drift");
  }
  const receipt = validateScaP01ToolMeasurementReceiptV1(
    exactJson(reader, tool.measurement_receipt_ref, "p01_tool_measurement_receipt")
  );
  if (
    receipt.tool_id !== tool.tool_id ||
    receipt.role !== tool.role ||
    receipt.version !== tool.version ||
    receipt.executable_sha256 !== tool.executable_sha256 ||
    canonicalJson(receipt.executable_ref) !== canonicalJson(tool.executable_ref)
  ) {
    fail("scanner_measurement_receipt_binding_drift");
  }
  exactBytes(reader, tool.executable_ref, "p01_tool_executable");
}

function admittedRules(reader: ArtifactReader, request: ScaP02OperationRequestV1) {
  const { core } = admittedP01(reader, request);
  const bundle = validateScaP01RuleBundleV1(
    exactJson(reader, core.frozen_refs.rule_bundle_ref, "p01_rule_bundle")
  );
  const selected = validateScaP01SelectedRuleManifestV1(
    exactJson(reader, core.frozen_refs.selected_rule_manifest_ref, "p01_selected_rule_manifest")
  );
  return { bundle, selected };
}

function validateInventory(
  reader: ArtifactReader,
  request: ScaP02InventoryRequestV1,
  result: ScaP02InventoryResultV1,
  values: readonly unknown[]
): void {
  const { core, custody } = admittedCustody(reader, request);
  const policy = admittedPolicy(reader, request);
  if (
    request.staging_parent !== policy.staging_parent ||
    request.source_census_identity_sha256 !==
      policy.internal_component_identities.source_census_sha256 ||
    request.tree_sitter_identity_sha256 !==
      policy.internal_component_identities.tree_sitter_sha256 ||
    canonicalJson(request.tree_sitter) !== canonicalJson(policy.tree_sitter)
  ) {
    fail("inventory_runtime_policy_binding_drift");
  }
  const censusInput = buildScaP02SourceCensusInputV1(request, custody);
  const treeInput = buildScaP02TreeSitterInputV2(request, custody);
  const dependencyInput = buildScaP02DependencyInventoryInputV2(request, custody);
  if (
    sha256(canonicalJson(censusInput.tool)) !== request.source_census_identity_sha256 ||
    sha256(canonicalJson(treeInput.tool)) !== request.tree_sitter_identity_sha256
  ) {
    fail("inventory_component_identity_drift");
  }

  const censusValues = values.filter((value) => schemaId(value) === SOURCE_CENSUS_RESULT_SCHEMA);
  const treeValues = values.filter((value) => schemaId(value) === TREE_SITTER_RESULT_SCHEMA);
  const dependencyValues = values.filter((value) => schemaId(value) === DEPENDENCY_RESULT_SCHEMA);
  const custodyValues = values.filter((value) => schemaId(value) === CUSTODY_SUMMARY_SCHEMA);
  if (
    censusValues.length !== 1 ||
    treeValues.length !== 2 ||
    dependencyValues.length !== 2 ||
    custodyValues.length !== 1 ||
    values.length !== 6
  ) {
    fail("inventory_component_set_mismatch");
  }

  const census = validateScaSourceCensusResultV1(censusValues[0]);
  const expectedCensus = buildScaSourceCensusV1(censusInput);
  equal(census, expectedCensus, "source_census_deterministic_rebuild_drift");
  const custodySummary = validateScaP02CustodySummaryV1(custodyValues[0]);
  const expectedCustodySummary = buildScaP02CustodySummaryV1({
    file_manifest_ref: core.frozen_refs.source_file_manifest_ref,
    custody_ref: core.frozen_refs.source_custody_ref,
    custody,
  });
  equal(custodySummary, expectedCustodySummary, "source_custody_summary_drift");

  // Live evidence was produced and digest-bound by the controlled inventory worker.
  // Rebuilding here would run the native parser in the unsandboxed service again.
  const live = request.isolation_qualification_scope === "live_qualified";
  const tree = validateScaTreeSitterIndexResultV2(treeValues[0], treeInput, {
    deterministic_rebuild: !live,
  });
  validateScaTreeSitterIndexResultV2(treeValues[1], treeInput, {
    deterministic_rebuild: !live,
  });
  equal(treeValues[0], treeValues[1], "tree_sitter_duplicate_evidence_drift");
  if (!live) {
    const expectedTree = buildScaTreeSitterIndexV2(treeInput);
    equal(tree, expectedTree, "tree_sitter_deterministic_rebuild_drift");
  }

  const dependency = validateScaDependencyInventoryResultV2(dependencyValues[0], dependencyInput);
  validateScaDependencyInventoryResultV2(dependencyValues[1], dependencyInput);
  equal(dependencyValues[0], dependencyValues[1], "dependency_duplicate_evidence_drift");
  const expectedDependency = buildScaDependencyInventoryV2(dependencyInput);
  equal(dependency, expectedDependency, "dependency_deterministic_rebuild_drift");

  const handoff = scaP02DependencyHandoffV1(dependency);
  equal(result.dependency_coordinates, handoff.coordinates, "dependency_coordinate_handoff_drift");
  equal(result.dependency_mappings, handoff.mappings, "dependency_mapping_handoff_drift");
  const ecosystemStates = (["Packagist", "npm"] as const).map((ecosystem) => {
    const state = dependency.ecosystems.find((entry) => entry.ecosystem === ecosystem)?.state;
    if (state === undefined) fail(`dependency_${ecosystem}_state_absent`);
    return { ecosystem, state };
  });
  equal(result.ecosystem_states, ecosystemStates, "dependency_ecosystem_state_drift");
}

type SemgrepRequest = ScaP02SemgrepPhpRequestV1 | ScaP02SemgrepJsTsRequestV1;

function validateSemgrep(
  reader: ArtifactReader,
  request: SemgrepRequest,
  values: readonly unknown[]
): void {
  admittedScannerTool(reader, request);
  const { bundle, selected } = admittedRules(reader, request);
  const rules = selectScaP02ScannerRulesV1({
    rules: bundle.rules,
    selected_rule_ids: selected.selected_rule_ids,
    languages: request.languages,
    excluded_rule_ids: request.excluded_rule_ids,
  });
  equal(
    request.selected_rule_bindings,
    rules.map((rule) => ({ rule_id: rule.rule_id, content_sha256: rule.content_sha256 })),
    "semgrep_selected_rule_binding_drift"
  );
  if (
    values.length !== rules.length ||
    values.some((value) => schemaId(value) !== SEMGREP_RESULT_SCHEMA)
  ) {
    fail("semgrep_component_set_mismatch");
  }
  for (const [index, rule] of rules.entries()) {
    const componentRequest = buildScaP02SemgrepComponentRequestV1({
      request,
      rule,
      rule_index: index,
    });
    validateScaSemgrepResultV1(values[index], componentRequest);
  }
}

function validateGitleaks(
  reader: ArtifactReader,
  request: ScaP02GitleaksRequestV1,
  values: readonly unknown[]
): void {
  admittedScannerTool(reader, request);
  const { bundle, selected } = admittedRules(reader, request);
  const rules = selectScaP02ScannerRulesV1({
    rules: bundle.rules,
    selected_rule_ids: selected.selected_rule_ids,
    languages: [],
    one_rule_id: request.configuration_rule_binding.rule_id,
  });
  const rule = rules[0];
  if (rule === undefined || rules.length !== 1) fail("gitleaks_configuration_rule_absent");
  equal(
    request.configuration_rule_binding,
    { rule_id: rule.rule_id, content_sha256: rule.content_sha256 },
    "gitleaks_configuration_binding_drift"
  );
  if (values.length !== 1 || schemaId(values[0]) !== SCA_P02_GITLEAKS_MINIMIZED_RESULT_V1_SCHEMA) {
    fail("gitleaks_component_set_mismatch");
  }
  validateScaP02GitleaksMinimizedResultV1(
    values[0],
    buildScaP02GitleaksComponentRequestV1({ request, rule })
  );
}

function validateOsv(
  reader: ArtifactReader,
  request: ScaP02OsvComposerRequestV1 | ScaP02OsvNpmRequestV1,
  result: ScaP02OperationResultV1,
  values: readonly unknown[]
): void {
  const policy = admittedPolicy(reader, request);
  if (
    request.transport_id !== policy.osv.transport_id ||
    request.max_batch_size !== policy.osv.max_batch_size ||
    request.max_concurrency !== policy.osv.max_concurrency ||
    request.timeout_ms !== policy.osv.timeout_ms ||
    request.max_response_bytes !== policy.osv.max_response_bytes ||
    request.max_advisory_requests !== policy.osv.max_advisory_requests ||
    request.freshness_max_age_seconds !== policy.osv.freshness_max_age_seconds ||
    request.coordinates.some((entry) => entry.package.ecosystem !== request.ecosystem) ||
    request.mappings.some((entry) => entry.package.ecosystem !== request.ecosystem)
  ) {
    fail("osv_runtime_policy_or_ecosystem_binding_drift");
  }
  if (values.length !== 2) fail("osv_component_set_mismatch");
  const planValue = values.find((value) => schemaId(value) === OSV_PLAN_SCHEMA);
  const resultValue = values.find((value) => schemaId(value) === OSV_RESULT_SCHEMA);
  if (planValue === undefined || resultValue === undefined) fail("osv_component_set_mismatch");
  const componentRequest = buildScaP02OsvComponentRequestV2(request);
  const expectedPlan = planScaOsvV2(componentRequest);
  const plan = validateScaOsvPlanV2(planValue, componentRequest);
  equal(plan, expectedPlan, "osv_deterministic_plan_drift");
  const componentResult = validateScaOsvResultV2(resultValue, componentRequest, plan);
  const freshness = evaluateScaOsvV2Freshness(
    componentResult,
    new Date(result.completed_at),
    componentRequest,
    plan
  );
  const expectedComplete =
    componentResult.status === "succeeded" &&
    componentResult.error_code === "none" &&
    freshness === "fresh";
  const expectedExpiresAt =
    componentResult.fetched_at === null || componentResult.max_age_seconds === null
      ? null
      : new Date(
          Date.parse(componentResult.fetched_at) + componentResult.max_age_seconds * 1_000
        ).toISOString();
  if (
    result.status !== (expectedComplete ? "complete" : "blocked") ||
    result.freshness.fetched_at !== componentResult.fetched_at ||
    result.freshness.max_age_seconds !== componentResult.max_age_seconds ||
    result.freshness.expires_at !== expectedExpiresAt ||
    result.analyzer_results.some((entry) => entry.fresh !== (freshness === "fresh"))
  ) {
    fail("osv_operation_freshness_or_status_drift");
  }
}

export function createScaP02ComponentValidationAuthorityV1(
  reader: ArtifactReader
): ScaP02ComponentValidationAuthorityV1 {
  const authority: ScaP02ComponentValidationAuthorityV1 = {
    validateComponents(input): void {
      const { operation_kind, request, result } = input;
      if (operation_kind !== request.operation_kind || operation_kind !== result.operation_kind) {
        fail("operation_kind_mismatch");
      }
      admittedP01(reader, request);
      const values = componentValues(result);
      if (validateBlockerOnly(request, result, values)) return;
      switch (request.operation_kind) {
        case "inventory":
          if (result.operation_kind !== "inventory") fail("inventory_result_kind_mismatch");
          validateInventory(reader, request, result, values);
          return;
        case "semgrep_php":
        case "semgrep_js_ts":
          validateSemgrep(reader, request, values);
          return;
        case "gitleaks":
          validateGitleaks(reader, request, values);
          return;
        case "osv_composer":
        case "osv_npm":
          validateOsv(reader, request, result, values);
          return;
      }
    },
  };
  return Object.freeze(authority);
}
