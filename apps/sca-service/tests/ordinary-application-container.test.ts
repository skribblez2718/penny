import { afterEach, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  createOrdinaryApplicationTestRuntime,
  OrdinaryApplicationContainerConfigSchema,
  OrdinaryApplicationTestPlanSchema,
  OrdinaryApplicationTestPolicySchema,
  recoverOrdinaryApplicationTest,
  type OrdinaryApplicationContainerConfig,
} from "../src/ordinary-application-tests.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  ordinaryApplicationDockerCommand,
  type OrdinaryApplicationDockerRunner,
  type OrdinaryApplicationDockerResponse,
} from "../src/ordinary-application-container.js";
import {
  containerFixture,
  type ContainerFixtureOptions,
} from "./fixtures/ordinary-application-container.js";

const nativeFileReads = vi.hoisted(() => {
  const reads: string[] = [];
  return reads;
});
// Only socket metadata is synthetic; no daemon or target workload runs in these contract tests.
// Refuse KVM access in-process, independent of whether the test host has a VM device.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async open(...args: Parameters<typeof fs.open>) {
      nativeFileReads.push(String(args[0]));
      if (String(args[0]) === "/dev/kvm")
        throw new Error("No KVM access authorized in offline tests");
      return fs.open(...args);
    },
    async realpath(...args: Parameters<typeof fs.realpath>) {
      nativeFileReads.push(String(args[0]));
      return fs.realpath(...args);
    },
    async lstat(...args: Parameters<typeof fs.lstat>) {
      nativeFileReads.push(String(args[0]));
      const stat = await fs.lstat(...args);
      return typeof args[0] === "string" && args[0].endsWith("fixture.sock")
        ? Object.assign(stat, { isSocket: () => true })
        : stat;
    },
  };
});
const roots: string[] = [];
const fixtures: Array<ReturnType<typeof containerFixture>> = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  function writableDirectories(root: string) {
    chmodSync(root, 0o700);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) writableDirectories(path.join(root, entry.name));
    }
  }
  for (const root of roots.splice(0)) {
    writableDirectories(root);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(options: Omit<ContainerFixtureOptions, "root" | "config"> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "container-contract-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const executable = path.join(root, "docker");
  const socket = path.join(root, "fixture.sock");
  writeFileSync(executable, "fake pinned client", { mode: 0o500 });
  writeFileSync(socket, "", { mode: 0o600 });
  const config: OrdinaryApplicationContainerConfig = {
    schema_id: "penny.sca-ordinary-application-container-config.v1",
    schema_version: 1,
    kind: "docker",
    isolation: "container",
    profile: "docker-local-no-network-v1",
    workspace_parent: workspace,
    docker: {
      path: executable,
      sha256: sha256(readFileSync(executable)),
      size_bytes: readFileSync(executable).length,
    },
    daemon_socket: socket,
    images: { php: `sha256:${"1".repeat(64)}`, node: `sha256:${"2".repeat(64)}` },
  };
  const f = containerFixture({ root, config, ...options });
  fixtures.push(f);
  return { ...f, config };
}
const processEnv = [
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/tmp",
  "TMPDIR=/tmp",
  "LANG=C.UTF-8",
  "HOSTNAME=application-test",
];
interface OracleOptions {
  readonly imageEnv?: unknown;
  readonly tamper?: (object: {
    HostConfig: Record<string, unknown>;
    Config: Record<string, unknown>;
    Mounts: Array<Record<string, unknown>>;
    AppArmorProfile: string;
    NetworkSettings: Record<string, unknown>;
  }) => void;
  readonly crash?: "create" | "start" | "rm";
  readonly foreign?: boolean;
  readonly collision?: boolean;
  readonly malformedCreate?: boolean;
  readonly staleTransport?: boolean;
  readonly removeRemains?: boolean;
}
function oracle(f: ReturnType<typeof fixture>, options: OracleOptions = {}) {
  const id = "a".repeat(64);
  const requestHash = sha256(canonicalJson(f.request));
  const name = `penny-app-${requestHash}`;
  const share = path.join(f.config.workspace_parent, `attempt-${requestHash}`, "input");
  const resources = f.plan.resources;
  const command = [
    "--signal=KILL",
    `${resources.test_timeout_ms / 1000}s`,
    "/usr/local/bin/node",
    "--max-old-space-size=128",
    "/input/tests/harness.mjs",
  ];
  const imageEnv: unknown[] = Array.isArray(options.imageEnv) ? options.imageEnv : [];
  const fixedNames = new Set(processEnv.map((entry) => entry.split("=")[0]));
  const unsetNames = imageEnv
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.split("=")[0])
    .filter((name) => !fixedNames.has(name));
  const object = {
    Id: id,
    Name: `/${name}`,
    Image: f.config.images.node,
    AppArmorProfile: "docker-default",
    NetworkSettings: { Networks: { none: {} } },
    Config: {
      User: "65534:65534",
      WorkingDir: "/input/tests",
      Hostname: "application-test",
      Entrypoint: ["/usr/bin/timeout"],
      Cmd: command,
      Env: [...unsetNames, ...processEnv],
      Tty: false,
      OpenStdin: true,
      Healthcheck: { Test: ["NONE"] },
      Labels: {
        "penny.application.request": options.foreign ? "wrong" : requestHash,
        "penny.application.owner": sha256(
          canonicalJson({ project: f.request.project_id, run: f.request.run_id })
        ),
        "penny.application.isolation": "CONTAINER",
      },
    },
    HostConfig: {
      NetworkMode: "none",
      IpcMode: "none",
      PidMode: "",
      UTSMode: "",
      UsernsMode: "",
      CgroupnsMode: "private",
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      Memory: resources.memory_bytes,
      MemorySwap: resources.memory_bytes,
      NanoCpus: 1_000_000_000,
      PidsLimit: resources.processes,
      Runtime: "runc",
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      LogConfig: { Type: "none", Config: {} },
      PublishAllPorts: false,
      AutoRemove: false,
      Init: false,
      OomKillDisable: false,
      CpuQuota: 0,
      CpuPeriod: 0,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16777216,nr_inodes=1024,mode=1777" },
      SecurityOpt: ["no-new-privileges=true", "seccomp=builtin", "apparmor=docker-default"],
      Ulimits: [
        { Name: "core", Soft: 0, Hard: 0 },
        { Name: "cpu", Soft: resources.cpu_seconds, Hard: resources.cpu_seconds },
        { Name: "fsize", Soft: resources.file_bytes, Hard: resources.file_bytes },
        { Name: "nofile", Soft: 64, Hard: 64 },
        { Name: "memlock", Soft: 0, Hard: 0 },
      ],
      Mounts: [
        {
          Type: "bind",
          Source: share,
          Target: "/input",
          ReadOnly: true,
          BindOptions: { NonRecursive: true },
        },
      ],
      MaskedPaths: ["/proc/kcore", "/proc/keys", "/sys/firmware"],
      ReadonlyPaths: ["/proc/sys", "/proc/sysrq-trigger"],
    } satisfies Record<string, unknown>,
    Mounts: [
      { Type: "bind", Source: share, Destination: "/input", RW: false, Propagation: "rprivate" },
    ],
    State: { Status: "created", Running: false, StartedAt: "0001-01-01T00:00:00Z", ExitCode: 0 },
  };
  const calls: string[][] = [];
  let exists = options.collision ?? false;
  const response = (
    stdout = "",
    patch: Partial<OrdinaryApplicationDockerResponse> = {}
  ): OrdinaryApplicationDockerResponse => ({
    exit_code: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    terminated: true,
    failure: null,
    ...patch,
  });
  const runner: OrdinaryApplicationDockerRunner = async (cmd) => {
    const args = [...cmd.argv.slice(4)];
    calls.push(args);
    expect(cmd.executable).toBe(f.config.docker.path);
    expect(cmd.argv.slice(0, 4)).toEqual([
      "--config",
      path.join(path.dirname(share), "docker-config"),
      "--host",
      `unix://${f.config.daemon_socket}`,
    ]);
    if (args[0] === "image")
      return response(
        canonicalJson({
          Id: f.config.images.node,
          Os: "linux",
          Config: { Env: options.imageEnv === undefined ? [] : options.imageEnv },
        })
      );
    if (args[1] === "ls") return response(exists ? `${id}\n` : "");
    if (args[1] === "create") {
      exists = true;
      expect(args).toContain("--pull=never");
      expect(args).toContain("--init=false");
      expect(args).toContain(`type=bind,src=${share},dst=/input,readonly,bind-recursive=disabled`);
      if (options.crash === "create") throw new Error("lost create response");
      return response(options.malformedCreate ? "lost" : `${id}\n`);
    }
    if (args[1] === "inspect") {
      options.tamper?.(object);
      return response(canonicalJson(object));
    }
    if (args[1] === "start") {
      object.State = {
        Status: "running",
        Running: true,
        StartedAt: "2026-01-01T00:00:00Z",
        ExitCode: 0,
      };
      if (options.crash === "start") throw new Error("lost runner");
      object.State.Running = false;
      object.State.Status = "exited";
      return response("safe", { terminated: !options.staleTransport });
    }
    if (args[1] === "kill") {
      object.State.Running = false;
      object.State.Status = "exited";
      return response(`${id}\n`);
    }
    if (args[1] === "rm") {
      if (options.crash === "rm") throw new Error("cleanup unavailable");
      exists = options.removeRemains ?? false;
      return response(`${id}\n`);
    }
    throw new Error("Unexpected command");
  };
  return { runner, calls, share, name };
}
it("completes the configured Docker branch without VM preflight, KVM, guest assets or VM config", async () => {
  const f = fixture();
  const fake = oracle(f);
  const vmRun = vi.fn(() => {
    throw new Error("VM transport is forbidden");
  });
  nativeFileReads.length = 0;
  const result = await createOrdinaryApplicationTestRuntime({
    authority: f.authority,
    runtime: f.config,
    runner: { run: vmRun },
    dockerRunner: fake.runner,
  }).run(f.request, f.owner);
  expect(result).toMatchObject({
    status: "completed",
    execution: "RUN",
    isolation: "CONTAINER",
    cleanup: "proved",
  });
  expect(fake.calls.some((args) => args[1] === "start")).toBe(true);
  expect(vmRun).not.toHaveBeenCalled();
  expect(nativeFileReads.length).toBeGreaterThan(0);
  expect(
    nativeFileReads.every(
      (file) =>
        file.startsWith(f.config.workspace_parent + path.sep) ||
        file === f.config.workspace_parent ||
        file === f.config.docker.path ||
        file === f.config.daemon_socket
    )
  ).toBe(true);
});
it("denies genuine legacy VM plan/policy on Docker rather than converting consent or running unconfined", async () => {
  const f = fixture();
  const { operation_timeout_seconds, ...common } = f.plan.resources;
  const resources = { ...common, vm_timeout_seconds: operation_timeout_seconds };
  const plan = {
    ...f.plan,
    schema_id: "penny.sca-ordinary-application-plan.v1",
    schema_version: 1,
    resources,
  };
  validateContract(OrdinaryApplicationTestPlanSchema, plan, "Genuine legacy plan");
  const planRef = f.persist("sca-execution-plan", canonicalJson(plan), plan.schema_id, 1);
  const policy = {
    ...f.policy,
    schema_id: "penny.sca-ordinary-application-policy.v1",
    schema_version: 1,
    isolation: "vm",
    profile: "qemu-kvm-nicless-v1",
    maxima: resources,
    allowed_plan_sha256: [planRef.content_digest],
  };
  validateContract(OrdinaryApplicationTestPolicySchema, policy, "Genuine legacy policy");
  const policyRef = f.persist("sca-execution-policy", canonicalJson(policy), policy.schema_id, 1);
  f.request.execution_plan_ref = planRef;
  f.request.policy_ref = policyRef;
  f.authority.admitted_policy_refs = [policyRef];
  const fake = oracle(f);
  expect(await f.run(fake.runner)).toMatchObject({
    status: "denied",
    execution: "NOT RUN",
    acceptance: "not_submitted",
    reason: "policy_denied",
  });
  expect(fake.calls).toEqual([]);
  expect(f.events).toEqual([]);
});
it("labels Docker CONTAINER and preserves legacy VM options without silently falling back", async () => {
  const f = fixture();
  const fake = oracle(f);
  const result = await f.run(fake.runner);
  expect(result).toMatchObject({
    status: "completed",
    execution: "RUN",
    passed: true,
    isolation: "CONTAINER",
    cleanup: "proved",
    quarantine_required: false,
  });
  expect(f.events).toContainEqual({ submission_guard: fake.name });
  expect(f.events).toContainEqual({ accepted: fake.name });
  expect(existsSync(fake.share)).toBe(false);
  expect(recoverOrdinaryApplicationTest(f.request, Buffer.from(canonicalJson(result)))).toEqual(
    result
  );
  const again = await f.run(fake.runner);
  expect(again).toMatchObject({
    status: "incomplete",
    reason: "recovery_requires_exact_cache",
    quarantine_required: true,
  });
  expect(fake.calls.filter((args) => args[1] === "create")).toHaveLength(1);
});
it.each([
  "Privileged",
  "ReadonlyRootfs",
  "Memory",
  "MemorySwap",
  "NanoCpus",
  "PidsLimit",
  "NetworkMode",
  "PidMode",
  "IpcMode",
  "CgroupnsMode",
  "Init",
  "OomKillDisable",
])("rejects daemon policy drift %s before start, not just argv", async (key) => {
  const f = fixture();
  const fake = oracle(f, {
    tamper(object) {
      object.HostConfig[key] = "unsafe-drift";
    },
  });
  const result = await f.run(fake.runner);
  expect(result.status).toBe("incomplete");
  expect(fake.calls.some((args) => args[1] === "start")).toBe(false);
  expect(result.cleanup).toBe("proved");
});
it.each([
  "caps",
  "seccomp",
  "device",
  "mount",
  "recursive",
  "pathmask",
  "ports",
  "network",
  "apparmor",
  "entrypoint",
  "user",
])("rejects unsafe actual Docker %s", async (mode) => {
  const f = fixture();
  const fake = oracle(f, {
    tamper(object) {
      if (mode === "caps") object.HostConfig.CapAdd = ["SYS_ADMIN"];
      if (mode === "seccomp") object.HostConfig.SecurityOpt = ["seccomp=unconfined"];
      if (mode === "device") object.HostConfig.Devices = [{ PathOnHost: "/dev/kvm" }];
      if (mode === "mount")
        object.Mounts.push({ Type: "bind", Source: "/", Destination: "/host", RW: true });
      if (mode === "recursive") object.HostConfig.Mounts = [];
      if (mode === "pathmask") object.HostConfig.MaskedPaths = [];
      if (mode === "ports") object.HostConfig.PortBindings = { "1/tcp": [{ HostPort: "1" }] };
      if (mode === "network") object.NetworkSettings.Networks = { bridge: {} };
      if (mode === "apparmor") object.AppArmorProfile = "unconfined";
      if (mode === "entrypoint") object.Config.Entrypoint = ["/bin/sh"];
      if (mode === "user") object.Config.User = "0";
    },
  });
  const result = await f.run(fake.runner);
  expect(result.status).toBe("incomplete");
  expect(fake.calls.some((a) => a[1] === "start")).toBe(false);
  expect(result.cleanup).toBe("proved");
});
it.each(["create", "start", "rm"] as const)(
  "handles %s runner crash with conservative acceptance and cleanup truth",
  async (crash) => {
    const f = fixture();
    const fake = oracle(f, { crash });
    const result = await f.run(fake.runner);
    expect(result).toMatchObject({
      status: "incomplete",
      execution: "UNKNOWN",
      cleanup: crash === "start" ? "proved" : "unproved",
      quarantine_required: crash !== "start",
    });
    if (crash !== "start") {
      expect(result.retained_workspace).toBe(path.dirname(fake.share));
      expect(existsSync(fake.share)).toBe(true);
    } else expect(fake.calls.some((a) => a[1] === "kill")).toBe(true);
  }
);
it.each([
  { malformedCreate: true },
  { staleTransport: true },
  { removeRemains: true },
  { foreign: true },
  { collision: true },
])("never fabricates cleanup/ownership from conflicting evidence %j", async (mode) => {
  const f = fixture();
  const fake = oracle(f, mode);
  const result = await f.run(fake.runner);
  expect(result.status).toBe("incomplete");
  expect(result.execution).toBe("UNKNOWN");
  if (mode.foreign || mode.collision) {
    expect(fake.calls.some((a) => a[1] === "kill" || a[1] === "rm")).toBe(false);
    expect(result.quarantine_required).toBe(true);
  }
  if (mode.malformedCreate || mode.removeRemains) expect(result.cleanup).toBe("unproved");
});
it("requires every exact operand and rejects widening, substituted policy and cross-backend consent", async () => {
  for (const mode of ["closure", "policy", "digest", "profile", "legacy", "resource"]) {
    const f = fixture({
      mutatePolicy(p) {
        return mode === "profile"
          ? { ...p, profile: "qemu-kvm-nicless-v1" }
          : mode === "legacy"
            ? {
                ...p,
                schema_id: "penny.sca-ordinary-application-policy.v1",
                schema_version: 1,
                isolation: "vm",
                profile: "qemu-kvm-nicless-v1",
              }
            : mode === "resource"
              ? { ...p, maxima: { ...p.maxima, memory_bytes: p.maxima.memory_bytes - 1 } }
              : p;
      },
    });
    if (mode === "closure") f.closure.delete(f.plan.harness_ref.artifact_id);
    if (mode === "policy") f.authority.admitted_policy_refs = [f.plan.harness_ref];
    if (mode === "digest")
      f.request.execution_plan_ref = {
        ...f.request.execution_plan_ref,
        content_digest: "0".repeat(64),
      };
    const fake = oracle(f);
    const result = await f.run(fake.runner);
    expect(result).toMatchObject({ status: "denied", execution: "NOT RUN" });
    expect(fake.calls).toEqual([]);
  }
});
it("rejects request runtime/image/path/argv/capability selectors and host image tags", async () => {
  const f = fixture();
  const fake = oracle(f);
  const runtime = createOrdinaryApplicationTestRuntime({
    authority: f.authority,
    runtime: f.config,
    dockerRunner: fake.runner,
  });
  await expect(
    runtime.run(
      { ...f.request, image: "node:latest", argv: ["sh"], source_root: "/", capabilities: ["ALL"] },
      f.owner
    )
  ).rejects.toThrow();
  expect(() =>
    validateContract(
      OrdinaryApplicationContainerConfigSchema,
      { ...f.config, images: { node: "node:22-slim", php: null } },
      "bad image"
    )
  ).toThrow();
  expect(() =>
    validateContract(
      OrdinaryApplicationContainerConfigSchema,
      { ...f.config, isolation: "vm" },
      "bad label"
    )
  ).toThrow();
  expect(fake.calls).toEqual([]);
});
it("honors pre-cancel, pinned client drift, unavailable interpreter and fresh submission fence", async () => {
  const f = fixture();
  const fake = oracle(f);
  f.controller.abort();
  expect((await f.run(fake.runner)).execution).toBe("NOT RUN");
  expect(fake.calls).toEqual([]);
  const drift = fixture();
  chmodSync(drift.config.docker.path, 0o600);
  writeFileSync(drift.config.docker.path, "changed");
  expect((await drift.run(oracle(drift).runner)).status).toBe("unsupported");
  const missing = fixture();
  missing.config.images.node = null;
  expect((await missing.run(oracle(missing).runner)).status).toBe("unsupported");
  const fence = fixture();
  fence.owner.beforeSubmit = () => {
    throw new Error("stale fence");
  };
  const test = oracle(fence);
  expect((await fence.run(test.runner)).execution).toBe("NOT RUN");
  expect(test.calls.some((a) => a[1] === "create")).toBe(false);
});

