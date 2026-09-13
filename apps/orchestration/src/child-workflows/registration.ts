import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import {
  ArtifactRefSchema,
  ChildWorkflowOutputContractV1Schema,
  ChildWorkflowProgressLeaseBindingV1Schema,
} from "../contracts.js";
import {
  OpaqueIdSchema,
  SchemaIdSchema,
  Sha256Schema,
  assertOpaqueId,
  assertUnique,
  validateSkillSchema,
} from "../skill-contracts/common.js";
import {
  ChildWorkflowPolicyV1Schema,
  ChildWorkflowPolicyV2Schema,
  ChildWorkflowTargetPolicyV1Schema,
  validateChildWorkflowPolicy,
  validateChildWorkflowPolicyV2,
  type ChildWorkflowPolicyV1,
  type ChildWorkflowRequestV1,
} from "./contracts.js";

const MAX_PROVIDER_PORTS = 16;
const MAX_PROVIDER_PHASES = 64;
const MAX_PROVIDER_CONSEQUENCES = 16;
const MAX_PROVIDER_GATES = 16;

const ChildProviderAvailabilityV1Schema = Type.Union([
  Type.Literal("candidate"),
  Type.Literal("qualification_running"),
  Type.Literal("qualified_non_discoverable"),
  Type.Literal("promoted"),
  Type.Literal("withdrawn"),
]);
export type ChildProviderAvailabilityV1 = Static<typeof ChildProviderAvailabilityV1Schema>;

const ChildProviderPortV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    name: OpaqueIdSchema,
    schema_id: SchemaIdSchema,
    schema_version_required: Type.Integer({ minimum: 1 }),
    artifact_kind: Type.String({ minLength: 1, maxLength: 128 }),
    required: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type ChildProviderPortV1 = Readonly<Static<typeof ChildProviderPortV1Schema>>;

const ChildProviderPhaseAuthorityV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    state_id: OpaqueIdSchema,
    agent: OpaqueIdSchema,
    tools_sha256: Sha256Schema,
    destination_policy_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ChildProviderPhaseAuthorityV1 = Readonly<
  Static<typeof ChildProviderPhaseAuthorityV1Schema>
>;

/**
 * A non-shipping descriptor freezes compatibility and fixed authority facts without adding them
 * to the active production registry. Gate 1B approves the concrete production projection later.
 */
export const ChildProviderDescriptorV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    provider_name: OpaqueIdSchema,
    ingress: Type.Literal("skill"),
    model_visibility: Type.Literal("model_visible_ordinary"),
    request: Type.Object(
      {
        schema_id: SchemaIdSchema,
        schema_version: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false }
    ),
    input_ports: Type.Array(ChildProviderPortV1Schema, { maxItems: MAX_PROVIDER_PORTS }),
    terminal_output: ChildWorkflowOutputContractV1Schema,
    partial_output: Type.Union([ChildWorkflowOutputContractV1Schema, Type.Null()]),
    phase_authority: Type.Array(ChildProviderPhaseAuthorityV1Schema, {
      minItems: 1,
      maxItems: MAX_PROVIDER_PHASES,
    }),
    consequence_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_PROVIDER_CONSEQUENCES }),
    required_gate_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_PROVIDER_GATES }),
    budget_policy_id: OpaqueIdSchema,
    recovery_policy_id: OpaqueIdSchema,
    availability: ChildProviderAvailabilityV1Schema,
    qualification_manifest: Type.Union([ArtifactRefSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ChildProviderDescriptorV1 = Readonly<Static<typeof ChildProviderDescriptorV1Schema>>;

export const ChildWorkflowCandidateRegistryV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    registry_kind: Type.Literal("non_shipping_candidate"),
    parent_policy: ChildWorkflowPolicyV1Schema,
    providers: Type.Array(ChildProviderDescriptorV1Schema, { maxItems: MAX_PROVIDER_PORTS }),
  },
  { additionalProperties: false }
);
export type ChildWorkflowCandidateRegistryV1 = Readonly<
  Static<typeof ChildWorkflowCandidateRegistryV1Schema>
