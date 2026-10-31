import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
/** Owner-only, no-follow, bounded descriptor read. Paths are private host inputs, never worker data. */
export function readVideogenPrivateFile(filename: string, maximum: number): Buffer {
  if (!path.isAbsolute(filename) || realpathSync(filename) !== filename)
    throw new Error("VIDEOGEN_PRIVATE_FILE_UNSAFE: canonical absolute nonsymlink path required");
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      (s.mode & 0o077) !== 0 ||
      (typeof process.geteuid === "function" && s.uid !== process.geteuid()) ||
      s.size < 1 ||
      s.size > maximum
    )
      throw new Error("VIDEOGEN_PRIVATE_FILE_UNSAFE: owner-only bounded regular file required");
    const buffer = Buffer.alloc(s.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, length);
      if (n === 0) break;
      length += n;
    }
    const bytes = buffer.subarray(0, length),
      after = fstatSync(fd);
    if (
      bytes.length !== s.size ||
      after.size !== s.size ||
      after.mtimeMs !== s.mtimeMs ||
      after.ctimeMs !== s.ctimeMs
    )
      throw new Error("VIDEOGEN_PRIVATE_FILE_CHANGED");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
