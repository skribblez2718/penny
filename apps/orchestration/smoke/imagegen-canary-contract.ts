/**
 * Pure, hermetic contract for the opt-in one-shot production activation canary.
 *
 * No registry, model, backend, filesystem, or environment access lives here. The live canary
 * runner and the default (provider-free) contract test share this module so the gate, the frozen
 * request, and the acceptance vocabulary cannot drift.
 *
 * The canary is an activation *evidence* step. It never enables ordinary imagegen mode and never
 * edits the operator manifest; enabling normal starts after evidence remains a separate operator
 * action.
 */

export const IMAGEGEN_CANARY_GATE_ENV = "PENNY_IMAGEGEN_CANARY" as const;
/** The canary requires the backend live gate and the multimodal critic smoke gate as prerequisites. */
export const IMAGEGEN_CANARY_BACKEND_GATE_ENV = "PENNY_IMAGEGEN_LIVE" as const;
export const IMAGEGEN_CANARY_MODEL_GATE_ENV = "PENNY_IMAGEGEN_MODEL_SMOKE" as const;
export const IMAGEGEN_CANARY_MANIFEST_ENV = "PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE" as const;

/** Fixed unsigned 32-bit base seed; slot 0's effective seed is this value exactly. */
export const IMAGEGEN_CANARY_SEED = 20_260_919 as const;

/** Fixed opaque host capability identifier for the canary; never caller- or model-supplied. */
export const IMAGEGEN_CANARY_CANARY_ID = "imagegen-activation-canary" as const;

/** Fixed canary goal. The one-shot capability is bound to this exact canonical request digest. */
export const IMAGEGEN_CANARY_GOAL =
  "Create one calm wordless blue geometric image for the production activation canary." as const;

/**
 * Frozen canary request: one candidate, no semantic repair, a fixed seed, no export. It matches
 * PRD §18 step 8 exactly.
 */
export const IMAGEGEN_CANARY_CONSTRAINTS = Object.freeze({
  schema_version: 1 as const,
  count: 1 as const,
  seed: IMAGEGEN_CANARY_SEED,
  max_revision_rounds: 0 as const,
  raw_prompt: null,
  dimensions: null,
  export: null,
});

export function imagegenCanaryEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return (
    env[IMAGEGEN_CANARY_GATE_ENV] === "1" &&
    env[IMAGEGEN_CANARY_BACKEND_GATE_ENV] === "1" &&
    env[IMAGEGEN_CANARY_MODEL_GATE_ENV] === "1"
  );
}

export function assertImagegenCanaryGate(env: Readonly<Record<string, string | undefined>>): void {
  const missing = [
    IMAGEGEN_CANARY_GATE_ENV,
    IMAGEGEN_CANARY_BACKEND_GATE_ENV,
    IMAGEGEN_CANARY_MODEL_GATE_ENV,
  ].filter((name) => env[name] !== "1");
  if (missing.length > 0) {
    throw new Error(
      `Set ${missing.join(", ")}=1 to authorize the one-shot imagegen activation canary.`
    );
  }
}

export interface ImagegenCanaryObservationV1 {
  readonly production_registry_has_imagegen: boolean;
  readonly ordinary_start_denied: boolean;
  readonly ordinary_denied_code: string;
  readonly canary_admission_decision: string;
  readonly canary_consumed_run_matches: boolean;
  readonly replay_denied: boolean;
  readonly replay_denied_code: string;
  readonly terminal_action: string;
  readonly terminal_met: boolean;
  readonly completion_origin: string;
  readonly selected_image_present: boolean;
  readonly review_epochs_complete: boolean;
  readonly cleanup_outcome: string;
  readonly operator_manifest_unchanged: boolean;
  readonly ordinary_mode_still_disabled: boolean;
}

export const IMAGEGEN_CANARY_EXPECTATIONS: Readonly<
  Omit<ImagegenCanaryObservationV1, "ordinary_denied_code" | "replay_denied_code">
> = Object.freeze({
  production_registry_has_imagegen: true,
  ordinary_start_denied: true,
  canary_admission_decision: "admitted_canary",
  canary_consumed_run_matches: true,
  replay_denied: true,
  terminal_action: "complete",
  terminal_met: true,
  completion_origin: "admitting_product",
  selected_image_present: true,
  review_epochs_complete: true,
  cleanup_outcome: "completed",
  operator_manifest_unchanged: true,
  ordinary_mode_still_disabled: true,
});

/** Denial codes that prove a canary capability refused a non-canary or replayed start. */
export const IMAGEGEN_CANARY_ACCEPTABLE_DENIAL_CODES = Object.freeze([
  "canary_request_drift",
  "canary_profile_drift",
  "canary_replay",
  "canary_absent",
] as const);

export const IMAGEGEN_CANARY_REQUIRED_FIELDS: readonly (keyof typeof IMAGEGEN_CANARY_EXPECTATIONS)[] =
  Object.freeze([
    "production_registry_has_imagegen",
    "ordinary_start_denied",
    "canary_admission_decision",
    "canary_consumed_run_matches",
    "replay_denied",
    "terminal_action",
    "terminal_met",
    "completion_origin",
    "selected_image_present",
    "review_epochs_complete",
    "cleanup_outcome",
    "operator_manifest_unchanged",
    "ordinary_mode_still_disabled",
  ]);

export function imagegenCanaryIssueCodes(
  observation: ImagegenCanaryObservationV1
): readonly string[] {
  const issues: string[] = [];
  for (const key of IMAGEGEN_CANARY_REQUIRED_FIELDS) {
    if (observation[key] !== IMAGEGEN_CANARY_EXPECTATIONS[key]) {
      issues.push(key);
    }
  }
  if (
    !(IMAGEGEN_CANARY_ACCEPTABLE_DENIAL_CODES as readonly string[]).includes(
      observation.ordinary_denied_code
    )
  ) {
    issues.push("ordinary_denied_code");
  }
  if (
    !(IMAGEGEN_CANARY_ACCEPTABLE_DENIAL_CODES as readonly string[]).includes(
      observation.replay_denied_code
    )
  ) {
    issues.push("replay_denied_code");
  }
  return issues;
}
