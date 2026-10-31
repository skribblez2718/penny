import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import {
  SCA_P11_TO_P12_TRANSITION_SCHEMA,
  validateScaP11ToP12TransitionV1,
  withP11Digest,
  type ScaP11ToP12TransitionV1,
} from "../dist/sca/p11-contracts.js";
import { admitScaP12Release } from "../dist/sca/p12-admission.js";
import {
  SCA_P12_REASSESSMENT_SCHEMA,
  validateScaP12ReassessmentV1,
  withP12Digest,
} from "../dist/sca/p12-contracts.js";
import {
  scaP12AdmissionInputFor,
  buildScaP12Lineage,
  type ScaP12LaneKindV1,
} from "./sca-p12-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function makeStore(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p12-admission-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}

function persist(
  store: ArtifactStore,
  runId: string,
  kind: string,
  schemaId: string,
  value: unknown
): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: runId,
    phase: "SCA-P11",
    branch_id: null,
    kind,
    operation_id: `${kind}-tamper-${Math.random().toString(16).slice(2)}`,
    version: 1,
    producer: "host:test",
    media_type: "application/json",
    content_schema: { schema_id: schemaId, schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  return store.persist({ metadata, content: canonicalJson(value) });
}

describe("SCA P12 exact four-lane admission", () => {
  const lanes: readonly ScaP12LaneKindV1[] = [
    "reporting_complete",
    "reporting_incomplete",
    "blocked_invalid",
    "cancelled",
  ];

  for (const lane of lanes) {
    it(`classifies the P11 ${lane} terminal`, () => {
      const store = makeStore();
      const lineage = buildScaP12Lineage({ store, run_id: `run-${lane}`, lane });
      const admitted = admitScaP12Release(scaP12AdmissionInputFor(store, lineage));
      if (lane === "reporting_complete" || lane === "reporting_incomplete") {
        expect(admitted.reportable).toBe(true);
        expect(admitted.lane).not.toBeNull();
        expect(admitted.non_reportable_reason).toBeNull();
        expect(admitted.admission.p11_rederivation_ok).toBe(true);
      } else {
        expect(admitted.reportable).toBe(false);
        expect(admitted.lane).toBeNull();
        expect(admitted.non_reportable_reason).toBe(`p11_${lane}_non_reportable`);
      }
    });
  }

  it("rejects a non-authorizing-handoff violation", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-handoff",
      lane: "reporting_complete",
    });
    const original: ScaP11ToP12TransitionV1 = validateScaP11ToP12TransitionV1(
      JSON.parse(
        store
          .readById(required(lineage.p11_transition_ref, "transition").artifact_id)
          .toString("utf8")
      )
    );
    // Flip the non-authorizing literal and re-seal; the admission must fail closed.
    const sealedBad = withP11Digest(
      { ...original, p12_release_authorized_by_this_transition: true as const },
      "transition_sha256"
    );
    const badRef = persist(
      store,
      "run-handoff",
      "sca-p11-to-p12-transition",
      SCA_P11_TO_P12_TRANSITION_SCHEMA,
      sealedBad
    );
    const input = { ...scaP12AdmissionInputFor(store, lineage), p11_transition_ref: badRef };
    expect(() => admitScaP12Release(input)).toThrow();
  });

  it("rejects a wrong-kind terminal and a digest-drifted ref", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({ store, run_id: "run-kind", lane: "reporting_complete" });
    const base = scaP12AdmissionInputFor(store, lineage);
    // The P11 report projection supplied as the terminal is a wrong kind.
    expect(() =>
      admitScaP12Release({ ...base, p11_terminal_ref: required(lineage.p11_report_ref, "report") })
    ).toThrow(/exact ref absent or substituted/);
    expect(() =>
      admitScaP12Release({
        ...base,
        p11_terminal_ref: { ...lineage.p11_terminal_ref, content_digest: "0".repeat(64) },
      })
    ).toThrow();
  });

  it("consumes an append-only reassessment read-only and rejects a non-append-only one", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-reassess",
      lane: "reporting_complete",
    });
    const base = scaP12AdmissionInputFor(store, lineage);
    const prior = lineage.p11_terminal_ref;
    const reassessment = withP12Digest(
      {
        schema_id: SCA_P12_REASSESSMENT_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        run_id: "run-reassess",
        prior_release_record_ref: prior,
        prior_release_record_sha256: prior.content_digest,
        trigger_codes: ["changed_phase_gate" as const],
        stimulus_refs: [prior],
        invalidated_evidence_refs: [],
        append_only: true as const,
        invalidates_release_approval: true as const,
      },
      "reassessment_sha256"
    );
    const okRef = persist(
      store,
      "run-reassess",
      "sca-p12-reassessment",
      SCA_P12_REASSESSMENT_SCHEMA,
      validateScaP12ReassessmentV1(reassessment)
    );
    const ok = admitScaP12Release({ ...base, p12_reassessment_ref: okRef });
    expect(ok.evidence_refs.some((ref) => ref.artifact_id === okRef.artifact_id)).toBe(true);
    const badRef = persist(
      store,
      "run-reassess",
      "sca-p12-reassessment",
      SCA_P12_REASSESSMENT_SCHEMA,
      { ...reassessment, append_only: false }
    );
    expect(() => admitScaP12Release({ ...base, p12_reassessment_ref: badRef })).toThrow();
  });

  it("fails closed when a re-derivation input is wrong", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-rederive",
      lane: "reporting_complete",
    });
    const base = scaP12AdmissionInputFor(store, lineage);
    expect(() =>
      admitScaP12Release({ ...base, p10_terminal_ref: lineage.p11_terminal_ref })
    ).toThrow(/sca-p10-terminal/);
  });
});
