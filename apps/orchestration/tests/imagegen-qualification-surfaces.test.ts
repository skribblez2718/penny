import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertImagegenCanaryGate,
  imagegenCanaryEnabled,
  imagegenCanaryIssueCodes,
  IMAGEGEN_CANARY_BACKEND_GATE_ENV,
  IMAGEGEN_CANARY_CANARY_ID,
  IMAGEGEN_CANARY_GATE_ENV,
  IMAGEGEN_CANARY_MODEL_GATE_ENV,
  IMAGEGEN_CANARY_GOAL,
  IMAGEGEN_CANARY_SEED,
  type ImagegenCanaryObservationV1,
} from "../smoke/imagegen-canary-contract.js";
import {
  assertImagegenRecoveryLiveGate,
  imagegenRecoveryIssueCodes,
  imagegenRecoveryLiveEnabled,
  IMAGEGEN_RECOVERY_BOUNDARIES,
  IMAGEGEN_RECOVERY_EXPECTATIONS,
  IMAGEGEN_RECOVERY_LIVE_GATE_ENV,
  type ImagegenRecoveryBoundaryObservationV1,
} from "../smoke/imagegen-recovery-live-contract.js";
import {
  assertImagegenSecurityInspectionGate,
  imagegenSecurityInspectionEnabled,
  imagegenSecurityInspectionIssueCodes,
  IMAGEGEN_SECURITY_CHECKS,
  IMAGEGEN_SECURITY_INSPECTION_GATE_ENV,
  IMAGEGEN_SECURITY_REPORT_DIRECTORY,
  IMAGEGEN_SECURITY_REPORT_FILENAME,
  type ImagegenSecurityCheckResultV1,
} from "../smoke/imagegen-security-inspection-contract.js";
import { parseJson, requireRecord, requireString } from "./helpers/narrowing.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function source(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

const SURFACE_SOURCES = [
  "apps/orchestration/smoke/imagegen-recovery-live-contract.ts",
  "apps/orchestration/smoke/imagegen-recovery-live.test.ts",
  "apps/orchestration/smoke/imagegen-security-inspection-contract.ts",
  "apps/orchestration/smoke/imagegen-security-inspection.test.ts",
  "apps/orchestration/smoke/imagegen-canary-contract.ts",
  "apps/orchestration/smoke/imagegen-canary.test.ts",
  "apps/orchestration/vitest.imagegen-recovery-live.config.ts",
  "apps/orchestration/vitest.imagegen-security-inspection.config.ts",
  "apps/orchestration/vitest.imagegen-canary.config.ts",
] as const;

function passingSecurityResults(): ImagegenSecurityCheckResultV1[] {
  return IMAGEGEN_SECURITY_CHECKS.map((check_id) => ({
    check_id,
    status: "passed" as const,
    detail_code: "ok",
  }));
}

function passingRecoveryObservations(): ImagegenRecoveryBoundaryObservationV1[] {
  return IMAGEGEN_RECOVERY_BOUNDARIES.map((boundary) => ({
    boundary,
    ...IMAGEGEN_RECOVERY_EXPECTATIONS[boundary],
  }));
}

function passingCanaryObservation(): ImagegenCanaryObservationV1 {
  return {
    production_registry_has_imagegen: true,
    ordinary_start_denied: true,
    ordinary_denied_code: "canary_request_drift",
    canary_admission_decision: "admitted_canary",
    canary_consumed_run_matches: true,
    replay_denied: true,
    replay_denied_code: "canary_absent",
    terminal_action: "complete",
    terminal_met: true,
    completion_origin: "admitting_product",
    selected_image_present: true,
    review_epochs_complete: true,
    cleanup_outcome: "completed",
    operator_manifest_unchanged: true,
    ordinary_mode_still_disabled: true,
  };
}

