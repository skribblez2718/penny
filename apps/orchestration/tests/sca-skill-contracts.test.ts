import { describe, expect, it } from "vitest";

import type { ArtifactStore } from "../src/artifact-store.js";
import type { ArtifactRef, ExecutionReceipt, RunIdentity } from "../src/contracts.js";
import { ReceiptAuthority, type UnsignedExecutionReceipt } from "../src/receipts.js";
import {
  SCA_MANDATORY_OBLIGATION_TYPES,
  SCA_PRODUCER_CONSUMER_TABLE,
  SCA_VERSION_FAMILY_TABLE,
  validateScaCompletion,
  validateScaDisposition,
  validateScaEvidenceProduct,
  validateScaReport,
  validateScaRequest,
  validateScaRunModel,
  validateScaSourceInventory,
  type ScaCompletionV1,
  type ScaCompletionValidationContext,
  type ScaContractValidationContext,
  type ScaDispositionV1,
  type ScaEvidenceProductV1,
  type ScaObligationV1,
  type ScaReportV1,
  type ScaRequestV1,
  type ScaRunModelV1,
  type ScaSourceInventoryV1,
} from "../src/skill-contracts/sca.js";
import {
  SCA_PHASE_ID,
  SCA_PROJECT_ID,
  SCA_RUN_ID,
  SCA_TENANT_ID,
  createValidScaDomainFixture,
  type ValidScaDomainFixture,
} from "./helpers/sca-domain-fixtures.js";

function persistContractArtifact(store: ArtifactStore, operationId: string): ArtifactRef {
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: SCA_RUN_ID,
      phase: "contract",
      branch_id: null,
      kind: "sca-contract",
      operation_id: operationId,
      version: 1,
      producer: "host:sca-contract-test",
      media_type: "application/json",
      parent_ref: null,
      upstream_refs: [],
    },
    content: `{"operation":"${operationId}"}`,
  });
}

interface ContractFixture {
  readonly context: ScaContractValidationContext;
  readonly completionContext: ScaCompletionValidationContext;
  readonly request: ScaRequestV1;
  readonly requestRef: ArtifactRef;
  readonly inventory: ScaSourceInventoryV1;
  readonly evidenceProduct: ScaEvidenceProductV1;
  readonly report: ScaReportV1;
  readonly runModel: ScaRunModelV1;
  readonly completion: ScaCompletionV1;
  readonly authority: ReceiptAuthority;
  readonly receipt: ExecutionReceipt;
}

function createObligation(
  fixture: ValidScaDomainFixture,
  obligationType: string,
  obligationClass: ScaObligationV1["obligation_class"] = "required_result"
): ScaObligationV1 {
  return {
    schema_id: "penny.sca-obligation.v1",
    schema_version: 1,
    tenant_id: SCA_TENANT_ID,
    project_id: SCA_PROJECT_ID,
    run_id: SCA_RUN_ID,
    source_snapshot_ref: fixture.sourceSnapshotRef,
    config_ref: fixture.configRef,
    provenance_ref: fixture.provenanceRef,
    obligation_id: `obligation-${obligationType}`,
    obligation_type: obligationType,
    obligation_class: obligationClass,
    phase_id: SCA_PHASE_ID,
    status: "pending",
    required_evidence_classes: ["obligation_disposition"],
    created_at: "2026-09-16T02:00:00.000000001Z",
  };
}

