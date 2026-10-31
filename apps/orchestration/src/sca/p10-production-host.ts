import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract, type ArtifactRef } from "../contracts.js";
import {
  hostOperationPolicyBinding,
  validateHostOperationDeclaration,
  type HostOperationAdapterTerminalV1,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
  type HostOperationDispositionV1,
  type HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import type { HostOperationUseValidatorV1 } from "../host-operations/owner.js";
import type { PlaybookRegistration } from "../playbooks/registry.js";
import { Sha256Schema } from "../skill-contracts/common.js";
import {
  SCA_P10_RULE_VALIDATION_ADAPTER_ID,
  SCA_P10_RULE_VALIDATION_BACKEND_ID,
  SCA_P10_RULE_VALIDATION_DECLARATION,
  scaP10RuleValidationBackendKeySha256,
  scaP10RuleValidationRuntimeV1,
  validateScaP10RuleValidationAdapterResultV1,
  deriveScaP10ValidationEntry,
  validateScaP10RuleValidationRequestV1,
  type ScaP10RuleValidationAdapterResultV1,
  type ScaP10RuleValidationRequestV1,
  type ScaP10RuleValidationRuntimeConfigV1,
} from "./p10-validation.js";
import {
  SCA_P10_RULE_VALIDATION_OPERATION_KIND,
  validateScaP10RuleCandidateRevisionV1,
  validateScaP10RuleTestFixturesV1,
} from "./p10-contracts.js";
import {
  buildScaP10CandidateRegistrationWithBindingV1,
  SCA_P10_CANDIDATE_PLAYBOOK_NAME,
  type ScaP10CandidateBindingV1,
} from "./p10-playbook.js";

/**
 * Production host operation for the deterministic P10 Semgrep `--validate` / `--test` manifest
 * (`SCA-P10` R6). It exact-reads the candidate rule revision and every fixture ref from the
 * artifact store, materializes them under an owner-only bounded temporary working root with
 * traversal and symlink protections, invokes an injected bounded validation runner, and publishes
 * the exact adapter result through the normal host-operation owner. The runner itself is injected
 * so the orchestration package never depends on the service process runtime.
 */

const RuntimeConfigSchema = Type.Object(
  {
    executable: Type.String({ minLength: 1, maxLength: 4_096 }),
    executable_sha256: Sha256Schema,
    fixed_arguments: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 0 }),
    tool_version: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false }
);

/** Injected bounded validation port. The service supplies the real Semgrep invocation. */
export interface ScaP10RuleValidationInvocationV1 {
  readonly request: ScaP10RuleValidationRequestV1;
  readonly rule_config_path: string;
  readonly fixture_directory: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}
export type ScaP10RuleValidationRunnerV1 = (
  input: ScaP10RuleValidationInvocationV1
) => Promise<ScaP10RuleValidationAdapterResultV1>;

export interface ScaP10RuleValidationProductionHostCompositionV1 {
  readonly operation_kind: typeof SCA_P10_RULE_VALIDATION_OPERATION_KIND;
  readonly declaration: HostOperationDeclarationV1;
  readonly adapter: HostOperationAdapterV1;
  /** Pass directly as `OrchestrationService.hostOperationAdapters`. */
  readonly adapters: ReadonlyMap<string, HostOperationAdapterV1>;
  /** Pass directly as `OrchestrationService.hostOperationUseValidator`. */
  readonly use_validator: HostOperationUseValidatorV1;
  readonly backend_key_sha256: string;
  readonly runtime: ScaP10RuleValidationRuntimeConfigV1;
}

function validateRuntime(value: unknown): ScaP10RuleValidationRuntimeConfigV1 {
  const parsed: Static<typeof RuntimeConfigSchema> = validateContract(
    RuntimeConfigSchema,
    value,
    "SCA P10 rule validation runtime config"
  );
  scaP10RuleValidationRuntimeV1(parsed);
  if (
    !path.isAbsolute(parsed.executable) ||
    path.normalize(parsed.executable) !== parsed.executable ||
    parsed.executable.includes("\0")
  ) {
    throw new Error("SCA P10 rule validation runtime executable is not a normalized absolute path");
  }
  return parsed;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function decodeCanonical(bytes: Uint8Array, label: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`SCA P10 ${label} is not canonical JSON`);
  return value;
}

