import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import type { ArtifactRef, JsonValue } from "../dist/contracts.js";
import {
  SCA_P11_REPAIRING_STATE,
  SCA_P11_REVIEWING_STATE,
  SCA_P11_REVIEWER_IDENTITY_ID,
  SCA_P11_REVIEWER_LINEAGE_ID,
  validateScaP11CognitivePayloadV1,
  validateScaP11RepairPatchV1,
  validateScaP11RepairRecordV1,
  validateScaP11ReportJsonV1,
  validateScaP11SemanticReviewV1,
  validateScaP11TerminalV1,
  validateScaP11ValidationRecordsV1,
} from "../dist/sca/p11-contracts.js";
import { driveP11, prepareP11, readJson, required, selectedRef } from "./sca-p11-harness.js";
import {
  stubScaP11RepairPatch,
  stubScaP11ReviewOutput,
  type ScaP11ReviewOutputInputV1,
} from "./sca-p11-lineage.js";
import { SCA_P11_QUALIFIED_CVSS_FIXTURE } from "../dist/sca/p11-scoring.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p11-repair-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

function refFor(
  artifacts: ArtifactStore,
  runId: string,
  phase: string,
  kind: string,
  operationId: string,
  version = 1
): ArtifactRef | null {
  return artifacts.refFor(runId, phase, null, kind, operationId, version);
}

const REPAIR_PAYLOAD_OP = "sca-p11-repair-payload-000001";
const CHILD_SUFFIX = "-000002";

function openItemReview(input: {
  readonly run_id: string;
  readonly report_ref: ArtifactRef;
  readonly payload: ScaP11ReviewOutputInputV1["payload"];
  readonly targetId: string;
}): Record<string, JsonValue> {
  return stubScaP11ReviewOutput({
    run_id: input.run_id,
    report_ref: input.report_ref,
    payload: input.payload,
    open_items: [
      {
        open_item_id: `p11openitem_${input.targetId.slice(0, 32)}`,
        target_id: input.targetId,
        severity: "actionable",
        evidence_refs: [],
        disposition: "retained-incomplete",
      },
    ],
  });
}

