import type { LocalApiOperationMeter } from "../host-operations/local-api-meter.js";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { verifyHostEffectBinding } from "../host-operations/effect-protocol.js";
import { BudgetReservationV1Schema, validateBudgetReservation } from "./foundation-contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  type ArtifactRef,
  type HostOperationArtifactContractV1,
} from "../contracts.js";
import type { PersistArtifactInput } from "../artifact-store.js";
import { Sha256Schema, OpaqueIdSchema as Id } from "../skill-contracts/common.js";
import type { HostOperationAdapterV1 } from "../host-operations/contracts.js";
import { isCanonicalHostOperationExecutionContextV1 } from "../host-operations/owner.js";
import { currentAdapterHost, assertAdapterOwnerBinding } from "./native-owner-authority.js";
import type { VideogenOwnerSelection } from "./owner-selection.js";
import type { HostOperationUseValidatorV1 } from "../host-operations/owner.js";
import { checkGateApproval, type GateBindingHostV1 } from "./gates.js";
import { readExact, readSemantic, sameRef, validateFoundation } from "./bounds.js";
import { PortableManifestV1Schema } from "./edit-contracts.js";
import { inspectPortablePackage, type PortableHostV1 } from "./portable-package.js";
import { LocalDeliveryFiles, type DeliveryFile } from "./delivery-files.js";
const closed = { additionalProperties: false } as const;
export const DeliveryIntentV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-delivery-intent.v1"),
    schema_version: Type.Literal(1),
    destination_id: Id,
    g5_decision_ref: ArtifactRefSchema,
    master_ref: ArtifactRefSchema,
    manifest_ref: ArtifactRefSchema,
    project_ref: ArtifactRefSchema,
    staging_id: Id,
    exclusive_final_id: Id,
    rights_check_ref: ArtifactRefSchema,
    budget_ref: ArtifactRefSchema,
  },
  closed
);
export type DeliveryIntentV1 = Static<typeof DeliveryIntentV1Schema>;
export const DeliveryOperationRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-delivery-operation-request.v1"),
    schema_version: Type.Literal(1),
    operation_id: Id,
    delivery_intent_ref: ArtifactRefSchema,
  },
  closed
);
export const DELIVERY_REQUEST_CONTRACT = {
  artifact_kind: "videogen-delivery-operation-request",
  schema_id: "penny.videogen-delivery-operation-request.v1",
  schema_version: 1,
  port_name: "videogen-delivery-operation-request",
  schema_version_required: 1,
} satisfies HostOperationArtifactContractV1;
export const DELIVERY_RESULT_CONTRACT = {
  artifact_kind: "videogen-delivery-raw-result",
  schema_id: "penny.videogen-delivery-raw-result.v1",
  schema_version: 1,
  port_name: "videogen-delivery-raw-result",
  schema_version_required: 1,
} satisfies HostOperationArtifactContractV1;
export const RawDeliveryResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-delivery-raw-result.v1"),
    schema_version: Type.Literal(1),
    operation_id: Id,
    destination_id: Id,
    exclusive_stage_id: Id,
    final_namespace_id: Id,
    g5_packet_digest: Sha256Schema,
    master_digest: Sha256Schema,
    project_digest: Sha256Schema,
    manifest_digest: Sha256Schema,
    readback: Type.Array(
      Type.Object(
        {
          relative_path: Type.String({ minLength: 1, maxLength: 512 }),
          sha256: Sha256Schema,
          bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        },
        closed
      ),
      { minItems: 1, maxItems: 65536 }
    ),
    publication: Type.Literal("private_exclusive_namespace_atomic_products_rename"),
    outcome: Type.Literal("succeeded"),
  },
  closed
);
export interface DeliveryHost extends PortableHostV1, GateBindingHostV1 {}
export interface LocalDeliveryBinding {
  readonly owner: VideogenOwnerSelection;
  /** Pure package/edit data only; authority fields are ignored and rederived. */
  readonly host: PortableHostV1;
  readonly files: LocalDeliveryFiles;
  readonly operation_meter?: LocalApiOperationMeter;
  readonly adapter_id: string;
  readonly backend_binding_id: string;
  readonly backend_key_sha256: string;
}
/** Recheck exact frozen payload/current rights and committed G1-G5 before every local effect.
 * This does not promote structural native bytes to qualified evidence: the accepted G5 packet
 * must also bind externally produced review/evidence. Completion still verifies those journals. */
