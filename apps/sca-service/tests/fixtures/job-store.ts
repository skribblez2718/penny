import { canonicalJson, sha256 } from "../../../orchestration/dist/canonical-json.js";
import type { CurrentArtifactRef } from "../../../orchestration/dist/contracts.js";
import type {
  ScaAdapterRegistry,
  ScaAdapterTerminalResult,
  ScaOperationAdapter,
} from "../../src/adapters.js";
import {
  SCA_BROKER_CONTRACT_LIMITS_V1,
  scaBrokerExecuteRequestSha256,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerPollRequestV1,
  type ScaBrokerCancelRequestV1,
} from "../../src/contracts.js";
const RUN_ID = "run-sca-jobs-001";

export function artifactRef(kind: string, operationId: string): CurrentArtifactRef {
  const identity = {
    branch_id: null,
    kind,
    operation_id: operationId,
    phase: "application",
    run_id: RUN_ID,
    version: 1,
  };
  const contentDigest = sha256(`${RUN_ID}:${kind}:${operationId}:content`);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(canonicalJson(identity))}`,
    run_id: RUN_ID,
    phase: "application",
    branch_id: null,
    kind,
    operation_id: operationId,
    version: 1,
    producer: "sca-job-fixture",
    media_type: "application/json",
    byte_length: 128,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

export function executeRequest(timeoutMs: number): ScaBrokerExecuteRequestV1 {
  const submittedAt = new Date(Date.now() - 100);
  return {
    schema_id: "penny.sca-broker-execute-request.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: RUN_ID,
    job_id: "job-source-query",
    attempt: 1,
    idempotency_key: "idempotency-source-query",
    tool_name: "sca_source_query",
    operation: "source_query",
    submitted_at: submittedAt.toISOString(),
    deadline_at: new Date(submittedAt.getTime() + 30_000).toISOString(),
    limits: { timeout_ms: timeoutMs, max_output_bytes: 16_384, max_result_items: 50 },
    source_snapshot_ref: artifactRef("source-snapshot", "snapshot-source-query"),
    config_ref: artifactRef("sca-config", "config-source-query"),
    input_refs: [],
    operation_input: {
      kind: "source_query",
      query_id: "query-source-1",
      selectors: [{ path: "src/example.ts", line_range: null, symbol: "Example" }],
      parameters: [],
    },
  };
}

export function pollRequest(request: ScaBrokerExecuteRequestV1): ScaBrokerPollRequestV1 {
  const requestedAt = new Date();
  return {
    schema_id: "penny.sca-broker-poll-request.v1",
    schema_version: 1,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    job_id: request.job_id,
    attempt: request.attempt,
    idempotency_key: request.idempotency_key,
    tool_name: request.tool_name,
    operation: request.operation,
    request_sha256: scaBrokerExecuteRequestSha256(request),
    requested_at: requestedAt.toISOString(),
    deadline_at: new Date(requestedAt.getTime() + 1_000).toISOString(),
    poll_timeout_ms: 1_000,
  };
}

export function cancelRequest(
  request: ScaBrokerExecuteRequestV1,
  timeoutMs: number
): ScaBrokerCancelRequestV1 {
  const requestedAt = new Date();
  return {
    schema_id: "penny.sca-broker-cancel-request.v1",
    schema_version: 1,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    job_id: request.job_id,
    attempt: request.attempt,
    idempotency_key: request.idempotency_key,
    tool_name: request.tool_name,
    operation: request.operation,
    request_sha256: scaBrokerExecuteRequestSha256(request),
    reason: "caller_requested",
    requested_at: requestedAt.toISOString(),
    deadline_at: new Date(requestedAt.getTime() + timeoutMs).toISOString(),
    timeout_ms: timeoutMs,
  };
}

export function terminalSuccess(outputRef: CurrentArtifactRef): ScaAdapterTerminalResult {
  return {
    terminal_status: "succeeded",
    partial: false,
    truncated: false,
    output_refs: [outputRef],
    result_item_count: 1,
    failure: null,
  };
}

export function adapterRegistry(adapter: ScaOperationAdapter): ScaAdapterRegistry {
  return {
    source_query: adapter,
    graph_query: null,
    application_test: null,
  };
}

export function adapterWithRun(run: ScaOperationAdapter["run"]): ScaOperationAdapter {
  return {
    async capability(request) {
      return {
        schema_id: "penny.sca-broker-capability-result.v1",
        schema_version: 1,
        tenant_id: request.tenant_id,
        project_id: request.project_id,
        run_id: request.run_id,
        request_id: request.request_id,
        tool_name: request.tool_name,
        operation: request.operation,
        status: "available",
        limits: {
          max_request_bytes: SCA_BROKER_CONTRACT_LIMITS_V1.max_request_bytes,
          max_input_refs: SCA_BROKER_CONTRACT_LIMITS_V1.max_input_refs,
          max_output_refs: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_refs,
          max_selectors: SCA_BROKER_CONTRACT_LIMITS_V1.max_selectors,
          max_parameters: SCA_BROKER_CONTRACT_LIMITS_V1.max_parameters,
          max_timeout_ms: SCA_BROKER_CONTRACT_LIMITS_V1.max_timeout_ms,
          max_output_bytes: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_bytes,
          max_result_items: SCA_BROKER_CONTRACT_LIMITS_V1.max_result_items,
        },
        error: null,
        observed_at: request.requested_at,
      };
    },
    run,
  };
}
