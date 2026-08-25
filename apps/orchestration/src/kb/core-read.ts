/**
 * Race-safe reads for the private KB publication tree.
 *
 * Every path component is opened relative to a pinned directory descriptor with
 * O_NOFOLLOW. The already-admitted root may be a non-group/other-writable public
 * scaffold; every live descendant directory remains exact mode 0700. The leaf
 * is read from its descriptor, never by pathname. Custody and identity are
 * checked before and after the read, and the complete logical path is re-opened
 * before bytes are released so replacement races fail closed.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

const KB_DIRECTORY_MODE = 0o700;
const KB_FILE_MODE = 0o600;
const GROUP_OR_OTHER_WRITE_MASK = 0o022;
const PERMISSION_MASK = 0o7777;

export type KbCoreReadErrorCode =
  | "missing"
  | "containment"
  | "custody"
  | "identity_changed"
  | "digest_mismatch"
  | "length_mismatch"
  | "unsupported";

export class KbCoreReadError extends Error {
  constructor(
    readonly code: KbCoreReadErrorCode,
    message: string
  ) {
    super(message);
    this.name = "KbCoreReadError";
  }
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface StableFileSnapshot extends FileIdentity {
  readonly size: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly nlink: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface ContainedKbFile {
  readonly descriptor: number;
  /** Linux descriptor-pinned path for APIs, such as SQLite, that require a path. */
  readonly pinnedPath: string;
  readonly byteLength: number;
}

export interface ContainedKbDirectory {
  readonly descriptor: number;
  readonly pinnedPath: string;
}

export interface ContainedKbReadOptions {
  readonly label: string;
  readonly expectedSha256?: string;
  readonly expectedByteLength?: number;
  /** Publication recovery alone may name an exact transient two-link inode. */
  readonly expectedLinkCount?: 1 | 2;
  /** Deterministic race injection; tests only. */
  readonly testOnlyAfterOpen?: () => void;
}

function currentUid(): bigint {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    throw new KbCoreReadError(
      "unsupported",
      "KB custody reads require Linux descriptor and current-user ownership support"
    );
  }
  return BigInt(process.getuid());
}

function pinnedChildPath(directoryDescriptor: number, child: string): string {
  return `/proc/self/fd/${directoryDescriptor}/${child}`;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function translateOpenError(error: unknown, label: string): never {
  const code = errorCode(error);
  if (code === "ENOENT") {
    throw new KbCoreReadError("missing", `${label} is missing`);
  }
  throw new KbCoreReadError("custody", `${label} cannot be opened with no-follow custody`);
}

function openDirectory(target: string, label: string): number {
  try {
    return openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    translateOpenError(error, label);
  }
}

function openFile(target: string, label: string): number {
  try {
    return openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    translateOpenError(error, label);
  }
}

/** Open every absolute component without following a symlink. */
function openRootDirectory(resolvedRoot: string, label: string): number {
  const parsed = path.parse(resolvedRoot);
  const segments = resolvedRoot
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((segment) => segment.length > 0);
  const descriptors: number[] = [];
  try {
    let descriptor = openDirectory(parsed.root, `${label} filesystem root`);
    descriptors.push(descriptor);
    for (const segment of segments) {
      descriptor = openDirectory(pinnedChildPath(descriptor, segment), `${label} ancestor`);
      descriptors.push(descriptor);
    }
    const rootDescriptor = requiredEntry(descriptors, descriptors.length - 1, `${label} root`);
    descriptors.pop();
    closeAll(descriptors);
    return rootDescriptor;
  } catch (error) {
    closeAll(descriptors);
    throw error;
  }
}

function admittedRootIdentity(descriptor: number, ownerUid: bigint, label: string): FileIdentity {
  const stat = fstatSync(descriptor, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.uid !== ownerUid ||
    (stat.mode & BigInt(GROUP_OR_OTHER_WRITE_MASK)) !== 0n
  ) {
    throw new KbCoreReadError(
      "custody",
      `${label} directory must be current-user-owned and not group/other writable`
    );
  }
  return { dev: stat.dev, ino: stat.ino };
}

function directoryIdentity(descriptor: number, ownerUid: bigint, label: string): FileIdentity {
  const stat = fstatSync(descriptor, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.uid !== ownerUid ||
    (stat.mode & BigInt(PERMISSION_MASK)) !== BigInt(KB_DIRECTORY_MODE)
  ) {
    throw new KbCoreReadError("custody", `${label} directory must be current-user-owned mode-0700`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function fileSnapshot(
  descriptor: number,
  ownerUid: bigint,
  expectedLinkCount: 1 | 2,
  label: string
): StableFileSnapshot {
  const stat = fstatSync(descriptor, { bigint: true });
  if (
    !stat.isFile() ||
    stat.uid !== ownerUid ||
    (stat.mode & BigInt(PERMISSION_MASK)) !== BigInt(KB_FILE_MODE) ||
    stat.nlink !== BigInt(expectedLinkCount)
  ) {
    throw new KbCoreReadError(
      "custody",
      `${label} must be a current-user-owned regular mode-0600 file with nlink=${expectedLinkCount}`
    );
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    uid: stat.uid,
    nlink: stat.nlink,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function requiredEntry<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new KbCoreReadError("identity_changed", `${label} identity chain is incomplete`);
  }
  return value;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: StableFileSnapshot, right: StableFileSnapshot): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function containedSegments(
  root: string,
  file: string,
  label: string
): {
  readonly resolvedRoot: string;
  readonly segments: readonly string[];
} {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".."
  ) {
    throw new KbCoreReadError("containment", `${label} is outside the admitted KB root`);
  }
  const segments = relative.split(path.sep);
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\")
    )
  ) {
    throw new KbCoreReadError("containment", `${label} does not have a closed contained path`);
  }
  return { resolvedRoot, segments };
}

function closeAll(descriptors: readonly number[]): void {
  for (const descriptor of [...descriptors].reverse()) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the primary custody/read failure.
    }
  }
}

