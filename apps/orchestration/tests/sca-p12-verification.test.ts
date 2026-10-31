import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import {
  validateScaP12CandidateStartV1,
  validateScaP12ReleaseAuthorityV1,
  validateScaP12VerificationScopeV1,
  validateScaP12VerifierAuthorityV1,
  withP12Digest,
  type ScaP12ReleaseApprovalV1,
  type ScaP12ReleaseAuthorityV1,
  type ScaP12VerifierAuthorityV1,
} from "../dist/sca/p12-contracts.js";
import { buildScaP12GateV1 } from "../dist/sca/p12-release.js";
import { validateScaP11SemanticReviewV1 } from "../dist/sca/p11-contracts.js";
import {
  evaluateScaP12ReleaseApprovalV1,
  sealScaP12ReleaseApprovalV1,
} from "../dist/sca/p12-approval.js";
import {
  buildScaP12ReplayEvidenceV1,
  buildScaP12VerifierVerdictsV1,
  checkScaP12Independence,
  deriveScaP12IndependenceExclusionsV1,
  deterministicSpotCheckSample,
} from "../dist/sca/p12-verification.js";
import { admitLineage, buildScaP12Lineage } from "./sca-p12-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function makeStore(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p12-verification-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

type AnyRecord = Record<string, unknown>;
function withoutDigest(value: AnyRecord, field: string): AnyRecord {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}
function readJson(store: ArtifactStore, ref: { artifact_id: string }): unknown {
  return JSON.parse(store.readById(ref.artifact_id).toString("utf8"));
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}

function resignVerifier(
  base: ScaP12VerifierAuthorityV1,
  patch: AnyRecord
): ScaP12VerifierAuthorityV1 {
  return validateScaP12VerifierAuthorityV1(
    withP12Digest({ ...withoutDigest(base, "authority_sha256"), ...patch }, "authority_sha256")
  );
}
function resignRelease(base: ScaP12ReleaseAuthorityV1, patch: AnyRecord): ScaP12ReleaseAuthorityV1 {
  return validateScaP12ReleaseAuthorityV1(
    withP12Digest({ ...withoutDigest(base, "authority_sha256"), ...patch }, "authority_sha256")
  );
}

const VERIFIER_DERIVED_EXCLUSIONS = {
  excluded_identity_ids: ["p11-implementer-identity", "p11-report-producer-identity"],
  excluded_lineage_ids: ["host:sca-p11-candidate", "vera"],
  exclusions_available: true,
  verifier_authority_current: true,
} as const;

function persistArtifact(
  store: ArtifactStore,
  runId: string,
  kind: string,
  schemaId: string,
  value: unknown
): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: runId,
    phase: "SCA-P12",
    branch_id: null,
    kind,
    operation_id: `${kind}-test`,
    version: 1,
    producer: "host:test",
    media_type: "application/json",
    content_schema: { schema_id: schemaId, schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  return store.persist({ metadata, content: canonicalJson(value) });
}

function passReadyGate(
  store: ArtifactStore,
  runId: string,
  reportRef: ArtifactRef
): { readonly ref: ArtifactRef; readonly gate: ReturnType<typeof buildScaP12GateV1> } {
  const facts = {
    immutable_p11_lineage_valid: true,
    verifier_independent_and_subset_authority: true,
    deterministic_replay_passed: true,
    spot_check_passed: true,
    verifier_verdicts_supported: true,
    no_unresolved_required_item: true,
    phase_gate_index_complete: true,
    obligation_ledger_complete: true,
    accepted_set_projection_consistent: true,
    artifact_identity_valid: true,
    latest_revision_only: true,
    human_release_authority_valid: true,
    release_record_binding_valid: true,
    publication_not_claimed: true,
    p12_release_authority_respected: true,
  } as const;
  const gate = buildScaP12GateV1({
    report_ref: reportRef,
    release_record_ref: null,
    lane: "accepted_progression",
    facts,
    blocker_codes: [],
    finding_count: 0,
    record_count: 0,
    evaluated_at: "2026-10-03T00:00:00.000Z",
  });
  return {
    ref: persistArtifact(store, runId, "sca-p12-gate", "penny.sca-p12-gate.v1", gate),
    gate,
  };
}

