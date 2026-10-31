import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, JsonValue, OutputArtifactMetadata } from "../dist/contracts.js";
import {
  SCA_P11_DISCLOSURE_SCOPE_SCHEMA,
  SCA_P11_REPAIR_PURPOSE,
  SCA_P11_REVIEW_PURPOSE,
  SCA_P11_REVIEWER_IDENTITY_ID,
  SCA_P11_REVIEWER_LINEAGE_ID,
  validateScaP11ChecksumManifestV1,
  validateScaP11CognitivePayloadV1,
  validateScaP11DisclosureAdmissionV1,
  validateScaP11DisclosureScopeV1,
  validateScaP11GateV1,
  validateScaP11ObligationLedgerV1,
  validateScaP11ReconciliationV1,
  validateScaP11ReportJsonV1,
  validateScaP11ReportPolicyV1,
  validateScaP11ReportSarifV1,
  validateScaP11ScoringRecordsV1,
  validateScaP11SemanticReviewV1,
  validateScaP11TerminalV1,
  validateScaP11ValidationRecordsV1,
  withP11Digest,
  type ScaP11CognitivePayloadV1,
  type ScaP11ReportPolicyV1,
} from "../dist/sca/p11-contracts.js";
import {
  SCA_P11_REDACTION_MARKER,
  redactScaP11Sensitive,
  scanScaP11Sensitive,
  scaP11HasSensitiveContent,
} from "../dist/sca/p11-redaction.js";
import { validateScaP11Deterministic } from "../dist/sca/p11-validation.js";
import {
  SCA_P11_CVSS_IMPLEMENTATION_ID,
  SCA_P11_FIXTURE_CVSS_QUALIFICATION,
  SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS,
  SCA_P11_QUALIFIED_CVSS_FIXTURE,
  assertScaP11CvssScorerAuthority,
  buildScaP11CvssScorerFromQualification,
  buildScaP11CvssScorerQualificationV1,
  resolveScaP11CvssScorerAuthority,
} from "../dist/sca/p11-scoring.js";
import { createScaP11ReportingProductionCompositionV1 } from "../dist/sca/p11-production-host.js";
import { renderScaP11MarkdownV1, renderScaP11ReportJsonV1 } from "../dist/sca/p11-render.js";
import { buildScaP11DisclosureAdmissionV1 } from "../dist/sca/p11-review.js";
import {
  persistScaP11FixtureQualification,
  persistScaP11QualificationValue,
  stubScaP11RepairPatch,
  stubScaP11ReviewOutput,
} from "./sca-p11-lineage.js";
import {
  driveP11,
  prepareP11,
  readJson,
  required,
  selectedRef,
  type P11Harness,
} from "./sca-p11-harness.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p11-accept-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

function checkPassed(
  checks: readonly { readonly check_id: string; readonly passed: boolean }[],
  id: string
): boolean {
  return required(
    checks.find((check) => check.check_id === id),
    `check ${id}`
  ).passed;
}

interface CompleteRun {
  readonly harness: P11Harness;
  readonly terminal: ReturnType<typeof validateScaP11TerminalV1>;
  readonly report: ReturnType<typeof validateScaP11ReportJsonV1>;
  readonly sarif: ReturnType<typeof validateScaP11ReportSarifV1>;
  readonly reconciliation: ReturnType<typeof validateScaP11ReconciliationV1>;
  readonly scoring: ReturnType<typeof validateScaP11ScoringRecordsV1>;
  readonly markdown: string;
}

function completeRun(runId: string): CompleteRun {
  const artifacts = store();
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
  const report = validateScaP11ReportJsonV1(
    readJson(artifacts, selectedRef(harness.run, "sca-p11-report-json"))
  );
  const sarif = validateScaP11ReportSarifV1(
    readJson(artifacts, selectedRef(harness.run, "sca-p11-report-sarif"))
  );
  const reconciliation = validateScaP11ReconciliationV1(
    readJson(artifacts, selectedRef(harness.run, "sca-p11-reconciliation"))
  );
  const scoring = validateScaP11ScoringRecordsV1(
    readJson(artifacts, selectedRef(harness.run, "sca-p11-scoring-records"))
  );
  const markdown = artifacts
    .readById(selectedRef(harness.run, "sca-p11-report-markdown").artifact_id)
    .toString("utf8");
  return { harness, terminal, report, sarif, reconciliation, scoring, markdown };
}

