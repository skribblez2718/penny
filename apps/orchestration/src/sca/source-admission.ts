import { Type, type Static } from "typebox";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import { currentArtifactRef } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema, assertOpaqueId } from "../skill-contracts/common.js";
import {
  SCA_SOURCE_ADMISSION_HARD_LIMITS,
  SCA_SOURCE_SNAPSHOT_SCHEMA,
  ScaSourceAdmissionPolicyV1Schema,
  ScaSourceFileDeclarationV1Schema,
  ScaSourceManifestError,
  buildScaSourceAdmissionResultV1,
  canonicalScaSourceSnapshotV1,
  computeScaSourceTreeSha256,
  dispositionForScaSource,
  validateScaPathSet,
  validateScaSourceAdmissionPolicy,
  type ScaSourceAdmissionPolicyV1,
  type ScaSourceFileDeclarationV1,
  type ScaSourceInventoryEntryV1,
  type ScaSourceAdmissionResultV1,
} from "./source-inventory.js";

export const SCA_SOURCE_ADMISSION_REQUEST_SCHEMA = "penny.sca-source-admission-request.v1";

export const ScaSourceAdmissionRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SOURCE_ADMISSION_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_ref: ArtifactRefSchema,
    root: Type.String({ minLength: 1, maxLength: SCA_SOURCE_ADMISSION_HARD_LIMITS.path_bytes }),
    policy: ScaSourceAdmissionPolicyV1Schema,
    files: Type.Array(ScaSourceFileDeclarationV1Schema, {
      minItems: 1,
      maxItems: SCA_SOURCE_ADMISSION_HARD_LIMITS.files,
    }),
  },
  { additionalProperties: false }
);

export type ScaSourceAdmissionRequestV1 = Static<typeof ScaSourceAdmissionRequestV1Schema>;

export class ScaSourceAdmissionError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "binding_mismatch"
      | "unsafe_root"
      | "unsafe_path"
      | "path_collision"
      | "quota_exceeded"
      | "policy_rejected"
      | "filesystem_refused"
      | "integrity_mismatch"
      | "read_race",
    message: string
  ) {
    super(message);
    this.name = "ScaSourceAdmissionError";
  }
}

export interface ScaSourceAdmissionBoundaryEvent {
  readonly stage: "after_file_open" | "after_file_read";
  readonly path: string;
}

export interface ScaSourceMountIdentityTarget {
  readonly kind: "root" | "directory" | "file";
  readonly path: string;
}

export type ScaSourceMountIdentityResolver = (
  descriptor: number,
  target: ScaSourceMountIdentityTarget
) => string;

/** Optional host instrumentation. It is primarily useful for deterministic boundary testing. */
export interface ScaSourceAdmissionOptions {
  readonly onBoundary?: (event: ScaSourceAdmissionBoundaryEvent) => void;
  readonly mountIdentityResolver?: ScaSourceMountIdentityResolver;
}

interface DeviceFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface FileIdentity extends DeviceFileIdentity {
  readonly mountId: string;
}

