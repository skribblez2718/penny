import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { canonicalJson, sha256 } from "../../../../apps/orchestration/dist/canonical-json.js";
import { registerTool } from "../../../lib/pi-tool-registration.js";
import { loadScaClientConfig, ScaClientConfigError, type ScaClientConfig } from "./config.js";
import { ScaClientError, ScaServiceClient, type ScaTerminalExecutionResult } from "./client.js";
import {
  SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2,
  SCA_EXTENSION_BROKER_MANIFEST_SHA256,
  SCA_MODEL_TOOL_ROSTER,
  SCA_TOOL_OPERATION_MAP,
  ScaBrokerExecuteRequestV1Schema,
  validateScaBrokerExecuteRequestV1,
  type ScaBrokerErrorCode,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerReceiptV1,
  type ScaBrokerToolName,
} from "./contracts.js";

export interface ScaToolSuccessDetails {
  readonly schema_version: 1;
  readonly status: "succeeded";
  readonly tool_name: ScaBrokerToolName;
  readonly manifest_sha256: typeof SCA_EXTENSION_BROKER_MANIFEST_SHA256;
  readonly request_sha256: string;
  readonly receipt: ScaBrokerReceiptV1;
}

export interface ScaToolFailureDetails {
  readonly schema_version: 1;
  readonly status: "failed";
  readonly completion: "failed" | "incomplete";
  readonly tool_name: ScaBrokerToolName;
  readonly manifest_sha256: typeof SCA_EXTENSION_BROKER_MANIFEST_SHA256;
  readonly error: {
    readonly schema_version: 1;
    readonly code: ScaBrokerErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly receipt?: ScaBrokerReceiptV1;
}

export type ScaToolResultDetails = ScaToolSuccessDetails | ScaToolFailureDetails;

export interface ScaToolClient {
  executeToTerminal(
    request: ScaBrokerExecuteRequestV1,
    options: { readonly signal?: AbortSignal }
  ): Promise<ScaTerminalExecutionResult>;
}

export interface RegisterScaToolsOptions {
  readonly environment?: () => NodeJS.ProcessEnv;
  readonly createClient?: (config: ScaClientConfig) => ScaToolClient;
}

const executeRequestDigest = SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2.schema_digests.find(
  (entry) => entry.export_name === "ScaBrokerExecuteRequestV1Schema"
);
if (executeRequestDigest === undefined) {
  throw new Error("SCA broker manifest is missing the execute request schema digest");
}

export const SCA_PROVIDER_REGISTRATION_V1 = Object.freeze({
  schema_version: 1,
  broker_manifest_sha256: SCA_EXTENSION_BROKER_MANIFEST_SHA256,
  tools: Object.freeze(
    SCA_MODEL_TOOL_ROSTER.map((toolName) =>
      Object.freeze({
        tool_name: toolName,
        operation: SCA_TOOL_OPERATION_MAP[toolName],
        parameters_sha256: executeRequestDigest.sha256,
      })
    )
  ),
});

const computedProviderRegistrationSha256 = sha256(canonicalJson(SCA_PROVIDER_REGISTRATION_V1));
export const SCA_PROVIDER_REGISTRATION_SHA256 =
  "902e47178d9f25d0c5784efc907c47440bff1172ea4f65c9dac3c5df7a60f4a7" as const;
if (computedProviderRegistrationSha256 !== SCA_PROVIDER_REGISTRATION_SHA256) {
  throw new Error("SCA provider registration digest does not match its frozen preimage");
}

const TOOL_LABELS: Readonly<Record<ScaBrokerToolName, string>> = {
  sca_source_query: "SCA Source Query",
  sca_graph_query: "SCA Graph Query",
  sca_application_test: "SCA Application Test",
};

const TOOL_DESCRIPTIONS: Readonly<Record<ScaBrokerToolName, string>> = {
  sca_source_query:
    "Submit one bounded, repository-relative source query through the SCA broker. Use when an admitted SCA request needs exact source evidence. Do not use for graph traversal, application testing, arbitrary filesystem access, or requests without approved limits. Returns a validated terminal receipt; unavailable or incomplete work is an error.",
  sca_graph_query:
    "Submit one bounded graph query through the SCA broker using an exact graph artifact reference. Use when an admitted SCA request needs graph evidence. Do not use for source reads, application testing, arbitrary paths, or database credentials. Returns a validated terminal receipt; unavailable or incomplete work is an error.",
  sca_application_test:
    "Submit one predeclared application test through the SCA broker with exact execution-plan and policy artifact references. Use only for admitted, policy-approved SCA checks. Do not use for shell commands, container controls, network configuration, mounts, images, or credentials. Returns a validated terminal receipt; unavailable or incomplete work is an error.",
};

function retryable(code: ScaBrokerErrorCode): boolean {
  return code === "service_unavailable" || code === "quota_exceeded" || code === "timeout";
}

function publicMessage(code: ScaBrokerErrorCode): string {
  switch (code) {
    case "service_unavailable":
      return "SCA service is unavailable";
    case "unsupported_operation":
      return "SCA operation is unsupported";
    case "invalid_request":
      return "SCA request is invalid";
    case "unauthorized":
      return "SCA service authorization failed";
    case "conflict":
      return "SCA request conflicts with an existing operation";
    case "quota_exceeded":
      return "SCA request exceeded a configured resource limit";
    case "cancelled":
      return "SCA operation was cancelled";
    case "timeout":
      return "SCA operation or transport became inactive before reaching a terminal result";
    case "output_truncated":
      return "SCA operation returned only bounded partial output";
    case "failed":
      return "SCA operation failed";
  }
}

function failedDetails(
  toolName: ScaBrokerToolName,
  code: ScaBrokerErrorCode,
  completion: "failed" | "incomplete",
  receipt?: ScaBrokerReceiptV1
): ScaToolFailureDetails {
  return {
    schema_version: 1,
    status: "failed",
    completion,
    tool_name: toolName,
    manifest_sha256: SCA_EXTENSION_BROKER_MANIFEST_SHA256,
    error: {
      schema_version: 1,
      code,
      message: publicMessage(code),
      retryable: retryable(code),
    },
    ...(receipt === undefined ? {} : { receipt }),
  };
}

function errorResult(details: ScaToolFailureDetails) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
    isError: true,
  };
}

