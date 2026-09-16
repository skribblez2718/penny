import type { ArtifactStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import type { ScaEvidenceClaimClass } from "../skill-contracts/sca.js";
import {
  ScaDomainValidationError,
  compareRfc3339Utc,
  domainRecordIdentity,
  domainRecordTimestamp,
  validateClaimRecord,
  validateDecisionRecord,
  validateEvidenceRef,
  validateFindingRecord,
  validateGateResult,
  validateManifest,
  validateScaDomainBundleShape,
  validateTaskRecord,
  type ClaimRecordV1,
  type DecisionRecordV1,
  type EvidenceRefV1,
  type FindingRecordV1,
  type GateResultV1,
  type ManifestRecordLocatorV1,
  type ScaDomainBundleV1,
  type ScaDomainRecordV1,
  type TaskRecordV1,
} from "./contracts.js";
import { createCanonicalReplay } from "./ledger.js";

export interface ScaEvidenceFamilyRuleV1 {
  readonly family_id: string;
  readonly family_version: number;
  readonly backend_id: string;
  readonly supported_claim_classes: readonly ScaEvidenceClaimClass[];
  readonly source_snapshot_ref: ArtifactRef;
  readonly config_ref: ArtifactRef;
  readonly provenance_ref: ArtifactRef;
}

export type ScaEvidenceFamilyRuleRegistryV1 = ReadonlyMap<string, ScaEvidenceFamilyRuleV1>;

export function scaEvidenceFamilyRuleKey(rule: {
  readonly family_id: string;
  readonly family_version: number;
}): string {
  return `${rule.family_id}@${rule.family_version}`;
}

function fail(label: string, issue: string): never {
  throw new ScaDomainValidationError(label, [issue]);
}

function latestByVersion<T extends { readonly version: number }>(
  records: readonly T[],
  idOf: (record: T) => string
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const record of records) {
    const id = idOf(record);
    const current = latest.get(id);
    if (current === undefined || record.version > current.version) latest.set(id, record);
  }
  return latest;
}

function exactLocator(locator: ManifestRecordLocatorV1): string {
  return `${locator.record_type}:${locator.record_id}:${locator.record_version}:${locator.sequence}`;
}

function recordLocator(record: ScaDomainRecordV1): string {
  const identity = domainRecordIdentity(record);
  return `${identity.record_type}:${identity.record_id}:${identity.record_version}:${identity.sequence}`;
}

function requireReference<T>(map: ReadonlyMap<string, T>, id: string, label: string): T {
  const value = map.get(id);
  if (value === undefined) fail("SCA referential integrity", `${label} '${id}' does not exist`);
  return value;
}

function assertSameTask(taskId: string, referencedTaskId: string, label: string): void {
  if (taskId !== referencedTaskId) {
    fail("SCA referential integrity", `${label} crosses task ownership`);
  }
}

function assertSamePhase(phaseId: string, referencedPhaseId: string, label: string): void {
  if (phaseId !== referencedPhaseId) {
    fail("SCA referential integrity", `${label} crosses phase ownership`);
  }
}

function assertEarlier(sequence: number, referencedSequence: number, label: string): void {
  if (referencedSequence >= sequence) {
    fail("SCA referential integrity", `${label} must refer to an earlier ledger record`);
  }
}

function indexImmutable<T>(
  records: readonly T[],
  idOf: (record: T) => string,
  label: string
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const record of records) {
    const id = idOf(record);
    if (indexed.has(id)) fail("SCA referential integrity", `duplicate ${label} '${id}'`);
    indexed.set(id, record);
  }
  return indexed;
}

function introducedSequences<T extends { readonly sequence: number }>(
  records: readonly T[],
  idOf: (record: T) => string
): Map<string, number> {
  const introduced = new Map<string, number>();
  for (const record of records) {
    const id = idOf(record);
    const current = introduced.get(id);
    if (current === undefined || record.sequence < current) introduced.set(id, record.sequence);
  }
  return introduced;
}

