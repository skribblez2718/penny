import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import type { Checkpointer } from "../checkpointer.js";
import {
  createRawPromotionKeyFile,
  generatePromotionKeyId,
  jcsCanonicalize,
  openPinnedDirectoryNoFollow,
  parsePromotionReceipt,
  pinnedDirectoryChildPath,
  promotionSha256,
  readRawPromotionKeyFile,
  receiptJcs,
  receiptSignedJcs,
  signPromotionReceipt,
  strictParseJson,
  verifyPromotionReceiptSignature,
  PromotionApprovalError,
} from "./approval-receipts.js";
import { CapabilityStore, envelopeDigest } from "./capabilities.js";
import {
  ParsedPromotionApprovalReceiptV1Schema,
  PromotionApplyJournalSchema,
  PromotionApplyOutcomeV1Schema,
  PromotionApprovalStoreEnvelopeV1Schema,
  PromotionApprovalStoreRecordV1Schema,
  PromotionControlApprovalBindingV1Schema,
  PromotionDecisionIntentSchema,
  PromotionDecisionOutcomeV1Schema,
  PromotionGateDecisionRecordSchema,
  PromotionGatePacketSchema,
  PromotionGateStoreEnvelopeV1Schema,
  PromotionGateStoreRecordV1Schema,
  PromotionPatchArtifactSchema,
  PromotionPlanArtifactSchema,
  PromotionVerificationSchema,
  validateKbContract,
  type ParsedPromotionApprovalReceiptV1,
  type PromotionApplyJournal,
  type PromotionApplyOutcomeV1,
  type PromotionApprovalReceipt,
  type PromotionApprovalStoreEnvelopeV1,
  type PromotionControlApprovalBindingV1,
  type PromotionDecisionIntent,
  type PromotionDecisionOutcomeV1,
  type PromotionGatePacket,
  type PromotionGateStoreEnvelopeV1,
  type PromotionPatchArtifact,
  type Sha256Hex,
} from "./contracts.js";
import { readManifest } from "./filesystem.js";
import { readSelectedGeneration } from "./generations.js";
import { loadEnvelope } from "./gate.js";
import { RunArtifactStore, type ArtifactHandle } from "./run-artifacts.js";

const APPROVAL_DIRECTORY_MODE = 0o700;
const APPROVAL_FILE_MODE = 0o600;
const DEFAULT_GATE_TTL_MS = 30 * 60_000;
const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;
const MAX_TARGET_BYTES = 1_048_576;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const MUTEX_ROW_ID = 1;
const TERMINAL_JOURNAL_STATES = new Set(["complete", "failed", "blocked_external_drift"]);

interface GateRow extends Record<string, SQLOutputValue> {
  challenge_id: string;
  run_id: string;
  session_id: string;
  packet_sha256: string;
  packet_jcs: string;
  state: string;
  decision_intent_jcs: string | null;
  decision_intent_sha256: string | null;
  decision_record_jcs: string | null;
  decision_or_receipt_id: string | null;
  transaction_id: string;
  updated_at: string;
}

interface ReceiptRow extends Record<string, SQLOutputValue> {
  receipt_id: string;
  challenge_id: string;
  receipt_sha256: string;
  receipt_jcs: string;
  signed_jcs: string;
  key_id: string;
  state: string;
  transaction_id: string | null;
  updated_at: string;
}

interface JournalRow extends Record<string, SQLOutputValue> {
  transaction_id: string;
  run_id: string;
  receipt_id: string;
  journal_jcs: string;
  state: string;
  updated_at: string;
}

export type PromotionGateStoreRecord = PromotionGateStoreEnvelopeV1;
export type PromotionApprovalStoreRecord = PromotionApprovalStoreEnvelopeV1;
export type PromotionDecisionOutcome = PromotionDecisionOutcomeV1;
export type PromotionApplyOutcome = PromotionApplyOutcomeV1;

/** Exact path/body-free metadata copied from the approval decision into control state. */
export type PromotionControlApprovalBinding = PromotionControlApprovalBindingV1;

export type PromotionFaultHook = (boundary: string) => void;

/** Test-only crash signal: unlike an owned exception it deliberately skips restore. */
export class PromotionSimulatedCrash extends Error {
  constructor(readonly boundary: string) {
    super(`simulated promotion crash at '${boundary}'`);
    this.name = "PromotionSimulatedCrash";
  }
}

export function approvalRootFor(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".penny", "kb-approval");
}

