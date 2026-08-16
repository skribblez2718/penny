import { randomUUID } from "node:crypto";

import { MemoryError, type MemoryClientDependencies, type MemoryRuntimeConfig } from "./types.js";

export type LogstreamUpstreamOperation = "append" | "list" | "wait" | "ack";

export interface LogstreamCallResult {
  requestId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const UPSTREAM_TOOL: Readonly<Record<LogstreamUpstreamOperation, string>> = Object.freeze({
  append: "mempalace_event_append",
  list: "mempalace_event_list",
  wait: "mempalace_event_wait",
  ack: "mempalace_event_ack",
});
const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);
const MAX_LOGSTREAM_REQUEST_BYTES = 64 * 1024;
const MAX_LOGSTREAM_RESPONSE_BYTES = 512 * 1024;
const MAX_LOGSTREAM_HTTP_TIMEOUT_MS = 6_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MemoryError("MEMPALACE_CANCELLED", "Memory request was cancelled"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new MemoryError("MEMPALACE_CANCELLED", "Memory request was cancelled"));
      },
      { once: true }
    );
  });
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) {
      throw new MemoryError("MEMPALACE_INTEGRITY", "Logstream response exceeded its hard bound");
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
        throw new MemoryError("MEMPALACE_INTEGRITY", "Logstream response exceeded its hard bound");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function errorForHttpStatus(status: number, requestId: string): MemoryError {
  if (status === 401 || status === 403) {
    return new MemoryError(
      "MEMPALACE_UNAUTHORIZED",
      "Memory hub rejected the configured credential",
      false,
      requestId
    );
  }
  if (status === 409) {
    return new MemoryError(
      "MEMPALACE_CONFLICT",
      "Memory hub reported an advisory-log conflict",
      false,
      requestId
    );
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new MemoryError(
      "MEMPALACE_INVALID",
      "Memory hub rejected the advisory-log request",
      false,
      requestId
    );
  }
  return new MemoryError(
    "MEMPALACE_UNAVAILABLE",
    "Memory hub is unavailable",
    RETRYABLE_HTTP_STATUS.has(status),
    requestId
  );
}

function errorForRpc(code: number, requestId: string): MemoryError {
  if (code === -32700 || code === -32600 || code === -32601 || code === -32602) {
    return new MemoryError(
      "MEMPALACE_INVALID",
      "Memory hub rejected the advisory-log RPC request",
      false,
      requestId
    );
  }
  if (code === -32001 || code === -32003 || code === -32005) {
    return new MemoryError(
      "MEMPALACE_CONFLICT",
      "Memory hub refused the advisory-log operation because its state conflicts",
      false,
      requestId
    );
  }
  if (code === -32002 || code === -32004) {
    return new MemoryError(
      "MEMPALACE_INTEGRITY",
      "Memory hub reported an advisory-log integrity failure",
      false,
      requestId
    );
  }
  return new MemoryError(
    "MEMPALACE_UNAVAILABLE",
    "Memory hub could not complete the advisory-log operation",
    false,
    requestId
  );
}

function parseJson(value: string, requestId: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new MemoryError(
      "MEMPALACE_INTEGRITY",
      `${label} returned malformed JSON`,
      false,
      requestId
    );
  }
}

function errorForMcpToolResult(text: string, requestId: string): MemoryError {
  const payload = asRecord(parseJson(text, requestId, "Memory hub"));
  const error = payload ? asRecord(payload.error) : undefined;
  if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") {
    return new MemoryError(
      "MEMPALACE_UNAVAILABLE",
      "Memory hub returned an unsupported advisory-log tool error",
      false,
      requestId
    );
  }
  const code = error.code as number;
  if ([400, 401, 403, 404, 409, 413, 422, 429, 502, 503, 504].includes(code)) {
    return errorForHttpStatus(code, requestId);
  }
  return errorForRpc(code, requestId);
}

function parseMcpResponse(
  raw: Buffer,
  expectedId: string,
  operation: LogstreamUpstreamOperation
): Record<string, unknown> {
  const envelope = asRecord(parseJson(raw.toString("utf8"), expectedId, "Memory hub"));
  if (!envelope || envelope.jsonrpc !== "2.0" || envelope.id !== expectedId) {
    throw new MemoryError(
      "MEMPALACE_INTEGRITY",
      "Memory hub returned a mismatched advisory-log RPC envelope",
      false,
      expectedId
    );
  }
  if (envelope.error !== undefined) {
    const error = asRecord(envelope.error);
    if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") {
      throw new MemoryError(
        "MEMPALACE_INTEGRITY",
        "Memory hub returned a malformed advisory-log RPC error",
        false,
        expectedId
      );
    }
    throw errorForRpc(error.code as number, expectedId);
  }

  const result = asRecord(envelope.result);
  if (!result || (result.isError !== undefined && typeof result.isError !== "boolean")) {
    throw new MemoryError(
      "MEMPALACE_INTEGRITY",
      "Memory hub returned a malformed advisory-log MCP result",
      false,
      expectedId
    );
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    throw new MemoryError(
      "MEMPALACE_INTEGRITY",
      "Memory hub returned a malformed advisory-log MCP result",
      false,
      expectedId
    );
  }
  const part = asRecord(result.content[0]);
  if (!part || part.type !== "text" || typeof part.text !== "string") {
    throw new MemoryError(
      "MEMPALACE_INTEGRITY",
      "Memory hub returned a non-text advisory-log MCP result",
      false,
      expectedId
    );
  }
  if (result.isError === true) throw errorForMcpToolResult(part.text, expectedId);

  const payload = asRecord(parseJson(part.text, expectedId, "Memory hub advisory-log tool"));
  if (!payload) {
    throw new MemoryError(
      "MEMPALACE_INTEGRITY",
      "Memory hub returned invalid advisory-log tool data",
      false,
      expectedId
    );
  }
  if (payload.success !== undefined && typeof payload.success !== "boolean") {
    throw new MemoryError(
      "MEMPALACE_INTEGRITY",
      "Memory hub returned an invalid advisory-log success flag",
      false,
      expectedId
    );
  }
  if (payload.success === false || typeof payload.error === "string") {
    throw new MemoryError(
      "MEMPALACE_INVALID",
      "Memory hub rejected the advisory-log operation",
      false,
      expectedId
    );
  }
  if ((operation === "append" || operation === "ack") && payload.success !== true) {
    throw new MemoryError(
      "MEMPALACE_INTEGRITY",
      "Memory hub did not prove advisory-log write success",
      false,
      expectedId
    );
  }
  return payload;
}

