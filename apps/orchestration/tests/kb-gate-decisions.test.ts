import { requireValue } from "./helpers/narrowing.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertObservationDecision,
  parseGateDecisionReceiptJcs,
  parseRetrievalFixture,
  validateGateDecisionReceipt,
  validateRetrievalFixture,
  type ObservationPairEvidenceV1,
} from "../src/kb/gate-decisions.js";
import {
  canonicalJson,
  sha256Hex,
  type ObservationCohortManifestV1,
  type ObservationWindowDecisionV1,
  type ResearchObservationProjectionV1,
} from "../src/kb/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const retrievalBytes = readFileSync(
  path.join(repoRoot, "apps/orchestration/tests/fixtures/kb-retrieval.json"),
  "utf8"
);

function observationFixture(): {
  decision: ObservationWindowDecisionV1;
  pairs: readonly ObservationPairEvidenceV1[];
  researchFixtureBytes: string;
  normalizationRulesBytes: string;
  runtimeConfigBytes: string;
  modelSetBytes: string;
} {
  const researchFixtureBytes = "research-fixture-v1";
  const normalizationRulesBytes = "normalization-rules-v1";
  const runtimeConfigBytes = "runtime-config-v1";
  const modelSetBytes = "model-set-v1";
  const cohort: ObservationCohortManifestV1 = {
    schema_version: 1,
    cohort_id: "cohort_fixture",
    research_fixture_sha256: sha256Hex(researchFixtureBytes),
    normalization_rules_path:
      "apps/orchestration/tests/fixtures/research-observation-normalization.json",
    normalization_rules_sha256: sha256Hex(normalizationRulesBytes),
    runtime_config_sha256: sha256Hex(runtimeConfigBytes),
    model_set_sha256: sha256Hex(modelSetBytes),
    scheduled_pair_count: 50,
    cases: [{ case_id: "case_fixture", repetitions: 50, fault_mode: "none" }],
    cost_unit: "provider_reported_usd",
  };
  const unreviewed = {
    schema_version: 1 as const,
    plan_id: "hybrid-kb-ts-plan-2026-08-13" as const,
    decision_id: "observation_fixture",
    approved_by_subject_id: "operator",
    approved_at: "2026-08-01T00:00:00Z",
    reviewed_by_subject_id: "agent:vera",
    reviewed_at: "2026-08-01T00:01:00Z",
    evidence_refs: [],
    decision_kind: "research_observation" as const,
    cohort,
    cohort_sha256: sha256Hex(canonicalJson(cohort)),
    minimum_duration_hours: 168,
    minimum_paired_terminal_runs: 50,
    maximum_unexplained_parity_mismatches: 0 as const,
    maximum_privacy_incidents: 0 as const,
    maximum_recovery_failures: 0 as const,
    maximum_p95_latency_ratio: 1.25,
    maximum_mean_cost_ratio: 1.25,
  };
  const decision: ObservationWindowDecisionV1 = {
    ...unreviewed,
    review_sha256: sha256Hex(canonicalJson(unreviewed)),
  };
  const projection: ResearchObservationProjectionV1 = {
    schema_version: 1,
    case_id: "case_fixture",
    terminal_status: "complete",
    met: true,
    terminal_code: "complete",
    result_kind: "research_report",
    result_sha256: "a".repeat(64),
    evidence_sha256: ["b".repeat(64)],
    warning_codes: [],
    unresolved_codes: [],
    safe_counts: { sources: 2 },
  };
  const pairs = Array.from(
    { length: 50 },
    (_, index): ObservationPairEvidenceV1 => ({
      case_id: "case_fixture",
      repetition: index + 1,
      baseline: {
        projection,
        latency_ms: 100,
        provider_reported_cost_usd: 0.01,
        privacy_incidents: 0,
        recovery_failures: 0,
      },
      candidate: {
        projection: structuredClone(projection),
        latency_ms: 110,
        provider_reported_cost_usd: 0.011,
        privacy_incidents: 0,
        recovery_failures: 0,
      },
    })
  );
  return {
    decision,
    pairs,
    researchFixtureBytes,
    normalizationRulesBytes,
    runtimeConfigBytes,
    modelSetBytes,
  };
}

function observationInput(fixture = observationFixture()) {
  return {
    ...fixture,
    firstDispatchAt: "2026-08-01T00:00:00Z",
    lastTerminalAt: "2026-08-08T00:00:00Z",
  };
}

