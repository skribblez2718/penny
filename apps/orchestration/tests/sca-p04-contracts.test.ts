import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { CATALOG_WORKER_CONTINUITY_OPENING_MAX_CHARACTERS } from "../dist/model-client.js";
import { resolvePlaybook } from "../dist/playbooks/registry.js";
import { buildScaInitialObligationLedgerV2 } from "../dist/sca/p01-contracts.js";
import {
  SCA_P03_QUERY_IDS,
  ScaP03BaselineQueryAggregateV2Schema,
} from "../dist/sca/p03-contracts.js";
import { SCA_P03_CANDIDATE_REGISTRATION } from "../dist/sca/p03-playbook.js";
import {
  ScaP04AdmissionError,
  buildScaP04SelectionPopulation,
  validateScaP04AcceptedP03CohortV1,
  validateScaP04AcceptedP03QueryPagesV1,
  type ScaP04PopulationAdmissionV1,
} from "../dist/sca/p04-admission.js";
import {
  SCA_P04_SERIALIZED_OPENING_MAX_BYTES,
  SCA_P04_SERIALIZED_OPENING_RESERVE_BYTES,
  assertScaP04SerializedOpeningSize,
} from "../dist/sca/p04-dispatch-guard.js";
import {
  SCA_P04_CANDIDATE_PLAYBOOK_NAME,
  buildScaP04CognitivePayload,
  buildScaP04DisclosureAdmission,
  type ScaP04CognitiveAdmissionV1,
  type ScaP04DisclosurePolicyAdmissionV1,
} from "../dist/sca/p04-playbook.js";
import {
  SCA_P04_REQUIRED_MODEL,
  SCA_P04_SCANNER_SPECIALIST,
  SCA_P04_UNDERDETECTED_SPECIALIST,
  scaP04StableItemId,
  validateScaP04ImplementationIdentityV1,
  validateScaP04SpecialistResultV1,
  validateScaP04SelectionPopulationV1,
  withSelfDigest,
  type ScaP04SelectionPopulationV1,
} from "../dist/sca/p04-contracts.js";

function ref(label: string, overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  const digest = sha256(label);
  const metadata = {
    schema_version: 2 as const,
    run_id: "run-upstream",
    phase: "SCA-P03",
    branch_id: null,
    kind: label,
    operation_id: label,
    version: 1,
    producer: "host:test",
    media_type: "application/json",
    byte_length: label.length,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
    ...overrides,
  };
  const identity = {
    branch_id: metadata.branch_id,
    kind: metadata.kind,
    operation_id: metadata.operation_id,
    phase: metadata.phase,
    run_id: metadata.run_id,
    version: metadata.version,
  };
  return {
    ...metadata,
    artifact_id: overrides.artifact_id ?? `art_${sha256(canonicalJson(identity))}`,
  };
}

type PopulationAdmissionFixture = ScaP04PopulationAdmissionV1 &
  ScaP04CognitiveAdmissionV1 &
  ScaP04DisclosurePolicyAdmissionV1;

