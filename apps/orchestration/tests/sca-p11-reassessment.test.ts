import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import {
  SCA_P11_REASSESSMENT_SCHEMA,
  validateScaP11ReassessmentV1,
  validateScaP11ReconciliationV1,
  validateScaP11ReportJsonV1,
  validateScaP11ReportV1,
  validateScaP11TerminalV1,
  validateScaP11ValidationRecordsV1,
  withP11Digest,
  type ScaP11ReassessmentTriggerCodeV1,
} from "../dist/sca/p11-contracts.js";
import { SCA_P11_QUALIFIED_CVSS_FIXTURE } from "../dist/sca/p11-scoring.js";
import {
  asTerminal,
  driveP11,
  prepareP11,
  readJson,
  required,
  selectedRef,
  type P11PayloadContext,
} from "./sca-p11-harness.js";
import { buildScaP11Lineage, stubScaP11ReviewOutput } from "./sca-p11-lineage.js";
import { validateScaP09ReconciliationLedgerV1 } from "../dist/sca/p09-contracts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p11-reassess-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

function save(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly kind: string;
  readonly operationId: string;
  readonly schemaId: string;
  readonly value: unknown;
}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: "SCA-P11",
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: "host:sca-p11-reassess-test",
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}

interface PriorRun {
  readonly reportRef: ArtifactRef;
  readonly validationRef: ArtifactRef;
  readonly latestRevision: number;
}

/** Run a complete provider-free revision-1 P11 reporting pass and return its authoritative refs. */
function runPriorPass(artifacts: ArtifactStore, runId: string): PriorRun {
  const harness = prepareP11({
    store: artifacts,
    runId,
    reportPolicyComplete: true,
    binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE },
  });
  const terminal = validateScaP11TerminalV1(
    driveP11({
      harness,
      review: ({ payload, revision, reportRef }) =>
        stubScaP11ReviewOutput({
          run_id: runId,
          report_ref: reportRef,
          payload: { ...payload, revision },
        }),
    }).result
  );
  expect(terminal.status).toBe("reporting_complete");
  const reportRef = selectedRef(harness.run, "sca-p11-report");
  return {
    reportRef,
    validationRef: required(
      artifacts.refFor(
        runId,
        "SCA-P11",
        null,
        "sca-p11-validation-records",
        "sca-p11-validation-records",
        1
      ),
      "prior validation"
    ),
    latestRevision: validateScaP11ReportV1(readJson(artifacts, reportRef)).latest_revision,
  };
}

function buildReassessment(input: {
  readonly artifacts: ArtifactStore;
  readonly runId: string;
  readonly prior: PriorRun;
  readonly triggerCodes: readonly ScaP11ReassessmentTriggerCodeV1[];
  readonly stimulusRefs: readonly ArtifactRef[];
  readonly invalidatedEvidenceRefs: readonly ArtifactRef[];
}): ArtifactRef {
  const value = validateScaP11ReassessmentV1(
    withP11Digest(
      {
        schema_id: SCA_P11_REASSESSMENT_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        run_id: input.runId,
        prior_report_ref: input.prior.reportRef,
        prior_report_sha256: input.prior.reportRef.content_digest,
        prior_validation_ref: input.prior.validationRef,
        prior_validation_sha256: input.prior.validationRef.content_digest,
        trigger_codes: [...input.triggerCodes],
        stimulus_refs: [...input.stimulusRefs],
        invalidated_evidence_refs: [...input.invalidatedEvidenceRefs],
      },
      "reassessment_sha256"
    )
  );
  return save({
    store: input.artifacts,
    runId: input.runId,
    kind: "sca-p11-reassessment",
    operationId: "sca-p11-reassessment",
    schemaId: SCA_P11_REASSESSMENT_SCHEMA,
    value,
  });
}

const REVIEW = (runId: string) => (context: P11PayloadContext) =>
  stubScaP11ReviewOutput({
    run_id: runId,
    report_ref: context.reportRef,
    payload: { ...context.payload, revision: context.revision },
  });