function validateReferenceGraph(input: {
  readonly tasks: ReadonlyMap<string, TaskRecordV1>;
  readonly taskIntroduced: ReadonlyMap<string, number>;
  readonly claims: ReadonlyMap<string, ClaimRecordV1>;
  readonly claimIntroduced: ReadonlyMap<string, number>;
  readonly evidence: ReadonlyMap<string, EvidenceRefV1>;
  readonly findings: ReadonlyMap<string, FindingRecordV1>;
  readonly findingIntroduced: ReadonlyMap<string, number>;
  readonly decisions: ReadonlyMap<string, DecisionRecordV1>;
  readonly gates: ReadonlyMap<string, GateResultV1>;
}): void {
  for (const evidence of input.evidence.values()) {
    const task = requireReference(input.tasks, evidence.task_id, "evidence task");
    const introduced = requireReference(input.taskIntroduced, evidence.task_id, "evidence task");
    assertSamePhase(evidence.phase_id, task.phase_id, "evidence task");
    assertEarlier(evidence.sequence, introduced, "evidence task");
  }

  for (const claim of input.claims.values()) {
    const task = requireReference(input.tasks, claim.task_id, "claim task");
    const taskIntroduced = requireReference(input.taskIntroduced, claim.task_id, "claim task");
    assertSamePhase(claim.phase_id, task.phase_id, "claim task");
    assertEarlier(claim.sequence, taskIntroduced, "claim task");
    for (const evidenceId of claim.evidence_ids) {
      const evidence = requireReference(input.evidence, evidenceId, "claim evidence");
      assertSameTask(claim.task_id, evidence.task_id, "claim evidence");
      assertSamePhase(claim.phase_id, evidence.phase_id, "claim evidence");
      assertEarlier(claim.sequence, evidence.sequence, "claim evidence");
    }
    if (claim.inference_disclosure !== null) {
      for (const basisId of claim.inference_disclosure.basis_claim_ids) {
        const basis = requireReference(input.claims, basisId, "basis claim");
        const introduced = requireReference(input.claimIntroduced, basisId, "basis claim");
        assertSameTask(claim.task_id, basis.task_id, "basis claim");
        assertSamePhase(claim.phase_id, basis.phase_id, "basis claim");
        assertEarlier(claim.sequence, introduced, "basis claim");
      }
    }
    if (claim.decision_id !== null) {
      const decision = requireReference(input.decisions, claim.decision_id, "claim decision");
      assertSameTask(claim.task_id, decision.task_id, "claim decision");
      assertSamePhase(claim.phase_id, decision.phase_id, "claim decision");
      assertEarlier(claim.sequence, decision.sequence, "claim decision");
    }
  }

  for (const finding of input.findings.values()) {
    const task = requireReference(input.tasks, finding.task_id, "finding task");
    const taskIntroduced = requireReference(input.taskIntroduced, finding.task_id, "finding task");
    assertSamePhase(finding.phase_id, task.phase_id, "finding task");
    assertEarlier(finding.sequence, taskIntroduced, "finding task");
    for (const claimId of finding.claim_ids) {
      const claim = requireReference(input.claims, claimId, "finding claim");
      const introduced = requireReference(input.claimIntroduced, claimId, "finding claim");
      assertSameTask(finding.task_id, claim.task_id, "finding claim");
      assertSamePhase(finding.phase_id, claim.phase_id, "finding claim");
      assertEarlier(finding.sequence, introduced, "finding claim");
    }
    for (const evidenceId of finding.evidence_ids) {
      const evidence = requireReference(input.evidence, evidenceId, "finding evidence");
      assertSameTask(finding.task_id, evidence.task_id, "finding evidence");
      assertSamePhase(finding.phase_id, evidence.phase_id, "finding evidence");
      assertEarlier(finding.sequence, evidence.sequence, "finding evidence");
    }
    if (finding.duplicate_of !== null) {
      const original = requireReference(input.findings, finding.duplicate_of, "duplicate finding");
      const introduced = requireReference(
        input.findingIntroduced,
        finding.duplicate_of,
        "duplicate finding"
      );
      assertSameTask(finding.task_id, original.task_id, "duplicate finding");
      assertSamePhase(finding.phase_id, original.phase_id, "duplicate finding");
      if (original.status === "duplicate") {
        fail("SCA referential integrity", "duplicate finding must target a non-duplicate finding");
      }
      assertEarlier(finding.sequence, introduced, "duplicate finding");
    }
    if (finding.decision_id !== null) {
      const decision = requireReference(input.decisions, finding.decision_id, "finding decision");
      assertSameTask(finding.task_id, decision.task_id, "finding decision");
      assertSamePhase(finding.phase_id, decision.phase_id, "finding decision");
      assertEarlier(finding.sequence, decision.sequence, "finding decision");
    }
  }

  for (const decision of input.decisions.values()) {
    const task = requireReference(input.tasks, decision.task_id, "decision task");
    const taskIntroduced = requireReference(
      input.taskIntroduced,
      decision.task_id,
      "decision task"
    );
    assertSamePhase(decision.phase_id, task.phase_id, "decision task");
    assertEarlier(decision.sequence, taskIntroduced, "decision task");
    for (const claimId of decision.claim_ids) {
      const claim = requireReference(input.claims, claimId, "decision claim");
      const introduced = requireReference(input.claimIntroduced, claimId, "decision claim");
      assertSameTask(decision.task_id, claim.task_id, "decision claim");
      assertSamePhase(decision.phase_id, claim.phase_id, "decision claim");
      assertEarlier(decision.sequence, introduced, "decision claim");
    }
    for (const findingId of decision.finding_ids) {
      const finding = requireReference(input.findings, findingId, "decision finding");
      const introduced = requireReference(input.findingIntroduced, findingId, "decision finding");
      assertSameTask(decision.task_id, finding.task_id, "decision finding");
      assertSamePhase(decision.phase_id, finding.phase_id, "decision finding");
      assertEarlier(decision.sequence, introduced, "decision finding");
    }
    for (const evidenceId of decision.evidence_ids) {
      const evidence = requireReference(input.evidence, evidenceId, "decision evidence");
      assertSameTask(decision.task_id, evidence.task_id, "decision evidence");
      assertSamePhase(decision.phase_id, evidence.phase_id, "decision evidence");
      assertEarlier(decision.sequence, evidence.sequence, "decision evidence");
    }
  }

  for (const task of input.tasks.values()) {
    if (task.decision_id !== null) {
      const decision = requireReference(input.decisions, task.decision_id, "task decision");
      assertSameTask(task.task_id, decision.task_id, "task decision");
      assertSamePhase(task.phase_id, decision.phase_id, "task decision");
      assertEarlier(task.sequence, decision.sequence, "task decision");
    }
  }

  for (const gate of input.gates.values()) {
    for (const taskId of gate.task_ids) {
      const task = requireReference(input.tasks, taskId, "gate task");
      assertEarlier(gate.sequence, task.sequence, "gate task");
    }
    for (const decisionId of gate.decision_ids) {
      const decision = requireReference(input.decisions, decisionId, "gate decision");
      if (!gate.task_ids.includes(decision.task_id)) {
        fail("SCA referential integrity", "gate decision task must appear in gate.task_ids");
      }
      assertEarlier(gate.sequence, decision.sequence, "gate decision");
    }
    for (const evidenceId of gate.evidence_ids) {
      const evidence = requireReference(input.evidence, evidenceId, "gate evidence");
      if (!gate.task_ids.includes(evidence.task_id)) {
        fail("SCA referential integrity", "gate evidence task must appear in gate.task_ids");
      }
      assertEarlier(gate.sequence, evidence.sequence, "gate evidence");
    }
  }
}

