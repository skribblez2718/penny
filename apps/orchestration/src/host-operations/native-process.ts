import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { Sha256Schema, validateSkillSchema } from "../skill-contracts/common.js";

const closed = { additionalProperties: false } as const;
export const NativeProcessPinSchema = Type.Object(
  {
    pid: Type.Integer({ minimum: 1, maximum: 2147483647 }),
    boot_id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
    start_ticks: Type.String({ pattern: "^[0-9]+$", maxLength: 32 }),
    executable: Type.Object(
      { path: Type.String({ minLength: 1, maxLength: 4096 }), sha256: Sha256Schema },
      closed
    ),
    cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  closed
);
export type NativeProcessPin = Static<typeof NativeProcessPinSchema>;

/** Bounded proc/sysfs read. Never read environment, argv, or recursively discover files. */
export function readNativeText(file: string, maxBytes = 65536): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > maxBytes) throw new Error("native observation byte limit");
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
export function parseLinuxProcessStat(text: string) {
  // comm may contain spaces and ')' characters. Field 3 begins after the LAST ') '.
  const end = text.lastIndexOf(") ");
  const pid = text.slice(0, text.indexOf(" "));
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/u);
  const number = (index: number): string => {
    const value = fields[index];
    if (value === undefined || !/^[0-9]+$/u.test(value))
      throw new Error("native proc stat malformed");
    return value;
  };
  if (
    end < 2 ||
    !/^[1-9][0-9]*$/u.test(pid) ||
    fields.length < 22 ||
    fields[0] === "Z" ||
    fields[0] === "X"
  )
    throw new Error("native process unavailable");
  return {
    pid: Number(pid),
    parent_pid: Number(number(1)),
    start_ticks: number(19),
    cpu_ticks: BigInt(number(11)) + BigInt(number(12)),
  };
}
export function observeNativeProcess(pin: NativeProcessPin, hashFile: (file: string) => string) {
  validateSkillSchema(NativeProcessPinSchema, pin, "native process pin");
  if (
    process.platform !== "linux" ||
    !path.isAbsolute(pin.cwd) ||
    realpathSync(pin.cwd) !== pin.cwd
  )
    throw new Error("native Linux process pin invalid");
  const root = `/proc/${pin.pid}`;
  const before = parseLinuxProcessStat(readNativeText(`${root}/stat`));
  const boot_id = readNativeText("/proc/sys/kernel/random/boot_id", 128).trim();
  if (
    before.pid !== pin.pid ||
    before.start_ticks !== pin.start_ticks ||
    boot_id !== pin.boot_id ||
    readlinkSync(`${root}/exe`) !== pin.executable.path ||
    readlinkSync(`${root}/cwd`) !== pin.cwd ||
    hashFile(pin.executable.path) !== pin.executable.sha256
  )
    throw new Error("native pinned process unavailable/drifted");
  const after = parseLinuxProcessStat(readNativeText(`${root}/stat`));
  if (
    after.start_ticks !== before.start_ticks ||
    after.pid !== before.pid ||
    readlinkSync(`${root}/exe`) !== pin.executable.path ||
    readlinkSync(`${root}/cwd`) !== pin.cwd
  )
    throw new Error("native process changed during observation");
  return {
    pid: pin.pid,
    process_epoch: sha256(
      canonicalJson({
        pid: pin.pid,
        boot_id,
        start_ticks: pin.start_ticks,
        executable_sha256: pin.executable.sha256,
      })
    ),
  };
}
/** Stable streaming digest for a caller-pinned canonical executable/source file. */
export function nativeFileSha256(source: string): string {
  if (!path.isAbsolute(source) || realpathSync(source) !== source)
    throw new Error("native canonical file required");
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("native regular file required");
    const hash = createHash("sha256"),
      bytes = Buffer.alloc(1048576);
    let total = 0n,
      n: number;
    while ((n = readSync(fd, bytes, 0, bytes.length, null)) > 0) {
      total += BigInt(n);
      if (total > before.size) throw new Error("native file grew during hashing");
      hash.update(bytes.subarray(0, n));
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("native file changed during hashing");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
/** Exact nonrecursive private file census. Absence is observed; directories/links refuse.
 * logical bytes, not allocated blocks, compression, or an inferred peak between samples. */
export function measureNativePrivateFiles(files: readonly string[]) {
  if (files.length > 1024 || new Set(files).size !== files.length)
    throw new Error("native file census limit/duplicate");
  return files.map((file) => {
    if (!path.isAbsolute(file) || realpathSync(path.dirname(file)) !== path.dirname(file))
      throw new Error("native private file path invalid");
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { path_sha256: sha256(file), bytes: 0, identity: null };
      throw error;
    }
    try {
      const s = fstatSync(fd, { bigint: true });
      if (
        !s.isFile() ||
        s.nlink !== 1n ||
        s.uid !== BigInt(process.getuid?.() ?? -1) ||
        (s.mode & 0o077n) !== 0n ||
        s.size > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new Error("native private file unsafe");
      return {
        path_sha256: sha256(file),
        bytes: Number(s.size),
        identity: `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}`,
      };
    } finally {
      closeSync(fd);
    }
  });
}

/** An explicitly pinned service supervisor may own the CPU cgroup while a pinned child owns
 * CUDA. An unrelated sibling/master is never silently adopted as that supervisor. */
export function requireNativeDescendant(
  child: NativeProcessPin,
  supervisor: NativeProcessPin
): void {
  observeNativeProcess(supervisor, nativeFileSha256);
  observeNativeProcess(child, nativeFileSha256);
  let pid = child.pid;
  const seen = new Set<number>();
  while (pid !== supervisor.pid) {
    if (pid <= 1 || seen.has(pid) || seen.size >= 64)
      throw new Error("native CPU supervisor/process ownership drift");
    seen.add(pid);
    pid = parseLinuxProcessStat(readNativeText(`/proc/${pid}/stat`, 4096)).parent_pid;
  }
  observeNativeProcess(child, nativeFileSha256);
}
