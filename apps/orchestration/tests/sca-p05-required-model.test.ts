import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, Directive } from "../dist/contracts.js";
import {
  buildAgentOpening,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
} from "../dist/model-client.js";
import { PLAYBOOK_REGISTRY, validateRegistrationContract } from "../dist/playbooks/registry.js";
import { PreDispatchPolicyDeniedError } from "../dist/sca/p04-dispatch-guard.js";
import {
  SCA_P05_INLINE_OPENING_PREFIX,
  authorizeScaP05SerializedOpening,
  buildScaP05InlineOpeningAppendix,
} from "../dist/sca/p05-dispatch-guard.js";
import {
  SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
  SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
  SCA_P05_REQUIRED_MODEL,
  scaP05EvidenceAtomId,
  scaP05HypothesisId,
  scaP05SourceSegmentId,
  validateScaP05CognitivePayloadV1,
  validateScaP05ConstructorResultV1,
  validateScaP05DisclosureAdmissionV1,
  validateScaP05DisclosureScopeV1,
  withSelfDigest,
} from "../dist/sca/p05-contracts.js";
import {
  SCA_P05_CANDIDATE_PLAYBOOK_NAME,
  SCA_P05_CANDIDATE_REGISTRATION,
} from "../dist/sca/p05-playbook.js";
import { WorkerExecutor } from "../dist/worker.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p05-guard-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

function persist(
  artifacts: ArtifactStore,
  input: {
    readonly runId: string;
    readonly phase: string;
    readonly kind: string;
    readonly operationId: string;
    readonly producer: string;
    readonly schemaId: string;
    readonly value: unknown;
  }
): ArtifactRef {
  return artifacts.persist({
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
      upstream_refs: [],
    },
    content: canonicalJson(input.value),
  });
}

function fixture(artifacts: ArtifactStore) {
  const runId = "run-p05-guard";
  const selectedId = `p04i_${"a".repeat(64)}`;
  const sourceRef = persist(artifacts, {
    runId: "run-p01-source",
    phase: "SCA-P01",
    kind: "source-custody",
    operationId: "source-custody",
    producer: "host:test",
    schemaId: "penny.test-source.v1",
    value: { source: true },
  });
  const sourceSnapshotSha = sourceRef.content_digest;
  const authority = withSelfDigest(
    {
      schema_id: SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA,
      schema_version: 1 as const,
      tenant_id: "tenant",
      project_id: "project",
      run_id: runId,
      phase_id: "SCA-P05" as const,
      source_snapshot_sha256: sourceSnapshotSha,
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
  const authorityRef = persist(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-disclosure-authority",
    operationId: "sca-p05-disclosure-authority",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA,
    value: authority,
  });
  const cohortRef = persist(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "accepted-cohort",
    operationId: "accepted-cohort",
    producer: "host:test",
    schemaId: "penny.sca-p05-accepted-cohort.v1",
    value: { cohort: true },
  });
  const text = "function allowed(actor, input) { return actor.admin || input.owner === actor.id; }";
  const textSha = sha256(Buffer.from(text, "utf8"));
  const segmentId = scaP05SourceSegmentId({
    origin_ref: sourceRef,
    source_path: "src/auth.ts",
    start_line: 1,
    end_line_exclusive: 2,
    visible_text_sha256: textSha,
  });
  const selector = `source-segment:${segmentId}`;
  const valueSha = sha256(canonicalJson(text));
  const atomId = scaP05EvidenceAtomId({
    origin_ref: sourceRef,
    selector,
    value_sha256: valueSha,
  });
  const scope = validateScaP05DisclosureScopeV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P05" as const,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceSnapshotSha,
        required_model: SCA_P05_REQUIRED_MODEL,
        destination_class: "cloud" as const,
        purposes: ["p05_hypothesis_construction" as const, "p05_falsification_challenge" as const],
        source_segments: [
          {
            segment_id: segmentId,
            selected_item_id: selectedId,
            origin_ref: sourceRef,
            source_path: "src/auth.ts",
            start_line: 1,
            end_line_exclusive: 2,
            transformation: "verbatim" as const,
            visible_text_sha256: textSha,
            visible_text_utf8: text,
            redaction_ranges: [],
            secrets_status: "absent" as const,
            personal_data_status: "absent" as const,
            allowed: true as const,
          },
        ],
        evidence_permissions: [
          {
            atom_id: atomId,
            selected_item_id: selectedId,
            atom_kind: "source_segment" as const,
            origin_ref: sourceRef,
            selector,
            value_sha256: valueSha,
            allowed: true as const,
          },
        ],
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
  const scopeRef = persist(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-disclosure-scope",
    operationId: "scope",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
    value: scope,
  });
  const payload = validateScaP05CognitivePayloadV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P05" as const,
        call_id: "constructor",
        role: "hypothesis_constructor" as const,
        purpose: "p05_hypothesis_construction" as const,
        required_model: SCA_P05_REQUIRED_MODEL,
        accepted_cohort_ref: cohortRef,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceSnapshotSha,
        assigned_item_ids: [selectedId],
        items: [
          {
            selected_item_id: selectedId,
            expected_hypothesis_id: scaP05HypothesisId(sourceSnapshotSha, selectedId),
            normalized_locator: "source:src/auth.ts",
            source_path: "src/auth.ts",
            package_coordinate: null,
            selection_rationale_code: "select_for_p05",
            evidence_atom_ids: [atomId],
          },
        ],
        evidence_atoms: [
          {
            atom_id: atomId,
            selected_item_id: selectedId,
            atom_kind: "source_segment" as const,
            origin_ref: sourceRef,
            selector,
            value_sha256: valueSha,
            value: text,
          },
        ],
        constructor_result_ref: null,
        constructor_result: null,
        disclosure_scope_ref: scopeRef,
        content_mode: "authorized_segments_and_exact_evidence_atoms" as const,
      },
      "payload_sha256"
    )
  );
  const payloadRef = persist(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-cognitive-payload",
    operationId: "payload",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
    value: payload,
  });
  const disclosure = validateScaP05DisclosureAdmissionV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P05" as const,
        call_id: "constructor",
        role: "hypothesis_constructor" as const,
        purpose: "p05_hypothesis_construction" as const,
        required_model: SCA_P05_REQUIRED_MODEL,
        disclosure_scope_ref: scopeRef,
        disclosure_scope_sha256: scope.scope_sha256,
        payload_ref: payloadRef,
        payload_sha256: payloadRef.content_digest,
        payload_byte_length: payloadRef.byte_length,
        serialized_opening_byte_limit: 700_000,
        authorized_segment_ids: [segmentId],
        authorized_atom_ids: [atomId],
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
  const disclosureRef = persist(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-disclosure-admission",
    operationId: "disclosure",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
    value: disclosure,
  });
  const assignment = {
    registration_name: SCA_P05_CANDIDATE_PLAYBOOK_NAME,
    run_id: runId,
    state_id: "forming_hypotheses",
    branch_id: null,
    agent: "ida",
    task: "Construct hypotheses.",
    input_artifacts: {
      schema_version: 2 as const,
      artifacts: [
        { slot: "cognitive_payload", ref: payloadRef },
        { slot: "disclosure_admission", ref: disclosureRef },
      ],
    },
  };
  return {
    assignment,
    sourceRef,
    cohortRef,
    authorityRef,
    scopeRef,
    payload,
    disclosure,
    payloadRef,
    disclosureRef,
    atomId,
  };
}