export function validateScaDomainBundle(value: unknown): ScaDomainBundleV1 {
  const shaped = validateScaDomainBundleShape(value);
  const manifest = validateManifest(shaped.manifest);
  const tasks = shaped.tasks.map((record) => validateTaskRecord(record));
  const claims = shaped.claims.map((record) => validateClaimRecord(record));
  const evidence = shaped.evidence.map((record) => validateEvidenceRef(record));
  const findings = shaped.findings.map((record) => validateFindingRecord(record));
  const decisions = shaped.decisions.map((record) => validateDecisionRecord(record));
  const gates = shaped.gates.map((record) => validateGateResult(record));
  const records: ScaDomainRecordV1[] = [
    ...tasks,
    ...claims,
    ...evidence,
    ...findings,
    ...decisions,
    ...gates,
  ];
  const replay = createCanonicalReplay(records);
  if (
    manifest.tenant_id !== replay.tenant_id ||
    manifest.project_id !== replay.project_id ||
    manifest.run_id !== replay.run_id
  ) {
    fail(
      "SCA referential integrity",
      "manifest tenant_id/project_id/run_id must match every record"
    );
  }
  if (manifest.ledger_sha256 !== replay.sha256) {
    fail("SCA referential integrity", "manifest ledger_sha256 does not match canonical replay");
  }
  if (manifest.record_count !== replay.records.length) {
    fail("SCA referential integrity", "manifest record_count does not match replay");
  }
  const expectedLocators = replay.records.map((record) => recordLocator(record));
  const actualLocators = manifest.records.map((locator) => exactLocator(locator));
  if (
    expectedLocators.length !== actualLocators.length ||
    expectedLocators.some((locator, index) => actualLocators[index] !== locator)
  ) {
    fail("SCA referential integrity", "manifest locators do not exactly bind replay records");
  }
  const last = replay.records[replay.records.length - 1];
  if (
    last === undefined ||
    compareRfc3339Utc(manifest.created_at, domainRecordTimestamp(last)) < 0
  ) {
    fail("SCA referential integrity", "manifest must not predate its final record");
  }

  const latestTasks = latestByVersion(tasks, (record) => record.task_id);
  const latestClaims = latestByVersion(claims, (record) => record.claim_id);
  const indexedEvidence = indexImmutable(evidence, (record) => record.evidence_id, "evidence");
  const latestFindings = latestByVersion(findings, (record) => record.finding_id);
  const indexedDecisions = indexImmutable(decisions, (record) => record.decision_id, "decision");
  const indexedGates = indexImmutable(gates, (record) => record.gate_id, "gate");
  validateReferenceGraph({
    tasks: latestTasks,
    taskIntroduced: introducedSequences(tasks, (record) => record.task_id),
    claims: latestClaims,
    claimIntroduced: introducedSequences(claims, (record) => record.claim_id),
    evidence: indexedEvidence,
    findings: latestFindings,
    findingIntroduced: introducedSequences(findings, (record) => record.finding_id),
    decisions: indexedDecisions,
    gates: indexedGates,
  });
  return { manifest, tasks, claims, evidence, findings, decisions, gates };
}

