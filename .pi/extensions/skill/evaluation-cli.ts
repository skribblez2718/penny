import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson, initializePennyState } from "@penny/orchestration/source";

import {
  DIRECT_DEMETRI_BASELINE_REGISTRATION,
  GenericEvaluationTrialExecutor,
  SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
  runPairedEvaluation,
  syntheticEvaluationImplementationBinding,
  syntheticEvaluationRuntimeFunctions,
  syntheticKnownDeltaModelClientFactory,
} from "./evaluation-runner.js";

const MAX_FIXTURE_BYTES = 1_048_576;
const EXPECTED_KNOWN_DELTA = 0.5;

interface CliArguments {
  readonly projectRoot: string;
  readonly populationPath: string;
  readonly planPath: string;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error(
        "usage: evaluation-cli.ts --project-root <path> --population <path> --plan <path>"
      );
    }
    if (values.has(name)) throw new Error(`duplicate evaluation CLI argument '${name}'`);
    values.set(name, value);
  }
  const projectRoot = values.get("--project-root");
  const populationPath = values.get("--population");
  const planPath = values.get("--plan");
  if (
    projectRoot === undefined ||
    populationPath === undefined ||
    planPath === undefined ||
    values.size !== 3
  ) {
    throw new Error(
      "usage: evaluation-cli.ts --project-root <path> --population <path> --plan <path>"
    );
  }
  return { projectRoot, populationPath, planPath };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readFixture(projectRoot: string, suppliedPath: string): unknown {
  const candidate = realpathSync(path.resolve(projectRoot, suppliedPath));
  if (!isWithinRoot(projectRoot, candidate)) {
    throw new Error("evaluation fixture path escapes the supplied project root");
  }
  const stats = lstatSync(candidate);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FIXTURE_BYTES) {
    throw new Error("evaluation fixture must be one bounded regular file");
  }
  return JSON.parse(readFileSync(candidate, "utf8"));
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv);
  const projectRoot = realpathSync(path.resolve(args.projectRoot));
  const population = readFixture(projectRoot, args.populationPath);
  const plan = readFixture(projectRoot, args.planPath);
  const temporary = mkdtempSync(path.join(tmpdir(), "penny-known-delta-eval-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(temporary, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  try {
    initializePennyState(projectRoot, { env });
    const runtimeFunctions = syntheticEvaluationRuntimeFunctions();
    const implementationBinding = syntheticEvaluationImplementationBinding({
      projectRoot,
      population,
      plan,
      runtimeFunctions,
    });
    const executor = new GenericEvaluationTrialExecutor({
      projectRoot,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      modelClientFactory: syntheticKnownDeltaModelClientFactory(),
    });
    const run = await runPairedEvaluation({
      population,
      plan,
      projectRoot,
      env,
      baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
      candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
      executor,
      implementationBinding,
      runtimeFunctions,
    });
    if (
      run.result.disposition !== "CANDIDATE" ||
      run.result.aggregate_deltas.primary_delta !== EXPECTED_KNOWN_DELTA ||
      !run.result.policy_outcomes.all_passed
    ) {
      throw new Error("offline known-delta evaluation did not reproduce its predeclared gate");
    }
    process.stdout.write(
      `${canonicalJson({
        ok: true,
        gate: "offline-synthetic-known-delta-v1",
        result_id: run.result.result_id,
        result_artifact_id: run.result_artifact_ref.artifact_id,
        primary_delta: run.result.aggregate_deltas.primary_delta,
        disposition: run.result.disposition,
      })}\n`
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

await main(process.argv.slice(2));