function populationAdmission(payloadLimit = 1_000_000): PopulationAdmissionFixture {
  const snapshotRef = ref("source-snapshot");
  const manifestRef = ref("source-manifest");
  const evidenceRef = ref("p02-normalized-evidence");
  const dependencyEvidenceRef = ref("p02-normalized-dependency-evidence");
  const graphRef = ref("graph-component");
  const pageRef = ref("query-page");
  const modelPolicyRef = ref("model-policy");
  return {
    request: {
      run_id: "run-p04",
    },
    runtime_policy: {
      max_population_items: 100,
      max_payload_bytes_per_call: payloadLimit,
      max_selected_items: 50,
    },
    p01_request: {
      source: { snapshot_ref: snapshotRef },
      model_data_policy_ref: modelPolicyRef,
    },
    source_snapshot: {
      file_manifest_ref: manifestRef,
    },
    source_file_manifest: {
      files: [
        { path: "src/alerted.ts", content_sha256: "1".repeat(64) },
        { path: "src/no-alert.ts", content_sha256: "2".repeat(64) },
      ],
    },
    p02_evidence_manifest: {
      operations: [
        { normalized_evidence_ref: evidenceRef },
        { normalized_evidence_ref: dependencyEvidenceRef },
      ],
    },
    p02_evidence: [
      {
        operation_kind: "semgrep_js_ts",
        normalized_observations: [
          {
            observation_id: `scaobs_${"3".repeat(64)}`,
            analyzer_id: "semgrep-js-ts",
            correlation_id: `p02corr_${"4".repeat(64)}`,
            duplicate_group_id: null,
            category: "security-rule",
            subject: "alerted surface",
            path: "src/alerted.ts",
            start_line: 9,
            advisory_id: null,
            raw_record_ids: [`p02raw_${"5".repeat(64)}`],
          },
        ],
        correlations: [],
      },
      {
        operation_kind: "osv_npm",
        normalized_observations: [
          {
            observation_id: `scaobs_${"7".repeat(64)}`,
            analyzer_id: "dependency-npm",
            correlation_id: `p02corr_${"8".repeat(64)}`,
            duplicate_group_id: null,
            category: "dependency-advisory",
            subject: "pkg:npm/example@1.0.0",
            path: "package-lock.json",
            start_line: null,
            advisory_id: "GHSA-test",
            raw_record_ids: [`p02raw_${"9".repeat(64)}`],
          },
        ],
        correlations: [],
      },
    ],
    graph_support: { entries: [] },
    candidate_packet: {
      candidates: [
        {
          candidate_id: `p03c_${"6".repeat(64)}`,
          claim: "unsupported_surface",
          disposition: "unresolved",
          reason_code: "relationship_unproven",
          graph_component_sha256: graphRef.content_digest,
          source_snapshot_sha256: snapshotRef.content_digest,
          query_release_sha256: sha256("query-release"),
          partition: "javascript_typescript",
          query_id: "p03.control-guard.v1",
          path: "src/no-alert.ts",
          stable_locator: "src/no-alert.ts:guard:17",
          summary: "Graph-derived guard surface",
          graph_component_ref: graphRef,
          page_ref: pageRef,
        },
      ],
    },
    model_data_policy: {
      payload_limit_bytes: payloadLimit,
      destination_class: "cloud",
      provider_retention_status: "known",
      provider_retention_days: 0,
      provider_training_use: "prohibited",
      data_classes: [
        { data_class: "source-code", treatment: "allow-minimized" },
        { data_class: "scanner-evidence", treatment: "allow-minimized" },
        { data_class: "dependency-coordinates", treatment: "allow-minimized" },
        { data_class: "secrets", treatment: "deny" },
        { data_class: "personal-data", treatment: "deny" },
      ],
    },
  };
}

function populationFixture(payloadLimit = 1_000_000): {
  admission: PopulationAdmissionFixture;
  population: ScaP04SelectionPopulationV1;
  populationRef: ArtifactRef;
} {
  const admission = populationAdmission(payloadLimit);
  const cohortRef = ref("accepted-cohort", { run_id: "run-p04", phase: "SCA-P04" });
  const population = buildScaP04SelectionPopulation({ admission, accepted_cohort_ref: cohortRef });
  const populationRef = ref("selection-population", {
    run_id: "run-p04",
    phase: "SCA-P04",
    content_digest: population.population_sha256,
  });
  return { admission, population, populationRef };
}

function boundCommon() {
  return {
    tenant_id: "tenant",
    project_id: "project",
    run_id: "run-p03",
    phase_id: "SCA-P03",
    p01_binding_sha256: "1".repeat(64),
    p02_binding_sha256: "2".repeat(64),
    p03_runtime_binding_sha256: "3".repeat(64),
    source_snapshot_ref: ref("snapshot"),
    source_snapshot_sha256: "4".repeat(64),
  };
}

