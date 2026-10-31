import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostOperationExecutionContextV1 } from "../dist/host-operations/contracts.js";
import { capacityPolicy } from "./helpers/capacity-fixtures.js";
import {
  CapacityRuntimeFixture,
  syntheticCapacityAdapter,
} from "./helpers/capacity-runtime-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";

function compileWorker(root: string): string {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const compiled = path.join(root, "compiled");
  mkdirSync(path.join(compiled, "tests", "fixtures"), { recursive: true });
  writeFileSync(path.join(compiled, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(path.join(packageRoot, "node_modules"), path.join(compiled, "node_modules"), "dir");
  // Keep child imports on the same guarded shipping generation as the parent.
  symlinkSync(path.join(packageRoot, "dist"), path.join(compiled, "dist"), "dir");
  const source = readFileSync(
    path.join(packageRoot, "tests", "fixtures", "capacity-productive-worker.ts"),
    "utf8"
  );
  const emitted = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    reportDiagnostics: true,
  });
  if (emitted.diagnostics?.some((x) => x.category === ts.DiagnosticCategory.Error))
    throw new Error("productive worker syntax invalid");
  const script = path.join(compiled, "tests", "fixtures", "capacity-productive-worker.js");
  writeFileSync(script, emitted.outputText);
  return script;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("independent durable productive source", () => {
  it("observes real-store work written by another process, rejects a repeated work count, and settles quarantine on restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), active_inactivity_ms: 150 }, true, {
      max_observations: 4,
      max_units: 1000,
    });
    const script = compileWorker(f.root);
    let context: HostOperationExecutionContextV1 | undefined;
    let markReady: () => void = () => {
      throw new Error("ready barrier absent");
    };
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const base = syntheticCapacityAdapter(() => undefined, f.counter);
    const adapter = {
      ...base,
      run: async (input: HostOperationExecutionContextV1) => {
        input.beginSubmission();
        f.counter.submissions += 1;
        input.recordRemoteAccepted("independent-durable-target");
        context = input;
        markReady();
        return await new Promise<never>(() => undefined);
      },
    };
    const directive = f.prepare("independent-progress");
    const done = f
      .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
      .dispatch(f.engine, directive);
    await Promise.race([
      ready,
      done.then(() => {
        throw new Error("owner ended before adapter entry");
      }),
    ]);
    const active = requireValue(context, "active independent fixture context");
    const observe = requireValue(active.observeProductiveProgress, "host-only callback");
    const produce = (revision: number, units: number): void => {
      expect(
        execFileSync(
          process.execPath,
          [
            script,
            JSON.stringify({
              stateRoot: f.config.stateRoot,
              dbPath: f.config.dbPath,
              artifactRoot: f.config.artifactRoot,
              projectId: f.config.projectId,
              operationRecordId: active.journal.operation_record_id,
              policy: f.policy,
              now: Date.now(),
              revision,
              units,
            }),
          ],
          { encoding: "utf8" }
        )
      ).toBe("durable-fixture-progress\n");
    };
    await vi.advanceTimersByTimeAsync(50);
    produce(1, 10);
    observe();
    expect(f.capacity.inspect(active.journal.operation_record_id)?.last_milestone_ms).toBe(10_050);
    const inactivity = active.journal.operation_inactivity_expires_at_ms;
    await vi.advanceTimersByTimeAsync(50);
    observe();
    expect(active.journal.operation_inactivity_expires_at_ms).toBe(inactivity);
    produce(2, 10); // Increasing revision and spend alone are not increasing actual work.
    expect(observe).toThrow(/unproductive/u);
    expect(f.capacity.runtimeRecord(active.journal.operation_record_id)?.productive_count).toBe(1);
    await vi.advanceTimersByTimeAsync(101);
    expect((await done).action).toBe("await_user");
    expect(f.record(directive).disposition).toMatchObject({
      outcome: "timed_out",
      lease_disposition: "quarantined",
    });
    f.reopen();
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("status");
    expect(f.capacity.runtimeRecord(active.journal.operation_record_id)).toMatchObject({
      productive_count: 1,
      core: { state: "quarantined", last_milestone_ms: 10_050 },
    });
    expect(f.counter.submissions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  }, 60_000);
});
