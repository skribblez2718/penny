#!/usr/bin/env node

import { stdin, stdout } from "node:process";

import { ArtifactStore } from "./artifact-store.js";
import { Checkpointer } from "./checkpointer.js";
import { loadRuntimeConfig } from "./config.js";
import type { Directive } from "./contracts.js";
import { OrchestrationEngine } from "./engine.js";
import { PiAgentClient } from "./model-client.js";
import { OrchestrationRunner, WorkerExecutor } from "./worker.js";

const MAX_REQUEST_BYTES = 4 * 1_024 * 1_024;

function requestChunk(value: unknown): Buffer<ArrayBufferLike> {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("stdin contained a non-byte chunk");
}

async function readRequest(): Promise<unknown> {
  const chunks: Buffer<ArrayBufferLike>[] = [];
  let total = 0;
  for await (const value of stdin) {
    const bytes = requestChunk(value);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error(`request exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  if (total === 0) {
    throw new Error("expected one JSON request on stdin");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    stdout.write(
      [
        "Usage: penny-orchestration [--execute] [--project-root=PATH]",
        "",
        "Reads one JSON orchestration request from stdin and writes one JSON directive to stdout.",
        "",
        "Options:",
        "  --execute          Execute the directive (run workers against a real model)",
        "  --project-root=PATH  Override the project root (default: cwd)",
        "  --help, -h          Show this help and exit",
        "",
        "Actions (in the JSON request):",
        "  start, step, recover, respond, cancel, status",
        "",
        "State:",
        "  Initialize first: penny-state init --project-root=PATH",
        "  PENNY_STATE_ROOT  Optional absolute override; defaults below Pi's getAgentDir()",
        "",
        "Environment:",
        "  PENNY_ORCHESTRATION_MAX_STEPS    Maximum steps per run (default: 96)",
        "  PENNY_ORCHESTRATION_WORKER_TIMEOUT_MS  Worker timeout in ms (default: 900000)",
        "  PENNY_ORCHESTRATION_PARALLEL_CONCURRENCY  Parallel branch limit (default: 4)",
        "  PENNY_ORCHESTRATION_MAX_RETAINED_RUNS    Bounded retention cap (default: 500)",
        "  PENNY_RESEARCH_DEFAULT_MODEL       Default model for all research agents",
        "",
      ].join("\n")
    );
    return;
  }
  const execute = process.argv.includes("--execute");
  const projectRootArgument = process.argv.find((argument) =>
    argument.startsWith("--project-root=")
  );
  const projectRoot = projectRootArgument
    ? projectRootArgument.slice("--project-root=".length)
    : process.cwd();
  const config = loadRuntimeConfig(projectRoot);
  const request = await readRequest();
  using checkpointer = new Checkpointer(config.dbPath, undefined, {
    maxRetainedRuns: config.maxRetainedRuns,
    projectId: config.projectId,
  });
  using artifacts = new ArtifactStore(config.artifactRoot, { projectId: config.projectId });
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: config.projectRoot,
    maxSteps: config.maxSteps,
    receiptKeyPath: config.receiptKeyPath,
    artifactRevisions: artifacts,
  });
  let result: Directive = engine.handle(request);
  if (execute) {
    const client = new PiAgentClient();
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: config.projectRoot,
      parallelConcurrency: config.parallelConcurrency,
      workerTimeoutMs: config.workerTimeoutMs,
    });
    result = await new OrchestrationRunner(engine, workers).runUntilBoundary(result);
  }
  stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: name, message })}\n`);
  process.exitCode = 1;
});