function saveScope(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly purpose: typeof SCA_P11_REVIEW_PURPOSE | typeof SCA_P11_REPAIR_PURPOSE;
  readonly maxProviderCalls: number;
}): ArtifactRef {
  const scope = validateScaP11DisclosureScopeV1(
    withP11Digest(
      {
        schema_id: SCA_P11_DISCLOSURE_SCOPE_SCHEMA,
        schema_version: 1 as const,
        run_id: input.runId,
        phase_id: "SCA-P11" as const,
        required_model: {
          schema_version: 1 as const,
          alias: "deepseek-flash" as const,
          provider: "ollama" as const,
          model: "deepseek-v4.1-flash:cloud" as const,
          override: "ollama/deepseek-v4.1-flash:cloud" as const,
        },
        destination_class: "cloud" as const,
        purpose: input.purpose,
        allowed_data_classes: [
          "report_assertion_projections",
          "finding_evidence_excerpts",
          "source_pointer_projections",
        ] as const,
        provider_retention_status: "known" as const,
        provider_retention_days: 0,
        provider_logging_status: "disabled" as const,
        provider_logging_days: 0,
        provider_training_use: "prohibited" as const,
        max_payload_bytes_per_call: 786_432,
        max_provider_calls: input.maxProviderCalls,
        decision: "allow" as const,
        blocker_codes: [],
        issued_at: "2026-10-02T00:00:05.000Z",
      },
      "scope_sha256"
    )
  );
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: "SCA-P11",
    branch_id: null,
    kind: "sca-p11-disclosure-scope",
    operation_id: `sca-p11-acceptance-scope-${input.purpose}`,
    version: 1,
    producer: "host:sca-p11-acceptance",
    media_type: "application/json",
    content_schema: { schema_id: SCA_P11_DISCLOSURE_SCOPE_SCHEMA, schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  return input.store.persist({ metadata, content: canonicalJson(scope) });
}

function admissionRefs(
  payload: ReturnType<typeof validateScaP11CognitivePayloadV1>
): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  byId.set(payload.report_ref.artifact_id, payload.report_ref);
  byId.set(payload.reconciliation_ref.artifact_id, payload.reconciliation_ref);
  if (payload.scoring_records_ref !== null) {
    byId.set(payload.scoring_records_ref.artifact_id, payload.scoring_records_ref);
  }
  for (const assertion of payload.assertions) {
    for (const ref of assertion.evidence_allowlist) byId.set(ref.artifact_id, ref);
  }
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}

function reportPolicyWithSecret(harness: P11Harness, secret: string): ScaP11ReportPolicyV1 {
  const policyRef = required(harness.lineage.constraints.report_policy_ref, "report policy");
  const policy = validateScaP11ReportPolicyV1(readJson(harness.artifacts, policyRef));
  return validateScaP11ReportPolicyV1(
    withP11Digest(
      {
        schema_id: policy.schema_id,
        schema_version: 1 as const,
        phase_id: policy.phase_id,
        run_id: policy.run_id,
        statements: policy.statements,
        entries: policy.entries.map((entry) => ({ ...entry, description: secret })),
      },
      "policy_sha256"
    )
  );
}

function requireRef<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) throw new Error(`expected ${label} is absent`);
  return value;
}