describe("SCA P12 verification", () => {
  it("separates a strict-subset current verifier from report production and the release authority", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-independence",
      lane: "reporting_complete",
    });
    const verifier = validateScaP12VerifierAuthorityV1(
      readJson(store, lineage.verifier_authority_ref)
    );
    const release = validateScaP12ReleaseAuthorityV1(
      readJson(store, lineage.release_authority_ref)
    );
    const result = checkScaP12Independence({
      verifier_authority: verifier,
      release_authority: release,
      subject_sha256: lineage.subject_sha256,
      ...VERIFIER_DERIVED_EXCLUSIONS,
    });
    expect(result.verifier_independent).toBe(true);
    expect(result.verifier_subset_authority).toBe(true);
    expect(result.verifier_authority_current).toBe(true);
    expect(result.release_authority_valid).toBe(true);
    expect(result.release_authority_distinct).toBe(true);
    expect(result.blocker_codes).toEqual([]);

    // A derived exclusion set that intersects the verifier identity rejects it (self-declaration
    // cannot grant independence). This mirrors the PROBE1 forgery: empty declared lists but the
    // real report-production identity is present in the host-derived set.
    const withVerifierExcluded = checkScaP12Independence({
      verifier_authority: resignVerifier(verifier, {
        excluded_identity_ids: [],
        excluded_lineage_ids: [],
      }),
      release_authority: release,
      subject_sha256: lineage.subject_sha256,
      excluded_identity_ids: [
        ...VERIFIER_DERIVED_EXCLUSIONS.excluded_identity_ids,
        verifier.verifier_identity_id,
      ],
      excluded_lineage_ids: VERIFIER_DERIVED_EXCLUSIONS.excluded_lineage_ids,
      exclusions_available: true,
      verifier_authority_current: true,
    });
    expect(withVerifierExcluded.verifier_independent).toBe(false);
    expect(withVerifierExcluded.blocker_codes).toContain("p12_verifier_not_independent");

    // Independence is unverifiable when the host cannot derive exclusions from verified records.
    expect(
      checkScaP12Independence({
        verifier_authority: verifier,
        release_authority: release,
        subject_sha256: lineage.subject_sha256,
        ...VERIFIER_DERIVED_EXCLUSIONS,
        exclusions_available: false,
      }).verifier_independent
    ).toBe(false);

    const sameRelease = resignRelease(release, {
      release_authority_identity_id: verifier.verifier_identity_id,
    });
    expect(
      checkScaP12Independence({
        verifier_authority: verifier,
        release_authority: sameRelease,
        subject_sha256: lineage.subject_sha256,
        ...VERIFIER_DERIVED_EXCLUSIONS,
      }).release_authority_distinct
    ).toBe(false);
  });

  it("derives the exact P11 semantic-reviewer/repairer identity and lineage and rejects a matching verifier", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-reviewer-exclusion",
      lane: "reporting_complete",
    });
    const admitted = admitLineage(store, lineage);
    // The exact P11 semantic review record carries the reviewer identity/lineage (never the
    // verifier's self-declaration).
    const reviewRef = required(admitted.validation?.semantic_review_ref, "semantic review");
    const review = validateScaP11SemanticReviewV1(readJson(store, reviewRef));
    expect(review.reviewer_identity_id).toBe("agent:vera");
    expect(review.reviewer_lineage_id).toBe("vera");

    const derived = deriveScaP12IndependenceExclusionsV1({
      store,
      admission: admitted,
      phase_gate_exclusions: null,
      phase_gate_complete: false,
    });
    expect(derived.identity_ids).toContain("agent:vera");
    expect(derived.lineage_ids).toContain("vera");

    const verifier = validateScaP12VerifierAuthorityV1(
      readJson(store, lineage.verifier_authority_ref)
    );
    const release = validateScaP12ReleaseAuthorityV1(
      readJson(store, lineage.release_authority_ref)
    );

    // A verifier using agent:vera is rejected even when its own exclusion list omits it.
    const usingReviewerIdentity = checkScaP12Independence({
      verifier_authority: resignVerifier(verifier, {
        verifier_identity_id: "agent:vera",
        excluded_identity_ids: [],
        excluded_lineage_ids: [],
      }),
      release_authority: release,
      subject_sha256: lineage.subject_sha256,
      excluded_identity_ids: derived.identity_ids,
      excluded_lineage_ids: derived.lineage_ids,
      exclusions_available: true,
      verifier_authority_current: true,
    });
    expect(usingReviewerIdentity.verifier_independent).toBe(false);
    expect(usingReviewerIdentity.blocker_codes).toContain("p12_verifier_not_independent");

    // A verifier using the exact P11 reviewer lineage (vera) is likewise rejected.
    const usingReviewerLineage = checkScaP12Independence({
      verifier_authority: resignVerifier(verifier, {
        verifier_lineage_id: "vera",
        excluded_identity_ids: [],
        excluded_lineage_ids: [],
      }),
      release_authority: release,
      subject_sha256: lineage.subject_sha256,
      excluded_identity_ids: derived.identity_ids,
      excluded_lineage_ids: derived.lineage_ids,
      exclusions_available: true,
      verifier_authority_current: true,
    });
    expect(usingReviewerLineage.verifier_independent).toBe(false);
    expect(usingReviewerLineage.blocker_codes).toContain("p12_verifier_not_independent");
  });

  it("rejects a non-empty tool set or a broader model from the verifier authority", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({ store, run_id: "run-subset", lane: "reporting_complete" });
    const verifier = validateScaP12VerifierAuthorityV1(
      readJson(store, lineage.verifier_authority_ref)
    );
    expect(() => resignVerifier(verifier, { allowed_tools: ["scanner"] })).toThrow();
    expect(() =>
      resignVerifier(verifier, {
        required_model: {
          schema_version: 1,
          alias: "deepseek-flash",
          provider: "ollama",
          model: "deepseek-v4.1-flash:cloud",
          override: "ollama/gpt-4o",
        },
      })
    ).toThrow();
  });

  it("re-derives the exact P11 evidence and produces supported verdicts", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({ store, run_id: "run-replay", lane: "reporting_complete" });
    const admitted = admitLineage(store, lineage);
    const scope = validateScaP12VerificationScopeV1(readJson(store, lineage.scope_ref));
    const replay = buildScaP12ReplayEvidenceV1({
      store,
      run_id: "run-replay",
      revision: 1,
      replay_lineage_id: "run-replay:p12-replay",
      admission: admitted,
      verification_scope: scope,
    });
    expect(replay.evidence.passed).toBe(true);
    expect(replay.evidence.spot_check_passed).toBe(true);
    expect(replay.evidence.checks.every((check) => check.passed)).toBe(true);

    const verifier = validateScaP12VerifierAuthorityV1(
      readJson(store, lineage.verifier_authority_ref)
    );
    const release = validateScaP12ReleaseAuthorityV1(
      readJson(store, lineage.release_authority_ref)
    );
    const independence = checkScaP12Independence({
      verifier_authority: verifier,
      release_authority: release,
      subject_sha256: lineage.subject_sha256,
      ...VERIFIER_DERIVED_EXCLUSIONS,
    });
    const verdicts = buildScaP12VerifierVerdictsV1({
      store,
      run_id: "run-replay",
      revision: 1,
      verification_scope: scope,
      facts: {
        scope_complete: true,
        independence,
        replay_passed: true,
        spot_check_passed: true,
        phase_gate_complete: true,
        obligation_ledger_complete: true,
        set_equality: true,
        no_unresolved: true,
        identity_valid: true,
        stale_free: true,
        release_claims_absent: true,
      },
    });
    expect(verdicts.evaluation.passed).toBe(true);
    expect(verdicts.verdicts.gate_verdict_set).toBe(false);

    const refuted = buildScaP12VerifierVerdictsV1({
      store,
      run_id: "run-replay",
      revision: 2,
      verification_scope: scope,
      facts: {
        scope_complete: true,
        independence,
        replay_passed: true,
        spot_check_passed: true,
        phase_gate_complete: true,
        obligation_ledger_complete: true,
        set_equality: true,
        no_unresolved: true,
        identity_valid: true,
        stale_free: true,
        release_claims_absent: true,
      },
    });
    expect(refuted.verdicts.verdicts.every((entry) => entry.verdict === "supported")).toBe(true);
  });

  it("invalidates an approval when any bound digest drifts, is rejected, or expires", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-approval",
      lane: "reporting_complete",
    });
    const release = validateScaP12ReleaseAuthorityV1(
      readJson(store, lineage.release_authority_ref)
    );
    const verifier = validateScaP12VerifierAuthorityV1(
      readJson(store, lineage.verifier_authority_ref)
    );
    const reportRef = required(lineage.p11_report_ref, "report");
    const { ref: gateRef, gate } = passReadyGate(store, "run-approval", reportRef);
    const separation = {
      separated_from_verifier: true,
      separated_from_report_production: true,
      distinct_from_release_authority: true,
    } as const;
    const approval = sealScaP12ReleaseApprovalV1({
      run_id: "run-approval",
      report_projection_ref: reportRef,
      report_projection_sha256: reportRef.content_digest,
      gate_ref: gateRef,
      gate_sha256: gateRef.content_digest,
      release_record_draft_sha256: "a".repeat(64),
      release_authority_ref: lineage.release_authority_ref,
      decision: "approved",
      human_principal_id: "p12-human-approver",
      authority_receipt_sha256: "f".repeat(64),
      decided_at: "2026-10-03T00:00:00.000Z",
      expires_at: "2026-12-31T00:00:00.000Z",
      ...separation,
    });
    const evaluate = (overrides: {
      readonly release_record_draft_sha256?: string;
      readonly now?: Date;
      readonly approval?: ScaP12ReleaseApprovalV1;
    }): ReturnType<typeof evaluateScaP12ReleaseApprovalV1> =>
      evaluateScaP12ReleaseApprovalV1({
        approval: overrides.approval ?? approval,
        gate,
        verifier_authority: verifier,
        release_authority: release,
        release_authority_ref: lineage.release_authority_ref,
        report_production_identity_ids: [],
        report_production_lineage_ids: [],
        report_projection_ref: reportRef,
        gate_ref: gateRef,
        release_record_draft_sha256: overrides.release_record_draft_sha256 ?? "a".repeat(64),
        now: overrides.now ?? new Date("2026-10-03T00:00:00.000Z"),
      });

    expect(evaluate({}).valid).toBe(true);
    expect(evaluate({ release_record_draft_sha256: "b".repeat(64) }).blocker_codes).toContain(
      "p12_release_approval_release_record_draft_drifted"
    );
    expect(evaluate({ now: new Date("2027-01-01T00:00:00.000Z") }).blocker_codes).toContain(
      "p12_release_approval_expired_or_not_yet_valid"
    );

    const rejected: ScaP12ReleaseApprovalV1 = sealScaP12ReleaseApprovalV1({
      run_id: "run-approval",
      report_projection_ref: reportRef,
      report_projection_sha256: reportRef.content_digest,
      gate_ref: gateRef,
      gate_sha256: gateRef.content_digest,
      release_record_draft_sha256: "a".repeat(64),
      release_authority_ref: lineage.release_authority_ref,
      decision: "rejected",
      human_principal_id: "p12-human-approver",
      authority_receipt_sha256: "f".repeat(64),
      decided_at: "2026-10-03T00:00:00.000Z",
      expires_at: "2026-12-31T00:00:00.000Z",
      ...separation,
    });
    expect(evaluate({ approval: rejected }).blocker_codes).toContain(
      "p12_release_approval_rejected"
    );

    // An approver that collides with the verifier identity is rejected even with `approved`.
    const colliding: ScaP12ReleaseApprovalV1 = sealScaP12ReleaseApprovalV1({
      run_id: "run-approval",
      report_projection_ref: reportRef,
      report_projection_sha256: reportRef.content_digest,
      gate_ref: gateRef,
      gate_sha256: gateRef.content_digest,
      release_record_draft_sha256: "a".repeat(64),
      release_authority_ref: lineage.release_authority_ref,
      decision: "approved",
      human_principal_id: verifier.verifier_identity_id,
      authority_receipt_sha256: "f".repeat(64),
      decided_at: "2026-10-03T00:00:00.000Z",
      expires_at: "2026-12-31T00:00:00.000Z",
      ...separation,
    });
    expect(evaluate({ approval: colliding }).blocker_codes).toContain(
      "p12_release_approver_not_separated_from_verifier"
    );
  });

  it("never returns an empty spot-check sample when findings exist and clamps to the admitted count", () => {
    expect([...deterministicSpotCheckSample(["a", "b", "c", "d", "e"], 4, 0)]).toHaveLength(1);
    expect([...deterministicSpotCheckSample(["a", "b", "c", "d", "e"], 4, 10)]).toHaveLength(5);
    expect([...deterministicSpotCheckSample([], 4, 4)]).toHaveLength(0);
    // Below the admitted threshold every finding is sampled.
    expect([...deterministicSpotCheckSample(["a", "b"], 4, 0)]).toHaveLength(2);
  });

  it("rejects a self-digest-tampered admission start", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({ store, run_id: "run-digest", lane: "reporting_complete" });
    const tampered = { ...lineage.constraints, run_id: "other-run" };
    // The change is not re-sealed: the closed contract must reject it.
    expect(() => validateScaP12CandidateStartV1(tampered)).not.toThrow();
    const drifted = { ...lineage.constraints, phase_id: "SCA-P11" };
    expect(() => validateScaP12CandidateStartV1(drifted)).toThrow();
  });
});
