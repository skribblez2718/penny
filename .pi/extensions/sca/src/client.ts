import { createConnection, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

import type { ScaClientConfig } from "./config.js";
import {
  SCA_BROKER_CONTRACT_LIMITS_V1,
  ScaBrokerContractError,
  classifyScaBrokerJobProgressV1,
  scaBrokerExecuteRequestSha256,
  validateScaBrokerCancelRequestV1,
  validateScaBrokerCancelResultV1,
  validateScaBrokerCapabilityRequestV1,
  validateScaBrokerCapabilityResultV1,
  validateScaBrokerExecuteAcceptedResult,
  validateScaBrokerExecuteRequestV1,
  validateScaBrokerPollRequestV1,
  validateScaBrokerPollResult,
  validateScaBrokerReceiptV1,
  validateScaBrokerTypedErrorV1,
  type ScaBrokerCancelRequestV1,
  type ScaBrokerCancelResultV1,
  type ScaBrokerCapabilityRequestV1,
  type ScaBrokerCapabilityResultV1,
  type ScaBrokerErrorCode,
  type ScaBrokerExecuteAcceptedResult,
  type ScaBrokerJobProgressV1,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerPollRequestV1,
  type ScaBrokerPollResult,
  type ScaBrokerReceiptV1,
} from "./contracts.js";

export const SCA_SERVICE_IPC_PROTOCOL = "penny.sca-service-ipc.v1" as const;

type ScaServiceAction = "capability" | "execute" | "poll" | "cancel";

export interface ScaClientCallOptions {
  readonly signal?: AbortSignal;
}

export interface ScaClientRuntime {
  readonly monotonicNow: () => number;
}

export interface ScaTerminalExecutionResult {
  readonly requestSha256: string;
  readonly receipt: ScaBrokerReceiptV1;
}

export type ScaClientCompletion = "failed" | "incomplete";

export class ScaClientError extends Error {
  constructor(
    readonly code: ScaBrokerErrorCode,
    readonly completion: ScaClientCompletion,
    readonly receipt?: ScaBrokerReceiptV1
  ) {
    super(publicMessageForCode(code));
    this.name = "ScaClientError";
  }

  withCompletion(completion: ScaClientCompletion): ScaClientError {
    return new ScaClientError(this.code, completion, this.receipt);
  }
}

function publicMessageForCode(code: ScaBrokerErrorCode): string {
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
      return "SCA operation or transport became inactive";
    case "output_truncated":
      return "SCA operation returned only bounded partial output";
    case "failed":
      return "SCA operation failed";
  }
}

