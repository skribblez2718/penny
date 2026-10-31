import {
  ArtifactStore,
  currentArtifactRef,
  currentOutputArtifactMetadata,
} from "../../orchestration/dist/artifact-store.js";
import { Checkpointer } from "../../orchestration/dist/checkpointer.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  validateContract,
  validateDirective,
  type ArtifactRef,
  type InvokeHostOperationDirectiveV1,
} from "../../orchestration/dist/contracts.js";
import {
  hostOperationPolicyBinding,
  validateHostOperationDeclaration,
  validateHostOperationCallRecord,
  validateHostOperationResult,
  validateHostOperationReceipt,
  MAX_HOST_OPERATION_RECORD_BYTES,
  MAX_HOST_OPERATION_RECEIPT_BYTES,
  type HostOperationDeclarationV1,
} from "../../orchestration/dist/host-operations/contracts.js";
import {
  ScaP03InitialProposalBindingV1,
  ScaP03InitialHumanEventV1Schema,
  assertScaP03InitialControlRefV1,
  SCA_P03_INITIAL_CONTROL_MAX_BYTES,
  deriveScaP03InitialCustodyV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import {
  SCA_P03_INITIAL_WORK_STATE,
  SCA_P03_INITIAL_GATE_STATE,
  SCA_P03_INITIAL_OPERATION,
  readScaP03InitialGate,
  scaP03InitialOperationInputs,
} from "../../orchestration/dist/sca/p03-initial-qualification.js";
import type { ScaP03AttemptWitnessV1 } from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import {
  scaP03FrontendLanguageV1,
  projectScaP03OracleTargetObservationsV2,
  SCA_P03_MAX_QUALIFICATION_TOTAL_BYTES,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  ScaP03InitialEvidenceV1Schema,
  replayScaP03InitialFixturePreimagesV1,
  type ScaP03InitialEvidenceV1,
} from "./p03-initial-live.js";
import { exactP03BootstrapObservations } from "./p03-bootstrap.js";
import { createScaP03ApprovedInputReaderV1 } from "./p03-predecessor-inputs.js";
import {
  parseScaP03NativeInventoryV1,
  assertScaP03NativeFrontendV1,
  scaP03NativeQueryCandidatesV1,
} from "./p03-docker-runtime.js";
import { verifyScaP03ConsumedFixtureTranscriptV1 } from "./p03-consumed-fixture-transcript.js";
import {
  ScaP03ConsumedEnvelopeReaderV1,
  consumedFixtureCheckV1 as check,
  consumedFixtureGuardV1 as guard,
  consumedFixtureSameV1 as same,
  parseScaP03ConsumedJsonV1 as json,
} from "./p03-consumed-fixture-custody.js";
export {
  ScaP03ConsumedFixtureErrorV1,
  type ScaP03ConsumedFixtureFailureV1,
} from "./p03-consumed-fixture-custody.js";

export interface ScaP03ConsumedFixtureReadV1 {
  readonly checkpointer: Checkpointer;
  readonly store: ArtifactStore;
  readonly binding: ScaP03InitialProposalBindingV1;
  readonly directive: InvokeHostOperationDirectiveV1;
  readonly declaration: HostOperationDeclarationV1;
  readonly expected_measurement_scope: ScaP03InitialEvidenceV1["measurement_scope"];
}
export type ScaP03ObservedFixtureEvidenceV1 = Readonly<
  ScaP03InitialEvidenceV1 & { status: "observed" }
>;
export interface ScaP03ConsumedFixtureEvidenceV1 {
  readonly evidence: ScaP03ObservedFixtureEvidenceV1;
  readonly evidence_bytes: Uint8Array;
  readonly attempt_witness: ScaP03AttemptWitnessV1;
  readonly attempt_witness_bytes: Uint8Array;
  readonly result_ref: ArtifactRef;
  readonly platform_result_ref: ArtifactRef;
  readonly receipt_ref: ArtifactRef;
  readonly verification_scope: "historical_consumed_fixture_evidence";
  readonly current_execution_authorization: "not_evaluated";
}
/** Historical snapshot only. Never authenticates a retrospective principal or grants current use. */
export function readScaP03ConsumedFixtureEvidenceV1(
  input: ScaP03ConsumedFixtureReadV1
): ScaP03ConsumedFixtureEvidenceV1 {
  return guard("owner_binding", () => {
    check(
      input.store instanceof ArtifactStore &&
        input.checkpointer instanceof Checkpointer &&
        input.binding instanceof ScaP03InitialProposalBindingV1,
      "owner_binding"
    );
    check(
      input.expected_measurement_scope === "live_observed" ||
        input.expected_measurement_scope === "deterministic_transport_test",
      "scope"
    );
    const directive = validateDirective(input.directive);
    check(directive.action === "invoke_host_operation", "owner_binding");
    const d = validateHostOperationDeclaration(input.declaration);
    input.binding.assertRef(directive.request_ref);
    input.binding.assertRun(directive.identity.run_id);
    const pinned = input.binding.proposal;
    check(
      pinned.effect === "fixture_qualification" &&
        directive.operation_kind === SCA_P03_INITIAL_OPERATION &&
        directive.state_id === SCA_P03_INITIAL_WORK_STATE &&
        directive.attempt === 1 &&
        directive.operation_id === `initial:${pinned.approval_id}:${pinned.invocation_nonce}` &&
        directive.request_sha256 === directive.request_ref.content_digest,
      "owner_binding"
    );
    check(
      d.operation_kind === SCA_P03_INITIAL_OPERATION &&
        d.adapter_id === "sca-p03-initial-qualification-adapter-v1" &&
        d.max_output_artifacts === 1 &&
        (d.output_contracts?.length ?? 0) === 0 &&
        same(directive.expected_result, d.result) &&
        same(
          directive.policy_binding,
          hostOperationPolicyBinding(d, pinned.backend_resource_sha256)
        ),
      "owner_binding"
    );
    const load = () =>
      input.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      );
    const found = load();
    check(found !== undefined, "missing_evidence");
    const record = validateHostOperationCallRecord(found);
    const recordSnapshot = canonicalJson(record);
    check(
      same(record.identity, directive.identity) &&
        same(record.directive, directive) &&
        record.project_id === pinned.project_id &&
        record.lifecycle === "consumed" &&
        same(record.disposition, {
          outcome: "completed",
          remote_disposition: "proven_terminal",
          lease_disposition: "released",
          retryable: false,
          reason_code: null,
        }),
      "owner_binding"
    );
    check(
      record.operation_result_ref !== null &&
        record.platform_result_ref !== null &&
        record.host_receipt_ref !== null,
      "missing_evidence"
    );
    check(
      record.lease !== null &&
        record.lease_disposition_receipt_id !== null &&
        record.output_artifacts.length === 0 &&
        record.lease.backend_key_sha256 === pinned.backend_resource_sha256,
      "owner_binding"
    );
    input.store.assertBoundProject(pinned.project_id);
    const slot = (name: string) => {
      const ref = directive.input_artifacts.artifacts.find((v) => v.slot === name)?.ref;
      check(ref !== undefined, "missing_evidence");
      return ref;
    };
    const proposalRef = slot("initial_proposal"),
      transportRef = slot("initial_transport"),
      witnessRef = slot("initial_witness");
    check(
      same(
        directive.input_artifacts,
        scaP03InitialOperationInputs(
          directive.request_ref,
          transportRef,
          witnessRef,
          pinned.input_refs
        )
      ),
      "owner_binding"
    );
    const refs = directive.input_artifacts.artifacts.map((v) => v.ref);
    check(new Set(refs.map((r) => r.artifact_id)).size === refs.length, "owner_binding");
    for (const [kind, ref] of [
      ["proposal", proposalRef],
      ["transport", transportRef],
      ["witness", witnessRef],
    ] as const) {
      assertScaP03InitialControlRefV1(ref, kind);
      check(ref.run_id === pinned.run_id, "owner_binding");
      if (kind !== "proposal")
        check(
          ref.phase === SCA_P03_INITIAL_GATE_STATE && ref.operation_id === `initial:${ref.kind}`,
          "provenance"
        );
    }
    const envelopes = new ScaP03ConsumedEnvelopeReaderV1(input.store, [
      proposalRef,
      transportRef,
      witnessRef,
      record.operation_result_ref,
      record.platform_result_ref,
      record.host_receipt_ref,
    ]);
    const custody = deriveScaP03InitialCustodyV1(pinned.input_refs);
    check(
      d.request.artifact_kind === proposalRef.kind &&
        d.request.schema_id === proposalRef.content_schema?.schema_id &&
        d.request.schema_version_required === proposalRef.content_schema.schema_version,
      "owner_binding"
    );
    check(
      proposalRef.byte_length <= d.max_request_bytes &&
        (d.max_input_artifacts === undefined || refs.length <= d.max_input_artifacts) &&
        (d.max_input_bytes === undefined ||
          refs.reduce((n, ref) => n + ref.byte_length, 0) <= d.max_input_bytes),
      "bounds"
    );
    // Validate all provenance membership BEFORE any approved body is read. No discovered closure.
    const approvedMap = new Map(pinned.input_refs.map((ref) => [ref.artifact_id, ref]));
    guard("provenance", () => {
      for (const ref of pinned.input_refs) {
        currentArtifactRef(ref);
        const stored = input.store.refById(ref.artifact_id);
        check(stored !== undefined, "missing_evidence");
        check(same(stored, ref), "bytes");
        const raw = input.store.metadata(ref);
        check(
          Array.isArray(raw.upstream_refs) && raw.upstream_refs.length <= custody.max_refs,
          "bounds"
        );
        const metadata = currentOutputArtifactMetadata(raw);
        const links = [
          ...metadata.upstream_refs,
          ...(metadata.parent_ref === null ? [] : [metadata.parent_ref]),
          ...(metadata.domain_revision_parent_ref == null
            ? []
            : [metadata.domain_revision_parent_ref]),
        ];
        check(
          links.length <= custody.max_refs &&
            links.every((link) => same(approvedMap.get(link.artifact_id), link)),
          "provenance"
        );
      }
    });
    const proposalBytes = envelopes.exact(
      proposalRef,
      SCA_P03_INITIAL_CONTROL_MAX_BYTES,
      pinned.input_refs,
      pinned.input_refs
    ).bytes;
    json(proposalBytes, SCA_P03_INITIAL_CONTROL_MAX_BYTES);
    const proposal = input.binding.read(input.store, proposalRef);
    const transportBytes = envelopes.exact(
      transportRef,
      SCA_P03_INITIAL_CONTROL_MAX_BYTES,
      [proposalRef],
      proposal.input_refs
    ).bytes;
    json(transportBytes, SCA_P03_INITIAL_CONTROL_MAX_BYTES);
    const gate = readScaP03InitialGate(input.store, proposalRef, transportRef);
    const eventBytes = envelopes.exact(
      witnessRef,
      SCA_P03_INITIAL_CONTROL_MAX_BYTES,
      [proposalRef, transportRef],
      proposal.input_refs
    ).bytes;
    const event = validateContract(
      ScaP03InitialHumanEventV1Schema,
      json(eventBytes, SCA_P03_INITIAL_CONTROL_MAX_BYTES),
      "P03 historical approval operand"
    );
    check(
      event.run_id === proposal.run_id &&
        event.gate_id === gate.gate_id &&
        event.challenge === gate.challenge &&
        same(event.artifact_ref, proposalRef) &&
        same(event.questionnaire_transport_ref, transportRef) &&
        event.rendered_questions_digest === gate.rendered_questions_digest &&
        event.decision === "approve" &&
        event.response === "approve" &&
        Date.parse(event.timestamp) >= Date.parse(proposal.issued_at) &&
        Date.parse(event.timestamp) < Date.parse(proposal.expires_at) &&
        Date.parse(event.timestamp) <= Date.parse(record.started_at),
      "owner_binding"
    );
    const approved = createScaP03ApprovedInputReaderV1(input.store, proposal.input_refs);
    const checked = guard("fixture_consistency", () => {
      for (const ref of proposal.input_refs) approved.exact(ref);
      return replayScaP03InitialFixturePreimagesV1({
        proposal,
        reader: {
          read: (ref) => Buffer.from(approved.exact(ref).bytes),
          metadata: (ref) => approved.metadata(ref),
          refById: (id) => approved.refById(id),
          readById: (id) => {
            // This surface is used by the owning P01 typed-root validator, not for
            // the opaque provenance walk. Keep octet-stream packages unchanged.
            const ref = approved.refById(id);
            check(ref !== undefined, "missing_evidence");
            const bytes = approved.readById(id);
            if (ref.media_type === "application/json") json(bytes, custody.max_json_bytes);
            return bytes;
          },
        },
      });
    });
    const resultRef = record.operation_result_ref,
      platformRef = record.platform_result_ref,
      receiptRef = record.host_receipt_ref;
    check(
      d.result.artifact_kind === resultRef.kind &&
        d.result.schema_id === resultRef.content_schema?.schema_id &&
        d.result.schema_version_required === resultRef.content_schema.schema_version,
      "owner_binding"
    );
    const contract = (
      ref: ArtifactRef,
      kind: string,
      operation: string,
      schema: string,
      producer: string
    ) =>
      check(
        ref.run_id === proposal.run_id &&
          ref.phase === directive.state_id &&
          ref.branch_id === null &&
          ref.version === 1 &&
          ref.kind === kind &&
          ref.operation_id === `${operation}:${record.operation_record_id}` &&
          ref.producer === producer &&
          ref.media_type === "application/json" &&
          same(ref.content_schema, { schema_id: schema, schema_version: 1 }),
        "provenance"
      );
    contract(
      resultRef,
      "sca-p03-initial-evidence",
      "host-operation-specific-result",
      "penny.sca-p03-initial-evidence.v1",
      `host:${d.adapter_id}`
    );
    contract(
      platformRef,
      "host-operation-result",
      "host-operation-platform-result",
      "penny.host-operation-result.v1",
      "host:host-operation-owner"
    );
    contract(
      receiptRef,
      "host-operation-receipt",
      "host-operation-receipt",
      "penny.host-operation-receipt.v1",
      "host:host-operation-owner"
    );
    const upstream = [
      ...new Map([directive.request_ref, ...refs].map((ref) => [ref.artifact_id, ref])).values(),
    ];
    const evidenceBytes = envelopes.exact(
      resultRef,
      Math.min(proposal.resources.max_evidence_bytes, d.max_output_bytes),
      upstream,
      proposal.input_refs
    ).bytes;
    const e = guard("fixture_consistency", () =>
      validateContract(
        ScaP03InitialEvidenceV1Schema,
        json(evidenceBytes, proposal.resources.max_evidence_bytes),
        "P03 consumed fixture"
      )
    );
    check(e.status === "observed", "fixture_consistency");
    check(e.measurement_scope === input.expected_measurement_scope, "scope");
    check(
      e.run_id === proposal.run_id &&
        e.invocation_nonce === proposal.invocation_nonce &&
        e.request_sha256 === directive.request_sha256 &&
        same(e.pre_live_inputs_ref, checked.manifestRef) &&
        same(e.input_refs, proposal.input_refs) &&
        e.query_release_sha256 === checked.query_release.release_sha256,
      "fixture_consistency"
    );
    const platform = guard("owner_binding", () =>
      validateHostOperationResult(
        json(
          envelopes.exact(
            platformRef,
            MAX_HOST_OPERATION_RECORD_BYTES,
            [proposalRef, resultRef],
            proposal.input_refs
          ).bytes,
          MAX_HOST_OPERATION_RECORD_BYTES
        )
      )
    );
    const receipt = guard("owner_binding", () =>
      validateHostOperationReceipt(
        json(
          envelopes.exact(
            receiptRef,
            MAX_HOST_OPERATION_RECEIPT_BYTES,
            [proposalRef, platformRef],
            proposal.input_refs
          ).bytes,
          MAX_HOST_OPERATION_RECEIPT_BYTES
        )
      )
    );
    for (const envelope of [platform, receipt])
      check(
        same(envelope.identity, directive.identity) &&
          envelope.operation_record_id === record.operation_record_id &&
          envelope.state_id === directive.state_id &&
          envelope.attempt === directive.attempt &&
          envelope.operation_id === directive.operation_id &&
          envelope.operation_kind === directive.operation_kind &&
          envelope.registration_sha256 === directive.registration_sha256 &&
          envelope.request_sha256 === directive.request_sha256 &&
          same(envelope.disposition, record.disposition),
        "owner_binding"
      );
    check(
      same(platform.operation_result_ref, resultRef) &&
        same(platform.lease, record.lease) &&
        same(platform.output_artifacts, []) &&
        receipt.result_sha256 === resultRef.content_digest &&
        receipt.remote_correlation_sha256 === record.remote_correlation_sha256 &&
        receipt.lease_disposition_receipt_id === record.lease_disposition_receipt_id &&
        receipt.request_bytes === proposalRef.byte_length &&
        receipt.output_artifact_count === 1 &&
        receipt.output_bytes === resultRef.byte_length &&
        receipt.progress_event_count === record.progress_event_count &&
        receipt.progress_event_count <= d.max_progress_events &&
        receipt.poll_count === 0 &&
        receipt.started_at === record.started_at &&
        Date.parse(receipt.ended_at) <= Date.parse(record.updated_at) &&
        receipt.receipt_id ===
          `hop_receipt_${sha256(canonicalJson({ operation_record_id: record.operation_record_id, disposition_receipt_id: record.lease_disposition_receipt_id }))}`,
      "owner_binding"
    );
    check(
      same(record.fetched, {
        schema_version: 1,
        content_sha256: resultRef.content_digest,
        byte_length: resultRef.byte_length,
        item_count: 1,
        poll_count: 0,
      }) &&
        same(record.persistence_plan, {
          schema_version: 1,
          operation_result: {
            schema_version: 1,
            operation_id: resultRef.operation_id,
            version: 1,
            artifact_kind: resultRef.kind,
            media_type: resultRef.media_type,
            schema_id: "penny.sca-p03-initial-evidence.v1",
            schema_version_required: 1,
            byte_length: resultRef.byte_length,
            content_sha256: resultRef.content_digest,
          },
          outputs: [],
          disposition: record.disposition,
        }),
      "owner_binding"
    );
    const transcript = verifyScaP03ConsumedFixtureTranscriptV1({
      evidence: e,
      resources: proposal.resources,
      operation_record_id: record.operation_record_id,
      run_id: proposal.run_id,
      request_sha256: directive.request_sha256,
    });
    check(
      Date.parse(transcript.attempt_witness.started_at) >= Date.parse(record.started_at) &&
        Date.parse(transcript.attempt_witness.ended_at) <= Date.parse(receipt.ended_at),
      "witness_consistency"
    );
    guard("fixture_consistency", () => {
      check(
        exactP03BootstrapObservations(
          checked.corpus,
          checked.query_release,
          checked.fixtures,
          { cases: e.cases, executed_query_release_sha256: e.query_release_sha256 },
          checked.m.source_oracle_validation_ref
        ),
        "fixture_consistency"
      );
      let caseBytes = 0;
      for (const readback of transcript.readbacks) {
        const fixture = checked.fixtures.find((f) => f.language === readback.language);
        check(fixture !== undefined, "fixture_consistency");
        const data = parseScaP03NativeInventoryV1(readback.inventory);
        assertScaP03NativeFrontendV1(data, scaP03FrontendLanguageV1(readback.language));
        check(
          data.files.has(fixture.path) &&
            data.nodes.some((node) => node.file_name === fixture.path),
          "fixture_consistency"
        );
        const candidates = scaP03NativeQueryCandidatesV1(
          checked.query_release,
          data,
          [{ path: fixture.path, disposition: "parsed" }],
          proposal.resources.max_query_items,
          {
            graph_component_sha256: sha256(readback.graph),
            source_snapshot_sha256: fixture.content_sha256,
          },
          checked.corpus.expected_cases.filter((entry) => entry.language === readback.language),
          checked.m.source_oracle_validation_ref,
          Buffer.from(fixture.bytes).toString("utf8").split("\n")
        );
        for (const entry of e.cases.filter((c) => c.language === readback.language)) {
          const expected = checked.corpus.expected_cases.find((c) => c.case_id === entry.case_id);
          check(expected !== undefined, "fixture_consistency");
          const replayed = projectScaP03OracleTargetObservationsV2(
            candidates.get(entry.query_id) ?? [],
            expected.oracle_assertions
          ).sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
          check(
            same(replayed, entry.observations) &&
              entry.observations.every(
                (candidate) =>
                  candidate.graph_component_sha256 === sha256(readback.graph) &&
                  candidate.source_snapshot_sha256 === fixture.content_sha256 &&
                  candidate.query_release_sha256 === checked.query_release.release_sha256
              ),
            "fixture_consistency"
          );
          caseBytes +=
            Buffer.byteLength(canonicalJson(entry.observations)) + (caseBytes === 0 ? 2 : 1);
          check(
            caseBytes <=
              Math.min(
                proposal.resources.max_evidence_bytes,
                SCA_P03_MAX_QUALIFICATION_TOTAL_BYTES
              ),
            "bounds"
          );
        }
      }
    });
    guard("reread_drift", () => approved.finish());
    envelopes.finish();
    guard("reread_drift", () => check(canonicalJson(load()) === recordSnapshot, "reread_drift"));
    return {
      evidence: structuredClone({ ...e, status: "observed" }),
      evidence_bytes: Buffer.from(evidenceBytes),
      attempt_witness: structuredClone(transcript.attempt_witness),
      attempt_witness_bytes: Buffer.from(transcript.attempt_witness_bytes),
      result_ref: structuredClone(resultRef),
      platform_result_ref: structuredClone(platformRef),
      receipt_ref: structuredClone(receiptRef),
      verification_scope: "historical_consumed_fixture_evidence",
      current_execution_authorization: "not_evaluated",
    };
  });
}