>;

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertDescriptorIdentity(descriptor: ChildProviderDescriptorV1): void {
  assertOpaqueId(descriptor.provider_name, "ChildProviderDescriptorV1.provider_name");
  assertOpaqueId(descriptor.budget_policy_id, "ChildProviderDescriptorV1.budget_policy_id");
  assertOpaqueId(descriptor.recovery_policy_id, "ChildProviderDescriptorV1.recovery_policy_id");
  assertUnique(
    descriptor.input_ports.map((port) => port.name),
    "ChildProviderDescriptorV1 input port names"
  );
  assertUnique(
    descriptor.phase_authority.map((phase) => phase.state_id),
    "ChildProviderDescriptorV1 phase authority states"
  );
  assertUnique(descriptor.consequence_ids, "ChildProviderDescriptorV1 consequence IDs");
  assertUnique(descriptor.required_gate_ids, "ChildProviderDescriptorV1 required gate IDs");
  for (const port of descriptor.input_ports)
    assertOpaqueId(port.name, "ChildProviderDescriptorV1 port");
  for (const phase of descriptor.phase_authority) {
    assertOpaqueId(phase.state_id, "ChildProviderDescriptorV1 phase state");
    assertOpaqueId(phase.agent, "ChildProviderDescriptorV1 phase agent");
  }
  if (
    descriptor.terminal_output.schema_id === descriptor.request.schema_id &&
    descriptor.terminal_output.schema_version_required === descriptor.request.schema_version
  ) {
    throw new Error(
      "ChildProviderDescriptorV1 terminal output must not reuse its request identity"
    );
  }
  if (descriptor.availability === "candidate" && descriptor.qualification_manifest !== null) {
    throw new Error("ChildProviderDescriptorV1 candidate cannot bind qualification evidence");
  }
  if (
    (descriptor.availability === "qualification_running" ||
      descriptor.availability === "qualified_non_discoverable" ||
      descriptor.availability === "promoted") &&
    descriptor.qualification_manifest === null
  ) {
    throw new Error(
      "ChildProviderDescriptorV1 qualified lifecycle requires exact qualification evidence"
    );
  }
  if (descriptor.availability === "withdrawn" && descriptor.qualification_manifest === null) {
    throw new Error(
      "ChildProviderDescriptorV1 withdrawn lifecycle retains its qualification evidence"
    );
  }
}

export function validateChildProviderDescriptor(value: unknown): ChildProviderDescriptorV1 {
  const descriptor = validateSkillSchema(
    ChildProviderDescriptorV1Schema,
    value,
    "ChildProviderDescriptorV1"
  );
  assertDescriptorIdentity(descriptor);
  return descriptor;
}

/**
 * Lease-bound descriptor for new calls. Provider authority and recovery remain explicit while
 * model/tool/step usage is telemetry rather than a guessed admission ceiling. V1 remains intact
 * for replaying the previous candidate policy bytes.
 */