function signReceipt(
  authority: ReceiptAuthority,
  outputRef: ArtifactRef,
  changes: Partial<UnsignedExecutionReceipt> = {}
): ExecutionReceipt {
  const unsigned: UnsignedExecutionReceipt = {
    schema_version: 2,
    receipt_id: "receipt-sca-contract",
    run_id: SCA_RUN_ID,
    state_id: SCA_PHASE_ID,
    branch_id: null,
    agent: "skribble",
    attempt: 1,
    worker_id: "worker-sca-contract",
    executor: "pi-sdk",
    command: ["pi", "sca"],
    model: "deepseek-v4.1-flash:cloud",
    working_directory: "project-root",
    trust_profile: "hardened-untrusted",
    started_at: "2026-09-16T02:00:01Z",
    ended_at: "2026-09-16T02:00:02Z",
    exit_code: 0,
    output_digest: outputRef.content_digest,
    output_artifact_ref: outputRef,
    trusted_invocation_digest: "a".repeat(64),
    ...changes,
  };
  return authority.sign(unsigned);
}

function createContractFixture(fixture: ValidScaDomainFixture): ContractFixture {
  const authority = ReceiptAuthority.createEphemeral();
  const refs = {
    baseline: persistContractArtifact(fixture.store, "baseline-rule-bundle"),
    profile: persistContractArtifact(fixture.store, "profile"),
    authority: persistContractArtifact(fixture.store, "authority"),
    executionPolicy: persistContractArtifact(fixture.store, "execution-policy"),
    testNetworkPolicy: persistContractArtifact(fixture.store, "test-network-policy"),
    privacyPolicy: persistContractArtifact(fixture.store, "privacy-policy"),
    resourcePolicy: persistContractArtifact(fixture.store, "resource-policy"),
    promotionPolicy: persistContractArtifact(fixture.store, "promotion-policy"),
    inventory: persistContractArtifact(fixture.store, "inventory"),
    evidence: persistContractArtifact(fixture.store, "evidence-product"),
    raw: persistContractArtifact(fixture.store, "raw-evidence"),
    reconciliation: persistContractArtifact(fixture.store, "reconciliation"),
    markdown: persistContractArtifact(fixture.store, "report-markdown"),
    json: persistContractArtifact(fixture.store, "report-json"),
    sarif: persistContractArtifact(fixture.store, "report-sarif"),
    reportValidation: persistContractArtifact(fixture.store, "report-validation"),
    modelResolution: persistContractArtifact(fixture.store, "model-resolution"),
    request: persistContractArtifact(fixture.store, "request"),
  };
  const runIdentity: RunIdentity = {
    schema_version: 2,
    run_id: SCA_RUN_ID,
    session_id: "session-sca-contract",
    playbook: "sca",
    engine_owner: "typescript",
  };
  const obligations = SCA_MANDATORY_OBLIGATION_TYPES.map((type) => createObligation(fixture, type));
  const request: ScaRequestV1 = {
    schema_id: "penny.sca-request.v1",
    schema_version: 1,
    tenant_id: SCA_TENANT_ID,
    project_id: SCA_PROJECT_ID,
    run_id: SCA_RUN_ID,
    source_snapshot_ref: fixture.sourceSnapshotRef,
    config_ref: fixture.configRef,
    provenance_ref: fixture.provenanceRef,
    run_identity: runIdentity,
    source_snapshot_sha256: fixture.sourceSnapshotRef.content_digest,
    config_sha256: fixture.configRef.content_digest,
    provenance_sha256: fixture.provenanceRef.content_digest,
    baseline_rule_bundle_ref: refs.baseline,
    profile_ref: refs.profile,
    authority_ref: refs.authority,
    threat_context_ref: null,
    test_artifacts_dir: "sca-test-artifacts",
    policy_refs: {
      execution_policy_ref: refs.executionPolicy,
      test_network_policy_ref: refs.testNetworkPolicy,
      privacy_policy_ref: refs.privacyPolicy,
      resource_policy_ref: refs.resourcePolicy,
      promotion_policy_ref: refs.promotionPolicy,
    },
    obligations,
    requested_at: "2026-09-16T02:00:00.000000001Z",
  };
  const context: ScaContractValidationContext = {
    tenant_id: SCA_TENANT_ID,
    project_id: SCA_PROJECT_ID,
    run_id: SCA_RUN_ID,
    source_snapshot_ref: fixture.sourceSnapshotRef,
    config_ref: fixture.configRef,
    provenance_ref: fixture.provenanceRef,
    receipt_verifier: authority,
  };
  const inventory: ScaSourceInventoryV1 = {
    schema_id: "penny.sca-source-inventory.v1",
    schema_version: 1,
    tenant_id: SCA_TENANT_ID,
    project_id: SCA_PROJECT_ID,
    run_id: SCA_RUN_ID,
    source_snapshot_ref: fixture.sourceSnapshotRef,
    config_ref: fixture.configRef,
    provenance_ref: fixture.provenanceRef,
    inventory_ref: refs.inventory,
    file_count: 2,
    total_bytes: 64,
    languages: [
      { language_id: "typescript", file_count: 2, byte_count: 64, support_status: "supported" },
    ],
    status: "complete",
    truncated: false,
    failure_status: "none",
    recorded_at: "2026-09-16T02:00:03Z",
  };
  const evidenceProduct: ScaEvidenceProductV1 = {
    schema_id: "penny.sca-evidence-product.v1",
    schema_version: 1,
    tenant_id: SCA_TENANT_ID,
    project_id: SCA_PROJECT_ID,
    run_id: SCA_RUN_ID,
    source_snapshot_ref: fixture.sourceSnapshotRef,
    config_ref: fixture.configRef,
    provenance_ref: fixture.provenanceRef,
    evidence_product_id: "evidence-product-primary",
    obligation_id: obligations[0]?.obligation_id ?? "missing-obligation",
    phase_id: SCA_PHASE_ID,
    status: "qualified",
    evidence_ref: refs.evidence,
    raw_ref: refs.raw,
    qualification: {
      schema_id: "penny.sca-family-evidence-qualification.v1",
      schema_version: 1,
      family_id: "source-analysis",
      family_version: 1,
      backend_id: "fixture-backend",
      status: "qualified",
      supported_claim_classes: ["fact", "obligation_disposition"],
      source_snapshot_ref: fixture.sourceSnapshotRef,
      config_ref: fixture.configRef,
      provenance_ref: fixture.provenanceRef,
      complete: true,
      truncated: false,
      failure_status: "none",
      fidelity_note: "The fixture backend is qualified for the declared source analysis family.",
    },
    negative_coverage: null,
    recorded_at: "2026-09-16T02:00:04Z",
  };
  const report: ScaReportV1 = {
    schema_id: "penny.sca-report.v1",
    schema_version: 1,
    tenant_id: SCA_TENANT_ID,
    project_id: SCA_PROJECT_ID,
    run_id: SCA_RUN_ID,
    source_snapshot_ref: fixture.sourceSnapshotRef,
    config_ref: fixture.configRef,
    provenance_ref: fixture.provenanceRef,
    report_id: "report-primary",
    status: "validated",
    reconciliation_ref: refs.reconciliation,
    markdown_ref: refs.markdown,
    json_ref: refs.json,
    sarif_ref: refs.sarif,
    validation_ref: refs.reportValidation,
    validated_at: "2026-09-16T02:00:05Z",
  };
  const receipt = signReceipt(authority, refs.evidence);
  const runModel: ScaRunModelV1 = {
    schema_id: "penny.sca-run-model.v1",
    schema_version: 1,
    tenant_id: SCA_TENANT_ID,
    project_id: SCA_PROJECT_ID,
    run_id: SCA_RUN_ID,
    source_snapshot_ref: fixture.sourceSnapshotRef,
    config_ref: fixture.configRef,
    provenance_ref: fixture.provenanceRef,
    run_identity: runIdentity,
    status: "resolved",
    model_alias: "deepseek-flash",
    provider: "ollama",
    resolved_model: "deepseek-v4.1-flash:cloud",
    resolution_ref: refs.modelResolution,
    execution_receipts: [receipt],
    recorded_at: "2026-09-16T02:00:06Z",
  };
  const completedObligations: ScaObligationV1[] = obligations.map((obligation) => ({
    ...obligation,
    status: "completed",
  }));
  const dispositions: ScaDispositionV1[] = completedObligations.map((obligation) => ({
    schema_id: "penny.sca-disposition.v1",
    schema_version: 1,
    tenant_id: SCA_TENANT_ID,
    project_id: SCA_PROJECT_ID,
    run_id: SCA_RUN_ID,
    source_snapshot_ref: fixture.sourceSnapshotRef,
    config_ref: fixture.configRef,
    provenance_ref: fixture.provenanceRef,
    disposition_id: `disposition-${obligation.obligation_type}`,
    obligation_id: obligation.obligation_id,
    phase_id: obligation.phase_id,
    status: obligation.obligation_type === "execution_disposition" ? "not_needed" : "completed",
    evidence_refs: [refs.evidence],
    execution_receipt: null,
    rationale: "The host disposition is supported by the exact evidence product.",
    disposed_at: "2026-09-16T02:00:07Z",
  }));
  const completion: ScaCompletionV1 = {
    schema_id: "penny.sca-completion.v1",
    schema_version: 1,
    tenant_id: SCA_TENANT_ID,
    project_id: SCA_PROJECT_ID,
    run_id: SCA_RUN_ID,
    source_snapshot_ref: fixture.sourceSnapshotRef,
    config_ref: fixture.configRef,
    provenance_ref: fixture.provenanceRef,
    completion_id: "completion-primary",
    status: "complete",
    request_ref: refs.request,
    obligations: completedObligations,
    dispositions,
    report,
    run_model: runModel,
    unresolved_obligation_ids: [],
    completed_at: "2026-09-16T02:00:08Z",
  };
  return {
    context,
    completionContext: { ...context, request, request_ref: refs.request },
    request,
    requestRef: refs.request,
    inventory,
    evidenceProduct,
    report,
    runModel,
    completion,
    authority,
    receipt,
  };
}

