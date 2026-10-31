import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract } from "../contracts.js";
import { HostOperationDispositionV1Schema } from "../host-operations/contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  ScaBrokerExecuteRequestV1Schema,
  ScaBrokerReceiptV1Schema,
  scaBrokerExecuteRequestSha256,
  validateScaBrokerExecuteRequestV1,
  validateScaBrokerReceiptV1,
} from "./broker-contracts.js";

export const SCA_P07_EXECUTION_AUTHORITY_SCHEMA = "penny.sca-p07-execution-authority.v1" as const;
export const SCA_P07_EXECUTION_PLAN_SCHEMA = "penny.sca-p07-execution-plan.v1" as const;
export const SCA_P07_ADMISSION_SCHEMA = "penny.sca-p07-admission.v1" as const;
export const SCA_P07_HOST_REQUEST_SCHEMA = "penny.sca-p07-host-request.v1" as const;
export const SCA_P07_HOST_RESULT_SCHEMA = "penny.sca-p07-host-result.v1" as const;
export const SCA_P07_EVIDENCE_LEDGER_SCHEMA = "penny.sca-p07-evidence-ledger.v1" as const;
export const SCA_P07_TO_P08_TRANSITION_SCHEMA = "penny.sca-p07-to-p08-transition.v1" as const;
export const SCA_P07_TERMINAL_SCHEMA = "penny.sca-p07-terminal.v1" as const;

const BindingSchema = Type.Object(
  {
    action_record_ref: ArtifactRefSchema,
    operation: Type.Union([
      Type.Literal("source_query"),
      Type.Literal("graph_query"),
      Type.Literal("application_test"),
    ]),
    broker_request_sha256: Sha256Schema,
    source_snapshot_ref: ArtifactRefSchema,
    config_ref: ArtifactRefSchema,
    input_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
  },
  { additionalProperties: false }
);

/** This separate, host-selected authority is never inferred from a P06 transition. */
export const ScaP07ExecutionAuthorityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P07_EXECUTION_AUTHORITY_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    transition_ref: ArtifactRefSchema,
    bindings: Type.Array(BindingSchema, { minItems: 1, maxItems: 64 }),
    authority_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P07_EXECUTION_AUTHORITY_SCHEMA }
);
export type ScaP07ExecutionAuthorityV1 = Readonly<Static<typeof ScaP07ExecutionAuthorityV1Schema>>;

const PlanItemSchema = Type.Object(
  {
    action_record_ref: ArtifactRefSchema,
    broker_request: ScaBrokerExecuteRequestV1Schema,
    broker_request_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export const ScaP07ExecutionPlanV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P07_EXECUTION_PLAN_SCHEMA),
    schema_version: Type.Literal(1),
    transition_ref: ArtifactRefSchema,
    authority_ref: ArtifactRefSchema,
    items: Type.Array(PlanItemSchema, { minItems: 1, maxItems: 64 }),
    plan_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P07_EXECUTION_PLAN_SCHEMA }
);
export type ScaP07ExecutionPlanV1 = Readonly<Static<typeof ScaP07ExecutionPlanV1Schema>>;

export const ScaP07AdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P07_ADMISSION_SCHEMA),
    schema_version: Type.Literal(1),
    transition_ref: ArtifactRefSchema,
    authority_ref: ArtifactRefSchema,
    plan_ref: ArtifactRefSchema,
    request_hashes: Type.Array(Sha256Schema, { minItems: 1, maxItems: 64 }),
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P07_ADMISSION_SCHEMA }
);
export type ScaP07AdmissionV1 = Readonly<Static<typeof ScaP07AdmissionV1Schema>>;

export const ScaP07HostRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P07_HOST_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    plan_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    item_index: Type.Integer({ minimum: 0, maximum: 63 }),
    action_record_ref: ArtifactRefSchema,
    broker_request: ScaBrokerExecuteRequestV1Schema,
    broker_request_sha256: Sha256Schema,
    request_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P07_HOST_REQUEST_SCHEMA }
);
export type ScaP07HostRequestV1 = Readonly<Static<typeof ScaP07HostRequestV1Schema>>;

export const ScaP07HostResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P07_HOST_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    request_sha256: Sha256Schema,
    plan_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    action_record_ref: ArtifactRefSchema,
    receipt: ScaBrokerReceiptV1Schema,
    result_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P07_HOST_RESULT_SCHEMA }
);
export type ScaP07HostResultV1 = Readonly<Static<typeof ScaP07HostResultV1Schema>>;

