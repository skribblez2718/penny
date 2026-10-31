import { verifyHostEffectBinding } from "./effect-protocol.js";
import { ArtifactStore, type ArtifactReader } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, InvokeHostOperationDirectiveV1 } from "../contracts.js";
import {
  hostOperationDirectiveSha256,
  hostOperationRecordId,
  validateHostOperationCallRecord,
  type HostOperationCallRecordV1,
  type HostOperationLifecycleV1,
} from "./contracts.js";

export interface EncodedHostOperationCallRecordV1 {
  readonly record: HostOperationCallRecordV1;
  readonly record_jcs: string;
  readonly record_sha256: string;
}

export interface StoredHostOperationCallRowV1 {
  readonly operation_record_id: unknown;
  readonly project_id: unknown;
  readonly run_id: unknown;
  readonly state_id: unknown;
  readonly attempt: unknown;
  readonly operation_id: unknown;
  readonly lifecycle: unknown;
  readonly record_jcs: unknown;
  readonly record_sha256: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

function rowText(
  row: StoredHostOperationCallRowV1,
  key: keyof StoredHostOperationCallRowV1
): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`stored host-operation call has an invalid '${key}' column`);
  }
  return value;
}

function rowInteger(
  row: StoredHostOperationCallRowV1,
  key: keyof StoredHostOperationCallRowV1
): number {
  const value = row[key];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new Error(`stored host-operation call has an invalid '${key}' column`);
  }
  return number;
}

export function encodeHostOperationCallRecord(value: unknown): EncodedHostOperationCallRecordV1 {
  const record = validateHostOperationCallRecord(value);
  const recordJcs = canonicalJson(record);
  return {
    record,
    record_jcs: recordJcs,
    record_sha256: sha256(recordJcs),
  };
}

export function decodeHostOperationCallRecord(input: {
  readonly record_jcs: unknown;
  readonly record_sha256: unknown;
}): HostOperationCallRecordV1 {
  if (typeof input.record_jcs !== "string" || typeof input.record_sha256 !== "string") {
    throw new Error("stored host-operation record or digest is not text");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.record_sha256)) {
    throw new Error("stored host-operation record digest is invalid");
  }
  if (sha256(input.record_jcs) !== input.record_sha256) {
    throw new Error("stored host-operation record digest does not match its bytes");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.record_jcs);
  } catch {
    throw new Error("stored host-operation record is not JSON");
  }
  const encoded = encodeHostOperationCallRecord(parsed);
  if (encoded.record_jcs !== input.record_jcs) {
    throw new Error("stored host-operation record is not canonical JSON");
  }
  return encoded.record;
}

export function decodeStoredHostOperationCallRow(
  row: StoredHostOperationCallRowV1
): HostOperationCallRecordV1 {
  const record = decodeHostOperationCallRecord(row);
  const projections: ReadonlyArray<readonly [string, string | number, string | number]> = [
    ["operation_record_id", rowText(row, "operation_record_id"), record.operation_record_id],
    ["project_id", rowText(row, "project_id"), record.project_id],
    ["run_id", rowText(row, "run_id"), record.identity.run_id],
    ["state_id", rowText(row, "state_id"), record.state_id],
    ["attempt", rowInteger(row, "attempt"), record.attempt],
    ["operation_id", rowText(row, "operation_id"), record.operation_id],
    ["lifecycle", rowText(row, "lifecycle"), record.lifecycle],
    ["created_at", rowText(row, "created_at"), record.created_at],
    ["updated_at", rowText(row, "updated_at"), record.updated_at],
  ];
  for (const [field, projected, decoded] of projections) {
    if (projected !== decoded) {
      throw new Error(
        `stored host-operation call '${record.operation_record_id}' ${field} projection diverged`
      );
    }
  }
  return record;
}

export function hostOperationCallImmutableJcs(record: HostOperationCallRecordV1): string {
  return canonicalJson({
    schema_version: record.schema_version,
    operation_record_id: record.operation_record_id,
    project_id: record.project_id,
    identity: record.identity,
    state_id: record.state_id,
    attempt: record.attempt,
    operation_id: record.operation_id,
    operation_kind: record.operation_kind,
    directive: record.directive,
    directive_sha256: record.directive_sha256,
    registration_sha256: record.registration_sha256,
    request_ref: record.request_ref,
    request_sha256: record.request_sha256,
    input_artifacts: record.input_artifacts,
    expected_result: record.expected_result,
    policy_binding: record.policy_binding,
    queue_inactivity_expires_at_ms: record.queue_inactivity_expires_at_ms,
    // Renewable operation inactivity expiry is mutable control state, not call identity.
    started_at: record.started_at,
    created_at: record.created_at,
  });
}

const LEGAL_TRANSITIONS: Readonly<
  Record<HostOperationLifecycleV1, readonly HostOperationLifecycleV1[]>
> = {
  prepared: ["prepared", "lease_acquired", "terminal"],
  lease_acquired: ["lease_acquired", "submitting", "terminal"],
  submitting: ["submitting", "submitted", "fetched", "terminal"],
  submitted: ["submitted", "fetched", "terminal"],
  fetched: ["fetched", "persisting", "terminal"],
  persisting: ["persisting", "persisted", "terminal"],
  persisted: ["persisted", "verified", "terminal"],
  verified: ["verified", "terminal"],
  terminal: ["terminal", "settled"],
  settled: ["settled", "consumed"],
  consumed: ["consumed"],
};

