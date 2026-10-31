import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { verifyP02ReadyFile } from "./p02-host-harness.js";
import { configuredPublicOsvIps } from "./adapters/osv-v2-fixed-ip.js";
import { verifyP02OsvPin, verifyP02OsvPinSet, type VerifiedP02OsvPin } from "./p02-osv-pin.js";
import {
  exactAllowedTransportRequest,
  parseScaOsvV2BatchResults,
  planScaOsvV2,
  ScaOsvRequestV2Schema,
  ScaOsvV2TransportError,
  type ScaOsvV2Transport,
  type ScaOsvV2TransportRequest,
  type ScaOsvV2TransportResponse,
} from "./adapters/osv-v2.js";

const SCRATCH_LAUNCHER = fileURLToPath(new URL("./p02-scratch-launcher.mjs", import.meta.url));
const MOUNT = "/usr/bin/mount";
const SETPRIV = "/usr/bin/setpriv";

const Hex = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Pin = Type.Object(
  { path: Type.String({ minLength: 1, maxLength: 4096 }), sha256: Hex },
  { additionalProperties: false }
);
export const P02_OSV_HOST_SCHEMA = Type.Object(
  {
    component_request: ScaOsvRequestV2Schema,
    transport_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }),
    profile_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }),
    profile_sha256: Hex,
    deployment: Pin,
    runtime: Pin,
    closure: Type.Array(Pin, { maxItems: 128 }),
    ca: Pin,
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
    workspace_parent: Type.String({ minLength: 1, maxLength: 4096 }),
    ips: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
    canary_ip: Type.String(),
    limits: Type.Object(
      {
        memory_bytes: Type.Integer({ minimum: 67_108_864, maximum: 2_147_483_648 }),
        scratch_bytes: Type.Integer({ minimum: 4096, maximum: 2_147_483_648, multipleOf: 4096 }),
        tasks: Type.Integer({ minimum: 2, maximum: 16 }),
        cpu_percent: Type.Integer({ minimum: 1, maximum: 100 }),
        runtime_ms: Type.Integer({ minimum: 3000, maximum: 300_000 }),
        output_bytes: Type.Integer({ minimum: 1024, maximum: 134_217_728 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type P02OsvHostConfig = Static<typeof P02_OSV_HOST_SCHEMA>;
const WORKER = fileURLToPath(new URL("./p02-osv-worker.mjs", import.meta.url));
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SYSTEMCTL = "/usr/bin/systemctl";
const BWRAP = "/usr/bin/bwrap";
const issued = new WeakMap<
  object,
  Readonly<{
    config: P02OsvHostConfig;
    plan: ReturnType<typeof planScaOsvV2>;
    evidence: P02OsvEgressEvidenceV1[];
  }>
>();

const CANARY_DENIAL_CODES = [
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "EACCES",
  "EPERM",
] as const;
type CanaryDenialCode = (typeof CANARY_DENIAL_CODES)[number];
function canaryDenialCode(value: unknown): CanaryDenialCode | null {
  return CANARY_DENIAL_CODES.find((code) => code === value) ?? null;
}

/** A completed, cleaned-up send only. The digest binds all fields except itself. */
export type P02OsvEgressEvidenceV1 = Readonly<{
  schema_version: 1;
  unit_id: string;
  method: "POST" | "GET";
  url: string;
  request_sha256: string;
  body_sha256: string;
  plan_sha256: string;
  mapping_sha256: string;
  profile_sha256: string;
  deployment_sha256: string;
  worker_sha256: string;
  runtime_sha256: string;
  ca_sha256: string;
  allowed_ips: readonly string[];
  selected_ip: string;
  kernel_peer_ip: string;
  kernel_peer_port: 443;
  network_namespace_denied: true;
  isolation: "preconnected-socket-object-capability-bwrap-netns-v1";
  canary_ip: string;
  canary_denied: true;
  canary_error_code: CanaryDenialCode;
  running_properties: string;
  terminal_properties: string;
  worker_receipt_sha256: string;
  response_sha256: string;
  response_byte_count: number;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  terminal_phase: "completed";
  terminal_status: 200;
  cleanup_verified: true;
  evidence_sha256: string;
}>;
type UnsignedEvidence = Omit<P02OsvEgressEvidenceV1, "evidence_sha256">;
type PendingEvidence = Omit<UnsignedEvidence, "completed_at" | "duration_ms" | "cleanup_verified">;

/** Only an issued object can be read; no hooks, response bytes, or mutable internal references escape. */
export function readP02OsvTransportEvidenceV1(
  transport: unknown
): readonly P02OsvEgressEvidenceV1[] {
  if (!isIssuedP02OsvTransport(transport)) fail("unissued_transport");
  const entry = issued.get(transport);
  if (!entry) fail("unissued_transport");
  return Object.freeze(
    entry.evidence.map((record) =>
      Object.freeze({ ...record, allowed_ips: Object.freeze([...record.allowed_ips]) })
    )
  );
}

function absolute(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    value !== "/" &&
    !value.includes("/../")
  );
}
function fail(code: string): never {
  throw new Error(`p02_osv_${code}`);
}
function pins(c: P02OsvHostConfig) {
  return [
    c.runtime,
    ...c.closure,
    c.ca,
    c.deployment,
    { path: BWRAP, sha256: c.controls.bwrap },
    { path: SYSTEMD_RUN, sha256: c.controls.systemd_run },
    { path: SYSTEMCTL, sha256: c.controls.systemctl },
    { path: SCRATCH_LAUNCHER, sha256: c.controls.scratch_launcher },
    { path: MOUNT, sha256: c.controls.mount },
    { path: SETPRIV, sha256: c.controls.setpriv },
  ];
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
const RESERVED = ["/proc", "/dev", "/sys", "/run", "/tmp", "/var", "/osv", "/scratch"];
function safeDestination(c: P02OsvHostConfig, file: string, runtime = false): boolean {
  const nestedHome = /^\/home\/[^/]+\/(?:[^/]+\/){2,}[^/]+$/.test(file);
  return (
    absolute(file) &&
    !RESERVED.some((root) => overlaps(root, file)) &&
    !overlaps(c.workspace_parent, file) &&
    (!overlaps("/home", file) || (runtime && nestedHome))
  );
}
/** CA and deployment are host-side sources copied to fixed sandbox destinations, not mount destinations. */
function safeStagedSource(c: P02OsvHostConfig, file: string): boolean {
  return absolute(file) && !overlaps(c.workspace_parent, file);
}
/** Revalidate lexical and resolved identities, including closure links, before and after use. */
async function originalPins(
  c: P02OsvHostConfig,
  workerSha: string,
  baseline?: ReadonlyMap<string, VerifiedP02OsvPin>
) {
  const specs = [
    { pin: c.runtime, allowSymlink: false },
    ...c.closure.map((pin) => ({ pin, allowSymlink: true })),
    { pin: c.ca, allowSymlink: false },
    { pin: c.deployment, allowSymlink: false },
    { pin: { path: BWRAP, sha256: c.controls.bwrap }, allowSymlink: false },
    { pin: { path: SYSTEMD_RUN, sha256: c.controls.systemd_run }, allowSymlink: false },
    { pin: { path: SYSTEMCTL, sha256: c.controls.systemctl }, allowSymlink: false },
    { pin: { path: WORKER, sha256: workerSha }, allowSymlink: false },
    { pin: { path: SCRATCH_LAUNCHER, sha256: c.controls.scratch_launcher }, allowSymlink: false },
    { pin: { path: MOUNT, sha256: c.controls.mount }, allowSymlink: false },
    { pin: { path: SETPRIV, sha256: c.controls.setpriv }, allowSymlink: false },
  ];
  return verifyP02OsvPinSet(
    specs.map(({ pin, allowSymlink }) => ({
      pin,
      allowSymlink,
      allowedTarget: (target: string) => !allowSymlink || safeDestination(c, target),
    })),
    baseline
  );
}
async function preflight(c: P02OsvHostConfig, workerSha: string) {
  if (process.platform !== "linux" || !process.getuid || process.getuid() === 0)
    fail("environment");
  const uid = process.getuid();
  const bus = await lstat(`/run/user/${uid}/bus`);
  const runtime = await lstat(`/run/user/${uid}`);
  const workspace = await lstat(c.workspace_parent);
  if (
    !bus.isSocket() ||
    bus.uid !== uid ||
    !runtime.isDirectory() ||
    runtime.uid !== uid ||
    (runtime.mode & 0o077) !== 0 ||
    !absolute(c.workspace_parent) ||
    !workspace.isDirectory() ||
    workspace.isSymbolicLink() ||
    workspace.uid !== uid ||
    (workspace.mode & 0o077) !== 0 ||
    (await realpath(c.workspace_parent)) !== c.workspace_parent
  )
    fail("workspace");
  const verified = await originalPins(c, workerSha);
  let stagedBytes = verified.get(WORKER)?.size ?? fail("pin_missing");
  for (const pin of [SCRATCH_LAUNCHER, MOUNT, SETPRIV])
    stagedBytes += verified.get(pin)?.size ?? fail("pin_missing");
  for (const pin of [c.runtime, ...c.closure, c.ca, c.deployment]) {
    stagedBytes += verified.get(pin.path)?.size ?? fail("pin_missing");
    if (stagedBytes > 536_870_912) fail("stage_limit");
  }
  return verified;
}
export function validateP02OsvHostConfig(value: unknown): P02OsvHostConfig {
  const c = validateContract(P02_OSV_HOST_SCHEMA, value, "P02 OSV host configuration");
  const ips = configuredPublicOsvIps(c.ips);
  const canary = configuredPublicOsvIps([c.canary_ip])[0];
  if (
    canary === undefined ||
    ips.some((ip) => ip.address === canary.address) ||
    c.component_request.network_policy !== "fixed_osv_origin_authorized" ||
    c.component_request.coordinates.length === 0 ||
    !absolute(c.workspace_parent) ||
    overlaps(c.workspace_parent, "/home") ||
    !absolute(c.runtime.path) ||
    !absolute(c.ca.path) ||
    !absolute(c.deployment.path) ||
    c.ca.path === c.runtime.path ||
    c.closure.some((pin) => !absolute(pin.path)) ||
    new Set(pins(c).map((pin) => pin.path)).size !== pins(c).length ||
    !safeDestination(c, c.runtime.path, true) ||
    c.closure.some((pin) => !safeDestination(c, pin.path)) ||
    !safeStagedSource(c, c.ca.path) ||
    !safeStagedSource(c, c.deployment.path)
  )
    fail("configuration");
  planScaOsvV2(c.component_request);
  return c;
}
export function p02OsvProfileDigest(c: P02OsvHostConfig, workerSha: string): string {
  const { profile_sha256: _omitted, ...profile } = c;
  void _omitted;
  return sha256(
    canonicalJson({
      profile,
      worker_sha256: workerSha,
      isolation: "preconnected-socket-object-capability-bwrap-netns-v1",
    })
  );
}
export function isIssuedP02OsvTransport(value: unknown): value is ScaOsvV2Transport {
  return typeof value === "object" && value !== null && issued.has(value);
}
export function matchesIssuedP02OsvTransport(
  value: unknown,
  input: {
    transport_id: string;
    isolation_profile_id: string;
    isolation_profile_sha256: string;
    isolation_deployment_sha256: string;
    isolation_qualification_scope: string;
  },
  component: unknown
): boolean {
  if (!isIssuedP02OsvTransport(value)) return false;
  const entry = issued.get(value);
  if (!entry) return false;
  try {
    const plan = planScaOsvV2(component);
    return (
      input.isolation_qualification_scope === "live_qualified" &&
      input.transport_id === entry.config.transport_id &&
      input.isolation_profile_id === entry.config.profile_id &&
      input.isolation_profile_sha256 === entry.config.profile_sha256 &&
      input.isolation_deployment_sha256 === entry.config.deployment.sha256 &&
      plan.plan_sha256 === entry.plan.plan_sha256 &&
      canonicalJson(component) === canonicalJson(entry.config.component_request)
    );
  } catch {
    return false;
  }
}
const scopeName = /^p02-osv-[a-f0-9]{32}\.scope$/;
const propertyNames = [
  "Id",
  "ActiveState",
  "SubState",
  "ControlGroup",
  "TasksCurrent",
  "MemoryMax",
  "TasksMax",
  "CPUQuotaPerSecUSec",
] as const;
const propertyQuery = `--property=${propertyNames.join(",")}`;
export function verifyP02OsvUnit(
  text: string,
  unit: string,
  c: P02OsvHostConfig,
  phase: "running" | "stopped"
): boolean {
  if (!scopeName.test(unit)) return false;
  const lines = text.trim().split("\n");
  if (lines.length !== propertyNames.length || lines.some((line) => !line.includes("=")))
    return false;
  const pairs: [string, string][] = lines.map((line) => [
    line.slice(0, line.indexOf("=")),
    line.slice(line.indexOf("=") + 1),
  ]);
  const p = new Map(pairs);
  if (p.size !== propertyNames.length || propertyNames.some((name) => !p.has(name))) return false;
  const tasks = Number(p.get("TasksCurrent"));
  return (
    p.get("Id") === unit &&
    p.get("ControlGroup")?.endsWith(`/${unit}`) === true &&
    p.get("MemoryMax") === String(c.limits.memory_bytes) &&
    p.get("TasksMax") === String(c.limits.tasks) &&
    [
      `${c.limits.cpu_percent * 10000}us`,
      `${c.limits.cpu_percent * 10}ms`,
      ...(c.limits.cpu_percent === 100 ? ["1s"] : []),
    ].includes(p.get("CPUQuotaPerSecUSec") ?? "") &&
    (phase === "running"
      ? p.get("ActiveState") === "active" &&
        p.get("SubState") === "running" &&
        tasks > 0 &&
        tasks <= c.limits.tasks
      : ["inactive", "failed"].includes(p.get("ActiveState") ?? "") &&
        ["dead", "failed"].includes(p.get("SubState") ?? "") &&
        ["0", "[not set]"].includes(p.get("TasksCurrent") ?? ""))
  );
}
// Only already-verified, bounded unit properties can enter collection evidence.
// A compromised show response must not smuggle workspace paths or error text into the record.
function evidenceProperties(
  text: string,
  unit: string,
  c: P02OsvHostConfig,
  terminal = false
): string {
  const group = text
    .split("\n")
    .find((line) => line.startsWith("ControlGroup="))
    ?.slice(13);
  if (
    Buffer.byteLength(text, "utf8") > 8192 ||
    !/^[\x20-\x7e\n]*$/.test(text) ||
    text.includes(c.workspace_parent) ||
    (!terminal &&
      (group === undefined ||
        !group.startsWith("/user.slice/") ||
        !group.endsWith(`/${unit}`) ||
        !/^\/[A-Za-z0-9_.@/-]+$/.test(group)))
  )
    fail("evidence_properties");
  return text;
}
const cleanupQuery = "--property=LoadState,ActiveState,SubState,TasksCurrent";
export function verifyP02OsvCleanup(text: string): boolean {
  const lines = text.trim().split("\n");
  if (lines.length !== 4 || lines.some((line) => !line.includes("="))) return false;
  const entries = lines.map(
    (line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const
  );
  const p = new Map(entries);
  if (
    p.size !== 4 ||
    ["LoadState", "ActiveState", "SubState", "TasksCurrent"].some((name) => !p.has(name))
  )
    return false;
  return (
    ["0", "[not set]"].includes(p.get("TasksCurrent") ?? "") &&
    ((["loaded", "not-found"].includes(p.get("LoadState") ?? "") &&
      p.get("ActiveState") === "inactive" &&
      p.get("SubState") === "dead") ||
      (p.get("LoadState") === "loaded" &&
        p.get("ActiveState") === "failed" &&
        p.get("SubState") === "failed"))
  );
}
function bwrapArgs(c: P02OsvHostConfig, work: string): string[] {
  const runtimeFiles = [
    c.runtime,
    { path: MOUNT, sha256: c.controls.mount },
    { path: SETPRIV, sha256: c.controls.setpriv },
    ...c.closure,
  ];
  const dirs = new Set(["/osv", "/scratch"]);
  for (const pin of runtimeFiles)
    for (let dir = path.dirname(pin.path); dir !== "/"; dir = path.dirname(dir)) dirs.add(dir);
  const args = [
    "--die-with-parent",
    "--unshare-user",
    "--uid",
    "0",
    "--gid",
    "0",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--unshare-net",
    // The one connected socket occupies stdin; Node execve preserves only stdio.
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CAP_SYS_ADMIN",
    "--cap-add",
    "CAP_SETPCAP",
    "--clearenv",
    "--setenv",
    "HOME",
    "/scratch",
    "--setenv",
    "TMPDIR",
    "/scratch",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  for (const dir of [...dirs].sort((a, b) => a.length - b.length || a.localeCompare(b)))
    args.push("--dir", dir);
  for (const [index, pin] of runtimeFiles.entries())
    args.push("--ro-bind", path.join(work, "pins", String(index)), pin.path);
  args.push(
    "--ro-bind",
    path.join(work, "pins", "worker"),
    "/osv/p02-osv-worker.mjs",
    "--ro-bind",
    path.join(work, "pins", "scratch-launcher"),
    "/osv/p02-scratch-launcher.mjs",
    "--ro-bind",
    path.join(work, "pins", "ca"),
    "/osv/ca.pem",
    "--ro-bind",
    path.join(work, "pins", "deployment"),
    "/osv/deployment",
    "--ro-bind",
    path.join(work, "request.json"),
    "/osv/request.json",
    "--bind",
    path.join(work, "control"),
    "/osv/control",
    "--tmpfs",
    "/scratch",
    "--remount-ro",
    "/",
    "--remount-ro",
    "/dev",
    "--chdir",
    "/scratch",
    "--",
    c.runtime.path,
    "--no-warnings",
    "/osv/p02-scratch-launcher.mjs",
    String(c.limits.scratch_bytes),
    c.runtime.path,
    c.runtime.sha256,
    c.controls.scratch_launcher,
    c.controls.mount,
    c.controls.setpriv
  );
  return args;
}
export function buildP02OsvSystemdArgs(
  c: P02OsvHostConfig,
  work: string,
  unit: string
): readonly string[] {
  validateP02OsvHostConfig(c);
  if (!absolute(work) || !scopeName.test(unit)) fail("argv");
  return [
    "--user",
    "--scope",
    "--quiet",
    `--unit=${unit}`,
    "--property=MemoryMax=" + c.limits.memory_bytes,
    "--property=TasksMax=" + c.limits.tasks,
    `--property=CPUQuota=${c.limits.cpu_percent}%`,
    "--",
    BWRAP,
    ...bwrapArgs(c, work),
  ];
}
export function buildP02OsvKillArgs(unit: string): readonly string[] {
  if (!scopeName.test(unit)) fail("argv");
  return ["--user", "kill", "--kill-who=all", "--signal=SIGKILL", unit];
}
function busEnv(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  if (!uid) fail("environment");
  return {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
}
async function command(exe: string, args: readonly string[], timeout: number) {
  const child = spawn(exe, [...args], {
    shell: false,
    env: busEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 8192) child.kill("SIGKILL");
    });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, output };
  } finally {
    clearTimeout(timer);
  }
}
/** Only the first closed-profile IP is used. Never retry a failed connect in this capability. */
export async function connectP02OsvPeer(
  ip: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Socket> {
  signal.throwIfAborted();
  if (
    configuredPublicOsvIps([ip])[0]?.address !== ip ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    fail("peer_input");
  const socket = connect({ host: ip, port: 443, family: ip.includes(":") ? 6 : 4 });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => done(Error("connect_timeout")), timeoutMs);
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", cancel);
        socket.off("error", onError);
        socket.off("connect", onConnect);
        if (error) {
          socket.destroy();
          reject(error);
        } else resolve();
      };
      const cancel = () => done(Error("connect_cancelled"));
      const onError = (error: Error) => done(error);
      const onConnect = () => {
        socket.pause();
        done();
      };
      signal.addEventListener("abort", cancel, { once: true });
      socket.once("error", onError);
      socket.once("connect", onConnect);
      if (signal.aborted) cancel();
    });
    const peer = socket.remoteAddress;
    if (!peer || configuredPublicOsvIps([peer])[0]?.address !== ip || socket.remotePort !== 443)
      fail("kernel_peer");
    signal.throwIfAborted();
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
function launchScope(
  args: readonly string[],
  socket: Socket
): Promise<{ child: ChildProcess; exit: Promise<number | null> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(SYSTEMD_RUN, [...args], {
      shell: false,
      env: busEnv(),
      stdio: [socket, "pipe", "pipe"],
    });
    let output = 0;
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk: Buffer) => {
        output += chunk.length;
        if (output > 8192) child.kill("SIGKILL");
      });
    const exit = new Promise<number | null>((done) => {
      child.once("close", done);
    });
    child.once("error", reject);
    child.once("spawn", () => resolve({ child, exit }));
  });
}
async function show(unit: string) {
  return command(SYSTEMCTL, ["--user", "show", unit, propertyQuery], 5000);
}
async function waitFor(
  test: () => Promise<boolean>,
  signal: AbortSignal,
  ms: number
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    signal.throwIfAborted();
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  fail("timeout");
}
export function validateP02OsvReceipt(
  bytes: Buffer,
  requestHash: string,
  payload: WorkerPayload,
  c: P02OsvHostConfig
): ScaOsvV2TransportResponse {
  if (bytes.length > c.limits.output_bytes || bytes.length < 10) fail("receipt_size");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("receipt_json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("receipt_shape");
  const receipt = validateContract(
    Type.Record(Type.String(), Type.Unknown()),
    value,
    "P02 OSV receipt"
  );
  const keys = [
    "nonce",
    "unit",
    "request_sha256",
    "body_sha256",
    "plan_sha256",
    "mapping_sha256",
    "worker_sha256",
    "deployment_sha256",
    "runtime_sha256",
    "ca_sha256",
    "scratch_bytes",
    "scratch_capacity_bytes",
    "worker_caps_zero",
    "no_new_privileges",
    "scratch_launcher_sha256",
    "ip",
    "kernel_peer_ip",
    "kernel_peer_port",
    "network_namespace_denied",
    "canary_ip",
    "canary_denied",
    "canary_error_code",
    "phase",
    "code",
    "status",
    "response_sha256",
    "response_base64",
  ];
  if (Object.keys(receipt).sort().join("|") !== keys.sort().join("|")) fail("receipt_shape");
  if (
    canonicalJson(receipt) + "\n" !== bytes.toString("utf8") ||
    receipt.nonce !== payload.nonce ||
    receipt.unit !== payload.unit ||
    receipt.request_sha256 !== requestHash ||
    receipt.body_sha256 !== payload.body_sha256 ||
    receipt.plan_sha256 !== payload.plan_sha256 ||
    receipt.mapping_sha256 !== payload.mapping_sha256 ||
    receipt.worker_sha256 !== payload.worker_sha256 ||
    receipt.deployment_sha256 !== payload.deployment_sha256 ||
    receipt.runtime_sha256 !== payload.runtime_sha256 ||
    receipt.ca_sha256 !== payload.ca_sha256 ||
    receipt.scratch_bytes !== c.limits.scratch_bytes ||
    receipt.scratch_bytes !== payload.scratch_bytes ||
    receipt.scratch_capacity_bytes !== payload.scratch_bytes ||
    receipt.worker_caps_zero !== true ||
    receipt.no_new_privileges !== true ||
    receipt.scratch_launcher_sha256 !== payload.scratch_launcher_sha256 ||
    receipt.ip !== payload.ip ||
    receipt.kernel_peer_ip !== payload.ip ||
    receipt.kernel_peer_port !== 443 ||
    receipt.network_namespace_denied !== true ||
    receipt.canary_ip !== payload.canary_ip ||
    receipt.canary_denied !== true ||
    canaryDenialCode(receipt.canary_error_code) === null
  )
    fail("receipt_binding");
  if (
    receipt.phase !== "completed" ||
    receipt.code !== "none" ||
    receipt.status !== 200 ||
    typeof receipt.response_base64 !== "string"
  )
    fail(`outcome_${String(receipt.phase)}_${String(receipt.code)}`);
  const body = Buffer.from(receipt.response_base64, "base64");
  if (
    body.toString("base64") !== receipt.response_base64 ||
    sha256(body) !== receipt.response_sha256 ||
    body.length > payload.max_response_bytes
  )
    fail("response_binding");
  return { status_code: 200, final_url: payload.url, redirected: false, body };
}
export type WorkerPayload = Readonly<{
  nonce: string;
  unit: string;
  url: string;
  method: "POST" | "GET";
  request_body: string | null;
  advisory_id: string | null;
  coordinate_ids: readonly string[];
  body_sha256: string;
  plan_sha256: string;
  mapping_sha256: string;
  worker_sha256: string;
  deployment_sha256: string;
  runtime_sha256: string;
  ca_sha256: string;
  scratch_bytes: number;
  scratch_launcher_sha256: string;
  mount_sha256: string;
  setpriv_sha256: string;
  node_path: string;
  node_sha256: string;
  ips: readonly string[];
  ip: string;
  kernel_peer_port: 443;
  canary_ip: string;
  max_response_bytes: number;
  timeout_ms: number;
}>;
async function run(
  c: P02OsvHostConfig,
  plan: ReturnType<typeof planScaOsvV2>,
  request: ScaOsvV2TransportRequest
): Promise<{ response: ScaOsvV2TransportResponse; evidence: PendingEvidence }> {
  const wall = AbortSignal.timeout(c.limits.runtime_ms + 15000);
  const signal = AbortSignal.any([request.signal, wall]);
  signal.throwIfAborted();
  const workerSha = sha256(await readFile(WORKER));
  const verified = await preflight(c, workerSha);
  signal.throwIfAborted();
  if (p02OsvProfileDigest(c, workerSha) !== c.profile_sha256) fail("profile_drift");
  const unit = `p02-osv-${randomBytes(16).toString("hex")}.scope`;
  const work = await mkdtemp(path.join(c.workspace_parent, "p02-osv-"));
  let launched = false,
    safe = false,
    sendGateOpened = false;
  let peer: Socket | null = null;
  try {
    await mkdir(path.join(work, "pins"), { mode: 0o700 });
    await mkdir(path.join(work, "control"), { mode: 0o700 });
    const staged = [
      ...[
        c.runtime,
        { path: MOUNT, sha256: c.controls.mount },
        { path: SETPRIV, sha256: c.controls.setpriv },
        ...c.closure,
      ].map((pin, index) => ({ ...pin, name: String(index) })),
      { path: WORKER, sha256: workerSha, name: "worker" },
      { path: SCRATCH_LAUNCHER, sha256: c.controls.scratch_launcher, name: "scratch-launcher" },
      { ...c.ca, name: "ca" },
      { ...c.deployment, name: "deployment" },
    ];
    for (const pin of staged) {
      const target = path.join(work, "pins", pin.name);
      await copyFile(
        verified.get(pin.path)?.source ?? fail("pin_missing"),
        target,
        constants.COPYFILE_EXCL
      );
      await chmod(
        target,
        (await lstat(verified.get(pin.path)?.source ?? fail("pin_missing"))).mode & 0o555
      );
      await verifyP02OsvPin({ path: target, sha256: pin.sha256 });
      signal.throwIfAborted();
    }
    const batch = plan.batches.find(
      (entry) => entry.request_body === request.body && request.method === "POST"
    );
    const advisoryId =
      request.method === "GET"
        ? decodeURIComponent(new URL(request.url).pathname.slice("/v1/vulns/".length))
        : null;
    const payload: WorkerPayload = {
      nonce: randomBytes(32).toString("hex"),
      unit,
      url: request.url,
      method: request.method,
      request_body: request.body,
      advisory_id: advisoryId,
      coordinate_ids: batch?.coordinate_ids ?? [],
      body_sha256: sha256(request.body ?? ""),
      plan_sha256: plan.plan_sha256,
      mapping_sha256: sha256(canonicalJson(c.component_request.coordinate_occurrences)),
      worker_sha256: workerSha,
      deployment_sha256: c.deployment.sha256,
      runtime_sha256: c.runtime.sha256,
      ca_sha256: c.ca.sha256,
      scratch_bytes: c.limits.scratch_bytes,
      scratch_launcher_sha256: c.controls.scratch_launcher,
      mount_sha256: c.controls.mount,
      setpriv_sha256: c.controls.setpriv,
      node_path: c.runtime.path,
      node_sha256: c.runtime.sha256,
      ips: c.ips,
      ip: c.ips[0] ?? "",
      kernel_peer_port: 443,
      canary_ip: c.canary_ip,
      max_response_bytes: request.max_response_bytes,
      timeout_ms: request.inactivity_timeout_ms,
    };
    const bytes = Buffer.from(canonicalJson(payload) + "\n");
    const requestHash = sha256(bytes);
    await writeFile(path.join(work, "request.json"), bytes, { flag: "wx", mode: 0o400 });
    await originalPins(c, workerSha, verified);
    signal.throwIfAborted();
    // Connect before scope creation; the paused kernel socket is the only OSV egress grant.
    peer = await connectP02OsvPeer(payload.ip, signal, Math.min(5000, c.limits.runtime_ms));
    let scope: Awaited<ReturnType<typeof launchScope>>;
    try {
      signal.throwIfAborted();
      launched = true; // A failed launcher may still have created the scope.
      scope = await launchScope(buildP02OsvSystemdArgs(c, work, unit), peer);
    } finally {
      peer.destroy(); // Close parent's duplicate immediately on spawn (also on failure).
      peer = null;
    }
    const running = async () => {
      const s = await show(unit);
      return s.code === 0
        ? verifyP02OsvUnit(s.output, unit, c, "running")
          ? s.output
          : null
        : null;
    };
    await waitFor(async () => (await running()) !== null, signal, 5000);
    await writeFile(path.join(work, "control", "policy"), "ok\n", { flag: "wx", mode: 0o600 });
    await waitFor(
      () => verifyP02ReadyFile(path.join(work, "control", "canary"), requestHash),
      signal,
      5000
    );
    const runningProperties = await running(); // The second, immediately pre-gate policy recheck.
    if (runningProperties === null) fail("policy_drift");
    evidenceProperties(runningProperties, unit, c);
    signal.throwIfAborted();
    const startedAt = Date.now();
    sendGateOpened = true; // Conservative: a failed gate write may still have released a send.
    await writeFile(path.join(work, "control", "go"), "ok\n", { flag: "wx", mode: 0o600 });
    // Receipt arrives while the scope is still running; the worker awaits finish.
    await waitFor(
      async () =>
        (await lstat(path.join(work, "control", "receipt.json")).catch(() => null))?.isFile() ===
        true,
      signal,
      c.limits.runtime_ms
    );
    const receiptPath = path.join(work, "control", "receipt.json");
    const receiptInfo = await lstat(receiptPath);
    if (
      !receiptInfo.isFile() ||
      receiptInfo.isSymbolicLink() ||
      receiptInfo.nlink !== 1 ||
      receiptInfo.uid !== process.getuid?.() ||
      (receiptInfo.mode & 0o777) !== 0o600 ||
      receiptInfo.size < 10 ||
      receiptInfo.size > c.limits.output_bytes
    )
      fail("receipt_size");
    const receipt = await readFile(receiptPath, {
      flag: constants.O_RDONLY | constants.O_NOFOLLOW,
    });
    const response = validateP02OsvReceipt(receipt, requestHash, payload, c);
    const receiptValue: unknown = JSON.parse(receipt.toString("utf8"));
    const canaryErrorCode =
      typeof receiptValue === "object" && receiptValue !== null
        ? canaryDenialCode(Reflect.get(receiptValue, "canary_error_code"))
        : null;
    if (canaryErrorCode === null) fail("receipt_binding");
    const postReceipt = await running();
    if (postReceipt === null) fail("policy_drift");
    evidenceProperties(postReceipt, unit, c);
    signal.throwIfAborted();
    await writeFile(path.join(work, "control", "finish"), requestHash + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    const exitCode = await Promise.race([
      scope.exit,
      new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(Error("scope_cancelled"));
          return;
        }
        signal.addEventListener("abort", () => reject(Error("scope_cancelled")), { once: true });
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(Error("scope_exit_timeout")), c.limits.runtime_ms);
        scope.exit.then(() => clearTimeout(timer));
      }),
    ]);
    if (exitCode !== 0) fail("scope_exit");
    if (
      (await readdir(path.join(work, "control"))).sort().join("|") !==
      "canary|finish|go|policy|receipt.json"
    )
      fail("output_shape");
    const ended = await command(SYSTEMCTL, ["--user", "show", unit, cleanupQuery], 5000);
    if (ended.code !== 0 || !verifyP02OsvCleanup(ended.output)) fail("terminal_mismatch");
    const terminalProperties = evidenceProperties(ended.output, unit, c, true);
    await originalPins(c, workerSha, verified);
    for (const pin of staged)
      await verifyP02OsvPin({ path: path.join(work, "pins", pin.name), sha256: pin.sha256 });
    if (batch) parseScaOsvV2BatchResults(batch, response.body);
    signal.throwIfAborted();
    return {
      response,
      evidence: {
        schema_version: 1,
        unit_id: unit,
        method: request.method,
        url: request.url,
        request_sha256: requestHash,
        body_sha256: payload.body_sha256,
        plan_sha256: payload.plan_sha256,
        mapping_sha256: payload.mapping_sha256,
        profile_sha256: c.profile_sha256,
        deployment_sha256: payload.deployment_sha256,
        worker_sha256: payload.worker_sha256,
        runtime_sha256: payload.runtime_sha256,
        ca_sha256: payload.ca_sha256,
        allowed_ips: [...c.ips],
        selected_ip: payload.ip,
        kernel_peer_ip: payload.ip,
        kernel_peer_port: 443,
        network_namespace_denied: true,
        isolation: "preconnected-socket-object-capability-bwrap-netns-v1",
        canary_ip: payload.canary_ip,
        canary_denied: true,
        canary_error_code: canaryErrorCode,
        running_properties: `${runningProperties}\n${postReceipt}`,
        terminal_properties: terminalProperties,
        worker_receipt_sha256: sha256(receipt),
        response_sha256: sha256(response.body),
        response_byte_count: response.body.length,
        started_at: new Date(startedAt).toISOString(),
        terminal_phase: "completed",
        terminal_status: 200,
      },
    };
  } catch (error) {
    if (sendGateOpened)
      throw new Error(
        `p02_osv_post_send_uncertain:${error instanceof Error ? error.message : "unknown"}`
      );
    throw error;
  } finally {
    peer?.destroy();
    if (launched) {
      await command(SYSTEMCTL, buildP02OsvKillArgs(unit), 5000).catch(() => undefined);
      await command(SYSTEMCTL, ["--user", "stop", unit], 5000).catch(() => undefined);
      const stopped = await command(SYSTEMCTL, ["--user", "show", unit, cleanupQuery], 5000).catch(
        () => ({ code: null, output: "" })
      );
      safe = stopped.code === 0 && verifyP02OsvCleanup(stopped.output);
      if (safe)
        await command(SYSTEMCTL, ["--user", "reset-failed", unit], 5000).catch(() => undefined);
    } else safe = true;
    let drift = false;
    if (launched && safe) {
      try {
        await originalPins(c, workerSha, verified);
      } catch {
        drift = true;
      }
    }
    if (safe)
      await rm(work, { recursive: true, force: false }).catch(() => {
        safe = false;
      });
    if (drift) fail("post_execution_drift");
    if (
      !safe ||
      (await stat(work).then(
        () => true,
        () => false
      ))
    )
      fail(`termination_or_cleanup_uncertain:${work}`);
    if (signal.aborted) fail(sendGateOpened ? "post_send_uncertain:timeout" : "timeout");
  }
}
/** Factory-issued capability. Creation is offline; each send performs fresh pin and effective-policy checks. */
export function createP02OsvExternalTransport(value: unknown): ScaOsvV2Transport {
  const config = validateP02OsvHostConfig(value);
  const c = validateP02OsvHostConfig(JSON.parse(canonicalJson(config)));
  const plan = planScaOsvV2(c.component_request);
  let queue: Promise<unknown> = Promise.resolve();
  const observed = new Set<string>();
  const attempted = new Set<string>();
  const evidence: P02OsvEgressEvidenceV1[] = [];
  const transport: ScaOsvV2Transport = Object.freeze({
    ip_confinement: "external_worker_enforced" as const,
    send(request: ScaOsvV2TransportRequest): Promise<ScaOsvV2TransportResponse> {
      const operation = async () => {
        if (
          !exactAllowedTransportRequest(request) ||
          request.signal.aborted ||
          request.inactivity_timeout_ms !== c.component_request.inactivity_timeout_ms ||
          request.max_response_bytes > Math.floor(((c.limits.output_bytes - 2048) * 3) / 4) ||
          request.max_response_bytes > c.component_request.max_response_bytes ||
          request.max_response_bytes < 1
        )
          fail("request");
        const batch = plan.batches.find(
          (entry) =>
            entry.request_body === request.body &&
            request.method === "POST" &&
            request.url === entry.url
        );
        const advisoryId =
          request.method === "GET"
            ? decodeURIComponent(new URL(request.url).pathname.slice("/v1/vulns/".length))
            : null;
        if (!batch && (advisoryId === null || !observed.has(advisoryId))) fail("mapping_drift");
        const requestKey = batch?.batch_id ?? `advisory:${advisoryId}`;
        if (attempted.has(requestKey)) fail("duplicate_send");
        attempted.add(requestKey); // Even a failed or uncertain send cannot be repeated in this capability.
        try {
          const { response: result, evidence: unsigned } = await run(c, plan, request);
          if (batch) {
            const mapped = parseScaOsvV2BatchResults(batch, result.body);
            for (const item of mapped) for (const id of item.advisory_ids) observed.add(id);
            if (observed.size > c.component_request.max_advisory_requests) fail("advisory_limit");
          } else if (advisoryId !== null) {
            const parsed: unknown = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(result.body)
            );
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("id" in parsed) ||
              parsed.id !== advisoryId
            )
              fail("mapping_drift");
          }
          // Append only after run's finally has verified zero tasks, removed the workspace,
          // and rechecked original pins, and after the outer batch/advisory validation.
          if (evidence.length >= plan.batches.length + c.component_request.max_advisory_requests)
            fail("evidence_limit");
          const completedAt = Date.now();
          const completed: UnsignedEvidence = {
            ...unsigned,
            completed_at: new Date(completedAt).toISOString(),
            duration_ms: completedAt - Date.parse(unsigned.started_at),
            cleanup_verified: true,
          };
          const record: P02OsvEgressEvidenceV1 = Object.freeze({
            ...completed,
            allowed_ips: Object.freeze([...completed.allowed_ips]),
            evidence_sha256: sha256(canonicalJson(completed)),
          });
          evidence.push(record);
          return result;
        } catch (error) {
          if (error instanceof ScaOsvV2TransportError) throw error;
          const detail = error instanceof Error ? error.message : "p02_osv_uncertain";
          const code = request.signal.aborted
            ? "cancelled"
            : detail.endsWith("_inactivity_timeout") || detail.endsWith("p02_osv_timeout")
              ? "inactivity_timeout"
              : detail.endsWith("_response_too_large")
                ? "response_too_large"
                : detail.endsWith("_redirect_refused")
                  ? "redirect_refused"
                  : "transport_failed";
          throw new ScaOsvV2TransportError(code, detail);
        }
      };
      const result = queue.then(operation);
      queue = result.catch(() => undefined);
      return result;
    },
  });
  issued.set(transport, { config: c, plan, evidence });
  return transport;
}