describe("SCA P11 reassessment, prior-report chain, and invalidation", () => {
  it("appends an exact parent-bound revision for changed evidence and preserves prior support", () => {
    const artifacts = store();
    const prior = runPriorPass(artifacts, "run-p11-reassess-changed-prior");
    const runId = "run-p11-reassess-changed";
    const lineage = buildScaP11Lineage({
      store: artifacts,
      run_id: runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: true,
    });
    const reassessmentRef = buildReassessment({
      artifacts,
      runId,
      prior,
      triggerCodes: ["new_evidence"],
      stimulusRefs: [prior.reportRef],
      invalidatedEvidenceRefs: [],
    });
    const reassessment = validateScaP11ReassessmentV1(readJson(artifacts, reassessmentRef));
    expect(reassessment.prior_report_sha256).toBe(prior.reportRef.content_digest);
    expect(reassessment.prior_validation_sha256).toBe(prior.validationRef.content_digest);

    const harness = prepareP11({
      store: artifacts,
      runId,
      lineage,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE },
      reassessmentRef,
      priorReportRef: prior.reportRef,
    });
    const terminal = validateScaP11TerminalV1(driveP11({ harness, review: REVIEW(runId) }).result);
    expect(terminal.status).toBe("reporting_complete");

    const reportRef = selectedRef(harness.run, "sca-p11-report");
    const projection = validateScaP11ReportV1(readJson(artifacts, reportRef));
    expect(projection.latest_revision).toBe(prior.latestRevision + 1);
    // Gapless append: the reassessed run's reconciliation is revision 2 and re-derives the same set.
    const reconciliation = validateScaP11ReconciliationV1(
      readJson(artifacts, selectedRef(harness.run, "sca-p11-reconciliation"))
    );
    expect(reconciliation.revision).toBe(2);
    const reportJson = validateScaP11ReportJsonV1(
      readJson(artifacts, selectedRef(harness.run, "sca-p11-report-json"))
    );
    expect(reportJson.revision).toBe(2);
    expect(reportJson.findings.length).toBeGreaterThan(0);
    const validation = validateScaP11ValidationRecordsV1(
      readJson(artifacts, selectedRef(harness.run, "sca-p11-validation-records"))
    );
    expect(validation.revision).toBe(2);
    // The prior revision remains untouched in the shared store.
    expect(validateScaP11ReportV1(readJson(artifacts, prior.reportRef)).latest_revision).toBe(
      prior.latestRevision
    );
  });

  it("invalidates named evidence: the affected record is retained but never reported", () => {
    const artifacts = store();
    const prior = runPriorPass(artifacts, "run-p11-reassess-invalidate-prior");
    const runId = "run-p11-reassess-invalidate";
    const lineage = buildScaP11Lineage({
      store: artifacts,
      run_id: runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: true,
    });
    const ledger = validateScaP09ReconciliationLedgerV1(
      readJson(artifacts, required(lineage.constraints.p09_reconciliation_ledger_ref, "ledger"))
    );
    const target = required(
      ledger.items.find((item) => item.p08_disposition_ref !== null),
      "disposed ledger item"
    );
    const invalidated = required(target.p08_disposition_ref, "target disposition ref");
    const reassessmentRef = buildReassessment({
      artifacts,
      runId,
      prior,
      triggerCodes: ["invalidated_evidence"],
      stimulusRefs: [invalidated],
      invalidatedEvidenceRefs: [invalidated],
    });

    const harness = prepareP11({
      store: artifacts,
      runId,
      lineage,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE },
      reassessmentRef,
      priorReportRef: prior.reportRef,
    });
    const terminal = validateScaP11TerminalV1(driveP11({ harness, review: REVIEW(runId) }).result);
    expect(terminal.status).toBe("reporting_incomplete");
    expect(terminal.report_status).toBe("incomplete");

    const reconciliation = validateScaP11ReconciliationV1(
      readJson(artifacts, selectedRef(harness.run, "sca-p11-reconciliation"))
    );
    const invalidatedRow = required(
      reconciliation.rows.find((row) => row.identity === target.identity),
      "invalidated reconciliation row"
    );
    expect(invalidatedRow.reportable).toBe(false);
    expect(invalidatedRow.report_status).toBeNull();
    expect(invalidatedRow.missing_material.join(" ")).toContain("invalidated");
    expect(reconciliation.retained_non_reportable_count).toBeGreaterThan(0);

    const reportJson = validateScaP11ReportJsonV1(
      readJson(artifacts, selectedRef(harness.run, "sca-p11-report-json"))
    );
    expect(reportJson.findings.some((finding) => finding.identity === target.identity)).toBe(false);
    // The invalidated evidence is retained, not silently dropped, and no finding was fabricated.
    expect(reconciliation.record_count).toBe(ledger.items.length + 1);
  });

  it("replays a no-op reassessment byte-for-byte without a duplicate revision", () => {
    const artifacts = store();
    const prior = runPriorPass(artifacts, "run-p11-reassess-noop-prior");
    const runId = "run-p11-reassess-noop";
    const lineage = buildScaP11Lineage({
      store: artifacts,
      run_id: runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: true,
    });
    const reassessmentRef = buildReassessment({
      artifacts,
      runId,
      prior,
      triggerCodes: ["new_evidence"],
      stimulusRefs: [prior.reportRef],
      invalidatedEvidenceRefs: [],
    });
    const harness = prepareP11({
      store: artifacts,
      runId,
      lineage,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE },
      reassessmentRef,
      priorReportRef: prior.reportRef,
    });
    const first = validateScaP11TerminalV1(driveP11({ harness, review: REVIEW(runId) }).result);

    // Replaying the exact same admitted inputs from a fresh context is a no-op: byte-identical.
    const requestRef = required(harness.run.selectedArtifacts[0], "request ref");
    const replayRun = RunContext.create({
      identity: harness.run.identity,
      goal: "replay",
      constraints: {},
      projectRoot: harness.run.projectRoot,
      trustProfile: "hardened-untrusted",
      maxSteps: 64,
      initialArtifacts: [requestRef],
    });
    const replayPlaybook = harness.playbook;
    const replayDirective = replayPlaybook.initialize(replayRun);
    const replay = validateScaP11TerminalV1(
      replayDirective.action === "invoke_agent"
        ? driveP11({
            harness: { ...harness, run: replayRun },
            initial: replayDirective,
            review: REVIEW(runId),
          }).result
        : asTerminal(replayDirective).result
    );
    expect(canonicalJson(replay)).toBe(canonicalJson(first));
    // No revision 3 was fabricated by the replay.
    expect(
      artifacts.refFor(runId, "SCA-P11", null, "sca-p11-report-json", "sca-p11-report-json", 2)
    ).toBeNull();
  });

  it("fails closed on a conflicting or foreign reassessment replay", () => {
    const artifacts = store();
    const prior = runPriorPass(artifacts, "run-p11-reassess-conflict-prior");
    const runId = "run-p11-reassess-conflict";
    const lineage = buildScaP11Lineage({
      store: artifacts,
      run_id: runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: true,
    });

    // Digest-conflicting reassessment bytes are rejected by the closed validator.
    expect(() =>
      validateScaP11ReassessmentV1({
        schema_id: SCA_P11_REASSESSMENT_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P11",
        run_id: runId,
        prior_report_ref: prior.reportRef,
        prior_report_sha256: "0".repeat(64),
        prior_validation_ref: prior.validationRef,
        prior_validation_sha256: prior.validationRef.content_digest,
        trigger_codes: ["new_evidence"],
        stimulus_refs: [prior.reportRef],
        invalidated_evidence_refs: [],
        reassessment_sha256: "0".repeat(64),
      })
    ).toThrow();

    const validReassessment = buildReassessment({
      artifacts,
      runId,
      prior,
      triggerCodes: ["new_evidence"],
      stimulusRefs: [prior.reportRef],
      invalidatedEvidenceRefs: [],
    });

    // A declared prior report that disagrees with the reassessment fails closed before any output.
    const mismatch = prepareP11({
      store: artifacts,
      runId,
      lineage,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE },
      reassessmentRef: validReassessment,
      priorReportRef: required(
        artifacts.refFor(
          runId,
          "SCA-P11",
          null,
          "sca-p11-scoring-policy",
          "sca-p11-lineage-scoring-policy",
          1
        ),
        "foreign prior ref"
      ),
    });
    expect(() => mismatch.playbook.initialize(mismatch.run)).toThrow();

    // A reassessment naming absent stimulus evidence is a foreign replay and fails closed.
    const absentStimulus = buildReassessment({
      artifacts,
      runId: "run-p11-reassess-conflict-absent",
      prior,
      triggerCodes: ["new_evidence"],
      stimulusRefs: [
        {
          schema_version: 2,
          artifact_id: `art_${"9".repeat(64)}`,
          run_id: runId,
          phase: "SCA-P11",
          branch_id: null,
          kind: "sca-p11-report",
          operation_id: "absent",
          version: 1,
          producer: "host:absent",
          media_type: "application/json",
          content_schema: { schema_id: "penny.sca-p11-report.v1", schema_version: 1 },
          byte_length: 1,
          content_digest: "9".repeat(64),
          store_ref: `artifact://sha256/${"9".repeat(64)}`,
        },
      ],
      invalidatedEvidenceRefs: [],
    });
    const absent = prepareP11({
      store: artifacts,
      runId: "run-p11-reassess-conflict-absent",
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE },
      reassessmentRef: absentStimulus,
      priorReportRef: prior.reportRef,
    });
    expect(() => absent.playbook.initialize(absent.run)).toThrow();
  });
});
