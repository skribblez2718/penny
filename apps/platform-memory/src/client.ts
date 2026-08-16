import { randomUUID } from "node:crypto";

import {
  assertValidResolvedMemoryCredential,
  resolveMemoryCredentialReference,
  validatePlatformMemoryConfigV1,
} from "./config.js";
import {
  SAFE_PLATFORM_MEMORY_READ_OPERATIONS,
  assertPlatformMemoryOperationAllowed,
  validatePlatformMemoryOperationInput,
} from "./policy.js";
import {
  PLATFORM_MEMORY_CONTRACT_VERSION,
  PlatformMemoryError,
  type PlatformMemoryClientDependencies,
  type PlatformMemoryConfigV1,
  type PlatformMemoryOperation,
  type PlatformMemoryResultV1,
  type ValidatedPlatformMemoryConfigV1,
} from "./types.js";

const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);
const SUPPORTED_UPSTREAM_HTTP_ERROR_STATUS = new Set([
  400,
  401,
  403,
  404,
  409,
  413,
  422,
  ...RETRYABLE_HTTP_STATUS,
]);
const SUPPORTED_UPSTREAM_RPC_ERROR_CODE = new Set([
  -32700, -32600, -32601, -32602, -32001, -32002, -32003, -32004, -32005,
]);

const UPSTREAM_TOOL: Readonly<Record<PlatformMemoryOperation, string>> = Object.freeze({
  search: "mempalace_search",
  smart_search: "mempalace_search",
  get_drawer: "mempalace_get_drawer",
  list_drawers: "mempalace_list_drawers",
  get_taxonomy: "mempalace_get_taxonomy",
  check_duplicate: "mempalace_check_duplicate",
  add_drawer: "mempalace_add_drawer",
  diary_read: "mempalace_diary_read",
  diary_write: "mempalace_diary_write",
  kg_query: "mempalace_kg_query",
  kg_add: "mempalace_kg_add",
  kg_invalidate: "mempalace_kg_invalidate",
  kg_supersede: "mempalace_kg_supersede",
  kg_timeline: "mempalace_kg_timeline",
  kg_stats: "mempalace_kg_stats",
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PlatformMemoryError("MEMORY_CANCELLED", "memory request was cancelled"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new PlatformMemoryError("MEMORY_CANCELLED", "memory request was cancelled"));
      },
      { once: true }
    );
  });
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) {
      throw new PlatformMemoryError("MEMORY_INTEGRITY", "memory response exceeded its hard bound");
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PlatformMemoryError(
          "MEMORY_INTEGRITY",
          "memory response exceeded its hard bound"
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function errorForHttpStatus(status: number, requestId: string): PlatformMemoryError {
  if (status === 401 || status === 403) {
    return new PlatformMemoryError(
      "MEMORY_UNAUTHORIZED",
      "memory service rejected the configured credential",
      false,
      requestId
    );
  }
  if (status === 409) {
    return new PlatformMemoryError(
      "MEMORY_CONFLICT",
      "memory service reported an ownership or write conflict",
      false,
      requestId
    );
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new PlatformMemoryError(
      "MEMORY_INVALID_REQUEST",
      "memory service rejected the request",
      false,
      requestId
    );
  }
  return new PlatformMemoryError(
    "MEMORY_UNAVAILABLE",
    "memory service is unavailable",
    RETRYABLE_HTTP_STATUS.has(status),
    requestId
  );
}

function errorForRpc(code: number, requestId: string): PlatformMemoryError {
  if (code === -32600 || code === -32601 || code === -32602 || code === -32700) {
    return new PlatformMemoryError(
      "MEMORY_INVALID_REQUEST",
      "memory service rejected the JSON-RPC request",
      false,
      requestId
    );
  }
  if (code === -32001 || code === -32003 || code === -32005) {
    return new PlatformMemoryError(
      "MEMORY_CONFLICT",
      "memory service refused an operation because its state conflicts",
      false,
      requestId
    );
  }
  if (code === -32002 || code === -32004) {
    return new PlatformMemoryError(
      "MEMORY_INTEGRITY",
      "memory service reported an integrity failure",
      false,
      requestId
    );
  }
  return new PlatformMemoryError(
    "MEMORY_UNAVAILABLE",
    "memory service could not complete the operation",
    false,
    requestId
  );
}

function parseToolJson(text: string, requestId: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PlatformMemoryError(
      "MEMORY_INTEGRITY",
      "memory service returned malformed tool JSON",
      false,
      requestId
    );
  }
}

function errorForMcpToolResult(text: string, requestId: string): PlatformMemoryError {
  const payload = parseToolJson(text, requestId);
  const record = asRecord(payload);
  if (!record) {
    return new PlatformMemoryError(
      "MEMORY_INTEGRITY",
      "memory service returned malformed MCP tool error data",
      false,
      requestId
    );
  }

  const errorValue = record.error;
  if (errorValue === undefined) {
    return new PlatformMemoryError(
      "MEMORY_UNAVAILABLE",
      "memory service reported an unsupported tool error",
      false,
      requestId
    );
  }
  const error = asRecord(errorValue);
  if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") {
    return new PlatformMemoryError(
      "MEMORY_INTEGRITY",
      "memory service returned malformed MCP tool error data",
      false,
      requestId
    );
  }

  const code = error.code as number;
  if (SUPPORTED_UPSTREAM_HTTP_ERROR_STATUS.has(code)) return errorForHttpStatus(code, requestId);
  if (SUPPORTED_UPSTREAM_RPC_ERROR_CODE.has(code)) return errorForRpc(code, requestId);
  return new PlatformMemoryError(
    "MEMORY_UNAVAILABLE",
    "memory service reported an unsupported tool error",
    false,
    requestId
  );
}