describe("SCA P11 acceptance corpus (provider-free, deterministic)", () => {
  it("rejects a vacuous semantic review and incomplete assertion coverage", () => {
    const emptyReview = withP11Digest(
      {
        schema_id: "penny.sca-p11-semantic-review.v1",
        schema_version: 1 as const,
        run_id: "run-vacuous",
        phase_id: "SCA-P11" as const,
        call_id: "sca-p11-semantic-review" as const,
        role: "report_semantic_reviewer" as const,
        reviewer_identity_id: SCA_P11_REVIEWER_IDENTITY_ID,
        reviewer_lineage_id: SCA_P11_REVIEWER_LINEAGE_ID,
        revision: 1,
        report_ref: {
          schema_version: 2 as const,
          artifact_id: `art_${"a".repeat(64)}`,
          run_id: "run-vacuous",
          phase: "SCA-P11",
          branch_id: null,
          kind: "sca-p11-report-json",
          operation_id: "op",
          version: 1,
          producer: "host",
          media_type: "application/json",
          content_schema: { schema_id: "penny.sca-p11-report-json.v1", schema_version: 1 },
          byte_length: 1,
          content_digest: "a".repeat(64),
          store_ref: `artifact://sha256/${"a".repeat(64)}`,
        },
        report_sha256: "a".repeat(64),
        payload_sha256: "b".repeat(64),
        verdicts: [],
        open_items: [],
        gate_verdict_set: false as const,
        complete: true as const,
      },
      "review_sha256"
    );
    expect(() => validateScaP11SemanticReviewV1(emptyReview)).toThrow();

    const artifacts = store();
    const runId = "run-p11-accept-coverage";
    const harness = prepareP11({
      store: artifacts,
      runId,
      reportPolicyComplete: true,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE },
    });
    expect(() =>
      driveP11({
        harness,
        review: ({ payload, revision, reportRef }) => {
          const assignment = required(payload.assertions[0], "first assertion");
          return withP11Digest(
            {
              schema_id: "penny.sca-p11-semantic-review.v1",
              schema_version: 1,
              run_id: runId,
              phase_id: "SCA-P11",
              call_id: "sca-p11-semantic-review",
              role: "report_semantic_reviewer",
              reviewer_identity_id: SCA_P11_REVIEWER_IDENTITY_ID,
              reviewer_lineage_id: SCA_P11_REVIEWER_LINEAGE_ID,
              revision,
              report_ref: reportRef,
              report_sha256: reportRef.content_digest,
              payload_sha256: payload.payload_sha256,
              verdicts: [
                {
                  assertion_id: assignment.assertion_id,
                  target_id: assignment.target_id,
                  verdict: "supported",
                  reason: "Only one assertion resolved.",
                  evidence_refs: [...assignment.evidence_allowlist],
                  repair_candidate: null,
                },
              ],
              open_items: [],
              gate_verdict_set: false,
              complete: true,
            },
            "review_sha256"
          );
        },
      })
    ).toThrow();
  }, 30_000);

  it("redacts secrets and personal data before disclosure and across representations", () => {
    const secret = 'SCA_AUTH_TOKEN="sk-live-DEADBEEF0123456789" and admin@example.com';
    expect(SCA_P11_REDACTION_MARKER).toContain("REDACTED");
    const run = completeRun("run-p11-accept-redaction");
    const payloadRef = requireRef(selectedRef(run.harness.run, "sca-p11-cognitive-payload"));
    const payload = validateScaP11CognitivePayloadV1(readJson(run.harness.artifacts, payloadRef));
    const scopeRef = requireRef(run.harness.lineage.constraints.p11_disclosure_scope_ref);
    const scope = validateScaP11DisclosureScopeV1(readJson(run.harness.artifacts, scopeRef));
    const taintedPayload = { ...payload, repair_violations: [secret] };
    const admission = buildScaP11DisclosureAdmissionV1({
      run_id: run.harness.run.identity.run_id,
      call_id: "sca-p11-semantic-review",
      scope,
      scope_ref: scopeRef,
      payload_ref: payloadRef,
      payload: taintedPayload,
      authorized_refs: admissionRefs(payload),
    });
    expect(admission.decision).toBe("deny");
    expect(admission.secrets_embedded).toBe(true);
    expect(admission.personal_data_embedded).toBe(true);
    expect(admission.blocker_codes).toContain("p11_payload_secret_present");
    expect(validateScaP11DisclosureAdmissionV1(admission).decision).toBe("deny");

    const checks = validateScaP11Deterministic({
      report: run.report,
      sarif: run.sarif,
      reconciliation: run.reconciliation,
      markdown: `${run.markdown}\n${secret}\n`,
    });
    expect(checkPassed(checks, "redaction_clean")).toBe(false);

    const rendered = renderScaP11ReportJsonV1({
      run_id: run.harness.run.identity.run_id,
      revision: run.report.revision,
      lane: run.report.lane,
      status: "complete",
      source_snapshot_sha256: run.report.source_snapshot_sha256,
      rows: run.reconciliation.rows,
      policy: reportPolicyWithSecret(run.harness, secret),
      scoring: run.scoring,
      location_by_identity: new Map(),
    });
    expect(rendered.findings.length).toBeGreaterThan(0);
    for (const finding of rendered.findings) {
      expect(finding.description).toContain(SCA_P11_REDACTION_MARKER);
      expect(finding.description).not.toContain("sk-live-DEADBEEF");
    }
  }, 30_000);

  it("flips each deterministic one-defect check and keeps a byte-stable golden representation", () => {
    const run = completeRun("run-p11-accept-golden");
    expect(run.terminal.status).toBe("reporting_complete");
    expect(run.markdown).toBe(renderScaP11MarkdownV1(run.report));
    expect(renderScaP11MarkdownV1(run.report)).toBe(renderScaP11MarkdownV1(run.report));
    const finding = required(run.report.findings[0], "finding");

    const base = validateScaP11Deterministic({
      report: run.report,
      sarif: run.sarif,
      reconciliation: run.reconciliation,
      markdown: run.markdown,
    });
    for (const id of [
      "title_severity_equality",
      "five_section_order",
      "cwe_metadata_complete",
      "status_mapping_supported",
      "score_vector_nomenclature_consistency",
      "cross_output_set_equality",
      "no_dropped_finding",
      "redaction_clean",
      "host_path_absence",
      "threat_model_reference_valid",
      "zero_findings_incomplete",
    ]) {
      expect(checkPassed(base, id), `base check ${id}`).toBe(true);
    }

    const titleMismatch = run.markdown.replace(
      `### ${finding.finding_id} — ${finding.title} (${finding.severity_token})`,
      `### ${finding.finding_id} — ${finding.title} (Low)`
    );
    expect(
      checkPassed(
        validateScaP11Deterministic({
          report: run.report,
          sarif: run.sarif,
          reconciliation: run.reconciliation,
          markdown: titleMismatch,
        }),
        "title_severity_equality"
      )
    ).toBe(false);

    const reordered = run.markdown.replace("#### Remediation", "#### NotRemediation");
    expect(
      checkPassed(
        validateScaP11Deterministic({
          report: run.report,
          sarif: run.sarif,
          reconciliation: run.reconciliation,
          markdown: reordered,
        }),
        "five_section_order"
      )
    ).toBe(false);

    const missingCwe = {
      ...run.report,
      findings: run.report.findings.map((entry) => ({ ...entry, cwe_name: null })),
    };
    expect(
      checkPassed(
        validateScaP11Deterministic({
          report: missingCwe,
          sarif: run.sarif,
          reconciliation: run.reconciliation,
          markdown: run.markdown,
        }),
        "cwe_metadata_complete"
      )
    ).toBe(false);

    const unsupportedStatus = {
      ...run.report,
      findings: run.report.findings.map((entry) => ({ ...entry, status: "Remediated" as const })),
    };
    expect(
      checkPassed(
        validateScaP11Deterministic({
          report: unsupportedStatus,
          sarif: run.sarif,
          reconciliation: run.reconciliation,
          markdown: run.markdown,
        }),
        "status_mapping_supported"
      )
    ).toBe(false);

    const strayScore = {
      ...run.report,
      findings: run.report.findings.map((entry) => ({
        ...entry,
        exception_shape: "informational" as const,
        cvss_score: 7.5,
      })),
    };
    expect(
      checkPassed(
        validateScaP11Deterministic({
          report: strayScore,
          sarif: run.sarif,
          reconciliation: run.reconciliation,
          markdown: run.markdown,
        }),
        "score_vector_nomenclature_consistency"
      )
    ).toBe(false);

    const brokenThreat = {
      ...run.report,
      findings: run.report.findings.map((entry) => ({
        ...entry,
        threat_model_id: "not-a-threat-ref",
      })),
    };
    expect(
      checkPassed(
        validateScaP11Deterministic({
          report: brokenThreat,
          sarif: run.sarif,
          reconciliation: run.reconciliation,
          markdown: run.markdown,
        }),
        "threat_model_reference_valid"
      )
    ).toBe(false);

    expect(
      checkPassed(
        validateScaP11Deterministic({
          report: run.report,
          sarif: run.sarif,
          reconciliation: run.reconciliation,
          markdown: `${run.markdown}\n/home/operator/private/secret.php\n`,
        }),
        "host_path_absence"
      )
    ).toBe(false);

    const dropped = {
      ...run.reconciliation,
      rows: run.reconciliation.rows.filter((row) => !row.reportable),
    };
    expect(
      checkPassed(
        validateScaP11Deterministic({
          report: run.report,
          sarif: run.sarif,
          reconciliation: dropped,
          markdown: run.markdown,
        }),
        "no_dropped_finding"
      )
    ).toBe(false);

    const driftedSarif = { ...run.sarif, results: run.sarif.results.slice(1) };
    expect(
      checkPassed(
        validateScaP11Deterministic({
          report: run.report,
          sarif: driftedSarif,
          reconciliation: run.reconciliation,
          markdown: run.markdown,
        }),
        "cross_output_set_equality"
      )
    ).toBe(false);

    const zeroFindings = { ...run.report, findings: [], finding_count: 0 };
    expect(
      checkPassed(
        validateScaP11Deterministic({
          report: zeroFindings,
          sarif: run.sarif,
          reconciliation: run.reconciliation,
          markdown: run.markdown,
        }),
        "zero_findings_incomplete"
      )
    ).toBe(false);

    const jsonIds = run.report.findings.map((entry) => entry.finding_id).sort();
    const sarifIds = run.sarif.results.map((entry) => entry.finding_id).sort();
    const markdownIds = [...run.markdown.matchAll(/^### (sca11find_[a-f0-9]{64}) — /gmu)]
      .map((match) => match[1] ?? "")
      .sort();
    expect(sarifIds).toEqual(jsonIds);
    expect(markdownIds).toEqual(jsonIds);
  }, 30_000);

  it("binds scoring to an exact admitted CVSS qualification receipt and re-reads it for production", () => {
    expect(() => assertScaP11CvssScorerAuthority(SCA_P11_QUALIFIED_CVSS_FIXTURE)).not.toThrow();
    const references = SCA_P11_FIXTURE_CVSS_QUALIFICATION.reference_vectors;
    expect(references.length).toBeGreaterThanOrEqual(3);
    for (const reference of references) {
      expect(SCA_P11_QUALIFIED_CVSS_FIXTURE.score(reference.vector).score).toBe(reference.score);
    }
    const rebuilt = buildScaP11CvssScorerFromQualification({
      qualification: SCA_P11_FIXTURE_CVSS_QUALIFICATION,
      qualification_ref: null,
    });
    expect(rebuilt.qualification.qualification_sha256).toBe(
      SCA_P11_FIXTURE_CVSS_QUALIFICATION.qualification_sha256
    );
    expect(() =>
      assertScaP11CvssScorerAuthority({
        qualification: SCA_P11_FIXTURE_CVSS_QUALIFICATION,
        qualification_ref: null,
        score: () => ({ score: 1, nomenclature: "CVSS-B" }),
      })
    ).toThrow();

    const artifacts = store();
    const ref = persistScaP11FixtureQualification(artifacts, "run-p11-accept-scorer");
    const composition = createScaP11ReportingProductionCompositionV1({
      store: artifacts,
      scorer_qualification_ref: ref,
      repair_budget: 0,
    });
    expect(composition.scorer.qualification.qualification_sha256).toBe(
      SCA_P11_FIXTURE_CVSS_QUALIFICATION.qualification_sha256
    );
    expect(
      resolveScaP11CvssScorerAuthority({ store: artifacts, ref }).qualification.scorer_id
    ).toBe("penny.sca-p11.cvss-v4-fixture");
    const driftedRef: ArtifactRef = { ...ref, content_digest: "0".repeat(64) };
    expect(() =>
      createScaP11ReportingProductionCompositionV1({
        store: artifacts,
        scorer_qualification_ref: driftedRef,
        repair_budget: 0,
      })
    ).toThrow();
  }, 30_000);

  it("keeps a zero-confirmed report honest and incomplete rather than a stub success", () => {
    const run = completeRun("run-p11-accept-zero-confirmed");
    // A universe with no reportable record must render an honest incomplete report naming coverage,
    // not a complete stub success (`P11-R10`).
    const noReportable = run.reconciliation.rows.map((row) => ({
      ...row,
      reportable: false,
      report_status: null,
    }));
    const zero = renderScaP11ReportJsonV1({
      run_id: run.harness.run.identity.run_id,
      revision: 1,
      lane: "incomplete_closeout",
      status: "complete",
      source_snapshot_sha256: run.report.source_snapshot_sha256,
      rows: noReportable,
      policy: validateScaP11ReportPolicyV1(
        readJson(
          run.harness.artifacts,
          required(run.harness.lineage.constraints.report_policy_ref, "report policy")
        )
      ),
      scoring: run.scoring,
      location_by_identity: new Map(),
    });
    expect(zero.findings.length).toBe(0);
    expect(zero.status).toBe("incomplete");
    expect(zero.coverage_statement.length).toBeGreaterThan(0);
    const checks = validateScaP11Deterministic({
      report: zero,
      sarif: run.sarif,
      reconciliation: { ...run.reconciliation, rows: noReportable },
      markdown: renderScaP11MarkdownV1(zero),
    });
    expect(checkPassed(checks, "zero_findings_incomplete")).toBe(true);
  }, 30_000);

  it("enforces per-purpose disclosure and a total provider-call budget", () => {
    const artifacts = store();
    const runId = "run-p11-accept-purpose";
    const harness = prepareP11({
      store: artifacts,
      runId,
      reportPolicyComplete: true,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE, repair_budget: 1 },
      mutateConstraints: (constraints) => ({
        ...constraints,
        p11_repair_disclosure_scope_ref: constraints.p11_disclosure_scope_ref,
      }),
    });
    let repairs = 0;
    const terminal = validateScaP11TerminalV1(
      driveP11({
        harness,
        review: ({ payload, revision, reportRef }) =>
          stubScaP11ReviewOutput({
            run_id: runId,
            report_ref: reportRef,
            payload: { ...payload, revision },
            open_items: [
              {
                open_item_id: "p11openitem_accept_purpose",
                target_id: requireRef(payload.assertions[0]).target_id,
                severity: "actionable",
                evidence_refs: [],
                disposition: "retained-incomplete",
              },
            ],
          }),
        repair: () => {
          repairs += 1;
          throw new Error("repair must not open under a review-only disclosure scope");
        },
      }).result
    );
    expect(repairs).toBe(0);
    expect(terminal.status).toBe("reporting_incomplete");
    expect(harness.run.selectedArtifacts.some((ref) => ref.kind === "sca-p11-repair-record")).toBe(
      false
    );

    const budgetArtifacts = store();
    const budgetRunId = "run-p11-accept-budget";
    const reviewScope = saveScope({
      store: budgetArtifacts,
      runId: budgetRunId,
      purpose: SCA_P11_REVIEW_PURPOSE,
      maxProviderCalls: 0,
    });
    const budgetHarness = prepareP11({
      store: budgetArtifacts,
      runId: budgetRunId,
      reportPolicyComplete: true,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE },
      mutateConstraints: (constraints) => ({
        ...constraints,
        p11_disclosure_scope_ref: reviewScope,
        p11_repair_disclosure_scope_ref: null,
      }),
    });
    const budgetTerminal = validateScaP11TerminalV1(
      driveP11({
        harness: budgetHarness,
        review: () => {
          throw new Error("provider call must never open once the admitted total budget is used");
        },
      }).result
    );
    expect(budgetTerminal.status).toBe("blocked_invalid");
    expect(budgetTerminal.blocker_codes).toContain("p11_provider_call_budget_exhausted");
  }, 30_000);

  it("applies a correct_status_note repair to the child revision", () => {
    const artifacts = store();
    const runId = "run-p11-accept-status-note";
    const harness = prepareP11({
      store: artifacts,
      runId,
      reportPolicyComplete: true,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE, repair_budget: 1 },
    });
    const initial = harness.playbook.initialize(harness.run);
    const baseReportRef = selectedRef(harness.run, "sca-p11-report-json");
    const baseReport = validateScaP11ReportJsonV1(readJson(artifacts, baseReportRef));
    const baseFinding = requireRef(baseReport.findings[0], "finding");
    const terminal = validateScaP11TerminalV1(
      driveP11({
        harness,
        initial,
        review: ({ payload, revision, reportRef }) =>
          revision === 1
            ? stubScaP11ReviewOutput({
                run_id: runId,
                report_ref: reportRef,
                payload: { ...payload, revision },
                open_items: [
                  {
                    open_item_id: "p11openitem_status_note",
                    target_id: baseFinding.finding_id,
                    severity: "actionable",
                    evidence_refs: [],
                    disposition: "retained-incomplete",
                  },
                ],
              })
            : stubScaP11ReviewOutput({
                run_id: runId,
                report_ref: reportRef,
                payload: { ...payload, revision },
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
                operation: "correct_status_note",
                target_id: baseFinding.finding_id,
                field: "status_note",
                value: "Corrected status note grounded in the exact reconciled evidence.",
              },
            ],
          }),
      }).result
    );
    expect(terminal.status).toBe("reporting_complete");
    const childReportRef = requireRef(
      artifacts.refFor(runId, "SCA-P11", null, "sca-p11-report-json", "sca-p11-report-json", 2)
    );
    const childReport = validateScaP11ReportJsonV1(readJson(artifacts, childReportRef));
    const childFinding = requireRef(childReport.findings[0], "child finding");
    expect(childFinding.status_note).toContain("Corrected status note");
    expect(childFinding.status).toBe(baseFinding.status);
  }, 30_000);

  it("derives an exhaustive obligation ledger and a checksum manifest with honest final closure", () => {
    const run = completeRun("run-p11-accept-ledger");
    const obligation = validateScaP11ObligationLedgerV1(
      readJson(run.harness.artifacts, selectedRef(run.harness.run, "sca-p11-obligation-ledger"))
    );
    expect(obligation.entry_count).toBeGreaterThan(10);
    expect(obligation.entries.some((entry) => entry.obligation_id.startsWith("SCA-OBL-P10-"))).toBe(
      true
    );
    expect(
      obligation.entries.some((entry) => entry.obligation_id === "SCA-OBL-P12-ACCEPTANCE")
    ).toBe(true);
    for (const requiredId of [
      "SCA-OBL-P11-ACCEPTANCE",
      "SCA-OBL-REPORT-MARKDOWN",
      "SCA-OBL-REPORT-VALIDATION-RECORDS",
    ]) {
      expect(
        requireRef(obligation.entries.find((entry) => entry.obligation_id === requiredId)).covered
      ).toBe(true);
    }
    expect(obligation.uncovered_obligation_ids).not.toContain("SCA-OBL-P11-ACCEPTANCE");

    const checksum = validateScaP11ChecksumManifestV1(
      readJson(run.harness.artifacts, selectedRef(run.harness.run, "sca-p11-checksum-manifest"))
    );
    expect(checksum.artifact_count).toBe(checksum.artifacts.length);
    expect(checksum.artifact_count).toBeGreaterThan(6);
    expect(checksum.final_closure.closed).toBe(false);
    expect(checksum.final_closure.deferred_artifact_kinds).toContain("sca-p11-checksum-manifest");
    for (const entry of checksum.artifacts) {
      const stored = run.harness.artifacts.refById(entry.artifact_id);
      expect(stored?.content_digest).toBe(entry.content_digest);
      expect(stored?.byte_length).toBe(entry.byte_length);
    }
  }, 30_000);

  it("blocks pass_ready when the semantic review proves nothing (insufficient, empty, or foreign evidence)", () => {
    type VerdictChoice = {
      readonly verdict: "supported" | "insufficient" | "refuted";
      readonly evidence_refs: readonly ArtifactRef[];
    };
    const buildReview = (input: {
      readonly runId: string;
      readonly payload: ScaP11CognitivePayloadV1;
      readonly revision: number;
      readonly reportRef: ArtifactRef;
      readonly verdictOf: () => VerdictChoice;
    }): Record<string, JsonValue> =>
      withP11Digest(
        {
          schema_id: "penny.sca-p11-semantic-review.v1",
          schema_version: 1,
          run_id: input.runId,
          phase_id: "SCA-P11",
          call_id: "sca-p11-semantic-review",
          role: "report_semantic_reviewer",
          reviewer_identity_id: SCA_P11_REVIEWER_IDENTITY_ID,
          reviewer_lineage_id: SCA_P11_REVIEWER_LINEAGE_ID,
          revision: input.revision,
          report_ref: input.reportRef,
          report_sha256: input.reportRef.content_digest,
          payload_sha256: input.payload.payload_sha256,
          verdicts: input.payload.assertions.map((assertion) => {
            const chosen = input.verdictOf();
            return {
              assertion_id: assertion.assertion_id,
              target_id: assertion.target_id,
              verdict: chosen.verdict,
              reason: "Stub reviewer for the semantic-pass regression.",
              evidence_refs: [...chosen.evidence_refs],
              repair_candidate: null,
            };
          }),
          open_items: [],
          gate_verdict_set: false,
          complete: true,
        },
        "review_sha256"
      );

    const foreignRef: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${"f".repeat(64)}`,
      run_id: "run-p11-accept-foreign",
      phase: "SCA-P11",
      branch_id: null,
      kind: "sca-p11-report-json",
      operation_id: "foreign-evidence",
      version: 1,
      producer: "host:attacker",
      media_type: "application/json",
      content_schema: { schema_id: "penny.sca-p11-report-json.v1", schema_version: 1 },
      byte_length: 1,
      content_digest: "f".repeat(64),
      store_ref: `artifact://sha256/${"f".repeat(64)}`,
    };

    const scenarios: readonly {
      readonly runId: string;
      readonly verdictOf: () => VerdictChoice;
    }[] = [
      {
        runId: "run-p11-accept-insufficient",
        verdictOf: () => ({ verdict: "insufficient", evidence_refs: [] }),
      },
      {
        runId: "run-p11-accept-trust-me",
        verdictOf: () => ({ verdict: "supported", evidence_refs: [] }),
      },
      {
        runId: "run-p11-accept-foreign",
        verdictOf: () => ({ verdict: "supported", evidence_refs: [foreignRef] }),
      },
    ];

    for (const scenario of scenarios) {
      const artifacts = store();
      const harness = prepareP11({
        store: artifacts,
        runId: scenario.runId,
        reportPolicyComplete: true,
        binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE },
      });
      const terminal = validateScaP11TerminalV1(
        driveP11({
          harness,
          review: ({ payload, revision, reportRef }) =>
            buildReview({
              runId: scenario.runId,
              payload,
              revision,
              reportRef,
              verdictOf: scenario.verdictOf,
            }),
        }).result
      );
      expect(terminal.status, scenario.runId).not.toBe("reporting_complete");
      const gate = validateScaP11GateV1(
        readJson(artifacts, selectedRef(harness.run, "sca-p11-gate"))
      );
      expect(gate.verdict, scenario.runId).toBe("pass_blocked");
      expect(gate.semantic_review_passed, scenario.runId).toBe(false);
      expect(gate.no_unresolved_required_item, scenario.runId).toBe(false);
      const validation = validateScaP11ValidationRecordsV1(
        readJson(artifacts, selectedRef(harness.run, "sca-p11-validation-records"))
      );
      expect(validation.semantic_passed, scenario.runId).toBe(false);
      expect(
        validation.open_items.some(
          (item) => item.severity === "blocking" && item.disposition === "retained-incomplete"
        ),
        scenario.runId
      ).toBe(true);
    }
  }, 60_000);

  it("rejects a fabricated CVSS receipt that rewrites a published reference score", () => {
    const nineThree = SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS.find(
      (entry) => entry.score === 9.3
    );
    expect(nineThree).toBeDefined();
    const nineThreeVector = requireRef(nineThree, "9.3 reference vector").vector;

    const fabricated = withP11Digest(
      {
        schema_id: "penny.sca-p11-scorer-qualification.v1" as const,
        schema_version: 1 as const,
        scorer_id: "attacker.scorer",
        implementation_id: SCA_P11_CVSS_IMPLEMENTATION_ID,
        build_sha256: SCA_P11_FIXTURE_CVSS_QUALIFICATION.build_sha256,
        official_references: [...SCA_P11_FIXTURE_CVSS_QUALIFICATION.official_references],
        reference_vectors: SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS.map((entry) =>
          entry.vector === nineThreeVector ? { ...entry, score: 1.1 } : { ...entry }
        ),
      },
      "qualification_sha256"
    );

    expect(() =>
      assertScaP11CvssScorerAuthority({
        qualification: fabricated,
        qualification_ref: null,
        score: SCA_P11_QUALIFIED_CVSS_FIXTURE.score,
      })
    ).toThrow(/pinned official FIRST corpus/u);
    expect(() =>
      buildScaP11CvssScorerFromQualification({ qualification: fabricated, qualification_ref: null })
    ).toThrow();

    const artifacts = store();
    const ref = persistScaP11QualificationValue(artifacts, "run-p11-accept-fabricated", fabricated);
    expect(() => resolveScaP11CvssScorerAuthority({ store: artifacts, ref })).toThrow();
    expect(() =>
      createScaP11ReportingProductionCompositionV1({
        store: artifacts,
        scorer_qualification_ref: ref,
        repair_budget: 0,
      })
    ).toThrow();

    // The pinned corpus is the only truth: the admitted implementation reproduces it and fails
    // closed for any vector outside it.
    expect(SCA_P11_FIXTURE_CVSS_QUALIFICATION.reference_vectors).toEqual([
      ...SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS,
    ]);
    expect(SCA_P11_QUALIFIED_CVSS_FIXTURE.score(nineThreeVector).score).toBe(9.3);
    expect(() =>
      SCA_P11_QUALIFIED_CVSS_FIXTURE.score(
        "CVSS:4.0/AV:L/AC:H/AT:P/PR:L/UI:P/VC:L/VI:L/VA:L/SC:N/SI:N/SA:N"
      )
    ).toThrow(/fails closed/u);
    // A receipt that names an unadmitted scorer implementation is refused outright.
    expect(() =>
      buildScaP11CvssScorerQualificationV1({
        scorer_id: "attacker.scorer",
        implementation_id: "attacker.implementation",
        official_references: [...SCA_P11_FIXTURE_CVSS_QUALIFICATION.official_references],
        reference_vectors: [...SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS],
      })
    ).toThrow(/unadmitted implementation/u);
  }, 30_000);

  it("detects the previously-missed secret key-name variants through one shared engine", () => {
    const missed = [
      "SECRET_KEY = abcdefghijklmnopqrstuvwxyz123456",
      "aws_secret_access_key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'",
      'AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
      "secret-key: abcdefghijklmnopqrstuvwxyz123456",
      "secret.key=abcdefghijklmnopqrstuvwxyz123456",
      "client secret = abcdefghijklmnopqrstuvwxyz123456",
      "export Secret_Key=abcdefghijklmnopqrstuvwxyz123456",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
      "AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF==",
      "opaque_blob = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ];
    for (const sample of missed) {
      const scan = scanScaP11Sensitive(sample);
      expect(scan.secrets, sample).toBe(true);
      expect(redactScaP11Sensitive(sample), sample).toContain(SCA_P11_REDACTION_MARKER);
      // One engine: the has-content helper, the scan, and the renderer agree on every surface.
      expect(scaP11HasSensitiveContent(sample), sample).toBe(true);
    }
    for (const keyName of [
      "SECRET_KEY",
      "secret-key",
      "Secret.Key",
      "secret key",
      "aws_secret_access_key",
      "AWSSecretAccessKey",
      "clientSecret",
      "API_KEY",
    ]) {
      expect(
        scanScaP11Sensitive(`${keyName}=abcdefghijklmnopqrstuvwxyz123456`).secrets,
        keyName
      ).toBe(true);
    }
    // Benign lookalikes must not be swept up, or a clean report would be marked incomplete.
    for (const benign of [
      "severity_token = Critical",
      "base_severity_token = Critical",
      "schema_id = penny.sca-p11-report-json.v1",
      "monkey = banana",
      "count = 3",
    ]) {
      expect(scanScaP11Sensitive(benign).secrets, benign).toBe(false);
    }
  }, 30_000);

  it("redacts the missed secret forms across representations and denies a tainted disclosure", () => {
    const secret = "SECRET_KEY = abcdefghijklmnopqrstuvwxyz123456";
    const run = completeRun("run-p11-accept-redaction-missed");
    const payloadRef = requireRef(selectedRef(run.harness.run, "sca-p11-cognitive-payload"));
    const payload = validateScaP11CognitivePayloadV1(readJson(run.harness.artifacts, payloadRef));
    const scopeRef = requireRef(run.harness.lineage.constraints.p11_disclosure_scope_ref);
    const scope = validateScaP11DisclosureScopeV1(readJson(run.harness.artifacts, scopeRef));
    const admission = buildScaP11DisclosureAdmissionV1({
      run_id: run.harness.run.identity.run_id,
      call_id: "sca-p11-semantic-review",
      scope,
      scope_ref: scopeRef,
      payload_ref: payloadRef,
      payload: { ...payload, repair_violations: [secret] },
      authorized_refs: admissionRefs(payload),
    });
    expect(admission.decision).toBe("deny");
    expect(admission.secrets_embedded).toBe(true);
    expect(admission.blocker_codes).toContain("p11_payload_secret_present");

    const rendered = renderScaP11ReportJsonV1({
      run_id: run.harness.run.identity.run_id,
      revision: run.report.revision,
      lane: run.report.lane,
      status: "complete",
      source_snapshot_sha256: run.report.source_snapshot_sha256,
      rows: run.reconciliation.rows,
      policy: reportPolicyWithSecret(run.harness, secret),
      scoring: run.scoring,
      location_by_identity: new Map(),
    });
    expect(rendered.findings.length).toBeGreaterThan(0);
    for (const finding of rendered.findings) {
      expect(finding.description).toContain(SCA_P11_REDACTION_MARKER);
      expect(finding.description).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    }

    // The deterministic `redaction_clean` check (which the gate predicate consumes) rejects the
    // missed form across the rendered representation surfaces.
    const checks = validateScaP11Deterministic({
      report: run.report,
      sarif: run.sarif,
      reconciliation: run.reconciliation,
      markdown: `${run.markdown}\n${secret}\n`,
    });
    expect(checkPassed(checks, "redaction_clean")).toBe(false);
    expect(scaP11HasSensitiveContent(`${run.markdown}\n${secret}\n`)).toBe(true);
  }, 30_000);
});
