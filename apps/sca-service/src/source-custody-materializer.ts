import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { getuid } from "node:process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Type, type Static } from "typebox";
import { caseFold } from "unicode-case-folding";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  ScaP01SourceCustodyCorpusV1Schema,
  ScaP01SourceFileManifestV1Schema,
  scaP01SourceTreeDigest,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  type ScaP01SourceCustodyCorpusV1,
  type ScaP01SourceFileManifestV1,
} from "../../orchestration/dist/sca/p01-contracts.js";
import { Sha256Schema } from "../../orchestration/dist/skill-contracts/common.js";

const MAX_PATH_BYTES = 4_096;
const GENERATION_MARKER = ".penny-sca-generation.json";
const GENERATION_TOKEN_PATTERN = "^[a-f0-9]{64}$";
const GENERATION_MARKER_SCHEMA = "penny.sca-source-custody-generation-marker.v1";
const targetLocks = new Map<string, Promise<void>>();

/**
 * This entire service-side P02 slice is inactive and has no persisted consumers. The existing
 * schema IDs are therefore updated atomically with every in-tree producer, validator, and test
 * instead of minting misleading successor IDs before first activation.
 */
export const SCA_SOURCE_CUSTODY_MATERIALIZATION_INPUT_V1_SCHEMA =
  "penny.sca-source-custody-materialization-input.v1";
export const SCA_SOURCE_CUSTODY_MATERIALIZATION_RECEIPT_V1_SCHEMA =
  "penny.sca-source-custody-materialization-receipt.v1";
export const SCA_SOURCE_CUSTODY_QUARANTINE_RECEIPT_V1_SCHEMA =
  "penny.sca-source-custody-quarantine-receipt.v1";

export const ScaSourceCustodyMaterializationInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SOURCE_CUSTODY_MATERIALIZATION_INPUT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    file_manifest_sha256: Sha256Schema,
    custody_sha256: Sha256Schema,
    file_manifest: ScaP01SourceFileManifestV1Schema,
    custody: ScaP01SourceCustodyCorpusV1Schema,
  },
  { additionalProperties: false }
);

const FilesystemIdentityV1Schema = Type.Object(
  {
    device: Type.String({ pattern: "^[0-9]+$", maxLength: 64 }),
    inode: Type.String({ pattern: "^[0-9]+$", maxLength: 64 }),
  },
  { additionalProperties: false }
);

const MaterializedFileV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    byte_count: Type.Integer({ minimum: 0, maximum: 1_099_511_627_776 }),
    content_sha256: Sha256Schema,
    mode: Type.Literal("0444"),
  },
  { additionalProperties: false }
);

export const ScaSourceCustodyMaterializationReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SOURCE_CUSTODY_MATERIALIZATION_RECEIPT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    snapshot_id: Type.String({ minLength: 1, maxLength: 256 }),
    staging_root: Type.String({ minLength: 1, maxLength: 16_384 }),
    generation_token: Type.String({ pattern: GENERATION_TOKEN_PATTERN }),
    filesystem_identity: FilesystemIdentityV1Schema,
    file_manifest_sha256: Sha256Schema,
    custody_sha256: Sha256Schema,
    tree_sha256: Sha256Schema,
    file_count: Type.Integer({ minimum: 1, maximum: 100_000 }),
    byte_count: Type.Integer({ minimum: 0, maximum: 1_099_511_627_776 }),
    files: Type.Array(MaterializedFileV1Schema, { minItems: 1, maxItems: 100_000 }),
    directory_mode: Type.Literal("0555"),
    filesystem_modes_prepared_read_only: Type.Literal(true),
    sandbox_read_only_enforced: Type.Literal(false),
    receipt_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaSourceCustodyQuarantineReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SOURCE_CUSTODY_QUARANTINE_RECEIPT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    staging_root: Type.String({ minLength: 1, maxLength: 16_384 }),
    generation_token: Type.String({ pattern: GENERATION_TOKEN_PATTERN }),
    filesystem_identity: FilesystemIdentityV1Schema,
    method: Type.Literal("identity_checked_atomic_rename_to_private_quarantine"),
    tree_sha256: Sha256Schema,
    status: Type.Union([Type.Literal("quarantined"), Type.Literal("already_absent")]),
    quarantine_path: Type.Union([Type.String({ minLength: 1, maxLength: 16_384 }), Type.Null()]),
    quarantine_token: Type.Union([Type.String({ pattern: GENERATION_TOKEN_PATTERN }), Type.Null()]),
  },
  { additionalProperties: false }
);

const GenerationMarkerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(GENERATION_MARKER_SCHEMA),
    schema_version: Type.Literal(1),
    generation_token: Type.String({ pattern: GENERATION_TOKEN_PATTERN }),
    staging_root: Type.String({ minLength: 1, maxLength: 16_384 }),
    snapshot_id: Type.String({ minLength: 1, maxLength: 256 }),
    file_manifest_sha256: Sha256Schema,
    custody_sha256: Sha256Schema,
    tree_sha256: Sha256Schema,
    file_count: Type.Integer({ minimum: 1, maximum: 100_000 }),
    byte_count: Type.Integer({ minimum: 0, maximum: 1_099_511_627_776 }),
    filesystem_identity: FilesystemIdentityV1Schema,
    publication_intent: Type.Literal("publish_complete_tree"),
  },
  { additionalProperties: false }
);

type GenerationMarkerV1 = Static<typeof GenerationMarkerV1Schema>;
export type ScaSourceCustodyMaterializationInputV1 = Static<
  typeof ScaSourceCustodyMaterializationInputV1Schema
>;
export type ScaSourceCustodyMaterializationReceiptV1 = Static<
  typeof ScaSourceCustodyMaterializationReceiptV1Schema
>;
export type ScaSourceCustodyQuarantineReceiptV1 = Static<
  typeof ScaSourceCustodyQuarantineReceiptV1Schema
>;
type FilesystemIdentityV1 = Static<typeof FilesystemIdentityV1Schema>;
type UnsignedReceipt = Omit<ScaSourceCustodyMaterializationReceiptV1, "receipt_sha256">;

export interface ScaSourceCustodyMaterializationOptions {
  readonly staging_root: string;
  readonly signal?: AbortSignal;
  readonly on_file_materialized?: (completedFiles: number) => void;
}

export interface ScaSourceCustodyMaterialization {
  readonly receipt: ScaSourceCustodyMaterializationReceiptV1;
  readonly cleanup_plan: Readonly<{
    staging_root: string;
    generation_token: string;
    filesystem_identity: FilesystemIdentityV1;
    method: "identity_checked_atomic_rename_to_private_quarantine";
    tree_sha256: string;
  }>;
  cleanup(): Promise<ScaSourceCustodyQuarantineReceiptV1>;
}

export class ScaSourceCustodyMaterializationError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unsafe_path"
      | "path_collision"
      | "digest_mismatch"
      | "scope_mismatch"
      | "symlink_refused"
      | "staging_not_fresh"
      | "unknown_occupant"
      | "ownership_mismatch"
      | "interrupted"
      | "recovery_failed"
      | "materialization_failed",
    message: string
  ) {
    super(message);
    this.name = "ScaSourceCustodyMaterializationError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function withTargetLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const previous = targetLocks.get(target) ?? Promise.resolve();
  const release: { current: (() => void) | null } = { current: null };
  const current = new Promise<void>((resolveCurrent) => {
    release.current = resolveCurrent;
  });
  const tail = previous.then(() => current);
  targetLocks.set(target, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release.current?.();
    if (targetLocks.get(target) === tail) targetLocks.delete(target);
  }
}

/**
 * Stable path-collision key: NFKC first removes compatibility distinctions, then the pinned
 * Unicode data package applies complete locale-independent Default Case Folding.
 */
export function scaStableUnicodeCollisionKey(value: string): string {
  return caseFold(value.normalize("NFKC"));
}

function validateCanonicalSourcePath(candidate: string): void {
  const segments = candidate.split("/");
  if (
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/u.test(candidate) ||
    candidate !== candidate.normalize("NFC") ||
    Buffer.byteLength(candidate, "utf8") > MAX_PATH_BYTES ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    segments.includes(GENERATION_MARKER)
  ) {
    throw new ScaSourceCustodyMaterializationError(
      "unsafe_path",
      "custody path is not a canonical materialization path"
    );
  }
}

function pathInScope(path: string, manifest: ScaP01SourceFileManifestV1): boolean {
  const included = manifest.scope.include_paths.some(
    (candidate) => path === candidate || path.startsWith(`${candidate}/`)
  );
  const excluded = manifest.scope.exclude_paths.some(
    (candidate) => path === candidate || path.startsWith(`${candidate}/`)
  );
  return included && !excluded;
}

