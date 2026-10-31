import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertImagegenLiveSmokeGate,
  imagegenBackendLiveSmokeIssueCodes,
  imagegenLiveSmokeEnabled,
  IMAGEGEN_LIVE_GATE_ENV,
  IMAGEGEN_LIVE_SMOKE_CONSTRAINTS,
  IMAGEGEN_LIVE_SMOKE_SEED,
  type ImagegenBackendLiveSmokeObservationV1,
} from "../smoke/imagegen-live-smoke-contract.js";
import {
  assertImagegenModelSmokeGate,
  criticDeliveryIssueCodes,
  criticReportIssueCodes,
  imagegenModelSmokeEnabled,
  IMAGEGEN_MODEL_SMOKE_DEFAULT_COUNT,
  IMAGEGEN_MODEL_SMOKE_GATE_ENV,
  IMAGEGEN_MODEL_SMOKE_MAXIMUM_COUNT,
} from "../smoke/imagegen-model-smoke-contract.js";
import { parseJson, requireRecord, requireString } from "./helpers/narrowing.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function source(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

const BACKEND_SMOKE = "apps/orchestration/smoke/imagegen-backend-live-smoke.test.ts";
const MODEL_SMOKE = "apps/orchestration/smoke/imagegen-model-smoke.test.ts";
const TERMINAL_IMAGE = ".pi/extensions/skill/terminal-image.ts";

const QUALIFICATION_SOURCES = [
  "apps/orchestration/smoke/imagegen-live-smoke-contract.ts",
  BACKEND_SMOKE,
  "apps/orchestration/smoke/imagegen-model-smoke-contract.ts",
  MODEL_SMOKE,
  "apps/orchestration/tests/helpers/imagegen-smoke-model.ts",
  "apps/orchestration/vitest.imagegen-live.config.ts",
  "apps/orchestration/vitest.imagegen-model-smoke.config.ts",
] as const;

function passingObservation(): ImagegenBackendLiveSmokeObservationV1 {
  return {
    terminal_action: "complete",
    terminal_met: true,
    readiness_operation_count: 1,
    generation_submission_count: 1,
    export_operation_count: 0,
    submitted_graph_count: 1,
    generated_image_count: 1,
    validation_receipt_count: 1,
    storage_reservation_receipt_count: 1,
    storage_release_receipt_count: 1,
    manifest_count: 1,
    slot_ledger_present: true,
    slot_accepted: true,
    quarantined_lease_count: 0,
    clean_shutdown: true,
  };
}

describe("imagegen opt-in qualification gates", () => {
  it("requires the exact opt-in value for each live surface", () => {
    expect(imagegenLiveSmokeEnabled({})).toBe(false);
    expect(imagegenLiveSmokeEnabled({ [IMAGEGEN_LIVE_GATE_ENV]: "0" })).toBe(false);
    expect(imagegenLiveSmokeEnabled({ [IMAGEGEN_LIVE_GATE_ENV]: "true" })).toBe(false);
    expect(imagegenLiveSmokeEnabled({ [IMAGEGEN_LIVE_GATE_ENV]: "1" })).toBe(true);
    expect(() => assertImagegenLiveSmokeGate({})).toThrow(IMAGEGEN_LIVE_GATE_ENV);

    expect(imagegenModelSmokeEnabled({})).toBe(false);
    expect(imagegenModelSmokeEnabled({ [IMAGEGEN_MODEL_SMOKE_GATE_ENV]: "yes" })).toBe(false);
    expect(imagegenModelSmokeEnabled({ [IMAGEGEN_MODEL_SMOKE_GATE_ENV]: "1" })).toBe(true);
    expect(() => assertImagegenModelSmokeGate({})).toThrow(IMAGEGEN_MODEL_SMOKE_GATE_ENV);
  });

  it("freezes the backend smoke request and the critic fixture-set sizes", () => {
    expect(IMAGEGEN_LIVE_SMOKE_CONSTRAINTS).toEqual({
      schema_version: 1,
      count: 1,
      seed: IMAGEGEN_LIVE_SMOKE_SEED,
      max_revision_rounds: 0,
      raw_prompt: null,
      dimensions: null,
      export: null,
    });
    expect(IMAGEGEN_LIVE_SMOKE_SEED).toBeGreaterThan(0);
    expect(IMAGEGEN_LIVE_SMOKE_SEED).toBeLessThan(2 ** 32);
    expect(IMAGEGEN_MODEL_SMOKE_DEFAULT_COUNT).toBe(3);
    expect(IMAGEGEN_MODEL_SMOKE_MAXIMUM_COUNT).toBe(10);
  });

  it("accepts only the complete backend live-smoke observation", () => {
    expect(imagegenBackendLiveSmokeIssueCodes(passingObservation())).toEqual([]);
    expect(
      imagegenBackendLiveSmokeIssueCodes({
        ...passingObservation(),
        terminal_action: "incomplete",
        terminal_met: false,
        readiness_operation_count: 0,
        generation_submission_count: 2,
        export_operation_count: 1,
        submitted_graph_count: 0,
        generated_image_count: 0,
        validation_receipt_count: 0,
        storage_reservation_receipt_count: 0,
        storage_release_receipt_count: 0,
        manifest_count: 0,
        slot_ledger_present: false,
        quarantined_lease_count: 1,
        clean_shutdown: false,
      })
    ).toEqual([
      "terminal_not_complete",
      "terminal_not_met",
      "readiness_count_not_one",
      "submission_count_not_one",
      "unexpected_export_operation",
      "missing_submitted_graph",
      "missing_sanitized_png",
      "missing_validation_receipt",
      "missing_storage_reservation_receipt",
      "missing_storage_release_receipt",
      "missing_manifest",
      "missing_slot_ledger",
      "quarantined_lease",
      "unclean_shutdown",
    ]);
    expect(
      imagegenBackendLiveSmokeIssueCodes({
        ...passingObservation(),
        slot_accepted: false,
      })
    ).toEqual(["slot_not_accepted"]);
  });
});