function assertPinnedPathStillNamesOpenedFile(input: {
  resolvedRoot: string;
  parentSegments: readonly string[];
  leaf: string;
  ownerUid: bigint;
  directoryIdentities: readonly FileIdentity[];
  fileIdentity: FileIdentity;
  expectedLinkCount: 1 | 2;
  label: string;
}): void {
  const reopened: number[] = [];
  try {
    let directory = openRootDirectory(input.resolvedRoot, `${input.label} root`);
    reopened.push(directory);
    let identity = admittedRootIdentity(directory, input.ownerUid, `${input.label} root`);
    if (!sameIdentity(identity, requiredEntry(input.directoryIdentities, 0, input.label))) {
      throw new KbCoreReadError("identity_changed", `${input.label} root identity changed`);
    }

    for (let index = 0; index < input.parentSegments.length; index += 1) {
      const segment = requiredEntry(input.parentSegments, index, input.label);
      directory = openDirectory(pinnedChildPath(directory, segment), `${input.label} parent`);
      reopened.push(directory);
      identity = directoryIdentity(directory, input.ownerUid, `${input.label} parent`);
      if (
        !sameIdentity(identity, requiredEntry(input.directoryIdentities, index + 1, input.label))
      ) {
        throw new KbCoreReadError("identity_changed", `${input.label} parent identity changed`);
      }
    }

    const leafDescriptor = openFile(pinnedChildPath(directory, input.leaf), input.label);
    reopened.push(leafDescriptor);
    const reopenedLeaf = fileSnapshot(
      leafDescriptor,
      input.ownerUid,
      input.expectedLinkCount,
      input.label
    );
    if (!sameIdentity(reopenedLeaf, input.fileIdentity)) {
      throw new KbCoreReadError("identity_changed", `${input.label} identity changed during read`);
    }
  } finally {
    closeAll(reopened);
  }
}

/** Hold one exact contained mode-0700 directory open for a bounded operation. */
export function withContainedKbDirectory<T>(
  root: string,
  directoryPath: string,
  label: string,
  reader: (directory: ContainedKbDirectory) => T
): T {
  const { resolvedRoot, segments } = containedSegments(root, directoryPath, label);
  const ownerUid = currentUid();
  const descriptors: number[] = [];
  const identities: FileIdentity[] = [];
  try {
    let directory = openRootDirectory(resolvedRoot, `${label} root`);
    descriptors.push(directory);
    identities.push(admittedRootIdentity(directory, ownerUid, `${label} root`));
    for (const segment of segments) {
      directory = openDirectory(pinnedChildPath(directory, segment), label);
      descriptors.push(directory);
      identities.push(directoryIdentity(directory, ownerUid, label));
    }
    const value = reader({ descriptor: directory, pinnedPath: `/proc/self/fd/${directory}` });
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = requiredEntry(descriptors, index, label);
      const after =
        index === 0
          ? admittedRootIdentity(descriptor, ownerUid, `${label} root`)
          : directoryIdentity(descriptor, ownerUid, label);
      if (!sameIdentity(after, requiredEntry(identities, index, label))) {
        throw new KbCoreReadError("identity_changed", `${label} identity changed during use`);
      }
    }

    const reopened: number[] = [];
    try {
      let reopenedDirectory = openRootDirectory(resolvedRoot, `${label} root`);
      reopened.push(reopenedDirectory);
      if (
        !sameIdentity(
          admittedRootIdentity(reopenedDirectory, ownerUid, `${label} root`),
          requiredEntry(identities, 0, label)
        )
      ) {
        throw new KbCoreReadError("identity_changed", `${label} root identity changed`);
      }
      for (let index = 0; index < segments.length; index += 1) {
        reopenedDirectory = openDirectory(
          pinnedChildPath(reopenedDirectory, requiredEntry(segments, index, label)),
          label
        );
        reopened.push(reopenedDirectory);
        if (
          !sameIdentity(
            directoryIdentity(reopenedDirectory, ownerUid, label),
            requiredEntry(identities, index + 1, label)
          )
        ) {
          throw new KbCoreReadError("identity_changed", `${label} identity changed`);
        }
      }
    } finally {
      closeAll(reopened);
    }
    return value;
  } finally {
    closeAll(descriptors);
  }
}

