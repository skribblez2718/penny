/**
 * §5.5–5.6 KB operation event-group / receipt plane.
 *
 * One durable event group owns one external start/resume or host callback. Its
 * per-run sequence is reserved before work. Once an outcome is known, the
 * control DB stores the exact replay JCS and preindexes the exact receipt bytes
 * and keys before this module writes anything under the owner-only receipt root.
 * Recovery is index-only: no directory scan, guessed ID, or found-file adoption.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import {
  type Checkpointer,
  operationSourceIdentitySha256,
  type ReserveOperationEventGroupInput,
} from "../checkpointer.js";
import type { RunContext } from "../context.js";
import { jcsCanonicalize } from "./approval-receipts.js";
import { kbHostStatePaths } from "./host-state.js";
import {
  ContentReviewGatePacketSchema,
  OperationEventGroupSchema,
  OperationReceiptIndexRecordSchema,
  OperationReceiptSchema,
  KnowledgeBaseResultSchema,
  ReplayableKnowledgeBaseResultSchema,
  validateKbContract,
  type OperationAction,
  type OperationEvent,
  type OperationEventGroup,
  type OperationEventSource,
  type OperationReceiptIndexRecord,
  type ReplayableKnowledgeBaseResult,
  type Sha256Hex,
} from "./contracts.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const OPAQUE_ID = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class OperationReceiptError extends Error {
  constructor(
    readonly code:
      | "operation_not_reserved"
      | "operation_conflict"
      | "receipt_custody_refused"
      | "receipt_hash_mismatch"
      | "receipt_state_mismatch"
      | "receipt_result_invalid",
    message: string
  ) {
    super(message);
    this.name = "OperationReceiptError";
  }
}

export type OperationReceiptFaultHook = (boundary: string) => void;

export interface SelectorCommitEvidence {
  readonly transaction_id: string;
  readonly candidate_generation_id: string;
  readonly selector_sha256: string;
}

export interface OperationCompletion {
  readonly group: OperationEventGroup;
  readonly receipt: OperationReceiptIndexRecord;
  readonly replay_result: ReplayableKnowledgeBaseResult;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonValue(source: string): unknown {
  const value: unknown = JSON.parse(source);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function operationReceiptRoot(projectRoot: string): string {
  return kbHostStatePaths(projectRoot).operationReceipts;
}

/** SHA-256(JCS(session/invocation/action/request digest)). */
export function externalOperationSourceIdentity(input: {
  session_id: string;
  invocation_id: string;
  action: OperationAction;
  request_sha256: string;
}): Sha256Hex {
  return operationSourceIdentitySha256({
    session_id: input.session_id,
    invocation_id: input.invocation_id,
    action: input.action,
    request_sha256: input.request_sha256,
  }) as Sha256Hex;
}

/** SHA-256(JCS(packet digest + exact decision-receipt digest)). */
export function contentReviewOperationSourceIdentity(input: {
  packet_sha256: string;
  decision_receipt_sha256: string;
}): Sha256Hex {
  return operationSourceIdentitySha256({
    packet_sha256: input.packet_sha256,
    decision_receipt_sha256: input.decision_receipt_sha256,
  }) as Sha256Hex;
}

/** SHA-256(JCS(promotion packet digest + durable decision-intent digest)). */
export function promotionDecisionOperationSourceIdentity(input: {
  packet_sha256: string;
  decision_intent_sha256: string;
}): Sha256Hex {
  return operationSourceIdentitySha256({
    packet_sha256: input.packet_sha256,
    decision_intent_sha256: input.decision_intent_sha256,
  }) as Sha256Hex;
}

/** SHA-256(JCS(approval-receipt digest + exact journal transaction id)). */
export function promotionApplyOperationSourceIdentity(input: {
  approval_receipt_sha256: string;
  transaction_id: string;
}): Sha256Hex {
  return operationSourceIdentitySha256({
    approval_receipt_sha256: input.approval_receipt_sha256,
    transaction_id: input.transaction_id,
  }) as Sha256Hex;
}

function asStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new OperationReceiptError("receipt_result_invalid", "result string list is malformed");
  }
  return value.map((item: unknown) => {
    if (typeof item !== "string") {
      throw new OperationReceiptError("receipt_result_invalid", "result string list is malformed");
    }
    return item;
  });
}

function uniqueOpaque(values: readonly string[]): string[] {
  if (values.some((value) => !OPAQUE_ID.test(value))) {
    throw new OperationReceiptError(
      "receipt_result_invalid",
      "result opaque identity is malformed"
    );
  }
  // This helper composes several independently valid internal ID sets into one
  // public set. De-duplication happens before the result exists; a caller-supplied
  // duplicate in `toReplayableKnowledgeBaseResult` is still rejected by schema.
  return [...new Set(values)];
}

function optionalOpaque(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new OperationReceiptError(
      "receipt_result_invalid",
      "optional result identity is malformed"
    );
  }
  return [value];
}

function flatSafeCounts(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  if (!isUnknownRecord(value)) {
    throw new OperationReceiptError("receipt_result_invalid", "result counts must be an object");
  }
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (
      !/^(?!(?:__proto__|prototype|constructor)$)[a-z][a-z0-9_]{0,63}$/.test(key) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw new OperationReceiptError("receipt_result_invalid", "result counts are malformed");
    }
    out[key] = count;
  }
  return out;
}

function artifactHandles(value: unknown): ReplayableKnowledgeBaseResult["artifacts"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new OperationReceiptError("receipt_result_invalid", "result artifacts must be an array");
  }
  return value.map((item) => {
    if (!isUnknownRecord(item)) {
      throw new OperationReceiptError(
        "receipt_result_invalid",
        "result artifact handle is malformed"
      );
    }
    const candidate = item;
    return validateKbContract(
      ReplayableKnowledgeBaseResultSchema.properties.artifacts.items,
      {
        schema_version: candidate["schema_version"],
        artifact_id: candidate["artifact_id"],
        artifact_kind: candidate["artifact_kind"],
        sha256: candidate["sha256"],
        media_type: candidate["media_type"],
        byte_length: candidate["byte_length"],
      },
      "operation replay artifact handle"
    );
  });
}

function indexedReviewArtifacts(
  checkpointer: Checkpointer | undefined,
  runId: string,
  value: unknown
): ReplayableKnowledgeBaseResult["artifacts"] {
  const ids = asStringArray(value);
  if (ids.length === 0) return [];
  if (checkpointer === undefined) {
    throw new OperationReceiptError(
      "receipt_result_invalid",
      "waiting run artifact projection requires the control index"
    );
  }
  return artifactHandles(
    ids.map((artifactId) => {
      const record = checkpointer.kbArtifact(artifactId);
      if (record === undefined || record.run_id !== runId || record.lifecycle !== "sealed") {
        throw new OperationReceiptError(
          "receipt_result_invalid",
          "waiting run artifact is absent or not sealed"
        );
      }
      return {
        schema_version: 1,
        artifact_id: record.artifact_id,
        artifact_kind: record.artifact_kind,
        sha256: record.sha256,
        media_type: record.media_type,
        byte_length: record.byte_length,
      };
    })
  );
}

function evidenceRefs(value: unknown): ReplayableKnowledgeBaseResult["evidence"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new OperationReceiptError("receipt_result_invalid", "result evidence must be an array");
  }
  return value.map((item) =>
    validateKbContract(
      ReplayableKnowledgeBaseResultSchema.properties.evidence.items,
      item,
      "operation replay evidence"
    )
  );
}

/**
 * Select exactly the replayable public fields and omit `derived_answer` even
 * when the caller's first result delivered one ephemerally.
 */
export function toReplayableKnowledgeBaseResult(value: unknown): ReplayableKnowledgeBaseResult {
  try {
    // Validate the complete public result first. Projection may omit only the
    // explicitly ephemeral derived answer; malformed IDs/counts/handles/evidence
    // are rejected rather than filtered or silently dropped.
    const complete = validateKbContract(KnowledgeBaseResultSchema, value, "knowledge-base result");
    const { derived_answer: _ephemeral, ...replay } = complete;
    return validateKbContract(ReplayableKnowledgeBaseResultSchema, replay, "replayable KB result");
  } catch (error) {
    throw new OperationReceiptError(
      "receipt_result_invalid",
      error instanceof Error ? error.message : "operation result is malformed"
    );
  }
}

