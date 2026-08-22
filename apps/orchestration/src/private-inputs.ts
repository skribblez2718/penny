/**
 * Durable private-input custody (§5.6) — the owner-only lifecycle of the bytes
 * that a start action's closed request carries (query text, titles, filters …).
 *
 * ## The split
 *
 * The CONTROL DATABASE (the checkpointer) indexes the input BEFORE its bytes
 * exist: one `preparing` record with host-preallocated exact final/temporary
 * keys, committed in the same transaction as the durable run row and the
 * idempotency record. This module owns only the BYTES under the trusted input
 * root `$PROJECT_ROOT/.penny/orchestration-inputs/` and performs the CAS that
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
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import type { Checkpointer } from "./checkpointer.js";
import { canonicalJson, sha256 } from "./checkpointer.js";
import type { RunContext } from "./context.js";

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

/** The trusted input root: ignored, owner-only, never a model-visible argument. */
export function privateInputRoot(projectRoot: string): string {
  return path.join(projectRoot, ".penny", "orchestration-inputs");
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
  if ((stat.mode & 0o077) !== 0) {
    throw new PrivateInputError("custody_refused", `${what} must be owner-only (0600)`);
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
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
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

function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best effort on the way out
    }
  }
}

function digestOf(bytes: Buffer): string {
  return sha256(bytes);
}

function indexedPath(root: string, key: string, label: string): string {
  if (path.isAbsolute(key) || key.includes("\\")) {
    throw new PrivateInputError("custody_refused", `${label} is not a safe relative key`);
  }
  const segments = key.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0 || segment === "..")
  ) {
    throw new PrivateInputError("custody_refused", `${label} is not an exact two-segment key`);
  }
  const candidate = path.resolve(root, ...segments);
  const boundary = `${path.resolve(root)}${path.sep}`;
  if (!candidate.startsWith(boundary)) {
    throw new PrivateInputError("custody_refused", `${label} escapes the private input root`);
  }
  return candidate;
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

export interface MaterializeInput {
  readonly projectRoot: string;
  readonly checkpointer: Checkpointer;
  readonly runId: string;
  /** The exact closed request (validated); its JCS bytes are what gets stored. */
  readonly request: unknown;
  /** The digest bound by the admission row; must cover the same bytes. */
  readonly requestSha256: string;
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
  if (row.state === "active") {
    const finalPath = indexedPath(root, row.storage_key, "the private input storage key");
    assertOwnerDirectory(root, "the private input root");
    assertOwnerDirectory(path.dirname(finalPath), "the private input run directory");
    assertOwnerFile(finalPath, "the private input file");
    if (digestOf(readOwnerFile(finalPath, "the private input file")) !== input.requestSha256) {
      throw new PrivateInputError(
        "hash_mismatch",
        "the active private input no longer matches its indexed digest"
      );
    }
    return; // idempotent
  }
  if (row.state === "terminal" || row.state === "discarding" || row.state === "discarded") {
    throw new PrivateInputError(
      "state_mismatch",
      `the private input of run '${input.runId}' is already ${row.state}; it cannot be re-materialized`
    );
  }

  // state === "preparing" — the index exists; the bytes (or part of them) may not.
  const runDir = path.dirname(indexedPath(root, row.storage_key, "the private input storage key"));
  const trustedParent = path.dirname(root);
  assertOwnerDirectory(trustedParent, "the private input parent directory");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  assertOwnerDirectory(root, "the private input root");
  if (!existsSync(runDir)) mkdirSync(runDir, { mode: 0o700 });
  assertOwnerDirectory(runDir, "the private input run directory");
  const finalPath = indexedPath(root, row.storage_key, "the private input storage key");
  const tempPath =
    row.temporary_storage_key !== undefined
      ? indexedPath(root, row.temporary_storage_key, "the private input temporary key")
      : undefined;

  // A crash after rename but before the active CAS leaves the exact final file.
  // It is adoptable only when custody and digest match and no temp also exists.
  if (existsSync(finalPath)) {
    let adoptable = false;
    try {
      assertOwnerFile(finalPath, "the private input file");
      adoptable =
        digestOf(readOwnerFile(finalPath, "the private input file")) === input.requestSha256;
    } catch {
      adoptable = false;
    }
    if (adoptable && (tempPath === undefined || !existsSync(tempPath))) {
      input.checkpointer.privateInputActivate(row.private_input_id);
      return;
    }
    discardExactKeys(input, row, { runDir, finalPath, tempPath });
    throw new PrivateInputError(
      "hash_mismatch",
      "the indexed final private input is mismatched or ambiguous; the run is left incomplete"
    );
  }

