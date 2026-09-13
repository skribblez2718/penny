import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactStore, type ArtifactReader } from "../artifact-store.js";
import type { ArtifactRef } from "../contracts.js";
import {
  childWorkflowCallId,
  childWorkflowDirectiveSha256,
  childWorkflowRunIdentity,
  validateCanonicalChildWorkflowRequestBytes,
  validateChildWorkflowCallRecord,
  validateInitialChildWorkflowDirective,
  type ChildWorkflowCallRecord,
  type ChildWorkflowInvocationDirective,
  type ChildWorkflowLifecycleV1,
} from "./contracts.js";

export const MAX_CHILD_WORKFLOW_CALL_RECORD_BYTES = 1_048_576 as const;

export interface EncodedChildWorkflowCallRecordV1 {
  readonly record: ChildWorkflowCallRecord;
  readonly record_jcs: string;
  readonly record_sha256: string;
}

export interface StoredChildWorkflowCallRowV1 {
  readonly call_id: unknown;
  readonly schema_version: unknown;
  readonly parent_run_id: unknown;
  readonly parent_state_id: unknown;
  readonly parent_visit_sequence: unknown;
  readonly parent_visit_offset: unknown;
  readonly call_key: unknown;
  readonly child_run_id: unknown;
  readonly lifecycle: unknown;
  readonly record_jcs: unknown;
  readonly record_sha256: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

function rowText(
  row: StoredChildWorkflowCallRowV1,
  key: keyof StoredChildWorkflowCallRowV1
): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`stored child-workflow call has an invalid '${key}' column`);
  }
  return value;
}

function rowInteger(
  row: StoredChildWorkflowCallRowV1,
  key: keyof StoredChildWorkflowCallRowV1
): number {
  const value = row[key];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new Error(`stored child-workflow call has an invalid '${key}' column`);
  }
  return number;
}

function assertDurableRecordInvariants(record: ChildWorkflowCallRecord): void {
  if (canonicalJson(record.directive.identity) !== canonicalJson(record.parent_identity)) {
    throw new Error(
      "durable child-workflow call directive identity is not the exact parent identity"
    );
  }
  validateInitialChildWorkflowDirective(record.directive);
  if (
    record.parent_visit_sequence < 1 ||
    record.parent_visit_offset < 0 ||
    record.parent_visit_offset > 31
  ) {
    throw new Error("durable child-workflow call visit coordinates are out of bounds");
  }
}

export function encodeChildWorkflowCallRecord(value: unknown): EncodedChildWorkflowCallRecordV1 {
  const record = validateChildWorkflowCallRecord(value);
  assertDurableRecordInvariants(record);
  const recordJcs = canonicalJson(record);
  const byteLength = Buffer.byteLength(recordJcs, "utf8");
  if (byteLength === 0 || byteLength > MAX_CHILD_WORKFLOW_CALL_RECORD_BYTES) {
    throw new Error(
      `durable child-workflow call record must contain 1..${MAX_CHILD_WORKFLOW_CALL_RECORD_BYTES} canonical UTF-8 bytes`
    );
  }
  return {
    record,
    record_jcs: recordJcs,
    record_sha256: sha256(recordJcs),
  };
}

export function decodeChildWorkflowCallRecord(input: {
  readonly record_jcs: unknown;
  readonly record_sha256: unknown;
}): ChildWorkflowCallRecord {
  if (typeof input.record_jcs !== "string" || typeof input.record_sha256 !== "string") {
    throw new Error("stored child-workflow call record or digest is not text");
  }
  const byteLength = Buffer.byteLength(input.record_jcs, "utf8");
  if (byteLength === 0 || byteLength > MAX_CHILD_WORKFLOW_CALL_RECORD_BYTES) {
    throw new Error("stored child-workflow call record has an invalid byte length");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.record_sha256)) {
    throw new Error("stored child-workflow call record digest is invalid");
  }
  if (sha256(input.record_jcs) !== input.record_sha256) {
    throw new Error("stored child-workflow call record digest does not match its bytes");
  }
  let value: unknown;
  try {
    value = JSON.parse(input.record_jcs);
  } catch {
    throw new Error("stored child-workflow call record is not JSON");
  }
  const encoded = encodeChildWorkflowCallRecord(value);
  if (encoded.record_jcs !== input.record_jcs) {
    throw new Error("stored child-workflow call record is not canonical JSON");
  }
  return encoded.record;
}

