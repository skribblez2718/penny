import { Type, type Static } from "typebox";
import { ArtifactRefSchema as Ref, validateContract, type ArtifactRef } from "../contracts.js";
import type { RunContext } from "../context.js";
import { OpaqueIdSchema as Id } from "../skill-contracts/common.js";
const closed = { additionalProperties: false } as const;
export const VideogenExecutionStateV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    config_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    slots: Type.Array(Type.Object({ slot: Id, ref: Ref }, closed), { maxItems: 1024 }),
    shot_ids: Type.Array(Id, { maxItems: 128, uniqueItems: true }),
    shot_index: Type.Integer({ minimum: 0, maximum: 128 }),
    asset_index: Type.Integer({ minimum: 0, maximum: 128 }),
    effect_index: Type.Integer({ minimum: 0, maximum: 1024 }),
    effects: Type.Array(
      Type.Object({ operation_id: Id, state: Id, subject: Id, wrapper_ref: Ref }, closed),
      { maxItems: 1024 }
    ),
    return_state: Type.Optional(Id),
    information_origin: Type.Optional(Id),
    synthesis_origin: Type.Optional(Id),
    synthesis_evidence: Type.Optional(Type.Array(Ref, { minItems: 2, maxItems: 32 })),
    synthesis_keys: Type.Optional(Type.Array(Id, { maxItems: 128, uniqueItems: true })),
    pending_worker_state: Type.Optional(Id),
  },
  closed
);
export type VideogenExecutionStateV1 = Static<typeof VideogenExecutionStateV1Schema>;
export function executionState(c: RunContext): VideogenExecutionStateV1 {
  return validateContract(
    VideogenExecutionStateV1Schema,
    c.playbookData.videogen_execution,
    "videogen execution state"
  );
}
export function saveExecution(c: RunContext, s: VideogenExecutionStateV1): void {
  c.playbookData.videogen_execution = validateContract(
    VideogenExecutionStateV1Schema,
    s,
    "videogen execution state"
  );
}
export function slot(s: VideogenExecutionStateV1, name: string): ArtifactRef {
  const ref = s.slots.find((x) => x.slot === name)?.ref;
  if (ref === undefined) throw new Error(`missing_input: videogen ${name}`);
  return ref;
}
export function setSlot(
  c: RunContext,
  s: VideogenExecutionStateV1,
  name: string,
  ref: ArtifactRef
): void {
  const old = s.slots.find((x) => x.slot === name)?.ref;
  s.slots = s.slots.filter((x) => x.slot !== name);
  s.slots.push({ slot: name, ref });
  if (
    name !== "packet" &&
    old !== undefined &&
    !s.slots.some((x) => x.ref.artifact_id === old.artifact_id)
  )
    c.selectedArtifacts = c.selectedArtifacts.filter((x) => x.artifact_id !== old.artifact_id);
  if (!c.selectedArtifacts.some((x) => x.artifact_id === ref.artifact_id))
    c.selectedArtifacts.push(ref);
  saveExecution(c, s);
}
