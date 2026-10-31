import { Type, type Static } from "typebox";
import { types } from "node:util";
import { ArtifactStore } from "../artifact-store.js";
import { Checkpointer } from "../checkpointer.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, type ArtifactRef, type Directive } from "../contracts.js";
import type { RunContext } from "../context.js";
import { OpaqueIdSchema, assertUnique } from "../skill-contracts/common.js";
import {
  FoundationLimitsV1Schema,
  readSemantic,
  sameRef,
  validateFoundation,
  type FoundationLimitsV1,
} from "./bounds.js";
import {
  GateDecisionV1Schema,
  GatePacketV1Schema,
  VideogenGateIdSchema,
  gateScopeDigest,
  validateGateDecision,
  validateGatePacket,
  type GateBindingHostV1,
} from "./gates.js";
import { CrossRunEdgeV1Schema, CurrentRightsV1Schema, type RightsHostV1 } from "./rights-ledger.js";

const closed = { additionalProperties: false } as const;
const selectionSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: OpaqueIdSchema,
    limits: FoundationLimitsV1Schema,
    admitted_destination_id: OpaqueIdSchema,
    territory: OpaqueIdSchema,
    approvals: Type.Array(
      Type.Object(
        {
          gate_id: VideogenGateIdSchema,
          engine_gate_id: OpaqueIdSchema,
          challenge: OpaqueIdSchema,
          packet_ref: ArtifactRefSchema,
          decision_ref: ArtifactRefSchema,
        },
        closed
      ),
      { maxItems: 5 }
    ),
    presented: Type.Array(
      Type.Object(
        {
          role: OpaqueIdSchema,
          ref: ArtifactRefSchema,
          revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        },
        closed
      )
    ),
    rights: Type.Array(CurrentRightsV1Schema),
    cross_run_edge_refs: Type.Array(ArtifactRefSchema),
  },
  closed
);
type Selection = Static<typeof selectionSchema>;
const KEY = "videogen_owner_selection";

/** Compact checkpoint bookkeeping, not an approval artifact, cache or transferable proof.
 * Call only while constructing an admitted host context; the engine/checkpointer owns its commit. */
