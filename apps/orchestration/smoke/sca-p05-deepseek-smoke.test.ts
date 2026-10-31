import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, Directive } from "../dist/contracts.js";
import { loadRuntimeConfig } from "../dist/config.js";
import { PiAgentClient } from "../dist/model-client.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import {
  SCA_P05_CHALLENGER_RESULT_V1_SCHEMA,
  SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
  SCA_P05_CONTROL_RECORD_V1_SCHEMA,
  SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
  SCA_P05_REQUIRED_MODEL,
  scaP05EvidenceAtomId,
  scaP05HypothesisId,
  scaP05SourceSegmentId,
  validateScaP05ChallengerResultV1,
  validateScaP05CognitivePayloadV1,
  validateScaP05ConstructorResultV1,
  validateScaP05ControlRecordV1,
  validateScaP05DisclosureAdmissionV1,
  validateScaP05DisclosureScopeV1,
  validateScaP05HypothesisAgainstPayload,
  withSelfDigest,
  type ScaP05CognitivePayloadV1,
  type ScaP05DisclosureScopeV1,
} from "../dist/sca/p05-contracts.js";
import {
  SCA_P05_CANDIDATE_PLAYBOOK_NAME,
  SCA_P05_CANDIDATE_REGISTRATION,
} from "../dist/sca/p05-playbook.js";
import { initializePennyState } from "../dist/state/index.js";
import { parsePersistedRoutingSummary, WorkerExecutor } from "../dist/worker.js";

const ENABLED = process.env.PENNY_SCA_P05_MODEL_SMOKE === "1";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
const priorStateRoot = process.env.PENNY_STATE_ROOT;

afterEach(() => {
  if (priorStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = priorStateRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function persistedSemanticResult(text: string): unknown {
  const routing = parsePersistedRoutingSummary(text);
  if (routing !== undefined) return routing.details;
  return JSON.parse(text.trim());
}

function persistJson(
  store: ArtifactStore,
  input: {
    readonly runId: string;
    readonly phase: string;
    readonly kind: string;
    readonly operationId: string;
    readonly producer: string;
    readonly schemaId: string;
    readonly value: unknown;
    readonly upstreamRefs?: readonly ArtifactRef[];
  }
): ArtifactRef {
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: input.runId,
      phase: input.phase,
      branch_id: null,
      kind: input.kind,
      operation_id: input.operationId,
      version: 1,
      producer: input.producer,
      media_type: "application/json",
      content_schema: { schema_id: input.schemaId, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [...(input.upstreamRefs ?? [])],
    },
    content: canonicalJson(input.value),
  });
}

function disclosure(input: {
  readonly runId: string;
  readonly callId: "constructor" | "challenger";
  readonly role: "hypothesis_constructor" | "falsification_challenger";
  readonly purpose: "p05_hypothesis_construction" | "p05_falsification_challenge";
  readonly scope: ScaP05DisclosureScopeV1;
  readonly scopeRef: ArtifactRef;
  readonly payloadRef: ArtifactRef;
  readonly segmentIds: readonly string[];
  readonly atomIds: readonly string[];
}) {
  return validateScaP05DisclosureAdmissionV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: input.runId,
        phase_id: "SCA-P05" as const,
        call_id: input.callId,
        role: input.role,
        purpose: input.purpose,
        required_model: SCA_P05_REQUIRED_MODEL,
        disclosure_scope_ref: input.scopeRef,
        disclosure_scope_sha256: input.scope.scope_sha256,
        payload_ref: input.payloadRef,
        payload_sha256: input.payloadRef.content_digest,
        payload_byte_length: input.payloadRef.byte_length,
        serialized_opening_byte_limit: 700_000,
        authorized_segment_ids: [...input.segmentIds].sort(),
        authorized_atom_ids: [...input.atomIds].sort(),
        destination: "cloud" as const,
        retention_days: 0,
        logging_status: "disabled" as const,
        logging_days: 0,
        training: "prohibited" as const,
        secrets_embedded: false as const,
        personal_data_embedded: false as const,
        decision: "allow" as const,
        blocker_codes: [],
        evaluated_before_dispatch: true as const,
      },
      "admission_sha256"
    )
  );
}