describe("§5.13 centralized decision schemas", () => {
  it("validates the closed observation receipt union and all bound cohort values", () => {
    const fixture = observationFixture();
    expect(parseGateDecisionReceiptJcs(canonicalJson(fixture.decision))).toEqual(fixture.decision);
    const result = assertObservationDecision(observationInput(fixture));
    expect(result).toMatchObject({
      pair_count: 50,
      duration_hours: 168,
      unexplained_parity_mismatches: 0,
      privacy_incidents: 0,
      recovery_failures: 0,
    });
    expect(result.p95_latency_ratio).toBeCloseTo(1.1);
    expect(result.mean_cost_ratio).toBeCloseTo(1.1);
  });

  it("rejects unknown decision keys, duplicate JSON members, non-JCS, and review drift", () => {
    const { decision } = observationFixture();
    expect(() =>
      validateGateDecisionReceipt({ ...decision, ordering_note: "outside schema" })
    ).toThrow();
    const jcs = canonicalJson(decision);
    expect(() =>
      parseGateDecisionReceiptJcs(jcs.replace('{"approved_at"', '{"approved_at":"x","approved_at"'))
    ).toThrow(/duplicate/u);
    expect(() => parseGateDecisionReceiptJcs(JSON.stringify(decision, null, 2))).toThrow(
      /exact JCS/u
    );
    expect(() =>
      validateGateDecisionReceipt({ ...decision, review_sha256: "0".repeat(64) })
    ).toThrow(/review_sha256/u);
  });
});

describe("§5.13 retrieval fixture schema", () => {
  it("strict-parses and validates the exact reviewed fixture/case shapes", () => {
    const fixture = parseRetrievalFixture(retrievalBytes);
    expect(fixture.cases).toHaveLength(3);
    expect(fixture.corpus).toHaveLength(3);
  });

  it("rejects duplicate members, unknown case keys, unresolved refs, and zero labels", () => {
    expect(() =>
      parseRetrievalFixture(
        retrievalBytes.replace(
          '"schema_version": 1,',
          '"schema_version": 1,\n  "schema_version": 1,'
        )
      )
    ).toThrow(/duplicate/u);
    const fixture = parseRetrievalFixture(retrievalBytes);
    expect(() =>
      validateRetrievalFixture({
        ...fixture,
        cases: fixture.cases.map((testCase, index) =>
          index === 0 ? { ...testCase, extra: true } : testCase
        ),
      })
    ).toThrow();
    expect(() =>
      validateRetrievalFixture({
        ...fixture,
        cases: fixture.cases.map((testCase, index) =>
          index === 0
            ? {
                ...testCase,
                expected_relevant: [{ page_id: "missing_page", revision_id: "rev_1" }],
              }
            : testCase
        ),
      })
    ).toThrow(/outside the corpus/u);
    expect(() =>
      validateRetrievalFixture({
        ...fixture,
        cases: fixture.cases.map((testCase) => ({
          ...testCase,
          expected_contradictions: [],
        })),
      })
    ).toThrow(/at least one contradiction/u);
  });
});

describe("§5.13 observation oracle negatives", () => {
  it("rejects missing/duplicate pairs and every frozen-byte binding drift", () => {
    const fixture = observationFixture();
    expect(() =>
      assertObservationDecision({
        ...observationInput(fixture),
        pairs: fixture.pairs.slice(1),
      })
    ).toThrow(/missing/u);
    expect(() =>
      assertObservationDecision({
        ...observationInput(fixture),
        pairs: [
          ...fixture.pairs.slice(0, -1),
          requireValue(fixture.pairs[0], "apps/orchestration/tests/kb-gate-decisions.test.ts:227"),
        ],
      })
    ).toThrow(/exactly once/u);
    expect(() =>
      assertObservationDecision({
        ...observationInput(fixture),
        modelSetBytes: "changed-model-set",
      })
    ).toThrow(/frozen cohort digests/u);
  });

  it("counts mismatches/incidents/recovery failures and rejects absent costs", () => {
    const fixture = observationFixture();
    const withFirstCandidate = (
      patch: Partial<ObservationPairEvidenceV1["candidate"]>
    ): readonly ObservationPairEvidenceV1[] =>
      fixture.pairs.map((pair, index) =>
        index === 0 ? { ...pair, candidate: { ...pair.candidate, ...patch } } : pair
      );
    const mismatched = withFirstCandidate({
      projection: {
        ...requireValue(fixture.pairs[0], "apps/orchestration/tests/kb-gate-decisions.test.ts:248")
          .candidate.projection,
        safe_counts: { sources: 3 },
      },
    });
    expect(() =>
      assertObservationDecision({ ...observationInput(fixture), pairs: mismatched })
    ).toThrow(/does not satisfy/u);

    expect(() =>
      assertObservationDecision({
        ...observationInput(fixture),
        pairs: withFirstCandidate({ privacy_incidents: 1 }),
      })
    ).toThrow(/does not satisfy/u);

    expect(() =>
      assertObservationDecision({
        ...observationInput(fixture),
        pairs: withFirstCandidate({ recovery_failures: 1 }),
      })
    ).toThrow(/does not satisfy/u);

    expect(() =>
      assertObservationDecision({
        ...observationInput(fixture),
        pairs: withFirstCandidate({ provider_reported_cost_usd: Number.NaN }),
      })
    ).toThrow(/provider cost/u);
  });
});