export function initializeVideogenOwnerSelection(
  context: RunContext,
  policy: {
    readonly project_id: string;
    readonly limits: FoundationLimitsV1;
    readonly admitted_destination_id: string;
    readonly territory: string;
  }
): void {
  if (context.playbookData[KEY] !== undefined)
    throw new Error("videogen owner already initialized");
  context.playbookData[KEY] = validateFoundation(
    selectionSchema,
    {
      schema_version: 1,
      ...policy,
      approvals: [],
      presented: [],
      rights: [],
      cross_run_edge_refs: [],
    },
    policy.limits
  );
}
function selection(context: RunContext): Selection {
  const value = context.playbookData[KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("videogen owner selections missing");
  const limits = validateFoundation(FoundationLimitsV1Schema, value.limits, {
    schema_id: "penny.videogen-foundation-limits.v1",
    schema_version: 1,
    max_json_bytes: 4096,
    max_text_bytes: 256,
    max_collection_items: 16,
    max_depth: 4,
    max_nodes: 64,
    max_integer: Number.MAX_SAFE_INTEGER,
  });
  return validateFoundation(selectionSchema, value, limits);
}

/** Host selection bookkeeping. Revocation is durable only when the containing context commits.
 * Rights still undergo exact provenance, consent, lifetime and use checks at the effect boundary. */
export function selectVideogenRights(
  context: RunContext,
  rights: Selection["rights"],
  crossRunEdgeRefs: readonly ArtifactRef[] = []
): void {
  const current = selection(context);
  assertUnique(
    rights.map((row) => row.subject_ref.artifact_id),
    "owner rights subjects"
  );
  context.playbookData[KEY] = validateFoundation(
    selectionSchema,
    {
      ...current,
      rights,
      cross_run_edge_refs: [...crossRunEdgeRefs],
    },
    current.limits
  );
  // These are retention dependencies, not grants: current rows still decide rights at use.
  for (const ref of [
    ...rights.flatMap((row) => [row.subject_ref, row.rights_ref]),
    ...crossRunEdgeRefs,
  ])
    if (!context.selectedArtifacts.some((selected) => sameRef(selected, ref)))
      context.selectedArtifacts.push(structuredClone(ref));
}

/** Runs in the engine before its response/checkpoint transaction. The original pending packet,
 * exact selected decision bytes and original engine gate answer are committed together. */
export function recordVideogenGateAnswer(
  context: RunContext,
  pending: Directive,
  response: unknown,
  store: unknown
): void {
  if (context.playbookData[KEY] === undefined) return;
  const current = selection(context);
  if (pending.action !== "await_user" || !(store instanceof ArtifactStore) || types.isProxy(store))
    throw new Error("owner gate custody missing");
  // The same parent can also own ordinary clarification/acknowledgement gates. Initialization
  // is not permission to reinterpret those replies as videogen approval decisions.
  if (
    !context.selectedArtifacts.some(
      (ref) =>
        ref.content_schema?.schema_id === "penny.videogen-gate-packet.v1" &&
        ref.content_digest === pending.payload_digest
    )
  )
    return;
  const decision = validateGateDecision(response, current.limits);
  const packet = validateGatePacket(
    readSemantic({
      store,
      project_id: current.project_id,
      ref: decision.packet_ref,
      schema: GatePacketV1Schema,
      schema_id: "penny.videogen-gate-packet.v1",
      limits: current.limits,
    }),
    current.limits
  );
  const selected = (ref: ArtifactRef) => context.selectedArtifacts.some((x) => sameRef(x, ref));
  const decisionRefs = context.selectedArtifacts.filter(
    (ref) =>
      ref.content_schema?.schema_id === "penny.videogen-gate-decision.v1" &&
      ref.content_digest === sha256(canonicalJson(decision))
  );
  const decisionRef = decisionRefs[0];
  if (
    decisionRef === undefined ||
    decisionRefs.length !== 1 ||
    decisionRef.run_id !== context.identity.run_id ||
    decision.run_id !== context.identity.run_id ||
    packet.run_id !== decision.run_id ||
    packet.gate_id !== decision.gate_id ||
    packet.challenge !== pending.challenge ||
    decision.challenge !== pending.challenge ||
    pending.payload_digest !== decision.packet_ref.content_digest ||
    !selected(decision.packet_ref) ||
    packet.presented.some((item) => !selected(item.ref))
  )
    throw new Error("owner gate answer mismatch");
  readSemantic({
    store,
    project_id: current.project_id,
    ref: decisionRef,
    schema: GateDecisionV1Schema,
    schema_id: "penny.videogen-gate-decision.v1",
    limits: current.limits,
  });
  if (
    decision.choice === "approve" &&
    decision.resulting_scope_digest !== gateScopeDigest(packet, decision.packet_ref)
  )
    throw new Error("owner gate scope mismatch");
  const order = ["G1", "G2", "G3", "G4", "G5"];
  const prior =
    packet.kind === "approval"
      ? current.approvals.filter((x) => order.indexOf(x.gate_id) < order.indexOf(packet.gate_id))
      : current.approvals;
  context.playbookData[KEY] = validateFoundation(
    selectionSchema,
    {
      ...current,
      approvals:
        decision.choice === "approve" && packet.kind === "approval"
          ? [
              ...prior,
              {
                gate_id: packet.gate_id,
                engine_gate_id: pending.gate_id,
                challenge: pending.challenge,
                packet_ref: decision.packet_ref,
                decision_ref: decisionRef,
              },
            ]
          : prior,
      presented: [
        ...current.presented.filter(
          (item) =>
            selected(item.ref) && !packet.presented.some((next) => sameRef(next.ref, item.ref))
        ),
        ...packet.presented,
      ],
    },
    current.limits
  );
}

const bindings = new WeakMap<
  object,
  {
    readonly store: ArtifactStore;
    readonly checkpointer: Checkpointer;
    readonly project_id: string;
    readonly run_id: string;
  }
>();
/** Concrete owner binding only. No constructor operand contains approvals, rights or intent indexes.
 * Like the concrete engine/store owners, trusted in-process code is not an isolation boundary. */
export class VideogenOwnerSelection {
  constructor(input: {
    readonly store: ArtifactStore;
    readonly checkpointer: Checkpointer;
    readonly project_id: string;
    readonly run_id: string;
  }) {
    if (
      new.target !== VideogenOwnerSelection ||
      types.isProxy(input.store) ||
      types.isProxy(input.checkpointer) ||
      Object.getPrototypeOf(input.store) !== ArtifactStore.prototype ||
      Object.getPrototypeOf(input.checkpointer) !== Checkpointer.prototype
    )
      throw new Error("concrete videogen project owners required");
    ArtifactStore.prototype.assertBoundProject.call(input.store, input.project_id);
    Checkpointer.prototype.assertBoundProject.call(input.checkpointer, input.project_id);
    bindings.set(this, Object.freeze({ ...input }));
    readVideogenOwnerSelection(this);
    Object.freeze(this);
  }
}
Object.freeze(VideogenOwnerSelection.prototype);
Object.freeze(VideogenOwnerSelection);

/** Always reloads the actual checkpoint. Returned projections cannot be re-imported as authority. */
export function readVideogenOwnerSelection(owner: unknown): {
  readonly gate: GateBindingHostV1;
  readonly rights: RightsHostV1;
  readonly approved_intent_refs: readonly ArtifactRef[];
} {
  const bound = typeof owner === "object" && owner !== null ? bindings.get(owner) : undefined;
  if (bound === undefined || Object.getPrototypeOf(owner) !== VideogenOwnerSelection.prototype)
    throw new Error("concrete videogen owner selection required");
  const { store, checkpointer, project_id, run_id } = bound;
  ArtifactStore.prototype.assertBoundProject.call(store, project_id);
  Checkpointer.prototype.assertBoundProject.call(checkpointer, project_id);
  const context = Checkpointer.prototype.loadRunById.call(checkpointer, run_id);
  if (context === null || context === undefined) throw new Error("owner run missing");
  const current = selection(context);
  if (current.project_id !== project_id) throw new Error("owner project changed");
  const selected = (ref: ArtifactRef) => context.selectedArtifacts.some((x) => sameRef(x, ref));
  const active =
    context.terminalDirective === null &&
    !["complete", "incomplete", "error", "cancelled"].includes(context.status);
  return {
    gate: {
      store,
      checkpointer,
      project_id,
      run_id,
      limits: current.limits,
      admitted_destination_id: current.admitted_destination_id,
      current_approvals: current.approvals.filter(
        (x) => active && selected(x.packet_ref) && selected(x.decision_ref)
      ),
      current_presented: current.presented.filter((x) => selected(x.ref)),
    },
    rights: {
      store,
      project_id,
      run_id,
      limits: current.limits,
      territory: current.territory,
      now_utc: new Date().toISOString(),
      current_rights: current.rights,
      cross_run_edges: current.cross_run_edge_refs.map((ref) =>
        readSemantic({
          store,
          project_id,
          ref,
          schema: CrossRunEdgeV1Schema,
          schema_id: "penny.videogen-cross-run-edge.v1",
          limits: current.limits,
        })
      ),
    },
    approved_intent_refs: context.selectedArtifacts.filter(
      (ref) => ref.content_schema?.schema_id === "penny.videogen-asset-intent.v1"
    ),
  };
}