export const ChildProviderDescriptorV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    provider_name: OpaqueIdSchema,
    ingress: Type.Literal("skill"),
    model_visibility: Type.Literal("model_visible_ordinary"),
    request: Type.Object(
      {
        schema_id: SchemaIdSchema,
        schema_version: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false }
    ),
    input_ports: Type.Array(ChildProviderPortV1Schema, { maxItems: MAX_PROVIDER_PORTS }),
    terminal_output: ChildWorkflowOutputContractV1Schema,
    partial_output: Type.Union([ChildWorkflowOutputContractV1Schema, Type.Null()]),
    phase_authority: Type.Array(ChildProviderPhaseAuthorityV1Schema, {
      minItems: 1,
      maxItems: MAX_PROVIDER_PHASES,
    }),
    consequence_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_PROVIDER_CONSEQUENCES }),
    required_gate_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_PROVIDER_GATES }),
    progress_lease: ChildWorkflowProgressLeaseBindingV1Schema,
    recovery_policy_id: OpaqueIdSchema,
    availability: ChildProviderAvailabilityV1Schema,
    qualification_manifest: Type.Union([ArtifactRefSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ChildProviderDescriptorV2 = Readonly<Static<typeof ChildProviderDescriptorV2Schema>>;

function assertDescriptorV2Identity(descriptor: ChildProviderDescriptorV2): void {
  assertOpaqueId(descriptor.provider_name, "ChildProviderDescriptorV2.provider_name");
  assertOpaqueId(descriptor.recovery_policy_id, "ChildProviderDescriptorV2.recovery_policy_id");
  assertUnique(
    descriptor.input_ports.map((port) => port.name),
    "ChildProviderDescriptorV2 input port names"
  );
  assertUnique(
    descriptor.phase_authority.map((phase) => phase.state_id),
    "ChildProviderDescriptorV2 phase authority states"
  );
  assertUnique(descriptor.consequence_ids, "ChildProviderDescriptorV2 consequence IDs");
  assertUnique(descriptor.required_gate_ids, "ChildProviderDescriptorV2 required gate IDs");
  for (const port of descriptor.input_ports)
    assertOpaqueId(port.name, "ChildProviderDescriptorV2 port");
  for (const phase of descriptor.phase_authority) {
    assertOpaqueId(phase.state_id, "ChildProviderDescriptorV2 phase state");
    assertOpaqueId(phase.agent, "ChildProviderDescriptorV2 phase agent");
  }
  if (
    descriptor.terminal_output.schema_id === descriptor.request.schema_id &&
    descriptor.terminal_output.schema_version_required === descriptor.request.schema_version
  ) {
    throw new Error(
      "ChildProviderDescriptorV2 terminal output must not reuse its request identity"
    );
  }
  if (descriptor.availability === "candidate" && descriptor.qualification_manifest !== null) {
    throw new Error("ChildProviderDescriptorV2 candidate cannot bind qualification evidence");
  }
  if (
    (descriptor.availability === "qualification_running" ||
      descriptor.availability === "qualified_non_discoverable" ||
      descriptor.availability === "promoted") &&
    descriptor.qualification_manifest === null
  ) {
    throw new Error(
      "ChildProviderDescriptorV2 qualified lifecycle requires exact qualification evidence"
    );
  }
  if (descriptor.availability === "withdrawn" && descriptor.qualification_manifest === null) {
    throw new Error(
      "ChildProviderDescriptorV2 withdrawn lifecycle retains its qualification evidence"
    );
  }
}

export function validateChildProviderDescriptorV2(value: unknown): ChildProviderDescriptorV2 {
  const descriptor = validateSkillSchema(
    ChildProviderDescriptorV2Schema,
    value,
    "ChildProviderDescriptorV2"
  );
  assertDescriptorV2Identity(descriptor);
  return descriptor;
}

/** A generic request envelope is compatible only with the provider's exact native request identity. */
export function childRequestMatchesProvider(
  request: ChildWorkflowRequestV1,
  provider: ChildProviderDescriptorV1
): boolean {
  return (
    request.child_name === provider.provider_name &&
    request.provider_request_schema_id === provider.request.schema_id &&
    request.provider_request_schema_version === provider.request.schema_version
  );
}

/** Only a promoted descriptor can become eligible for future production child discovery. */
export function isPromotedChildProvider(descriptor: ChildProviderDescriptorV1): boolean {
  return descriptor.availability === "promoted" && descriptor.qualification_manifest !== null;
}

export function childProviderDescriptorSha256(descriptor: ChildProviderDescriptorV1): string {
  return sha256(canonicalJson(validateChildProviderDescriptor(descriptor)));
}

export function childParentPolicySha256(policy: ChildWorkflowPolicyV1): string {
  return sha256(canonicalJson(validateChildWorkflowPolicy(policy)));
}

/**
 * Validate a disposable candidate registry. It is deliberately non-shipping and rejects promoted
 * providers; promotion belongs to the later approved production-registry cutover.
 */
export function validateChildWorkflowCandidateRegistry(
  value: unknown
): ChildWorkflowCandidateRegistryV1 {
  const candidate = validateSkillSchema(
    ChildWorkflowCandidateRegistryV1Schema,
    value,
    "ChildWorkflowCandidateRegistryV1"
  );
  const policy = validateChildWorkflowPolicy(candidate.parent_policy);
  const providers = candidate.providers.map(validateChildProviderDescriptor);
  assertUnique(
    providers.map((provider) => provider.provider_name),
    "ChildWorkflowCandidateRegistryV1 provider names"
  );
  if (providers.some(isPromotedChildProvider)) {
    throw new Error("ChildWorkflowCandidateRegistryV1 cannot expose a promoted provider");
  }
  for (const target of policy.targets) {
    const provider = providers.find((item) => item.provider_name === target.child_name);
    if (provider === undefined) {
      throw new Error(
        `ChildWorkflowCandidateRegistryV1 target '${target.child_name}' lacks a provider`
      );
    }
    if (!sameCanonical(provider.terminal_output, target.expected_output)) {
      throw new Error(
        `ChildWorkflowCandidateRegistryV1 target '${target.child_name}' does not match its provider output contract`
      );
    }
  }
  return { ...candidate, parent_policy: policy, providers };
}

export function childWorkflowCandidateRegistrySha256(
  candidate: ChildWorkflowCandidateRegistryV1
): string {
  return sha256(canonicalJson(validateChildWorkflowCandidateRegistry(candidate)));
}

/**
 * New policy registry. It is still non-shipping, but refuses the legacy V1 allocation policy so a
 * future caller cannot attach predicted resource limits to a new lease-bound run.
 */
export const ChildWorkflowCandidateRegistryV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    registry_kind: Type.Literal("non_shipping_candidate"),
    parent_policy: ChildWorkflowPolicyV2Schema,
    providers: Type.Array(ChildProviderDescriptorV2Schema, { maxItems: MAX_PROVIDER_PORTS }),
  },
  { additionalProperties: false }
);
export type ChildWorkflowCandidateRegistryV2 = Readonly<
  Static<typeof ChildWorkflowCandidateRegistryV2Schema>
