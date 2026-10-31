import type { ArtifactHostStore } from "./artifact-store.js";
import type { ArtifactRef, InputArtifacts } from "./contracts.js";

/** Closed registration-owned provider-opening policies admitted by the shared worker. */
export type ProviderOpeningGuardId =
  | "sca_p04_payload_disclosure_v1"
  | "sca_p05_payload_disclosure_v1"
  | "sca_p06_payload_disclosure_v1"
  | "sca_p08_payload_disclosure_v1"
  | "sca_p10_payload_disclosure_v1"
  | "sca_p11_payload_disclosure_v1";

export type PreDispatchPolicyBlockerCode = "opening_appendix_invalid" | "opening_policy_denied";

/**
 * A deterministic refusal raised before provider dispatch. The runner durably terminalizes it and
 * recovery never rebuilds or replays the denied opening.
 */
export class PreDispatchPolicyDeniedError extends Error {
  constructor(
    readonly blockerCode: PreDispatchPolicyBlockerCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PreDispatchPolicyDeniedError";
  }
}

export interface ProviderOpeningGuardAssignmentV1 {
  readonly registration_name: string;
  readonly run_id: string;
  readonly state_id: string;
  readonly branch_id: string | null;
  readonly agent: string;
  readonly task: string;
  readonly input_artifacts: InputArtifacts;
}

export interface ProviderOpeningAuthorizationV1 {
  readonly serialized_opening_sha256: string;
  readonly serialized_opening_byte_length: number;
  readonly payload_ref: ArtifactRef;
  readonly disclosure_ref: ArtifactRef;
}

export type ProviderOpeningResultRoutingPolicy =
  | "exact_summary_or_phase_json"
  | "exact_summary_only";

/** Phase-specific policy behind one shared, fail-closed worker seam. */
export interface ProviderOpeningGuardAdapter {
  readonly id: ProviderOpeningGuardId;
  /** Registration-owned framing policy for routing fields parsed from persisted provider output. */
  readonly resultRoutingPolicy: ProviderOpeningResultRoutingPolicy;
  matches(registrationName: string, stateId: string, agent: string): boolean;
  buildAppendix(input: {
    readonly store: ArtifactHostStore;
    readonly assignment: ProviderOpeningGuardAssignmentV1;
  }): string;
  authorizeSerializedOpening(input: {
    readonly store: ArtifactHostStore;
    readonly assignment: ProviderOpeningGuardAssignmentV1;
    readonly opening: string;
  }): ProviderOpeningAuthorizationV1;
}

const PROVIDER_OPENING_GUARD_IDS: readonly ProviderOpeningGuardId[] = Object.freeze([
  "sca_p04_payload_disclosure_v1",
  "sca_p05_payload_disclosure_v1",
  "sca_p06_payload_disclosure_v1",
  "sca_p08_payload_disclosure_v1",
  "sca_p10_payload_disclosure_v1",
  "sca_p11_payload_disclosure_v1",
]);

export function isProviderOpeningGuardId(
  value: string | undefined
): value is ProviderOpeningGuardId {
  return PROVIDER_OPENING_GUARD_IDS.some((candidate) => candidate === value);
}

export function resolveProviderOpeningGuard(input: {
  readonly id: string;
  readonly registration_name: string;
  readonly state_id: string;
  readonly agent: string;
  readonly adapters: readonly ProviderOpeningGuardAdapter[];
}): ProviderOpeningGuardAdapter {
  if (!isProviderOpeningGuardId(input.id)) {
    throw new Error(`unknown provider opening guard '${input.id}'`);
  }
  const matches = input.adapters.filter(
    (adapter) =>
      adapter.id === input.id &&
      adapter.matches(input.registration_name, input.state_id, input.agent)
  );
  const adapter = matches[0];
  if (adapter === undefined || matches.length !== 1) {
    throw new Error(
      `provider opening guard '${input.id}' is not uniquely bound to '${input.registration_name}:${input.state_id}:${input.agent}'`
    );
  }
  return adapter;
}
