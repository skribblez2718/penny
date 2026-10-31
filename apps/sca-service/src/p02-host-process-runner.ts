import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  ScaProcessResultV1Schema,
  type ScaProcessRequestV1,
  type ScaProcessResultV1,
  type ScaProcessRunnerV1,
} from "./process.js";
import {
  P02_HOST_REQUEST_SCHEMA,
  runP02HostCanary,
  validateHostPaths,
  p02HostToolPath,
  verifyP02HostProfileV1,
  type P02HostRequest,
} from "./p02-host-harness.js";

import { SCA_P02_OPERATION_IDS } from "../../orchestration/dist/sca/p02-contracts.js";
import {
  validateScaP01RuleBundleV1,
  validateScaP01SelectedRuleManifestV1,
} from "../../orchestration/dist/sca/p01-policy-contracts.js";
import { selectScaP02ScannerRulesV1 } from "./p02-component-inputs.js";
import { validateScaSourceCustodyMaterializationInputV1 } from "./source-custody-materializer.js";
import { exactPath, overlaps, validTree, verifyTree, type HostTree } from "./p02-host-tree.js";

const issuedRunners = new WeakSet<object>();
function isScannerKind(kind: P02HostRequest["kind"]): kind is P02ControlledProcessRunnerV1["kind"] {
  return kind === "semgrep_php" || kind === "semgrep_js_ts" || kind === "gitleaks";
}
const issuedFactories = new WeakMap<
  object,
  Readonly<{
    staging_parent: string;
    executable: string;
    executable_sha256: string;
    timeout_ms: number;
    max_output_bytes: number;
    allowed: ReadonlySet<string>;
  }>
>();
export function isControlledP02FactoryRunnerV1(
  value: unknown
): value is P02ControlledProcessRunnerV1 {
  return typeof value === "object" && value !== null && issuedFactories.has(value);
}
export function matchesP02HostFactoryRunnerV1(
  value: unknown,
  request: Readonly<{
    operation_kind: "semgrep_php" | "semgrep_js_ts" | "gitleaks";
    staging_parent: string;
    executable: { executable_path: string; executable_sha256: string };
    timeout_ms: number;
    max_output_bytes: number;
    selected_rule_bindings?: readonly { content_sha256: string }[];
    configuration_rule_binding?: { content_sha256: string };
  }>
): boolean {
  if (!isControlledP02FactoryRunnerV1(value)) return false;
  const boundary = issuedFactories.get(value);
  const digests =
    request.operation_kind === "gitleaks"
      ? [request.configuration_rule_binding?.content_sha256]
      : request.selected_rule_bindings?.map((entry) => entry.content_sha256);
  return (
    boundary !== undefined &&
    value.kind === request.operation_kind &&
    boundary.staging_parent === request.staging_parent &&
    boundary.executable === request.executable.executable_path &&
    boundary.executable_sha256 === request.executable.executable_sha256 &&
    boundary.timeout_ms === request.timeout_ms &&
    request.max_output_bytes >= 4096 &&
    request.max_output_bytes <= boundary.max_output_bytes &&
    digests !== undefined &&
    digests.length > 0 &&
    digests.every((digest) => digest !== undefined && boundary.allowed.has(digest))
  );
}
export function isControlledP02RunnerV1(value: unknown): value is P02ControlledProcessRunnerV1 {
  return typeof value === "object" && value !== null && issuedRunners.has(value);
}

export interface P02ControlledProcessRunnerV1 extends ScaProcessRunnerV1 {
  readonly qualification: "controlled_p02_scanners_only";
  readonly kind: "semgrep_php" | "semgrep_js_ts" | "gitleaks";
  readonly profile_sha256: string;
  readonly deployment_sha256: string;
}