function deliveryOperands(
  b: LocalDeliveryBinding,
  intent: DeliveryIntentV1
): { files: DeliveryFile[]; packet_digest: string } {
  const current = currentAdapterHost(b.owner, b.host),
    h = current.host;
  current.requireSelected([
    intent.master_ref,
    intent.project_ref,
    intent.manifest_ref,
    intent.budget_ref,
    intent.rights_check_ref,
  ]);
  if (!sameRef(current.ledger_ref, intent.rights_check_ref))
    throw new Error("delivery selected ledger drift");
  if (intent.destination_id !== h.admitted_destination_id)
    throw new Error("delivery destination changed");
  const approved = checkGateApproval(h, "G5", intent.g5_decision_ref);
  if (approved.packet.kind !== "approval") throw new Error("delivery approval packet required");
  const manifest = readSemantic({
    ...h,
    ref: intent.manifest_ref,
    schema: PortableManifestV1Schema,
    schema_id: "penny.videogen-portable-package.v1",
  });
  const closure = inspectPortablePackage(h, manifest);
  if (closure.manifest_sha256 !== intent.manifest_ref.content_digest)
    throw new Error("frozen manifest digest drift");
  for (const [ref, descriptor, role] of [
    [intent.master_ref, manifest.accepted_master, "master"],
    [intent.project_ref, manifest.native_project, "project"],
  ] as const)
    if (
      !manifest.files.some(
        (f) =>
          f.role === role &&
          sameRef(f.producer_ref, ref) &&
          f.relative_path === descriptor.relative_path &&
          f.sha256 === descriptor.sha256 &&
          f.bytes === descriptor.bytes
      )
    )
      throw new Error("accepted product binding drift");
  // Owner presents the exact frozen payloads in addition to its full review records. No worker
  // summary or caller boolean can stand in for a product address accepted by the durable gate.
  for (const ref of [intent.master_ref, intent.project_ref, intent.manifest_ref])
    if (!approved.packet.presented.some((p) => sameRef(p.ref, ref)))
      throw new Error("G5 must bind exact master/project/frozen manifest");
  if (!sameRef(intent.rights_check_ref, manifest.rights_ledger_ref))
    throw new Error("delivery current rights closure mismatch");
  const budget = validateBudgetReservation(
    readSemantic({
      ...h,
      ref: intent.budget_ref,
      schema: BudgetReservationV1Schema,
      schema_id: "penny.videogen-budget-reservation.v1",
    }),
    h.limits
  );
  if (
    budget.operation_kind !== "local_delivery" ||
    budget.subject_id !== intent.destination_id ||
    Date.parse(budget.created_at_utc) > Date.parse(h.now_utc) ||
    budget.state !== "held" ||
    !sameRef(budget.scope_gate_ref, intent.g5_decision_ref) ||
    Date.parse(budget.expires_at_utc) <= Date.parse(h.now_utc)
  )
    throw new Error("current held delivery reservation required");
  const files: DeliveryFile[] = manifest.files.map((f) => ({
    relative_path: `package/${f.relative_path}`,
    sha256: f.sha256,
    bytes: readExact(h.store, h.project_id, f.producer_ref, h.package_policy.max_file_bytes),
  }));
  files.push({
    relative_path: "package/manifest.json",
    sha256: intent.manifest_ref.content_digest,
    bytes: closure.canonical_bytes,
  });
  files.push({
    relative_path: "master.mp4",
    sha256: intent.master_ref.content_digest,
    bytes: readExact(h.store, h.project_id, intent.master_ref, h.package_policy.max_file_bytes),
  });
  for (const ref of Object.values(budget.policy_refs))
    readExact(h.store, h.project_id, ref, h.limits.max_json_bytes);
  const held = budget.meters.find((m) => m.meter === "stored_bytes");
  if (
    held === undefined ||
    BigInt(held.reserved - held.consumed) < files.reduce((n, f) => n + BigInt(f.bytes.length), 0n)
  )
    throw new Error("delivery byte hold insufficient");
  if (files.length > h.limits.max_collection_items)
    throw new Error("delivery result readback array bound");
  current.assertUnchanged();
  return { files, packet_digest: approved.decision.packet_ref.content_digest };
}
export function prepareLocalDelivery(input: {
  readonly binding: LocalDeliveryBinding;
  readonly intent: Omit<
    DeliveryIntentV1,
    "schema_id" | "schema_version" | "staging_id" | "exclusive_final_id"
  >;
  readonly metadata: PersistArtifactInput["metadata"];
  readonly signal: AbortSignal;
}): { intent: DeliveryIntentV1; intent_ref: ArtifactRef } {
  const b = input.binding;
  const { host: h, assertUnchanged } = currentAdapterHost(b.owner, b.host);
  const intent = validateFoundation(
    DeliveryIntentV1Schema,
    {
      ...input.intent,
      schema_id: "penny.videogen-delivery-intent.v1",
      schema_version: 1,
      staging_id: `stage-${randomUUID()}`,
      exclusive_final_id: `delivery-${randomUUID()}`,
    },
    h.limits
  );
  if (
    input.metadata.run_id !== h.run_id ||
    input.metadata.producer !== "host:videogen-delivery" ||
    input.metadata.content_schema?.schema_id !== intent.schema_id ||
    input.metadata.media_type !== "application/json"
  )
    throw new Error("host delivery intent identity required");
  input.signal.throwIfAborted();
  deliveryOperands(b, intent);
  assertUnchanged();
  const intent_ref = h.store.persist({
    metadata: input.metadata,
    content: canonicalJson(intent),
  });
  const readback = readSemantic({
    ...h,
    ref: intent_ref,
    schema: DeliveryIntentV1Schema,
    schema_id: intent.schema_id,
  });
  if (canonicalJson(readback) !== canonicalJson(intent))
    throw new Error("delivery intent readback mismatch");
  return { intent, intent_ref };
}
export function createLocalDeliveryAdapter(
  binding: LocalDeliveryBinding
): HostOperationAdapterV1 & HostOperationUseValidatorV1 {
  const b = Object.freeze({
    ...binding,
    host: {
      ...binding.host,
      edit_policy: structuredClone(binding.host.edit_policy),
      package_policy: structuredClone(binding.host.package_policy),
    },
  });
  assertAdapterOwnerBinding(b.owner, b.host);
  if (!(b.files instanceof LocalDeliveryFiles)) throw new Error("concrete delivery store required");
  const parse = (bytes: Uint8Array) => {
    const text = Buffer.from(bytes).toString("utf8"),
      value: unknown = JSON.parse(text);
    const request = validateFoundation(
      DeliveryOperationRequestSchema,
      value,
      currentAdapterHost(b.owner, b.host).host.limits
    );
    if (canonicalJson(request) !== text) throw new Error("noncanonical delivery request");
    return request;
  };
  const inspect: HostOperationAdapterV1["inspectRequest"] = (input) => {
    const current = currentAdapterHost(b.owner, b.host),
      h = current.host;
    const r = parse(input.request_bytes),
      d = input.directive;
    const intent = readSemantic({
      ...h,
      ref: r.delivery_intent_ref,
      schema: DeliveryIntentV1Schema,
      schema_id: "penny.videogen-delivery-intent.v1",
    });
    if (r.delivery_intent_ref.run_id !== h.run_id)
      throw new Error("delivery intent parent mismatch");
    const effect = verifyHostEffectBinding(h.store, h.project_id, d);
    if (
      effect === undefined ||
      !sameRef(effect.gate_decision_ref, intent.g5_decision_ref) ||
      !sameRef(effect.budget_reservation_ref, intent.budget_ref) ||
      !d.effect_identity ||
      !sameRef(d.effect_identity.predecessor_ref, intent.manifest_ref)
    )
      throw new Error("delivery exact current owner effect binding required");
    deliveryOperands(b, intent);
    current.assertUnchanged();
    if (
      d.operation_id !== r.operation_id ||
      d.operation_kind !== "local_delivery" ||
      d.identity.run_id !== h.run_id ||
      canonicalJson(d.expected_result) !== canonicalJson(DELIVERY_RESULT_CONTRACT) ||
      canonicalJson(input.declaration.request) !== canonicalJson(DELIVERY_REQUEST_CONTRACT) ||
      canonicalJson(d.input_artifacts.artifacts) !==
        canonicalJson([{ slot: "delivery-intent", ref: r.delivery_intent_ref }])
    )
      throw new Error("delivery directive/request identity");
    return {
      schema_version: 1,
      operation_kind: "local_delivery",
      adapter_id: b.adapter_id,
      backend_binding_id: b.backend_binding_id,
      backend_key_sha256: b.backend_key_sha256,
    };
  };
  return {
    adapter_id: b.adapter_id,
    inspectRequest: inspect,
    validateUse(input) {
      input.signal.throwIfAborted();
      inspect({ ...input, input_artifacts: input.directive.input_artifacts });
    },
    async run(context) {
      if (!isCanonicalHostOperationExecutionContextV1(context))
        throw new Error("canonical delivery owner context required");
      inspect({
        directive: context.directive,
        declaration: context.declaration,
        request_bytes: context.request_bytes,
        input_artifacts: context.directive.input_artifacts,
      });
      const value: unknown = JSON.parse(
        Buffer.from(context.readInput("delivery-intent").bytes).toString("utf8")
      );
      const intent = validateFoundation(
        DeliveryIntentV1Schema,
        value,
        currentAdapterHost(b.owner, b.host).host.limits
      );
      const effect = verifyHostEffectBinding(b.host.store, b.host.project_id, context.directive);
      if (
        effect === undefined ||
        !sameRef(effect.gate_decision_ref, intent.g5_decision_ref) ||
        !sameRef(effect.budget_reservation_ref, intent.budget_ref)
      )
        throw new Error("delivery requires exact request/intent/current-G5 reservation pair");
      const operands = deliveryOperands(b, intent);
      const current = currentAdapterHost(b.owner, b.host);
      const correlation = canonicalJson({
        stage: intent.staging_id,
        final: intent.exclusive_final_id,
        destination: intent.destination_id,
        manifest: intent.manifest_ref.content_digest,
      });
      let readback;
      if (context.journal.lifecycle === "lease_acquired") {
        b.files.prepareForIntent(
          intent.destination_id,
          intent.staging_id,
          operands.files,
          context.signal
        );
        current.assertUnchanged();
        deliveryOperands(b, intent);
        context.beginSubmission();
        context.recordRemoteAccepted(correlation);
        // Deliberate journal-before-publish ordering. Any interruption after this point can only
        // adopt exact published bytes read-only; it cannot attempt a second publication.
        current.assertUnchanged();
        deliveryOperands(b, intent);
        readback = b.files.apply(
          intent.destination_id,
          intent.staging_id,
          intent.exclusive_final_id,
          operands.files,
          context.signal
        );
      } else if (
        context.journal.remote_correlation_id === correlation &&
        ["submitted", "fetched"].includes(context.journal.lifecycle)
      ) {
        readback = b.files.readback(
          intent.destination_id,
          intent.exclusive_final_id,
          operands.files
        );
      } else throw new Error("delivery ambiguous/missing journal linkage");
      current.assertUnchanged();
      deliveryOperands(b, intent);
      b.operation_meter?.recordOwnedFiles(readback);
      context.reportActivity("delivery_fsync_readback", readback.length);
      const content = canonicalJson(
        validateFoundation(
          RawDeliveryResultV1Schema,
          {
            schema_id: "penny.videogen-delivery-raw-result.v1",
            schema_version: 1,
            operation_id: context.directive.operation_id,
            destination_id: intent.destination_id,
            exclusive_stage_id: intent.staging_id,
            final_namespace_id: intent.exclusive_final_id,
            g5_packet_digest: operands.packet_digest,
            master_digest: intent.master_ref.content_digest,
            project_digest: intent.project_ref.content_digest,
            manifest_digest: intent.manifest_ref.content_digest,
            readback,
            publication: "private_exclusive_namespace_atomic_products_rename",
            outcome: "succeeded",
          },
          b.host.limits
        )
      );
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(content),
        byte_length: Buffer.byteLength(content),
        item_count: readback.length,
        poll_count: 0,
      });
      const disposition = {
        outcome: "completed",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
        retryable: false,
        reason_code: null,
      } as const;
      return {
        disposition,
        ...context.persist({
          disposition,
          operation_result: {
            contract: DELIVERY_RESULT_CONTRACT,
            media_type: "application/json",
            content,
          },
        }),
      };
    },
  };
}