function assertLineColumn(
  lines: readonly string[],
  line: number,
  column: number,
  label: string
): void {
  const text = lines[line - 1];
  if (text === undefined) fail("SCA evidence pointer", `${label}.line exceeds UTF-8 text bounds`);
  const maximumColumn = [...text].length + 1;
  if (column > maximumColumn) {
    fail("SCA evidence pointer", `${label}.column exceeds UTF-8 text bounds`);
  }
}

/** Byte ends are exclusive byte offsets; line/column ends are exclusive code-point positions. */
export function validateEvidencePointers(
  evidenceValue: unknown,
  immutableBytes: Uint8Array
): EvidenceRefV1 {
  const evidence = validateEvidenceRef(evidenceValue);
  if (immutableBytes.byteLength !== evidence.artifact_ref.byte_length) {
    fail("SCA evidence pointer", "provided bytes do not match artifact byte_length");
  }
  if (sha256(immutableBytes) !== evidence.artifact_ref.content_digest) {
    fail("SCA evidence pointer", "provided bytes do not match artifact content_digest");
  }
  const needsText = evidence.citations.some(
    (citation) => citation.pointer.pointer_type === "line_column_range"
  );
  let lines: readonly string[] | null = null;
  if (needsText) {
    try {
      lines = new TextDecoder("utf-8", { fatal: true }).decode(immutableBytes).split("\n");
    } catch {
      fail("SCA evidence pointer", "line/column pointers require valid UTF-8 artifact bytes");
    }
  }
  for (const citation of evidence.citations) {
    const pointer = citation.pointer;
    if (pointer.pointer_type === "byte_range") {
      if (pointer.end_byte_exclusive > immutableBytes.byteLength) {
        fail("SCA evidence pointer", `citation '${citation.citation_id}' exceeds byte bounds`);
      }
      continue;
    }
    if (lines === null) fail("SCA evidence pointer", "UTF-8 line index is unavailable");
    assertLineColumn(lines, pointer.start.line, pointer.start.column, "start");
    assertLineColumn(
      lines,
      pointer.end_exclusive.line,
      pointer.end_exclusive.column,
      "end_exclusive"
    );
  }
  return evidence;
}

