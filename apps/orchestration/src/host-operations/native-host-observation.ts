import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { canonicalJson } from "../canonical-json.js";

import { observeNativeProcess, nativeFileSha256 } from "./native-process.js";
export interface NativeFilePin {
  readonly path: string;
  readonly sha256: string;
}
export type NativeProcessPin = import("./native-process.js").NativeProcessPin;
export function observeNativeHostProcess(pin: NativeProcessPin) {
  return observeNativeProcess(pin, nativeFileSha256);
}
export interface NativeGpuProbe {
  readonly executable: NativeFilePin;
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
}
/** Actual compute-process membership, not GPU availability or caller-assigned logical IDs. */
export function observeNativeHostGpus(probe: NativeGpuProbe) {
  if (
    !Number.isSafeInteger(probe.timeout_ms) ||
    probe.timeout_ms < 1 ||
    probe.timeout_ms > 30000 ||
    !Number.isSafeInteger(probe.max_output_bytes) ||
    probe.max_output_bytes < 1 ||
    probe.max_output_bytes > 1048576 ||
    nativeFileSha256(probe.executable.path) !== probe.executable.sha256
  )
    throw new Error("voice GPU probe pin/limits invalid");
  const run = (query: string): string =>
    execFileSync(probe.executable.path, [query, "--format=csv,noheader,nounits"], {
      encoding: "utf8",
      timeout: probe.timeout_ms,
      maxBuffer: probe.max_output_bytes,
      stdio: ["ignore", "pipe", "ignore"],
    });
  const uuids = run("--query-gpu=uuid").trim().split(/\r?\n/u).filter(Boolean);
  if (
    !uuids.length ||
    uuids.length > 64 ||
    new Set(uuids).size !== uuids.length ||
    uuids.some((u) => !/^GPU-[a-f0-9-]+$/u.test(u))
  )
    throw new Error("voice GPU inventory malformed");
  const applications = run("--query-compute-apps=pid,gpu_uuid")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [pid, uuid, extra] = line.split(",").map((v) => v.trim());
      if (
        !pid ||
        !/^[1-9][0-9]*$/u.test(pid) ||
        !Number.isSafeInteger(Number(pid)) ||
        !uuid ||
        !uuids.includes(uuid) ||
        extra !== undefined
      )
        throw new Error("voice GPU process inventory malformed");
      return { pid: Number(pid), uuid };
    });
  if (applications.length > 4096) throw new Error("voice GPU process inventory too large");
  return { uuids, applications };
}
/** Owner-private, atomic canonical observation exports only. No public HTTP PASS route. */
export function readNativeObservationFile(source: string, max_bytes: number): unknown {
  if (
    !Number.isSafeInteger(max_bytes) ||
    max_bytes < 1 ||
    max_bytes > 16777216 ||
    !path.isAbsolute(source) ||
    realpathSync(source) !== source
  )
    throw new Error("voice service observation path/limit invalid");
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.size > max_bytes
    )
      throw new Error("voice service observation file unsafe");
    const bytes = Buffer.alloc(before.size + 1);
    let n = 0;
    while (n < bytes.length) {
      const count = readSync(fd, bytes, n, bytes.length - n, null);
      if (!count) break;
      n += count;
    }
    const after = fstatSync(fd);
    if (
      n !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("voice service observation changed during read");
    const value: unknown = JSON.parse(bytes.subarray(0, n).toString("utf8"));
    const pending = [{ value, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const item = pending.pop();
      if (!item || ++nodes > 200000 || item.depth > 32)
        throw new Error("native observation complexity limit");
      if (item.value !== null && typeof item.value === "object")
        for (const child of Object.values(item.value))
          pending.push({ value: child, depth: item.depth + 1 });
    }
    if (canonicalJson(value) !== bytes.subarray(0, n).toString("utf8"))
      throw new Error("voice service observation noncanonical or duplicate fields");
    return value;
  } finally {
    closeSync(fd);
  }
}
