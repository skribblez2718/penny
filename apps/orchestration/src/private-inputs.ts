/**
 * Durable private-input custody (§5.6) — the owner-only lifecycle of the bytes
 * that a start action's closed request carries (query text, titles, filters …).
 *
 * ## The split
 *
 * The CONTROL DATABASE (the checkpointer) indexes the input BEFORE its bytes
 * exist: one `preparing` record with host-preallocated exact final/temporary
 * keys, committed in the same transaction as the durable run row and the
 * idempotency record. This module owns only the BYTES under the trusted,
 * catalog-bound project input root and performs the CAS that
 * each filesystem step earns:
 *
 * ```text
 *   index (preparing) → write temp (0600, no-follow) → fsync → rename
 *                      → fsync parent → CAS active
 *   … later, at terminal: CAS terminal → CAS discarding
 *                      → remove ONLY the exact indexed keys → fsync
 *                      → CAS discarded
 * ```
 *
 * Recovery uses only the indexed row: a `preparing` row with a matching exact
 * temp is hash-checked and adopted through rename; a missing temp is rewritten
 * from the validated request and re-verified; a mismatching temp, a symlink, a
 * wrong owner/mode, or a link-count surprise refuses — nothing is adopted from
 * a scan, and a mismatch on the write path discards the exact indexed keys and
 * leaves the run incomplete. The index row survives as `discarded` metadata;
 * the bytes do not survive their owner.
 *
 * ## What never happens here
 *
 * No request body is logged, stored in the control DB, or returned: this
 * module reads bytes only to (a) verify them against the indexed digest and
 * hand the parsed value to the caller in memory, or (b) delete the exact
 * indexed keys at discard.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import type { Checkpointer } from "./checkpointer.js";
import { canonicalJson, sha256 } from "./checkpointer.js";
import type { RunContext } from "./context.js";
import { resolvePennyRuntimeState } from "./state/setup.js";

/** A custody, hash, or lifecycle refusal. `code` is bounded and safe to surface. */
export class PrivateInputError extends Error {
  constructor(
    readonly code:
      | "index_missing"
      | "custody_refused"
      | "hash_mismatch"
      | "state_mismatch"
      | "read_refused",
    message: string
  ) {
    super(message);
    this.name = "PrivateInputError";
  }
}

function ownerUid(): number | undefined {
  try {
    return typeof process.getuid === "function" ? process.getuid() : undefined;
  } catch {
    return undefined;
  }
}

function errorHasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

/** The trusted catalog-bound input root; never a model-visible argument. */
export function privateInputRoot(projectRoot: string): string {
  return resolvePennyRuntimeState(path.resolve(projectRoot)).paths.orchestration.inputs;
}

function assertOwnerDirectory(dir: string, what: string): void {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PrivateInputError("custody_refused", `${what} must be a regular directory`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new PrivateInputError("custody_refused", `${what} must be owner-only (0700)`);
  }
  const uid = ownerUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new PrivateInputError("custody_refused", `${what} must be current-user-owned`);
  }
}

function assertOwnerFile(file: string, what: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PrivateInputError("custody_refused", `${what} must be a regular non-symlink file`);
  }
  // A stray second link is a custody surprise: refuse rather than follow it.
  if (stat.nlink !== 1) {
    throw new PrivateInputError("custody_refused", `${what} has an unexpected link count`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new PrivateInputError("custody_refused", `${what} mode must be exactly 0600`);
  }
  const uid = ownerUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new PrivateInputError("custody_refused", `${what} must be current-user-owned`);
  }
}