/** Closed result→event mapping; no other pair is admitted. */
export function operationEventForResult(input: {
  result: ReplayableKnowledgeBaseResult;
  transaction_id: string;
  selector_evidence?: SelectorCommitEvidence;
}): OperationEvent {
  const result = validateKbContract(
    ReplayableKnowledgeBaseResultSchema,
    input.result,
    "operation event result"
  );
  if (result.status === "awaiting_user") return "prepared";
  if (result.status === "complete") {
    if (input.selector_evidence !== undefined) {
      if (
        !["init", "ingest", "save"].includes(result.action) ||
        input.selector_evidence.transaction_id !== input.transaction_id ||
        !OPAQUE_ID.test(input.selector_evidence.candidate_generation_id) ||
        !SHA256.test(input.selector_evidence.selector_sha256)
      ) {
        throw new OperationReceiptError(
          "operation_conflict",
          "published event lacks same-transaction selector evidence"
        );
      }
      return "published";
    }
    return "completed";
  }
  if (
    result.status === "running" ||
    result.status === "exhausted" ||
    result.status === "cancelled"
  ) {
    return "incomplete";
  }
  if (result.status === "refused" || result.status === "error") return "failed";
  throw new OperationReceiptError("operation_conflict", "result/event pairing is not closed");
}

/**
 * Build a content-free callback replay from durable run metadata. This helper
 * never copies a query/title/body or a derived answer from the run.
 */
export function replayableResultFromRun(input: {
  action: OperationAction;
  run: RunContext;
  checkpointer?: Checkpointer;
  status_override?: ReplayableKnowledgeBaseResult["status"];
}): ReplayableKnowledgeBaseResult {
  const terminalValue: unknown = input.run.terminalDirective;
  const terminal = isUnknownRecord(terminalValue) ? terminalValue : undefined;
  const resultValue = terminal?.["result"];
  const internal = isUnknownRecord(resultValue) ? resultValue : {};
  const publicStatus = String(input.run.knowledgeBaseData.public_status ?? "");
  const status =
    input.status_override ??
    (input.run.status === "complete"
      ? "complete"
      : input.run.status === "awaiting_user"
        ? "awaiting_user"
        : input.run.status === "running"
          ? "running"
          : input.run.status === "incomplete"
            ? publicStatus === "refused"
              ? "refused"
              : publicStatus === "exhausted"
                ? "exhausted"
                : "complete"
            : input.run.status === "cancelled"
              ? "cancelled"
              : "error");
  const counts = flatSafeCounts(
    internal["published_counts"] ??
      internal["counts"] ??
      input.run.knowledgeBaseData.published_counts
  );
  if (typeof internal["candidate_count"] === "number") {
    counts["candidates"] = Math.max(0, Math.trunc(internal["candidate_count"]));
  }
  const answerHandle = internal["answer_handle"];
  const partialHandles = internal["best_partial_artifact_handles"];
  let artifactInput: unknown = Array.isArray(internal["artifacts"])
    ? internal["artifacts"]
    : Array.isArray(partialHandles) && partialHandles.length > 0
      ? partialHandles
      : answerHandle === null || answerHandle === undefined
        ? []
        : [answerHandle];
  if (
    status === "awaiting_user" &&
    (input.action === "ingest" || input.action === "save") &&
    Array.isArray(artifactInput) &&
    artifactInput.length === 0
  ) {
    const packetJcs = input.run.knowledgeBaseData.content_review_packet_jcs;
    if (typeof packetJcs !== "string") {
      throw new OperationReceiptError(
        "receipt_result_invalid",
        "waiting content-review run is missing its exact packet"
      );
    }
    let packet: unknown;
    try {
      packet = JSON.parse(packetJcs);
    } catch {
      throw new OperationReceiptError(
        "receipt_result_invalid",
        "waiting content-review packet is malformed"
      );
    }
    artifactInput = validateKbContract(
      ContentReviewGatePacketSchema,
      packet,
      "waiting content-review packet"
    ).candidate_artifacts;
  }
  let artifacts = artifactHandles(artifactInput);
  if (status === "awaiting_user" && artifacts.length === 0) {
    artifacts = indexedReviewArtifacts(
      input.checkpointer,
      input.run.identity.run_id,
      input.run.knowledgeBaseData.review_artifact_ids
    );
  }
  const ids = uniqueOpaque([
    input.run.identity.run_id,
    ...asStringArray(internal["ids"]),
    ...asStringArray(internal["query_page_ids"]),
    ...optionalOpaque(internal["answer_artifact_id"]),
    ...optionalOpaque(internal["published_generation_id"]),
  ]);
  const warnings = [
    ...asStringArray(internal["warnings"]),
    ...asStringArray(input.run.knowledgeBaseData.warnings),
  ];
  const unresolved = [
    ...asStringArray(internal["unresolved"]),
    ...asStringArray(internal["unresolved_issues"]),
    ...asStringArray(terminal?.unresolved),
  ];
  return toReplayableKnowledgeBaseResult({
    schema_version: 1,
    action: input.action,
    run_id: input.run.identity.run_id,
    ...(typeof input.run.knowledgeBaseData.kb_id === "string" &&
    input.run.knowledgeBaseData.kb_id.length > 0
      ? { kb_id: input.run.knowledgeBaseData.kb_id }
      : {}),
    status,
    met: status === "complete" ? input.run.met : false,
    ids,
    counts,
    artifacts,
    evidence: evidenceRefs(internal["evidence"]),
    warnings: [...new Set(warnings)].slice(0, 64),
    unresolved: [...new Set(unresolved)].slice(0, 64),
    next: status === "running" ? "resume" : status === "awaiting_user" ? "review" : "none",
  });
}

function currentUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function assertDirectory(directory: string, label: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== DIRECTORY_MODE) {
    throw new OperationReceiptError(
      "receipt_custody_refused",
      `${label} must be a regular no-follow mode-0700 directory`
    );
  }
  if (currentUid() !== undefined && stat.uid !== currentUid()) {
    throw new OperationReceiptError("receipt_custody_refused", `${label} has the wrong owner`);
  }
}

function ensureDirectory(directory: string, label: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { mode: DIRECTORY_MODE });
    chmodSync(directory, DIRECTORY_MODE);
    fsyncDirectory(path.dirname(directory));
  }
  assertDirectory(directory, label);
}

function assertFile(file: string, label: string): void {
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== FILE_MODE
  ) {
    throw new OperationReceiptError(
      "receipt_custody_refused",
      `${label} must be a regular no-follow single-link mode-0600 file`
    );
  }
  if (currentUid() !== undefined && stat.uid !== currentUid()) {
    throw new OperationReceiptError("receipt_custody_refused", `${label} has the wrong owner`);
  }
}

function readSecure(file: string, label: string): Buffer {
  assertFile(file, label);
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== FILE_MODE ||
      (currentUid() !== undefined && stat.uid !== currentUid())
    ) {
      throw new OperationReceiptError(
        "receipt_custody_refused",
        `${label} failed descriptor custody checks`
      );
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
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

function indexedReceiptPath(root: string, key: string, label: string): string {
  if (path.isAbsolute(key) || key.includes("\\")) {
    throw new OperationReceiptError("receipt_custody_refused", `${label} is not relative`);
  }
  const segments = key.split("/");
  if (
    segments.length !== 3 ||
    segments.some(
      (segment) =>
        !OPAQUE_ID.test(
          segment
            .replace(/^\./, "")
            .replace(/\.tmp$/, "")
            .replace(/\.json$/, "")
        )
    )
  ) {
    throw new OperationReceiptError("receipt_custody_refused", `${label} has invalid segments`);
  }
  const absolute = path.resolve(root, ...segments);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new OperationReceiptError("receipt_custody_refused", `${label} escapes receipt root`);
  }
  return absolute;
}