/**
 * Hold one exact contained KB file open while a descriptor-based reader runs.
 * The callback must finish all reads before returning.
 */
export function withContainedKbFile<T>(
  root: string,
  file: string,
  options: ContainedKbReadOptions,
  reader: (file: ContainedKbFile) => T
): T {
  const { resolvedRoot, segments } = containedSegments(root, file, options.label);
  const ownerUid = currentUid();
  const expectedLinkCount = options.expectedLinkCount ?? 1;
  const parentSegments = segments.slice(0, -1);
  const leaf = requiredEntry(segments, segments.length - 1, options.label);
  const descriptors: number[] = [];
  const directoryIdentities: FileIdentity[] = [];

  try {
    let directory = openRootDirectory(resolvedRoot, `${options.label} root`);
    descriptors.push(directory);
    directoryIdentities.push(admittedRootIdentity(directory, ownerUid, `${options.label} root`));

    for (const segment of parentSegments) {
      directory = openDirectory(pinnedChildPath(directory, segment), `${options.label} parent`);
      descriptors.push(directory);
      directoryIdentities.push(directoryIdentity(directory, ownerUid, `${options.label} parent`));
    }

    const descriptor = openFile(pinnedChildPath(directory, leaf), options.label);
    descriptors.push(descriptor);
    const before = fileSnapshot(descriptor, ownerUid, expectedLinkCount, options.label);
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new KbCoreReadError("custody", `${options.label} is too large to read safely`);
    }

    options.testOnlyAfterOpen?.();
    const value = reader({
      descriptor,
      pinnedPath: `/proc/self/fd/${descriptor}`,
      byteLength: Number(before.size),
    });

    const after = fileSnapshot(descriptor, ownerUid, expectedLinkCount, options.label);
    if (!sameFileSnapshot(before, after)) {
      throw new KbCoreReadError("identity_changed", `${options.label} changed during read`);
    }
    assertPinnedPathStillNamesOpenedFile({
      resolvedRoot,
      parentSegments,
      leaf,
      ownerUid,
      directoryIdentities,
      fileIdentity: before,
      expectedLinkCount,
      label: options.label,
    });
    return value;
  } finally {
    closeAll(descriptors);
  }
}

/** Read exact bytes from one descriptor-pinned KB file. */
export function readContainedKbFile(
  root: string,
  file: string,
  options: ContainedKbReadOptions
): Buffer {
  return withContainedKbFile(root, file, options, ({ descriptor }) => {
    const bytes = readFileSync(descriptor);
    if (options.expectedByteLength !== undefined && bytes.length !== options.expectedByteLength) {
      throw new KbCoreReadError("length_mismatch", `${options.label} byte length does not match`);
    }
    if (
      options.expectedSha256 !== undefined &&
      createHash("sha256").update(bytes).digest("hex") !== options.expectedSha256
    ) {
      throw new KbCoreReadError("digest_mismatch", `${options.label} digest does not match`);
    }
    return bytes;
  });
}

/** Return undefined only for a genuinely absent contained file. */
export function tryReadContainedKbFile(
  root: string,
  file: string,
  options: ContainedKbReadOptions
): Buffer | undefined {
  try {
    return readContainedKbFile(root, file, options);
  } catch (error) {
    if (error instanceof KbCoreReadError && error.code === "missing") return undefined;
    throw error;
  }
}
