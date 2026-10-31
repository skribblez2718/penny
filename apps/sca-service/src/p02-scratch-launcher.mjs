// Shared, built-ins-only privileged setup. Never a general command launcher.
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const MIN_SCRATCH_BYTES = 4096;
export const MAX_SCRATCH_BYTES = 2147483648;
const SETUP_CAPS = "0000000000200100"; // CAP_SYS_ADMIN | CAP_SETPCAP; no other authority.
const CAP_FIELDS = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const canon = (value) =>
  JSON.stringify(value, (_key, child) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b)))
      : child
  );
export function validateScratchBytes(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_SCRATCH_BYTES ||
    value > MAX_SCRATCH_BYTES ||
    value % 4096 !== 0
  )
    throw Error("scratch_limit");
  return value;
}
export function verifyNamespaceIdentity(status, uidMap, gidMap, uid, gid, pid, privileged) {
  for (const [label, value] of [
    ["Uid", uid],
    ["Gid", gid],
  ])
    if (value !== 0 || !new RegExp(`^${label}:\\s+0\\s+0\\s+0\\s+0$`, "m").test(status))
      throw Error("scratch_identity");
  for (const text of [uidMap, gidMap]) {
    const fields = text.trim().split(/\s+/u).map(Number);
    if (
      fields.length !== 3 ||
      fields[0] !== 0 ||
      !Number.isSafeInteger(fields[1]) ||
      fields[1] <= 0 ||
      fields[2] !== 1
    )
      throw Error("scratch_rootless_namespace");
  }
  if (!Number.isSafeInteger(pid) || pid < 1 || !new RegExp(`^NSpid:\\s+${pid}$`, "m").test(status))
    throw Error("scratch_pid_namespace");
  for (const field of CAP_FIELDS)
    if (!new RegExp(`^${field}:\\s+${privileged ? SETUP_CAPS : "0{16}"}$`, "m").test(status))
      throw Error("scratch_capabilities");
  if (!privileged && !/^NoNewPrivs:\s+1$/m.test(status)) throw Error("scratch_no_new_privileges");
}
export function verifyCurrentIdentity(privileged = false) {
  if (process.platform !== "linux") throw Error("scratch_platform");
  verifyNamespaceIdentity(
    readFileSync("/proc/self/status", "utf8"),
    readFileSync("/proc/self/uid_map", "utf8"),
    readFileSync("/proc/self/gid_map", "utf8"),
    process.getuid(),
    process.getgid(),
    process.pid,
    privileged
  );
}
export function scratchMountRecord(mountinfo, hardened = true) {
  const lines = mountinfo
    .trim()
    .split("\n")
    .map((line) => line.split(" "));
  const matches = lines.filter((fields) => fields[4] === "/scratch");
  if (matches.length !== 1 || lines.some((fields) => fields[4]?.startsWith("/scratch/")))
    throw Error("scratch_mount");
  const fields = matches[0];
  const sep = fields.indexOf("-");
  if (sep < 6 || fields[3] !== "/" || fields[sep + 1] !== "tmpfs") throw Error("scratch_tmpfs");
  const flags = fields[5].split(",");
  if (
    !flags.includes("rw") ||
    (hardened && ["nosuid", "nodev", "noexec"].some((flag) => !flags.includes(flag)))
  )
    throw Error("scratch_mount_flags");
  return { id: fields[0], device: fields[2] };
}
export function verifyScratchCapacity(limit, info) {
  validateScratchBytes(limit);
  if (
    info.type !== 0x01021994n ||
    info.bsize <= 0n ||
    BigInt(limit) % info.bsize !== 0n ||
    info.blocks * info.bsize !== BigInt(limit) ||
    info.bavail < 0n ||
    info.bavail > info.blocks
  )
    throw Error("scratch_capacity");
  return limit;
}
export function verifyBoundedScratch(limit) {
  scratchMountRecord(readFileSync("/proc/self/mountinfo", "utf8"));
  const dir = lstatSync("/scratch");
  if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync("/scratch") !== "/scratch")
    throw Error("scratch_path");
  return verifyScratchCapacity(limit, statfsSync("/scratch", { bigint: true }));
}
export function verifyPinnedFile(filename, digest) {
  const info = lstatSync(filename);
  if (
    !hex(digest) ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > 134217728 ||
    (info.mode & 0o222) !== 0 ||
    realpathSync(filename) !== filename
  )
    throw Error("scratch_pin_drift");
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const identity = (value) =>
    [
      value.dev,
      value.ino,
      value.uid,
      value.gid,
      value.mode,
      value.nlink,
      value.size,
      value.mtimeMs,
      value.ctimeMs,
    ].join(":");
  try {
    const before = fstatSync(fd);
    if (identity(before) !== identity(info)) throw Error("scratch_pin_drift");
    const digestState = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    for (let offset = 0; offset < before.size; ) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytes === 0) throw Error("scratch_pin_drift");
      digestState.update(buffer.subarray(0, bytes));
      offset += bytes;
    }
    if (
      digestState.digest("hex") !== digest ||
      identity(fstatSync(fd)) !== identity(before) ||
      identity(lstatSync(filename)) !== identity(before) ||
      realpathSync(filename) !== filename
    )
      throw Error("scratch_pin_drift");
  } finally {
    closeSync(fd);
  }
}
function launch() {
  verifyCurrentIdentity(true);
  const self = fileURLToPath(import.meta.url);
  const root = path.dirname(self);
  const workerName =
    root === "/p02" ? "p02-host-worker.mjs" : root === "/osv" ? "p02-osv-worker.mjs" : null;
  if (
    workerName === null ||
    self !== `${root}/p02-scratch-launcher.mjs` ||
    process.argv[1] !== self ||
    process.argv.length !== 8 ||
    process.execArgv.join("|") !== "--no-warnings" ||
    typeof process.execve !== "function"
  )
    throw Error("scratch_invocation");
  const [limitText, nodePath, nodeSha, launcherSha, mountSha, setprivSha] = process.argv.slice(2);
  if (!/^[1-9][0-9]*$/.test(limitText)) throw Error("scratch_limit");
  const limit = validateScratchBytes(Number(limitText));
  if (
    process.execPath !== nodePath ||
    !path.isAbsolute(nodePath) ||
    path.normalize(nodePath) !== nodePath
  )
    throw Error("scratch_node_drift");
  const requestFile = `${root}/request.json`;
  const requestInfo = lstatSync(requestFile);
  if (
    !requestInfo.isFile() ||
    requestInfo.nlink !== 1 ||
    (requestInfo.mode & 0o222) !== 0 ||
    requestInfo.size < 1 ||
    requestInfo.size > 16777216
  )
    throw Error("scratch_request_size");
  const input = readFileSync(requestFile, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
  const requestAfter = lstatSync(requestFile);
  if (
    input.length !== requestInfo.size ||
    requestInfo.ino !== requestAfter.ino ||
    requestInfo.dev !== requestAfter.dev ||
    requestInfo.mtimeMs !== requestAfter.mtimeMs ||
    requestInfo.ctimeMs !== requestAfter.ctimeMs
  )
    throw Error("scratch_request_binding");
  const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    canon(data) + "\n" !== input.toString("utf8") ||
    data.scratch_bytes !== limit ||
    data.node_path !== nodePath ||
    data.node_sha256 !== nodeSha ||
    data.scratch_launcher_sha256 !== launcherSha ||
    data.mount_sha256 !== mountSha ||
    data.setpriv_sha256 !== setprivSha ||
    !hex(data.worker_sha256)
  )
    throw Error("scratch_request_binding");
  if (root === "/p02") {
    const { request_sha256, ...payload } = data;
    if (request_sha256 !== hash(canon(payload)) || !/^p02-[a-f0-9]{32}\.service$/.test(data.unit))
      throw Error("scratch_request_binding");
  } else if (!/^p02-osv-[a-f0-9]{32}\.scope$/.test(data.unit))
    throw Error("scratch_request_binding");
  const worker = `${root}/${workerName}`;
  for (const [file, digest] of [
    [self, launcherSha],
    [worker, data.worker_sha256],
    [nodePath, nodeSha],
    ["/usr/bin/mount", mountSha],
    ["/usr/bin/setpriv", setprivSha],
  ])
    verifyPinnedFile(file, digest);
  const before = scratchMountRecord(readFileSync("/proc/self/mountinfo", "utf8"), false);
  if (readdirSync("/scratch").length !== 0) throw Error("scratch_not_empty");
  const env = { PATH: "/usr/bin:/bin", HOME: "/scratch", TMPDIR: "/scratch", LC_ALL: "C" };
  const mounted = spawnSync(
    "/usr/bin/mount",
    [
      "--internal-only",
      "--no-mtab",
      "--options-source",
      "disable",
      "-o",
      `remount,rw,nosuid,nodev,noexec,size=${limit}`,
      "--",
      "/scratch",
    ],
    { shell: false, env, stdio: "ignore", timeout: 5000 }
  );
  if (mounted.error || mounted.status !== 0 || mounted.signal !== null)
    throw Error("scratch_remount");
  const after = scratchMountRecord(readFileSync("/proc/self/mountinfo", "utf8"));
  if (before.id !== after.id || before.device !== after.device) throw Error("scratch_mount_drift");
  verifyBoundedScratch(limit);
  verifyCurrentIdentity(true);
  // execve preserves only stdio. OSV carries its sole connected socket on stdin.
  // Read-only staged pins are checked again immediately before exec. No privileged parent survives.
  for (const [file, digest] of [
    [self, launcherSha],
    [worker, data.worker_sha256],
    [nodePath, nodeSha],
    ["/usr/bin/mount", mountSha],
    ["/usr/bin/setpriv", setprivSha],
  ])
    verifyPinnedFile(file, digest);
  process.execve(
    "/usr/bin/setpriv",
    [
      "/usr/bin/setpriv",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--",
      process.execPath,
      "--no-warnings",
      worker,
      ...(root === "/p02" ? [data.unit] : []),
    ],
    env
  );
  throw Error("scratch_exec_returned");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    launch();
  } catch (error) {
    process.stderr.write(
      `${/^scratch_[a-z_]+$/.test(error?.message) ? error.message : "scratch_setup_failed"}\n`
    );
    process.exitCode = 1;
  }
}