function validateExactKeys(record: OperationReceiptIndexRecord): {
  profileDirectory: string;
  runDirectory: string;
  finalPath: string;
  tempPath: string;
} {
  const expectedFinal = `${record.kb_profile_id}/${record.run_id}/${record.receipt_id}.json`;
  const expectedTemp = `${record.kb_profile_id}/${record.run_id}/.${record.receipt_id}.tmp`;
  if (
    record.final_storage_key !== expectedFinal ||
    (record.temporary_storage_key !== undefined && record.temporary_storage_key !== expectedTemp)
  ) {
    throw new OperationReceiptError(
      "receipt_custody_refused",
      "operation receipt index keys are not exact"
    );
  }
  return {
    profileDirectory: record.kb_profile_id,
    runDirectory: `${record.kb_profile_id}/${record.run_id}`,
    finalPath: expectedFinal,
    tempPath: expectedTemp,
  };
}

function fileMatches(file: string, record: OperationReceiptIndexRecord): boolean {
  try {
    const bytes = readSecure(file, "operation receipt file");
    return bytes.length === record.byte_length && awaitlessSha256(bytes) === record.sha256;
  } catch (error) {
    if (error instanceof OperationReceiptError) throw error;
    return false;
  }
}

function writeExactTemp(tempPath: string, bytes: Buffer): void {
  const descriptor = openSync(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    FILE_MODE
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (written <= 0)
        throw new OperationReceiptError("receipt_state_mismatch", "short receipt write");
      offset += written;
    }
    fchmodSync(descriptor, FILE_MODE);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export class OperationReceiptStore {
  private readonly root: string;

  constructor(
    private readonly input: {
      projectRoot: string;
      checkpointer: Checkpointer;
      now?: () => Date;
      fault?: OperationReceiptFaultHook;
    }
  ) {
    this.root = operationReceiptRoot(input.projectRoot);
  }

  reserve(input: ReserveOperationEventGroupInput): {
    kind: "created" | "existing";
    group: OperationEventGroup;
  } {
    return this.input.checkpointer.reserveOperationEventGroup(input);
  }

  committedBySource(
    sourceKind: OperationEventSource,
    sourceIdentitySha256: string
  ): OperationCompletion | undefined {
    const group = this.input.checkpointer.operationEventGroupBySource(
      sourceKind,
      sourceIdentitySha256
    );
    if (group?.state !== "committed") return undefined;
    return this.finish(group.request_event_group_id);
  }

  complete(input: {
    request_event_group_id: string;
    kb_profile_id: string;
    result: unknown;
    input_digests: readonly string[];
    output_refs?: readonly string[];
    kb_id?: string;
    base_generation_id?: string;
    candidate_generation_id?: string;
    policy_sha256?: string;
    safe_metrics?: Readonly<Record<string, number>>;
    selector_evidence?: SelectorCommitEvidence;
  }): OperationCompletion {
    let group = this.input.checkpointer.operationEventGroup(input.request_event_group_id);
    if (group === undefined) {
      throw new OperationReceiptError("operation_not_reserved", "operation group is absent");
    }
    validateKbContract(OperationEventGroupSchema, group, "operation event group");
    if (group.state !== "reserved") {
      // Exact retry and outcome-preparing recovery are bound to STORED replay,
      // never to a later projection supplied by the caller.
      return this.finish(group.request_event_group_id);
    }
    const replay = toReplayableKnowledgeBaseResult(input.result);
    if (replay.action !== group.action || replay.run_id !== group.run_id) {
      throw new OperationReceiptError(
        "operation_conflict",
        "operation result does not match its reserved action/run"
      );
    }
    if (input.selector_evidence !== undefined) {
      if (input.candidate_generation_id !== input.selector_evidence.candidate_generation_id) {
        throw new OperationReceiptError(
          "operation_conflict",
          "selector evidence does not match the receipt candidate generation"
        );
      }
      let publication;
      try {
        publication = this.input.checkpointer.kbPublicationSelectorEvidence({
          transaction_id: group.transaction_id,
          run_id: group.run_id,
          candidate_generation_id: input.selector_evidence.candidate_generation_id,
        });
      } catch (error) {
        throw new OperationReceiptError(
          "operation_conflict",
          `published event lacks same-transaction selector evidence: ${errorMessage(error)}`
        );
      }
      if (publication.selector_sha256 !== input.selector_evidence.selector_sha256) {
        throw new OperationReceiptError(
          "operation_conflict",
          "selector evidence digest does not match the publication transaction"
        );
      }
    }
    const event = operationEventForResult({
      result: replay,
      transaction_id: group.transaction_id,
      ...(input.selector_evidence ? { selector_evidence: input.selector_evidence } : {}),
    });
    const inputDigests = [...new Set(input.input_digests)];
    if (inputDigests.length === 0 || inputDigests.some((digest) => !SHA256.test(digest))) {
      throw new OperationReceiptError(
        "operation_conflict",
        "operation receipt input digests are invalid"
      );
    }
    if (event !== "failed" && (input.kb_id === undefined || input.policy_sha256 === undefined)) {
      throw new OperationReceiptError(
        "operation_conflict",
        "non-failed operation receipt requires KB and policy identity"
      );
    }
    const createdAt = (this.input.now ?? (() => new Date()))().toISOString();
    const receiptId = `opr_${randomUUID().replace(/-/g, "")}`;
    const outputRefs = uniqueOpaque([
      ...(input.output_refs ?? []),
      ...replay.ids,
      ...replay.artifacts.map((artifact) => artifact.artifact_id),
    ]);
    const receipt = validateKbContract(
      OperationReceiptSchema,
      {
        schema_version: 1,
        receipt_id: receiptId,
        run_id: group.run_id,
        session_id: group.session_id,
        transaction_id: group.transaction_id,
        request_event_group_id: group.request_event_group_id,
        event_sequence: group.event_sequence,
        kb_profile_id: input.kb_profile_id,
        ...(input.kb_id !== undefined ? { kb_id: input.kb_id } : {}),
        action: group.action,
        event,
        input_digests: inputDigests,
        output_refs: outputRefs,
        ...(input.base_generation_id !== undefined
          ? { base_generation_id: input.base_generation_id }
          : {}),
        ...(input.candidate_generation_id !== undefined
          ? { candidate_generation_id: input.candidate_generation_id }
          : {}),
        ...(input.policy_sha256 !== undefined ? { policy_sha256: input.policy_sha256 } : {}),
        safe_metrics: flatSafeCounts(input.safe_metrics ?? replay.counts),
        created_at: createdAt,
      },
      "operation receipt"
    );
    const receiptJcs = jcsCanonicalize(receipt);
    const exactReceiptSha = awaitlessSha256(receiptJcs) as Sha256Hex;
    const finalKey = `${input.kb_profile_id}/${group.run_id}/${receiptId}.json`;
    const tempKey = `${input.kb_profile_id}/${group.run_id}/.${receiptId}.tmp`;
    const index = validateKbContract(
      OperationReceiptIndexRecordSchema,
      {
        schema_version: 1,
        receipt_id: receiptId,
        run_id: group.run_id,
        session_id: group.session_id,
        kb_profile_id: input.kb_profile_id,
        ...(input.kb_id !== undefined ? { kb_id: input.kb_id } : {}),
        action: group.action,
        event,
        transaction_id: group.transaction_id,
        request_event_group_id: group.request_event_group_id,
        event_sequence: group.event_sequence,
        source_kind: group.source_kind,
        source_identity_sha256: group.source_identity_sha256,
        receipt_jcs: receiptJcs,
        temporary_storage_key: tempKey,
        final_storage_key: finalKey,
        sha256: exactReceiptSha,
        byte_length: Buffer.byteLength(receiptJcs, "utf8"),
        state: "preparing",
        created_at: createdAt,
        updated_at: createdAt,
      },
      "operation receipt index"
    );
    group = this.input.checkpointer.prepareOperationOutcome({
      group,
      receipt: index,
      replay_result: replay,
    });
    this.hit("after_outcome_preindexed");
    return this.finish(group.request_event_group_id);
  }

  finish(groupId: string): OperationCompletion {
    let group = this.input.checkpointer.operationEventGroup(groupId);
    if (group === undefined || group.state === "reserved" || group.receipt_id === undefined) {
      throw new OperationReceiptError(
        "operation_not_reserved",
        "operation outcome is not yet prepared"
      );
    }
    let receipt = this.input.checkpointer.operationReceipt(group.receipt_id);
    if (receipt === undefined) {
      throw new OperationReceiptError("operation_conflict", "operation receipt index is absent");
    }
    this.validateStored(group, receipt);
    const storedReceipt = validateKbContract(
      OperationReceiptSchema,
      parseJsonValue(receipt.receipt_jcs),
      "stored operation receipt"
    );
    if (storedReceipt.event === "published") {
      if (storedReceipt.candidate_generation_id === undefined) {
        throw new OperationReceiptError(
          "operation_conflict",
          "published receipt has no candidate generation"
        );
      }
      try {
        this.input.checkpointer.kbPublicationSelectorEvidence({
          transaction_id: storedReceipt.transaction_id,
          run_id: storedReceipt.run_id,
          candidate_generation_id: storedReceipt.candidate_generation_id,
        });
      } catch (error) {
        throw new OperationReceiptError(
          "operation_conflict",
          `published receipt lacks durable selector evidence: ${errorMessage(error)}`
        );
      }
    }
    this.publishReceiptFile(receipt);
    const persistedReceipt = this.input.checkpointer.operationReceipt(receipt.receipt_id);
    if (persistedReceipt === undefined) {
      throw new OperationReceiptError(
        "operation_conflict",
        "published operation receipt disappeared"
      );
    }
    receipt = persistedReceipt;
    if (group.state !== "committed") {
      group = this.input.checkpointer.commitOperationReceipt(receipt.receipt_id);
    }
    if (storedReceipt.event === "published") {
      this.input.checkpointer.advanceKbPublication({
        transaction_id: storedReceipt.transaction_id,
        expected: ["finalizing"],
        next: "complete",
      });
    }
    const replay = this.replay(group);
    const committedReceipt = this.input.checkpointer.operationReceipt(receipt.receipt_id);
    if (committedReceipt === undefined) {
      throw new OperationReceiptError(
        "operation_conflict",
        "committed operation receipt disappeared"
      );
    }
    return {
      group,
      receipt: committedReceipt,
      replay_result: replay,
    };
  }

  private replay(group: OperationEventGroup): ReplayableKnowledgeBaseResult {
    if (group.replay_result_jcs === undefined || group.replay_result_sha256 === undefined) {
      throw new OperationReceiptError("operation_conflict", "operation replay bytes are absent");
    }
    if (awaitlessSha256(group.replay_result_jcs) !== group.replay_result_sha256) {
      throw new OperationReceiptError("receipt_hash_mismatch", "operation replay digest mismatch");
    }
    const parsed = validateKbContract(
      ReplayableKnowledgeBaseResultSchema,
      parseJsonValue(group.replay_result_jcs),
      "stored operation replay"
    );
    if (jcsCanonicalize(parsed) !== group.replay_result_jcs) {
      throw new OperationReceiptError("receipt_hash_mismatch", "operation replay is not JCS");
    }
    return parsed;
  }

  private validateStored(group: OperationEventGroup, index: OperationReceiptIndexRecord): void {
    validateKbContract(OperationEventGroupSchema, group, "stored operation group");
    validateKbContract(OperationReceiptIndexRecordSchema, index, "stored operation receipt index");
    const receipt = validateKbContract(
      OperationReceiptSchema,
      parseJsonValue(index.receipt_jcs),
      "stored operation receipt"
    );
    const shared = [
      [receipt.receipt_id, index.receipt_id],
      [receipt.run_id, index.run_id],
      [receipt.session_id, index.session_id],
      [receipt.transaction_id, index.transaction_id],
      [receipt.request_event_group_id, index.request_event_group_id],
      [receipt.event_sequence, index.event_sequence],
      [receipt.action, index.action],
      [receipt.event, index.event],
      [index.run_id, group.run_id],
      [index.session_id, group.session_id],
      [index.transaction_id, group.transaction_id],
      [index.request_event_group_id, group.request_event_group_id],
      [index.event_sequence, group.event_sequence],
      [index.action, group.action],
      [index.source_kind, group.source_kind],
      [index.source_identity_sha256, group.source_identity_sha256],
    ];
    if (shared.some(([left, right]) => left !== right)) {
      throw new OperationReceiptError(
        "operation_conflict",
        "receipt/index/group identity mismatch"
      );
    }
    if (
      jcsCanonicalize(receipt) !== index.receipt_jcs ||
      awaitlessSha256(index.receipt_jcs) !== index.sha256 ||
      Buffer.byteLength(index.receipt_jcs, "utf8") !== index.byte_length
    ) {
      throw new OperationReceiptError("receipt_hash_mismatch", "stored receipt bytes mismatch");
    }
    validateExactKeys(index);
  }

  private publishReceiptFile(record: OperationReceiptIndexRecord): void {
    const keys = validateExactKeys(record);
    ensureDirectory(this.root, "operation receipt root");
    const profileDirectory = path.join(this.root, keys.profileDirectory);
    ensureDirectory(profileDirectory, "operation receipt profile directory");
    const runDirectory = path.join(this.root, keys.runDirectory);
    ensureDirectory(runDirectory, "operation receipt run directory");
    const finalPath = indexedReceiptPath(this.root, keys.finalPath, "receipt final key");
    const tempPath = indexedReceiptPath(this.root, keys.tempPath, "receipt temporary key");
    const finalExists = existsSync(finalPath);
    const tempExists = existsSync(tempPath);
    if (finalExists && tempExists) {
      throw new OperationReceiptError(
        "receipt_state_mismatch",
        "both receipt temp and final exist; refusing ambiguous third state"
      );
    }
    if (finalExists) {
      if (!fileMatches(finalPath, record)) {
        throw new OperationReceiptError(
          "receipt_hash_mismatch",
          "receipt final file mismatches index"
        );
      }
      if (record.state !== "published") {
        if (record.state === "preparing")
          this.input.checkpointer.operationReceiptMarkStaged(record.receipt_id);
        this.hit("before_receipt_db_publish");
        this.input.checkpointer.commitOperationReceipt(record.receipt_id);
      }
      return;
    }
    if (record.state === "published") {
      // Exact missing-file recovery: reconstruct only from stored receipt_jcs,
      // at the exact derived temp/final key. No scan and no alternate adoption.
      if (tempExists) {
        if (!fileMatches(tempPath, record)) {
          throw new OperationReceiptError(
            "receipt_hash_mismatch",
            "published receipt recovery temp mismatches its index"
          );
        }
      } else {
        writeExactTemp(tempPath, Buffer.from(record.receipt_jcs, "utf8"));
        this.hit("after_receipt_temp_fsync");
      }
      renameSync(tempPath, finalPath);
      fsyncDirectory(runDirectory);
      this.hit("after_receipt_parent_fsync");
      if (!fileMatches(finalPath, record)) {
        throw new OperationReceiptError("receipt_hash_mismatch", "recreated receipt mismatch");
      }
      return;
    }
    if (tempExists) {
      if (!fileMatches(tempPath, record)) {
        throw new OperationReceiptError(
          "receipt_hash_mismatch",
          "receipt temp file mismatches index"
        );
      }
    } else {
      writeExactTemp(tempPath, Buffer.from(record.receipt_jcs, "utf8"));
      this.hit("after_receipt_temp_fsync");
    }
    if (record.state === "preparing") {
      this.input.checkpointer.operationReceiptMarkStaged(record.receipt_id);
    }
    this.hit("after_receipt_staged");
    renameSync(tempPath, finalPath);
    this.hit("after_receipt_rename");
    fsyncDirectory(runDirectory);
    this.hit("after_receipt_parent_fsync");
    if (!fileMatches(finalPath, record)) {
      throw new OperationReceiptError("receipt_hash_mismatch", "published receipt file mismatch");
    }
    this.hit("before_receipt_db_publish");
    this.input.checkpointer.commitOperationReceipt(record.receipt_id);
  }

  private hit(boundary: string): void {
    this.input.fault?.(boundary);
  }
}

/** Local SHA-256 over exact UTF-8 bytes. */
function awaitlessSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
