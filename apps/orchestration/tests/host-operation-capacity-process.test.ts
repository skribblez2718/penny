import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  validateCapacityRecord,
  type HostCapacityRecordV1,
} from "../dist/host-operations/capacity-contracts.js";
import { CapacityFixture, type CapacityFixtureOperation } from "./helpers/capacity-fixtures.js";

interface CompetitionChild {
  readonly ready: Promise<void>;
  readonly result: Promise<HostCapacityRecordV1>;
  readonly go: () => void;
  readonly stop: () => Promise<void>;
}
function child(
  script: string,
  fixture: CapacityFixture,
  op: CapacityFixtureOperation,
  mode: "reserve" | "inspect" = "reserve"
): CompetitionChild {
  const processChild = spawn(
    process.execPath,
    [
      script,
      JSON.stringify({
        stateRoot: fixture.stateRoot,
        projectRoot: op.project.root,
        policy: fixture.policy,
        request: op.request,
        now: fixture.now,
        mode,
      }),
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let output = "";
  let errorOutput = "";
  let markReady: () => void = () => {
    throw new Error("barrier not initialized");
  };
  let failReady: (error: Error) => void = () => {
    throw new Error("barrier not initialized");
  };
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  processChild.stdout.on("data", (value: Buffer) => {
    output += value.toString("utf8");
    if (output.startsWith("ready\n")) markReady();
  });
  processChild.stderr.on("data", (value: Buffer) => {
    errorOutput += value.toString("utf8");
  });
  const result = new Promise<HostCapacityRecordV1>((resolve, reject) => {
    processChild.once("error", (error) => {
      failReady(error);
      reject(error);
    });
    processChild.once("exit", (code) => {
      if (code !== 0) {
        const error = new Error(`capacity child failed: ${errorOutput}`);
        failReady(error);
        reject(error);
        return;
      }
      try {
        const lines = output.trim().split("\n");
        const raw: unknown = JSON.parse(lines[1] ?? "null");
        resolve(validateCapacityRecord(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
  // Attach rejection handlers while awaiting the two readiness barriers, avoiding orphan rejects.
  void result.catch(() => undefined);
  return {
    ready,
    result,
    go: () => {
      processChild.stdin.end("go\n");
    },
    stop: async () => {
      if (processChild.exitCode === null) processChild.kill("SIGTERM");
      await result.catch(() => undefined);
    },
  };
}
function compileWorker(fixture: CapacityFixture): string {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const compiled = path.join(fixture.root, "compiled");
  mkdirSync(path.join(compiled, "tests", "fixtures"), { recursive: true });
  writeFileSync(path.join(compiled, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(path.join(packageRoot, "node_modules"), path.join(compiled, "node_modules"), "dir");
  // Keep child imports on the same guarded shipping generation as the parent.
  symlinkSync(path.join(packageRoot, "dist"), path.join(compiled, "dist"), "dir");
  const source = readFileSync(
    path.join(packageRoot, "tests", "fixtures", "capacity-competition-worker.ts"),
    "utf8"
  );
  const emitted = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    reportDiagnostics: true,
  });
  if (emitted.diagnostics?.some((x) => x.category === ts.DiagnosticCategory.Error))
    throw new Error("capacity worker syntax invalid");
  const script = path.join(compiled, "tests", "fixtures", "capacity-competition-worker.js");
  writeFileSync(script, emitted.outputText);
  return script;
}

describe("cross-process global capacity", () => {
  it("competes atomically across two real project stores and restores exact holds in a fresh process", async () => {
    using f = new CapacityFixture();
    const a = f.operation("process-a", "video-a", 0, 60);
    const b = f.operation("process-b", "video-b", 1, 60);
    const script = compileWorker(f);
    const children: CompetitionChild[] = [];
    try {
      const first = child(script, f, a);
      const second = child(script, f, b);
      children.push(first, second);
      await Promise.all([first.ready, second.ready]);
      first.go();
      second.go();
      const outcomes = await Promise.all([first.result, second.result]);
      expect(outcomes.map((x) => x.state).sort()).toEqual(["held", "queued"]);
      const core = f.core();
      expect(core.inspect(a.record.operation_record_id)).toEqual(outcomes[0]);
      expect(core.inspect(b.record.operation_record_id)).toEqual(outcomes[1]);
      const adopted = child(script, f, a, "inspect");
      children.push(adopted);
      await adopted.ready;
      adopted.go();
      expect(await adopted.result).toEqual(outcomes[0]);
      const c = f.operation("process-distinct", "video-c", 1, 60);
      const distinct = child(script, f, c);
      children.push(distinct);
      await distinct.ready;
      distinct.go();
      expect((await distinct.result).state).toBe("held");
    } finally {
      await Promise.all(children.map((worker) => worker.stop()));
    }
  }, 60_000);
});
