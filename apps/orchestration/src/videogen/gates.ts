import { Type, type Static } from "typebox";
import type { Checkpointer } from "../checkpointer.js";
import type { ArtifactStore } from "../artifact-store.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { OpaqueIdSchema as Id, Sha256Schema, assertUnique } from "../skill-contracts/common.js";
import {
  exactRef,
  readExact,
  readSemantic,
  sameRef,
  validateFoundation,
  type FoundationLimitsV1,
} from "./bounds.js";
import {
  MeterSchema,
  VideogenEffectKindSchema,
  AssetIntentV1Schema,
  validateAssetIntent,
} from "./foundation-contracts.js";
const closed = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const texts = Type.Array(text);
const refs = Type.Array(ArtifactRefSchema, { uniqueItems: true });
// Semantic gate refinements use only trusted host-produced earliest producers, never worker targets.
const GATE_PRODUCERS = {
  G1: ["story_plan", "script_text", "g1"],
  G2: ["asset_prepare"],
  G3: ["animatic_plan"],
  G4: ["rough_build", "shot_prepare", "story_plan", "script_text"],
  G5: ["finish_prepare", "final_prepare", "story_plan", "script_text", "admit"],
} as const;
export const VideogenGateIdSchema = Type.Union([
  Type.Literal("G1"),
  Type.Literal("G2"),
  Type.Literal("G3"),
  Type.Literal("G4"),
  Type.Literal("G5"),
]);
export type VideogenGateId = Static<typeof VideogenGateIdSchema>;
const common = {
  schema_id: Type.Literal("penny.videogen-gate-packet.v1"),
  schema_version: Type.Literal(1),
  run_id: Id,
  challenge: Id,
  producer_state: Id,
  presented: Type.Array(
    Type.Object(
      {
        role: Id,
        ref: ArtifactRefSchema,
        revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      },
      closed
    ),
    { minItems: 1 }
  ),
  prior_decisions: refs,
  change_summary: text,
  affected_shot_ids: Type.Array(Id, { uniqueItems: true }),
  limitations: texts,
  rights_refs: refs,
  review_evidence_refs: refs,
  questions: texts,
};
export const GatePacketV1Schema = Type.Union([
  Type.Object(
    {
      ...common,
      kind: Type.Literal("approval"),
      gate_id: VideogenGateIdSchema,
      effect_scope: Type.Object(
        {
          kinds: Type.Array(VideogenEffectKindSchema, { uniqueItems: true }),
          subject_ids: Type.Array(Id, { uniqueItems: true }),
          meters: Type.Array(
            Type.Object(
              {
                meter: MeterSchema,
                limit: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
              },
              closed
            ),
            { maxItems: 7 }
          ),
          destination_id: Type.Optional(Id),
        },
        closed
      ),
      choices: Type.Tuple([Type.Literal("approve"), Type.Literal("refine"), Type.Literal("deny")]),
    },
    closed
  ),
  Type.Object(
    {
      ...common,
      kind: Type.Literal("clarification"),
      gate_id: Type.Literal("clarify"),
      choices: Type.Tuple([Type.Literal("answer"), Type.Literal("cancel")]),
    },
    closed
  ),
]);
export type GatePacketV1 = Static<typeof GatePacketV1Schema>;
const decisionCommon = {
  schema_id: Type.Literal("penny.videogen-gate-decision.v1"),
  schema_version: Type.Literal(1),
  packet_ref: ArtifactRefSchema,
  run_id: Id,
  gate_id: Type.Union([VideogenGateIdSchema, Type.Literal("clarify")]),
  challenge: Id,
};
export const GateDecisionV1Schema = Type.Union([
  Type.Object(
    { ...decisionCommon, choice: Type.Literal("approve"), resulting_scope_digest: Sha256Schema },
    closed
  ),
  Type.Object(
    {
      ...decisionCommon,
      choice: Type.Union([Type.Literal("refine"), Type.Literal("answer")]),
      refinement_text: Type.Optional(text),
    },
    closed
  ),
  Type.Object(
    { ...decisionCommon, choice: Type.Union([Type.Literal("deny"), Type.Literal("cancel")]) },
    closed
  ),
]);
export type GateDecisionV1 = Static<typeof GateDecisionV1Schema>;
export function validateGatePacket(value: unknown, limits: FoundationLimitsV1): GatePacketV1 {
  const packet = validateFoundation(GatePacketV1Schema, value, limits);
  assertUnique(
    packet.presented.map((x) => x.ref.artifact_id),
    "presented refs"
  );
  for (const presented of packet.presented) exactRef(presented.ref);
  if (packet.kind === "clarification") {
    if (packet.questions.length === 0) throw new Error("clarification requires questions");
    return packet;
  }
  assertUnique(
    packet.effect_scope.meters.map((x) => x.meter),
    "gate meters"
  );
  if (!GATE_PRODUCERS[packet.gate_id].some((state) => state === packet.producer_state))
    throw new Error("invalid earliest gate producer");
  const scope = packet.effect_scope;
  if (
    (packet.gate_id === "G2" || packet.gate_id === "G5") &&
    (scope.kinds.length !== 0 || scope.subject_ids.length !== 0 || scope.meters.length !== 0)
  )
    throw new Error("version-only gate cannot authorize effects");
  if (
    packet.gate_id === "G1" &&
    (scope.kinds.length === 0 ||
      scope.kinds.some(
        (x) => x !== "voice_job" && x !== "child_imagegen" && x !== "media_decode_extract"
      ))
  )
    throw new Error("G1 is preview authority only");
  if (
    packet.gate_id === "G3" &&
    (scope.kinds.length === 0 ||
      scope.kinds.some(
        (x) =>
          !["reference_upload", "video_render", "media_decode_extract", "timeline_master"].includes(
            x
          )
      ))
  )
    throw new Error("G3 is draft authority only");
  if (
    packet.gate_id === "G4" &&
    (scope.kinds.length === 0 ||
      scope.kinds.some(
        (x) =>
          ![
            "reference_upload",
            "video_render",
            "media_decode_extract",
            "timeline_master",
            "kdenlive_build_verify",
          ].includes(x)
      ))
  )
    throw new Error("G4 is final authority only");
  if (
    ["G1", "G3", "G4"].includes(packet.gate_id) &&
    (scope.subject_ids.length === 0 ||
      scope.meters.length === 0 ||
      scope.meters.every((x) => x.limit === 0))
  )
    throw new Error("bounded campaign required");
  if (scope.destination_id !== undefined && packet.gate_id !== "G5")
    throw new Error("destination is acceptance-only");
  return packet;
}
export function validateGateDecision(value: unknown, limits: FoundationLimitsV1): GateDecisionV1 {
  const decision = validateFoundation(GateDecisionV1Schema, value, limits);
  if (
    (decision.gate_id === "clarify") !==
    (decision.choice === "answer" || decision.choice === "cancel")
  ) {
    throw new Error("decision kind/gate mismatch");
  }
  return decision;
}
export function gateScopeDigest(packet: GatePacketV1, packetRef: ArtifactRef): string {
  return sha256(
    canonicalJson({
      packet_ref: packetRef,
      presented: packet.presented,
      effect_scope: packet.kind === "approval" ? packet.effect_scope : null,
    })
  );
}
/** Owner-selected bindings, never packet/response fields or an approval boolean. */
export interface CurrentGateApprovalV1 {
  readonly gate_id: VideogenGateId;
  readonly engine_gate_id: string;
  readonly challenge: string;
  readonly packet_ref: ArtifactRef;
  readonly decision_ref: ArtifactRef;
}
const GATE_ORDER: readonly VideogenGateId[] = ["G1", "G2", "G3", "G4", "G5"];
function earlierGates(gate: VideogenGateId): readonly VideogenGateId[] {
  return GATE_ORDER.slice(0, GATE_ORDER.indexOf(gate));
}
export interface GateBindingHostV1 {
  readonly store: ArtifactStore;
  readonly checkpointer: Checkpointer;
  /** Derived from current OWNER selections, not caller-supplied predecessor refs. */
  readonly current_approvals: readonly CurrentGateApprovalV1[];
  readonly project_id: string;
  readonly run_id: string;
  readonly limits: FoundationLimitsV1;
  readonly admitted_destination_id: string;
  /** Current owner-selected index. Absence is not current, and a same digest/new revision is stale. */
  readonly current_presented: readonly {
    readonly role: string;
    readonly ref: ArtifactRef;
    readonly revision: number;
  }[];
}
function checkCurrentPacket(host: GateBindingHostV1, packetValue: unknown): GatePacketV1 {
  const packet = validateGatePacket(packetValue, host.limits);
  if (packet.run_id !== host.run_id) throw new Error("wrong gate run");
  assertUnique(
    host.current_presented.map((x) => x.ref.artifact_id),
    "current gate index"
  );
  for (const item of packet.presented) {
    const selected = host.current_presented.find(
      (x) => x.role === item.role && sameRef(x.ref, item.ref) && x.revision === item.revision
    );
    if (selected === undefined) throw new Error("stale presented ref/revision");
    readExact(host.store, host.project_id, item.ref, host.limits.max_integer);
  }
  for (const ref of [...packet.rights_refs, ...packet.review_evidence_refs])
    readExact(host.store, host.project_id, ref, host.limits.max_json_bytes);
  if (packet.kind === "approval") {
    const requiredRole = {
      G1: "story",
      G2: "look-voice",
      G3: "animatic",
      G4: "rough-cut",
      G5: "master",
    }[packet.gate_id];
    if (
      !packet.presented.some((x) => x.role === requiredRole) ||
      (packet.gate_id === "G5" && !packet.presented.some((x) => x.role === "package"))
    )
      throw new Error("gate presentation coverage");
    if (
      packet.gate_id === "G5" &&
      packet.effect_scope.destination_id !== host.admitted_destination_id
    )
      throw new Error("unchanged admitted local destination required");
    if (packet.gate_id === "G1") {
      const stories = packet.presented.filter((x) => x.role === "story");
      const story = stories[0];
      if (stories.length !== 1 || story === undefined || story.ref.run_id !== host.run_id)
        throw new Error("G1 requires exactly one current same-run story");
      const intents = packet.presented
        .filter((x) => x.role === "asset-intent")
        .map((x) =>
          validateAssetIntent(
            readSemantic({
              store: host.store,
              project_id: host.project_id,
              ref: x.ref,
              schema: AssetIntentV1Schema,
              schema_id: "penny.videogen-asset-intent.v1",
              limits: host.limits,
            }),
            host.limits
          )
        );
      if (
        intents.length !== packet.effect_scope.subject_ids.length ||
        intents.some(
          (x) =>
            x.scope_status !== "proposed" ||
            !sameRef(x.story_ref, story.ref) ||
            !packet.effect_scope.subject_ids.includes(x.asset_id)
        )
      )
        throw new Error("G1 preview intent coverage");
      assertUnique(
        intents.map((x) => x.asset_id),
        "preview intent IDs"
      );
      if (
        packet.effect_scope.kinds.includes("media_decode_extract") &&
        !intents.some(
          (intent) =>
            (intent.source === "supplied" || intent.source === "voice_studio") &&
            (intent.purpose === "performance" || intent.purpose === "voice_preview")
        )
      )
        throw new Error("G1 media preparation requires an audio preview intent");
      for (const intent of intents) {
        const kind =
          intent.source === "voice_studio"
            ? "voice_job"
            : intent.source === "supplied"
              ? intent.purpose === "performance" || intent.purpose === "voice_preview"
                ? "media_decode_extract"
                : null
              : "child_imagegen";
        if (kind !== null && !packet.effect_scope.kinds.includes(kind))
          throw new Error("intent effect kind not scoped");
      }
      for (const meter of new Set(intents.flatMap((x) => x.estimated_meters.map((m) => m.meter)))) {
        const total = intents
          .flatMap((x) => x.estimated_meters)
          .filter((x) => x.meter === meter)
          .reduce((n, x) => n + BigInt(x.reserved), 0n);
        const admitted = packet.effect_scope.meters.find((x) => x.meter === meter);
        if (admitted === undefined || total > BigInt(admitted.limit))
          throw new Error("preview meters exceed G1");
      }
    }
  }
  return packet;
}