function timeoutFor(
  config: MemoryRuntimeConfig,
  operation: LogstreamUpstreamOperation,
  arguments_: Record<string, unknown>
): number {
  const configured =
    config.platformConfig.mode === "none"
      ? MAX_LOGSTREAM_HTTP_TIMEOUT_MS
      : (config.platformConfig.transport?.requestTimeoutMs ?? MAX_LOGSTREAM_HTTP_TIMEOUT_MS);
  const operationBound =
    operation === "wait" && typeof arguments_.timeout_ms === "number"
      ? Math.min(MAX_LOGSTREAM_HTTP_TIMEOUT_MS, arguments_.timeout_ms + 1_000)
      : 5_000;
  return Math.max(100, Math.min(configured, operationBound));
}

export class MemoryLogstreamClient {
  private readonly fetchImpl: typeof fetch;
  private readonly randomId: () => string;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly config: MemoryRuntimeConfig,
    dependencies: MemoryClientDependencies = {}
  ) {
    if (
      config.mode !== "hub" ||
      config.logstream.mode !== "primary-advisory" ||
      config.platformConfig.mode === "none"
    ) {
      throw new MemoryError(
        "MEMPALACE_INVALID",
        "Primary advisory logstream client requires enabled hub configuration"
      );
    }
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.randomId = dependencies.randomId ?? randomUUID;
    this.sleep = dependencies.sleep ?? safeSleep;
  }

  async call(
    operation: LogstreamUpstreamOperation,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
    options: { allowReadRetry?: boolean } = {}
  ): Promise<LogstreamCallResult> {
    const configuredAttempts =
      this.config.platformConfig.mode === "none"
        ? 1
        : (this.config.platformConfig.transport?.maxReadAttempts ?? 1);
    const maximumAttempts =
      operation === "list" && options.allowReadRetry === true ? Math.min(configuredAttempts, 2) : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const result = await this.callOnce(operation, arguments_, signal);
        return { ...result, attempts: attempt };
      } catch (error) {
        lastError = error;
        const typed = error instanceof MemoryError ? error : undefined;
        if (operation === "append" || operation === "ack") {
          if (typed?.retryable) {
            throw new MemoryError(typed.code, typed.message, false, typed.requestId);
          }
          throw error;
        }
        if (!typed?.retryable || attempt === maximumAttempts) throw error;
        await this.sleep(50, signal);
      }
    }
    throw lastError;
  }

  private async callOnce(
    operation: LogstreamUpstreamOperation,
    arguments_: Record<string, unknown>,
    callerSignal?: AbortSignal
  ): Promise<Omit<LogstreamCallResult, "attempts">> {
    if (callerSignal?.aborted) {
      throw new MemoryError("MEMPALACE_CANCELLED", "Memory request was cancelled");
    }
    if (this.config.platformConfig.mode === "none") {
      throw new MemoryError("MEMPALACE_INVALID", "Memory hub is disabled");
    }

    const requestId = `penny-memory-logstream-${this.randomId()}`;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name: UPSTREAM_TOOL[operation], arguments: arguments_ },
    });
    if (Buffer.byteLength(body, "utf8") > MAX_LOGSTREAM_REQUEST_BYTES) {
      throw new MemoryError(
        "MEMPALACE_INVALID",
        "Advisory-log request exceeded its hard bound",
        false,
        requestId
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      timeoutFor(this.config, operation, arguments_)
    );
    timer.unref?.();

    try {
      const response = await this.fetchImpl(this.config.platformConfig.target.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.bearerToken}`,
          "Content-Type": "application/json",
          "User-Agent": "penny-memory-logstream/1",
          "X-Platform-Memory-Palace": this.config.platformConfig.target.palaceId,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw errorForHttpStatus(response.status, requestId);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) {
        throw new MemoryError(
          "MEMPALACE_INTEGRITY",
          "Memory hub returned an unexpected advisory-log content type",
          false,
          requestId
        );
      }
      const maximumResponseBytes = Math.min(
        this.config.platformConfig.transport?.maxResponseBytes ?? MAX_LOGSTREAM_RESPONSE_BYTES,
        MAX_LOGSTREAM_RESPONSE_BYTES
      );
      const raw = await readBoundedResponse(response, maximumResponseBytes);
      return { requestId, payload: parseMcpResponse(raw, requestId, operation) };
    } catch (error) {
      if (callerSignal?.aborted) {
        throw new MemoryError(
          "MEMPALACE_CANCELLED",
          "Memory request was cancelled",
          false,
          requestId
        );
      }
      if (timedOut) {
        throw new MemoryError(
          "MEMPALACE_TIMEOUT",
          "Memory hub advisory-log request timed out",
          true,
          requestId
        );
      }
      if (error instanceof MemoryError) throw error;
      throw new MemoryError("MEMPALACE_UNAVAILABLE", "Memory hub is unavailable", true, requestId);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
