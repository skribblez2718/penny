import console from "node:console";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(
  packageRoot,
  "tests",
  "fixtures",
  "provider-free-skill-conformance.v1.json"
);
const vitestPath = path.join(packageRoot, "node_modules", "vitest", "vitest.mjs");
const skillExtensionRoot = path.resolve(packageRoot, "..", "..", ".pi", "extensions", "skill");
const networkGuardPath = path.join(packageRoot, "tests", "helpers", "deny-network.mjs");
const runRoot = mkdtempSync(path.join(tmpdir(), "penny-skill-conformance-"));
const isolatedHome = path.join(runRoot, "home");
mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });

const safeEnvironment = {
  PATH: process.env.PATH ?? "",
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
  XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
  TMPDIR: runRoot,
  TEMP: runRoot,
  TMP: runRoot,
  NODE_ENV: "test",
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  PENNY_PROVIDER_ACCESS: "forbidden",
};

function loadJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function bounded(value) {
  return typeof value === "string" ? value.slice(0, 8_192) : "";
}

function runVitest(label, files, options = {}) {
  const cwd = options.cwd ?? packageRoot;
  const config = options.config ?? "vitest.config.ts";
  const outputFile = path.join(runRoot, `${label}.json`);
  const networkAccessLog = path.join(runRoot, `${label}.network-attempts.log`);
  const child = spawnSync(
    process.execPath,
    [
      vitestPath,
      "run",
      "--config",
      config,
      ...files,
      "--reporter=json",
      "--outputFile",
      outputFile,
    ],
    {
      cwd,
      env: {
        ...safeEnvironment,
        NODE_OPTIONS: `--import=${pathToFileURL(networkGuardPath).href}`,
        PENNY_PROVIDER_ACCESS_LOG: networkAccessLog,
      },
      encoding: "utf8",
      maxBuffer: 32 * 1_024 * 1_024,
    }
  );
  let report;
  try {
    report = loadJson(outputFile, `${label} Vitest report`);
  } catch {
    report = undefined;
  }
  let forbiddenNetworkAttempts = [];
  try {
    forbiddenNetworkAttempts = readFileSync(networkAccessLog, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    // The guard creates the log only when an outbound network surface is invoked.
  }
  return {
    exit_code: child.status,
    signal: child.signal,
    spawn_error: child.error?.message,
    forbidden_network_attempts: forbiddenNetworkAttempts,
    stdout: bounded(child.stdout),
    stderr: bounded(child.stderr),
    report,
    cwd,
  };
}

function assertionsByBinding(execution) {
  const report = execution.report;
  const assertions = new Map();
  if (report === undefined || !Array.isArray(report.testResults)) return assertions;
  for (const fileResult of report.testResults) {
    if (typeof fileResult?.name !== "string" || !Array.isArray(fileResult.assertionResults)) {
      continue;
    }
    const file = path.relative(execution.cwd, fileResult.name).split(path.sep).join("/");
    for (const assertion of fileResult.assertionResults) {
      if (typeof assertion?.fullName !== "string") continue;
      assertions.set(`${file}\u0000${assertion.fullName}`, assertion);
    }
  }
  return assertions;
}

function statusForAssertion(assertion) {
  if (assertion === undefined) return "ERROR";
  if (assertion.status === "passed") return "PASS";
  if (assertion.status === "failed") return "FAIL";
  return "ERROR";
}

function executionStatus(execution) {
  if (execution.report === undefined || execution.spawn_error !== undefined) return "ERROR";
  if (
    execution.report.success !== true ||
    execution.exit_code !== 0 ||
    execution.forbidden_network_attempts.length > 0
  ) {
    return "FAIL";
  }
  return "PASS";
}

function aggregateStatus(statuses) {
  if (statuses.includes("ERROR")) return "ERROR";
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("NOT_RUN")) return "NOT_RUN";
  return "PASS";
}

const result = {
  schema_id: "penny.provider-free-skill-conformance-result.v1",
  schema_version: 1,
  claim_scope: "engine_and_contract_conformance_only",
  provider_execution: "deterministic_stubs_only",
  guarded_network_attempts: 0,
  credential_environment_inherited: false,
  status: "ERROR",
  tiers: [],
  limitations: [
    "Deterministic conformance does not prove semantic quality or real-world usefulness.",
    "It does not establish superiority over a direct agent or authorize candidate promotion.",
    "Network evidence covers guarded in-process Node transports; it is not an operating-system network sandbox.",
  ],
};