function parseMcpResponse(raw: Buffer, expectedId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new PlatformMemoryError(
      "MEMORY_INTEGRITY",
      "memory service returned malformed JSON",
      false,
      expectedId
    );
  }
  const envelope = asRecord(parsed);
  if (!envelope || envelope.jsonrpc !== "2.0" || envelope.id !== expectedId) {
    throw new PlatformMemoryError(
      "MEMORY_INTEGRITY",
      "memory service returned a mismatched JSON-RPC envelope",
      false,
      expectedId
    );
  }

  if (envelope.error !== undefined) {
    const error = asRecord(envelope.error);
    if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") {
      throw new PlatformMemoryError(
        "MEMORY_INTEGRITY",
        "memory service returned a malformed JSON-RPC error",
        false,
        expectedId
      );
    }
    throw errorForRpc(error.code as number, expectedId);
  }

  const result = asRecord(envelope.result);
  if (!result || (result.isError !== undefined && typeof result.isError !== "boolean")) {
    throw new PlatformMemoryError(
      "MEMORY_INTEGRITY",
      "memory service returned a malformed MCP tool result",
      false,
      expectedId
    );
  }
  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1) {
    throw new PlatformMemoryError(
      "MEMORY_INTEGRITY",
      "memory service returned a malformed MCP tool result",
      false,
      expectedId
    );
  }
  const textPart = asRecord(content[0]);
  if (!textPart || textPart.type !== "text" || typeof textPart.text !== "string") {
    throw new PlatformMemoryError(
      "MEMORY_INTEGRITY",
      "memory service returned a non-text MCP tool result",
      false,
      expectedId
    );
  }

  if (result.isError === true) throw errorForMcpToolResult(textPart.text, expectedId);

  const record = asRecord(parseToolJson(textPart.text, expectedId));
  if (!record) {
    throw new PlatformMemoryError(
      "MEMORY_INTEGRITY",
      "memory service returned invalid tool data",
      false,
      expectedId
    );
  }
  return record;
}

function upstreamArguments(
  config: Exclude<ValidatedPlatformMemoryConfigV1, { mode: "none" }>,
  operation: PlatformMemoryOperation,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (operation !== "diary_read" && operation !== "diary_write") return input;
  if (!config.primaryDiaryId) {
    throw new PlatformMemoryError(
      "MEMORY_CONFIG_INVALID",
      "primary diary operation has no configured diary identity"
    );
  }
  return { ...input, agent_name: config.primaryDiaryId };
}

export class PlatformMemoryClientV1 {
  readonly config: ValidatedPlatformMemoryConfigV1;
  private readonly fetchImpl: typeof fetch;
  private readonly randomId: () => string;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly resolveCredential: () => string | Promise<string>;

