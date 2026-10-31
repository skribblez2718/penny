/** Private, descriptor-anchored files only. No campaign state, mutable head or recovery owner. */
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
  fsyncSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { sha256 } from "../../orchestration/dist/canonical-json.js";

export function absolutePath(value: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || /[\0\\]/u.test(value))
    throw new Error("unsafe_path");
}
export function openDirectory(value: string, privateLeaf = false): number {
  absolutePath(value);
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of value.split("/").filter(Boolean)) {
      const next = openSync(
        `/proc/self/fd/${fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      closeSync(fd);
      fd = next;
    }
    const stat = fstatSync(fd);
    if (privateLeaf && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      throw new Error("private_directory_required");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
export function readExactFile(value: string, maximum: number, expected?: string): Buffer {
  absolutePath(value);
  const parent = openDirectory(path.dirname(value));
  let fd: number | undefined;
  try {
    fd = openSync(
      `/proc/self/fd/${parent}/${path.basename(value)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum)
      throw new Error("unsafe_file");
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, size);
      if (!n) break;
      size += n;
    }
    const after = fstatSync(fd),
      result = bytes.subarray(0, size);
    if (
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      (expected !== undefined && sha256(result) !== expected)
    )
      throw new Error("file_drift");
    return result;
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(parent);
  }
}
export function readCapturedFile(value: string, maximum: number, expected?: string): Buffer {
  const fd = openSync(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum)
      throw new Error("captured_file_drift");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, size);
      if (!n) break;
      size += n;
    }
    const after = fstatSync(fd),
      result = bytes.subarray(0, size);
    if (
      size !== stat.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs ||
      (expected !== undefined && sha256(result) !== expected)
    )
      throw new Error("captured_file_drift");
    return result;
  } finally {
    closeSync(fd);
  }
}
export function writeNewFile(value: string, bytes: Buffer): void {
  const fd = openSync(
    value,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o400
  );
  try {
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function privateStage(root: string): { root: string; dispose(): void } {
  const fd = openDirectory(root, true);
  try {
    const staging = mkdtempSync(`/proc/self/fd/${fd}/.rule-learning-`);
    const directory = `/proc/${process.pid}/fd/${fd}/${path.basename(staging)}`;
    // Return the descriptor path too indirectly: callers hold only newly generated private names.
    return {
      root: directory,
      dispose() {
        rmSync(`/proc/self/fd/${fd}/${path.basename(staging)}`, {
          recursive: true,
          force: true,
        });
        closeSync(fd);
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
export function publishRuleRelease(input: {
  namespace: string;
  slot: string;
  content: Buffer;
  fault?: (boundary: string) => void;
}): {
  status: "promoted" | "adopted" | "conflict";
  path: string;
  sha256: string;
} {
  if (!/^[a-f0-9]{64}$/u.test(input.slot)) throw new Error("invalid_successor_slot");
  const fd = openDirectory(input.namespace, true);
  const prefix = `/proc/self/fd/${fd}`;
  const digest = sha256(input.content),
    file = `${digest}.json`,
    target = `successor-${input.slot}`;
  const destination = `${prefix}/${target}`;
  let pending: string | undefined;
  const adopt = () => {
    const dir = openSync(
      destination,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      if (JSON.stringify(readdirSync(`/proc/self/fd/${dir}`).sort()) !== JSON.stringify([file]))
        return false;
      return readCapturedFile(`${destination}/${file}`, input.content.length, digest).equals(
        input.content
      );
    } finally {
      closeSync(dir);
    }
  };
  try {
    // Existing immutable publication is never overwritten, repaired or cleaned up by replay.
    try {
      if (adopt())
        return {
          status: "adopted",
          path: path.join(input.namespace, target, file),
          sha256: digest,
        };
      return { status: "conflict", path: "", sha256: digest };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    pending = mkdtempSync(`${prefix}/.pending-`);
    writeNewFile(`${pending}/${file}`, input.content);
    const stageFd = openSync(
      pending,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      fsyncSync(stageFd);
    } finally {
      closeSync(stageFd);
    }
    input.fault?.("before_publish");
    try {
      renameSync(pending, destination);
      pending = undefined;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error.code === "EEXIST" || error.code === "ENOTEMPTY")
        )
      )
        throw error;
      if (!adopt()) return { status: "conflict", path: "", sha256: digest };
      return {
        status: "adopted",
        path: path.join(input.namespace, target, file),
        sha256: digest,
      };
    }
    input.fault?.("after_publish");
    fsyncSync(fd);
    if (!adopt()) throw new Error("publication_drift");
    return {
      status: "promoted",
      path: path.join(input.namespace, target, file),
      sha256: digest,
    };
  } finally {
    if (pending !== undefined) rmSync(pending, { recursive: true, force: true });
    closeSync(fd);
  }
}
