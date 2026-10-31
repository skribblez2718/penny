import { StaticVideogenProfileRegistry } from "./profile-registry.js";
import { Type, type Static } from "typebox";
import {
  OpaqueIdSchema,
  Sha256Schema,
  assertUnique,
  validateSkillSchema,
} from "../skill-contracts/common.js";
import { HostOperationCapacityAuthority } from "../host-operations/capacity-authority.js";
import {
  capacityJson,
  hostCapacityWorkerKey,
  validateCapacityRequest,
  type HostCapacityDemandV1,
  type HostCapacityRecordV1,
  type HostCapacityRequestV1,
} from "../host-operations/capacity-contracts.js";

export const VideogenCapacitySelectionV1Schema = Type.Object(
  {
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    operation_kind: OpaqueIdSchema,
    capacity_binding_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type VideogenCapacitySelectionV1 = Static<typeof VideogenCapacitySelectionV1Schema>;
const Selections = Type.Array(VideogenCapacitySelectionV1Schema, { minItems: 1, maxItems: 256 });

/** Host-selected profile/capacity mapping. With an explicit profile registry, require its
 * actual-worker key to match the existing immutable capacity worker binding. The generic
 * capacity core still verifies exact journal custody, demand, current fence and settlement;
 * this mapping grants no effects and is not physical-topology qualification. */
export class VideogenCapacitySchedulerBinding {
  private readonly selections: VideogenCapacitySelectionV1[];
  constructor(
    private readonly capacity: HostOperationCapacityAuthority,
    selections: unknown,
    private readonly profiles?: StaticVideogenProfileRegistry
  ) {
    if (!(capacity instanceof HostOperationCapacityAuthority))
      throw new Error("videogen capacity owner absent");
    if (profiles !== undefined && !(profiles instanceof StaticVideogenProfileRegistry))
      throw new Error("videogen capacity profile registry invalid");
    capacityJson(selections);
    this.selections = structuredClone(
      validateSkillSchema(Selections, selections, "VideogenCapacitySelectionsV1")
    );
    assertUnique(
      this.selections.map((x) => `${x.profile_id}\u0000${x.operation_kind}`),
      "videogen capacity selections"
    );
    for (const selection of this.selections) {
      if (
        capacity.binding(selection.capacity_binding_id).operation_kind !== selection.operation_kind
      )
        throw new Error("videogen capacity operation binding conflict");
      this.verifyWorker(selection);
    }
  }
  private verifyWorker(selection: VideogenCapacitySelectionV1): void {
    if (this.profiles === undefined) return;
    const resolved = this.profiles.resolve(selection.profile_id);
    const binding = this.capacity.binding(selection.capacity_binding_id);
    if (
      resolved.approved_profile_sha256 !== selection.profile_sha256 ||
      resolved.backend_key_sha256 !== hostCapacityWorkerKey(binding.worker_id)
    )
      throw new Error("videogen capacity actual worker/profile binding conflict");
  }
  requestFor(input: {
    readonly profile_id: string;
    readonly profile_sha256: string;
    readonly operation_kind: string;
    readonly project_id: string;
    readonly operation_record_id: string;
    readonly demands: readonly HostCapacityDemandV1[];
  }): HostCapacityRequestV1 {
    const selected = this.selections.find(
      (x) => x.profile_id === input.profile_id && x.operation_kind === input.operation_kind
    );
    if (selected === undefined || selected.profile_sha256 !== input.profile_sha256)
      throw new Error("videogen opt-in capacity selection absent or stale");
    this.verifyWorker(selected);
    return validateCapacityRequest({
      schema_id: "penny.host-capacity-request.v1",
      schema_version: 1,
      operation_record_id: input.operation_record_id,
      project_id: input.project_id,
      binding_id: selected.capacity_binding_id,
      demands: structuredClone(input.demands),
    });
  }
  reserve(
    input: Parameters<VideogenCapacitySchedulerBinding["requestFor"]>[0]
  ): HostCapacityRecordV1 {
    return this.capacity.reserve(this.requestFor(input));
  }
}
