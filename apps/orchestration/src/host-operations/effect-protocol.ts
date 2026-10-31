import { VideogenHostOperationKindSchema } from "../videogen/foundation-contracts.js";
import { Type, type Static, type TSchema } from "typebox";
import { ArtifactStore, type ArtifactReader } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  HostEffectLogicalIdentityV1Schema,
  type HostEffectLogicalIdentityV1,
  type ArtifactRef,
  type HostOperationArtifactContractV1,
  type InvokeHostOperationDirectiveV1,
} from "../contracts.js";
import { OpaqueIdSchema as Id, validateSkillSchema } from "../skill-contracts/common.js";
import { MAX_HOST_OPERATION_RECORD_BYTES, type HostOperationCallRecordV1 } from "./contracts.js";

const closed = { additionalProperties: false } as const;
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** Identity deliberately excludes future request/intent digests. Scope and predecessor are exact
 * existing owner-selected refs, so a request change conflicts at the same logical operation. */
export function hostEffectOperationId(value: HostEffectLogicalIdentityV1): string {
  return `effect_${sha256(canonicalJson(validateSkillSchema(HostEffectLogicalIdentityV1Schema, value, "effect identity")))}`;
}
export const HostEffectIntentV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-effect-intent.v1"),
    schema_version: Type.Literal(1),
    kind: VideogenHostOperationKindSchema,
    run_id: Id,
    project_id: Id,
    state_id: Id,
    visit: positive,
    attempt: positive,
    operation_id: Id,
    gate_decision_ref: ArtifactRefSchema,
    request_ref: ArtifactRefSchema,
    input_refs: Type.Array(ArtifactRefSchema, { maxItems: 1024 }),
    profile_snapshot_ref: Type.Optional(ArtifactRefSchema),
    budget_reservation_ref: ArtifactRefSchema,
    expected_output_contract_ref: ArtifactRefSchema,
    idempotency_key: Id,
  },
  closed
);
export type HostEffectIntentV1 = Static<typeof HostEffectIntentV1Schema>;
export const HOST_RECEIPTED_RESULT_CONTRACT = Object.freeze({
  schema_version: 1,
  port_name: "receipted_result",
  artifact_kind: "host-operation-receipted-result",
  schema_id: "penny.host-operation-receipted-result.v1",
  schema_version_required: 1,
} as const satisfies HostOperationArtifactContractV1);
export const HostReceiptedResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.host-operation-receipted-result.v1"),
    schema_version: Type.Literal(1),
    operation_record_id: Id,
    operation_id: Id,
    request_ref: ArtifactRefSchema,
    effect_intent_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    raw_result_ref: ArtifactRefSchema,
    output_refs: Type.Array(ArtifactRefSchema, { maxItems: 1024 }),
    receipt_ref: ArtifactRefSchema,
  },
  closed
);
function exact(store: ArtifactReader, ref: ArtifactRef, maxBytes?: number): Buffer {
  if (maxBytes !== undefined && ref.byte_length > maxBytes)
    throw new Error("effect control artifact byte limit");
  if (canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref))
    throw new Error("effect exact ref mismatch");
  const bytes = store.readById(ref.artifact_id);
  if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
    throw new Error("effect exact bytes mismatch");
  return bytes;
}
function json(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error("effect noncanonical JSON");
  return value;
}
/** Both links must already exist; neither orphan artifacts nor a callback can manufacture one. */
export function verifyHostEffectBinding(
  store: ArtifactReader,
  projectId: string,
  directive: InvokeHostOperationDirectiveV1
): HostEffectIntentV1 | undefined {
  const ref = directive.effect_intent_ref;
  if ((ref === undefined) !== (directive.effect_identity === undefined))
    throw new Error("effect identity/intent pair missing");
  if (ref === undefined) return undefined;
  if (
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== "penny.videogen-effect-intent.v1" ||
    ref.content_schema.schema_version !== 1 ||
    ref.run_id !== directive.identity.run_id ||
    ref.kind !== "videogen-effect-intent" ||
    ref.producer !== "host:host-effect-preparation" ||
    ref.phase !== directive.state_id
  )
    throw new Error("effect intent ref identity mismatch");
  const intent = validateSkillSchema(
    HostEffectIntentV1Schema,
    json(exact(store, ref, MAX_HOST_OPERATION_RECORD_BYTES)),
    "effect intent"
  );
  const identity = validateSkillSchema(
    HostEffectLogicalIdentityV1Schema,
    directive.effect_identity,
    "effect identity"
  );
  const operationId = hostEffectOperationId(identity);
  const request = json(exact(store, directive.request_ref));
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    !("operation_id" in request) ||
    request.operation_id !== operationId ||
    intent.operation_id !== operationId ||
    directive.operation_id !== operationId ||
    intent.idempotency_key !== operationId ||
    ref.operation_id !== `${operationId}:intent` ||
    directive.request_ref.operation_id !== `${operationId}:request` ||
    directive.request_ref.run_id !== identity.run_id ||
    directive.request_ref.phase !== identity.state_id ||
    directive.request_ref.producer !== "host:host-effect-preparation" ||
    identity.project_id !== projectId ||
    intent.project_id !== projectId ||
    identity.run_id !== directive.identity.run_id ||
    intent.run_id !== identity.run_id ||
    identity.state_id !== directive.state_id ||
    intent.state_id !== identity.state_id ||
    identity.attempt !== directive.attempt ||
    intent.attempt !== identity.attempt ||
    intent.visit !== identity.visit ||
    intent.kind !== identity.kind ||
    intent.kind !== directive.operation_kind ||
    canonicalJson(intent.gate_decision_ref) !== canonicalJson(identity.scope_ref) ||
    canonicalJson(intent.request_ref) !== canonicalJson(directive.request_ref) ||
    canonicalJson(intent.input_refs) !==
      canonicalJson(directive.input_artifacts.artifacts.map((x) => x.ref))
  )
    throw new Error("effect request/intent/logical identity mismatch");
  for (const operand of [
    identity.scope_ref,
    identity.predecessor_ref,
    intent.budget_reservation_ref,
    intent.expected_output_contract_ref,
    ...(intent.profile_snapshot_ref === undefined ? [] : [intent.profile_snapshot_ref]),
  ])
    exact(store, operand);
  return intent;
}
/** Persist request first, then exact intent. Interrupted orphan pairs are refused, not completed
 * from a scan. A host may prepare a new explicit attempt after inspecting such a refusal. */
