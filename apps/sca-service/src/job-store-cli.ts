#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Type, type Static } from "typebox";

import { canonicalJson } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { ScaJobStore, type ScaJobStoreOptions } from "./job-store.js";

const MIN_RETAINED_JOBS = 1;
const MAX_RETAINED_JOBS = 10_000;
const COMMANDS = ["provision", "status"] as const;
const FLAGS = new Set(["database", "project-id", "max-retained-jobs"]);

export const ScaJobStoreCliResultSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-job-store-cli-result.v1"),
    schema_version: Type.Literal(1),
    operation: Type.Union([Type.Literal("provision"), Type.Literal("status")]),
    project_id: Type.String({ minLength: 1, maxLength: 128 }),
    retained_jobs: Type.Integer({ minimum: 0, maximum: MAX_RETAINED_JOBS }),
    terminal_jobs: Type.Integer({ minimum: 0, maximum: MAX_RETAINED_JOBS }),
    max_retained_jobs: Type.Integer({
      minimum: MIN_RETAINED_JOBS,
      maximum: MAX_RETAINED_JOBS,
    }),
  },
  { additionalProperties: false }
);
export type ScaJobStoreCliResultV1 = Static<typeof ScaJobStoreCliResultSchema>;

interface ScaJobStoreCliCommand {
  readonly command: "provision" | "status";
  readonly database: string;
  readonly projectId: string;
  readonly maxRetainedJobs?: number;
}

export interface ScaJobStoreCliDepsV1 {
  /** Test seam; the executable's main guard supplies the stdout default. */
  readonly emit?: (value: string) => void;
}

function usage(): never {
  throw new Error(
    "usage: penny-sca-job-store {provision|status} --database=ABS_PATH --project-id=ID [--max-retained-jobs=N]"
  );
}

function parseArgv(argv: readonly string[]): ScaJobStoreCliCommand {
  const command = argv[0];
  if (command !== COMMANDS[0] && command !== COMMANDS[1]) usage();
  const flags = new Map<string, string>();
  for (const token of argv.slice(1)) {
    const separator = token.indexOf("=");
    if (!token.startsWith("--") || separator < 3) usage();
    const name = token.slice(2, separator);
    if (!FLAGS.has(name) || flags.has(name)) usage();
    flags.set(name, token.slice(separator + 1));
  }
  const database = flags.get("database");
  const projectId = flags.get("project-id");
  if (database === undefined || database.length === 0) usage();
  if (projectId === undefined || projectId.length === 0) usage();
  const rawLimit = flags.get("max-retained-jobs");
  let maxRetainedJobs: number | undefined;
  if (rawLimit !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(rawLimit)) usage();
    maxRetainedJobs = Number(rawLimit);
    if (!Number.isSafeInteger(maxRetainedJobs)) usage();
  }
  return { command, database, projectId, maxRetainedJobs };
}

function run(command: ScaJobStoreCliCommand): ScaJobStoreCliResultV1 {
  const options: ScaJobStoreOptions = {
    projectId: command.projectId,
    ...(command.maxRetainedJobs === undefined ? {} : { maxRetainedJobs: command.maxRetainedJobs }),
  };
  // Status is a read-only SQLite inspection. Provision publishes with create-never semantics and
  // closes the writable handle before returning the same body-free summary.
  const summary =
    command.command === "status"
      ? ScaJobStore.inspectExisting(command.database, options)
      : (() => {
          const store = ScaJobStore.provision(command.database, options);
          try {
            return store.summary();
          } finally {
            store.close();
          }
        })();
  return {
    schema_id: "penny.sca-job-store-cli-result.v1",
    schema_version: 1,
    operation: command.command,
    project_id: summary.projectId,
    retained_jobs: summary.retainedJobs,
    terminal_jobs: summary.terminalJobs,
    max_retained_jobs: summary.maxRetainedJobs,
  };
}

export function runScaJobStoreCliV1(
  argv: readonly string[],
  deps: ScaJobStoreCliDepsV1 = {}
): void {
  const command = parseArgv(argv);
  const result = run(command);
  const validated = validateContract(
    ScaJobStoreCliResultSchema,
    result,
    "SCA job store CLI result"
  );
  const emit = deps.emit ?? ((value: string) => process.stdout.write(`${value}\n`));
  emit(canonicalJson(validated));
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runScaJobStoreCliV1(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`job-store: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  }
}