function checkApprovalIndex(host: GateBindingHostV1): void {
  host.checkpointer.assertBoundProject(host.project_id);
  host.store.assertBoundProject(host.project_id);
  if (host.current_approvals.length > GATE_ORDER.length)
    throw new Error("current approval index exceeds five gates");
  for (const keys of [
    host.current_approvals.map((x) => x.gate_id),
    host.current_approvals.map((x) => x.engine_gate_id),
    host.current_approvals.map((x) => x.decision_ref.artifact_id),
    host.current_approvals.map((x) => x.packet_ref.artifact_id),
  ])
    assertUnique(keys, "current approval index");
}
function selectedApproval(host: GateBindingHostV1, gate: VideogenGateId): CurrentGateApprovalV1 {
  const selected = host.current_approvals.find((x) => x.gate_id === gate);
  if (selected === undefined) throw new Error("missing current " + gate + " approval");
  return selected;
}
function checkPriorRefs(host: GateBindingHostV1, packet: GatePacketV1): readonly VideogenGateId[] {
  // Clarification may retain an exact current prefix, but cannot occupy any approval slot.
  const required =
    packet.kind === "approval"
      ? earlierGates(packet.gate_id)
      : GATE_ORDER.slice(0, packet.prior_decisions.length);
  if (packet.prior_decisions.length !== required.length)
    throw new Error("exact earlier approval coverage required");
  for (const [index, gate] of required.entries()) {
    const ref = packet.prior_decisions[index];
    if (ref === undefined || !sameRef(ref, selectedApproval(host, gate).decision_ref))
      throw new Error("prior decisions differ from current owner approvals");
  }
  return required;
}
function readCurrentApproval(host: GateBindingHostV1, gate: VideogenGateId) {
  const selected = selectedApproval(host, gate);
  const decision = validateGateDecision(
    readSemantic({
      store: host.store,
      project_id: host.project_id,
      ref: selected.decision_ref,
      schema: GateDecisionV1Schema,
      schema_id: "penny.videogen-gate-decision.v1",
      limits: host.limits,
    }),
    host.limits
  );
  if (
    selected.decision_ref.run_id !== host.run_id ||
    selected.packet_ref.run_id !== host.run_id ||
    decision.run_id !== host.run_id ||
    decision.gate_id !== gate ||
    decision.choice !== "approve" ||
    decision.challenge !== selected.challenge ||
    !sameRef(decision.packet_ref, selected.packet_ref)
  )
    throw new Error("current approval decision identity/choice mismatch");
  const packet = checkCurrentPacket(
    host,
    readSemantic({
      store: host.store,
      project_id: host.project_id,
      ref: selected.packet_ref,
      schema: GatePacketV1Schema,
      schema_id: "penny.videogen-gate-packet.v1",
      limits: host.limits,
    })
  );
  if (
    packet.kind !== "approval" ||
    packet.gate_id !== gate ||
    packet.challenge !== selected.challenge ||
    decision.resulting_scope_digest !== gateScopeDigest(packet, selected.packet_ref)
  )
    throw new Error("current approval packet/scope mismatch");
  checkPriorRefs(host, packet);
  const committed = host.checkpointer.gateResponseBinding(host.run_id, selected.engine_gate_id);
  if (
    committed?.status !== "answered" ||
    committed.challenge !== selected.challenge ||
    committed.response_digest !== sha256(canonicalJson(decision))
  )
    throw new Error("approval not committed by engine at original run/gate/challenge");
  return { packet, decision };
}
export function checkGatePacket(host: GateBindingHostV1, packetValue: unknown): GatePacketV1 {
  checkApprovalIndex(host);
  const packet = checkCurrentPacket(host, packetValue);
  // Fixed increasing order: at most four predecessors; no recursive graph traversal or cycles.
  for (const gate of checkPriorRefs(host, packet)) readCurrentApproval(host, gate);
  return packet;
}
/** Read current exact committed approval and its earlier closure. Authenticates no caller. */
export function checkGateApproval(host: GateBindingHostV1, gate: VideogenGateId, ref: ArtifactRef) {
  checkApprovalIndex(host);
  if (!sameRef(ref, selectedApproval(host, gate).decision_ref))
    throw new Error("approval ref differs from current owner index");
  for (const prior of earlierGates(gate)) readCurrentApproval(host, prior);
  return readCurrentApproval(host, gate);
}

