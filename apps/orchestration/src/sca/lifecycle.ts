import { canonicalJson } from "../canonical-json.js";
import {
  ScaDomainValidationError,
  compareRfc3339Utc,
  validateClaimRecord,
  validateFindingRecord,
  validateTaskRecord,
  type ClaimRecordV1,
  type ClaimStatus,
  type FindingRecordV1,
  type FindingStatus,
  type TaskRecordV1,
  type TaskStatus,
} from "./contracts.js";

export const TASK_TRANSITIONS = Object.freeze({
  pending: Object.freeze([
    "active",
    "failed",
    "blocked",
    "unsupported",
    "unavailable",
    "rejected",
    "cancelled",
  ]),
  active: Object.freeze([
    "completed",
    "failed",
    "blocked",
    "unsupported",
    "unavailable",
    "rejected",
    "cancelled",
  ]),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  blocked: Object.freeze([]),
  unsupported: Object.freeze([]),
  unavailable: Object.freeze([]),
  rejected: Object.freeze([]),
  cancelled: Object.freeze([]),
} satisfies Readonly<Record<TaskStatus, readonly TaskStatus[]>>);

export const CLAIM_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["asserted", "rejected"]),
  asserted: Object.freeze(["accepted", "rejected"]),
  accepted: Object.freeze([]),
  rejected: Object.freeze([]),
} satisfies Readonly<Record<ClaimStatus, readonly ClaimStatus[]>>);

export const FINDING_TRANSITIONS = Object.freeze({
  candidate: Object.freeze(["investigating"]),
  investigating: Object.freeze([
    "confirmed",
    "rejected_with_evidence",
    "inconclusive",
    "deferred",
    "duplicate",
    "out_of_scope",
  ]),
  confirmed: Object.freeze([]),
  rejected_with_evidence: Object.freeze([]),
  inconclusive: Object.freeze([]),
  deferred: Object.freeze([]),
  duplicate: Object.freeze([]),
  out_of_scope: Object.freeze([]),
} satisfies Readonly<Record<FindingStatus, readonly FindingStatus[]>>);

function fail(label: string, issue: string): never {
  throw new ScaDomainValidationError(label, [issue]);
}

function assertSame(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) fail(label, "immutable fields changed");
}

function assertAppendOnly(
  previous: readonly string[],
  next: readonly string[],
  label: string
): void {
  if (next.length < previous.length || previous.some((value, index) => next[index] !== value)) {
    fail(label, "reference list must be append-only and retain its original order");
  }
}

function assertMonotonicEnvelope(
  previous: { readonly version: number; readonly sequence: number; readonly updated_at: string },
  next: { readonly version: number; readonly sequence: number; readonly updated_at: string },
  label: string
): void {
  if (next.version !== previous.version + 1) {
    fail(label, "version must increase by exactly one");
  }
  if (next.sequence <= previous.sequence) {
    fail(label, "sequence must increase");
  }
  if (compareRfc3339Utc(next.updated_at, previous.updated_at) <= 0) {
    fail(label, "updated_at must increase strictly");
  }
}

function assertAllowedTransition<State extends string>(
  previous: State,
  next: State,
  table: Readonly<Record<State, readonly State[]>>,
  label: string
): void {
  if (!table[previous].includes(next)) {
    const terminal = table[previous].length === 0 ? " terminal" : "";
    fail(label, `illegal transition from${terminal} '${previous}' to '${next}'`);
  }
}

export function transitionTaskRecord(previousValue: unknown, nextValue: unknown): TaskRecordV1 {
  const previous = validateTaskRecord(previousValue);
  const next = validateTaskRecord(nextValue);
  assertSame(
    {
      schema_id: previous.schema_id,
      schema_version: previous.schema_version,
      tenant_id: previous.tenant_id,
      project_id: previous.project_id,
      run_id: previous.run_id,
      phase_id: previous.phase_id,
      task_id: previous.task_id,
      obligation_id: previous.obligation_id,
      task_type: previous.task_type,
      task_type_version: previous.task_type_version,
      obligation_class: previous.obligation_class,
      title: previous.title,
      created_at: previous.created_at,
    },
    {
      schema_id: next.schema_id,
      schema_version: next.schema_version,
      tenant_id: next.tenant_id,
      project_id: next.project_id,
      run_id: next.run_id,
      phase_id: next.phase_id,
      task_id: next.task_id,
      obligation_id: next.obligation_id,
      task_type: next.task_type,
      task_type_version: next.task_type_version,
      obligation_class: next.obligation_class,
      title: next.title,
      created_at: next.created_at,
    },
    "SCA task transition"
  );
  assertMonotonicEnvelope(previous, next, "SCA task transition");
  assertAllowedTransition(previous.status, next.status, TASK_TRANSITIONS, "SCA task transition");
  if (previous.decision_id !== null) fail("SCA task transition", "terminal task cannot mutate");
  return next;
}