function readOwnerFile(file: string, what: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new PrivateInputError("custody_refused", `${what} failed descriptor custody checks`);
    }
    const uid = ownerUid();
    if (uid !== undefined && stat.uid !== uid) {
      throw new PrivateInputError("custody_refused", `${what} must be current-user-owned`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function digestOf(bytes: Buffer): string {
  return sha256(bytes);
}

function requirePrivateInputRow(
  checkpointer: Checkpointer,
  runId: string
): NonNullable<ReturnType<Checkpointer["getPrivateInput"]>> {
  const row = checkpointer.getPrivateInput(runId);
  if (row === undefined) {
    throw new PrivateInputError(
      "index_missing",
      `run '${runId}' has no indexed private input; refusing un-indexed private bytes`
    );
  }
  if (row.run_id !== runId || row.storage_key !== `${runId}/request.json`) {
    throw new PrivateInputError("custody_refused", "the indexed private input identity is corrupt");
  }
  if (
    row.temporary_storage_key !== undefined &&
    (!row.temporary_storage_key.startsWith(`${runId}/.`) ||
      !row.temporary_storage_key.endsWith(".tmp") ||
      row.temporary_storage_key.slice(runId.length + 2).includes("/"))
  ) {
    throw new PrivateInputError("custody_refused", "the indexed private input temp key is corrupt");
  }
  return row;
}

interface StableOwnerDirectory {
  readonly path: string;
  readonly canonicalPath: string;
  readonly descriptor: number;
  readonly descriptorRoot: string;
  readonly device: number | bigint;
  readonly inode: number | bigint;
  readonly what: string;
}

function sameDirectoryIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
  throw new PrivateInputError(
    "custody_refused",
    "private input operations require a stable directory-descriptor filesystem"
  );
}

function openStableOwnerDirectory(
  directory: string,
  what: string,
  expectedPath = directory
): StableOwnerDirectory {
  const openPath = path.resolve(directory);
  const absolute = path.resolve(expectedPath);
  let descriptor: number | undefined;
  try {
    assertOwnerDirectory(absolute, what);
    const canonicalPath = realpathSync.native(absolute);
    if (canonicalPath !== absolute) {
      throw new PrivateInputError("custody_refused", `${what} has a symlinked path component`);
    }
    descriptor = openSync(
      openPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const pathStat = lstatSync(absolute);
    const descriptorStat = fstatSync(descriptor);
    if (!sameDirectoryIdentity(pathStat, descriptorStat)) {
      throw new PrivateInputError("custody_refused", `${what} changed while it was opened`);
    }
    const descriptorRoot = descriptorRootFor(descriptor);
    if (realpathSync.native(descriptorRoot) !== canonicalPath) {
      throw new PrivateInputError("custody_refused", `${what} descriptor identity disagrees`);
    }
    return {
      path: absolute,
      canonicalPath,
      descriptor,
      descriptorRoot,
      device: descriptorStat.dev,
      inode: descriptorStat.ino,
      what,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // best effort after refusal
      }
    }
    if (error instanceof PrivateInputError) throw error;
    throw new PrivateInputError(
      "custody_refused",
      `${what} failed stable directory custody checks`
    );
  }
}

function assertStableOwnerDirectory(directory: StableOwnerDirectory): void {
  try {
    assertOwnerDirectory(directory.path, directory.what);
    const pathStat = lstatSync(directory.path);
    const descriptorStat = fstatSync(directory.descriptor);
    if (
      !sameDirectoryIdentity(pathStat, descriptorStat) ||
      pathStat.dev !== directory.device ||
      pathStat.ino !== directory.inode ||
      realpathSync.native(directory.path) !== directory.canonicalPath ||
      realpathSync.native(directory.descriptorRoot) !== directory.canonicalPath
    ) {
      throw new PrivateInputError(
        "custody_refused",
        `${directory.what} changed during a private input operation`
      );
    }
  } catch (error) {
    if (error instanceof PrivateInputError) throw error;
    throw new PrivateInputError(
      "custody_refused",
      `${directory.what} changed during a private input operation`
    );
  }
}

function closeStableOwnerDirectory(directory: StableOwnerDirectory): void {
  closeSync(directory.descriptor);
}

function stableEntry(directory: StableOwnerDirectory, leaf: string): string {
  if (
    leaf.length === 0 ||
    leaf === "." ||
    leaf === ".." ||
    leaf.includes("/") ||
    leaf.includes("\\")
  ) {
    throw new PrivateInputError("custody_refused", "private input entry name is unsafe");
  }
  return path.join(directory.descriptorRoot, leaf);
}

function entryExistsNoFollow(directory: StableOwnerDirectory, leaf: string): boolean {
  try {
    lstatSync(stableEntry(directory, leaf));
    return true;
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function fsyncStableDirectory(directory: StableOwnerDirectory): void {
  fsyncSync(directory.descriptor);
}

function storageLeaves(row: NonNullable<ReturnType<Checkpointer["getPrivateInput"]>>): {
  readonly runLeaf: string;
  readonly finalLeaf: string;
  readonly tempLeaf: string | undefined;
} {
  const [runLeaf, finalLeaf] = row.storage_key.split("/");
  if (runLeaf === undefined || finalLeaf === undefined) {
    throw new PrivateInputError("custody_refused", "the indexed private input key is corrupt");
  }
  const tempLeaf = row.temporary_storage_key?.split("/")[1];
  return { runLeaf, finalLeaf, tempLeaf };
}

export type PrivateInputCustodyBoundary =
  | "before_temp_create"
  | "before_temp_rename"
  | "before_exact_unlink";

export interface MaterializeInput {
  readonly projectRoot: string;
  readonly checkpointer: Checkpointer;
  readonly runId: string;
  /** The exact closed request (validated); its JCS bytes are what gets stored. */
  readonly request: unknown;
  /** The digest bound by the admission row; must cover the same bytes. */
  readonly requestSha256: string;
  /** Deterministic race-injection seam for custody regression tests. */
  readonly onCustodyBoundary?: (boundary: PrivateInputCustodyBoundary) => void;
}

/**
 * Materialize the run's private input from the indexed admission, exactly and
 * idempotently:
 *
 * - `active`: verify the final file custody + hash and return (no rewrite).
 * - `preparing`: adopt the indexed exact temp if its bytes hash-match, else
 *   rewrite the temp from the validated request (no-follow exclusive, mode
 *   0600), fsync, rename to the exact final key, fsync the parent, CAS
 *   `active`.
 * - a temp that fails its hash check refuses: the exact indexed keys are
 *   driven through `discarding → discarded`, removed, and the run is left
 *   incomplete (a mismatch is never silently rewritten over).
 */
export function materializeRunInput(input: MaterializeInput): void {
  const root = privateInputRoot(input.projectRoot);
  const row = requirePrivateInputRow(input.checkpointer, input.runId);
  if (row.request_sha256 !== input.requestSha256) {
    throw new PrivateInputError(
      "hash_mismatch",
      "the admitted request digest does not match the supplied request"
    );
  }
  const bytes = Buffer.from(canonicalJson(input.request), "utf8");
  if (digestOf(bytes) !== input.requestSha256) {
    throw new PrivateInputError(
      "hash_mismatch",
      "the supplied request does not canonicalize to its admitted digest"
    );
  }
  if (row.state === "terminal" || row.state === "discarding" || row.state === "discarded") {
    throw new PrivateInputError(
      "state_mismatch",
      `the private input of run '${input.runId}' is already ${row.state}; it cannot be re-materialized`
    );
  }

  const { runLeaf, finalLeaf, tempLeaf } = storageLeaves(row);
  const rootDirectory = openStableOwnerDirectory(root, "the private input root");
  let runDirectory: StableOwnerDirectory | undefined;
  try {
    if (!entryExistsNoFollow(rootDirectory, runLeaf)) {
      if (row.state === "active") {
        throw new PrivateInputError(
          "custody_refused",
          "the active private input run directory is absent"
        );
      }
      mkdirSync(stableEntry(rootDirectory, runLeaf), { mode: 0o700 });
      fsyncStableDirectory(rootDirectory);
    }
    assertStableOwnerDirectory(rootDirectory);
    runDirectory = openStableOwnerDirectory(
      stableEntry(rootDirectory, runLeaf),
      "the private input run directory",
      path.join(rootDirectory.canonicalPath, runLeaf)
    );
    assertStableOwnerDirectory(rootDirectory);

    if (row.state === "active") {
      assertOwnerFile(stableEntry(runDirectory, finalLeaf), "the private input file");
      const stored = readOwnerFile(stableEntry(runDirectory, finalLeaf), "the private input file");
      assertStableOwnerDirectory(runDirectory);
      if (digestOf(stored) !== input.requestSha256) {
        throw new PrivateInputError(
          "hash_mismatch",
          "the active private input no longer matches its indexed digest"
        );
      }
      return;
    }

    // A crash after rename but before the active CAS leaves the exact final entry.
    if (entryExistsNoFollow(runDirectory, finalLeaf)) {
      let adoptable = false;
      try {
        assertOwnerFile(stableEntry(runDirectory, finalLeaf), "the private input file");
        adoptable =
          digestOf(
            readOwnerFile(stableEntry(runDirectory, finalLeaf), "the private input file")
          ) === input.requestSha256;
      } catch {
        adoptable = false;
      }
      assertStableOwnerDirectory(runDirectory);
      if (adoptable && (tempLeaf === undefined || !entryExistsNoFollow(runDirectory, tempLeaf))) {
        input.checkpointer.privateInputActivate(row.private_input_id);
        return;
      }
      discardExactEntries(input, row, rootDirectory, runDirectory, finalLeaf, tempLeaf);
      throw new PrivateInputError(
        "hash_mismatch",
        "the indexed final private input is mismatched or ambiguous; the run is left incomplete"
      );
    }

    // A matching exact indexed temp may be adopted. Anything else is discarded,
    // never rewritten over.
    if (tempLeaf !== undefined && entryExistsNoFollow(runDirectory, tempLeaf)) {
      let adoptable = false;
      try {
        assertOwnerFile(stableEntry(runDirectory, tempLeaf), "the private input temporary file");
        adoptable =
          digestOf(
            readOwnerFile(stableEntry(runDirectory, tempLeaf), "the private input temporary file")
          ) === input.requestSha256;
      } catch {
        adoptable = false;
      }
      if (adoptable) {
        input.onCustodyBoundary?.("before_temp_rename");
        assertStableOwnerDirectory(rootDirectory);
        assertStableOwnerDirectory(runDirectory);
        renameSync(stableEntry(runDirectory, tempLeaf), stableEntry(runDirectory, finalLeaf));
        fsyncStableDirectory(runDirectory);
        assertStableOwnerDirectory(runDirectory);
        input.checkpointer.privateInputActivate(row.private_input_id);
        assertOwnerFile(stableEntry(runDirectory, finalLeaf), "the private input file");
        if (
          digestOf(
            readOwnerFile(stableEntry(runDirectory, finalLeaf), "the private input file")
          ) !== input.requestSha256
        ) {
          throw new PrivateInputError(
            "hash_mismatch",
            "the private input final file no longer matches its indexed digest"
          );
        }
        return;
      }
      discardExactEntries(input, row, rootDirectory, runDirectory, finalLeaf, tempLeaf);
      throw new PrivateInputError(
        "hash_mismatch",
        "the indexed temporary private input does not match the admitted digest; the run is left incomplete"
      );
    }

    if (tempLeaf === undefined) {
      throw new PrivateInputError(
        "state_mismatch",
        "a preparing private input is missing its indexed temporary key"
      );
    }
    input.onCustodyBoundary?.("before_temp_create");
    assertStableOwnerDirectory(rootDirectory);
    assertStableOwnerDirectory(runDirectory);
    const temporaryEntry = stableEntry(runDirectory, tempLeaf);
    const descriptor = openSync(temporaryEntry, "wx", 0o600);
    let written = 0;
    try {
      // Creation mode is umask-filtered; normalize through the already-open
      // descriptor rather than reopening the pathname.
      fchmodSync(descriptor, 0o600);
      while (written < bytes.length) {
        written += writeSync(descriptor, bytes, written, bytes.length - written);
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    assertOwnerFile(temporaryEntry, "the private input temporary file");
    input.onCustodyBoundary?.("before_temp_rename");
    assertStableOwnerDirectory(rootDirectory);
    assertStableOwnerDirectory(runDirectory);
    renameSync(temporaryEntry, stableEntry(runDirectory, finalLeaf));
    fsyncStableDirectory(runDirectory);
    assertStableOwnerDirectory(runDirectory);
    input.checkpointer.privateInputActivate(row.private_input_id);
    assertOwnerFile(stableEntry(runDirectory, finalLeaf), "the private input file");
    if (
      digestOf(readOwnerFile(stableEntry(runDirectory, finalLeaf), "the private input file")) !==
      input.requestSha256
    ) {
      throw new PrivateInputError(
        "hash_mismatch",
        "the private input final file no longer matches its indexed digest"
      );
    }
  } finally {
    if (runDirectory !== undefined) closeStableOwnerDirectory(runDirectory);
    closeStableOwnerDirectory(rootDirectory);
  }
}

function discardExactEntries(
  input: MaterializeInput,
  row: NonNullable<ReturnType<Checkpointer["getPrivateInput"]>>,
  rootDirectory: StableOwnerDirectory,
  runDirectory: StableOwnerDirectory,
  finalLeaf: string,
  tempLeaf: string | undefined
): void {
  input.checkpointer.privateInputBeginDiscarding(row.private_input_id, "preparing");
  input.onCustodyBoundary?.("before_exact_unlink");
  assertStableOwnerDirectory(rootDirectory);
  assertStableOwnerDirectory(runDirectory);
  for (const leaf of [tempLeaf, finalLeaf]) {
    if (leaf === undefined) continue;
    try {
      unlinkSync(stableEntry(runDirectory, leaf));
    } catch (error) {
      if (!errorHasCode(error, "ENOENT")) throw error;
    }
  }
  fsyncStableDirectory(runDirectory);
  assertStableOwnerDirectory(runDirectory);
  input.checkpointer.privateInputFinishDiscarded(row.private_input_id);
}

/**
 * Read the run's private input back for the one host step that needs the
 * request values. Requires `active`; re-verifies custody and the indexed
 * digest on the way. Returns the parsed value as-is — the caller performs the
 * closed-schema validation for its action (e.g. `QueryKbRequest`).
 */
export function readRunInput(input: {
  readonly projectRoot: string;
  readonly checkpointer: Checkpointer;
  readonly runId: string;
}): unknown {
  const root = privateInputRoot(input.projectRoot);
  const row = requirePrivateInputRow(input.checkpointer, input.runId);
  if (row.state !== "active" && row.state !== "terminal") {
    throw new PrivateInputError(
      "read_refused",
      `the private input of run '${input.runId}' is '${row.state}', not active; materialize it first`
    );
  }
  const { runLeaf, finalLeaf } = storageLeaves(row);
  const rootDirectory = openStableOwnerDirectory(root, "the private input root");
  let runDirectory: StableOwnerDirectory | undefined;
  try {
    runDirectory = openStableOwnerDirectory(
      stableEntry(rootDirectory, runLeaf),
      "the private input run directory",
      path.join(rootDirectory.canonicalPath, runLeaf)
    );
    assertStableOwnerDirectory(rootDirectory);
    assertOwnerFile(stableEntry(runDirectory, finalLeaf), "the private input file");
    const stored = readOwnerFile(stableEntry(runDirectory, finalLeaf), "the private input file");
    assertStableOwnerDirectory(runDirectory);
    if (digestOf(stored) !== row.request_sha256) {
      throw new PrivateInputError(
        "hash_mismatch",
        "the private input no longer matches its indexed digest"
      );
    }
    try {
      const value: unknown = JSON.parse(stored.toString("utf8"));
      return value;
    } catch {
      throw new PrivateInputError("hash_mismatch", "the private input is not valid JSON");
    }
  } finally {
    if (runDirectory !== undefined) closeStableOwnerDirectory(runDirectory);
    closeStableOwnerDirectory(rootDirectory);
  }
}

/**
 * Settle a run's private input at terminal: `active → terminal → discarding →
 * (exact-key removal + fsync) → discarded`. Restart-safe: every step is an
 * exact CAS, so a host crash mid-sequence resumes the sequence on the next
 * settle. Runs the host never admitted (no index row) are untouched.
 */
export function verifyAndSettleTerminalStart(input: {
  readonly projectRoot: string;
  readonly checkpointer: Checkpointer;
  readonly run: RunContext;
}): Record<string, unknown> | undefined {
  const terminal = input.run.terminalDirective;
  if (
    terminal === null ||
    (terminal.action !== "complete" &&
      terminal.action !== "incomplete" &&
      terminal.action !== "error" &&
      terminal.action !== "cancelled")
  ) {
    return undefined;
  }
  const result: Record<string, unknown> = terminal.result;
  const admission = input.checkpointer.getStartAdmission(input.run.identity.run_id);
  if (admission === undefined) return result;
  const storedTerminal = input.checkpointer.terminalResult(input.run.identity.run_id);
  const resultSha = storedTerminal?.result_sha256 ?? sha256(canonicalJson(result));
  const resultId =
    storedTerminal?.terminal_result_id ??
    `trm_${sha256(canonicalJson({ run_id: input.run.identity.run_id, result_sha256: resultSha }))}`;
  if (admission.state === "running") {
    input.checkpointer.settleStartAdmission(input.run.identity.run_id, {
      terminal_result_id: resultId,
      terminal_result_sha256: resultSha,
    });
  } else if (
    admission.terminal_result_sha256 !== resultSha ||
    (storedTerminal !== undefined && admission.terminal_result_id !== resultId)
  ) {
    // Legacy callers predate TerminalResultRecordV1 and historically supplied
    // an independent opaque result id; preserve that compatibility while the
    // new receipt-bound record requires exact id + digest equality.
    throw new PrivateInputError(
      "hash_mismatch",
      "the terminal replay does not match its admitted result digest"
    );
  }
  // Also resumes the crash window after the admission became terminal but
  // before the private bytes reached discarded.
  settleRunInput({
    projectRoot: input.projectRoot,
    checkpointer: input.checkpointer,
    runId: input.run.identity.run_id,
  });
  return result;
}

export function settleRunInput(input: {
  readonly projectRoot: string;
  readonly checkpointer: Checkpointer;
  readonly runId: string;
  /** Deterministic race-injection seam for custody regression tests. */
  readonly onCustodyBoundary?: (boundary: PrivateInputCustodyBoundary) => void;
}): void {
  const root = privateInputRoot(input.projectRoot);
  let row = input.checkpointer.getPrivateInput(input.runId);
  if (row === undefined || row.state === "discarded") return;
  if (row.state === "active") {
    input.checkpointer.privateInputBeginTerminal(row.private_input_id);
    row = input.checkpointer.getPrivateInput(input.runId);
    if (row === undefined) return;
  }
  if (row.state === "terminal") {
    input.checkpointer.privateInputBeginDiscarding(row.private_input_id, "terminal");
  } else if (row.state === "preparing") {
    input.checkpointer.privateInputBeginDiscarding(row.private_input_id, "preparing");
  }

  const { runLeaf, finalLeaf, tempLeaf } = storageLeaves(row);
  const rootDirectory = openStableOwnerDirectory(root, "the private input root");
  let runDirectory: StableOwnerDirectory | undefined;
  try {
    if (!entryExistsNoFollow(rootDirectory, runLeaf)) {
      fsyncStableDirectory(rootDirectory);
      input.checkpointer.privateInputFinishDiscarded(row.private_input_id);
      return;
    }
    runDirectory = openStableOwnerDirectory(
      stableEntry(rootDirectory, runLeaf),
      "the private input run directory",
      path.join(rootDirectory.canonicalPath, runLeaf)
    );
    assertStableOwnerDirectory(rootDirectory);
    input.onCustodyBoundary?.("before_exact_unlink");
    assertStableOwnerDirectory(rootDirectory);
    assertStableOwnerDirectory(runDirectory);
    for (const leaf of [tempLeaf, finalLeaf]) {
      if (leaf === undefined) continue;
      try {
        unlinkSync(stableEntry(runDirectory, leaf));
      } catch (error) {
        if (!errorHasCode(error, "ENOENT")) throw error;
      }
    }
    fsyncStableDirectory(runDirectory);
    assertStableOwnerDirectory(runDirectory);
    // Keep the now-empty indexed directory as a custody tombstone. Node does
    // not expose inode-conditioned rmdir/unlinkat; a pathname rmdir after the
    // identity check would recreate the very swap race this module excludes.
    input.checkpointer.privateInputFinishDiscarded(row.private_input_id);
  } finally {
    if (runDirectory !== undefined) closeStableOwnerDirectory(runDirectory);
    closeStableOwnerDirectory(rootDirectory);
  }
}
