import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { canonicalJson, sha256 } from "../../../../../apps/orchestration/dist/canonical-json.js";
import type { CurrentArtifactRef } from "../../../../../apps/orchestration/dist/contracts.js";
import scaExtension from "../../index.js";
import { ScaClientError } from "../../src/client.js";
import {
  SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2,
  SCA_BROKER_SCHEMA_MANIFEST_SHA256,
  SCA_EXTENSION_BROKER_MANIFEST_SHA256,
  SCA_MODEL_TOOL_ROSTER,
  ScaBrokerExecuteRequestV1Schema,
  scaBrokerSchemaSha256,
  validateScaBrokerExecuteRequestV1,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerOperationKind,
  type ScaBrokerToolName,
} from "../../src/contracts.js";
import {
  SCA_PROVIDER_REGISTRATION_SHA256,
  SCA_PROVIDER_REGISTRATION_V1,
  registerScaTools,
} from "../../src/tools.js";

const TOKEN = "unit-registration-token-0000000000000000";
const RUN_ID = "run-sca-registration-001";

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
    producer: "sca-extension-fixture",
    media_type: "application/json",
    byte_length: 128,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

function executeRequest(
  toolName: ScaBrokerToolName,
  operation: ScaBrokerOperationKind
): ScaBrokerExecuteRequestV1 {
  const submittedAt = new Date();
  const common = {
    schema_id: "penny.sca-broker-execute-request.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: RUN_ID,
    job_id: `job-${operation}`,
    attempt: 1,
    idempotency_key: `idempotency-${operation}`,
    tool_name: toolName,
    operation,
    submitted_at: submittedAt.toISOString(),
    deadline_at: new Date(submittedAt.getTime() + 30_000).toISOString(),
    limits: { timeout_ms: 5_000, max_output_bytes: 16_384, max_result_items: 50 },
    source_snapshot_ref: artifactRef("source-snapshot", `snapshot-${operation}`),
    config_ref: artifactRef("sca-config", `config-${operation}`),
    input_refs: [],
  };
  switch (operation) {
    case "source_query":
      return validateScaBrokerExecuteRequestV1({
        ...common,
        operation_input: {
          kind: "source_query",
          query_id: "query-source-1",
          selectors: [{ path: "src/example.ts", line_range: null, symbol: "Example" }],
          parameters: [],
        },
      });
    case "graph_query": {
      const graphRef = artifactRef("sca-graph", "graph-query-1");
      return validateScaBrokerExecuteRequestV1({
        ...common,
        input_refs: [graphRef],
        operation_input: {
          kind: "graph_query",
          graph_ref: graphRef,
          query_id: "query-graph-1",
          selectors: [{ path: "src/example.ts", line_range: null, symbol: "Example" }],
          parameters: [],
        },
      });
    }
    case "application_test": {
      const executionPlanRef = artifactRef("sca-execution-plan", "application-plan-1");
      const policyRef = artifactRef("sca-execution-policy", "application-policy-1");
      const inputRefs = [executionPlanRef, policyRef].sort((left, right) =>
        left.artifact_id.localeCompare(right.artifact_id)
      );
      return validateScaBrokerExecuteRequestV1({
        ...common,
        input_refs: inputRefs,
        operation_input: {
          kind: "application_test",
          execution_plan_ref: executionPlanRef,
          policy_ref: policyRef,
        },
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolDetails(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value["details"])) throw new Error("tool details missing");
  return value["details"];
}

interface CapturedTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
}

function isCapturedTool(value: unknown): value is CapturedTool {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["label"] === "string" &&
    typeof value["description"] === "string" &&
    value["parameters"] !== undefined &&
    typeof value["execute"] === "function"
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

const MAPPINGS = [
  ["sca_source_query", "source_query"],
  ["sca_graph_query", "graph_query"],
  ["sca_application_test", "application_test"],
] as const;

describe("SCA tool registration", () => {
  it("registers exactly the frozen provider-first roster with the canonical schema and digest", () => {
    const tools = captureTools(scaExtension);

    expect(tools.map((tool) => tool.name)).toEqual([...SCA_MODEL_TOOL_ROSTER]);
    expect(tools).toHaveLength(3);
    expect(SCA_EXTENSION_BROKER_MANIFEST_SHA256).toBe(SCA_BROKER_SCHEMA_MANIFEST_SHA256);
    expect(SCA_PROVIDER_REGISTRATION_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(SCA_PROVIDER_REGISTRATION_V1.tools.map((entry) => entry.tool_name)).toEqual([
      ...SCA_MODEL_TOOL_ROSTER,
    ]);
    const executeDigest = SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2.schema_digests.find(
      (entry) => entry.export_name === "ScaBrokerExecuteRequestV1Schema"
    );
    if (executeDigest === undefined) throw new Error("execute schema digest missing");

    for (const tool of tools) {
      expect(tool.parameters).toBe(ScaBrokerExecuteRequestV1Schema);
      expect(scaBrokerSchemaSha256(ScaBrokerExecuteRequestV1Schema)).toBe(executeDigest.sha256);
      expect(
        SCA_PROVIDER_REGISTRATION_V1.tools.find((entry) => entry.tool_name === tool.name)
      ).toMatchObject({ parameters_sha256: executeDigest.sha256 });
      expect(tool.description).toMatch(/Use |Use only /);
      expect(tool.description).toMatch(/Do not use/);
      expect(tool.description).toMatch(/Returns/);
    }
  });

  it("does not read configuration or create an IPC client during import or registration", () => {
    const environment = vi.fn((): NodeJS.ProcessEnv => {
      throw new Error("configuration must not be read during registration");
    });
    const createClient = vi.fn(() => {
      throw new Error("client must not be created during registration");
    });

    let tools: CapturedTool[] = [];
    expect(() => {
      tools = captureTools((pi) => registerScaTools(pi, { environment, createClient }));
    }).not.toThrow();
    expect(environment).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(tools).toHaveLength(3);
  });

  it("exposes no socket, token, host, shell, mount, image, network, or credential controls", () => {
    const serialized = JSON.stringify(ScaBrokerExecuteRequestV1Schema);
    for (const forbidden of [
      "socket",
      "token",
      "host",
      "shell",
      "command",
      "mount",
      "image",
      "network",
      "credential",
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    expect(serialized).toContain("source_snapshot_ref");
    expect(serialized).toContain("operation_input");
  });

  it("enforces every exact tool-to-operation mapping before broker execution", async () => {
    const seen: ScaBrokerExecuteRequestV1[] = [];
    const tools = captureTools((pi) =>
      registerScaTools(pi, {
        environment: () => ({
          PENNY_SCA_SERVICE_SOCKET_PATH: "/tmp/penny-sca-registration.sock",
          PENNY_SCA_SERVICE_TOKEN: TOKEN,
        }),
        createClient: () => ({
          async executeToTerminal(request) {
            seen.push(request);
            throw new ScaClientError("service_unavailable", "failed");
          },
        }),
      })
    );

    for (const [toolName, operation] of MAPPINGS) {
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (tool === undefined) throw new Error(`missing tool ${toolName}`);
      const result = await tool.execute("call-correct", executeRequest(toolName, operation));
      expect(toolDetails(result)).toMatchObject({
        status: "failed",
        tool_name: toolName,
        error: { code: "service_unavailable" },
      });
    }
    expect(seen.map((request) => [request.tool_name, request.operation])).toEqual(MAPPINGS);

    const graphTool = tools.find((tool) => tool.name === "sca_graph_query");
    if (graphTool === undefined) throw new Error("missing graph tool");
    const wrongResult = await graphTool.execute(
      "call-wrong",
      executeRequest("sca_source_query", "source_query")
    );
    expect(toolDetails(wrongResult)).toMatchObject({
      status: "failed",
      completion: "failed",
      error: { code: "invalid_request" },
    });
    expect(seen).toHaveLength(3);
  });
});