function validateStagingRoot(stagingRoot: string): string {
  if (
    !isAbsolute(stagingRoot) ||
    stagingRoot.includes("\0") ||
    stagingRoot !== stagingRoot.normalize("NFC") ||
    resolve(stagingRoot) !== stagingRoot ||
    basename(stagingRoot).length === 0
  ) {
    throw new ScaSourceCustodyMaterializationError(
      "unsafe_path",
      "staging root must be a canonical absolute caller-supplied path"
    );
  }
  return stagingRoot;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorCodeIs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function currentUid(): number {
  if (typeof getuid !== "function") {
    throw new ScaSourceCustodyMaterializationError(
      "unsafe_path",
      "materialization requires an operating system owner identity"
    );
  }
  return getuid();
}

async function assertPrivateOwnedParent(parent: string): Promise<FilesystemIdentityV1> {
  let status;
  let actual: string;
  try {
    status = await lstat(parent, { bigint: true });
    actual = await realpath(parent);
  } catch {
    throw new ScaSourceCustodyMaterializationError(
      "unsafe_path",
      "staging root parent must already exist"
    );
  }
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    actual !== parent ||
    status.uid !== BigInt(currentUid()) ||
    (status.mode & 0o777n) !== 0o700n
  ) {
    throw new ScaSourceCustodyMaterializationError(
      "unsafe_path",
      "staging root parent must be an owner-controlled non-symlink directory with mode 0700"
    );
  }
  return { device: status.dev.toString(), inode: status.ino.toString() };
}

function filesystemIdentity(status: {
  readonly dev: bigint;
  readonly ino: bigint;
}): FilesystemIdentityV1 {
  return { device: status.dev.toString(), inode: status.ino.toString() };
}

function sameIdentity(left: FilesystemIdentityV1, right: FilesystemIdentityV1): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function lstatOwnedDirectory(path: string): Promise<{
  readonly identity: FilesystemIdentityV1;
}> {
  const status = await lstat(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new ScaSourceCustodyMaterializationError(
      "symlink_refused",
      "materialization control path is not a non-symlink directory"
    );
  }
  if (status.uid !== BigInt(currentUid())) {
    throw new ScaSourceCustodyMaterializationError(
      "ownership_mismatch",
      "materialization control path is not owned by the service identity"
    );
  }
  return { identity: filesystemIdentity(status) };
}

function exactCustodyBytes(file: ScaP01SourceCustodyCorpusV1["files"][number]): Buffer {
  const bytes = Buffer.from(file.content_base64, "base64");
  if (
    bytes.toString("base64") !== file.content_base64 ||
    bytes.byteLength !== file.byte_count ||
    sha256(bytes) !== file.content_sha256
  ) {
    throw new ScaSourceCustodyMaterializationError(
      "digest_mismatch",
      `custody bytes are not exact for '${file.path}'`
    );
  }
  return bytes;
}

export function validateScaSourceCustodyMaterializationInputV1(
  value: unknown
): ScaSourceCustodyMaterializationInputV1 {
  let input: ScaSourceCustodyMaterializationInputV1;
  try {
    input = validateContract(
      ScaSourceCustodyMaterializationInputV1Schema,
      value,
      "SCA source custody materialization input"
    );
    validateScaP01SourceFileManifestV1(input.file_manifest);
    validateScaP01SourceCustodyCorpusV1(input.custody);
  } catch (error) {
    throw new ScaSourceCustodyMaterializationError(
      "invalid_input",
      error instanceof Error ? error.message : "source custody materialization input is invalid"
    );
  }
  if (
    sha256(canonicalJson(input.file_manifest)) !== input.file_manifest_sha256 ||
    sha256(canonicalJson(input.custody)) !== input.custody_sha256 ||
    input.custody.file_manifest_ref.content_digest !== input.file_manifest_sha256
  ) {
    throw new ScaSourceCustodyMaterializationError(
      "digest_mismatch",
      "manifest or custody digest does not match its exact input"
    );
  }
  if (
    input.file_manifest.snapshot_id !== input.custody.snapshot_id ||
    input.file_manifest.file_count !== input.custody.file_count ||
    input.file_manifest.byte_count !== input.custody.byte_count ||
    input.file_manifest.tree_sha256 !== input.custody.tree_sha256
  ) {
    throw new ScaSourceCustodyMaterializationError(
      "scope_mismatch",
      "manifest and custody summary are not exactly bound"
    );
  }

  const manifestByPath = new Map(input.file_manifest.files.map((file) => [file.path, file]));
  const exactPaths = new Set<string>();
  const collisionKeys = new Set<string>();
  for (const file of input.custody.files) {
    validateCanonicalSourcePath(file.path);
    const collisionKey = scaStableUnicodeCollisionKey(file.path);
    if (exactPaths.has(file.path) || collisionKeys.has(collisionKey)) {
      throw new ScaSourceCustodyMaterializationError(
        "path_collision",
        "custody paths collide exactly or by the documented Unicode collision key"
      );
    }
    exactPaths.add(file.path);
    collisionKeys.add(collisionKey);
    const manifestFile = manifestByPath.get(file.path);
    if (
      manifestFile === undefined ||
      manifestFile.byte_count !== file.byte_count ||
      manifestFile.content_sha256 !== file.content_sha256 ||
      !pathInScope(file.path, input.file_manifest)
    ) {
      throw new ScaSourceCustodyMaterializationError(
        "scope_mismatch",
        `custody file '${file.path}' is not exactly admitted by the manifest`
      );
    }
    exactCustodyBytes(file);
  }
  if (exactPaths.size !== manifestByPath.size) {
    throw new ScaSourceCustodyMaterializationError(
      "scope_mismatch",
      "manifest and custody file sets differ"
    );
  }
  return input;
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncFileNoFollow(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      throw new ScaSourceCustodyMaterializationError(
        "symlink_refused",
        "materialized entry is not a regular file"
      );
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectoryTree(root: string, sourcePath: string): Promise<void> {
  const parentRelative = dirname(sourcePath);
  if (parentRelative === ".") return;
  let current = root;
  for (const segment of parentRelative.split("/")) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
      await fsyncDirectory(dirname(current));
    } catch (error) {
      if (!errorCodeIs(error, "EEXIST")) throw error;
      const status = await lstat(current);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new ScaSourceCustodyMaterializationError(
          "symlink_refused",
          "materialization encountered a non-directory or symbolic link"
        );
      }
    }
    await fsyncDirectory(current);
  }
}

