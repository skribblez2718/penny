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

async function readRequest(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.from(chunk);
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
  const execute = process.argv.includes("--execute");
  const projectRootArgument = process.argv.find((argument) =>
    argument.startsWith("--project-root=")
  );
  const projectRoot = projectRootArgument
    ? projectRootArgument.slice("--project-root=".length)
    : process.cwd();
  const config = loadRuntimeConfig(projectRoot);
  const request = await readRequest();
  using checkpointer = new Checkpointer(config.dbPath);
  using artifacts = new ArtifactStore(config.artifactRoot);
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: config.projectRoot,
    maxSteps: config.maxSteps,
    artifactRevisions: artifacts,
  });
  let result: Directive = engine.handle(request);
  if (execute) {
    const client = new PiAgentClient({
      readArtifact: (ref, consumer) => artifacts.read(ref, consumer),
    });
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