function exactCurrentRef(store: ArtifactHostStore, ref: ArtifactRef, label: string): Uint8Array {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) {
    throw new Error(`SCA P10 ${label} exact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`SCA P10 ${label} exact bytes drifted`);
  }
  return bytes;
}

function completedDisposition(): HostOperationDispositionV1 {
  return {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  };
}

function failedDisposition(reason: string, finished = false): HostOperationDispositionV1 {
  return {
    outcome: "failed",
    remote_disposition: finished ? "proven_terminal" : "proven_not_accepted",
    lease_disposition: "released",
    retryable: false,
    reason_code: reason,
  };
}

function terminalWithoutArtifacts(
  disposition: HostOperationDispositionV1
): HostOperationAdapterTerminalV1 {
  return { disposition, operation_result_ref: null, output_artifacts: [] };
}

function safeSegment(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 1_024 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    path.basename(name) !== name
  ) {
    throw new Error("SCA P10 fixture file name is not a single safe path segment");
  }
}

function assertOwnedDirectory(directory: string): void {
  const stat = lstatSync(directory);
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    (stat.mode & 0o777) !== 0o700 ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    throw new Error("SCA P10 bounded working directory is not owner-only");
  }
}

interface MaterializedRuleValidationV1 {
  readonly root: string;
  readonly rule_config_path: string;
  readonly fixture_directory: string;
  cleanup(): void;
}

/**
 * Materialize the exact candidate rule and all fixture refs under a fresh owner-only temporary
 * working root. Every fixture file name is a single safe segment; directory and file custody is
 * verified after creation. The caller owns cleanup.
 */
function materializeRuleValidation(input: {
  readonly store: ArtifactHostStore;
  readonly request: ScaP10RuleValidationRequestV1;
  readonly ruleBytes: Buffer;
}): MaterializedRuleValidationV1 {
  const created = mkdtempSync(path.join(tmpdir(), "penny-p10-rule-validation-"));
  chmodSync(created, 0o700);
  const root = realpathSync(created);
  assertOwnedDirectory(root);
  const rulesDirectory = path.join(root, "rules");
  const fixtureDirectory = path.join(root, "fixtures");
  mkdirSync(rulesDirectory, { mode: 0o700 });
  mkdirSync(fixtureDirectory, { mode: 0o700 });
  assertOwnedDirectory(rulesDirectory);
  assertOwnedDirectory(fixtureDirectory);
  const ruleConfigPath = path.join(rulesDirectory, `${input.request.candidate_id}.yml`);
  writeFileSync(ruleConfigPath, input.ruleBytes, { flag: "wx", mode: 0o400 });
  const ruleStat = lstatSync(ruleConfigPath);
  if (!ruleStat.isFile() || ruleStat.isSymbolicLink() || ruleStat.nlink !== 1) {
    throw new Error("SCA P10 rule config custody is invalid");
  }
  for (const fixture of input.request.fixtures) {
    safeSegment(fixture.file_name);
    const target = path.resolve(fixtureDirectory, fixture.file_name);
    if (path.dirname(target) !== fixtureDirectory) {
      throw new Error("SCA P10 fixture file escapes its bounded directory");
    }
    const bytes = exactCurrentRef(input.store, fixture.fixture_ref, "fixture");
    writeFileSync(target, bytes, { flag: "wx", mode: 0o400 });
    const stat = lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== bytes.byteLength
    ) {
      throw new Error("SCA P10 fixture file custody is invalid");
    }
  }
  return {
    root,
    rule_config_path: ruleConfigPath,
    fixture_directory: fixtureDirectory,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort teardown; the exact result is already published independently of the scratch
        // directory, and the operation never reports success from an unverified scratch artifact.
      }
    },
  };
}

interface BoundRuleValidationV1 {
  readonly request: ScaP10RuleValidationRequestV1;
  readonly revision: ReturnType<typeof validateScaP10RuleCandidateRevisionV1>;
  readonly fixtures: ReturnType<typeof validateScaP10RuleTestFixturesV1>;
}

/** Exact store-bound request/revision/fixture projection shared by inspection, use, and run. */
function bindRuleValidation(input: {
  readonly store: ArtifactHostStore;
  readonly requestBytes: Uint8Array;
  readonly ruleRevisionRef: ArtifactRef;
  readonly fixtureManifestRef: ArtifactRef;
  readonly backendKeySha256: string;
  readonly directiveBackendKeySha256: string;
  readonly runtime: ScaP10RuleValidationRuntimeConfigV1;
}): BoundRuleValidationV1 {
  const request = validateScaP10RuleValidationRequestV1(
    decodeCanonical(input.requestBytes, "rule validation request")
  );
  if (input.directiveBackendKeySha256 !== input.backendKeySha256) {
    throw new Error("SCA P10 rule validation directive policy binding drift");
  }
  const revision = validateScaP10RuleCandidateRevisionV1(
    decodeCanonical(
      exactCurrentRef(input.store, input.ruleRevisionRef, "candidate revision"),
      "candidate revision"
    )
  );
  const fixtures = validateScaP10RuleTestFixturesV1(
    decodeCanonical(
      exactCurrentRef(input.store, input.fixtureManifestRef, "fixture manifest"),
      "fixture manifest"
    )
  );
  if (
    !same(request.runtime, scaP10RuleValidationRuntimeV1(input.runtime)) ||
    revision.run_id !== request.run_id ||
    revision.rule_id !== request.rule_id ||
    revision.rule_language !== request.rule_language ||
    revision.candidate_id !== request.candidate_id ||
    revision.rule_sha256 !== request.rule_sha256 ||
    revision.rule_content_base64 !== request.rule_content_base64 ||
    !same(revision.fixture_manifest_ref, input.fixtureManifestRef) ||
    !same(request.rule_revision_ref, input.ruleRevisionRef) ||
    fixtures.candidate_id !== request.candidate_id ||
    !same(fixtures.fixture_directory, request.fixture_directory) ||
    fixtures.cases.length !== request.fixtures.length ||
    request.fixtures.some((fixture) => {
      const declared = fixtures.cases.find((entry) => entry.case_class === fixture.case_class);
      return (
        declared === undefined ||
        declared.file_name !== fixture.file_name ||
        !same(declared.fixture_ref, fixture.fixture_ref)
      );
    })
  ) {
    throw new Error("SCA P10 rule validation request binding drift");
  }
  return { request, revision, fixtures };
}

/** Host-only adapter for the declared local Semgrep validation operation. It never consults a model. */
export function createScaP10RuleValidationAdapterV1(input: {
  readonly store: ArtifactHostStore;
  readonly runtime: ScaP10RuleValidationRuntimeConfigV1;
  readonly backend_key_sha256: string;
  readonly run_validation: ScaP10RuleValidationRunnerV1;
}): HostOperationAdapterV1 {
  validateRuntime(input.runtime);
  if (!/^[a-f0-9]{64}$/u.test(input.backend_key_sha256)) {
    throw new Error("SCA P10 rule validation backend key is not a SHA-256 digest");
  }
  return {
    adapter_id: SCA_P10_RULE_VALIDATION_ADAPTER_ID,
    inspectRequest(inspected) {
      const slots = new Set(inspected.input_artifacts.artifacts.map((entry) => entry.slot));
      if (
        inspected.directive.operation_kind !== SCA_P10_RULE_VALIDATION_OPERATION_KIND ||
        inspected.declaration.adapter_id !== SCA_P10_RULE_VALIDATION_ADAPTER_ID ||
        slots.size !== 2 ||
        !slots.has("rule_revision") ||
        !slots.has("fixture_manifest")
      ) {
        throw new Error("SCA P10 rule validation input or declaration drift");
      }
      const ruleRevision = inspected.input_artifacts.artifacts.find(
        (entry) => entry.slot === "rule_revision"
      );
      const fixtureManifest = inspected.input_artifacts.artifacts.find(
        (entry) => entry.slot === "fixture_manifest"
      );
      if (ruleRevision === undefined || fixtureManifest === undefined) {
        throw new Error("SCA P10 rule validation input bindings are absent");
      }
      bindRuleValidation({
        store: input.store,
        requestBytes: inspected.request_bytes,
        ruleRevisionRef: ruleRevision.ref,
        fixtureManifestRef: fixtureManifest.ref,
        runtime: input.runtime,
        backendKeySha256: input.backend_key_sha256,
        directiveBackendKeySha256: inspected.directive.policy_binding.backend_key_sha256,
      });
      return {
        schema_version: 1 as const,
        operation_kind: SCA_P10_RULE_VALIDATION_OPERATION_KIND,
        adapter_id: SCA_P10_RULE_VALIDATION_ADAPTER_ID,
        backend_binding_id: inspected.declaration.backend_binding_id,
        backend_key_sha256: input.backend_key_sha256,
      };
    },
    async run(context: HostOperationExecutionContextV1): Promise<HostOperationAdapterTerminalV1> {
      context.signal.throwIfAborted();
      const revisionInput = context.readInput("rule_revision");
      const fixtureInput = context.readInput("fixture_manifest");
      const bound = bindRuleValidation({
        store: input.store,
        requestBytes: context.request_bytes,
        ruleRevisionRef: revisionInput.ref,
        fixtureManifestRef: fixtureInput.ref,
        runtime: input.runtime,
        backendKeySha256: input.backend_key_sha256,
        directiveBackendKeySha256: context.directive.policy_binding.backend_key_sha256,
      });
      const ruleBytes = Buffer.from(bound.request.rule_content_base64, "base64");
      const materialized = materializeRuleValidation({
        store: input.store,
        request: bound.request,
        ruleBytes,
      });
      let executionFinished = false;
      // Annotation agreement is a self-test only. buildCandidates persists proposer-authored fixture
      // bytes, and this boundary has NO independently approved fixture-truth input. Preserve raw
      // evidence but never return successful qualification for a would-be positive, including cache.
      const dispositionFor = (
        result: ScaP10RuleValidationAdapterResultV1
      ): HostOperationDispositionV1 => {
        const entry = deriveScaP10ValidationEntry({ request: bound.request, result });
        return entry.manifest_complete
          ? failedDisposition("p10_independent_fixture_truth_unverified", true)
          : completedDisposition();
      };
      try {
        const cached = await context.readCachedResult();
        context.signal.throwIfAborted();
        if (cached !== null) {
          const cachedBytes = Buffer.from(cached.bytes);
          const cachedResult = validateScaP10RuleValidationAdapterResultV1(
            decodeCanonical(cachedBytes, "cached rule validation result")
          );
          const disposition = dispositionFor(cachedResult);
          context.signal.throwIfAborted();
          const persisted = context.persist({
            disposition,
            operation_result: {
              contract: SCA_P10_RULE_VALIDATION_DECLARATION.result,
              media_type: "application/json",
              content: cachedBytes,
            },
          });
          context.signal.throwIfAborted();
          return {
            disposition,
            operation_result_ref: persisted.operation_result_ref,
            output_artifacts: persisted.output_artifacts,
          };
        }
        context.signal.throwIfAborted();
        context.beginSubmission();
        context.signal.throwIfAborted();
        const collected = await input.run_validation({
          request: bound.request,
          rule_config_path: materialized.rule_config_path,
          fixture_directory: materialized.fixture_directory,
          cwd: materialized.root,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        executionFinished = true;
        context.signal.throwIfAborted();
        const result = validateScaP10RuleValidationAdapterResultV1(collected);
        for (const child of result.test.collection.children) {
          if (
            child.config_path !== materialized.rule_config_path ||
            child.fixture_path !== path.join(materialized.fixture_directory, child.file_name)
          )
            throw new Error("SCA P10 fresh materialized result binding drift");
        }
        const disposition = dispositionFor(result);
        const bytes = Buffer.from(canonicalJson(result));
        context.signal.throwIfAborted();
        const cachedResult = await context.cacheResult(bytes);
        context.signal.throwIfAborted();
        context.recordFetched({
          schema_version: 1,
          content_sha256: cachedResult.content_sha256,
          byte_length: cachedResult.byte_length,
          item_count: 1,
          poll_count: 1,
        });
        context.signal.throwIfAborted();
        const persisted = context.persist({
          disposition,
          operation_result: {
            contract: SCA_P10_RULE_VALIDATION_DECLARATION.result,
            media_type: "application/json",
            content: bytes,
          },
        });
        context.signal.throwIfAborted();
        return {
          disposition,
          operation_result_ref: persisted.operation_result_ref,
          output_artifacts: persisted.output_artifacts,
        };
      } catch {
        context.signal.throwIfAborted();
        return terminalWithoutArtifacts(
          failedDisposition("p10_validation_runner_failed", executionFinished)
        );
      } finally {
        materialized.cleanup();
      }
    },
  };
}

/**
 * Production composition factory. It validates the runtime config, reproduces the exact declared
 * host operation, derives the local backend key, and binds the declaration, adapter, use-time
 * validator, and adapter map so a caller can install them together.
 */
export function createScaP10RuleValidationProductionHostCompositionV1(input: {
  readonly store: ArtifactHostStore;
  readonly runtime: ScaP10RuleValidationRuntimeConfigV1;
  readonly run_validation: ScaP10RuleValidationRunnerV1;
  readonly declaration?: HostOperationDeclarationV1;
}): ScaP10RuleValidationProductionHostCompositionV1 {
  const runtime = validateRuntime(input.runtime);
  const declaration = validateHostOperationDeclaration(
    input.declaration ?? SCA_P10_RULE_VALIDATION_DECLARATION
  );
  if (!same(declaration, SCA_P10_RULE_VALIDATION_DECLARATION)) {
    throw new Error(
      "SCA P10 rule validation declaration is not the registered host operation shape"
    );
  }
  const backendKey = scaP10RuleValidationBackendKeySha256(runtime);
  const adapter = createScaP10RuleValidationAdapterV1({
    store: input.store,
    runtime,
    backend_key_sha256: backendKey,
    run_validation: input.run_validation,
  });
  const useValidator: HostOperationUseValidatorV1 = {
    validateUse({ directive, declaration: activeDeclaration, request_bytes }) {
      if (
        directive.operation_kind !== SCA_P10_RULE_VALIDATION_OPERATION_KIND ||
        !same(activeDeclaration, declaration)
      ) {
        throw new Error("SCA P10 rule validation use-time declaration drift");
      }
      const ruleRevision = directive.input_artifacts.artifacts.find(
        (entry) => entry.slot === "rule_revision"
      );
      const fixtureManifest = directive.input_artifacts.artifacts.find(
        (entry) => entry.slot === "fixture_manifest"
      );
      if (ruleRevision === undefined || fixtureManifest === undefined) {
        throw new Error("SCA P10 rule validation use-time inputs are absent");
      }
      bindRuleValidation({
        store: input.store,
        requestBytes: request_bytes,
        ruleRevisionRef: ruleRevision.ref,
        fixtureManifestRef: fixtureManifest.ref,
        runtime: input.runtime,
        backendKeySha256: backendKey,
        directiveBackendKeySha256: directive.policy_binding.backend_key_sha256,
      });
    },
  };
  return Object.freeze({
    operation_kind: SCA_P10_RULE_VALIDATION_OPERATION_KIND,
    declaration,
    adapter,
    adapters: new Map([[adapter.adapter_id, adapter]]),
    use_validator: useValidator,
    backend_key_sha256: backendKey,
    runtime,
  });
}

/**
 * Production candidate-registration factory. It projects the composition's exact declaration,
 * backend key, and local runtime, plus the independent current-authority resolvers, into the
 * inactive P10 candidate registration. It never installs the registration into any active registry.
 */
export function createScaP10CandidateProductionRegistrationV1(input: {
  readonly composition: ScaP10RuleValidationProductionHostCompositionV1;
  readonly resolve_current_p07_authority_ref: NonNullable<
    ScaP10CandidateBindingV1["resolve_current_p07_authority_ref"]
  >;
  readonly resolve_current_p01_obligation_head_ref: NonNullable<
    ScaP10CandidateBindingV1["resolve_current_p01_obligation_head_ref"]
  >;
  readonly promotionFault?: ScaP10CandidateBindingV1["promotionFault"];
}): PlaybookRegistration {
  const composition = input.composition;
  if (composition.operation_kind !== SCA_P10_RULE_VALIDATION_OPERATION_KIND) {
    throw new Error("SCA P10 production composition is not the rule validation operation");
  }
  if (
    composition.declaration.adapter_id !== SCA_P10_RULE_VALIDATION_ADAPTER_ID ||
    composition.declaration.backend_binding_id !== SCA_P10_RULE_VALIDATION_BACKEND_ID
  ) {
    throw new Error("SCA P10 production composition declaration binding is invalid");
  }
  const backendKey = scaP10RuleValidationBackendKeySha256(composition.runtime);
  if (backendKey !== composition.backend_key_sha256) {
    throw new Error("SCA P10 production composition backend key is not runtime-derived");
  }
  if (typeof input.resolve_current_p07_authority_ref !== "function") {
    throw new Error("SCA P10 candidate requires an independent current P07 authority resolver");
  }
  if (typeof input.resolve_current_p01_obligation_head_ref !== "function") {
    throw new Error("SCA P10 candidate requires an independent P01 obligation-head resolver");
  }
  const registration = buildScaP10CandidateRegistrationWithBindingV1({
    declaration: composition.declaration,
    backend_key_sha256: composition.backend_key_sha256,
    rule_validation_runtime: composition.runtime,
    resolve_current_p07_authority_ref: input.resolve_current_p07_authority_ref,
    resolve_current_p01_obligation_head_ref: input.resolve_current_p01_obligation_head_ref,
    ...(input.promotionFault === undefined ? {} : { promotionFault: input.promotionFault }),
  });
  if (registration.name !== SCA_P10_CANDIDATE_PLAYBOOK_NAME) {
    throw new Error("SCA P10 production registration name is invalid");
  }
  return registration;
}

/** Exact policy binding for one validation directive, derived from the composition. */
export function scaP10RuleValidationPolicyBinding(
  composition: ScaP10RuleValidationProductionHostCompositionV1
) {
  return hostOperationPolicyBinding(composition.declaration, composition.backend_key_sha256);
}