export function withP07Digest<T extends Readonly<Record<string, unknown>>, K extends string>(
  body: T,
  field: K
): T & Record<K, string> {
  return { ...body, [field]: sha256(canonicalJson(body)) } as T & Record<K, string>;
}
function selfDigest(value: Readonly<Record<string, unknown>>, field: string): void {
  const { [field]: digest, ...body } = value;
  if (digest !== sha256(canonicalJson(body))) throw new Error(`P07 ${field} mismatch`);
}
function orderedRefs(refs: readonly { readonly artifact_id: string }[]): void {
  for (let i = 1; i < refs.length; i++) {
    const previous = refs[i - 1];
    const current = refs[i];
    if (
      previous === undefined ||
      current === undefined ||
      previous.artifact_id >= current.artifact_id
    )
      throw new Error("P07 refs must be strictly ordered and unique");
  }
}
export function validateScaP07ExecutionAuthorityV1(value: unknown): ScaP07ExecutionAuthorityV1 {
  const parsed = validateContract(
    ScaP07ExecutionAuthorityV1Schema,
    value,
    "P07 execution authority"
  );
  selfDigest(parsed, "authority_sha256");
  orderedRefs(parsed.bindings.map((entry) => entry.action_record_ref));
  for (const entry of parsed.bindings) orderedRefs(entry.input_refs);
  return parsed;
}
export function validateScaP07ExecutionPlanV1(value: unknown): ScaP07ExecutionPlanV1 {
  const parsed = validateContract(ScaP07ExecutionPlanV1Schema, value, "P07 execution plan");
  selfDigest(parsed, "plan_sha256");
  orderedRefs(parsed.items.map((entry) => entry.action_record_ref));
  for (const entry of parsed.items) {
    validateScaBrokerExecuteRequestV1(entry.broker_request);
    if (scaBrokerExecuteRequestSha256(entry.broker_request) !== entry.broker_request_sha256)
      throw new Error("P07 plan broker request hash mismatch");
  }
  return parsed;
}
export function validateScaP07AdmissionV1(value: unknown): ScaP07AdmissionV1 {
  const parsed = validateContract(ScaP07AdmissionV1Schema, value, "P07 admission");
  selfDigest(parsed, "admission_sha256");
  return parsed;
}
export function validateScaP07HostRequestV1(value: unknown): ScaP07HostRequestV1 {
  const parsed = validateContract(ScaP07HostRequestV1Schema, value, "P07 host request");
  selfDigest(parsed, "request_sha256");
  validateScaBrokerExecuteRequestV1(parsed.broker_request);
  if (parsed.broker_request_sha256 !== scaBrokerExecuteRequestSha256(parsed.broker_request))
    throw new Error("P07 host broker request hash mismatch");
  return parsed;
}
const NullableArtifactRefSchema = Type.Union([ArtifactRefSchema, Type.Null()]);
const P07BlockerCodeSchema = Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" });
const P07ActionStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("not_invoked"),
]);

/** One exact plan item's honest outcome. Every admitted action yields exactly one row. */
export const ScaP07ActionOutcomeV1Schema = Type.Object(
  {
    item_index: Type.Integer({ minimum: 0, maximum: 63 }),
    action_record_ref: ArtifactRefSchema,
    operation_id: OpaqueIdSchema,
    host_request_ref: ArtifactRefSchema,
    host_result_ref: NullableArtifactRefSchema,
    platform_result_ref: NullableArtifactRefSchema,
    host_receipt_ref: NullableArtifactRefSchema,
    disposition: Type.Union([HostOperationDispositionV1Schema, Type.Null()]),
    status: P07ActionStatusSchema,
    blocker_codes: Type.Array(P07BlockerCodeSchema, { maxItems: 16 }),
  },
  { additionalProperties: false }
);
export type ScaP07ActionOutcomeV1 = Readonly<Static<typeof ScaP07ActionOutcomeV1Schema>>;

/** Bounded, exhaustive per-action evidence ledger for the candidate P07 execution pass. */
export const ScaP07EvidenceLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P07_EVIDENCE_LEDGER_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal("SCA-P07"),
    run_id: OpaqueIdSchema,
    transition_ref: ArtifactRefSchema,
    authority_ref: ArtifactRefSchema,
    plan_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    rows: Type.Array(ScaP07ActionOutcomeV1Schema, { minItems: 1, maxItems: 64 }),
    action_count: Type.Integer({ minimum: 1, maximum: 64 }),
    completed_action_count: Type.Integer({ minimum: 0, maximum: 64 }),
    blocked_action_count: Type.Integer({ minimum: 0, maximum: 64 }),
    not_invoked_action_count: Type.Integer({ minimum: 0, maximum: 64 }),
    exhaustive_accounting: Type.Literal(true),
    execution_occurred: Type.Boolean(),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    ledger_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P07_EVIDENCE_LEDGER_SCHEMA }
);
export type ScaP07EvidenceLedgerV1 = Readonly<Static<typeof ScaP07EvidenceLedgerV1Schema>>;