it("cannot launder legacy VM consent through V2 artifact metadata", async () => {
  const f = fixture();
  const { operation_timeout_seconds: seconds, ...common } = f.plan.resources;
  const resources = { ...common, vm_timeout_seconds: seconds };
  const vmPlan = {
    ...f.plan,
    schema_id: "penny.sca-ordinary-application-plan.v1",
    schema_version: 1,
    resources,
  };
  const planRef = f.persist("sca-execution-plan", canonicalJson(vmPlan), f.plan.schema_id, 2);
  const vmPolicy = {
    ...f.policy,
    schema_id: "penny.sca-ordinary-application-policy.v1",
    schema_version: 1,
    isolation: "vm",
    profile: "qemu-kvm-nicless-v1",
    maxima: resources,
    allowed_plan_sha256: [planRef.content_digest],
  };
  const policyRef = f.persist(
    "sca-execution-policy",
    canonicalJson(vmPolicy),
    f.policy.schema_id,
    2
  );
  f.request.execution_plan_ref = planRef;
  f.request.policy_ref = policyRef;
  f.authority.admitted_policy_refs = [policyRef];
  const fake = oracle(f);
  expect(await f.run(fake.runner)).toMatchObject({ status: "denied", execution: "NOT RUN" });
  expect(fake.calls).toEqual([]);
});