describe("S-01 TypeBox SCA skill contract families", () => {
  it("round-trips every closed family and publishes version and producer-consumer tables", () => {
    using fixture = createValidScaDomainFixture();
    const values = createContractFixture(fixture);

    expect(validateScaRequest(values.request, values.context)).toEqual(values.request);
    expect(validateScaSourceInventory(values.inventory, values.context)).toEqual(values.inventory);
    expect(validateScaEvidenceProduct(values.evidenceProduct, values.context)).toEqual(
      values.evidenceProduct
    );
    expect(validateScaDisposition(values.completion.dispositions[0], values.context)).toEqual(
      values.completion.dispositions[0]
    );
    expect(validateScaReport(values.report, values.context)).toEqual(values.report);
    expect(validateScaRunModel(values.runModel, values.context)).toEqual(values.runModel);
    expect(validateScaCompletion(values.completion, values.completionContext)).toEqual(
      values.completion
    );
    expect(SCA_VERSION_FAMILY_TABLE).toHaveLength(8);
    expect(SCA_PRODUCER_CONSUMER_TABLE.map((row) => row.family)).toEqual(
      SCA_VERSION_FAMILY_TABLE.map((row) => row.family)
    );
  });

  it("requires every mandatory lane exactly once as required_result and pending", () => {
    using fixture = createValidScaDomainFixture();
    const values = createContractFixture(fixture);
    expect(() =>
      validateScaRequest(
        { ...values.request, obligations: values.request.obligations.slice(1) },
        values.context
      )
    ).toThrow(/mandatory obligation|at least|fewer than/u);
    expect(() =>
      validateScaRequest(
        {
          ...values.request,
          obligations: values.request.obligations.map((obligation) =>
            obligation.obligation_type === "deep_analysis"
              ? { ...obligation, obligation_class: "optional" }
              : obligation
          ),
        },
        values.context
      )
    ).toThrow(/deep_analysis.*required_result/u);
    expect(() =>
      validateScaRequest(
        {
          ...values.request,
          obligations: values.request.obligations.map((obligation) =>
            obligation.obligation_type === "report_validation"
              ? { ...obligation, status: "completed" }
              : obligation
          ),
        },
        values.context
      )
    ).toThrow(/begin pending/u);
  });

  it("rejects unknown, unsupported-version, oversized, wrong-ref, and cross-project requests", () => {
    using fixture = createValidScaDomainFixture();
    const values = createContractFixture(fixture);
    expect(() => validateScaRequest({ ...values.request, rogue: true }, values.context)).toThrow(
      /additional properties/u
    );
    expect(() =>
      validateScaRequest({ ...values.request, schema_version: 2 }, values.context)
    ).toThrow(/constant/u);
    expect(() =>
      validateScaRequest(
        { ...values.request, test_artifacts_dir: "x".repeat(4_097) },
        values.context
      )
    ).toThrow(/length|4096/u);
    expect(() =>
      validateScaRequest(
        { ...values.request, source_snapshot_ref: fixture.configRef },
        values.context
      )
    ).toThrow(/frozen binding|snapshot digest/u);
    expect(() =>
      validateScaRequest({ ...values.request, project_id: `prj_${"8".repeat(32)}` }, values.context)
    ).toThrow(/tenant_id\/project_id\/run_id/u);
  });

  it("rejects forged, wrong-run, and mismatched-output execution receipts", () => {
    using fixture = createValidScaDomainFixture();
    const values = createContractFixture(fixture);
    expect(() =>
      validateScaRunModel(
        {
          ...values.runModel,
          execution_receipts: [{ ...values.receipt, signature: `hmac-sha256:${"f".repeat(64)}` }],
        },
        values.context
      )
    ).toThrow(/invalid signature/u);

    const outputRef = values.receipt.output_artifact_ref;
    const wrongRun = signReceipt(values.authority, outputRef, { run_id: "run-other" });
    expect(() =>
      validateScaRunModel({ ...values.runModel, execution_receipts: [wrongRun] }, values.context)
    ).toThrow(/another run/u);

    const wrongDigest = signReceipt(values.authority, outputRef, { output_digest: "f".repeat(64) });
    expect(() =>
      validateScaRunModel({ ...values.runModel, execution_receipts: [wrongDigest] }, values.context)
    ).toThrow(/output_digest/u);
  });

  it("keeps unsupported and unavailable explicit rather than accepting generic success", () => {
    using fixture = createValidScaDomainFixture();
    const values = createContractFixture(fixture);
    expect(() =>
      validateScaReport({ ...values.report, status: "success" }, values.context)
    ).toThrow();
    expect(() =>
      validateScaEvidenceProduct({ ...values.evidenceProduct, status: "success" }, values.context)
    ).toThrow();
    expect(() =>
      validateScaCompletion(
        {
          ...values.completion,
          report: {
            ...values.report,
            status: "unavailable",
            validated_at: null,
          },
        },
        values.completionContext
      )
    ).toThrow(/validated report/u);
  });

  it("rejects required failure presented as complete", () => {
    using fixture = createValidScaDomainFixture();
    const values = createContractFixture(fixture);
    const deep = values.completion.obligations.find(
      (obligation) => obligation.obligation_type === "deep_analysis"
    );
    if (deep === undefined) throw new Error("deep obligation fixture is missing");
    expect(() =>
      validateScaCompletion(
        {
          ...values.completion,
          obligations: values.completion.obligations.map((obligation) =>
            obligation.obligation_id === deep.obligation_id
              ? { ...obligation, status: "failed" }
              : obligation
          ),
          dispositions: values.completion.dispositions.map((disposition) =>
            disposition.obligation_id === deep.obligation_id
              ? { ...disposition, status: "failed" }
              : disposition
          ),
        },
        values.completionContext
      )
    ).toThrow(/required_result.*not completed/u);
  });

  it("permits terminal evidenced attempt_and_report but rejects its omission", () => {
    using fixture = createValidScaDomainFixture();
    const base = createContractFixture(fixture);
    const attempted = createObligation(fixture, "supplemental_backend", "attempt_and_report");
    const request: ScaRequestV1 = {
      ...base.request,
      obligations: [...base.request.obligations, attempted],
    };
    const attemptDisposition: ScaDispositionV1 = {
      ...requireValue(base.completion.dispositions[0], "disposition template"),
      disposition_id: "disposition-supplemental-backend",
      obligation_id: attempted.obligation_id,
      status: "unavailable",
    };
    const completionContext: ScaCompletionValidationContext = {
      ...base.context,
      request,
      request_ref: base.requestRef,
    };
    const completion: ScaCompletionV1 = {
      ...base.completion,
      obligations: [...base.completion.obligations, { ...attempted, status: "unavailable" }],
      dispositions: [...base.completion.dispositions, attemptDisposition],
    };
    expect(validateScaCompletion(completion, completionContext)).toEqual(completion);
    expect(() =>
      validateScaCompletion(
        {
          ...completion,
          dispositions: completion.dispositions.map((disposition) =>
            disposition.obligation_id === attempted.obligation_id
              ? { ...disposition, status: "completed" }
              : disposition
          ),
        },
        completionContext
      )
    ).toThrow(/contradictory disposition/u);
    expect(() =>
      validateScaCompletion(
        {
          ...completion,
          obligations: completion.obligations.filter(
            (obligation) => obligation.obligation_id !== attempted.obligation_id
          ),
          dispositions: completion.dispositions.filter(
            (disposition) => disposition.obligation_id !== attempted.obligation_id
          ),
        },
        completionContext
      )
    ).toThrow(/every request obligation/u);
  });

  it("requires exact unresolved accounting and an explicit disposition for declared optional work", () => {
    using fixture = createValidScaDomainFixture();
    const base = createContractFixture(fixture);
    const optional = createObligation(fixture, "supplemental_optional", "optional");
    const request: ScaRequestV1 = {
      ...base.request,
      obligations: [...base.request.obligations, optional],
    };
    const completionContext: ScaCompletionValidationContext = {
      ...base.context,
      request,
      request_ref: base.requestRef,
    };
    const openOptional: ScaCompletionV1 = {
      ...base.completion,
      obligations: [...base.completion.obligations, optional],
    };
    expect(() => validateScaCompletion(openOptional, completionContext)).toThrow(
      /unresolved_obligation_ids/u
    );

    const optionalDisposition: ScaDispositionV1 = {
      ...requireValue(base.completion.dispositions[0], "disposition template"),
      disposition_id: "disposition-supplemental-optional",
      obligation_id: optional.obligation_id,
      status: "not_needed",
    };
    const closedOptional: ScaCompletionV1 = {
      ...openOptional,
      obligations: [...base.completion.obligations, { ...optional, status: "completed" }],
      dispositions: [...base.completion.dispositions, optionalDisposition],
    };
    expect(validateScaCompletion(closedOptional, completionContext)).toEqual(closedOptional);
  });

  it("refuses clean-complete inventory and qualification flags that hide failures", () => {
    using fixture = createValidScaDomainFixture();
    const values = createContractFixture(fixture);
    expect(() =>
      validateScaSourceInventory(
        { ...values.inventory, status: "complete", truncated: true },
        values.context
      )
    ).toThrow(/complete inventory/u);
    expect(() =>
      validateScaEvidenceProduct(
        {
          ...values.evidenceProduct,
          qualification: { ...values.evidenceProduct.qualification, truncated: true },
        },
        values.context
      )
    ).toThrow(/qualified evidence/u);
  });
});

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is missing`);
  return value;
}