async function writeExclusiveFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(dirname(path));
}

async function strictReadFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new ScaSourceCustodyMaterializationError(
        "symlink_refused",
        "materialization entry is not a regular file"
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new ScaSourceCustodyMaterializationError(
        "ownership_mismatch",
        "materialization entry changed while it was being verified"
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readGenerationMarker(root: string): Promise<GenerationMarkerV1> {
  let parsed: unknown;
  try {
    const bytes = await strictReadFile(join(root, GENERATION_MARKER));
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ScaSourceCustodyMaterializationError) throw error;
    throw new ScaSourceCustodyMaterializationError(
      "unknown_occupant",
      "materialization occupant has no valid generation marker"
    );
  }
  try {
    return validateContract(GenerationMarkerV1Schema, parsed, "SCA generation marker");
  } catch {
    throw new ScaSourceCustodyMaterializationError(
      "unknown_occupant",
      "materialization occupant has an invalid generation marker"
    );
  }
}

async function collectDirectories(root: string): Promise<string[]> {
  const directories = [root];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ScaSourceCustodyMaterializationError(
          "symlink_refused",
          "materialized tree unexpectedly contains a symbolic link"
        );
      }
      if (entry.isDirectory()) {
        directories.push(path);
        stack.push(path);
      } else if (!entry.isFile()) {
        throw new ScaSourceCustodyMaterializationError(
          "materialization_failed",
          "materialized tree contains an unsupported filesystem entry"
        );
      }
    }
  }
  return directories;
}

async function verifyPreparedTreeModes(root: string): Promise<void> {
  const directories = await collectDirectories(root);
  for (const directory of directories) {
    const status = await lstat(directory, { bigint: true });
    if (
      status.isSymbolicLink() ||
      !status.isDirectory() ||
      status.uid !== BigInt(currentUid()) ||
      (status.mode & 0o777n) !== 0o555n
    ) {
      throw new ScaSourceCustodyMaterializationError(
        "ownership_mismatch",
        "published materialization directory modes or ownership changed"
      );
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fileStatus = await lstat(join(directory, entry.name), { bigint: true });
      if (
        fileStatus.isSymbolicLink() ||
        !fileStatus.isFile() ||
        fileStatus.uid !== BigInt(currentUid()) ||
        (fileStatus.mode & 0o777n) !== 0o444n
      ) {
        throw new ScaSourceCustodyMaterializationError(
          "ownership_mismatch",
          "published materialization file modes or ownership changed"
        );
      }
    }
  }
}

async function prepareTreeModesAndSync(root: string): Promise<void> {
  const directories = await collectDirectories(root);
  const stack = [...directories];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(directory, entry.name);
      await chmod(path, 0o444);
      await fsyncFileNoFollow(path);
    }
  }
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) {
    await chmod(directory, 0o555);
    await fsyncDirectory(directory);
  }
}