it.each([
  { imageEnv: ["LD_PRELOAD=/image/hook.so"] },
  { imageEnv: ["NODE_OPTIONS=--import=/image/hook.mjs"] },
  { imageEnv: ["PATH=/image/bin", "NODE_VERSION=22.0.0", "JAVA_HOME=/image/java"] },
  { imageEnv: ["ARBITRARY_NEW_BENIGN_NAME=must-not-survive"] },
  { imageEnv: ["LANG=unsafe", "HOME=/image/home", "TMPDIR=/image/tmp", "HOSTNAME=image"] },
])(
  "removes every inherited image name before the loader, not just dangerous names: $imageEnv",
  async ({ imageEnv }) => {
    const f = fixture();
    const fake = oracle(f, { imageEnv });
    const result = await f.run(fake.runner);
    expect(result).toMatchObject({ status: "completed", passed: true, cleanup: "proved" });
    const create = fake.calls.find((args) => args[1] === "create");
    if (create === undefined) throw new Error("Create required");
    expect(create.filter((arg) => arg.startsWith("--env="))).toEqual([
      ...imageEnv.map((entry) => `--env=${entry.split("=")[0]}`),
      ...processEnv.map((entry) => `--env=${entry}`),
    ]);
    expect(create).not.toContain("/usr/bin/env");
  }
);
it.each([
  { label: "not an array", value: {} },
  { label: "string", value: "LD_PRELOAD=/image/hook.so" },
  { label: "non-string", value: [42] },
  { label: "missing equals", value: ["NODE_OPTIONS"] },
  { label: "empty name", value: ["=x"] },
  { label: "flag name", value: ["--privileged=x"] },
  { label: "newline name", value: ["A\nB=x"] },
  { label: "nul value", value: ["BENIGN=x\0y"] },
  { label: "duplicate", value: ["BENIGN=x", "BENIGN=y"] },
  { label: "oversized name", value: [`${"A".repeat(129)}=x`] },
  { label: "oversized entry", value: [`A=${"x".repeat(8192)}`] },
  { label: "oversized count", value: Array.from({ length: 257 }, (_, i) => `V${i}=x`) },
  {
    label: "oversized total",
    value: Array.from({ length: 9 }, (_, i) => `V${i}=${"x".repeat(8000)}`),
  },
])(
  "rejects malformed/ambiguous/beyond-budget image environment before create: $label",
  async ({ value }) => {
    const f = fixture();
    const fake = oracle(f, { imageEnv: value });
    expect(await f.run(fake.runner)).toMatchObject({
      status: "failed",
      execution: "NOT RUN",
      acceptance: "not_submitted",
    });
    expect(fake.calls.some((args) => args[1] === "create")).toBe(false);
    expect(f.events).toEqual([]);
  }
);
it.each([
  { env: [...processEnv, "LD_PRELOAD=/image/hook.so"] },
  { env: [...processEnv, "NODE_OPTIONS=--import=/image/hook.mjs"] },
  { env: [...processEnv, "ARBITRARY_NEW_BENIGN_NAME=x"] },
  { env: ["PATH=/image/bin", ...processEnv.slice(1)] },
  { env: [...processEnv, "LANG=C.UTF-8"] },
  { env: processEnv.slice(1) },
  { env: null },
  { env: {} },
])(
  "rejects any effective environment outside the exact fixed set before start: $env",
  async ({ env }) => {
    const f = fixture();
    const fake = oracle(f, {
      tamper(object) {
        object.Config.Env = env;
      },
    });
    expect(await f.run(fake.runner)).toMatchObject({
      status: "incomplete",
      execution: "UNKNOWN",
      cleanup: "proved",
      quarantine_required: false,
    });
    expect(fake.calls.some((args) => args[1] === "start")).toBe(false);
    expect(
      f.events.some((event) => typeof event === "object" && event !== null && "accepted" in event)
    ).toBe(false);
  }
);
it("accepts nullable no-image-env and order-only effective environment differences", async () => {
  const f = fixture();
  const fake = oracle(f, {
    imageEnv: null,
    tamper(object) {
      object.Config.Env = [...processEnv].reverse();
    },
  });
  expect(await f.run(fake.runner)).toMatchObject({ status: "completed", passed: true });
});
it("gives the actual Docker CLI runner an EMPTY host environment, including PATH/LANG and loader options", async () => {
  const keys = ["PATH", "LANG", "LD_PRELOAD", "NODE_OPTIONS", "ARBITRARY_NEW_BENIGN_NAME"];
  const prior = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = "must-not-forward";
  try {
    const response = await ordinaryApplicationDockerCommand({
      executable: process.execPath,
      argv: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      input: Buffer.alloc(0),
      signal: new AbortController().signal,
      timeout_ms: 5000,
      output_bytes: 1024,
    });
    expect(response).toMatchObject({ exit_code: 0, failure: null, terminated: true });
    expect(response.stderr.length).toBe(0);
    expect(response.stdout.toString()).toBe("{}");
  } finally {
    keys.forEach((key, i) => {
      const value = prior[i];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

it.each([
  { label: "empty assignment is not removal", env: [...processEnv, "NODE_VERSION="] },
  { label: "inherited value remains", env: [...processEnv, "NODE_VERSION=22"] },
  { label: "missing removal marker", env: [...processEnv] },
  { label: "duplicate removal marker", env: [...processEnv, "NODE_VERSION", "NODE_VERSION"] },
  { label: "unrequested bare marker", env: [...processEnv, "NODE_VERSION", "ANOTHER_NAME"] },
])("requires exactly the expected daemon unset markers: $label", async ({ env }) => {
  const f = fixture();
  const fake = oracle(f, {
    imageEnv: ["NODE_VERSION=22"],
    tamper(object) {
      object.Config.Env = env;
    },
  });
  expect(await f.run(fake.runner)).toMatchObject({
    status: "incomplete",
    execution: "UNKNOWN",
    cleanup: "proved",
  });
  expect(fake.calls.some((args) => args[1] === "start")).toBe(false);
});