/** Verify every evidence body through one concrete project-bound host ArtifactStore. */
export function validateEvidenceCorpus(
  bundleValue: unknown,
  artifactStore: ArtifactStore
): ScaDomainBundleV1 {
  const bundle = validateScaDomainBundle(bundleValue);
  try {
    artifactStore.assertBoundProject(bundle.manifest.project_id);
  } catch (error) {
    fail(
      "SCA evidence corpus",
      error instanceof Error ? error.message : "artifact store project binding failed"
    );
  }
  for (const evidence of bundle.evidence) {
    let bytes: Uint8Array;
    try {
      bytes = artifactStore.read(evidence.artifact_ref);
    } catch (error) {
      fail(
        "SCA evidence corpus",
        error instanceof Error ? error.message : "artifact custody read failed"
      );
    }
    validateEvidencePointers(evidence, bytes);
  }
  return bundle;
}

function requireEvidence(
  evidence: ReadonlyMap<string, EvidenceRefV1>,
  ids: readonly string[],
  label: string
): readonly EvidenceRefV1[] {
  return ids.map((id) => requireReference(evidence, id, label));
}

function assertHostQualifiedFamilyRule(
  reference: EvidenceRefV1,
  rules: ScaEvidenceFamilyRuleRegistryV1
): void {
  const qualification = reference.qualification;
  const key = scaEvidenceFamilyRuleKey(qualification);
  const rule = rules.get(key);
  if (rule === undefined) {
    fail(
      "SCA proof obligations",
      `evidence '${reference.evidence_id}' has no admitted family rule`
    );
  }
  const expected = {
    family_id: rule.family_id,
    family_version: rule.family_version,
    backend_id: rule.backend_id,
    supported_claim_classes: [...rule.supported_claim_classes].sort(),
    source_snapshot_ref: rule.source_snapshot_ref,
    config_ref: rule.config_ref,
    provenance_ref: rule.provenance_ref,
  };
  const actual = {
    family_id: qualification.family_id,
    family_version: qualification.family_version,
    backend_id: qualification.backend_id,
    supported_claim_classes: [...qualification.supported_claim_classes].sort(),
    source_snapshot_ref: qualification.source_snapshot_ref,
    config_ref: qualification.config_ref,
    provenance_ref: qualification.provenance_ref,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(
      "SCA proof obligations",
      `evidence '${reference.evidence_id}' does not match its admitted family rule`
    );
  }
}

function assertQualifiedFor(
  reference: EvidenceRefV1,
  claimClass: EvidenceRefV1["claim_classes"][number],
  label: string
): void {
  if (
    reference.qualification.status !== "qualified" ||
    !reference.qualification.complete ||
    reference.qualification.truncated ||
    reference.qualification.failure_status !== "none" ||
    !reference.claim_classes.includes(claimClass) ||
    !reference.qualification.supported_claim_classes.includes(claimClass)
  ) {
    fail("SCA proof obligations", `${label} is not qualified for claim class '${claimClass}'`);
  }
}