function acceptedCohortFixture() {
  const common = boundCommon();
  const requestRef = ref("p03-request");
  const oracleRef = ref("source-oracle");
  const receiptRef = ref("source-oracle-validation");
  const entryRef = ref("p03-entry");
  const qualificationRef = ref("p03-qualification");
  const graphRef = ref("p03-graph");
  const supportRef = ref("p03-support");
  const aggregateRef = ref("p03-aggregate");
  const candidateRef = ref("p03-candidates");
  const coverageRef = ref("p03-coverage");
  const evidenceRef = ref("p03-evidence");
  const ledgerRef = ref("p03-ledger");
  const zeroRef = ref("p03-zero");
  const gateRef = ref("p03-gate");
  const transition = {
    schema_id: "penny.sca-p03-p04-transition.v2",
    ...common,
    p03_request_ref: requestRef,
    source_oracle_ref: oracleRef,
    source_oracle_validation_ref: receiptRef,
    p02_m1_ref: ref("p02-m1"),
    p02_evidence_manifest_ref: ref("p02-evidence"),
    entry_admission_ref: entryRef,
    qualification_record_ref: qualificationRef,
    graph_manifest_ref: graphRef,
    graph_support_matrix_ref: supportRef,
    baseline_query_aggregate_ref: aggregateRef,
    candidate_packet_ref: candidateRef,
    coverage_matrix_ref: coverageRef,
    evidence_manifest_ref: evidenceRef,
    successor_ledger_ref: ledgerRef,
    zero_model_evidence_ref: zeroRef,
    gate_ref: gateRef,
  };
  const gate = {
    schema_id: "penny.sca-p03-gate.v1",
    ...common,
    p03_request_ref: requestRef,
    entry_admission_ref: entryRef,
    qualification_record_ref: qualificationRef,
    graph_manifest_ref: graphRef,
    graph_support_matrix_ref: supportRef,
    baseline_query_aggregate_ref: aggregateRef,
    candidate_packet_ref: candidateRef,
    coverage_matrix_ref: coverageRef,
    evidence_manifest_ref: evidenceRef,
    successor_ledger_ref: ledgerRef,
    zero_model_evidence_ref: zeroRef,
    status: "passed",
    isolation_scope: "live_qualified",
    blocker_codes: [],
  };
  return {
    transition,
    request: { ...common, source_oracle_ref: oracleRef, source_oracle_validation_ref: receiptRef },
    entry: {
      schema_id: "penny.sca-p03-entry-admission.v2",
      ...common,
      p03_request_ref: requestRef,
      source_oracle_ref: oracleRef,
      source_oracle_validation_ref: receiptRef,
    },
    qualification: {
      schema_id: "penny.sca-p03-qualification-record.v2",
      ...common,
      status: "passed",
      live_qualified: true,
      blocker_codes: [],
    },
    graph_manifest: {
      schema_id: "penny.sca-p03-graph-manifest.v1",
      ...common,
      complete: true,
      components: ["php", "javascript_typescript"].map((partition) => ({
        partition,
        status: "complete",
        graph_component_ref: ref(`${partition}-component`),
        graph_provenance_ref: ref(`${partition}-provenance`),
        graph_id: `${partition}-graph`,
      })),
    },
    graph_support: {
      schema_id: "penny.sca-p03-graph-support-matrix.v1",
      ...common,
      complete: true,
      entries: [
        {
          qualification_scope: "live_qualified",
          material_gap: false,
          materiality: "material",
          support: "supported",
        },
      ],
    },
    query_aggregate: {
      schema_id: "penny.sca-p03-baseline-query-aggregate.v1",
      ...common,
      complete: true,
      batches: ["php", "javascript_typescript"].map((partition) => ({
        partition,
        graph_component_ref: ref(`${partition}-component`),
        complete: true,
        truncated: false,
        ordered_query_ids: [...SCA_P03_QUERY_IDS],
      })),
    },
    candidate_packet: {
      schema_id: "penny.sca-p03-graph-candidate-packet.v1",
      ...common,
      complete: true,
      source_bound: true,
    },
    coverage: {
      schema_id: "penny.sca-p03-coverage-matrix.v1",
      ...common,
      entries: [{ status: "complete", blocker_codes: [] }],
    },
    evidence_manifest: {
      schema_id: "penny.sca-p03-evidence-manifest.v2",
      ...common,
      p03_request_ref: requestRef,
      source_oracle_ref: oracleRef,
      source_oracle_validation_ref: receiptRef,
      entry_admission_ref: entryRef,
      qualification_record_ref: qualificationRef,
      graph_manifest_ref: graphRef,
      graph_support_matrix_ref: supportRef,
      baseline_query_aggregate_ref: aggregateRef,
      candidate_packet_ref: candidateRef,
      coverage_matrix_ref: coverageRef,
      zero_model_evidence_ref: zeroRef,
    },
    successor_ledger: {
      schema_id: "penny.sca-p03-successor-ledger.v1",
      ...common,
      dispositions: [{ status: "satisfied" }],
      pending_phase_ids: ["SCA-P04"],
      append_only: true,
      campaign_completion_claimed: false,
      release_eligible: false,
    },
    zero_model: {
      schema_id: "penny.sca-p03-zero-model-evidence.v1",
      ...common,
      worker_kind: "none",
      model_calls: 0,
      model_turns: 0,
      passed: true,
    },
    gate,
  };
}

function queryPagesFixture(partition: "php" | "javascript_typescript") {
  const graphRef = ref(`${partition}-graph`);
  const snapshotRef = ref("query-snapshot");
  const querySetRef = ref("query-set");
  const pages = SCA_P03_QUERY_IDS.flatMap((queryId) =>
    Array.from({ length: queryId === SCA_P03_QUERY_IDS[0] ? 2 : 1 }, (_, index) => {
      const pageRef = ref(
        `query-page-${partition.replaceAll("_", "-")}-${queryId.replaceAll(".", "-")}-${index + 1}`
      );
      return {
        ref: pageRef,
        page: {
          run_id: "run-p03",
          partition,
          source_snapshot_ref: snapshotRef,
          source_snapshot_sha256: snapshotRef.content_digest,
          graph_component_ref: graphRef,
          baseline_query_set_ref: querySetRef,
          query_release_sha256: "a".repeat(64),
          query_id: queryId,
          page_number: index + 1,
          item_count: 0,
          complete: index + 1 === (queryId === SCA_P03_QUERY_IDS[0] ? 2 : 1),
        },
      };
    })
  );
  const pageDescriptors = pages.map(({ ref: pageRef, page }) => ({
    query_id: page.query_id,
    page_number: page.page_number,
    item_count: 0,
    byte_length: pageRef.byte_length,
    content_sha256: pageRef.content_digest,
  }));
  return {
    aggregate: {
      run_id: "run-p03",
      source_snapshot_ref: snapshotRef,
      source_snapshot_sha256: snapshotRef.content_digest,
      baseline_query_set_ref: querySetRef,
    },
    batch: {
      partition,
      graph_component_ref: graphRef,
      page_refs: pages.map((entry) => entry.ref),
      ordered_query_ids: [...SCA_P03_QUERY_IDS],
      complete: true,
      truncated: false,
    },
    result: {
      partition,
      graph_component_ref: graphRef,
      baseline_query_set_ref: querySetRef,
      executed_query_release_sha256: "a".repeat(64),
      page_descriptors: pageDescriptors,
      query_footers: SCA_P03_QUERY_IDS.map((queryId) => ({
        query_id: queryId,
        page_count: queryId === SCA_P03_QUERY_IDS[0] ? 2 : 1,
        item_count: 0,
        byte_count: pageDescriptors
          .filter((entry) => entry.query_id === queryId)
          .reduce((sum, entry) => sum + entry.byte_length, 0),
        complete: true,
      })),
      status: "complete" as const,
      complete: true,
      truncated: false,
    },
    pages,
  };
}

