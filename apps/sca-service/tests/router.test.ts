import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/src/canonical-json.js";
import { type CurrentArtifactRef } from "../../orchestration/src/contracts.js";
import {
  SCA_ADAPTER_REGISTRY,
  SCA_BROKER_SCHEMA_MANIFEST_SHA256,
  SCA_SERVICE_BROKER_MANIFEST_SHA256,
  SCA_SERVICE_IPC_PROTOCOL,
  createScaRouter,
  scaBrokerExecuteRequestSha256,
  validateScaBrokerCapabilityResultV1,
  type ScaBrokerCapabilityRequestV1,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerOperationKind,
  type ScaBrokerToolName,
} from "../src/index.js";

const TOKEN = "router-test-token-000000000000000000000000";
const NOW = new Date("2026-03-14T12:00:05.000Z");
const REQUESTED_AT = "2026-03-14T12:00:00.000Z";
const DEADLINE_AT = "2026-03-14T12:00:10.000Z";
const RUN_ID = "run-sca-service-001";

const TOOL_BY_OPERATION = {
  source_query: "sca_source_query",
  graph_query: "sca_graph_query",
  application_test: "sca_application_test",
} as const satisfies Readonly<Record<ScaBrokerOperationKind, ScaBrokerToolName>>;

function router() {
  return createScaRouter({ authenticationToken: TOKEN, now: () => NOW });
}

function frame(action: string, request: unknown, token = TOKEN): Record<string, unknown> {
  return { protocol: SCA_SERVICE_IPC_PROTOCOL, action, token, request };
}

function capabilityRequest(
  operation: ScaBrokerOperationKind,
  requestId = `capability-${operation}`
): ScaBrokerCapabilityRequestV1 {
  return {
    schema_id: "penny.sca-broker-capability-request.v1",
    schema_version: 1,
    request_id: requestId,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: RUN_ID,
    tool_name: TOOL_BY_OPERATION[operation],
    operation,
    requested_at: REQUESTED_AT,
    deadline_at: DEADLINE_AT,
    timeout_ms: 1_000,
  };
}

function artifactRef(kind: string, operationId: string): CurrentArtifactRef {
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
    producer: "sca-service-fixture",
    media_type: "application/json",
    byte_length: 128,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

function executeRequest(): ScaBrokerExecuteRequestV1 {
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
    submitted_at: REQUESTED_AT,
    deadline_at: DEADLINE_AT,
    limits: {
      timeout_ms: 1_000,
      max_output_bytes: 16_384,
      max_result_items: 50,
    },
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

function pollRequest(request: ScaBrokerExecuteRequestV1) {
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
    requested_at: REQUESTED_AT,
    deadline_at: DEADLINE_AT,
    poll_timeout_ms: 1_000,
  };
}

function cancelRequest(request: ScaBrokerExecuteRequestV1) {
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
    requested_at: REQUESTED_AT,
    deadline_at: DEADLINE_AT,
    timeout_ms: 1_000,
  };
}

describe("SCA service contract boundary", () => {
  it("pins the accepted S-03-T1 digest and exposes only immutable unavailable adapters", () => {
    expect(SCA_SERVICE_BROKER_MANIFEST_SHA256).toBe(SCA_BROKER_SCHEMA_MANIFEST_SHA256);
    expect(Object.isFrozen(SCA_ADAPTER_REGISTRY)).toBe(true);
    expect(SCA_ADAPTER_REGISTRY).toEqual({
      source_query: null,
      graph_query: null,
      application_test: null,
    });
  });

  it.each(["source_query", "graph_query", "application_test"] as const)(
    "reports %s capability truthfully unavailable with exact request binding",
    async (operation) => {
      const request = capabilityRequest(operation);
      const response = await router().route(frame("capability", request));
      expect(response.ok).toBe(true);
      if (!response.ok || response.action !== "capability") throw new Error("unexpected response");
      expect(response.result).toMatchObject({
        request_id: request.request_id,
        tenant_id: request.tenant_id,
        project_id: request.project_id,
        run_id: request.run_id,
        tool_name: request.tool_name,
        operation,
        status: "unavailable",
        limits: null,
        error: { code: "service_unavailable" },
      });
      expect(validateScaBrokerCapabilityResultV1(response.result, request)).toEqual(
        response.result
      );
    }
  );

  it("refuses cross-request capability substitution", async () => {
    const first = capabilityRequest("source_query", "capability-first");
    const second = capabilityRequest("source_query", "capability-second");
    const response = await router().route(frame("capability", first));
    if (!response.ok || response.action !== "capability") throw new Error("unexpected response");
    expect(() => validateScaBrokerCapabilityResultV1(response.result, second)).toThrow();
  });

  it("returns typed service_unavailable for valid execute, poll, and cancel requests", async () => {
    const execute = executeRequest();
    const requests = [
      ["execute", execute],
      ["poll", pollRequest(execute)],
      ["cancel", cancelRequest(execute)],
    ] as const;
    for (const [action, request] of requests) {
      const response = await router().route(frame(action, request));
      expect(response).toMatchObject({
        ok: false,
        action,
        error: { code: "service_unavailable" },
      });
      expect(response).not.toHaveProperty("result");
      expect(JSON.stringify(response)).not.toMatch(/accepted|success|output/);
    }
  });

  it("rejects missing and incorrect authentication before routing", async () => {
    const request = capabilityRequest("source_query");
    await expect(
      router().route(frame("capability", request, "wrong-token"))
    ).resolves.toMatchObject({
      ok: false,
      action: null,
      error: { code: "unauthorized" },
    });
    await expect(
      router().route({ protocol: SCA_SERVICE_IPC_PROTOCOL, action: "capability", request })
    ).resolves.toMatchObject({
      ok: false,
      action: null,
      error: { code: "unauthorized" },
    });
  });

  it("distinguishes malformed input from unsupported action or operation mappings", async () => {
    await expect(router().route(frame("capability", { operation: 7 }))).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    await expect(
      router().route(frame("unknown-action", capabilityRequest("source_query")))
    ).resolves.toMatchObject({ error: { code: "unsupported_operation" } });
    await expect(
      router().route(
        frame("execute", {
          ...executeRequest(),
          operation: "invented_operation",
        })
      )
    ).resolves.toMatchObject({
      action: "execute",
      error: { code: "unsupported_operation" },
    });
    await expect(
      router().route({
        ...frame("capability", capabilityRequest("source_query")),
        extra: true,
      })
    ).resolves.toMatchObject({ error: { code: "invalid_request" } });
  });
});