function directive(input: {
  readonly runId: string;
  readonly stateId: "forming_hypotheses" | "challenging_hypotheses";
  readonly agent: "ida" | "annie";
  readonly task: string;
  readonly payloadRef: ArtifactRef;
  readonly disclosureRef: ArtifactRef;
  readonly outputKind: "sca-p05-constructor-output" | "sca-p05-challenger-output";
}): Extract<Directive, { action: "invoke_agent" }> {
  return {
    schema_version: 2,
    action: "invoke_agent",
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: "session-sca-p05-live-schema-smoke",
      playbook: SCA_P05_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    state_id: input.stateId,
    agent: input.agent,
    attempt: 1,
    task: input.task,
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "cognitive_payload", ref: input.payloadRef },
        { slot: "disclosure_admission", ref: input.disclosureRef },
      ],
    },
    output_artifact: {
      schema_version: 2,
      run_id: input.runId,
      phase: input.stateId,
      branch_id: null,
      kind: input.outputKind,
      operation_id: `sca-p05-${input.agent}-smoke-output`,
      version: 1,
      producer: `agent:${input.agent}`,
      media_type: "text/plain",
      content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [input.payloadRef, input.disclosureRef],
    },
    trust_profile: "hardened-untrusted",
    model_override: SCA_P05_REQUIRED_MODEL.override,
  };
}

