import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore } from "../../src/artifact-store.js";
import {
  domainRecordIdentity,
  type ClaimRecordV1,
  type DecisionRecordV1,
  type EvidenceRefV1,
  type FindingRecordV1,
  type GateResultV1,
  type ManifestV1,
  type ScaDomainBundleV1,
  type ScaDomainRecordV1,
  type TaskRecordV1,
} from "../../src/sca/contracts.js";
import type { ScaEvidenceFamilyRuleV1 } from "../../src/sca/evidence.js";
import { createCanonicalReplay } from "../../src/sca/ledger.js";
import { requireValue } from "./narrowing.js";

export const SCA_TENANT_ID = "tenant-alpha";
export const SCA_PROJECT_ID = `prj_${"1".repeat(32)}`;
export const SCA_RUN_ID = "run-sca-contract";
export const SCA_PHASE_ID = "analyze";
export const SCA_TASK_ID = "task-primary";
export const SCA_CLAIM_ID = "claim-source-fact";
export const SCA_FINDING_ID = "finding-primary";
export const SCA_EVIDENCE_ID = "evidence-source";

function timestamp(sequence: number): string {
  return `2026-09-16T00:00:${String(sequence).padStart(2, "0")}Z`;
}

function persistFixtureArtifact(
  store: ArtifactStore,
  input: {
    readonly phase: string;
    readonly kind: string;
    readonly operationId: string;
    readonly mediaType: string;
    readonly content: string | Uint8Array;
  }
): ReturnType<ArtifactStore["persist"]> {
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: SCA_RUN_ID,
      phase: input.phase,
      branch_id: null,
      kind: input.kind,
      operation_id: input.operationId,
      version: 1,
      producer: "host:sca-fixture",
      media_type: input.mediaType,
      parent_ref: null,
      upstream_refs: [],
    },
    content: input.content,
  });
}

export interface ValidScaDomainFixture extends Disposable {
  readonly bundle: ScaDomainBundleV1;
  readonly records: readonly ScaDomainRecordV1[];
  readonly evidenceBytes: Uint8Array;
  readonly store: ArtifactStore;
  readonly familyRules: ReadonlyMap<string, ScaEvidenceFamilyRuleV1>;
  readonly root: string;
  readonly sourceSnapshotRef: ReturnType<ArtifactStore["persist"]>;
  readonly configRef: ReturnType<ArtifactStore["persist"]>;
  readonly provenanceRef: ReturnType<ArtifactStore["persist"]>;
}