interface FileSnapshot extends FileIdentity {
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface StableRoot {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: FileIdentity;
}

interface OpenDirectory {
  readonly segment: string;
  readonly relativePath: string;
  readonly descriptor: number;
  readonly identity: FileIdentity;
}

interface SourceReadOptions {
  readonly mountIdentityResolver: ScaSourceMountIdentityResolver;
  readonly generatedPaths: ReadonlySet<string>;
  readonly contentMismatchCode: "integrity_mismatch" | "read_race";
  readonly onBoundary?: (event: ScaSourceAdmissionBoundaryEvent) => void;
}

function fail(code: ScaSourceAdmissionError["code"], message: string): never {
  throw new ScaSourceAdmissionError(code, message);
}

function errorHasCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function deviceIdentityOf(stat: BigIntStats): DeviceFileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function identityOf(stat: BigIntStats, mountId: string): FileIdentity {
  return { ...deviceIdentityOf(stat), mountId };
}

function snapshotOf(stat: BigIntStats, mountId: string): FileSnapshot {
  return {
    ...identityOf(stat, mountId),
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameDeviceIdentity(left: DeviceFileIdentity, right: DeviceFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameDeviceIdentity(left, right) && left.mountId === right.mountId;
}

function sameMountBoundary(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.mountId === right.mountId;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function linuxProcMountIdentity(descriptor: number): string {
  if (process.platform !== "linux") {
    fail("filesystem_refused", "source admission requires Linux mount identity support");
  }

  const fdInfo = readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8");
  const mountLines = fdInfo.split("\n").filter((line) => line.startsWith("mnt_id:"));
  if (mountLines.length !== 1) {
    fail("filesystem_refused", "source admission could not obtain one stable mount identity");
  }
  const mountLine = mountLines.at(0);
  const mountId = mountLine?.slice("mnt_id:".length).trim();
  if (mountId === undefined || !/^[0-9]+$/u.test(mountId)) {
    fail("filesystem_refused", "source admission received an invalid mount identity");
  }
  return mountId;
}

function mountIdentityOf(
  descriptor: number,
  target: ScaSourceMountIdentityTarget,
  resolver: ScaSourceMountIdentityResolver
): string {
  let mountId: unknown;
  try {
    mountId = resolver(descriptor, target);
  } catch (error) {
    if (error instanceof ScaSourceAdmissionError) {
      throw error;
    }
    fail("filesystem_refused", "source admission could not resolve stable mount identity");
  }
  if (typeof mountId !== "string" || mountId.length === 0) {
    fail("filesystem_refused", "source admission received an invalid mount identity");
  }
  return mountId;
}

function descriptorRootFor(descriptor: number): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      realpathSync.native(candidate);
      return candidate;
    } catch {
      // Try the next host-supported descriptor filesystem.
    }
  }
  fail("filesystem_refused", "source admission requires a stable directory-descriptor filesystem");
}

function closeQuietly(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the original admission result or refusal.
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

function assertCanonicalRootText(root: string): void {
  if (root.includes("\0")) {
    fail("unsafe_root", "source root must not contain NUL");
  }
  if (root.includes("\\")) {
    fail("unsafe_root", "source root must not contain backslashes");
  }
  if (root !== root.normalize("NFC")) {
    fail("unsafe_root", "source root must be NFC-normalized");
  }
  if (hasControlCharacter(root)) {
    fail("unsafe_root", "source root must not contain control characters");
  }
  if (Buffer.byteLength(root, "utf8") > SCA_SOURCE_ADMISSION_HARD_LIMITS.path_bytes) {
    fail("unsafe_root", "source root exceeds the hard path-byte limit");
  }
  if (!path.isAbsolute(root) || path.resolve(root) !== root) {
    fail("unsafe_root", "source root must be an absolute canonical path");
  }
}

function openStableRoot(
  root: string,
  mountIdentityResolver: ScaSourceMountIdentityResolver
): StableRoot {
  assertCanonicalRootText(root);
  let descriptor: number | undefined;
  try {
    const before = lstatSync(root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      fail("unsafe_root", "source root must be a non-symlink directory");
    }
    if (realpathSync.native(root) !== root) {
      fail("unsafe_root", "source root or one of its ancestors is a symlink or path alias");
    }

    descriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    const identity = identityOf(
      opened,
      mountIdentityOf(descriptor, { kind: "root", path: root }, mountIdentityResolver)
    );
    if (!opened.isDirectory() || !sameDeviceIdentity(deviceIdentityOf(before), identity)) {
      fail("read_race", "source root changed while it was opened");
    }
    const descriptorPath = descriptorRootFor(descriptor);
    if (realpathSync.native(descriptorPath) !== root) {
      fail("read_race", "source root descriptor does not resolve to the declared root");
    }
    return { path: root, descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) {
      closeQuietly(descriptor);
    }
    if (error instanceof ScaSourceAdmissionError) {
      throw error;
    }
    if (errorHasCode(error, "ENOENT")) {
      fail("unsafe_root", "source root does not exist");
    }
    if (errorHasCode(error, "ELOOP", "ENOTDIR")) {
      fail("unsafe_root", "source root contains a symlink or non-directory component");
    }
    fail("filesystem_refused", "source root could not be opened safely");
  }
}

function assertRootStable(
  root: StableRoot,
  mountIdentityResolver: ScaSourceMountIdentityResolver
): void {
  let freshDescriptor: number | undefined;
  try {
    const descriptorStat = fstatSync(root.descriptor, { bigint: true });
    const descriptorIdentity = identityOf(
      descriptorStat,
      mountIdentityOf(root.descriptor, { kind: "root", path: root.path }, mountIdentityResolver)
    );
    const pathStat = lstatSync(root.path, { bigint: true });
    freshDescriptor = openSync(
      root.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const freshStat = fstatSync(freshDescriptor, { bigint: true });
    const freshIdentity = identityOf(
      freshStat,
      mountIdentityOf(freshDescriptor, { kind: "root", path: root.path }, mountIdentityResolver)
    );
    if (
      !descriptorStat.isDirectory() ||
      !pathStat.isDirectory() ||
      pathStat.isSymbolicLink() ||
      !freshStat.isDirectory() ||
      !sameIdentity(root.identity, descriptorIdentity) ||
      !sameDeviceIdentity(root.identity, deviceIdentityOf(pathStat)) ||
      !sameIdentity(root.identity, freshIdentity) ||
      realpathSync.native(root.path) !== root.path
    ) {
      fail("read_race", "source root changed during admission");
    }
  } catch (error) {
    if (error instanceof ScaSourceAdmissionError) {
      throw error;
    }
    fail("read_race", "source root became unavailable during admission");
  } finally {
    if (freshDescriptor !== undefined) {
      closeQuietly(freshDescriptor);
    }
  }
}

function openChildDirectory(
  parentDescriptor: number,
  parentIdentity: FileIdentity,
  segment: string,
  relativePath: string,
  mountIdentityResolver: ScaSourceMountIdentityResolver
): OpenDirectory {
  let descriptor: number | undefined;
  const childPath = `${descriptorRootFor(parentDescriptor)}/${segment}`;
  try {
    const before = lstatSync(childPath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      fail("unsafe_path", "a declared path contains a non-directory or symlink component");
    }
    descriptor = openSync(
      childPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const identity = identityOf(
      opened,
      mountIdentityOf(descriptor, { kind: "directory", path: relativePath }, mountIdentityResolver)
    );
    if (!opened.isDirectory() || !sameDeviceIdentity(deviceIdentityOf(before), identity)) {
      fail("read_race", "a declared path directory changed while it was opened");
    }
    if (!sameMountBoundary(parentIdentity, identity)) {
      fail("filesystem_refused", `declared path '${relativePath}' crosses a mount boundary`);
    }
    return { segment, relativePath, descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) {
      closeQuietly(descriptor);
    }
    if (error instanceof ScaSourceAdmissionError) {
      throw error;
    }
    if (errorHasCode(error, "ELOOP", "ENOTDIR")) {
      fail("unsafe_path", "a declared path contains a symlink or non-directory component");
    }
    if (errorHasCode(error, "ENOENT")) {
      fail("filesystem_refused", "a declared path directory does not exist");
    }
    fail("filesystem_refused", "a declared path directory could not be opened safely");
  }
}

function openDeclaredFile(
  parentDescriptor: number,
  parentIdentity: FileIdentity,
  relativePath: string,
  leaf: string,
  mountIdentityResolver: ScaSourceMountIdentityResolver
): { readonly descriptor: number; readonly snapshot: FileSnapshot } {
  let descriptor: number | undefined;
  const childPath = `${descriptorRootFor(parentDescriptor)}/${leaf}`;
  try {
    const before = lstatSync(childPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      fail("unsafe_path", `declared path '${relativePath}' is not a regular non-symlink file`);
    }
    if (before.nlink !== 1n) {
      fail("unsafe_path", `declared path '${relativePath}' has an unexpected hard-link count`);
    }
    descriptor = openSync(childPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    const identity = identityOf(
      opened,
      mountIdentityOf(descriptor, { kind: "file", path: relativePath }, mountIdentityResolver)
    );
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameDeviceIdentity(deviceIdentityOf(before), identity)
    ) {
      fail("read_race", `declared path '${relativePath}' changed while it was opened`);
    }
    if (!sameMountBoundary(parentIdentity, identity)) {
      fail("filesystem_refused", `declared path '${relativePath}' crosses a mount boundary`);
    }
    return { descriptor, snapshot: snapshotOf(opened, identity.mountId) };
  } catch (error) {
    if (descriptor !== undefined) {
      closeQuietly(descriptor);
    }
    if (error instanceof ScaSourceAdmissionError) {
      throw error;
    }
    if (errorHasCode(error, "ELOOP")) {
      fail("unsafe_path", `declared path '${relativePath}' is a symlink`);
    }
    if (errorHasCode(error, "ENOENT")) {
      fail("filesystem_refused", `declared path '${relativePath}' does not exist`);
    }
    if (errorHasCode(error, "EISDIR", "ENOTDIR")) {
      fail("unsafe_path", `declared path '${relativePath}' is not a regular file`);
    }
    fail("filesystem_refused", `declared path '${relativePath}' could not be opened safely`);
  }
}

function readExactFile(descriptor: number, expectedLength: number, relativePath: string): Buffer {
  const bytes = Buffer.alloc(expectedLength);
  let offset = 0;
  while (offset < expectedLength) {
    const count = readSync(descriptor, bytes, offset, expectedLength - offset, offset);
    if (count === 0) {
      fail("read_race", `declared path '${relativePath}' became shorter during admission`);
    }
    offset += count;
  }

  const extra = Buffer.allocUnsafe(1);
  if (readSync(descriptor, extra, 0, 1, expectedLength) !== 0) {
    fail("read_race", `declared path '${relativePath}' became longer during admission`);
  }
  return bytes;
}

function assertDeclaredTextBytes(
  bytes: Buffer,
  relativePath: string,
  failureCode: SourceReadOptions["contentMismatchCode"]
): void {
  if (bytes.includes(0)) {
    fail(failureCode, `declared text path '${relativePath}' contains NUL`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(failureCode, `declared text path '${relativePath}' is not valid UTF-8`);
  }

  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) ||
        (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      fail(failureCode, `declared text path '${relativePath}' contains a disallowed control`);
    }
  }
}

function revalidateOpenedPath(
  root: StableRoot,
  directories: readonly OpenDirectory[],
  relativePath: string,
  leaf: string,
  fileIdentity: FileIdentity,
  mountIdentityResolver: ScaSourceMountIdentityResolver
): void {
  const freshDescriptors: number[] = [];
  let parent = root.descriptor;
  let parentIdentity = root.identity;
  try {
    for (const expected of directories) {
      const fresh = openChildDirectory(
        parent,
        parentIdentity,
        expected.segment,
        expected.relativePath,
        mountIdentityResolver
      );
      freshDescriptors.push(fresh.descriptor);
      if (!sameIdentity(fresh.identity, expected.identity)) {
        fail("read_race", `declared path '${relativePath}' changed during admission`);
      }
      parent = fresh.descriptor;
      parentIdentity = fresh.identity;
    }
    const freshFile = openDeclaredFile(
      parent,
      parentIdentity,
      relativePath,
      leaf,
      mountIdentityResolver
    );
    freshDescriptors.push(freshFile.descriptor);
    if (!sameIdentity(freshFile.snapshot, fileIdentity)) {
      fail("read_race", `declared path '${relativePath}' changed during admission`);
    }
  } finally {
    while (freshDescriptors.length > 0) {
      const descriptor = freshDescriptors.pop();
      if (descriptor !== undefined) closeQuietly(descriptor);
    }
  }
}

function readDeclaredSource(
  root: StableRoot,
  declaration: ScaSourceFileDeclarationV1,
  policy: ScaSourceAdmissionPolicyV1,
  options: SourceReadOptions
): ScaSourceInventoryEntryV1 {
  const segments = declaration.path.split("/");
  const leaf = segments.at(-1);
  if (leaf === undefined) {
    fail("unsafe_path", "declared path has no final component");
  }
  const directories: OpenDirectory[] = [];
  let fileDescriptor: number | undefined;

  try {
    let parent = root.descriptor;
    let parentIdentity = root.identity;
    const directorySegments: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      directorySegments.push(segment);
      const opened = openChildDirectory(
        parent,
        parentIdentity,
        segment,
        directorySegments.join("/"),
        options.mountIdentityResolver
      );
      directories.push(opened);
      parent = opened.descriptor;
      parentIdentity = opened.identity;
    }

    const openedFile = openDeclaredFile(
      parent,
      parentIdentity,
      declaration.path,
      leaf,
      options.mountIdentityResolver
    );
    fileDescriptor = openedFile.descriptor;
    if (openedFile.snapshot.size !== BigInt(declaration.expected_byte_length)) {
      fail(
        options.contentMismatchCode,
        `declared path '${declaration.path}' has an unexpected byte length`
      );
    }

    options.onBoundary?.({ stage: "after_file_open", path: declaration.path });
    const bytes = readExactFile(
      openedFile.descriptor,
      declaration.expected_byte_length,
      declaration.path
    );
    options.onBoundary?.({ stage: "after_file_read", path: declaration.path });

    const after = fstatSync(openedFile.descriptor, { bigint: true });
    const afterSnapshot = snapshotOf(
      after,
      mountIdentityOf(
        openedFile.descriptor,
        { kind: "file", path: declaration.path },
        options.mountIdentityResolver
      )
    );
    if (
      !after.isFile() ||
      after.nlink !== 1n ||
      !sameSnapshot(openedFile.snapshot, afterSnapshot)
    ) {
      fail("read_race", `declared path '${declaration.path}' changed while it was read`);
    }
    revalidateOpenedPath(
      root,
      directories,
      declaration.path,
      leaf,
      openedFile.snapshot,
      options.mountIdentityResolver
    );
    assertRootStable(root, options.mountIdentityResolver);

    const actualDigest = sha256(bytes);
    if (actualDigest !== declaration.expected_sha256) {
      fail(
        options.contentMismatchCode,
        `declared path '${declaration.path}' has an unexpected SHA-256`
      );
    }
    if (declaration.content_kind === "text") {
      assertDeclaredTextBytes(bytes, declaration.path, options.contentMismatchCode);
    }

    const generated = options.generatedPaths.has(declaration.path);
    const disposition = dispositionForScaSource(declaration.content_kind, generated, policy);
    return {
      path: declaration.path,
      byte_length: declaration.expected_byte_length,
      sha256: actualDigest,
      content_kind: declaration.content_kind,
      generated,
      ...disposition,
    };
  } catch (error) {
    if (error instanceof ScaSourceAdmissionError) {
      throw error;
    }
    if (error instanceof ScaSourceManifestError) {
      mapInventoryError(error);
    }
    throw new ScaSourceAdmissionError(
      "filesystem_refused",
      `declared path '${declaration.path}' could not be read safely`
    );
  } finally {
    if (fileDescriptor !== undefined) {
      closeQuietly(fileDescriptor);
    }
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory !== undefined) closeQuietly(directory.descriptor);
    }
  }
}

