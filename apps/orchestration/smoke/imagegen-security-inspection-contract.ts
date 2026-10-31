/**
 * Pure, hermetic contract for the opt-in deployed imagegen security inspection.
 *
 * No filesystem, network, or environment access lives here. The live inspection runner and the
 * default (provider-free) contract test share this module so the gate, the required check
 * vocabulary, the private report location, and the fail-closed issue codes cannot drift.
 *
 * The report path is relative to the operator project root and, like every `.penny/` artifact, is
 * never tracked. Nothing here names an operator path or echoes a sensitive body.
 */

export const IMAGEGEN_SECURITY_INSPECTION_GATE_ENV = "PENNY_IMAGEGEN_SECURITY_INSPECTION" as const;
export const IMAGEGEN_SECURITY_INSPECTION_MANIFEST_ENV =
  "PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE" as const;

/** Project-root-relative private report directory and filename. Never tracked. */
export const IMAGEGEN_SECURITY_REPORT_DIRECTORY = ".penny/imagegen/qualification" as const;
export const IMAGEGEN_SECURITY_REPORT_FILENAME = "security-inspection.json" as const;

export const IMAGEGEN_SECURITY_CHECKS = Object.freeze([
  "loopback_listener_reachability",
  "direct_client_egress_and_proxy",
  "runtime_identity",
  "manifest_custody",
  "profile_approval_and_inventory",
  "storage_quota_reservations_modes",
  "artifact_and_output_permissions",
  "export_destinations_and_permissions",
  "log_and_control_state_leakage",
] as const);

export type ImagegenSecurityCheckIdV1 = (typeof IMAGEGEN_SECURITY_CHECKS)[number];

export interface ImagegenSecurityCheckResultV1 {
  readonly check_id: ImagegenSecurityCheckIdV1;
  /** Every check is required; only `passed` is accepted. */
  readonly status: "passed" | "failed";
  /** A bounded, content-free reason. Never a path, prompt, image byte, or credential. */
  readonly detail_code: string;
}

export function imagegenSecurityInspectionEnabled(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env[IMAGEGEN_SECURITY_INSPECTION_GATE_ENV] === "1";
}

export function assertImagegenSecurityInspectionGate(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (!imagegenSecurityInspectionEnabled(env)) {
    throw new Error(
      `Set ${IMAGEGEN_SECURITY_INSPECTION_GATE_ENV}=1 to authorize the deployed imagegen security inspection.`
    );
  }
}

export type ImagegenSecurityIssueCode = "check_missing" | "check_duplicated" | "check_failed";

/**
 * Fail-closed, order-stable assertion vocabulary. Every required check must appear exactly once
 * with status `passed`; a missing, duplicated, or failed check is an issue.
 */
export function imagegenSecurityInspectionIssueCodes(
  results: readonly ImagegenSecurityCheckResultV1[]
): readonly string[] {
  const issues: string[] = [];
  const counts = new Map<ImagegenSecurityCheckIdV1, number>();
  for (const result of results) {
    counts.set(result.check_id, (counts.get(result.check_id) ?? 0) + 1);
  }
  for (const check of IMAGEGEN_SECURITY_CHECKS) {
    const count = counts.get(check) ?? 0;
    if (count === 0) issues.push(`${check}:check_missing`);
    else if (count > 1) issues.push(`${check}:check_duplicated`);
  }
  for (const result of results) {
    if (result.status !== "passed") issues.push(`${result.check_id}:check_failed`);
    if (result.detail_code.trim().length === 0) {
      issues.push(`${result.check_id}:check_failed`);
    }
  }
  return issues;
}
