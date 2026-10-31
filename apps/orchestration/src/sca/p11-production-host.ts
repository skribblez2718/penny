import type { ArtifactHostStore } from "../artifact-store.js";
import type { ProviderOpeningGuardAdapter } from "../provider-opening-guard.js";
import type { ArtifactRef } from "../contracts.js";
import type { PlaybookRegistration } from "../playbooks/registry.js";
import {
  SCA_P11_CANDIDATE_PLAYBOOK_NAME,
  createScaP11CandidateRegistrationV1,
  type ScaP11CandidateBindingV1,
} from "./p11-playbook.js";
import { SCA_P11_PROVIDER_OPENING_GUARD } from "./p11-contracts.js";
import { SCA_P11_PROVIDER_OPENING_ADAPTER } from "./p11-dispatch-guard.js";
import {
  resolveScaP11CvssScorerAuthority,
  type ScaP11CvssScorerAuthorityV1,
} from "./p11-scoring.js";

/**
 * Production composition for the inactive P11 reporting candidate. It requires the exact admitted
 * CVSS v4 scorer qualification receipt artifact and re-reads it from the host store (a
 * current-authority re-read, never an object-shape check). There is no fallback and no live scorer.
 * It projects the exact provider-opening guard the review/repair phases declare and constructs the
 * production registration without ever installing it into any active registry or the public `sca`
 * skill. P11 runs no scanner, adapter, target execution, or second engine, so it declares no host
 * operations.
 */
export interface ScaP11ReportingProductionCompositionV1 {
  readonly registration: PlaybookRegistration;
  readonly provider_opening_guard_id: typeof SCA_P11_PROVIDER_OPENING_GUARD;
  readonly provider_opening_adapters: ReadonlyMap<string, ProviderOpeningGuardAdapter>;
  readonly scorer: ScaP11CvssScorerAuthorityV1;
  readonly scorer_qualification_ref: ArtifactRef;
  readonly repair_budget: number;
}

export function createScaP11ReportingProductionCompositionV1(input: {
  readonly store: ArtifactHostStore;
  readonly scorer_qualification_ref: ArtifactRef;
  readonly repair_budget?: number;
  readonly resolve_current_p07_authority_ref?: ScaP11CandidateBindingV1["resolve_current_p07_authority_ref"];
  readonly resolve_current_p01_obligation_head_ref?: ScaP11CandidateBindingV1["resolve_current_p01_obligation_head_ref"];
}): ScaP11ReportingProductionCompositionV1 {
  // Current-authority re-read: the authority is rebuilt from the exact admitted receipt bytes.
  const scorer = resolveScaP11CvssScorerAuthority({
    store: input.store,
    ref: input.scorer_qualification_ref,
  });
  const repairBudget = input.repair_budget ?? 0;
  if (!Number.isInteger(repairBudget) || repairBudget < 0 || repairBudget > 64) {
    throw new Error("SCA P11 production repair budget is not a bounded admitted policy value");
  }
  const registration = createScaP11CandidateRegistrationV1({
    scorer,
    repair_budget: repairBudget,
    ...(input.resolve_current_p07_authority_ref === undefined
      ? {}
      : { resolve_current_p07_authority_ref: input.resolve_current_p07_authority_ref }),
    ...(input.resolve_current_p01_obligation_head_ref === undefined
      ? {}
      : { resolve_current_p01_obligation_head_ref: input.resolve_current_p01_obligation_head_ref }),
  });
  if (registration.name !== SCA_P11_CANDIDATE_PLAYBOOK_NAME) {
    throw new Error("SCA P11 production registration name is invalid");
  }
  const worker = registration.worker;
  if (worker.kind !== "catalog-agent") {
    throw new Error("SCA P11 production registration is not a catalog-agent worker");
  }
  const phases = worker.phases;
  if (
    phases.size === 0 ||
    [...phases.values()].some(
      (phase) => phase.provider_opening_guard !== SCA_P11_PROVIDER_OPENING_GUARD
    )
  ) {
    throw new Error("SCA P11 production registration does not declare the exact opening guard");
  }
  return Object.freeze({
    registration,
    provider_opening_guard_id: SCA_P11_PROVIDER_OPENING_GUARD,
    provider_opening_adapters: new Map<string, ProviderOpeningGuardAdapter>([
      [SCA_P11_PROVIDER_OPENING_ADAPTER.id, SCA_P11_PROVIDER_OPENING_ADAPTER],
    ]),
    scorer,
    scorer_qualification_ref: input.scorer_qualification_ref,
    repair_budget: repairBudget,
  });
}