  // If the run directory holds a file at the EXACT indexed temp key, the
  // indexed digest decides: matching bytes are adopted through the exact
  // rename; anything else (foreign bytes, wrong owner/mode, a symlink) is
  // refused, its exact indexed keys are discarded, and the run is left
  // incomplete. An ABSENT temp is the normal fresh-crash window: write fresh.
  if (tempPath !== undefined && existsSync(tempPath)) {
    let adoptable = false;
    try {
      assertOwnerFile(tempPath, "the private input temporary file");
      adoptable =
        digestOf(readOwnerFile(tempPath, "the private input temporary file")) ===
        input.requestSha256;
    } catch {
      adoptable = false; // wrong owner/mode or a symlink — never adopt
    }
    if (adoptable) {
      renameSync(tempPath, finalPath);
      chmodSync(finalPath, 0o600);
      fsyncDirectory(runDir);
      input.checkpointer.privateInputActivate(row.private_input_id);
      assertOwnerFile(finalPath, "the private input file");
      if (digestOf(readOwnerFile(finalPath, "the private input file")) !== input.requestSha256) {
        throw new PrivateInputError(
          "hash_mismatch",
          "the private input final file no longer matches its indexed digest"
        );
      }
      return;
    }
    discardExactKeys(input, row, { runDir, finalPath, tempPath });
    throw new PrivateInputError(
      "hash_mismatch",
      "the indexed temporary private input does not match the admitted digest; the run is left incomplete"
    );
  }

  // No indexed temp survived (crash before the temp write): write fresh at
  // that exact preallocated key. An alternate temp would be an unindexed
  // private byte after a crash.
  if (tempPath === undefined) {
    throw new PrivateInputError(
      "state_mismatch",
      "a preparing private input is missing its indexed temporary key"
    );
  }
  const tmpPath = tempPath;
  const fd = openSync(tmpPath, "wx", 0o600);
  let written = 0;
  try {
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best effort
    }
  }
  chmodSync(tmpPath, 0o600);
  assertOwnerFile(tmpPath, "the private input temporary file");
  renameSync(tmpPath, finalPath);
  chmodSync(finalPath, 0o600);
  fsyncDirectory(runDir);
  input.checkpointer.privateInputActivate(row.private_input_id);
  assertOwnerFile(finalPath, "the private input file");
  if (digestOf(readOwnerFile(finalPath, "the private input file")) !== input.requestSha256) {
    throw new PrivateInputError(
      "hash_mismatch",
      "the private input final file no longer matches its indexed digest"
    );
  }
}

/**
 * Drive the row `preparing → discarding → discarded`, removing ONLY the exact
 * indexed keys and fsyncing the parent before the row leaves `discarding`.
 */
function discardExactKeys(
  input: MaterializeInput,
  row: NonNullable<ReturnType<Checkpointer["getPrivateInput"]>>,
  keys: { runDir: string; finalPath: string; tempPath: string | undefined }
): void {
  input.checkpointer.privateInputBeginDiscarding(row.private_input_id, "preparing");
  for (const exact of [keys.tempPath, keys.finalPath]) {
    if (exact === undefined) continue;
    try {
      unlinkSync(exact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (existsSync(keys.runDir)) fsyncDirectory(keys.runDir);
  try {
    rmdirSync(keys.runDir); // only succeeds once empty; the root itself stays
  } catch {
    // not empty or already gone — exact-key removal above is the contract
  }
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
  const runDir = path.dirname(indexedPath(root, row.storage_key, "the private input storage key"));
  assertOwnerDirectory(root, "the private input root");
  assertOwnerDirectory(runDir, "the private input run directory");
  const finalPath = indexedPath(root, row.storage_key, "the private input storage key");
  assertOwnerFile(finalPath, "the private input file");
  const stored = readOwnerFile(finalPath, "the private input file");
  if (digestOf(stored) !== row.request_sha256) {
    throw new PrivateInputError(
      "hash_mismatch",
      "the private input no longer matches its indexed digest"
    );
  }
  try {
    return JSON.parse(stored.toString("utf8")) as unknown;
  } catch {
    throw new PrivateInputError("hash_mismatch", "the private input is not valid JSON");
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
  const result = terminal.result as Record<string, unknown>;
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
}): void {
  const root = privateInputRoot(input.projectRoot);
  let row = input.checkpointer.getPrivateInput(input.runId);
  if (row === undefined) {
    return;
  }
  if (row.state === "discarded") {
    return; // idempotent
  }
  if (row.state === "active") {
    input.checkpointer.privateInputBeginTerminal(row.private_input_id);
    row = input.checkpointer.getPrivateInput(input.runId);
    if (row === undefined) return;
  }
  const runDir = path.dirname(indexedPath(root, row.storage_key, "the private input storage key"));
  const finalPath = indexedPath(root, row.storage_key, "the private input storage key");
  const tempPath =
    row.temporary_storage_key !== undefined
      ? indexedPath(root, row.temporary_storage_key, "the private input temporary key")
      : undefined;
  if (row.state === "terminal") {
    input.checkpointer.privateInputBeginDiscarding(row.private_input_id, "terminal");
  } else if (row.state === "preparing") {
    // Never became active (crash window): the run is left incomplete. Discard
    // only the exact indexed keys; keep the metadata.
    input.checkpointer.privateInputBeginDiscarding(row.private_input_id, "preparing");
  }
  // else: already `discarding` (a crashed settle resumes here).
  for (const exact of [tempPath, finalPath]) {
    if (exact === undefined) continue;
    try {
      unlinkSync(exact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (existsSync(runDir)) {
    fsyncDirectory(runDir);
  }
  try {
    rmdirSync(runDir);
  } catch {
    // not empty or already gone
  }
  input.checkpointer.privateInputFinishDiscarded(row.private_input_id);
}