describe("SCA P11 bounded repair loop (positive admitted budget, provider-free)", () => {
  it("creates an immutable child revision that re-enters both checks and addresses the exact violation", () => {
    const artifacts = store();
    const runId = "run-p11-repair-success";
    const harness = prepareP11({
      store: artifacts,
      runId,
      reportPolicyComplete: true,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE, repair_budget: 1 },
    });
    const initial = harness.playbook.initialize(harness.run);
    const baseReportRef = selectedRef(harness.run, "sca-p11-report-json");
    const baseReport = validateScaP11ReportJsonV1(readJson(artifacts, baseReportRef));
    const baseFinding = required(baseReport.findings[0], "base finding");
    expect(baseFinding.complete).toBe(true);

    let repairs = 0;
    const terminal = validateScaP11TerminalV1(
      driveP11({
        harness,
        initial,
        review: ({ payload, revision, reportRef }) => {
          if (revision === 1) {
            return openItemReview({
              run_id: runId,
              report_ref: reportRef,
              payload: { ...payload, revision },
              targetId: baseFinding.finding_id,
            });
          }
          return stubScaP11ReviewOutput({
            run_id: runId,
            report_ref: reportRef,
            payload: { ...payload, revision },
          });
        },
        repair: ({ payload }) => {
          repairs += 1;
          return stubScaP11RepairPatch({
            run_id: runId,
            payload: {
              revision: payload.revision,
              payload_sha256: payload.payload_sha256,
              report_ref: payload.report_ref,
            },
            operations: [
              {
                operation: "rewrite_prose",
                target_id: baseFinding.finding_id,
                field: "description",
                value: "Repaired description grounded in the exact reconciled evidence.",
              },
            ],
          });
        },
      }).result
    );
    expect(repairs).toBe(1);
    expect(terminal.status).toBe("reporting_complete");
    expect(terminal.report_status).toBe("complete");
    for (const literal of [
      terminal.phase_gate_passed,
      terminal.release_eligible,
      terminal.campaign_complete,
      terminal.p12_release_authorized,
      terminal.release_adjudication_performed,
    ]) {
      expect(literal).toBe(false);
    }

    // History is append-only: the base revision is untouched and the child revision is a new object.
    const childReportRef = required(
      refFor(artifacts, runId, "SCA-P11", "sca-p11-report-json", "sca-p11-report-json", 2),
      "child report"
    );
    expect(childReportRef.artifact_id).not.toBe(baseReportRef.artifact_id);
    const baseAgain = validateScaP11ReportJsonV1(readJson(artifacts, baseReportRef));
    expect(baseAgain.revision).toBe(1);
    const childReport = validateScaP11ReportJsonV1(readJson(artifacts, childReportRef));
    expect(childReport.revision).toBe(2);

    // No finding was deleted or downgraded; only the addressed prose changed.
    const baseById = new Map(baseReport.findings.map((finding) => [finding.finding_id, finding]));
    expect(childReport.findings.length).toBe(baseReport.findings.length);
    for (const finding of childReport.findings) {
      const base = required(baseById.get(finding.finding_id), "retained finding");
      expect(finding.severity_token).toBe(base.severity_token);
      expect(finding.status).toBe(base.status);
      expect(finding.cwe_id).toBe(base.cwe_id);
      expect(finding.cwe_name).toBe(base.cwe_name);
      expect(finding.threat_model_id).toBe(base.threat_model_id);
      expect(finding.cvss_score).toBe(base.cvss_score);
      expect(finding.exception_shape).toBe(base.exception_shape);
    }
    expect(required(childReport.findings[0], "child finding").description).toContain("Repaired");

    // The immutable repair record binds the exact base ref/digest, the exact addressed violation, and
    // the child revision's actual deterministic-validation and semantic-review re-entry receipts.
    const repairRef = required(
      refFor(artifacts, runId, "SCA-P11", "sca-p11-repair-record", "sca-p11-repair-record", 1),
      "repair record"
    );
    const repair = validateScaP11RepairRecordV1(readJson(artifacts, repairRef));
    expect(repair.base_report_ref.artifact_id).toBe(baseReportRef.artifact_id);
    expect(repair.base_report_sha256).toBe(baseReportRef.content_digest);
    expect(repair.base_revision).toBe(1);
    expect(repair.revision).toBe(2);
    expect(repair.deleted_finding_ids).toEqual([]);
    const repairPayload = validateScaP11CognitivePayloadV1(
      readJson(
        artifacts,
        required(
          refFor(
            artifacts,
            runId,
            SCA_P11_REPAIRING_STATE,
            "sca-p11-cognitive-payload",
            REPAIR_PAYLOAD_OP
          ),
          "repair payload"
        )
      )
    );
    expect(repair.violations_addressed).toEqual([...repairPayload.repair_violations].sort());
    const childValidationRef = required(
      refFor(
        artifacts,
        runId,
        "SCA-P11",
        "sca-p11-validation-records",
        "sca-p11-validation-records",
        2
      ),
      "child validation"
    );
    const childReviewRef = required(
      refFor(
        artifacts,
        runId,
        SCA_P11_REVIEWING_STATE,
        "sca-p11-semantic-review",
        `sca-p11-semantic-review-record${CHILD_SUFFIX}`
      ),
      "child review"
    );
    expect(repair.reentry.deterministic_validation_ref.artifact_id).toBe(
      childValidationRef.artifact_id
    );
    expect(repair.reentry.deterministic_validation_passed).toBe(true);
    expect(repair.reentry.semantic_review_ref.artifact_id).toBe(childReviewRef.artifact_id);
    expect(repair.reentry.semantic_review_passed).toBe(true);
    // The immutable repair record binds the exact repairer identity and execution lineage.
    expect(repair.repairer_identity_id).toBe(SCA_P11_REVIEWER_IDENTITY_ID);
    expect(repair.repairer_lineage_id).toBe(SCA_P11_REVIEWER_LINEAGE_ID);

    // Both checks actually re-entered on the child revision and are bound to its exact digest.
    const childValidation = validateScaP11ValidationRecordsV1(
      readJson(artifacts, childValidationRef)
    );
    expect(childValidation.revision).toBe(2);
    expect(childValidation.deterministic_passed).toBe(true);
    expect(childValidation.semantic_passed).toBe(true);
    expect(childValidation.report_json_ref.artifact_id).toBe(childReportRef.artifact_id);
    const childReview = validateScaP11SemanticReviewV1(readJson(artifacts, childReviewRef));
    expect(childReview.revision).toBe(2);
    expect(childReview.report_sha256).toBe(childReportRef.content_digest);
    expect(childReview.reviewer_identity_id).toBe(SCA_P11_REVIEWER_IDENTITY_ID);
    expect(childReview.reviewer_lineage_id).toBe(SCA_P11_REVIEWER_LINEAGE_ID);
  });

  it("retains the best revision as INCOMPLETE on exhausted budget, naming the exact base violations", () => {
    const artifacts = store();
    const runId = "run-p11-repair-exhausted";
    const harness = prepareP11({
      store: artifacts,
      runId,
      reportPolicyComplete: false,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE, repair_budget: 1 },
    });
    const initial = harness.playbook.initialize(harness.run);
    const baseReportRef = selectedRef(harness.run, "sca-p11-report-json");
    const baseReport = validateScaP11ReportJsonV1(readJson(artifacts, baseReportRef));
    const baseFinding = required(baseReport.findings[0], "base finding");
    expect(baseFinding.complete).toBe(false);
    const exactViolations = baseReport.findings
      .filter((finding) => !finding.complete)
      .map((finding) => `${finding.finding_id}: ${finding.missing_material.join(", ")}`);

    const terminal = validateScaP11TerminalV1(
      driveP11({
        harness,
        initial,
        review: ({ payload, revision, reportRef }) =>
          openItemReview({
            run_id: runId,
            report_ref: reportRef,
            payload: { ...payload, revision },
            targetId: baseFinding.finding_id,
          }),
        repair: ({ payload }) =>
          stubScaP11RepairPatch({
            run_id: runId,
            payload: {
              revision: payload.revision,
              payload_sha256: payload.payload_sha256,
              report_ref: payload.report_ref,
            },
            operations: [
              {
                operation: "rewrite_prose",
                target_id: baseFinding.finding_id,
                field: "description",
                value: "A prose repair that cannot supply the missing metadata.",
              },
            ],
          }),
      }).result
    );
    expect(terminal.status).toBe("reporting_incomplete");
    expect(terminal.report_status).toBe("incomplete");

    const childReportRef = required(
      refFor(artifacts, runId, "SCA-P11", "sca-p11-report-json", "sca-p11-report-json", 2),
      "child report"
    );
    const childReport = validateScaP11ReportJsonV1(readJson(artifacts, childReportRef));
    expect(childReport.revision).toBe(2);
    expect(childReport.status).toBe("incomplete");
    expect(childReport.missing_sections.length).toBeGreaterThan(0);
    // The best (latest) revision is retained; no extra revision was fabricated on exhaustion.
    expect(
      refFor(artifacts, runId, "SCA-P11", "sca-p11-report-json", "sca-p11-report-json", 3)
    ).toBeNull();

    const childValidation = validateScaP11ValidationRecordsV1(
      readJson(
        artifacts,
        required(
          refFor(
            artifacts,
            runId,
            "SCA-P11",
            "sca-p11-validation-records",
            "sca-p11-validation-records",
            2
          ),
          "child validation"
        )
      )
    );
    expect(childValidation.incomplete).toBe(true);
    expect(childValidation.incomplete_marker?.startsWith("⚠ INCOMPLETE — missing:")).toBe(true);
    expect(
      childValidation.open_items.some((item) => item.disposition === "retained-incomplete")
    ).toBe(true);

    const repair = validateScaP11RepairRecordV1(
      readJson(
        artifacts,
        required(
          refFor(artifacts, runId, "SCA-P11", "sca-p11-repair-record", "sca-p11-repair-record", 1),
          "repair record"
        )
      )
    );
    expect(repair.violations_addressed).toEqual([...exactViolations].sort());
    expect(repair.deleted_finding_ids).toEqual([]);
  });

  it("structurally cannot delete, add, or downgrade a finding through a repair", () => {
    const baseReportRef: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${"b".repeat(64)}`,
      run_id: "run-p11-repair-shape",
      phase: "SCA-P11",
      branch_id: null,
      kind: "sca-p11-report-json",
      operation_id: "sca-p11-report-json",
      version: 1,
      producer: "host:sca-p11-candidate",
      media_type: "application/json",
      content_schema: { schema_id: "penny.sca-p11-report-json.v1", schema_version: 1 },
      byte_length: 1,
      content_digest: "c".repeat(64),
      store_ref: `artifact://sha256/${"c".repeat(64)}`,
    };
    const valid = stubScaP11RepairPatch({
      run_id: "run-p11-repair-shape",
      payload: {
        revision: 1,
        payload_sha256: "a".repeat(64),
        report_ref: baseReportRef,
      },
      operations: [
        {
          operation: "rewrite_prose",
          target_id: "sca11find_deadbeef",
          field: "description",
          value: "bounded prose",
        },
      ],
    });
    validateScaP11RepairPatchV1(valid);
    expect(() => validateScaP11RepairPatchV1({ ...valid, no_finding_removed: false })).toThrow();
    expect(() => validateScaP11RepairPatchV1({ ...valid, no_metadata_upgrade: false })).toThrow();
    expect(() =>
      validateScaP11RepairPatchV1({
        ...valid,
        operations: [
          { operation: "add_metadata", target_id: "x", field: "description", value: "y" },
        ],
      })
    ).toThrow();

    // The immutable repair record can never name a deleted finding.
    const repair = {
      schema_id: "penny.sca-p11-repair-record.v1",
      schema_version: 1,
      phase_id: "SCA-P11",
      run_id: "run-p11-repair-shape",
      base_report_ref: baseReportRef,
      base_report_sha256: baseReportRef.content_digest,
      base_revision: 1,
      revision: 2,
      repairer_identity_id: SCA_P11_REVIEWER_IDENTITY_ID,
      repairer_lineage_id: SCA_P11_REVIEWER_LINEAGE_ID,
      ordered_operations: [
        { operation: "rewrite_prose", target_id: "x", detail: "description: y" },
      ],
      violations_addressed: ["bounded prose repair"],
      reentry: {
        deterministic_validation_ref: baseReportRef,
        deterministic_validation_passed: true,
        semantic_review_ref: baseReportRef,
        semantic_review_passed: true,
      },
      deleted_finding_ids: [],
      repair_sha256: "d".repeat(64),
    };
    expect(() =>
      validateScaP11RepairRecordV1({ ...repair, deleted_finding_ids: ["sca11find_deadbeef"] })
    ).toThrow();
  });

  it("fails closed when a repair patch is not bound to the base revision", () => {
    const artifacts = store();
    const runId = "run-p11-repair-unbound";
    const harness = prepareP11({
      store: artifacts,
      runId,
      reportPolicyComplete: true,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE, repair_budget: 1 },
    });
    const initial = harness.playbook.initialize(harness.run);
    const baseReport = validateScaP11ReportJsonV1(
      readJson(artifacts, selectedRef(harness.run, "sca-p11-report-json"))
    );
    const baseFinding = required(baseReport.findings[0], "base finding");
    expect(() =>
      driveP11({
        harness,
        initial,
        review: ({ payload, revision, reportRef }) =>
          openItemReview({
            run_id: runId,
            report_ref: reportRef,
            payload: { ...payload, revision },
            targetId: baseFinding.finding_id,
          }),
        repair: ({ payload }) => {
          const patch = stubScaP11RepairPatch({
            run_id: runId,
            payload: {
              revision: payload.revision,
              payload_sha256: payload.payload_sha256,
              report_ref: payload.report_ref,
            },
            operations: [
              {
                operation: "rewrite_prose",
                target_id: baseFinding.finding_id,
                field: "description",
                value: "unbound",
              },
            ],
          });
          return { ...patch, report_sha256: "0".repeat(64), patch_sha256: "1".repeat(64) };
        },
      })
    ).toThrow();
  });
});