export function createValidScaDomainFixture(): ValidScaDomainFixture {
  const root = mkdtempSync(join(tmpdir(), "penny-sca-domain-"));
  chmodSync(root, 0o700);
  const store = ArtifactStore.provision(root, { projectId: SCA_PROJECT_ID });
  try {
    const sourceSnapshotRef = persistFixtureArtifact(store, {
      phase: "admission",
      kind: "source-snapshot",
      operationId: "source-snapshot",
      mediaType: "application/octet-stream",
      content: "snapshot bytes",
    });
    const configRef = persistFixtureArtifact(store, {
      phase: "admission",
      kind: "sca-config",
      operationId: "sca-config",
      mediaType: "application/json",
      content: '{"profile":"fixture"}',
    });
    const provenanceRef = persistFixtureArtifact(store, {
      phase: "admission",
      kind: "sca-provenance",
      operationId: "sca-provenance",
      mediaType: "application/json",
      content: '{"producer":"fixture"}',
    });
    const evidenceBytes = Buffer.from("const café = unsafe(input);\nreturn café;\n", "utf8");
    const persistedEvidence = persistFixtureArtifact(store, {
      phase: SCA_PHASE_ID,
      kind: "sca-evidence",
      operationId: "evidence-source",
      mediaType: "text/plain; charset=utf-8",
      content: evidenceBytes,
    });
    const taskV1: TaskRecordV1 = {
      schema_id: "penny.sca-task-record.v1",
      schema_version: 1,
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
      phase_id: SCA_PHASE_ID,
      task_id: SCA_TASK_ID,
      obligation_id: "obligation-primary",
      task_type: "source.review",
      task_type_version: 1,
      obligation_class: "required_result",
      title: "Review the source path",
      status: "pending",
      decision_id: null,
      version: 1,
      sequence: 1,
      created_at: timestamp(1),
      updated_at: timestamp(1),
    };
    const taskV2: TaskRecordV1 = {
      ...taskV1,
      status: "active",
      version: 2,
      sequence: 2,
      updated_at: timestamp(2),
    };
    const evidence: EvidenceRefV1 = {
      schema_id: "penny.sca-evidence-ref.v1",
      schema_version: 1,
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
      phase_id: SCA_PHASE_ID,
      evidence_id: SCA_EVIDENCE_ID,
      task_id: SCA_TASK_ID,
      evidence_kind: "observation",
      artifact_ref: persistedEvidence,
      claim_classes: [
        "fact",
        "inference",
        "negative",
        "finding_confirmation",
        "finding_rejection",
        "finding_uncertainty",
        "obligation_disposition",
        "gate_completion",
      ],
      qualification: {
        schema_id: "penny.sca-family-evidence-qualification.v1",
        schema_version: 1,
        family_id: "source-analysis",
        family_version: 1,
        backend_id: "fixture-backend",
        status: "qualified",
        supported_claim_classes: [
          "fact",
          "inference",
          "negative",
          "finding_confirmation",
          "finding_rejection",
          "finding_uncertainty",
          "obligation_disposition",
          "gate_completion",
        ],
        source_snapshot_ref: sourceSnapshotRef,
        config_ref: configRef,
        provenance_ref: provenanceRef,
        complete: true,
        truncated: false,
        failure_status: "none",
        fidelity_note: "The fixture backend exactly covers the cited source bytes.",
      },
      negative_coverage: null,
      citations: [
        {
          citation_id: "citation-source-line",
          citation_class: "source",
          pointer: {
            pointer_type: "line_column_range",
            start: { line: 1, column: 1 },
            end_exclusive: { line: 1, column: 28 },
          },
        },
        {
          citation_id: "citation-causal-bytes",
          citation_class: "causal",
          pointer: { pointer_type: "byte_range", start_byte: 0, end_byte_exclusive: 28 },
        },
      ],
      summary: "The admitted source line reaches the unsafe call.",
      version: 1,
      sequence: 3,
      recorded_at: timestamp(3),
    };
    const claimV1: ClaimRecordV1 = {
      schema_id: "penny.sca-claim-record.v1",
      schema_version: 1,
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
      phase_id: SCA_PHASE_ID,
      claim_id: SCA_CLAIM_ID,
      task_id: SCA_TASK_ID,
      claim_class: "fact",
      subject_class: "source",
      statement: "The admitted source contains the unsafe call.",
      confidence: "CERTAIN",
      evidence_ids: [SCA_EVIDENCE_ID],
      inference_disclosure: null,
      status: "draft",
      decision_id: null,
      version: 1,
      sequence: 4,
      created_at: timestamp(4),
      updated_at: timestamp(4),
    };
    const claimV2: ClaimRecordV1 = {
      ...claimV1,
      status: "asserted",
      version: 2,
      sequence: 5,
      updated_at: timestamp(5),
    };
    const claimDecision: DecisionRecordV1 = {
      schema_id: "penny.sca-decision-record.v1",
      schema_version: 1,
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
      phase_id: SCA_PHASE_ID,
      decision_id: "decision-claim-accept",
      task_id: SCA_TASK_ID,
      decision_type: "claim_disposition",
      outcome: "approved",
      claim_ids: [SCA_CLAIM_ID],
      finding_ids: [],
      evidence_ids: [SCA_EVIDENCE_ID],
      rationale: "The exact cited source bytes support the factual claim.",
      confidence: "CERTAIN",
      version: 1,
      sequence: 6,
      recorded_at: timestamp(6),
    };
    const claimV3: ClaimRecordV1 = {
      ...claimV2,
      status: "accepted",
      decision_id: claimDecision.decision_id,
      version: 3,
      sequence: 7,
      updated_at: timestamp(7),
    };
    const findingV1: FindingRecordV1 = {
      schema_id: "penny.sca-finding-record.v1",
      schema_version: 1,
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
      phase_id: SCA_PHASE_ID,
      finding_id: SCA_FINDING_ID,
      task_id: SCA_TASK_ID,
      finding_type: "application.custom-unsafe-call",
      finding_type_version: 1,
      title: "Unsafe call receives admitted input",
      severity: "high",
      confidence: "PROBABLE",
      claim_ids: [SCA_CLAIM_ID],
      evidence_ids: [],
      investigation: null,
      status: "candidate",
      duplicate_of: null,
      decision_id: null,
      version: 1,
      sequence: 8,
      created_at: timestamp(8),
      updated_at: timestamp(8),
    };
    const findingV2: FindingRecordV1 = {
      ...findingV1,
      evidence_ids: [SCA_EVIDENCE_ID],
      investigation: {
        hypothesis: "Admitted input reaches the unsafe call without an effective guard.",
        competing_explanations: ["A guard may exist on a caller path outside the cited line."],
        expected_observations: ["The caller path supplies controllable input to the call."],
        stop_conditions: ["Stop if every reachable caller applies an effective guard."],
        reopening_conditions: ["Reopen if a new reachable unguarded caller is admitted."],
      },
      status: "investigating",
      version: 2,
      sequence: 9,
      updated_at: timestamp(9),
    };
    const findingDecision: DecisionRecordV1 = {
      schema_id: "penny.sca-decision-record.v1",
      schema_version: 1,
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
      phase_id: SCA_PHASE_ID,
      decision_id: "decision-finding-confirm",
      task_id: SCA_TASK_ID,
      decision_type: "finding_disposition",
      outcome: "approved",
      claim_ids: [],
      finding_ids: [SCA_FINDING_ID],
      evidence_ids: [SCA_EVIDENCE_ID],
      rationale: "The accepted claim and cited source support confirmation.",
      confidence: "PROBABLE",
      version: 1,
      sequence: 10,
      recorded_at: timestamp(10),
    };
    const findingV3: FindingRecordV1 = {
      ...findingV2,
      status: "confirmed",
      decision_id: findingDecision.decision_id,
      version: 3,
      sequence: 11,
      updated_at: timestamp(11),
    };
    const taskDecision: DecisionRecordV1 = {
      schema_id: "penny.sca-decision-record.v1",
      schema_version: 1,
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
      phase_id: SCA_PHASE_ID,
      decision_id: "decision-task-complete",
      task_id: SCA_TASK_ID,
      decision_type: "task_disposition",
      outcome: "approved",
      claim_ids: [],
      finding_ids: [],
      evidence_ids: [SCA_EVIDENCE_ID],
      rationale: "The required task has an accepted claim and confirmed finding.",
      confidence: "CERTAIN",
      version: 1,
      sequence: 12,
      recorded_at: timestamp(12),
    };
    const taskV3: TaskRecordV1 = {
      ...taskV2,
      status: "completed",
      decision_id: taskDecision.decision_id,
      version: 3,
      sequence: 13,
      updated_at: timestamp(13),
    };
    const gate: GateResultV1 = {
      schema_id: "penny.sca-gate-result.v1",
      schema_version: 1,
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
      phase_id: "completion-gate",
      gate_id: "gate-proof-complete",
      gate_type: "proof.complete",
      gate_type_version: 1,
      status: "passed",
      task_ids: [SCA_TASK_ID],
      decision_ids: [taskDecision.decision_id],
      evidence_ids: [SCA_EVIDENCE_ID],
      summary: "All required proof obligations are satisfied.",
      version: 1,
      sequence: 14,
      evaluated_at: timestamp(14),
    };
    const records: ScaDomainRecordV1[] = [
      taskV1,
      taskV2,
      evidence,
      claimV1,
      claimV2,
      claimDecision,
      claimV3,
      findingV1,
      findingV2,
      findingDecision,
      findingV3,
      taskDecision,
      taskV3,
      gate,
    ];
    const replay = createCanonicalReplay(records);
    const first = requireValue(replay.records[0], "first SCA replay record");
    const last = requireValue(replay.records[replay.records.length - 1], "last SCA replay record");
    const manifest: ManifestV1 = {
      schema_id: "penny.sca-manifest.v1",
      schema_version: 1,
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
      manifest_id: "manifest-primary",
      records: replay.records.map((record) => domainRecordIdentity(record)),
      record_count: replay.records.length,
      first_sequence: first.sequence,
      last_sequence: last.sequence,
      ledger_sha256: replay.sha256,
      created_at: timestamp(14),
    };
    const familyRule: ScaEvidenceFamilyRuleV1 = {
      family_id: evidence.qualification.family_id,
      family_version: evidence.qualification.family_version,
      backend_id: evidence.qualification.backend_id,
      supported_claim_classes: evidence.qualification.supported_claim_classes,
      source_snapshot_ref: evidence.qualification.source_snapshot_ref,
      config_ref: evidence.qualification.config_ref,
      provenance_ref: evidence.qualification.provenance_ref,
    };
    const fixture: Omit<ValidScaDomainFixture, typeof Symbol.dispose> = {
      evidenceBytes,
      records,
      store,
      familyRules: new Map([[`${familyRule.family_id}@${familyRule.family_version}`, familyRule]]),
      root,
      sourceSnapshotRef,
      configRef,
      provenanceRef,
      bundle: {
        manifest,
        tasks: [taskV1, taskV2, taskV3],
        claims: [claimV1, claimV2, claimV3],
        evidence: [evidence],
        findings: [findingV1, findingV2, findingV3],
        decisions: [claimDecision, findingDecision, taskDecision],
        gates: [gate],
      },
    };
    return {
      ...fixture,
      [Symbol.dispose](): void {
        store.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    store.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
