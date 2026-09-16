import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { sha256 } from "../src/canonical-json.js";
import {
  domainRecordIdentity,
  domainRecordTimestamp,
  type ClaimRecordV1,
  type DecisionRecordV1,
  type FindingRecordV1,
  type ScaDomainBundleV1,
  type ScaDomainRecordV1,
  type TaskRecordV1,
} from "../src/sca/contracts.js";
import {
  validateEvidenceCorpus,
  validateEvidencePointers,
  validateProofObligations,
  validateScaDomainBundle,
} from "../src/sca/evidence.js";
import { createCanonicalReplay } from "../src/sca/ledger.js";
import { requireValue } from "./helpers/narrowing.js";
import {
  SCA_CLAIM_ID,
  SCA_EVIDENCE_ID,
  SCA_FINDING_ID,
  SCA_PROJECT_ID,
  createValidScaDomainFixture,
} from "./helpers/sca-domain-fixtures.js";

class TemporaryArtifactStore implements Disposable {
  readonly root: string;
  readonly store: ArtifactStore;

  constructor(projectId: string) {
    this.root = mkdtempSync(join(tmpdir(), "penny-sca-evidence-store-"));
    chmodSync(this.root, 0o700);
    this.store = ArtifactStore.provision(this.root, { projectId });
  }

