#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "@penny/orchestration/source";

import {
  REMOTE_CALIBRATION_LIVE_ENV,
  runRemoteC6CalibrationSequenceV1,
  type EvaluationRemoteCalibrationResultV1,
  type RemoteCalibrationPreflightV1,
} from "./evaluation-remote-calibration.js";
import {
  evaluationLiveCalibrationApprovalReceiptSha256,
  type EvaluationOperatorApprovalVerifierV1,
} from "./evaluation-semantic-review.js";

const MAX_JSON_BYTES = 1_048_576;
const FLAGS = new Set([
  "--project-root",
  "--decide-package",
  "--decide-manifest",
  "--decide-approval",
  "--decide-confirm-package-sha256",
  "--decide-confirm-max-spend-microusd",
  "--plan-package",
  "--plan-manifest",
  "--plan-approval",
  "--plan-confirm-package-sha256",
  "--plan-confirm-max-spend-microusd",
  "--owner-verifier-module",
]);

interface CliOptionsV1 {
  readonly projectRoot: string;
  readonly decidePackage: string;
  readonly decideManifest: string;
  readonly decideApproval: string;
  readonly decideConfirmedPackageSha256: string;
  readonly decideConfirmedMaxSpendMicrousd: number;
  readonly planPackage: string;
  readonly planManifest: string;
  readonly planApproval: string;
  readonly planConfirmedPackageSha256: string;
  readonly planConfirmedMaxSpendMicrousd: number;
  readonly verifierModule: string;
  readonly preflightOnly: boolean;
}

function usage(): never {
  throw new Error(
    [
      "Usage: evaluation-remote-calibration-cli",
      "  --project-root <absolute-path>",
      "  --decide-package <project-relative-path>",
      "  --decide-manifest <path> --decide-approval <path>",
      "  --decide-confirm-package-sha256 <sha256>",
      "  --decide-confirm-max-spend-microusd <integer>",
      "  --plan-package <project-relative-path>",
      "  --plan-manifest <path> --plan-approval <path>",
      "  --plan-confirm-package-sha256 <sha256>",
      "  --plan-confirm-max-spend-microusd <integer>",
      "  --owner-verifier-module <path>",
      "  (--preflight-only | --execute-live)",
    ].join("\n")
  );
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) usage();
  return value;
}

function exactSha256(value: string, flag: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${flag} must be one lowercase SHA-256`);
  return value;
}

function boundedInteger(value: string, flag: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

export function parseRemoteCalibrationCliArgs(argv: readonly string[]): CliOptionsV1 {
  const values = new Map<string, string>();
  let preflightOnly = false;
  let executeLive = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--preflight-only") {
      if (preflightOnly) usage();
      preflightOnly = true;
      continue;
    }
    if (token === "--execute-live") {
      if (executeLive) usage();
      executeLive = true;
      continue;
    }
    if (!FLAGS.has(token)) usage();
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || values.has(token)) usage();
    values.set(token, value);
    index += 1;
  }
  if (preflightOnly === executeLive) usage();
  const projectRoot = required(values, "--project-root");
  if (!path.isAbsolute(projectRoot) || realpathSync(projectRoot) !== path.resolve(projectRoot)) {
    throw new Error("--project-root must be an existing canonical absolute path");
  }
  return {
    projectRoot,
    decidePackage: required(values, "--decide-package"),
    decideManifest: required(values, "--decide-manifest"),
    decideApproval: required(values, "--decide-approval"),
    decideConfirmedPackageSha256: exactSha256(
      required(values, "--decide-confirm-package-sha256"),
      "--decide-confirm-package-sha256"
    ),
    decideConfirmedMaxSpendMicrousd: boundedInteger(
      required(values, "--decide-confirm-max-spend-microusd"),
      "--decide-confirm-max-spend-microusd"
    ),
    planPackage: required(values, "--plan-package"),
    planManifest: required(values, "--plan-manifest"),
    planApproval: required(values, "--plan-approval"),
    planConfirmedPackageSha256: exactSha256(
      required(values, "--plan-confirm-package-sha256"),
      "--plan-confirm-package-sha256"
    ),
    planConfirmedMaxSpendMicrousd: boundedInteger(
      required(values, "--plan-confirm-max-spend-microusd"),
      "--plan-confirm-max-spend-microusd"
    ),
    verifierModule: required(values, "--owner-verifier-module"),
    preflightOnly,
  };
}

function checkedRegularPath(filePath: string, label: string): string {
  const absolute = path.resolve(filePath);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} path contains a symlink`);
  }
  const resolved = realpathSync(absolute);
  if (!lstatSync(resolved).isFile()) throw new Error(`${label} is not a regular file`);
  return resolved;
}

function checkedJson(filePath: string): unknown {
  const resolved = checkedRegularPath(filePath, "remote calibration input");
  const stats = lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_JSON_BYTES) {
    throw new Error("remote calibration input must be one bounded regular JSON file");
  }
  const before = { dev: stats.dev, ino: stats.ino, size: stats.size };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (cause) {
    throw new Error("remote calibration input is not JSON", { cause });
  }
  const after = lstatSync(resolved);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new Error("remote calibration input changed while reading");
  }
  return parsed;
}

