import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestExtensionApi } from "../../../../lib/tests/test-narrowers.js";
import { canonicalJson, sha256 } from "../../../../../apps/orchestration/src/canonical-json.js";
import type { CurrentArtifactRef } from "../../../../../apps/orchestration/src/contracts.js";
import {
  startScaService,
  type ScaServiceHandle,
} from "../../../../../apps/sca-service/src/server.js";
import scaExtension from "../../index.js";
import {
  SCA_CLIENT_MAX_RESPONSE_BYTES_ENV,
  SCA_SERVICE_SOCKET_ENV,
  SCA_SERVICE_TOKEN_ENV,
} from "../../src/config.js";
import { SCA_MODEL_TOOL_ROSTER, validateScaBrokerExecuteRequestV1 } from "../../src/contracts.js";

const TOKEN = "startup-unavailable-token-00000000000000";
const RUN_ID = "run-sca-startup-001";
const roots = new Set<string>();
const services = new Set<ScaServiceHandle>();

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
    producer: "sca-startup-fixture",
    media_type: "application/json",
    byte_length: 128,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

function executeRequest() {
  const submittedAt = new Date();
  return validateScaBrokerExecuteRequestV1({
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
    limits: { timeout_ms: 5_000, max_output_bytes: 16_384, max_result_items: 50 },
    source_snapshot_ref: artifactRef("source-snapshot", "snapshot-source-query"),
    config_ref: artifactRef("sca-config", "config-source-query"),
    input_refs: [],
    operation_input: {
      kind: "source_query",
      query_id: "query-source-1",
      selectors: [{ path: "src/example.ts", line_range: null, symbol: "Example" }],
      parameters: [],
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailsOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value["details"])) throw new Error("tool details missing");
  return value["details"];
}

interface CapturedTool {
  readonly name: string;
  execute(toolCallId: string, params: unknown): Promise<unknown>;
}

function isCapturedTool(value: unknown): value is CapturedTool {
  return (
    isRecord(value) && typeof value["name"] === "string" && typeof value["execute"] === "function"
  );
}

function captureTools(register: (pi: ExtensionAPI) => void): CapturedTool[] {
  const tools: CapturedTool[] = [];
  const pi = createTestExtensionApi({
    onRegisterTool(value) {
      if (!isCapturedTool(value)) throw new Error("SCA registered an invalid tool");
      tools.push(value);
    },
  });
  register(pi);
  return tools;
}

async function callSourceTool() {
  const tools = captureTools(scaExtension);
  const tool = tools.find((candidate) => candidate.name === "sca_source_query");
  if (tool === undefined) throw new Error("source tool missing");
  return {
    registeredNames: tools.map((candidate) => candidate.name),
    result: await tool.execute("startup-call", executeRequest()),
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const service of services) await service.shutdown();
  services.clear();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("SCA extension startup while the service is unavailable", () => {
  it("loads and registers all facades without reading missing service configuration", async () => {
    vi.stubEnv(SCA_SERVICE_SOCKET_ENV, undefined);
    vi.stubEnv(SCA_SERVICE_TOKEN_ENV, undefined);

    const tools = captureTools(scaExtension);
    expect(tools.map((tool) => tool.name)).toEqual([...SCA_MODEL_TOOL_ROSTER]);

    const tool = tools.find((candidate) => candidate.name === "sca_source_query");
    if (tool === undefined) throw new Error("source tool missing");
    const result = await tool.execute("missing-config-call", executeRequest());
    expect(detailsOf(result)).toMatchObject({
      status: "failed",
      completion: "failed",
      error: { code: "service_unavailable" },
    });
    expect(result).toHaveProperty("isError", true);
  });

  it("returns typed unavailable from the accepted S-03-T2 router without reporting fake success", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "penny-sca-router-unavailable-"));
    roots.add(root);
    const socketPath = path.join(root, "service.sock");
    const service = await startScaService({
      socketPath,
      authenticationToken: TOKEN,
      requestTimeoutMs: 500,
      shutdownTimeoutMs: 250,
    });
    services.add(service);
    vi.stubEnv(SCA_SERVICE_SOCKET_ENV, socketPath);
    vi.stubEnv(SCA_SERVICE_TOKEN_ENV, TOKEN);

    const { result } = await callSourceTool();
    expect(detailsOf(result)).toMatchObject({
      status: "failed",
      completion: "failed",
      error: { code: "service_unavailable" },
    });
    expect(result).toHaveProperty("isError", true);
    expect(JSON.stringify(result)).not.toMatch(/"status":"succeeded"/);
    await vi.waitFor(() => expect(service.activeConnections()).toBe(0));
  });

  it("returns typed unavailable for a refused Unix-socket connection without leaking connection data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "penny-sca-unavailable-"));
    roots.add(root);
    const socketPath = path.join(root, "absent.sock");
    vi.stubEnv(SCA_SERVICE_SOCKET_ENV, socketPath);
    vi.stubEnv(SCA_SERVICE_TOKEN_ENV, TOKEN);

    const { registeredNames, result } = await callSourceTool();
    expect(registeredNames).toEqual([...SCA_MODEL_TOOL_ROSTER]);
    expect(detailsOf(result)).toMatchObject({
      status: "failed",
      error: { code: "service_unavailable" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(socketPath);
    expect(serialized).not.toContain(TOKEN);
  });

  it.each([
    ["relative socket path", "relative/service.sock", TOKEN, undefined],
    ["short token", "/tmp/penny-sca-malformed.sock", "short", undefined],
    ["invalid response bound", "/tmp/penny-sca-malformed.sock", TOKEN, "not-an-integer"],
  ])(
    "refuses malformed call-time configuration: %s",
    async (_label, socket, token, responseBound) => {
      vi.stubEnv(SCA_SERVICE_SOCKET_ENV, socket);
      vi.stubEnv(SCA_SERVICE_TOKEN_ENV, token);
      vi.stubEnv(SCA_CLIENT_MAX_RESPONSE_BYTES_ENV, responseBound);

      const { result } = await callSourceTool();
      expect(detailsOf(result)).toMatchObject({
        status: "failed",
        completion: "failed",
        error: { code: "service_unavailable" },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(socket);
      expect(serialized).not.toContain(token);
    }
  );
});