/** Non-release successor handoff. It never grants P08 disposition or campaign completion. */
export const ScaP07ToP08TransitionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P07_TO_P08_TRANSITION_SCHEMA),
    schema_version: Type.Literal(1),
    source_phase_id: Type.Literal("SCA-P07"),
    target_phase_id: Type.Literal("SCA-P08"),
    handoff_kind: Type.Literal("candidate_evidence_only"),
    qualification_scope: Type.Literal("evidence_gathering_only_not_p08_disposition"),
    phase_gate_passed: Type.Literal(false),
    p06_transition_ref: ArtifactRefSchema,
    p07_authority_ref: ArtifactRefSchema,
    p07_plan_ref: ArtifactRefSchema,
    p07_admission_ref: ArtifactRefSchema,
    evidence_ledger_ref: ArtifactRefSchema,
    action_count: Type.Integer({ minimum: 1, maximum: 64 }),
    completed_action_result_refs: Type.Array(ArtifactRefSchema, { maxItems: 64 }),
    blocked_action_count: Type.Integer({ minimum: 0, maximum: 64 }),
    not_invoked_action_count: Type.Integer({ minimum: 0, maximum: 64 }),
    evidence_complete: Type.Boolean(),
    p08_disposition_authorized_by_this_transition: Type.Literal(false),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    campaign_completion_claimed: Type.Literal(false),
    transition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P07_TO_P08_TRANSITION_SCHEMA }
);
export type ScaP07ToP08TransitionV1 = Readonly<Static<typeof ScaP07ToP08TransitionV1Schema>>;

/** Terminal accounting for the candidate P07 pass. It is always non-positive at the phase gate. */
export const ScaP07TerminalV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P07_TERMINAL_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal("SCA-P07"),
    status: Type.Union([
      Type.Literal("candidate_complete"),
      Type.Literal("blocked"),
      Type.Literal("cancelled"),
    ]),
    evidence_ledger_ref: ArtifactRefSchema,
    p08_transition_ref: NullableArtifactRefSchema,
    p08_handoff_ready: Type.Boolean(),
    evidence_complete: Type.Boolean(),
    phase_gate_passed: Type.Literal(false),
    execution_occurred: Type.Boolean(),
    action_count: Type.Integer({ minimum: 1, maximum: 64 }),
    completed_action_count: Type.Integer({ minimum: 0, maximum: 64 }),
    blocked_action_count: Type.Integer({ minimum: 0, maximum: 64 }),
    not_invoked_action_count: Type.Integer({ minimum: 0, maximum: 64 }),
    selected_artifact_refs: Type.Array(ArtifactRefSchema, { maxItems: 128 }),
    blocker_codes: Type.Array(P07BlockerCodeSchema, { maxItems: 32 }),
    release_eligible: Type.Literal(false),
    campaign_complete: Type.Literal(false),
    nonterminal_campaign: Type.Literal(true),
    report_or_finding_adjudication_performed: Type.Literal(false),
    terminal_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P07_TERMINAL_SCHEMA }
);
export type ScaP07TerminalV1 = Readonly<Static<typeof ScaP07TerminalV1Schema>>;

function countStatus(
  rows: readonly ScaP07ActionOutcomeV1[],
  status: ScaP07ActionOutcomeV1["status"]
): number {
  return rows.filter((row) => row.status === status).length;
}

