import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import {
  SCA_P11_DISCLOSURE_SCOPE_SCHEMA,
  SCA_P11_REPAIRING_STATE,
  SCA_P11_REVIEWING_STATE,
  validateScaP11CognitivePayloadV1,
  validateScaP11DisclosureAdmissionV1,
  validateScaP11DisclosureScopeV1,
  validateScaP11ReportJsonV1,
  validateScaP11TerminalV1,
  withP11Digest,
  type ScaP11DisclosureScopeV1,
} from "../dist/sca/p11-contracts.js";
import { createScaP11ReportingProductionCompositionV1 } from "../dist/sca/p11-production-host.js";
import { SCA_P11_QUALIFIED_CVSS_FIXTURE } from "../dist/sca/p11-scoring.js";
import {
  SCA_P11_PROVIDER_OPENING_ADAPTER,
  authorizeScaP11SerializedOpening,
  buildScaP11InlineOpeningAppendix,
} from "../dist/sca/p11-dispatch-guard.js";
import {
  asTerminal,
  driveP11,
  prepareP11,
  readJson,
  required,
  type P11Harness,
} from "./sca-p11-harness.js";
import {
  buildScaP11Lineage,
  persistScaP11FixtureQualification,
  stubScaP11RepairPatch,
  stubScaP11ReviewOutput,
} from "./sca-p11-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p11-production-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

function save(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly phase: string;
  readonly kind: string;
  readonly operationId: string;
  readonly schemaId: string;
  readonly value: unknown;
}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: "host:sca-p11-production-test",
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}

function openingFor(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly stateId: string;
  readonly payloadRef: ArtifactRef;
  readonly disclosureRef: ArtifactRef;
  readonly task: string;
  readonly padding?: string;
}): {
  readonly opening: string;
  readonly assignment: Parameters<typeof buildScaP11InlineOpeningAppendix>[0]["assignment"];
} {
  const assignment = {
    registration_name: "sca-p11-candidate",
    run_id: input.runId,
    state_id: input.stateId,
    branch_id: null,
    agent: "vera",
    task: input.task,
    input_artifacts: {
      schema_version: 2 as const,
      artifacts: [
        { slot: "cognitive_payload", ref: input.payloadRef },
        { slot: "disclosure_admission", ref: input.disclosureRef },
      ],
    },
  };
  const appendix = buildScaP11InlineOpeningAppendix({ store: input.store, assignment });
  const opening = `Host task preamble.\n\n${appendix}\n\nReturn the complete stage output\n${input.padding ?? ""}`;
  return { opening, assignment };
}

function allowedHarness(): P11Harness {
  const artifacts = store();
  const runId = "run-p11-production-allow";
  const harness = prepareP11({
    store: artifacts,
    runId,
    reportPolicyComplete: true,
    binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE, repair_budget: 1 },
  });
  const initial = harness.playbook.initialize(harness.run);
  const report = validateScaP11ReportJsonV1(
    readJson(
      artifacts,
      required(
        [...harness.run.selectedArtifacts]
          .reverse()
          .find((ref) => ref.kind === "sca-p11-report-json"),
        "base report"
      )
    )
  );
  const terminal = validateScaP11TerminalV1(
    driveP11({
      harness,
      initial,
      review: ({ payload, revision, reportRef }) =>
        stubScaP11ReviewOutput({
          run_id: runId,
          report_ref: reportRef,
          payload: { ...payload, revision },
          ...(revision === 1
            ? {
                open_items: [
                  {
                    open_item_id: "p11openitem_production_0001",
                    target_id: required(report.findings[0], "finding").finding_id,
                    severity: "actionable" as const,
                    evidence_refs: [] as ArtifactRef[],
                    disposition: "retained-incomplete" as const,
                  },
                ],
              }
            : {}),
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
              target_id: required(report.findings[0], "finding").finding_id,
              field: "description",
              value: "Repaired by the production composition test.",
            },
          ],
        }),
    }).result
  );
  expect(terminal.status).toBe("reporting_complete");
  return harness;
}

function deniedScope(storeRef: ArtifactStore, runId: string): ArtifactRef {
  const scope: ScaP11DisclosureScopeV1 = validateScaP11DisclosureScopeV1(
    withP11Digest(
      {
        schema_id: SCA_P11_DISCLOSURE_SCOPE_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P11" as const,
        required_model: {
          schema_version: 1 as const,
          alias: "deepseek-flash" as const,
          provider: "ollama" as const,
          model: "deepseek-v4.1-flash:cloud" as const,
          override: "ollama/deepseek-v4.1-flash:cloud" as const,
        },
        destination_class: "cloud" as const,
        purpose: "p11_report_semantic_review" as const,
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
        max_provider_calls: 8,
        decision: "deny" as const,
        blocker_codes: ["p11_scope_not_admitted"],
        issued_at: "2026-10-02T00:00:05.000Z",
      },
      "scope_sha256"
    )
  );
  return save({
    store: storeRef,
    runId,
    phase: "SCA-P11",
    kind: "sca-p11-disclosure-scope",
    operationId: "sca-p11-lineage-disclosure-scope-denied",
    schemaId: SCA_P11_DISCLOSURE_SCOPE_SCHEMA,
    value: scope,
  });
}

