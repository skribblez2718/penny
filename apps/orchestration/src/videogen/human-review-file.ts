import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Private descriptor plus hash-verified byte snapshot. We NEVER hash a path then reopen it to
 * stream. Every response is made from the very bytes hashed, so even an in-place writer after
 * verification cannot change an outgoing response. Same-UID hostile code is not isolated here. */
export class PinnedReviewFile {
  readonly #fd: number;
  readonly #stat: BigIntStats;
  readonly #digest: string;
  readonly #bytes: Buffer;
  #closed = false;
  constructor(input: {
    readonly path: string;
    readonly sha256: string;
    readonly max_bytes: number;
  }) {
    if (
      !Number.isSafeInteger(input.max_bytes) ||
      input.max_bytes < 1 ||
      input.max_bytes > 512 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      !path.isAbsolute(input.path) ||
      realpathSync(input.path) !== input.path
    )
      throw new Error("bounded canonical private review file required");
    this.#fd = openSync(
      input.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      this.#stat = fstatSync(this.#fd, { bigint: true });
      const s = this.#stat;
      if (
        !s.isFile() ||
        s.nlink !== 1n ||
        (s.mode & 0o077n) !== 0n ||
        (process.geteuid && s.uid !== BigInt(process.geteuid())) ||
        s.size < 1n ||
        s.size > BigInt(input.max_bytes)
      )
        throw new Error("private regular review file required");
      this.#digest = input.sha256;
      this.#bytes = this.#snapshot();
    } catch (error) {
      closeSync(this.#fd);
      throw error;
    }
  }
  #assertStat(): void {
    if (this.#closed) throw new Error("review file closed");
    const s = fstatSync(this.#fd, { bigint: true }),
      before = this.#stat;
    if (
      !["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode", "uid"].every(
        (key) => Reflect.get(s, key) === Reflect.get(before, key)
      )
    )
      throw new Error("review file drift");
  }
  #snapshot(): Buffer {
    this.#assertStat();
    const bytes = Buffer.alloc(Number(this.#stat.size));
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(this.#fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!n) throw new Error("review file short read");
      hash.update(bytes.subarray(offset, offset + n));
      offset += n;
    }
    this.#assertStat();
    if (hash.digest("hex") !== this.#digest) throw new Error("review file hash drift");
    return bytes;
  }
  get size(): number {
    return this.#bytes.length;
  }
  verify(): void {
    // Compare a fresh descriptor snapshot with the original bytes. No mutable file bytes reach HTTP.
    if (!this.#snapshot().equals(this.#bytes)) throw new Error("review file changed");
  }
  slice(start: number, endExclusive: number): Buffer {
    this.#assertStat();
    return Buffer.from(this.#bytes.subarray(start, endExclusive));
  }
  [Symbol.dispose](): void {
    if (!this.#closed) {
      this.#closed = true;
      closeSync(this.#fd);
      this.#bytes.fill(0);
    }
  }
}

/** Exactly one RFC byte range. Multi-range and malformed ranges fail closed, never list assets. */
export function reviewByteRange(
  header: string | undefined,
  size: number
): { start: number; end: number; partial: boolean } {
  if (header === undefined) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=([0-9]{0,16})-([0-9]{0,16})$/u.exec(header);
  if (!m || (!m[1] && !m[2])) throw new Error("invalid range");
  let start: number, end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new Error("invalid suffix");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new Error("unsatisfied range");
  return { start, end, partial: true };
}