  constructor(config: PlatformMemoryConfigV1, dependencies: PlatformMemoryClientDependencies = {}) {
    this.config = validatePlatformMemoryConfigV1(config);
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.randomId = dependencies.randomId ?? randomUUID;
    this.sleep = dependencies.sleep ?? safeSleep;
    this.resolveCredential = () => {
      if (this.config.mode === "none") {
        throw new PlatformMemoryError("MEMORY_DISABLED", "memory mode is none");
      }
      if (dependencies.credentialResolver) {
        return dependencies.credentialResolver(this.config.credential);
      }
      return resolveMemoryCredentialReference(this.config.credential, { env: dependencies.env });
    };
  }

  async invoke(
    operation: PlatformMemoryOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<PlatformMemoryResultV1> {
    assertPlatformMemoryOperationAllowed(this.config, operation);
    if (this.config.mode === "none") {
      throw new PlatformMemoryError("MEMORY_DISABLED", "memory mode is none");
    }
    const enabledConfig = this.config;
    const validatedInput = validatePlatformMemoryOperationInput(operation, input);
    const credential = assertValidResolvedMemoryCredential(await this.resolveCredential());
    const safeRead = SAFE_PLATFORM_MEMORY_READ_OPERATIONS.has(operation);
    const maximumAttempts = safeRead ? enabledConfig.transport.maxReadAttempts : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const result = await this.callOnce(
          enabledConfig,
          credential,
          operation,
          validatedInput,
          signal
        );
        return { ...result, attempts: attempt };
      } catch (error) {
        lastError = error;
        const typed = error instanceof PlatformMemoryError ? error : undefined;
        if (!safeRead) {
          if (typed?.retryable) {
            throw new PlatformMemoryError(typed.code, typed.message, false, typed.requestId);
          }
          throw error;
        }
        if (!typed?.retryable || attempt === maximumAttempts) throw error;
        await this.sleep(attempt === 1 ? 50 : 150, signal);
      }
    }
    throw lastError;
  }

  private async callOnce(
    config: Exclude<ValidatedPlatformMemoryConfigV1, { mode: "none" }>,
    credential: string,
    operation: PlatformMemoryOperation,
    input: Record<string, unknown>,
    callerSignal?: AbortSignal
  ): Promise<Omit<PlatformMemoryResultV1, "attempts">> {
    if (callerSignal?.aborted) {
      throw new PlatformMemoryError("MEMORY_CANCELLED", "memory request was cancelled");
    }

    const requestId = `platform-memory-${this.randomId()}`;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: UPSTREAM_TOOL[operation],
        arguments: upstreamArguments(config, operation, input),
      },
    });
    if (Buffer.byteLength(body, "utf8") > config.transport.maxRequestBytes) {
      throw new PlatformMemoryError(
        "MEMORY_INVALID_REQUEST",
        "memory request exceeds the transport bound",
        false,
        requestId
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.transport.requestTimeoutMs);
    timer.unref?.();

    try {
      const response = await this.fetchImpl(config.target.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
          "User-Agent": "platform-memory/1",
          "X-Platform-Memory-Contract": String(PLATFORM_MEMORY_CONTRACT_VERSION),
          "X-Platform-Memory-Palace": config.target.palaceId,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw errorForHttpStatus(response.status, requestId);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) {
        throw new PlatformMemoryError(
          "MEMORY_INTEGRITY",
          "memory service returned an unexpected content type",
          false,
          requestId
        );
      }
      const raw = await readBoundedResponse(response, config.transport.maxResponseBytes);
      return {
        contractVersion: PLATFORM_MEMORY_CONTRACT_VERSION,
        operation,
        requestId,
        palaceId: config.target.palaceId,
        data: parseMcpResponse(raw, requestId),
      };
    } catch (error) {
      if (callerSignal?.aborted) {
        throw new PlatformMemoryError(
          "MEMORY_CANCELLED",
          "memory request was cancelled",
          false,
          requestId
        );
      }
      if (timedOut) {
        throw new PlatformMemoryError(
          "MEMORY_TIMEOUT",
          "memory service request timed out",
          true,
          requestId
        );
      }
      if (error instanceof PlatformMemoryError) throw error;
      throw new PlatformMemoryError(
        "MEMORY_UNAVAILABLE",
        "memory service is unavailable",
        true,
        requestId
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
