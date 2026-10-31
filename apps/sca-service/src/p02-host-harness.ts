import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  Tree,
  SealedRuntimeTreeV1,
  validSealedRuntimeTreeV1,
  verifySealedRuntimeTreeV1,
  verifySealedSourceTree,
  type HostTree,
  validTree,
  verifyTree,
  stageTree,
  unsealStagedTree,
  exactPath,
  overlaps,
} from "./p02-host-tree.js";
import { ScaProcessResultV1Schema, type ScaProcessResultV1 } from "./process.js";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";

const SCRATCH_LAUNCHER = fileURLToPath(new URL("./p02-scratch-launcher.mjs", import.meta.url));
const MOUNT = "/usr/bin/mount";
const SETPRIV = "/usr/bin/setpriv";

const Hex = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Pin = Type.Object(
  { path: Type.String({ minLength: 1, maxLength: 4096 }), sha256: Hex },
  { additionalProperties: false }
);
const InventoryRuntime = Type.Object(
  {
    kind: Type.Literal("inventory"),
    packages: SealedRuntimeTreeV1,
    mount_root: Type.Literal("/opt/p02-inventory/node_modules"),
    bundle: Pin,
    indexer_source: Pin,
    same_uid_residual_ack: Type.Literal(true),
  },
  { additionalProperties: false }
);
const ToolRuntime = Type.Union([
  InventoryRuntime,
  Type.Object({ kind: Type.Literal("static"), executable: Pin }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal("sealed"),
      tree: SealedRuntimeTreeV1,
      mount_root: Type.String({ minLength: 1, maxLength: 4096 }),
      executable: Type.String({ minLength: 1, maxLength: 4096 }),
      executable_sha256: Hex,
      tool_version: Type.Literal("1.168.0"),
      same_uid_residual_ack: Type.Literal(true),
    },
    { additionalProperties: false }
  ),
]);
const Limits = Type.Object(
  {
    memory_bytes: Type.Integer({ minimum: 67_108_864, maximum: 2_147_483_648 }),
    scratch_bytes: Type.Integer({ minimum: 4096, maximum: 2_147_483_648, multipleOf: 4096 }),
    tasks: Type.Integer({ minimum: 2, maximum: 32 }),
    cpu_percent: Type.Integer({ minimum: 1, maximum: 100 }),
    runtime_ms: Type.Integer({ minimum: 1000, maximum: 120_000 }),
    output_bytes: Type.Integer({ minimum: 1024, maximum: 65_536 }),
  },
  { additionalProperties: false }
);
export const P02_HOST_REQUEST_SCHEMA = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("inventory"),
      Type.Literal("canary"),
      Type.Literal("canary_hold"),
      Type.Literal("semgrep_php"),
      Type.Literal("semgrep_js_ts"),
      Type.Literal("gitleaks"),
    ]),
    source: Tree,
    source_generation: Type.Optional(
      Type.Object(
        { file_manifest_sha256: Hex, custody_sha256: Hex },
        { additionalProperties: false }
      )
    ),
    tool_runtime: ToolRuntime,
    rule: Pin,
    runtime: Pin,
    // Exact files only. Dynamic loader and shared libraries retain their absolute paths.
    closure: Type.Array(Pin, { maxItems: 128 }),
    deployment: Pin,
    controls: Type.Object(
      {
        bwrap: Hex,
        systemd_run: Hex,
        systemctl: Hex,
        scratch_launcher: Hex,
        mount: Hex,
        setpriv: Hex,
      },
      { additionalProperties: false }
    ),
    profile_sha256: Hex,
    workspace_parent: Type.String({ minLength: 1, maxLength: 4096 }),
    protected_roots: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
      minItems: 1,
      maxItems: 16,
    }),
    limits: Limits,
  },
  { additionalProperties: false }
);
export type P02HostRequest = Static<typeof P02_HOST_REQUEST_SCHEMA>;
const Checks = Type.Object(
  {
    input: Type.Boolean(),
    readonly: Type.Boolean(),
    scratch: Type.Boolean(),
    forbidden: Type.Boolean(),
    network: Type.Boolean(),
    namespace: Type.Boolean(),
    identity: Type.Boolean(),
  },
  { additionalProperties: false }
);
export const P02_HOST_RECEIPT_SCHEMA = Type.Object(
  {
    version: Type.Literal(1),
    kind: P02_HOST_REQUEST_SCHEMA.properties.kind,
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
    nonce: Hex,
    unit: Type.String({ pattern: "^p02-[a-f0-9]{32}\\.service$" }),
    request_sha256: Hex,
    plan_sha256: Hex,
    worker_sha256: Hex,
    launcher_sha256: Hex,
    profile_sha256: Hex,
    deployment_sha256: Hex,
    source_sha256: Hex,
    tool_sha256: Hex,
    runtime_sha256: Hex,
    process: Type.Union([ScaProcessResultV1Schema, Type.Null()]),
    inventory_result_sha256: Type.Optional(Type.Union([Hex, Type.Null()])),
    rule_sha256: Hex,
    output_sha256: Hex,
    scratch_bytes: Limits.properties.scratch_bytes,
    checks: Checks,
  },
  { additionalProperties: false }
);
export type P02HostReceipt = Static<typeof P02_HOST_RECEIPT_SCHEMA>;
export type P02HostOutcome = {
  status: "passed" | "failed" | "cancelled" | "timeout" | "unverified";
  receipt: P02HostReceipt | null;
  unit: string | null;
  issue: string | null;
  inventory_result?: unknown;
};
const WORKER = fileURLToPath(new URL("./p02-host-worker.mjs", import.meta.url));
const LAUNCHER = fileURLToPath(import.meta.url);
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SYSTEMCTL = "/usr/bin/systemctl";
const BWRAP = "/usr/bin/bwrap";
const MAX_FILE = 128 * 1024 * 1024;
const MAX_STAGE = 512 * 1024 * 1024;
/** The only package files permitted in the external native parser closure. */
export function p02InventoryPackageFiles(
  platform = process.platform,
  arch = process.arch
): readonly string[] {
  const packages = [
    "tree-sitter",
    "tree-sitter-javascript",
    "tree-sitter-php",
    "tree-sitter-typescript",
  ];
  return [
    "node-gyp-build/index.js",
    "node-gyp-build/node-gyp-build.js",
    "node-gyp-build/package.json",
    ...packages.flatMap((name) => [
      `${name}/package.json`,
      `${name}/${name === "tree-sitter" ? "index.js" : "bindings/node/index.js"}`,
      `${name}/prebuilds/${platform}-${arch}/${name}.node`,
    ]),
    "tree-sitter-javascript/src/node-types.json",
    "tree-sitter-php/php/src/node-types.json",
    "tree-sitter-php/php_only/src/node-types.json",
    "tree-sitter-typescript/typescript/src/node-types.json",
    "tree-sitter-typescript/tsx/src/node-types.json",
  ].sort();
}