function privateName(stagingRoot: string, role: "partial" | "quarantine", token: string): string {
  return join(dirname(stagingRoot), `${basename(stagingRoot)}.penny-${role}-${token}`);
}

function tokenFromPrivateName(
  name: string,
  stagingBase: string,
  role: "partial" | "quarantine"
): string | null {
  const prefix = `${stagingBase}.penny-${role}-`;
  if (!name.startsWith(prefix)) return null;
  const token = name.slice(prefix.length);
  return /^[a-f0-9]{64}$/u.test(token) ? token : null;
}

/**
 * This component stops at quarantine. Retention and deletion belong to a separately isolated,
 * privileged janitor and are intentionally not exposed by this module.
 */
type PrivateQuarantine = Readonly<{
  path: string;
  token: string;
  identity: FilesystemIdentityV1;
}>;

async function quarantineOwnedGeneration(
  sourcePath: string,
  stagingRoot: string,
  expectedIdentity: FilesystemIdentityV1
): Promise<PrivateQuarantine> {
  const observed = await lstatOwnedDirectory(sourcePath);
  if (!sameIdentity(observed.identity, expectedIdentity)) {
    throw new ScaSourceCustodyMaterializationError(
      "ownership_mismatch",
      "generation changed before quarantine"
    );
  }
  const token = randomBytes(32).toString("hex");
  const path = privateName(stagingRoot, "quarantine", token);
  try {
    await lstat(path);
    throw new ScaSourceCustodyMaterializationError(
      "unknown_occupant",
      "private quarantine destination is already occupied"
    );
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await rename(sourcePath, path);
  await fsyncDirectory(dirname(stagingRoot));
  const quarantined = await lstatOwnedDirectory(path);
  if (!sameIdentity(quarantined.identity, expectedIdentity)) {
    throw new ScaSourceCustodyMaterializationError(
      "ownership_mismatch",
      "quarantined generation does not have the identity checked before rename"
    );
  }
  return { path, token, identity: quarantined.identity };
}

async function recoverOwnedPrivateGenerations(stagingRoot: string): Promise<void> {
  const parent = dirname(stagingRoot);
  const stagingBase = basename(stagingRoot);
  const entries = await readdir(parent, { withFileTypes: true });
  for (const entry of entries) {
    const partialToken = tokenFromPrivateName(entry.name, stagingBase, "partial");
    const quarantineToken = tokenFromPrivateName(entry.name, stagingBase, "quarantine");
    if (partialToken === null && quarantineToken === null) {
      if (
        entry.name.startsWith(`${stagingBase}.penny-partial-`) ||
        entry.name.startsWith(`${stagingBase}.penny-quarantine-`)
      ) {
        throw new ScaSourceCustodyMaterializationError(
          "unknown_occupant",
          "materialization control namespace contains an unknown occupant"
        );
      }
      continue;
    }
    const path = join(parent, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ScaSourceCustodyMaterializationError(
        "unknown_occupant",
        "materialization control namespace contains a non-directory occupant"
      );
    }
    const observed = await lstatOwnedDirectory(path);
    try {
      const marker = await readGenerationMarker(path);
      if (
        (partialToken !== null && marker.generation_token !== partialToken) ||
        marker.staging_root !== stagingRoot ||
        !sameIdentity(marker.filesystem_identity, observed.identity)
      ) {
        throw new ScaSourceCustodyMaterializationError(
          "unknown_occupant",
          "private generation marker does not match its owned namespace or filesystem identity"
        );
      }
    } catch (error) {
      if (!isMissingMarker(error)) throw error;
      // A crash between exclusive mkdir and first marker write leaves a recognizable empty partial.
      const contents = await readdir(path);
      if (contents.length !== 0) {
        throw new ScaSourceCustodyMaterializationError(
          "unknown_occupant",
          "unmarked private generation is not empty"
        );
      }
    }
    if (partialToken !== null) {
      await quarantineOwnedGeneration(path, stagingRoot, observed.identity);
    }
  }
}

function isMissingMarker(error: unknown): boolean {
  return error instanceof ScaSourceCustodyMaterializationError && error.code === "unknown_occupant";
}

async function verifyExpectedTree(
  root: string,
  input: ScaSourceCustodyMaterializationInputV1
): Promise<ScaSourceCustodyMaterializationReceiptV1["files"]> {
  const expectedFiles = new Set(input.custody.files.map((file) => file.path));
  const observedFiles = new Set<string>();
  const directories = await collectDirectories(root);
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      if (relativePath === GENERATION_MARKER) continue;
      observedFiles.add(relativePath);
    }
  }
  if (
    observedFiles.size !== expectedFiles.size ||
    [...observedFiles].some((path) => !expectedFiles.has(path))
  ) {
    throw new ScaSourceCustodyMaterializationError(
      "scope_mismatch",
      "materialized filesystem file set differs from custody"
    );
  }
  const files: ScaSourceCustodyMaterializationReceiptV1["files"] = [];
  for (const file of [...input.custody.files].sort((left, right) =>
    compareUtf8(left.path, right.path)
  )) {
    const bytes = await strictReadFile(join(root, ...file.path.split("/")));
    if (bytes.byteLength !== file.byte_count || sha256(bytes) !== file.content_sha256) {
      throw new ScaSourceCustodyMaterializationError(
        "digest_mismatch",
        "materialized file differs from custody"
      );
    }
    files.push({
      path: file.path,
      byte_count: file.byte_count,
      content_sha256: file.content_sha256,
      mode: "0444",
    });
  }
  return files;
}