class FencedP05Client implements ModelClient {
  providerPrompts = 0;
  guardCalls = 0;

  constructor(
    private readonly tamperOpening = false,
    private readonly response = "SUMMARY:{}"
  ) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    invocation.admitResolvedModel?.({
      provider: SCA_P05_REQUIRED_MODEL.provider,
      model: SCA_P05_REQUIRED_MODEL.model,
    });
    const appendix = invocation.providerOpeningAppendix?.();
    const opening = buildAgentOpening({
      invocation,
      registration: invocation.registration,
      agentGuidance: "registration-bound",
      domainGuidance: "registration-bound",
      activeToolNames: [],
      ...(appendix === undefined ? {} : { providerOpeningAppendix: appendix }),
    });
    this.guardCalls += 1;
    invocation.guardModelDispatch?.(this.tamperOpening ? `${opening}\nsubstituted` : opening);
    this.providerPrompts += 1;
    return { text: this.response };
  }
}

function worker(artifacts: ArtifactStore, client: ModelClient): WorkerExecutor {
  const executor = new WorkerExecutor(client, artifacts, {
    projectRoot: path.resolve(import.meta.dirname, "../../.."),
    parallelConcurrency: 1,
    registration: SCA_P05_CANDIDATE_REGISTRATION,
  });
  executor.setReceiptAuthority(TEST_RECEIPT_AUTHORITY);
  return executor;
}

