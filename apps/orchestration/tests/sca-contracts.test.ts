import { describe, expect, it } from "vitest";

import {
  validateClaimRecord,
  validateDecisionRecord,
  validateEvidenceRef,
  validateFindingRecord,
  validateGateResult,
  validateManifest,
  validateTaskRecord,
} from "../src/sca/contracts.js";
import { requireValue } from "./helpers/narrowing.js";
import { createValidScaDomainFixture } from "./helpers/sca-domain-fixtures.js";

function jsonRoundTrip(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

describe("S-01 closed SCA ledger contracts", () => {
  it("round-trips every v1 record with tenant/project/run/phase identity", () => {
    using fixture = createValidScaDomainFixture();
    const { bundle } = fixture;
    const task = requireValue(bundle.tasks[0], "task");
    const claim = requireValue(bundle.claims[0], "claim");
    const evidence = requireValue(bundle.evidence[0], "evidence");
    const finding = requireValue(bundle.findings[0], "finding");
    const decision = requireValue(bundle.decisions[0], "decision");
    const gate = requireValue(bundle.gates[0], "gate");

    expect(validateTaskRecord(jsonRoundTrip(task))).toEqual(task);
    expect(validateClaimRecord(jsonRoundTrip(claim))).toEqual(claim);
    expect(validateEvidenceRef(jsonRoundTrip(evidence))).toEqual(evidence);
    expect(
      validateFindingRecord(
        jsonRoundTrip({
          ...finding,
          finding_type: "vendor.experimental-control-flow",
          finding_type_version: 27,
        })
      )
    ).toMatchObject({
      finding_type: "vendor.experimental-control-flow",
      finding_type_version: 27,
    });
    expect(validateDecisionRecord(jsonRoundTrip(decision))).toEqual(decision);
    expect(validateGateResult(jsonRoundTrip(gate))).toEqual(gate);
    expect(validateManifest(jsonRoundTrip(bundle.manifest))).toEqual(bundle.manifest);
  });

  it("rejects unknown fields for every closed record class", () => {
    using fixture = createValidScaDomainFixture();
    const { bundle } = fixture;
    const candidates: readonly (() => unknown)[] = [
      () => validateTaskRecord({ ...requireValue(bundle.tasks[0], "task"), rogue: true }),
      () => validateClaimRecord({ ...requireValue(bundle.claims[0], "claim"), rogue: true }),
      () => validateEvidenceRef({ ...requireValue(bundle.evidence[0], "evidence"), rogue: true }),
      () => validateFindingRecord({ ...requireValue(bundle.findings[0], "finding"), rogue: true }),
      () =>
        validateDecisionRecord({ ...requireValue(bundle.decisions[0], "decision"), rogue: true }),
      () => validateGateResult({ ...requireValue(bundle.gates[0], "gate"), rogue: true }),
      () => validateManifest({ ...bundle.manifest, rogue: true }),
    ];

    for (const candidate of candidates) expect(candidate).toThrow(/additional properties/u);

    const evidence = requireValue(bundle.evidence[0], "evidence");
    const citation = requireValue(evidence.citations[0], "citation");
    const locator = requireValue(bundle.manifest.records[0], "manifest locator");
    expect(() =>
      validateEvidenceRef({
        ...evidence,
        citations: [{ ...citation, pointer: { ...citation.pointer, rogue: true } }],
      })
    ).toThrow(/additional properties/u);
    expect(() =>
      validateManifest({
        ...bundle.manifest,
        records: [{ ...locator, rogue: true }, ...bundle.manifest.records.slice(1)],
      })
    ).toThrow(/additional properties/u);
  });

  it("rejects missing fields, unsupported versions, malformed statuses, and cross-run refs", () => {
    using fixture = createValidScaDomainFixture();
    const { bundle } = fixture;
    const task = requireValue(bundle.tasks[0], "task");
    const claim = requireValue(bundle.claims[0], "claim");
    const evidence = requireValue(bundle.evidence[0], "evidence");
    const finding = requireValue(bundle.findings[0], "finding");
    const decision = requireValue(bundle.decisions[0], "decision");
    const gate = requireValue(bundle.gates[0], "gate");
    const { title: _title, ...taskWithoutTitle } = task;

    expect(() => validateTaskRecord(taskWithoutTitle)).toThrow(/title/u);
    expect(() => validateClaimRecord({ ...claim, schema_version: 2 })).toThrow(/constant/u);
    expect(() => validateEvidenceRef({ ...evidence, evidence_kind: "prose" })).toThrow();
    expect(() => validateFindingRecord({ ...finding, status: "verified" })).toThrow();
    expect(() => validateDecisionRecord({ ...decision, outcome: "allow" })).toThrow();
    expect(() => validateGateResult({ ...gate, status: "success" })).toThrow();
    expect(() =>
      validateManifest({ ...bundle.manifest, schema_id: "penny.sca-manifest.v2" })
    ).toThrow(/constant/u);
    expect(() =>
      validateEvidenceRef({
        ...evidence,
        artifact_ref: { ...evidence.artifact_ref, run_id: "run-other" },
      })
    ).toThrow();
  });

  it("rejects unsafe numbers and nonsensical exclusive ranges", () => {
    using fixture = createValidScaDomainFixture();
    const { bundle } = fixture;
    const task = requireValue(bundle.tasks[0], "task");
    const evidence = requireValue(bundle.evidence[0], "evidence");
    const citation = requireValue(evidence.citations[0], "citation");

    expect(() => validateTaskRecord({ ...task, sequence: Number.NaN })).toThrow();
    expect(() => validateTaskRecord({ ...task, version: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => validateTaskRecord({ ...task, sequence: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() =>
      validateEvidenceRef({
        ...evidence,
        citations: [
          {
            ...citation,
            pointer: { pointer_type: "byte_range", start_byte: 8, end_byte_exclusive: 8 },
          },
        ],
      })
    ).toThrow(/non-empty|exclusiveMinimum|minimum/u);
    expect(() =>
      validateEvidenceRef({
        ...evidence,
        citations: [
          {
            ...citation,
            pointer: {
              pointer_type: "line_column_range",
              start: { line: 2, column: 2 },
              end_exclusive: { line: 1, column: 1 },
            },
          },
        ],
      })
    ).toThrow(/increasing/u);
  });

  it("enforces initial pending/draft/candidate states and terminal decisions", () => {
    using fixture = createValidScaDomainFixture();
    const { bundle } = fixture;
    const task = requireValue(bundle.tasks[0], "task");
    const claim = requireValue(bundle.claims[0], "claim");
    const acceptedClaim = requireValue(bundle.claims[2], "accepted claim");
    const finding = requireValue(bundle.findings[0], "finding");
    const investigatedFinding = requireValue(bundle.findings[1], "investigated finding");

    expect(() =>
      validateTaskRecord({ ...task, status: "completed", decision_id: "decision-task" })
    ).toThrow(/version 1.*pending/u);
    expect(() =>
      validateClaimRecord({ ...claim, status: "accepted", decision_id: "decision-claim" })
    ).toThrow(/version 1.*draft/u);
    expect(() =>
      validateFindingRecord({
        ...finding,
        investigation: investigatedFinding.investigation,
        status: "confirmed",
        decision_id: "decision-finding",
      })
    ).toThrow(/version 1.*candidate/u);
    expect(() =>
      validateClaimRecord({ ...claim, claim_class: "inference", inference_disclosure: null })
    ).toThrow(/inference_disclosure/u);
    expect(() => validateClaimRecord({ ...claim, confidence: "HIGH" })).toThrow();
    expect(() => validateClaimRecord({ ...acceptedClaim, decision_id: null })).toThrow(
      /decision_id/u
    );
    expect(() =>
      validateFindingRecord({
        ...finding,
        investigation: investigatedFinding.investigation,
        status: "duplicate",
      })
    ).toThrow(/duplicate_of/u);
  });

  it("requires canonical current ArtifactRef v2 identity", () => {
    using fixture = createValidScaDomainFixture();
    const evidence = requireValue(fixture.bundle.evidence[0], "evidence");

    expect(() =>
      validateEvidenceRef({
        ...evidence,
        artifact_ref: { ...evidence.artifact_ref, schema_version: 1 },
      })
    ).toThrow();
    expect(() =>
      validateEvidenceRef({
        ...evidence,
        artifact_ref: {
          ...evidence.artifact_ref,
          artifact_id: `art_${"f".repeat(64)}`,
        },
      })
    ).toThrow(/canonical identity/u);
    expect(() =>
      validateEvidenceRef({
        ...evidence,
        artifact_ref: {
          ...evidence.artifact_ref,
          store_ref: `artifact://sha256/${"e".repeat(64)}`,
        },
      })
    ).toThrow(/content_digest/u);
  });
});