>;

export function validateChildWorkflowCandidateRegistryV2(
  value: unknown
): ChildWorkflowCandidateRegistryV2 {
  const candidate = validateSkillSchema(
    ChildWorkflowCandidateRegistryV2Schema,
    value,
    "ChildWorkflowCandidateRegistryV2"
  );
  const policy = validateChildWorkflowPolicyV2(candidate.parent_policy);
  const providers = candidate.providers.map(validateChildProviderDescriptorV2);
  assertUnique(
    providers.map((provider) => provider.provider_name),
    "ChildWorkflowCandidateRegistryV2 provider names"
  );
  if (providers.some((provider) => provider.availability === "promoted")) {
    throw new Error("ChildWorkflowCandidateRegistryV2 cannot expose a promoted provider");
  }
  for (const target of policy.targets) {
    const provider = providers.find((item) => item.provider_name === target.child_name);
    if (provider === undefined) {
      throw new Error(
        `ChildWorkflowCandidateRegistryV2 target '${target.child_name}' lacks a provider`
      );
    }
    if (!sameCanonical(provider.terminal_output, target.expected_output)) {
      throw new Error(
        `ChildWorkflowCandidateRegistryV2 target '${target.child_name}' does not match its provider output contract`
      );
    }
    if (!sameCanonical(provider.progress_lease, target.progress_lease)) {
      throw new Error(
        `ChildWorkflowCandidateRegistryV2 target '${target.child_name}' has a mismatched progress lease`
      );
    }
  }
  return { ...candidate, parent_policy: policy, providers };
}

export function childWorkflowCandidateRegistryV2Sha256(
  candidate: ChildWorkflowCandidateRegistryV2
): string {
  return sha256(canonicalJson(validateChildWorkflowCandidateRegistryV2(candidate)));
}

/** A pure candidate-registration seam for registry tests; it does not mutate PLAYBOOK_REGISTRY. */
export function candidateTargetMatchesProvider(
  target: Static<typeof ChildWorkflowTargetPolicyV1Schema>,
  provider: ChildProviderDescriptorV1
): boolean {
  return (
    target.child_name === provider.provider_name &&
    sameCanonical(target.expected_output, provider.terminal_output)
  );
}
