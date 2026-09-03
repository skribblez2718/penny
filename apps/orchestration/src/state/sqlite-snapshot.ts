import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertOwnerFile, pathExistsNoFollow } from "./custody.js";

const SQLITE_WAL_SUFFIX = "-wal";
const COPY_BUFFER_SIZE = 64 * 1024;

interface FileIdentity {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function identity(file: string, label: string): FileIdentity {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a regular non-symlink single-link file`);
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new Error(`${label} has an unsupported size`);
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/**
 * Copy one custody-validated SQLite file without updating its atime. SQLite's
 * read-only open still creates WAL/SHM siblings on a live WAL database; status
 * validation must therefore operate on a private copy. O_NOATIME is required
 * rather than falling back to a potentially mutating source read.
 */
function copyNoAtime(source: string, destination: string, label: string): void {
  const before = identity(source, label);
  const noAtime = constants.O_NOATIME;
  if (typeof noAtime !== "number") {
    throw new Error("non-mutating SQLite validation requires O_NOATIME support");
  }
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | noAtime);
  let output: number | undefined;
  try {
    output = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    let position = 0;
    while (position < before.size) {
      const requested = Math.min(buffer.length, before.size - position);
      const read = readSync(input, buffer, 0, requested, position);
      if (read === 0) throw new Error(`${label} changed while being copied`);
      let written = 0;
      while (written < read) {
        written += writeSync(output, buffer, written, read - written, position + written);
      }
      position += read;
    }
    fsyncSync(output);
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
  }
  const after = identity(source, label);
  if (!sameIdentity(before, after)) {
    throw new Error(`${label} changed while being copied`);
  }
}

/** A temporary private SQLite image used exclusively for non-mutating validation. */
export class ReadOnlySqliteSnapshot implements Disposable {
  readonly databasePath: string;
  private closed = false;

  constructor(
    private readonly root: string,
    databaseName: string
  ) {
    this.databasePath = path.join(root, databaseName);
  }

  close(): void {
    if (this.closed) return;
    rmSync(this.root, { recursive: true, force: true });
    this.closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * Build a private copy of a canonical SQLite database and its WAL, if present.
 * The canonical source is never opened by SQLite and is copied with O_NOATIME.
 * The copy is rejected if either input changed during the snapshot attempt.
 */
export function createReadOnlySqliteSnapshot(
  databasePath: string,
  label: string
): ReadOnlySqliteSnapshot {
  const source = path.resolve(databasePath);
  assertOwnerFile(source, label);
  const sourceWal = `${source}${SQLITE_WAL_SUFFIX}`;
  const databaseBefore = identity(source, label);
  const walPresentBefore = pathExistsNoFollow(sourceWal);
  const walBefore = walPresentBefore ? identity(sourceWal, `${label} WAL`) : undefined;
  if (walPresentBefore) assertOwnerFile(sourceWal, `${label} WAL`);

  const root = mkdtempSync(path.join(tmpdir(), "penny-sqlite-validation-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const snapshot = new ReadOnlySqliteSnapshot(root, path.basename(source));
  try {
    copyNoAtime(source, snapshot.databasePath, label);
    if (walPresentBefore) {
      copyNoAtime(sourceWal, `${snapshot.databasePath}${SQLITE_WAL_SUFFIX}`, `${label} WAL`);
    }
    if (!sameIdentity(databaseBefore, identity(source, label))) {
      throw new Error(`${label} changed while being copied`);
    }
    if (pathExistsNoFollow(sourceWal) !== walPresentBefore) {
      throw new Error(`${label} WAL changed while being copied`);
    }
    if (walBefore !== undefined && !sameIdentity(walBefore, identity(sourceWal, `${label} WAL`))) {
      throw new Error(`${label} WAL changed while being copied`);
    }
    assertOwnerFile(source, label);
    if (walPresentBefore) assertOwnerFile(sourceWal, `${label} WAL`);
    return snapshot;
  } catch (error) {
    snapshot.close();
    throw error;
  }
}