function normalizeClientError(error: unknown): ScaClientError {
  if (error instanceof ScaClientError) {
    return error;
  }
  if (error instanceof ScaBrokerContractError) {
    return new ScaClientError("invalid_request", "failed");
  }
  return new ScaClientError("service_unavailable", "failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseResponseEnvelope<TResult>(
  text: string,
  action: ScaServiceAction,
  validateResult: (value: unknown) => TResult
): TResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ScaClientError("failed", "failed");
  }
  if (!isRecord(parsed) || parsed["protocol"] !== SCA_SERVICE_IPC_PROTOCOL) {
    throw new ScaClientError("failed", "failed");
  }
  if (parsed["ok"] === false) {
    if (
      !hasExactKeys(parsed, ["protocol", "ok", "action", "error"]) ||
      (parsed["action"] !== action && parsed["action"] !== null)
    ) {
      throw new ScaClientError("failed", "failed");
    }
    try {
      const protocolError = validateScaBrokerTypedErrorV1(parsed["error"]);
      throw new ScaClientError(protocolError.code, "failed");
    } catch (error) {
      if (error instanceof ScaClientError) {
        throw error;
      }
      throw new ScaClientError("failed", "failed");
    }
  }
  if (
    parsed["ok"] !== true ||
    parsed["action"] !== action ||
    !hasExactKeys(parsed, ["protocol", "ok", "action", "result"])
  ) {
    throw new ScaClientError("failed", "failed");
  }
  try {
    return validateResult(parsed["result"]);
  } catch {
    throw new ScaClientError("failed", "failed");
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function remainingMilliseconds(deadlineAt: string): number {
  return Math.floor(Date.parse(deadlineAt) - Date.now());
}

function responseInactivityTimeout(config: ScaClientConfig): number {
  return Math.max(1, config.responseTimeoutMs);
}

function frameFor(token: string, action: ScaServiceAction, request: unknown): string {
  return `${JSON.stringify({
    protocol: SCA_SERVICE_IPC_PROTOCOL,
    token,
    action,
    request,
  })}\n`;
}

function socketFailure(error: unknown): ScaClientError {
  if (error instanceof ScaClientError) {
    return error;
  }
  return new ScaClientError("service_unavailable", "failed");
}

async function readOneResponseFrame(
  config: ScaClientConfig,
  action: ScaServiceAction,
  request: unknown,
  absoluteTimeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted === true) {
    throw new ScaClientError("cancelled", "failed");
  }

  const frame = frameFor(config.token, action, request);
  if (Buffer.byteLength(frame, "utf8") > SCA_BROKER_CONTRACT_LIMITS_V1.max_request_bytes) {
    throw new ScaClientError("quota_exceeded", "failed");
  }
  if (!Number.isFinite(absoluteTimeoutMs) || absoluteTimeoutMs <= 0) {
    throw new ScaClientError("timeout", "failed");
  }
  const timeoutMs = responseInactivityTimeout(config);

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let receivedBytes = 0;
    let lineFound = false;
    const lineChunks: Buffer[] = [];
    const socket: Socket = createConnection({ path: config.socketPath, allowHalfOpen: true });

    let inactivityTimer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      clearTimeout(absoluteTimer);
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(socketFailure(error));
    };
    const onAbort = (): void => {
      fail(new ScaClientError("cancelled", "failed"));
    };
    const absoluteTimer = setTimeout(
      () => {
        fail(new ScaClientError("timeout", "failed"));
      },
      Math.max(1, Math.ceil(absoluteTimeoutMs))
    );
    const renewInactivity = (): void => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fail(new ScaClientError("timeout", "failed"));
      }, timeoutMs);
    };
    renewInactivity();

    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("connect", () => {
      socket.end(frame, "utf8");
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (chunk.byteLength > 0) renewInactivity();
      receivedBytes += chunk.byteLength;
      if (receivedBytes > config.maxResponseBytes) {
        fail(new ScaClientError("quota_exceeded", "failed"));
        return;
      }
      if (lineFound) {
        fail(new ScaClientError("failed", "failed"));
        return;
      }
      const newlineIndex = chunk.indexOf(0x0a);
      if (newlineIndex === -1) {
        lineChunks.push(chunk);
        return;
      }
      if (newlineIndex !== chunk.byteLength - 1) {
        fail(new ScaClientError("failed", "failed"));
        return;
      }
      lineChunks.push(chunk.subarray(0, newlineIndex));
      lineFound = true;
    });
    socket.on("end", () => {
      if (settled) return;
      if (!lineFound) {
        fail(new ScaClientError("failed", "failed"));
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(lineChunks).toString("utf8"));
    });
    socket.on("close", () => {
      if (!settled && !lineFound) {
        fail(new ScaClientError("service_unavailable", "failed"));
      }
    });
    socket.on("error", fail);
  });
}