describe("imagegen critic qualification evidence", () => {
  it("requires every expected image block to reach the registered critic", () => {
    const delivered = {
      worker: "vera",
      expected_artifact_ids: ["art_a", "art_b", "art_c"],
      delivered_artifact_ids: ["art_a", "art_b", "art_c"],
      delivered_mime_types: ["image/png", "image/png", "image/png"],
    };
    expect(criticDeliveryIssueCodes(delivered)).toEqual([]);
    expect(
      criticDeliveryIssueCodes({ ...delivered, delivered_artifact_ids: ["art_a", "art_b"] })
    ).toEqual(["missing_image_delivery"]);
    expect(
      criticDeliveryIssueCodes({
        ...delivered,
        delivered_artifact_ids: ["art_a", "art_b", "art_c", "art_d"],
      })
    ).toEqual(["unexpected_image_delivery"]);
    expect(
      criticDeliveryIssueCodes({
        ...delivered,
        delivered_artifact_ids: [],
        delivered_mime_types: [],
      })
    ).toEqual(["missing_image_delivery", "text_only_delivery"]);
    expect(
      criticDeliveryIssueCodes({
        ...delivered,
        delivered_mime_types: ["image/jpeg", "image/png", "image/png"],
      })
    ).toEqual(["delivered_non_png_image"]);
    expect(
      criticDeliveryIssueCodes({
        ...delivered,
        worker: "synthia",
        delivered_artifact_ids: [],
        delivered_mime_types: [],
      })
    ).toEqual([
      "worker_is_not_a_registered_critic",
      "missing_image_delivery",
      "text_only_delivery",
    ]);
  });

  it("requires exact current-revision and ranking coverage in the active epoch", () => {
    const expected = ["0|0|art_a|shaA", "1|0|art_b|shaB", "2|0|art_c|shaC"];
    const coverage = {
      worker: "carren",
      expected_epoch: 1,
      report_epoch: 1,
      expected_revision_keys: expected,
      reported_revision_keys: expected,
      ranked_revision_keys: ["2|0|art_c|shaC", "0|0|art_a|shaA", "1|0|art_b|shaB"],
    };
    expect(criticReportIssueCodes(coverage)).toEqual([]);
    expect(criticReportIssueCodes({ ...coverage, report_epoch: 2 })).toEqual([
      "review_epoch_mismatch",
    ]);
    expect(
      criticReportIssueCodes({ ...coverage, reported_revision_keys: expected.slice(0, 2) })
    ).toEqual(["candidate_coverage_mismatch"]);
    expect(
      criticReportIssueCodes({ ...coverage, ranked_revision_keys: expected.slice(0, 2) })
    ).toEqual(["ranking_coverage_mismatch"]);
  });
});