function workerDirective(
  built: ReturnType<typeof fixture>,
  disclosureRef = built.disclosureRef,
  payloadRef = built.payloadRef
): Extract<Directive, { action: "invoke_agent" }> {
  return {
    schema_version: 2,
    action: "invoke_agent",
    identity: {
      schema_version: 2,
      run_id: built.assignment.run_id,
      session_id: `session-${built.assignment.run_id}`,
      playbook: SCA_P05_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    state_id: "forming_hypotheses",
    agent: "ida",
    attempt: 1,
    task: built.assignment.task,
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "cognitive_payload", ref: payloadRef },
        { slot: "disclosure_admission", ref: disclosureRef },
      ],
    },
    output_artifact: {
      schema_version: 2,
      run_id: built.assignment.run_id,
      phase: "forming_hypotheses",
      branch_id: null,
      kind: "sca-p05-constructor-output",
      operation_id: "sca-p05-constructor-output",
      version: 1,
      producer: "agent:ida",
      media_type: "text/plain",
      content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [payloadRef, disclosureRef],
    },
    trust_profile: "hardened-untrusted",
    model_override: SCA_P05_REQUIRED_MODEL.override,
  };
}

describe("SCA P05 required model and complete opening guard", () => {
  it("authorizes the exact payload/disclosure/source/model opening and rejects substitution", () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const appendix = buildScaP05InlineOpeningAppendix({
      store: artifacts,
      assignment: built.assignment,
    });
    const opening = `HOST\n\n${appendix}\n\nReturn the complete stage output and end with SUMMARY.`;
    expect(
      authorizeScaP05SerializedOpening({
        store: artifacts,
        assignment: built.assignment,
        opening,
      }).payload_ref
    ).toEqual(built.payloadRef);
    expect(() =>
      authorizeScaP05SerializedOpening({
        store: artifacts,
        assignment: { ...built.assignment, task: "Substituted task." },
        opening,
      })
    ).toThrow(/substituted|projection/u);
  });

  it("binds both P05 cognitive phases to zero tools and exact DeepSeek while remaining inactive", () => {
    expect(() => validateRegistrationContract(SCA_P05_CANDIDATE_REGISTRATION)).not.toThrow();
    if (SCA_P05_CANDIDATE_REGISTRATION.worker.kind !== "catalog-agent") {
      throw new Error("P05 must be a catalog-agent registration");
    }
    for (const phase of SCA_P05_CANDIDATE_REGISTRATION.worker.phases.values()) {
      expect(phase.allowed_tools).toEqual([]);
      expect(phase.required_model).toEqual(SCA_P05_REQUIRED_MODEL);
      expect(phase.provider_opening_guard).toBe("sca_p05_payload_disclosure_v1");
    }
    expect(PLAYBOOK_REGISTRY.has(SCA_P05_CANDIDATE_PLAYBOOK_NAME)).toBe(false);
  });

  it("preserves schema-valid raw phase JSON routing for P05 compatibility", async () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const selectedItem = built.payload.assigned_item_ids[0];
    if (selectedItem === undefined) throw new Error("P05 assigned item is absent");
    const checkpoint = validateScaP05ConstructorResultV1({
      schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
      schema_version: 1,
      role: "hypothesis_constructor",
      payload_sha256: built.payload.payload_sha256,
      assigned_item_ids: [selectedItem],
      items: [
        {
          selected_item_id: selectedItem,
          disposition: "checkpointed_incomplete",
          hypothesis: null,
          reason_code: "insufficient_causal_basis",
          missing_evidence_need: "Exact causal evidence is absent.",
          stop_condition: "Stop before inventing a causal path.",
          reopen_condition: "Reopen when exact causal evidence is admitted.",
          vulnerability_adjudication: "not_performed",
          safe_claim: false,
        },
      ],
      complete: true,
    });
    const completed = await worker(
      artifacts,
      new FencedP05Client(false, canonicalJson(checkpoint))
    ).execute(workerDirective(built));
    expect(completed[0]?.details).toEqual(checkpoint);
  });

  it("executes the final worker dispatch guard and makes zero provider calls on opening drift", async () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const client = new FencedP05Client(true);
    await expect(worker(artifacts, client).execute(workerDirective(built))).rejects.toBeInstanceOf(
      PreDispatchPolicyDeniedError
    );
    expect(client.guardCalls).toBe(1);
    expect(client.providerPrompts).toBe(0);
  });

  it("makes zero provider calls when payload source-snapshot identity drifts from authority", async () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const { payload_sha256: _payloadDigest, ...payloadBody } = built.payload;
    const driftedPayload = validateScaP05CognitivePayloadV1(
      withSelfDigest(
        {
          ...payloadBody,
          source_snapshot_ref: built.cohortRef,
          source_snapshot_sha256: built.cohortRef.content_digest,
          items: payloadBody.items.map((item) => ({
            ...item,
            expected_hypothesis_id: scaP05HypothesisId(
              built.cohortRef.content_digest,
              item.selected_item_id
            ),
          })),
        },
        "payload_sha256"
      )
    );
    const payloadRef = persist(artifacts, {
      runId: built.assignment.run_id,
      phase: "SCA-P05",
      kind: "sca-p05-cognitive-payload",
      operationId: "source-drift-payload",
      producer: "host:sca-p05-candidate",
      schemaId: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
      value: driftedPayload,
    });
    const { admission_sha256: _admissionDigest, ...disclosureBody } = built.disclosure;
    const disclosure = validateScaP05DisclosureAdmissionV1(
      withSelfDigest(
        {
          ...disclosureBody,
          payload_ref: payloadRef,
          payload_sha256: payloadRef.content_digest,
          payload_byte_length: payloadRef.byte_length,
        },
        "admission_sha256"
      )
    );
    const disclosureRef = persist(artifacts, {
      runId: built.assignment.run_id,
      phase: "SCA-P05",
      kind: "sca-p05-disclosure-admission",
      operationId: "source-drift-disclosure",
      producer: "host:sca-p05-candidate",
      schemaId: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
      value: disclosure,
    });
    const client = new FencedP05Client();
    await expect(
      worker(artifacts, client).execute(workerDirective(built, disclosureRef, payloadRef))
    ).rejects.toBeInstanceOf(PreDispatchPolicyDeniedError);
    expect(client.guardCalls).toBe(1);
    expect(client.providerPrompts).toBe(0);
  });

  it("enforces the authority scope payload ceiling on the actual worker path", async () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const { admission_sha256: _digest, ...body } = built.disclosure;
    const overLimit = validateScaP05DisclosureAdmissionV1(
      withSelfDigest(
        {
          ...body,
          serialized_opening_byte_limit: 700_001,
        },
        "admission_sha256"
      )
    );
    const disclosureRef = persist(artifacts, {
      runId: built.assignment.run_id,
      phase: "SCA-P05",
      kind: "sca-p05-disclosure-admission",
      operationId: "over-scope-limit-disclosure",
      producer: "host:sca-p05-candidate",
      schemaId: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
      value: overLimit,
    });
    const client = new FencedP05Client();
    await expect(
      worker(artifacts, client).execute(workerDirective(built, disclosureRef))
    ).rejects.toBeInstanceOf(PreDispatchPolicyDeniedError);
    expect(client.guardCalls).toBe(1);
    expect(client.providerPrompts).toBe(0);
  });

  it("rejects a disclosure whose per-call purpose differs from its payload", async () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const raw: unknown = JSON.parse(artifacts.read(built.disclosureRef).toString("utf8"));
    const admitted = validateScaP05DisclosureAdmissionV1(raw);
    const { admission_sha256: _digest, ...body } = admitted;
    const mismatched = validateScaP05DisclosureAdmissionV1(
      withSelfDigest(
        {
          ...body,
          purpose: "p05_falsification_challenge" as const,
        },
        "admission_sha256"
      )
    );
    const mismatchRef = persist(artifacts, {
      runId: built.assignment.run_id,
      phase: "SCA-P05",
      kind: "sca-p05-disclosure-admission",
      operationId: "purpose-mismatch-disclosure",
      producer: "host:sca-p05-candidate",
      schemaId: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
      value: mismatched,
    });
    expect(() =>
      buildScaP05InlineOpeningAppendix({
        store: artifacts,
        assignment: {
          ...built.assignment,
          input_artifacts: {
            schema_version: 2,
            artifacts: [
              { slot: "cognitive_payload", ref: built.payloadRef },
              { slot: "disclosure_admission", ref: mismatchRef },
            ],
          },
        },
      })
    ).toThrow(/purpose|binding/u);
    const client = new FencedP05Client();
    await expect(
      worker(artifacts, client).execute(workerDirective(built, mismatchRef))
    ).rejects.toBeInstanceOf(PreDispatchPolicyDeniedError);
    expect(client.guardCalls).toBe(0);
    expect(client.providerPrompts).toBe(0);
  });

  it("fails closed on a conflicting evidence atom authorization", () => {
    using artifacts = store();
    const built = fixture(artifacts);
    const appendix = buildScaP05InlineOpeningAppendix({
      store: artifacts,
      assignment: built.assignment,
    });
    const opening = `HOST\n\n${appendix}\n\nReturn the complete stage output and end with SUMMARY.`;
    expect(() =>
      authorizeScaP05SerializedOpening({
        store: artifacts,
        assignment: {
          ...built.assignment,
          input_artifacts: {
            ...built.assignment.input_artifacts,
            artifacts: [
              {
                slot: "cognitive_payload",
                ref: { ...built.payloadRef, content_digest: "f".repeat(64) },
              },
              { slot: "disclosure_admission", ref: built.disclosureRef },
            ],
          },
        },
        opening,
      })
    ).toThrow();
  });

  it("uses one canonical inline envelope marker", () => {
    expect(SCA_P05_INLINE_OPENING_PREFIX).toContain("host-verified");
  });
});