describe("SCA P04 population and admission contracts", () => {
  it("derives stable IDs from immutable lineage and rejects alias/order drift", () => {
    const input = {
      source_snapshot_sha256: "a".repeat(64),
      item_kind: "source_surface" as const,
      normalized_locator: "source:src/a.ts",
      upstream_ids: ["z", "a", "a"],
    };
    expect(scaP04StableItemId(input)).toBe(
      scaP04StableItemId({ ...input, upstream_ids: ["a", "z"] })
    );
  });

  it("builds one deterministic exhaustive population spanning scanner, graph, and no-alert surfaces", () => {
    const { population } = populationFixture();
    expect(population.items.map((item) => item.stable_id)).toEqual(
      [...population.items.map((item) => item.stable_id)].sort()
    );
    expect(population.items.some((item) => item.item_kind === "scanner_lead")).toBe(true);
    expect(population.items.some((item) => item.item_kind === "dependency_lead")).toBe(true);
    expect(population.items.some((item) => item.item_kind === "graph_candidate")).toBe(true);
    expect(
      population.items.some(
        (item) => item.item_kind === "source_surface" && item.alert_state === "no_alert"
      )
    ).toBe(true);
    expect(
      population.items.some((item) =>
        item.assigned_specialists.includes(SCA_P04_SCANNER_SPECIALIST)
      )
    ).toBe(true);
    expect(
      population.items.some((item) =>
        item.assigned_specialists.includes(SCA_P04_UNDERDETECTED_SPECIALIST)
      )
    ).toBe(true);
    expect(new Set(population.items.map((item) => item.selection_metadata.metadata_kind))).toEqual(
      new Set(["scanner_observation", "source_surface", "p03_graph_candidate"])
    );
    for (const specialistId of [
      SCA_P04_SCANNER_SPECIALIST,
      SCA_P04_UNDERDETECTED_SPECIALIST,
    ] as const) {
      const payload = buildScaP04CognitivePayload({
        admission: populationAdmission(),
        population,
        population_ref: ref("selection-population"),
        specialist_id: specialistId,
      });
      expect(payload.assigned_items).toEqual(
        population.items.filter((item) => item.assigned_specialists.includes(specialistId))
      );
      expect(
        payload.assigned_items.every(
          (item) =>
            item.evidence_refs.length > 0 &&
            item.evidence_refs.every((evidenceRef) => evidenceRef.artifact_id.startsWith("art_"))
        )
      ).toBe(true);
    }
  });

  it("admits exact minimized payload bytes and denies oversized calls before dispatch", () => {
    const allowed = populationFixture();
    const allowedPayload = buildScaP04CognitivePayload({
      admission: allowed.admission,
      population: allowed.population,
      population_ref: allowed.populationRef,
      specialist_id: SCA_P04_SCANNER_SPECIALIST,
    });
    const serialized = canonicalJson(allowedPayload);
    const allowedPayloadRef = ref("allowed-payload", {
      run_id: "run-p04",
      phase: "SCA-P04",
      branch_id: SCA_P04_SCANNER_SPECIALIST,
      byte_length: Buffer.byteLength(serialized),
      content_digest: sha256(serialized),
      store_ref: `artifact://sha256/${sha256(serialized)}`,
    });
    const admission = buildScaP04DisclosureAdmission({
      admission: allowed.admission,
      payload: allowedPayload,
      payload_ref: allowedPayloadRef,
      agent: "annie",
    });
    expect(admission.decision).toBe("allow");
    expect(admission.payload_sha256).toBe(sha256(serialized));
    expect(admission.serialized_opening_byte_limit).toBe(SCA_P04_SERIALIZED_OPENING_MAX_BYTES);
    expect(admission.data_class_decisions.find((entry) => entry.data_class === "secrets")).toEqual(
      expect.objectContaining({ included: false, treatment: "deny", minimization: "excluded" })
    );
    const classDeniedAdmission: ScaP04DisclosurePolicyAdmissionV1 = {
      ...allowed.admission,
      model_data_policy: {
        ...allowed.admission.model_data_policy,
        data_classes: allowed.admission.model_data_policy.data_classes.map((entry) =>
          entry.data_class === "source-code" ? { ...entry, treatment: "deny" as const } : entry
        ),
      },
    };
    const classDenied = buildScaP04DisclosureAdmission({
      admission: classDeniedAdmission,
      payload: allowedPayload,
      payload_ref: allowedPayloadRef,
      agent: "annie",
    });
    expect(classDenied.decision).toBe("deny");
    expect(classDenied.blocker_codes).toContain("included_data_class_denied:source-code");

    const exactFramedLimit =
      allowedPayloadRef.byte_length + SCA_P04_SERIALIZED_OPENING_RESERVE_BYTES;
    const exactAdmission: PopulationAdmissionFixture = {
      ...allowed.admission,
      runtime_policy: {
        ...allowed.admission.runtime_policy,
        max_payload_bytes_per_call: exactFramedLimit,
      },
      model_data_policy: {
        ...allowed.admission.model_data_policy,
        payload_limit_bytes: exactFramedLimit,
      },
    };
    expect(
      buildScaP04DisclosureAdmission({
        admission: exactAdmission,
        payload: allowedPayload,
        payload_ref: allowedPayloadRef,
        agent: "annie",
      }).decision
    ).toBe("allow");
    const oneByteShort: PopulationAdmissionFixture = {
      ...exactAdmission,
      runtime_policy: {
        ...exactAdmission.runtime_policy,
        max_payload_bytes_per_call: exactFramedLimit - 1,
      },
      model_data_policy: {
        ...exactAdmission.model_data_policy,
        payload_limit_bytes: exactFramedLimit - 1,
      },
    };
    expect(
      buildScaP04DisclosureAdmission({
        admission: oneByteShort,
        payload: allowedPayload,
        payload_ref: allowedPayloadRef,
        agent: "annie",
      }).blocker_codes
    ).toContain("payload_size_denied");

    const deniedFixture = populationFixture(1);
    const deniedPayload = buildScaP04CognitivePayload({
      admission: deniedFixture.admission,
      population: deniedFixture.population,
      population_ref: deniedFixture.populationRef,
      specialist_id: SCA_P04_SCANNER_SPECIALIST,
    });
    const deniedText = canonicalJson(deniedPayload);
    const denied = buildScaP04DisclosureAdmission({
      admission: deniedFixture.admission,
      payload: deniedPayload,
      payload_ref: ref("denied-payload", {
        run_id: "run-p04",
        phase: "SCA-P04",
        branch_id: SCA_P04_SCANNER_SPECIALIST,
        byte_length: Buffer.byteLength(deniedText),
        content_digest: sha256(deniedText),
        store_ref: `artifact://sha256/${sha256(deniedText)}`,
      }),
      agent: "annie",
    });
    expect(denied.decision).toBe("deny");
    expect(denied.blocker_codes).toContain("payload_size_denied");
  });

  it("keeps the P04 full-opening ceiling below continuity and enforces its exact byte boundary", () => {
    expect(SCA_P04_SERIALIZED_OPENING_MAX_BYTES).toBeLessThan(
      CATALOG_WORKER_CONTINUITY_OPENING_MAX_CHARACTERS
    );
    expect(
      assertScaP04SerializedOpeningSize(
        "x".repeat(SCA_P04_SERIALIZED_OPENING_MAX_BYTES),
        SCA_P04_SERIALIZED_OPENING_MAX_BYTES
      )
    ).toBe(SCA_P04_SERIALIZED_OPENING_MAX_BYTES);
    expect(() =>
      assertScaP04SerializedOpeningSize(
        "x".repeat(SCA_P04_SERIALIZED_OPENING_MAX_BYTES + 1),
        SCA_P04_SERIALIZED_OPENING_MAX_BYTES + 1
      )
    ).toThrow(/exceeds admitted maximum/u);
  });

  it("accepts only closed specialist semantics and exact specialist-role binding", () => {
    const stableId = `p04i_${"0".repeat(64)}`;
    const valid = {
      schema_id: "penny.sca-p04-specialist-result.v1",
      schema_version: 1,
      specialist_id: SCA_P04_SCANNER_SPECIALIST,
      role: "scanner_and_dependency_leads",
      population_sha256: "1".repeat(64),
      assigned_item_ids: [stableId],
      results: [
        {
          stable_id: stableId,
          recommendation: "select",
          reason_code: "select_for_p05",
          evidence_status: "bounded_but_usable",
          evidence_refs: [ref("evidence")],
          p05_question_codes: ["inspect_source_surface"],
          uncertainty_code: "bounded_metadata_only",
        },
      ],
      discoveries: [],
      branch_gap_codes: [],
      complete: true,
    };
    expect(validateScaP04SpecialistResultV1(valid).role).toBe("scanner_and_dependency_leads");
    expect(() =>
      validateScaP04SpecialistResultV1({
        ...valid,
        role: "underdetected_and_no_alert_surfaces",
      })
    ).toThrow(/specialist id\/role binding mismatch/u);
    for (const result of [
      { ...valid.results[0], rationale: "This package is vulnerable." },
      { ...valid.results[0], verdict: "safe" },
      { ...valid.results[0], reason_code: "not_vulnerable" },
      { ...valid.results[0], p05_questions: ["Is this exploitable?"] },
      { ...valid.results[0], uncertainty: "Probably safe." },
    ]) {
      expect(() => validateScaP04SpecialistResultV1({ ...valid, results: [result] })).toThrow();
    }
    expect(() =>
      validateScaP04SpecialistResultV1({
        ...valid,
        branch_gaps: ["free prose gap"],
      })
    ).toThrow();

    const exactGap = {
      ...valid.results[0],
      recommendation: "defer" as const,
      reason_code: "defer_pending_evidence" as const,
      evidence_status: "evidence_gap" as const,
      p05_question_codes: ["resolve_evidence_gap"] as const,
      uncertainty_code: "missing_required_evidence" as const,
    };
    expect(() => validateScaP04SpecialistResultV1({ ...valid, results: [exactGap] })).not.toThrow();
    expect(() =>
      validateScaP04SpecialistResultV1({
        ...valid,
        results: [
          {
            ...exactGap,
            recommendation: "block",
            reason_code: "block_required_evidence_gap",
          },
        ],
      })
    ).not.toThrow();

    const contradictoryResults = [
      { ...valid.results[0], uncertainty_code: "missing_required_evidence" },
      { ...valid.results[0], evidence_status: "evidence_gap" },
      { ...valid.results[0], p05_question_codes: ["resolve_evidence_gap"] },
      { ...exactGap, recommendation: "select", reason_code: "select_for_p05" },
      { ...exactGap, recommendation: "omit", reason_code: "omit_lower_relative_priority" },
      { ...exactGap, evidence_status: "bounded_but_usable" },
      { ...exactGap, uncertainty_code: "bounded_metadata_only" },
      { ...exactGap, p05_question_codes: [] },
    ];
    for (const result of contradictoryResults) {
      expect(() => validateScaP04SpecialistResultV1({ ...valid, results: [result] })).toThrow(
        /evidence-gap semantics mismatch/u
      );
    }
    expect(() =>
      validateScaP04SpecialistResultV1({
        ...valid,
        discoveries: [
          {
            stable_id: `p04d_${"3".repeat(64)}`,
            basis_item_id: stableId,
            source_path: "src/discovery.ts",
            package_coordinate: null,
            normalized_locator: "source:src/discovery.ts",
            evidence_refs: [ref("discovery-evidence")],
            recommendation: "defer",
            reason_code: "defer_pending_evidence",
          },
        ],
      })
    ).toThrow();
  });

  it("marks implementation identity values as declarations rather than runtime attestations", () => {
    const declaration = {
      schema_id: "penny.sca-p04-implementation-identity.v1",
      schema_version: 1,
      phase_id: "SCA-P04",
      implementation_revision: "candidate-revision",
      contracts_sha256: "1".repeat(64),
      prompts_sha256: "2".repeat(64),
      identity_scope: "caller_declaration_not_runtime_attestation",
      host_issued: true,
      required_model: SCA_P04_REQUIRED_MODEL,
    };
    expect(validateScaP04ImplementationIdentityV1(declaration).identity_scope).toBe(
      "caller_declaration_not_runtime_attestation"
    );
    const { identity_scope: _identityScope, ...attestationLooking } = declaration;
    expect(() => validateScaP04ImplementationIdentityV1(attestationLooking)).toThrow();
  });

  it("keeps the cumulative P01→P02→P03 deterministic route structurally blocked before P04", () => {
    const ledger = buildScaInitialObligationLedgerV2({
      tenant_id: "tenant",
      project_id: "project",
      run_id: "run-p01",
      created_at: "2026-09-21T00:00:00.000Z",
      assigning_authority_id: "authority",
      policy_refs: [ref("p01-policy")],
      supporting_evidence_refs: [ref("p01-support")],
    });
    const p04Obligations = ledger.entries
      .filter((entry) => entry.semantic_phase_id === "SCA-P04")
      .map((entry) => entry.obligation_id)
      .sort();
    expect(p04Obligations).toEqual(
      [
        "SCA-OBL-OUTPUT-P04-COVERAGE-DOSSIER",
        "SCA-OBL-OUTPUT-P04-OMISSION-DOSSIER",
        "SCA-OBL-OUTPUT-P04-SELECTION-DOSSIER",
        "SCA-OBL-OUTPUT-P04-SPECIALIST-DOSSIERS",
        "SCA-OBL-P04-ACCEPTANCE",
      ].sort()
    );
    expect(SCA_P03_CANDIDATE_REGISTRATION.worker.kind).toBe("none");
    expect(resolvePlaybook(SCA_P04_CANDIDATE_PLAYBOOK_NAME)).toBeUndefined();
    const liveFixture = acceptedCohortFixture();
    const deterministic = {
      ...liveFixture,
      gate: {
        ...liveFixture.gate,
        isolation_scope: "deterministic_test_only",
        status: "blocked",
        blocker_codes: ["isolation_unqualified"],
      },
      qualification: {
        ...liveFixture.qualification,
        status: "blocked",
        live_qualified: false,
        blocker_codes: ["isolation_unqualified"],
      },
    };
    expect(() => validateScaP04AcceptedP03CohortV1(deterministic)).toThrow(
      /positive live evidence/u
    );
  });

  it("rejects an omitted or substituted accepted P03 oracle/receipt binding", () => {
    const cohort = acceptedCohortFixture();
    expect(() => validateScaP04AcceptedP03CohortV1(cohort)).not.toThrow();
    for (const field of ["source_oracle_ref", "source_oracle_validation_ref"] as const) {
      expect(() =>
        validateScaP04AcceptedP03CohortV1({
          ...cohort,
          request: { ...cohort.request, [field]: ref(`substituted-${field}`) },
        })
      ).toThrow(ScaP04AdmissionError);
    }
  });

  it("accepts exactly seven ordered V2 queries and rejects six or reordered IDs", () => {
    const cohort = acceptedCohortFixture();
    expect(() => validateScaP04AcceptedP03CohortV1(cohort)).not.toThrow();
    for (const ids of [
      SCA_P03_QUERY_IDS.filter((id) => id !== "p03.framework-dispatch.v2"),
      [...SCA_P03_QUERY_IDS].reverse(),
    ]) {
      expect(() =>
        validateScaP04AcceptedP03CohortV1({
          ...cohort,
          query_aggregate: {
            ...cohort.query_aggregate,
            batches: cohort.query_aggregate.batches.map((batch) => ({
              ...batch,
              ordered_query_ids: ids,
            })),
          },
        })
      ).toThrow(ScaP04AdmissionError);
    }
    expect(() =>
      validateScaP04AcceptedP03CohortV1({
        ...cohort,
        query_aggregate: {
          ...cohort.query_aggregate,
          batches: cohort.query_aggregate.batches.map((batch, index) => ({
            ...batch,
            graph_component_ref: ref(
              index === 0 ? "javascript_typescript-component" : "php-component"
            ),
          })),
        },
      })
    ).toThrow(ScaP04AdmissionError);
    expect(() =>
      validateScaP04AcceptedP03CohortV1({
        ...cohort,
        graph_manifest: { ...cohort.graph_manifest, run_id: "run-other" },
      })
    ).toThrow(ScaP04AdmissionError);
  });

  it("requires aggregate page capacity for all seven V2 queries, not six", () => {
    const fixture = queryPagesFixture("php");
    const batchSchema = ScaP03BaselineQueryAggregateV2Schema.properties.batches.items;
    const batch = {
      ...fixture.batch,
      query_batch_request_ref: ref("batch-request"),
      query_batch_result_ref: ref("batch-result"),
    };
    expect(Value.Check(batchSchema, batch)).toBe(true);
    expect(Value.Check(batchSchema, { ...batch, page_refs: batch.page_refs.slice(0, 6) })).toBe(
      false
    );
  });

  it("accepts all seven pages plus a second page in each partition against batch descriptors", () => {
    for (const partition of ["php", "javascript_typescript"] as const) {
      expect(() =>
        validateScaP04AcceptedP03QueryPagesV1(queryPagesFixture(partition))
      ).not.toThrow();
    }
  });

  it("rejects missing, duplicate, extra, cross-query, cross-partition and page-count substitutions", () => {
    const valid = queryPagesFixture("php");
    const foreign = queryPagesFixture("javascript_typescript");
    const first = valid.pages[0];
    const second = valid.pages[1];
    const foreignFirst = foreign.pages[0];
    const descriptorFirst = valid.result.page_descriptors[0];
    if (
      first === undefined ||
      second === undefined ||
      foreignFirst === undefined ||
      descriptorFirst === undefined
    ) {
      throw new Error("missing query test pages");
    }
    const cases = [
      {
        ...valid,
        batch: { ...valid.batch, ordered_query_ids: valid.batch.ordered_query_ids.slice(0, 6) },
      },
      {
        ...valid,
        pages: valid.pages.slice(1),
        batch: { ...valid.batch, page_refs: valid.batch.page_refs.slice(1) },
      },
      { ...valid, pages: [first, first, ...valid.pages.slice(2)] },
      {
        ...valid,
        pages: [...valid.pages, first],
        batch: { ...valid.batch, page_refs: [...valid.batch.page_refs, first.ref] },
      },
      {
        ...valid,
        pages: [
          { ...first, page: { ...first.page, query_id: SCA_P03_QUERY_IDS[1] } },
          ...valid.pages.slice(1),
        ],
      },
      {
        ...valid,
        pages: [{ ...first, page: { ...first.page, page_number: 2 } }, ...valid.pages.slice(1)],
      },
      {
        ...valid,
        pages: [
          { ...first, page: { ...first.page, partition: foreign.batch.partition } },
          ...valid.pages.slice(1),
        ],
      },
      {
        ...valid,
        pages: [foreignFirst, ...valid.pages.slice(1)],
        batch: { ...valid.batch, page_refs: [foreignFirst.ref, ...valid.batch.page_refs.slice(1)] },
      },
      {
        ...valid,
        result: {
          ...valid.result,
          query_footers: valid.result.query_footers.map((footer, index) =>
            index === 0 ? { ...footer, page_count: 1 } : footer
          ),
        },
      },
      {
        ...valid,
        result: { ...valid.result, page_descriptors: valid.result.page_descriptors.slice(1) },
      },
      {
        ...valid,
        result: {
          ...valid.result,
          page_descriptors: [...valid.result.page_descriptors, descriptorFirst],
        },
      },
      {
        ...valid,
        result: {
          ...valid.result,
          page_descriptors: valid.result.page_descriptors.map((descriptor, index) =>
            index === 0 ? { ...descriptor, content_sha256: "f".repeat(64) } : descriptor
          ),
        },
      },
    ];
    for (const candidate of cases) {
      expect(() => validateScaP04AcceptedP03QueryPagesV1(candidate)).toThrow(ScaP04AdmissionError);
    }
  });
});

