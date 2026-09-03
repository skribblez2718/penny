import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DecisionSemanticEvaluationV3Schema,
  DecideSemanticGraderOracleV3Schema,
  decisionSemanticV3GraderDescriptor,
  gradeDecisionSemanticClausesV3,
} from "../../decide-evaluation.js";
import {
  AuthorizedPlanSemanticEvidenceProjectionV1Schema,
  EvaluationCalibrationAuthorizationRequestTemplateV1Schema,
  EvaluationCalibrationCohortV1Schema,
  EvaluationCalibrationContaminationFingerprintManifestV1Schema,
  EvaluationCalibrationPackageV1Schema,
  EvaluationCalibrationPreparationEvidenceV1Schema,
  EvaluationCalibrationScheduleV1Schema,
  PlanCalibrationSourceAdmissionV1Schema,
  buildEvaluationCalibrationContaminationFingerprintManifestV1,
  calibrationCanonicalSha256,
  calibrationPackageBodySha256,
  projectAuthorizedPlanCalibrationSemanticEvidenceV1,
  sha256Bytes,
  validateEvaluationCalibrationAuthorizationRequestTemplate,
  validateEvaluationCalibrationCohort,
  validateEvaluationCalibrationContaminationFingerprintManifest,
  validateEvaluationCalibrationPackage,
  validateEvaluationCalibrationPreparationEvidence,
  validateEvaluationCalibrationSchedule,
  validateEvaluationCalibrationSemanticJudgeControl,
  validateEvaluationCalibrationTask,
} from "../../evaluation-calibration-package.js";
import {
  Q4_ORACLE_REVIEW_CLAUSE_IDS,
  validateSemanticReviewOutputV1,
  validateSemanticReviewPacketV1,
} from "../../evaluation-semantic-review.js";
import {
  PLAN_SEMANTIC_CLAUSE_IDS,
  PlanSemanticGraderOracleV2Schema,
  StrategyEvaluationV2Schema,
  gradePlanSemanticClausesV2,
  planSemanticV2GraderDescriptor,
} from "../../plan-evaluation.js";
import {
  DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3,
  PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2,
  PlanSemanticReviewWireV2Schema,
} from "../../evaluation-semantic-projections.js";
import { canonicalJson, JsonValueSchema, validateContract } from "@penny/orchestration/source";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const DECIDE_BASE = "evals/calibration/decide-c6-v1";
const PLAN_BASE = "evals/calibration/plan-c6-v1";
const CASE_KINDS = ["ordinary", "equivalent", "known_bad", "boundary", "mutation"];

function fileBytes(relative: string): Buffer {
  return readFileSync(path.join(PROJECT_ROOT, relative));
}

function sha256BytesLocal(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectCanonicalKeyOrder(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectCanonicalKeyOrder(item);
    return;
  }
  if (!isRecord(value)) return;
  expect(Object.keys(value)).toEqual([...Object.keys(value)].sort());
  for (const item of Object.values(value)) expectCanonicalKeyOrder(item);
}

function readJson(relative: string): unknown {
  const bytes = fileBytes(relative);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  expect(bytes.toString("utf8").endsWith("\n")).toBe(true);
  expectCanonicalKeyOrder(parsed);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function deepUnknown(value: unknown): unknown {
  const parsed: unknown = JSON.parse(canonicalJson(value));
  return parsed;
}

function controlsFor(base: string) {
  const bundle = record(readJson(`${base}/semantic-judge-controls.v1.json`), "controls");
  const controls = array(bundle.controls, "controls.items").map((value) =>
    validateEvaluationCalibrationSemanticJudgeControl(value)
  );
  return { bundle, controls };
}

function oracleItemsFor(base: string) {
  const bundle = record(readJson(`${base}/oracles.v1.json`), "oracles");
  return array(bundle.items, "oracles.items").map((value) => record(value, "oracle item"));
}

function equivalenceItemsFor(base: string) {
  const bundle = record(readJson(`${base}/accepted-equivalences.v1.json`), "equivalences");
  return array(bundle.items, "equivalences.items").map((value) =>
    record(value, "equivalence item")
  );
}

function q4ItemsFor(base: string) {
  const bundle = record(readJson(`${base}/oracle-review-packets.v1.json`), "Q4 bundle");
  return array(bundle.packets, "Q4 packets").map((value) => record(value, "Q4 packet"));
}

function assertNoKeys(value: unknown, forbiddenKeys: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoKeys(item, forbiddenKeys);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    expect(forbiddenKeys.has(key), `forbidden key ${key}`).toBe(false);
    assertNoKeys(item, forbiddenKeys);
  }
}