function mapInventoryError(error: ScaSourceManifestError): never {
  const mapped: Record<ScaSourceManifestError["code"], ScaSourceAdmissionError["code"]> = {
    invalid_inventory: "invalid_input",
    invalid_policy: "policy_rejected",
    unsafe_path: "unsafe_path",
    path_collision: "path_collision",
    quota_exceeded: "quota_exceeded",
    binding_mismatch: "binding_mismatch",
    digest_mismatch: "integrity_mismatch",
  };
  fail(mapped[error.code], error.message);
}

function validateRequest(value: unknown): {
  readonly request: ScaSourceAdmissionRequestV1;
  readonly policy: ScaSourceAdmissionPolicyV1;
  readonly snapshotRef: ArtifactRef;
} {
  let request: ScaSourceAdmissionRequestV1;
  try {
    request = validateContract(
      ScaSourceAdmissionRequestV1Schema,
      value,
      "SCA source admission request"
    );
    assertOpaqueId(request.tenant_id, "tenant_id");
    assertOpaqueId(request.project_id, "project_id");
    assertOpaqueId(request.run_id, "run_id");
  } catch (error) {
    fail("invalid_input", error instanceof Error ? error.message : "invalid admission request");
  }

  let policy: ScaSourceAdmissionPolicyV1;
  try {
    policy = validateScaSourceAdmissionPolicy(request.policy);
    validateScaPathSet(
      request.files.map((file) => file.path),
      policy
    );
  } catch (error) {
    if (error instanceof ScaSourceManifestError) {
      mapInventoryError(error);
    }
    throw error;
  }

  if (request.files.length > policy.max_files) {
    fail("quota_exceeded", "declared file count exceeds max_files");
  }

  const generatedPaths = new Set(policy.generated_paths);
  const declaredPaths = new Set(request.files.map((file) => file.path));
  for (const generatedPath of generatedPaths) {
    if (!declaredPaths.has(generatedPath)) {
      fail(
        "invalid_input",
        `generated policy path '${generatedPath}' is not present in the declared source set`
      );
    }
  }

  let declaredBytes = 0;
  for (const declaration of request.files) {
    const generated = generatedPaths.has(declaration.path);
    if (declaration.generated !== generated) {
      fail(
        "invalid_input",
        `declared path '${declaration.path}' generated classification does not match policy`
      );
    }
    if (declaration.expected_byte_length > policy.max_bytes_per_file) {
      fail("quota_exceeded", `declared path '${declaration.path}' exceeds max_bytes_per_file`);
    }
    declaredBytes += declaration.expected_byte_length;
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > policy.max_total_bytes) {
      fail("quota_exceeded", "declared byte total exceeds max_total_bytes");
    }
  }

  let snapshotRef: ArtifactRef;
  try {
    snapshotRef = currentArtifactRef(request.source_snapshot_ref, "SCA source snapshot reference");
  } catch (error) {
    fail(
      "binding_mismatch",
      error instanceof Error ? error.message : "invalid source snapshot reference"
    );
  }
  if (snapshotRef.run_id !== request.run_id) {
    fail("binding_mismatch", "source snapshot run_id does not match admission run_id");
  }
  if (
    snapshotRef.kind !== "source-snapshot" ||
    snapshotRef.content_schema?.schema_id !== SCA_SOURCE_SNAPSHOT_SCHEMA ||
    snapshotRef.content_schema.schema_version !== 1
  ) {
    fail("binding_mismatch", "source snapshot reference has the wrong kind or content schema");
  }

  const declaredTree = request.files.map((file) => ({
    path: file.path,
    byte_length: file.expected_byte_length,
    sha256: file.expected_sha256,
  }));
  const declaredTreeDigest = computeScaSourceTreeSha256(declaredTree);
  if (snapshotRef.content_digest !== declaredTreeDigest) {
    fail("binding_mismatch", "source snapshot content digest does not match the declared tree");
  }
  if (
    snapshotRef.byte_length !==
    Buffer.byteLength(canonicalScaSourceSnapshotV1(declaredTree), "utf8")
  ) {
    fail("binding_mismatch", "source snapshot byte length does not match its canonical tree");
  }

  return { request, policy, snapshotRef };
}