/** Caller pins the full plan, including the exact source tree. No executable or mount is selected from adapter argv. */
export function createP02HostProcessRunnerV1(
  planValue: unknown,
  scratchRoot: string
): P02ControlledProcessRunnerV1 {
  const parsed = validateContract(
    P02_HOST_REQUEST_SCHEMA,
    planValue,
    "P02 controlled process plan"
  );
  const plan = validateContract(
    P02_HOST_REQUEST_SCHEMA,
    JSON.parse(canonicalJson(parsed)),
    "P02 immutable process plan"
  );
  validateHostPaths(plan);
  if (
    !path.isAbsolute(scratchRoot) ||
    scratchRoot.includes("..") ||
    scratchRoot === plan.source.root
  )
    throw Error("p02_scratch_path");
  if (
    !isScannerKind(plan.kind) ||
    (plan.kind === "gitleaks" && plan.tool_runtime.kind !== "static") ||
    (plan.kind !== "gitleaks" && plan.tool_runtime.kind !== "sealed")
  )
    throw Error("p02_scanner_kind");
  const tool = p02HostToolPath(plan.tool_runtime);
  const runner: P02ControlledProcessRunnerV1 = Object.freeze({
    qualification: "controlled_p02_scanners_only" as const,
    kind: plan.kind,
    profile_sha256: plan.profile_sha256,
    deployment_sha256: plan.deployment.sha256,
    async run(request: ScaProcessRequestV1, signal?: AbortSignal): Promise<ScaProcessResultV1> {
      const expectedArguments =
        plan.kind === "gitleaks"
          ? [
              "dir",
              ".",
              "--config",
              request.cwd === plan.source.root ? "/input/rule" : "",
              "--no-banner",
              "--redact",
              "--report-format",
              "json",
              "--report-path",
              "-",
              "--exit-code",
              "1",
            ]
          : [
              "scan",
              "--json",
              "--error",
              "--metrics=off",
              "--disable-version-check",
              "--no-git-ignore",
              "--x-ignore-semgrepignore-files",
              "--no-rewrite-rule-ids",
              "--config",
              "/input/rule",
              "--",
              ".",
            ];
      const originalArguments = [...expectedArguments];
      originalArguments[originalArguments.indexOf("/input/rule")] =
        request.arguments[request.arguments.indexOf("--config") + 1] ?? "";
      const expectedEnv =
        plan.kind === "gitleaks"
          ? [{ name: "HOME", value: "/nonexistent" }]
          : [
              { name: "HOME", value: scratchRoot },
              { name: "PATH", value: "/usr/bin:/bin" },
              { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
              { name: "SEMGREP_SEND_METRICS", value: "off" },
            ];
      const rulePath = request.arguments[request.arguments.indexOf("--config") + 1];
      let ruleStable = false;
      if (request.executable !== tool.path || request.executable_sha256 !== tool.sha256)
        throw Error("p02_process_plan_mismatch");
      if (rulePath === plan.rule.path) {
        const fd = await open(rulePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await fd.stat();
          if (info.isFile() && info.nlink === 1 && info.size <= 16_777_216)
            ruleStable = sha256(await fd.readFile()) === plan.rule.sha256;
        } finally {
          await fd.close();
        }
      }
      if (
        rulePath === undefined ||
        !path.isAbsolute(rulePath) ||
        request.cwd !== plan.source.root ||
        request.executable !== tool.path ||
        request.executable_sha256 !== tool.sha256 ||
        canonicalJson(request.arguments) !== canonicalJson(originalArguments) ||
        canonicalJson(request.environment) !== canonicalJson(expectedEnv) ||
        request.timeout_ms !== plan.limits.runtime_ms - 500 ||
        request.max_stdout_bytes > 4096 ||
        request.max_stderr_bytes > 4096 ||
        plan.limits.output_bytes < 65536 ||
        !ruleStable
      )
        throw Error("p02_process_plan_mismatch");
      const outcome = await runP02HostCanary(plan, signal);
      if (
        outcome.status !== "passed" ||
        outcome.receipt?.process === null ||
        outcome.receipt?.process === undefined
      )
        throw Error(`p02_process_${outcome.status}`);
      const process = validateContract(
        ScaProcessResultV1Schema,
        outcome.receipt.process,
        "P02 process receipt"
      );
      if (
        process.request_sha256 !==
        sha256(
          canonicalJson({
            plan_sha256: sha256(canonicalJson(plan)),
            nonce: outcome.receipt.nonce,
            kind: plan.kind,
          })
        )
      )
        throw Error("p02_process_receipt_mismatch");
      // Adapter invocation binding must describe the original component request, not the sandbox paths.
      return { ...process, request_sha256: sha256(canonicalJson(request)) };
    },
  });
  issuedRunners.add(runner);
  return runner;
}

/** P01 custody is the authority for files. The on-disk walk only verifies this descriptor. */
export function deriveP02HostSourceManifestV1(value: unknown): Readonly<{
  files: HostTree["files"];
  total_bytes: number;
  tree_sha256: string;
  source_generation: NonNullable<P02HostRequest["source_generation"]>;
}> {
  const input = validateScaSourceCustodyMaterializationInputV1(value);
  const files = input.file_manifest.files.map((file) => ({
    path: file.path,
    bytes: file.byte_count,
    sha256: file.content_sha256,
  }));
  const result = {
    files,
    total_bytes: input.file_manifest.byte_count,
    tree_sha256: sha256(canonicalJson(files)),
    source_generation: {
      file_manifest_sha256: input.file_manifest_sha256,
      custody_sha256: input.custody_sha256,
    },
  };
  validTree({
    files,
    total_bytes: result.total_bytes,
    tree_sha256: result.tree_sha256,
    root: "/p02-admitted-source",
  });
  return result;
}

export function deriveP02HostRuleDigestsV1(
  bundleValue: unknown,
  selectionValue: unknown,
  kind: "semgrep_php" | "semgrep_js_ts" | "gitleaks",
  excludedRuleIds: readonly string[] = [],
  configRuleId?: string
): readonly string[] {
  const bundle = validateScaP01RuleBundleV1(bundleValue);
  const selected = validateScaP01SelectedRuleManifestV1(selectionValue);
  if (kind === "gitleaks" && configRuleId === undefined) throw Error("p02_factory_rules");
  const rules = selectScaP02ScannerRulesV1({
    rules: bundle.rules,
    selected_rule_ids: selected.selected_rule_ids,
    languages: kind === "semgrep_php" ? ["php"] : ["javascript", "typescript"],
    ...(kind === "gitleaks" && configRuleId !== undefined
      ? { one_rule_id: configRuleId }
      : { excluded_rule_ids: excludedRuleIds }),
  });
  if (rules.length === 0 || (kind === "gitleaks" && rules.length !== 1))
    throw Error("p02_factory_rules");
  return rules.map((rule) => rule.content_sha256);
}

export type P02HostProcessRunnerFactoryConfigV1 = Omit<
  P02HostRequest,
  "source" | "rule" | "source_generation" | "kind"
> &
  Readonly<{
    kind: "semgrep_php" | "semgrep_js_ts" | "gitleaks";
    staging_parent: string;
    source_material: unknown;
    allowed_rule_sha256: readonly string[];
  }>;

/** One issued capability per operation kind/profile; no adapter can amend the harness closure. */
export function createP02HostProcessRunnerFactoryV1(
  value: P02HostProcessRunnerFactoryConfigV1
): P02ControlledProcessRunnerV1 {
  const config = validateContract(
    Type.Object(
      {
        ...Type.Omit(P02_HOST_REQUEST_SCHEMA, ["source", "rule", "source_generation"]).properties,
        staging_parent: Type.String(),
        source_material: Type.Unknown(),
        allowed_rule_sha256: Type.Array(Type.String()),
      },
      { additionalProperties: false }
    ),
    JSON.parse(canonicalJson(value)),
    "P02 scanner factory configuration"
  );
  const keys = [
    "kind",
    "tool_runtime",
    "runtime",
    "closure",
    "deployment",
    "controls",
    "profile_sha256",
    "workspace_parent",
    "protected_roots",
    "limits",
    "staging_parent",
    "source_material",
    "allowed_rule_sha256",
  ];
  if (canonicalJson(Object.keys(config).sort()) !== canonicalJson(keys.sort()))
    throw Error("p02_factory_configuration");
  const { source_material, allowed_rule_sha256, staging_parent, ...base } = config;
  const { source_generation, ...sourceFiles } = deriveP02HostSourceManifestV1(source_material);
  if (
    !exactPath(staging_parent) ||
    staging_parent === "/" ||
    !isScannerKind(base.kind) ||
    !exactPath(base.workspace_parent) ||
    overlaps(staging_parent, base.workspace_parent) ||
    allowed_rule_sha256.length === 0 ||
    (base.kind === "gitleaks" && allowed_rule_sha256.length !== 1) ||
    allowed_rule_sha256.length > 1_000_000 ||
    allowed_rule_sha256.some((digest) => !/^[a-f0-9]{64}$/.test(digest))
  )
    throw Error("p02_factory_configuration");
  const permitted = new Set(allowed_rule_sha256);
  const operationId = SCA_P02_OPERATION_IDS[base.kind];
  const sampleSource = path.join(staging_parent, `${operationId}-source-${"a".repeat(16)}`);
  const sampleRule = path.join(
    staging_parent,
    `${operationId}-aux-${"a".repeat(16)}`,
    base.kind === "gitleaks" ? "gitleaks.toml" : "config/rule-000000.yaml"
  );
  const makePlan = (sourceRoot: string, rulePath: string, ruleHash: string): P02HostRequest =>
    validateContract(
      P02_HOST_REQUEST_SCHEMA,
      {
        ...base,
        source: { ...sourceFiles, root: sourceRoot },
        source_generation,
        rule: { path: rulePath, sha256: ruleHash },
      },
      "P02 factory plan"
    );
  // Strip the custody marker metadata from the source tree descriptor, not from verification.
  const firstRule = allowed_rule_sha256[0];
  if (firstRule === undefined) throw Error("p02_factory_rules");
  const sample = makePlan(sampleSource, sampleRule, firstRule);
  validateHostPaths(sample);
  if ((base.kind === "gitleaks") !== (base.tool_runtime.kind === "static"))
    throw Error("p02_scanner_kind");
  const tool = p02HostToolPath(base.tool_runtime);
  // The adapter's measured executable is the original path reproduced at mount_root,
  // not the private host copy used as the sealed bind source.
  const hostExecutable = tool.path;
  const runner: P02ControlledProcessRunnerV1 = Object.freeze({
    qualification: "controlled_p02_scanners_only" as const,
    kind: base.kind,
    profile_sha256: base.profile_sha256,
    deployment_sha256: base.deployment.sha256,
    async run(request: ScaProcessRequestV1, signal?: AbortSignal): Promise<ScaProcessResultV1> {
      const suffix = /^([a-f0-9]{16})$/;
      const prefix = `${operationId}-source-`;
      const requestId =
        request.cwd.startsWith(path.join(staging_parent, prefix)) &&
        path.dirname(request.cwd) === staging_parent
          ? request.cwd.slice(path.join(staging_parent, prefix).length)
          : "";
      if (!exactPath(request.cwd) || !suffix.test(requestId))
        throw Error("p02_process_plan_mismatch");
      const aux = path.join(staging_parent, `${operationId}-aux-${requestId}`);
      const slot = base.kind === "gitleaks" ? 3 : 9;
      const rulePath = request.arguments[slot];
      const ruleIndex =
        base.kind === "gitleaks"
          ? ""
          : rulePath?.slice(path.join(aux, "config", "rule-").length, -5);
      const expectedRule =
        base.kind === "gitleaks"
          ? path.join(aux, "gitleaks.toml")
          : path.join(aux, "config", `rule-${ruleIndex ?? ""}.yaml`);
      if (
        rulePath === undefined ||
        !exactPath(rulePath) ||
        rulePath !== expectedRule ||
        (base.kind !== "gitleaks" && !/^\d{6}$/.test(ruleIndex ?? "")) ||
        !path.relative(staging_parent, rulePath) ||
        overlaps(request.cwd, rulePath) ||
        overlaps(rulePath, base.workspace_parent) ||
        request.executable !== hostExecutable ||
        request.executable_sha256 !== tool.sha256
      )
        throw Error("p02_process_plan_mismatch");
      const args =
        base.kind === "gitleaks"
          ? [
              "dir",
              ".",
              "--config",
              rulePath,
              "--no-banner",
              "--redact",
              "--report-format",
              "json",
              "--report-path",
              "-",
              "--exit-code",
              "1",
            ]
          : [
              "scan",
              "--json",
              "--error",
              "--metrics=off",
              "--disable-version-check",
              "--no-git-ignore",
              "--x-ignore-semgrepignore-files",
              "--no-rewrite-rule-ids",
              "--config",
              rulePath,
              "--",
              ".",
            ];
      const env =
        base.kind === "gitleaks"
          ? [{ name: "HOME", value: "/nonexistent" }]
          : [
              { name: "HOME", value: path.join(aux, "scratch") },
              { name: "PATH", value: "/usr/bin:/bin" },
              { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
              { name: "SEMGREP_SEND_METRICS", value: "off" },
            ];
      if (
        canonicalJson(request.arguments) !== canonicalJson(args) ||
        canonicalJson(request.environment) !== canonicalJson(env) ||
        request.timeout_ms !== base.limits.runtime_ms - 500 ||
        request.max_stdout_bytes < 4096 ||
        request.max_stdout_bytes > base.limits.output_bytes ||
        request.max_stderr_bytes !== request.max_stdout_bytes
      )
        throw Error("p02_process_plan_mismatch");
      const parent = await lstat(staging_parent);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        parent.uid !== process.getuid?.() ||
        (parent.mode & 0o777) !== 0o700 ||
        (await realpath(staging_parent)) !== staging_parent
      )
        throw Error("p02_process_staging_parent");
      const auxInfo = await lstat(aux);
      const ruleParent = await lstat(path.dirname(rulePath));
      if (
        !auxInfo.isDirectory() ||
        auxInfo.isSymbolicLink() ||
        auxInfo.uid !== process.getuid?.() ||
        (auxInfo.mode & 0o077) !== 0 ||
        !ruleParent.isDirectory() ||
        ruleParent.isSymbolicLink() ||
        ruleParent.uid !== process.getuid?.() ||
        (ruleParent.mode & 0o022) !== 0 ||
        (await realpath(aux)) !== aux ||
        (await realpath(path.dirname(rulePath))) !== path.dirname(rulePath)
      )
        throw Error("p02_process_rule_parent");
      const fd = await open(rulePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let digest: string;
      try {
        const before = await fd.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.uid !== process.getuid?.() ||
          before.size < 1 ||
          before.size > 16_777_216 ||
          (before.mode & 0o022) !== 0
        )
          throw Error("p02_process_rule");
        digest = sha256(await fd.readFile());
        const after = await fd.stat();
        if (
          before.ino !== after.ino ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          (await lstat(rulePath)).ino !== before.ino
        )
          throw Error("p02_process_rule");
      } finally {
        await fd.close();
      }
      if (!permitted.has(digest)) throw Error("p02_process_rule_unlisted");
      const plan = makePlan(request.cwd, rulePath, digest);
      validateHostPaths(plan);
      await verifyTree(plan.source, plan.source_generation);
      await verifyP02HostProfileV1(plan);
      const outcome = await runP02HostCanary(plan, signal);
      if (
        outcome.status !== "passed" ||
        outcome.receipt?.process == null ||
        outcome.receipt.plan_sha256 !== sha256(canonicalJson(plan))
      )
        throw Error(`p02_process_${outcome.status}`);
      const result = validateContract(
        ScaProcessResultV1Schema,
        outcome.receipt.process,
        "P02 process receipt"
      );
      if (
        result.request_sha256 !==
        sha256(
          canonicalJson({
            plan_sha256: outcome.receipt.plan_sha256,
            nonce: outcome.receipt.nonce,
            kind: base.kind,
          })
        )
      )
        throw Error("p02_process_receipt_mismatch");
      return { ...result, request_sha256: sha256(canonicalJson(request)) };
    },
  });
  issuedRunners.add(runner);
  issuedFactories.set(
    runner,
    Object.freeze({
      staging_parent,
      executable: hostExecutable,
      executable_sha256: tool.sha256,
      timeout_ms: base.limits.runtime_ms - 500,
      max_output_bytes: base.limits.output_bytes,
      allowed: permitted,
    })
  );
  return runner;
}
