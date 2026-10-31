/** Temporary opt-in shared-kernel CONTAINER boundary, never a VM or isolation attestation.
 * Host-only pins select already-local reviewed secret-free images. No pull/build/install path.
 * The canonical owner remains responsible for leases, submission journaling, cache and quarantine.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type {
  OrdinaryApplicationTestOwner,
  OrdinaryApplicationExecutionPlan,
  OrdinaryApplicationTestRequest,
  OrdinaryApplicationTestResult,
} from "./ordinary-application-tests.js";

const MiB = 1_048_576;
const Absolute = Type.String({ minLength: 1, maxLength: 4096 });
const Pin = Type.Object(
  {
    path: Absolute,
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    size_bytes: Type.Integer({ minimum: 1, maximum: 256 * MiB }),
  },
  { additionalProperties: false }
);
const Image = Type.Union([Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), Type.Null()]);
export const ORDINARY_APPLICATION_CONTAINER_PROFILE = "docker-local-no-network-v1";
export const OrdinaryApplicationContainerConfigSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ordinary-application-container-config.v1"),
    schema_version: Type.Literal(1),
    kind: Type.Literal("docker"),
    isolation: Type.Literal("container"),
    profile: Type.Literal(ORDINARY_APPLICATION_CONTAINER_PROFILE),
    workspace_parent: Absolute,
    docker: Pin,
    daemon_socket: Absolute,
    images: Type.Object({ php: Image, node: Image }, { additionalProperties: false }),
  },
  { additionalProperties: false }
);
export type OrdinaryApplicationContainerConfig = Static<
  typeof OrdinaryApplicationContainerConfigSchema
>;
export interface OrdinaryApplicationDockerCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly input: Uint8Array;
  readonly signal: AbortSignal;
  readonly timeout_ms: number;
  readonly output_bytes: number;
}
export interface OrdinaryApplicationDockerResponse {
  readonly exit_code: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly terminated: boolean;
  readonly failure: "timeout" | "output_limit" | "cancelled" | "spawn" | null;
}
/** Trusted fault-test seam. Killing the Docker CLI is NOT container termination proof. */
export type OrdinaryApplicationDockerRunner = (
  command: OrdinaryApplicationDockerCommand
) => Promise<OrdinaryApplicationDockerResponse>;
export const ordinaryApplicationDockerCommand: OrdinaryApplicationDockerRunner = (command) =>
  new Promise((resolve) => {
    if (command.signal.aborted) {
      resolve({
        exit_code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        terminated: true,
        failure: "cancelled",
      });
      return;
    }
    const child = spawn(command.executable, [...command.argv], {
      shell: false,
      detached: true,
      // Bare --env=NAME must mean REMOVE, never import a host value (including PATH/LANG).
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let count = 0;
    let failure: OrdinaryApplicationDockerResponse["failure"] = null;
    const stop = (reason: NonNullable<OrdinaryApplicationDockerResponse["failure"]>) => {
      failure ??= reason;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Absence is independently checked on close. */
        }
      }
    };
    const abort = () => stop("cancelled");
    command.signal.addEventListener("abort", abort, { once: true });
    if (command.signal.aborted) abort();
    const timer = setTimeout(() => stop("timeout"), command.timeout_ms);
    for (const [stream, chunks] of [
      [child.stdout, out],
      [child.stderr, err],
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, command.output_bytes - count);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        count += chunk.length;
        if (count > command.output_bytes) stop("output_limit");
      });
    }
    child.stdin.on("error", () => {
      /* A workload may close its admitted stdin early. */
    });
    child.on("error", () => stop("spawn"));
    child.stdin.end(command.input);
    child.on("close", (code) => {
      clearTimeout(timer);
      command.signal.removeEventListener("abort", abort);
      let terminated = child.pid === undefined;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          terminated = error instanceof Error && "code" in error && error.code === "ESRCH";
        }
      }
      resolve({
        exit_code: code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        terminated,
        failure,
      });
    });
  });

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Docker object required");
  return Object.fromEntries(Object.entries(value));
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Docker array required");
  const values: unknown[] = value;
  return values;
}
function equal(value: unknown, expected: unknown): void {
  if (canonicalJson(value) !== canonicalJson(expected)) throw new Error("Docker policy mismatch");
}
function empty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    canonicalJson(value) === "{}" ||
    canonicalJson(value) === "[]"
  );
}
function parse(bytes: Buffer, maximum = MiB): unknown {
  if (bytes.length > maximum) throw new Error("Docker control overflow");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return value;
}
function success(response: OrdinaryApplicationDockerResponse): Buffer {
  if (!response.terminated || response.failure !== null || response.exit_code !== 0)
    throw new Error("Docker command incomplete");
  return response.stdout;
}
function canonicalAbsolute(value: string): boolean {
  return path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n,$]/u.test(value);
}
async function preflight(config: OrdinaryApplicationContainerConfig, signal: AbortSignal) {
  signal.throwIfAborted();
  if (process.platform !== "linux" || process.getuid?.() === 0)
    throw new Error("Unsupported Docker host");
  for (const name of [config.workspace_parent, config.docker.path, config.daemon_socket]) {
    if (!canonicalAbsolute(name) || (await realpath(name)) !== name)
      throw new Error("Noncanonical Docker path");
  }
  const parent = await lstat(config.workspace_parent);
  const socket = await lstat(config.daemon_socket);
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o777) !== 0o700 ||
    !socket.isSocket()
  )
    throw new Error("Unsafe Docker host");
  const file = await open(
    config.docker.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== config.docker.size_bytes ||
      (before.mode & 0o022) !== 0 ||
      (before.mode & 0o111) === 0 ||
      ![0, process.getuid?.()].includes(before.uid)
    )
      throw new Error("Docker client identity");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      bytes.length !== config.docker.size_bytes ||
      sha256(bytes) !== config.docker.sha256 ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      (await lstat(config.docker.path)).ino !== before.ino
    )
      throw new Error("Docker client drift");
  } finally {
    await file.close();
  }
}
// All image names are removed before the first entrypoint loader runs. Bounds cap argv
// and inspection work; these are syntax/size constraints, NOT a dangerous-name denylist.
const IMAGE_ENV_MAX_ENTRIES = 256;
const IMAGE_ENV_MAX_BYTES = 64 * 1024;
const IMAGE_ENV_MAX_ENTRY_BYTES = 8192;
const IMAGE_ENV_MAX_NAME_LENGTH = 128;
const PROCESS_ENV = [
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/tmp",
  "TMPDIR=/tmp",
  "LANG=C.UTF-8",
  "HOSTNAME=application-test",
];
function effectiveEnvironment(imageEnvNames: readonly string[]): string[] {
  const fixedNames = new Set(PROCESS_ENV.map((entry) => entry.split("=")[0]));
  // Docker retains bare unset markers in Config.Env, then removes them when
  // building the OCI process environment. Admit exactly those markers, no values
  // and no other names. Native tests verify the actual PID 1 environment too.
  return [...imageEnvNames.filter((name) => !fixedNames.has(name)), ...PROCESS_ENV];
}
function imageEnvironmentNames(value: unknown): string[] {
  if (value === null) return [];
  const entries = array(value);
  if (entries.length > IMAGE_ENV_MAX_ENTRIES) throw new Error("Image environment count");
  const names = new Set<string>();
  let bytes = 0;
  for (const entry of entries) {
    if (typeof entry !== "string") throw new Error("Image environment entry");
    const size = Buffer.byteLength(entry) + 1;
    bytes += size;
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator);
    if (
      size > IMAGE_ENV_MAX_ENTRY_BYTES ||
      bytes > IMAGE_ENV_MAX_BYTES ||
      entry.includes("\0") ||
      separator < 1 ||
      name.length > IMAGE_ENV_MAX_NAME_LENGTH ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      names.has(name)
    )
      throw new Error("Invalid image environment");
    names.add(name);
  }
  return [...names];
}
const TMPFS = "/tmp:rw,noexec,nosuid,nodev,size=16777216,nr_inodes=1024,mode=1777";
function invocation(plan: OrdinaryApplicationExecutionPlan): string[] {
  const interpreter =
    plan.interpreter === "php"
      ? ["/usr/bin/php", "-n"]
      : [
          "/usr/local/bin/node",
          "--max-old-space-size=128",
          ...(plan.interpreter === "node_typescript" ? ["--experimental-strip-types"] : []),
        ];
  const ext =
    plan.interpreter === "php" ? "php" : plan.interpreter === "node_typescript" ? "ts" : "mjs";
  // timeout is daemon-side: even loss of this controller cannot leave an
  // indefinitely running namespace. Its loader already receives only PROCESS_ENV.
  return [
    "--signal=KILL",
    `${plan.resources.test_timeout_ms / 1000}s`,
    ...interpreter,
    `/input/tests/harness.${ext}`,
  ];
}
function limits(plan: OrdinaryApplicationExecutionPlan) {
  return [
    { Name: "core", Soft: 0, Hard: 0 },
    { Name: "cpu", Soft: plan.resources.cpu_seconds, Hard: plan.resources.cpu_seconds },
    { Name: "fsize", Soft: plan.resources.file_bytes, Hard: plan.resources.file_bytes },
    { Name: "nofile", Soft: 64, Hard: 64 },
    { Name: "memlock", Soft: 0, Hard: 0 },
  ];
}
function labels(request: OrdinaryApplicationTestRequest) {
  return {
    "penny.application.request": sha256(canonicalJson(request)),
    "penny.application.owner": sha256(
      canonicalJson({ project: request.project_id, run: request.run_id })
    ),
    "penny.application.isolation": "CONTAINER",
  };
}
function createArgs(
  request: OrdinaryApplicationTestRequest,
  plan: OrdinaryApplicationExecutionPlan,
  share: string,
  image: string,
  name: string,
  imageEnvNames: readonly string[]
) {
  return [
    "container",
    "create",
    "--pull=never",
    "--name",
    name,
    "--hostname",
    "application-test",
    "--runtime",
    "runc",
    "--network",
    "none",
    "--ipc",
    "none",
    "--cgroupns",
    "private",
    "--read-only",
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--security-opt",
    "seccomp=builtin",
    "--security-opt",
    "apparmor=docker-default",
    "--memory",
    String(plan.resources.memory_bytes),
    "--memory-swap",
    String(plan.resources.memory_bytes),
    "--cpus",
    "1",
    "--pids-limit",
    String(plan.resources.processes),
    "--restart",
    "no",
    "--no-healthcheck",
    "--init=false",
    "--log-driver",
    "none",
    "--stop-timeout",
    "1",
    "--interactive",
    "--tmpfs",
    TMPFS,
    "--mount",
    `type=bind,src=${share},dst=/input,readonly,bind-recursive=disabled`,
    "--workdir",
    "/input/tests",
    ...limits(plan).flatMap((entry) => ["--ulimit", `${entry.Name}=${entry.Soft}:${entry.Hard}`]),
    ...Object.entries(labels(request)).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    // Docker treats a bare absent host name as removal, unlike NAME= (empty value).
    // Remove ALL inherited names, then replace only the fixed benign environment.
    ...imageEnvNames.map((key) => `--env=${key}`),
    ...PROCESS_ENV.map((entry) => `--env=${entry}`),
    "--entrypoint",
    "/usr/bin/timeout",
    image,
    ...invocation(plan),
  ];
}
function owned(
  inspect: RecordValue,
  request: OrdinaryApplicationTestRequest,
  id: string,
  name: string
) {
  equal(inspect.Id, id);
  equal(inspect.Name, `/${name}`);
  const actual = record(record(inspect.Config).Labels);
  for (const [key, value] of Object.entries(labels(request))) equal(actual[key], value);
}
/** Inspect the daemon's effective object BEFORE start; flags alone are not an acceptance oracle. */
function inspectPolicy(
  inspect: RecordValue,
  request: OrdinaryApplicationTestRequest,
  plan: OrdinaryApplicationExecutionPlan,
  image: string,
  share: string,
  id: string,
  name: string,
  imageEnvNames: readonly string[]
) {
  owned(inspect, request, id, name);
  equal(inspect.Image, image);
  const c = record(inspect.Config);
  for (const [key, value] of Object.entries({
    User: "65534:65534",
    WorkingDir: "/input/tests",
    Hostname: "application-test",
    Entrypoint: ["/usr/bin/timeout"],
    Cmd: invocation(plan),
    Tty: false,
    OpenStdin: true,
    Healthcheck: { Test: ["NONE"] },
  }))
    equal(c[key], value);
  // Closed equality rejects every extra/missing/duplicate variable or unset marker.
  equal(array(c.Env).slice().sort(), effectiveEnvironment(imageEnvNames).sort());
  const h = record(inspect.HostConfig);
  for (const [key, value] of Object.entries({
    NetworkMode: "none",
    IpcMode: "none",
    PidMode: "",
    UTSMode: "",
    UsernsMode: "",
    CgroupnsMode: "private",
    Privileged: false,
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    Memory: plan.resources.memory_bytes,
    MemorySwap: plan.resources.memory_bytes,
    NanoCpus: 1_000_000_000,
    PidsLimit: plan.resources.processes,
    Runtime: "runc",
    RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    LogConfig: { Type: "none", Config: {} },
    PublishAllPorts: false,
    AutoRemove: false,
    Init: false,
    OomKillDisable: false,
    CpuQuota: 0,
    CpuPeriod: 0,
    Tmpfs: { "/tmp": TMPFS.slice(5) },
  }))
    equal(h[key], value);
  equal(
    array(h.SecurityOpt).slice().sort(),
    ["no-new-privileges=true", "seccomp=builtin", "apparmor=docker-default"].sort()
  );
  equal(
    array(h.Ulimits)
      .map((entry) => record(entry))
      .sort((a, b) => String(a.Name).localeCompare(String(b.Name))),
    limits(plan).sort((a, b) => a.Name.localeCompare(b.Name))
  );
  for (const key of [
    "Binds",
    "VolumesFrom",
    "CapAdd",
    "Devices",
    "DeviceRequests",
    "DeviceCgroupRules",
    "PortBindings",
    "Links",
    "ExtraHosts",
    "GroupAdd",
    "Sysctls",
    "StorageOpt",
  ])
    if (!empty(h[key])) throw new Error("Unexpected Docker capability");
  equal(h.Mounts, [
    {
      Type: "bind",
      Source: share,
      Target: "/input",
      ReadOnly: true,
      BindOptions: { NonRecursive: true },
    },
  ]);
  equal(Object.keys(record(record(inspect.NetworkSettings).Networks)), ["none"]);
  for (const [key, required] of [
    ["MaskedPaths", ["/proc/kcore", "/proc/keys", "/sys/firmware"]],
    ["ReadonlyPaths", ["/proc/sys", "/proc/sysrq-trigger"]],
  ] as const) {
    const actual = array(h[key]);
    if (!required.every((entry) => actual.includes(entry)))
      throw new Error("Missing system path confinement");
  }
  const mounts = array(inspect.Mounts);
  if (mounts.length !== 1) throw new Error("Unexpected Docker mounts");
  const mount = record(mounts[0]);
  for (const [key, value] of Object.entries({
    Type: "bind",
    Source: share,
    Destination: "/input",
    RW: false,
    Propagation: "rprivate",
  }))
    equal(mount[key], value);
  if (!empty(c.Volumes) || !empty(c.ExposedPorts))
    throw new Error("Image adds mutable volumes/ports");
  equal(inspect.AppArmorProfile, "docker-default");
}
interface AdmittedContainerInput {
  readonly plan: OrdinaryApplicationExecutionPlan;
  readonly payload: Buffer;
}
/** Called only after exact immutable operand admission in the generalized runtime. */
export async function runOrdinaryApplicationContainer(
  config: OrdinaryApplicationContainerConfig,
  admitted: AdmittedContainerInput,
  request: OrdinaryApplicationTestRequest,
  owner: OrdinaryApplicationTestOwner,
  runner: OrdinaryApplicationDockerRunner = ordinaryApplicationDockerCommand
): Promise<Partial<OrdinaryApplicationTestResult>> {
  try {
    await preflight(config, owner.signal);
  } catch {
    return {
      status: owner.signal.aborted ? "failed" : "unsupported",
      reason: owner.signal.aborted ? "cancelled" : "not_configured",
    };
  }
  const image = admitted.plan.interpreter === "php" ? config.images.php : config.images.node;
  if (image === null) return { status: "unsupported", reason: "not_configured" };
  const digest = sha256(canonicalJson(request));
  const name = `penny-app-${digest}`;
  const work = path.join(config.workspace_parent, `attempt-${digest}`);
  try {
    await mkdir(work, { mode: 0o700 });
  } catch {
    // This path is an anti-rerun claim, NEVER a result-discovery/cache surface.
    return {
      status: "incomplete",
      reason: "recovery_requires_exact_cache",
      execution: "UNKNOWN",
      acceptance: "ambiguous",
      cleanup: "unproved",
      quarantine_required: true,
      retained_workspace: work,
    };
  }
  const share = path.join(work, "input");
  const cliConfig = path.join(work, "docker-config");
  const events: unknown[] = [];
  let submitted = false;
  let collision = false;
  let createCertain = false;
  let cleanup = true;
  let id: string | undefined;
  let started = false;
  let recorded = false;
  let evidenceOverflow = false;
  let eventBytes = 0;
  const operationDeadline =
    performance.now() +
    ("operation_timeout_seconds" in admitted.plan.resources
      ? admitted.plan.resources.operation_timeout_seconds
      : admitted.plan.resources.vm_timeout_seconds) *
      1000;
  let outcome: Partial<OrdinaryApplicationTestResult> = {
    status: "failed",
    reason: "container_failed",
  };
  const raw = () =>
    Buffer.from(
      canonicalJson({
        schema_id: "penny.sca-ordinary-application-container-receipt.v1",
        schema_version: 1,
        isolation: "CONTAINER",
        request_sha256: digest,
        image_id: image,
        name,
        events,
      })
    ).toString("base64");
  const call = async (
    args: readonly string[],
    signal = owner.signal,
    output = MiB,
    timeout = 10_000,
    input: Uint8Array = Buffer.alloc(0)
  ) => {
    const remaining = signal === owner.signal ? operationDeadline - performance.now() : 5000;
    if (remaining <= 0) throw new Error("Operation resource budget exhausted");
    const response = await runner({
      executable: config.docker.path,
      argv: ["--config", cliConfig, "--host", `unix://${config.daemon_socket}`, ...args],
      signal,
      timeout_ms: Math.min(timeout, remaining),
      output_bytes: output,
      input,
    });
    const event = {
      argv: args,
      response: {
        ...response,
        stdout: response.stdout.toString("base64"),
        stderr: response.stderr.toString("base64"),
      },
    };
    const encoded = canonicalJson(event);
    if (eventBytes + Buffer.byteLength(encoded) <= 8 * MiB) {
      events.push(event);
      eventBytes += Buffer.byteLength(encoded);
    } else {
      evidenceOverflow = true;
      events.push({ argv: args, omitted_evidence_sha256: sha256(encoded) });
    }
    return response;
  };
  const inspect = async (target: string, signal: AbortSignal) =>
    record(
      parse(success(await call(["container", "inspect", "--format", "{{json .}}", target], signal)))
    );
  const listed = async (signal: AbortSignal) =>
    success(
      await call(
        [
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.ID}}",
        ],
        signal
      )
    )
      .toString("utf8")
      .trim();
  try {
    await mkdir(cliConfig, { mode: 0o700 });
    await writeFile(path.join(cliConfig, "config.json"), "{}", { flag: "wx", mode: 0o400 });
    const imageObject = record(
      parse(success(await call(["image", "inspect", "--format", "{{json .}}", image])))
    );
    equal(imageObject.Id, image);
    equal(imageObject.Os, "linux");
    const imageEnvNames = imageEnvironmentNames(record(imageObject.Config).Env);
    if (
      !empty(record(imageObject.Config).Volumes) ||
      !empty(record(imageObject.Config).ExposedPorts)
    )
      throw new Error("Unreviewed image capability");
    if ((await listed(owner.signal)) !== "") {
      collision = true;
      cleanup = false;
      throw new Error("Existing request must be reconciled, never rerun");
    }
    // Only source-only sealed corpus/harness/input bytes are materialized, not a host checkout.
    const payload = record(parse(admitted.payload, 24 * MiB));
    const files = array(payload.files);
    await mkdir(share, { mode: 0o755 });
    for (const value of files) {
      const file = record(value);
      if (
        typeof file.path !== "string" ||
        typeof file.content_base64 !== "string" ||
        typeof file.content_sha256 !== "string" ||
        !/^(source|tests)\/[A-Za-z0-9._@+/-]+$/u.test(file.path) ||
        file.path.split("/").some((p) => p === ".." || p === "." || p === "")
      )
        throw new Error("Invalid staged input");
      const bytes = Buffer.from(file.content_base64, "base64");
      if (sha256(bytes) !== file.content_sha256 || bytes.toString("base64") !== file.content_base64)
        throw new Error("Input drift");
      const target = path.join(share, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o444 });
    }
    // Bind is read-only, including all descendants (recursive submounts are disabled).
    await chmod(share, 0o555);
    owner.signal.throwIfAborted();
    owner.beforeSubmit(name);
    submitted = true;
    cleanup = false;
    const created = await call(
      createArgs(request, admitted.plan, share, image, name, imageEnvNames)
    );
    const createdId = success(created).toString("utf8").trim();
    if (!/^[a-f0-9]{64}$/u.test(createdId)) throw new Error("Uncertain Docker create");
    id = createdId;
    createCertain = true;
    const effective = await inspect(id, owner.signal);
    inspectPolicy(effective, request, admitted.plan, image, share, id, name, imageEnvNames);
    equal(record(effective.State).Status, "created");
    owner.accepted(name); // Accepted daemon-owned container, not proof the interpreter ran.
    recorded = true;
    owner.activity();
    owner.signal.throwIfAborted();
    const startTime = performance.now();
    const start = await call(
      ["container", "start", "--attach", "--interactive", id],
      owner.signal,
      admitted.plan.resources.output_bytes,
      admitted.plan.resources.test_timeout_ms + 2000,
      Buffer.from(typeof payload.stdin_base64 === "string" ? payload.stdin_base64 : "", "base64")
    );
    const terminalSignal = new AbortController().signal;
    if (start.failure !== null) {
      const live = await inspect(id, terminalSignal);
      owned(live, request, id, name);
      if (record(live.State).Running === true)
        success(await call(["container", "kill", "--signal", "KILL", id], terminalSignal));
    }
    const terminal = await inspect(id, terminalSignal);
    owned(terminal, request, id, name);
    const state = record(terminal.State);
    started = typeof state.StartedAt === "string" && !state.StartedAt.startsWith("0001-");
    if (
      !start.terminated ||
      !started ||
      state.Running !== false ||
      state.Status !== "exited" ||
      typeof state.ExitCode !== "number" ||
      !Number.isInteger(state.ExitCode)
    )
      throw new Error("Uncertain Docker terminal");
    const reason = owner.signal.aborted
      ? "cancelled"
      : state.OOMKilled === true
        ? "container_failed"
        : start.failure === "output_limit"
          ? "output_limit"
          : start.failure === "timeout" ||
              (state.ExitCode === 137 &&
                performance.now() - startTime >= admitted.plan.resources.test_timeout_ms)
            ? "timeout"
            : start.failure === null
              ? "observed"
              : "container_failed";
    if (start.failure === null && start.exit_code !== state.ExitCode)
      throw new Error("Conflicting Docker exit");
    // 125–127 may be timeout/env/interpreter launch failure, not proof the harness ran.
    if ([125, 126, 127].includes(state.ExitCode))
      throw new Error("Interpreter launch truth unavailable");
    outcome = {
      status: reason === "observed" ? "completed" : "failed",
      reason,
      execution: "RUN",
      passed: reason === "observed" ? state.ExitCode === admitted.plan.expected_exit_code : null,
      exit_code: state.ExitCode,
      stdout_base64: start.stdout.toString("base64"),
      stderr_base64: start.stderr.toString("base64"),
    };
  } catch {
    outcome = {
      status: submitted ? "incomplete" : "failed",
      reason: owner.signal.aborted ? "cancelled" : "container_failed",
      execution: submitted ? "UNKNOWN" : "NOT RUN",
    };
  }
  {
    if (submitted) {
      // Independent cleanup channel: cancellation/failed runner never disables containment attempts.
      const signal = new AbortController().signal;
      try {
        if (id === undefined) {
          const candidate = await listed(signal);
          if (!/^[a-f0-9]{64}$/u.test(candidate)) throw new Error("Create acceptance uncertain");
          const observed = await inspect(candidate, signal);
          owned(observed, request, candidate, name);
          id = candidate;
          if (!recorded) {
            owner.accepted(name);
            recorded = true;
          }
        }
        const observed = await inspect(id, signal);
        owned(observed, request, id, name);
        if (record(observed.State).Running === true)
          success(await call(["container", "kill", "--signal", "KILL", id], signal));
        const stopped = await inspect(id, signal);
        owned(stopped, request, id, name);
        equal(record(stopped.State).Running, false);
        success(await call(["container", "rm", id], signal));
        equal(await listed(signal), "");
        // An uncertain create transport may still have a late daemon request in flight.
        cleanup = createCertain;
      } catch {
        cleanup = false;
      }
    }
    if (cleanup) {
      try {
        await chmod(share, 0o755).catch(async () => {
          if (await exists(share)) throw new Error("Staging permission changed");
        });
        await rm(share, { recursive: true, force: true });
        await rm(cliConfig, { recursive: true, force: true });
        if ((await exists(share)) || (await exists(cliConfig))) throw new Error("Staging remains");
      } catch {
        cleanup = false;
      }
    }
  }
  if (!cleanup)
    return {
      status: "incomplete",
      reason: "containment_unproved",
      execution: submitted || collision ? "UNKNOWN" : "NOT RUN",
      acceptance: submitted || collision ? "ambiguous" : "not_submitted",
      cleanup: "unproved",
      quarantine_required: true,
      passed: null,
      raw_receipt_base64: raw(),
      retained_workspace: work,
    };
  return {
    ...outcome,
    ...(evidenceOverflow
      ? ({
          status: "incomplete",
          reason: "evidence_invalid",
          execution: submitted ? "UNKNOWN" : "NOT RUN",
          passed: null,
        } as const)
      : {}),
    acceptance: submitted ? "terminal" : "not_submitted",
    cleanup: submitted ? "proved" : "not_needed",
    quarantine_required: false,
    raw_receipt_base64: raw(),
  };
}
async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