/**
 * Admit only caller-declared source files. The function performs no directory
 * discovery and returns no source bytes; it reads bounded bytes solely to
 * verify a pre-existing immutable snapshot identity and a stable, single-mount,
 * no-follow custody chain. A no-hook second pass proves whole-set coherence.
 */
export function admitScaSourceV1(
  value: unknown,
  options: ScaSourceAdmissionOptions = {}
): ScaSourceAdmissionResultV1 {
  const { request, policy, snapshotRef } = validateRequest(value);
  const mountIdentityResolver: ScaSourceMountIdentityResolver =
    options.mountIdentityResolver ?? linuxProcMountIdentity;
  const root = openStableRoot(request.root, mountIdentityResolver);
  try {
    const declarations = [...request.files].sort((left, right) =>
      Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))
    );
    const generatedPaths = new Set(policy.generated_paths);
    const firstReadOptions: SourceReadOptions =
      options.onBoundary === undefined
        ? {
            mountIdentityResolver,
            generatedPaths,
            contentMismatchCode: "integrity_mismatch",
          }
        : {
            mountIdentityResolver,
            generatedPaths,
            contentMismatchCode: "integrity_mismatch",
            onBoundary: options.onBoundary,
          };
    const entries = declarations.map((declaration) =>
      readDeclaredSource(root, declaration, policy, firstReadOptions)
    );
    assertRootStable(root, mountIdentityResolver);

    const verificationOptions: SourceReadOptions = {
      mountIdentityResolver,
      generatedPaths,
      contentMismatchCode: "read_race",
    };
    const verificationEntries = declarations.map((declaration) =>
      readDeclaredSource(root, declaration, policy, verificationOptions)
    );
    assertRootStable(root, mountIdentityResolver);
    if (canonicalJson(entries) !== canonicalJson(verificationEntries)) {
      fail("read_race", "declared source set changed during final coherence verification");
    }

    try {
      return buildScaSourceAdmissionResultV1(
        {
          tenant_id: request.tenant_id,
          project_id: request.project_id,
          run_id: request.run_id,
          source_snapshot_ref: snapshotRef,
        },
        policy,
        entries
      );
    } catch (error) {
      if (error instanceof ScaSourceManifestError) {
        mapInventoryError(error);
      }
      throw error;
    }
  } finally {
    closeQuietly(root.descriptor);
  }
}

export {
  ScaSourceAdmissionPolicyV1Schema,
  ScaSourceFileDeclarationV1Schema,
  ScaSourceAdmissionResultV1Schema,
  validateScaSourceAdmissionResultV1,
} from "./source-inventory.js";