function resolveCallerPath(projectRoot: string, supplied: string): string {
  return path.isAbsolute(supplied) ? supplied : path.resolve(projectRoot, supplied);
}

function isOwnerVerifier(value: unknown): value is EvaluationOperatorApprovalVerifierV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    "verify" in value &&
    typeof value.verify === "function"
  );
}

async function loadOwnerVerifier(
  projectRoot: string,
  modulePath: string
): Promise<EvaluationOperatorApprovalVerifierV1> {
  const resolved = checkedRegularPath(
    resolveCallerPath(projectRoot, modulePath),
    "owner verifier module"
  );
  const imported: unknown = await import(pathToFileURL(resolved).href);
  if (imported === null || typeof imported !== "object") {
    throw new Error("owner verifier module has no exports");
  }
  const verifier =
    "ownerVerifier" in imported
      ? imported.ownerVerifier
      : "default" in imported
        ? imported.default
        : undefined;
  if (!isOwnerVerifier(verifier)) {
    throw new Error("owner verifier module must export ownerVerifier or default with verify()");
  }
  return verifier;
}

function preflightSummary(value: RemoteCalibrationPreflightV1): Readonly<Record<string, unknown>> {
  return {
    skill: value.loaded.package.skill,
    package_id: value.loaded.package.package_id,
    package_sha256: value.loaded.package.package_sha256,
    schedule_sha256: value.loaded.scheduleSha256,
    authorization_manifest_sha256: value.approval.manifest_sha256,
    approval_receipt_sha256: evaluationLiveCalibrationApprovalReceiptSha256(value.approval),
    runtime_binding_sha256: value.runtimeBindingSha256,
    scheduled_trials:
      value.loaded.schedule.accounting.scheduled_task_arm_pair_count *
      value.manifest.limits.repetitions,
    provider_calls: 0,
  };
}

function executionSummary(
  value: EvaluationRemoteCalibrationResultV1,
  skill: "decide" | "plan"
): Readonly<Record<string, unknown>> {
  return {
    skill,
    package_id: value.package_id,
    package_sha256: value.package_sha256,
    schedule_sha256: value.schedule_sha256,
    authorization_manifest_sha256: value.authorization_manifest_sha256,
    approval_receipt_sha256: value.approval_receipt_sha256,
    runtime_binding_sha256: value.runtime_binding_sha256,
    result_sha256: value.result_sha256,
    accounting: value.accounting,
  };
}

export async function runRemoteCalibrationCli(argv: readonly string[]): Promise<void> {
  const options = parseRemoteCalibrationCliArgs(argv);
  const verifier = await loadOwnerVerifier(options.projectRoot, options.verifierModule);
  const decideManifest = checkedJson(
    resolveCallerPath(options.projectRoot, options.decideManifest)
  );
  const decideApproval = checkedJson(
    resolveCallerPath(options.projectRoot, options.decideApproval)
  );
  const planManifest = checkedJson(resolveCallerPath(options.projectRoot, options.planManifest));
  const planApproval = checkedJson(resolveCallerPath(options.projectRoot, options.planApproval));
  const outcome = await runRemoteC6CalibrationSequenceV1({
    projectRoot: options.projectRoot,
    decide: {
      packagePath: options.decidePackage,
      manifest: decideManifest,
      approval: decideApproval,
      confirmedPackageSha256: options.decideConfirmedPackageSha256,
      confirmedMaxSpendMicrousd: options.decideConfirmedMaxSpendMicrousd,
    },
    plan: {
      packagePath: options.planPackage,
      manifest: planManifest,
      approval: planApproval,
      confirmedPackageSha256: options.planConfirmedPackageSha256,
      confirmedMaxSpendMicrousd: options.planConfirmedMaxSpendMicrousd,
    },
    ownerVerifier: verifier,
    preflightOnly: options.preflightOnly,
    env: process.env,
  });
  const preflightOnly = outcome.status === "PREFLIGHT_PASSED";
  const summaries =
    outcome.status === "PREFLIGHT_PASSED"
      ? {
          decide: preflightSummary(outcome.decide),
          plan: preflightSummary(outcome.plan),
        }
      : {
          decide: executionSummary(outcome.decide, "decide"),
          plan: executionSummary(outcome.plan, "plan"),
        };
  const report = {
    schema_id: "penny.evaluation-remote-calibration-cli-report.v1",
    schema_version: 1,
    status: outcome.status,
    order: ["decide", "plan"],
    split: "calibration",
    scoring: "non_scoring",
    live_gate: preflightOnly ? "not_requested" : REMOTE_CALIBRATION_LIVE_ENV,
    decide: summaries.decide,
    plan: summaries.plan,
  };
  process.stdout.write(`${canonicalJson(report)}\n`);
}

if (import.meta.main) {
  runRemoteCalibrationCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown remote calibration failure";
    process.stderr.write(`remote calibration failed: ${message}\n`);
    process.exitCode = 1;
  });
}
