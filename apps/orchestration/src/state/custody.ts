import { constants, lstatSync, mkdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import path from "node:path";

export const OWNER_DIRECTORY_MODE = 0o700;
export const OWNER_FILE_MODE = 0o600;

function errorHasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function currentUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

export function pathExistsNoFollow(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** Reject symlink traversal and unsafe writable ancestors before creating state. */
export function assertSafeAncestorChain(candidate: string, label: string): void {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  const uid = currentUid();
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!pathExistsNoFollow(cursor)) continue;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`${label} has a symlink ancestor: ${cursor}`);
    if (!stat.isDirectory()) throw new Error(`${label} has a non-directory ancestor: ${cursor}`);

    const writableByOthers = (stat.mode & 0o022) !== 0;
    const stickyDirectory = (stat.mode & 0o1000) !== 0;
    const ownedByCurrent = uid !== undefined && stat.uid === uid;
    const ownedByCurrentOrRoot = uid === undefined || ownedByCurrent || stat.uid === 0;
    if (writableByOthers && !stickyDirectory && !ownedByCurrent) {
      throw new Error(`${label} has an unsafe writable ancestor: ${cursor}`);
    }
    if (!ownedByCurrentOrRoot)
      throw new Error(`${label} has an untrusted ancestor owner: ${cursor}`);
  }
}

export function assertOwnerDirectory(directory: string, label: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if ((stat.mode & 0o777) !== OWNER_DIRECTORY_MODE) {
    throw new Error(`${label} mode must be exactly 0700`);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} has the wrong owner`);
}

export function assertOwnerFile(file: string, label: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a regular non-symlink single-link file`);
  }
  if ((stat.mode & 0o777) !== OWNER_FILE_MODE) {
    throw new Error(`${label} mode must be exactly 0600`);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} has the wrong owner`);
}

export function ensureOwnerDirectory(directory: string, label: string): void {
  assertSafeAncestorChain(directory, label);
  if (!pathExistsNoFollow(directory))
    mkdirSync(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  assertSafeAncestorChain(directory, label);
  assertOwnerDirectory(directory, label);
}

export function fsyncDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