function sqliteModule(): typeof import("node:sqlite") {
  const module = process.getBuiltinModule("node:" + "sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (module === undefined) throw new PromotionApprovalError("Node.js runtime lacks node:sqlite");
  return module;
}

function currentUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function pathExistsNoFollow(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertDirectoryDescriptor(descriptor: number, label: string, requiredMode?: number): void {
  const stat = fstatSync(descriptor);
  if (!stat.isDirectory()) throw new PromotionApprovalError(`${label} must be a directory`);
  if (requiredMode !== undefined && (stat.mode & 0o7777) !== requiredMode) {
    throw new PromotionApprovalError(`${label} mode must be exactly 0700`);
  }
  if (currentUid() !== undefined && stat.uid !== currentUid()) {
    throw new PromotionApprovalError(`${label} has the wrong owner`);
  }
}

function openChildDirectory(
  parentDescriptor: number,
  child: string,
  label: string,
  create: boolean
): number {
  const childPath = pinnedDirectoryChildPath(parentDescriptor, child);
  let created = false;
  if (!pathExistsNoFollow(childPath)) {
    if (!create) throw new PromotionApprovalError(`${label} is absent`);
    try {
      mkdirSync(childPath, { mode: APPROVAL_DIRECTORY_MODE });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      childPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch (error) {
    throw new PromotionApprovalError(
      `${label} rejected a symlink or non-directory component: ${String(error)}`
    );
  }
  try {
    if (created) {
      fchmodSync(descriptor, APPROVAL_DIRECTORY_MODE);
      fsyncSync(descriptor);
      fsyncSync(parentDescriptor);
    }
    assertDirectoryDescriptor(descriptor, label, APPROVAL_DIRECTORY_MODE);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openApprovalRoot(input: { projectRoot: string; create: boolean }): {
  descriptor: number;
  identity: { dev: bigint | number; ino: bigint | number };
} {
  const projectDescriptor = openPinnedDirectoryNoFollow(input.projectRoot);
  try {
    assertDirectoryDescriptor(projectDescriptor, "promotion project root");
    const pennyDescriptor = openChildDirectory(
      projectDescriptor,
      ".penny",
      "promotion .penny ancestor",
      input.create
    );
    try {
      const approvalDescriptor = openChildDirectory(
        pennyDescriptor,
        "kb-approval",
        "promotion approval root",
        input.create
      );
      const stat = fstatSync(approvalDescriptor);
      return {
        descriptor: approvalDescriptor,
        identity: { dev: stat.dev, ino: stat.ino },
      };
    } finally {
      closeSync(pennyDescriptor);
    }
  } finally {
    closeSync(projectDescriptor);
  }
}

function openSecureRegularFileAt(
  parentDescriptor: number,
  child: string,
  label: string,
  expectedMode = APPROVAL_FILE_MODE
): number {
  const filePath = pinnedDirectoryChildPath(parentDescriptor, child);
  const before = lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new PromotionApprovalError(`${label} must be a regular non-symlink single-link file`);
  }
  if ((before.mode & 0o7777) !== expectedMode) {
    throw new PromotionApprovalError(
      `${label} mode must be exactly ${expectedMode.toString(8).padStart(4, "0")}`
    );
  }
  if (currentUid() !== undefined && before.uid !== currentUid()) {
    throw new PromotionApprovalError(`${label} has the wrong owner`);
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (
    !opened.isFile() ||
    opened.nlink !== 1 ||
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    (opened.mode & 0o7777) !== expectedMode ||
    opened.uid !== before.uid
  ) {
    closeSync(descriptor);
    throw new PromotionApprovalError(`${label} changed while it was opened`);
  }
  return descriptor;
}

function createSecureEmptyFileAt(parentDescriptor: number, child: string): void {
  const descriptor = openSync(
    pinnedDirectoryChildPath(parentDescriptor, child),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    APPROVAL_FILE_MODE
  );
  try {
    fchmodSync(descriptor, APPROVAL_FILE_MODE);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncSync(parentDescriptor);
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameJson(left: unknown, right: unknown): boolean {
  return jcsCanonicalize(left) === jcsCanonicalize(right);
}

function assertSortedUnique(values: readonly string[], label: string): void {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new PromotionApprovalError(`${label} must be non-empty and unique`);
  }
  for (let index = 1; index < values.length; index += 1) {
    if (bytewiseCompare(values[index - 1]!, values[index]!) >= 0) {
      throw new PromotionApprovalError(`${label} must be sorted by UTF-8 byte order`);
    }
  }
}

function assertSortedPageRevisions(packet: PromotionGatePacket): void {
  const keys = packet.page_revisions.map((item) => `${item.page_id}\u0000${item.revision_id}`);
  assertSortedUnique(keys, "promotion page revisions");
}

function safeIso(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new PromotionApprovalError("invalid promotion time");
  return date.toISOString();
}

function readUtf8FileAt(
  parentDescriptor: number,
  child: string,
  allowedLinkCounts: readonly number[] = [1]
): {
  bytes: Buffer;
  mode: number;
  sha256: Sha256Hex;
  dev: bigint | number;
  ino: bigint | number;
} {
  const targetPath = pinnedDirectoryChildPath(parentDescriptor, child);
  const before = lstatSync(targetPath);
  if (!before.isFile() || before.isSymbolicLink() || !allowedLinkCounts.includes(before.nlink)) {
    throw new PromotionApprovalError(
      "canonical target must be an existing regular file with an admitted link count"
    );
  }
  if (currentUid() !== undefined && before.uid !== currentUid()) {
    throw new PromotionApprovalError("canonical target is not owned by the current user");
  }
  const descriptor = openSync(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      !allowedLinkCounts.includes(opened.nlink) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid
    ) {
      throw new PromotionApprovalError("canonical target changed while it was opened");
    }
    if (opened.size > MAX_TARGET_BYTES) {
      throw new PromotionApprovalError("canonical target exceeds the v1 byte limit");
    }
    const bytes = readFileSync(descriptor);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new PromotionApprovalError("canonical target is not strict UTF-8");
    }
    return {
      bytes,
      mode: opened.mode & 0o7777,
      sha256: promotionSha256(bytes),
      dev: opened.dev,
      ino: opened.ino,
    };
  } finally {
    closeSync(descriptor);
  }
}

function readUtf8Target(filePath: string): { bytes: Buffer; mode: number; sha256: Sha256Hex } {
  const parentDescriptor = openPinnedDirectoryNoFollow(path.dirname(filePath));
  try {
    return readUtf8FileAt(parentDescriptor, path.basename(filePath));
  } finally {
    closeSync(parentDescriptor);
  }
}

function assertContainedTarget(target: string, authorityRoot: string): string {
  const root = path.resolve(authorityRoot);
  const resolved = path.resolve(target);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new PromotionApprovalError("canonical target escapes its authority root");
  }
  return resolved;
}

interface NoClobberReplaceInput {
  target: string;
  bytes: Buffer;
  mode: number;
  expectedCurrentSha256: Sha256Hex;
  expectedCurrentMode: number;
  transactionId: string;
  ordinal: number;
  purpose: "postimage" | "restore";
  beforeCommit?: () => void;
  hit?: (boundary: string) => void;
}

function noClobberStageName(input: NoClobberReplaceInput): string {
  const targetTag = promotionSha256(path.basename(input.target)).slice(0, 16);
  return `.penny-promote-${input.transactionId}-${input.ordinal}-${input.purpose}-${targetTag}`;
}

function recoverNoClobberStageAt(
  parentDescriptor: number,
  input: NoClobberReplaceInput
): "absent" | "completed" {
  const targetName = path.basename(input.target);
  const targetPath = pinnedDirectoryChildPath(parentDescriptor, targetName);
  const stageName = noClobberStageName(input);
  const stagePath = pinnedDirectoryChildPath(parentDescriptor, stageName);
  if (!pathExistsNoFollow(stagePath)) return "absent";

  const stageDescriptor = openSync(
    stagePath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  let stageOpen = true;
  const cleanup = (): void => {
    if (stageOpen) {
      fsyncSync(stageDescriptor);
      closeSync(stageDescriptor);
      stageOpen = false;
    }
    rmSync(stagePath, { recursive: true });
    fsyncSync(parentDescriptor);
  };
  try {
    assertDirectoryDescriptor(
      stageDescriptor,
      "promotion no-clobber staging directory",
      APPROVAL_DIRECTORY_MODE
    );
    const replacementPath = pinnedDirectoryChildPath(stageDescriptor, "replacement");
    const displacedPath = pinnedDirectoryChildPath(stageDescriptor, "displaced");
    const replacementExists = pathExistsNoFollow(replacementPath);
    const displacedExists = pathExistsNoFollow(displacedPath);
    const targetExists = pathExistsNoFollow(targetPath);
    const desiredSha256 = promotionSha256(input.bytes);

    if (!displacedExists) {
      if (!targetExists) {
        throw new PromotionApprovalError(
          "promotion no-clobber stage is incomplete before target displacement"
        );
      }
      const target = readUtf8FileAt(parentDescriptor, targetName);
      if (target.sha256 === desiredSha256 && target.mode === input.mode) {
        cleanup();
        return "completed";
      }
      if (
        target.sha256 === input.expectedCurrentSha256 &&
        target.mode === input.expectedCurrentMode
      ) {
        cleanup();
        return "absent";
      }
      if (!replacementExists) {
        throw new PromotionApprovalError(
          "promotion no-clobber stage lost both owned files around a drifted target"
        );
      }
      cleanup();
      throw new PromotionApprovalError(
        "canonical target drifted while an uncommitted no-clobber stage existed"
      );
    }

    const displaced = readUtf8FileAt(stageDescriptor, "displaced", [1, 2]);
    if (!targetExists) {
      if (
        displaced.sha256 !== input.expectedCurrentSha256 ||
        displaced.mode !== input.expectedCurrentMode
      ) {
        try {
          linkSync(displacedPath, targetPath);
          unlinkSync(displacedPath);
          fsyncSync(parentDescriptor);
        } catch (error) {
          throw new PromotionApprovalError(
            `displaced third-party target remains preserved in staging: ${String(error)}`
          );
        }
        cleanup();
        throw new PromotionApprovalError(
          "canonical target drifted during no-clobber displacement and was restored"
        );
      }
      if (!replacementExists) {
        throw new PromotionApprovalError(
          "promotion no-clobber stage lost its replacement after displacement"
        );
      }
      const replacement = readUtf8FileAt(stageDescriptor, "replacement");
      if (replacement.sha256 !== desiredSha256 || replacement.mode !== input.mode) {
        throw new PromotionApprovalError(
          "promotion no-clobber staged replacement failed custody verification"
        );
      }
      linkSync(replacementPath, targetPath);
      unlinkSync(replacementPath);
      fsyncSync(parentDescriptor);
      const installed = readUtf8FileAt(parentDescriptor, targetName);
      if (installed.sha256 !== desiredSha256 || installed.mode !== input.mode) {
        throw new PromotionApprovalError(
          "recovered no-clobber replacement failed postimage verification"
        );
      }
      unlinkSync(displacedPath);
      cleanup();
      return "completed";
    }

    const target = readUtf8FileAt(parentDescriptor, targetName, [1, 2]);
    if (target.sha256 === desiredSha256 && target.mode === input.mode) {
      if (replacementExists) {
        const replacement = readUtf8FileAt(stageDescriptor, "replacement", [1, 2]);
        if (replacement.sha256 !== desiredSha256 || replacement.mode !== input.mode) {
          throw new PromotionApprovalError(
            "promotion no-clobber replacement link conflicts with installed bytes"
          );
        }
        unlinkSync(replacementPath);
      }
      if (pathExistsNoFollow(displacedPath)) unlinkSync(displacedPath);
      cleanup();
      return "completed";
    }
    if (
      target.sha256 === input.expectedCurrentSha256 &&
      target.mode === input.expectedCurrentMode
    ) {
      if (replacementExists) unlinkSync(replacementPath);
      if (pathExistsNoFollow(displacedPath)) unlinkSync(displacedPath);
      cleanup();
      return "absent";
    }
    throw new PromotionApprovalError(
      "canonical target is occupied by third-party drift; staged owned bytes were preserved"
    );
  } finally {
    if (stageOpen) closeSync(stageDescriptor);
  }
}

function recoverNoClobberStage(input: NoClobberReplaceInput): "absent" | "completed" {
  const parentDescriptor = openPinnedDirectoryNoFollow(path.dirname(input.target));
  try {
    return recoverNoClobberStageAt(parentDescriptor, input);
  } finally {
    closeSync(parentDescriptor);
  }
}

function noClobberReplaceExisting(input: NoClobberReplaceInput): void {
  const parentDescriptor = openPinnedDirectoryNoFollow(path.dirname(input.target));
  const targetName = path.basename(input.target);
  const targetPath = pinnedDirectoryChildPath(parentDescriptor, targetName);
  const stageName = noClobberStageName(input);
  const stageDirectoryPath = pinnedDirectoryChildPath(parentDescriptor, stageName);
  let preserveStage = false;
  let stageDescriptor: number | undefined;
  try {
    if (recoverNoClobberStageAt(parentDescriptor, input) === "completed") return;
    mkdirSync(stageDirectoryPath, { mode: APPROVAL_DIRECTORY_MODE });
    stageDescriptor = openSync(
      stageDirectoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    fchmodSync(stageDescriptor, APPROVAL_DIRECTORY_MODE);
    const stagedPath = pinnedDirectoryChildPath(stageDescriptor, "replacement");
    const displacedPath = pinnedDirectoryChildPath(stageDescriptor, "displaced");
    const descriptor = openSync(
      stagedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      input.mode
    );
    try {
      writeFileSync(descriptor, input.bytes);
      fchmodSync(descriptor, input.mode);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncSync(stageDescriptor);

    const checked = readUtf8FileAt(parentDescriptor, targetName);
    if (
      checked.sha256 !== input.expectedCurrentSha256 ||
      checked.mode !== input.expectedCurrentMode
    ) {
      throw new PromotionApprovalError(
        "canonical target bytes or mode drifted before no-clobber replacement"
      );
    }
    input.beforeCommit?.();

    renameSync(targetPath, displacedPath);
    input.hit?.(`after_target_displaced_${input.ordinal}_${input.purpose}`);
    const displaced = readUtf8FileAt(stageDescriptor, "displaced");
    if (
      displaced.sha256 !== input.expectedCurrentSha256 ||
      displaced.mode !== input.expectedCurrentMode
    ) {
      try {
        linkSync(displacedPath, targetPath);
        unlinkSync(displacedPath);
        fsyncSync(parentDescriptor);
      } catch (restoreError) {
        preserveStage = true;
        throw new PromotionApprovalError(
          `canonical target drift was preserved in private staging because its name was concurrently occupied: ${String(restoreError)}`
        );
      }
      throw new PromotionApprovalError(
        "canonical target drifted between check and commit; third-party bytes were not overwritten"
      );
    }

    try {
      linkSync(stagedPath, targetPath);
      input.hit?.(`after_target_linked_${input.ordinal}_${input.purpose}`);
    } catch (error) {
      if (error instanceof PromotionSimulatedCrash) {
        preserveStage = true;
        throw error;
      }
      try {
        linkSync(displacedPath, targetPath);
        unlinkSync(displacedPath);
        fsyncSync(parentDescriptor);
      } catch (restoreError) {
        preserveStage = true;
        throw new PromotionApprovalError(
          `canonical target was concurrently occupied; owned preimage remains in private staging: ${String(restoreError)}`
        );
      }
      throw new PromotionApprovalError(
        `canonical target was concurrently recreated; refusing to overwrite it: ${String(error)}`
      );
    }
    unlinkSync(stagedPath);
    fsyncSync(parentDescriptor);
    const installed = readUtf8FileAt(parentDescriptor, targetName);
    if (installed.sha256 !== promotionSha256(input.bytes) || installed.mode !== input.mode) {
      preserveStage = true;
      throw new PromotionApprovalError("canonical replacement postimage or mode did not verify");
    }
    unlinkSync(displacedPath);
    fsyncSync(stageDescriptor);
    closeSync(stageDescriptor);
    stageDescriptor = undefined;
    rmSync(stageDirectoryPath, { recursive: true });
    fsyncSync(parentDescriptor);
  } catch (error) {
    if (error instanceof PromotionSimulatedCrash) preserveStage = true;
    if (stageDescriptor !== undefined) closeSync(stageDescriptor);
    if (!preserveStage && pathExistsNoFollow(stageDirectoryPath)) {
      rmSync(stageDirectoryPath, { recursive: true, force: true });
      fsyncSync(parentDescriptor);
    }
    throw error;
  } finally {
    closeSync(parentDescriptor);
  }
}

function targetPathForPacket(packet: PromotionGatePacket, capabilityId: string): string {
  const index = packet.target_capability_ids.indexOf(capabilityId);
  const presentation = packet.target_presentations[index];
  if (index < 0 || presentation === undefined) {
    throw new PromotionApprovalError("journal target is outside the stored promotion packet");
  }
  return presentation.canonical_target;
}

function validatePatchCrossFields(
  patch: PromotionPatchArtifact,
  packetOrIds: Pick<PromotionGatePacket, "target_capability_ids" | "preimage_digests">
): void {
  const ids = patch.targets.map((target) => target.target_capability_id);
  if (!sameJson(ids, packetOrIds.target_capability_ids)) {
    throw new PromotionApprovalError("promotion patch target order/set does not match the packet");
  }
  for (const target of patch.targets) {
    if (target.preimage_sha256 !== packetOrIds.preimage_digests[target.target_capability_id]) {
      throw new PromotionApprovalError(
        "promotion patch preimage does not match the target capability"
      );
    }
    if (promotionSha256(Buffer.from(target.replacement_utf8, "utf8")) !== target.postimage_sha256) {
      throw new PromotionApprovalError(
        "promotion patch postimage digest does not match replacement_utf8"
      );
    }
  }
}

export class PromotionApprovalStore implements Disposable {
  readonly projectRoot: string;
  readonly kbRoot: string;
  readonly root: string;
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly fault: PromotionFaultHook | undefined;
  private readonly controlBindingForRun:
    | ((runId: string) => PromotionControlApprovalBinding | undefined)
    | undefined;
  private readonly artifactCheckpointer: Checkpointer | undefined;
  private readonly reserveApplyOperation:
    | ((input: {
        runId: string;
        sessionId: string;
        receiptSha256: Sha256Hex;
        transactionId: string;
      }) => void)
    | undefined;
  private readonly rootDescriptor: number;
  private readonly rootIdentity: { dev: bigint | number; ino: bigint | number };
  private readonly databaseIdentity: { dev: bigint | number; ino: bigint | number };
  private readonly mutexDescriptor: number;
  private readonly mutexIdentity: { dev: bigint | number; ino: bigint | number };

  constructor(input: {
    projectRoot: string;
    kbRoot: string;
    now?: () => Date;
    fault?: PromotionFaultHook;
    artifactCheckpointer?: Checkpointer;
    controlBindingForRun?: (runId: string) => PromotionControlApprovalBinding | undefined;
    /** Called after receipt+journal claim is durable and before effectful apply work. */
    reserveApplyOperation?: (input: {
      runId: string;
      sessionId: string;
      receiptSha256: Sha256Hex;
      transactionId: string;
    }) => void;
  }) {
    this.projectRoot = path.resolve(input.projectRoot);
    this.kbRoot = path.resolve(input.kbRoot);
    this.root = approvalRootFor(this.projectRoot);
    this.now = input.now ?? (() => new Date());
    this.fault = input.fault;
    this.artifactCheckpointer = input.artifactCheckpointer;
    this.controlBindingForRun = input.controlBindingForRun;
    this.reserveApplyOperation = input.reserveApplyOperation;
    const approvalRoot = openApprovalRoot({ projectRoot: this.projectRoot, create: true });
    this.rootDescriptor = approvalRoot.descriptor;
    this.rootIdentity = approvalRoot.identity;

    const databaseRef = pinnedDirectoryChildPath(this.rootDescriptor, "receipts.sqlite");
    const databaseExisted = pathExistsNoFollow(databaseRef);
    if (!databaseExisted) createSecureEmptyFileAt(this.rootDescriptor, "receipts.sqlite");
    const databaseDescriptor = openSecureRegularFileAt(
      this.rootDescriptor,
      "receipts.sqlite",
      "promotion receipt database"
    );
    const databaseStat = fstatSync(databaseDescriptor);
    this.databaseIdentity = { dev: databaseStat.dev, ino: databaseStat.ino };
    closeSync(databaseDescriptor);

    const mutexRef = pinnedDirectoryChildPath(this.rootDescriptor, "promotion-apply.mutex");
    if (!pathExistsNoFollow(mutexRef)) {
      createSecureEmptyFileAt(this.rootDescriptor, "promotion-apply.mutex");
    }
    this.mutexDescriptor = openSecureRegularFileAt(
      this.rootDescriptor,
      "promotion-apply.mutex",
      "promotion apply mutex"
    );
    const mutexStat = fstatSync(this.mutexDescriptor);
    this.mutexIdentity = { dev: mutexStat.dev, ino: mutexStat.ino };
    fsyncSync(this.rootDescriptor);

    const sidecarExisted = new Map(
      ["-wal", "-shm"].map((suffix) => [
        suffix,
        pathExistsNoFollow(
          pinnedDirectoryChildPath(this.rootDescriptor, `receipts.sqlite${suffix}`)
        ),
      ])
    );
    const { DatabaseSync } = sqliteModule();
    this.db = new DatabaseSync(databaseRef);
    this.db.exec(
      `PRAGMA journal_mode=WAL;
       PRAGMA synchronous=FULL;
       PRAGMA foreign_keys=ON;
       PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};`
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signing_keys (
        key_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('active', 'verification_only')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_promotion_key
        ON signing_keys(state) WHERE state = 'active';
      CREATE TABLE IF NOT EXISTS promotion_gates (
        challenge_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        packet_sha256 TEXT NOT NULL,
        packet_jcs TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'awaiting','claimed','approved','refined','denied','invalidated','expired'
        )),
        decision_intent_jcs TEXT,
        decision_intent_sha256 TEXT,
        decision_record_jcs TEXT,
        decision_or_receipt_id TEXT,
        transaction_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, challenge_id, transaction_id)
      );
      CREATE TABLE IF NOT EXISTS promotion_receipts (
        receipt_id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL UNIQUE REFERENCES promotion_gates(challenge_id),
        receipt_sha256 TEXT NOT NULL UNIQUE,
        receipt_jcs TEXT NOT NULL,
        signed_jcs TEXT NOT NULL,
        key_id TEXT NOT NULL REFERENCES signing_keys(key_id),
        state TEXT NOT NULL CHECK(state IN (
          'available','claimed','apply_reserved','consumed','invalidated','expired'
        )),
        transaction_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS apply_journals (
        transaction_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL UNIQUE REFERENCES promotion_receipts(receipt_id),
        journal_jcs TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'claimed','capturing','applying','verifying','restoring',
          'complete','failed','blocked_external_drift'
        )),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS apply_mutex (
        mutex_id INTEGER PRIMARY KEY CHECK(mutex_id = 1),
        transaction_id TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO apply_mutex(mutex_id, transaction_id, updated_at)
        VALUES (1, NULL, '1970-01-01T00:00:00.000Z');
    `);
    for (const suffix of ["", "-wal", "-shm"]) {
      const child = `receipts.sqlite${suffix}`;
      const file = pinnedDirectoryChildPath(this.rootDescriptor, child);
      if (!pathExistsNoFollow(file)) continue;
      const existed = suffix === "" ? databaseExisted : sidecarExisted.get(suffix) === true;
      if (!existed) {
        const createdDescriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fchmodSync(createdDescriptor, APPROVAL_FILE_MODE);
          fsyncSync(createdDescriptor);
        } finally {
          closeSync(createdDescriptor);
        }
      }
      const descriptor = openSecureRegularFileAt(
        this.rootDescriptor,
        child,
        `promotion receipt database${suffix}`
      );
      closeSync(descriptor);
    }
    this.assertCustody();
  }

  rotateKey(keyId = generatePromotionKeyId()): string {
    createRawPromotionKeyFile(this.root, keyId);
    fsyncSync(this.rootDescriptor);
    const timestamp = safeIso(this.now());
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE signing_keys SET state = 'verification_only', updated_at = ? WHERE state = 'active'"
        )
        .run(timestamp);
      this.db
        .prepare(
          "INSERT INTO signing_keys(key_id, state, created_at, updated_at) VALUES (?, 'active', ?, ?)"
        )
        .run(keyId, timestamp, timestamp);
    });
    return keyId;
  }

  keyStates(): Array<{ key_id: string; state: "active" | "verification_only" }> {
    this.assertCustody();
    return (
      this.db
        .prepare("SELECT key_id, state FROM signing_keys ORDER BY created_at, key_id")
        .all() as Array<Record<string, SQLOutputValue>>
    ).map((row) => ({
      key_id: String(row.key_id),
      state: String(row.state) as "active" | "verification_only",
    }));
  }

  storePreparedGate(input: {
    runId: string;
    sessionId: string;
    challengeId: string;
    profileId: string;
    pageRevisions: readonly { page_id: string; revision_id: string }[];
    targetCapabilityIds: readonly string[];
    planArtifactId: string;
    patchArtifactId: string;
    verificationArtifactId: string;
    ttlMs?: number;
  }): PromotionGateStoreRecord {
    const pageRevisions = input.pageRevisions.map((item) => ({ ...item }));
    const targetIds = [...input.targetCapabilityIds];
    const pageKeys = pageRevisions.map((item) => `${item.page_id}\u0000${item.revision_id}`);
    assertSortedUnique(pageKeys, "promotion page revisions");
    assertSortedUnique(targetIds, "promotion target capability IDs");

    using artifacts = new RunArtifactStore(this.kbRoot, input.runId, this.artifactControl());
    const planRead = artifacts.read(input.planArtifactId);
    const patchRead = artifacts.read(input.patchArtifactId);
    const verificationRead = artifacts.read(input.verificationArtifactId);
    this.assertSealedArtifact(artifacts, "plan", planRead.handle);
    this.assertSealedArtifact(artifacts, "patch", patchRead.handle);
    this.assertSealedArtifact(artifacts, "promotion_verification", verificationRead.handle);
    if (
      planRead.handle.artifact_kind !== "promotion_plan" ||
      patchRead.handle.artifact_kind !== "promotion_patch" ||
      verificationRead.handle.artifact_kind !== "verification_report"
    ) {
      throw new PromotionApprovalError(
        "promotion gate artifact kinds are not plan/patch/verification"
      );
    }
    const plan = validateKbContract(
      PromotionPlanArtifactSchema,
      strictParseJson(planRead.content),
      "promotion plan artifact"
    );
    const patch = validateKbContract(
      PromotionPatchArtifactSchema,
      strictParseJson(patchRead.content),
      "promotion patch artifact"
    );
    const verification = validateKbContract(
      PromotionVerificationSchema,
      strictParseJson(verificationRead.content),
      "promotion verification artifact"
    );
    for (const [label, content, value, handle] of [
      ["plan", planRead.content, plan, planRead.handle],
      ["patch", patchRead.content, patch, patchRead.handle],
      ["verification", verificationRead.content, verification, verificationRead.handle],
    ] as const) {
      const canonical = jcsCanonicalize(value);
      if (content !== canonical || promotionSha256(canonical) !== handle.sha256) {
        throw new PromotionApprovalError(`promotion ${label} artifact is not stored as exact JCS`);
      }
    }
    if (!sameJson(plan.page_revisions, pageRevisions)) {
      throw new PromotionApprovalError("promotion plan page revisions do not match the request");
    }
    if (!sameJson(plan.target_capability_ids, targetIds)) {
      throw new PromotionApprovalError("promotion plan targets do not match the request");
    }
    if (!sameJson(verification.page_revisions, pageRevisions)) {
      throw new PromotionApprovalError(
        "promotion verification page revisions do not match the request"
      );
    }
    const selected = readSelectedGeneration(this.kbRoot);
    if (selected === undefined) {
      throw new PromotionApprovalError("promotion packet requires one selected generation");
    }
    for (const revision of pageRevisions) {
      if (selected.catalog.pages[revision.page_id]?.revision_id !== revision.revision_id) {
        throw new PromotionApprovalError("promotion page revision is no longer selected");
      }
    }

    const capabilityStore = new CapabilityStore(this.projectRoot);
    const presentations: PromotionGatePacket["target_presentations"] = [];
    const preimages: Record<string, Sha256Hex> = Object.create(null) as Record<string, Sha256Hex>;
    let earliestCapabilityExpiry = Number.POSITIVE_INFINITY;
    try {
      for (const [ordinal, capabilityId] of targetIds.entries()) {
        const lease = capabilityStore.lease(capabilityId);
        if (lease?.state !== "claimed" || lease.run_id !== input.runId) {
          throw new PromotionApprovalError(
            `canonical target capability '${capabilityId}' is not claimed by this run`
          );
        }
        const envelope = loadEnvelope(this.projectRoot, capabilityId);
        if (
          envelopeDigest(envelope) !== lease.envelope_sha256 ||
          envelope.kind !== "canonical_target" ||
          envelope.allowed_operation !== "promote" ||
          envelope.kb_profile_id !== input.profileId ||
          envelope.session_id !== input.sessionId ||
          envelope.authority_root === undefined
        ) {
          throw new PromotionApprovalError(
            `canonical target capability '${capabilityId}' has the wrong authority binding`
          );
        }
        const target = assertContainedTarget(envelope.resolved_path, envelope.authority_root);
        const current = readUtf8Target(target);
        if (current.sha256 !== envelope.expected_sha256) {
          throw new PromotionApprovalError(`canonical target '${capabilityId}' preimage drifted`);
        }
        const finding = verification.targets[ordinal];
        if (
          finding === undefined ||
          finding.capability_id !== capabilityId ||
          finding.preimage_sha256 !== current.sha256
        ) {
          throw new PromotionApprovalError(
            `promotion verification target '${capabilityId}' does not match the live presentation`
          );
        }
        presentations.push({
          target_capability_id: capabilityId,
          canonical_target: target,
          preimage_sha256: current.sha256,
        });
        preimages[capabilityId] = current.sha256;
        earliestCapabilityExpiry = Math.min(
          earliestCapabilityExpiry,
          new Date(envelope.expires_at).getTime()
        );
      }
    } finally {
      capabilityStore.close();
    }
    validatePatchCrossFields(patch, {
      target_capability_ids: targetIds,
      preimage_digests: preimages,
    });

    const issued = this.now();
    const configuredExpiry = issued.getTime() + (input.ttlMs ?? DEFAULT_GATE_TTL_MS);
    const expiresAt = new Date(Math.min(configuredExpiry, earliestCapabilityExpiry));
    if (expiresAt.getTime() <= issued.getTime()) {
      throw new PromotionApprovalError("promotion gate or target authority is already expired");
    }
    const verificationEvidence: PromotionGatePacket["verification_evidence"] = [
      {
        evidence_id: verificationRead.handle.artifact_id,
        kind: "artifact",
        ref: verificationRead.handle.artifact_id,
        sha256: verificationRead.handle.sha256,
      },
    ];
    const packet = validateKbContract(
      PromotionGatePacketSchema,
      {
        schema_version: 1,
        run_id: input.runId,
        session_id: input.sessionId,
        challenge_id: input.challengeId,
        kb_profile_id: input.profileId,
        kb_id: readManifest(this.kbRoot, selected.catalog.manifest_sha256).kb_id,
        page_revisions: pageRevisions,
        target_capability_ids: targetIds,
        target_presentations: presentations,
        preimage_digests: preimages,
        plan_artifact: planRead.handle,
        patch_artifact: patchRead.handle,
        verification_artifact: verificationRead.handle,
        patch_digest: patchRead.handle.sha256,
        verification_evidence: verificationEvidence,
        verification_evidence_digest: promotionSha256(jcsCanonicalize(verificationEvidence)),
        issued_at: safeIso(issued),
        expires_at: safeIso(expiresAt),
      },
      "promotion gate packet"
    );
    this.validatePacketCrossFields(packet);
    const packetJcs = jcsCanonicalize(packet);
    const packetSha256 = promotionSha256(packetJcs);
    const transactionId = `tx_gate_${randomUUID().replace(/-/g, "")}`;
    const timestamp = safeIso(this.now());
    this.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM promotion_gates WHERE challenge_id = ?")
        .get(packet.challenge_id) as GateRow | undefined;
      if (existing !== undefined) {
        if (
          String(existing.packet_jcs) !== packetJcs ||
          String(existing.packet_sha256) !== packetSha256 ||
          String(existing.run_id) !== packet.run_id
        ) {
          throw new PromotionApprovalError(
            "promotion challenge conflicts with stored packet bytes"
          );
        }
        return;
      }
      this.db
        .prepare(
          `INSERT INTO promotion_gates(
            challenge_id, run_id, session_id, packet_sha256, packet_jcs,
            state, transaction_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'awaiting', ?, ?)`
        )
        .run(
          packet.challenge_id,
          packet.run_id,
          packet.session_id,
          packetSha256,
          packetJcs,
          transactionId,
          timestamp
        );
    });
    return this.gate(packet.challenge_id)!;
  }

  gate(challengeId: string): PromotionGateStoreRecord | undefined {
    this.assertCustody();
    const row = this.db
      .prepare("SELECT * FROM promotion_gates WHERE challenge_id = ?")
      .get(challengeId) as GateRow | undefined;
    return row === undefined ? undefined : this.gateRecord(row);
  }

  gateForRun(runId: string): PromotionGateStoreRecord | undefined {
    this.assertCustody();
    const row = this.db
      .prepare("SELECT * FROM promotion_gates WHERE run_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(runId) as GateRow | undefined;
    return row === undefined ? undefined : this.gateRecord(row);
  }

  listGates(profileId?: string): PromotionGateStoreRecord[] {
    this.assertCustody();
    const rows = this.db.prepare("SELECT * FROM promotion_gates ORDER BY rowid").all() as GateRow[];
    return rows
      .map((row) => this.gateRecord(row))
      .filter((record) => profileId === undefined || record.packet.kb_profile_id === profileId);
  }

  buildDecisionIntent(input: {
    challengeId: string;
    decision: "approve" | "refine" | "deny";
    reviewerSubjectId: string;
    ttlMs?: number;
  }): PromotionDecisionIntent {
    const gate = this.gate(input.challengeId);
    if (gate === undefined) throw new PromotionApprovalError("unknown promotion challenge");
    const decided = this.now();
    const intent = {
      schema_version: 1 as const,
      decision_id: `decision_${randomUUID().replace(/-/g, "")}`,
      decision: input.decision,
      challenge_id: gate.challenge_id,
      packet_sha256: gate.packet_sha256,
      reviewer_subject_id: input.reviewerSubjectId,
      decided_at: safeIso(decided),
      ...(input.decision === "approve"
        ? {
            approval_nonce: `nonce_${randomBytes(18).toString("base64url")}`,
            approval_expires_at: safeIso(
              new Date(
                Math.min(
                  decided.getTime() + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS),
                  new Date(gate.packet.expires_at).getTime()
                )
              )
            ),
          }
        : {}),
    };
    return this.validateDecisionIntent(intent);
  }

  decide(intentInput: PromotionDecisionIntent): PromotionDecisionOutcome {
    const intent = this.validateDecisionIntent(intentInput);
    const intentJcs = jcsCanonicalize(intent);
    const intentSha256 = promotionSha256(intentJcs);
    const gate = this.gate(intent.challenge_id);
    if (gate === undefined) throw new PromotionApprovalError("unknown promotion challenge");
    if (gate.packet_sha256 !== intent.packet_sha256) {
      throw new PromotionApprovalError("promotion decision intent packet digest mismatch");
    }
    if (
      intent.decision === "approve" &&
      new Date(intent.approval_expires_at!).getTime() > new Date(gate.packet.expires_at).getTime()
    ) {
      throw new PromotionApprovalError("approve intent expiry outlives the stored gate packet");
    }
    if (gate.decision_intent_sha256 !== undefined) {
      if (gate.decision_intent_sha256 !== intentSha256) {
        throw new PromotionApprovalError(
          "promotion challenge already has a different decision intent"
        );
      }
      return this.finishClaimedDecision(gate.challenge_id);
    }
    if (gate.state !== "awaiting") {
      throw new PromotionApprovalError(`promotion challenge is '${gate.state}', not awaiting`);
    }
    const nowMs = this.now().getTime();
    if (new Date(gate.packet.expires_at).getTime() <= nowMs) {
      this.expireGate(gate.challenge_id);
      throw new PromotionApprovalError("promotion gate packet expired before decision");
    }
    this.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE promotion_gates
           SET state = 'claimed', decision_intent_jcs = ?, decision_intent_sha256 = ?, updated_at = ?
           WHERE challenge_id = ? AND state = 'awaiting'`
        )
        .run(intentJcs, intentSha256, safeIso(this.now()), gate.challenge_id);
      if (Number(changed.changes) !== 1) {
        throw new PromotionApprovalError("lost promotion decision claim race");
      }
    });
    this.hit("after_decision_intent");
    return this.finishClaimedDecision(gate.challenge_id);
  }

  parseAndVerifyReceipt(raw: string | Uint8Array): ParsedPromotionApprovalReceiptV1 {
    this.assertCustody();
    const receipt = parsePromotionReceipt(raw);
    const keyRow = this.db
      .prepare("SELECT state FROM signing_keys WHERE key_id = ?")
      .get(receipt.key_id) as { state: string } | undefined;
    if (
      keyRow === undefined ||
      (keyRow.state !== "active" && keyRow.state !== "verification_only")
    ) {
      throw new PromotionApprovalError("promotion approval receipt names an unknown key_id");
    }
    const key = readRawPromotionKeyFile(this.root, receipt.key_id);
    verifyPromotionReceiptSignature(receipt, key);
    const canonical = receiptJcs(receipt);
    return validateKbContract(
      ParsedPromotionApprovalReceiptV1Schema,
      { receipt, receipt_jcs: canonical, receipt_sha256: promotionSha256(canonical) },
      "parsed promotion approval receipt"
    );
  }

  receipt(receiptId: string): PromotionApprovalStoreRecord | undefined {
    this.assertCustody();
    const row = this.db
      .prepare("SELECT * FROM promotion_receipts WHERE receipt_id = ?")
      .get(receiptId) as ReceiptRow | undefined;
    return row === undefined ? undefined : this.receiptRecord(row);
  }

  receiptForRun(runId: string): PromotionApprovalStoreRecord | undefined {
    this.assertCustody();
    const row = this.db
      .prepare(
        `SELECT r.* FROM promotion_receipts r
         JOIN promotion_gates g ON g.challenge_id = r.challenge_id
         WHERE g.run_id = ? ORDER BY r.rowid DESC LIMIT 1`
      )
      .get(runId) as ReceiptRow | undefined;
    return row === undefined ? undefined : this.receiptRecord(row);
  }

  /** The sole internal apply entry: validates and atomically claims one signed receipt. */
  resumeApprovedPromotion(rawReceipt: string | Uint8Array): PromotionApplyOutcome {
    const verified = this.parseAndVerifyReceipt(rawReceipt);
    const stored = this.receipt(verified.receipt.receipt_id);
    if (
      stored === undefined ||
      stored.receipt_sha256 !== verified.receipt_sha256 ||
      stored.receipt_jcs !== verified.receipt_jcs
    ) {
      throw new PromotionApprovalError(
        "promotion approval receipt is not the exact stored receipt"
      );
    }
    const approvedGate = this.gate(verified.receipt.challenge_id);
    if (approvedGate === undefined) {
      throw new PromotionApprovalError("promotion approval receipt lost its gate");
    }
    this.validateReceiptPacketBinding(verified.receipt, approvedGate);
    this.requireControlApprovalBinding(verified.receipt, approvedGate, verified.receipt_sha256);
    if (stored.state !== "available") {
      throw new PromotionApprovalError(
        `promotion approval receipt is '${stored.state}', not available`
      );
    }
    if (new Date(verified.receipt.expires_at).getTime() <= this.now().getTime()) {
      return this.terminalizeApprovalBeforeClaim(verified, "expired");
    }
    try {
      this.revalidateReceiptBindings(verified.receipt, false);
    } catch (error) {
      if (error instanceof PromotionSimulatedCrash) throw error;
      return this.terminalizeApprovalBeforeClaim(verified, "invalidated");
    }
    const transactionId = `tx_apply_${randomUUID().replace(/-/g, "")}`;
    const packet = this.gate(verified.receipt.challenge_id)!.packet;
    const patch = this.readPatch(packet);
    const timestamp = safeIso(this.now());
    const journal = validateKbContract(
      PromotionApplyJournalSchema,
      {
        schema_version: 1,
        transaction_id: transactionId,
        run_id: verified.receipt.run_id,
        receipt_id: verified.receipt.receipt_id,
        receipt_sha256: verified.receipt_sha256,
        patch_artifact_id: packet.patch_artifact.artifact_id,
        state: "claimed",
        targets: patch.targets.map((target, ordinal) => ({
          ordinal,
          target_capability_id: target.target_capability_id,
          preimage_sha256: target.preimage_sha256,
          postimage_sha256: target.postimage_sha256,
          preimage_mode: readUtf8Target(targetPathForPacket(packet, target.target_capability_id))
            .mode,
          preimage_storage_key: path.posix.join(
            "work",
            verified.receipt.run_id,
            "promotion",
            transactionId,
            "preimages",
            String(ordinal)
          ),
          state: "pending",
        })),
        post_apply_verified: false,
        created_at: timestamp,
        updated_at: timestamp,
      },
      "promotion apply journal"
    );
    this.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE promotion_receipts
           SET state = 'claimed', transaction_id = ?, updated_at = ?
           WHERE receipt_id = ? AND state = 'available'`
        )
        .run(transactionId, timestamp, verified.receipt.receipt_id);
      if (Number(changed.changes) !== 1) {
        throw new PromotionApprovalError("lost promotion receipt claim race");
      }
      this.db
        .prepare(
          `INSERT INTO apply_journals(
            transaction_id, run_id, receipt_id, journal_jcs, state, updated_at
          ) VALUES (?, ?, ?, ?, 'claimed', ?)`
        )
        .run(
          transactionId,
          journal.run_id,
          journal.receipt_id,
          jcsCanonicalize(journal),
          timestamp
        );
    });
    this.reserveApplyOperation?.({
      runId: verified.receipt.run_id,
      sessionId: verified.receipt.session_id,
      receiptSha256: verified.receipt_sha256,
      transactionId,
    });
    this.hit("after_apply_operation_reserved");
    this.hit("after_apply_claim");
    return this.runApply(transactionId);
  }

  /**
   * Reconcile every approval-store state for one control-approved run. This is
   * the host restart entry, including expiry/drift terminalized before a journal
   * could exist.
   */
  reconcileApprovedPromotion(runId: string): PromotionApplyOutcome {
    const receipt = this.receiptForRun(runId);
    if (receipt === undefined) {
      throw new PromotionApprovalError("promotion run has no approval receipt");
    }
    if (receipt.state === "available") {
      return this.resumeApprovedPromotion(receipt.receipt_jcs);
    }
    if (receipt.transaction_id === undefined) {
      throw new PromotionApprovalError(
        `promotion receipt '${receipt.state}' has no recovery transaction`
      );
    }
    const journal = this.journal(receipt.transaction_id);
    if (journal !== undefined) return this.recoverApply(receipt.transaction_id);
    if (receipt.state === "expired" || receipt.state === "invalidated") {
      return this.recoverApprovalBeforeClaim(receipt);
    }
    throw new PromotionApprovalError(
      `promotion receipt/journal split cannot recover from '${receipt.state}'`
    );
  }

  /** Restart entry for the one journal-owning transaction; no receipt replay is accepted. */
  recoverApply(transactionId: string): PromotionApplyOutcome {
    const found = this.journal(transactionId);
    if (found === undefined)
      throw new PromotionApprovalError("unknown promotion apply transaction");
    this.ensureApplyOperationReserved(found);
    const journal = this.repairJournalReceiptSplit(found);
    if (journal.state === "complete") return this.finalizeSuccessfulApply(journal);
    if (journal.state === "failed" || journal.state === "blocked_external_drift") {
      return this.finalizeFailedApply(journal);
    }
    return this.runApply(transactionId);
  }

  journal(transactionId: string): PromotionApplyJournal | undefined {
    this.assertCustody();
    const row = this.db
      .prepare("SELECT * FROM apply_journals WHERE transaction_id = ?")
      .get(transactionId) as JournalRow | undefined;
    if (row === undefined) return undefined;
    const parsed = validateKbContract(
      PromotionApplyJournalSchema,
      strictParseJson(String(row.journal_jcs)),
      "promotion apply journal"
    );
    if (jcsCanonicalize(parsed) !== String(row.journal_jcs) || parsed.state !== String(row.state)) {
      throw new PromotionApprovalError("promotion apply journal row/JCS mismatch");
    }
    return parsed;
  }

  invalidateOrphanedGate(challengeId: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE promotion_gates SET state = 'invalidated', updated_at = ?
           WHERE challenge_id = ? AND state = 'awaiting'`
        )
        .run(safeIso(this.now()), challengeId);
    });
  }

  private finishClaimedDecision(challengeId: string): PromotionDecisionOutcome {
    const gate = this.gate(challengeId);
    if (gate === undefined || gate.decision_intent === undefined) {
      throw new PromotionApprovalError("claimed promotion decision lost its durable intent");
    }
    if (gate.state !== "claimed") {
      return this.decisionOutcome(gate);
    }
    const intent = gate.decision_intent;
    if (intent.decision === "approve") {
      if (intent.approval_nonce === undefined || intent.approval_expires_at === undefined) {
        throw new PromotionApprovalError("approve intent is missing nonce/expiry");
      }
      this.revalidatePacketForApproval(gate.packet);
      const keyRow = this.db
        .prepare("SELECT key_id FROM signing_keys WHERE state = 'active'")
        .get() as { key_id: string } | undefined;
      if (keyRow === undefined) {
        throw new PromotionApprovalError("no active promotion approval key; rotate a key first");
      }
      const receiptId = `receipt_${intent.decision_id}`;
      const unsigned: Omit<PromotionApprovalReceipt, "signature"> = {
        schema_version: 1,
        receipt_id: receiptId,
        decision: "approve",
        run_id: gate.packet.run_id,
        session_id: gate.packet.session_id,
        challenge_id: gate.packet.challenge_id,
        kb_profile_id: gate.packet.kb_profile_id,
        kb_id: gate.packet.kb_id,
        gate_packet_sha256: gate.packet_sha256,
        page_revisions: gate.packet.page_revisions,
        target_capability_ids: gate.packet.target_capability_ids,
        canonical_targets: gate.packet.target_presentations.map((item) => item.canonical_target),
        preimage_digests: gate.packet.preimage_digests,
        patch_digest: gate.packet.patch_digest,
        verification_evidence_digest: gate.packet.verification_evidence_digest,
        approver_subject_id: intent.reviewer_subject_id,
        issued_at: intent.decided_at,
        expires_at: intent.approval_expires_at,
        nonce: intent.approval_nonce,
        key_id: keyRow.key_id,
      };
      const key = readRawPromotionKeyFile(this.root, keyRow.key_id);
      const receipt = signPromotionReceipt(unsigned, key);
      this.validateReceiptPacketBinding(receipt, gate);
      const completeJcs = receiptJcs(receipt);
      const completeSha = promotionSha256(completeJcs);
      const signedJcs = receiptSignedJcs(receipt);
      this.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO promotion_receipts(
              receipt_id, challenge_id, receipt_sha256, receipt_jcs, signed_jcs,
              key_id, state, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'available', ?)`
          )
          .run(
            receipt.receipt_id,
            receipt.challenge_id,
            completeSha,
            completeJcs,
            signedJcs,
            receipt.key_id,
            safeIso(this.now())
          );
        const changed = this.db
          .prepare(
            `UPDATE promotion_gates
             SET state = 'approved', decision_or_receipt_id = ?, updated_at = ?
             WHERE challenge_id = ? AND state = 'claimed' AND decision_intent_sha256 = ?`
          )
          .run(
            receipt.receipt_id,
            safeIso(this.now()),
            gate.challenge_id,
            gate.decision_intent_sha256!
          );
        if (Number(changed.changes) !== 1) {
          throw new PromotionApprovalError("lost promotion approval finalization race");
        }
      });
      return this.decisionOutcome(this.gate(challengeId)!);
    }

    const decisionRecord = validateKbContract(
      PromotionGateDecisionRecordSchema,
      {
        schema_version: 1,
        decision_id: intent.decision_id,
        decision: intent.decision,
        challenge_id: intent.challenge_id,
        packet_sha256: intent.packet_sha256,
        reviewer_subject_id: intent.reviewer_subject_id,
        decided_at: intent.decided_at,
      },
      "promotion gate decision record"
    );
    const decisionJcs = jcsCanonicalize(decisionRecord);
    this.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE promotion_gates
           SET state = ?, decision_record_jcs = ?, decision_or_receipt_id = ?, updated_at = ?
           WHERE challenge_id = ? AND state = 'claimed' AND decision_intent_sha256 = ?`
        )
        .run(
          intent.decision === "refine" ? "refined" : "denied",
          decisionJcs,
          decisionRecord.decision_id,
          safeIso(this.now()),
          gate.challenge_id,
          gate.decision_intent_sha256!
        );
      if (Number(changed.changes) !== 1) {
        throw new PromotionApprovalError("lost promotion decision finalization race");
      }
    });
    return this.decisionOutcome(this.gate(challengeId)!);
  }

  private decisionOutcome(gate: PromotionGateStoreRecord): PromotionDecisionOutcome {
    if (gate.state === "approved") {
      const receiptRecord = this.receipt(gate.decision_or_receipt_id ?? "");
      if (receiptRecord === undefined) {
        throw new PromotionApprovalError("approved promotion gate has no stored receipt");
      }
      const parsed = this.parseAndVerifyReceipt(receiptRecord.receipt_jcs);
      if (parsed.receipt_sha256 !== receiptRecord.receipt_sha256) {
        throw new PromotionApprovalError("stored promotion receipt digest mismatch");
      }
      this.validateReceiptPacketBinding(parsed.receipt, gate);
      return validateKbContract(
        PromotionDecisionOutcomeV1Schema,
        {
          gate,
          receipt: parsed.receipt,
          receipt_jcs: parsed.receipt_jcs,
          receipt_sha256: parsed.receipt_sha256,
        },
        "promotion approval decision outcome"
      );
    }
    return validateKbContract(
      PromotionDecisionOutcomeV1Schema,
      {
        gate,
        ...(gate.decision_record !== undefined ? { decision_record: gate.decision_record } : {}),
      },
      "promotion non-approval decision outcome"
    );
  }

  private ensureApplyOperationReserved(journal: PromotionApplyJournal): void {
    if (this.reserveApplyOperation === undefined) return;
    const receiptRecord = this.receipt(journal.receipt_id);
    if (
      receiptRecord === undefined ||
      receiptRecord.receipt_sha256 !== journal.receipt_sha256 ||
      receiptRecord.transaction_id !== journal.transaction_id
    ) {
      throw new PromotionApprovalError(
        "promotion apply journal cannot reserve an operation group without its exact receipt"
      );
    }
    const verified = this.parseAndVerifyReceipt(receiptRecord.receipt_jcs);
    this.reserveApplyOperation({
      runId: journal.run_id,
      sessionId: verified.receipt.session_id,
      receiptSha256: receiptRecord.receipt_sha256,
      transactionId: journal.transaction_id,
    });
  }

  private repairJournalReceiptSplit(journal: PromotionApplyJournal): PromotionApplyJournal {
    const receiptRecord = this.receipt(journal.receipt_id);
    if (
      receiptRecord === undefined ||
      receiptRecord.transaction_id !== journal.transaction_id ||
      receiptRecord.receipt_sha256 !== journal.receipt_sha256
    ) {
      throw new PromotionApprovalError("promotion journal/receipt ownership split is invalid");
    }
    const verified = this.parseAndVerifyReceipt(receiptRecord.receipt_jcs);
    const gate = this.gate(verified.receipt.challenge_id);
    if (gate === undefined) throw new PromotionApprovalError("promotion journal lost its gate");
    this.validateReceiptPacketBinding(verified.receipt, gate);
    this.requireControlApprovalBinding(verified.receipt, gate, receiptRecord.receipt_sha256);

    const terminalJournal = TERMINAL_JOURNAL_STATES.has(journal.state);
    if (terminalJournal) {
      const expectedReceipt = journal.state === "complete" ? "consumed" : "invalidated";
      if (receiptRecord.state === expectedReceipt) return journal;
      if (
        (expectedReceipt === "consumed" && receiptRecord.state !== "apply_reserved") ||
        (expectedReceipt === "invalidated" &&
          receiptRecord.state !== "claimed" &&
          receiptRecord.state !== "apply_reserved")
      ) {
        throw new PromotionApprovalError(
          "terminal promotion journal conflicts with terminal receipt authority"
        );
      }
      this.transaction(() => {
        const changed = this.db
          .prepare(
            `UPDATE promotion_receipts SET state = ?, updated_at = ?
             WHERE receipt_id = ? AND transaction_id = ? AND state = ?`
          )
          .run(
            expectedReceipt,
            safeIso(this.now()),
            receiptRecord.receipt_id,
            journal.transaction_id,
            receiptRecord.state
          );
        if (Number(changed.changes) !== 1) {
          throw new PromotionApprovalError("lost terminal journal/receipt repair race");
        }
      });
      return journal;
    }

    if (receiptRecord.state === "consumed") {
      for (const target of journal.targets) {
        const current = readUtf8Target(
          targetPathForPacket(gate.packet, target.target_capability_id)
        );
        if (current.sha256 !== target.postimage_sha256 || current.mode !== target.preimage_mode) {
          throw new PromotionApprovalError(
            "consumed promotion receipt cannot repair a non-postimage journal"
          );
        }
      }
      return this.updateJournal(journal, {
        state: "complete",
        post_apply_verified: true,
      });
    }
    if (receiptRecord.state === "expired") {
      throw new PromotionApprovalError("an expired pre-claim receipt cannot own an apply journal");
    }
    if (
      receiptRecord.state !== "claimed" &&
      receiptRecord.state !== "apply_reserved" &&
      receiptRecord.state !== "invalidated"
    ) {
      throw new PromotionApprovalError(
        `promotion journal cannot recover receipt state '${receiptRecord.state}'`
      );
    }
    return journal;
  }

  private runApply(transactionId: string): PromotionApplyOutcome {
    try {
      let journal = this.journalRequired(transactionId);
      const receiptRecord = this.receipt(journal.receipt_id);
      if (receiptRecord === undefined || receiptRecord.transaction_id !== transactionId) {
        throw new PromotionApprovalError("apply journal does not own its receipt claim");
      }
      const verified = this.parseAndVerifyReceipt(receiptRecord.receipt_jcs);
      const gate = this.gate(verified.receipt.challenge_id);
      if (gate === undefined)
        throw new PromotionApprovalError("apply journal lost its gate packet");
      const packet = gate.packet;
      this.requireControlApprovalBinding(verified.receipt, gate, receiptRecord.receipt_sha256);
      const patch = this.readPatch(packet);
      this.revalidateReceiptBindings(verified.receipt, receiptRecord.state === "apply_reserved");

      if (journal.state === "claimed") {
        journal = this.updateJournal(journal, { state: "capturing" });
      }
      if (journal.state === "capturing") {
        for (const targetJournal of journal.targets) {
          const preimagePath = this.preimageAbsolute(targetJournal.preimage_storage_key);
          if (targetJournal.state === "pending") {
            const target = targetPathForPacket(packet, targetJournal.target_capability_id);
            const current = readUtf8Target(target);
            if (
              current.sha256 !== targetJournal.preimage_sha256 ||
              current.mode !== targetJournal.preimage_mode
            ) {
              throw new PromotionApprovalError(
                "canonical target bytes or mode drifted before preimage capture"
              );
            }
            this.capturePreimage(preimagePath, current.bytes);
            journal = this.updateJournalTarget(journal, targetJournal.ordinal, "ready");
            this.hit(`after_preimage_${targetJournal.ordinal}`);
          } else {
            this.verifyStoredPreimage(preimagePath, targetJournal.preimage_sha256);
          }
        }
        journal = this.journalRequired(transactionId);
        if (!journal.targets.every((target) => target.state === "ready")) {
          throw new PromotionApprovalError("not every promotion preimage is ready before mutation");
        }
      }

      this.acquireMutex(transactionId);
      const currentReceipt = this.receipt(journal.receipt_id)!;
      this.requireControlApprovalBinding(verified.receipt, gate, currentReceipt.receipt_sha256);
      if (currentReceipt.state === "claimed") {
        if (new Date(verified.receipt.expires_at).getTime() <= this.now().getTime()) {
          throw new PromotionApprovalError("promotion receipt expired before apply reservation");
        }
        this.revalidateReceiptBindings(verified.receipt, false);
        for (const target of journal.targets) {
          const current = readUtf8Target(targetPathForPacket(packet, target.target_capability_id));
          if (current.sha256 !== target.preimage_sha256 || current.mode !== target.preimage_mode) {
            throw new PromotionApprovalError(
              "canonical target bytes or mode drifted immediately before reservation"
            );
          }
          this.verifyStoredPreimage(
            this.preimageAbsolute(target.preimage_storage_key),
            target.preimage_sha256
          );
        }
        this.transaction(() => {
          const changed = this.db
            .prepare(
              `UPDATE promotion_receipts
               SET state = 'apply_reserved', updated_at = ?
               WHERE receipt_id = ? AND state = 'claimed' AND transaction_id = ?`
            )
            .run(safeIso(this.now()), verified.receipt.receipt_id, transactionId);
          if (Number(changed.changes) !== 1) {
            throw new PromotionApprovalError("lost promotion receipt reservation race");
          }
          journal = this.updateJournalInTransaction(journal, { state: "applying" });
        });
        this.hit("after_receipt_reservation");
        using capabilities = new CapabilityStore(this.projectRoot);
        capabilities.reserveApplyAll(
          verified.receipt.target_capability_ids,
          verified.receipt.run_id,
          transactionId,
          safeIso(this.now())
        );
        this.hit("after_capability_reservation");
      } else if (currentReceipt.state === "apply_reserved") {
        // Crash reconciliation for the cross-store reservation boundary: the
        // receipt reservation is durable/finalize-only, so complete the exact
        // target set under the same mutex instead of expiring or reclaiming it.
        using capabilities = new CapabilityStore(this.projectRoot);
        const exact = verified.receipt.target_capability_ids.every((capabilityId) => {
          const lease = capabilities.lease(capabilityId);
          return (
            lease?.state === "apply_reserved" &&
            lease.run_id === verified.receipt.run_id &&
            lease.transaction_id === transactionId
          );
        });
        if (!exact) {
          capabilities.reserveApplyAll(
            verified.receipt.target_capability_ids,
            verified.receipt.run_id,
            transactionId,
            safeIso(this.now())
          );
        }
      } else {
        throw new PromotionApprovalError(
          `promotion receipt cannot recover apply from '${currentReceipt.state}'`
        );
      }
      this.assertCapabilityReservation(verified.receipt, transactionId);
      journal = this.journalRequired(transactionId);
      if (journal.state !== "applying" && journal.state !== "verifying") {
        throw new PromotionApprovalError(`promotion journal cannot apply from '${journal.state}'`);
      }

      if (journal.state === "applying") {
        for (const targetJournal of journal.targets) {
          const patchTarget = patch.targets[targetJournal.ordinal];
          if (patchTarget === undefined)
            throw new PromotionApprovalError("patch/journal ordinal mismatch");
          const targetPath = targetPathForPacket(packet, targetJournal.target_capability_id);
          const replacement: NoClobberReplaceInput = {
            target: targetPath,
            bytes: Buffer.from(patchTarget.replacement_utf8, "utf8"),
            mode: targetJournal.preimage_mode,
            expectedCurrentSha256: targetJournal.preimage_sha256,
            expectedCurrentMode: targetJournal.preimage_mode,
            transactionId,
            ordinal: targetJournal.ordinal,
            purpose: "postimage",
            beforeCommit: () => this.hit(`before_replace_commit_${targetJournal.ordinal}`),
            hit: (boundary) => this.hit(boundary),
          };
          recoverNoClobberStage(replacement);
          let current = readUtf8Target(targetPath);
          if (
            current.sha256 !== targetJournal.preimage_sha256 &&
            current.sha256 !== targetJournal.postimage_sha256
          ) {
            return this.restoreOrBlock(journal, packet, true);
          }
          if (current.sha256 === targetJournal.preimage_sha256) {
            noClobberReplaceExisting(replacement);
            this.hit(`after_rename_before_journal_${targetJournal.ordinal}`);
            journal = this.updateJournalTarget(journal, targetJournal.ordinal, "written");
            this.hit(`after_written_${targetJournal.ordinal}`);
          } else if (targetJournal.state !== "verified") {
            journal = this.updateJournalTarget(journal, targetJournal.ordinal, "written");
          }
          current = readUtf8Target(targetPath);
          if (
            current.sha256 !== targetJournal.postimage_sha256 ||
            current.mode !== targetJournal.preimage_mode
          ) {
            return this.restoreOrBlock(journal, packet, false);
          }
          journal = this.updateJournalTarget(journal, targetJournal.ordinal, "verified");
          this.hit(`after_verified_${targetJournal.ordinal}`);
        }
        journal = this.updateJournal(this.journalRequired(transactionId), { state: "verifying" });
      }

      this.revalidateReceiptBindings(verified.receipt, true);
      for (const target of journal.targets) {
        const current = readUtf8Target(targetPathForPacket(packet, target.target_capability_id));
        if (current.sha256 !== target.postimage_sha256 || current.mode !== target.preimage_mode) {
          return this.restoreOrBlock(journal, packet, true);
        }
      }
      journal = this.terminalizeJournalAndReceipt(journal, "complete", true, "consumed");
      this.hit("after_approval_complete");
      const outcome = this.finalizeSuccessfulApply(journal);
      this.releaseMutex(transactionId);
      return outcome;
    } catch (error) {
      if (error instanceof PromotionSimulatedCrash) throw error;
      const journal = this.journal(transactionId);
      if (journal === undefined) throw error;
      if (journal.state === "complete") {
        // Approval-store success is already mutation truth. A capability or
        // control-store error after this point is finalize-only, never restore.
        return this.finalizeSuccessfulApply(journal);
      }
      if (journal.state === "failed" || journal.state === "blocked_external_drift") {
        return this.finalizeFailedApply(journal);
      }
      return this.restoreOrBlock(journal, this.gateForJournal(journal).packet, false);
    }
  }

  private restoreOrBlock(
    inputJournal: PromotionApplyJournal,
    packet: PromotionGatePacket,
    externalDriftSeen: boolean
  ): PromotionApplyOutcome {
    let journal = inputJournal;
    if (journal.state !== "restoring") {
      journal = this.updateJournal(journal, { state: "restoring" });
    }
    let blocked = externalDriftSeen;
    for (const target of [...journal.targets].reverse()) {
      const targetPath = targetPathForPacket(packet, target.target_capability_id);
      try {
        const preimagePath = this.preimageAbsolute(target.preimage_storage_key);
        const preimage = this.readStoredPreimage(preimagePath, target.preimage_sha256);
        const restoration: NoClobberReplaceInput = {
          target: targetPath,
          bytes: preimage,
          mode: target.preimage_mode,
          expectedCurrentSha256: target.postimage_sha256,
          expectedCurrentMode: target.preimage_mode,
          transactionId: journal.transaction_id,
          ordinal: target.ordinal,
          purpose: "restore",
          beforeCommit: () => this.hit(`before_restore_commit_${target.ordinal}`),
          hit: (boundary) => this.hit(boundary),
        };
        recoverNoClobberStage(restoration);
        const current = readUtf8Target(targetPath);
        if (current.sha256 === target.postimage_sha256 && current.mode === target.preimage_mode) {
          noClobberReplaceExisting(restoration);
          const restored = readUtf8Target(targetPath);
          if (
            restored.sha256 !== target.preimage_sha256 ||
            restored.mode !== target.preimage_mode
          ) {
            blocked = true;
            continue;
          }
          journal = this.updateJournalTarget(journal, target.ordinal, "restored");
          this.hit(`after_restore_${target.ordinal}`);
        } else if (
          current.sha256 === target.preimage_sha256 &&
          current.mode === target.preimage_mode
        ) {
          journal = this.updateJournalTarget(journal, target.ordinal, "restored");
        } else {
          blocked = true;
        }
      } catch (error) {
        if (error instanceof PromotionSimulatedCrash) throw error;
        blocked = true;
      }
    }
    const terminalState = blocked ? "blocked_external_drift" : "failed";
    journal = this.terminalizeJournalAndReceipt(
      this.journalRequired(journal.transaction_id),
      terminalState,
      false,
      "invalidated"
    );
    this.hit("after_failure_approval_terminal");
    const outcome = this.finalizeFailedApply(journal);
    this.releaseMutex(journal.transaction_id);
    return outcome;
  }

  private finalizeSuccessfulApply(journal: PromotionApplyJournal): PromotionApplyOutcome {
    const gate = this.gateForJournal(journal);
    const receiptRecord = this.receipt(journal.receipt_id);
    if (receiptRecord === undefined) {
      throw new PromotionApprovalError("terminal promotion journal lost its receipt");
    }
    const verified = this.parseAndVerifyReceipt(receiptRecord.receipt_jcs);
    this.requireControlApprovalBinding(verified.receipt, gate, receiptRecord.receipt_sha256);
    for (const target of journal.targets) {
      const current = readUtf8Target(targetPathForPacket(gate.packet, target.target_capability_id));
      if (current.sha256 !== target.postimage_sha256 || current.mode !== target.preimage_mode) {
        throw new PromotionApprovalError(
          "finalize-only success found a non-postimage target or changed mode"
        );
      }
    }
    using capabilities = new CapabilityStore(this.projectRoot);
    const leases = gate.packet.target_capability_ids.map((id) => capabilities.lease(id));
    if (
      leases.every(
        (lease) => lease?.state === "consumed" && lease.transaction_id === journal.transaction_id
      )
    ) {
      // Cross-store finalization already committed.
    } else {
      capabilities.consumeApplyReservedAll(
        gate.packet.target_capability_ids,
        journal.run_id,
        journal.transaction_id,
        safeIso(this.now())
      );
      this.hit("after_capability_finalization");
    }
    return this.applyOutcome(journal, "complete");
  }

  private finalizeFailedApply(journal: PromotionApplyJournal): PromotionApplyOutcome {
    const gate = this.gateForJournal(journal);
    const receiptRecord = this.receipt(journal.receipt_id);
    if (receiptRecord === undefined) {
      throw new PromotionApprovalError("terminal promotion journal lost its receipt");
    }
    const verified = this.parseAndVerifyReceipt(receiptRecord.receipt_jcs);
    this.requireControlApprovalBinding(verified.receipt, gate, receiptRecord.receipt_sha256);
    using capabilities = new CapabilityStore(this.projectRoot);
    const leases = gate.packet.target_capability_ids.map((id) => capabilities.lease(id));
    if (
      !leases.every(
        (lease) => lease?.state === "invalidated" && lease.transaction_id === journal.transaction_id
      )
    ) {
      capabilities.invalidateApplySet(
        gate.packet.target_capability_ids,
        journal.run_id,
        journal.transaction_id,
        safeIso(this.now())
      );
    }
    this.hit("after_failure_capability_finalization");
    return this.applyOutcome(
      journal,
      journal.state === "blocked_external_drift" ? "blocked_external_drift" : "failed"
    );
  }

  private applyOutcome(
    journal: PromotionApplyJournal,
    status: PromotionApplyOutcome["status"]
  ): PromotionApplyOutcome {
    return validateKbContract(
      PromotionApplyOutcomeV1Schema,
      {
        transaction_id: journal.transaction_id,
        run_id: journal.run_id,
        receipt_id: journal.receipt_id,
        receipt_sha256: journal.receipt_sha256,
        status,
        post_apply_verified: journal.post_apply_verified,
        target_count: journal.targets.length,
      },
      "promotion apply outcome"
    );
  }

  private revalidatePacketForApproval(packet: PromotionGatePacket): void {
    const verification = this.readVerification(packet);
    if (!verification.verified || verification.findings.length !== 0) {
      throw new PromotionApprovalError("host promotion verification did not pass");
    }
    this.revalidatePacketArtifacts(packet);
    for (const presentation of packet.target_presentations) {
      const current = readUtf8Target(presentation.canonical_target);
      if (current.sha256 !== presentation.preimage_sha256) {
        throw new PromotionApprovalError("canonical target drifted before approval signing");
      }
    }
  }

  private revalidateReceiptBindings(
    receipt: PromotionApprovalReceipt,
    afterReservation: boolean
  ): void {
    const gate = this.gate(receipt.challenge_id);
    if (gate === undefined)
      throw new PromotionApprovalError("receipt challenge has no stored packet");
    this.validateReceiptPacketBinding(receipt, gate);
    if (gate.state !== "approved") {
      throw new PromotionApprovalError(`receipt gate is '${gate.state}', not approved`);
    }
    this.revalidatePacketArtifacts(gate.packet);
    const selected = readSelectedGeneration(this.kbRoot);
    if (selected === undefined) {
      throw new PromotionApprovalError("promotion receipt has no selected KB generation");
    }
    for (const revision of receipt.page_revisions) {
      if (selected.catalog.pages[revision.page_id]?.revision_id !== revision.revision_id) {
        throw new PromotionApprovalError(
          "promotion page revision selection drifted after approval"
        );
      }
    }
    const receiptRecord = this.receipt(receipt.receipt_id);
    if (receiptRecord === undefined)
      throw new PromotionApprovalError("receipt store row is absent");
    if (!afterReservation && new Date(receipt.expires_at).getTime() <= this.now().getTime()) {
      throw new PromotionApprovalError("promotion approval receipt expired");
    }
    using capabilities = new CapabilityStore(this.projectRoot);
    for (const [ordinal, capabilityId] of receipt.target_capability_ids.entries()) {
      const envelope = loadEnvelope(this.projectRoot, capabilityId);
      const presentation = gate.packet.target_presentations[ordinal]!;
      const lease = capabilities.lease(capabilityId);
      if (
        lease === undefined ||
        envelopeDigest(envelope) !== lease.envelope_sha256 ||
        envelope.kind !== "canonical_target" ||
        envelope.allowed_operation !== "promote" ||
        envelope.kb_profile_id !== receipt.kb_profile_id ||
        envelope.session_id !== receipt.session_id ||
        envelope.authority_root === undefined ||
        assertContainedTarget(envelope.resolved_path, envelope.authority_root) !==
          presentation.canonical_target ||
        envelope.expected_sha256 !== presentation.preimage_sha256 ||
        (!afterReservation && new Date(envelope.expires_at).getTime() <= this.now().getTime())
      ) {
        throw new PromotionApprovalError("canonical target capability remapped after approval");
      }
      if (!afterReservation) {
        const current = readUtf8Target(presentation.canonical_target);
        if (current.sha256 !== presentation.preimage_sha256) {
          throw new PromotionApprovalError("canonical target preimage drifted after approval");
        }
      }
      if (
        lease.run_id !== receipt.run_id ||
        (!afterReservation && lease.state !== "claimed") ||
        (afterReservation && !["claimed", "apply_reserved", "consumed"].includes(lease.state))
      ) {
        throw new PromotionApprovalError(
          "canonical target capability lease does not match receipt"
        );
      }
    }
  }

  private revalidatePacketArtifacts(packet: PromotionGatePacket): void {
    using artifacts = new RunArtifactStore(this.kbRoot, packet.run_id, this.artifactControl());
    const plan = artifacts.read(packet.plan_artifact.artifact_id);
    const patch = artifacts.read(packet.patch_artifact.artifact_id);
    const verification = artifacts.read(packet.verification_artifact.artifact_id);
    for (const [expected, actual] of [
      [packet.plan_artifact, plan.handle],
      [packet.patch_artifact, patch.handle],
      [packet.verification_artifact, verification.handle],
    ] as const) {
      if (!sameJson(expected, actual)) {
        throw new PromotionApprovalError("promotion artifact handle drifted from gate packet");
      }
    }
    if (packet.patch_digest !== patch.handle.sha256) {
      throw new PromotionApprovalError("promotion patch digest drifted from gate packet");
    }
    const evidenceDigest = promotionSha256(jcsCanonicalize(packet.verification_evidence));
    if (evidenceDigest !== packet.verification_evidence_digest) {
      throw new PromotionApprovalError("promotion verification evidence digest mismatch");
    }
    if (
      !packet.verification_evidence.some(
        (evidence) =>
          evidence.evidence_id === verification.handle.artifact_id &&
          evidence.ref === verification.handle.artifact_id &&
          evidence.sha256 === verification.handle.sha256
      )
    ) {
      throw new PromotionApprovalError(
        "promotion verification evidence does not bind its artifact"
      );
    }
    const parsedPlan = validateKbContract(
      PromotionPlanArtifactSchema,
      strictParseJson(plan.content),
      "promotion plan artifact"
    );
    if (
      plan.content !== jcsCanonicalize(parsedPlan) ||
      !sameJson(parsedPlan.page_revisions, packet.page_revisions) ||
      !sameJson(parsedPlan.target_capability_ids, packet.target_capability_ids)
    ) {
      throw new PromotionApprovalError("promotion plan drifted from stored packet scope");
    }
    const parsedPatch = validateKbContract(
      PromotionPatchArtifactSchema,
      strictParseJson(patch.content),
      "promotion patch artifact"
    );
    if (patch.content !== jcsCanonicalize(parsedPatch)) {
      throw new PromotionApprovalError("promotion patch is not exact stored JCS");
    }
    validatePatchCrossFields(parsedPatch, packet);
    const parsedVerification = validateKbContract(
      PromotionVerificationSchema,
      strictParseJson(verification.content),
      "promotion verification artifact"
    );
    if (
      verification.content !== jcsCanonicalize(parsedVerification) ||
      !parsedVerification.verified ||
      parsedVerification.findings.length !== 0 ||
      !sameJson(parsedVerification.page_revisions, packet.page_revisions)
    ) {
      throw new PromotionApprovalError("promotion verification no longer validates the packet");
    }
    const projectedTargets = parsedVerification.targets.map((target) => ({
      capability_id: target.capability_id,
      preimage_sha256: target.preimage_sha256,
    }));
    const expectedTargets = packet.target_presentations.map((target) => ({
      capability_id: target.target_capability_id,
      preimage_sha256: target.preimage_sha256,
    }));
    if (!sameJson(projectedTargets, expectedTargets)) {
      throw new PromotionApprovalError("promotion verification target projection drifted");
    }
  }

  private readPatch(packet: PromotionGatePacket): PromotionPatchArtifact {
    using artifacts = new RunArtifactStore(this.kbRoot, packet.run_id, this.artifactControl());
    const read = artifacts.read(packet.patch_artifact.artifact_id);
    if (
      !sameJson(read.handle, packet.patch_artifact) ||
      read.handle.sha256 !== packet.patch_digest
    ) {
      throw new PromotionApprovalError("promotion patch handle/digest mismatch");
    }
    const patch = validateKbContract(
      PromotionPatchArtifactSchema,
      strictParseJson(read.content),
      "promotion patch artifact"
    );
    if (read.content !== jcsCanonicalize(patch)) {
      throw new PromotionApprovalError("promotion patch bytes are not exact JCS");
    }
    validatePatchCrossFields(patch, packet);
    return patch;
  }

  private readVerification(packet: PromotionGatePacket) {
    using artifacts = new RunArtifactStore(this.kbRoot, packet.run_id, this.artifactControl());
    const read = artifacts.read(packet.verification_artifact.artifact_id);
    if (!sameJson(read.handle, packet.verification_artifact)) {
      throw new PromotionApprovalError("promotion verification handle mismatch");
    }
    return validateKbContract(
      PromotionVerificationSchema,
      strictParseJson(read.content),
      "promotion verification artifact"
    );
  }

  private validatePacketCrossFields(packet: PromotionGatePacket): void {
    assertSortedPageRevisions(packet);
    assertSortedUnique(packet.target_capability_ids, "promotion target capability IDs");
    if (packet.target_presentations.length !== packet.target_capability_ids.length) {
      throw new PromotionApprovalError(
        "promotion target presentations are not a complete projection"
      );
    }
    const preimageKeys = Object.keys(packet.preimage_digests).sort(bytewiseCompare);
    if (!sameJson(preimageKeys, packet.target_capability_ids)) {
      throw new PromotionApprovalError("promotion preimage digest map has wrong keys");
    }
    for (const [ordinal, capabilityId] of packet.target_capability_ids.entries()) {
      const presentation = packet.target_presentations[ordinal];
      if (
        presentation?.target_capability_id !== capabilityId ||
        presentation.preimage_sha256 !== packet.preimage_digests[capabilityId]
      ) {
        throw new PromotionApprovalError("promotion target presentation order/projection mismatch");
      }
    }
    if (packet.patch_digest !== packet.patch_artifact.sha256) {
      throw new PromotionApprovalError("promotion packet patch_digest is not its artifact digest");
    }
    if (
      promotionSha256(jcsCanonicalize(packet.verification_evidence)) !==
      packet.verification_evidence_digest
    ) {
      throw new PromotionApprovalError("promotion packet verification evidence digest mismatch");
    }
    if (new Date(packet.expires_at).getTime() <= new Date(packet.issued_at).getTime()) {
      throw new PromotionApprovalError("promotion packet expiry must follow issuance");
    }
  }

  private validateDecisionIntent(value: PromotionDecisionIntent): PromotionDecisionIntent {
    const intent = validateKbContract(
      PromotionDecisionIntentSchema,
      value,
      "promotion decision intent"
    );
    const hasNonce = intent.approval_nonce !== undefined;
    const hasExpiry = intent.approval_expires_at !== undefined;
    if (intent.decision === "approve") {
      if (!hasNonce || !hasExpiry) {
        throw new PromotionApprovalError("approve intent requires nonce and approval expiry");
      }
      const expiry = new Date(intent.approval_expires_at!).getTime();
      if (expiry <= new Date(intent.decided_at).getTime()) {
        throw new PromotionApprovalError("approve intent expiry must follow its decision time");
      }
    } else if (hasNonce || hasExpiry) {
      throw new PromotionApprovalError("refine/deny intent forbids approval nonce and expiry");
    }
    return intent;
  }

  private validateReceiptPacketBinding(
    receipt: PromotionApprovalReceipt,
    gate: PromotionGateStoreRecord
  ): void {
    const packet = gate.packet;
    const expectedCanonicalTargets = packet.target_presentations.map(
      (item) => item.canonical_target
    );
    const intent = gate.decision_intent;
    if (
      intent === undefined ||
      intent.decision !== "approve" ||
      intent.approval_nonce === undefined ||
      intent.approval_expires_at === undefined ||
      receipt.receipt_id !== `receipt_${intent.decision_id}` ||
      receipt.approver_subject_id !== intent.reviewer_subject_id ||
      receipt.nonce !== intent.approval_nonce ||
      receipt.issued_at !== intent.decided_at ||
      receipt.expires_at !== intent.approval_expires_at ||
      receipt.challenge_id !== intent.challenge_id ||
      receipt.gate_packet_sha256 !== intent.packet_sha256 ||
      receipt.run_id !== packet.run_id ||
      receipt.session_id !== packet.session_id ||
      receipt.challenge_id !== packet.challenge_id ||
      receipt.kb_profile_id !== packet.kb_profile_id ||
      receipt.kb_id !== packet.kb_id ||
      receipt.gate_packet_sha256 !== gate.packet_sha256 ||
      !sameJson(receipt.page_revisions, packet.page_revisions) ||
      !sameJson(receipt.target_capability_ids, packet.target_capability_ids) ||
      !sameJson(receipt.canonical_targets, expectedCanonicalTargets) ||
      !sameJson(receipt.preimage_digests, packet.preimage_digests) ||
      receipt.patch_digest !== packet.patch_digest ||
      receipt.verification_evidence_digest !== packet.verification_evidence_digest
    ) {
      throw new PromotionApprovalError("promotion receipt does not exactly bind the stored packet");
    }
    if (new Date(receipt.expires_at).getTime() > new Date(packet.expires_at).getTime()) {
      throw new PromotionApprovalError("promotion receipt outlives its gate packet");
    }
  }

  private gateRecord(row: GateRow): PromotionGateStoreRecord {
    const packet = validateKbContract(
      PromotionGatePacketSchema,
      strictParseJson(String(row.packet_jcs)),
      "stored promotion gate packet"
    );
    this.validatePacketCrossFields(packet);
    const packetJcs = jcsCanonicalize(packet);
    const packetSha = promotionSha256(packetJcs);
    if (
      packetJcs !== String(row.packet_jcs) ||
      packetSha !== String(row.packet_sha256) ||
      packet.challenge_id !== String(row.challenge_id) ||
      packet.run_id !== String(row.run_id) ||
      packet.session_id !== String(row.session_id)
    ) {
      throw new PromotionApprovalError("promotion gate row/JCS binding mismatch");
    }
    const intentJcs = row.decision_intent_jcs == null ? undefined : String(row.decision_intent_jcs);
    if ((intentJcs === undefined) !== (row.decision_intent_sha256 == null)) {
      throw new PromotionApprovalError(
        "promotion decision intent bytes/digest requiredness mismatch"
      );
    }
    const intent =
      intentJcs === undefined
        ? undefined
        : this.validateDecisionIntent(
            validateKbContract(
              PromotionDecisionIntentSchema,
              strictParseJson(intentJcs),
              "stored promotion decision intent"
            )
          );
    if (
      intentJcs !== undefined &&
      (jcsCanonicalize(intent) !== intentJcs ||
        promotionSha256(intentJcs) !== String(row.decision_intent_sha256) ||
        intent?.challenge_id !== packet.challenge_id ||
        intent.packet_sha256 !== packetSha)
    ) {
      throw new PromotionApprovalError("promotion decision intent row/JCS mismatch");
    }
    const decisionJcs =
      row.decision_record_jcs == null ? undefined : String(row.decision_record_jcs);
    const decision =
      decisionJcs === undefined
        ? undefined
        : validateKbContract(
            PromotionGateDecisionRecordSchema,
            strictParseJson(decisionJcs),
            "stored promotion decision record"
          );
    if (
      decisionJcs !== undefined &&
      (jcsCanonicalize(decision) !== decisionJcs ||
        decision?.challenge_id !== packet.challenge_id ||
        decision.packet_sha256 !== packetSha)
    ) {
      throw new PromotionApprovalError("promotion decision record is not exact bound JCS");
    }
    const state = String(row.state);
    const decisionId =
      row.decision_or_receipt_id == null ? undefined : String(row.decision_or_receipt_id);
    if (
      (state === "awaiting" &&
        (intent !== undefined || decision !== undefined || decisionId !== undefined)) ||
      (state === "claimed" &&
        (intent === undefined || decision !== undefined || decisionId !== undefined)) ||
      (state === "approved" &&
        (intent?.decision !== "approve" || decision !== undefined || decisionId === undefined)) ||
      (state === "refined" &&
        (intent?.decision !== "refine" ||
          decision?.decision !== "refine" ||
          decisionId !== decision.decision_id)) ||
      (state === "denied" &&
        (intent?.decision !== "deny" ||
          decision?.decision !== "deny" ||
          decisionId !== decision.decision_id))
    ) {
      throw new PromotionApprovalError("promotion gate state projection is inconsistent");
    }
    const record = validateKbContract(
      PromotionGateStoreRecordV1Schema,
      {
        schema_version: 1,
        challenge_id: String(row.challenge_id),
        run_id: String(row.run_id),
        session_id: String(row.session_id),
        packet_sha256: packetSha,
        packet_jcs: packetJcs,
        state,
        ...(intentJcs !== undefined
          ? {
              decision_intent_jcs: intentJcs,
              decision_intent_sha256: String(row.decision_intent_sha256),
            }
          : {}),
        ...(decisionId !== undefined ? { decision_or_receipt_id: decisionId } : {}),
        ...(row.transaction_id != null ? { transaction_id: String(row.transaction_id) } : {}),
        updated_at: String(row.updated_at),
      },
      "promotion gate store record projection"
    );
    return validateKbContract(
      PromotionGateStoreEnvelopeV1Schema,
      {
        ...record,
        packet,
        ...(intent !== undefined ? { decision_intent: intent } : {}),
        ...(decisionJcs !== undefined
          ? { decision_record_jcs: decisionJcs, decision_record: decision }
          : {}),
      },
      "promotion gate store envelope"
    );
  }

  private receiptRecord(row: ReceiptRow): PromotionApprovalStoreRecord {
    const parsed = this.parseAndVerifyReceipt(String(row.receipt_jcs));
    if (
      parsed.receipt_jcs !== String(row.receipt_jcs) ||
      parsed.receipt_sha256 !== String(row.receipt_sha256) ||
      receiptSignedJcs(parsed.receipt) !== String(row.signed_jcs) ||
      parsed.receipt.receipt_id !== String(row.receipt_id) ||
      parsed.receipt.challenge_id !== String(row.challenge_id) ||
      parsed.receipt.key_id !== String(row.key_id)
    ) {
      throw new PromotionApprovalError("promotion receipt row/JCS/signature binding mismatch");
    }
    const state = String(row.state);
    if ((state === "available") !== (row.transaction_id == null)) {
      throw new PromotionApprovalError("promotion approval transaction requiredness mismatch");
    }
    const record = validateKbContract(
      PromotionApprovalStoreRecordV1Schema,
      {
        schema_version: 1,
        receipt_id: String(row.receipt_id),
        receipt_sha256: parsed.receipt_sha256,
        key_id: String(row.key_id),
        state,
        ...(row.transaction_id != null ? { transaction_id: String(row.transaction_id) } : {}),
        updated_at: String(row.updated_at),
      },
      "promotion approval store record projection"
    );
    return validateKbContract(
      PromotionApprovalStoreEnvelopeV1Schema,
      {
        ...record,
        challenge_id: String(row.challenge_id),
        receipt_jcs: parsed.receipt_jcs,
        signed_jcs: String(row.signed_jcs),
        receipt: parsed.receipt,
      },
      "promotion approval store envelope"
    );
  }

  private artifactControl(): Checkpointer {
    if (this.artifactCheckpointer === undefined) {
      throw new PromotionApprovalError(
        "promotion artifact validation requires the orchestration control DB"
      );
    }
    return this.artifactCheckpointer;
  }

  private assertSealedArtifact(
    store: RunArtifactStore,
    state: string,
    handle: ArtifactHandle
  ): void {
    const sealed = store.listByState(state, "sealed");
    if (!sealed.some((candidate) => sameJson(candidate, handle))) {
      throw new PromotionApprovalError(
        `promotion ${state} artifact is not the exact sealed same-run handle`
      );
    }
  }

  private terminalizeApprovalBeforeClaim(
    verified: {
      receipt: PromotionApprovalReceipt;
      receipt_jcs: string;
      receipt_sha256: Sha256Hex;
    },
    state: "invalidated" | "expired"
  ): PromotionApplyOutcome {
    const receipt = verified.receipt;
    const transactionId = `tx_invalidate_${receipt.receipt_id}`;
    this.reserveApplyOperation?.({
      runId: receipt.run_id,
      sessionId: receipt.session_id,
      receiptSha256: verified.receipt_sha256,
      transactionId,
    });
    this.hit("after_apply_operation_reserved");
    this.transaction(() => {
      const receiptChange = this.db
        .prepare(
          `UPDATE promotion_receipts SET state = ?, transaction_id = ?, updated_at = ?
           WHERE receipt_id = ? AND state = 'available' AND receipt_sha256 = ?`
        )
        .run(
          state,
          transactionId,
          safeIso(this.now()),
          receipt.receipt_id,
          verified.receipt_sha256
        );
      const gateChange = this.db
        .prepare(
          `UPDATE promotion_gates SET state = ?, updated_at = ?
           WHERE challenge_id = ? AND state = 'approved'
             AND decision_or_receipt_id = ?`
        )
        .run(state, safeIso(this.now()), receipt.challenge_id, receipt.receipt_id);
      if (Number(receiptChange.changes) !== 1 || Number(gateChange.changes) !== 1) {
        throw new PromotionApprovalError(
          "lost atomic pre-claim promotion receipt/gate terminalization race"
        );
      }
    });
    this.hit("after_preclaim_approval_terminal");
    const record = this.receipt(receipt.receipt_id)!;
    return this.recoverApprovalBeforeClaim(record);
  }

  private recoverApprovalBeforeClaim(
    receiptRecord: PromotionApprovalStoreRecord
  ): PromotionApplyOutcome {
    if (
      (receiptRecord.state !== "expired" && receiptRecord.state !== "invalidated") ||
      receiptRecord.transaction_id === undefined ||
      this.journal(receiptRecord.transaction_id) !== undefined
    ) {
      throw new PromotionApprovalError("promotion pre-claim recovery state is inconsistent");
    }
    const verified = this.parseAndVerifyReceipt(receiptRecord.receipt_jcs);
    this.reserveApplyOperation?.({
      runId: verified.receipt.run_id,
      sessionId: verified.receipt.session_id,
      receiptSha256: receiptRecord.receipt_sha256,
      transactionId: receiptRecord.transaction_id,
    });
    const gate = this.gate(verified.receipt.challenge_id);
    if (
      gate === undefined ||
      gate.state !== receiptRecord.state ||
      gate.decision_or_receipt_id !== receiptRecord.receipt_id
    ) {
      throw new PromotionApprovalError("promotion pre-claim receipt/gate terminal state split");
    }
    this.validateReceiptPacketBinding(verified.receipt, gate);
    this.requireControlApprovalBinding(verified.receipt, gate, receiptRecord.receipt_sha256);
    using capabilities = new CapabilityStore(this.projectRoot);
    const leases = verified.receipt.target_capability_ids.map((id) => capabilities.lease(id));
    if (
      !leases.every(
        (lease) =>
          lease?.state === "invalidated" &&
          lease.run_id === verified.receipt.run_id &&
          lease.transaction_id === receiptRecord.transaction_id
      )
    ) {
      capabilities.invalidateApplySet(
        verified.receipt.target_capability_ids,
        verified.receipt.run_id,
        receiptRecord.transaction_id,
        safeIso(this.now())
      );
    }
    this.hit("after_preclaim_capability_terminal");
    return validateKbContract(
      PromotionApplyOutcomeV1Schema,
      {
        transaction_id: receiptRecord.transaction_id,
        run_id: verified.receipt.run_id,
        receipt_id: verified.receipt.receipt_id,
        receipt_sha256: receiptRecord.receipt_sha256,
        status: "failed",
        post_apply_verified: false,
        target_count: verified.receipt.target_capability_ids.length,
      },
      "promotion pre-claim apply outcome"
    );
  }

  private expireGate(challengeId: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE promotion_gates SET state = 'expired', updated_at = ? WHERE challenge_id = ? AND state = 'awaiting'"
        )
        .run(safeIso(this.now()), challengeId);
    });
  }

  private journalRequired(transactionId: string): PromotionApplyJournal {
    const journal = this.journal(transactionId);
    if (journal === undefined)
      throw new PromotionApprovalError("promotion apply journal is absent");
    return journal;
  }

  private updateJournal(
    journal: PromotionApplyJournal,
    patch: Partial<Pick<PromotionApplyJournal, "state" | "post_apply_verified">>
  ): PromotionApplyJournal {
    return this.transaction(() => this.updateJournalInTransaction(journal, patch));
  }

  private terminalizeJournalAndReceipt(
    journal: PromotionApplyJournal,
    journalState: "complete" | "failed" | "blocked_external_drift",
    postApplyVerified: boolean,
    receiptState: "consumed" | "invalidated"
  ): PromotionApplyJournal {
    return this.transaction(() => {
      const updated = this.updateJournalInTransaction(journal, {
        state: journalState,
        post_apply_verified: postApplyVerified,
      });
      const currentReceipt = this.db
        .prepare("SELECT state, transaction_id FROM promotion_receipts WHERE receipt_id = ?")
        .get(updated.receipt_id) as { state: string; transaction_id: string | null } | undefined;
      if (
        currentReceipt === undefined ||
        currentReceipt.transaction_id !== updated.transaction_id
      ) {
        throw new PromotionApprovalError(
          "promotion journal lost its exact receipt transaction during terminalization"
        );
      }
      if (currentReceipt.state !== receiptState) {
        const allowed =
          receiptState === "consumed"
            ? currentReceipt.state === "apply_reserved"
            : currentReceipt.state === "claimed" || currentReceipt.state === "apply_reserved";
        if (!allowed) {
          throw new PromotionApprovalError(
            "promotion receipt state conflicts with journal terminalization"
          );
        }
        const changed = this.db
          .prepare(
            `UPDATE promotion_receipts
             SET state = ?, updated_at = ?
             WHERE receipt_id = ? AND transaction_id = ? AND state = ?`
          )
          .run(
            receiptState,
            updated.updated_at,
            updated.receipt_id,
            updated.transaction_id,
            currentReceipt.state
          );
        if (Number(changed.changes) !== 1) {
          throw new PromotionApprovalError(
            "lost atomic promotion journal/receipt terminalization race"
          );
        }
      }
      return updated;
    });
  }

  private updateJournalInTransaction(
    journal: PromotionApplyJournal,
    patch: Partial<Pick<PromotionApplyJournal, "state" | "post_apply_verified">>
  ): PromotionApplyJournal {
    const updated = validateKbContract(
      PromotionApplyJournalSchema,
      {
        ...journal,
        ...patch,
        updated_at: safeIso(this.now()),
      },
      "promotion apply journal"
    );
    const changed = this.db
      .prepare(
        `UPDATE apply_journals SET journal_jcs = ?, state = ?, updated_at = ?
         WHERE transaction_id = ? AND journal_jcs = ?`
      )
      .run(
        jcsCanonicalize(updated),
        updated.state,
        updated.updated_at,
        journal.transaction_id,
        jcsCanonicalize(journal)
      );
    if (Number(changed.changes) !== 1) {
      throw new PromotionApprovalError("lost promotion journal update race");
    }
    return updated;
  }

  private updateJournalTarget(
    journal: PromotionApplyJournal,
    ordinal: number,
    state: PromotionApplyJournal["targets"][number]["state"]
  ): PromotionApplyJournal {
    const targets = journal.targets.map((target) =>
      target.ordinal === ordinal ? { ...target, state } : target
    );
    const updated = validateKbContract(
      PromotionApplyJournalSchema,
      { ...journal, targets, updated_at: safeIso(this.now()) },
      "promotion apply journal"
    );
    return this.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE apply_journals SET journal_jcs = ?, state = ?, updated_at = ?
           WHERE transaction_id = ? AND journal_jcs = ?`
        )
        .run(
          jcsCanonicalize(updated),
          updated.state,
          updated.updated_at,
          journal.transaction_id,
          jcsCanonicalize(journal)
        );
      if (Number(changed.changes) !== 1) {
        throw new PromotionApprovalError("lost promotion journal target update race");
      }
      return updated;
    });
  }

  private capturePreimage(filePath: string, bytes: Buffer): void {
    const directory = path.dirname(filePath);
    this.ensurePrivateTree(directory);
    if (pathExistsNoFollow(filePath)) {
      if (!this.readStoredPreimage(filePath, promotionSha256(bytes)).equals(bytes)) {
        throw new PromotionApprovalError("stored promotion preimage bytes conflict");
      }
      return;
    }
    const parentDescriptor = openPinnedDirectoryNoFollow(directory);
    try {
      const descriptor = openSync(
        pinnedDirectoryChildPath(parentDescriptor, path.basename(filePath)),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        APPROVAL_FILE_MODE
      );
      try {
        writeFileSync(descriptor, bytes);
        fchmodSync(descriptor, APPROVAL_FILE_MODE);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
    this.readStoredPreimage(filePath, promotionSha256(bytes));
  }

  private ensurePrivateTree(directory: string): void {
    const relative = path.relative(this.kbRoot, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new PromotionApprovalError("promotion preimage directory escapes the KB root");
    }
    let descriptor = openPinnedDirectoryNoFollow(this.kbRoot);
    try {
      assertDirectoryDescriptor(descriptor, "promotion KB root", APPROVAL_DIRECTORY_MODE);
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        const next = openChildDirectory(descriptor, segment, "promotion preimage directory", true);
        closeSync(descriptor);
        descriptor = next;
      }
    } finally {
      closeSync(descriptor);
    }
  }

  private preimageAbsolute(storageKey: string): string {
    const expectedPrefix = `work${path.sep}`;
    const native = storageKey.split("/").join(path.sep);
    if (!native.startsWith(expectedPrefix)) {
      throw new PromotionApprovalError("promotion preimage key is outside work/");
    }
    const absolute = path.resolve(this.kbRoot, native);
    if (!absolute.startsWith(`${this.kbRoot}${path.sep}`)) {
      throw new PromotionApprovalError("promotion preimage key escapes the KB root");
    }
    return absolute;
  }

  private readStoredPreimage(filePath: string, expected: Sha256Hex): Buffer {
    const parentDescriptor = openPinnedDirectoryNoFollow(path.dirname(filePath));
    try {
      const descriptor = openSecureRegularFileAt(
        parentDescriptor,
        path.basename(filePath),
        "promotion preimage"
      );
      try {
        const bytes = readFileSync(descriptor);
        if (promotionSha256(bytes) !== expected) {
          throw new PromotionApprovalError("stored promotion preimage hash mismatch");
        }
        return bytes;
      } finally {
        closeSync(descriptor);
      }
    } finally {
      closeSync(parentDescriptor);
    }
  }

  private verifyStoredPreimage(filePath: string, expected: Sha256Hex): void {
    this.readStoredPreimage(filePath, expected);
  }

  private acquireMutex(transactionId: string): void {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT transaction_id FROM apply_mutex WHERE mutex_id = ?")
        .get(MUTEX_ROW_ID) as { transaction_id: string | null };
      if (row.transaction_id !== null && row.transaction_id !== transactionId) {
        const owner = this.journal(row.transaction_id);
        if (owner === undefined || !TERMINAL_JOURNAL_STATES.has(owner.state)) {
          throw new PromotionApprovalError(
            "another promotion apply transaction holds the host mutex"
          );
        }
      }
      this.db
        .prepare("UPDATE apply_mutex SET transaction_id = ?, updated_at = ? WHERE mutex_id = ?")
        .run(transactionId, safeIso(this.now()), MUTEX_ROW_ID);
    });
  }

  private releaseMutex(transactionId: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE apply_mutex SET transaction_id = NULL, updated_at = ? WHERE mutex_id = ? AND transaction_id = ?"
        )
        .run(safeIso(this.now()), MUTEX_ROW_ID, transactionId);
    });
  }

  private assertCapabilityReservation(
    receipt: PromotionApprovalReceipt,
    transactionId: string
  ): void {
    using capabilities = new CapabilityStore(this.projectRoot);
    for (const capabilityId of receipt.target_capability_ids) {
      const lease = capabilities.lease(capabilityId);
      if (
        lease?.state !== "apply_reserved" ||
        lease.run_id !== receipt.run_id ||
        lease.transaction_id !== transactionId
      ) {
        throw new PromotionApprovalError("target capability set is not wholly apply_reserved");
      }
    }
  }

  private gateForJournal(journal: PromotionApplyJournal): PromotionGateStoreRecord {
    const receipt = this.receipt(journal.receipt_id);
    if (receipt === undefined) throw new PromotionApprovalError("journal receipt is absent");
    const gate = this.gate(receipt.challenge_id);
    if (gate === undefined) throw new PromotionApprovalError("journal gate is absent");
    return gate;
  }

  private assertCustody(): void {
    const currentRoot = openApprovalRoot({ projectRoot: this.projectRoot, create: false });
    try {
      const pinned = fstatSync(this.rootDescriptor);
      if (
        currentRoot.identity.dev !== this.rootIdentity.dev ||
        currentRoot.identity.ino !== this.rootIdentity.ino ||
        pinned.dev !== this.rootIdentity.dev ||
        pinned.ino !== this.rootIdentity.ino
      ) {
        throw new PromotionApprovalError("promotion approval root changed after open");
      }
    } finally {
      closeSync(currentRoot.descriptor);
    }
    const database = openSecureRegularFileAt(
      this.rootDescriptor,
      "receipts.sqlite",
      "promotion receipt database"
    );
    try {
      const stat = fstatSync(database);
      if (stat.dev !== this.databaseIdentity.dev || stat.ino !== this.databaseIdentity.ino) {
        throw new PromotionApprovalError("promotion receipt database path changed after open");
      }
    } finally {
      closeSync(database);
    }
    const mutex = openSecureRegularFileAt(
      this.rootDescriptor,
      "promotion-apply.mutex",
      "promotion apply mutex"
    );
    try {
      const stat = fstatSync(mutex);
      const held = fstatSync(this.mutexDescriptor);
      if (
        stat.dev !== this.mutexIdentity.dev ||
        stat.ino !== this.mutexIdentity.ino ||
        held.dev !== this.mutexIdentity.dev ||
        held.ino !== this.mutexIdentity.ino
      ) {
        throw new PromotionApprovalError("promotion apply mutex path changed after open");
      }
    } finally {
      closeSync(mutex);
    }
    for (const suffix of ["-wal", "-shm"]) {
      const child = `receipts.sqlite${suffix}`;
      const file = pinnedDirectoryChildPath(this.rootDescriptor, child);
      if (!pathExistsNoFollow(file)) continue;
      const descriptor = openSecureRegularFileAt(
        this.rootDescriptor,
        child,
        `promotion receipt database${suffix}`
      );
      closeSync(descriptor);
    }
  }

  private requireControlApprovalBinding(
    receipt: PromotionApprovalReceipt,
    gate: PromotionGateStoreRecord,
    receiptSha256: Sha256Hex
  ): PromotionControlApprovalBinding {
    const candidate = this.controlBindingForRun?.(receipt.run_id);
    const binding =
      candidate === undefined
        ? undefined
        : validateKbContract(
            PromotionControlApprovalBindingV1Schema,
            candidate,
            "promotion control approval binding"
          );
    if (
      binding === undefined ||
      binding.run_id !== receipt.run_id ||
      binding.challenge_id !== receipt.challenge_id ||
      binding.packet_sha256 !== gate.packet_sha256 ||
      binding.decision !== "approve" ||
      binding.decision_intent_sha256 !== gate.decision_intent_sha256 ||
      binding.receipt_id !== receipt.receipt_id ||
      binding.receipt_sha256 !== receiptSha256
    ) {
      throw new PromotionApprovalError(
        "canonical mutation requires the exact control-side approved decision/receipt binding"
      );
    }
    return binding;
  }

  private hit(boundary: string): void {
    this.fault?.(boundary);
  }

  private transaction<T>(operation: () => T): T {
    this.assertCustody();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
    closeSync(this.mutexDescriptor);
    closeSync(this.rootDescriptor);
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