describe("SCA P11 production composition and guard-bound openings", () => {
  it("binds the injected scorer and the exact guard, and authorizes both review and repair openings", () => {
    const compositionStore = store();
    const composition = createScaP11ReportingProductionCompositionV1({
      store: compositionStore,
      scorer_qualification_ref: persistScaP11FixtureQualification(
        compositionStore,
        "run-p11-production-composition"
      ),
      repair_budget: 1,
    });
    expect(composition.provider_opening_guard_id).toBe("sca_p11_payload_disclosure_v1");
    expect(composition.scorer.qualification.scorer_id).toBe(
      SCA_P11_QUALIFIED_CVSS_FIXTURE.qualification.scorer_id
    );
    expect(composition.repair_budget).toBe(1);
    expect(composition.provider_opening_adapters.get("sca_p11_payload_disclosure_v1")).toBe(
      SCA_P11_PROVIDER_OPENING_ADAPTER
    );
    const worker = composition.registration.worker;
    if (worker.kind !== "catalog-agent") throw new Error("expected catalog-agent registration");
    for (const state of [SCA_P11_REVIEWING_STATE, SCA_P11_REPAIRING_STATE]) {
      const phase = required(worker.phases.get(state), `phase ${state}`);
      expect(phase.provider_opening_guard).toBe("sca_p11_payload_disclosure_v1");
      expect(phase.allowed_tools).toEqual([]);
      expect(phase.required_model?.override).toBe("ollama/deepseek-v4.1-flash:cloud");
    }

    const harness = allowedHarness();
    const artifacts = harness.artifacts;
    const runId = "run-p11-production-allow";
    const reviewPayloadRef = required(
      artifacts.refFor(
        runId,
        SCA_P11_REVIEWING_STATE,
        null,
        "sca-p11-cognitive-payload",
        "sca-p11-review-payload-000001",
        1
      ),
      "review payload"
    );
    const reviewDisclosureRef = required(
      artifacts.refFor(
        runId,
        SCA_P11_REVIEWING_STATE,
        null,
        "sca-p11-disclosure-admission",
        "sca-p11-review-disclosure-000001",
        1
      ),
      "review disclosure"
    );
    const repairPayloadRef = required(
      artifacts.refFor(
        runId,
        SCA_P11_REPAIRING_STATE,
        null,
        "sca-p11-cognitive-payload",
        "sca-p11-repair-payload-000001",
        1
      ),
      "repair payload"
    );
    const repairDisclosureRef = required(
      artifacts.refFor(
        runId,
        SCA_P11_REPAIRING_STATE,
        null,
        "sca-p11-disclosure-admission",
        "sca-p11-repair-disclosure-000001",
        1
      ),
      "repair disclosure"
    );

    const reviewOpening = openingFor({
      store: artifacts,
      runId,
      stateId: SCA_P11_REVIEWING_STATE,
      payloadRef: reviewPayloadRef,
      disclosureRef: reviewDisclosureRef,
      task: "Review the exact report assertions.",
    });
    const reviewAuthorization = authorizeScaP11SerializedOpening({
      store: artifacts,
      assignment: reviewOpening.assignment,
      opening: reviewOpening.opening,
    });
    const reviewPayload = validateScaP11CognitivePayloadV1(readJson(artifacts, reviewPayloadRef));
    expect(reviewAuthorization.payload_ref.artifact_id).toBe(reviewPayloadRef.artifact_id);

    const repairOpening = openingFor({
      store: artifacts,
      runId,
      stateId: SCA_P11_REPAIRING_STATE,
      payloadRef: repairPayloadRef,
      disclosureRef: repairDisclosureRef,
      task: "Propose a bounded repair for the exact violations.",
    });
    const repairAuthorization = authorizeScaP11SerializedOpening({
      store: artifacts,
      assignment: repairOpening.assignment,
      opening: repairOpening.opening,
    });
    const repairPayload = validateScaP11CognitivePayloadV1(readJson(artifacts, repairPayloadRef));
    expect(repairAuthorization.payload_ref.artifact_id).toBe(repairPayloadRef.artifact_id);
    expect(repairPayload.call_id).toBe("sca-p11-bounded-repair");
    expect(reviewPayload.call_id).toBe("sca-p11-semantic-review");
    expect(repairPayload.repair_violations.length).toBeGreaterThan(0);
  }, 30_000);

  it("refuses a denied disclosure scope before any provider call", () => {
    const artifacts = store();
    const runId = "run-p11-production-denied";
    const lineage = buildScaP11Lineage({
      store: artifacts,
      run_id: runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: true,
    });
    const deniedRef = deniedScope(artifacts, runId);
    const harness = prepareP11({
      store: artifacts,
      runId,
      lineage,
      binding: { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE, repair_budget: 1 },
      mutateConstraints: (constraints) => ({ ...constraints, p11_disclosure_scope_ref: deniedRef }),
    });
    const directive = harness.playbook.initialize(harness.run);
    // A denied scope finalizes non-positively without ever opening a provider call.
    expect(directive.action).toBe("incomplete");
    const terminal = validateScaP11TerminalV1(asTerminal(directive).result);
    expect(terminal.status).toBe("blocked_invalid");
    expect(terminal.blocker_codes).toContain("p11_review_disclosure_denied");
    expect(terminal.p12_transition_ref).toBeNull();
    expect(
      harness.run.selectedArtifacts.some((ref) => ref.kind === "sca-p11-semantic-review")
    ).toBe(false);
  }, 30_000);

  it("refuses mismatched and oversized serialized openings with zero provider calls", () => {
    const harness = allowedHarness();
    const artifacts = harness.artifacts;
    const runId = "run-p11-production-allow";
    const payloadRef = required(
      artifacts.refFor(
        runId,
        SCA_P11_REVIEWING_STATE,
        null,
        "sca-p11-cognitive-payload",
        "sca-p11-review-payload-000001",
        1
      ),
      "review payload"
    );
    const disclosureRef = required(
      artifacts.refFor(
        runId,
        SCA_P11_REVIEWING_STATE,
        null,
        "sca-p11-disclosure-admission",
        "sca-p11-review-disclosure-000001",
        1
      ),
      "review disclosure"
    );
    const task = "Review the exact report assertions.";
    const exact = openingFor({
      store: artifacts,
      runId,
      stateId: SCA_P11_REVIEWING_STATE,
      payloadRef,
      disclosureRef,
      task,
    });
    authorizeScaP11SerializedOpening({
      store: artifacts,
      assignment: exact.assignment,
      opening: exact.opening,
    });

    // A different declared state is not the exact guarded assignment.
    expect(() =>
      authorizeScaP11SerializedOpening({
        store: artifacts,
        assignment: { ...exact.assignment, state_id: SCA_P11_REPAIRING_STATE },
        opening: exact.opening,
      })
    ).toThrow();

    // A disclosure whose authorized refs differ from the serialized payload is refused.
    const disclosure = validateScaP11DisclosureAdmissionV1(readJson(artifacts, disclosureRef));
    const tamperedDisclosure = withP11Digest(
      {
        ...Object.fromEntries(
          Object.entries(disclosure).filter(([key]) => key !== "admission_sha256")
        ),
        authorized_refs: [payloadRef],
      },
      "admission_sha256"
    );
    const tamperedRef = save({
      store: artifacts,
      runId,
      phase: SCA_P11_REVIEWING_STATE,
      kind: "sca-p11-disclosure-admission",
      operationId: "sca-p11-review-disclosure-tampered",
      schemaId: "penny.sca-p11-disclosure-admission.v1",
      value: tamperedDisclosure,
    });
    // A disclosure whose authorized refs differ from the serialized payload is refused (here the
    // appendix construction itself fails closed before any opening can be authorized).
    expect(() =>
      openingFor({
        store: artifacts,
        runId,
        stateId: SCA_P11_REVIEWING_STATE,
        payloadRef,
        disclosureRef: tamperedRef,
        task,
      })
    ).toThrow();
    expect(() =>
      authorizeScaP11SerializedOpening({
        store: artifacts,
        assignment: {
          ...exact.assignment,
          input_artifacts: {
            schema_version: 2,
            artifacts: [
              { slot: "cognitive_payload", ref: payloadRef },
              { slot: "disclosure_admission", ref: tamperedRef },
            ],
          },
        },
        opening: exact.opening,
      })
    ).toThrow();

    // An oversized serialized opening exceeds the admitted post-framing limit.
    const oversized = openingFor({
      store: artifacts,
      runId,
      stateId: SCA_P11_REVIEWING_STATE,
      payloadRef,
      disclosureRef,
      task,
      padding: "x".repeat(800_000),
    });
    expect(() =>
      authorizeScaP11SerializedOpening({
        store: artifacts,
        assignment: oversized.assignment,
        opening: oversized.opening,
      })
    ).toThrow();
  }, 30_000);
});
