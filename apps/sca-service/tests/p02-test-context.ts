import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type {
  ArtifactRef,
  InvokeHostOperationDirectiveV1,
} from "../../orchestration/dist/contracts.js";
import {
  hostOperationDirectiveSha256,
  hostOperationPolicyBinding,
  type HostOperationCallRecordV1,
  type HostOperationDeclarationV1,
  type HostOperationLifecycleV1,
} from "../../orchestration/dist/host-operations/contracts.js";

function requestRef(requestBytes: string, operationKind: string): ArtifactRef {
  const digest = sha256(requestBytes);
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: "p02-test-run",
    phase: "sca-p02-candidate",
    branch_id: null,
    kind: `sca-p02-${operationKind.replaceAll("_", "-")}-request`,
    operation_id: `p02_${operationKind}`,
    version: 1,
    producer: "host:sca-p02-candidate",
    media_type: "application/json",
    content_schema: {
      schema_id: `penny.sca-p02-${operationKind.replaceAll("_", "-")}-request.v1`,
      schema_version: 1,
    },
    byte_length: Buffer.byteLength(requestBytes, "utf8"),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

export function p02TestOperationEnvelope(input: {
  readonly declaration: HostOperationDeclarationV1;
  readonly requestBytes: string;
  readonly requestSha256: string;
  readonly lifecycle: HostOperationLifecycleV1;
  readonly createdAt: string;
}): Readonly<{
  directive: InvokeHostOperationDirectiveV1;
  journal: HostOperationCallRecordV1;
}> {
  const ref = requestRef(input.requestBytes, input.declaration.operation_kind);
  const identity = {
    schema_version: 2 as const,
    run_id: ref.run_id,
    session_id: "p02-test-session",
    playbook: "sca-p02-candidate",
    engine_owner: "typescript" as const,
  };
  const registrationSha256 = sha256("p02-test-registration");
  const policyBinding = hostOperationPolicyBinding(input.declaration, sha256("p02-test-backend"));
  const directive: InvokeHostOperationDirectiveV1 = {
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity,
    state_id: `running_${input.declaration.operation_kind}`,
    attempt: 1,
    operation_id: `p02_${input.declaration.operation_kind}`,
    operation_kind: input.declaration.operation_kind,
    registration_sha256: registrationSha256,
    request_ref: ref,
    request_sha256: input.requestSha256,
    input_artifacts: { schema_version: 2, artifacts: [] },
    expected_result: input.declaration.result,
    policy_binding: policyBinding,
  };
  const correlationId = `p02_${input.requestSha256}`;
  const remoteAccepted = input.lifecycle !== "lease_acquired";
  const journal: HostOperationCallRecordV1 = {
    schema_version: 1,
    operation_record_id: `hop_${sha256(canonicalJson({ directive, created_at: input.createdAt }))}`,
    project_id: "p02-test-project",
    identity,
    state_id: directive.state_id,
    attempt: directive.attempt,
    operation_id: directive.operation_id,
    operation_kind: directive.operation_kind,
    directive,
    directive_sha256: hostOperationDirectiveSha256(directive),
    registration_sha256: registrationSha256,
    request_ref: ref,
    request_sha256: input.requestSha256,
    input_artifacts: directive.input_artifacts,
    expected_result: directive.expected_result,
    policy_binding: policyBinding,
    lifecycle: input.lifecycle,
    lease: null,
    lease_expires_at_ms: null,
    queue_inactivity_expires_at_ms: 0,
    operation_inactivity_expires_at_ms: 0,
    remote_correlation_id: remoteAccepted ? correlationId : null,
    remote_correlation_sha256: remoteAccepted ? sha256(correlationId) : null,
    fetched: null,
    persistence_plan: null,
    operation_result_ref: null,
    output_artifacts: [],
    disposition: null,
    lease_disposition_receipt_id: null,
    platform_result_ref: null,
    host_receipt_ref: null,
    progress_event_count: 0,
    started_at: input.createdAt,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
  return { directive, journal };
}
