import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createChildLifecycleScope, waitForChildLifecycle } from "../../child-lifecycle.js";

function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("fixture child did not become ready")),
      2_000
    );
    child.stdout?.once("data", (chunk: Buffer) => {
      clearTimeout(timeout);
      if (!chunk.toString().includes("READY")) {
        reject(new Error("fixture child emitted an unexpected readiness payload"));
        return;
      }
      resolve();
    });
  });
}

const posixIt = process.platform === "win32" ? it.skip : it;
const windowsIt = process.platform === "win32" ? it : it.skip;

describe("real subagent child cancellation", () => {
  it("leaves no child orphaned when finalizer setup fails after spawn", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000);"], {
      cwd: tmpdir(),
      env: {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const scope = createChildLifecycleScope({
      maxActiveChildren: 1,
      createFinalizer() {
        throw new Error("live-local setup failure");
      },
    });
    const begun = scope.beginChild(child, undefined, {
      forceExitGraceMs: 1_000,
      outputDrainGraceMs: 1_000,
    });

    try {
      expect(begun.accepted).toBe(false);
      await expect(begun.finalizer.settled).resolves.toMatchObject({
        state: "setup_failed",
        terminationRequested: true,
        forceRequested: true,
        exitObserved: true,
        closeObserved: true,
      });
      expect(scope.activeCount).toBe(0);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);

  it("leaves no admitted child orphaned after scope shutdown", async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.stdout.write("READY\\n");setInterval(() => {}, 1_000);'],
      {
        cwd: tmpdir(),
        env: {},
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const scope = createChildLifecycleScope({ maxActiveChildren: 1 });
    const begun = scope.beginChild(child, undefined, {
      terminationGraceMs: 100,
      forceExitGraceMs: 1_000,
      outputDrainGraceMs: 1_000,
    });

    try {
      expect(begun.accepted).toBe(true);
      await waitForReady(child);
      await Promise.all([scope.finalize(), scope.finalize()]);
      await expect(begun.finalizer.settled).resolves.toMatchObject({
        state: "closed",
        terminationRequested: true,
        exitObserved: true,
        closeObserved: true,
      });
      expect(scope.activeCount).toBe(0);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);

  it("leaves no child orphaned when admission arrives after finalization resolved", async () => {
    const scope = createChildLifecycleScope({ maxActiveChildren: 1 });
    await scope.finalize();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000);"], {
      cwd: tmpdir(),
      env: {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const begun = scope.beginChild(child, undefined, {
      forceExitGraceMs: 1_000,
      outputDrainGraceMs: 1_000,
    });

    try {
      expect(begun).toMatchObject({ accepted: false, reason: "scope_finalizing" });
      await expect(begun.finalizer.settled).resolves.toMatchObject({
        state: "admission_rejected",
        terminationRequested: true,
        exitObserved: true,
        closeObserved: true,
      });
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(scope.activeCount).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);

  posixIt(
    "force-kills a harmless child that ignores SIGTERM and settles after close",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          [
            'process.on("SIGTERM", () => {});',
            'process.stdout.write("READY\\n");',
            "setInterval(() => {}, 1_000);",
          ].join(""),
        ],
        {
          cwd: tmpdir(),
          env: {},
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      const controller = new AbortController();
      const terminationGraceMs = 100;
      const lifecyclePromise = waitForChildLifecycle(child, controller.signal, {
        terminationGraceMs,
        forceExitGraceMs: 1_000,
        outputDrainGraceMs: 1_000,
      });

      try {
        await waitForReady(child);
        const startedAt = Date.now();
        controller.abort();
        const result = await lifecyclePromise;
        const elapsedMs = Date.now() - startedAt;

        expect(result).toMatchObject({
          state: "closed",
          terminationRequested: true,
          forceRequested: true,
          exitObserved: true,
          closeObserved: true,
          exitSignal: "SIGKILL",
        });
        expect(elapsedMs).toBeGreaterThanOrEqual(terminationGraceMs - 25);
        expect(elapsedMs).toBeLessThan(terminationGraceMs + 1_000);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    10_000
  );

  windowsIt(
    "uses explicit force-only termination under Windows signal emulation",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", 'process.stdout.write("READY\\n");setInterval(() => {}, 1_000);'],
        {
          cwd: tmpdir(),
          env: {},
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      const controller = new AbortController();
      const lifecyclePromise = waitForChildLifecycle(child, controller.signal, {
        forceExitGraceMs: 1_000,
        outputDrainGraceMs: 1_000,
      });

      try {
        await waitForReady(child);
        controller.abort();
        await expect(lifecyclePromise).resolves.toMatchObject({
          state: "closed",
          terminationRequested: true,
          forceRequested: true,
          exitObserved: true,
          closeObserved: true,
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    10_000
  );
});