(ENABLED ? describe : describe.skip)("opt-in SCA P05 DeepSeek schema/prompt smoke", () => {
  it("runs the sequential constructor and challenger prompts on the exact required identity", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-sca-p05-live-smoke-"));
    roots.push(root);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(root, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    process.env.PENNY_STATE_ROOT = env.PENNY_STATE_ROOT;
    const initialized = initializePennyState(PROJECT_ROOT, { env });
    const config = loadRuntimeConfig(PROJECT_ROOT, env);
    using artifacts = new ArtifactStore(initialized.paths.artifacts.root);
    const runId = "run-sca-p05-live-schema-smoke";
    const issueSelectedId = `p04i_${"5".repeat(64)}`;
    const controlledSelectedId = `p04i_${"6".repeat(64)}`;
    const issueText = [
      "export function deleteInvoice(actorId: string, invoiceId: string) {",
      "  database.delete(invoiceId);",
      "  return true;",
      "}",
    ].join("\n");
    const controlledText = [
      "export function viewInvoice(actorId: string, invoice: Invoice) {",
      "  if (invoice.ownerId !== actorId) throw new ForbiddenError();",
      "  return invoice.contents;",
      "}",
    ].join("\n");
    const sourceRef = persistJson(artifacts, {
      runId: "run-sca-p01-live-schema-smoke",
      phase: "SCA-P01",
      kind: "source-segment-origin",
      operationId: "source-segment-origin",
      producer: "host:sca-p05-smoke",
      schemaId: "penny.sca-p05-smoke-source.v1",
      value: {
        sources: [
          { source_path: "src/delete-invoice.ts", source_text: issueText },
          { source_path: "src/view-invoice.ts", source_text: controlledText },
        ],
      },
    });
    const sourceSha = sourceRef.content_digest;
    const authority = withSelfDigest(
      {
        schema_id: SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA,
        schema_version: 1 as const,
        tenant_id: "tenant",
        project_id: "project",
        run_id: runId,
        phase_id: "SCA-P05" as const,
        source_snapshot_sha256: sourceSha,
        required_model: SCA_P05_REQUIRED_MODEL,
        destination_class: "cloud" as const,
        purposes: ["p05_hypothesis_construction" as const, "p05_falsification_challenge" as const],
        provider_retention_status: "known" as const,
        provider_retention_days: 0,
        provider_logging_status: "disabled" as const,
        provider_logging_days: 0,
        provider_training_use: "prohibited" as const,
        max_payload_bytes_per_call: 700_000,
        max_provider_calls: 2 as const,
        decision: "approved" as const,
        issued_at: "2026-09-21T00:00:00.000Z",
      },
      "authority_sha256"
    );
    const authorityRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-disclosure-authority",
      operationId: "sca-p05-disclosure-authority",
      producer: "host:sca-p05-candidate",
      schemaId: SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA,
      value: authority,
    });
    const cohortRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "accepted-cohort",
      operationId: "accepted-cohort",
      producer: "host:sca-p05-smoke",
      schemaId: "penny.sca-p05-accepted-cohort.v1",
      value: { selected_item_ids: [issueSelectedId, controlledSelectedId].sort() },
    });
    const sourceInputs = [
      {
        selectedItemId: issueSelectedId,
        sourcePath: "src/delete-invoice.ts",
        normalizedLocator: "source:src/delete-invoice.ts",
        text: issueText,
      },
      {
        selectedItemId: controlledSelectedId,
        sourcePath: "src/view-invoice.ts",
        normalizedLocator: "source:src/view-invoice.ts",
        text: controlledText,
      },
    ].map((entry) => {
      const textSha = sha256(Buffer.from(entry.text, "utf8"));
      const segmentId = scaP05SourceSegmentId({
        origin_ref: sourceRef,
        source_path: entry.sourcePath,
        start_line: 1,
        end_line_exclusive: 5,
        visible_text_sha256: textSha,
      });
      const selector = `source-segment:${segmentId}`;
      const valueSha = sha256(canonicalJson(entry.text));
      const atomId = scaP05EvidenceAtomId({
        origin_ref: sourceRef,
        selector,
        value_sha256: valueSha,
      });
      return { ...entry, textSha, segmentId, selector, valueSha, atomId };
    });
    const controlledSource = sourceInputs.find(
      (entry) => entry.selectedItemId === controlledSelectedId
    );
    if (controlledSource === undefined) throw new Error("controlled source fixture is absent");
    const controlRecord = validateScaP05ControlRecordV1(
      withSelfDigest(
        {
          schema_id: SCA_P05_CONTROL_RECORD_V1_SCHEMA,
          schema_version: 1 as const,
          selected_item_id: controlledSelectedId,
          control_id: "owner-match-authorization-guard",
          control_type: "authorization" as const,
          enforcement_point: "src/view-invoice.ts before invoice contents are returned",
          controlled_actor_or_input: "actorId and invoice.ownerId",
          prevented_outcome: "A non-owner reads invoice contents",
          source_snapshot_sha256: sourceSha,
          evidence_refs: [sourceRef],
        },
        "record_sha256"
      )
    );
    const controlRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-control-record",
      operationId: "sca-p05-controlled-lead-control-record",
      producer: "host:sca-p05-smoke",
      schemaId: SCA_P05_CONTROL_RECORD_V1_SCHEMA,
      value: controlRecord,
      upstreamRefs: [sourceRef],
    });
    const controlSelector = "json-pointer:";
    const controlValueSha = sha256(canonicalJson(controlRecord));
    const controlAtomId = scaP05EvidenceAtomId({
      origin_ref: controlRef,
      selector: controlSelector,
      value_sha256: controlValueSha,
    });
    const sourceSegments = sourceInputs
      .map((entry) => ({
        segment_id: entry.segmentId,
        selected_item_id: entry.selectedItemId,
        origin_ref: sourceRef,
        source_path: entry.sourcePath,
        start_line: 1,
        end_line_exclusive: 5,
        transformation: "verbatim" as const,
        visible_text_sha256: entry.textSha,
        visible_text_utf8: entry.text,
        redaction_ranges: [],
        secrets_status: "absent" as const,
        personal_data_status: "absent" as const,
        allowed: true as const,
      }))
      .sort((left, right) => left.segment_id.localeCompare(right.segment_id));
    const evidencePermissions = [
      ...sourceInputs.map((entry) => ({
        atom_id: entry.atomId,
        selected_item_id: entry.selectedItemId,
        atom_kind: "source_segment" as const,
        origin_ref: sourceRef,
        selector: entry.selector,
        value_sha256: entry.valueSha,
        allowed: true as const,
      })),
      {
        atom_id: controlAtomId,
        selected_item_id: controlledSelectedId,
        atom_kind: "control_record" as const,
        origin_ref: controlRef,
        selector: controlSelector,
        value_sha256: controlValueSha,
        allowed: true as const,
      },
    ].sort((left, right) => left.atom_id.localeCompare(right.atom_id));
    const scope = validateScaP05DisclosureScopeV1(
      withSelfDigest(
        {
          schema_id: SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
          schema_version: 1 as const,
          run_id: runId,
          phase_id: "SCA-P05" as const,
          source_snapshot_ref: sourceRef,
          source_snapshot_sha256: sourceSha,
          required_model: SCA_P05_REQUIRED_MODEL,
          destination_class: "cloud" as const,
          purposes: [
            "p05_hypothesis_construction" as const,
            "p05_falsification_challenge" as const,
          ],
          source_segments: sourceSegments,
          evidence_permissions: evidencePermissions,
          provider_retention_status: "known" as const,
          provider_retention_days: 0,
          provider_logging_status: "disabled" as const,
          provider_logging_days: 0,
          provider_training_use: "prohibited" as const,
          max_payload_bytes_per_call: 700_000,
          max_provider_calls: 2 as const,
          authority_ref: authorityRef,
          decision: "allow" as const,
          blocker_codes: [],
        },
        "scope_sha256"
      )
    );
    const scopeRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-disclosure-scope",
      operationId: "scope",
      producer: "host:sca-p05-smoke",
      schemaId: SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
      value: scope,
      upstreamRefs: [sourceRef, controlRef, authorityRef],
    });
    const assignedItemIds = [issueSelectedId, controlledSelectedId].sort();
    const items = sourceInputs
      .map((entry) => ({
        selected_item_id: entry.selectedItemId,
        expected_hypothesis_id: scaP05HypothesisId(sourceSha, entry.selectedItemId),
        normalized_locator: entry.normalizedLocator,
        source_path: entry.sourcePath,
        package_coordinate: null,
        selection_rationale_code: "select_for_p05",
        evidence_atom_ids:
          entry.selectedItemId === controlledSelectedId
            ? [entry.atomId, controlAtomId].sort()
            : [entry.atomId],
      }))
      .sort((left, right) => left.selected_item_id.localeCompare(right.selected_item_id));
    const evidenceAtoms = [
      ...sourceInputs.map((entry) => ({
        atom_id: entry.atomId,
        selected_item_id: entry.selectedItemId,
        atom_kind: "source_segment" as const,
        origin_ref: sourceRef,
        selector: entry.selector,
        value_sha256: entry.valueSha,
        value: entry.text,
      })),
      {
        atom_id: controlAtomId,
        selected_item_id: controlledSelectedId,
        atom_kind: "control_record" as const,
        origin_ref: controlRef,
        selector: controlSelector,
        value_sha256: controlValueSha,
        value: controlRecord,
      },
    ].sort((left, right) => left.atom_id.localeCompare(right.atom_id));
    const basePayload = {
      schema_id: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
      schema_version: 1 as const,
      run_id: runId,
      phase_id: "SCA-P05" as const,
      required_model: SCA_P05_REQUIRED_MODEL,
      accepted_cohort_ref: cohortRef,
      source_snapshot_ref: sourceRef,
      source_snapshot_sha256: sourceSha,
      assigned_item_ids: assignedItemIds,
      items,
      evidence_atoms: evidenceAtoms,
      disclosure_scope_ref: scopeRef,
      content_mode: "authorized_segments_and_exact_evidence_atoms" as const,
    };
    const constructorPayload = validateScaP05CognitivePayloadV1(
      withSelfDigest(
        {
          ...basePayload,
          call_id: "constructor",
          role: "hypothesis_constructor" as const,
          purpose: "p05_hypothesis_construction" as const,
          constructor_result_ref: null,
          constructor_result: null,
        },
        "payload_sha256"
      )
    );
    const constructorPayloadRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-cognitive-payload",
      operationId: "constructor-payload",
      producer: "host:sca-p05-smoke",
      schemaId: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
      value: constructorPayload,
      upstreamRefs: [scopeRef],
    });
    const constructorDisclosure = disclosure({
      runId,
      callId: "constructor",
      role: "hypothesis_constructor",
      purpose: "p05_hypothesis_construction",
      scope,
      scopeRef,
      payloadRef: constructorPayloadRef,
      segmentIds: sourceSegments.map((entry) => entry.segment_id),
      atomIds: evidenceAtoms.map((entry) => entry.atom_id),
    });
    const constructorDisclosureRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-disclosure-admission",
      operationId: "constructor-disclosure",
      producer: "host:sca-p05-smoke",
      schemaId: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
      value: constructorDisclosure,
      upstreamRefs: [constructorPayloadRef, scopeRef],
    });
    const client = new PiAgentClient({
      catalogSessions: { projectId: config.projectId, root: config.subagentSessionRoot },
    });
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: PROJECT_ROOT,
      parallelConcurrency: 1,
      registration: SCA_P05_CANDIDATE_REGISTRATION,
    });
    workers.setReceiptAuthority(ReceiptAuthority.createEphemeral());
    const constructorResult = (
      await workers.execute(
        directive({
          runId,
          stateId: "forming_hypotheses",
          agent: "ida",
          task: "Construct exactly one complete falsifiable bounded hypothesis for each of the two assigned P04 selections using only their inline exact evidence atoms. For the guarded view-invoice selection, form the plausible unauthorized-read lead and preserve its owner-match guard as a competing benign explanation; do not adjudicate it. Account for both assigned IDs exactly once. No tools are available.",
          payloadRef: constructorPayloadRef,
          disclosureRef: constructorDisclosureRef,
          outputKind: "sca-p05-constructor-output",
        })
      )
    )[0];
    if (constructorResult === undefined) throw new Error("P05 constructor result is absent");
    let constructorSummary;
    try {
      const text = artifacts
        .readById(constructorResult.output_artifact.artifact_id)
        .toString("utf8");
      constructorSummary = validateScaP05ConstructorResultV1(persistedSemanticResult(text));
    } catch (error) {
      throw new Error(
        `live P05 constructor artifact was not schema-compatible: ${error instanceof Error ? error.message : String(error)}; details=${canonicalJson(constructorResult.details)}; persisted=${artifacts.readById(constructorResult.output_artifact.artifact_id).toString("utf8")}`
      );
    }
    expect(constructorSummary.schema_id).toBe(SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA);
    expect(constructorSummary.payload_sha256).toBe(constructorPayloadRef.content_digest);
    expect(constructorSummary.items).toHaveLength(2);
    expect(constructorSummary.items.every((item) => item.disposition === "formed")).toBe(true);
    for (const item of constructorSummary.items) {
      if (item.disposition !== "formed") throw new Error("expected formed live hypothesis");
      validateScaP05HypothesisAgainstPayload(item.hypothesis, constructorPayload);
    }
    const challengerPayload: ScaP05CognitivePayloadV1 = validateScaP05CognitivePayloadV1(
      withSelfDigest(
        {
          ...basePayload,
          call_id: "challenger",
          role: "falsification_challenger" as const,
          purpose: "p05_falsification_challenge" as const,
          constructor_result_ref: constructorResult.output_artifact,
          constructor_result: constructorSummary,
        },
        "payload_sha256"
      )
    );
    const challengerPayloadRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-cognitive-payload",
      operationId: "challenger-payload",
      producer: "host:sca-p05-smoke",
      schemaId: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
      value: challengerPayload,
      upstreamRefs: [scopeRef, constructorResult.output_artifact],
    });
    const challengerDisclosure = disclosure({
      runId,
      callId: "challenger",
      role: "falsification_challenger",
      purpose: "p05_falsification_challenge",
      scope,
      scopeRef,
      payloadRef: challengerPayloadRef,
      segmentIds: sourceSegments.map((entry) => entry.segment_id),
      atomIds: evidenceAtoms.map((entry) => entry.atom_id),
    });
    const challengerDisclosureRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-disclosure-admission",
      operationId: "challenger-disclosure",
      producer: "host:sca-p05-smoke",
      schemaId: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
      value: challengerDisclosure,
      upstreamRefs: [challengerPayloadRef, scopeRef],
    });
    const challengerResult = (
      await workers.execute(
        directive({
          runId,
          stateId: "challenging_hypotheses",
          agent: "annie",
          task: `Challenge both formed hypotheses against the exact evidence. Preserve the delete-invoice hypothesis for investigation because its source path shows no authorization control. Refute the view-invoice hypothesis with the exact control atom '${controlAtomId}' because the owner-match authorization guard prevents the claimed non-owner read on that path. Account for both assigned IDs exactly once, never claim global safety, and use no tools.`,
          payloadRef: challengerPayloadRef,
          disclosureRef: challengerDisclosureRef,
          outputKind: "sca-p05-challenger-output",
        })
      )
    )[0];
    if (challengerResult === undefined) throw new Error("P05 challenger result is absent");
    let challengerSummary;
    try {
      const text = artifacts
        .readById(challengerResult.output_artifact.artifact_id)
        .toString("utf8");
      challengerSummary = validateScaP05ChallengerResultV1(persistedSemanticResult(text));
    } catch (error) {
      throw new Error(
        `live P05 challenger artifact was not schema-compatible: ${error instanceof Error ? error.message : String(error)}; details=${canonicalJson(challengerResult.details)}; persisted=${artifacts.readById(challengerResult.output_artifact.artifact_id).toString("utf8")}`
      );
    }
    expect(challengerSummary.schema_id).toBe(SCA_P05_CHALLENGER_RESULT_V1_SCHEMA);
    expect(challengerSummary.payload_sha256).toBe(challengerPayloadRef.content_digest);
    expect(challengerSummary.items).toHaveLength(2);
    const formedHypothesisIds = new Map(
      constructorSummary.items.flatMap((item) =>
        item.disposition === "formed"
          ? [[item.selected_item_id, item.hypothesis.hypothesis_id] as const]
          : []
      )
    );
    for (const item of challengerSummary.items) {
      expect(item.hypothesis_id).toBe(formedHypothesisIds.get(item.selected_item_id));
    }
    const issueChallenge = challengerSummary.items.find(
      (item) => item.selected_item_id === issueSelectedId
    );
    const controlledChallenge = challengerSummary.items.find(
      (item) => item.selected_item_id === controlledSelectedId
    );
    expect(issueChallenge?.decision).toBe("accept_for_investigation");
    expect(controlledChallenge?.decision).toBe("refute_with_existing_control");
    if (controlledChallenge?.decision !== "refute_with_existing_control") {
      throw new Error("expected exact-control live refutation");
    }
    expect(controlledChallenge.control_atom_ids).toEqual([controlAtomId]);
    for (const result of [constructorResult, challengerResult]) {
      expect(result.worker_receipt.requested_model).toEqual(SCA_P05_REQUIRED_MODEL);
      expect(result.worker_receipt.observed_model).toEqual({
        provider: SCA_P05_REQUIRED_MODEL.provider,
        model: SCA_P05_REQUIRED_MODEL.model,
      });
    }

    const evidencePath = process.env.PENNY_SCA_P05_SMOKE_EVIDENCE_PATH;
    if (evidencePath !== undefined && evidencePath.trim().length > 0) {
      const evidenceBody = {
        schema_id: "penny.sca-p05-live-gate-evidence.v1",
        schema_version: 1,
        observed_at: new Date().toISOString(),
        status: "passed",
        run_id: runId,
        required_model: SCA_P05_REQUIRED_MODEL,
        source_snapshot_ref: sourceRef,
        accepted_cohort_ref: cohortRef,
        control_record_ref: controlRef,
        disclosure_authority_ref: authorityRef,
        disclosure_scope_ref: scopeRef,
        constructor: {
          payload_ref: constructorPayloadRef,
          disclosure_ref: constructorDisclosureRef,
          output_ref: constructorResult.output_artifact,
          worker_receipt: constructorResult.worker_receipt,
          summary: constructorSummary,
        },
        challenger: {
          payload_ref: challengerPayloadRef,
          disclosure_ref: challengerDisclosureRef,
          output_ref: challengerResult.output_artifact,
          worker_receipt: challengerResult.worker_receipt,
          summary: challengerSummary,
        },
        assertions: {
          assigned_item_count: 2,
          formed_hypothesis_count: 2,
          supported_issue_decision: issueChallenge?.decision,
          controlled_lead_decision: controlledChallenge.decision,
          controlled_lead_control_atom_ids: controlledChallenge.control_atom_ids,
          provider_calls: 2,
          tools_available: 0,
        },
      };
      const evidence = {
        ...evidenceBody,
        evidence_sha256: sha256(canonicalJson(evidenceBody)),
      };
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(evidencePath, 0o600);
    }
  }, 300_000);
});