function assertCompleteNegativeCoverage(reference: EvidenceRefV1, label: string): void {
  const coverage = reference.negative_coverage;
  if (
    coverage === null ||
    coverage.status !== "complete" ||
    coverage.truncated ||
    coverage.failure_status !== "none" ||
    coverage.source_snapshot_sha256 !== coverage.source_snapshot_ref.content_digest ||
    canonicalJson(coverage.source_snapshot_ref) !==
      canonicalJson(reference.qualification.source_snapshot_ref)
  ) {
    fail(
      "SCA proof obligations",
      `${label} lacks complete, nontruncated, failure-free snapshot-bound negative coverage`
    );
  }
}

function decisionFor(
  decisions: ReadonlyMap<string, DecisionRecordV1>,
  decisionId: string | null,
  label: string
): DecisionRecordV1 {
  if (decisionId === null) fail("SCA proof obligations", `${label} lacks a decision record`);
  return requireReference(decisions, decisionId, label);
}

function assertClaimDecision(
  claim: ClaimRecordV1,
  decisions: ReadonlyMap<string, DecisionRecordV1>
): void {
  if (claim.status !== "accepted" && claim.status !== "rejected") return;
  const decision = decisionFor(decisions, claim.decision_id, `claim '${claim.claim_id}' decision`);
  const expectedOutcome = claim.status === "accepted" ? "approved" : "rejected";
  if (
    decision.decision_type !== "claim_disposition" ||
    decision.outcome !== expectedOutcome ||
    !decision.claim_ids.includes(claim.claim_id)
  ) {
    fail("SCA proof obligations", `claim '${claim.claim_id}' has an incompatible decision record`);
  }
}

function assertFindingDecision(
  finding: FindingRecordV1,
  decisions: ReadonlyMap<string, DecisionRecordV1>
): void {
  if (finding.status === "candidate" || finding.status === "investigating") return;
  const decision = decisionFor(
    decisions,
    finding.decision_id,
    `finding '${finding.finding_id}' decision`
  );
  const expectedOutcomes: readonly DecisionRecordV1["outcome"][] =
    finding.status === "confirmed"
      ? ["approved"]
      : finding.status === "inconclusive" || finding.status === "deferred"
        ? ["deferred", "blocked"]
        : ["rejected"];
  if (
    decision.decision_type !== "finding_disposition" ||
    !expectedOutcomes.includes(decision.outcome) ||
    !decision.finding_ids.includes(finding.finding_id)
  ) {
    fail(
      "SCA proof obligations",
      `finding '${finding.finding_id}' has an incompatible decision record`
    );
  }
}

function assertTaskDecision(
  task: TaskRecordV1,
  decisions: ReadonlyMap<string, DecisionRecordV1>
): void {
  if (task.status === "pending" || task.status === "active") return;
  const decision = decisionFor(decisions, task.decision_id, `task '${task.task_id}' decision`);
  const acceptable =
    task.status === "completed"
      ? decision.outcome === "approved"
      : decision.outcome === "rejected" || decision.outcome === "blocked";
  if (
    decision.decision_type !== "task_disposition" ||
    decision.task_id !== task.task_id ||
    !acceptable
  ) {
    fail("SCA proof obligations", `task '${task.task_id}' has an incompatible decision record`);
  }
}

