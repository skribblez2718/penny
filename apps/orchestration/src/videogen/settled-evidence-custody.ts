import { verifyHostResultWrapper } from "../host-operations/effect-protocol.js";
import { ArtifactStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { Checkpointer } from "../checkpointer.js";
import type { ArtifactRef, HostOperationArtifactContractV1 } from "../contracts.js";
import { HostOperationLeaseAuthority } from "../host-operations/lease-authority.js";
import {
  HostOperationReceiptV1Schema,
  HostOperationResultV1Schema,
  hostOperationPolicyBinding,
  type HostOperationDeclarationV1,
} from "../host-operations/contracts.js";
import { HostOperationArtifactCustody } from "../host-operations/storage.js";
import { readSemantic, type FoundationLimitsV1 } from "./bounds.js";
export interface SettledEvidenceCustodyBindingsV1 {
  readonly project_id: string;
  readonly store: ArtifactStore;
  readonly checkpointer: Checkpointer;
  readonly leases: HostOperationLeaseAuthority;
  readonly limits: FoundationLimitsV1;
  readonly registration_sha256: string;
  readonly declaration: HostOperationDeclarationV1;
  readonly backend_key_sha256: string;
}
function requireValue<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) throw new Error(`media custody missing ${name}`);
  return value;
}
function equal(a: unknown, b: unknown, label: string): void {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(`media custody mismatch: ${label}`);
}
/** Read-only verification against the existing owner journal and lease authority. No signer,
 * receipt store, registration, execution, caller journal or positive-status callback. */
export class SettledEvidenceCustody {
  private readonly b: SettledEvidenceCustodyBindingsV1;
  private readonly custody: HostOperationArtifactCustody;
  constructor(bindings: SettledEvidenceCustodyBindingsV1) {
    if (
      !(bindings.store instanceof ArtifactStore) ||
      !(bindings.checkpointer instanceof Checkpointer) ||
      !(bindings.leases instanceof HostOperationLeaseAuthority)
    )
      throw new Error("settled evidence requires concrete existing owners");
    bindings.store.assertBoundProject(bindings.project_id);
    this.b = {
      ...bindings,
      limits: structuredClone(bindings.limits),
      declaration: structuredClone(bindings.declaration),
    };
    this.custody = HostOperationArtifactCustody.fromArtifactStore(bindings.store);
  }
  /** Shared receipt/journal verification for additive raw media contracts. No decoder or PASS hook. */
  verifySettled(operationRecordId: string, expected: HostOperationArtifactContractV1) {
    const b = this.b;
    const record = this.custody.verifyForProject(
      b.project_id,
      requireValue(b.checkpointer.hostOperationCall(operationRecordId), "journal")
    );
    if (
      (record.lifecycle !== "settled" && record.lifecycle !== "consumed") ||
      record.disposition?.outcome !== "completed" ||
      record.operation_kind !== b.declaration.operation_kind ||
      record.registration_sha256 !== b.registration_sha256
    )
      throw new Error("settled custody requires exact completed settled operation");
    equal(
      record.policy_binding,
      hostOperationPolicyBinding(b.declaration, b.backend_key_sha256),
      "current declaration/backend"
    );
    equal(record.expected_result, expected, "raw result contract");
    if (b.declaration.receipt_citing_result !== undefined && record.result_wrapper === undefined)
      throw new Error("settled evidence result wrapper absent");
    verifyHostResultWrapper(b.store, record);
    const rawRef = requireValue(record.operation_result_ref, "raw result");
    const receiptRef = requireValue(record.host_receipt_ref, "owner receipt");
    const platformRef = requireValue(record.platform_result_ref, "platform result");
    const plan = requireValue(record.persistence_plan, "raw persistence plan");
    const disposition = requireValue(
      b.leases.dispositionForOperation(record.operation_record_id),
      "lease disposition"
    );
    equal(disposition.disposition, record.disposition, "lease outcome");
    equal(disposition.lease, record.lease, "lease identity");
    if (
      disposition.receipt_id !== record.lease_disposition_receipt_id ||
      disposition.backend_key_sha256 !== b.backend_key_sha256 ||
      disposition.remote_correlation_sha256 !== record.remote_correlation_sha256
    )
      throw new Error("settled lease disposition drift");
    const read = <T extends Parameters<typeof readSemantic>[0]["schema"]>(
      ref: ArtifactRef,
      schema: T,
      schemaId: string
    ) =>
      readSemantic({
        store: b.store,
        project_id: b.project_id,
        ref,
        schema,
        schema_id: schemaId,
        limits: b.limits,
      });
    const platform = read(
      platformRef,
      HostOperationResultV1Schema,
      "penny.host-operation-result.v1"
    );
    equal(
      platform,
      {
        schema_version: 1,
        operation_record_id: record.operation_record_id,
        identity: record.identity,
        state_id: record.state_id,
        attempt: record.attempt,
        operation_id: record.operation_id,
        operation_kind: record.operation_kind,
        registration_sha256: record.registration_sha256,
        request_sha256: record.request_sha256,
        lease: record.lease,
        disposition: record.disposition,
        operation_result_ref: rawRef,
        output_artifacts: record.output_artifacts,
      },
      "platform result"
    );
    const receipt = read(
      receiptRef,
      HostOperationReceiptV1Schema,
      "penny.host-operation-receipt.v1"
    );
    if (
      receipt.operation_record_id !== record.operation_record_id ||
      receipt.operation_id !== record.operation_id ||
      receipt.operation_kind !== record.operation_kind ||
      receipt.registration_sha256 !== record.registration_sha256 ||
      receipt.request_sha256 !== record.request_sha256 ||
      receipt.result_sha256 !== rawRef.content_digest ||
      receipt.output_artifact_count !== record.output_artifacts.length + 1 ||
      receipt.output_bytes !==
        rawRef.byte_length + record.output_artifacts.reduce((n, ref) => n + ref.byte_length, 0) ||
      receipt.lease_disposition_receipt_id !== disposition.receipt_id ||
      receipt.remote_correlation_sha256 !== record.remote_correlation_sha256 ||
      receipt.request_bytes !== record.request_ref.byte_length ||
      receipt.started_at !== record.started_at ||
      receipt.progress_event_count !== record.progress_event_count ||
      receipt.poll_count !== (record.fetched?.poll_count ?? 0)
    )
      throw new Error("settled owner receipt identity/count drift");
    equal(receipt.identity, record.identity, "receipt run");
    equal(receipt.disposition, record.disposition, "receipt outcome");
    if (
      receipt.state_id !== record.state_id ||
      receipt.attempt !== record.attempt ||
      receipt.ended_at < receipt.started_at
    )
      throw new Error("settled receipt visit/time drift");
    const expectedReceiptId = `hop_receipt_${sha256(canonicalJson({ operation_record_id: record.operation_record_id, disposition_receipt_id: disposition.receipt_id }))}`;
    if (receipt.receipt_id !== expectedReceiptId) throw new Error("settled receipt identity drift");
    const receiptMeta = b.store.metadata(receiptRef);
    const platformMeta = b.store.metadata(platformRef);
    if (
      receiptRef.producer !== "host:host-operation-owner" ||
      platformRef.producer !== "host:host-operation-owner"
    )
      throw new Error("settled owner producer drift");
    equal(
      receiptMeta.upstream_refs,
      [record.request_ref, platformRef],
      "receipt platform provenance"
    );
    equal(
      platformMeta.upstream_refs,
      [record.request_ref, rawRef, ...record.output_artifacts],
      "platform raw provenance"
    );
    return { record, rawRef, receiptRef, platformRef, plan, read };
  }
}