  [Symbol.dispose](): void {
    this.store.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

function rebuildBundle(
  bundle: ScaDomainBundleV1,
  changes: Partial<
    Pick<ScaDomainBundleV1, "tasks" | "claims" | "evidence" | "findings" | "decisions" | "gates">
  >
): ScaDomainBundleV1 {
  const changed: ScaDomainBundleV1 = { ...bundle, ...changes };
  const records: ScaDomainRecordV1[] = [
    ...changed.tasks,
    ...changed.claims,
    ...changed.evidence,
    ...changed.findings,
    ...changed.decisions,
    ...changed.gates,
  ];
  const replay = createCanonicalReplay(records);
  const first = requireValue(replay.records[0], "first rebuilt record");
  const last = requireValue(replay.records[replay.records.length - 1], "last rebuilt record");
  return {
    ...changed,
    manifest: {
      ...changed.manifest,
      records: replay.records.map((record) => domainRecordIdentity(record)),
      record_count: replay.records.length,
      first_sequence: first.sequence,
      last_sequence: last.sequence,
      ledger_sha256: replay.sha256,
      created_at: domainRecordTimestamp(last),
    },
  };
}

function changeClaims(
  claims: readonly ClaimRecordV1[],
  change: (record: ClaimRecordV1) => ClaimRecordV1
): ClaimRecordV1[] {
  return claims.map(change);
}

function time(sequence: number): string {
  return `2026-09-16T00:00:${String(sequence).padStart(2, "0")}Z`;
}

describe("S-01 artifact custody, evidence qualification, and proof obligations", () => {
  it("validates persisted evidence through the bound ArtifactStore", () => {
    using fixture = createValidScaDomainFixture();
    const evidence = requireValue(fixture.bundle.evidence[0], "evidence");

    expect(validateEvidencePointers(evidence, fixture.evidenceBytes)).toEqual(evidence);
    expect(validateEvidenceCorpus(fixture.bundle, fixture.store)).toEqual(fixture.bundle);
    expect(validateProofObligations(fixture.bundle, fixture.store, fixture.familyRules)).toEqual(
      fixture.bundle
    );
  });

  it("rejects a missing, forged, or cross-project artifact store binding", () => {
    using fixture = createValidScaDomainFixture();
    using missing = new TemporaryArtifactStore(SCA_PROJECT_ID);
    using foreign = new TemporaryArtifactStore(`prj_${"2".repeat(32)}`);
    const evidence = requireValue(fixture.bundle.evidence[0], "evidence");

    expect(() => validateEvidenceCorpus(fixture.bundle, missing.store)).toThrow(/absent/u);
    expect(() => validateEvidenceCorpus(fixture.bundle, foreign.store)).toThrow(
      /another Penny project/u
    );
    expect(() =>
      validateEvidenceCorpus(
        rebuildBundle(fixture.bundle, {
          evidence: [
            {
              ...evidence,
              artifact_ref: {
                ...evidence.artifact_ref,
                artifact_id: `art_${"f".repeat(64)}`,
              },
            },
          ],
        }),
        fixture.store
      )
    ).toThrow(/canonical identity|absent/u);
  });

  it("allows arbitrary binary bytes for byte ranges but requires UTF-8 for line/column pointers", () => {
    using fixture = createValidScaDomainFixture();
    const evidence = requireValue(fixture.bundle.evidence[0], "evidence");
    const binary = Uint8Array.from([0xff, 0x00, 0xc3, 0x28]);
    const digest = sha256(binary);
    const binaryEvidence = {
      ...evidence,
      artifact_ref: {
        ...evidence.artifact_ref,
        byte_length: binary.byteLength,
        content_digest: digest,
        store_ref: `artifact://sha256/${digest}`,
      },
      citations: [
        {
          citation_id: "citation-binary",
          citation_class: "source" as const,
          pointer: {
            pointer_type: "byte_range" as const,
            start_byte: 1,
            end_byte_exclusive: 3,
          },
        },
      ],
    };
    expect(validateEvidencePointers(binaryEvidence, binary)).toMatchObject({
      evidence_id: SCA_EVIDENCE_ID,
    });
    expect(() =>
      validateEvidencePointers(
        {
          ...binaryEvidence,
          citations: [
            {
              citation_id: "citation-text",
              citation_class: "source",
              pointer: {
                pointer_type: "line_column_range",
                start: { line: 1, column: 1 },
                end_exclusive: { line: 1, column: 2 },
              },
            },
          ],
        },
        binary
      )
    ).toThrow(/valid UTF-8/u);
  });

  it("rejects out-of-bounds byte and Unicode-code-point line ranges", () => {
    using fixture = createValidScaDomainFixture();
    const evidence = requireValue(fixture.bundle.evidence[0], "evidence");
    const citation = requireValue(evidence.citations[0], "citation");

    expect(() =>
      validateEvidencePointers(
        {
          ...evidence,
          citations: [
            {
              ...citation,
              pointer: {
                pointer_type: "byte_range",
                start_byte: 0,
                end_byte_exclusive: fixture.evidenceBytes.byteLength + 1,
              },
            },
          ],
        },
        fixture.evidenceBytes
      )
    ).toThrow(/byte_length|byte bounds/u);
    expect(() =>
      validateEvidencePointers(
        {
          ...evidence,
          citations: [
            {
              ...citation,
              pointer: {
                pointer_type: "line_column_range",
                start: { line: 20, column: 1 },
                end_exclusive: { line: 20, column: 2 },
              },
            },
          ],
        },
        fixture.evidenceBytes
      )
    ).toThrow(/line exceeds/u);
    expect(() =>
      validateEvidencePointers(
        {
          ...evidence,
          citations: [
            {
              ...citation,
              pointer: {
                pointer_type: "line_column_range",
                start: { line: 1, column: 200 },
                end_exclusive: { line: 2, column: 1 },
              },
            },
          ],
        },
        fixture.evidenceBytes
      )
    ).toThrow(/column exceeds/u);
  });

  it("requires qualified evidence that explicitly supports the claim class", () => {
    using fixture = createValidScaDomainFixture();
    const evidence = requireValue(fixture.bundle.evidence[0], "evidence");
    const unsupported = rebuildBundle(fixture.bundle, {
      evidence: [{ ...evidence, claim_classes: ["negative"] }],
    });
    expect(() => validateProofObligations(unsupported, fixture.store, fixture.familyRules)).toThrow(
      /not qualified for claim class 'fact'/u
    );

    const unavailable = rebuildBundle(fixture.bundle, {
      evidence: [
        {
          ...evidence,
          qualification: {
            ...evidence.qualification,
            status: "unavailable",
            complete: false,
            failure_status: "unavailable",
          },
        },
      ],
    });
    expect(() => validateProofObligations(unavailable, fixture.store, fixture.familyRules)).toThrow(
      /not qualified/u
    );

    const rule = requireValue(
      fixture.familyRules.get("source-analysis@1"),
      "source-analysis family rule"
    );
    const forgedRules = new Map([
      ["source-analysis@1", { ...rule, backend_id: "different-backend" }],
    ]);
    expect(() => validateProofObligations(fixture.bundle, fixture.store, forgedRules)).toThrow(
      /does not match its admitted family rule/u
    );
  });

  it("rejects negative claims without complete snapshot-bound, nontruncated coverage", () => {
    using fixture = createValidScaDomainFixture();
    const evidence = requireValue(fixture.bundle.evidence[0], "evidence");
    const negative = rebuildBundle(fixture.bundle, {
      claims: changeClaims(fixture.bundle.claims, (record) => ({
        ...record,
        claim_class: "negative",
      })),
      evidence: [
        {
          ...evidence,
          evidence_kind: "coverage",
          negative_coverage: {
            schema_id: "penny.sca-negative-coverage.v1",
            schema_version: 1,
            source_snapshot_ref: fixture.sourceSnapshotRef,
            source_snapshot_sha256: fixture.sourceSnapshotRef.content_digest,
            coverage_scope_ref: evidence.artifact_ref,
            status: "incomplete",
            truncated: true,
            failure_status: "failed",
          },
        },
      ],
    });
    expect(() => validateProofObligations(negative, fixture.store, fixture.familyRules)).toThrow(
      /complete, nontruncated, failure-free snapshot-bound negative coverage/u
    );
  });

  it("rejects passed gates with open claims/findings, an omitted required task, or wrong decisions", () => {
    using fixture = createValidScaDomainFixture();
    const openClaim = rebuildBundle(fixture.bundle, {
      claims: fixture.bundle.claims.slice(0, 2),
      findings: [],
      decisions: [
        requireValue(fixture.bundle.decisions[0], "claim decision"),
        requireValue(fixture.bundle.decisions[2], "task decision"),
      ],
    });
    expect(() => validateProofObligations(openClaim, fixture.store, fixture.familyRules)).toThrow(
      /open claim/u
    );

    const openFinding = rebuildBundle(fixture.bundle, {
      findings: fixture.bundle.findings.slice(0, 2),
    });
    expect(() => validateProofObligations(openFinding, fixture.store, fixture.familyRules)).toThrow(
      /open finding/u
    );

    const secondTaskV1: TaskRecordV1 = {
      ...requireValue(fixture.bundle.tasks[0], "task v1"),
      task_id: "task-required-second",
      sequence: 15,
      created_at: time(15),
      updated_at: time(15),
    };
    const secondTaskV2: TaskRecordV1 = {
      ...secondTaskV1,
      status: "active",
      version: 2,
      sequence: 16,
      updated_at: time(16),
    };
    const secondEvidence = {
      ...requireValue(fixture.bundle.evidence[0], "evidence"),
      evidence_id: "evidence-task-second",
      task_id: secondTaskV1.task_id,
      sequence: 17,
      recorded_at: time(17),
    };
    const secondDecision: DecisionRecordV1 = {
      ...requireValue(fixture.bundle.decisions[2], "task decision"),
      decision_id: "decision-task-second",
      task_id: secondTaskV1.task_id,
      evidence_ids: [secondEvidence.evidence_id],
      sequence: 18,
      recorded_at: time(18),
    };
    const secondTaskV3: TaskRecordV1 = {
      ...secondTaskV2,
      status: "completed",
      decision_id: secondDecision.decision_id,
      version: 3,
      sequence: 19,
      updated_at: time(19),
    };
    const gate = requireValue(fixture.bundle.gates[0], "gate");
    const omitted = rebuildBundle(fixture.bundle, {
      tasks: [...fixture.bundle.tasks, secondTaskV1, secondTaskV2, secondTaskV3],
      evidence: [...fixture.bundle.evidence, secondEvidence],
      decisions: [...fixture.bundle.decisions, secondDecision],
      gates: [{ ...gate, sequence: 20, evaluated_at: time(20) }],
    });
    expect(() => validateProofObligations(omitted, fixture.store, fixture.familyRules)).toThrow(
      /omits nonoptional task/u
    );

    const wrongDecision = rebuildBundle(fixture.bundle, {
      gates: [{ ...gate, decision_ids: ["decision-claim-accept"] }],
    });
    expect(() =>
      validateProofObligations(wrongDecision, fixture.store, fixture.familyRules)
    ).toThrow(/exactly its task decisions/u);
  });

  it("requires required_result completion but permits evidenced terminal attempt_and_report", () => {
    using fixture = createValidScaDomainFixture();
    const taskDecision = requireValue(fixture.bundle.decisions[2], "task decision");
    const gate = requireValue(fixture.bundle.gates[0], "gate");
    const unavailableTasks = fixture.bundle.tasks.map((task) =>
      task.version === 1
        ? task
        : task.version === 2
          ? task
          : { ...task, status: "unavailable" as const }
    );
    const blockedDecision: DecisionRecordV1 = { ...taskDecision, outcome: "blocked" };
    const required = rebuildBundle(fixture.bundle, {
      tasks: unavailableTasks,
      decisions: [...fixture.bundle.decisions.slice(0, 2), blockedDecision],
      gates: [{ ...gate, decision_ids: [blockedDecision.decision_id] }],
    });
    expect(() => validateProofObligations(required, fixture.store, fixture.familyRules)).toThrow(
      /uncompleted required_result/u
    );

    const attempted = rebuildBundle(required, {
      tasks: unavailableTasks.map((task) => ({ ...task, obligation_class: "attempt_and_report" })),
    });
    expect(validateProofObligations(attempted, fixture.store, fixture.familyRules)).toEqual(
      attempted
    );
  });

  it("requires accepted inference bases rather than rejected or draft bases", () => {
    using fixture = createValidScaDomainFixture();
    const basisDecision = requireValue(fixture.bundle.decisions[0], "basis decision");
    const rejectedClaims = changeClaims(fixture.bundle.claims, (claim) =>
      claim.version === 3 ? { ...claim, status: "rejected" } : claim
    );
    const inferenceV1: ClaimRecordV1 = {
      ...requireValue(fixture.bundle.claims[0], "claim v1"),
      claim_id: "claim-inference",
      claim_class: "inference",
      inference_disclosure: {
        basis_claim_ids: [SCA_CLAIM_ID],
        rationale: "The rejected basis must not support this inference.",
      },
      sequence: 15,
      created_at: time(15),
      updated_at: time(15),
    };
    const inferenceV2: ClaimRecordV1 = {
      ...inferenceV1,
      status: "asserted",
      version: 2,
      sequence: 16,
      updated_at: time(16),
    };
    const inferenceDecision: DecisionRecordV1 = {
      ...basisDecision,
      decision_id: "decision-inference",
      claim_ids: [inferenceV1.claim_id],
      sequence: 17,
      recorded_at: time(17),
    };
    const inferenceV3: ClaimRecordV1 = {
      ...inferenceV2,
      status: "accepted",
      decision_id: inferenceDecision.decision_id,
      version: 3,
      sequence: 18,
      updated_at: time(18),
    };
    const rejectedBasisDecision: DecisionRecordV1 = { ...basisDecision, outcome: "rejected" };
    const value = rebuildBundle(fixture.bundle, {
      claims: [...rejectedClaims, inferenceV1, inferenceV2, inferenceV3],
      findings: [],
      gates: [],
      decisions: [
        rejectedBasisDecision,
        requireValue(fixture.bundle.decisions[2], "task decision"),
        inferenceDecision,
      ],
    });
    expect(() => validateProofObligations(value, fixture.store, fixture.familyRules)).toThrow(
      /inference basis.*not accepted/u
    );
  });

  it("rejects duplicate chains and cycles by requiring a non-duplicate target", () => {
    using fixture = createValidScaDomainFixture();
    const baseFinding = requireValue(fixture.bundle.findings[0], "base finding");
    const investigatedFinding = requireValue(fixture.bundle.findings[1], "investigated finding");
    const baseDecision = requireValue(fixture.bundle.decisions[1], "finding decision");
    const duplicateAV1: FindingRecordV1 = {
      ...baseFinding,
      finding_id: "finding-duplicate-a",
      sequence: 15,
      created_at: time(15),
      updated_at: time(15),
    };
    const duplicateAV2: FindingRecordV1 = {
      ...duplicateAV1,
      evidence_ids: investigatedFinding.evidence_ids,
      investigation: investigatedFinding.investigation,
      status: "investigating",
      version: 2,
      sequence: 16,
      updated_at: time(16),
    };
    const decisionA: DecisionRecordV1 = {
      ...baseDecision,
      decision_id: "decision-duplicate-a",
      outcome: "rejected",
      finding_ids: [duplicateAV1.finding_id],
      sequence: 17,
      recorded_at: time(17),
    };
    const duplicateAV3: FindingRecordV1 = {
      ...duplicateAV2,
      status: "duplicate",
      duplicate_of: SCA_FINDING_ID,
      decision_id: decisionA.decision_id,
      version: 3,
      sequence: 18,
      updated_at: time(18),
    };
    const duplicateBV1: FindingRecordV1 = {
      ...duplicateAV1,
      finding_id: "finding-duplicate-b",
      sequence: 19,
      created_at: time(19),
      updated_at: time(19),
    };
    const duplicateBV2: FindingRecordV1 = {
      ...duplicateBV1,
      evidence_ids: investigatedFinding.evidence_ids,
      investigation: investigatedFinding.investigation,
      status: "investigating",
      version: 2,
      sequence: 20,
      updated_at: time(20),
    };
    const decisionB: DecisionRecordV1 = {
      ...decisionA,
      decision_id: "decision-duplicate-b",
      finding_ids: [duplicateBV1.finding_id],
      sequence: 21,
      recorded_at: time(21),
    };
    const duplicateBV3: FindingRecordV1 = {
      ...duplicateBV2,
      status: "duplicate",
      duplicate_of: duplicateAV1.finding_id,
      decision_id: decisionB.decision_id,
      version: 3,
      sequence: 22,
      updated_at: time(22),
    };
    const chain = rebuildBundle(fixture.bundle, {
      findings: [
        ...fixture.bundle.findings,
        duplicateAV1,
        duplicateAV2,
        duplicateAV3,
        duplicateBV1,
        duplicateBV2,
        duplicateBV3,
      ],
      decisions: [...fixture.bundle.decisions, decisionA, decisionB],
      gates: [],
    });
    expect(() => validateScaDomainBundle(chain)).toThrow(/non-duplicate finding/u);

    const cycle = rebuildBundle(fixture.bundle, {
      findings: [
        ...fixture.bundle.findings,
        duplicateAV1,
        duplicateAV2,
        { ...duplicateAV3, duplicate_of: duplicateBV1.finding_id },
        duplicateBV1,
        duplicateBV2,
        { ...duplicateBV3, duplicate_of: duplicateAV1.finding_id },
      ],
      decisions: [...fixture.bundle.decisions, decisionA, decisionB],
      gates: [],
    });
    expect(() => validateScaDomainBundle(cycle)).toThrow(/earlier ledger record|non-duplicate/u);
  });

  it("fails closed on cross-project domain records", () => {
    using fixture = createValidScaDomainFixture();
    const decision = requireValue(fixture.bundle.decisions[0], "decision");
    expect(() =>
      validateScaDomainBundle({
        ...fixture.bundle,
        decisions: [
          { ...decision, project_id: `prj_${"3".repeat(32)}` },
          ...fixture.bundle.decisions.slice(1),
        ],
      })
    ).toThrow(/project_id|project/u);
  });
});