export function transitionClaimRecord(previousValue: unknown, nextValue: unknown): ClaimRecordV1 {
  const previous = validateClaimRecord(previousValue);
  const next = validateClaimRecord(nextValue);
  assertSame(
    {
      schema_id: previous.schema_id,
      schema_version: previous.schema_version,
      tenant_id: previous.tenant_id,
      project_id: previous.project_id,
      run_id: previous.run_id,
      phase_id: previous.phase_id,
      claim_id: previous.claim_id,
      task_id: previous.task_id,
      claim_class: previous.claim_class,
      subject_class: previous.subject_class,
      statement: previous.statement,
      confidence: previous.confidence,
      inference_disclosure: previous.inference_disclosure,
      created_at: previous.created_at,
    },
    {
      schema_id: next.schema_id,
      schema_version: next.schema_version,
      tenant_id: next.tenant_id,
      project_id: next.project_id,
      run_id: next.run_id,
      phase_id: next.phase_id,
      claim_id: next.claim_id,
      task_id: next.task_id,
      claim_class: next.claim_class,
      subject_class: next.subject_class,
      statement: next.statement,
      confidence: next.confidence,
      inference_disclosure: next.inference_disclosure,
      created_at: next.created_at,
    },
    "SCA claim transition"
  );
  assertAppendOnly(previous.evidence_ids, next.evidence_ids, "SCA claim transition evidence_ids");
  assertMonotonicEnvelope(previous, next, "SCA claim transition");
  assertAllowedTransition(previous.status, next.status, CLAIM_TRANSITIONS, "SCA claim transition");
  if (previous.decision_id !== null) fail("SCA claim transition", "terminal claim cannot mutate");
  return next;
}

export function transitionFindingRecord(
  previousValue: unknown,
  nextValue: unknown
): FindingRecordV1 {
  const previous = validateFindingRecord(previousValue);
  const next = validateFindingRecord(nextValue);
  assertSame(
    {
      schema_id: previous.schema_id,
      schema_version: previous.schema_version,
      tenant_id: previous.tenant_id,
      project_id: previous.project_id,
      run_id: previous.run_id,
      phase_id: previous.phase_id,
      finding_id: previous.finding_id,
      task_id: previous.task_id,
      finding_type: previous.finding_type,
      finding_type_version: previous.finding_type_version,
      title: previous.title,
      severity: previous.severity,
      confidence: previous.confidence,
      created_at: previous.created_at,
    },
    {
      schema_id: next.schema_id,
      schema_version: next.schema_version,
      tenant_id: next.tenant_id,
      project_id: next.project_id,
      run_id: next.run_id,
      phase_id: next.phase_id,
      finding_id: next.finding_id,
      task_id: next.task_id,
      finding_type: next.finding_type,
      finding_type_version: next.finding_type_version,
      title: next.title,
      severity: next.severity,
      confidence: next.confidence,
      created_at: next.created_at,
    },
    "SCA finding transition"
  );
  assertAppendOnly(previous.claim_ids, next.claim_ids, "SCA finding transition claim_ids");
  assertAppendOnly(previous.evidence_ids, next.evidence_ids, "SCA finding transition evidence_ids");
  if (
    previous.status === "candidate" &&
    previous.claim_ids.length === next.claim_ids.length &&
    previous.evidence_ids.length === next.evidence_ids.length
  ) {
    fail(
      "SCA finding transition",
      "candidate investigation must append discriminating claim or evidence"
    );
  }
  if (previous.status === "investigating") {
    assertSame(previous.investigation, next.investigation, "SCA finding investigation");
  }
  assertMonotonicEnvelope(previous, next, "SCA finding transition");
  assertAllowedTransition(
    previous.status,
    next.status,
    FINDING_TRANSITIONS,
    "SCA finding transition"
  );
  if (previous.decision_id !== null)
    fail("SCA finding transition", "terminal finding cannot mutate");
  return next;
}