function reject(message: string): never {
  throw new Error(`p02_host_${message}`);
}
function safePath(p: string): boolean {
  return exactPath(p);
}
async function pinned(pin: Static<typeof Pin>, allowSymlink = false): Promise<void> {
  if (!safePath(pin.path)) reject("path");
  const resolved = await realpath(pin.path).catch(() => "");
  if (!safePath(resolved) || (!allowSymlink && resolved !== pin.path)) reject("path");
  const lexicalBefore = await lstat(pin.path);
  const targetBefore = await lstat(resolved);
  if (
    (!lexicalBefore.isFile() && !(allowSymlink && lexicalBefore.isSymbolicLink())) ||
    !targetBefore.isFile() ||
    targetBefore.nlink !== 1 ||
    targetBefore.size > MAX_FILE ||
    targetBefore.size < 1 ||
    (targetBefore.mode & 0o002) !== 0
  )
    reject("file");
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const hash = createHash("sha256");
    const buf = Buffer.alloc(65536);
    for (let offset = 0; offset < before.size; ) {
      const { bytesRead } = await handle.read(
        buf,
        0,
        Math.min(buf.length, before.size - offset),
        offset
      );
      if (!bytesRead) reject("file");
      hash.update(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    const lexicalAfter = await lstat(pin.path);
    if (
      hash.digest("hex") !== pin.sha256 ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      lexicalBefore.ino !== lexicalAfter.ino ||
      lexicalBefore.size !== lexicalAfter.size ||
      lexicalBefore.mtimeMs !== lexicalAfter.mtimeMs ||
      (await realpath(pin.path)) !== resolved ||
      (await lstat(resolved)).ino !== before.ino
    )
      reject("drift");
  } finally {
    await handle.close();
  }
}
/** The path visible to the worker; the host tree root is never an executable path in the sandbox. */
export function p02HostToolPath(runtime: P02HostRequest["tool_runtime"]): {
  path: string;
  sha256: string;
} {
  return runtime.kind === "static"
    ? runtime.executable
    : runtime.kind === "inventory"
      ? { path: "/opt/p02-inventory/worker.mjs", sha256: runtime.bundle.sha256 }
      : {
          path: path.join(runtime.mount_root, runtime.executable),
          sha256: runtime.executable_sha256,
        };
}
export function p02HostProfileDigest(
  request: P02HostRequest,
  workerSha: string,
  launcherSha: string
): string {
  return sha256(
    canonicalJson({
      version: 1,
      kind: request.kind,
      deployment: request.deployment,
      workspace_parent: request.workspace_parent,
      limits: request.limits,
      runtime: request.runtime,
      tool_runtime: request.tool_runtime,
      protected_roots: request.protected_roots,
      closure: request.closure,
      worker: workerSha,
      launcher: launcherSha,
      bwrap: "rootless-uid0-user-pid-net-ipc-uts-cgroup-bounded-tmpfs-setpriv",
      controls: request.controls,
    })
  );
}
export async function verifyP02HostProfileV1(req: P02HostRequest): Promise<void> {
  const worker = sha256(await readFile(WORKER));
  const launcher = sha256(await readFile(LAUNCHER));
  await pinned({ path: SCRATCH_LAUNCHER, sha256: req.controls.scratch_launcher });
  if (p02HostProfileDigest(req, worker, launcher) !== req.profile_sha256) reject("profile");
}
function controlPins(req: P02HostRequest): Static<typeof Pin>[] {
  return [
    { path: BWRAP, sha256: req.controls.bwrap },
    { path: SYSTEMD_RUN, sha256: req.controls.systemd_run },
    { path: SYSTEMCTL, sha256: req.controls.systemctl },
    { path: SCRATCH_LAUNCHER, sha256: req.controls.scratch_launcher },
    { path: MOUNT, sha256: req.controls.mount },
    { path: SETPRIV, sha256: req.controls.setpriv },
  ];
}
function argsFor(request: P02HostRequest, work: string): string[] {
  const mounts = [
    request.runtime.path,
    MOUNT,
    SETPRIV,
    ...request.closure.map((x) => x.path),
    ...(request.tool_runtime.kind === "static" ? [request.tool_runtime.executable.path] : []),
  ];
  const toolMount =
    request.tool_runtime.kind === "sealed" || request.tool_runtime.kind === "inventory"
      ? request.tool_runtime.mount_root
      : null;
  const dirs = new Set<string>(["/p02", "/input", "/scratch"]);
  for (const file of [...mounts, ...(toolMount === null ? [] : [toolMount])]) {
    let dir = path.dirname(file);
    while (dir !== "/") {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  const argv = [
    "--die-with-parent",
    "--unshare-user",
    "--uid",
    "0",
    "--gid",
    "0",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CAP_SYS_ADMIN",
    "--cap-add",
    "CAP_SETPCAP",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/scratch",
    "--setenv",
    "TMPDIR",
    "/scratch",
    "--setenv",
    "LC_ALL",
    "C",
    "--hostname",
    "p02-offline",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  for (const dir of [...dirs].sort((a, b) => a.length - b.length || a.localeCompare(b)))
    argv.push("--dir", dir);
  for (const [index, file] of mounts.entries())
    argv.push("--ro-bind", path.join(work, "pins", String(index)), file);
  if (toolMount !== null && request.tool_runtime.kind === "sealed")
    argv.push("--ro-bind", request.tool_runtime.tree.root, toolMount);
  if (request.tool_runtime.kind === "inventory") {
    argv.push(
      "--ro-bind",
      request.tool_runtime.packages.root,
      request.tool_runtime.mount_root,
      "--ro-bind",
      path.join(work, "pins", "inventory"),
      "/opt/p02-inventory/worker.mjs",
      "--ro-bind",
      path.join(work, "pins", "indexer"),
      "/p02/indexer-source"
    );
  }
  argv.push(
    "--ro-bind",
    path.join(work, "pins", "worker"),
    "/p02/p02-host-worker.mjs",
    "--ro-bind",
    path.join(work, "pins", "scratch-launcher"),
    "/p02/p02-scratch-launcher.mjs",
    "--ro-bind",
    path.join(work, "pins", "launcher"),
    "/p02/launcher",
    "--ro-bind",
    path.join(work, "pins", "deployment"),
    "/p02/deployment",
    "--ro-bind",
    path.join(work, "request.json"),
    "/p02/request.json",
    "--ro-bind",
    path.join(work, "source"),
    "/input/source",
    "--ro-bind",
    path.join(work, "tree.json"),
    "/p02/tree.json",
    "--ro-bind",
    path.join(work, "pins", "rule"),
    "/input/rule",
    "--bind",
    path.join(work, "control"),
    "/p02/control",
    "--tmpfs",
    "/scratch",
    "--remount-ro",
    "/",
    "--remount-ro",
    "/dev",
    "--chdir",
    "/scratch",
    "--",
    request.runtime.path,
    "--no-warnings",
    "/p02/p02-scratch-launcher.mjs",
    String(request.limits.scratch_bytes),
    request.runtime.path,
    request.runtime.sha256,
    request.controls.scratch_launcher,
    request.controls.mount,
    request.controls.setpriv
  );
  return argv;
}
/** Pure, fixed grammar. Never accepts caller argv, env, URL, bind destinations or a shell. */
export function buildP02HostArgv(input: unknown, work: string, unit: string): readonly string[] {
  const request = validateContract(P02_HOST_REQUEST_SCHEMA, input, "P02 host request");
  validateHostPaths(request);
  if (!/^p02-[a-f0-9]{32}\.service$/.test(unit) || !safePath(work)) reject("argv");
  return [
    "--user",
    "--quiet",
    "--no-block",
    "--remain-after-exit",
    `--unit=${unit}`,
    "--property=Type=exec",
    "--property=IPAddressDeny=any",
    `--property=MemoryMax=${request.limits.memory_bytes}`,
    `--property=TasksMax=${request.limits.tasks}`,
    `--property=CPUQuota=${request.limits.cpu_percent}%`,
    `--property=RuntimeMaxSec=${Math.ceil(request.limits.runtime_ms / 1000)}s`,
    "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes",
    "--property=Restart=no",
    "--property=NoNewPrivileges=yes",
    "--property=UMask=0077",
    "--property=StandardOutput=null",
    "--property=StandardError=null",
    "--",
    BWRAP,
    ...argsFor(request, work),
  ];
}
/** Pure preflight: executable and mount destinations cannot intersect reserved or input trees. */
export function validateHostPaths(req: P02HostRequest): void {
  validTree(req.source);
  if (
    [
      req.runtime.path,
      ...req.closure.map((pin) => pin.path),
      ...(req.tool_runtime.kind === "static" ? [req.tool_runtime.executable.path] : []),
    ].some((file) => [MOUNT, SETPRIV, BWRAP, SYSTEMCTL, SYSTEMD_RUN].includes(file))
  )
    reject("control_collision");
  if (
    req.protected_roots.some((root) => !safePath(root)) ||
    !safePath(req.workspace_parent) ||
    !safePath(req.rule.path) ||
    !safePath(req.deployment.path) ||
    !safePath(req.runtime.path)
  )
    reject("path");
  const forbiddenRoots = [
    req.source.root,
    req.workspace_parent,
    path.resolve(LAUNCHER, "../../../.."),
    req.rule.path,
    req.deployment.path,
    req.runtime.path,
    MOUNT,
    SETPRIV,
    ...req.closure.map((pin) => pin.path),
    ...req.protected_roots,
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/tmp",
    "/var",
    "/p02",
    "/input",
    "/scratch",
  ];
  if (
    [
      req.workspace_parent,
      path.resolve(LAUNCHER, "../../../.."),
      req.rule.path,
      req.deployment.path,
      req.runtime.path,
      MOUNT,
      SETPRIV,
      ...req.closure.map((pin) => pin.path),
    ].some((x) => overlaps(req.source.root, x)) ||
    (req.tool_runtime.kind === "static" &&
      overlaps(req.source.root, req.tool_runtime.executable.path))
  )
    reject("source_overlap");
  if (
    ["semgrep_php", "semgrep_js_ts", "gitleaks"].includes(req.kind) &&
    req.limits.output_bytes < 65536
  )
    reject("output_limit");
  if (req.kind === "inventory" && req.source_generation === undefined)
    reject("inventory_custody_generation");
  if (
    (req.kind === "inventory" && req.tool_runtime.kind !== "inventory") ||
    (req.kind !== "inventory" && req.tool_runtime.kind === "inventory")
  )
    reject("runtime_kind");
  if (req.tool_runtime.kind === "inventory") {
    const inventory = req.tool_runtime;
    validSealedRuntimeTreeV1(inventory.packages);
    if (
      canonicalJson(inventory.packages.files.map((f) => f.path)) !==
        canonicalJson(p02InventoryPackageFiles()) ||
      forbiddenRoots.some((x) => overlaps(inventory.packages.root, x)) ||
      [
        req.source.root,
        req.workspace_parent,
        ...req.protected_roots,
        req.runtime.path,
        ...req.closure.map((x) => x.path),
      ].some((x) => overlaps(inventory.mount_root, x)) ||
      [inventory.bundle.path, inventory.indexer_source.path].some(
        (x) =>
          !safePath(x) ||
          [
            req.source.root,
            req.workspace_parent,
            ...req.protected_roots,
            inventory.packages.root,
          ].some((y) => overlaps(x, y))
      )
    )
      reject("inventory_runtime_path");
  } else if (req.tool_runtime.kind === "sealed") {
    const tool = req.tool_runtime;
    validSealedRuntimeTreeV1(tool.tree);
    const home = /^\/home\/[^/]+$/.test(tool.mount_root);
    const nestedHome = /^\/home\/[^/]+\/(?:[^/]+\/){2,}[^/]+$/.test(tool.mount_root);
    const mountDestinations = [
      "/input/source",
      "/input/rule",
      "/scratch",
      "/p02",
      req.runtime.path,
      MOUNT,
      SETPRIV,
      ...req.closure.map((pin) => pin.path),
    ];
    if (
      !safePath(tool.mount_root) ||
      tool.mount_root === "/" ||
      tool.mount_root === "/home" ||
      home ||
      (tool.mount_root.startsWith("/home/") && !nestedHome) ||
      forbiddenRoots.some((x) => overlaps(tool.tree.root, x)) ||
      overlaps(tool.tree.root, tool.mount_root) ||
      mountDestinations.some((x) => overlaps(tool.mount_root, x)) ||
      [
        req.source.root,
        req.workspace_parent,
        path.resolve(LAUNCHER, "../../../.."),
        req.rule.path,
        req.deployment.path,
        ...req.protected_roots,
      ].some(
        (x) =>
          overlaps(tool.mount_root, x) &&
          !(nestedHome && /^\/home\/[^/]+$/.test(x) && tool.mount_root.startsWith(`${x}/`))
      ) ||
      ["/proc", "/sys", "/dev", "/run", "/tmp", "/var"].some((x) => overlaps(tool.mount_root, x)) ||
      !tool.tree.files.some(
        (file) => file.path === tool.executable && file.sha256 === tool.executable_sha256
      )
    )
      reject("runtime_path");
  } else {
    const executable = req.tool_runtime.executable.path;
    if (
      !safePath(executable) ||
      [req.source.root, req.rule.path, req.deployment.path, req.workspace_parent].some((x) =>
        overlaps(x, executable)
      )
    )
      reject("runtime_path");
  }
}
function hostControlEnv(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) reject("environment");
  const runtime = `/run/user/${String(uid)}`;
  return {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  };
}

async function command(
  exe: string,
  argv: readonly string[],
  ms: number
): Promise<{ code: number | null; text: string }> {
  const child = spawn(exe, [...argv], {
    shell: false,
    env: hostControlEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 8192) child.kill("SIGKILL");
    });
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  try {
    return await new Promise((resolve, rejectPromise) => {
      child.on("error", rejectPromise);
      child.on("close", (code) => resolve({ code, text }));
    });
  } finally {
    clearTimeout(timer);
  }
}
export function validateP02HostReceipt(
  bytes: Buffer,
  max: number,
  expected: Omit<
    P02HostReceipt,
    "status" | "checks" | "output_sha256" | "process" | "inventory_result_sha256"
  >
): P02HostReceipt {
  if (bytes.length > max || bytes.length < 10) reject("output_limit");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    reject("receipt");
  }
  const receipt = validateContract(P02_HOST_RECEIPT_SCHEMA, value, "P02 host receipt");
  if (
    canonicalJson(receipt) + "\n" !== bytes.toString("utf8") ||
    canonicalJson(
      Object.fromEntries(
        Object.entries(receipt).filter(
          ([key]) =>
            !["status", "checks", "output_sha256", "process", "inventory_result_sha256"].includes(
              key
            )
        )
      )
    ) !== canonicalJson(expected)
  )
    reject("receipt");
  if (
    receipt.output_sha256 !==
    sha256(
      canonicalJson({
        status: receipt.status,
        checks: receipt.checks,
        nonce: receipt.nonce,
        process: receipt.process,
        inventory_result_sha256: receipt.inventory_result_sha256,
      })
    )
  )
    reject("receipt");
  if (
    receipt.status === "passed" &&
    ((receipt.kind !== "canary" && receipt.kind !== "inventory" && receipt.process === null) ||
      !Object.values(receipt.checks).every(Boolean))
  )
    reject("receipt");
  if (
    (receipt.kind === "canary" && receipt.process !== null) ||
    (receipt.kind === "inventory" &&
      (receipt.process !== null || receipt.inventory_result_sha256 === null)) ||
    (receipt.kind !== "inventory" && receipt.inventory_result_sha256 != null) ||
    (["semgrep_php", "semgrep_js_ts", "gitleaks"].includes(receipt.kind) &&
      receipt.process === null)
  )
    reject("process_receipt");
  if (receipt.process !== null) {
    const result: ScaProcessResultV1 = receipt.process;
    if (
      (result.failure_code === "none") !== (result.status === "succeeded") ||
      (result.status === "output_limit") !== (result.stdout_truncated || result.stderr_truncated) ||
      (result.status === "succeeded" && result.exit_code !== 0) ||
      (result.status === "nonzero_exit" && (result.exit_code === null || result.exit_code === 0)) ||
      (result.status === "timed_out" && result.failure_code !== "timeout") ||
      (result.status === "cancelled" && result.failure_code !== "cancelled") ||
      (result.status === "output_limit" && result.failure_code !== "output_limit")
    )
      reject("process_receipt");
    if (
      !(["semgrep_php", "semgrep_js_ts", "gitleaks"] as string[]).includes(receipt.kind) ||
      result.stdout_sha256 !== sha256(result.stdout) ||
      result.stderr_sha256 !== sha256(result.stderr) ||
      result.stdout_bytes !== Buffer.byteLength(result.stdout) ||
      result.stderr_bytes !== Buffer.byteLength(result.stderr) ||
      result.stdout_bytes > 4096 ||
      result.stderr_bytes > 4096 ||
      result.request_sha256 !==
        sha256(
          canonicalJson({
            plan_sha256: receipt.plan_sha256,
            nonce: receipt.nonce,
            kind: receipt.kind,
          })
        )
    )
      reject("process_receipt");
  }
  return receipt;
}
const UNIT_PROPERTY_NAMES = [
  "Id",
  "Result",
  "SubState",
  "ActiveState",
  "TasksCurrent",
  "ExecMainStatus",
  "KillMode",
  "Restart",
  "RemainAfterExit",
  "MemoryMax",
  "TasksMax",
  "CPUQuotaPerSecUSec",
  "RuntimeMaxUSec",
  "IPAddressDeny",
  "ControlGroup",
  "NoNewPrivileges",
  "SendSIGKILL",
] as const;
const UNIT_PROPERTY_QUERY = `--property=${UNIT_PROPERTY_NAMES.join(",")}`;
function unitProperties(text: string): Readonly<Record<string, string>> | null {
  const lines = text.trim().split("\n");
  if (lines.length !== UNIT_PROPERTY_NAMES.length || lines.some((line) => !line.includes("=")))
    return null;
  const props = Object.fromEntries(
    lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );
  return Object.keys(props).length === UNIT_PROPERTY_NAMES.length &&
    UNIT_PROPERTY_NAMES.every((name) => name in props)
    ? props
    : null;
}
function effectivePolicy(
  props: Readonly<Record<string, string>>,
  unit: string,
  limits: P02HostRequest["limits"]
): boolean {
  const seconds = Math.ceil(limits.runtime_ms / 1000);
  const cpuValues = [
    `${limits.cpu_percent * 10_000}us`,
    `${limits.cpu_percent * 10}ms`,
    ...(limits.cpu_percent % 100 === 0 ? [`${limits.cpu_percent / 100}s`] : []),
  ];
  return (
    props.Id === unit &&
    props.Result === "success" &&
    props.ExecMainStatus === "0" &&
    props.KillMode === "control-group" &&
    props.Restart === "no" &&
    props.RemainAfterExit === "yes" &&
    props.MemoryMax === String(limits.memory_bytes) &&
    props.TasksMax === String(limits.tasks) &&
    cpuValues.includes(props.CPUQuotaPerSecUSec ?? "") &&
    [
      `${seconds * 1_000_000}us`,
      `${seconds}s`,
      ...(seconds % 60 === 0 ? [`${seconds / 60}min`] : []),
    ].includes(props.RuntimeMaxUSec ?? "") &&
    ["any", "::/0 0.0.0.0/0", "0.0.0.0/0 ::/0"].includes(props.IPAddressDeny ?? "") &&
    props.NoNewPrivileges === "yes" &&
    props.SendSIGKILL === "yes"
  );
}
function validateP02RunningUnit(
  text: string,
  unit: string,
  limits: P02HostRequest["limits"]
): boolean {
  const props = unitProperties(text);
  if (props === null || !effectivePolicy(props, unit, limits)) return false;
  const tasks = Number(props.TasksCurrent);
  return (
    props.ActiveState === "active" &&
    ["start", "running"].includes(props.SubState ?? "") &&
    Number.isSafeInteger(tasks) &&
    tasks > 0 &&
    tasks <= limits.tasks &&
    typeof props.ControlGroup === "string" &&
    props.ControlGroup.endsWith(`/${unit}`)
  );
}
type UnitObservation = { code: number | null; text: string };
type GateDecision = {
  gateOpened: boolean;
  issue: string | null;
  lastPolicy: string;
  systemdTimeout: boolean;
};
export async function verifyP02FinalControl(
  control: string,
  kind: P02HostRequest["kind"]
): Promise<void> {
  if (
    (await readdir(control)).sort().join("|") !==
    (kind === "inventory" ? "inventory.json|probe|receipt.json" : "probe|receipt.json")
  )
    reject("output_shape");
  const probe = path.join(control, "probe");
  const info = await lstat(probe);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size !== 11 ||
    (await readFile(probe, {
      encoding: "utf8",
      flag: constants.O_RDONLY | constants.O_NOFOLLOW,
    })) !== "p02-scratch"
  )
    reject("output_shape");
}
function policySummary(text: string): string {
  const props = unitProperties(text);
  if (props === null) return "invalid_policy_response";
  return ["Result", "ActiveState", "SubState", "TasksCurrent", "IPAddressDeny"]
    .map(
      (key) => `${key}=${(props[key] ?? "").replace(/[^a-zA-Z0-9. /:[\\]-]/g, "?").slice(0, 64)}`
    )
    .join(",");
}
async function absentGateFile(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
/** An exact, no-follow ready marker; absence is distinct from a forged or drifting file. */
export async function verifyP02ReadyFile(file: string, requestSha: string): Promise<boolean> {
  if (!(await absentGateFile(file))) {
    const before = await lstat(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.size !== 65 ||
      before.uid !== process.getuid?.()
    )
      reject("ready_invalid");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        info.ino !== before.ino ||
        info.dev !== before.dev ||
        info.size !== before.size ||
        info.nlink !== 1 ||
        !info.isFile() ||
        (info.mode & 0o777) !== 0o600 ||
        (await handle.readFile("utf8")) !== `${requestSha}\n`
      )
        reject("ready_invalid");
      const final = await handle.stat();
      const after = await lstat(file);
      if (
        final.ino !== info.ino ||
        final.dev !== info.dev ||
        final.size !== info.size ||
        final.mtimeMs !== info.mtimeMs ||
        final.nlink !== 1 ||
        (final.mode & 0o777) !== 0o600 ||
        after.ino !== info.ino ||
        after.dev !== info.dev ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.nlink !== 1 ||
        (after.mode & 0o777) !== 0o600
      )
        reject("ready_drift");
    } finally {
      await handle.close();
    }
    return true;
  }
  return false;
}
/** Offline-testable parent half of the gate; only a live, twice-validated policy can release work. */
export async function openP02PolicyGate(
  control: string,
  requestSha: string,
  unit: string,
  limits: P02HostRequest["limits"],
  observe: () => Promise<UnitObservation>,
  signal?: AbortSignal,
  stopped: () => boolean = () => false
): Promise<GateDecision> {
  let lastPolicy = "not_observed";
  const end = Date.now() + limits.runtime_ms;
  const result = (issue: string, systemdTimeout = false): GateDecision => ({
    gateOpened: false,
    issue,
    lastPolicy,
    systemdTimeout,
  });
  while (Date.now() < end && !signal?.aborted && !stopped()) {
    const current = await observe();
    lastPolicy = policySummary(current.text);
    if (signal?.aborted || stopped()) return result("cancelled_before_gate");
    if (current.code !== 0) return result("policy_show_failed");
    if (current.text.includes("Result=timeout")) return result("systemd_runtime_limit", true);
    if (current.text.includes("SubState=exited")) return result("exited_before_gate");
    if (!validateP02RunningUnit(current.text, unit, limits)) {
      // Starting units may not yet have tasks. Any other failed/changed policy is terminal.
      const props = unitProperties(current.text);
      if (
        props === null ||
        !effectivePolicy(props, unit, limits) ||
        !(
          props.ActiveState === "activating" ||
          (props.ActiveState === "active" && props.SubState === "start")
        )
      )
        return result("running_policy_unverified");
    } else {
      let ready: boolean;
      try {
        ready = await verifyP02ReadyFile(path.join(control, "ready"), requestSha);
        if (!(await absentGateFile(path.join(control, "go")))) return result("go_preexisting");
      } catch {
        return result("ready_invalid");
      }
      if (ready) {
        const second = await observe();
        lastPolicy = policySummary(second.text);
        if (signal?.aborted || stopped()) return result("cancelled_before_gate");
        if (second.code !== 0 || !validateP02RunningUnit(second.text, unit, limits))
          return result("policy_drift_before_gate");
        if (!(await absentGateFile(path.join(control, "go")))) return result("go_preexisting");
        if (signal?.aborted || stopped()) return result("cancelled_before_gate");
        // Conservative: a write error can still have made go visible to the worker.
        try {
          await writeFile(path.join(control, "go"), "ok\n", { flag: "wx", mode: 0o600 });
          return { gateOpened: true, issue: null, lastPolicy, systemdTimeout: false };
        } catch {
          return {
            gateOpened: true,
            issue: "go_write_uncertain",
            lastPolicy,
            systemdTimeout: false,
          };
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return result(signal?.aborted || stopped() ? "cancelled_before_gate" : "gate_wait_expired");
}
export function validateP02EffectiveUnit(
  text: string,
  unit: string,
  limits: P02HostRequest["limits"]
): boolean {
  const props = unitProperties(text);
  return (
    props !== null &&
    effectivePolicy(props, unit, limits) &&
    props.SubState === "exited" &&
    props.ActiveState === "active" &&
    ["0", "[not set]"].includes(props.TasksCurrent ?? "") &&
    (props.ControlGroup === "" || props.ControlGroup?.endsWith(`/${unit}`) === true)
  );
}
/** Opt-in offline boundary only. No registry, P02 dispatch, attestation or artifact minting. */
export async function runP02HostCanary(
  input: unknown,
  signal?: AbortSignal
): Promise<P02HostOutcome> {
  const req = validateContract(P02_HOST_REQUEST_SCHEMA, input, "P02 host request");
  validateHostPaths(req);
  if (signal?.aborted)
    return { status: "cancelled", receipt: null, unit: null, issue: "cancelled_before_launch" };
  const uid = process.getuid?.();
  if (
    process.platform !== "linux" ||
    uid === undefined ||
    uid === 0 ||
    !safePath(req.workspace_parent)
  )
    reject("environment");
  const controlRuntime = await lstat(`/run/user/${String(uid)}`);
  const controlBus = await lstat(`/run/user/${String(uid)}/bus`);
  if (
    !controlRuntime.isDirectory() ||
    controlRuntime.uid !== uid ||
    (controlRuntime.mode & 0o077) !== 0 ||
    !controlBus.isSocket() ||
    controlBus.uid !== uid
  )
    reject("environment");
  if (
    new Set([
      req.source.root,
      req.rule.path,
      ...(req.tool_runtime.kind === "inventory"
        ? [req.tool_runtime.bundle.path, req.tool_runtime.indexer_source.path]
        : []),
      req.runtime.path,
      req.deployment.path,
      ...req.closure.map((x) => x.path),
      ...(req.tool_runtime.kind === "static" ? [req.tool_runtime.executable.path] : []),
    ]).size !==
    req.closure.length +
      4 +
      (req.tool_runtime.kind === "static" ? 1 : 0) +
      (req.tool_runtime.kind === "inventory" ? 2 : 0)
  )
    reject("duplicate");
  const reserved = ["/proc", "/dev", "/sys", "/tmp", "/run", "/var", "/p02", "/input", "/scratch"];
  for (const pin of [
    req.runtime,
    ...req.closure,
    ...(req.tool_runtime.kind === "static" ? [req.tool_runtime.executable] : []),
  ])
    if (reserved.some((x) => pin.path === x || pin.path.startsWith(`${x}/`)))
      reject("runtime_path");
  const parent = await lstat(req.workspace_parent);
  if (
    !parent.isDirectory() ||
    parent.uid !== uid ||
    (parent.mode & 0o077) !== 0 ||
    (await realpath(req.workspace_parent)) !== req.workspace_parent
  )
    reject("workspace");
  if (req.tool_runtime.kind === "inventory") {
    await verifySealedRuntimeTreeV1(req.tool_runtime.packages);
    await pinned(req.tool_runtime.bundle);
    await pinned(req.tool_runtime.indexer_source);
  } else if (req.tool_runtime.kind === "sealed") {
    const tool = req.tool_runtime;
    await verifySealedRuntimeTreeV1(tool.tree); // Same UID can still chmod later; pre/post checks are residual evidence, not immutability.
  } else await pinned(req.tool_runtime.executable);
  await verifyTree(req.source, req.source_generation);
  for (const pin of [req.rule, req.runtime, req.deployment, ...controlPins(req)]) await pinned(pin);
  for (const pin of req.closure) await pinned(pin, true);
  const stagedInputs = [
    req.rule,
    req.runtime,
    { path: MOUNT, sha256: req.controls.mount },
    { path: SETPRIV, sha256: req.controls.setpriv },
    { path: SCRATCH_LAUNCHER, sha256: req.controls.scratch_launcher },
    req.deployment,
    ...req.closure,
    ...(req.tool_runtime.kind === "static" ? [req.tool_runtime.executable] : []),
    ...(req.tool_runtime.kind === "inventory"
      ? [req.tool_runtime.bundle, req.tool_runtime.indexer_source]
      : []),
  ];
  const workerSha = sha256(await readFile(WORKER));
  const launcherSha = sha256(await readFile(LAUNCHER));
  await pinned({ path: WORKER, sha256: workerSha });
  await pinned({ path: LAUNCHER, sha256: launcherSha });
  let stageBytes =
    (await lstat(WORKER)).size + (await lstat(LAUNCHER)).size + req.source.total_bytes;
  for (const pin of stagedInputs) {
    stageBytes += (await lstat(await realpath(pin.path))).size;
    if (stageBytes > MAX_STAGE) reject("stage_limit");
  }
  const profileSha = p02HostProfileDigest(req, workerSha, launcherSha);
  if (profileSha !== req.profile_sha256) reject("profile");
  if (signal?.aborted)
    return { status: "cancelled", receipt: null, unit: null, issue: "cancelled_before_launch" };
  const unit = `p02-${randomBytes(16).toString("hex")}.service`;
  const work = await mkdtemp(path.join(req.workspace_parent, "p02-"));
  let launched = false;
  let stagedTree: HostTree | null = null;
  let safeToClean = false;
  let outcome: P02HostOutcome = { status: "unverified", receipt: null, unit, issue: "not_started" };
  try {
    await mkdir(path.join(work, "control"), { mode: 0o700 });
    await mkdir(path.join(work, "pins"), { mode: 0o700 });
    stagedTree = await stageTree(req.source, path.join(work, "source"));
    await verifySealedSourceTree(stagedTree);
    await verifyTree(req.source, req.source_generation);
    await writeFile(
      path.join(work, "tree.json"),
      canonicalJson({ ...req.source, root: "/input/source" }) + "\n",
      { flag: "wx", mode: 0o400 }
    );
    const staged: { path: string; sha256: string; target: string }[] = [
      ...[
        req.runtime,
        { path: MOUNT, sha256: req.controls.mount },
        { path: SETPRIV, sha256: req.controls.setpriv },
        ...req.closure,
        ...(req.tool_runtime.kind === "static" ? [req.tool_runtime.executable] : []),
      ].map((pin, index) => ({ ...pin, target: String(index) })),
      { path: WORKER, sha256: workerSha, target: "worker" },
      { path: SCRATCH_LAUNCHER, sha256: req.controls.scratch_launcher, target: "scratch-launcher" },
      { path: LAUNCHER, sha256: launcherSha, target: "launcher" },
      { ...req.deployment, target: "deployment" },
      { ...req.rule, target: "rule" },
      ...(req.tool_runtime.kind === "inventory"
        ? [
            { ...req.tool_runtime.bundle, target: "inventory" },
            { ...req.tool_runtime.indexer_source, target: "indexer" },
          ]
        : []),
    ];
    for (const pin of staged) {
      const dest = path.join(work, "pins", pin.target);
      await copyFile(pin.path, dest, constants.COPYFILE_EXCL);
      await chmod(dest, (await lstat(pin.path)).mode & 0o555);
      await pinned({ path: dest, sha256: pin.sha256 });
      if (signal?.aborted) throw new Error("cancelled_before_launch");
    }
    for (const pin of [
      req.rule,
      req.runtime,
      req.deployment,
      ...controlPins(req),
      { path: WORKER, sha256: workerSha },
      { path: LAUNCHER, sha256: launcherSha },
    ])
      await pinned(pin);
    for (const pin of req.closure) await pinned(pin, true);
    if (req.tool_runtime.kind === "inventory") {
      await pinned(req.tool_runtime.bundle);
      await pinned(req.tool_runtime.indexer_source);
      await verifySealedRuntimeTreeV1(req.tool_runtime.packages);
    }
    const nonce = randomBytes(32).toString("hex");
    const payload = {
      version: 1,
      kind: req.kind,
      nonce,
      unit,
      plan_sha256: sha256(canonicalJson(req)),
      worker_sha256: workerSha,
      launcher_sha256: launcherSha,
      profile_sha256: profileSha,
      deployment_sha256: req.deployment.sha256,
      source_sha256: req.source.tree_sha256,
      tool_sha256:
        req.tool_runtime.kind === "static"
          ? req.tool_runtime.executable.sha256
          : req.tool_runtime.kind === "inventory"
            ? req.tool_runtime.bundle.sha256
            : req.tool_runtime.executable_sha256,
      runtime_sha256: sha256(canonicalJson(req.tool_runtime)),
      tool_path: p02HostToolPath(req.tool_runtime).path,
      process_timeout_ms: req.limits.runtime_ms - 500,
      scratch_bytes: req.limits.scratch_bytes,
      scratch_launcher_sha256: req.controls.scratch_launcher,
      mount_sha256: req.controls.mount,
      setpriv_sha256: req.controls.setpriv,
      node_path: req.runtime.path,
      node_sha256: req.runtime.sha256,
      rule_sha256: req.rule.sha256,
    };
    const requestSha = sha256(canonicalJson(payload));
    await writeFile(
      path.join(work, "request.json"),
      canonicalJson({ ...payload, request_sha256: requestSha }) + "\n",
      { flag: "wx", mode: 0o400 }
    );
    await verifyTree(req.source, req.source_generation);
    await verifySealedSourceTree(stagedTree);
    if (req.tool_runtime.kind === "static") await pinned(req.tool_runtime.executable);
    if (req.tool_runtime.kind === "sealed") await verifySealedRuntimeTreeV1(req.tool_runtime.tree);
    if (req.tool_runtime.kind === "inventory")
      await verifySealedRuntimeTreeV1(req.tool_runtime.packages);
    if (signal?.aborted) throw new Error("cancelled_before_launch");
    const args = buildP02HostArgv(req, work, unit);
    const run = spawn(SYSTEMD_RUN, [...args], {
      shell: false,
      env: hostControlEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    launched = true;
    let output = 0;
    for (const stream of [run.stdout, run.stderr])
      stream.on("data", (buf: Buffer) => {
        output += buf.length;
        if (output > 8192) run.kill("SIGKILL");
      });
    let reason: "cancelled" | "timeout" | null = null;
    const stops: Promise<unknown>[] = [];
    const stop = (why: "cancelled" | "timeout"): void => {
      if (reason !== null) return;
      reason = why;
      run.kill("SIGKILL");
      stops.push(
        command(
          SYSTEMCTL,
          ["--user", "kill", "--kill-who=all", "--signal=SIGKILL", unit],
          5000
        ).catch(() => undefined)
      );
      stops.push(command(SYSTEMCTL, ["--user", "stop", unit], 5000).catch(() => undefined));
    };
    const abort = (): void => stop("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), req.limits.runtime_ms + 10_000);
    let code: number | null = null;
    let finished = false;
    let systemdTimeout = false;
    let gateOpened = false;
    let gateIssue: string | null = null;
    let lastObservedPolicy = "not_observed";
    try {
      code = await new Promise((resolve, rejectPromise) => {
        run.on("error", rejectPromise);
        run.on("close", resolve);
      });
      if (code === 0 && reason === null) {
        const gate = await openP02PolicyGate(
          path.join(work, "control"),
          requestSha,
          unit,
          req.limits,
          () => command(SYSTEMCTL, ["--user", "show", unit, UNIT_PROPERTY_QUERY], 5000),
          signal,
          () => reason !== null
        );
        gateOpened = gate.gateOpened;
        gateIssue = gate.issue;
        lastObservedPolicy = gate.lastPolicy;
        systemdTimeout = gate.systemdTimeout;
        if (gateIssue !== null && reason === null && !systemdTimeout) stop("timeout");
      }
      while (code === 0 && reason === null && gateIssue === null && !finished && !systemdTimeout) {
        const observed = await command(
          SYSTEMCTL,
          ["--user", "show", unit, UNIT_PROPERTY_QUERY],
          5000
        );
        lastObservedPolicy = policySummary(observed.text);
        if (observed.code !== 0 || !observed.text.includes(`Id=${unit}\n`)) break;
        if (observed.text.includes("Result=timeout")) systemdTimeout = true;
        else if (
          observed.text.includes("Result=success") &&
          observed.text.includes("SubState=exited")
        )
          finished = true;
        else if (!validateP02RunningUnit(observed.text, unit, req.limits)) break;
        else await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    await Promise.all(stops);
    if (gateIssue !== null && gateIssue !== "cancelled_before_gate" && !systemdTimeout)
      outcome.issue = `gate_${gateIssue}:observed=${lastObservedPolicy}`;
    else if (reason !== null) outcome = { status: reason, receipt: null, unit, issue: reason };
    else if (systemdTimeout)
      outcome = { status: "timeout", receipt: null, unit, issue: "systemd_runtime_limit" };
    else if (code !== 0 || output > 8192 || !finished || !gateOpened)
      outcome.issue = `launcher_or_running_policy_failure:code=${String(code)}:output_bytes=${String(output)}:finished=${String(finished)}:gate_opened=${String(gateOpened)}:observed=${lastObservedPolicy}`;
    else {
      const show = await command(SYSTEMCTL, ["--user", "show", unit, UNIT_PROPERTY_QUERY], 5000);
      if (show.code !== 0 || !validateP02EffectiveUnit(show.text, unit, req.limits))
        outcome.issue = "effective_policy_unverified";
      else {
        const control = path.join(work, "control");
        await verifyP02FinalControl(control, req.kind);
        const dest = path.join(control, "receipt.json");
        const s = await lstat(dest);
        if (
          !s.isFile() ||
          s.nlink !== 1 ||
          s.uid !== uid ||
          (s.mode & 0o777) !== 0o600 ||
          s.size > req.limits.output_bytes
        )
          reject("output_limit");
        const bytes = await readFile(dest, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
        const receipt = validateP02HostReceipt(bytes, req.limits.output_bytes, {
          version: 1,
          kind: req.kind,
          nonce,
          unit,
          request_sha256: requestSha,
          plan_sha256: payload.plan_sha256,
          worker_sha256: workerSha,
          launcher_sha256: launcherSha,
          profile_sha256: profileSha,
          deployment_sha256: req.deployment.sha256,
          source_sha256: req.source.tree_sha256,
          tool_sha256: payload.tool_sha256,
          runtime_sha256: payload.runtime_sha256,
          rule_sha256: req.rule.sha256,
          scratch_bytes: req.limits.scratch_bytes,
        });
        let inventoryResult: unknown;
        if (req.kind === "inventory") {
          const outputFile = path.join(control, "inventory.json");
          const info = await lstat(outputFile);
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.uid !== uid ||
            (info.mode & 0o777) !== 0o600 ||
            info.size > req.limits.output_bytes ||
            info.size < 10
          )
            reject("inventory_output_limit");
          const outputBytes = await readFile(outputFile, {
            flag: constants.O_RDONLY | constants.O_NOFOLLOW,
          });
          if (sha256(outputBytes) !== receipt.inventory_result_sha256)
            reject("inventory_result_drift");
          inventoryResult = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(outputBytes)
          );
          if (canonicalJson(inventoryResult) + "\n" !== outputBytes.toString("utf8"))
            reject("inventory_result_canonical");
        }
        await verifyTree(req.source, req.source_generation);
        await verifySealedSourceTree(stagedTree);
        if (req.tool_runtime.kind === "sealed")
          await verifySealedRuntimeTreeV1(req.tool_runtime.tree);
        else if (req.tool_runtime.kind === "inventory") {
          await verifySealedRuntimeTreeV1(req.tool_runtime.packages);
          await pinned(req.tool_runtime.bundle);
          await pinned(req.tool_runtime.indexer_source);
        } else await pinned(req.tool_runtime.executable);
        for (const pin of [
          req.rule,
          req.runtime,
          req.deployment,
          ...controlPins(req),
          { path: WORKER, sha256: workerSha },
          { path: LAUNCHER, sha256: launcherSha },
        ])
          await pinned(pin);
        for (const pin of req.closure) await pinned(pin, true);
        outcome = {
          status: receipt.status,
          receipt,
          unit,
          issue: receipt.status === "passed" ? null : receipt.status,
          inventory_result: inventoryResult,
        };
      }
    }
  } catch {
    outcome = signal?.aborted
      ? {
          status: "cancelled",
          receipt: null,
          unit,
          issue: "cancelled_before_launch_or_during_failure",
        }
      : { status: "unverified", receipt: null, unit, issue: "validation_or_launch_failure" };
  } finally {
    if (launched) {
      const stopped = await command(SYSTEMCTL, ["--user", "stop", unit], 5000).catch(() => ({
        code: null,
        text: "",
      }));
      const state = await command(
        SYSTEMCTL,
        ["--user", "show", unit, "--property=LoadState,ActiveState,SubState,TasksCurrent,MainPID"],
        5000
      ).catch(() => ({ code: null, text: "" }));
      const absent = state.text.includes("LoadState=not-found");
      const noTasks =
        (state.text.includes("TasksCurrent=0") || state.text.includes("TasksCurrent=[not set]")) &&
        state.text.includes("MainPID=0");
      const inactive =
        state.text.includes("ActiveState=inactive") &&
        state.text.includes("SubState=dead") &&
        noTasks;
      const failed =
        state.text.includes("ActiveState=failed") &&
        state.text.includes("SubState=failed") &&
        noTasks;
      safeToClean = (stopped.code === 0 || absent || failed) && (absent || inactive || failed);
      if (safeToClean)
        await command(SYSTEMCTL, ["--user", "reset-failed", unit], 5000).catch(() => undefined);
    } else safeToClean = true;
    if (launched && safeToClean && stagedTree !== null) {
      try {
        await verifyTree(req.source, req.source_generation);
        await verifySealedSourceTree(stagedTree);
        if (req.tool_runtime.kind === "sealed")
          await verifySealedRuntimeTreeV1(req.tool_runtime.tree);
        else if (req.tool_runtime.kind === "inventory") {
          await verifySealedRuntimeTreeV1(req.tool_runtime.packages);
          await pinned(req.tool_runtime.bundle);
          await pinned(req.tool_runtime.indexer_source);
        } else await pinned(req.tool_runtime.executable);
        await pinned(req.rule);
      } catch {
        outcome = { status: "unverified", receipt: null, unit, issue: "post_execution_drift" };
      }
    }
    if (safeToClean && stagedTree !== null)
      await unsealStagedTree(stagedTree).catch(() => {
        safeToClean = false;
      });
    if (safeToClean)
      await rm(work, { recursive: true, force: false }).catch(() => {
        safeToClean = false;
      });
  }
  if (
    !safeToClean ||
    (await stat(work).then(
      () => true,
      () => false
    ))
  )
    return {
      status: "unverified",
      receipt: null,
      unit,
      issue: `termination_or_cleanup_uncertain:${work}`,
    };
  if (signal?.aborted) return { status: "cancelled", receipt: null, unit, issue: "cancelled" };
  return outcome;
}
