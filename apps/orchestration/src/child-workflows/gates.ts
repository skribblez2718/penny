import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ChildWorkflowGateProjectionV2Schema,
  JsonValueSchema,
  validateDirective,
  type Directive,
} from "../contracts.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import type { ChildWorkflowCallRecord } from "./contracts.js";

export const ProjectedChildResponseV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.projected-child-response.v1"),
    schema_version: Type.Literal(1),
    projection: ChildWorkflowGateProjectionV2Schema,
    payload_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    reply: JsonValueSchema,
  },
  { additionalProperties: false }
);
export type ProjectedChildResponseV1 = Static<typeof ProjectedChildResponseV1Schema>;
export type UserGate = Extract<Directive, { action: "await_user" }>;

/** Derived solely from the committed call and exact durable child gate. No new authority. */
export function projectChildGate(record: ChildWorkflowCallRecord, gate: UserGate): UserGate {
  if (
    canonicalJson(gate.identity) !== canonicalJson(record.child_identity) ||
    gate.child_workflow !== undefined
  )
    throw new Error("child gate identity or nesting mismatch");
  const projection = {
    schema_version: 2 as const,
    call_id: record.call_id,
    child_run_id: record.child_identity.run_id,
    child_gate_id: gate.gate_id,
    child_challenge: gate.challenge,
    child_payload_digest: gate.payload_digest,
    parent_registration_sha256: record.parent_registration_sha256,
    child_registration_sha256: record.child_registration_sha256,
    invocation_sha256: record.directive_sha256,
    child_gate_sha256: sha256(canonicalJson(gate)),
  };
  const digest = sha256(canonicalJson(projection));
  const value = validateDirective({
    schema_version: 2,
    action: "await_user",
    identity: record.parent_identity,
    state_id: record.parent_state_id,
    gate_id: `child-gate-${digest.slice(0, 48)}`,
    challenge: `child-challenge-${digest.slice(0, 48)}`,
    payload_digest: digest,
    child_workflow: projection,
    questions: gate.questions,
  });
  if (value.action !== "await_user") throw new Error("invalid child projection");
  return value;
}

export function validateProjectedChildResponse(
  value: unknown,
  gate: UserGate
): ProjectedChildResponseV1 {
  const response = validateSkillSchema(
    ProjectedChildResponseV1Schema,
    value,
    "ProjectedChildResponseV1"
  );
  if (
    gate.child_workflow?.schema_version !== 2 ||
    canonicalJson(response.projection) !== canonicalJson(gate.child_workflow) ||
    response.payload_digest !== gate.payload_digest
  )
    throw new Error("projected child response binding mismatch");
  if (Buffer.byteLength(canonicalJson(response), "utf8") > 131072)
    throw new Error("projected child response exceeds byte limit");
  return response;
}