describe("P04 typed graph-candidate uncertainty", () => {
  function population() {
    return buildScaP04SelectionPopulation({
      admission: populationAdmission(),
      accepted_cohort_ref: ref("cohort"),
    });
  }
  it("carries uncertainty and immutable provenance unchanged into inline selection", () => {
    const admitted = populationAdmission();
    const candidate = admitted.candidate_packet.candidates[0];
    if (candidate === undefined) throw new Error("candidate absent");
    const value = population();
    const item = value.items.find((item) => item.item_kind === "graph_candidate");
    expect(item?.selection_metadata).toMatchObject({
      metadata_kind: "p03_graph_candidate",
      candidate_id: candidate.candidate_id,
      claim: candidate.claim,
      disposition: candidate.disposition,
      reason_code: candidate.reason_code,
      graph_component_sha256: candidate.graph_component_sha256,
      source_snapshot_sha256: candidate.source_snapshot_sha256,
      query_release_sha256: candidate.query_release_sha256,
      graph_component_ref: candidate.graph_component_ref,
      page_ref: candidate.page_ref,
    });
    const payload = buildScaP04CognitivePayload({
      admission: admitted,
      population: value,
      population_ref: ref("inline-population"),
      specialist_id: SCA_P04_UNDERDETECTED_SPECIALIST,
    });
    expect(
      payload.assigned_items.find((entry) => entry.stable_id === item?.stable_id)
        ?.selection_metadata
    ).toEqual(item?.selection_metadata);
  });
  it.each(["missing", "supported", "reason", "source", "graph", "page"])(
    "fails closed on %s metadata drift",
    (defect) => {
      const value = population();
      const items = value.items.map((item) => {
        const metadata = item.selection_metadata;
        if (metadata.metadata_kind !== "p03_graph_candidate") return item;
        const { disposition: _disposition, ...withoutDisposition } = metadata;
        return {
          ...item,
          selection_metadata:
            defect === "missing"
              ? withoutDisposition
              : {
                  ...metadata,
                  ...(defect === "supported"
                    ? { disposition: "supported", reason_code: null }
                    : {}),
                  ...(defect === "reason" ? { reason_code: null } : {}),
                  ...(defect === "source"
                    ? { source_snapshot_sha256: sha256("foreign-source") }
                    : {}),
                  ...(defect === "graph"
                    ? { graph_component_sha256: sha256("foreign-graph") }
                    : {}),
                  ...(defect === "page" ? { page_ref: ref("foreign-page") } : {}),
                },
        };
      });
      expect(() =>
        validateScaP04SelectionPopulationV1(
          withSelfDigest({ ...value, items }, "population_sha256")
        )
      ).toThrow();
    }
  );
});