describe("opt-in imagegen qualification gates", () => {
  it("requires the exact opt-in value for each remaining surface and is default-off", () => {
    for (const gate of [
      IMAGEGEN_RECOVERY_LIVE_GATE_ENV,
      IMAGEGEN_SECURITY_INSPECTION_GATE_ENV,
      IMAGEGEN_CANARY_GATE_ENV,
    ]) {
      expect(gate.startsWith("PENNY_IMAGEGEN_")).toBe(true);
    }

    expect(imagegenRecoveryLiveEnabled({})).toBe(false);
    expect(imagegenRecoveryLiveEnabled({ [IMAGEGEN_RECOVERY_LIVE_GATE_ENV]: "true" })).toBe(false);
    expect(imagegenRecoveryLiveEnabled({ [IMAGEGEN_RECOVERY_LIVE_GATE_ENV]: "1" })).toBe(true);
    expect(() => assertImagegenRecoveryLiveGate({})).toThrow(IMAGEGEN_RECOVERY_LIVE_GATE_ENV);

    expect(imagegenSecurityInspectionEnabled({})).toBe(false);
    expect(
      imagegenSecurityInspectionEnabled({ [IMAGEGEN_SECURITY_INSPECTION_GATE_ENV]: "1" })
    ).toBe(true);
    expect(() => assertImagegenSecurityInspectionGate({})).toThrow(
      IMAGEGEN_SECURITY_INSPECTION_GATE_ENV
    );

    // The canary additionally requires both live prerequisite gates.
    expect(imagegenCanaryEnabled({ [IMAGEGEN_CANARY_GATE_ENV]: "1" })).toBe(false);
    expect(
      imagegenCanaryEnabled({
        [IMAGEGEN_CANARY_GATE_ENV]: "1",
        [IMAGEGEN_CANARY_BACKEND_GATE_ENV]: "1",
      })
    ).toBe(false);
    expect(
      imagegenCanaryEnabled({
        [IMAGEGEN_CANARY_GATE_ENV]: "1",
        [IMAGEGEN_CANARY_BACKEND_GATE_ENV]: "1",
        [IMAGEGEN_CANARY_MODEL_GATE_ENV]: "1",
      })
    ).toBe(true);
    expect(() => assertImagegenCanaryGate({ [IMAGEGEN_CANARY_GATE_ENV]: "1" })).toThrow(
      IMAGEGEN_CANARY_BACKEND_GATE_ENV
    );
  });

  it("freezes the recovery boundaries, canary request, and security report location", () => {
    expect([...IMAGEGEN_RECOVERY_BOUNDARIES]).toEqual([
      "before_submit",
      "after_submit_before_prompt_id_checkpoint",
      "after_prompt_id_checkpoint",
      "after_fetch",
      "after_artifact_persist",
      "before_routing",
    ]);
    expect(IMAGEGEN_CANARY_SEED).toBeGreaterThan(0);
    expect(IMAGEGEN_CANARY_SEED).toBeLessThan(2 ** 32);
    expect(IMAGEGEN_CANARY_CANARY_ID.length).toBeGreaterThan(0);
    expect(IMAGEGEN_CANARY_GOAL.length).toBeGreaterThan(0);
    expect(IMAGEGEN_SECURITY_REPORT_DIRECTORY).toBe(".penny/imagegen/qualification");
    expect(IMAGEGEN_SECURITY_REPORT_FILENAME.endsWith(".json")).toBe(true);
  });

  it("accepts only exhaustive, expectation-matching recovery observations", () => {
    expect(imagegenRecoveryIssueCodes(passingRecoveryObservations())).toEqual([]);
    const missing = passingRecoveryObservations().slice(0, 5);
    expect(imagegenRecoveryIssueCodes(missing)).toEqual(["before_routing:boundary_missing"]);
    const mismatched = passingRecoveryObservations().map((observation) =>
      observation.boundary === "after_submit_before_prompt_id_checkpoint"
        ? { ...observation, resubmitted_after_recovery: true }
        : observation
    );
    expect(imagegenRecoveryIssueCodes(mismatched)).toEqual([
      "after_submit_before_prompt_id_checkpoint:resubmission_mismatch",
    ]);
  });

  it("fails closed on any missing, duplicated, or failed security check", () => {
    expect(imagegenSecurityInspectionIssueCodes(passingSecurityResults())).toEqual([]);
    expect(imagegenSecurityInspectionIssueCodes(passingSecurityResults().slice(1))).toEqual([
      "loopback_listener_reachability:check_missing",
    ]);
    expect(
      imagegenSecurityInspectionIssueCodes([
        ...passingSecurityResults(),
        { check_id: "runtime_identity", status: "passed", detail_code: "ok" },
      ])
    ).toEqual(["runtime_identity:check_duplicated"]);
    expect(
      imagegenSecurityInspectionIssueCodes(
        passingSecurityResults().map((result) =>
          result.check_id === "manifest_custody"
            ? { ...result, status: "failed" as const, detail_code: "failed" }
            : result
        )
      )
    ).toEqual(["manifest_custody:check_failed"]);
    expect(
      imagegenSecurityInspectionIssueCodes(
        passingSecurityResults().map((result) =>
          result.check_id === "log_and_control_state_leakage"
            ? { ...result, detail_code: "" }
            : result
        )
      )
    ).toEqual(["log_and_control_state_leakage:check_failed"]);
  });

  it("accepts only the complete one-shot canary observation", () => {
    expect(imagegenCanaryIssueCodes(passingCanaryObservation())).toEqual([]);
    const failing = imagegenCanaryIssueCodes({
      ...passingCanaryObservation(),
      ordinary_start_denied: false,
      ordinary_denied_code: "not_denied",
      canary_admission_decision: "admitted_ordinary",
      replay_denied: false,
      replay_denied_code: "not_denied",
      terminal_action: "incomplete",
      terminal_met: false,
      completion_origin: "complete",
      selected_image_present: false,
      review_epochs_complete: false,
      cleanup_outcome: "failed",
      operator_manifest_unchanged: false,
      ordinary_mode_still_disabled: false,
    });
    expect(failing).toEqual([
      "ordinary_start_denied",
      "canary_admission_decision",
      "replay_denied",
      "terminal_action",
      "terminal_met",
      "completion_origin",
      "selected_image_present",
      "review_epochs_complete",
      "cleanup_outcome",
      "operator_manifest_unchanged",
      "ordinary_mode_still_disabled",
      "ordinary_denied_code",
      "replay_denied_code",
    ]);
  });
});