export function decodeStoredChildWorkflowCallRow(
  row: StoredChildWorkflowCallRowV1
): ChildWorkflowCallRecord {
  const record = decodeChildWorkflowCallRecord({
    record_jcs: row.record_jcs,
    record_sha256: row.record_sha256,
  });
  const projections: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["call_id", rowText(row, "call_id"), record.call_id],
    ["schema_version", rowInteger(row, "schema_version"), record.schema_version],
    ["parent_run_id", rowText(row, "parent_run_id"), record.parent_identity.run_id],
    ["parent_state_id", rowText(row, "parent_state_id"), record.parent_state_id],
    [
      "parent_visit_sequence",
      rowInteger(row, "parent_visit_sequence"),
      record.parent_visit_sequence,
    ],
    ["parent_visit_offset", rowInteger(row, "parent_visit_offset"), record.parent_visit_offset],
    ["call_key", rowText(row, "call_key"), record.call_key],
    ["child_run_id", rowText(row, "child_run_id"), record.child_identity.run_id],
    ["lifecycle", rowText(row, "lifecycle"), record.lifecycle],
    ["created_at", rowText(row, "created_at"), record.created_at],
    ["updated_at", rowText(row, "updated_at"), record.updated_at],
  ];
  for (const [field, projected, decoded] of projections) {
    if (projected !== decoded) {
      throw new Error(
        `stored child-workflow call '${record.call_id}' ${field} projection diverged`
      );
    }
  }
  return record;
}

export function childWorkflowCallImmutableJcs(record: ChildWorkflowCallRecord): string {
  return canonicalJson({
    schema_version: record.schema_version,
    call_id: record.call_id,
    parent_identity: record.parent_identity,
    parent_state_id: record.parent_state_id,
    parent_visit_sequence: record.parent_visit_sequence,
    parent_visit_offset: record.parent_visit_offset,
    call_key: record.call_key,
    child_identity: record.child_identity,
    directive: record.directive,
    directive_sha256: record.directive_sha256,
    request_ref: record.request_ref,
    request_ref_sha256: record.request_ref_sha256,
    input_artifacts: record.input_artifacts,
    input_refs_sha256: record.input_refs_sha256,
    expected_output: record.expected_output,
    expected_output_sha256: record.expected_output_sha256,
    policy_binding: record.policy_binding,
    policy_sha256: record.policy_sha256,
    parent_registration_sha256: record.parent_registration_sha256,
    child_registration_sha256: record.child_registration_sha256,
    ...(record.schema_version === 1 ? { budget: record.budget } : {}),
  });
}

const LEGAL_TRANSITIONS: Readonly<
  Record<ChildWorkflowLifecycleV1, readonly ChildWorkflowLifecycleV1[]>
> = {
  reserved: ["running", "paused", "failed", "cancelled"],
  running: ["waiting_user", "paused", "terminal_recorded", "failed", "cancelled"],
  waiting_user: ["running", "paused", "failed", "cancelled"],
  paused: ["running", "waiting_user", "failed", "cancelled"],
  terminal_recorded: ["consumed"],
  consumed: [],
  failed: ["consumed"],
  cancelled: ["consumed"],
};

