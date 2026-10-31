import {
  chmodSync,
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { ScaJobStore } from "../src/job-store.js";
import {
  createScaVmBrokerProductionCompositionV1,
  loadScaVmBrokerProductionConfigV1,
} from "../src/production-vm-config.js";

const roots: string[] = [];
afterEach(() => {
  vi.doUnmock("../src/production-vm-config.js");
  vi.doUnmock("../src/server.js");
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "penny-sca-production-vm-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const artifacts = path.join(root, "artifacts");
  const projectId = `prj_${"a".repeat(32)}`;
  ArtifactStore.provision(artifacts, { projectId }).close();
  const jobStorePath = path.join(root, "jobs.db");
  ScaJobStore.provision(jobStorePath, { projectId }).close();
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  chmodSync(workspace, 0o700);
  const lock = path.join(root, "global.lock");
  closeSync(openSync(lock, "wx", 0o600));
  chmodSync(lock, 0o600);
  const pin = (name: string, size = 32, mode = 0o500) => {
    const file = path.join(root, name);
    const bytes = Buffer.alloc(size, name.charCodeAt(0));
    writeFileSync(file, bytes, { mode });
    chmodSync(file, mode);
    return { path: file, sha256: sha256(bytes), size_bytes: bytes.byteLength };
  };
  const runJob = pin("run_job.py");
  const outputProtocol = pin("output_protocol.py");
  const config = {
    schema_version: 1 as const,
    artifact_root: artifacts,
    job_store_path: jobStorePath,
    project_id: projectId,
    workspace_parent: workspace,
    global_lock: lock,
    authorization: {
      configProducers: ["host:config"],
      configDigests: ["a".repeat(64)],
      executionPlanProducers: ["host:plan"],
      graphBindingProducers: ["host:graph-binding"],
      graphProducers: ["host:graph"],
      policyProducers: ["host:policy"],
      policyDigests: ["b".repeat(64)],
    },
    run_job: runJob,
    run_guest: pin("run_guest.py"),
    output_protocol: outputProtocol,
    python: pin("python"),
    genisoimage: pin("genisoimage"),
    cp: pin("cp"),
    qemu: pin("qemu"),
    bwrap: pin("bwrap"),
    systemctl: pin("systemctl"),
    template: pin("template.qcow2", 65_536, 0o400),
  };
  const configPath = path.join(root, "production.json");
  writeFileSync(configPath, canonicalJson(config), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { config, configPath };
}

describe("SCA VM production composition", () => {
  it("loads one closed owner-only canonical config and installs all broker adapters", () => {
    const { configPath } = setup();
    expect(loadScaVmBrokerProductionConfigV1(configPath).project_id).toBe(`prj_${"a".repeat(32)}`);
    const composition = createScaVmBrokerProductionCompositionV1(configPath);
    try {
      expect(composition.jobStore.projectId).toBe(`prj_${"a".repeat(32)}`);
      expect(composition.jobStore.databasePath).toBe(
        loadScaVmBrokerProductionConfigV1(configPath).job_store_path
      );
      expect(composition.adapters.source_query).not.toBeNull();
      expect(composition.adapters.graph_query).not.toBeNull();
      expect(composition.adapters.application_test).not.toBeNull();
    } finally {
      composition.close();
    }
  });

  it("requires an existing canonical project-bound job store and closes it", () => {
    const { config, configPath } = setup();
    const writeConfig = (value: unknown): void => writeFileSync(configPath, canonicalJson(value));
    const { job_store_path: jobStorePath, ...missing } = config;
    writeConfig(missing);
    expect(() => loadScaVmBrokerProductionConfigV1(configPath)).toThrow();
    for (const invalid of [
      "jobs.db",
      `${path.dirname(jobStorePath)}/../jobs.db`,
      `${jobStorePath}\0`,
    ]) {
      writeConfig({ ...config, job_store_path: invalid });
      expect(() => loadScaVmBrokerProductionConfigV1(configPath)).toThrow(/absolute/u);
    }
    writeConfig({ ...config, job_store_path: path.join(path.dirname(jobStorePath), "absent.db") });
    expect(() => createScaVmBrokerProductionCompositionV1(configPath)).toThrow();
    writeConfig(config);
    const composition = createScaVmBrokerProductionCompositionV1(configPath);
    composition.close();
    composition.close();
    expect(() => composition.jobStore.get("a".repeat(64))).toThrow(/unavailable/u);
    rmSync(jobStorePath);
    ScaJobStore.provision(jobStorePath, { projectId: `prj_${"b".repeat(32)}` }).close();
    expect(() => createScaVmBrokerProductionCompositionV1(configPath)).toThrow(/project binding/u);
  });

  it("main injects durable custody and closes it on shutdown and startup failure", async () => {
    const { configPath } = setup();
    vi.stubEnv("PENNY_SCA_SERVICE_VM_CONFIG", configPath);
    vi.stubEnv(
      "PENNY_SCA_SERVICE_SOCKET_PATH",
      path.join(path.dirname(configPath), "service.sock")
    );
    vi.stubEnv("PENNY_SCA_SERVICE_TOKEN", "production-test-token-00000000000000000000");
    const composition = createScaVmBrokerProductionCompositionV1(configPath);
    let currentComposition = composition;
    const closed = vi.spyOn(composition.jobStore, "close");
    const shutdown = vi.fn(async () => {});
    const start = vi.fn(async () => ({
      socketPath: "unused",
      isListening: () => true,
      activeConnections: () => 0,
      lastServerError: () => null,
      shutdown,
    }));
    vi.doMock("../src/production-vm-config.js", () => ({
      createScaVmBrokerProductionCompositionV1: () => currentComposition,
    }));
    vi.doMock("../src/server.js", () => ({ startScaService: start }));
    const beforeInt = new Set(process.listeners("SIGINT"));
    const beforeTerm = new Set(process.listeners("SIGTERM"));
    const previousExitCode = process.exitCode;
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const { main } = await import("../src/index.js");
      await main();
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticationToken: "production-test-token-00000000000000000000",
        }),
        { adapters: composition.adapters, jobStore: composition.jobStore }
      );
      const onTerm = process.listeners("SIGTERM").find((listener) => !beforeTerm.has(listener));
      if (onTerm === undefined) throw new Error("main did not register shutdown");
      onTerm("SIGTERM");
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
      expect(shutdown).toHaveBeenCalledTimes(1);
      currentComposition = createScaVmBrokerProductionCompositionV1(configPath);
      const failedClose = vi.spyOn(currentComposition.jobStore, "close");
      start.mockRejectedValueOnce(new Error("startup failed"));
      await expect(main()).rejects.toThrow(/startup failed/u);
      expect(failedClose).toHaveBeenCalledTimes(1);
    } finally {
      for (const listener of process.listeners("SIGINT"))
        if (!beforeInt.has(listener)) process.removeListener("SIGINT", listener);
      for (const listener of process.listeners("SIGTERM"))
        if (!beforeTerm.has(listener)) process.removeListener("SIGTERM", listener);
      process.exitCode = previousExitCode;
      write.mockRestore();
      currentComposition.close();
    }
  });

  it("rejects exposed, noncanonical, and unknown-field config before opening a service", () => {
    const { config, configPath } = setup();
    chmodSync(configPath, 0o644);
    expect(() => loadScaVmBrokerProductionConfigV1(configPath)).toThrow(/0600/u);
    chmodSync(configPath, 0o600);
    writeFileSync(configPath, JSON.stringify({ ...config, unexpected: true }, null, 2), {
      mode: 0o600,
    });
    expect(() => loadScaVmBrokerProductionConfigV1(configPath)).toThrow(/canonical|contract/u);
  });
});
