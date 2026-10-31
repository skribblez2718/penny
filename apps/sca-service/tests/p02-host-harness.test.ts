import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validTree,
  validSealedRuntimeTreeV1,
  verifyTree,
  verifySealedRuntimeTreeV1,
  type HostTree,
} from "../src/p02-host-tree.js";
import { scannerArguments, waitForGo } from "../src/p02-host-worker.mjs";
import { createP02HostProcessRunnerV1 } from "../src/p02-host-process-runner.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  buildP02HostArgv,
  p02HostProfileDigest,
  p02InventoryPackageFiles,
  p02HostToolPath,
  P02_HOST_REQUEST_SCHEMA,
  runP02HostCanary,
  openP02PolicyGate,
  verifyP02ReadyFile,
  verifyP02FinalControl,
  validateP02HostReceipt,
  validateP02EffectiveUnit,
  validateHostPaths,
  type P02HostRequest,
} from "../src/p02-host-harness.js";

// Only the two control metadata operands are synthetic, never the host's runtime directory.
const offlineControl = vi.hoisted(() => ({ root: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async lstat(...args: Parameters<typeof fs.lstat>) {
      const runtime = `/run/user/${String(process.getuid?.())}`;
      if (offlineControl.root !== null && (args[0] === runtime || args[0] === `${runtime}/bus`)) {
        const info = await fs.lstat(offlineControl.root);
        return args[0] === runtime ? info : Object.assign(info, { isSocket: () => true });
      }
      return fs.lstat(...args);
    },
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const hex = "a".repeat(64);
const unit = `p02-${"b".repeat(32)}.service`;
const fixture = (): P02HostRequest => ({
  kind: "canary",
  source: {
    root: "/data/source",
    files: [{ path: "sample.txt", bytes: 6, sha256: sha256("source") }],
    total_bytes: 6,
    tree_sha256: sha256(
      canonicalJson([{ path: "sample.txt", bytes: 6, sha256: sha256("source") }])
    ),
  },
  tool_runtime: { kind: "static", executable: { path: "/usr/bin/true", sha256: hex } },
  rule: { path: "/data/rule", sha256: hex },
  runtime: { path: "/usr/bin/node", sha256: hex },
  closure: [{ path: "/usr/lib/libc.so", sha256: hex }],
  deployment: { path: "/data/deployment", sha256: hex },
  controls: {
    bwrap: hex,
    systemd_run: hex,
    systemctl: hex,
    scratch_launcher: hex,
    mount: hex,
    setpriv: hex,
  },
  workspace_parent: "/private",
  protected_roots: ["/private-state"],
  profile_sha256: hex,
  limits: {
    scratch_bytes: 1048576,
    memory_bytes: 134_217_728,
    tasks: 8,
    cpu_percent: 50,
    runtime_ms: 10_000,
    output_bytes: 8192,
  },
});
const receipt = () => ({
  version: 1 as const,
  kind: "canary" as const,
  status: "passed" as const,
  nonce: hex,
  unit,
  request_sha256: hex,
  plan_sha256: hex,
  worker_sha256: hex,
  launcher_sha256: hex,
  profile_sha256: hex,
  deployment_sha256: hex,
  source_sha256: hex,
  tool_sha256: hex,
  runtime_sha256: hex,
  process: null,
  scratch_bytes: 1048576,
  rule_sha256: hex,
  output_sha256: hex,
  checks: {
    input: true as const,
    readonly: true as const,
    scratch: true as const,
    forbidden: true as const,
    network: true as const,
    namespace: true as const,
    identity: true as const,
  },
});

function inventoryFixture(): P02HostRequest {
  const files = p02InventoryPackageFiles().map((file) => ({ path: file, bytes: 1, sha256: hex }));
  return {
    ...fixture(),
    kind: "inventory",
    source_generation: { file_manifest_sha256: hex, custody_sha256: hex },
    limits: { ...fixture().limits, output_bytes: 65536 },
    tool_runtime: {
      kind: "inventory",
      same_uid_residual_ack: true,
      mount_root: "/opt/p02-inventory/node_modules",
      packages: {
        root: "/sealed/native-packages",
        files,
        total_bytes: files.length,
        tree_sha256: sha256(canonicalJson(files)),
      },
      bundle: { path: "/data/inventory-bundle", sha256: hex },
      indexer_source: { path: "/data/indexer-source", sha256: hex },
    },
  };
}

const runningPolicy = () =>
  [
    `Id=${unit}`,
    "Result=success",
    "SubState=running",
    "ActiveState=active",
    "TasksCurrent=1",
    "ExecMainStatus=0",
    "KillMode=control-group",
    "Restart=no",
    "RemainAfterExit=yes",
    `MemoryMax=${fixture().limits.memory_bytes}`,
    `TasksMax=${fixture().limits.tasks}`,
    "CPUQuotaPerSecUSec=500ms",
    "RuntimeMaxUSec=10s",
    "IPAddressDeny=any",
    `ControlGroup=/user.slice/user-1000.slice/${unit}`,
    "NoNewPrivileges=yes",
    "SendSIGKILL=yes",
  ].join("\n") + "\n";

describe("P02 two-phase gate (no host controls or scanners)", () => {
  const withScratch = async (test: (scratch: string) => Promise<void>) => {
    const scratch = await mkdtemp(path.join(tmpdir(), "p02-gate-"));
    try {
      await test(scratch);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
  const show =
    (text = runningPolicy()) =>
    async () => ({ code: 0, text });
  it("does not release scanner or inventory before the worker gate", async () => {
    const worker = await readFile(
      fileURLToPath(new URL("../src/p02-host-worker.mjs", import.meta.url)),
      "utf8"
    );
    const main = worker.slice(worker.indexOf("const main = async"));
    const gate = main.indexOf("await waitForGo(");
    expect(gate).toBeGreaterThan(0);
    for (const dispatch of [
      "await childBounded()",
      'await import("/opt/p02-inventory/worker.mjs")',
      "await runScanner(req)",
      'if (req.kind === "canary_hold")',
    ])
      expect(main.indexOf(dispatch)).toBeGreaterThan(gate);
    await withScratch(async (scratch) => {
      await expect(waitForGo(30, scratch)).rejects.toThrow("gate_timeout");
      await writeFile(path.join(scratch, "go"), "wrong\n", { mode: 0o600 });
      await expect(waitForGo(30, scratch)).rejects.toThrow("gate_file");
      await rm(path.join(scratch, "go"));
      await symlink("/etc/passwd", path.join(scratch, "go"));
      await expect(waitForGo(30, scratch)).rejects.toThrow();
    });
  });
  it("rejects forged, stale, symlink, hardlinked and permission-drifted ready files", async () => {
    await withScratch(async (scratch) => {
      const ready = path.join(scratch, "ready");
      for (const content of [`${"b".repeat(64)}\n`, `${hex}\nextra`, "forged"]) {
        await writeFile(ready, content, { mode: 0o600 });
        await expect(verifyP02ReadyFile(ready, hex)).rejects.toThrow();
        await rm(ready);
      }
      await symlink("/etc/passwd", ready);
      await expect(verifyP02ReadyFile(ready, hex)).rejects.toThrow();
      await rm(ready);
      await writeFile(ready, `${hex}\n`, { mode: 0o600 });
      expect(await verifyP02ReadyFile(ready, hex)).toBe(true);
      await link(ready, path.join(scratch, "alias"));
      await expect(verifyP02ReadyFile(ready, hex)).rejects.toThrow();
      await rm(path.join(scratch, "alias"));
      await chmod(ready, 0o644);
      await expect(verifyP02ReadyFile(ready, hex)).rejects.toThrow();
    });
  });
  it("opens go once only after two running policy observations and exact ready", async () => {
    await withScratch(async (scratch) => {
      const ready = path.join(scratch, "ready");
      await writeFile(ready, `${hex}\n`, { mode: 0o600 });
      let observations = 0;
      const result = await openP02PolicyGate(scratch, hex, unit, fixture().limits, async () => {
        observations++;
        return show()();
      });
      expect(observations).toBe(2);
      expect(result).toMatchObject({ gateOpened: true, issue: null });
      expect(await readFile(path.join(scratch, "go"), "utf8")).toBe("ok\n");
      expect((await openP02PolicyGate(scratch, hex, unit, fixture().limits, show())).issue).toBe(
        "go_preexisting"
      );

      await writeFile(path.join(scratch, "probe"), "p02-scratch", { mode: 0o600 });
      await writeFile(path.join(scratch, "receipt.json"), "{}");
      await expect(verifyP02FinalControl(scratch, "canary")).rejects.toThrow("output_shape");
      await rm(ready);
      await rm(path.join(scratch, "go"));
      await verifyP02FinalControl(scratch, "canary");
      await writeFile(path.join(scratch, "inventory.json"), "{}\n");
      await verifyP02FinalControl(scratch, "inventory");
    });
  });
  it("fails closed on policy drift, stale ready, early exit and pre-gate cancellation", async () => {
    await withScratch(async (scratch) => {
      const ready = path.join(scratch, "ready");
      await writeFile(ready, `${hex}\n`, { mode: 0o600 });
      const changed = runningPolicy().replace("IPAddressDeny=any", "IPAddressDeny=");
      let n = 0;
      const result = await openP02PolicyGate(scratch, hex, unit, fixture().limits, async () =>
        show(++n === 1 ? runningPolicy() : changed)()
      );
      expect(result.issue).toBe("policy_drift_before_gate");
      expect(result.gateOpened).toBe(false);
      expect(result.lastPolicy.length).toBeLessThan(400);
      await expect(readFile(path.join(scratch, "go"))).rejects.toThrow();
      await writeFile(ready, `${"b".repeat(64)}\n`);
      expect((await openP02PolicyGate(scratch, hex, unit, fixture().limits, show())).issue).toBe(
        "ready_invalid"
      );
      await rm(ready);
      expect(
        (
          await openP02PolicyGate(
            scratch,
            hex,
            unit,
            fixture().limits,
            show(runningPolicy().replace("SubState=running", "SubState=exited"))
          )
        ).issue
      ).toBe("exited_before_gate");
      const controller = new AbortController();
      controller.abort();
      let calls = 0;
      expect(
        (
          await openP02PolicyGate(
            scratch,
            hex,
            unit,
            fixture().limits,
            async () => {
              calls++;
              return show()();
            },
            controller.signal
          )
        ).issue
      ).toBe("cancelled_before_gate");
      expect(calls).toBe(0);
      await writeFile(ready, `${hex}\n`, { mode: 0o600 });
      const during = new AbortController();
      let checks = 0;
      const cancelled = await openP02PolicyGate(
        scratch,
        hex,
        unit,
        fixture().limits,
        async () => {
          checks++;
          if (checks === 2) during.abort();
          return show()();
        },
        during.signal
      );
      expect(cancelled.issue).toBe("cancelled_before_gate");
      expect(cancelled.gateOpened).toBe(false);
      await expect(readFile(path.join(scratch, "go"))).rejects.toThrow();
    });
  });
});

describe("P02 offline host closed boundary", () => {
  it("refuses an inventory receipt without the bound parser output", () => {
    const original = receipt();
    const value = {
      ...original,
      kind: "inventory" as const,
      process: null,
      scratch_bytes: 1048576,
      inventory_result_sha256: sha256("result"),
    };
    const signed = {
      ...value,
      output_sha256: sha256(
        canonicalJson({
          status: value.status,
          checks: value.checks,
          nonce: value.nonce,
          process: value.process,
          inventory_result_sha256: value.inventory_result_sha256,
        })
      ),
    };
    const expected = {
      version: signed.version,
      kind: signed.kind,
      nonce: signed.nonce,
      unit: signed.unit,
      request_sha256: signed.request_sha256,
      plan_sha256: signed.plan_sha256,
      worker_sha256: signed.worker_sha256,
      launcher_sha256: signed.launcher_sha256,
      profile_sha256: signed.profile_sha256,
      deployment_sha256: signed.deployment_sha256,
      source_sha256: signed.source_sha256,
      tool_sha256: signed.tool_sha256,
      runtime_sha256: signed.runtime_sha256,
      rule_sha256: signed.rule_sha256,
      scratch_bytes: signed.scratch_bytes,
    };
    expect(
      validateP02HostReceipt(Buffer.from(canonicalJson(signed) + "\n"), 65536, expected)
        .inventory_result_sha256
    ).toBe(sha256("result"));
    expect(() =>
      validateP02HostReceipt(
        Buffer.from(canonicalJson({ ...signed, inventory_result_sha256: null }) + "\n"),
        65536,
        expected
      )
    ).toThrow();
    expect(() =>
      validateP02HostReceipt(
        Buffer.from(canonicalJson({ ...signed, request_sha256: "b".repeat(64) }) + "\n"),
        65536,
        expected
      )
    ).toThrow();
  });
  it("rejects native package byte drift before any inventory launch", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "p02-inventory-closure-"));
    const root = path.join(parent, "packages");
    await mkdir(root, { mode: 0o700 });
    const files = p02InventoryPackageFiles().map((file) => ({
      path: file,
      bytes: 1,
      sha256: sha256("x"),
    }));
    try {
      const dirs = new Set(
        files.flatMap((file) =>
          file.path
            .split("/")
            .slice(0, -1)
            .map((_, i, parts) => parts.slice(0, i + 1).join("/"))
        )
      );
      for (const dir of [...dirs].sort((a, b) => a.length - b.length))
        await mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
      for (const file of files) await writeFile(path.join(root, file.path), "x", { mode: 0o400 });
      for (const dir of [...dirs].sort((a, b) => b.length - a.length))
        await chmod(path.join(root, dir), 0o500);
      await chmod(root, 0o500);
      const tree = {
        root,
        files,
        total_bytes: files.length,
        tree_sha256: sha256(canonicalJson(files)),
      };
      await verifySealedRuntimeTreeV1(tree);
      const native = files.find((file) => file.path.endsWith(".node"));
      if (native === undefined) throw Error("missing native fixture");
      await chmod(path.join(root, native.path), 0o600);
      await writeFile(path.join(root, native.path), "y");
      await expect(verifySealedRuntimeTreeV1(tree)).rejects.toThrow();
    } finally {
      await chmod(root, 0o700);
      const dirs = new Set(
        files.flatMap((file) =>
          file.path
            .split("/")
            .slice(0, -1)
            .map((_, i, parts) => parts.slice(0, i + 1).join("/"))
        )
      );
      for (const dir of dirs) await chmod(path.join(root, dir), 0o700);
      await rm(parent, { recursive: true, force: true });
    }
  });
  it("mounts only the exact inventory bundle and native package closure", () => {
    const input = inventoryFixture();
    validateHostPaths(input);
    expect(() => validateHostPaths({ ...input, source_generation: undefined })).toThrow();
    const argv = buildP02HostArgv(input, "/private/p02-a", unit);
    expect(argv).toContain("/opt/p02-inventory/worker.mjs");
    expect(argv).toContain("/opt/p02-inventory/node_modules");
    expect(argv).not.toContain("/project-root");
    expect(argv.filter((arg) => arg === "--bind")).toHaveLength(1);
    expect(argv).toContain("--unshare-net");
    expect(argv).toContain("--property=IPAddressDeny=any");
    const runtime = input.tool_runtime;
    if (runtime.kind !== "inventory") throw Error("fixture runtime");
    const changed = {
      ...input,
      tool_runtime: {
        ...runtime,
        packages: {
          ...runtime.packages,
          files: [
            ...runtime.packages.files,
            { path: "tree-sitter/extra.js", bytes: 1, sha256: hex },
          ],
        },
      },
    };
    expect(() => validateHostPaths(changed)).toThrow();
    expect(() => validateHostPaths({ ...input, kind: "semgrep_php" })).toThrow();
    expect(() =>
      validateContract(
        P02_HOST_REQUEST_SCHEMA,
        {
          ...input,
          tool_runtime: { ...runtime, mount_root: "/home/user/node_modules" },
        },
        "invalid inventory mount"
      )
    ).toThrow();
    const before = p02HostProfileDigest(input, hex, hex);
    expect(
      p02HostProfileDigest(
        {
          ...input,
          tool_runtime: { ...runtime, bundle: { ...runtime.bundle, sha256: "b".repeat(64) } },
        },
        hex,
        hex
      )
    ).not.toBe(before);
    expect(
      p02HostProfileDigest(
        {
          ...input,
          tool_runtime: {
            ...runtime,
            packages: {
              ...runtime.packages,
              files: runtime.packages.files.map((file, i) =>
                i === 0 ? { ...file, sha256: "b".repeat(64) } : file
              ),
            },
          },
        },
        hex,
        hex
      )
    ).not.toBe(before);
  });
  it("constructs fixed service and bwrap grammar without caller commands, env or extra binds", () => {
    const argv = buildP02HostArgv(fixture(), "/private/p02-a", unit);
    expect(argv).toContain("--remain-after-exit");
    expect(argv).toContain("--property=IPAddressDeny=any");
    expect(argv).toContain("--unshare-cgroup");
    expect(argv).toContain("--die-with-parent");
    expect(argv).not.toContain("--ro-bind-try");
    expect(argv.filter((arg, i) => arg === "/" && argv[i - 1] !== "--remount-ro")).toEqual([]);
    expect(argv.filter((x) => x === "--bind")).toHaveLength(1);
    expect(argv.filter((x) => x === "--ro-bind")).toHaveLength(13);
    expect(argv).toContain("/p02/p02-host-worker.mjs");
    expect(() =>
      buildP02HostArgv({ ...fixture(), kind: "arbitrary" }, "/private/p02-a", unit)
    ).toThrow();
    expect(() =>
      buildP02HostArgv({ ...fixture(), env: { SECRET: "yes" } }, "/private/p02-a", unit)
    ).toThrow();
    expect(() => buildP02HostArgv(fixture(), "/private/p02-a", "evil.service")).toThrow();
    expect(() => buildP02HostArgv(fixture(), "/private/../home", unit)).toThrow();
  });
  it("fails closed before launching on hostile paths, extra options and cancellation", async () => {
    for (const bad of [
      { ...fixture(), source: { ...fixture().source, root: "/data/../secret" } },
      { ...fixture(), source: { ...fixture().source, root: "/data/link" } },
      { ...fixture(), argv: ["/bin/sh"] },
      { ...fixture(), mounts: ["/"] },
      { ...fixture(), limits: { ...fixture().limits, tasks: 1000 } },
    ])
      await expect(runP02HostCanary(bad)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    expect((await runP02HostCanary(fixture(), controller.signal)).status).toBe("cancelled");
    await expect(
      runP02HostCanary({ ...fixture(), kind: "shell" }, controller.signal)
    ).rejects.toThrow();
  });
  it("rejects actual symlinks and changed executable bytes before any launch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "p02-host-unit-"));
    // Runtime pins cannot live under reserved /tmp; keep inert fixture bytes beside this test.
    const pins = await mkdtemp(fileURLToPath(new URL("./.p02-host-pins-", import.meta.url)));
    const launch = vi.mocked(spawn).mockImplementation(() => {
      throw Error("offline_fixture_launch_forbidden");
    });
    try {
      const source = path.join(dir, "source");
      const workspace = path.join(dir, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      offlineControl.root = workspace;
      const rule = path.join(dir, "rule");
      const link = path.join(dir, "link");
      const runtime = path.join(pins, "runtime");
      const tool = path.join(pins, "tool");
      await mkdir(source, { mode: 0o700 });
      await writeFile(path.join(source, "sample.txt"), "source", { mode: 0o400 });
      await writeFile(rule, "rule", { mode: 0o400 });
      await writeFile(runtime, "runtime", { mode: 0o600 });
      await writeFile(tool, "tool", { mode: 0o400 });
      await symlink(source, link);
      const input = validateContract(
        P02_HOST_REQUEST_SCHEMA,
        {
          ...fixture(),
          workspace_parent: workspace,
          source: { ...fixture().source, root: source },
          rule: { path: rule, sha256: sha256("rule") },
          runtime: { path: runtime, sha256: sha256("runtime") },
          tool_runtime: { kind: "static", executable: { path: tool, sha256: sha256("tool") } },
          closure: [],
          deployment: { path: path.join(dir, "absent-deployment"), sha256: hex },
        },
        "offline host pin fixture"
      );
      validateHostPaths(input);
      await verifyTree(input.source);
      expect(sha256(await readFile(runtime))).toBe(input.runtime.sha256);
      expect((await lstat(workspace)).mode & 0o777).toBe(0o700);
      // Correct pins pass through runtime verification, then stop at our absent deployment.
      await expect(runP02HostCanary(input)).rejects.toThrow(/^p02_host_path$/u);
      await expect(
        runP02HostCanary({ ...input, source: { ...input.source, root: link } })
      ).rejects.toThrow(/^p02_host_tree_directory$/u);
      // Change only the pinned runtime's bytes, leaving the validated request unchanged.
      await writeFile(runtime, "changed-runtime");
      await expect(runP02HostCanary(input)).rejects.toThrow(/^p02_host_drift$/u);
      await writeFile(runtime, "runtime");
      await expect(runP02HostCanary(input)).rejects.toThrow(/^p02_host_path$/u);
      expect(launch).not.toHaveBeenCalled();
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      offlineControl.root = null;
      launch.mockRestore();
      await rm(pins, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("binds profile to worker, launcher, limits and closure", () => {
    const base = p02HostProfileDigest(fixture(), hex, hex);
    expect(p02HostProfileDigest({ ...fixture(), kind: "gitleaks" }, hex, hex)).not.toBe(base);
    expect(
      p02HostProfileDigest({ ...fixture(), workspace_parent: "/different-workspace" }, hex, hex)
    ).not.toBe(base);
    expect(
      p02HostProfileDigest(
        { ...fixture(), deployment: { ...fixture().deployment, sha256: "b".repeat(64) } },
        hex,
        hex
      )
    ).not.toBe(base);
    expect(
      p02HostProfileDigest(
        {
          ...fixture(),
          source: { ...fixture().source, root: "/data/other" },
          rule: { ...fixture().rule, path: "/data/other-rule" },
        },
        hex,
        hex
      )
    ).toBe(base);
    expect(
      p02HostProfileDigest({ ...fixture(), limits: { ...fixture().limits, tasks: 9 } }, hex, hex)
    ).not.toBe(base);
    expect(p02HostProfileDigest(fixture(), "b".repeat(64), hex)).not.toBe(base);
    expect(
      p02HostProfileDigest({ ...fixture(), protected_roots: ["/different-state"] }, hex, hex)
    ).not.toBe(base);
    expect(
      p02HostProfileDigest(
        { ...fixture(), runtime: { path: "/usr/local/bin/node", sha256: hex } },
        hex,
        hex
      )
    ).not.toBe(base);
    expect(p02HostProfileDigest(fixture(), hex, "b".repeat(64))).not.toBe(base);
    expect(
      p02HostProfileDigest(
        { ...fixture(), closure: [{ path: "/usr/lib/libc.so", sha256: "b".repeat(64) }] },
        hex,
        hex
      )
    ).not.toBe(base);
  });
  it("rejects forged unit/cgroup, weakened properties, and duplicate properties", () => {
    const text = [
      `Id=${unit}`,
      "Result=success",
      "SubState=exited",
      "ActiveState=active",
      "TasksCurrent=0",
      "ExecMainStatus=0",
      "KillMode=control-group",
      "Restart=no",
      "RemainAfterExit=yes",
      `MemoryMax=${fixture().limits.memory_bytes}`,
      `TasksMax=${fixture().limits.tasks}`,
      "CPUQuotaPerSecUSec=500ms",
      "RuntimeMaxUSec=10s",
      "IPAddressDeny=any",
      `ControlGroup=/user.slice/user-1000.slice/${unit}`,
      "NoNewPrivileges=yes",
      "SendSIGKILL=yes",
    ].join("\n");
    const check = (value: string) => validateP02EffectiveUnit(value, unit, fixture().limits);
    expect(check(text)).toBe(true);
    for (const changed of [
      text.replace(`/${unit}`, "/evil.service"),
      text.replace("IPAddressDeny=any", "IPAddressDeny="),
      text.replace("TasksMax=8", "TasksMax=32"),
      text.replace("TasksCurrent=0", "TasksCurrent=1"),
      text.replace(`Id=${unit}`, "Id=evil.service"),
      text + "\nId=" + unit,
    ])
      expect(check(changed)).toBe(false);
  });
  it("rejects truncation, forged digest, wrong nonce/unit and extra receipt fields", () => {
    const raw = receipt();
    const r = {
      ...raw,
      output_sha256: sha256(
        canonicalJson({
          status: raw.status,
          checks: raw.checks,
          nonce: raw.nonce,
          process: raw.process,
        })
      ),
    };
    const {
      status: _status,
      checks: _checks,
      output_sha256: _output,
      process: _process,
      ...expected
    } = r;
    void _status;
    void _checks;
    void _output;
    void _process;
    const check = (candidate: unknown, max = 8192) =>
      validateP02HostReceipt(Buffer.from(canonicalJson(candidate) + "\n"), max, expected);
    expect(check(r)).toEqual(r);
    expect(() =>
      validateP02HostReceipt(Buffer.from(JSON.stringify(r) + "\n"), 8192, expected)
    ).toThrow();
    expect(() => check({ ...r, output_sha256: hex })).toThrow();
    expect(() => check({ ...r, unit: "p02-" + "c".repeat(32) + ".service" })).toThrow();
    expect(() => check({ ...r, nonce: "c".repeat(64) })).toThrow();
    expect(() => check({ ...r, checks: { ...r.checks, identity: false } })).toThrow();
    expect(() => check({ ...r, extra: true })).toThrow();
    expect(() => check(r, 20)).toThrow();
    const forged = {
      ...r,
      process: {
        schema_id: "penny.sca-process-result.v1",
        schema_version: 1,
        request_sha256: hex,
        status: "succeeded",
        exit_code: 0,
        signal: null,
        stdout: "secret",
        stderr: "",
        stdout_sha256: hex,
        stderr_sha256: sha256(""),
        stdout_bytes: 6,
        stderr_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        failure_code: "none",
      },
    };
    expect(() =>
      check({
        ...forged,
        output_sha256: sha256(
          canonicalJson({
            status: r.status,
            checks: r.checks,
            nonce: r.nonce,
            process: forged.process,
          })
        ),
      })
    ).toThrow();
    const stream = "x".repeat(4097);
    const scanner = {
      ...r,
      kind: "gitleaks" as const,
      process: {
        ...forged.process,
        request_sha256: sha256(
          canonicalJson({ plan_sha256: r.plan_sha256, nonce: r.nonce, kind: "gitleaks" })
        ),
        stdout: stream,
        stdout_sha256: sha256(stream),
        stdout_bytes: Buffer.byteLength(stream),
        stdout_truncated: true,
        status: "output_limit",
        failure_code: "output_limit",
      },
    };
    const oversized = {
      ...scanner,
      output_sha256: sha256(
        canonicalJson({
          status: scanner.status,
          checks: scanner.checks,
          nonce: scanner.nonce,
          process: scanner.process,
        })
      ),
    };
    expect(() =>
      validateP02HostReceipt(Buffer.from(canonicalJson(oversized) + "\n"), 65536, {
        ...expected,
        kind: "gitleaks",
      })
    ).toThrow("p02_host_process_receipt");
    expect(() => validateP02HostReceipt(Buffer.from('{"version":1'), 8192, expected)).toThrow();
  });
});

describe("scanner closure and tree rejection (non-live)", () => {
  it("keeps the two exact adapter argument suffixes without caller argv", () => {
    expect(scannerArguments("semgrep_php")).toEqual(scannerArguments("semgrep_js_ts"));
    expect(scannerArguments("semgrep_php")).toEqual([
      "scan",
      "--json",
      "--error",
      "--metrics=off",
      "--disable-version-check",
      "--no-git-ignore",
      "--x-ignore-semgrepignore-files",
      "--no-rewrite-rule-ids",
      "--config",
      "/input/rule",
      "--",
      ".",
    ]);
    expect(scannerArguments("gitleaks")).toEqual([
      "dir",
      ".",
      "--config",
      "/input/rule",
      "--no-banner",
      "--redact",
      "--report-format",
      "json",
      "--report-path",
      "-",
      "--exit-code",
      "1",
    ]);
    expect(() => {
      Reflect.apply(scannerArguments, undefined, ["shell"]);
    }).toThrow();
  });
  it("rejects canonical collisions, traversal and counts without starting a service", () => {
    for (const paths of [["a/../b"], ["A/x", "a/y"], ["a", "a"], ["/root/x"]]) {
      const files = paths.map((p) => ({ path: p, bytes: 1, sha256: sha256("x") }));
      expect(() =>
        validTree({
          root: "/private/input",
          files,
          total_bytes: files.length,
          tree_sha256: sha256(canonicalJson(files)),
        })
      ).toThrow();
    }
  });
  it("rejects symlinks, extras, mutated files and hard links in a private tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "p02-tree-"));
    const file = path.join(root, "a");
    const files = [{ path: "a", bytes: 1, sha256: sha256("x") }];
    const tree: HostTree = {
      root,
      files,
      total_bytes: 1,
      tree_sha256: sha256(canonicalJson(files)),
    };
    try {
      await writeFile(file, "x", { mode: 0o400 });
      await verifyTree(tree);
      await writeFile(path.join(root, "extra"), "x");
      await expect(verifyTree(tree)).rejects.toThrow();
      await rm(path.join(root, "extra"));
      await chmod(file, 0o600);
      await writeFile(file, "y");
      await expect(verifyTree(tree)).rejects.toThrow();
      await rm(file);
      await symlink("/etc/passwd", file);
      await expect(verifyTree(tree)).rejects.toThrow();
      await rm(file);
      await writeFile(file, "x");
      await (await import("node:fs/promises")).link(file, path.join(root, "other"));
      await expect(verifyTree(tree)).rejects.toThrow();
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects sealed manifest drift and runtime-root overlap before dispatch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "p02-runtime-"));
    const files = [{ path: "bin/tool", bytes: 1, sha256: sha256("x") }];
    const tree: HostTree = {
      root,
      files,
      total_bytes: 1,
      tree_sha256: sha256(canonicalJson(files)),
    };
    try {
      await mkdir(path.join(root, "bin"), { mode: 0o700 });
      await writeFile(path.join(root, "bin/tool"), "y", { mode: 0o444 });
      await chmod(root, 0o555);
      await expect(verifySealedRuntimeTreeV1(tree)).rejects.toThrow();
      const plan: P02HostRequest = {
        ...fixture(),
        kind: "semgrep_php",
        limits: { ...fixture().limits, output_bytes: 65536 },
        tool_runtime: {
          kind: "sealed",
          tree: { ...tree, root: fixture().source.root },
          mount_root: "/home/runner/.pyenv/versions/1.168.0",
          executable: "bin/tool",
          executable_sha256: sha256("x"),
          tool_version: "1.168.0",
          same_uid_residual_ack: true,
        },
      };
      expect(() => validateHostPaths(plan)).toThrow("p02_host_runtime_path");
      if (plan.tool_runtime.kind !== "sealed") throw Error("expected sealed fixture");
      const sealed = plan.tool_runtime;
      expect(() =>
        validateHostPaths({
          ...plan,
          tool_runtime: {
            ...sealed,
            kind: "sealed",
            tree: { ...tree, root: "/private-state/runtime" },
          },
        })
      ).toThrow("p02_host_runtime_path");
      await expect(runP02HostCanary(plan)).rejects.toThrow();
    } finally {
      await chmod(root, 0o700);
      await chmod(path.join(root, "bin"), 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("accepts the large sealed manifest structurally but not as source", () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      path: `lib/${String(i).padStart(4, "0")}`,
      bytes: i === 0 ? 300 * 1024 * 1024 : 1,
      sha256: hex,
    }));
    const tree = {
      root: "/sealed/closure",
      files,
      total_bytes: 300 * 1024 * 1024 + 299,
      tree_sha256: sha256(canonicalJson(files)),
    };
    expect(() => validSealedRuntimeTreeV1(tree)).not.toThrow();
    expect(() => validTree(tree)).toThrow();
    const oversizedFile = [{ path: "large", bytes: 536_870_913, sha256: hex }];
    expect(() =>
      validSealedRuntimeTreeV1({
        root: tree.root,
        files: oversizedFile,
        total_bytes: oversizedFile[0].bytes,
        tree_sha256: sha256(canonicalJson(oversizedFile)),
      })
    ).toThrow();
    const oversizedManifest = Array.from({ length: 2300 }, (_, i) => ({
      path: `${String(i).padStart(4, "0")}-${"x".repeat(3900)}`,
      bytes: 1,
      sha256: hex,
    }));
    expect(() =>
      validSealedRuntimeTreeV1({
        root: tree.root,
        files: oversizedManifest,
        total_bytes: oversizedManifest.length,
        tree_sha256: sha256(canonicalJson(oversizedManifest)),
      })
    ).toThrow("p02_host_tree_limit");
    expect(() =>
      validateContract(
        P02_HOST_REQUEST_SCHEMA,
        {
          ...fixture(),
          tool_runtime: {
            kind: "sealed",
            tree,
            mount_root: "/home/runner/.pyenv/versions/semgrep-1.168.0",
            executable: files[0].path,
            executable_sha256: hex,
            tool_version: "1.168.0",
            same_uid_residual_ack: true,
          },
        },
        "runtime plan"
      )
    ).not.toThrow();
  });
  it("keeps private host root distinct from exact sandbox mount and binds both in profile", () => {
    const source = fixture();
    const files = [{ path: "bin/semgrep", bytes: 1, sha256: hex }];
    const tree = {
      root: "/sealed/closure",
      files,
      total_bytes: 1,
      tree_sha256: sha256(canonicalJson(files)),
    };
    const tool_runtime = {
      kind: "sealed" as const,
      tree,
      mount_root: "/home/runner/.pyenv/versions/semgrep-1.168.0",
      executable: "bin/semgrep",
      executable_sha256: hex,
      tool_version: "1.168.0" as const,
      same_uid_residual_ack: true as const,
    };
    const plan = {
      ...source,
      kind: "semgrep_php" as const,
      limits: { ...source.limits, output_bytes: 65536 },
      protected_roots: ["/private-state", "/home/runner"],
      tool_runtime,
    };
    expect(() => validateHostPaths(plan)).not.toThrow();
    const argv = buildP02HostArgv(plan, "/private/p02-a", unit);
    const i = argv.indexOf(tree.root);
    expect(argv.slice(i - 1, i + 2)).toEqual(["--ro-bind", tree.root, tool_runtime.mount_root]);
    expect(
      argv.some((arg, index) => arg === "--ro-bind" && argv[index + 2] === "/home/runner")
    ).toBe(false);
    expect(p02HostToolPath(tool_runtime)).toEqual({
      path: "/home/runner/.pyenv/versions/semgrep-1.168.0/bin/semgrep",
      sha256: hex,
    });
    const base = p02HostProfileDigest(plan, hex, hex);
    expect(
      p02HostProfileDigest(
        {
          ...plan,
          tool_runtime: {
            ...tool_runtime,
            mount_root: "/home/runner/.pyenv/versions/other",
          },
        },
        hex,
        hex
      )
    ).not.toBe(base);
    expect(
      p02HostProfileDigest(
        {
          ...plan,
          tool_runtime: {
            ...tool_runtime,
            tree: { ...tree, root: "/sealed/other" },
          },
        },
        hex,
        hex
      )
    ).not.toBe(base);
    expect(
      p02HostProfileDigest(
        {
          ...plan,
          tool_runtime: {
            ...tool_runtime,
            tree: { ...tree, tree_sha256: "b".repeat(64) },
          },
        },
        hex,
        hex
      )
    ).not.toBe(base);
    for (const mount_root of [
      "/",
      "/home",
      "/home/runner",
      "/home/runner/.pyenv",
      "/sealed/closure",
      "/data/source",
      "/private-state/other",
      "/input/source",
      "/input",
      "/p02",
      "/scratch",
      "/proc",
      "/sys",
      "/dev",
      "/run",
      "/tmp",
      "/var",
      "/usr/bin",
      "/usr/bin/node",
      "/data/rule",
      "/data/deployment",
      "/home/runner/project/../bad",
    ]) {
      expect(() =>
        validateHostPaths({ ...plan, tool_runtime: { ...tool_runtime, mount_root } })
      ).toThrow("p02_host_runtime_path");
    }
    expect(() =>
      validateHostPaths({
        ...plan,
        tool_runtime: {
          ...tool_runtime,
          tree: { ...tree, root: "/private-state/closure" },
        },
      })
    ).toThrow();
  });
  it("rejects sealed runtime byte and permission drift without running it", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "p02-sealed-parent-"));
    const root = path.join(parent, "closure");
    const files = [{ path: "bin/tool", bytes: 1, sha256: sha256("x") }];
    const tree = { root, files, total_bytes: 1, tree_sha256: sha256(canonicalJson(files)) };
    try {
      await mkdir(path.join(root, "bin"), { recursive: true, mode: 0o700 });
      const executable = path.join(root, "bin/tool");
      await writeFile(executable, "x", { mode: 0o444 });
      await chmod(path.join(root, "bin"), 0o555);
      await chmod(root, 0o555);
      await verifySealedRuntimeTreeV1(tree);
      await chmod(executable, 0o644);
      await expect(verifySealedRuntimeTreeV1(tree)).rejects.toThrow();
      await chmod(executable, 0o644);
      await writeFile(executable, "y");
      await chmod(executable, 0o444);
      await expect(verifySealedRuntimeTreeV1(tree)).rejects.toThrow();
    } finally {
      await chmod(root, 0o700);
      await chmod(path.join(root, "bin"), 0o700);
      await rm(parent, { recursive: true, force: true });
    }
  });
  it("uses the mount-root executable when validating a controlled runner", async () => {
    const base = fixture();
    const files = [{ path: "bin/semgrep", bytes: 1, sha256: hex }];
    const plan = {
      ...base,
      kind: "semgrep_php" as const,
      limits: { ...base.limits, output_bytes: 65536 },
      tool_runtime: {
        kind: "sealed" as const,
        tree: {
          root: "/sealed/closure",
          files,
          total_bytes: 1,
          tree_sha256: sha256(canonicalJson(files)),
        },
        mount_root: "/home/runner/.pyenv/versions/semgrep-1.168.0",
        executable: "bin/semgrep",
        executable_sha256: hex,
        tool_version: "1.168.0" as const,
        same_uid_residual_ack: true as const,
      },
    };
    const runner = createP02HostProcessRunnerV1(plan, "/private/scratch");
    const request = {
      schema_id: "penny.sca-process-request.v1" as const,
      schema_version: 1 as const,
      executable: path.join(plan.tool_runtime.tree.root, "bin/semgrep"),
      executable_sha256: hex,
      arguments: scannerArguments("semgrep_php").map((arg) =>
        arg === "/input/rule" ? plan.rule.path : arg
      ),
      cwd: plan.source.root,
      environment: [
        { name: "HOME", value: "/private/scratch" },
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
        { name: "SEMGREP_SEND_METRICS", value: "off" },
      ],
      timeout_ms: 9500,
      max_stdout_bytes: 4096,
      max_stderr_bytes: 4096,
    };
    await expect(runner.run(request)).rejects.toThrow("p02_process_plan_mismatch");
    // The mounted path passes the executable gate; the absent offline rule stops it before dispatch.
    await expect(
      runner.run({ ...request, executable: p02HostToolPath(plan.tool_runtime).path })
    ).rejects.toThrow("ENOENT");
  });
  it("rejects process plan mismatch without launching a service", async () => {
    const plan = {
      ...fixture(),
      kind: "gitleaks",
      limits: { ...fixture().limits, output_bytes: 65536 },
    };
    const runner = createP02HostProcessRunnerV1(plan, "/private/scratch");
    await expect(
      runner.run({
        schema_id: "penny.sca-process-request.v1",
        schema_version: 1,
        executable: "/bin/sh",
        executable_sha256: hex,
        arguments: ["-c", "echo"],
        cwd: plan.source.root,
        environment: [],
        timeout_ms: 9500,
        max_stdout_bytes: 1024,
        max_stderr_bytes: 1024,
      })
    ).rejects.toThrow("p02_process_plan_mismatch");
  });
});

describe.skipIf(process.env.PENNY_P02_HOST_LIVE !== "1")("P02 gated live canary", () => {
  it("runs only with explicitly supplied offline closure and can be cancelled", async () => {
    const configPath = process.env.PENNY_P02_HOST_CONFIG;
    if (!configPath) throw new Error("PENNY_P02_HOST_CONFIG required");
    const input: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (input === null || typeof input !== "object" || !("runtime" in input))
      throw new Error("invalid fixture");
    // A formal collector must supply an actual verified deployment pin and complete ELF closure.
    const worker = fileURLToPath(new URL("../src/p02-host-worker.mjs", import.meta.url));
    const launcher = fileURLToPath(new URL("../src/p02-host-harness.ts", import.meta.url));
    const source = await readFile(worker);
    const config = validateContract(P02_HOST_REQUEST_SCHEMA, input, "P02 live host fixture");
    // This is a one-file source tree; stale single-file fixtures are rejected by the schema.
    expect(config.source.files).toHaveLength(1);
    const request = {
      ...config,
      profile_sha256: p02HostProfileDigest(
        config,
        sha256(source),
        sha256(await readFile(launcher))
      ),
    };
    const result = await runP02HostCanary(request);
    expect(result.status).toBe("passed");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runP02HostCanary(request, controller.signal);
    expect(cancelled.status).toBe("cancelled");
    const held = { ...request, kind: "canary_hold" as const };
    held.profile_sha256 = p02HostProfileDigest(
      held,
      sha256(source),
      sha256(await readFile(launcher))
    );
    const inFlight = new AbortController();
    const timer = setTimeout(() => inFlight.abort(), 2000);
    try {
      expect((await runP02HostCanary(held, inFlight.signal)).status).toBe("cancelled");
    } finally {
      clearTimeout(timer);
    }
    const timeoutRequest = { ...held, limits: { ...held.limits, runtime_ms: 1000 } };
    timeoutRequest.profile_sha256 = p02HostProfileDigest(
      timeoutRequest,
      sha256(source),
      sha256(await readFile(launcher))
    );
    expect((await runP02HostCanary(timeoutRequest)).status).toBe("timeout");
  }, 300_000);
});