let manifest;
let manifestError;
try {
  manifest = loadJson(manifestPath, "provider-free conformance manifest");
} catch (error) {
  manifestError = error instanceof Error ? error.message : String(error);
}
if (manifest === undefined) {
  result.tiers.push({
    tier: 0,
    name: "profile_preflight",
    status: "ERROR",
    error: manifestError ?? "provider-free conformance manifest is unavailable",
    checks: [],
  });
  const reportPath = path.join(runRoot, "result.json");
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.error(`Provider-free skill conformance: ERROR\nReport: ${reportPath}`);
  process.exitCode = 1;
} else {
  const profiles = Array.isArray(manifest.profiles) ? manifest.profiles : [];
  const allChecks = profiles.flatMap((profile) =>
    Array.isArray(profile.checks)
      ? profile.checks.map((check) => ({ ...check, skill_name: profile.skill_name }))
      : []
  );
  const entrypointChecks = Array.isArray(manifest.entrypoint_checks)
    ? manifest.entrypoint_checks
    : [];
  const preflightExecution = runVitest("tier-0-profile-preflight", [
    "tests/provider-free-skill-conformance.test.ts",
  ]);
  const preflightStatus = executionStatus(preflightExecution);
  result.tiers.push({
    tier: 0,
    name: "profile_preflight",
    status: preflightStatus,
    checks: [
      {
        check_id: "registry-profile-integrity",
        category: "profile_integrity",
        status: preflightStatus,
      },
    ],
    ...(preflightStatus === "PASS" ? {} : { execution: preflightExecution }),
  });

  let blocked = preflightStatus !== "PASS";
  for (const [tier, name] of [
    [1, "deterministic_contract"],
    [2, "orchestrated_real_path"],
  ]) {
    const tierChecks = allChecks.filter((check) => check.tier === tier);
    if (blocked) {
      result.tiers.push({
        tier,
        name,
        status: "NOT_RUN",
        checks: [
          ...tierChecks.map((check) => ({
            check_id: check.check_id,
            skill_name: check.skill_name,
            category: check.category,
            status: "NOT_RUN",
          })),
          ...(tier === 2
            ? entrypointChecks.map((check) => ({
                check_id: check.check_id,
                registration_scope: check.registration_scope,
                category: "extension_entrypoint",
                status: "NOT_RUN",
              }))
            : []),
        ],
      });
      continue;
    }

    const files = [...new Set(tierChecks.map((check) => check.test_file))].sort();
    const execution = runVitest(`tier-${tier}-${name}`, files);
    const assertions = assertionsByBinding(execution);
    const profileChecks = tierChecks.map((check) => {
      const assertion = assertions.get(`${check.test_file}\u0000${check.full_name}`);
      const status = statusForAssertion(assertion);
      return {
        check_id: check.check_id,
        skill_name: check.skill_name,
        category: check.category,
        status,
        evidence: { test_file: check.test_file, full_name: check.full_name },
        ...(status === "ERROR" && assertion === undefined
          ? { error: "declared test assertion was not observed" }
          : {}),
        ...(status === "FAIL" ? { failure_messages: assertion.failureMessages ?? [] } : {}),
      };
    });
    const extensionExecutions = new Map();
    if (tier === 2) {
      for (const testConfig of ["unit", "integration", "e2e"]) {
        const configured = entrypointChecks.filter((check) => check.test_config === testConfig);
        if (configured.length === 0) continue;
        extensionExecutions.set(
          testConfig,
          runVitest(
            `tier-2-skill-extension-${testConfig}`,
            [...new Set(configured.map((check) => check.test_file))].sort(),
            {
              cwd: skillExtensionRoot,
              config: `tests/vitest${testConfig === "unit" ? "" : `.${testConfig}`}.config.ts`,
            }
          )
        );
      }
    }
    const extensionChecks =
      tier === 2
        ? entrypointChecks.map((check) => {
            const extensionExecution = extensionExecutions.get(check.test_config);
            const assertion = assertionsByBinding(extensionExecution).get(
              `${check.test_file}\u0000${check.full_name}`
            );
            const status = statusForAssertion(assertion);
            return {
              check_id: check.check_id,
              registration_scope: check.registration_scope,
              category: "extension_entrypoint",
              status,
              evidence: {
                test_config: check.test_config,
                test_file: check.test_file,
                full_name: check.full_name,
              },
              ...(status === "ERROR" && assertion === undefined
                ? { error: "declared extension assertion was not observed" }
                : {}),
              ...(status === "FAIL" ? { failure_messages: assertion.failureMessages ?? [] } : {}),
            };
          })
        : [];
    const checks = [...profileChecks, ...extensionChecks];
    const executions = [execution, ...extensionExecutions.values()];
    const tierStatus = aggregateStatus([
      ...checks.map((check) => check.status),
      ...executions.map(executionStatus),
    ]);
    result.tiers.push({
      tier,
      name,
      status: tierStatus,
      checks,
      ...(tierStatus === "PASS"
        ? {}
        : {
            executions: executions.filter(
              (candidateExecution) => executionStatus(candidateExecution) !== "PASS"
            ),
          }),
    });
    blocked = tierStatus !== "PASS";
  }

  result.guarded_network_attempts = result.tiers.reduce(
    (count, tier) =>
      count +
      (tier.execution?.forbidden_network_attempts?.length ?? 0) +
      (tier.executions ?? []).reduce(
        (executionCount, execution) =>
          executionCount + (execution.forbidden_network_attempts?.length ?? 0),
        0
      ),
    0
  );
  result.status = aggregateStatus(result.tiers.map((tier) => tier.status));
  const reportPath = path.join(runRoot, "result.json");
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

  console.log("Provider-free skill conformance");
  for (const tier of result.tiers) {
    console.log(`  Tier ${tier.tier} ${tier.name}: ${tier.status}`);
    for (const check of tier.checks.filter((item) => item.status !== "PASS")) {
      console.log(
        `    ${check.status} ${check.skill_name === undefined ? "" : `${check.skill_name}/`}${check.category}`
      );
    }
  }
  console.log(`  Overall: ${result.status}`);
  console.log(`  Guard-observed network attempts: ${result.guarded_network_attempts}`);
  console.log(`  Report: ${reportPath}`);
  if (result.status !== "PASS") process.exitCode = 1;
}