function terminalErrorCode(receipt: ScaBrokerReceiptV1): ScaBrokerErrorCode {
  if (receipt.failure !== null) return receipt.failure.code;
  if (receipt.terminal_status === "cancelled") return "cancelled";
  if (receipt.terminal_status === "timed_out") return "timeout";
  return "failed";
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function remainingJobInactivity(
  lastProgressAtMs: number,
  inactivityMs: number,
  currentMs: number
): number {
  if (
    !Number.isFinite(lastProgressAtMs) ||
    !Number.isFinite(currentMs) ||
    currentMs < lastProgressAtMs
  ) {
    throw new ScaClientError("failed", "failed");
  }
  return inactivityMs - (currentMs - lastProgressAtMs);
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new ScaClientError("cancelled", "failed"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new ScaClientError("cancelled", "failed"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function capabilityRequestFor(
  executeRequest: ScaBrokerExecuteRequestV1,
  lifecycleDeadlineAt: string
): ScaBrokerCapabilityRequestV1 {
  const requestedAt = isoNow();
  const remaining = remainingMilliseconds(lifecycleDeadlineAt);
  if (remaining <= 0) throw new ScaClientError("timeout", "failed");
  return validateScaBrokerCapabilityRequestV1({
    schema_id: "penny.sca-broker-capability-request.v1",
    schema_version: 1,
    tenant_id: executeRequest.tenant_id,
    project_id: executeRequest.project_id,
    run_id: executeRequest.run_id,
    request_id: `capability-${scaBrokerExecuteRequestSha256(executeRequest).slice(0, 32)}`,
    tool_name: executeRequest.tool_name,
    operation: executeRequest.operation,
    requested_at: requestedAt,
    deadline_at: lifecycleDeadlineAt,
    timeout_ms: Math.max(1, Math.min(executeRequest.limits.timeout_ms, remaining)),
  });
}

function pollRequestFor(
  executeRequest: ScaBrokerExecuteRequestV1,
  accepted: ScaBrokerExecuteAcceptedResult,
  pollTimeoutMs: number
): ScaBrokerPollRequestV1 {
  const requestedAt = isoNow();
  return validateScaBrokerPollRequestV1({
    schema_id: "penny.sca-broker-poll-request.v1",
    schema_version: 1,
    tenant_id: executeRequest.tenant_id,
    project_id: executeRequest.project_id,
    run_id: executeRequest.run_id,
    job_id: executeRequest.job_id,
    attempt: executeRequest.attempt,
    idempotency_key: executeRequest.idempotency_key,
    tool_name: executeRequest.tool_name,
    operation: executeRequest.operation,
    request_sha256: accepted.request_sha256,
    requested_at: requestedAt,
    deadline_at: new Date(Date.parse(requestedAt) + pollTimeoutMs).toISOString(),
    poll_timeout_ms: pollTimeoutMs,
  });
}

export class ScaServiceClient {
  private readonly runtime: ScaClientRuntime;

  constructor(
    private readonly config: ScaClientConfig,
    runtime: Partial<ScaClientRuntime> = {}
  ) {
    this.runtime = {
      monotonicNow: runtime.monotonicNow ?? (() => performance.now()),
    };
  }

  async capability(
    requestValue: ScaBrokerCapabilityRequestV1,
    options: ScaClientCallOptions = {}
  ): Promise<ScaBrokerCapabilityResultV1> {
    const request = validateScaBrokerCapabilityRequestV1(requestValue);
    const text = await readOneResponseFrame(
      this.config,
      "capability",
      request,
      remainingMilliseconds(request.deadline_at),
      options.signal
    );
    return parseResponseEnvelope(text, "capability", (value) =>
      validateScaBrokerCapabilityResultV1(value, request)
    );
  }

  private async executeWithin(
    requestValue: ScaBrokerExecuteRequestV1,
    absoluteTimeoutMs: number,
    options: ScaClientCallOptions
  ): Promise<ScaBrokerExecuteAcceptedResult> {
    const request = validateScaBrokerExecuteRequestV1(requestValue);
    const text = await readOneResponseFrame(
      this.config,
      "execute",
      request,
      absoluteTimeoutMs,
      options.signal
    );
    return parseResponseEnvelope(text, "execute", (value) =>
      validateScaBrokerExecuteAcceptedResult(value, request)
    );
  }

  async execute(
    requestValue: ScaBrokerExecuteRequestV1,
    options: ScaClientCallOptions = {}
  ): Promise<ScaBrokerExecuteAcceptedResult> {
    const request = validateScaBrokerExecuteRequestV1(requestValue);
    return await this.executeWithin(request, remainingMilliseconds(request.deadline_at), options);
  }

  private async pollWithin(
    requestValue: ScaBrokerPollRequestV1,
    executeRequestValue: ScaBrokerExecuteRequestV1,
    absoluteTimeoutMs: number,
    options: ScaClientCallOptions
  ): Promise<ScaBrokerPollResult> {
    const request = validateScaBrokerPollRequestV1(requestValue);
    const executeRequest = validateScaBrokerExecuteRequestV1(executeRequestValue);
    const text = await readOneResponseFrame(
      this.config,
      "poll",
      request,
      absoluteTimeoutMs,
      options.signal
    );
    return parseResponseEnvelope(text, "poll", (value) =>
      validateScaBrokerPollResult(value, request, executeRequest)
    );
  }

  async poll(
    requestValue: ScaBrokerPollRequestV1,
    executeRequestValue: ScaBrokerExecuteRequestV1,
    options: ScaClientCallOptions = {}
  ): Promise<ScaBrokerPollResult> {
    const request = validateScaBrokerPollRequestV1(requestValue);
    return await this.pollWithin(
      request,
      executeRequestValue,
      remainingMilliseconds(request.deadline_at),
      options
    );
  }

  async cancel(
    requestValue: ScaBrokerCancelRequestV1,
    executeRequestValue: ScaBrokerExecuteRequestV1,
    options: ScaClientCallOptions = {}
  ): Promise<ScaBrokerCancelResultV1> {
    const request = validateScaBrokerCancelRequestV1(requestValue);
    const executeRequest = validateScaBrokerExecuteRequestV1(executeRequestValue);
    const text = await readOneResponseFrame(
      this.config,
      "cancel",
      request,
      remainingMilliseconds(request.deadline_at),
      options.signal
    );
    return parseResponseEnvelope(text, "cancel", (value) =>
      validateScaBrokerCancelResultV1(value, request, executeRequest)
    );
  }

  private async bestEffortCancel(
    executeRequest: ScaBrokerExecuteRequestV1,
    accepted: ScaBrokerExecuteAcceptedResult,
    cause: ScaBrokerErrorCode
  ): Promise<void> {
    const requestedAt = isoNow();
    const timeoutMs = this.config.responseTimeoutMs;
    const request = validateScaBrokerCancelRequestV1({
      schema_id: "penny.sca-broker-cancel-request.v1",
      schema_version: 1,
      tenant_id: executeRequest.tenant_id,
      project_id: executeRequest.project_id,
      run_id: executeRequest.run_id,
      job_id: executeRequest.job_id,
      attempt: executeRequest.attempt,
      idempotency_key: executeRequest.idempotency_key,
      tool_name: executeRequest.tool_name,
      operation: executeRequest.operation,
      request_sha256: accepted.request_sha256,
      reason:
        cause === "timeout"
          ? "deadline_exceeded"
          : cause === "cancelled"
            ? "parent_cancelled"
            : "caller_requested",
      requested_at: requestedAt,
      deadline_at: new Date(Date.parse(requestedAt) + timeoutMs).toISOString(),
      timeout_ms: timeoutMs,
    });
    try {
      await this.cancel(request, executeRequest);
    } catch {
      // Cancellation is deliberately best effort; the original typed failure remains authoritative.
    }
  }

  async executeToTerminal(
    requestValue: ScaBrokerExecuteRequestV1,
    options: ScaClientCallOptions = {}
  ): Promise<ScaTerminalExecutionResult> {
    const request = validateScaBrokerExecuteRequestV1(requestValue);
    const requestSha256 = scaBrokerExecuteRequestSha256(request);
    const admissionDeadlineAt = new Date(
      Math.min(Date.parse(request.deadline_at), Date.now() + request.limits.timeout_ms)
    ).toISOString();
    let accepted: ScaBrokerExecuteAcceptedResult | undefined;
    let terminalReceipt: ScaBrokerReceiptV1 | undefined;

    try {
      if (isAborted(options.signal)) {
        throw new ScaClientError("cancelled", "failed");
      }
      const capability = await this.capability(
        capabilityRequestFor(request, admissionDeadlineAt),
        options
      );
      if (capability.status !== "available") {
        if (capability.error === null) throw new ScaClientError("failed", "failed");
        throw new ScaClientError(capability.error.code, "failed");
      }

      accepted = await this.executeWithin(
        request,
        remainingMilliseconds(admissionDeadlineAt),
        options
      );
      const progressProtocol = accepted.schema_version;
      let lastProgress: ScaBrokerJobProgressV1 | undefined =
        accepted.schema_version === 2 ? accepted.progress : undefined;
      let lastNonterminalStatus: "accepted" | "running" = "accepted";
      let lastProgressAtMs = this.runtime.monotonicNow();

      for (;;) {
        if (isAborted(options.signal)) {
          throw new ScaClientError("cancelled", "failed");
        }
        const inactivityRemaining = remainingJobInactivity(
          lastProgressAtMs,
          request.limits.timeout_ms,
          this.runtime.monotonicNow()
        );
        if (inactivityRemaining <= 0) throw new ScaClientError("timeout", "failed");
        const pollTimeoutMs = Math.max(
          1,
          Math.min(
            this.config.responseTimeoutMs,
            SCA_BROKER_CONTRACT_LIMITS_V1.max_poll_timeout_ms,
            Math.floor(inactivityRemaining)
          )
        );
        const pollResult = await this.pollWithin(
          pollRequestFor(request, accepted, pollTimeoutMs),
          request,
          Math.min(inactivityRemaining, pollTimeoutMs),
          options
        );

        if (isAborted(options.signal)) {
          throw new ScaClientError("cancelled", "failed");
        }
        if (pollResult.schema_version !== progressProtocol) {
          throw new ScaClientError("failed", "failed");
        }
        if (pollResult.status === "accepted" && lastNonterminalStatus === "running") {
          throw new ScaClientError("failed", "failed");
        }

        const observedAtMs = this.runtime.monotonicNow();
        if (pollResult.schema_version === 2) {
          if (lastProgress === undefined) throw new ScaClientError("failed", "failed");
          const disposition = classifyScaBrokerJobProgressV1(lastProgress, pollResult.progress);
          lastProgress = pollResult.progress;
          if (disposition === "advanced") lastProgressAtMs = observedAtMs;
        }
        if (pollResult.status === "running") lastNonterminalStatus = "running";

        if (
          remainingJobInactivity(lastProgressAtMs, request.limits.timeout_ms, observedAtMs) <= 0
        ) {
          throw new ScaClientError("timeout", "failed");
        }
        if (pollResult.status !== "accepted" && pollResult.status !== "running") {
          if (pollResult.receipt === null) throw new ScaClientError("failed", "failed");
          terminalReceipt = validateScaBrokerReceiptV1(pollResult.receipt, request);
          if (terminalReceipt.terminal_status !== "succeeded") {
            throw new ScaClientError(terminalErrorCode(terminalReceipt), "failed", terminalReceipt);
          }
          return { requestSha256, receipt: terminalReceipt };
        }
        const remainingBeforeSleep = remainingJobInactivity(
          lastProgressAtMs,
          request.limits.timeout_ms,
          this.runtime.monotonicNow()
        );
        if (remainingBeforeSleep <= 0) throw new ScaClientError("timeout", "failed");
        await sleep(
          Math.max(1, Math.min(this.config.pollIntervalMs, Math.floor(remainingBeforeSleep))),
          options.signal
        );
      }
    } catch (error) {
      const clientError = normalizeClientError(error);
      if (accepted !== undefined && terminalReceipt === undefined) {
        await this.bestEffortCancel(request, accepted, clientError.code);
        throw clientError.withCompletion("incomplete");
      }
      throw clientError;
    }
  }
}