export function isLegalHostOperationCallTransition(
  from: HostOperationLifecycleV1,
  to: HostOperationLifecycleV1
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

function readExactArtifact(artifacts: ArtifactReader, supplied: ArtifactRef): Buffer {
  const stored = artifacts.refById(supplied.artifact_id);
  if (stored === undefined || canonicalJson(stored) !== canonicalJson(supplied)) {
    throw new Error(`host-operation artifact '${supplied.artifact_id}' ref differs from custody`);
  }
  const bytes = artifacts.readById(supplied.artifact_id);
  if (
    bytes.byteLength !== supplied.byte_length ||
    sha256(bytes) !== supplied.content_digest ||
    supplied.store_ref !== `artifact://sha256/${supplied.content_digest}`
  ) {
    throw new Error(`host-operation artifact '${supplied.artifact_id}' bytes differ from its ref`);
  }
  return bytes;
}

export function verifyHostOperationCallArtifacts(
  artifacts: ArtifactReader,
  value: unknown
): HostOperationCallRecordV1 {
  const record = encodeHostOperationCallRecord(value).record;
  verifyHostEffectBinding(artifacts, record.project_id, record.directive);
  readExactArtifact(artifacts, record.request_ref);
  for (const binding of record.input_artifacts.artifacts) readExactArtifact(artifacts, binding.ref);
  if (record.directive.effect_intent_ref !== undefined)
    readExactArtifact(artifacts, record.directive.effect_intent_ref);
  if (record.result_wrapper?.ref !== undefined && record.result_wrapper.ref !== null)
    readExactArtifact(artifacts, record.result_wrapper.ref);
  if (record.operation_result_ref !== null)
    readExactArtifact(artifacts, record.operation_result_ref);
  for (const output of record.output_artifacts) readExactArtifact(artifacts, output);
  if (record.platform_result_ref !== null) readExactArtifact(artifacts, record.platform_result_ref);
  if (record.host_receipt_ref !== null) readExactArtifact(artifacts, record.host_receipt_ref);
  return record;
}

const custodyStores = new WeakMap<object, ArtifactStore>();

function trustedArtifactStore(value: unknown): ArtifactStore {
  if (value === null || typeof value !== "object") {
    throw new Error("host-operation custody does not carry a trusted ArtifactStore");
  }
  const artifacts = custodyStores.get(value);
  if (artifacts === undefined) {
    throw new Error("host-operation custody does not carry a trusted ArtifactStore");
  }
  return artifacts;
}

export class HostOperationArtifactCustody {
  private constructor() {}

  static fromArtifactStore(artifacts: ArtifactStore): HostOperationArtifactCustody {
    if (!(artifacts instanceof ArtifactStore)) {
      throw new Error("host-operation custody requires the concrete ArtifactStore");
    }
    const custody = new HostOperationArtifactCustody();
    custodyStores.set(custody, artifacts);
    return custody;
  }

  verifyForProject(projectId: string, value: unknown): HostOperationCallRecordV1 {
    return verifyHostOperationArtifactCustody(this, projectId, value);
  }
}

export function verifyHostOperationArtifactCustody(
  custody: unknown,
  projectId: string,
  value: unknown
): HostOperationCallRecordV1 {
  const artifacts = trustedArtifactStore(custody);
  artifacts.assertBoundProject(projectId);
  return verifyHostOperationCallArtifacts(artifacts, value);
}

export function createPreparedHostOperationCallRecord(input: {
  readonly project_id: string;
  readonly directive: InvokeHostOperationDirectiveV1;
  readonly queue_inactivity_expires_at_ms: number;
  readonly operation_inactivity_expires_at_ms: number;
  readonly timestamp: string;
}): HostOperationCallRecordV1 {
  const directive = input.directive;
  return encodeHostOperationCallRecord({
    schema_version: 1,
    operation_record_id: hostOperationRecordId({
      project_id: input.project_id,
      run_id: directive.identity.run_id,
      state_id: directive.state_id,
      attempt: directive.attempt,
      operation_id: directive.operation_id,
      registration_sha256: directive.registration_sha256,
      request_sha256: directive.request_sha256,
    }),
    project_id: input.project_id,
    identity: directive.identity,
    state_id: directive.state_id,
    attempt: directive.attempt,
    operation_id: directive.operation_id,
    operation_kind: directive.operation_kind,
    directive,
    directive_sha256: hostOperationDirectiveSha256(directive),
    registration_sha256: directive.registration_sha256,
    request_ref: directive.request_ref,
    request_sha256: directive.request_sha256,
    input_artifacts: directive.input_artifacts,
    expected_result: directive.expected_result,
    policy_binding: directive.policy_binding,
    lifecycle: "prepared",
    lease: null,
    lease_expires_at_ms: null,
    queue_inactivity_expires_at_ms: input.queue_inactivity_expires_at_ms,
    operation_inactivity_expires_at_ms: input.operation_inactivity_expires_at_ms,
    remote_correlation_id: null,
    remote_correlation_sha256: null,
    fetched: null,
    persistence_plan: null,
    operation_result_ref: null,
    output_artifacts: [],
    disposition: null,
    lease_disposition_receipt_id: null,
    platform_result_ref: null,
    host_receipt_ref: null,
    progress_event_count: 0,
    started_at: input.timestamp,
    created_at: input.timestamp,
    updated_at: input.timestamp,
  }).record;
}