export function isLegalChildWorkflowCallTransition(
  from: ChildWorkflowLifecycleV1,
  to: ChildWorkflowLifecycleV1
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

function readExactArtifact(artifacts: ArtifactReader, supplied: ArtifactRef): Buffer {
  const stored = artifacts.refById(supplied.artifact_id);
  if (stored === undefined || canonicalJson(stored) !== canonicalJson(supplied)) {
    throw new Error(`child-workflow artifact '${supplied.artifact_id}' ref differs from custody`);
  }
  const bytes = artifacts.readById(supplied.artifact_id);
  if (
    bytes.byteLength !== supplied.byte_length ||
    sha256(bytes) !== supplied.content_digest ||
    supplied.store_ref !== `artifact://sha256/${supplied.content_digest}`
  ) {
    throw new Error(`child-workflow artifact '${supplied.artifact_id}' bytes differ from its ref`);
  }
  return bytes;
}

/**
 * Verify every immutable artifact operand before any child control-store mutation.
 * Checkpointer calls this itself so public storage APIs cannot bypass artifact-first custody.
 */
export function verifyChildWorkflowCallArtifacts(
  artifacts: ArtifactReader,
  value: unknown
): ChildWorkflowCallRecord {
  const record = encodeChildWorkflowCallRecord(value).record;
  const requestBytes = readExactArtifact(artifacts, record.request_ref);
  const request = validateCanonicalChildWorkflowRequestBytes(requestBytes, record.request_ref);
  if (
    request.child_name !== record.directive.child_name ||
    canonicalJson(request.policy_binding) !== canonicalJson(record.policy_binding)
  ) {
    throw new Error("child-workflow request bytes do not match the durable call operands");
  }
  for (const binding of record.input_artifacts.artifacts) {
    readExactArtifact(artifacts, binding.ref);
  }
  if (record.output_artifact !== null) {
    readExactArtifact(artifacts, record.output_artifact);
  }
  return record;
}

const childWorkflowArtifactCustodyStores = new WeakMap<object, ArtifactStore>();

/**
 * Opaque custody capability minted only from one concrete, project-bound ArtifactStore. Its backing
 * store is held in a module-private WeakMap so a structural lookalike cannot authenticate bytes.
 */
function trustedArtifactStore(value: unknown): ArtifactStore {
  if (value === null || typeof value !== "object") {
    throw new Error("child-workflow custody does not carry a trusted ArtifactStore");
  }
  const artifacts = childWorkflowArtifactCustodyStores.get(value);
  if (artifacts === undefined) {
    throw new Error("child-workflow custody does not carry a trusted ArtifactStore");
  }
  return artifacts;
}

export class ChildWorkflowArtifactCustody {
  private constructor() {}

  static fromArtifactStore(artifacts: ArtifactStore): ChildWorkflowArtifactCustody {
    if (!(artifacts instanceof ArtifactStore)) {
      throw new Error("child-workflow custody requires the concrete ArtifactStore");
    }
    const custody = new ChildWorkflowArtifactCustody();
    childWorkflowArtifactCustodyStores.set(custody, artifacts);
    return custody;
  }

  verify(value: unknown): ChildWorkflowCallRecord {
    return verifyChildWorkflowCallArtifacts(trustedArtifactStore(this), value);
  }

  verifyForProject(projectId: string, value: unknown): ChildWorkflowCallRecord {
    return verifyChildWorkflowArtifactCustody(this, projectId, value);
  }
}

/** Fail closed unless the opaque custody token was minted from one concrete matching store. */
export function verifyChildWorkflowArtifactCustody(
  custody: unknown,
  projectId: string,
  value: unknown
): ChildWorkflowCallRecord {
  const artifacts = trustedArtifactStore(custody);
  artifacts.assertBoundProject(projectId);
  return verifyChildWorkflowCallArtifacts(artifacts, value);
}

export function createReservedChildWorkflowCallRecord(input: {
  readonly directive: ChildWorkflowInvocationDirective;
  readonly parent_visit_sequence: number;
  readonly parent_visit_offset: number;
  readonly parent_registration_sha256: string;
  readonly child_registration_sha256: string;
  readonly timestamp: string;
}): ChildWorkflowCallRecord {
  const directive = validateInitialChildWorkflowDirective(input.directive);
  const callId = childWorkflowCallId({
    parent_run_id: directive.identity.run_id,
    parent_state_id: directive.state_id,
    call_key: directive.call_key,
  });
  return encodeChildWorkflowCallRecord({
    schema_version: directive.schema_version === 3 ? 2 : 1,
    call_id: callId,
    parent_identity: directive.identity,
    parent_state_id: directive.state_id,
    parent_visit_sequence: input.parent_visit_sequence,
    parent_visit_offset: input.parent_visit_offset,
    call_key: directive.call_key,
    child_identity: childWorkflowRunIdentity({
      call_id: callId,
      parent: directive.identity,
      child_name: directive.child_name,
    }),
    directive,
    directive_sha256: childWorkflowDirectiveSha256(directive),
    request_ref: directive.request_ref,
    request_ref_sha256: sha256(canonicalJson(directive.request_ref)),
    input_artifacts: directive.input_artifacts,
    input_refs_sha256: sha256(canonicalJson(directive.input_artifacts)),
    expected_output: directive.expected_output,
    expected_output_sha256: sha256(canonicalJson(directive.expected_output)),
    policy_binding: directive.policy_binding,
    policy_sha256: sha256(canonicalJson(directive.policy_binding)),
    parent_registration_sha256: input.parent_registration_sha256,
    child_registration_sha256: input.child_registration_sha256,
    ...(directive.schema_version === 2
      ? { budget: directive.budget }
      : { progress_lease: directive.progress_lease }),
    lifecycle: "reserved",
    terminal_action: null,
    terminal_sha256: null,
    output_artifact: null,
    usage: null,
    created_at: input.timestamp,
    updated_at: input.timestamp,
  }).record;
}