function markerMatchesInput(
  marker: GenerationMarkerV1,
  input: ScaSourceCustodyMaterializationInputV1
): boolean {
  return (
    marker.snapshot_id === input.file_manifest.snapshot_id &&
    marker.file_manifest_sha256 === input.file_manifest_sha256 &&
    marker.custody_sha256 === input.custody_sha256 &&
    marker.tree_sha256 === input.file_manifest.tree_sha256 &&
    marker.file_count === input.file_manifest.file_count &&
    marker.byte_count === input.file_manifest.byte_count
  );
}

function receiptDigest(value: UnsignedReceipt): string {
  return sha256(canonicalJson(value));
}

function createReceipt(
  input: ScaSourceCustodyMaterializationInputV1,
  stagingRoot: string,
  marker: GenerationMarkerV1,
  files: ScaSourceCustodyMaterializationReceiptV1["files"]
): ScaSourceCustodyMaterializationReceiptV1 {
  const treeSha256 = scaP01SourceTreeDigest(files);
  if (treeSha256 !== input.file_manifest.tree_sha256) {
    throw new ScaSourceCustodyMaterializationError(
      "digest_mismatch",
      "materialized tree digest differs from the admitted tree"
    );
  }
  const unsigned: UnsignedReceipt = {
    schema_id: SCA_SOURCE_CUSTODY_MATERIALIZATION_RECEIPT_V1_SCHEMA,
    schema_version: 1,
    snapshot_id: input.file_manifest.snapshot_id,
    staging_root: stagingRoot,
    generation_token: marker.generation_token,
    filesystem_identity: marker.filesystem_identity,
    file_manifest_sha256: input.file_manifest_sha256,
    custody_sha256: input.custody_sha256,
    tree_sha256: treeSha256,
    file_count: files.length,
    byte_count: files.reduce((total, file) => total + file.byte_count, 0),
    files,
    directory_mode: "0555",
    filesystem_modes_prepared_read_only: true,
    sandbox_read_only_enforced: false,
  };
  return validateContract(
    ScaSourceCustodyMaterializationReceiptV1Schema,
    { ...unsigned, receipt_sha256: receiptDigest(unsigned) },
    "SCA source custody materialization receipt"
  );
}

function quarantineReceipt(
  stagingRoot: string,
  generationToken: string,
  identity: FilesystemIdentityV1,
  treeSha256: string,
  quarantine: PrivateQuarantine | null
): ScaSourceCustodyQuarantineReceiptV1 {
  return validateContract(
    ScaSourceCustodyQuarantineReceiptV1Schema,
    {
      schema_id: SCA_SOURCE_CUSTODY_QUARANTINE_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      staging_root: stagingRoot,
      generation_token: generationToken,
      filesystem_identity: identity,
      method: "identity_checked_atomic_rename_to_private_quarantine",
      tree_sha256: treeSha256,
      status: quarantine === null ? "already_absent" : "quarantined",
      quarantine_path: quarantine?.path ?? null,
      quarantine_token: quarantine?.token ?? null,
    },
    "SCA source custody quarantine receipt"
  );
}

