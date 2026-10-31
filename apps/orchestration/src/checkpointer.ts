import { assertSupportedSqliteVersion } from "./state/sqlite-runtime.js";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "./canonical-json.js";
import { projectChildGate } from "./child-workflows/gates.js";
import {
  childWorkflowCallImmutableJcs,
  decodeStoredChildWorkflowCallRow,
  encodeChildWorkflowCallRecord,
  isLegalChildWorkflowCallTransition,
  verifyChildWorkflowArtifactCustody,
  type StoredChildWorkflowCallRowV1,
} from "./child-workflows/storage.js";
import type {
  ChildWorkflowCallRecord,
  ChildWorkflowLifecycleV1,
} from "./child-workflows/contracts.js";
import {
  decodeStoredHostOperationCallRow,
  encodeHostOperationCallRecord,
  hostOperationCallImmutableJcs,
  isLegalHostOperationCallTransition,
  verifyHostOperationArtifactCustody,
  type StoredHostOperationCallRowV1,
} from "./host-operations/storage.js";
import type {
  HostOperationCallRecordV1,
  HostOperationLifecycleV1,
} from "./host-operations/contracts.js";
import { RunContext } from "./context.js";
import {
  CompletionAdmissionEnvelopeSchema,
  CompletionEvidenceRefSchema,
  CompletionRefusalEvidenceSchema,
  JsonValueSchema,
  PhaseResultSchema,
  StateVisitSchema,
  isTerminalStatus,
  validateContract,
} from "./contracts.js";
import type {
  ArtifactRef,
  CompletionAdmissionEnvelope,
  CompletionEvidenceRef,
  CompletionRefusalEvidence,
  ExecutionReceipt,
  JsonValue,
  PhaseResult,
  RunIdentity,
  StateVisit,
  StateVisitRef,
} from "./contracts.js";
import { CheckpointIdentityError, orchestrationDurableStateCodec } from "./durable-state.js";
import type { GenericGateResponseStorageModeV1 } from "./playbooks/playbook.js";

export { CheckpointIdentityError } from "./durable-state.js";
import {
  packetDigest,
  validateContentReviewPacket,
  validateContentReviewReceipt,
} from "./kb/content-review.js";
import {
  ArtifactKindSchema,
  ArtifactMediaTypeSchema,
  ContentReviewStoreStateSchema,
  CurrentGenerationSchema,
  InitReservationSchema,
  IdempotencyRecordSchema,
  KbArtifactHandleSchema,
  KbComposeAuthoritySchema,
  KbPublicationTransactionSchema,
  OpaqueIdSchema,
  OperationEventGroupSchema,
  OperationReceiptIndexRecordSchema,
  PrivateRunInputRecordSchema,
  PublicationFileRecordSchema,
  ReplayableKnowledgeBaseResultSchema,
  Sha256HexSchema,
  validateKbContract,
} from "./kb/contracts.js";
import type {
  ContentReviewDecisionReceipt,
  ContentReviewGatePacket,
  ContentReviewStoreState,
  CurrentGeneration,
  InitReservation,
  KbPublicationTransaction,
  PublicationFileRecord,
  PublicationLifecycle,
  OperationAction,
  OperationEventGroup,
  OperationEventSource,
  OperationReceiptIndexRecord,
  ReplayableKnowledgeBaseResult,
  TerminalResultRecord,
  ArtifactKind,
  ArtifactMediaType,
  KbArtifactHandle,
  KbComposeAuthority,
  IdempotencyRecord,
  PrivateRunInputRecord,
  StartKbAction,
} from "./kb/contracts.js";
import type { PromotionControlApprovalBinding } from "./kb/promotion.js";
import { assertOwnerDirectory, assertOwnerFile, pathExistsNoFollow } from "./state/custody.js";
import { PENNY_STATE_LAYOUT_VERSION, PROJECT_ID_PATTERN } from "./state/paths.js";
import { assertSqliteHealthy, openReadOnlySqliteDatabase } from "./state/sqlite-health.js";

export { canonicalJson, sha256 } from "./canonical-json.js";

export const ORCHESTRATION_DATABASE_SCHEMA_VERSION = 13 as const;
export const ORCHESTRATION_UPGRADE_SOURCE_VERSIONS = [10, 11, 12] as const;

export class OrchestrationSchemaCompatibilityError extends Error {
  readonly code = "ORCHESTRATION_SCHEMA_INCOMPATIBLE";
  readonly component = "orchestration";
  readonly requiredVersion = ORCHESTRATION_DATABASE_SCHEMA_VERSION;
  readonly upgradeSupported: boolean;

  constructor(readonly actualVersion: number) {
    const upgradeSupported = ORCHESTRATION_UPGRADE_SOURCE_VERSIONS.some(
      (version) => version === actualVersion
    );
    super(
      upgradeSupported
        ? `orchestration schema ${actualVersion} is not current; run penny-state upgrade --project-root=PATH --backup-dir=PATH`
        : `orchestration schema ${actualVersion} is not supported by this runtime (required ${ORCHESTRATION_DATABASE_SCHEMA_VERSION})`
    );
    this.name = "OrchestrationSchemaCompatibilityError";
    this.upgradeSupported = upgradeSupported;
  }
}

export interface OrchestrationSchemaInspection {
  readonly actualVersion: number;
  readonly requiredVersion: number;
  readonly upgradeRequired: boolean;
  readonly upgradeSupported: boolean;
}

export interface OrchestrationSchemaUpgradeResult {
  readonly sourceVersion: number;
  readonly targetVersion: number;
  readonly changed: boolean;
}

const REQUIRED_ORCHESTRATION_COLUMNS = {
  host_operation_calls: [
    "operation_record_id",
    "project_id",
    "run_id",
    "state_id",
    "attempt",
    "operation_id",
    "lifecycle",
    "record_jcs",
    "record_sha256",
    "created_at",
    "updated_at",
  ],
  child_workflow_calls: [
    "call_id",
    "schema_version",
    "parent_run_id",
    "parent_state_id",
    "parent_visit_sequence",
    "parent_visit_offset",
    "call_key",
    "child_run_id",
    "lifecycle",
    "record_jcs",
    "record_sha256",
    "created_at",
    "updated_at",
  ],
  content_reviews: ["challenge_id", "run_id", "packet_sha256", "packet_jcs", "state"],
  events: ["run_id", "sequence", "event_type", "payload_json", "created_at"],
  gates: ["run_id", "gate_id", "state_id", "challenge", "status"],
  kb_init_reservations: ["kb_profile_id", "run_id", "transaction_id", "state"],
  kb_phase_operands: ["run_id", "state_id", "operands_jcs", "operands_sha256", "lifecycle"],
  kb_phase_results: ["phase_result_id", "run_id", "state_id", "result_jcs", "result_sha256"],
  kb_publication_files: ["publication_file_id", "transaction_id", "role", "state"],
  kb_publication_transactions: ["transaction_id", "run_id", "kb_profile_id", "lifecycle"],
  kb_run_artifacts: ["artifact_id", "run_id", "state_id", "artifact_kind", "lifecycle"],
  operation_event_groups: ["request_event_group_id", "run_id", "action", "state"],
  operation_receipt_index: ["receipt_id", "run_id", "action", "receipt_jcs", "state"],
  private_inputs: ["private_input_id", "run_id", "request_sha256", "storage_key", "state"],
  receipts: ["receipt_id", "run_id", "state_id", "branch_id", "result_json"],
  runs: [
    "run_id",
    "session_id",
    "playbook",
    "engine_owner",
    "schema_version",
    "status",
    "state_id",
    "context_json",
    "created_at",
    "updated_at",
  ],
  start_admissions: ["run_id", "session_id", "invocation_id", "request_sha256", "state"],
  store_metadata: ["singleton", "project_id", "state_layout_version", "created_at"],
  terminal_results: [
    "terminal_result_id",
    "run_id",
    "idempotency_transaction_id",
    "operation_receipt_id",
    "result_jcs",
    "result_sha256",
    "created_at",
  ],
} as const;
const REQUIRED_ORCHESTRATION_TABLES = Object.keys(REQUIRED_ORCHESTRATION_COLUMNS);

type CheckpointerOpenMode =
  | "provision"
  | "migration-target"
  | "existing"
  | "verify"
  | "upgrade-inspect"
  | "upgrade";

export interface CheckpointerOptions {
  readonly maxRetainedRuns?: number;
  readonly projectId?: string;
}

const CheckpointEventPayloadSchema = Type.Record(Type.String(), JsonValueSchema);
const RESERVED_COMPLETION_EVENT_KEYS = new Set([
  "state_visits_v1",
  "completion_admission_v1",
  "completion_refusal_v1",
]);

interface RunRow extends Record<string, SQLOutputValue> {
  run_id: string;
  session_id: string;
  playbook: string;
  engine_owner: string;
  schema_version: number;
  context_json: string;
}

interface ReceiptRow extends Record<string, SQLOutputValue> {
  receipt_id: string;
  result_json: string;
}

interface GateRow extends Record<string, SQLOutputValue> {
  gate_id: string;
  challenge: string;
  status: string;
  response_digest: string | null;
  response_json: string | null;
}

interface ContentReviewRow extends Record<string, SQLOutputValue> {
  challenge_id: string;
  run_id: string;
  packet_sha256: string;
  packet_jcs: string;
  state: string;
  decision_receipt_jcs: string | null;
  decision_receipt_sha256: string | null;
  receipt_id: string | null;
  transaction_id: string | null;
  updated_at: string;
}

interface InitReservationRow extends Record<string, SQLOutputValue> {
  kb_profile_id: string;
  run_id: string;
  transaction_id: string;
  request_sha256: string;
  profile_commitment_sha256: string;
  kb_id: string;
  generation_id: string;
  state: string;
  updated_at: string;
}

export interface ContentReviewRecord {
  readonly challenge_id: string;
  readonly run_id: string;
  readonly packet_sha256: string;
  readonly packet_jcs: string;
  readonly packet: ContentReviewGatePacket;
  readonly state: ContentReviewStoreState;
  readonly decision_receipt_jcs?: string;
  readonly decision_receipt_sha256?: string;
  readonly decision_receipt?: ContentReviewDecisionReceipt;
  readonly receipt_id?: string;
  readonly transaction_id?: string;
  readonly updated_at: string;
}

export interface CheckpointObservation {
  readonly identity: RunIdentity;
  readonly status: string;
  readonly stateId: string;
  readonly eventType: string;
  readonly payload: Record<string, JsonValue>;
  readonly sequence: number;
  readonly timestamp: string;
}

export type CheckpointObserver = (observation: CheckpointObservation) => void;

export interface CheckpointEvent {
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: Record<string, JsonValue>;
  readonly createdAt: string;
}

export class ReceiptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptConflictError";
  }
}

export class GateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateConflictError";
  }
}

export class ChildWorkflowCallConflictError extends Error {
  readonly code = "child_workflow_call_conflict";

  constructor(message: string) {
    super(message);
    this.name = "ChildWorkflowCallConflictError";
  }
}

export interface ReserveChildWorkflowCallInput {
  readonly record: ChildWorkflowCallRecord;
  readonly childContext: RunContext;
  /** Atomic capacity bounds required for every lease-bound new call. */
  readonly admission?: {
    readonly max_calls: number;
    readonly max_active_children: number;
    readonly project_concurrency_limit: number;
  };
  /** Opaque runtime-verified artifact-store custody capability required before mutation. */
  readonly custody: unknown;
}

export type ReserveChildWorkflowCallOutcome =
  | { readonly kind: "created"; readonly record: ChildWorkflowCallRecord }
  | { readonly kind: "adopted"; readonly record: ChildWorkflowCallRecord };

export interface TransitionChildWorkflowCallInput {
  readonly call_id: string;
  readonly from: ChildWorkflowLifecycleV1;
  readonly next: ChildWorkflowCallRecord;
  /** Only the exact projected child gate may replace the parent suspension. */
  readonly parentContext?: RunContext;
  /** Opaque runtime-verified artifact-store custody capability required before mutation. */
  readonly custody: unknown;
}

/**
 * The sole parent-result commit boundary. The child terminal record and its immutable output are
 * already durable; this transaction advances the parent and marks that exact logical call consumed
 * together so a replay cannot route the parent twice.
 */
export interface ConsumeChildWorkflowCallInput {
  readonly call_id: string;
  readonly next: ChildWorkflowCallRecord;
  readonly parentContext: RunContext;
  readonly expected_parent_snapshot_sha256?: string;
  readonly eventType: string;
  readonly payload: Record<string, JsonValue>;
  /** Opaque runtime-verified artifact-store custody capability required before mutation. */
  readonly custody: unknown;
}

export class HostOperationCallConflictError extends Error {
  readonly code = "host_operation_call_conflict";

  constructor(message: string) {
    super(message);
    this.name = "HostOperationCallConflictError";
  }
}

export interface ReserveHostOperationCallInput {
  readonly record: HostOperationCallRecordV1;
  readonly custody: unknown;
}

export type ReserveHostOperationCallOutcome =
  | { readonly kind: "created"; readonly record: HostOperationCallRecordV1 }
  | { readonly kind: "adopted"; readonly record: HostOperationCallRecordV1 };

export interface TransitionHostOperationCallInput {
  readonly operation_record_id: string;
  readonly from: HostOperationLifecycleV1;
  readonly expected_record_sha256: string;
  readonly next: HostOperationCallRecordV1;
  readonly custody: unknown;
}

export interface ConsumeHostOperationCallInput {
  readonly operation_record_id: string;
  readonly expected_record_sha256: string;
  readonly next: HostOperationCallRecordV1;
  readonly parentContext: RunContext;
  readonly expected_parent_snapshot_sha256?: string;
  readonly eventType: string;
  readonly payload: Record<string, JsonValue>;
  readonly custody: unknown;
}

function requiredCheckpointValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new ReceiptConflictError(`${label} is absent after its durable mutation`);
  }
  return value;
}

/**
 * §5.6 idempotency: the same (session_id, invocation_id) pair was admitted with
 * a different request digest. Nothing may be created or resumed for the new
 * request; the host converts this to the public `idempotency_mismatch` refusal.
 */
export class StartAdmissionMismatchError extends Error {
  readonly code = "idempotency_mismatch";
  constructor(message: string) {
    super(message);
    this.name = "StartAdmissionMismatchError";
  }
}

/**
 * The durable private-input and idempotency records of one admitted start run
 * (§5.6 `PrivateRunInputRecordV1` / `IdempotencyRecordV1`). Metadata only:
 * digests, host-allocated keys, states — never request bytes.
 */
export interface StartAdmissionInput {
  /** The authenticated host session (§5.6 same-session binding). */
  readonly session_id: string;
  /** The host invocation identity (per tool call), never model-supplied. */
  readonly invocation_id: string;
  /** SHA-256(JCS(validated request)). */
  readonly request_sha256: string;
  /** The exact start-action enum; part of the record, not a key. */
  readonly action: StartKbAction;
  /** The resolved opaque profile id. */
  readonly profile_id: string;
  /** Host-random transaction id, durable before side effects. */
  readonly transaction_id: string;
  /** Host-allocated private-input id. */
  readonly private_input_id: string;
  /** Exactly `<run_id>/request.json` under the trusted input root. */
  readonly storage_key: string;
  /** The host-allocated temporary key, `<run_id>/.<transaction_id>.tmp`. */
  readonly temporary_storage_key: string;
}

export type StartAdmissionOutcome =
  /** The run rows were created in this admission transaction. */
  | { readonly kind: "created"; readonly run_id: string }
  /** The same session/invocation/digest was already admitted; replay it. */
  | { readonly kind: "replay"; readonly run_id: string };

interface AdmissionRow extends Record<string, SQLOutputValue> {
  run_id: string;
  session_id: string;
  invocation_id: string;
  request_sha256: string;
  action: string;
  profile_id: string;
  transaction_id: string;
  state: string;
  terminal_result_id: string | null;
  terminal_result_sha256: string | null;
  created_at: string;
  updated_at: string;
}

interface PrivateInputRow extends Record<string, SQLOutputValue> {
  private_input_id: string;
  run_id: string;
  request_sha256: string;
  storage_key: string;
  temporary_storage_key: string | null;
  state: string;
  created_at: string;
  updated_at: string;
}

interface OperationGroupRow extends Record<string, SQLOutputValue> {
  request_event_group_id: string;
  run_id: string;
  session_id: string;
  transaction_id: string;
  action: string;
  source_kind: string;
  source_identity_sha256: string;
  event_sequence: number;
  state: string;
  receipt_id: string | null;
  replay_result_jcs: string | null;
  replay_result_sha256: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationReceiptRow extends Record<string, SQLOutputValue> {
  receipt_id: string;
  run_id: string;
  session_id: string;
  kb_profile_id: string;
  kb_id: string | null;
  action: string;
  event: string;
  transaction_id: string;
  request_event_group_id: string;
  event_sequence: number;
  source_kind: string;
  source_identity_sha256: string;
  receipt_jcs: string;
  temporary_storage_key: string | null;
  final_storage_key: string;
  sha256: string;
  byte_length: number;
  state: string;
  created_at: string;
  updated_at: string;
}

interface TerminalResultRow extends Record<string, SQLOutputValue> {
  terminal_result_id: string;
  run_id: string;
  idempotency_transaction_id: string;
  operation_receipt_id: string;
  result_jcs: string;
  result_sha256: string;
  created_at: string;
}

interface KbArtifactRow extends Record<string, SQLOutputValue> {
  artifact_id: string;
  run_id: string;
  state_id: string;
  kb_profile_id: string;
  artifact_kind: string;
  media_type: string;
  sha256: string;
  byte_length: number;
  storage_key: string;
  temporary_storage_key: string | null;
  lifecycle: string;
  created_at: string;
  updated_at: string;
}

interface KbPhaseOperandsRow extends Record<string, SQLOutputValue> {
  run_id: string;
  state_id: string;
  operands_jcs: string;
  operands_sha256: string;
  lifecycle: string;
  closed_result_sha256: string | null;
  created_at: string;
  closed_at: string | null;
}

interface KbPhaseResultRow extends Record<string, SQLOutputValue> {
  phase_result_id: string;
  run_id: string;
  state_id: string;
  result_jcs: string;
  result_sha256: string;
  artifact_ids_jcs: string;
  created_at: string;
}

const KbArtifactLifecycleSchema = Type.Union([
  Type.Literal("prepared"),
  Type.Literal("staged"),
  Type.Literal("sealed"),
  Type.Literal("consumed"),
  Type.Literal("discarding"),
  Type.Literal("discarded"),
]);
export type KbArtifactLifecycle = Static<typeof KbArtifactLifecycleSchema>;

/** Body-free authoritative metadata for bytes held in the KB work plane. */
export interface KbArtifactIndexRecord {
  readonly schema_version: 1;
  readonly artifact_id: string;
  readonly run_id: string;
  readonly state_id: string;
  readonly kb_profile_id: string;
  readonly artifact_kind: ArtifactKind;
  readonly media_type: ArtifactMediaType;
  readonly sha256: string;
  readonly byte_length: number;
  readonly storage_key: string;
  readonly temporary_storage_key?: string;
  readonly lifecycle: KbArtifactLifecycle;
  readonly created_at: string;
  readonly updated_at: string;
}

const KbPhaseArtifactOperandSchema = Type.Object(
  {
    run_id: OpaqueIdSchema,
    state_id: OpaqueIdSchema,
    handle: KbArtifactHandleSchema,
  },
  { additionalProperties: false }
);
export type KbPhaseArtifactOperand = Readonly<Static<typeof KbPhaseArtifactOperandSchema>>;

const KbPhaseSelectedPageSchema = Type.Object(
  { page_id: OpaqueIdSchema, revision_id: OpaqueIdSchema },
  { additionalProperties: false }
);

/** Closed, body-free operands frozen before one KB child phase is dispatched. */
const KbPhaseOperandsSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    state_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    operation: Type.Union([
      Type.Literal("ingest"),
      Type.Literal("query"),
      Type.Literal("save"),
      Type.Literal("promote"),
    ]),
    agent: Type.Union([
      Type.Literal("echo"),
      Type.Literal("synthia"),
      Type.Literal("carren"),
      Type.Literal("vera"),
      Type.Literal("piper"),
      Type.Literal("skribble"),
    ]),
    expected_artifact_kind: ArtifactKindSchema,
    expected_media_type: ArtifactMediaTypeSchema,
    source_ids: Type.Array(OpaqueIdSchema, { maxItems: 64 }),
    prior_state_ids: Type.Array(OpaqueIdSchema, { maxItems: 8 }),
    allowed_prior_artifacts: Type.Array(KbPhaseArtifactOperandSchema, { maxItems: 8 }),
    allowed_selected_pages: Type.Array(KbPhaseSelectedPageSchema, { maxItems: 64 }),
    private_input_sha256: Sha256HexSchema,
    admitted_policy_sha256: Sha256HexSchema,
    /** Present only for compose; all stable advisory identity authority lives here. */
    compose_authority: Type.Optional(KbComposeAuthoritySchema),
  },
  { additionalProperties: false }
);
type KbPhaseOperandsContract = Static<typeof KbPhaseOperandsSchema>;
export type KbPhaseOperands = Readonly<
  Omit<
    KbPhaseOperandsContract,
    "source_ids" | "prior_state_ids" | "allowed_prior_artifacts" | "allowed_selected_pages"
  >
> & {
  readonly source_ids: readonly string[];
  readonly prior_state_ids: readonly string[];
  readonly allowed_prior_artifacts: readonly KbPhaseArtifactOperand[];
  readonly allowed_selected_pages: readonly Readonly<Static<typeof KbPhaseSelectedPageSchema>>[];
};

export interface KbPhaseOperandsRecord {
  readonly schema_version: 1;
  readonly operands: KbPhaseOperands;
  readonly operands_sha256: string;
  readonly lifecycle: "open" | "closed";
  readonly created_at: string;
  readonly closed_result_sha256?: string;
  readonly closed_at?: string;
}

export interface KbPhaseResultRecord {
  readonly phase_result_id: string;
  readonly run_id: string;
  readonly state_id: string;
  readonly result_jcs: string;
  readonly result_sha256: string;
  readonly artifact_ids: readonly string[];
  readonly created_at: string;
}

export interface PrepareKbArtifactInput extends KbArtifactIndexRecord {
  readonly lifecycle: "prepared";
  readonly temporary_storage_key: string;
}

export type PrivateInputRecord = PrivateRunInputRecord;
export type StartAdmissionRecord = IdempotencyRecord;

export interface ReserveOperationEventGroupInput {
  readonly run_id: string;
  readonly session_id: string;
  readonly transaction_id: string;
  readonly action: OperationAction;
  readonly source_kind: OperationEventSource;
  readonly source_identity_sha256: string;
}

export interface PrepareOperationOutcomeInput {
  readonly group: OperationEventGroup;
  readonly receipt: OperationReceiptIndexRecord;
  readonly replay_result: ReplayableKnowledgeBaseResult;
}

/**
 * Hash one closed host-owned source identity. The identity object itself is not
 * persisted; only this digest enters the content-free event group.
 */
export function operationSourceIdentitySha256(value: Record<string, unknown>): string {
  return sha256(canonicalJson(value));
}

type SqliteRow = Record<string, SQLOutputValue>;

interface SqliteRuntimeModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isSqliteRuntimeModule(value: unknown): value is SqliteRuntimeModule {
  return isUnknownRecord(value) && typeof value["DatabaseSync"] === "function";
}

function sqliteModule(): SqliteRuntimeModule {
  assertSupportedSqliteVersion(process.versions.sqlite);
  const module: unknown = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteRuntimeModule(module)) {
    throw new Error("Node.js runtime does not provide node:sqlite");
  }
  return module;
}

function malformedSqliteColumn(label: string, column: string): never {
  throw new CheckpointIdentityError(`${label} has an invalid SQLite '${column}' column`);
}

function sqliteText(row: SqliteRow, column: string, label: string): string {
  const value = row[column];
  return typeof value === "string" ? value : malformedSqliteColumn(label, column);
}

function sqliteNullableText(row: SqliteRow, column: string, label: string): string | null {
  const value = row[column];
  return value === null || typeof value === "string" ? value : malformedSqliteColumn(label, column);
}

function sqliteInteger(row: SqliteRow, column: string, label: string): number {
  const value = row[column];
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number)
    ? number
    : malformedSqliteColumn(label, column);
}

function runRow(row: SqliteRow): RunRow {
  const label = "stored orchestration run";
  return {
    run_id: sqliteText(row, "run_id", label),
    session_id: sqliteText(row, "session_id", label),
    playbook: sqliteText(row, "playbook", label),
    engine_owner: sqliteText(row, "engine_owner", label),
    schema_version: sqliteInteger(row, "schema_version", label),
    context_json: sqliteText(row, "context_json", label),
  };
}

function childWorkflowCallRow(row: SqliteRow): StoredChildWorkflowCallRowV1 {
  return {
    call_id: row["call_id"],
    schema_version: row["schema_version"],
    parent_run_id: row["parent_run_id"],
    parent_state_id: row["parent_state_id"],
    parent_visit_sequence: row["parent_visit_sequence"],
    parent_visit_offset: row["parent_visit_offset"],
    call_key: row["call_key"],
    child_run_id: row["child_run_id"],
    lifecycle: row["lifecycle"],
    record_jcs: row["record_jcs"],
    record_sha256: row["record_sha256"],
    created_at: row["created_at"],
    updated_at: row["updated_at"],
  };
}

function hostOperationCallRow(row: SqliteRow): StoredHostOperationCallRowV1 {
  return {
    operation_record_id: row["operation_record_id"],
    project_id: row["project_id"],
    run_id: row["run_id"],
    state_id: row["state_id"],
    attempt: row["attempt"],
    operation_id: row["operation_id"],
    lifecycle: row["lifecycle"],
    record_jcs: row["record_jcs"],
    record_sha256: row["record_sha256"],
    created_at: row["created_at"],
    updated_at: row["updated_at"],
  };
}

function receiptRow(row: SqliteRow): ReceiptRow {
  const label = "stored execution receipt";
  return {
    receipt_id: sqliteText(row, "receipt_id", label),
    result_json: sqliteText(row, "result_json", label),
  };
}

function gateRow(row: SqliteRow): GateRow {
  const label = "stored orchestration gate";
  return {
    gate_id: sqliteText(row, "gate_id", label),
    challenge: sqliteText(row, "challenge", label),
    status: sqliteText(row, "status", label),
    response_digest: sqliteNullableText(row, "response_digest", label),
    response_json: sqliteNullableText(row, "response_json", label),
  };
}

function contentReviewRow(row: SqliteRow): ContentReviewRow {
  const label = "stored content review";
  return {
    challenge_id: sqliteText(row, "challenge_id", label),
    run_id: sqliteText(row, "run_id", label),
    packet_sha256: sqliteText(row, "packet_sha256", label),
    packet_jcs: sqliteText(row, "packet_jcs", label),
    state: sqliteText(row, "state", label),
    decision_receipt_jcs: sqliteNullableText(row, "decision_receipt_jcs", label),
    decision_receipt_sha256: sqliteNullableText(row, "decision_receipt_sha256", label),
    receipt_id: sqliteNullableText(row, "receipt_id", label),
    transaction_id: sqliteNullableText(row, "transaction_id", label),
    updated_at: sqliteText(row, "updated_at", label),
  };
}

function initReservationRow(row: SqliteRow): InitReservationRow {
  const label = "stored KB init reservation";
  return {
    kb_profile_id: sqliteText(row, "kb_profile_id", label),
    run_id: sqliteText(row, "run_id", label),
    transaction_id: sqliteText(row, "transaction_id", label),
    request_sha256: sqliteText(row, "request_sha256", label),
    profile_commitment_sha256: sqliteText(row, "profile_commitment_sha256", label),
    kb_id: sqliteText(row, "kb_id", label),
    generation_id: sqliteText(row, "generation_id", label),
    state: sqliteText(row, "state", label),
    updated_at: sqliteText(row, "updated_at", label),
  };
}

function admissionRow(row: SqliteRow): AdmissionRow {
  const label = "stored start admission";
  return {
    run_id: sqliteText(row, "run_id", label),
    session_id: sqliteText(row, "session_id", label),
    invocation_id: sqliteText(row, "invocation_id", label),
    request_sha256: sqliteText(row, "request_sha256", label),
    action: sqliteText(row, "action", label),
    profile_id: sqliteText(row, "profile_id", label),
    transaction_id: sqliteText(row, "transaction_id", label),
    state: sqliteText(row, "state", label),
    terminal_result_id: sqliteNullableText(row, "terminal_result_id", label),
    terminal_result_sha256: sqliteNullableText(row, "terminal_result_sha256", label),
    created_at: sqliteText(row, "created_at", label),
    updated_at: sqliteText(row, "updated_at", label),
  };
}

function privateInputRow(row: SqliteRow): PrivateInputRow {
  const label = "stored private run input";
  return {
    private_input_id: sqliteText(row, "private_input_id", label),
    run_id: sqliteText(row, "run_id", label),
    request_sha256: sqliteText(row, "request_sha256", label),
    storage_key: sqliteText(row, "storage_key", label),
    temporary_storage_key: sqliteNullableText(row, "temporary_storage_key", label),
    state: sqliteText(row, "state", label),
    created_at: sqliteText(row, "created_at", label),
    updated_at: sqliteText(row, "updated_at", label),
  };
}

function operationGroupRow(row: SqliteRow): OperationGroupRow {
  const label = "stored operation event group";
  return {
    request_event_group_id: sqliteText(row, "request_event_group_id", label),
    run_id: sqliteText(row, "run_id", label),
    session_id: sqliteText(row, "session_id", label),
    transaction_id: sqliteText(row, "transaction_id", label),
    action: sqliteText(row, "action", label),
    source_kind: sqliteText(row, "source_kind", label),
    source_identity_sha256: sqliteText(row, "source_identity_sha256", label),
    event_sequence: sqliteInteger(row, "event_sequence", label),
    state: sqliteText(row, "state", label),
    receipt_id: sqliteNullableText(row, "receipt_id", label),
    replay_result_jcs: sqliteNullableText(row, "replay_result_jcs", label),
    replay_result_sha256: sqliteNullableText(row, "replay_result_sha256", label),
    created_at: sqliteText(row, "created_at", label),
    updated_at: sqliteText(row, "updated_at", label),
  };
}

function operationReceiptRow(row: SqliteRow): OperationReceiptRow {
  const label = "stored operation receipt";
  return {
    receipt_id: sqliteText(row, "receipt_id", label),
    run_id: sqliteText(row, "run_id", label),
    session_id: sqliteText(row, "session_id", label),
    kb_profile_id: sqliteText(row, "kb_profile_id", label),
    kb_id: sqliteNullableText(row, "kb_id", label),
    action: sqliteText(row, "action", label),
    event: sqliteText(row, "event", label),
    transaction_id: sqliteText(row, "transaction_id", label),
    request_event_group_id: sqliteText(row, "request_event_group_id", label),
    event_sequence: sqliteInteger(row, "event_sequence", label),
    source_kind: sqliteText(row, "source_kind", label),
    source_identity_sha256: sqliteText(row, "source_identity_sha256", label),
    receipt_jcs: sqliteText(row, "receipt_jcs", label),
    temporary_storage_key: sqliteNullableText(row, "temporary_storage_key", label),
    final_storage_key: sqliteText(row, "final_storage_key", label),
    sha256: sqliteText(row, "sha256", label),
    byte_length: sqliteInteger(row, "byte_length", label),
    state: sqliteText(row, "state", label),
    created_at: sqliteText(row, "created_at", label),
    updated_at: sqliteText(row, "updated_at", label),
  };
}