describe("remaining imagegen qualification source boundaries", () => {
  it("keeps the tracked qualification sources generic and self-contained", () => {
    for (const relative of SURFACE_SOURCES) {
      expect(existsSync(path.join(REPO_ROOT, relative)), relative).toBe(true);
      const text = source(relative);
      expect(text, relative).not.toMatch(/\/home\/|\/Users\//u);
      expect(text, relative).not.toMatch(/from\s+"\.\.?\/src\/index\.js"/u);
    }
  });

  it("keeps every live surface out of the default provider-free test run", () => {
    const defaultConfig = source("apps/orchestration/vitest.config.ts");
    for (const config of [
      "imagegen-recovery-live",
      "imagegen-security-inspection",
      "imagegen-canary",
    ]) {
      expect(defaultConfig).not.toContain(config);
    }
    expect(source("apps/orchestration/vitest.imagegen-recovery-live.config.ts")).toContain(
      "smoke/imagegen-recovery-live.test.ts"
    );
    expect(source("apps/orchestration/vitest.imagegen-security-inspection.config.ts")).toContain(
      "smoke/imagegen-security-inspection.test.ts"
    );
    expect(source("apps/orchestration/vitest.imagegen-canary.config.ts")).toContain(
      "smoke/imagegen-canary.test.ts"
    );
  });

  it("ships env-gated package scripts and no default-suite live invocation", () => {
    const pkg = requireRecord(
      parseJson(source("apps/orchestration/package.json")),
      "orchestration package.json"
    );
    const scripts = requireRecord(pkg["scripts"], "orchestration scripts");
    expect(
      requireString(scripts["test:imagegen-recovery-live"], "test:imagegen-recovery-live")
    ).toContain(IMAGEGEN_RECOVERY_LIVE_GATE_ENV);
    expect(
      requireString(
        scripts["test:imagegen-security-inspection"],
        "test:imagegen-security-inspection"
      )
    ).toContain(IMAGEGEN_SECURITY_INSPECTION_GATE_ENV);
    expect(requireString(scripts["test:imagegen-canary"], "test:imagegen-canary")).toContain(
      IMAGEGEN_CANARY_GATE_ENV
    );
    for (const name of [
      "test:imagegen-recovery-live:aggregate",
      "test:imagegen-security-inspection:aggregate",
      "test:imagegen-canary:aggregate",
    ]) {
      expect(requireString(scripts[name], name).length).toBeGreaterThan(0);
    }
    const testAll = requireString(scripts["test:all"], "test:all");
    for (const name of [
      "test:imagegen-recovery-live:aggregate",
      "test:imagegen-security-inspection:aggregate",
      "test:imagegen-canary:aggregate",
    ]) {
      expect(testAll).toContain(name);
    }
    const rootScripts = requireRecord(
      requireRecord(parseJson(source("package.json")), "root package.json")["scripts"],
      "root scripts"
    );
    for (const name of [
      "test:imagegen-recovery-live",
      "test:imagegen-recovery-live:aggregate",
      "test:imagegen-security-inspection",
      "test:imagegen-security-inspection:aggregate",
      "test:imagegen-canary",
      "test:imagegen-canary:aggregate",
    ]) {
      expect(requireString(rootScripts[name], `root ${name}`).length).toBeGreaterThan(0);
    }
  });

  it("keeps the recovery experiment on the operator manifest and the host-owned crash seam", () => {
    const live = source("apps/orchestration/smoke/imagegen-recovery-live.test.ts");
    expect(live).toContain("IMAGEGEN_RECOVERY_LIVE_MANIFEST_ENV");
    expect(live).toContain("loadImagegenRuntimeFromEnvironment");
    expect(live).toContain("HostOperationSimulatedCrashError");
    expect(live).toContain("IMAGEGEN_RECOVERY_BOUNDARY_FAULT_POINT");
    expect(live).toContain("crashAt");
    // A private profile must come only from the operator manifest, never a fabricated fixture.
    expect(live).not.toContain("StaticImagegenProfileRegistry");
    expect(live).not.toMatch(/http:\/\/(?:127\.0\.0\.1|localhost)/u);
  });

  it("keeps the crash seam host-owned and absent from every caller/model surface", () => {
    const owners = source("apps/orchestration/src/host-operations/owner.ts");
    expect(owners).toContain("HOST_OPERATION_FAULT_POINTS");
    expect(owners).toContain("HostOperationSimulatedCrashError");
    const service = source("apps/orchestration/src/service.ts");
    expect(service).toContain("hostOperationFault");
    // The seam is a construction-time capability, never a directive, request, or registration field.
    for (const relative of [
      "apps/orchestration/src/contracts.ts",
      "apps/orchestration/src/playbooks/registry.ts",
      "apps/orchestration/src/host-operations/contracts.ts",
    ]) {
      expect(source(relative), relative).not.toContain("HostOperationFaultPoint");
      expect(source(relative), relative).not.toContain("HostOperationSimulatedCrashError");
    }
  });

  it("keeps the security inspection private, fail-closed, and free of echoed bodies", () => {
    const live = source("apps/orchestration/smoke/imagegen-security-inspection.test.ts");
    expect(live).toContain("IMAGEGEN_SECURITY_REPORT_DIRECTORY");
    expect(live).toContain("IMAGEGEN_SECURITY_REPORT_FILENAME");
    expect(live).toContain("loadImagegenRuntimeFromEnvironment");
    expect(live).toContain("probeTcp");
    expect(live).toContain("0o600");
    expect(live).not.toMatch(/console\.log/u);
    // The report directory is under `.penny/`, which is gitignored and never tracked.
    const gitignore = source(".gitignore");
    expect(gitignore).toMatch(/^\.penny\/$/mu);
  });

  it("keeps the canary on the production registry with real SSOT models and no mode change", () => {
    const live = source("apps/orchestration/smoke/imagegen-canary.test.ts");
    expect(live).toContain("PLAYBOOK_REGISTRY");
    expect(live).toContain("resolvePlaybook");
    expect(live).toContain("loadImagegenRuntimeFromEnvironment");
    expect(live).toContain("imagegenActivationRequestSha256");
    expect(live).toContain("buildSkillImageOutputPresentation");
    expect(live).toContain("assertImagegenCanaryGate");
    // Real SSOT critics: the canary never injects a text-only model or a hardcoded model override,
    // and it never injects a registration (so exact-name ingress resolves the production registry).
    expect(live).not.toContain("modelClient:");
    expect(live).not.toContain("modelOverride");
    expect(live).not.toContain("playbookRegistration:");
    expect(live).not.toMatch(/deepseek/iu);
    expect(live).not.toMatch(/mode:\s*"enabled"/u);
  });
});
