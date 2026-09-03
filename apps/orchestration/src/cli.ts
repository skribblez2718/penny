#!/usr/bin/env node

import { stdin, stdout } from "node:process";

import { ArtifactStore } from "./artifact-store.js";
import { ProjectRetentionOwner } from "./catalog-session-retention.js";
import { Checkpointer } from "./checkpointer.js";
import { loadRuntimeConfig } from "./config.js";
import type { Directive } from "./contracts.js";
import { OrchestrationEngine } from "./engine.js";
import { PiAgentClient } from "./model-client.js";
import { ReceiptAuthority } from "./receipts.js";
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
        "  PENNY_ORCHESTRATION_MAX_RETAINED_RUNS    Terminal run/worker-session cohort cap (default: 500)",
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
  const checkpointer = Checkpointer.openExisting(config.dbPath, undefined, {
    maxRetainedRuns: config.maxRetainedRuns,
    projectId: config.projectId,
  });
  let artifacts: ArtifactStore | undefined;
  let retention: ProjectRetentionOwner | undefined;
  let result: Directive | undefined;
  let runtimeReady = false;
  const failures: unknown[] = [];
  try {
    const openedArtifacts = ArtifactStore.openExisting(config.artifactRoot, {
      projectId: config.projectId,
    });
    artifacts = openedArtifacts;
    retention = new ProjectRetentionOwner(checkpointer, {
      projectId: config.projectId,
      sessionRoot: config.subagentSessionRoot,
    });
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: config.projectRoot,
      maxSteps: config.maxSteps,
      receiptAuthority: ReceiptAuthority.loadExisting(config.receiptKeyPath),
      artifactRevisions: openedArtifacts,
    });
    runtimeReady = true;
    result = engine.handle(request);
    if (execute) {
      const client = new PiAgentClient({
        catalogSessions: {
          projectId: config.projectId,
          root: config.subagentSessionRoot,
        },
      });
      const workers = new WorkerExecutor(client, openedArtifacts, {
        projectRoot: config.projectRoot,
        parallelConcurrency: config.parallelConcurrency,
        workerTimeoutMs: config.workerTimeoutMs,
      });
      result = await new OrchestrationRunner(engine, workers).runUntilBoundary(result);
    }
  } catch (error) {
    failures.push(error);
  }
  if (runtimeReady && retention !== undefined) {
    try {
      retention.run();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    artifacts?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    checkpointer.close();
  } catch (error) {
    failures.push(error);
  }
  const first = failures[0];
  if (failures.length === 1 && first !== undefined) throw first;
  if (failures.length > 1) {
    throw new AggregateError(failures, "orchestration runtime finalization failed");
  }
  if (result === undefined) throw new Error("orchestration runtime produced no directive");
  stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: name, message })}\n`);
  process.exitCode = 1;
});