describe("imagegen qualification source safety", () => {
  it("keeps qualification imports narrow and tracked sources free of operator paths", () => {
    for (const relative of QUALIFICATION_SOURCES) {
      const text = source(relative);
      expect(text, relative).not.toMatch(/from\s+"\.\.?\/src\/index\.js"/u);
      expect(text, relative).not.toMatch(/\/home\/|\/Users\//u);
    }
  });

  it("keeps the backend smoke on the operator manifest and the real loopback adapters", () => {
    const backend = source(BACKEND_SMOKE);
    expect(backend).toContain("assertImagegenLiveSmokeGate");
    expect(backend).toContain("IMAGEGEN_LIVE_MANIFEST_ENV");
    expect(backend).toContain("loadImagegenRuntimeFromEnvironment");
    expect(backend).toContain("loaded.adapters");
    expect(backend).toContain("mkdtempSync");
    expect(backend).toContain("IMAGEGEN_LIVE_SMOKE_CONSTRAINTS");
    // A private profile must come only from the operator manifest, never a fabricated fixture.
    expect(backend).not.toContain("StaticImagegenProfileRegistry");
    expect(backend).not.toMatch(/http:\/\/(?:127\.0\.0\.1|localhost)/u);
  });

  it("keeps the critic smoke on real PiAgentClient workers under unmodified SSOT identities", () => {
    const model = source(MODEL_SMOKE);
    expect(model).toContain("assertImagegenModelSmokeGate");
    expect(model).toContain("new PiAgentClient(");
    expect(model).toContain("ssotModel(");
    expect(model).toContain("buildSkillImageOutputPresentation");
    expect(model).toContain('path.join(PROJECT_ROOT, ".pi", "agents"');
    expect(model).toContain("requires_image_input");
    // No text-only substitute critic and no hardcoded SSOT override.
    expect(model).not.toMatch(/deepseek/iu);
    expect(model).not.toMatch(/modelOverride:\s*"/u);
  });

  it("shares the parent skill result rendering path instead of forking it", () => {
    expect(source(TERMINAL_IMAGE)).toContain("buildSkillImageOutputPresentation");
    expect(source(MODEL_SMOKE)).toContain("buildSkillImageOutputPresentation");
  });

  it("keeps both live smokes out of the default provider-free test run", () => {
    const defaultConfig = source("apps/orchestration/vitest.config.ts");
    expect(defaultConfig).not.toContain("imagegen-backend-live-smoke");
    expect(defaultConfig).not.toContain("imagegen-model-smoke");
    expect(source("apps/orchestration/vitest.imagegen-live.config.ts")).toContain(
      "smoke/imagegen-backend-live-smoke.test.ts"
    );
    expect(source("apps/orchestration/vitest.imagegen-model-smoke.config.ts")).toContain(
      "smoke/imagegen-model-smoke.test.ts"
    );
  });

  it("ships env-gated package scripts and no default-suite live invocation", () => {
    const pkg = requireRecord(
      parseJson(source("apps/orchestration/package.json")),
      "orchestration package.json"
    );
    const scripts = requireRecord(pkg["scripts"], "orchestration scripts");
    expect(requireString(scripts["test:imagegen-live"], "test:imagegen-live")).toContain(
      IMAGEGEN_LIVE_GATE_ENV
    );
    expect(
      requireString(scripts["test:imagegen-live:aggregate"], "test:imagegen-live:aggregate")
    ).toContain(IMAGEGEN_LIVE_GATE_ENV);
    expect(
      requireString(scripts["test:imagegen-model-smoke"], "test:imagegen-model-smoke")
    ).toContain(IMAGEGEN_MODEL_SMOKE_GATE_ENV);
    expect(
      requireString(
        scripts["test:imagegen-model-smoke:aggregate"],
        "test:imagegen-model-smoke:aggregate"
      )
    ).toContain(IMAGEGEN_MODEL_SMOKE_GATE_ENV);
    const rootPkg = requireRecord(parseJson(source("package.json")), "root package.json");
    const rootScripts = requireRecord(rootPkg["scripts"], "root scripts");
    for (const name of [
      "test:imagegen-live",
      "test:imagegen-live:aggregate",
      "test:imagegen-model-smoke",
      "test:imagegen-model-smoke:aggregate",
    ]) {
      expect(requireString(rootScripts[name], `root ${name}`).length).toBeGreaterThan(0);
    }
  });
});