async function quarantinePublishedGeneration(
  stagingRoot: string,
  generationToken: string,
  expectedIdentity: FilesystemIdentityV1,
  treeSha256: string
): Promise<ScaSourceCustodyQuarantineReceiptV1> {
  await assertPrivateOwnedParent(dirname(stagingRoot));
  let observed;
  try {
    observed = await lstatOwnedDirectory(stagingRoot);
  } catch (error) {
    if (isMissing(error)) {
      return quarantineReceipt(stagingRoot, generationToken, expectedIdentity, treeSha256, null);
    }
    throw error;
  }
  const marker = await readGenerationMarker(stagingRoot);
  if (
    marker.generation_token !== generationToken ||
    !sameIdentity(marker.filesystem_identity, expectedIdentity) ||
    !sameIdentity(observed.identity, expectedIdentity) ||
    marker.tree_sha256 !== treeSha256
  ) {
    throw new ScaSourceCustodyMaterializationError(
      "ownership_mismatch",
      "cleanup refused a replacement or generation identity mismatch"
    );
  }

  const quarantine = await quarantineOwnedGeneration(stagingRoot, stagingRoot, expectedIdentity);
  const quarantinedMarker = await readGenerationMarker(quarantine.path);
  if (
    quarantinedMarker.generation_token !== generationToken ||
    quarantinedMarker.staging_root !== stagingRoot ||
    quarantinedMarker.tree_sha256 !== treeSha256 ||
    !sameIdentity(quarantinedMarker.filesystem_identity, expectedIdentity)
  ) {
    throw new ScaSourceCustodyMaterializationError(
      "ownership_mismatch",
      "cleanup quarantined an occupant whose marker does not match the checked generation"
    );
  }
  return quarantineReceipt(stagingRoot, generationToken, expectedIdentity, treeSha256, quarantine);
}

function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ScaSourceCustodyMaterializationError(
      "interrupted",
      "materialization was interrupted"
    );
  }
}

function materializationHandle(
  receipt: ScaSourceCustodyMaterializationReceiptV1
): ScaSourceCustodyMaterialization {
  const cleanupPlan = Object.freeze({
    staging_root: receipt.staging_root,
    generation_token: receipt.generation_token,
    filesystem_identity: receipt.filesystem_identity,
    method: "identity_checked_atomic_rename_to_private_quarantine" as const,
    tree_sha256: receipt.tree_sha256,
  });
  return Object.freeze({
    receipt,
    cleanup_plan: cleanupPlan,
    cleanup: async () =>
      withTargetLock(receipt.staging_root, async () =>
        quarantinePublishedGeneration(
          receipt.staging_root,
          receipt.generation_token,
          receipt.filesystem_identity,
          receipt.tree_sha256
        )
      ),
  });
}

async function recoverPublishedGeneration(
  stagingRoot: string,
  input: ScaSourceCustodyMaterializationInputV1
): Promise<ScaSourceCustodyMaterialization | null> {
  let observed;
  try {
    observed = await lstatOwnedDirectory(stagingRoot);
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof ScaSourceCustodyMaterializationError) throw error;
    throw new ScaSourceCustodyMaterializationError(
      "unknown_occupant",
      "staging root is occupied by an unknown filesystem entry"
    );
  }
  const marker = await readGenerationMarker(stagingRoot);
  if (
    marker.staging_root !== stagingRoot ||
    !sameIdentity(marker.filesystem_identity, observed.identity)
  ) {
    throw new ScaSourceCustodyMaterializationError(
      "unknown_occupant",
      "published generation marker does not match its filesystem identity"
    );
  }
  if (!markerMatchesInput(marker, input)) {
    throw new ScaSourceCustodyMaterializationError(
      "staging_not_fresh",
      "staging root contains a different owned generation"
    );
  }
  const files = await verifyExpectedTree(stagingRoot, input);
  await verifyPreparedTreeModes(stagingRoot);
  return materializationHandle(createReceipt(input, stagingRoot, marker, files));
}