export type GateResponseOutcomeV1 =
  | {
      readonly action: "approved";
      readonly decision: GateDecisionV1;
      readonly effect_authority: "preview" | "draft" | "final" | "none";
    }
  | {
      readonly action: "refine" | "clarification_answer";
      readonly decision: GateDecisionV1;
      readonly producer_state: string;
      readonly effect_authority: "none";
    }
  | {
      readonly action: "deny" | "cancel";
      readonly decision: GateDecisionV1;
      readonly met: false;
      readonly effect_authority: "none";
    };
/** Classification only, from trusted host resume after engine checks; no caller authentication.
 * Recheck the durable pending operand. The engine alone commits this response and handles duplicates.
 */
export function respondToGate(input: {
  host: GateBindingHostV1;
  packet_ref: ArtifactRef;
  response: unknown;
}): GateResponseOutcomeV1 {
  input.host.checkpointer.assertBoundProject(input.host.project_id);
  const context = input.host.checkpointer.loadRunById(input.host.run_id);
  const pending = context?.pendingDirective;
  if (context?.status !== "awaiting_user" || pending?.action !== "await_user")
    throw new Error("gate replay or absent durable pending gate");
  const binding = input.host.checkpointer.gateResponseBinding(input.host.run_id, pending.gate_id);
  if (
    binding?.status !== "pending" ||
    binding.challenge !== pending.challenge ||
    pending.payload_digest !== input.packet_ref.content_digest ||
    !context.selectedArtifacts.some((ref) => sameRef(ref, input.packet_ref))
  )
    throw new Error("gate replay or wrong durable pending packet");
  const packet = checkGatePacket(
    input.host,
    readSemantic({
      store: input.host.store,
      project_id: input.host.project_id,
      ref: input.packet_ref,
      schema: GatePacketV1Schema,
      schema_id: "penny.videogen-gate-packet.v1",
      limits: input.host.limits,
    })
  );
  if (pending.challenge !== packet.challenge) throw new Error("pending gate challenge mismatch");
  if (input.packet_ref.run_id !== input.host.run_id) throw new Error("packet lineage run mismatch");
  const decision = validateGateDecision(input.response, input.host.limits);
  if (
    !sameRef(decision.packet_ref, input.packet_ref) ||
    decision.run_id !== packet.run_id ||
    decision.gate_id !== packet.gate_id ||
    decision.challenge !== packet.challenge ||
    !packet.choices.some((choice) => choice === decision.choice)
  )
    throw new Error("gate decision identity/choice mismatch");
  if (decision.choice === "approve") {
    if (decision.resulting_scope_digest !== gateScopeDigest(packet, input.packet_ref))
      throw new Error("gate scope digest mismatch");
    return {
      action: "approved",
      decision,
      effect_authority:
        packet.gate_id === "G1"
          ? "preview"
          : packet.gate_id === "G3"
            ? "draft"
            : packet.gate_id === "G4"
              ? "final"
              : "none",
    };
  }
  if (decision.choice === "refine" || decision.choice === "answer")
    return {
      action: decision.choice === "refine" ? "refine" : "clarification_answer",
      decision,
      producer_state: packet.producer_state,
      effect_authority: "none",
    };
  return { action: decision.choice, decision, met: false, effect_authority: "none" };
}
/** Host constructs a decision from the trusted human transport; this helper authenticates nobody. */
export function constructGateDecision(
  packet: GatePacketV1,
  packetRef: ArtifactRef,
  choice: GateDecisionV1["choice"],
  limits: FoundationLimitsV1,
  refinementText?: string
): GateDecisionV1 {
  validateGatePacket(packet, limits);
  exactRef(packetRef);
  if (!packet.choices.some((x) => x === choice)) throw new Error("choice not offered");
  return validateGateDecision(
    {
      schema_id: "penny.videogen-gate-decision.v1",
      schema_version: 1,
      packet_ref: packetRef,
      run_id: packet.run_id,
      gate_id: packet.gate_id,
      challenge: packet.challenge,
      choice,
      ...(choice === "approve"
        ? { resulting_scope_digest: gateScopeDigest(packet, packetRef) }
        : {}),
      ...((choice === "refine" || choice === "answer") && refinementText !== undefined
        ? { refinement_text: refinementText }
        : {}),
    },
    limits
  );
}
