import { Type } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import {
  HostCapacityPolicyV1Schema,
  validateCapacityPolicy,
  type HostCapacityPolicyV1,
} from "./capacity-contracts.js";
import { Sha256Schema } from "../skill-contracts/common.js";
/** Explicit policy selection in the existing singleton. Each old policy is retained unchanged.
 * Ordinary construction never creates this envelope. Older binaries must refuse it. */
export const CapacityPolicyVersionsSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.host-capacity-policy-versions.v2"),
    schema_version: Type.Literal(2),
    active_sha256: Sha256Schema,
    policies: Type.Array(HostCapacityPolicyV1Schema, { minItems: 2, maxItems: 16 }),
  },
  { additionalProperties: false }
);
export function capacityPolicyVersions(value: unknown): {
  active: HostCapacityPolicyV1;
  policies: HostCapacityPolicyV1[];
} {
  if (
    typeof value === "object" &&
    value !== null &&
    "schema_id" in value &&
    value.schema_id === "penny.host-capacity-policy-versions.v2"
  ) {
    const v = validateContract(CapacityPolicyVersionsSchema, value, "capacity policy versions");
    const policies = v.policies.map(validateCapacityPolicy),
      matches = policies.filter((p) => sha256(canonicalJson(p)) === v.active_sha256);
    if (matches.length !== 1 || new Set(policies.map((p) => p.policy_id)).size !== policies.length)
      throw new Error("capacity version selection conflict");
    const active = matches[0];
    if (!active) throw new Error("capacity active version missing");
    return { active, policies };
  }
  const policy = validateCapacityPolicy(value);
  return { active: policy, policies: [policy] };
}