function assertLedgerAccounted(ledger: ScaP07EvidenceLedgerV1): void {
  if (ledger.rows.length !== ledger.action_count) throw new Error("P07 ledger row count mismatch");
  for (const [index, row] of ledger.rows.entries()) {
    if (row.item_index !== index) throw new Error("P07 ledger rows must be contiguous and ordered");
    if (row.status === "completed") {
      if (
        row.disposition?.outcome !== "completed" ||
        row.host_result_ref === null ||
        row.blocker_codes.length !== 0
      )
        throw new Error("P07 completed ledger row lacks its exact completed result");
    } else if (row.status === "blocked") {
      // A blocked row may still cite an exact disposition it never reconciled into the parent
      // (for example a host operation that settled but crashed before parent consumption); it must
      // always name the blocker that explains why the action did not complete here.
      if (row.blocker_codes.length === 0)
        throw new Error("P07 blocked ledger row lacks a blocker code");
    } else if (
      row.disposition !== null ||
      row.host_result_ref !== null ||
      row.platform_result_ref !== null ||
      row.host_receipt_ref !== null
    ) {
      throw new Error("P07 not-invoked ledger row cites settled evidence");
    }
  }
  if (
    countStatus(ledger.rows, "completed") !== ledger.completed_action_count ||
    countStatus(ledger.rows, "blocked") !== ledger.blocked_action_count ||
    countStatus(ledger.rows, "not_invoked") !== ledger.not_invoked_action_count ||
    ledger.completed_action_count +
      ledger.blocked_action_count +
      ledger.not_invoked_action_count !==
      ledger.action_count
  )
    throw new Error("P07 ledger action accounting is not exhaustive");
  if (ledger.execution_occurred !== ledger.completed_action_count + ledger.blocked_action_count > 0)
    throw new Error("P07 ledger execution flag disagrees with the settled action count");
}

function assertTransitionAccounted(transition: ScaP07ToP08TransitionV1): void {
  if (
    transition.completed_action_result_refs.length !==
      transition.action_count -
        transition.blocked_action_count -
        transition.not_invoked_action_count ||
    transition.completed_action_result_refs.length > transition.action_count ||
    transition.evidence_complete !==
      (transition.blocked_action_count === 0 && transition.not_invoked_action_count === 0)
  )
    throw new Error("P07 successor handoff accounting is inconsistent");
}

function assertTerminalAccounted(terminal: ScaP07TerminalV1): void {
  if (
    terminal.completed_action_count +
      terminal.blocked_action_count +
      terminal.not_invoked_action_count !==
    terminal.action_count
  )
    throw new Error("P07 terminal action accounting is not exhaustive");
  if (
    terminal.execution_occurred !==
    terminal.completed_action_count + terminal.blocked_action_count > 0
  )
    throw new Error("P07 terminal execution flag disagrees with the settled action count");
  if ((terminal.p08_transition_ref !== null) !== terminal.p08_handoff_ready)
    throw new Error("P07 terminal handoff readiness disagrees with its exact transition ref");
  if (terminal.status === "candidate_complete") {
    if (
      terminal.p08_transition_ref === null ||
      !terminal.evidence_complete ||
      terminal.blocked_action_count !== 0 ||
      terminal.not_invoked_action_count !== 0 ||
      terminal.blocker_codes.length !== 0
    )
      throw new Error("P07 candidate_complete terminal claims incomplete evidence");
  }
  if (terminal.status === "blocked" && terminal.evidence_complete)
    throw new Error("P07 blocked terminal cannot claim complete evidence");
  if (terminal.status === "cancelled" && terminal.p08_transition_ref !== null)
    throw new Error("P07 cancelled terminal cannot hand off a successor transition");
}

export function validateScaP07EvidenceLedgerV1(value: unknown): ScaP07EvidenceLedgerV1 {
  const parsed = validateContract(ScaP07EvidenceLedgerV1Schema, value, "P07 evidence ledger");
  selfDigest(parsed, "ledger_sha256");
  assertLedgerAccounted(parsed);
  return parsed;
}
export function validateScaP07ToP08TransitionV1(value: unknown): ScaP07ToP08TransitionV1 {
  const parsed = validateContract(ScaP07ToP08TransitionV1Schema, value, "P07 successor handoff");
  selfDigest(parsed, "transition_sha256");
  assertTransitionAccounted(parsed);
  return parsed;
}
export function validateScaP07TerminalV1(value: unknown): ScaP07TerminalV1 {
  const parsed = validateContract(ScaP07TerminalV1Schema, value, "P07 terminal");
  selfDigest(parsed, "terminal_sha256");
  assertTerminalAccounted(parsed);
  return parsed;
}

export function validateScaP07HostResultV1(
  value: unknown,
  request: ScaP07HostRequestV1
): ScaP07HostResultV1 {
  const parsed = validateContract(ScaP07HostResultV1Schema, value, "P07 host result");
  selfDigest(parsed, "result_sha256");
  if (
    parsed.request_sha256 !== request.request_sha256 ||
    canonicalJson(parsed.plan_ref) !== canonicalJson(request.plan_ref) ||
    canonicalJson(parsed.admission_ref) !== canonicalJson(request.admission_ref) ||
    canonicalJson(parsed.action_record_ref) !== canonicalJson(request.action_record_ref)
  )
    throw new Error("P07 result request/ref mismatch");
  validateScaBrokerReceiptV1(parsed.receipt, request.broker_request);
  return parsed;
}
