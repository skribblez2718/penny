import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../src/config.js";
import { initializePennyState, resolvePennyRuntimeState } from "../src/state/index.js";

const roots: string[] = [];

function fixture(): { projectRoot: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(path.join(tmpdir(), "penny-runtime-config-test-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const env = { PENNY_STATE_ROOT: path.join(root, "state") };
  initializePennyState(projectRoot, { env });
  return { projectRoot, env };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TypeScript orchestration runtime configuration", () => {
  it("uses project-bound stable target paths", () => {
    const { projectRoot, env } = fixture();
    const config = loadRuntimeConfig(projectRoot, env);

    expect(path.basename(config.dbPath)).toBe("orchestration.db");
    expect(path.basename(config.receiptKeyPath)).toBe("receipt-key");
    expect(path.basename(config.subagentSessionRoot)).toBe("subagent-sessions");
    expect(path.basename(config.artifactRoot)).toBe("artifacts");
    expect(config.dbPath.startsWith(config.stateRoot)).toBe(true);
    expect(config.artifactRoot.startsWith(config.stateRoot)).toBe(true);
    expect(config.projectId).toMatch(/^prj_[a-f0-9]{32}$/u);
    expect(config.dbPath).not.toContain(projectRoot);
  });

  it("refuses uninitialized projects instead of creating or importing state", () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-runtime-config-missing-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });

    expect(() =>
      loadRuntimeConfig(projectRoot, { PENNY_STATE_ROOT: path.join(root, "state") })
    ).toThrow("run explicit state setup");
  });

  it("does not make observability availability an orchestration runtime prerequisite", () => {
    const { projectRoot, env } = fixture();
    const observabilityDatabase = path.join(
      env.PENNY_STATE_ROOT ?? "",
      "observability",
      "observability.db"
    );
    rmSync(observabilityDatabase, { force: true });
    rmSync(`${observabilityDatabase}-wal`, { force: true });
    rmSync(`${observabilityDatabase}-shm`, { force: true });

    expect(loadRuntimeConfig(projectRoot, env).projectRoot).toBe(projectRoot);
  });

  it.each([
    "PENNY_ORCH_DB",
    "PENNY_ORCH_V2_DB",
    "PENNY_ARTIFACT_ROOT",
    "PI_OBSERVABILITY_URL",
    "PI_OBSERVABILITY_DATA_DIR",
  ])("rejects retired path selector %s", (name) => {
    const { projectRoot, env } = fixture();
    expect(() => loadRuntimeConfig(projectRoot, { ...env, [name]: "/tmp/retired" })).toThrow(
      `${name} is retired`
    );
  });

  it("rejects retired selectors at the shared runtime boundary", () => {
    const { projectRoot, env } = fixture();
    expect(() =>
      resolvePennyRuntimeState(projectRoot, {
        env: { ...env, PENNY_ORCH_V2_DB: "/tmp/retired" },
      })
    ).toThrow("PENNY_ORCH_V2_DB is retired");
  });

  it("uses unversioned runtime limit names", () => {
    const { projectRoot, env } = fixture();
    const config = loadRuntimeConfig(projectRoot, {
      ...env,
      PENNY_ORCHESTRATION_MAX_STEPS: "12",
      PENNY_ORCHESTRATION_WORKER_TIMEOUT_MS: "30000",
      PENNY_ORCHESTRATION_PARALLEL_CONCURRENCY: "2",
      PENNY_ORCHESTRATION_MAX_RETAINED_RUNS: "100",
    });
    expect(config.maxSteps).toBe(12);
    expect(config.workerTimeoutMs).toBe(30_000);
    expect(config.parallelConcurrency).toBe(2);
    expect(config.maxRetainedRuns).toBe(100);
    expect(() =>
      loadRuntimeConfig(projectRoot, { ...env, PENNY_ORCHESTRATION_MAX_STEPS: "0" })
    ).toThrow("positive integer");
  });

  it("rejects the versioned limit selectors", () => {
    const { projectRoot, env } = fixture();
    expect(() => loadRuntimeConfig(projectRoot, { ...env, PENNY_ORCH_V2_MAX_STEPS: "12" })).toThrow(
      "PENNY_ORCH_V2_MAX_STEPS is retired"
    );
  });
});