function terminalResultRow(row: SqliteRow): TerminalResultRow {
  const label = "stored terminal result";
  return {
    terminal_result_id: sqliteText(row, "terminal_result_id", label),
    run_id: sqliteText(row, "run_id", label),
    idempotency_transaction_id: sqliteText(row, "idempotency_transaction_id", label),
    operation_receipt_id: sqliteText(row, "operation_receipt_id", label),
    result_jcs: sqliteText(row, "result_jcs", label),
    result_sha256: sqliteText(row, "result_sha256", label),
    created_at: sqliteText(row, "created_at", label),
  };
}

function kbArtifactRow(row: SqliteRow): KbArtifactRow {
  const label = "stored KB artifact";
  return {
    artifact_id: sqliteText(row, "artifact_id", label),
    run_id: sqliteText(row, "run_id", label),
    state_id: sqliteText(row, "state_id", label),
    kb_profile_id: sqliteText(row, "kb_profile_id", label),
    artifact_kind: sqliteText(row, "artifact_kind", label),
    media_type: sqliteText(row, "media_type", label),
    sha256: sqliteText(row, "sha256", label),
    byte_length: sqliteInteger(row, "byte_length", label),
    storage_key: sqliteText(row, "storage_key", label),
    temporary_storage_key: sqliteNullableText(row, "temporary_storage_key", label),
    lifecycle: sqliteText(row, "lifecycle", label),
    created_at: sqliteText(row, "created_at", label),
    updated_at: sqliteText(row, "updated_at", label),
  };
}

function kbPhaseOperandsRow(row: SqliteRow): KbPhaseOperandsRow {
  const label = "stored KB phase operands";
  return {
    run_id: sqliteText(row, "run_id", label),
    state_id: sqliteText(row, "state_id", label),
    operands_jcs: sqliteText(row, "operands_jcs", label),
    operands_sha256: sqliteText(row, "operands_sha256", label),
    lifecycle: sqliteText(row, "lifecycle", label),
    closed_result_sha256: sqliteNullableText(row, "closed_result_sha256", label),
    created_at: sqliteText(row, "created_at", label),
    closed_at: sqliteNullableText(row, "closed_at", label),
  };
}

function kbPhaseResultRow(row: SqliteRow): KbPhaseResultRow {
  const label = "stored KB phase result";
  return {
    phase_result_id: sqliteText(row, "phase_result_id", label),
    run_id: sqliteText(row, "run_id", label),
    state_id: sqliteText(row, "state_id", label),
    result_jcs: sqliteText(row, "result_jcs", label),
    result_sha256: sqliteText(row, "result_sha256", label),
    artifact_ids_jcs: sqliteText(row, "artifact_ids_jcs", label),
    created_at: sqliteText(row, "created_at", label),
  };
}

function now(): string {
  return new Date().toISOString();
}

function assertKbPhaseResultBodyFree(resultJcs: string): void {
  if (Buffer.byteLength(resultJcs, "utf8") > 65_536) {
    throw new ReceiptConflictError("KB phase result metadata is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJcs);
  } catch {
    throw new ReceiptConflictError("KB phase result metadata is not JSON");
  }
  if (canonicalJson(parsed) !== resultJcs) {
    throw new ReceiptConflictError("KB phase result metadata is not canonical JSON");
  }
  const forbidden = new Set([
    "body",
    "content",
    "content_utf8",
    "markdown",
    "path",
    "relative_path",
    "replacement_utf8",
    "root",
    "locator",
  ]);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isUnknownRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) {
        throw new ReceiptConflictError("KB phase result metadata contains a body or locator");
      }
      visit(child);
    }
  };
  visit(parsed);
}

function validateKbPhaseOperandsMetadata(value: unknown): KbPhaseOperands {
  let input: KbPhaseOperands;
  try {
    input = validateKbContract(KbPhaseOperandsSchema, value, "KB phase operands");
  } catch {
    throw new ReceiptConflictError("KB phase operands are not closed body-free metadata");
  }
  const exactKeys = [
    "admitted_policy_sha256",
    "agent",
    "allowed_prior_artifacts",
    "allowed_selected_pages",
    ...(input.compose_authority === undefined ? [] : ["compose_authority"]),
    "expected_artifact_kind",
    "expected_media_type",
    "kb_profile_id",
    "operation",
    "prior_state_ids",
    "private_input_sha256",
    "run_id",
    "schema_version",
    "session_id",
    "source_ids",
    "state_id",
  ];
  const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const kinds = new Set([
    "claims",
    "page_draft",
    "query_answer",
    "lint_report",
    "verification_report",
    "promotion_plan",
    "promotion_patch",
  ]);
  if (
    canonicalJson(Object.keys(input).sort()) !== canonicalJson(exactKeys) ||
    input.schema_version !== 1 ||
    ![input.run_id, input.state_id, input.session_id, input.kb_profile_id].every((value) =>
      opaque.test(value)
    ) ||
    !["echo", "synthia", "carren", "vera", "piper", "skribble"].includes(input.agent) ||
    !["ingest", "query", "save", "promote"].includes(input.operation) ||
    !kinds.has(input.expected_artifact_kind) ||
    input.expected_media_type !== "application/json" ||
    !/^[a-f0-9]{64}$/.test(input.admitted_policy_sha256) ||
    !/^[a-f0-9]{64}$/.test(input.private_input_sha256) ||
    input.source_ids.length > 64 ||
    input.prior_state_ids.length > 8 ||
    input.allowed_prior_artifacts.length > 8 ||
    input.allowed_selected_pages.length > 64 ||
    !input.source_ids.every((value) => opaque.test(value)) ||
    !input.prior_state_ids.every((value) => opaque.test(value))
  ) {
    throw new ReceiptConflictError("KB phase operands are not closed body-free metadata");
  }
  const selectedPagePairs = input.allowed_selected_pages.map(
    (page) => `${page.page_id}\u0000${page.revision_id}`
  );
  if (
    new Set(selectedPagePairs).size !== selectedPagePairs.length ||
    input.allowed_selected_pages.some(
      (page) =>
        canonicalJson(Object.keys(page).sort()) !== canonicalJson(["page_id", "revision_id"]) ||
        !opaque.test(page.page_id) ||
        !opaque.test(page.revision_id)
    )
  ) {
    throw new ReceiptConflictError("KB phase selected-page operands are duplicated or malformed");
  }
  const hasComposeAuthority = input.compose_authority !== undefined;
  if (
    (input.state_id === "compose") !== hasComposeAuthority ||
    (hasComposeAuthority &&
      (input.expected_artifact_kind !== "page_draft" ||
        (input.operation !== "ingest" && input.operation !== "save")))
  ) {
    throw new ReceiptConflictError("KB compose authority is absent or attached outside compose");
  }
  if (input.compose_authority !== undefined) {
    let authority: KbComposeAuthority;
    try {
      authority = validateKbContract(
        KbComposeAuthoritySchema,
        input.compose_authority,
        "KB compose authority"
      );
    } catch {
      throw new ReceiptConflictError("KB compose authority is malformed");
    }
    if (input.operation === "save" && authority.allocations.length !== 1) {
      throw new ReceiptConflictError("KB save compose must own exactly one page allocation");
    }
    const selectedPages = new Set<string>();
    for (const selectedPage of authority.selected_pages) {
      if (selectedPages.has(selectedPage.page_id)) {
        throw new ReceiptConflictError("KB compose selected-page bounds are duplicated");
      }
      selectedPages.add(selectedPage.page_id);
    }
    const pages = new Set<string>();
    const revisions = new Set<string>();
    const claims = new Set<string>();
    const candidates = new Set<string>();
    for (const allocation of authority.allocations) {
      if (
        !/^page_[A-Za-z0-9._:-]+$/.test(allocation.page_id) ||
        !/^rev_[A-Za-z0-9._:-]+$/.test(allocation.revision_id) ||
        allocation.lifecycle !== "draft" ||
        pages.has(allocation.page_id) ||
        revisions.has(allocation.revision_id) ||
        new Set(allocation.source_ids).size !== allocation.source_ids.length ||
        (allocation.supersedes !== null &&
          (allocation.supersedes.page_id !== allocation.page_id ||
            allocation.supersedes.revision_id === allocation.revision_id ||
            !selectedPages.has(allocation.page_id)))
      ) {
        throw new ReceiptConflictError("KB compose page allocation is duplicated or invalid");
      }
      pages.add(allocation.page_id);
      revisions.add(allocation.revision_id);
      for (const claim of allocation.claim_allocations) {
        if (
          !/^clm_[A-Za-z0-9._:-]+$/.test(claim.claim_id) ||
          claims.has(claim.claim_id) ||
          candidates.has(claim.candidate_ref)
        ) {
          throw new ReceiptConflictError("KB compose claim allocation is duplicated or invalid");
        }
        claims.add(claim.claim_id);
        candidates.add(claim.candidate_ref);
      }
    }
  }
  for (const operand of input.allowed_prior_artifacts) {
    if (
      canonicalJson(Object.keys(operand).sort()) !==
        canonicalJson(["handle", "run_id", "state_id"]) ||
      canonicalJson(Object.keys(operand.handle).sort()) !==
        canonicalJson([
          "artifact_id",
          "artifact_kind",
          "byte_length",
          "media_type",
          "schema_version",
          "sha256",
        ]) ||
      !opaque.test(operand.run_id) ||
      !opaque.test(operand.state_id) ||
      operand.handle.schema_version !== 1 ||
      !/^art_[a-f0-9]{32}$/.test(operand.handle.artifact_id) ||
      !kinds.has(operand.handle.artifact_kind) ||
      operand.handle.media_type !== "application/json" ||
      !/^[a-f0-9]{64}$/.test(operand.handle.sha256) ||
      !Number.isSafeInteger(operand.handle.byte_length) ||
      operand.handle.byte_length < 2 ||
      operand.handle.byte_length > 1_048_576
    ) {
      throw new ReceiptConflictError("KB phase prior-artifact operand is malformed");
    }
  }
  return input;
}