async function materializeScaSourceCustodyUnlocked(
  value: unknown,
  options: ScaSourceCustodyMaterializationOptions
): Promise<ScaSourceCustodyMaterialization> {
  const input = validateScaSourceCustodyMaterializationInputV1(value);
  const stagingRoot = validateStagingRoot(options.staging_root);
  const parent = dirname(stagingRoot);
  const parentIdentity = await assertPrivateOwnedParent(parent);
  await recoverOwnedPrivateGenerations(stagingRoot);
  const recovered = await recoverPublishedGeneration(stagingRoot, input);
  if (recovered !== null) return recovered;
  throwIfInterrupted(options.signal);

  const generationToken = randomBytes(32).toString("hex");
  const privateRoot = privateName(stagingRoot, "partial", generationToken);
  let privateIdentity: FilesystemIdentityV1 | null = null;
  try {
    await mkdir(privateRoot, { mode: 0o700 });
    privateIdentity = (await lstatOwnedDirectory(privateRoot)).identity;
    await fsyncDirectory(parent);
    const marker: GenerationMarkerV1 = validateContract(
      GenerationMarkerV1Schema,
      {
        schema_id: GENERATION_MARKER_SCHEMA,
        schema_version: 1,
        generation_token: generationToken,
        staging_root: stagingRoot,
        snapshot_id: input.file_manifest.snapshot_id,
        file_manifest_sha256: input.file_manifest_sha256,
        custody_sha256: input.custody_sha256,
        tree_sha256: input.file_manifest.tree_sha256,
        file_count: input.file_manifest.file_count,
        byte_count: input.file_manifest.byte_count,
        filesystem_identity: privateIdentity,
        publication_intent: "publish_complete_tree",
      },
      "SCA generation marker"
    );
    await writeExclusiveFile(
      join(privateRoot, GENERATION_MARKER),
      Buffer.from(canonicalJson(marker), "utf8"),
      0o600
    );

    const orderedFiles = [...input.custody.files].sort((left, right) =>
      compareUtf8(left.path, right.path)
    );
    for (const [index, file] of orderedFiles.entries()) {
      throwIfInterrupted(options.signal);
      await ensureDirectoryTree(privateRoot, file.path);
      const finalPath = join(privateRoot, ...file.path.split("/"));
      const relation = relative(privateRoot, finalPath);
      if (relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
        throw new ScaSourceCustodyMaterializationError(
          "unsafe_path",
          "materialized path escaped the private generation root"
        );
      }
      await writeExclusiveFile(finalPath, exactCustodyBytes(file), 0o600);
      options.on_file_materialized?.(index + 1);
      throwIfInterrupted(options.signal);
    }

    const files = await verifyExpectedTree(privateRoot, input);
    if (scaP01SourceTreeDigest(files) !== input.file_manifest.tree_sha256) {
      throw new ScaSourceCustodyMaterializationError(
        "digest_mismatch",
        "private materialized tree digest differs from the admitted tree"
      );
    }
    await prepareTreeModesAndSync(privateRoot);
    throwIfInterrupted(options.signal);

    const parentRecheck = await assertPrivateOwnedParent(parent);
    if (!sameIdentity(parentIdentity, parentRecheck)) {
      throw new ScaSourceCustodyMaterializationError(
        "ownership_mismatch",
        "staging parent changed before publication"
      );
    }
    try {
      await lstat(stagingRoot);
      throw new ScaSourceCustodyMaterializationError(
        "staging_not_fresh",
        "staging root became occupied before publication"
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await rename(privateRoot, stagingRoot);
    await fsyncDirectory(parent);

    const published = await lstatOwnedDirectory(stagingRoot);
    if (!sameIdentity(published.identity, privateIdentity)) {
      throw new ScaSourceCustodyMaterializationError(
        "ownership_mismatch",
        "published generation identity differs from the verified private tree"
      );
    }
    const publishedMarker = await readGenerationMarker(stagingRoot);
    await verifyPreparedTreeModes(stagingRoot);
    if (
      publishedMarker.generation_token !== generationToken ||
      !sameIdentity(publishedMarker.filesystem_identity, published.identity)
    ) {
      throw new ScaSourceCustodyMaterializationError(
        "ownership_mismatch",
        "published generation marker differs from the verified private tree"
      );
    }
    return materializationHandle(createReceipt(input, stagingRoot, publishedMarker, files));
  } catch (error) {
    if (privateIdentity !== null) {
      try {
        await quarantineOwnedGeneration(privateRoot, stagingRoot, privateIdentity);
      } catch (cleanupError) {
        if (!isMissing(cleanupError)) {
          throw new ScaSourceCustodyMaterializationError(
            "recovery_failed",
            "materialization failed and its owned private generation could not be quarantined"
          );
        }
      }
    }
    if (error instanceof ScaSourceCustodyMaterializationError) throw error;
    throw new ScaSourceCustodyMaterializationError(
      options.signal?.aborted === true ? "interrupted" : "materialization_failed",
      options.signal?.aborted === true
        ? "materialization was interrupted"
        : "source custody materialization failed"
    );
  }
}

export async function materializeScaSourceCustodyV1(
  value: unknown,
  options: ScaSourceCustodyMaterializationOptions
): Promise<ScaSourceCustodyMaterialization> {
  const stagingRoot = validateStagingRoot(options.staging_root);
  return withTargetLock(stagingRoot, async () =>
    materializeScaSourceCustodyUnlocked(value, { ...options, staging_root: stagingRoot })
  );
}