function fakeTrialJudge(
  controls: ReturnType<typeof controlsFor>["controls"],
  controlId: string,
  wireSha256: string
) {
  const control = controls.find((item) => item.control_id === controlId);
  if (control === undefined) throw new Error(`unknown control ${controlId}`);
  const wire = control.skill === "plan" ? control.semantic_review_wire : control.output;
  if (calibrationCanonicalSha256(wire) !== wireSha256) {
    throw new Error(`wire digest mismatch for ${controlId}`);
  }
  return control.expected_review;
}

for (const [skill, base] of [
  ["decide", DECIDE_BASE],
  ["plan", PLAN_BASE],
] as const) {
  describe(`${skill} C6 calibration package`, () => {
    it("is canonical, strict, digest-bound, and reproducible from its component bytes", () => {
      const packageRecord = validateEvaluationCalibrationPackage(
        readJson(`${base}/package.v1.json`)
      );
      expect(
        validateContract(EvaluationCalibrationPackageV1Schema, packageRecord, "package")
      ).toEqual(packageRecord);
      const { package_sha256: packageSha256, ...packageBody } = packageRecord;
      expect(packageSha256).toBe(calibrationPackageBodySha256(packageBody));
      for (const binding of packageRecord.components) {
        const bytes = fileBytes(binding.path);
        expect(bytes.byteLength).toBe(binding.byte_length);
        expect(sha256BytesLocal(bytes)).toBe(binding.sha256);
      }

      const preparation = validateEvaluationCalibrationPreparationEvidence(
        readJson(`${base}/preparation-evidence.v1.json`)
      );
      expect(
        validateContract(
          EvaluationCalibrationPreparationEvidenceV1Schema,
          preparation,
          "preparation"
        )
      ).toEqual(preparation);
      expect(preparation.digests.package_sha256).toBe(packageRecord.package_sha256);
      expect(preparation.provider_calls).toBe(0);
      expect(preparation.credentials_accessed).toBe(false);
      expect(preparation.approval_created).toBe(false);
      expect(preparation.held_out_created).toBe(false);
      expect(preparation.protected_history_modified).toBe(false);
      expect(preparation.status).toBe("awaiting_owner_parameters");
      expect(preparation.enabled_or_promoted).toBe(false);
      expect(preparation.current_bindings.historical_preservation_verified_entries).toBe(334);
      expect(preparation.current_bindings.historical_preservation_mismatches).toBe(0);

      const authorization = validateEvaluationCalibrationAuthorizationRequestTemplate(
        readJson(`${base}/authorization-request.template.v1.json`)
      );
      expect(
        validateContract(
          EvaluationCalibrationAuthorizationRequestTemplateV1Schema,
          authorization,
          "authorization request"
        )
      ).toEqual(authorization);
      expect(authorization.status).toBe("awaiting_owner_parameters");
      expect(
        Object.values(authorization.unresolved_owner_parameters).every((value) => value === null)
      ).toBe(true);
      expect(authorization.package_sha256).toBe(packageRecord.package_sha256);
      expect(authorization.schedule_sha256).toBe(preparation.digests.schedule_sha256);
    });

    it("binds every task to one canonical request identity and rejects content drift", () => {
      const cohort = validateEvaluationCalibrationCohort(readJson(`${base}/cohort.v1.json`));
      expect(validateContract(EvaluationCalibrationCohortV1Schema, cohort, "cohort")).toEqual(
        cohort
      );
      expect(cohort.tasks).toHaveLength(5);
      expect(new Set(cohort.tasks.map((task) => task.task_id)).size).toBe(5);
      for (const task of cohort.tasks) {
        expect(validateEvaluationCalibrationTask(task)).toEqual(task);
        expect(task.runtime_task.task_id).toBe(task.task_id);
        expect(task.request_binding.canonical_request_sha256).toBe(
          calibrationCanonicalSha256(task.canonical_request)
        );
      }

      const mutated = record(deepUnknown(cohort.tasks[0]), "mutated task");
      const runtimeTask = record(mutated.runtime_task, "mutated runtime task");
      runtimeTask.goal = `${text(runtimeTask.goal, "runtime goal")} drift`;
      expect(() => validateEvaluationCalibrationTask(mutated)).toThrow();

      const withUnknown = record(deepUnknown(cohort.tasks[0]), "unknown-field task");
      withUnknown.unregistered_field = true;
      expect(() => validateEvaluationCalibrationTask(withUnknown)).toThrow();

      const duplicateCohort = record(deepUnknown(cohort), "duplicate cohort");
      const duplicateTasks = array(duplicateCohort.tasks, "duplicate tasks");
      duplicateTasks.push(deepUnknown(duplicateTasks[0]));
      expect(() => validateEvaluationCalibrationCohort(duplicateCohort)).toThrow();
    });

    it("contains full ordinary, equivalent, known-bad, boundary, and mutation controls", () => {
      const { bundle, controls } = controlsFor(base);
      expect(controls).toHaveLength(25);
      expect(record(bundle.deterministic_fake_judge, "fake judge")).toEqual({
        dispatch: "exact_control_id_and_packet_digest_lookup_only",
        keyword_scoring: false,
        model_or_provider_calls: 0,
      });
      const taskIds = [...new Set(controls.map((control) => control.task_id))].sort();
      expect(taskIds).toHaveLength(5);
      for (const taskId of taskIds) {
        expect(
          controls
            .filter((control) => control.task_id === taskId)
            .map((control) => control.case_kind)
            .sort()
        ).toEqual([...CASE_KINDS].sort());
      }

      for (const control of controls) {
        const outputSchema =
          control.skill === "decide"
            ? DecisionSemanticEvaluationV3Schema
            : StrategyEvaluationV2Schema;
        validateContract(outputSchema, control.output, `${control.control_id} output`);
        if (control.skill === "plan") {
          validateContract(
            PlanSemanticReviewWireV2Schema,
            control.semantic_review_wire,
            `${control.control_id} semantic wire`
          );
        }
        const wire = control.skill === "plan" ? control.semantic_review_wire : control.output;
        const first = fakeTrialJudge(
          controls,
          control.control_id,
          calibrationCanonicalSha256(wire)
        );
        const second = fakeTrialJudge(
          controls,
          control.control_id,
          calibrationCanonicalSha256(wire)
        );
        expect(first).toEqual(second);
        const applicable = new Set(control.applicable_clause_ids);
        expect(control.expected_review.clause_results).toHaveLength(
          control.skill === "decide"
            ? DECISION_SEMANTIC_REVIEW_CLAUSE_IDS_V3.length
            : PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2.length
        );
        expect(
          new Set(control.expected_review.clause_results.map((item) => item.clause_id)).size
        ).toBe(control.expected_review.clause_results.length);
        for (const result of control.expected_review.clause_results) {
          if (!applicable.has(result.clause_id)) expect(result.outcome).toBe("UNVERIFIABLE");
        }
        if (control.case_kind === "known_bad" || control.case_kind === "boundary") {
          expect(control.expected_semantic_disposition).toBe("FAIL");
          expect(
            control.expected_review.clause_results.some((item) => item.outcome === "FAIL")
          ).toBe(true);
        } else {
          expect(control.expected_semantic_disposition).toBe("PASS");
        }
      }
    });

    it("keeps every control structurally bound to its exact existing grader oracle", () => {
      const { controls } = controlsFor(base);
      const oracleItems = oracleItemsFor(base);
      for (const control of controls) {
        const oracleItem = oracleItems.find(
          (item) => item.oracle_item_id === control.oracle.item_id
        );
        if (oracleItem === undefined) throw new Error("bound oracle item missing");
        const graderCaseId = `${control.control_id}-grader`;
        const task = {
          task_id: control.task_id,
          domain: "c6-calibration",
          trigger_expected: true,
          goal: control.request_variant.goal,
          constraints: validateContract(
            Type.Record(Type.String(), JsonValueSchema),
            control.request_variant.constraints,
            "control task constraints"
          ),
          exact_input_artifact_ids: control.request_variant.exact_input_artifact_ids,
          grader_case_id: graderCaseId,
        };
        const structural =
          control.skill === "decide"
            ? gradeDecisionSemanticClausesV3(
                canonicalJson(control.output),
                task,
                decisionSemanticV3GraderDescriptor({
                  graderCaseId,
                  protectedCapability: false,
                  oracle: validateContract(
                    DecideSemanticGraderOracleV3Schema,
                    oracleItem.oracle,
                    "Decide control oracle"
                  ),
                })
              )
            : gradePlanSemanticClausesV2(
                canonicalJson(control.output),
                task,
                planSemanticV2GraderDescriptor({
                  graderCaseId,
                  protectedCapability: false,
                  oracle: validateContract(
                    PlanSemanticGraderOracleV2Schema,
                    oracleItem.oracle,
                    "Plan control oracle"
                  ),
                })
              );
        expect(
          structural.clause_results.some((result) => result.outcome === "FAIL"),
          control.control_id
        ).toBe(false);
      }
    });

    it("provides revised typed mutation oracles and full accepted equivalence outputs", () => {
      const oracleItems = oracleItemsFor(base);
      const equivalenceItems = equivalenceItemsFor(base);
      expect(oracleItems).toHaveLength(10);
      expect(equivalenceItems).toHaveLength(10);
      for (const item of oracleItems) {
        const variant = text(item.variant, "oracle variant");
        expect(["ordinary", "mutation"]).toContain(variant);
        const oracle = item.oracle;
        validateContract(
          skill === "decide"
            ? DecideSemanticGraderOracleV3Schema
            : PlanSemanticGraderOracleV2Schema,
          oracle,
          "typed calibration oracle"
        );
        const derivation = record(item.derivation, "oracle derivation");
        expect(derivation.candidate_output_consumed).toBe(false);
        expect(derivation.sealed_before_control_output_review).toBe(true);
      }
      for (const item of equivalenceItems) {
        const outputs = array(item.outputs, "equivalent outputs");
        expect(outputs).toHaveLength(2);
        for (const output of outputs) {
          validateContract(
            skill === "decide" ? DecisionSemanticEvaluationV3Schema : StrategyEvaluationV2Schema,
            output,
            "accepted full output"
          );
        }
        const outputDigests = array(item.output_sha256s, "equivalent output digests").map((value) =>
          text(value, "equivalent output digest")
        );
        expect(outputDigests).toEqual(outputs.map(calibrationCanonicalSha256));
        expect(item.candidate_output_used_to_derive_oracle).toBe(false);
      }
    });

    it("constructs all ten Q4 oracle-review packets without candidate output", () => {
      const packets = q4ItemsFor(base);
      expect(packets).toHaveLength(10);
      for (const item of packets) {
        expect(item.candidate_output_present).toBe(false);
        const packet = validateSemanticReviewPacketV1({
          value: item.packet,
          reviewKind: "oracle",
          canonicalClauseIds: Q4_ORACLE_REVIEW_CLAUSE_IDS,
        });
        expect(calibrationCanonicalSha256(packet)).toBe(item.packet_sha256);
        validateSemanticReviewOutputV1({
          value: item.expected_fake_judge_output,
          packet,
          canonicalClauseIds: Q4_ORACLE_REVIEW_CLAUSE_IDS,
        });
        assertNoKeys(
          packet,
          new Set([
            "candidate_output",
            "semantic_wire",
            "trial_output",
            "arm_id",
            "performance",
            "score",
          ])
        );
      }
    });

    it("enforces exact contamination fingerprints and makes no semantic-overlap claim", () => {
      const manifest = validateEvaluationCalibrationContaminationFingerprintManifest(
        readJson(`${base}/contamination.manifest.v1.json`)
      );
      expect(
        validateContract(
          EvaluationCalibrationContaminationFingerprintManifestV1Schema,
          manifest,
          "contamination manifest"
        )
      ).toEqual(manifest);
      expect(manifest.comparison_result).toBe("PASS_EXACT_METADATA_SCREEN");
      expect(manifest.semantic_overlap_claim).toBe("not_claimed_metadata_only");
      expect(manifest.held_out_oracle_body_access).toBe("none");
      expect(new Set(manifest.prohibited_corpora.map((corpus) => corpus.corpus_class))).toEqual(
        new Set(["development", "calibration", "held_out", "historical"])
      );
      expect(manifest.prohibited_corpora.every((corpus) => !corpus.oracle_bodies_consumed)).toBe(
        true
      );

      const collisionKinds = [
        "task_ids",
        "domains",
        "canonical_task_body_sha256s",
        "exact_input_byte_sha256s",
        "source_material_sha256s",
        "material_sha256s",
        "oracle_sha256s",
        "equivalence_sha256s",
      ] as const;
      for (const field of collisionKinds) {
        const collision = record(deepUnknown(manifest), "collision manifest");
        const prohibited = record(
          array(collision.prohibited_corpora, "prohibited corpora")[0],
          "prohibited corpus"
        );
        const screened = record(collision.screened_package, "screened package");
        const screenedValues = array(screened[field], `screened ${field}`);
        if (screenedValues.length === 0) continue;
        prohibited[field] = [screenedValues[0]];
        expect(() =>
          validateEvaluationCalibrationContaminationFingerprintManifest(collision)
        ).toThrow();
      }

      const semanticFixture = record(deepUnknown(manifest), "semantic fixture");
      const semanticScreened = record(semanticFixture.screened_package, "semantic screened");
      semanticScreened.domains = ["fictional-reworded-near-neighbor"];
      semanticScreened.canonical_task_body_sha256s = ["f".repeat(64)];
      const rebuilt = buildEvaluationCalibrationContaminationFingerprintManifestV1({
        inventory_binding: validateContract(
          EvaluationCalibrationContaminationFingerprintManifestV1Schema,
          manifest,
          "manifest"
        ).inventory_binding,
        prohibited_corpora: manifest.prohibited_corpora,
        screened_package: validateContract(
          EvaluationCalibrationContaminationFingerprintManifestV1Schema.properties.screened_package,
          semanticScreened,
          "semantic screened fixture"
        ),
      });
      expect(rebuilt.comparison_result).toBe("PASS_EXACT_METADATA_SCREEN");
      expect(rebuilt.semantic_overlap_claim).toBe("not_claimed_metadata_only");
    });
  });
}

