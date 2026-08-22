import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORCHESTRATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VITEST = path.join(ORCHESTRATION_ROOT, "node_modules", "vitest", "vitest.mjs");
const WORKER = path.join(ORCHESTRATION_ROOT, "tests", "fixtures", "authority-race-worker.test.ts");
const WAIT_TIMEOUT_MS = 20_000;

export interface AuthorityWorkerJob {
  readonly operation: string;
  readonly storeDir: string;
  readonly input: Record<string, unknown>;
}

interface RunningWorker {
  readonly child: ChildProcess;
  readonly readyPath: string;
  readonly resultPath: string;
  readonly output: () => string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(10);
  }
}

function launch(job: AuthorityWorkerJob, coordinationDir: string, index: number): RunningWorker {
  const readyPath = path.join(coordinationDir, `ready-${index}`);
  const resultPath = path.join(coordinationDir, `result-${index}.json`);
  let output = "";
  const child = spawn(
    process.execPath,
    [
      VITEST,
      "run",
      "--config",
      "vitest.config.ts",
      "--pool=threads",
      "--maxWorkers=1",
      "--minWorkers=1",
      "tests/fixtures/authority-race-worker.test.ts",
    ],
    {
      cwd: ORCHESTRATION_ROOT,
      env: {
        ...process.env,
        PENNY_AUTHORITY_WORKER_JOB: JSON.stringify({
          ...job,
          readyPath,
          resultPath,
          goPath: path.join(coordinationDir, "go"),
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  return { child, readyPath, resultPath, output: () => output };
}

function exited(
  worker: RunningWorker
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
    return Promise.resolve({ code: worker.child.exitCode, signal: worker.child.signalCode });
  }
  return new Promise((resolve, reject) => {
    worker.child.once("error", reject);
    worker.child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForWorkersReady(workers: readonly RunningWorker[]): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!workers.every((worker) => existsSync(worker.readyPath))) {
    const exitedEarly = workers.find(
      (worker) => worker.child.exitCode !== null || worker.child.signalCode !== null
    );
    if (exitedEarly !== undefined) {
      throw new Error(
        `authority worker exited before the barrier ` +
          `(${exitedEarly.child.exitCode}/${exitedEarly.child.signalCode}):\n${exitedEarly.output()}`
      );
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for authority workers");
    await delay(10);
  }
}

/** Run store API calls in separately booted, barrier-synchronized Node processes. */
export async function runAuthorityRace(
  jobs: readonly AuthorityWorkerJob[]
): Promise<Array<Record<string, unknown>>> {
  const coordinationDir = mkdtempSync(path.join(tmpdir(), "penny-authority-race-"));
  try {
    const workers = jobs.map((job, index) => launch(job, coordinationDir, index));
    await waitForWorkersReady(workers);
    writeFileSync(path.join(coordinationDir, "go"), "go", { mode: 0o600 });
    const exits = await Promise.all(workers.map(exited));
    for (let index = 0; index < exits.length; index += 1) {
      const status = exits[index]!;
      if (status.code !== 0) {
        throw new Error(
          `authority worker ${index} failed (${status.code}/${status.signal}):\n${workers[index]!.output()}`
        );
      }
    }
    return workers.map(
      (worker) => JSON.parse(readFileSync(worker.resultPath, "utf8")) as Record<string, unknown>
    );
  } finally {
    rmSync(coordinationDir, { recursive: true, force: true });
  }
}

/** Kill one worker after an uncommitted SQLite update and verify process death. */
export async function crashAuthorityTransaction(job: AuthorityWorkerJob): Promise<void> {
  const coordinationDir = mkdtempSync(path.join(tmpdir(), "penny-authority-crash-"));
  try {
    const worker = launch(job, coordinationDir, 0);
    const exit = exited(worker);
    await waitFor(() => existsSync(worker.readyPath), "uncommitted authority transaction");
    worker.child.kill("SIGKILL");
    const status = await exit;
    if (status.signal !== "SIGKILL") {
      throw new Error(
        `authority crash worker did not die at the transaction boundary (${status.code}/${status.signal}):\n${worker.output()}`
      );
    }
  } finally {
    rmSync(coordinationDir, { recursive: true, force: true });
  }
}