export function validateProofObligations(
  value: unknown,
  artifactStore: ArtifactStore,
  familyRules: ScaEvidenceFamilyRuleRegistryV1
): ScaDomainBundleV1 {
  const bundle = validateEvidenceCorpus(value, artifactStore);
  const tasks = latestByVersion(bundle.tasks, (record) => record.task_id);
  const claims = latestByVersion(bundle.claims, (record) => record.claim_id);
  const evidence = indexImmutable(bundle.evidence, (record) => record.evidence_id, "evidence");
  const findings = latestByVersion(bundle.findings, (record) => record.finding_id);
  const decisions = indexImmutable(bundle.decisions, (record) => record.decision_id, "decision");

  for (const reference of evidence.values()) assertHostQualifiedFamilyRule(reference, familyRules);

  for (const claim of claims.values()) {
    const cited = requireEvidence(evidence, claim.evidence_ids, "claim evidence");
    for (const reference of cited) {
      assertQualifiedFor(reference, claim.claim_class, `claim '${claim.claim_id}' evidence`);
    }
    if (claim.claim_class === "fact" && cited.length === 0) {
      fail("SCA proof obligations", `fact claim '${claim.claim_id}' lacks evidence`);
    }
    if (claim.claim_class === "inference") {
      if (claim.inference_disclosure === null || cited.length === 0) {
        fail(
          "SCA proof obligations",
          `inference claim '${claim.claim_id}' lacks disclosure/evidence`
        );
      }
      for (const basisId of claim.inference_disclosure.basis_claim_ids) {
        const basis = requireReference(claims, basisId, "inference basis claim");
        if (basis.status !== "accepted") {
          fail("SCA proof obligations", `inference basis '${basisId}' is not accepted`);
        }
      }
    }
    if (claim.claim_class === "negative") {
      const coverageEvidence = cited.filter((reference) => reference.evidence_kind === "coverage");
      if (coverageEvidence.length === 0) {
        fail("SCA proof obligations", `negative claim '${claim.claim_id}' lacks coverage evidence`);
      }
      for (const reference of coverageEvidence) {
        assertCompleteNegativeCoverage(reference, `negative claim '${claim.claim_id}'`);
      }
    }
    if (claim.subject_class !== "general") {
      const matched = cited.some((reference) =>
        reference.citations.some((citation) => citation.citation_class === claim.subject_class)
      );
      if (!matched) {
        fail(
          "SCA proof obligations",
          `${claim.subject_class} claim '${claim.claim_id}' lacks a matching citation class`
        );
      }
    }
    assertClaimDecision(claim, decisions);
  }

  for (const finding of findings.values()) {
    const findingEvidence = requireEvidence(evidence, finding.evidence_ids, "finding evidence");
    if (
      (finding.status === "confirmed" || finding.status === "rejected_with_evidence") &&
      findingEvidence.length === 0
    ) {
      fail("SCA proof obligations", `finding '${finding.finding_id}' lacks disposition evidence`);
    }
    if (finding.status === "confirmed") {
      for (const reference of findingEvidence) {
        assertQualifiedFor(
          reference,
          "finding_confirmation",
          `finding '${finding.finding_id}' evidence`
        );
      }
      for (const claimId of finding.claim_ids) {
        const claim = requireReference(claims, claimId, "confirmed finding claim");
        if (claim.status !== "accepted") {
          fail(
            "SCA proof obligations",
            `confirmed finding '${finding.finding_id}' depends on an unaccepted claim`
          );
        }
      }
    } else if (finding.status === "rejected_with_evidence") {
      for (const reference of findingEvidence) {
        assertQualifiedFor(
          reference,
          "finding_rejection",
          `finding '${finding.finding_id}' evidence`
        );
      }
    }
    assertFindingDecision(finding, decisions);
  }

  for (const decision of decisions.values()) {
    const decisionEvidence = requireEvidence(evidence, decision.evidence_ids, "decision evidence");
    if (decision.decision_type === "task_disposition") {
      for (const reference of decisionEvidence) {
        assertQualifiedFor(reference, "obligation_disposition", "task decision evidence");
      }
    } else if (decision.decision_type === "claim_disposition") {
      for (const claimId of decision.claim_ids) {
        const claim = requireReference(claims, claimId, "decision claim");
        for (const reference of decisionEvidence) {
          assertQualifiedFor(reference, claim.claim_class, "claim decision evidence");
        }
      }
    } else if (decision.decision_type === "finding_disposition") {
      const claimClass =
        decision.outcome === "approved"
          ? "finding_confirmation"
          : decision.outcome === "rejected"
            ? "finding_rejection"
            : "finding_uncertainty";
      for (const reference of decisionEvidence) {
        assertQualifiedFor(reference, claimClass, "finding decision evidence");
      }
    } else {
      for (const reference of decisionEvidence) {
        assertQualifiedFor(reference, "gate_completion", "gate decision evidence");
      }
    }
    if (
      (decision.decision_type === "task_disposition" ||
        decision.decision_type === "gate_disposition") &&
      (decision.claim_ids.length !== 0 || decision.finding_ids.length !== 0)
    ) {
      fail("SCA proof obligations", `${decision.decision_type} must not target claims/findings`);
    }
    if (decision.decision_type === "claim_disposition" && decision.finding_ids.length !== 0) {
      fail("SCA proof obligations", "claim_disposition must not target findings");
    }
    if (decision.decision_type === "finding_disposition" && decision.claim_ids.length !== 0) {
      fail("SCA proof obligations", "finding_disposition must not target claims");
    }
  }

  for (const task of tasks.values()) assertTaskDecision(task, decisions);

  for (const gate of bundle.gates) {
    if (gate.status !== "passed") continue;
    const gateEvidence = requireEvidence(evidence, gate.evidence_ids, "passed gate evidence");
    for (const reference of gateEvidence) {
      assertQualifiedFor(reference, "gate_completion", `passed gate '${gate.gate_id}' evidence`);
    }
    for (const task of tasks.values()) {
      if (task.obligation_class !== "optional" && !gate.task_ids.includes(task.task_id)) {
        fail(
          "SCA proof obligations",
          `passed gate '${gate.gate_id}' omits nonoptional task '${task.task_id}'`
        );
      }
    }
    const exactTaskDecisionIds: string[] = [];
    for (const taskId of gate.task_ids) {
      const task = requireReference(tasks, taskId, "passed gate task");
      if (task.status === "pending" || task.status === "active") {
        fail("SCA proof obligations", `passed gate '${gate.gate_id}' includes open task`);
      }
      if (task.obligation_class === "required_result" && task.status !== "completed") {
        fail(
          "SCA proof obligations",
          `passed gate '${gate.gate_id}' has an uncompleted required_result task`
        );
      }
      if (task.decision_id === null) {
        fail("SCA proof obligations", `passed gate '${gate.gate_id}' task lacks disposition`);
      }
      const decision = requireReference(decisions, task.decision_id, "passed gate task decision");
      if (decision.decision_type !== "task_disposition" || decision.task_id !== task.task_id) {
        fail("SCA proof obligations", `passed gate '${gate.gate_id}' task decision is not exact`);
      }
      if (task.obligation_class === "required_result" && decision.outcome !== "approved") {
        fail(
          "SCA proof obligations",
          `passed gate '${gate.gate_id}' required_result decision is not approved`
        );
      }
      if (task.obligation_class === "attempt_and_report" && decision.evidence_ids.length === 0) {
        fail(
          "SCA proof obligations",
          `passed gate '${gate.gate_id}' attempt_and_report task lacks evidence`
        );
      }
      exactTaskDecisionIds.push(task.decision_id);
    }
    const expectedDecisionIds = [...exactTaskDecisionIds].sort();
    const actualDecisionIds = [...gate.decision_ids].sort();
    if (canonicalJson(expectedDecisionIds) !== canonicalJson(actualDecisionIds)) {
      fail(
        "SCA proof obligations",
        `passed gate '${gate.gate_id}' must include exactly its task decisions`
      );
    }
    for (const claim of claims.values()) {
      if (claim.status !== "accepted" && claim.status !== "rejected") {
        fail("SCA proof obligations", `passed gate '${gate.gate_id}' has an open claim`);
      }
      if (claim.sequence >= gate.sequence) {
        fail("SCA proof obligations", `passed gate '${gate.gate_id}' predates a claim disposition`);
      }
    }
    for (const finding of findings.values()) {
      if (finding.status === "candidate" || finding.status === "investigating") {
        fail("SCA proof obligations", `passed gate '${gate.gate_id}' has an open finding`);
      }
      if (finding.sequence >= gate.sequence) {
        fail(
          "SCA proof obligations",
          `passed gate '${gate.gate_id}' predates a finding disposition`
        );
      }
    }
  }

  return bundle;
}