describe("cross-arm Q2 schedule and Plan source-route controls", () => {
  it("uses identical fixture wires for every arm on each common task", () => {
    for (const base of [DECIDE_BASE, PLAN_BASE]) {
      const schedule = validateEvaluationCalibrationSchedule(readJson(`${base}/schedule.v1.json`));
      expect(validateContract(EvaluationCalibrationScheduleV1Schema, schedule, "schedule")).toEqual(
        schedule
      );
      const { bundle, controls } = controlsFor(base);
      const rows = array(bundle.all_arm_fixture_matrix, "all-arm matrix").map((value) =>
        record(value, "all-arm row")
      );
      expect(rows).toHaveLength(schedule.common_task_ids.length * schedule.arms.length * 5);
      for (const taskId of schedule.common_task_ids) {
        for (const caseKind of CASE_KINDS) {
          const matching = rows.filter(
            (row) => row.task_id === taskId && row.case_kind === caseKind
          );
          expect(matching).toHaveLength(3);
          expect(new Set(matching.map((row) => row.semantic_wire_sha256)).size).toBe(1);
          expect(new Set(matching.map((row) => row.arm_id))).toEqual(
            new Set(schedule.arms.map((arm) => arm.arm_id))
          );
          const controlId = text(matching[0]?.control_id, "matrix control ID");
          const control = controls.find((item) => item.control_id === controlId);
          expect(control).toBeDefined();
          if (control === undefined) throw new Error("matrix control missing");
          const wire = control.skill === "plan" ? control.semantic_review_wire : control.output;
          expect(matching[0]?.semantic_wire_sha256).toBe(calibrationCanonicalSha256(wire));
        }
      }
    }
  });

  it("keeps the Comet source route candidate-only and excludes it from Q2 comparisons", () => {
    const schedule = validateEvaluationCalibrationSchedule(
      readJson(`${PLAN_BASE}/schedule.v1.json`)
    );
    expect(schedule.common_task_ids).toHaveLength(4);
    expect(schedule.candidate_only_task_ids).toEqual(["c6p-comet"]);
    expect(schedule.task_arm_pairs.filter((row) => row.task_id === "c6p-comet")).toEqual([
      {
        arm_id: "plan",
        route: "candidate_only_product_integrity",
        task_id: "c6p-comet",
      },
    ]);
    const bundle = record(
      readJson(`${PLAN_BASE}/semantic-judge-controls.v1.json`),
      "Plan controls"
    );
    const candidateRows = array(
      bundle.candidate_only_integrity_matrix,
      "candidate-only matrix"
    ).map((value) => record(value, "candidate-only row"));
    expect(candidateRows).toHaveLength(5);
    expect(candidateRows.every((row) => row.arm_id === "plan")).toBe(true);
    expect(candidateRows.every((row) => boolean(row.q2_excluded, "q2 excluded"))).toBe(true);
    expect(
      candidateRows.every((row) => boolean(row.arm_comparison_excluded, "comparison excluded"))
    ).toBe(true);
  });

  it("admits exact source bytes for Echo and strips transport metadata from semantic evidence", () => {
    const cohort = validateEvaluationCalibrationCohort(readJson(`${PLAN_BASE}/cohort.v1.json`));
    const task = cohort.tasks.find((item) => item.task_id === "c6p-comet");
    if (task === undefined) throw new Error("Comet task missing");
    const source = fileBytes(
      "evals/calibration/plan-c6-v1/sources/luminar-comet-tile-notice.v1.txt"
    );
    expect(source.toString("utf8")).toContain("CIRRUS, EMBER, LUMEN, ORBIT, TIDE");
    expect(source.toString("utf8")).toContain("AURORA");
    expect(task.exact_inputs).toHaveLength(1);
    expect(task.exact_inputs[0]?.byte_length).toBe(source.byteLength);
    expect(task.exact_inputs[0]?.sha256).toBe(sha256Bytes(source));

    const projectionBundle = record(
      readJson(`${PLAN_BASE}/authorized-semantic-evidence-projections.v1.json`),
      "projection bundle"
    );
    const wrapper = record(
      array(projectionBundle.projections, "projections")[0],
      "projection wrapper"
    );
    const admission = validateContract(
      PlanCalibrationSourceAdmissionV1Schema,
      wrapper.source_admission,
      "source admission"
    );
    const storedProjection = validateContract(
      AuthorizedPlanSemanticEvidenceProjectionV1Schema,
      wrapper.projection,
      "stored semantic evidence projection"
    );
    const recomputed = projectAuthorizedPlanCalibrationSemanticEvidenceV1({
      task,
      admission,
      source_bytes: source,
      semantic_request: storedProjection.request,
    });
    expect(recomputed).toEqual(storedProjection);
    expect(wrapper.candidate_output_consumed).toBe(false);

    const semanticText = canonicalJson(storedProjection.request);
    expect(semanticText).toContain("CIRRUS");
    expect(semanticText).toContain("AURORA");
    expect(semanticText).not.toContain(admission.artifact_id);
    expect(semanticText).not.toContain(admission.source_sha256);
    expect(semanticText).not.toContain("input_artifact_ids");
    expect(semanticText).not.toContain("request_id");
    expect(semanticText).not.toContain("Echo");
    expect(semanticText).not.toContain("admission");
    expect(semanticText).not.toContain("transport");

    const drifted = Buffer.from(source);
    drifted[0] = drifted[0] === 0x46 ? 0x47 : 0x46;
    expect(() =>
      projectAuthorizedPlanCalibrationSemanticEvidenceV1({
        task,
        admission,
        source_bytes: drifted,
        semantic_request: storedProjection.request,
      })
    ).toThrow();

    const controls = controlsFor(PLAN_BASE).controls.filter(
      (control) => control.task_id === "c6p-comet"
    );
    for (const control of controls) {
      if (control.skill !== "plan") throw new Error("unexpected Decide control");
      const wireText = canonicalJson(control.semantic_review_wire);
      expect(wireText).not.toContain(admission.artifact_id);
      expect(wireText).not.toContain(admission.source_sha256);
      expect(wireText).not.toContain("input_artifact_ids");
      expect(wireText).not.toContain("Echo");
      expect(wireText).not.toContain("admission");
      expect(wireText).not.toContain("transport");
      expect(wireText).not.toContain("provenance");
      expect(wireText).not.toContain("arm_id");
      expect(wireText).not.toContain("performance");
    }
  });

  it("keeps candidate-visible Comet requests source-value-free before admission", () => {
    const cohort = validateEvaluationCalibrationCohort(readJson(`${PLAN_BASE}/cohort.v1.json`));
    const task = cohort.tasks.find((item) => item.task_id === "c6p-comet");
    if (task === undefined) throw new Error("Comet task missing");
    const candidateRequestText = canonicalJson(task.runtime_task);
    expect(candidateRequestText).not.toContain("CIRRUS");
    expect(candidateRequestText).not.toContain("EMBER");
    expect(candidateRequestText).not.toContain("LUMEN");
    expect(candidateRequestText).not.toContain("ORBIT");
    expect(candidateRequestText).not.toContain("TIDE");
    expect(candidateRequestText).not.toContain("AURORA");
    expect(task.routing.kind).toBe("candidate_only_product_integrity");
    if (task.routing.kind !== "candidate_only_product_integrity") {
      throw new Error("unexpected routing kind");
    }
    expect(task.routing.direct_baseline_forbidden).toBe(true);
    expect(task.routing.ablation_forbidden).toBe(true);
    expect(task.routing.arm_comparison_eligible).toBe(false);
  });

  it("binds Plan semantic clauses to the declared V2 clause set", () => {
    expect([...PLAN_SEMANTIC_CLAUSE_IDS]).toEqual([...PLAN_SEMANTIC_REVIEW_CLAUSE_IDS_V2]);
  });
});