function numberValue(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function provisionOwnerDirectory(directory: string): void {
  if (pathExistsNoFollow(directory)) {
    assertOwnerDirectory(directory, "Penny orchestration directory");
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertOwnerDirectory(directory, "Penny orchestration directory");
}

export class Checkpointer implements Disposable {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly maxRetainedRuns: number;
  private static expectedSchemaFingerprint: string | undefined;
  private kbRuntimeProjectRoot?: string;

  /** Explicit setup/migration path. Ordinary runtime must use openExisting(). */
  static provision(
    dbPath: string,
    observer?: CheckpointObserver,
    options: CheckpointerOptions = {}
  ): Checkpointer {
    return new Checkpointer(dbPath, observer, options, "provision");
  }

  /**
   * Explicit state-migration target setup. This is the sole path allowed to bind a recognized
   * pre-binding retained store after the migration owner has selected its project target.
   */
  static provisionMigrationTarget(dbPath: string, projectId: string): Checkpointer {
    return new Checkpointer(dbPath, undefined, { projectId }, "migration-target");
  }

  /** Open one complete canonical control database without creating, repairing, or migrating it. */
  static openExisting(
    dbPath: string,
    observer: CheckpointObserver | undefined,
    options: CheckpointerOptions & { readonly projectId: string }
  ): Checkpointer {
    return new Checkpointer(dbPath, observer, options, "existing");
  }

  /** Readiness probe for state administration. It never performs retention pruning. */
  static verifyExisting(
    dbPath: string,
    options: CheckpointerOptions & { readonly projectId: string }
  ): void {
    using _checkpointer = new Checkpointer(dbPath, undefined, options, "verify");
  }

  /** Inspect one bound retained database using a SQLite-managed read transaction without requiring current schema. */
  static inspectExistingSchema(dbPath: string, projectId: string): OrchestrationSchemaInspection {
    using checkpointer = new Checkpointer(dbPath, undefined, { projectId }, "upgrade-inspect");
    const actualVersion = checkpointer.userVersion();
    return {
      actualVersion,
      requiredVersion: ORCHESTRATION_DATABASE_SCHEMA_VERSION,
      upgradeRequired: actualVersion !== ORCHESTRATION_DATABASE_SCHEMA_VERSION,
      upgradeSupported: ORCHESTRATION_UPGRADE_SOURCE_VERSIONS.some(
        (version) => version === actualVersion
      ),
    };
  }

  /**
   * Upgrade one already-bound retained control database while an exclusive SQLite writer lock is
   * held. The caller must create and verify its recovery backup in beforeMutation; ordinary runtime
   * never reaches this path.
   */
  static async upgradeExisting(
    dbPath: string,
    projectId: string,
    beforeMutation: (sourceVersion: number) => Promise<void>,
    afterMigrationStep?: (targetVersion: 11 | 12 | 13) => Promise<void>
  ): Promise<OrchestrationSchemaUpgradeResult> {
    const inspection = Checkpointer.inspectExistingSchema(dbPath, projectId);
    if (!inspection.upgradeRequired) {
      return {
        sourceVersion: inspection.actualVersion,
        targetVersion: inspection.requiredVersion,
        changed: false,
      };
    }
    if (!inspection.upgradeSupported) {
      throw new OrchestrationSchemaCompatibilityError(inspection.actualVersion);
    }
    using checkpointer = new Checkpointer(dbPath, undefined, { projectId }, "upgrade");
    return await checkpointer.upgradeExistingTransaction(
      projectId,
      beforeMutation,
      afterMigrationStep
    );
  }

  constructor(
    dbPath: string,
    private readonly observer?: CheckpointObserver,
    options: CheckpointerOptions = {},
    mode: CheckpointerOpenMode = "provision"
  ) {
    this.dbPath = dbPath;
    this.maxRetainedRuns = options.maxRetainedRuns ?? 500;
    const databaseExists = dbPath !== ":memory:" && pathExistsNoFollow(dbPath);
    if (mode === "provision" || mode === "migration-target") {
      if (dbPath !== ":memory:") {
        provisionOwnerDirectory(path.dirname(dbPath));
        if (databaseExists) assertOwnerFile(dbPath, "Penny orchestration database");
      }
    } else {
      if (dbPath === ":memory:") {
        throw new Error("ordinary runtime cannot open an in-memory orchestration database");
      }
      assertOwnerDirectory(path.dirname(dbPath), "Penny orchestration directory");
      assertOwnerFile(dbPath, "Penny orchestration database");
      if (options.projectId === undefined) {
        throw new Error("opening an existing orchestration database requires its Penny project ID");
      }
    }
    const { DatabaseSync } = sqliteModule();
    this.db =
      mode === "verify" || mode === "upgrade-inspect"
        ? openReadOnlySqliteDatabase(dbPath, "Penny orchestration database", DatabaseSync)
        : new DatabaseSync(dbPath);
    if (mode !== "verify" && mode !== "upgrade-inspect") {
      // Connection-local settings do not alter retained database bytes. WAL is deliberately delayed
      // until migrate() has accepted the source version/fingerprint, so rejected state is untouched.
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    }
    try {
      if (mode === "provision" || mode === "migration-target") {
        // A bound v10+ store must be checked before any DDL or persistent journal-mode change; a
        // caller cannot relabel it by a provision attempt. A retained v10 source with no metadata
        // is an explicitly supported pre-binding migration case, so it is bound only after its
        // accepted schema upgrade. v9 predates the binding table entirely.
        const retainedVersion = databaseExists ? this.userVersion() : undefined;
        if (
          retainedVersion !== undefined &&
          retainedVersion >= 10 &&
          retainedVersion <= ORCHESTRATION_DATABASE_SCHEMA_VERSION &&
          options.projectId !== undefined
        ) {
          const binding = this.db
            .prepare(
              "SELECT project_id, state_layout_version FROM store_metadata WHERE singleton = 1"
            )
            .get();
          if (
            binding !== undefined ||
            (retainedVersion === ORCHESTRATION_DATABASE_SCHEMA_VERSION &&
              mode !== "migration-target")
          ) {
            this.assertProjectBinding(options.projectId, binding);
          }
        }
        this.migrate(databaseExists);
        if (options.projectId !== undefined) this.ensureProjectBinding(options.projectId);
        if (dbPath !== ":memory:") {
          this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        }
        if (dbPath !== ":memory:" && options.projectId !== undefined) {
          this.assertExistingSchema(options.projectId);
        }
      } else if (mode === "upgrade" || mode === "upgrade-inspect") {
        this.assertUpgradeableSchema(options.projectId);
      } else {
        this.assertExistingSchema(options.projectId);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (
      (mode === "provision" || mode === "migration-target") &&
      !databaseExists &&
      dbPath !== ":memory:"
    ) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const databaseFile = `${dbPath}${suffix}`;
        if (existsSync(databaseFile)) {
          chmodSync(databaseFile, 0o600);
        }
      }
    }
  }

  /** Bind the current trusted project root used to rehydrate path-free KB rows. */
  bindKbRuntimeProjectRoot(projectRoot: string): void {
    const resolved = path.resolve(projectRoot);
    if (this.kbRuntimeProjectRoot !== undefined && this.kbRuntimeProjectRoot !== resolved) {
      throw new CheckpointIdentityError("KB runtime project root changed for this control DB");
    }
    this.kbRuntimeProjectRoot = resolved;
  }

  private migrate(databaseExists: boolean): void {
    const existingVersion = this.userVersion();
    if (existingVersion > ORCHESTRATION_DATABASE_SCHEMA_VERSION) {
      throw new Error(`orchestration schema ${existingVersion} is newer than supported`);
    }
    if (databaseExists && existingVersion === 0) {
      throw new Error(
        "orchestration schema 0 is not a recognized retained-state version; use an absent database for fresh initialization"
      );
    }
    if (databaseExists && existingVersion === ORCHESTRATION_DATABASE_SCHEMA_VERSION) {
      this.assertMigrationSourceFingerprint(
        existingVersion,
        Checkpointer.currentSchemaFingerprint()
      );
    }
    if (databaseExists && existingVersion > 0 && existingVersion < 9) {
      throw new Error(
        `orchestration schema ${existingVersion} is not an approved retained-state migration source`
      );
    }
    if (
      databaseExists &&
      (existingVersion === 9 ||
        existingVersion === 10 ||
        existingVersion === 11 ||
        existingVersion === 12)
    ) {
      this.assertMigrationSourceFingerprint(
        existingVersion,
        this.expectedLegacySchemaFingerprint(existingVersion)
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        playbook TEXT NOT NULL,
        engine_owner TEXT NOT NULL CHECK(engine_owner = 'typescript'),
        schema_version INTEGER NOT NULL CHECK(schema_version = 2),
        status TEXT NOT NULL,
        state_id TEXT NOT NULL,
        context_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        receipt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        state_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        output_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, state_id, branch_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS gates (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        gate_id TEXT NOT NULL,
        state_id TEXT NOT NULL,
        challenge TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'answered')),
        response_digest TEXT,
        response_json TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        PRIMARY KEY(run_id, gate_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session_playbook
        ON runs(session_id, playbook, status);
      CREATE INDEX IF NOT EXISTS idx_receipts_run_state
        ON receipts(run_id, state_id, branch_id);
    `);
    if (this.userVersion() < 3) {
      this.migrateV3();
    }
    if (this.userVersion() < 4) {
      this.migrateV4();
    }
    if (this.userVersion() < 5) {
      this.migrateV5();
    }
    if (this.userVersion() < 6) {
      this.migrateV6();
    }
    if (this.userVersion() < 7) {
      this.migrateV7();
    }
    if (this.userVersion() < 8) {
      this.migrateV8();
    }
    if (this.userVersion() < 9) {
      this.migrateV9();
    }
    if (this.userVersion() < 10) {
      this.migrateV10();
    }
    if (this.userVersion() < 11) {
      this.migrateV11();
    }
    if (this.userVersion() < 12) {
      this.migrateV12();
    }
    if (this.userVersion() < 13) {
      this.migrateV13();
    }
  }

  private assertMigrationSourceFingerprint(version: number, expected: string): void {
    const actual = this.schemaFingerprint();
    if (actual !== expected) {
      throw new Error(
        `orchestration schema ${version} fingerprint is incompatible with the explicit migration path (${actual} != ${expected})`
      );
    }
  }

  private expectedLegacySchemaFingerprint(version: 9 | 10 | 11 | 12): string {
    using expected = Checkpointer.provision(":memory:");
    expected.db.exec("DROP TABLE host_operation_calls;");
    if (version === 12) {
      expected.db.exec("PRAGMA user_version=12;");
      return expected.schemaFingerprint();
    }
    if (version === 11) {
      expected.db.exec(`
        DROP TABLE child_workflow_calls;
        CREATE TABLE child_workflow_calls (
          call_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK(schema_version = 1),
          parent_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          parent_state_id TEXT NOT NULL,
          parent_visit_sequence INTEGER NOT NULL CHECK(parent_visit_sequence >= 1),
          parent_visit_offset INTEGER NOT NULL CHECK(
            parent_visit_offset >= 0 AND parent_visit_offset <= 31
          ),
          call_key TEXT NOT NULL,
          child_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
          lifecycle TEXT NOT NULL CHECK(lifecycle IN (
            'reserved','running','waiting_user','paused','terminal_recorded',
            'consumed','failed','cancelled'
          )),
          record_jcs TEXT NOT NULL,
          record_sha256 TEXT NOT NULL CHECK(length(record_sha256) = 64),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(parent_run_id, parent_state_id, call_key),
          CHECK(parent_run_id <> child_run_id)
        );
        CREATE INDEX idx_child_workflow_calls_parent_lifecycle
          ON child_workflow_calls(parent_run_id, lifecycle);
        PRAGMA user_version=11;
      `);
      return expected.schemaFingerprint();
    }
    expected.db.exec("DROP TABLE child_workflow_calls;");
    if (version === 9) expected.db.exec("DROP TABLE store_metadata;");
    expected.db.exec(`PRAGMA user_version=${version};`);
    return expected.schemaFingerprint();
  }

  private userVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get();
    if (row === undefined) malformedSqliteColumn("SQLite user_version", "user_version");
    return sqliteInteger(row, "user_version", "SQLite user_version");
  }

  /**
   * v3 — §5.6 start-admission custody: the idempotency record and the durable
   * private-input index live in this SAME control database as the run it
   * protects. They carry metadata only (digests, host-allocated relative keys,
   * lifecycle states) — never request bytes — and never a second run identity:
   * the run row remains the single authoritative run record.
   */
  private migrateV3(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS start_admissions (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        action TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running', 'terminal')),
        terminal_result_id TEXT,
        terminal_result_sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, invocation_id)
      );
      CREATE TABLE IF NOT EXISTS private_inputs (
        private_input_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
        request_sha256 TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        temporary_storage_key TEXT,
        state TEXT NOT NULL CHECK(state IN ('preparing', 'active', 'terminal', 'discarding', 'discarded')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version=3;
    `);
  }

  /**
   * v4 — G8 §5.1 canonical content-review packet and decision custody.
   * Packet/receipt JCS contains authority metadata only, never artifact bodies.
   * It is co-located with `runs` and `gates` so each DB-side transition is one
   * FULL-synchronous transaction rather than a JSON-file/DB split.
   */
  private migrateV4(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_reviews (
        challenge_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        packet_sha256 TEXT NOT NULL,
        packet_jcs TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'awaiting', 'approved', 'claimed', 'commit_reserved', 'consumed',
          'refined', 'denied', 'invalidated', 'expired'
        )),
        decision_receipt_jcs TEXT,
        decision_receipt_sha256 TEXT,
        receipt_id TEXT UNIQUE,
        transaction_id TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, challenge_id)
      );
      CREATE INDEX IF NOT EXISTS idx_content_reviews_run
        ON content_reviews(run_id, updated_at);
      PRAGMA user_version=4;
    `);
  }

  /**
   * v5 — §5.5–5.6 operation event-group, immutable receipt index, and exact
   * replay plane. The event group is the idempotency owner; the receipt row is
   * preindexed before bytes. These rows intentionally RESTRICT run deletion so
   * audit files can never outlive their authoritative index by retention prune.
   */
  private migrateV5(): void {
    const runColumns = this.db.prepare("PRAGMA table_info(runs)").all();
    if (
      !runColumns.some(
        (column) =>
          sqliteText(column, "name", "runs table metadata") === "last_operation_receipt_id"
      )
    ) {
      this.db.exec("ALTER TABLE runs ADD COLUMN last_operation_receipt_id TEXT");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operation_event_groups (
        request_event_group_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        session_id TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('init','ingest','query','save','lint','promote','resume')),
        source_kind TEXT NOT NULL CHECK(source_kind IN (
          'external_start','external_resume','content_review_decision','promotion_decision','promotion_apply'
        )),
        source_identity_sha256 TEXT NOT NULL,
        event_sequence INTEGER NOT NULL CHECK(event_sequence >= 0),
        state TEXT NOT NULL CHECK(state IN ('reserved','outcome_preparing','committed')),
        receipt_id TEXT UNIQUE,
        replay_result_jcs TEXT,
        replay_result_sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_kind, source_identity_sha256),
        UNIQUE(run_id, request_event_group_id),
        UNIQUE(run_id, event_sequence),
        CHECK(
          (state = 'reserved' AND receipt_id IS NULL AND replay_result_jcs IS NULL AND replay_result_sha256 IS NULL)
          OR
          (state IN ('outcome_preparing','committed') AND receipt_id IS NOT NULL AND replay_result_jcs IS NOT NULL AND replay_result_sha256 IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS operation_receipt_index (
        receipt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        session_id TEXT NOT NULL,
        kb_profile_id TEXT NOT NULL,
        kb_id TEXT,
        action TEXT NOT NULL CHECK(action IN ('init','ingest','query','save','lint','promote','resume')),
        event TEXT NOT NULL CHECK(event IN ('prepared','published','completed','incomplete','failed')),
        transaction_id TEXT NOT NULL,
        request_event_group_id TEXT NOT NULL UNIQUE REFERENCES operation_event_groups(request_event_group_id),
        event_sequence INTEGER NOT NULL CHECK(event_sequence >= 0),
        source_kind TEXT NOT NULL CHECK(source_kind IN (
          'external_start','external_resume','content_review_decision','promotion_decision','promotion_apply'
        )),
        source_identity_sha256 TEXT NOT NULL,
        receipt_jcs TEXT NOT NULL,
        temporary_storage_key TEXT,
        final_storage_key TEXT NOT NULL UNIQUE,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK(byte_length >= 2),
        state TEXT NOT NULL CHECK(state IN ('preparing','staged','published')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, event_sequence),
        CHECK(
          (state IN ('preparing','staged') AND temporary_storage_key IS NOT NULL)
          OR (state = 'published' AND temporary_storage_key IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS terminal_results (
        terminal_result_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
        idempotency_transaction_id TEXT NOT NULL,
        operation_receipt_id TEXT NOT NULL UNIQUE REFERENCES operation_receipt_index(receipt_id),
        result_jcs TEXT NOT NULL,
        result_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operation_groups_run
        ON operation_event_groups(run_id, event_sequence);
      CREATE INDEX IF NOT EXISTS idx_operation_receipts_run
        ON operation_receipt_index(run_id, event_sequence);
      PRAGMA user_version=5;
    `);
  }

  /**
   * v6 — §5.10 transaction-owned publication evidence. Every candidate and
   * exact file key is durable before publication-file I/O. The selector JCS is
   * retained here so recovery never reconstructs or silently rebases it.
   */
  private migrateV6(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_publication_transactions (
        transaction_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        kb_profile_id TEXT NOT NULL,
        kb_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('init','ingest','save')),
        base_generation_id TEXT,
        base_selector_sha256 TEXT,
        candidate_generation_id TEXT NOT NULL UNIQUE,
        staging_root TEXT NOT NULL UNIQUE,
        generation_staging_key TEXT NOT NULL UNIQUE,
        generation_final_key TEXT NOT NULL UNIQUE,
        selector_jcs TEXT,
        selector_sha256 TEXT,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN (
          'planned','staged','immutables_published','generation_published',
          'selector_committed','finalizing','complete','discarding','discarded'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, transaction_id),
        CHECK(
          (action = 'init' AND base_generation_id IS NULL AND base_selector_sha256 IS NULL)
          OR
          (action IN ('ingest','save') AND base_generation_id IS NOT NULL AND base_selector_sha256 IS NOT NULL)
        ),
        CHECK(
          (selector_jcs IS NULL AND selector_sha256 IS NULL)
          OR (selector_jcs IS NOT NULL AND selector_sha256 IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS kb_publication_files (
        publication_file_id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES kb_publication_transactions(transaction_id),
        role TEXT NOT NULL CHECK(role IN (
          'manifest','policy','source_object','source_record','page_markdown','claims',
          'conflict','catalog','index','selector'
        )),
        staging_key TEXT NOT NULL,
        final_key TEXT NOT NULL,
        sha256 TEXT,
        byte_length INTEGER,
        state TEXT NOT NULL CHECK(state IN ('planned','staged','published')),
        UNIQUE(transaction_id, staging_key),
        UNIQUE(transaction_id, final_key),
        CHECK(
          (state = 'planned' AND sha256 IS NULL AND byte_length IS NULL)
          OR (state IN ('staged','published') AND sha256 IS NOT NULL AND byte_length IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_kb_publications_run
        ON kb_publication_transactions(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_kb_publication_files_transaction
        ON kb_publication_files(transaction_id, role, final_key);
      PRAGMA user_version=6;
    `);
  }

  /**
   * v7 — §5.7 KB child-artifact control boundary. Artifact and phase-result
   * metadata are co-located with the durable run; private artifact bytes remain
   * exclusively under the resolved KB work plane. Exact temp/final keys are
   * frozen before bytes, and one run/state may have only one unfinished artifact
   * of a given kind and one terminating phase result.
   */
  private migrateV7(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_run_artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        state_id TEXT NOT NULL,
        kb_profile_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL CHECK(artifact_kind IN (
          'claims','page_draft','query_answer','lint_report','verification_report',
          'promotion_plan','promotion_patch'
        )),
        media_type TEXT NOT NULL CHECK(media_type = 'application/json'),
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        byte_length INTEGER NOT NULL CHECK(byte_length >= 2 AND byte_length <= 1048576),
        storage_key TEXT NOT NULL UNIQUE,
        temporary_storage_key TEXT UNIQUE,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN (
          'prepared','staged','sealed','consumed','discarding','discarded'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (lifecycle IN ('prepared','discarding') AND temporary_storage_key IS NOT NULL)
          OR (lifecycle IN ('staged','sealed','consumed','discarded') AND temporary_storage_key IS NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_unfinished_kb_artifact_kind
        ON kb_run_artifacts(run_id,state_id,artifact_kind)
        WHERE lifecycle IN ('prepared','staged');
      CREATE INDEX IF NOT EXISTS idx_kb_run_artifacts_phase
        ON kb_run_artifacts(run_id,state_id,lifecycle,created_at);
      CREATE TABLE IF NOT EXISTS kb_phase_operands (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        state_id TEXT NOT NULL,
        operands_jcs TEXT NOT NULL,
        operands_sha256 TEXT NOT NULL CHECK(length(operands_sha256) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id,state_id)
      );
      CREATE TABLE IF NOT EXISTS kb_phase_results (
        phase_result_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        state_id TEXT NOT NULL,
        result_jcs TEXT NOT NULL,
        result_sha256 TEXT NOT NULL CHECK(length(result_sha256) = 64),
        artifact_ids_jcs TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id,state_id)
      );
      PRAGMA user_version=7;
    `);
  }

  /**
   * v8 — profile-keyed base-none init exclusion. The row binds the canonical
   * normalized-profile commitment and immutable KB/generation identities while
   * deliberately retaining no absolute root.
   */
  private migrateV8(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_init_reservations (
        kb_profile_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        transaction_id TEXT NOT NULL UNIQUE,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
        profile_commitment_sha256 TEXT NOT NULL CHECK(length(profile_commitment_sha256) = 64),
        kb_id TEXT NOT NULL UNIQUE,
        generation_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN (
          'reserved','selector_committed','finalized','released'
        )),
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_init_reservations_run
        ON kb_init_reservations(run_id,transaction_id);
      PRAGMA user_version=8;
    `);
  }

  /**
   * v9 — compose identity authority and operand lifecycle. The immutable JCS
   * now may contain host-minted page/revision/claim allocations; separate
   * lifecycle columns close that exact operand set in the same transaction as
   * the body-free terminating phase result.
   */
  private migrateV9(): void {
    const columns = this.db.prepare("PRAGMA table_info(kb_phase_operands)").all();
    const names = new Set(
      columns.map((column) => sqliteText(column, "name", "KB phase operands table metadata"))
    );
    if (!names.has("lifecycle")) {
      this.db.exec(
        "ALTER TABLE kb_phase_operands ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'open' CHECK(lifecycle IN ('open','closed'))"
      );
    }
    if (!names.has("closed_result_sha256")) {
      this.db.exec("ALTER TABLE kb_phase_operands ADD COLUMN closed_result_sha256 TEXT");
    }
    if (!names.has("closed_at")) {
      this.db.exec("ALTER TABLE kb_phase_operands ADD COLUMN closed_at TEXT");
    }
    this.db.exec(`
      UPDATE kb_phase_operands
      SET lifecycle='closed',
          closed_result_sha256=(
            SELECT result_sha256 FROM kb_phase_results r
            WHERE r.run_id=kb_phase_operands.run_id
              AND r.state_id=kb_phase_operands.state_id
          ),
          closed_at=(
            SELECT created_at FROM kb_phase_results r
            WHERE r.run_id=kb_phase_operands.run_id
              AND r.state_id=kb_phase_operands.state_id
          )
      WHERE EXISTS (
        SELECT 1 FROM kb_phase_results r
        WHERE r.run_id=kb_phase_operands.run_id
          AND r.state_id=kb_phase_operands.state_id
      );
      PRAGMA user_version=9;
    `);
  }

  /** v10 — bind one control database to one opaque Penny project partition. */
  private migrateV10(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        project_id TEXT NOT NULL,
        state_layout_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version=10;
    `);
  }

  /** v11 — exact, additive durable child-call linkage and reservation custody. */
  private migrateV11(transactional = true): void {
    // SQLite transactional DDL makes an interrupted v10→v11 migration leave the exact v10 source
    // intact; the next explicit provision can then retry or fail closed from its source fingerprint.
    const operation = () => {
      this.db.exec(`
        CREATE TABLE child_workflow_calls (
          call_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK(schema_version = 1),
          parent_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          parent_state_id TEXT NOT NULL,
          parent_visit_sequence INTEGER NOT NULL CHECK(parent_visit_sequence >= 1),
          parent_visit_offset INTEGER NOT NULL CHECK(
            parent_visit_offset >= 0 AND parent_visit_offset <= 31
          ),
          call_key TEXT NOT NULL,
          child_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
          lifecycle TEXT NOT NULL CHECK(lifecycle IN (
            'reserved','running','waiting_user','paused','terminal_recorded',
            'consumed','failed','cancelled'
          )),
          record_jcs TEXT NOT NULL,
          record_sha256 TEXT NOT NULL CHECK(length(record_sha256) = 64),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(parent_run_id, parent_state_id, call_key),
          CHECK(parent_run_id <> child_run_id)
        );
        CREATE INDEX idx_child_workflow_calls_parent_lifecycle
          ON child_workflow_calls(parent_run_id, lifecycle);
        PRAGMA user_version=11;
      `);
    };
    if (transactional) this.transaction(operation);
    else operation();
  }

  /** v12 — lease-bound child calls coexist with byte-exact V1 records. */
  private migrateV12(transactional = true): void {
    const operation = () => {
      this.db.exec(`
        ALTER TABLE child_workflow_calls RENAME TO child_workflow_calls_v11;
        CREATE TABLE child_workflow_calls (
          call_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK(schema_version IN (1, 2)),
          parent_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          parent_state_id TEXT NOT NULL,
          parent_visit_sequence INTEGER NOT NULL CHECK(parent_visit_sequence >= 1),
          parent_visit_offset INTEGER NOT NULL CHECK(
            parent_visit_offset >= 0 AND parent_visit_offset <= 31
          ),
          call_key TEXT NOT NULL,
          child_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
          lifecycle TEXT NOT NULL CHECK(lifecycle IN (
            'reserved','running','waiting_user','paused','terminal_recorded',
            'consumed','failed','cancelled'
          )),
          record_jcs TEXT NOT NULL,
          record_sha256 TEXT NOT NULL CHECK(length(record_sha256) = 64),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(parent_run_id, parent_state_id, call_key),
          CHECK(parent_run_id <> child_run_id)
        );
        INSERT INTO child_workflow_calls(
          call_id, schema_version, parent_run_id, parent_state_id,
          parent_visit_sequence, parent_visit_offset, call_key, child_run_id,
          lifecycle, record_jcs, record_sha256, created_at, updated_at
        )
        SELECT
          call_id, schema_version, parent_run_id, parent_state_id,
          parent_visit_sequence, parent_visit_offset, call_key, child_run_id,
          lifecycle, record_jcs, record_sha256, created_at, updated_at
        FROM child_workflow_calls_v11;
        DROP TABLE child_workflow_calls_v11;
        CREATE INDEX idx_child_workflow_calls_parent_lifecycle
          ON child_workflow_calls(parent_run_id, lifecycle);
        PRAGMA user_version=12;
      `);
    };
    if (transactional) this.transaction(operation);
    else operation();
  }

  /** v13 — generic asynchronous host-operation journal and exact parent consumption. */
  private migrateV13(transactional = true): void {
    const operation = () => {
      this.db.exec(`
        CREATE TABLE host_operation_calls (
          operation_record_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          state_id TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK(attempt >= 1),
          operation_id TEXT NOT NULL,
          lifecycle TEXT NOT NULL CHECK(lifecycle IN (
            'prepared','lease_acquired','submitting','submitted','fetched','persisting',
            'persisted','verified','terminal','settled','consumed'
          )),
          record_jcs TEXT NOT NULL,
          record_sha256 TEXT NOT NULL CHECK(length(record_sha256) = 64),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(run_id, state_id, attempt, operation_id)
        );
        CREATE INDEX idx_host_operation_calls_run_lifecycle
          ON host_operation_calls(run_id, lifecycle, created_at);
        CREATE UNIQUE INDEX one_unconsumed_host_operation_per_run
          ON host_operation_calls(run_id) WHERE lifecycle <> 'consumed';
        PRAGMA user_version=13;
      `);
    };
    if (transactional) this.transaction(operation);
    else operation();
  }

  private assertUpgradeableSchema(projectId: string | undefined): void {
    const version = this.userVersion();
    if (version === ORCHESTRATION_DATABASE_SCHEMA_VERSION) {
      this.assertExistingSchema(projectId);
      return;
    }
    if (version !== 10 && version !== 11 && version !== 12) {
      throw new OrchestrationSchemaCompatibilityError(version);
    }
    const journal = this.db.prepare("PRAGMA journal_mode").get();
    if (journal === undefined) malformedSqliteColumn("orchestration journal mode", "journal_mode");
    if (sqliteText(journal, "journal_mode", "orchestration journal mode").toLowerCase() !== "wal") {
      throw new Error("orchestration database is not configured for WAL mode");
    }
    this.assertMigrationSourceFingerprint(version, this.expectedLegacySchemaFingerprint(version));
    this.assertProjectBinding(projectId);
    assertSqliteHealthy(this.db, "orchestration");
  }

  private async upgradeExistingTransaction(
    projectId: string,
    beforeMutation: (sourceVersion: number) => Promise<void>,
    afterMigrationStep?: (targetVersion: 11 | 12 | 13) => Promise<void>
  ): Promise<OrchestrationSchemaUpgradeResult> {
    this.db.exec("BEGIN EXCLUSIVE");
    try {
      const sourceVersion = this.userVersion();
      this.assertUpgradeableSchema(projectId);
      if (sourceVersion === ORCHESTRATION_DATABASE_SCHEMA_VERSION) {
        this.db.exec("ROLLBACK");
        return {
          sourceVersion,
          targetVersion: ORCHESTRATION_DATABASE_SCHEMA_VERSION,
          changed: false,
        };
      }
      await beforeMutation(sourceVersion);
      if (sourceVersion < 11) {
        this.migrateV11(false);
        await afterMigrationStep?.(11);
      }
      if (sourceVersion < 12) {
        this.migrateV12(false);
        await afterMigrationStep?.(12);
      }
      if (sourceVersion < 13) {
        this.migrateV13(false);
        await afterMigrationStep?.(13);
      }
      this.assertExistingSchema(projectId);
      this.db.exec("COMMIT");
      return {
        sourceVersion,
        targetVersion: ORCHESTRATION_DATABASE_SCHEMA_VERSION,
        changed: true,
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the initiating upgrade error; the caller's post-failure readiness check reports
        // whether the transaction committed despite that failure.
      }
      throw error;
    }
  }

  private assertExistingSchema(projectId: string | undefined): void {
    const journal = this.db.prepare("PRAGMA journal_mode").get();
    if (journal === undefined) malformedSqliteColumn("orchestration journal mode", "journal_mode");
    if (sqliteText(journal, "journal_mode", "orchestration journal mode").toLowerCase() !== "wal") {
      throw new Error("orchestration database is not configured for WAL mode");
    }
    const version = this.userVersion();
    if (version !== ORCHESTRATION_DATABASE_SCHEMA_VERSION) {
      throw new OrchestrationSchemaCompatibilityError(version);
    }
    const tables = new Set(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => sqliteText(row, "name", "orchestration schema"))
    );
    for (const table of REQUIRED_ORCHESTRATION_TABLES) {
      if (!tables.has(table)) {
        throw new Error(`orchestration database is missing required table '${table}'`);
      }
    }
    for (const [table, requiredColumns] of Object.entries(REQUIRED_ORCHESTRATION_COLUMNS)) {
      const columns = new Set(
        this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => sqliteText(row, "name", `${table} table metadata`))
      );
      for (const column of requiredColumns) {
        if (!columns.has(column)) {
          throw new Error(
            `orchestration database table '${table}' is missing required column '${column}'`
          );
        }
      }
    }
    if (this.schemaFingerprint() !== Checkpointer.currentSchemaFingerprint()) {
      throw new Error(
        "orchestration database schema does not match the current canonical definition"
      );
    }
    assertSqliteHealthy(this.db, "orchestration");
    this.assertProjectBinding(projectId);
    const callIds = this.db
      .prepare("SELECT call_id FROM child_workflow_calls ORDER BY call_id")
      .all()
      .map((row) => sqliteText(row, "call_id", "stored child-workflow call index"));
    for (const callId of callIds) this.childWorkflowCall(callId);
    const operationRecordIds = this.db
      .prepare("SELECT operation_record_id FROM host_operation_calls ORDER BY operation_record_id")
      .all()
      .map((row) => sqliteText(row, "operation_record_id", "stored host-operation call index"));
    for (const operationRecordId of operationRecordIds) {
      this.hostOperationCall(operationRecordId);
    }
  }

  private schemaFingerprint(): string {
    const objects = this.db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master " +
          "WHERE type IN ('table', 'index', 'trigger') AND sql IS NOT NULL ORDER BY type, name"
      )
      .all();
    const normalized = objects.map((row) => ({
      type: sqliteText(row, "type", "orchestration schema object"),
      name: sqliteText(row, "name", "orchestration schema object"),
      table: sqliteText(row, "tbl_name", "orchestration schema object"),
      sql: sqliteText(row, "sql", "orchestration schema object").replace(/\s+/gu, " ").trim(),
    }));
    return sha256(canonicalJson(normalized));
  }

  private static currentSchemaFingerprint(): string {
    if (Checkpointer.expectedSchemaFingerprint !== undefined) {
      return Checkpointer.expectedSchemaFingerprint;
    }
    using expected = Checkpointer.provision(":memory:", undefined, {
      projectId: `prj_${"0".repeat(32)}`,
    });
    const fingerprint = expected.schemaFingerprint();
    Checkpointer.expectedSchemaFingerprint = fingerprint;
    return fingerprint;
  }

  private ensureProjectBinding(projectId: string): void {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("project ID is not canonical");
    const row = this.db
      .prepare("SELECT project_id, state_layout_version FROM store_metadata WHERE singleton = 1")
      .get();
    if (row === undefined) {
      this.db
        .prepare(
          "INSERT INTO store_metadata(singleton, project_id, state_layout_version, created_at) " +
            "VALUES(1, ?, ?, ?)"
        )
        .run(projectId, PENNY_STATE_LAYOUT_VERSION, new Date().toISOString());
      return;
    }
    this.assertProjectBinding(projectId, row);
  }

  private assertProjectBinding(projectId: string | undefined, stored?: SqliteRow): void {
    if (projectId === undefined || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error("project ID is not canonical");
    }
    const storedValue =
      stored ??
      this.db
        .prepare("SELECT project_id, state_layout_version FROM store_metadata WHERE singleton = 1")
        .get();
    if (storedValue === undefined) {
      throw new Error("orchestration database project binding is absent");
    }
    if (sqliteText(storedValue, "project_id", "orchestration store metadata") !== projectId) {
      throw new Error("orchestration database belongs to another Penny project");
    }
    if (
      sqliteInteger(storedValue, "state_layout_version", "orchestration store metadata") !==
      PENNY_STATE_LAYOUT_VERSION
    ) {
      throw new Error("orchestration database has an unsupported state layout version");
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertCompletionPayloadUnforgeable(payload: Record<string, JsonValue>): void {
    for (const key of Object.keys(payload)) {
      if (RESERVED_COMPLETION_EVENT_KEYS.has(key)) {
        throw new CheckpointIdentityError(`caller payload cannot set reserved key '${key}'`);
      }
    }
  }

  private nextEventSequence(runId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events WHERE run_id = ?"
      )
      .get(runId);
    if (row === undefined) malformedSqliteColumn("next checkpoint event", "next_sequence");
    return sqliteInteger(row, "next_sequence", "next checkpoint event");
  }

  stateVisits(runId: string): StateVisitRef[] {
    const refs: StateVisitRef[] = [];
    // Progress/liveness events carry no visit evidence. Filter them in SQLite rather than
    // hydrating the entire event history. Invalid JSON and non-object payloads still reach
    // the ordinary validator, as do invalid SQLite column types. A malformed relevant
    // field (including null) must never vanish. SQLite accepts overflowed JSON numbers
    // that JavaScript decodes as Infinity; route those through the canonical validator too.
    const rows = this.db
      .prepare(
        `SELECT sequence, event_type, payload_json, created_at FROM events WHERE run_id = ? AND (
           typeof(sequence) <> 'integer' OR sequence NOT BETWEEN ? AND ? OR
           typeof(event_type) <> 'text' OR typeof(created_at) <> 'text' OR
           typeof(payload_json) <> 'text' OR
           CASE WHEN json_valid(payload_json) THEN
             json_type(payload_json) <> 'object' OR
             json_type(payload_json, '$.state_visits_v1') IS NOT NULL OR
             EXISTS (
               SELECT 1 FROM json_tree(payload_json)
               WHERE type IN ('integer', 'real') AND atom NOT BETWEEN ? AND ?
             )
           ELSE 1 END
         ) ORDER BY sequence`
      )
      .all(
        runId,
        -Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        -Number.MAX_VALUE,
        Number.MAX_VALUE
      );
    for (const row of rows) {
      const event = {
        sequence: sqliteInteger(row, "sequence", "stored checkpoint event"),
        eventType: sqliteText(row, "event_type", "stored checkpoint event"),
        payload: validateContract(
          CheckpointEventPayloadSchema,
          JSON.parse(sqliteText(row, "payload_json", "stored checkpoint event")),
          "stored checkpoint event payload"
        ),
        createdAt: sqliteText(row, "created_at", "stored checkpoint event"),
      };
      const raw = event.payload.state_visits_v1;
      if (raw === undefined) continue;
      if (!Array.isArray(raw) || raw.length > 32) {
        throw new CheckpointIdentityError("stored state-visit metadata is malformed");
      }
      raw.forEach((value, offset) => {
        let visit: StateVisit;
        try {
          visit = validateContract(StateVisitSchema, value, "stored state visit");
        } catch {
          throw new CheckpointIdentityError("stored state-visit metadata is malformed");
        }
        refs.push({
          event_sequence: event.sequence,
          offset,
          state_id: visit.state_id,
          source: visit.source,
        });
      });
    }
    return refs;
  }

  /** Any reserved event field proves that the run has crossed the completion-admission boundary. */
  hasCompletionProtocolMetadata(runId: string): boolean {
    return this.events(runId).some((event) =>
      [...RESERVED_COMPLETION_EVENT_KEYS].some((key) => Object.hasOwn(event.payload, key))
    );
  }

  /** Durable visits plus the exact journal that will enter the next ordinary event. */
  completionStateVisits(context: RunContext): StateVisitRef[] {
    const durable = this.stateVisits(context.identity.run_id);
    const pending = context.pendingStateVisits();
    const sequence = this.nextEventSequence(context.identity.run_id);
    return [
      ...durable,
      ...pending.map((visit, offset) => ({
        event_sequence: sequence,
        offset,
        state_id: visit.state_id,
        source: visit.source,
      })),
    ];
  }

  completionAdmission(runId: string): CompletionAdmissionEnvelope | undefined {
    const found: CompletionAdmissionEnvelope[] = [];
    for (const event of this.events(runId)) {
      const raw = event.payload.completion_admission_v1;
      if (raw === undefined) continue;
      try {
        found.push(
          validateContract(CompletionAdmissionEnvelopeSchema, raw, "stored completion admission")
        );
      } catch {
        throw new CheckpointIdentityError("stored completion-admission envelope is malformed");
      }
    }
    if (found.length > 1) {
      throw new CheckpointIdentityError("run has duplicate completion-admission envelopes");
    }
    return found[0];
  }

  completionRefusal(runId: string): CompletionRefusalEvidence | undefined {
    const found: CompletionRefusalEvidence[] = [];
    for (const event of this.events(runId)) {
      const raw = event.payload.completion_refusal_v1;
      if (raw === undefined) continue;
      try {
        found.push(
          validateContract(CompletionRefusalEvidenceSchema, raw, "stored completion refusal")
        );
      } catch {
        throw new CheckpointIdentityError("stored completion-refusal evidence is malformed");
      }
    }
    if (found.length > 1) {
      throw new CheckpointIdentityError("run has duplicate completion-refusal records");
    }
    return found[0];
  }

  private validateAdmissionEnvelope(envelope: CompletionAdmissionEnvelope): void {
    validateContract(CompletionAdmissionEnvelopeSchema, envelope, "completion-admission envelope");
    const { terminal_envelope_id: _id, ...body } = envelope;
    if (`tenv_${sha256(canonicalJson(body))}` !== envelope.terminal_envelope_id) {
      throw new CheckpointIdentityError("completion-admission envelope ID is invalid");
    }
  }

  private checkpointPayload(
    context: RunContext,
    payload: Record<string, JsonValue>
  ): Record<string, JsonValue> {
    this.assertCompletionPayloadUnforgeable(payload);
    const visits = context.pendingStateVisits();
    const admission = context.pendingCompletionAdmission();
    const refusal = context.pendingCompletionRefusal();
    if (admission !== null && refusal !== null) {
      throw new CheckpointIdentityError("checkpoint cannot admit and refuse the same terminal");
    }
    if (visits.length > 32) {
      throw new CheckpointIdentityError("one checkpoint event cannot append more than 32 visits");
    }
    for (const visit of visits) validateContract(StateVisitSchema, visit, "state visit");
    if (admission !== null) this.validateAdmissionEnvelope(admission);
    if (refusal !== null) {
      validateContract(CompletionRefusalEvidenceSchema, refusal, "completion refusal");
    }
    return {
      ...payload,
      ...(visits.length > 0 ? { state_visits_v1: [...visits] } : {}),
      ...(admission !== null ? { completion_admission_v1: admission } : {}),
      ...(refusal !== null ? { completion_refusal_v1: refusal } : {}),
    };
  }

  private assertNewRunCompletionProtocol(context: RunContext): void {
    if (context.completionProtocolVersion !== 1) {
      throw new CheckpointIdentityError("new run lacks completion protocol version 1");
    }
  }

  private validatePositiveTerminalWrite(context: RunContext): void {
    const terminal = context.terminalDirective;
    const positiveRunState = context.status === "complete" && context.met === true;
    const positiveTerminal =
      terminal?.action === "complete" && terminal.status === "complete" && terminal.met === true;
    if (!positiveRunState && !positiveTerminal) return;
    if (
      !positiveRunState ||
      terminal?.action !== "complete" ||
      terminal.status !== "complete" ||
      terminal.met !== true
    ) {
      throw new CheckpointIdentityError("positive run state lacks matching completion admission");
    }

    const envelope = context.pendingCompletionAdmission();
    const row = this.selectRun(context.identity.run_id);
    if (row !== undefined && envelope === null) {
      const priorContext = this.contextFromRunRow(row);
      const prior = priorContext.terminalDirective;
      if (
        priorContext.completionProtocolVersion === undefined &&
        context.completionProtocolVersion === undefined &&
        prior?.action === "complete" &&
        canonicalJson(prior) === canonicalJson(terminal) &&
        !this.hasCompletionProtocolMetadata(context.identity.run_id)
      ) {
        // Only an exact positive whose durable context predates protocol v1 is legacy replay.
        return;
      }
    }
    if (envelope === null) {
      throw new CheckpointIdentityError("new positive terminal lacks completion admission");
    }
    this.validateAdmissionEnvelope(envelope);
    const visits = this.completionStateVisits(context);
    if (
      envelope.run_id !== context.identity.run_id ||
      envelope.terminal_digest !== sha256(canonicalJson(terminal)) ||
      canonicalJson(envelope.state_visit_refs) !== canonicalJson(visits) ||
      envelope.origin_state !== visits.at(-1)?.state_id ||
      envelope.unresolved_count !== terminal.unresolved.length
    ) {
      throw new CheckpointIdentityError("positive terminal completion admission is not exact");
    }
    if (envelope.latest_product.selector === "terminal_result") {
      const digest = sha256(canonicalJson(terminal.result));
      if (
        envelope.latest_product.sha256 !== digest ||
        envelope.latest_product.product_id !== `prod_${digest}`
      ) {
        throw new CheckpointIdentityError("terminal-result completion product is not exact");
      }
    } else {
      const artifact = terminal.artifacts.find(
        (candidate) => candidate.artifact_id === envelope.latest_product.product_id
      );
      const selected = context.selectedArtifacts.find(
        (candidate) => candidate.artifact_id === envelope.latest_product.product_id
      );
      const highestVersion = Math.max(
        ...context.selectedArtifacts
          .filter(
            (candidate) =>
              candidate.run_id === context.identity.run_id &&
              candidate.operation_id === artifact?.operation_id
          )
          .map((candidate) => candidate.version)
      );
      if (
        artifact === undefined ||
        artifact.run_id !== context.identity.run_id ||
        selected === undefined ||
        canonicalJson(artifact) !== canonicalJson(selected) ||
        artifact.content_digest !== envelope.latest_product.sha256 ||
        artifact.version !== highestVersion
      ) {
        throw new CheckpointIdentityError("terminal-artifact completion product is not exact");
      }
    }
    if (
      envelope.evidence_refs.some(
        (ref) => !this.completionEvidenceRefExists(ref, context.identity.run_id)
      )
    ) {
      throw new CheckpointIdentityError("completion admission references absent evidence");
    }
  }

  completionEvidenceRefExists(ref: CompletionEvidenceRef, runId: string): boolean {
    try {
      validateContract(CompletionEvidenceRefSchema, ref, "completion evidence ref");
      if (ref.kind === "execution_receipt") {
        const row = this.db
          .prepare("SELECT result_json FROM receipts WHERE receipt_id = ? AND run_id = ?")
          .get(ref.reference_id, runId);
        return (
          row !== undefined &&
          ref.sha256 === sha256(sqliteText(row, "result_json", "completion execution receipt"))
        );
      }
      if (ref.kind === "kb_artifact") {
        const artifact = this.kbArtifact(ref.reference_id);
        return artifact?.run_id === runId && artifact.sha256 === ref.sha256;
      }
      if (ref.kind === "kb_phase_result") {
        const row = this.db
          .prepare(
            "SELECT result_sha256 FROM kb_phase_results WHERE phase_result_id = ? AND run_id = ?"
          )
          .get(ref.reference_id, runId);
        return (
          row !== undefined &&
          sqliteText(row, "result_sha256", "completion KB phase result") === ref.sha256
        );
      }
      if (ref.kind === "kb_publication") {
        const publication = this.kbPublication(ref.reference_id);
        return publication?.selector_sha256 === ref.sha256;
      }
      if (ref.kind === "content_review") {
        const review = this.contentReviewForRun(runId);
        return (
          review?.challenge_id === ref.reference_id && review.decision_receipt_sha256 === ref.sha256
        );
      }
      if (ref.kind === "promotion_approval") {
        const approval = this.promotionApprovalBinding(runId);
        return approval?.receipt_id === ref.reference_id && approval.receipt_sha256 === ref.sha256;
      }
      return false;
    } catch {
      return false;
    }
  }

  childWorkflowCall(callId: string): ChildWorkflowCallRecord | undefined {
    const row = this.db.prepare("SELECT * FROM child_workflow_calls WHERE call_id = ?").get(callId);
    if (row === undefined) return undefined;
    let record: ChildWorkflowCallRecord;
    try {
      record = decodeStoredChildWorkflowCallRow(childWorkflowCallRow(row));
    } catch (error) {
      throw new CheckpointIdentityError(
        `stored child-workflow call '${callId}' is malformed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    this.assertChildWorkflowCallLinkage(record);
    return record;
  }

  childWorkflowCallForChild(childRunId: string): ChildWorkflowCallRecord | undefined {
    const row = this.db
      .prepare("SELECT call_id FROM child_workflow_calls WHERE child_run_id = ?")
      .get(childRunId);
    return row === undefined
      ? undefined
      : this.childWorkflowCall(sqliteText(row, "call_id", "child call lookup"));
  }

  childWorkflowCallForParent(
    parentRunId: string,
    parentStateId: string,
    callKey: string
  ): ChildWorkflowCallRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT call_id FROM child_workflow_calls
         WHERE parent_run_id = ? AND parent_state_id = ? AND call_key = ?`
      )
      .get(parentRunId, parentStateId, callKey);
    if (row === undefined) return undefined;
    return requiredCheckpointValue(
      this.childWorkflowCall(sqliteText(row, "call_id", "stored child-workflow call lookup")),
      "indexed child-workflow call"
    );
  }

  /**
   * One control-store transaction suspends the exact parent directive, creates the ordinary child
   * run/initial event, and inserts one immutable reservation. It re-verifies artifact custody
   * before the transaction so public storage callers cannot bypass artifact-first ordering. This
   * method performs no dispatch or external work.
   */
  reserveChildWorkflowCall(input: ReserveChildWorkflowCallInput): ReserveChildWorkflowCallOutcome {
    let encoded: ReturnType<typeof encodeChildWorkflowCallRecord>;
    try {
      encoded = encodeChildWorkflowCallRecord(input.record);
    } catch (error) {
      throw new ChildWorkflowCallConflictError(
        `child-workflow reservation is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const requested = verifyChildWorkflowArtifactCustody(
      input.custody,
      this.projectIdForChildWorkflowCall(),
      encoded.record
    );
    if (
      requested.lifecycle !== "reserved" ||
      requested.created_at !== requested.updated_at ||
      requested.terminal_action !== null ||
      requested.terminal_sha256 !== null ||
      requested.output_artifact !== null ||
      requested.usage !== null
    ) {
      throw new ChildWorkflowCallConflictError(
        "a new child-workflow reservation must be an initial reserved record"
      );
    }
    this.assertInitialChildWorkflowContext(input.childContext, requested);
    if (requested.schema_version === 2 && input.admission === undefined) {
      throw new ChildWorkflowCallConflictError(
        "lease-bound child-workflow reservation requires atomic capacity admission"
      );
    }
    if (
      input.admission !== undefined &&
      Object.values(input.admission).some(
        (limit) => !Number.isSafeInteger(limit) || limit < 1 || limit > 64
      )
    ) {
      throw new ChildWorkflowCallConflictError("child-workflow capacity admission is invalid");
    }

    const outcome = this.transaction((): ReserveChildWorkflowCallOutcome => {
      const existing = this.childWorkflowCallForParent(
        requested.parent_identity.run_id,
        requested.parent_state_id,
        requested.call_key
      );
      if (existing !== undefined) {
        if (childWorkflowCallImmutableJcs(existing) !== childWorkflowCallImmutableJcs(requested)) {
          throw new ChildWorkflowCallConflictError(
            "child-workflow logical call was already reserved with different immutable operands"
          );
        }
        const parent = this.contextForChildWorkflowCall(existing.parent_identity.run_id);
        if (
          existing.lifecycle !== "consumed" &&
          canonicalJson(parent.pendingDirective) !== canonicalJson(existing.directive) &&
          !(existing.lifecycle === "waiting_user" && this.exactProjectedChildGate(existing, parent))
        ) {
          throw new CheckpointIdentityError(
            "adopted child-workflow call is not the parent's exact pending directive"
          );
        }
        return { kind: "adopted", record: existing };
      }
      if (this.childWorkflowCall(requested.call_id) !== undefined) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow call ID is already bound to another logical call"
        );
      }
      if (input.admission !== undefined) {
        const parentCounts = this.db
          .prepare(
            `SELECT
               COUNT(*) AS calls,
               COALESCE(SUM(CASE WHEN lifecycle IN ('reserved','running','waiting_user','paused') THEN 1 ELSE 0 END), 0) AS active
             FROM child_workflow_calls WHERE parent_run_id = ?`
          )
          .get(requested.parent_identity.run_id);
        if (parentCounts === undefined) malformedSqliteColumn("child capacity", "calls");
        const parentCalls = sqliteInteger(parentCounts, "calls", "child parent call capacity");
        const parentActive = sqliteInteger(parentCounts, "active", "child parent active capacity");
        const projectActive = this.activeChildWorkflowCallCount();
        if (parentCalls >= input.admission.max_calls) {
          throw new ChildWorkflowCallConflictError("child workflow parent exhausted call capacity");
        }
        if (parentActive >= input.admission.max_active_children) {
          throw new ChildWorkflowCallConflictError(
            "child workflow parent exhausted active capacity"
          );
        }
        if (projectActive >= input.admission.project_concurrency_limit) {
          throw new ChildWorkflowCallConflictError("child workflow project capacity is exhausted");
        }
      }
      if (this.selectRun(requested.child_identity.run_id) !== undefined) {
        throw new CheckpointIdentityError(
          "deterministic child run exists without its matching child-workflow call"
        );
      }

      const parent = this.contextForChildWorkflowCall(requested.parent_identity.run_id);
      this.assertIdentity(requested.parent_identity, parent.identity);
      if (parent.status !== "running" || parent.stateId !== requested.parent_state_id) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow parent is not running at the reserved state"
        );
      }
      if (
        parent.pendingDirective !== null &&
        canonicalJson(parent.pendingDirective) !== canonicalJson(requested.directive)
      ) {
        throw new CheckpointIdentityError(
          "parent already has pending work without the exact child-workflow directive"
        );
      }
      if (
        input.childContext.projectRoot !== parent.projectRoot ||
        input.childContext.trustProfile !== parent.trustProfile
      ) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow initial context does not share the parent project/trust boundary"
        );
      }
      this.assertRegistrationDigest(
        parent,
        requested.parent_registration_sha256,
        "parent child-workflow registration"
      );
      if (
        !this.stateVisits(parent.identity.run_id).some(
          (visit) =>
            visit.event_sequence === requested.parent_visit_sequence &&
            visit.offset === requested.parent_visit_offset &&
            visit.state_id === requested.parent_state_id
        )
      ) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow reservation does not name an exact durable parent visit"
        );
      }
      if (this.projectIdForChildWorkflowCall() !== requested.policy_binding.project_id) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow policy project does not match the control-store project"
        );
      }

      parent.pendingDirective = structuredClone(requested.directive);
      this.updateRun(parent);
      const timestamp = requested.created_at;
      this.db
        .prepare(
          `INSERT INTO runs(
            run_id, session_id, playbook, engine_owner, schema_version,
            status, state_id, context_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.childContext.identity.run_id,
          input.childContext.identity.session_id,
          input.childContext.identity.playbook,
          input.childContext.identity.engine_owner,
          input.childContext.identity.schema_version,
          input.childContext.status,
          input.childContext.stateId,
          this.durableContextJson(input.childContext),
          timestamp,
          timestamp
        );
      this.db
        .prepare(
          `INSERT INTO child_workflow_calls(
            call_id, schema_version, parent_run_id, parent_state_id,
            parent_visit_sequence, parent_visit_offset, call_key, child_run_id,
            lifecycle, record_jcs, record_sha256, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          requested.call_id,
          requested.schema_version,
          requested.parent_identity.run_id,
          requested.parent_state_id,
          requested.parent_visit_sequence,
          requested.parent_visit_offset,
          requested.call_key,
          requested.child_identity.run_id,
          requested.lifecycle,
          encoded.record_jcs,
          encoded.record_sha256,
          requested.created_at,
          requested.updated_at
        );
      this.insertEvent(
        parent.identity.run_id,
        "child_workflow_reserved",
        this.checkpointPayload(parent, {
          call_id: requested.call_id,
          child_run_id: requested.child_identity.run_id,
          directive_sha256: requested.directive_sha256,
          request_ref_sha256: requested.request_ref_sha256,
          input_refs_sha256: requested.input_refs_sha256,
          expected_output_sha256: requested.expected_output_sha256,
          policy_sha256: requested.policy_sha256,
        }),
        timestamp
      );
      this.insertEvent(
        input.childContext.identity.run_id,
        "child_workflow_run_created",
        this.checkpointPayload(input.childContext, {
          call_id: requested.call_id,
          parent_run_id: requested.parent_identity.run_id,
          parent_state_id: requested.parent_state_id,
        }),
        timestamp
      );

      const stored = requiredCheckpointValue(
        this.childWorkflowCall(requested.call_id),
        "created child-workflow call"
      );
      const storedParent = this.contextForChildWorkflowCall(requested.parent_identity.run_id);
      const storedChild = this.contextForChildWorkflowCall(requested.child_identity.run_id);
      if (
        canonicalJson(stored) !== encoded.record_jcs ||
        canonicalJson(storedParent.pendingDirective) !== canonicalJson(requested.directive) ||
        canonicalJson(storedChild.snapshot()) !== canonicalJson(input.childContext.snapshot())
      ) {
        throw new CheckpointIdentityError(
          "child-workflow reservation projections did not round-trip exactly"
        );
      }
      return { kind: "created", record: stored };
    });
    if (outcome.kind === "created") input.childContext.markCheckpointEvidencePersisted();
    return outcome;
  }

  /** Exact lifecycle compare-and-set for non-consumption changes; consumption has its own atomic owner method. */
  transitionChildWorkflowCall(input: TransitionChildWorkflowCallInput): ChildWorkflowCallRecord {
    let encoded: ReturnType<typeof encodeChildWorkflowCallRecord>;
    try {
      encoded = encodeChildWorkflowCallRecord(input.next);
    } catch (error) {
      throw new ChildWorkflowCallConflictError(
        `child-workflow lifecycle record is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const next = verifyChildWorkflowArtifactCustody(
      input.custody,
      this.projectIdForChildWorkflowCall(),
      encoded.record
    );
    encoded = encodeChildWorkflowCallRecord(next);
    if (encoded.record.call_id !== input.call_id) {
      throw new ChildWorkflowCallConflictError("child-workflow lifecycle call ID changed");
    }
    if (encoded.record.lifecycle === "consumed") {
      throw new ChildWorkflowCallConflictError(
        "child-workflow consumption requires Checkpointer.consumeChildWorkflowCall"
      );
    }
    return this.transaction(() => {
      const current = requiredCheckpointValue(
        this.childWorkflowCall(input.call_id),
        "child-workflow lifecycle call"
      );
      if (current.lifecycle !== input.from) {
        throw new ChildWorkflowCallConflictError(
          `child-workflow lifecycle compare-and-set expected '${input.from}', found '${current.lifecycle}'`
        );
      }
      if (
        childWorkflowCallImmutableJcs(current) !== childWorkflowCallImmutableJcs(encoded.record)
      ) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow lifecycle transition changed immutable operands"
        );
      }
      if (
        encoded.record.created_at !== current.created_at ||
        encoded.record.updated_at < current.updated_at
      ) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow lifecycle transition changed or regressed durable timestamps"
        );
      }
      if (encoded.record.lifecycle === current.lifecycle) {
        if (canonicalJson(encoded.record) === canonicalJson(current)) return current;
        throw new ChildWorkflowCallConflictError(
          "same child-workflow lifecycle cannot change the stored record"
        );
      }
      if (!isLegalChildWorkflowCallTransition(current.lifecycle, encoded.record.lifecycle)) {
        throw new ChildWorkflowCallConflictError(
          `illegal child-workflow lifecycle transition '${current.lifecycle}' -> '${encoded.record.lifecycle}'`
        );
      }
      if (next.lifecycle === "waiting_user" && input.parentContext === undefined)
        throw new ChildWorkflowCallConflictError("child waits require atomic parent projection");
      if (input.parentContext !== undefined) {
        const parent = this.loadRun(current.parent_identity);
        const childGate = this.loadRun(current.child_identity).pendingDirective;
        if (
          current.lifecycle !== "running" ||
          next.lifecycle !== "waiting_user" ||
          parent.terminalDirective !== null ||
          childGate?.action !== "await_user" ||
          canonicalJson(parent.pendingDirective) !== canonicalJson(current.directive) ||
          canonicalJson(input.parentContext.pendingDirective) !==
            canonicalJson(projectChildGate(current, childGate)) ||
          input.parentContext.status !== "awaiting_user" ||
          canonicalJson(input.parentContext.snapshot()) !==
            canonicalJson({
              ...parent.snapshot(),
              status: "awaiting_user",
              pending_directive: projectChildGate(current, childGate),
            })
        )
          throw new ChildWorkflowCallConflictError(
            "child gate projection lost its exact parent/child boundary"
          );
        this.assertIdentity(current.parent_identity, input.parentContext.identity);
        this.updateRun(input.parentContext);
        this.persistPendingGate(input.parentContext);
        this.insertEvent(
          current.parent_identity.run_id,
          "child_workflow_waiting",
          {
            call_id: current.call_id,
            child_run_id: current.child_identity.run_id,
            gate_sha256: sha256(canonicalJson(childGate)),
          },
          now()
        );
      }
      const currentEncoded = encodeChildWorkflowCallRecord(current);
      const updated = this.db
        .prepare(
          `UPDATE child_workflow_calls
           SET lifecycle = ?, record_jcs = ?, record_sha256 = ?, updated_at = ?
           WHERE call_id = ? AND lifecycle = ? AND record_sha256 = ?`
        )
        .run(
          encoded.record.lifecycle,
          encoded.record_jcs,
          encoded.record_sha256,
          encoded.record.updated_at,
          input.call_id,
          input.from,
          currentEncoded.record_sha256
        );
      if (numberValue(updated.changes) !== 1) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow lifecycle compare-and-set lost its durable owner"
        );
      }
      this.insertEvent(
        current.parent_identity.run_id,
        "child_workflow_transition",
        {
          call_id: current.call_id,
          from: current.lifecycle,
          to: next.lifecycle,
          terminal_sha256: next.terminal_sha256,
        },
        now()
      );
      const stored = requiredCheckpointValue(
        this.childWorkflowCall(input.call_id),
        "transitioned child-workflow call"
      );
      if (canonicalJson(stored) !== encoded.record_jcs) {
        throw new CheckpointIdentityError(
          "child-workflow lifecycle transition did not round-trip exactly"
        );
      }
      return stored;
    });
  }

  /** Return all durable child calls for one parent in deterministic creation order. */
  childWorkflowCallsForParent(parentRunId: string): readonly ChildWorkflowCallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT call_id FROM child_workflow_calls
         WHERE parent_run_id = ? ORDER BY created_at, call_id`
      )
      .all(parentRunId);
    return rows.map((row) =>
      requiredCheckpointValue(
        this.childWorkflowCall(sqliteText(row, "call_id", "child-workflow parent call index")),
        "indexed child-workflow parent call"
      )
    );
  }

  /**
   * Project-wide child capacity is based only on calls that can still dispatch or wait for a
   * response. Captured terminals no longer consume active-worker capacity, but stay retained until
   * the separate consume transaction settles their parent.
   */
  activeChildWorkflowCallCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM child_workflow_calls
         WHERE lifecycle IN ('reserved', 'running', 'waiting_user', 'paused')`
      )
      .get();
    if (row === undefined) malformedSqliteColumn("active child-workflow call count", "count");
    return sqliteInteger(row, "count", "active child-workflow call count");
  }

  /**
   * Atomically commit an already captured child terminal into the suspended parent. This is not a
   * general lifecycle transition: it proves the persisted parent still names the exact original
   * directive, preserves the terminal operands, writes the new parent snapshot, and changes the
   * call to `consumed` under one compare-and-set transaction.
   */
  consumeChildWorkflowCall(input: ConsumeChildWorkflowCallInput): ChildWorkflowCallRecord {
    let encoded: ReturnType<typeof encodeChildWorkflowCallRecord>;
    try {
      encoded = encodeChildWorkflowCallRecord(input.next);
    } catch (error) {
      throw new ChildWorkflowCallConflictError(
        `child-workflow consumption is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const next = verifyChildWorkflowArtifactCustody(
      input.custody,
      this.projectIdForChildWorkflowCall(),
      encoded.record
    );
    encoded = encodeChildWorkflowCallRecord(next);
    if (next.call_id !== input.call_id || next.lifecycle !== "consumed") {
      throw new ChildWorkflowCallConflictError(
        "child-workflow consumption must retain its call ID and use lifecycle 'consumed'"
      );
    }
    let persistedPayload: Record<string, JsonValue> = input.payload;
    const consumed = this.transaction(() => {
      const current = requiredCheckpointValue(
        this.childWorkflowCall(input.call_id),
        "child-workflow consumption call"
      );
      if (current.lifecycle === "consumed") {
        if (canonicalJson(current) === encoded.record_jcs) return current;
        throw new ChildWorkflowCallConflictError(
          "child-workflow call was already consumed with different terminal operands"
        );
      }
      if (current.lifecycle !== "terminal_recorded") {
        throw new ChildWorkflowCallConflictError(
          `child-workflow call '${input.call_id}' is not ready for consumption`
        );
      }
      this.assertChildWorkflowCallLinkage(current);
      const durableParent = this.loadRun(current.parent_identity);
      if (
        input.expected_parent_snapshot_sha256 !== undefined &&
        sha256(canonicalJson(durableParent.snapshot())) !== input.expected_parent_snapshot_sha256
      )
        throw new ChildWorkflowCallConflictError(
          "child consumption lost exact pending parent selections"
        );
      if (
        durableParent.terminalDirective !== null ||
        canonicalJson(durableParent.pendingDirective) !== canonicalJson(current.directive)
      )
        throw new ChildWorkflowCallConflictError(
          "child consumption lost its pending parent or cancellation fence"
        );
      if (
        childWorkflowCallImmutableJcs(current) !== childWorkflowCallImmutableJcs(next) ||
        current.terminal_action !== next.terminal_action ||
        current.terminal_sha256 !== next.terminal_sha256 ||
        canonicalJson(current.output_artifact) !== canonicalJson(next.output_artifact) ||
        canonicalJson(current.usage) !== canonicalJson(next.usage) ||
        next.created_at !== current.created_at ||
        next.updated_at < current.updated_at
      ) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow consumption changed captured terminal operands"
        );
      }
      this.assertIdentity(current.parent_identity, input.parentContext.identity);
      this.assertRegistrationDigest(
        input.parentContext,
        current.parent_registration_sha256,
        "parent child-workflow consumption registration"
      );
      if (
        input.parentContext.terminalDirective === null &&
        input.parentContext.status !== "running"
      ) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow parent continuation is not running or terminal"
        );
      }
      this.validatePositiveTerminalWrite(input.parentContext);
      persistedPayload = this.checkpointPayload(input.parentContext, input.payload);
      this.updateRun(input.parentContext);
      this.persistPendingGate(input.parentContext);
      const updated = this.db
        .prepare(
          `UPDATE child_workflow_calls
           SET lifecycle = ?, record_jcs = ?, record_sha256 = ?, updated_at = ?
           WHERE call_id = ? AND lifecycle = 'terminal_recorded' AND record_sha256 = ?`
        )
        .run(
          next.lifecycle,
          encoded.record_jcs,
          encoded.record_sha256,
          next.updated_at,
          input.call_id,
          encodeChildWorkflowCallRecord(current).record_sha256
        );
      if (numberValue(updated.changes) !== 1) {
        throw new ChildWorkflowCallConflictError(
          "child-workflow consumption compare-and-set lost its durable owner"
        );
      }
      this.insertEvent(
        input.parentContext.identity.run_id,
        input.eventType,
        persistedPayload,
        now()
      );
      return requiredCheckpointValue(this.childWorkflowCall(input.call_id), "consumed child call");
    });
    input.parentContext.markCheckpointEvidencePersisted();
    this.observe(input.parentContext, input.eventType, persistedPayload);
    return consumed;
  }

  hostOperationCall(operationRecordId: string): HostOperationCallRecordV1 | undefined {
    const row = this.db
      .prepare("SELECT * FROM host_operation_calls WHERE operation_record_id = ?")
      .get(operationRecordId);
    if (row === undefined) return undefined;
    let record: HostOperationCallRecordV1;
    try {
      record = decodeStoredHostOperationCallRow(hostOperationCallRow(row));
    } catch (error) {
      throw new CheckpointIdentityError(
        `stored host-operation call '${operationRecordId}' is malformed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const parent = this.contextForChildWorkflowCall(record.identity.run_id);
    this.assertIdentity(record.identity, parent.identity);
    this.assertRegistrationDigest(
      parent,
      record.registration_sha256,
      "stored host-operation registration"
    );
    if (this.projectIdForChildWorkflowCall() !== record.project_id) {
      throw new CheckpointIdentityError(
        "stored host-operation project does not match the control-store project"
      );
    }
    return record;
  }

  hostOperationCallForDirective(
    runId: string,
    stateId: string,
    attempt: number,
    operationId: string
  ): HostOperationCallRecordV1 | undefined {
    const row = this.db
      .prepare(
        `SELECT operation_record_id FROM host_operation_calls
         WHERE run_id = ? AND state_id = ? AND attempt = ? AND operation_id = ?`
      )
      .get(runId, stateId, attempt, operationId);
    if (row === undefined) return undefined;
    return requiredCheckpointValue(
      this.hostOperationCall(
        sqliteText(row, "operation_record_id", "stored host-operation logical lookup")
      ),
      "indexed host-operation call"
    );
  }

  hostOperationCallsForRun(runId: string): readonly HostOperationCallRecordV1[] {
    const rows = this.db
      .prepare(
        `SELECT operation_record_id FROM host_operation_calls
         WHERE run_id = ? ORDER BY created_at, operation_record_id`
      )
      .all(runId);
    return rows.map((row) =>
      requiredCheckpointValue(
        this.hostOperationCall(
          sqliteText(row, "operation_record_id", "host-operation run call index")
        ),
        "indexed host-operation run call"
      )
    );
  }

  reserveHostOperationCall(input: ReserveHostOperationCallInput): ReserveHostOperationCallOutcome {
    let encoded: ReturnType<typeof encodeHostOperationCallRecord>;
    try {
      encoded = encodeHostOperationCallRecord(input.record);
    } catch (error) {
      throw new HostOperationCallConflictError(
        `host-operation reservation is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const requested = verifyHostOperationArtifactCustody(
      input.custody,
      this.projectIdForChildWorkflowCall(),
      encoded.record
    );
    if (
      requested.lifecycle !== "prepared" ||
      requested.created_at !== requested.updated_at ||
      requested.lease !== null ||
      requested.disposition !== null
    ) {
      throw new HostOperationCallConflictError(
        "a new host-operation reservation must be an initial prepared record"
      );
    }
    return this.transaction((): ReserveHostOperationCallOutcome => {
      const existing = this.hostOperationCallForDirective(
        requested.identity.run_id,
        requested.state_id,
        requested.attempt,
        requested.operation_id
      );
      if (existing !== undefined) {
        if (hostOperationCallImmutableJcs(existing) !== hostOperationCallImmutableJcs(requested)) {
          throw new HostOperationCallConflictError(
            "host-operation logical call was already prepared with different immutable operands"
          );
        }
        const parent = this.contextForChildWorkflowCall(existing.identity.run_id);
        if (
          existing.lifecycle !== "consumed" &&
          canonicalJson(parent.pendingDirective) !== canonicalJson(existing.directive)
        ) {
          throw new CheckpointIdentityError(
            "adopted host-operation call is not the parent's exact pending directive"
          );
        }
        return { kind: "adopted", record: existing };
      }
      if (this.hostOperationCall(requested.operation_record_id) !== undefined) {
        throw new HostOperationCallConflictError(
          "host-operation record ID is already bound to another logical call"
        );
      }
      const parent = this.contextForChildWorkflowCall(requested.identity.run_id);
      this.assertIdentity(requested.identity, parent.identity);
      this.assertRegistrationDigest(
        parent,
        requested.registration_sha256,
        "host-operation reservation registration"
      );
      if (parent.status !== "running" || parent.stateId !== requested.state_id) {
        throw new HostOperationCallConflictError(
          "host-operation parent is not running at the prepared state"
        );
      }
      const effectIdentity = requested.directive.effect_identity;
      if (
        effectIdentity !== undefined &&
        this.stateVisits(parent.identity.run_id).filter(
          (visit) => visit.state_id === parent.stateId
        ).length !== effectIdentity.visit
      )
        throw new HostOperationCallConflictError(
          "host-operation effect visit differs from durable current state visit"
        );
      if (canonicalJson(parent.pendingDirective) !== canonicalJson(requested.directive)) {
        throw new CheckpointIdentityError(
          "host-operation reservation requires the exact already-checkpointed pending directive"
        );
      }
      if (this.projectIdForChildWorkflowCall() !== requested.project_id) {
        throw new HostOperationCallConflictError(
          "host-operation project does not match the control-store project"
        );
      }
      this.db
        .prepare(
          `INSERT INTO host_operation_calls(
             operation_record_id, project_id, run_id, state_id, attempt, operation_id,
             lifecycle, record_jcs, record_sha256, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          requested.operation_record_id,
          requested.project_id,
          requested.identity.run_id,
          requested.state_id,
          requested.attempt,
          requested.operation_id,
          requested.lifecycle,
          encoded.record_jcs,
          encoded.record_sha256,
          requested.created_at,
          requested.updated_at
        );
      this.insertEvent(
        requested.identity.run_id,
        "host_operation_prepared",
        this.checkpointPayload(parent, {
          operation_record_id: requested.operation_record_id,
          operation_id: requested.operation_id,
          operation_kind: requested.operation_kind,
          directive_sha256: requested.directive_sha256,
          registration_sha256: requested.registration_sha256,
          request_sha256: requested.request_sha256,
        }),
        requested.created_at
      );
      const stored = requiredCheckpointValue(
        this.hostOperationCall(requested.operation_record_id),
        "prepared host-operation call"
      );
      if (canonicalJson(stored) !== encoded.record_jcs) {
        throw new CheckpointIdentityError("host-operation reservation did not round-trip exactly");
      }
      return { kind: "created", record: stored };
    });
  }

  transitionHostOperationCall(input: TransitionHostOperationCallInput): HostOperationCallRecordV1 {
    let encoded: ReturnType<typeof encodeHostOperationCallRecord>;
    try {
      encoded = encodeHostOperationCallRecord(input.next);
    } catch (error) {
      throw new HostOperationCallConflictError(
        `host-operation transition is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const next = verifyHostOperationArtifactCustody(
      input.custody,
      this.projectIdForChildWorkflowCall(),
      encoded.record
    );
    encoded = encodeHostOperationCallRecord(next);
    if (next.operation_record_id !== input.operation_record_id || next.lifecycle === "consumed") {
      throw new HostOperationCallConflictError(
        "host-operation transition changed its identity or attempted direct consumption"
      );
    }
    return this.transaction(() => {
      const current = requiredCheckpointValue(
        this.hostOperationCall(input.operation_record_id),
        "host-operation transition call"
      );
      const currentEncoded = encodeHostOperationCallRecord(current);
      if (
        current.lifecycle !== input.from ||
        currentEncoded.record_sha256 !== input.expected_record_sha256
      ) {
        throw new HostOperationCallConflictError(
          "host-operation transition compare-and-set lost its durable owner"
        );
      }
      if (hostOperationCallImmutableJcs(current) !== hostOperationCallImmutableJcs(next)) {
        throw new HostOperationCallConflictError(
          "host-operation transition changed immutable operands"
        );
      }
      if (next.created_at !== current.created_at || next.updated_at < current.updated_at) {
        throw new HostOperationCallConflictError(
          "host-operation transition changed or regressed durable timestamps"
        );
      }
      if (!isLegalHostOperationCallTransition(current.lifecycle, next.lifecycle)) {
        throw new HostOperationCallConflictError(
          `illegal host-operation lifecycle transition '${current.lifecycle}' -> '${next.lifecycle}'`
        );
      }
      if (
        current.result_wrapper !== undefined &&
        (next.result_wrapper === undefined ||
          canonicalJson(current.result_wrapper.plan) !== canonicalJson(next.result_wrapper.plan) ||
          (current.result_wrapper.ref !== null &&
            canonicalJson(current.result_wrapper.ref) !== canonicalJson(next.result_wrapper.ref)))
      )
        throw new HostOperationCallConflictError("host-operation wrapper milestone is immutable");
      if (current.lifecycle === "settled")
        for (const key of [
          "operation_result_ref",
          "output_artifacts",
          "platform_result_ref",
          "host_receipt_ref",
          "disposition",
          "persistence_plan",
          "lease_disposition_receipt_id",
        ] as const) {
          if (canonicalJson(current[key]) !== canonicalJson(next[key]))
            throw new HostOperationCallConflictError(
              "host-operation settled evidence is immutable"
            );
        }
      if (next.lifecycle === current.lifecycle && canonicalJson(next) === canonicalJson(current)) {
        return current;
      }
      const updated = this.db
        .prepare(
          `UPDATE host_operation_calls SET lifecycle = ?, record_jcs = ?, record_sha256 = ?, updated_at = ?
           WHERE operation_record_id = ? AND lifecycle = ? AND record_sha256 = ?`
        )
        .run(
          next.lifecycle,
          encoded.record_jcs,
          encoded.record_sha256,
          next.updated_at,
          input.operation_record_id,
          input.from,
          input.expected_record_sha256
        );
      if (numberValue(updated.changes) !== 1) {
        throw new HostOperationCallConflictError(
          "host-operation transition compare-and-set lost its durable owner"
        );
      }
      const stored = requiredCheckpointValue(
        this.hostOperationCall(input.operation_record_id),
        "transitioned host-operation call"
      );
      if (canonicalJson(stored) !== encoded.record_jcs) {
        throw new CheckpointIdentityError("host-operation transition did not round-trip exactly");
      }
      return stored;
    });
  }

  consumeHostOperationCall(input: ConsumeHostOperationCallInput): HostOperationCallRecordV1 {
    let encoded: ReturnType<typeof encodeHostOperationCallRecord>;
    try {
      encoded = encodeHostOperationCallRecord(input.next);
    } catch (error) {
      throw new HostOperationCallConflictError(
        `host-operation consumption is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const next = verifyHostOperationArtifactCustody(
      input.custody,
      this.projectIdForChildWorkflowCall(),
      encoded.record
    );
    encoded = encodeHostOperationCallRecord(next);
    if (next.operation_record_id !== input.operation_record_id || next.lifecycle !== "consumed") {
      throw new HostOperationCallConflictError(
        "host-operation consumption must retain its ID and use lifecycle 'consumed'"
      );
    }
    let persistedPayload = input.payload;
    const consumed = this.transaction(() => {
      const current = requiredCheckpointValue(
        this.hostOperationCall(input.operation_record_id),
        "host-operation consumption call"
      );
      const currentEncoded = encodeHostOperationCallRecord(current);
      if (current.lifecycle === "consumed") {
        if (canonicalJson(current) === encoded.record_jcs) return current;
        throw new HostOperationCallConflictError(
          "host-operation call was already consumed with different operands"
        );
      }
      if (
        current.lifecycle !== "settled" ||
        currentEncoded.record_sha256 !== input.expected_record_sha256
      ) {
        throw new HostOperationCallConflictError(
          "host-operation call is not the exact settled record ready for consumption"
        );
      }
      if (
        hostOperationCallImmutableJcs(current) !== hostOperationCallImmutableJcs(next) ||
        canonicalJson(current.lease) !== canonicalJson(next.lease) ||
        canonicalJson(current.disposition) !== canonicalJson(next.disposition) ||
        canonicalJson(current.operation_result_ref) !== canonicalJson(next.operation_result_ref) ||
        canonicalJson(current.output_artifacts) !== canonicalJson(next.output_artifacts) ||
        canonicalJson(current.result_wrapper ?? null) !==
          canonicalJson(next.result_wrapper ?? null) ||
        canonicalJson(current.platform_result_ref) !== canonicalJson(next.platform_result_ref) ||
        canonicalJson(current.host_receipt_ref) !== canonicalJson(next.host_receipt_ref) ||
        current.lease_disposition_receipt_id !== next.lease_disposition_receipt_id ||
        next.created_at !== current.created_at ||
        next.updated_at < current.updated_at
      ) {
        throw new HostOperationCallConflictError(
          "host-operation consumption changed settled evidence"
        );
      }
      this.assertIdentity(current.identity, input.parentContext.identity);
      const storedParent = this.contextForChildWorkflowCall(current.identity.run_id);
      if (
        input.expected_parent_snapshot_sha256 !== undefined &&
        sha256(canonicalJson(storedParent.snapshot())) !== input.expected_parent_snapshot_sha256
      )
        throw new HostOperationCallConflictError("host consumption lost current parent selections");
      if (
        storedParent.status !== "running" ||
        storedParent.stateId !== current.state_id ||
        canonicalJson(storedParent.pendingDirective) !== canonicalJson(current.directive)
      ) {
        throw new HostOperationCallConflictError(
          "host-operation parent changed before atomic consumption"
        );
      }
      this.assertRegistrationDigest(
        input.parentContext,
        current.registration_sha256,
        "host-operation parent consumption registration"
      );
      this.validatePositiveTerminalWrite(input.parentContext);
      persistedPayload = this.checkpointPayload(input.parentContext, input.payload);
      this.updateRun(input.parentContext);
      this.persistPendingGate(input.parentContext);
      const updated = this.db
        .prepare(
          `UPDATE host_operation_calls SET lifecycle = ?, record_jcs = ?, record_sha256 = ?, updated_at = ?
           WHERE operation_record_id = ? AND lifecycle = 'settled' AND record_sha256 = ?`
        )
        .run(
          next.lifecycle,
          encoded.record_jcs,
          encoded.record_sha256,
          next.updated_at,
          input.operation_record_id,
          input.expected_record_sha256
        );
      if (numberValue(updated.changes) !== 1) {
        throw new HostOperationCallConflictError(
          "host-operation consumption compare-and-set lost its durable owner"
        );
      }
      this.insertEvent(
        input.parentContext.identity.run_id,
        input.eventType,
        persistedPayload,
        now()
      );
      return requiredCheckpointValue(
        this.hostOperationCall(input.operation_record_id),
        "consumed host-operation call"
      );
    });
    input.parentContext.markCheckpointEvidencePersisted();
    this.observe(input.parentContext, input.eventType, persistedPayload);
    return consumed;
  }

  createRun(
    context: RunContext,
    eventType: string,
    payload: Record<string, JsonValue>,
    operationGroup?: ReserveOperationEventGroupInput
  ): void {
    const snapshot = context.snapshot();
    const identity = snapshot.identity;
    this.transaction(() => {
      this.assertNewRunCompletionProtocol(context);
      this.validatePositiveTerminalWrite(context);
      const existing = this.selectRun(identity.run_id);
      if (existing !== undefined) {
        this.assertIdentityRow(identity, existing);
        throw new CheckpointIdentityError(`run_id '${identity.run_id}' already exists`);
      }
      const timestamp = now();
      this.db
        .prepare(
          `INSERT INTO runs(
            run_id, session_id, playbook, engine_owner, schema_version,
            status, state_id, context_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          identity.run_id,
          identity.session_id,
          identity.playbook,
          identity.engine_owner,
          identity.schema_version,
          context.status,
          context.stateId,
          this.durableContextJson(context),
          timestamp,
          timestamp
        );
      if (operationGroup !== undefined) {
        if (
          operationGroup.run_id !== identity.run_id ||
          operationGroup.session_id !== identity.session_id
        ) {
          throw new CheckpointIdentityError(
            "initial operation group does not match the created run identity"
          );
        }
        this.reserveOperationEventGroupInTransaction(operationGroup);
      }
      this.persistPendingGate(context);
      this.insertEvent(
        identity.run_id,
        eventType,
        this.checkpointPayload(context, payload),
        timestamp
      );
    });
    const observedPayload = this.checkpointPayload(context, payload);
    context.markCheckpointEvidencePersisted();
    this.observe(context, eventType, observedPayload);
  }

  /**
   * Whether a durable run row exists for this run id (identity-agnostic probe;
   * callers that need identity binding use {@link loadRun}).
   */
  runExists(runId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS one FROM runs WHERE run_id = ?").get(runId);
    return row !== undefined;
  }

  /** Read one authoritative KB artifact metadata row from the control DB. */
  kbArtifact(artifactId: string): KbArtifactIndexRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM kb_run_artifacts WHERE artifact_id = ?")
      .get(artifactId);
    return row === undefined ? undefined : this.kbArtifactRecord(kbArtifactRow(row));
  }

  kbArtifacts(input: {
    run_id: string;
    state_id?: string;
    lifecycles?: readonly KbArtifactLifecycle[];
  }): KbArtifactIndexRecord[] {
    const clauses = ["run_id = ?"];
    const values: Array<string> = [input.run_id];
    if (input.state_id !== undefined) {
      clauses.push("state_id = ?");
      values.push(input.state_id);
    }
    if (input.lifecycles !== undefined) {
      if (input.lifecycles.length === 0) return [];
      clauses.push(`lifecycle IN (${input.lifecycles.map(() => "?").join(",")})`);
      values.push(...input.lifecycles);
    }
    return this.db
      .prepare(
        `SELECT * FROM kb_run_artifacts WHERE ${clauses.join(" AND ")}
         ORDER BY created_at,artifact_id`
      )
      .all(...values)
      .map((row) => this.kbArtifactRecord(kbArtifactRow(row)));
  }

  /**
   * Freeze one prepared artifact row before any work-plane byte. An exact
   * unfinished duplicate is returned for recovery; changed metadata is refused.
   * Prepared/discarding rows do not consume the phase quota, but the partial
   * unique index prevents a second unfinished artifact of the same kind.
   */
  prepareKbArtifact(
    input: PrepareKbArtifactInput,
    maxArtifacts: number
  ): { kind: "created" | "existing"; record: KbArtifactIndexRecord } {
    return this.transaction(() => {
      if (!this.runExists(input.run_id)) {
        throw new CheckpointIdentityError(`KB artifact run '${input.run_id}' is absent`);
      }
      const expectedFinal = `artifacts/${input.state_id}/${input.artifact_id}`;
      const expectedTemporary = `artifacts/${input.state_id}/.${input.artifact_id}.tmp`;
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.run_id) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.state_id) ||
        !/^art_[a-f0-9]{32}$/.test(input.artifact_id) ||
        !/^[a-f0-9]{64}$/.test(input.sha256) ||
        input.storage_key !== expectedFinal ||
        input.temporary_storage_key !== expectedTemporary ||
        input.lifecycle !== "prepared" ||
        input.schema_version !== 1
      ) {
        throw new ReceiptConflictError("KB artifact prepared metadata or exact keys are invalid");
      }
      const existingValue = this.db
        .prepare(
          `SELECT * FROM kb_run_artifacts
           WHERE run_id=? AND state_id=? AND artifact_kind=?
             AND lifecycle IN ('prepared','staged')`
        )
        .get(input.run_id, input.state_id, input.artifact_kind);
      const existing = existingValue === undefined ? undefined : kbArtifactRow(existingValue);
      if (existing !== undefined) {
        const record = this.kbArtifactRecord(existing);
        if (
          record.kb_profile_id !== input.kb_profile_id ||
          record.media_type !== input.media_type ||
          record.sha256 !== input.sha256 ||
          record.byte_length !== input.byte_length
        ) {
          throw new ReceiptConflictError("KB phase already owns a different unfinished artifact");
        }
        return { kind: "existing" as const, record };
      }
      const count = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM kb_run_artifacts
           WHERE run_id=? AND state_id=? AND lifecycle='staged'`
        )
        .get(input.run_id, input.state_id);
      if (count === undefined) malformedSqliteColumn("KB artifact phase count", "count");
      if (sqliteInteger(count, "count", "KB artifact phase count") >= maxArtifacts) {
        throw new ReceiptConflictError("KB artifact phase count exceeded");
      }
      this.db
        .prepare(
          `INSERT INTO kb_run_artifacts(
            artifact_id,run_id,state_id,kb_profile_id,artifact_kind,media_type,
            sha256,byte_length,storage_key,temporary_storage_key,lifecycle,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`
        )
        .run(
          input.artifact_id,
          input.run_id,
          input.state_id,
          input.kb_profile_id,
          input.artifact_kind,
          input.media_type,
          input.sha256,
          input.byte_length,
          input.storage_key,
          input.temporary_storage_key,
          input.created_at,
          input.updated_at
        );
      return {
        kind: "created" as const,
        record: requiredCheckpointValue(this.kbArtifact(input.artifact_id), "created KB artifact"),
      };
    });
  }

  kbArtifactMarkStaged(artifactId: string, runId: string): KbArtifactIndexRecord {
    return this.transaction(() => {
      const current = this.kbArtifact(artifactId);
      if (current === undefined || current.run_id !== runId) {
        throw new CheckpointIdentityError("KB artifact staged CAS owner is not exact");
      }
      if (current.lifecycle === "staged") return current;
      if (current.lifecycle !== "prepared") {
        throw new ReceiptConflictError("KB artifact is not prepared for staged CAS");
      }
      const changed = this.db
        .prepare(
          `UPDATE kb_run_artifacts
           SET lifecycle='staged',temporary_storage_key=NULL,updated_at=?
           WHERE artifact_id=? AND run_id=? AND lifecycle='prepared'`
        )
        .run(now(), artifactId, runId);
      if (Number(changed.changes) !== 1) {
        throw new ReceiptConflictError("lost KB artifact staged CAS");
      }
      return requiredCheckpointValue(this.kbArtifact(artifactId), "staged KB artifact");
    });
  }

  kbArtifactBeginDiscarding(artifactId: string, runId: string): KbArtifactIndexRecord {
    return this.transaction(() => {
      const current = this.kbArtifact(artifactId);
      if (current === undefined || current.run_id !== runId) {
        throw new CheckpointIdentityError("KB artifact discard owner is not exact");
      }
      if (current.lifecycle === "discarding" || current.lifecycle === "discarded") return current;
      if (current.lifecycle !== "prepared") {
        throw new ReceiptConflictError("only a prepared KB artifact may be discarded");
      }
      const changed = this.db
        .prepare(
          `UPDATE kb_run_artifacts SET lifecycle='discarding',updated_at=?
           WHERE artifact_id=? AND run_id=? AND lifecycle='prepared'`
        )
        .run(now(), artifactId, runId);
      if (Number(changed.changes) !== 1) {
        throw new ReceiptConflictError("lost KB artifact discarding CAS");
      }
      return requiredCheckpointValue(this.kbArtifact(artifactId), "discarding KB artifact");
    });
  }

  kbArtifactFinishDiscarded(artifactId: string, runId: string): KbArtifactIndexRecord {
    return this.transaction(() => {
      const current = this.kbArtifact(artifactId);
      if (current === undefined || current.run_id !== runId) {
        throw new CheckpointIdentityError("KB artifact cleanup owner is not exact");
      }
      if (current.lifecycle === "discarded") return current;
      if (current.lifecycle !== "discarding") {
        throw new ReceiptConflictError("KB artifact is not in its cleanup window");
      }
      const changed = this.db
        .prepare(
          `UPDATE kb_run_artifacts
           SET lifecycle='discarded',temporary_storage_key=NULL,updated_at=?
           WHERE artifact_id=? AND run_id=? AND lifecycle='discarding'`
        )
        .run(now(), artifactId, runId);
      if (Number(changed.changes) !== 1) {
        throw new ReceiptConflictError("lost KB artifact discarded CAS");
      }
      return requiredCheckpointValue(this.kbArtifact(artifactId), "discarded KB artifact");
    });
  }

  /** Atomically transition an exact artifact set for host-owned lifecycle work. */
  transitionKbArtifacts(input: {
    run_id: string;
    artifact_ids: readonly string[];
    from: KbArtifactLifecycle;
    to: KbArtifactLifecycle;
    allow_already_to?: boolean;
  }): void {
    this.transaction(() => {
      if (new Set(input.artifact_ids).size !== input.artifact_ids.length) {
        throw new ReceiptConflictError("KB artifact transition ids are not unique");
      }
      for (const artifactId of input.artifact_ids) {
        const current = this.kbArtifact(artifactId);
        if (
          current !== undefined &&
          current.run_id === input.run_id &&
          input.allow_already_to === true &&
          current.lifecycle === input.to
        ) {
          continue;
        }
        const changed = this.db
          .prepare(
            `UPDATE kb_run_artifacts SET lifecycle=?,updated_at=?
             WHERE artifact_id=? AND run_id=? AND lifecycle=?`
          )
          .run(input.to, now(), artifactId, input.run_id, input.from);
        if (Number(changed.changes) !== 1) {
          throw new ReceiptConflictError("KB artifact lifecycle transition is not exact");
        }
      }
    });
  }

  kbPhaseOperandsRecord(runId: string, stateId: string): KbPhaseOperandsRecord | undefined {
    const rowValue = this.db
      .prepare("SELECT * FROM kb_phase_operands WHERE run_id=? AND state_id=?")
      .get(runId, stateId);
    if (rowValue === undefined) return undefined;
    const row = kbPhaseOperandsRow(rowValue);
    if (sha256(row.operands_jcs) !== row.operands_sha256) {
      throw new ReceiptConflictError("KB phase operands digest mismatch");
    }
    const parsedValue: unknown = JSON.parse(row.operands_jcs);
    const parsed = validateKbPhaseOperandsMetadata(parsedValue);
    const lifecycle = String(row.lifecycle);
    const closedResultSha256 =
      row.closed_result_sha256 === null ? undefined : String(row.closed_result_sha256);
    const closedAt = row.closed_at === null ? undefined : String(row.closed_at);
    if (
      canonicalJson(parsed) !== row.operands_jcs ||
      parsed.schema_version !== 1 ||
      parsed.run_id !== runId ||
      parsed.state_id !== stateId ||
      (lifecycle !== "open" && lifecycle !== "closed") ||
      (lifecycle === "open" && (closedResultSha256 !== undefined || closedAt !== undefined)) ||
      (lifecycle === "closed" &&
        (!/^[a-f0-9]{64}$/.test(closedResultSha256 ?? "") || closedAt === undefined))
    ) {
      throw new ReceiptConflictError("KB phase operands are not exact canonical metadata");
    }
    if (lifecycle === "closed") {
      const result = this.kbPhaseResult(runId, stateId);
      if (result === undefined || result.result_sha256 !== closedResultSha256) {
        throw new ReceiptConflictError("closed KB phase operands lost their terminating result");
      }
    }
    return {
      schema_version: 1,
      operands: parsed,
      operands_sha256: String(row.operands_sha256),
      lifecycle,
      created_at: String(row.created_at),
      ...(closedResultSha256 === undefined ? {} : { closed_result_sha256: closedResultSha256 }),
      ...(closedAt === undefined ? {} : { closed_at: closedAt }),
    };
  }

  kbPhaseOperands(runId: string, stateId: string): KbPhaseOperands | undefined {
    return this.kbPhaseOperandsRecord(runId, stateId)?.operands;
  }

  /** Fail unless one exact operand set is still usable by its live child session. */
  requireOpenKbPhaseOperands(runId: string, stateId: string): KbPhaseOperands {
    const record = this.kbPhaseOperandsRecord(runId, stateId);
    if (record === undefined || record.lifecycle !== "open") {
      throw new ReceiptConflictError("KB phase operands are absent or closed");
    }
    return record.operands;
  }

  /** Freeze or exactly replay one body-free open phase operand set. */
  bindKbPhaseOperands(input: KbPhaseOperands): KbPhaseOperands {
    validateKbPhaseOperandsMetadata(input);
    return this.transaction(() => {
      const run = this.selectRun(input.run_id);
      if (
        run === undefined ||
        run.session_id !== input.session_id ||
        !/^[a-f0-9]{64}$/.test(input.admitted_policy_sha256)
      ) {
        throw new CheckpointIdentityError("KB phase operands do not match their durable run");
      }
      const durable = this.contextFromRunRow(run);
      if (
        durable.identity.playbook !== "knowledge-base" ||
        durable.identity.session_id !== input.session_id ||
        String(durable.knowledgeBaseData.profile_id ?? "") !== input.kb_profile_id ||
        String(durable.knowledgeBaseData.action ?? "") !== input.operation ||
        String(durable.knowledgeBaseData.admitted_policy_sha256 ?? "") !==
          input.admitted_policy_sha256
      ) {
        throw new CheckpointIdentityError("KB phase operands exceed their durable run binding");
      }
      const privateInput = this.getPrivateInput(input.run_id);
      if (
        privateInput === undefined ||
        privateInput.state !== "active" ||
        privateInput.request_sha256 !== input.private_input_sha256
      ) {
        throw new CheckpointIdentityError("KB phase operands lost their private-input binding");
      }
      if (
        input.compose_authority !== undefined &&
        (input.compose_authority.private_input_sha256 !== input.private_input_sha256 ||
          String(durable.knowledgeBaseData.kb_id ?? "") !== input.compose_authority.kb_id)
      ) {
        throw new CheckpointIdentityError(
          "KB compose authority does not match the KB/private-input run binding"
        );
      }
      const existing = this.kbPhaseOperandsRecord(input.run_id, input.state_id);
      const jcs = canonicalJson(input);
      if (existing !== undefined) {
        if (existing.lifecycle !== "open") {
          throw new ReceiptConflictError("KB phase operands are closed and cannot be rebound");
        }
        if (canonicalJson(existing.operands) !== jcs) {
          throw new ReceiptConflictError("KB phase operands changed across restart");
        }
        return existing.operands;
      }
      if (
        new Set(input.source_ids).size !== input.source_ids.length ||
        new Set(input.prior_state_ids).size !== input.prior_state_ids.length ||
        new Set(input.allowed_prior_artifacts.map((entry) => entry.handle.artifact_id)).size !==
          input.allowed_prior_artifacts.length
      ) {
        throw new ReceiptConflictError("KB phase operands contain duplicate authorities");
      }
      for (const operand of input.allowed_prior_artifacts) {
        const record = this.kbArtifact(operand.handle.artifact_id);
        if (
          record === undefined ||
          record.run_id !== operand.run_id ||
          record.state_id !== operand.state_id ||
          record.lifecycle !== "sealed" ||
          canonicalJson(this.kbArtifactHandle(record)) !== canonicalJson(operand.handle)
        ) {
          throw new ReceiptConflictError("KB phase prior-artifact operand is not exact and sealed");
        }
      }
      this.db
        .prepare(
          `INSERT INTO kb_phase_operands(
             run_id,state_id,operands_jcs,operands_sha256,lifecycle,
             closed_result_sha256,created_at,closed_at
           ) VALUES (?,?,?,?,'open',NULL,?,NULL)`
        )
        .run(input.run_id, input.state_id, jcs, sha256(jcs), now());
      return this.requireOpenKbPhaseOperands(input.run_id, input.state_id);
    });
  }

  kbPhaseResult(runId: string, stateId: string): KbPhaseResultRecord | undefined {
    const rowValue = this.db
      .prepare("SELECT * FROM kb_phase_results WHERE run_id=? AND state_id=?")
      .get(runId, stateId);
    if (rowValue === undefined) return undefined;
    const row = kbPhaseResultRow(rowValue);
    if (sha256(row.result_jcs) !== row.result_sha256) {
      throw new ReceiptConflictError("KB phase result digest mismatch");
    }
    const ids: unknown = JSON.parse(row.artifact_ids_jcs);
    if (!isStringArray(ids)) {
      throw new ReceiptConflictError("KB phase result artifact ids are invalid");
    }
    return {
      phase_result_id: String(row.phase_result_id),
      run_id: String(row.run_id),
      state_id: String(row.state_id),
      result_jcs: String(row.result_jcs),
      result_sha256: String(row.result_sha256),
      artifact_ids: ids,
      created_at: String(row.created_at),
    };
  }

  /** One transaction: body-free terminating result plus staged → sealed. */
  sealKbArtifactsWithPhaseResult(input: {
    run_id: string;
    state_id: string;
    kb_profile_id: string;
    result_jcs: string;
    handles: readonly KbArtifactHandle[];
  }): KbPhaseResultRecord {
    assertKbPhaseResultBodyFree(input.result_jcs);
    return this.transaction(() => {
      const artifactIds = input.handles.map((handle) => handle.artifact_id);
      if (artifactIds.length === 0 || new Set(artifactIds).size !== artifactIds.length) {
        throw new ReceiptConflictError("KB phase result handles are empty or duplicated");
      }
      const operandRecord = this.kbPhaseOperandsRecord(input.run_id, input.state_id);
      const existing = this.kbPhaseResult(input.run_id, input.state_id);
      if (existing !== undefined) {
        if (
          existing.result_jcs !== input.result_jcs ||
          canonicalJson(existing.artifact_ids) !== canonicalJson(artifactIds) ||
          (operandRecord !== undefined &&
            (operandRecord.lifecycle !== "closed" ||
              operandRecord.closed_result_sha256 !== existing.result_sha256))
        ) {
          throw new ReceiptConflictError("KB phase already has a different terminating result");
        }
        for (const handle of input.handles) {
          const record = this.kbArtifact(handle.artifact_id);
          if (
            record === undefined ||
            record.lifecycle !== "sealed" ||
            canonicalJson(this.kbArtifactHandle(record)) !== canonicalJson(handle)
          ) {
            throw new ReceiptConflictError("stored KB phase result lost its sealed artifact");
          }
        }
        return existing;
      }
      if (operandRecord === undefined) {
        throw new ReceiptConflictError("KB phase cannot terminate without durable operands");
      }
      if (operandRecord.lifecycle !== "open") {
        throw new ReceiptConflictError("KB phase operands closed without their terminating result");
      }
      const records = input.handles.map((handle) => {
        const record = this.kbArtifact(handle.artifact_id);
        if (
          record === undefined ||
          record.run_id !== input.run_id ||
          record.state_id !== input.state_id ||
          record.kb_profile_id !== input.kb_profile_id ||
          record.lifecycle !== "staged" ||
          canonicalJson(this.kbArtifactHandle(record)) !== canonicalJson(handle)
        ) {
          throw new ReceiptConflictError("KB phase result handle is not exact, staged, and owned");
        }
        return record;
      });
      const timestamp = now();
      const phaseResultId = `phase_${randomUUID().replace(/-/g, "")}`;
      this.db
        .prepare(
          `INSERT INTO kb_phase_results(
             phase_result_id,run_id,state_id,result_jcs,result_sha256,artifact_ids_jcs,created_at
           ) VALUES (?,?,?,?,?,?,?)`
        )
        .run(
          phaseResultId,
          input.run_id,
          input.state_id,
          input.result_jcs,
          sha256(input.result_jcs),
          canonicalJson(artifactIds),
          timestamp
        );
      for (const record of records) {
        const changed = this.db
          .prepare(
            `UPDATE kb_run_artifacts SET lifecycle='sealed',updated_at=?
             WHERE artifact_id=? AND run_id=? AND state_id=? AND lifecycle='staged'`
          )
          .run(timestamp, record.artifact_id, input.run_id, input.state_id);
        if (Number(changed.changes) !== 1) {
          throw new ReceiptConflictError("lost KB phase artifact seal CAS");
        }
      }
      if (operandRecord !== undefined) {
        const closed = this.db
          .prepare(
            `UPDATE kb_phase_operands
             SET lifecycle='closed',closed_result_sha256=?,closed_at=?
             WHERE run_id=? AND state_id=? AND lifecycle='open'
               AND closed_result_sha256 IS NULL AND closed_at IS NULL`
          )
          .run(sha256(input.result_jcs), timestamp, input.run_id, input.state_id);
        if (Number(closed.changes) !== 1) {
          throw new ReceiptConflictError("lost KB phase operand close CAS");
        }
      }
      return requiredCheckpointValue(
        this.kbPhaseResult(input.run_id, input.state_id),
        "sealed KB phase result"
      );
    });
  }

  private kbArtifactRecord(row: KbArtifactRow): KbArtifactIndexRecord {
    const record: KbArtifactIndexRecord = {
      schema_version: 1,
      artifact_id: row.artifact_id,
      run_id: row.run_id,
      state_id: row.state_id,
      kb_profile_id: row.kb_profile_id,
      artifact_kind: validateKbContract(
        ArtifactKindSchema,
        row.artifact_kind,
        "stored KB artifact kind"
      ),
      media_type: validateKbContract(
        ArtifactMediaTypeSchema,
        row.media_type,
        "stored KB artifact media type"
      ),
      sha256: row.sha256,
      byte_length: row.byte_length,
      storage_key: row.storage_key,
      ...(row.temporary_storage_key === null
        ? {}
        : { temporary_storage_key: row.temporary_storage_key }),
      lifecycle: validateKbContract(
        KbArtifactLifecycleSchema,
        row.lifecycle,
        "stored KB artifact lifecycle"
      ),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    const expectedFinal = `artifacts/${record.state_id}/${record.artifact_id}`;
    const expectedTemporary = `artifacts/${record.state_id}/.${record.artifact_id}.tmp`;
    if (
      record.storage_key !== expectedFinal ||
      (record.temporary_storage_key !== undefined &&
        record.temporary_storage_key !== expectedTemporary) ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    ) {
      throw new ReceiptConflictError("stored KB artifact metadata or keys are not exact");
    }
    return record;
  }

  private kbArtifactHandle(record: KbArtifactIndexRecord): KbArtifactHandle {
    return {
      schema_version: 1,
      artifact_id: record.artifact_id,
      artifact_kind: record.artifact_kind,
      sha256: record.sha256,
      media_type: record.media_type,
      byte_length: record.byte_length,
    } as KbArtifactHandle;
  }

  kbInitReservation(profileId: string): InitReservation | undefined {
    const row = this.db
      .prepare("SELECT * FROM kb_init_reservations WHERE kb_profile_id=?")
      .get(profileId);
    return row === undefined ? undefined : this.kbInitReservationRecord(initReservationRow(row));
  }

  kbInitReservationByTransaction(transactionId: string): InitReservation | undefined {
    const row = this.db
      .prepare("SELECT * FROM kb_init_reservations WHERE transaction_id=?")
      .get(transactionId);
    return row === undefined ? undefined : this.kbInitReservationRecord(initReservationRow(row));
  }

  private kbInitReservationRecord(row: InitReservationRow): InitReservation {
    return validateKbContract(
      InitReservationSchema,
      {
        schema_version: 1,
        kb_profile_id: String(row.kb_profile_id),
        run_id: String(row.run_id),
        transaction_id: String(row.transaction_id),
        request_sha256: String(row.request_sha256),
        profile_commitment_sha256: String(row.profile_commitment_sha256),
        kb_id: String(row.kb_id),
        generation_id: String(row.generation_id),
        state: String(row.state),
        updated_at: String(row.updated_at),
      },
      "stored KB init reservation"
    );
  }

  private reserveKbInitInTransaction(input: InitReservation): InitReservation {
    const reservation = validateKbContract(InitReservationSchema, input, "KB init reservation");
    if (reservation.state !== "reserved") {
      throw new ReceiptConflictError("new KB init reservation must begin reserved");
    }
    const existing = this.kbInitReservation(reservation.kb_profile_id);
    if (existing !== undefined) {
      if (existing.transaction_id !== reservation.transaction_id) {
        throw new ReceiptConflictError("init_in_progress");
      }
      if (existing.profile_commitment_sha256 !== reservation.profile_commitment_sha256) {
        throw new ReceiptConflictError("profile_remapped");
      }
      const immutable = (value: InitReservation) => ({
        schema_version: value.schema_version,
        kb_profile_id: value.kb_profile_id,
        run_id: value.run_id,
        transaction_id: value.transaction_id,
        request_sha256: value.request_sha256,
        profile_commitment_sha256: value.profile_commitment_sha256,
        kb_id: value.kb_id,
        generation_id: value.generation_id,
      });
      if (canonicalJson(immutable(existing)) !== canonicalJson(immutable(reservation))) {
        throw new ReceiptConflictError("KB init reservation identity changed");
      }
      if (existing.state === "released") {
        throw new ReceiptConflictError("released KB init reservation cannot recover");
      }
      return existing;
    }
    const transactionOwner = this.kbInitReservationByTransaction(reservation.transaction_id);
    if (transactionOwner !== undefined) {
      throw new ReceiptConflictError("KB init transaction is already bound to another profile");
    }
    this.db
      .prepare(
        `INSERT INTO kb_init_reservations(
           kb_profile_id,run_id,transaction_id,request_sha256,profile_commitment_sha256,
           kb_id,generation_id,state,updated_at
         ) VALUES (?,?,?,?,?,?,?,'reserved',?)`
      )
      .run(
        reservation.kb_profile_id,
        reservation.run_id,
        reservation.transaction_id,
        reservation.request_sha256,
        reservation.profile_commitment_sha256,
        reservation.kb_id,
        reservation.generation_id,
        reservation.updated_at
      );
    return requiredCheckpointValue(
      this.kbInitReservation(reservation.kb_profile_id),
      "created KB init reservation"
    );
  }

  /**
   * Preindex one complete publication transaction and its closed ordered file
   * set in a single FULL-synchronous control-DB transaction. Base-none init
   * reserves its normalized profile commitment and immutable identities in
   * this same transaction, before any KB-root byte is written.
   */
  planKbPublication(
    input: KbPublicationTransaction,
    initReservation?: InitReservation
  ): KbPublicationTransaction {
    const planned = validateKbContract(
      KbPublicationTransactionSchema,
      input,
      "planned KB publication"
    );
    if (planned.lifecycle !== "planned" || planned.selector_jcs !== undefined) {
      throw new ReceiptConflictError(
        "new KB publication must begin planned without selector bytes"
      );
    }
    if (
      planned.files.length === 0 ||
      planned.files.some(
        (file) =>
          file.transaction_id !== planned.transaction_id ||
          file.state !== "planned" ||
          file.sha256 !== undefined ||
          file.byte_length !== undefined
      )
    ) {
      throw new ReceiptConflictError("planned KB publication file set is incomplete");
    }
    const roleCount = (role: PublicationFileRecord["role"]): number =>
      planned.files.filter((file) => file.role === role).length;
    const pageCount = roleCount("page_markdown");
    const commonInvalid =
      roleCount("catalog") !== 1 ||
      roleCount("index") !== 1 ||
      roleCount("selector") !== 1 ||
      pageCount !== roleCount("claims");
    const initInvalid =
      planned.action === "init" &&
      (planned.files.length !== 5 || roleCount("manifest") !== 1 || roleCount("policy") !== 1);
    const mutationInvalid =
      planned.action !== "init" &&
      (roleCount("manifest") !== 0 || roleCount("policy") !== 0 || pageCount === 0);
    const sourceInvalid =
      (planned.action === "save" &&
        (roleCount("source_object") !== 0 || roleCount("source_record") !== 0)) ||
      (planned.action === "ingest" && roleCount("source_record") === 0);
    if (commonInvalid || initInvalid || mutationInvalid || sourceInvalid) {
      throw new ReceiptConflictError("planned KB publication role/cardinality matrix is invalid");
    }
    if ((planned.action === "init") !== (initReservation !== undefined)) {
      throw new ReceiptConflictError("base-none publication requires exactly one init reservation");
    }
    return this.transaction(() => {
      if (initReservation !== undefined) {
        if (
          initReservation.kb_profile_id !== planned.kb_profile_id ||
          initReservation.run_id !== planned.run_id ||
          initReservation.transaction_id !== planned.transaction_id ||
          initReservation.kb_id !== planned.kb_id ||
          initReservation.generation_id !== planned.candidate_generation_id
        ) {
          throw new ReceiptConflictError("KB init reservation does not bind the publication");
        }
        this.reserveKbInitInTransaction(initReservation);
      }
      const existing = this.kbPublication(planned.transaction_id);
      if (existing !== undefined) {
        const immutable = (value: KbPublicationTransaction) => ({
          schema_version: value.schema_version,
          run_id: value.run_id,
          transaction_id: value.transaction_id,
          kb_profile_id: value.kb_profile_id,
          kb_id: value.kb_id,
          action: value.action,
          base_generation_id: value.base_generation_id,
          base_selector_sha256: value.base_selector_sha256,
          candidate_generation_id: value.candidate_generation_id,
          staging_root: value.staging_root,
          generation_staging_key: value.generation_staging_key,
          generation_final_key: value.generation_final_key,
          files: value.files.map((file) => ({
            publication_file_id: file.publication_file_id,
            transaction_id: file.transaction_id,
            role: file.role,
            staging_key: file.staging_key,
            final_key: file.final_key,
          })),
        });
        if (canonicalJson(immutable(existing)) !== canonicalJson(immutable(planned))) {
          throw new ReceiptConflictError(
            "KB publication transaction identity or file plan changed"
          );
        }
        return existing;
      }
      this.db
        .prepare(
          `INSERT INTO kb_publication_transactions (
             transaction_id,run_id,kb_profile_id,kb_id,action,base_generation_id,
             base_selector_sha256,candidate_generation_id,staging_root,
             generation_staging_key,generation_final_key,selector_jcs,selector_sha256,
             lifecycle,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'planned',?,?)`
        )
        .run(
          planned.transaction_id,
          planned.run_id,
          planned.kb_profile_id,
          planned.kb_id,
          planned.action,
          planned.base_generation_id,
          planned.base_selector_sha256,
          planned.candidate_generation_id,
          planned.staging_root,
          planned.generation_staging_key,
          planned.generation_final_key,
          planned.created_at,
          planned.updated_at
        );
      const insert = this.db.prepare(
        `INSERT INTO kb_publication_files (
           publication_file_id,transaction_id,role,staging_key,final_key,sha256,byte_length,state
         ) VALUES (?,?,?,?,?,NULL,NULL,'planned')`
      );
      for (const file of planned.files) {
        insert.run(
          file.publication_file_id,
          file.transaction_id,
          file.role,
          file.staging_key,
          file.final_key
        );
      }
      return requiredCheckpointValue(
        this.kbPublication(planned.transaction_id),
        "planned KB publication"
      );
    });
  }

  kbPublication(transactionId: string): KbPublicationTransaction | undefined {
    const row = this.db
      .prepare("SELECT * FROM kb_publication_transactions WHERE transaction_id=?")
      .get(transactionId) as Record<string, SQLOutputValue> | undefined;
    if (row === undefined) return undefined;
    const fileRows = this.db
      .prepare(
        `SELECT * FROM kb_publication_files
         WHERE transaction_id=? ORDER BY role,final_key`
      )
      .all(transactionId) as Array<Record<string, SQLOutputValue>>;
    const files = fileRows.map((file) =>
      validateKbContract(
        PublicationFileRecordSchema,
        {
          schema_version: 1,
          publication_file_id: String(file["publication_file_id"]),
          transaction_id: String(file["transaction_id"]),
          role: String(file["role"]),
          staging_key: String(file["staging_key"]),
          final_key: String(file["final_key"]),
          ...(file["sha256"] === null || file["sha256"] === undefined
            ? {}
            : { sha256: String(file["sha256"]) }),
          ...(file["byte_length"] === null || file["byte_length"] === undefined
            ? {}
            : { byte_length: Number(file["byte_length"]) }),
          state: String(file["state"]),
        },
        "stored KB publication file"
      )
    );
    return validateKbContract(
      KbPublicationTransactionSchema,
      {
        schema_version: 1,
        run_id: String(row["run_id"]),
        transaction_id: String(row["transaction_id"]),
        kb_profile_id: String(row["kb_profile_id"]),
        kb_id: String(row["kb_id"]),
        action: String(row["action"]),
        base_generation_id:
          row["base_generation_id"] === null ? null : String(row["base_generation_id"]),
        base_selector_sha256:
          row["base_selector_sha256"] === null ? null : String(row["base_selector_sha256"]),
        candidate_generation_id: String(row["candidate_generation_id"]),
        staging_root: String(row["staging_root"]),
        generation_staging_key: String(row["generation_staging_key"]),
        generation_final_key: String(row["generation_final_key"]),
        ...(row["selector_jcs"] === null || row["selector_jcs"] === undefined
          ? {}
          : { selector_jcs: String(row["selector_jcs"]) }),
        ...(row["selector_sha256"] === null || row["selector_sha256"] === undefined
          ? {}
          : { selector_sha256: String(row["selector_sha256"]) }),
        lifecycle: String(row["lifecycle"]),
        files,
        created_at: String(row["created_at"]),
        updated_at: String(row["updated_at"]),
      },
      "stored KB publication"
    );
  }

  storeKbPublicationSelector(input: {
    transaction_id: string;
    selector_jcs: string;
    selector_sha256: string;
  }): KbPublicationTransaction {
    return this.transaction(() => {
      const current = this.kbPublication(input.transaction_id);
      if (current === undefined) throw new ReceiptConflictError("KB publication is absent");
      if (current.selector_jcs !== undefined) {
        if (
          current.selector_jcs !== input.selector_jcs ||
          current.selector_sha256 !== input.selector_sha256
        ) {
          throw new ReceiptConflictError("stored KB selector intent changed");
        }
        return current;
      }
      if (current.lifecycle !== "planned") {
        throw new ReceiptConflictError("KB selector intent was not stored while planned");
      }
      const changed = this.db
        .prepare(
          `UPDATE kb_publication_transactions
           SET selector_jcs=?,selector_sha256=?,updated_at=?
           WHERE transaction_id=? AND lifecycle='planned' AND selector_jcs IS NULL`
        )
        .run(input.selector_jcs, input.selector_sha256, now(), input.transaction_id);
      if (Number(changed.changes) !== 1) {
        throw new ReceiptConflictError("lost KB selector intent CAS");
      }
      return requiredCheckpointValue(
        this.kbPublication(input.transaction_id),
        "stored KB selector intent"
      );
    });
  }

  stageKbPublicationFile(input: {
    transaction_id: string;
    publication_file_id: string;
    sha256: string;
    byte_length: number;
  }): PublicationFileRecord {
    return this.transaction(() => {
      const publication = this.kbPublication(input.transaction_id);
      const current = publication?.files.find(
        (file) => file.publication_file_id === input.publication_file_id
      );
      if (current === undefined) throw new ReceiptConflictError("KB publication file is absent");
      if (current.state !== "planned") {
        if (current.sha256 !== input.sha256 || current.byte_length !== input.byte_length) {
          throw new ReceiptConflictError("staged KB publication file bytes changed");
        }
        return current;
      }
      const changed = this.db
        .prepare(
          `UPDATE kb_publication_files SET state='staged',sha256=?,byte_length=?
           WHERE publication_file_id=? AND transaction_id=? AND state='planned'`
        )
        .run(input.sha256, input.byte_length, input.publication_file_id, input.transaction_id);
      if (Number(changed.changes) !== 1) {
        throw new ReceiptConflictError("lost KB publication file staged CAS");
      }
      const stagedPublication = requiredCheckpointValue(
        this.kbPublication(input.transaction_id),
        "staged KB publication"
      );
      return requiredCheckpointValue(
        stagedPublication.files.find(
          (file) => file.publication_file_id === input.publication_file_id
        ),
        "staged KB publication file"
      );
    });
  }

  publishKbPublicationFile(
    transactionId: string,
    publicationFileId: string
  ): PublicationFileRecord {
    return this.transaction(() => {
      const current = this.kbPublication(transactionId)?.files.find(
        (file) => file.publication_file_id === publicationFileId
      );
      if (current === undefined) throw new ReceiptConflictError("KB publication file is absent");
      if (current.state === "published") return current;
      if (current.state !== "staged") {
        throw new ReceiptConflictError("only a staged KB publication file may publish");
      }
      const changed = this.db
        .prepare(
          `UPDATE kb_publication_files SET state='published'
           WHERE publication_file_id=? AND transaction_id=? AND state='staged'`
        )
        .run(publicationFileId, transactionId);
      if (Number(changed.changes) !== 1) {
        throw new ReceiptConflictError("lost KB publication file published CAS");
      }
      const publishedPublication = requiredCheckpointValue(
        this.kbPublication(transactionId),
        "published KB publication"
      );
      return requiredCheckpointValue(
        publishedPublication.files.find((file) => file.publication_file_id === publicationFileId),
        "published KB publication file"
      );
    });
  }

  /**
   * One control-DB commit for selector file evidence, publication lifecycle,
   * and the base-none init reservation. This repairs an exact crash-after-link
   * retry without exposing a split reservation/lifecycle state.
   */
  commitKbPublicationSelector(
    transactionId: string,
    publicationFileId: string
  ): KbPublicationTransaction {
    return this.transaction(() => {
      const publication = this.kbPublication(transactionId);
      const selector = publication?.files.find(
        (file) => file.publication_file_id === publicationFileId
      );
      if (publication === undefined || selector === undefined || selector.role !== "selector") {
        throw new ReceiptConflictError("KB selector publication owner is not exact");
      }
      if (
        ["selector_committed", "finalizing", "complete"].includes(publication.lifecycle) &&
        selector.state === "published"
      ) {
        this.syncKbInitReservationInTransaction(publication, "selector_committed");
        return publication;
      }
      if (publication.lifecycle !== "generation_published" || selector.state !== "staged") {
        throw new ReceiptConflictError("KB selector is not at its exact commit CAS");
      }
      if (
        publication.files.some(
          (file) =>
            file.role !== "selector" &&
            (file.state !== "published" ||
              file.sha256 === undefined ||
              file.byte_length === undefined)
        )
      ) {
        throw new ReceiptConflictError("KB selector commit lacks the complete published file set");
      }
      const timestamp = now();
      const fileChanged = this.db
        .prepare(
          `UPDATE kb_publication_files SET state='published'
           WHERE publication_file_id=? AND transaction_id=? AND state='staged'`
        )
        .run(publicationFileId, transactionId);
      const publicationChanged = this.db
        .prepare(
          `UPDATE kb_publication_transactions SET lifecycle='selector_committed',updated_at=?
           WHERE transaction_id=? AND lifecycle='generation_published'`
        )
        .run(timestamp, transactionId);
      if (Number(fileChanged.changes) !== 1 || Number(publicationChanged.changes) !== 1) {
        throw new ReceiptConflictError("lost KB selector/publication commit CAS");
      }
      const committedPublication = requiredCheckpointValue(
        this.kbPublication(transactionId),
        "selector-committed KB publication"
      );
      this.syncKbInitReservationInTransaction(
        committedPublication,
        "selector_committed",
        timestamp
      );
      return committedPublication;
    });
  }

  private syncKbInitReservationInTransaction(
    publication: KbPublicationTransaction,
    target: "selector_committed" | "finalized",
    timestamp = now()
  ): void {
    if (publication.action !== "init") return;
    const reservation = this.kbInitReservation(publication.kb_profile_id);
    if (
      reservation === undefined ||
      reservation.run_id !== publication.run_id ||
      reservation.transaction_id !== publication.transaction_id ||
      reservation.kb_id !== publication.kb_id ||
      reservation.generation_id !== publication.candidate_generation_id
    ) {
      throw new ReceiptConflictError("KB init reservation lost its exact publication binding");
    }
    if (
      reservation.state === target ||
      (target === "selector_committed" && reservation.state === "finalized")
    ) {
      return;
    }
    const expected = target === "selector_committed" ? "reserved" : "selector_committed";
    if (reservation.state !== expected) {
      throw new ReceiptConflictError(
        `KB init reservation cannot move ${reservation.state} → ${target}`
      );
    }
    const changed = this.db
      .prepare(
        `UPDATE kb_init_reservations SET state=?,updated_at=?
         WHERE kb_profile_id=? AND transaction_id=? AND state=?`
      )
      .run(target, timestamp, reservation.kb_profile_id, reservation.transaction_id, expected);
    if (Number(changed.changes) !== 1) {
      throw new ReceiptConflictError("lost KB init reservation CAS");
    }
  }

  advanceKbPublication(input: {
    transaction_id: string;
    expected: readonly PublicationLifecycle[];
    next: PublicationLifecycle;
  }): KbPublicationTransaction {
    if (input.next === "selector_committed") {
      throw new ReceiptConflictError(
        "selector_committed requires commitKbPublicationSelector exact file-set CAS"
      );
    }
    return this.transaction(() => {
      const current = this.kbPublication(input.transaction_id);
      if (current === undefined) throw new ReceiptConflictError("KB publication is absent");
      if (current.lifecycle === input.next) {
        if (input.next === "selector_committed") {
          this.syncKbInitReservationInTransaction(current, "selector_committed");
        } else if (input.next === "complete") {
          this.syncKbInitReservationInTransaction(current, "finalized");
        }
        return current;
      }
      if (!input.expected.includes(current.lifecycle)) {
        throw new ReceiptConflictError(
          `KB publication cannot move ${current.lifecycle} → ${input.next}`
        );
      }
      const transitions: Record<PublicationLifecycle, readonly PublicationLifecycle[]> = {
        planned: ["staged", "discarding"],
        staged: ["immutables_published", "discarding"],
        immutables_published: ["generation_published", "discarding"],
        generation_published: ["selector_committed", "discarding"],
        selector_committed: ["finalizing"],
        finalizing: ["complete"],
        complete: [],
        discarding: ["discarded"],
        discarded: [],
      };
      if (!transitions[current.lifecycle].includes(input.next)) {
        throw new ReceiptConflictError(
          `KB publication lifecycle edge ${current.lifecycle} → ${input.next} is forbidden`
        );
      }
      const placeholders = input.expected.map(() => "?").join(",");
      const changed = this.db
        .prepare(
          `UPDATE kb_publication_transactions SET lifecycle=?,updated_at=?
           WHERE transaction_id=? AND lifecycle IN (${placeholders})`
        )
        .run(input.next, now(), input.transaction_id, ...input.expected);
      if (Number(changed.changes) !== 1) {
        throw new ReceiptConflictError("lost KB publication lifecycle CAS");
      }
      const advanced = requiredCheckpointValue(
        this.kbPublication(input.transaction_id),
        "advanced KB publication"
      );
      if (input.next === "selector_committed") {
        this.syncKbInitReservationInTransaction(advanced, "selector_committed");
      } else if (input.next === "complete") {
        this.syncKbInitReservationInTransaction(advanced, "finalized");
      }
      return advanced;
    });
  }

  /** Exact durable same-transaction selector evidence for operation receipts. */
  kbPublicationSelectorEvidence(input: {
    transaction_id: string;
    run_id: string;
    candidate_generation_id: string;
  }): KbPublicationTransaction {
    const publication = this.kbPublication(input.transaction_id);
    const selector = publication?.files.find((file) => file.role === "selector");
    let parsedSelector: CurrentGeneration | undefined;
    try {
      parsedSelector =
        publication?.selector_jcs === undefined
          ? undefined
          : validateKbContract(
              CurrentGenerationSchema,
              JSON.parse(publication.selector_jcs),
              "publication selector evidence"
            );
    } catch {
      parsedSelector = undefined;
    }
    if (
      publication === undefined ||
      publication.run_id !== input.run_id ||
      publication.candidate_generation_id !== input.candidate_generation_id ||
      publication.selector_jcs === undefined ||
      publication.selector_sha256 === undefined ||
      parsedSelector === undefined ||
      canonicalJson(parsedSelector) !== publication.selector_jcs ||
      sha256(publication.selector_jcs) !== publication.selector_sha256 ||
      parsedSelector.kb_id !== publication.kb_id ||
      parsedSelector.generation_id !== publication.candidate_generation_id ||
      !["selector_committed", "finalizing", "complete"].includes(publication.lifecycle) ||
      selector?.state !== "published" ||
      selector.final_key !== ".kb/current.json" ||
      selector.sha256 !== publication.selector_sha256 ||
      selector.byte_length !== Buffer.byteLength(publication.selector_jcs, "utf8")
    ) {
      throw new ReceiptConflictError(
        "published operation lacks exact same-transaction selector evidence"
      );
    }
    return publication;
  }

  kbPublications(runId: string): KbPublicationTransaction[] {
    return this.db
      .prepare(
        "SELECT transaction_id FROM kb_publication_transactions WHERE run_id = ? ORDER BY created_at"
      )
      .all(runId)
      .map((row) =>
        requiredCheckpointValue(
          this.kbPublication(sqliteText(row, "transaction_id", "stored KB publication")),
          "stored KB publication"
        )
      );
  }

  kbPublicationsForGeneration(kbId: string, generationId: string): KbPublicationTransaction[] {
    return this.db
      .prepare(
        `SELECT transaction_id FROM kb_publication_transactions
         WHERE kb_id = ? AND candidate_generation_id = ? ORDER BY created_at`
      )
      .all(kbId, generationId)
      .map((row) =>
        requiredCheckpointValue(
          this.kbPublication(sqliteText(row, "transaction_id", "stored KB publication")),
          "stored KB publication"
        )
      );
  }

  /** Reserve a decided content gate at the selector cliff; exact retries are idempotent. */
  reserveContentReviewCommit(runId: string, transactionId: string): ContentReviewRecord {
    return this.transaction(() => {
      const record = this.contentReviewForRun(runId);
      if (record === undefined || record.transaction_id !== transactionId) {
        throw new GateConflictError("content-review commit reservation owner is not exact");
      }
      if (record.state === "commit_reserved" || record.state === "consumed") return record;
      if (record.state !== "claimed" || record.decision_receipt?.decision !== "approve") {
        throw new GateConflictError("only an approved claimed content review may reserve commit");
      }
      const changed = this.db
        .prepare(
          `UPDATE content_reviews SET state='commit_reserved',updated_at=?
           WHERE run_id=? AND state='claimed' AND transaction_id=?`
        )
        .run(now(), runId, transactionId);
      if (Number(changed.changes) !== 1) {
        throw new GateConflictError("lost content-review commit reservation CAS");
      }
      return requiredCheckpointValue(
        this.contentReviewForRun(runId),
        "reserved content-review commit"
      );
    });
  }

  abortContentReviewCommit(runId: string, transactionId: string): ContentReviewRecord {
    return this.transaction(() => {
      const record = this.contentReviewForRun(runId);
      if (record === undefined || record.transaction_id !== transactionId) {
        throw new GateConflictError("content-review abort owner is not exact");
      }
      if (record.state === "invalidated") return record;
      if (!["claimed", "commit_reserved"].includes(record.state)) {
        throw new GateConflictError("content-review gate is not pre-selector abortable");
      }
      const changed = this.db
        .prepare(
          `UPDATE content_reviews SET state='invalidated',updated_at=?
           WHERE run_id=? AND state IN ('claimed','commit_reserved') AND transaction_id=?`
        )
        .run(now(), runId, transactionId);
      if (Number(changed.changes) !== 1) {
        throw new GateConflictError("lost content-review abort CAS");
      }
      return requiredCheckpointValue(
        this.contentReviewForRun(runId),
        "aborted content-review commit"
      );
    });
  }

  finalizeContentReviewCommit(runId: string, transactionId: string): ContentReviewRecord {
    return this.transaction(() => {
      const record = this.contentReviewForRun(runId);
      if (record === undefined || record.transaction_id !== transactionId) {
        throw new GateConflictError("content-review finalization owner is not exact");
      }
      if (record.state === "consumed") return record;
      if (record.state !== "commit_reserved") {
        throw new GateConflictError("selector finalization requires a commit_reserved gate");
      }
      const changed = this.db
        .prepare(
          `UPDATE content_reviews SET state='consumed',updated_at=?
           WHERE run_id=? AND state='commit_reserved' AND transaction_id=?`
        )
        .run(now(), runId, transactionId);
      if (Number(changed.changes) !== 1) {
        throw new GateConflictError("lost content-review consumed CAS");
      }
      return requiredCheckpointValue(
        this.contentReviewForRun(runId),
        "consumed content-review commit"
      );
    });
  }

  /** Reserve one globally idempotent group and the next contiguous run sequence. */
  reserveOperationEventGroup(input: ReserveOperationEventGroupInput): {
    kind: "created" | "existing";
    group: OperationEventGroup;
  } {
    return this.transaction(() => this.reserveOperationEventGroupInTransaction(input));
  }

  private reserveOperationEventGroupInTransaction(input: ReserveOperationEventGroupInput): {
    kind: "created" | "existing";
    group: OperationEventGroup;
  } {
    const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    for (const [label, value] of [
      ["run_id", input.run_id],
      ["session_id", input.session_id],
      ["transaction_id", input.transaction_id],
      ["action", input.action],
      ["source_kind", input.source_kind],
    ] as const) {
      if (!opaqueId.test(value)) {
        throw new CheckpointIdentityError(`operation ${label} is not a safe opaque id`);
      }
    }
    if (!/^[a-f0-9]{64}$/.test(input.source_identity_sha256)) {
      throw new CheckpointIdentityError("operation source identity digest is invalid");
    }
    const existingValue = this.db
      .prepare(
        `SELECT * FROM operation_event_groups
         WHERE source_kind = ? AND source_identity_sha256 = ?`
      )
      .get(input.source_kind, input.source_identity_sha256);
    const existing = existingValue === undefined ? undefined : operationGroupRow(existingValue);
    if (existing !== undefined) {
      const group = this.operationGroupRecord(existing);
      if (
        group.run_id !== input.run_id ||
        group.session_id !== input.session_id ||
        group.transaction_id !== input.transaction_id ||
        group.action !== input.action
      ) {
        throw new CheckpointIdentityError(
          "operation source identity is already bound to different run metadata"
        );
      }
      return { kind: "existing", group };
    }
    const run = this.selectRun(input.run_id);
    if (run === undefined) {
      throw new CheckpointIdentityError(
        `operation group cannot precede absent run '${input.run_id}'`
      );
    }
    if (run.session_id !== input.session_id) {
      throw new CheckpointIdentityError("operation group session does not match the run");
    }
    const sequenceRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(event_sequence), -1) + 1 AS next_sequence
         FROM operation_event_groups WHERE run_id = ?`
      )
      .get(input.run_id);
    if (sequenceRow === undefined) {
      malformedSqliteColumn("operation event sequence", "next_sequence");
    }
    const eventSequence = sqliteInteger(sequenceRow, "next_sequence", "operation event sequence");
    const timestamp = now();
    const groupId = `opg_${randomUUID().replace(/-/g, "")}`;
    this.db
      .prepare(
        `INSERT INTO operation_event_groups(
          request_event_group_id, run_id, session_id, transaction_id, action,
          source_kind, source_identity_sha256, event_sequence, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`
      )
      .run(
        groupId,
        input.run_id,
        input.session_id,
        input.transaction_id,
        input.action,
        input.source_kind,
        input.source_identity_sha256,
        eventSequence,
        timestamp,
        timestamp
      );
    return {
      kind: "created",
      group: requiredCheckpointValue(
        this.operationEventGroup(groupId),
        "created operation event group"
      ),
    };
  }

  operationEventGroup(groupId: string): OperationEventGroup | undefined {
    const row = this.db
      .prepare("SELECT * FROM operation_event_groups WHERE request_event_group_id = ?")
      .get(groupId);
    return row === undefined ? undefined : this.operationGroupRecord(operationGroupRow(row));
  }

  operationEventGroupBySource(
    sourceKind: OperationEventSource,
    sourceIdentitySha256: string
  ): OperationEventGroup | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM operation_event_groups
         WHERE source_kind = ? AND source_identity_sha256 = ?`
      )
      .get(sourceKind, sourceIdentitySha256);
    return row === undefined ? undefined : this.operationGroupRecord(operationGroupRow(row));
  }

  operationEventGroups(runId: string): OperationEventGroup[] {
    return this.db
      .prepare("SELECT * FROM operation_event_groups WHERE run_id = ? ORDER BY event_sequence")
      .all(runId)
      .map((row) => this.operationGroupRecord(operationGroupRow(row)));
  }

  private operationGroupRecord(row: OperationGroupRow): OperationEventGroup {
    const receiptId = row.receipt_id === null ? undefined : String(row.receipt_id);
    const replayJcs = row.replay_result_jcs === null ? undefined : String(row.replay_result_jcs);
    const replaySha =
      row.replay_result_sha256 === null ? undefined : String(row.replay_result_sha256);
    const state = row.state;
    if (
      (state === "reserved" &&
        (receiptId !== undefined || replayJcs !== undefined || replaySha !== undefined)) ||
      (state !== "reserved" &&
        (receiptId === undefined ||
          replayJcs === undefined ||
          replaySha === undefined ||
          sha256(replayJcs) !== replaySha))
    ) {
      throw new ReceiptConflictError(
        `operation group '${row.request_event_group_id}' has inconsistent outcome fields`
      );
    }
    return validateKbContract(
      OperationEventGroupSchema,
      {
        schema_version: 1,
        request_event_group_id: row.request_event_group_id,
        run_id: row.run_id,
        session_id: row.session_id,
        transaction_id: row.transaction_id,
        action: row.action,
        source_kind: row.source_kind,
        source_identity_sha256: row.source_identity_sha256,
        event_sequence: row.event_sequence,
        state,
        ...(receiptId !== undefined ? { receipt_id: receiptId } : {}),
        ...(replayJcs !== undefined ? { replay_result_jcs: replayJcs } : {}),
        ...(replaySha !== undefined ? { replay_result_sha256: replaySha } : {}),
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      "stored operation event group"
    );
  }

  /** Atomically preindex receipt bytes/result before any receipt filesystem byte. */
  prepareOperationOutcome(input: PrepareOperationOutcomeInput): OperationEventGroup {
    return this.transaction(() => {
      const current = this.operationEventGroup(input.group.request_event_group_id);
      if (current === undefined) throw new ReceiptConflictError("operation group is absent");
      const resultJcs = canonicalJson(input.replay_result);
      const resultSha = sha256(resultJcs);
      if (current.state !== "reserved") {
        const receipt = current.receipt_id ? this.operationReceipt(current.receipt_id) : undefined;
        if (
          current.receipt_id === input.receipt.receipt_id &&
          current.replay_result_jcs === resultJcs &&
          current.replay_result_sha256 === resultSha &&
          receipt !== undefined &&
          canonicalJson(receipt) === canonicalJson(input.receipt)
        ) {
          return current;
        }
        throw new ReceiptConflictError("operation group already has a different outcome");
      }
      const shared = [
        [input.receipt.run_id, current.run_id],
        [input.receipt.session_id, current.session_id],
        [input.receipt.transaction_id, current.transaction_id],
        [input.receipt.action, current.action],
        [input.receipt.request_event_group_id, current.request_event_group_id],
        [input.receipt.event_sequence, current.event_sequence],
        [input.receipt.source_kind, current.source_kind],
        [input.receipt.source_identity_sha256, current.source_identity_sha256],
      ];
      if (shared.some(([left, right]) => left !== right)) {
        throw new ReceiptConflictError("operation receipt does not match its reserved group");
      }
      if (
        input.receipt.state !== "preparing" ||
        input.receipt.temporary_storage_key === undefined ||
        sha256(input.receipt.receipt_jcs) !== input.receipt.sha256 ||
        Buffer.byteLength(input.receipt.receipt_jcs, "utf8") !== input.receipt.byte_length
      ) {
        throw new ReceiptConflictError("operation receipt preindex metadata is invalid");
      }
      this.db
        .prepare(
          `INSERT INTO operation_receipt_index(
            receipt_id, run_id, session_id, kb_profile_id, kb_id, action, event,
            transaction_id, request_event_group_id, event_sequence, source_kind,
            source_identity_sha256, receipt_jcs, temporary_storage_key, final_storage_key,
            sha256, byte_length, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`
        )
        .run(
          input.receipt.receipt_id,
          input.receipt.run_id,
          input.receipt.session_id,
          input.receipt.kb_profile_id,
          input.receipt.kb_id ?? null,
          input.receipt.action,
          input.receipt.event,
          input.receipt.transaction_id,
          input.receipt.request_event_group_id,
          input.receipt.event_sequence,
          input.receipt.source_kind,
          input.receipt.source_identity_sha256,
          input.receipt.receipt_jcs,
          input.receipt.temporary_storage_key,
          input.receipt.final_storage_key,
          input.receipt.sha256,
          input.receipt.byte_length,
          input.receipt.created_at,
          input.receipt.updated_at
        );
      const changed = this.db
        .prepare(
          `UPDATE operation_event_groups
           SET state = 'outcome_preparing', receipt_id = ?, replay_result_jcs = ?,
               replay_result_sha256 = ?, updated_at = ?
           WHERE request_event_group_id = ? AND state = 'reserved'`
        )
        .run(
          input.receipt.receipt_id,
          resultJcs,
          resultSha,
          input.receipt.updated_at,
          current.request_event_group_id
        );
      if (Number(changed.changes) !== 1) {
        throw new ReceiptConflictError("lost operation outcome preparation race");
      }
      return requiredCheckpointValue(
        this.operationEventGroup(current.request_event_group_id),
        "prepared operation event group"
      );
    });
  }

  operationReceipt(receiptId: string): OperationReceiptIndexRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM operation_receipt_index WHERE receipt_id = ?")
      .get(receiptId);
    return row === undefined ? undefined : this.operationReceiptRecord(operationReceiptRow(row));
  }

  operationReceipts(runId: string): OperationReceiptIndexRecord[] {
    return this.db
      .prepare("SELECT * FROM operation_receipt_index WHERE run_id = ? ORDER BY event_sequence")
      .all(runId)
      .map((row) => this.operationReceiptRecord(operationReceiptRow(row)));
  }

  private operationReceiptRecord(row: OperationReceiptRow): OperationReceiptIndexRecord {
    return validateKbContract(
      OperationReceiptIndexRecordSchema,
      {
        schema_version: 1,
        receipt_id: row.receipt_id,
        run_id: row.run_id,
        session_id: row.session_id,
        kb_profile_id: row.kb_profile_id,
        ...(row.kb_id === null ? {} : { kb_id: row.kb_id }),
        action: row.action,
        event: row.event,
        transaction_id: row.transaction_id,
        request_event_group_id: row.request_event_group_id,
        event_sequence: row.event_sequence,
        source_kind: row.source_kind,
        source_identity_sha256: row.source_identity_sha256,
        receipt_jcs: row.receipt_jcs,
        ...(row.temporary_storage_key === null
          ? {}
          : { temporary_storage_key: row.temporary_storage_key }),
        final_storage_key: row.final_storage_key,
        sha256: row.sha256,
        byte_length: row.byte_length,
        state: row.state,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      "stored operation receipt"
    );
  }

  operationReceiptMarkStaged(receiptId: string): OperationReceiptIndexRecord {
    return this.transaction(() => {
      const current = this.operationReceipt(receiptId);
      if (current === undefined) throw new ReceiptConflictError("operation receipt is absent");
      if (current.state === "staged" || current.state === "published") return current;
      const changed = this.db
        .prepare(
          `UPDATE operation_receipt_index SET state = 'staged', updated_at = ?
           WHERE receipt_id = ? AND state = 'preparing'`
        )
        .run(now(), receiptId);
      if (Number(changed.changes) !== 1) {
        throw new ReceiptConflictError("lost operation receipt staged CAS");
      }
      return requiredCheckpointValue(this.operationReceipt(receiptId), "staged operation receipt");
    });
  }

  /**
   * Final receipt commit: published index + committed group + run binding and,
   * for the first terminal outcome, exact terminal replay in one transaction.
   */
  commitOperationReceipt(receiptId: string): OperationEventGroup {
    return this.transaction(() => {
      const receipt = this.operationReceipt(receiptId);
      if (receipt === undefined) throw new ReceiptConflictError("operation receipt is absent");
      const group = this.operationEventGroup(receipt.request_event_group_id);
      if (group === undefined || group.receipt_id !== receiptId) {
        throw new ReceiptConflictError("operation receipt lost its event group");
      }
      if (group.state === "committed" && receipt.state === "published") return group;
      if (group.state !== "outcome_preparing" || receipt.state !== "staged") {
        throw new ReceiptConflictError("operation receipt is not staged for final commit");
      }
      const timestamp = now();
      const published = this.db
        .prepare(
          `UPDATE operation_receipt_index
           SET state = 'published', temporary_storage_key = NULL, updated_at = ?
           WHERE receipt_id = ? AND state = 'staged'`
        )
        .run(timestamp, receiptId);
      if (Number(published.changes) !== 1) {
        throw new ReceiptConflictError("lost operation receipt publish CAS");
      }
      const committed = this.db
        .prepare(
          `UPDATE operation_event_groups SET state = 'committed', updated_at = ?
           WHERE request_event_group_id = ? AND state = 'outcome_preparing' AND receipt_id = ?`
        )
        .run(timestamp, group.request_event_group_id, receiptId);
      if (Number(committed.changes) !== 1) {
        throw new ReceiptConflictError("lost operation group commit CAS");
      }
      this.db
        .prepare("UPDATE runs SET last_operation_receipt_id = ?, updated_at = ? WHERE run_id = ?")
        .run(receiptId, timestamp, group.run_id);
      const replayJcs = requiredCheckpointValue(
        group.replay_result_jcs,
        "operation replay payload"
      );
      const replaySha256 = requiredCheckpointValue(
        group.replay_result_sha256,
        "operation replay digest"
      );
      const replay = validateKbContract(
        ReplayableKnowledgeBaseResultSchema,
        JSON.parse(replayJcs),
        "stored operation replay result"
      );
      const terminal = replay.status !== "running" && replay.status !== "awaiting_user";
      if (terminal) {
        const terminalId = `trm_${receiptId}`;
        const existingValue = this.db
          .prepare("SELECT * FROM terminal_results WHERE run_id = ?")
          .get(group.run_id);
        const existing = existingValue === undefined ? undefined : terminalResultRow(existingValue);
        if (existing === undefined) {
          this.db
            .prepare(
              `INSERT INTO terminal_results(
                terminal_result_id, run_id, idempotency_transaction_id,
                operation_receipt_id, result_jcs, result_sha256, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              terminalId,
              group.run_id,
              group.transaction_id,
              receiptId,
              replayJcs,
              replaySha256,
              timestamp
            );
        }
        if (group.source_kind === "external_start") {
          const admission = this.db
            .prepare(
              "SELECT state, transaction_id, terminal_result_id, terminal_result_sha256 FROM start_admissions WHERE run_id = ?"
            )
            .get(group.run_id);
          if (admission !== undefined) {
            const admissionState = sqliteText(admission, "state", "terminal start admission");
            const admissionTransactionId = sqliteText(
              admission,
              "transaction_id",
              "terminal start admission"
            );
            const admissionTerminalResultId = sqliteNullableText(
              admission,
              "terminal_result_id",
              "terminal start admission"
            );
            const admissionTerminalResultSha256 = sqliteNullableText(
              admission,
              "terminal_result_sha256",
              "terminal start admission"
            );
            if (admissionTransactionId !== group.transaction_id) {
              throw new ReceiptConflictError("terminal operation/admission transaction mismatch");
            }
            if (admissionState === "running") {
              this.db
                .prepare(
                  `UPDATE start_admissions
                   SET state = 'terminal', terminal_result_id = ?, terminal_result_sha256 = ?, updated_at = ?
                   WHERE run_id = ? AND state = 'running'`
                )
                .run(terminalId, replaySha256, timestamp, group.run_id);
            } else if (
              admissionTerminalResultId !== terminalId ||
              admissionTerminalResultSha256 !== group.replay_result_sha256
            ) {
              throw new ReceiptConflictError("terminal start admission replay conflicts");
            }
          }
        }
      }
      return requiredCheckpointValue(
        this.operationEventGroup(group.request_event_group_id),
        "committed operation event group"
      );
    });
  }

  lastOperationReceiptId(runId: string): string | undefined {
    const row = this.db
      .prepare("SELECT last_operation_receipt_id FROM runs WHERE run_id = ?")
      .get(runId);
    if (row === undefined) return undefined;
    const receiptId = sqliteNullableText(row, "last_operation_receipt_id", "stored run receipt");
    return receiptId === null ? undefined : receiptId;
  }

  terminalResult(runId: string): TerminalResultRecord | undefined {
    const rowValue = this.db.prepare("SELECT * FROM terminal_results WHERE run_id = ?").get(runId);
    if (rowValue === undefined) return undefined;
    const row = terminalResultRow(rowValue);
    const result = validateKbContract(
      ReplayableKnowledgeBaseResultSchema,
      JSON.parse(row.result_jcs),
      "stored terminal result"
    );
    if (sha256(row.result_jcs) !== row.result_sha256) {
      throw new ReceiptConflictError(`terminal result for '${runId}' has a mismatched digest`);
    }
    return {
      schema_version: 1,
      terminal_result_id: String(row.terminal_result_id),
      run_id: String(row.run_id),
      idempotency_transaction_id: String(row.idempotency_transaction_id),
      operation_receipt_id: String(row.operation_receipt_id),
      result,
      result_sha256: String(row.result_sha256),
      created_at: String(row.created_at),
    };
  }

  /**
   * §5.6 start admission — the ONE transaction that durably binds an admitted
   * start action before any capability claim, private-body read, child session,
   * filesystem write, or receipt append:
   *
   * 1. the authoritative durable run row (plus its `run_started` event),
   * 2. the idempotency record keyed by the authenticated (session_id,
   *    invocation_id) pair with the closed-request digest, and
   * 3. the `preparing` private-input record with host-preallocated exact
   *    final/temporary keys.
   *
   * The request BYTES are written by the host only after this commit, through
   * the owner-only temp/fsync/rename lifecycle, and CASed `preparing → active`
   * after the rename. Nothing in any of these rows is a request body.
   *
   * Idempotency: the same (session_id, invocation_id) with the same digest
   * returns the ORIGINAL run to replay, with no second side effect; the same
   * pair with a different digest throws {@link StartAdmissionMismatchError}
   * (`idempotency_mismatch`) and creates nothing.
   */
  admitStartRun(context: RunContext, admission: StartAdmissionInput): StartAdmissionOutcome {
    const identity = context.identity;
    const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    for (const [label, value] of [
      ["run_id", identity.run_id],
      ["session_id", admission.session_id],
      ["invocation_id", admission.invocation_id],
      ["action", admission.action],
      ["profile_id", admission.profile_id],
      ["transaction_id", admission.transaction_id],
      ["private_input_id", admission.private_input_id],
    ] as const) {
      if (!opaqueId.test(value)) {
        throw new CheckpointIdentityError(`start admission ${label} is not a safe opaque id`);
      }
    }
    if (admission.session_id !== identity.session_id) {
      throw new CheckpointIdentityError("start admission session does not match run identity");
    }
    if (!/^[a-f0-9]{64}$/.test(admission.request_sha256)) {
      throw new CheckpointIdentityError("start admission request digest is invalid");
    }
    const expectedStorageKey = `${identity.run_id}/request.json`;
    const expectedTemporaryKey = `${identity.run_id}/.${admission.transaction_id}.tmp`;
    if (
      admission.storage_key !== expectedStorageKey ||
      admission.temporary_storage_key !== expectedTemporaryKey
    ) {
      throw new CheckpointIdentityError("start admission private-input keys are not exact");
    }
    const sourceIdentitySha256 = operationSourceIdentitySha256({
      session_id: admission.session_id,
      invocation_id: admission.invocation_id,
      action: admission.action,
      request_sha256: admission.request_sha256,
    });
    const outcome = this.transaction(() => {
      const existingValue = this.db
        .prepare(`SELECT * FROM start_admissions WHERE session_id = ? AND invocation_id = ?`)
        .get(admission.session_id, admission.invocation_id);
      const existing = existingValue === undefined ? undefined : admissionRow(existingValue);
      if (existing !== undefined) {
        const sameRequest =
          existing.request_sha256 === admission.request_sha256 &&
          existing.action === admission.action &&
          existing.profile_id === admission.profile_id;
        if (sameRequest) {
          const group = this.operationEventGroupBySource("external_start", sourceIdentitySha256);
          if (
            group === undefined ||
            group.run_id !== String(existing.run_id) ||
            group.transaction_id !== String(existing.transaction_id)
          ) {
            throw new CheckpointIdentityError(
              "start admission replay is missing its exact operation event group"
            );
          }
          return { kind: "replay" as const, run_id: String(existing.run_id) };
        }
        throw new StartAdmissionMismatchError(
          `session '${admission.session_id}' invocation '${admission.invocation_id}' was already ` +
            `admitted with a different request digest (idempotency_mismatch)`
        );
      }
      this.assertNewRunCompletionProtocol(context);
      if (this.selectRun(identity.run_id) !== undefined) {
        throw new CheckpointIdentityError(`run_id '${identity.run_id}' already exists`);
      }
      const timestamp = now();
      validateKbContract(
        IdempotencyRecordSchema,
        {
          schema_version: 1,
          session_id: admission.session_id,
          invocation_id: admission.invocation_id,
          request_sha256: admission.request_sha256,
          kb_profile_id: admission.profile_id,
          action: admission.action,
          run_id: identity.run_id,
          transaction_id: admission.transaction_id,
          state: "running",
          created_at: timestamp,
          updated_at: timestamp,
        },
        "new idempotency DB projection"
      );
      validateKbContract(
        PrivateRunInputRecordSchema,
        {
          schema_version: 1,
          private_input_id: admission.private_input_id,
          run_id: identity.run_id,
          request_sha256: admission.request_sha256,
          storage_key: admission.storage_key,
          temporary_storage_key: admission.temporary_storage_key,
          state: "preparing",
          created_at: timestamp,
          updated_at: timestamp,
        },
        "new private-run-input DB projection"
      );
      this.db
        .prepare(
          `INSERT INTO runs(
            run_id, session_id, playbook, engine_owner, schema_version,
            status, state_id, context_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          identity.run_id,
          identity.session_id,
          identity.playbook,
          identity.engine_owner,
          identity.schema_version,
          context.status,
          context.stateId,
          this.durableContextJson(context),
          timestamp,
          timestamp
        );
      this.db
        .prepare(
          `INSERT INTO start_admissions(
            run_id, session_id, invocation_id, request_sha256, action, profile_id,
            transaction_id, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`
        )
        .run(
          identity.run_id,
          admission.session_id,
          admission.invocation_id,
          admission.request_sha256,
          admission.action,
          admission.profile_id,
          admission.transaction_id,
          timestamp,
          timestamp
        );
      this.db
        .prepare(
          `INSERT INTO private_inputs(
            private_input_id, run_id, request_sha256, storage_key, temporary_storage_key,
            state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?)`
        )
        .run(
          admission.private_input_id,
          identity.run_id,
          admission.request_sha256,
          admission.storage_key,
          admission.temporary_storage_key,
          timestamp,
          timestamp
        );
      this.reserveOperationEventGroupInTransaction({
        run_id: identity.run_id,
        session_id: identity.session_id,
        transaction_id: admission.transaction_id,
        action: admission.action as OperationAction,
        source_kind: "external_start",
        source_identity_sha256: sourceIdentitySha256,
      });
      this.persistPendingGate(context);
      this.insertEvent(
        identity.run_id,
        "run_started",
        this.checkpointPayload(context, {
          run_id: identity.run_id,
          session_id: identity.session_id,
          request_sha256: admission.request_sha256,
          action: admission.action,
        }),
        timestamp
      );
      if (
        this.getStartAdmission(identity.run_id)?.state !== "running" ||
        this.getPrivateInput(identity.run_id)?.state !== "preparing"
      ) {
        throw new CheckpointIdentityError("start admission projections did not round-trip exactly");
      }
      return { kind: "created" as const, run_id: identity.run_id };
    });
    if (outcome.kind === "created") context.markCheckpointEvidencePersisted();
    return outcome;
  }

  getStartAdmission(runId: string): StartAdmissionRecord | undefined {
    const rowValue = this.db.prepare("SELECT * FROM start_admissions WHERE run_id = ?").get(runId);
    if (rowValue === undefined) return undefined;
    const row = admissionRow(rowValue);
    let record: IdempotencyRecord;
    try {
      record = validateKbContract(
        IdempotencyRecordSchema,
        {
          schema_version: 1,
          session_id: String(row.session_id),
          invocation_id: String(row.invocation_id),
          request_sha256: String(row.request_sha256),
          kb_profile_id: String(row.profile_id),
          action: String(row.action),
          run_id: String(row.run_id),
          transaction_id: String(row.transaction_id),
          state: String(row.state),
          ...(row.terminal_result_id === null
            ? {}
            : { terminal_result_id: String(row.terminal_result_id) }),
          ...(row.terminal_result_sha256 === null
            ? {}
            : { terminal_result_sha256: String(row.terminal_result_sha256) }),
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
        },
        "idempotency DB projection"
      );
    } catch {
      throw new CheckpointIdentityError("idempotency DB projection is malformed");
    }
    const terminalFields =
      record.terminal_result_id !== undefined && record.terminal_result_sha256 !== undefined;
    if (
      record.run_id !== runId ||
      (record.state === "running" && terminalFields) ||
      (record.state === "terminal" && !terminalFields)
    ) {
      throw new CheckpointIdentityError("idempotency DB projection lifecycle is inconsistent");
    }
    return record;
  }

  getPrivateInput(runId: string): PrivateInputRecord | undefined {
    const rowValue = this.db.prepare("SELECT * FROM private_inputs WHERE run_id = ?").get(runId);
    if (rowValue === undefined) return undefined;
    const row = privateInputRow(rowValue);
    let record: PrivateRunInputRecord;
    try {
      record = validateKbContract(
        PrivateRunInputRecordSchema,
        {
          schema_version: 1,
          private_input_id: String(row.private_input_id),
          run_id: String(row.run_id),
          request_sha256: String(row.request_sha256),
          storage_key: String(row.storage_key),
          ...(row.temporary_storage_key === null
            ? {}
            : { temporary_storage_key: String(row.temporary_storage_key) }),
          state: String(row.state),
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
        },
        "private-run-input DB projection"
      );
    } catch {
      throw new CheckpointIdentityError("private-run-input DB projection is malformed");
    }
    if (
      record.run_id !== runId ||
      (record.state === "preparing" && record.temporary_storage_key === undefined) ||
      (["active", "terminal", "discarded"].includes(record.state) &&
        record.temporary_storage_key !== undefined)
    ) {
      throw new CheckpointIdentityError(
        "private-run-input DB projection lifecycle is inconsistent"
      );
    }
    return record;
  }

  /**
   * Strictly compare-and-set one private-input lifecycle transition.
   *
   * Fails loudly (and mutates nothing) unless the row is exactly in the
   * expected state — that is what makes the recovery sequences below exact:
   * each step is re-runnable and cannot skip or reverse.
   */
  private casPrivateInput(
    privateInputId: string,
    from: PrivateInputRecord["state"],
    to: PrivateInputRecord["state"],
    options: { clearTemporaryKey?: boolean } = {}
  ): void {
    this.transaction(() => {
      const clear = options.clearTemporaryKey === true;
      const updateSql = clear
        ? `UPDATE private_inputs
            SET state = ?, temporary_storage_key = NULL, updated_at = ?
            WHERE private_input_id = ? AND state = ?`
        : `UPDATE private_inputs
            SET state = ?, updated_at = ?
            WHERE private_input_id = ? AND state = ?`;
      const result = clear
        ? this.db.prepare(updateSql).run(to, now(), privateInputId, from)
        : this.db.prepare(updateSql).run(to, now(), privateInputId, from);
      if (Number(result.changes) !== 1) {
        const current = this.db
          .prepare("SELECT state FROM private_inputs WHERE private_input_id = ?")
          .get(privateInputId) as { state?: string } | undefined;
        throw new CheckpointIdentityError(
          `private input '${privateInputId}' is '${current?.state ?? "absent"}', not '${from}'; refusing transition to '${to}'`
        );
      }
      const owner = this.db
        .prepare("SELECT run_id FROM private_inputs WHERE private_input_id = ?")
        .get(privateInputId) as { run_id?: string } | undefined;
      if (owner?.run_id === undefined || this.getPrivateInput(String(owner.run_id)) === undefined) {
        throw new CheckpointIdentityError("private-run-input write did not round-trip exactly");
      }
    });
  }

  /** `preparing → active`: the temp was fsynced and renamed to the final key. */
  privateInputActivate(privateInputId: string): void {
    this.casPrivateInput(privateInputId, "preparing", "active", { clearTemporaryKey: true });
  }

  /** `active → terminal`: the terminal result is durable and needs no more input bytes. */
  privateInputBeginTerminal(privateInputId: string): void {
    this.casPrivateInput(privateInputId, "active", "terminal", { clearTemporaryKey: true });
  }

  /**
   * `preparing|terminal → discarding`: the exclusive cleanup window. The host
   * removes ONLY the exact indexed keys in this window, then finishes the
   * discard.
   */
  privateInputBeginDiscarding(privateInputId: string, from: "preparing" | "terminal"): void {
    this.casPrivateInput(privateInputId, from, "discarding");
  }

  /** `discarding → discarded`: exact files removed and the parent fsynced. */
  privateInputFinishDiscarded(privateInputId: string): void {
    this.casPrivateInput(privateInputId, "discarding", "discarded", { clearTemporaryKey: true });
  }

  /**
   * Settle an admitted start run's idempotency record as terminal.
   *
   * The terminal result id and the digest of the exact replayable projection
   * become REQUIRED once terminal and immutable thereafter; a later
   * status/resume lookup re-checks that digest against the run's stored
   * terminal projection. Re-settling with the same values is idempotent;
   * settling with different values is refused.
   */
  settleStartAdmission(
    runId: string,
    input: { terminal_result_id: string; terminal_result_sha256: string }
  ): void {
    this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT state, terminal_result_id, terminal_result_sha256 FROM start_admissions WHERE run_id = ?"
        )
        .get(runId);
      if (row === undefined) {
        throw new CheckpointIdentityError(`run '${runId}' has no start admission record`);
      }
      const state = sqliteText(row, "state", "settled start admission");
      const terminalResultId = sqliteNullableText(
        row,
        "terminal_result_id",
        "settled start admission"
      );
      const terminalResultSha256 = sqliteNullableText(
        row,
        "terminal_result_sha256",
        "settled start admission"
      );
      if (state === "running") {
        const result = this.db
          .prepare(
            `UPDATE start_admissions
             SET state = 'terminal', terminal_result_id = ?, terminal_result_sha256 = ?, updated_at = ?
             WHERE run_id = ? AND state = 'running'`
          )
          .run(input.terminal_result_id, input.terminal_result_sha256, now(), runId);
        if (Number(result.changes) !== 1) {
          throw new CheckpointIdentityError(`failed to settle start admission for run '${runId}'`);
        }
        if (this.getStartAdmission(runId)?.state !== "terminal") {
          throw new CheckpointIdentityError(
            "terminal idempotency write did not round-trip exactly"
          );
        }
        return;
      }
      if (state !== "terminal") {
        throw new CheckpointIdentityError(
          `start admission for run '${runId}' is '${state}', not settleable`
        );
      }
      if (
        terminalResultId !== input.terminal_result_id ||
        terminalResultSha256 !== input.terminal_result_sha256
      ) {
        throw new CheckpointIdentityError(
          `start admission for run '${runId}' was already settled with a different terminal result`
        );
      }
    });
  }

  /** Return the newest content-review challenge for one run. */
  contentReviewForRun(runId: string): ContentReviewRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM content_reviews WHERE run_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(runId);
    return row === undefined ? undefined : this.contentReviewRecord(contentReviewRow(row));
  }

  listContentReviews(): ContentReviewRecord[] {
    return this.db
      .prepare("SELECT * FROM content_reviews ORDER BY rowid")
      .all()
      .map((row) => this.contentReviewRecord(contentReviewRow(row)));
  }

  private contentReviewRecord(row: ContentReviewRow): ContentReviewRecord {
    const packet = validateContentReviewPacket(JSON.parse(row.packet_jcs));
    const digest = packetDigest(packet);
    if (digest !== String(row.packet_sha256)) {
      throw new GateConflictError(
        `content-review packet '${row.challenge_id}' does not match its stored digest`
      );
    }
    const decisionJcs =
      row.decision_receipt_jcs === null || row.decision_receipt_jcs === undefined
        ? undefined
        : String(row.decision_receipt_jcs);
    const decisionDigest =
      row.decision_receipt_sha256 === null || row.decision_receipt_sha256 === undefined
        ? undefined
        : String(row.decision_receipt_sha256);
    let decision: ContentReviewDecisionReceipt | undefined;
    if (decisionJcs !== undefined || decisionDigest !== undefined) {
      if (
        decisionJcs === undefined ||
        decisionDigest === undefined ||
        sha256(decisionJcs) !== decisionDigest
      ) {
        throw new GateConflictError(
          `content-review decision '${row.challenge_id}' has incomplete or mismatched stored bytes`
        );
      }
      decision = validateContentReviewReceipt(JSON.parse(decisionJcs), packet, row.packet_sha256);
      if (canonicalJson(decision) !== decisionJcs) {
        throw new GateConflictError(
          `content-review decision '${row.challenge_id}' is not stored as canonical JSON`
        );
      }
    }
    return {
      challenge_id: String(row.challenge_id),
      run_id: String(row.run_id),
      packet_sha256: String(row.packet_sha256),
      packet_jcs: String(row.packet_jcs),
      packet,
      state: validateKbContract(
        ContentReviewStoreStateSchema,
        row.state,
        "stored content-review state"
      ),
      ...(decisionJcs !== undefined ? { decision_receipt_jcs: decisionJcs } : {}),
      ...(decisionDigest !== undefined ? { decision_receipt_sha256: decisionDigest } : {}),
      ...(decision !== undefined ? { decision_receipt: decision } : {}),
      ...(row.receipt_id !== null && row.receipt_id !== undefined
        ? { receipt_id: String(row.receipt_id) }
        : {}),
      ...(row.transaction_id !== null && row.transaction_id !== undefined
        ? { transaction_id: String(row.transaction_id) }
        : {}),
      updated_at: String(row.updated_at),
    };
  }

  /**
   * Authenticated callback transaction: persist exact receipt bytes/digest and
   * bind the decision to the generic gate plus durable run context. An exact
   * duplicate is the only idempotent duplicate; any other receipt conflicts.
   */
  recordContentReviewDecision(input: {
    receipt: ContentReviewDecisionReceipt;
    receiptJcs: string;
    receiptSha256: string;
  }): {
    kind: "accepted" | "duplicate";
    finalized: boolean;
    request_event_group_id: string;
  } {
    return this.transaction(() => {
      const rowValue = this.db
        .prepare("SELECT * FROM content_reviews WHERE challenge_id = ?")
        .get(input.receipt.challenge_id);
      const row = rowValue === undefined ? undefined : contentReviewRow(rowValue);
      if (row === undefined) {
        throw new GateConflictError(
          `unknown content-review challenge '${input.receipt.challenge_id}'`
        );
      }
      const record = this.contentReviewRecord(row);
      const receipt = validateContentReviewReceipt(
        input.receipt,
        record.packet,
        record.packet_sha256
      );
      if (
        canonicalJson(receipt) !== input.receiptJcs ||
        sha256(input.receiptJcs) !== input.receiptSha256
      ) {
        throw new GateConflictError("content-review receipt bytes or digest are not canonical");
      }
      const sourceIdentitySha256 = operationSourceIdentitySha256({
        packet_sha256: record.packet_sha256,
        decision_receipt_sha256: input.receiptSha256,
      });
      if (record.decision_receipt_sha256 !== undefined) {
        if (record.decision_receipt_sha256 !== input.receiptSha256) {
          throw new GateConflictError(
            `content-review challenge '${record.challenge_id}' already has a different receipt digest`
          );
        }
        const reserved = this.reserveOperationEventGroupInTransaction({
          run_id: record.run_id,
          session_id: receipt.session_id,
          transaction_id: receipt.receipt_id,
          action: receipt.action,
          source_kind: "content_review_decision",
          source_identity_sha256: sourceIdentitySha256,
        });
        return {
          kind: "duplicate" as const,
          finalized:
            record.transaction_id !== undefined &&
            (record.state === "consumed" ||
              record.state === "refined" ||
              record.state === "denied"),
          request_event_group_id: reserved.group.request_event_group_id,
        };
      }
      if (record.state !== "awaiting") {
        throw new GateConflictError(
          `content-review challenge '${record.challenge_id}' is '${record.state}', not awaiting`
        );
      }
      const context = this.loadRunById(record.run_id);
      const pending = context?.pendingDirective;
      if (
        context === undefined ||
        context.status !== "awaiting_user" ||
        context.stateId !== "awaiting_review" ||
        pending?.action !== "await_user" ||
        pending.gate_id !== record.challenge_id
      ) {
        throw new GateConflictError(
          `run '${record.run_id}' is not waiting on content-review challenge '${record.challenge_id}'`
        );
      }
      const reserved = this.reserveOperationEventGroupInTransaction({
        run_id: record.run_id,
        session_id: receipt.session_id,
        transaction_id: receipt.receipt_id,
        action: receipt.action,
        source_kind: "content_review_decision",
        source_identity_sha256: sourceIdentitySha256,
      });
      const decisionState =
        receipt.decision === "approve"
          ? "approved"
          : receipt.decision === "refine"
            ? "refined"
            : "denied";
      const timestamp = now();
      const changed = this.db
        .prepare(
          `UPDATE content_reviews
           SET state = ?, decision_receipt_jcs = ?, decision_receipt_sha256 = ?,
               receipt_id = ?, updated_at = ?
           WHERE challenge_id = ? AND state = 'awaiting' AND decision_receipt_sha256 IS NULL`
        )
        .run(
          decisionState,
          input.receiptJcs,
          input.receiptSha256,
          receipt.receipt_id,
          timestamp,
          record.challenge_id
        );
      if (Number(changed.changes) !== 1) {
        throw new GateConflictError(
          `lost content-review decision race for '${record.challenge_id}'`
        );
      }
      const responseJson = canonicalJson(receipt.decision);
      const gate = this.db
        .prepare(
          `UPDATE gates
           SET status = 'answered', response_digest = ?, response_json = ?, answered_at = ?
           WHERE run_id = ? AND gate_id = ? AND status = 'pending'`
        )
        .run(sha256(responseJson), responseJson, timestamp, record.run_id, record.challenge_id);
      if (Number(gate.changes) !== 1) {
        throw new GateConflictError(`generic gate '${record.challenge_id}' is not pending`);
      }
      context.status = "running";
      context.knowledgeBaseData.review_decision = receipt.decision;
      context.knowledgeBaseData.review_receipt_id = receipt.receipt_id;
      context.knowledgeBaseData.review_receipt_sha256 = input.receiptSha256;
      this.updateRun(context);
      this.insertEvent(
        record.run_id,
        "content_review_decided",
        {
          run_id: record.run_id,
          gate_id: record.challenge_id,
          receipt_sha256: input.receiptSha256,
          decision: receipt.decision,
        },
        timestamp
      );
      return {
        kind: "accepted" as const,
        finalized: false,
        request_event_group_id: reserved.group.request_event_group_id,
      };
    });
  }

  claimContentReview(input: {
    runId: string;
    receiptSha256: string;
    transactionId: string;
  }): ContentReviewRecord {
    return this.transaction(() => {
      const record = this.contentReviewForRun(input.runId);
      if (record === undefined || record.decision_receipt === undefined) {
        throw new GateConflictError(`run '${input.runId}' has no decided content review`);
      }
      if (record.decision_receipt_sha256 !== input.receiptSha256) {
        throw new GateConflictError("content-review resume receipt digest mismatch");
      }
      if (record.state === "claimed") {
        if (record.transaction_id !== input.transactionId) {
          throw new GateConflictError("content-review challenge is claimed by another transaction");
        }
        return record;
      }
      const expected =
        record.decision_receipt.decision === "approve"
          ? "approved"
          : record.decision_receipt.decision === "refine"
            ? "refined"
            : "denied";
      if (record.state !== expected || record.transaction_id !== undefined) {
        throw new GateConflictError(
          `content-review challenge '${record.challenge_id}' is '${record.state}', not resumable`
        );
      }
      const changed = this.db
        .prepare(
          `UPDATE content_reviews SET state = 'claimed', transaction_id = ?, updated_at = ?
           WHERE challenge_id = ? AND state = ? AND transaction_id IS NULL`
        )
        .run(input.transactionId, now(), record.challenge_id, expected);
      if (Number(changed.changes) !== 1) {
        throw new GateConflictError(`lost content-review claim race for '${record.challenge_id}'`);
      }
      return requiredCheckpointValue(
        this.contentReviewForRun(input.runId),
        "claimed content-review record"
      );
    });
  }

  finishContentReview(input: {
    context: RunContext;
    receiptSha256: string;
    transactionId: string;
  }): void {
    let persistedPayload: Record<string, JsonValue> = {};
    this.transaction(() => {
      const record = this.contentReviewForRun(input.context.identity.run_id);
      if (
        record === undefined ||
        !["claimed", "commit_reserved", "consumed"].includes(record.state) ||
        record.transaction_id !== input.transactionId ||
        record.decision_receipt_sha256 !== input.receiptSha256 ||
        record.decision_receipt === undefined
      ) {
        throw new GateConflictError("content-review completion is not owned by this transaction");
      }
      const finalState: ContentReviewStoreState =
        record.decision_receipt.decision === "approve"
          ? input.context.met && input.context.status === "complete"
            ? "consumed"
            : "invalidated"
          : record.decision_receipt.decision === "refine"
            ? "refined"
            : "denied";
      if (record.state === "consumed" && finalState !== "consumed") {
        throw new GateConflictError("selector-proven content review cannot be demoted");
      }
      this.db
        .prepare(
          `UPDATE content_reviews SET state = ?, updated_at = ?
           WHERE challenge_id = ? AND state IN ('claimed','commit_reserved') AND transaction_id = ?`
        )
        .run(finalState, now(), record.challenge_id, input.transactionId);
      this.validatePositiveTerminalWrite(input.context);
      persistedPayload = this.checkpointPayload(input.context, {
        run_id: record.run_id,
        gate_id: record.challenge_id,
        receipt_sha256: input.receiptSha256,
        state: finalState,
      });
      this.updateRun(input.context);
      this.insertEvent(record.run_id, "content_review_resumed", persistedPayload, now());
    });
    input.context.markCheckpointEvidencePersisted();
    this.observe(input.context, "content_review_resumed", persistedPayload);
  }

  invalidateContentReview(input: {
    context: RunContext;
    receiptSha256?: string;
    reason: string;
    state: "invalidated" | "expired";
  }): void {
    this.transaction(() => {
      const record = this.contentReviewForRun(input.context.identity.run_id);
      if (record === undefined) throw new GateConflictError("content-review row is absent");
      if (
        input.receiptSha256 !== undefined &&
        record.decision_receipt_sha256 !== undefined &&
        record.decision_receipt_sha256 !== input.receiptSha256
      ) {
        throw new GateConflictError("content-review invalidation receipt digest mismatch");
      }
      this.db
        .prepare(
          `UPDATE content_reviews SET state = ?, updated_at = ?
           WHERE challenge_id = ? AND state NOT IN ('consumed', 'refined', 'denied')`
        )
        .run(input.state, now(), record.challenge_id);
      this.db
        .prepare(
          `UPDATE gates SET status = 'answered', response_digest = ?, response_json = ?, answered_at = ?
           WHERE run_id = ? AND gate_id = ?`
        )
        .run(
          sha256(input.reason),
          canonicalJson({ invalidated: input.reason }),
          now(),
          record.run_id,
          record.challenge_id
        );
      this.updateRun(input.context);
      this.insertEvent(
        record.run_id,
        "content_review_invalidated",
        { run_id: record.run_id, gate_id: record.challenge_id, reason: input.reason },
        now()
      );
    });
  }

  /**
   * Append one content-free liveness charge without mutating the run snapshot.
   * These synchronous writes are the admission boundary for model/tool/time work
   * and deliberately bypass observability.
   */
  appendLivenessEvent(runId: string, eventType: string, payload: Record<string, JsonValue>): void {
    if (!eventType.startsWith("liveness_")) {
      throw new CheckpointIdentityError("liveness event type must use the liveness_ prefix");
    }
    const parsed = validateContract(
      CheckpointEventPayloadSchema,
      payload,
      "liveness event payload"
    );
    this.transaction(() => {
      if (this.selectRun(runId) === undefined) {
        throw new CheckpointIdentityError(`unknown run_id '${runId}'`);
      }
      this.insertEvent(runId, eventType, parsed, now());
    });
  }

  /** Append bounded body-free host-operation metadata without mutating the run snapshot. */
  appendHostOperationEvent(
    runId: string,
    eventType: string,
    payload: Record<string, JsonValue>,
    timestamp = now()
  ): void {
    if (
      !Number.isFinite(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp
    ) {
      throw new CheckpointIdentityError("host-operation event timestamp must be canonical UTC");
    }
    if (!eventType.startsWith("host_operation_")) {
      throw new CheckpointIdentityError(
        "host-operation event type must use the host_operation_ prefix"
      );
    }
    const parsed = validateContract(
      CheckpointEventPayloadSchema,
      payload,
      "host-operation event payload"
    );
    if (Buffer.byteLength(canonicalJson(parsed), "utf8") > 16_384) {
      throw new CheckpointIdentityError("host-operation event payload exceeds 16384 bytes");
    }
    this.transaction(() => {
      if (this.selectRun(runId) === undefined) {
        throw new CheckpointIdentityError(`unknown run_id '${runId}'`);
      }
      this.insertEvent(runId, eventType, parsed, timestamp);
    });
  }

  saveRun(context: RunContext, eventType: string, payload: Record<string, JsonValue>): void {
    let persistedPayload: Record<string, JsonValue> = payload;
    this.transaction(() => {
      this.validatePositiveTerminalWrite(context);
      persistedPayload = this.checkpointPayload(context, payload);
      this.updateRun(context);
      this.persistPendingGate(context);
      this.insertEvent(context.identity.run_id, eventType, persistedPayload, now());
    });
    context.markCheckpointEvidencePersisted();
    this.observe(context, eventType, persistedPayload);
  }

  saveWithReceipt(
    context: RunContext,
    result: PhaseResult,
    branchId: string,
    eventType: string,
    payload: Record<string, JsonValue>
  ): void {
    let persistedPayload: Record<string, JsonValue> = payload;
    this.transaction(() => {
      this.insertReceipt(result.worker_receipt, result, branchId);
      this.validatePositiveTerminalWrite(context);
      persistedPayload = this.checkpointPayload(context, payload);
      this.updateRun(context);
      this.persistPendingGate(context);
      this.insertEvent(context.identity.run_id, eventType, persistedPayload, now());
    });
    context.markCheckpointEvidencePersisted();
    this.observe(context, eventType, persistedPayload);
  }

  gateResponseBinding(
    runId: string,
    gateId: string
  ):
    | {
        readonly challenge: string;
        readonly status: "pending" | "answered";
        readonly response_digest: string | null;
      }
    | undefined {
    const value = this.db
      .prepare(
        "SELECT gate_id, challenge, status, response_digest, response_json FROM gates WHERE run_id = ? AND gate_id = ?"
      )
      .get(runId, gateId);
    if (value === undefined) return undefined;
    const row = gateRow(value);
    if (row.status !== "pending" && row.status !== "answered") {
      throw new GateConflictError(`gate '${gateId}' has invalid status`);
    }
    return {
      challenge: row.challenge,
      status: row.status,
      response_digest: row.response_digest,
    };
  }

  saveGateResponse(
    context: RunContext,
    gateId: string,
    challenge: string,
    response: JsonValue,
    eventType: string,
    payload: Record<string, JsonValue>,
    storageMode: GenericGateResponseStorageModeV1 = "full",
    projectedCallId?: string,
    expectedParentSnapshotSha256?: string
  ): void {
    if (storageMode !== "full" && storageMode !== "digest-only") {
      throw new GateConflictError("invalid generic gate response storage mode");
    }
    const responseJson = canonicalJson(response);
    const responseDigest = sha256(responseJson);
    // Do not allow a caller of the digest-only store to smuggle response text into
    // the event or its observability mirror via an otherwise arbitrary payload.
    if (storageMode === "digest-only") {
      const identity = context.identity;
      const safePayload: Record<string, JsonValue> = {
        schema_version: identity.schema_version,
        run_id: identity.run_id,
        session_id: identity.session_id,
        playbook: identity.playbook,
        engine_owner: identity.engine_owner,
        gate_id: gateId,
        response_sha256: responseDigest,
        state_id: context.stateId,
      };
      if (
        eventType !== "user_gate_answered" ||
        canonicalJson(payload) !== canonicalJson(safePayload)
      ) {
        throw new GateConflictError("digest-only generic gate event must be body-free");
      }
    }
    let persistedPayload: Record<string, JsonValue> = payload;
    let duplicate = false;
    this.transaction(() => {
      if (
        expectedParentSnapshotSha256 !== undefined &&
        sha256(canonicalJson(this.loadRun(context.identity).snapshot())) !==
          expectedParentSnapshotSha256
      )
        throw new GateConflictError("gate response lost current parent selections");
      if (projectedCallId !== undefined) {
        const call = this.childWorkflowCall(projectedCallId);
        if (
          call === undefined ||
          call.lifecycle !== "waiting_user" ||
          call.parent_identity.run_id !== context.identity.run_id ||
          !this.exactProjectedChildGate(call, this.loadRun(call.parent_identity)) ||
          canonicalJson(context.pendingDirective) !== canonicalJson(call.directive)
        )
          throw new GateConflictError(
            "projected reply lost its exact waiting child or parent fence"
          );
        const parent = this.loadRun(call.parent_identity);
        const replyRef = context.selectedArtifacts.at(-1);
        if (
          replyRef === undefined ||
          replyRef.run_id !== parent.identity.run_id ||
          replyRef.kind !== "child-gate-response" ||
          replyRef.producer !== "host:child-workflow-owner" ||
          replyRef.operation_id !== `child-response:${gateId}` ||
          replyRef.content_digest !== responseDigest ||
          replyRef.byte_length !== Buffer.byteLength(responseJson, "utf8") ||
          replyRef.content_schema?.schema_id !== "penny.projected-child-response.v1" ||
          replyRef.content_schema.schema_version !== 1 ||
          canonicalJson(context.snapshot()) !==
            canonicalJson({
              ...parent.snapshot(),
              status: "running",
              pending_directive: call.directive,
              selected_artifacts: [...parent.selectedArtifacts, replyRef],
            })
        )
          throw new GateConflictError(
            "projected reply changed unrelated parent state or lacks its exact response ref"
          );
      }
      const rowValue = this.db
        .prepare(
          "SELECT gate_id, challenge, status, response_digest, response_json FROM gates WHERE run_id = ? AND gate_id = ?"
        )
        .get(context.identity.run_id, gateId);
      const row = rowValue === undefined ? undefined : gateRow(rowValue);
      if (row === undefined) {
        throw new GateConflictError(`unknown gate '${gateId}'`);
      }
      if (row.challenge !== challenge) {
        throw new GateConflictError(`challenge mismatch for gate '${gateId}'`);
      }
      if (row.status === "answered") {
        if (
          storageMode === "digest-only"
            ? row.response_json === null && row.response_digest === responseDigest
            : row.response_json === responseJson
        ) {
          duplicate = true;
          return;
        }
        throw new GateConflictError(`gate '${gateId}' was already answered`);
      }
      const updated = this.db
        .prepare(
          `UPDATE gates
           SET status='answered', response_digest=?, response_json=?, answered_at=?
           WHERE run_id=? AND gate_id=? AND status='pending'`
        )
        .run(
          responseDigest,
          storageMode === "digest-only" ? null : responseJson,
          now(),
          context.identity.run_id,
          gateId
        );
      if (storageMode === "digest-only" && numberValue(updated.changes) !== 1) {
        throw new GateConflictError(`gate '${gateId}' is no longer pending`);
      }
      this.validatePositiveTerminalWrite(context);
      persistedPayload = this.checkpointPayload(context, payload);
      this.updateRun(context);
      this.persistPendingGate(context);
      this.insertEvent(context.identity.run_id, eventType, persistedPayload, now());
    });
    if (duplicate && storageMode === "digest-only") return;
    context.markCheckpointEvidencePersisted();
    this.observe(context, eventType, persistedPayload);
  }

  loadRun(identity: RunIdentity): RunContext {
    const row = this.selectRun(identity.run_id);
    if (row === undefined) {
      throw new CheckpointIdentityError(`unknown run_id '${identity.run_id}'`);
    }
    this.assertIdentityRow(identity, row);
    const context = this.contextFromRunRow(row);
    this.assertIdentity(identity, context.identity);
    return context;
  }

  /** Exact project binding for an owner sharing this control store with an artifact store. */
  assertBoundProject(projectId: string): void {
    this.assertProjectBinding(projectId);
  }

  /** Bounded exact-run owner evidence, precharged before JSON decoding or predicate evaluation. */
  compositionEvidence(
    runId: string,
    maxRecords = 128,
    maxBytes = 16 * 1024 * 1024
  ): {
    readonly events: readonly CheckpointEvent[];
    readonly receipts: readonly { receipt_id: string; sha256: string }[];
    readonly bytes: number;
  } {
    const size = this.db
      .prepare(
        `SELECT
      (SELECT COUNT(*) FROM runs WHERE run_id = ?) +
      (SELECT COUNT(*) FROM events WHERE run_id = ?) + (SELECT COUNT(*) FROM receipts WHERE run_id = ?) AS records,
      (SELECT COALESCE(SUM(length(CAST(context_json AS BLOB))), 0) FROM runs WHERE run_id = ?) +
      (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) FROM events WHERE run_id = ?) +
      (SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))), 0) FROM receipts WHERE run_id = ?) AS bytes`
      )
      .get(runId, runId, runId, runId, runId, runId);
    if (
      size === undefined ||
      sqliteInteger(size, "records", "composition evidence") > Math.min(maxRecords, 128) ||
      sqliteInteger(size, "bytes", "composition evidence") > Math.min(maxBytes, 16 * 1024 * 1024)
    ) {
      throw new CheckpointIdentityError("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED: owner records");
    }
    const receipts = this.db
      .prepare("SELECT receipt_id, result_json FROM receipts WHERE run_id = ? ORDER BY receipt_id")
      .all(runId)
      .map((row) => ({
        receipt_id: sqliteText(row, "receipt_id", "composition receipt"),
        sha256: sha256(sqliteText(row, "result_json", "composition receipt")),
      }));
    return {
      events: this.events(runId),
      receipts,
      bytes: sqliteInteger(size, "bytes", "composition evidence"),
    };
  }

  loadRunById(runId: string): RunContext | undefined {
    const row = this.selectRun(runId);
    if (row === undefined) {
      return undefined;
    }
    return this.contextFromRunRow(row);
  }

  /**
   * Return an approval binding only when the durable run context and generic
   * gate row agree on the exact approved promotion decision and receipt.
   */
  promotionApprovalBinding(runId: string): PromotionControlApprovalBinding | undefined {
    const context = this.loadRunById(runId);
    if (
      context === undefined ||
      context.identity.playbook !== "knowledge-base" ||
      String(context.knowledgeBaseData.action ?? "") !== "promote" ||
      (context.stateId !== "awaiting_review" && context.terminalDirective === null) ||
      String(context.knowledgeBaseData.review_decision ?? "") !== "approve"
    ) {
      return undefined;
    }
    const challengeId = String(context.knowledgeBaseData.promotion_challenge_id ?? "");
    const packetSha256 = String(context.knowledgeBaseData.promotion_packet_sha256 ?? "");
    const intentSha256 = String(context.knowledgeBaseData.promotion_decision_intent_sha256 ?? "");
    const receiptId = String(context.knowledgeBaseData.promotion_receipt_id ?? "");
    const receiptSha256 = String(context.knowledgeBaseData.promotion_receipt_sha256 ?? "");
    if (
      challengeId.length === 0 ||
      receiptId.length === 0 ||
      !/^[a-f0-9]{64}$/.test(packetSha256) ||
      !/^[a-f0-9]{64}$/.test(intentSha256) ||
      !/^[a-f0-9]{64}$/.test(receiptSha256)
    ) {
      return undefined;
    }
    const gate = this.db
      .prepare(
        `SELECT challenge, payload_digest, status, response_json
         FROM gates WHERE run_id = ? AND gate_id = ?`
      )
      .get(runId, challengeId);
    const expectedResponse = canonicalJson({
      decision: "approve",
      intent_sha256: intentSha256,
      receipt_id: receiptId,
      receipt_sha256: receiptSha256,
    });
    if (
      gate === undefined ||
      sqliteText(gate, "status", "promotion approval gate") !== "answered" ||
      (context.pendingDirective?.action === "await_user" &&
        sqliteText(gate, "challenge", "promotion approval gate") !==
          context.pendingDirective.challenge) ||
      sqliteText(gate, "payload_digest", "promotion approval gate") !== packetSha256 ||
      sqliteNullableText(gate, "response_json", "promotion approval gate") !== expectedResponse
    ) {
      return undefined;
    }
    return {
      run_id: runId,
      challenge_id: challengeId,
      packet_sha256: packetSha256 as PromotionControlApprovalBinding["packet_sha256"],
      decision: "approve",
      decision_intent_sha256:
        intentSha256 as PromotionControlApprovalBinding["decision_intent_sha256"],
      receipt_id: receiptId,
      receipt_sha256: receiptSha256 as PromotionControlApprovalBinding["receipt_sha256"],
    };
  }

  receiptResultById(receiptId: string): PhaseResult | undefined {
    const rowValue = this.db
      .prepare("SELECT receipt_id, result_json FROM receipts WHERE receipt_id = ?")
      .get(receiptId);
    if (rowValue === undefined) return undefined;
    const row = receiptRow(rowValue);
    return validateContract(PhaseResultSchema, JSON.parse(row.result_json), "stored phase result");
  }

  receiptResult(receipt: ExecutionReceipt): PhaseResult | undefined {
    const rowValue = this.db
      .prepare("SELECT receipt_id, result_json FROM receipts WHERE receipt_id = ?")
      .get(receipt.receipt_id);
    if (rowValue === undefined) {
      return undefined;
    }
    const row = receiptRow(rowValue);
    return validateContract(PhaseResultSchema, JSON.parse(row.result_json), "stored phase result");
  }

  events(runId: string): CheckpointEvent[] {
    return this.eventsAfter(runId, 0);
  }

  /** Indexed suffix read for incremental deterministic projections such as liveness. */
  eventsAfter(runId: string, sequence: number): CheckpointEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new CheckpointIdentityError("event sequence must be a non-negative safe integer");
    }
    const rows = this.db
      .prepare(
        `SELECT sequence, event_type, payload_json, created_at FROM events
         WHERE run_id = ? AND sequence > ? ORDER BY sequence`
      )
      .all(runId, sequence);
    return rows.map((row) => ({
      sequence: sqliteInteger(row, "sequence", "stored checkpoint event"),
      eventType: sqliteText(row, "event_type", "stored checkpoint event"),
      payload: validateContract(
        CheckpointEventPayloadSchema,
        JSON.parse(sqliteText(row, "payload_json", "stored checkpoint event")),
        "stored checkpoint event payload"
      ),
      createdAt: sqliteText(row, "created_at", "stored checkpoint event"),
    }));
  }

  tableNames(): string[] {
    return (
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<Record<string, SQLOutputValue>>
    ).map((row) => String(row.name));
  }

  close(): void {
    this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** Body-free existence projection used by the project retention custodian. */
  hasRunById(runId: string): boolean {
    return this.db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId) !== undefined;
  }

  /**
   * Bounded retention: prune the oldest terminal runs that exceed the retention cap.
   *
   * Terminal statuses are complete, incomplete, error, and cancelled. Non-terminal
   * (running or awaiting_user) runs are never pruned — they may still be resumed.
   * Pruning cascades to events, receipts, and gates via FK ON DELETE CASCADE. The
   * exact deleted run IDs are exposed only after the deletion transaction commits.
   */
  pruneTerminalRuns(): readonly string[] {
    // This method is synchronous and invokes no application callbacks: only other
    // connections can change the store between planning and deletion. Capture the
    // same-connection data_version BEFORE opening the read snapshot, then compare
    // it AFTER acquiring the writer reservation. Any intervening commit invalidates
    // the whole plan (including new consumers, custody holds, calls and keep order).
    const version = this.retentionDataVersion();
    this.db.exec("BEGIN DEFERRED");
    let candidates: readonly string[];
    try {
      candidates = this.terminalRunRetentionPlan();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (candidates.length === 0) return [];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.retentionDataVersion() !== version) {
        this.db.exec("ROLLBACK");
        // Retention is opportunistic: a busy project must not spin through repeated
        // full plans and delay service shutdown. The next retention pass replans;
        // preserving excess runs is safe, deleting from a stale snapshot is not.
        return [];
      }
      const deleted: string[] = [];
      const deleteStmt = this.db.prepare("DELETE FROM runs WHERE run_id = ?");
      for (const runId of candidates) {
        if (numberValue(deleteStmt.run(runId).changes) !== 1) {
          throw new CheckpointIdentityError("retention candidate disappeared during deletion");
        }
        deleted.push(runId);
      }
      this.db.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private retentionDataVersion(): number {
    return sqliteInteger(
      requiredCheckpointValue(this.db.prepare("PRAGMA main.data_version").get(), "data version"),
      "data_version",
      "retention data version"
    );
  }

  /** Read-snapshot-only planning; no context hydration or history replay in the write phase. */
  private terminalRunRetentionPlan(): readonly string[] {
    const terminalStatuses = ["complete", "incomplete", "error", "cancelled"];
    const placeholders = terminalStatuses.map(() => "?").join(", ");
    // Most shutdowns have nothing to evict. Do not load contexts, calls or event history,
    // and in particular do not compete for the writer reservation on this path.
    if (
      this.db
        .prepare(`SELECT 1 FROM runs WHERE status IN (${placeholders}) LIMIT 1 OFFSET ?`)
        .get(...terminalStatuses, this.maxRetainedRuns) === undefined
    )
      return [];
    // Keep the newest `maxRetainedRuns` terminal runs; delete the rest.
    // DESC ordering selects the newest first, with insertion order breaking timestamp ties.
    const keep = this.db
      .prepare(
        `SELECT run_id FROM runs
         WHERE status IN (${placeholders})
         ORDER BY updated_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(...terminalStatuses, this.maxRetainedRuns);
    const keepIds = keep.map((row) => sqliteText(row, "run_id", "retained orchestration run"));
    // Keep linked parent/child control rows and catalog sessions as an indivisible cohort.
    // No artifact objects are deleted here; immutable media remains under artifact custody.
    const keepSet = new Set(keepIds);
    const runs = this.db.prepare("SELECT run_id, status FROM runs ORDER BY rowid").all();
    const blocked = new Set(
      this.db
        .prepare(
          `
      SELECT run_id FROM private_inputs WHERE state <> 'discarded'
      UNION SELECT run_id FROM start_admissions WHERE state <> 'terminal'
      UNION SELECT run_id FROM operation_event_groups
      UNION SELECT run_id FROM kb_run_artifacts
    `
        )
        .all()
        .map((row) => sqliteText(row, "run_id", "retention custody blocker"))
    );
    const calls = this.db
      .prepare("SELECT call_id FROM child_workflow_calls ORDER BY call_id")
      .all()
      .map((row) =>
        requiredCheckpointValue(
          this.childWorkflowCall(sqliteText(row, "call_id", "retained child call")),
          "retained child call"
        )
      );
    const parents = new Map(
      calls.map((call) => [call.child_identity.run_id, call.parent_identity.run_id])
    );
    const rootFor = (runId: string): string => {
      const seen = new Set<string>();
      let current = runId;
      while (parents.has(current)) {
        if (seen.has(current))
          throw new CheckpointIdentityError("retention child cohort contains a cycle");
        seen.add(current);
        current = requiredCheckpointValue(parents.get(current), "retention cohort parent");
      }
      return current;
    };
    const groups = new Map<string, string[]>();
    for (const row of runs) {
      const id = sqliteText(row, "run_id", "retention cohort run");
      if (!terminalStatuses.includes(sqliteText(row, "status", "retention cohort status")))
        blocked.add(id);
      const root = rootFor(id);
      const group = groups.get(root) ?? [];
      group.push(id);
      groups.set(root, group);
    }
    // Released, consumed effects are settled. A consumed remote-unknown/quarantine is not.
    for (const row of this.db
      .prepare("SELECT operation_record_id FROM host_operation_calls")
      .all()) {
      const effect = requiredCheckpointValue(
        this.hostOperationCall(sqliteText(row, "operation_record_id", "retained host operation")),
        "retained host operation"
      );
      if (effect.lifecycle !== "consumed" || effect.disposition?.lease_disposition !== "released")
        blocked.add(effect.identity.run_id);
    }
    for (const call of calls) {
      if (call.lifecycle === "consumed") continue;
      const parent = this.loadRun(call.parent_identity);
      const child = this.loadRun(call.child_identity);
      const safelyAbandoned =
        parent.terminalDirective?.action === "cancelled" &&
        child.terminalDirective !== null &&
        call.terminal_sha256 === sha256(canonicalJson(child.terminalDirective)) &&
        ["cancelled", "failed", "terminal_recorded"].includes(call.lifecycle);
      if (!safelyAbandoned) blocked.add(call.parent_identity.run_id);
    }
    // Exact cross-run handoffs pin producer control/gate/receipt evidence for as long as a
    // retained consumer depends on it. Age alone cannot sever an approval/delivery chain.
    const pendingRoots = [...groups]
      .filter(([, members]) => members.some((id) => keepSet.has(id) || blocked.has(id)))
      .map(([root]) => root);
    const visitedRoots = new Set(pendingRoots);
    for (let i = 0; i < pendingRoots.length; i++) {
      const root = requiredCheckpointValue(pendingRoots[i], "retained dependency root");
      for (const id of groups.get(root) ?? [])
        for (const ref of this.retentionSelectedArtifacts(id)) {
          const producerRoot = rootFor(ref.run_id);
          if (!groups.has(producerRoot) || visitedRoots.has(producerRoot)) continue;
          visitedRoots.add(producerRoot);
          pendingRoots.push(producerRoot);
          for (const producer of groups.get(producerRoot) ?? []) blocked.add(producer);
        }
    }
    const candidates: string[] = [];
    for (const [root, members] of groups) {
      if (members.some((id) => keepSet.has(id) || blocked.has(id))) continue;
      // Parent-first order removes the FK-linked calls before their child rows.
      candidates.push(root, ...members.filter((id) => id !== root));
    }
    return candidates;
  }

  /**
   * Validate the compact checkpoint with the canonical codec, without rehydrating a live run
   * or restoring its state visits. Retention needs exact producer refs, not runtime state.
   */
  private retentionSelectedArtifacts(runId: string): readonly ArtifactRef[] {
    const row = requiredCheckpointValue(this.selectRun(runId), "retained dependency run");
    const parsed: unknown = JSON.parse(row.context_json);
    const projection = orchestrationDurableStateCodec.decodeCheckpoint(parsed, {
      playbook: row.playbook,
      ...(this.kbRuntimeProjectRoot === undefined
        ? {}
        : { projectRoot: this.kbRuntimeProjectRoot }),
    });
    this.assertIdentityRow(projection.identity, row);
    return projection.selected_artifacts;
  }

  private contextForChildWorkflowCall(runId: string): RunContext {
    const row = this.selectRun(runId);
    if (row === undefined) {
      throw new CheckpointIdentityError(`child-workflow linked run '${runId}' is absent`);
    }
    const context = this.contextFromRunRow(row);
    this.assertIdentityRow(context.identity, row);
    return context;
  }

  private projectIdForChildWorkflowCall(): string {
    const row = this.db.prepare("SELECT project_id FROM store_metadata WHERE singleton = 1").get();
    if (row === undefined) {
      throw new CheckpointIdentityError("child-workflow control store lacks a project binding");
    }
    return sqliteText(row, "project_id", "child-workflow control-store project binding");
  }

  private assertRegistrationDigest(context: RunContext, expected: string, label: string): void {
    const binding = context.registrationContractBinding;
    if (
      binding === undefined ||
      binding.registration_name !== context.identity.playbook ||
      binding.registration_sha256 !== expected
    ) {
      throw new CheckpointIdentityError(`${label} is absent or does not match the durable run`);
    }
  }

  private exactProjectedChildGate(record: ChildWorkflowCallRecord, parent: RunContext): boolean {
    const gate = this.contextForChildWorkflowCall(record.child_identity.run_id).pendingDirective;
    return (
      parent.status === "awaiting_user" &&
      gate?.action === "await_user" &&
      canonicalJson(parent.pendingDirective) === canonicalJson(projectChildGate(record, gate))
    );
  }

  private assertChildWorkflowCallLinkage(record: ChildWorkflowCallRecord): void {
    const parent = this.contextForChildWorkflowCall(record.parent_identity.run_id);
    const child = this.contextForChildWorkflowCall(record.child_identity.run_id);
    this.assertIdentity(record.parent_identity, parent.identity);
    this.assertIdentity(record.child_identity, child.identity);
    this.assertRegistrationDigest(
      parent,
      record.parent_registration_sha256,
      "stored parent child-workflow registration"
    );
    this.assertRegistrationDigest(
      child,
      record.child_registration_sha256,
      "stored child child-workflow registration"
    );
    if (
      child.projectRoot !== parent.projectRoot ||
      child.trustProfile !== parent.trustProfile ||
      (record.schema_version === 1 && child.maxSteps !== record.budget.max_steps)
    ) {
      throw new CheckpointIdentityError(
        "stored child-workflow run diverged from its parent trust boundary or legacy step allocation"
      );
    }
    if (this.projectIdForChildWorkflowCall() !== record.policy_binding.project_id) {
      throw new CheckpointIdentityError(
        "stored child-workflow policy project does not match the control-store project"
      );
    }
    const parentCancellationIsDurable =
      parent.status === "cancelled" && parent.terminalDirective?.action === "cancelled";
    if (
      (record.lifecycle === "reserved" ||
        record.lifecycle === "running" ||
        record.lifecycle === "waiting_user" ||
        record.lifecycle === "paused") &&
      canonicalJson(parent.pendingDirective) !== canonicalJson(record.directive) &&
      !(record.lifecycle === "waiting_user" && this.exactProjectedChildGate(record, parent)) &&
      !parentCancellationIsDurable
    ) {
      throw new CheckpointIdentityError(
        "stored child-workflow call is not the parent's exact pending directive"
      );
    }
    if (
      !this.stateVisits(record.parent_identity.run_id).some(
        (visit) =>
          visit.event_sequence === record.parent_visit_sequence &&
          visit.offset === record.parent_visit_offset &&
          visit.state_id === record.parent_state_id
      )
    ) {
      throw new CheckpointIdentityError(
        "stored child-workflow call does not reference an exact durable parent visit"
      );
    }
  }

  private assertInitialChildWorkflowContext(
    context: RunContext,
    record: ChildWorkflowCallRecord
  ): void {
    this.assertNewRunCompletionProtocol(context);
    this.assertIdentity(record.child_identity, context.identity);
    this.assertRegistrationDigest(
      context,
      record.child_registration_sha256,
      "initial child-workflow registration"
    );
    const visits = context.pendingStateVisits();
    if (
      context.status !== "running" ||
      context.stateId !== "intake" ||
      context.previousState !== null ||
      context.stepCount !== 0 ||
      (record.schema_version === 1 && context.maxSteps !== record.budget.max_steps) ||
      context.met ||
      context.pendingDirective !== null ||
      context.pendingBranches.length !== 0 ||
      context.terminalDirective !== null ||
      canonicalJson(visits) !==
        canonicalJson([{ schema_version: 1, state_id: "intake", source: "create" }])
    ) {
      throw new ChildWorkflowCallConflictError(
        "child-workflow context is not the exact unstarted ordinary run"
      );
    }
  }

  private durableContextJson(context: RunContext): string {
    if (context.identity.playbook === "knowledge-base") {
      this.bindKbRuntimeProjectRoot(context.projectRoot);
    }
    const checkpoint = orchestrationDurableStateCodec.encodeCheckpoint(context.snapshot());
    return canonicalJson(checkpoint);
  }

  private contextFromRunRow(row: RunRow): RunContext {
    const parsed: unknown = JSON.parse(row.context_json);
    if (row.playbook !== "knowledge-base") {
      const context = RunContext.fromCheckpoint(parsed, { playbook: row.playbook });
      if (
        !isTerminalStatus(context.status) &&
        !this.stateVisits(row.run_id).some((visit) => visit.state_id === context.stateId)
      ) {
        context.restoreCurrentStateVisit();
      }
      return context;
    }
    const projectRoot = this.kbRuntimeProjectRoot;
    if (projectRoot === undefined) {
      throw new CheckpointIdentityError(
        "KB durable projection cannot load without the current trusted project root"
      );
    }
    const context = RunContext.fromCheckpoint(parsed, {
      playbook: row.playbook,
      projectRoot,
    });
    this.assertIdentityRow(context.identity, row);
    if (
      !isTerminalStatus(context.status) &&
      !this.stateVisits(row.run_id).some((visit) => visit.state_id === context.stateId)
    ) {
      context.restoreCurrentStateVisit();
    }
    return context;
  }

  private selectRun(runId: string): RunRow | undefined {
    const row = this.db
      .prepare(
        `SELECT run_id, session_id, playbook, engine_owner, schema_version, context_json
         FROM runs WHERE run_id = ?`
      )
      .get(runId);
    return row === undefined ? undefined : runRow(row);
  }

  private assertIdentityRow(identity: RunIdentity, row: RunRow): void {
    if (row.schema_version !== 2 || row.engine_owner !== "typescript") {
      throw new CheckpointIdentityError("stored checkpoint identity is not a TypeScript v2 run");
    }
    this.assertIdentity(identity, {
      schema_version: 2,
      run_id: row.run_id,
      session_id: row.session_id,
      playbook: row.playbook,
      engine_owner: "typescript",
    });
  }

  private assertIdentity(expected: RunIdentity, actual: RunIdentity): void {
    for (const key of [
      "schema_version",
      "run_id",
      "session_id",
      "playbook",
      "engine_owner",
    ] as const) {
      if (expected[key] !== actual[key]) {
        throw new CheckpointIdentityError(
          `checkpoint identity mismatch for ${key}: expected '${expected[key]}', found '${actual[key]}'`
        );
      }
    }
  }

  private updateRun(context: RunContext): void {
    const identity = context.identity;
    const result = this.db
      .prepare(
        `UPDATE runs
         SET status=?, state_id=?, context_json=?, updated_at=?
         WHERE run_id=? AND session_id=? AND playbook=?
           AND engine_owner=? AND schema_version=?`
      )
      .run(
        context.status,
        context.stateId,
        this.durableContextJson(context),
        now(),
        identity.run_id,
        identity.session_id,
        identity.playbook,
        identity.engine_owner,
        identity.schema_version
      );
    if (numberValue(result.changes) !== 1) {
      const row = this.selectRun(identity.run_id);
      if (row === undefined) {
        throw new CheckpointIdentityError(`unknown run_id '${identity.run_id}'`);
      }
      this.assertIdentityRow(identity, row);
      throw new CheckpointIdentityError(`failed to update checkpoint '${identity.run_id}'`);
    }
  }

  private insertEvent(
    runId: string,
    eventType: string,
    payload: Record<string, JsonValue>,
    timestamp: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO events(run_id, sequence, event_type, payload_json, created_at)
         SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?
         FROM events WHERE run_id = ?`
      )
      .run(runId, eventType, canonicalJson(payload), timestamp, runId);
  }

  private insertReceipt(receipt: ExecutionReceipt, result: PhaseResult, branchId: string): void {
    const resultJson = canonicalJson(result);
    const existingValue = this.db
      .prepare("SELECT receipt_id, result_json FROM receipts WHERE receipt_id = ?")
      .get(receipt.receipt_id);
    const existingById = existingValue === undefined ? undefined : receiptRow(existingValue);
    if (existingById !== undefined) {
      if (existingById.result_json === resultJson) {
        return;
      }
      throw new ReceiptConflictError(`receipt_id '${receipt.receipt_id}' has conflicting content`);
    }
    try {
      this.db
        .prepare(
          `INSERT INTO receipts(
            receipt_id, run_id, state_id, branch_id, agent, attempt,
            worker_id, output_digest, result_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          receipt.receipt_id,
          receipt.run_id,
          receipt.state_id,
          branchId,
          receipt.agent,
          receipt.attempt,
          receipt.worker_id,
          receipt.output_digest,
          resultJson,
          now()
        );
    } catch (error) {
      throw new ReceiptConflictError(
        `assignment ${receipt.run_id}/${receipt.state_id}/${branchId}/${receipt.attempt} already has a receipt: ${String(error)}`
      );
    }
  }

  private observe(
    context: RunContext,
    eventType: string,
    payload: Record<string, JsonValue>
  ): void {
    if (this.observer === undefined) {
      return;
    }
    try {
      const event = this.events(context.identity.run_id).at(-1);
      if (event === undefined) {
        return;
      }
      this.observer({
        identity: context.identity,
        status: context.status,
        stateId: context.stateId,
        eventType,
        payload: structuredClone(payload),
        sequence: event.sequence,
        timestamp: event.createdAt,
      });
    } catch {
      // The observability mirror never blocks durable checkpoint truth.
    }
  }

  private persistPendingGate(context: RunContext): void {
    const directive = context.pendingDirective;
    if (directive?.action !== "await_user") {
      return;
    }
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO gates(
          run_id, gate_id, state_id, challenge, payload_digest, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(run_id, gate_id) DO NOTHING`
      )
      .run(
        context.identity.run_id,
        directive.gate_id,
        directive.state_id,
        directive.challenge,
        directive.payload_digest,
        timestamp
      );

    // G8 §5.1: ingest/save waits are valid only when the complete canonical
    // packet is inserted in THIS transaction with the run/generic gate. A
    // waiting run without that row is corruption, not a recoverable empty gate.
    if (context.identity.playbook !== "knowledge-base") return;
    const knowledgeBaseData = context.knowledgeBaseData;
    const action = String(knowledgeBaseData.action ?? "");
    if (action !== "ingest" && action !== "save") return;
    const packetJcs = knowledgeBaseData.content_review_packet_jcs;
    const expectedDigest = knowledgeBaseData.content_review_packet_sha256;
    if (typeof packetJcs !== "string" || typeof expectedDigest !== "string") {
      throw new GateConflictError(
        `KB run '${context.identity.run_id}' reached content review without a canonical packet`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(packetJcs);
    } catch {
      throw new GateConflictError("content-review packet JCS is not valid JSON");
    }
    const packet = validateContentReviewPacket(parsed);
    if (
      canonicalJson(packet) !== packetJcs ||
      packetDigest(packet) !== expectedDigest ||
      packet.run_id !== context.identity.run_id ||
      packet.session_id !== context.identity.session_id ||
      packet.challenge_id !== directive.gate_id ||
      packet.kb_profile_id !== String(knowledgeBaseData.profile_id ?? "") ||
      packet.action !== action
    ) {
      throw new GateConflictError(
        "content-review packet does not exactly bind the waiting run/gate"
      );
    }
    const existingValue = this.db
      .prepare("SELECT * FROM content_reviews WHERE challenge_id = ?")
      .get(packet.challenge_id);
    const existing = existingValue === undefined ? undefined : contentReviewRow(existingValue);
    if (existing !== undefined) {
      if (
        String(existing.packet_sha256) !== expectedDigest ||
        String(existing.packet_jcs) !== packetJcs ||
        String(existing.run_id) !== context.identity.run_id
      ) {
        throw new GateConflictError(
          `content-review challenge '${packet.challenge_id}' conflicts with stored packet bytes`
        );
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO content_reviews(
          challenge_id, run_id, packet_sha256, packet_jcs, state, updated_at
        ) VALUES (?, ?, ?, ?, 'awaiting', ?)`
      )
      .run(packet.challenge_id, packet.run_id, expectedDigest, packetJcs, timestamp);
  }
}