function successResult(details: ScaToolSuccessDetails) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function clientErrorFor(error: unknown): ScaClientError {
  if (error instanceof ScaClientError) return error;
  if (error instanceof ScaClientConfigError) {
    return new ScaClientError("service_unavailable", "failed");
  }
  return new ScaClientError("failed", "failed");
}

export function registerScaTools(pi: ExtensionAPI, options: RegisterScaToolsOptions = {}): void {
  const environment = options.environment ?? (() => process.env);
  const createClient =
    options.createClient ?? ((config: ScaClientConfig) => new ScaServiceClient(config));

  for (const toolName of SCA_MODEL_TOOL_ROSTER) {
    registerTool<typeof ScaBrokerExecuteRequestV1Schema, ScaToolResultDetails>(pi, {
      name: toolName,
      label: TOOL_LABELS[toolName],
      description: TOOL_DESCRIPTIONS[toolName],
      parameters: ScaBrokerExecuteRequestV1Schema,
      async execute(_toolCallId, params, signal) {
        let request: ScaBrokerExecuteRequestV1;
        try {
          request = validateScaBrokerExecuteRequestV1(params);
        } catch {
          return errorResult(failedDetails(toolName, "invalid_request", "failed"));
        }
        const expectedOperation = SCA_TOOL_OPERATION_MAP[toolName];
        if (
          request.tool_name !== toolName ||
          request.operation !== expectedOperation ||
          request.operation_input.kind !== expectedOperation
        ) {
          return errorResult(failedDetails(toolName, "invalid_request", "failed"));
        }

        try {
          const config = loadScaClientConfig(environment());
          const callOptions = signal === undefined ? {} : { signal };
          const result = await createClient(config).executeToTerminal(request, callOptions);
          return successResult({
            schema_version: 1,
            status: "succeeded",
            tool_name: toolName,
            manifest_sha256: SCA_EXTENSION_BROKER_MANIFEST_SHA256,
            request_sha256: result.requestSha256,
            receipt: result.receipt,
          });
        } catch (error) {
          const clientError = clientErrorFor(error);
          return errorResult(
            failedDetails(toolName, clientError.code, clientError.completion, clientError.receipt)
          );
        }
      },
    });
  }
}