export function prepareHostEffectArtifacts(input: {
  readonly store: ArtifactStore;
  readonly identity: HostEffectLogicalIdentityV1;
  readonly request_contract: HostOperationArtifactContractV1;
  readonly request_schema: TSchema;
  readonly request: Readonly<Record<string, unknown>>;
  readonly input_refs: readonly ArtifactRef[];
  readonly budget_reservation_ref: ArtifactRef;
  readonly expected_output_contract_ref: ArtifactRef;
  readonly profile_snapshot_ref?: ArtifactRef;
}): {
  readonly operation_id: string;
  readonly request_ref: ArtifactRef;
  readonly effect_intent_ref: ArtifactRef;
  readonly effect_identity: HostEffectLogicalIdentityV1;
} {
  const identity = validateSkillSchema(
    HostEffectLogicalIdentityV1Schema,
    input.identity,
    "effect identity"
  );
  input.store.assertBoundProject(identity.project_id);
  validateSkillSchema(VideogenHostOperationKindSchema, identity.kind, "effect kind");
  const operationId = hostEffectOperationId(identity);
  if (
    (input.request.operation_id !== undefined && input.request.operation_id !== operationId) ||
    "effect_intent_ref" in input.request
  )
    throw new Error("effect request contains mismatched or future identity");
  const contract = input.request_contract;
  for (const ref of [
    ...input.input_refs,
    identity.scope_ref,
    identity.predecessor_ref,
    input.budget_reservation_ref,
    input.expected_output_contract_ref,
    ...(input.profile_snapshot_ref === undefined ? [] : [input.profile_snapshot_ref]),
  ])
    exact(input.store, ref);
  const requestBytes = canonicalJson(
    validateSkillSchema(
      input.request_schema,
      { ...input.request, operation_id: operationId },
      "effect request"
    )
  );
  const parsedRequest = json(Buffer.from(requestBytes));
  if (
    parsedRequest === null ||
    typeof parsedRequest !== "object" ||
    !("schema_id" in parsedRequest) ||
    parsedRequest.schema_id !== contract.schema_id ||
    !("schema_version" in parsedRequest) ||
    parsedRequest.schema_version !== contract.schema_version_required
  )
    throw new Error("effect request semantic schema differs from its contract");
  const coordinates = {
    run_id: identity.run_id,
    phase: identity.state_id,
    branch_id: null,
    version: 1,
    schema_version: 2 as const,
    producer: "host:host-effect-preparation",
    media_type: "application/json",
  };
  const existingRequest = input.store.refFor(
    identity.run_id,
    identity.state_id,
    null,
    contract.artifact_kind,
    `${operationId}:request`,
    1
  );
  const existingIntent = input.store.refFor(
    identity.run_id,
    identity.state_id,
    null,
    "videogen-effect-intent",
    `${operationId}:intent`,
    1
  );
  if ((existingRequest === null) !== (existingIntent === null))
    throw new Error("orphan effect request/intent; explicit fresh attempt required");
  const requestRef =
    existingRequest ??
    input.store.persist({
      metadata: {
        ...coordinates,
        kind: contract.artifact_kind,
        operation_id: `${operationId}:request`,
        content_schema: {
          schema_id: contract.schema_id,
          schema_version: contract.schema_version_required,
        },
        parent_ref: null,
        upstream_refs: [
          ...new Map(
            [...input.input_refs, identity.scope_ref, identity.predecessor_ref].map((ref) => [
              canonicalJson(ref),
              ref,
            ])
          ).values(),
        ],
      },
      content: requestBytes,
    });
  if (exact(input.store, requestRef).toString("utf8") !== requestBytes)
    throw new Error("effect request conflict");
  const intent = validateSkillSchema(
    HostEffectIntentV1Schema,
    {
      schema_id: "penny.videogen-effect-intent.v1",
      schema_version: 1,
      kind: identity.kind,
      run_id: identity.run_id,
      project_id: identity.project_id,
      state_id: identity.state_id,
      visit: identity.visit,
      attempt: identity.attempt,
      operation_id: operationId,
      gate_decision_ref: identity.scope_ref,
      request_ref: requestRef,
      input_refs: [...input.input_refs],
      budget_reservation_ref: input.budget_reservation_ref,
      expected_output_contract_ref: input.expected_output_contract_ref,
      ...(input.profile_snapshot_ref === undefined
        ? {}
        : { profile_snapshot_ref: input.profile_snapshot_ref }),
      idempotency_key: operationId,
    },
    "effect intent"
  );
  const content = canonicalJson(intent);
  const intentRef =
    existingIntent ??
    input.store.persist({
      metadata: {
        ...coordinates,
        kind: "videogen-effect-intent",
        operation_id: `${operationId}:intent`,
        content_schema: { schema_id: "penny.videogen-effect-intent.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [requestRef, identity.scope_ref],
      },
      content,
    });
  if (exact(input.store, intentRef).toString("utf8") !== content)
    throw new Error("effect intent conflict");
  return {
    operation_id: operationId,
    request_ref: requestRef,
    effect_intent_ref: intentRef,
    effect_identity: identity,
  };
}
export function hostReceiptedResult(record: HostOperationCallRecordV1) {
  if (record.host_receipt_ref === null || record.operation_result_ref === null)
    throw new Error("wrapper requires prior receipt and raw result");
  return validateSkillSchema(
    HostReceiptedResultV1Schema,
    {
      schema_id: "penny.host-operation-receipted-result.v1",
      schema_version: 1,
      operation_record_id: record.operation_record_id,
      operation_id: record.operation_id,
      request_ref: record.request_ref,
      effect_intent_ref: record.directive.effect_intent_ref ?? null,
      raw_result_ref: record.operation_result_ref,
      output_refs: record.output_artifacts,
      receipt_ref: record.host_receipt_ref,
    },
    "receipted result"
  );
}
export function verifyHostResultWrapper(
  store: ArtifactReader,
  record: HostOperationCallRecordV1
): void {
  if (record.result_wrapper === undefined) return;
  const ref = record.result_wrapper.ref;
  if (
    ref === null ||
    ref.run_id !== record.identity.run_id ||
    ref.phase !== record.state_id ||
    ref.branch_id !== null ||
    ref.operation_id !== record.result_wrapper.plan.operation_id ||
    ref.version !== record.result_wrapper.plan.version ||
    ref.kind !== record.result_wrapper.plan.artifact_kind ||
    ref.media_type !== record.result_wrapper.plan.media_type ||
    ref.content_schema?.schema_id !== record.result_wrapper.plan.schema_id ||
    ref.content_schema.schema_version !== record.result_wrapper.plan.schema_version_required ||
    ref.producer !== `host:${record.policy_binding.adapter_id}` ||
    ref.content_digest !== record.result_wrapper.plan.content_sha256 ||
    ref.byte_length !== record.result_wrapper.plan.byte_length ||
    exact(store, ref, MAX_HOST_OPERATION_RECORD_BYTES).toString("utf8") !==
      canonicalJson(hostReceiptedResult(record))
  )
    throw new Error("host result wrapper differs from exact settled evidence");
}
