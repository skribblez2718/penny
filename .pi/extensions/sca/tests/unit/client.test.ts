import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../../../../apps/orchestration/dist/canonical-json.js";
import type { CurrentArtifactRef } from "../../../../../apps/orchestration/dist/contracts.js";
import type { ScaClientConfig } from "../../src/config.js";
import { SCA_SERVICE_IPC_PROTOCOL, ScaClientError, ScaServiceClient } from "../../src/client.js";
import {
  SCA_BROKER_CONTRACT_LIMITS_V1,
  scaBrokerExecuteRequestSha256,
  validateScaBrokerCancelRequestV1,
  validateScaBrokerCapabilityRequestV1,
  validateScaBrokerExecuteRequestV1,
  validateScaBrokerPollRequestV1,
  type ScaBrokerExecuteRequestV1,
} from "../../src/contracts.js";

const TOKEN = "client-test-token-000000000000000000000";
const RUN_ID = "run-sca-client-001";

type Action = "capability" | "execute" | "poll" | "cancel";

interface ObservedFrame {
  readonly protocol: string;
  readonly action: Action;
  readonly token: string;
  readonly request: unknown;
}

interface FakeServer {
  readonly socketPath: string;
  readonly frames: ObservedFrame[];
  close(): Promise<void>;
}

const servers = new Set<FakeServer>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is Action {
  return value === "capability" || value === "execute" || value === "poll" || value === "cancel";
}

function parseFrame(text: string): ObservedFrame {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value["protocol"] !== "string" ||
    !isAction(value["action"]) ||
    typeof value["token"] !== "string"
  ) {
    throw new Error("invalid client frame");
  }
  return {
    protocol: value["protocol"],
    action: value["action"],
    token: value["token"],
    request: value["request"],
  };
}

async function startFakeServer(
  handle: (frame: ObservedFrame, socket: Socket) => void | Promise<void>
): Promise<FakeServer> {
  const root = await mkdtemp(path.join(tmpdir(), "penny-sca-client-test-"));
  const socketPath = path.join(root, "service.sock");
  const frames: ObservedFrame[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    let body = Buffer.alloc(0);
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) throw new Error("client sent more than one request frame");
      body = Buffer.concat([body, chunk]);
      const newline = body.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== body.byteLength - 1) throw new Error("client sent trailing frame bytes");
      handled = true;
      const frame = parseFrame(body.subarray(0, newline).toString("utf8"));
      frames.push(frame);
      void Promise.resolve(handle(frame, socket)).catch(() => socket.destroy());
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const fake: FakeServer = {
    socketPath,
    frames,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await rm(root, { recursive: true, force: true });
    },
  };
  servers.add(fake);
  return fake;
}

function respond(socket: Socket, action: Action, result: unknown): void {
  socket.end(
    `${JSON.stringify({ protocol: SCA_SERVICE_IPC_PROTOCOL, ok: true, action, result })}\n`,
    "utf8"
  );
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
    producer: "sca-client-fixture",
    media_type: "application/json",
    byte_length: 128,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

function executeRequest(timeoutMs = 5_000): ScaBrokerExecuteRequestV1 {
  const submittedAt = new Date(Date.now() - 100);
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
  });
}

function config(socketPath: string, overrides: Partial<ScaClientConfig> = {}): ScaClientConfig {
  return {
    socketPath,
    token: TOKEN,
    responseTimeoutMs: 1_000,
    pollIntervalMs: 1,
    maxResponseBytes: 64 * 1_024,
    ...overrides,
  };
}

function capabilityResult(frame: ObservedFrame): unknown {
  const request = validateScaBrokerCapabilityRequestV1(frame.request);
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
}

function jobProgress(
  binding: ScaBrokerExecuteRequestV1 | ReturnType<typeof validateScaBrokerPollRequestV1>,
  overrides: Partial<{
    readonly sequence: number;
    readonly phase: "accepted" | "executing" | "materializing_output";
    readonly work_units: number;
    readonly output_bytes: number;
    readonly result_items: number;
  }> = {}
): unknown {
  return {
    schema_id: "penny.sca-broker-job-progress.v1",
    schema_version: 1,
    tenant_id: binding.tenant_id,
    project_id: binding.project_id,
    run_id: binding.run_id,
    job_id: binding.job_id,
    attempt: binding.attempt,
    idempotency_key: binding.idempotency_key,
    tool_name: binding.tool_name,
    operation: binding.operation,
    request_sha256:
      "submitted_at" in binding ? scaBrokerExecuteRequestSha256(binding) : binding.request_sha256,
    sequence: 0,
    phase: "accepted",
    work_units: 0,
    output_bytes: 0,
    result_items: 0,
    ...overrides,
  };
}

function acceptedResult(frame: ObservedFrame, request: ScaBrokerExecuteRequestV1): unknown {
  const received = validateScaBrokerExecuteRequestV1(frame.request);
  return {
    schema_id: "penny.sca-broker-execute-accepted-result.v2",
    schema_version: 2,
    tenant_id: received.tenant_id,
    project_id: received.project_id,
    run_id: received.run_id,
    job_id: received.job_id,
    attempt: received.attempt,
    idempotency_key: received.idempotency_key,
    tool_name: received.tool_name,
    operation: received.operation,
    status: "accepted",
    request_sha256: scaBrokerExecuteRequestSha256(request),
    accepted_at: new Date().toISOString(),
    progress: jobProgress(received),
  };
}

function legacyAcceptedResult(frame: ObservedFrame, request: ScaBrokerExecuteRequestV1): unknown {
  const received = validateScaBrokerExecuteRequestV1(frame.request);
  return {
    schema_id: "penny.sca-broker-execute-accepted-result.v1",
    schema_version: 1,
    tenant_id: received.tenant_id,
    project_id: received.project_id,
    run_id: received.run_id,
    job_id: received.job_id,
    attempt: received.attempt,
    idempotency_key: received.idempotency_key,
    tool_name: received.tool_name,
    operation: received.operation,
    status: "accepted",
    request_sha256: scaBrokerExecuteRequestSha256(request),
    accepted_at: new Date().toISOString(),
  };
}

function runningResult(
  frame: ObservedFrame,
  progressOverrides: Parameters<typeof jobProgress>[1] = {}
): unknown {
  const request = validateScaBrokerPollRequestV1(frame.request);
  return {
    schema_id: "penny.sca-broker-poll-result.v2",
    schema_version: 2,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    job_id: request.job_id,
    attempt: request.attempt,
    idempotency_key: request.idempotency_key,
    tool_name: request.tool_name,
    operation: request.operation,
    request_sha256: request.request_sha256,
    status: "running",
    progress: jobProgress(request, {
      sequence: 1,
      phase: "executing",
      ...progressOverrides,
    }),
    partial: false,
    truncated: false,
    output_refs: [],
    result_item_count: 0,
    failure: null,
    receipt: null,
    observed_at: request.requested_at,
  };
}

function legacyRunningResult(frame: ObservedFrame): unknown {
  const request = validateScaBrokerPollRequestV1(frame.request);
  return {
    schema_id: "penny.sca-broker-poll-result.v1",
    schema_version: 1,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    job_id: request.job_id,
    attempt: request.attempt,
    idempotency_key: request.idempotency_key,
    tool_name: request.tool_name,
    operation: request.operation,
    request_sha256: request.request_sha256,
    status: "running",
    partial: false,
    truncated: false,
    output_refs: [],
    result_item_count: 0,
    failure: null,
    receipt: null,
    observed_at: request.requested_at,
  };
}

function terminalResult(
  frame: ObservedFrame,
  execute: ScaBrokerExecuteRequestV1,
  acceptedAt: string,
  progressOverrides: Parameters<typeof jobProgress>[1] = {}
): unknown {
  const poll = validateScaBrokerPollRequestV1(frame.request);
  const outputRef = artifactRef("sca-source-results", "source-results-1");
  const terminalAt = new Date(Math.max(Date.now(), Date.parse(acceptedAt))).toISOString();
  const receipt = {
    schema_id: "penny.sca-broker-receipt.v1",
    schema_version: 1,
    tenant_id: execute.tenant_id,
    project_id: execute.project_id,
    run_id: execute.run_id,
    job_id: execute.job_id,
    attempt: execute.attempt,
    idempotency_key: execute.idempotency_key,
    receipt_id: "receipt-source-query-1",
    tool_name: execute.tool_name,
    operation: execute.operation,
    request_sha256: poll.request_sha256,
    limits: execute.limits,
    terminal_status: "succeeded",
    partial: false,
    truncated: false,
    source_snapshot_ref: execute.source_snapshot_ref,
    config_ref: execute.config_ref,
    input_refs: execute.input_refs,
    output_refs: [outputRef],
    result_item_count: 1,
    failure: null,
    accepted_at: acceptedAt,
    terminal_at: terminalAt,
  };
  return {
    schema_id: "penny.sca-broker-poll-result.v2",
    schema_version: 2,
    tenant_id: execute.tenant_id,
    project_id: execute.project_id,
    run_id: execute.run_id,
    job_id: execute.job_id,
    attempt: execute.attempt,
    idempotency_key: execute.idempotency_key,
    tool_name: execute.tool_name,
    operation: execute.operation,
    request_sha256: poll.request_sha256,
    status: "succeeded",
    progress: jobProgress(poll, {
      sequence: 2,
      phase: "materializing_output",
      output_bytes: outputRef.byte_length,
      result_items: 1,
      ...progressOverrides,
    }),
    partial: false,
    truncated: false,
    output_refs: [outputRef],
    result_item_count: 1,
    failure: null,
    receipt,
    observed_at: poll.requested_at,
  };
}

function cancelRequestedResult(frame: ObservedFrame): unknown {
  const request = validateScaBrokerCancelRequestV1(frame.request);
  return {
    schema_id: "penny.sca-broker-cancel-result.v1",
    schema_version: 1,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    job_id: request.job_id,
    attempt: request.attempt,
    idempotency_key: request.idempotency_key,
    tool_name: request.tool_name,
    operation: request.operation,
    request_sha256: request.request_sha256,
    outcome: "cancel_requested",
    terminal_status: null,
    receipt: null,
    error: null,
    observed_at: request.requested_at,
  };
}

async function clientError(promise: Promise<unknown>): Promise<ScaClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ScaClientError) return error;
    throw error;
  }
  throw new Error("expected ScaClientError");
}

afterEach(async () => {
  for (const server of servers) await server.close();
  servers.clear();
});

describe("SCA Unix-socket client", () => {
  it("uses one authenticated frame per connection and returns an exact validated terminal receipt", async () => {
    const request = executeRequest();
    let pollCount = 0;
    let acceptedAt = "";
    const fake = await startFakeServer((frame, socket) => {
      expect(frame.protocol).toBe(SCA_SERVICE_IPC_PROTOCOL);
      expect(frame.token).toBe(TOKEN);
      switch (frame.action) {
        case "capability":
          respond(socket, "capability", capabilityResult(frame));
          return;
        case "execute": {
          const result = acceptedResult(frame, request);
          if (!isRecord(result) || typeof result["accepted_at"] !== "string") {
            throw new Error("accepted timestamp missing");
          }
          acceptedAt = result["accepted_at"];
          respond(socket, "execute", result);
          return;
        }
        case "poll":
          pollCount += 1;
          respond(
            socket,
            "poll",
            pollCount === 1 ? runningResult(frame) : terminalResult(frame, request, acceptedAt)
          );
          return;
        case "cancel":
          throw new Error("successful lifecycle must not cancel");
      }
    });

    const result = await new ScaServiceClient(config(fake.socketPath)).executeToTerminal(request);
    expect(result.requestSha256).toBe(scaBrokerExecuteRequestSha256(request));
    expect(result.receipt).toMatchObject({
      terminal_status: "succeeded",
      job_id: request.job_id,
      request_sha256: result.requestSha256,
      result_item_count: 1,
    });
    expect(fake.frames.map((frame) => frame.action)).toEqual([
      "capability",
      "execute",
      "poll",
      "poll",
    ]);
    expect(fake.frames).toHaveLength(4);
  });

  it("keeps polling broker-owned substantive progress beyond the former elapsed limit", async () => {
    const request = executeRequest(6);
    let acceptedAt = "";
    let pollCount = 0;
    let monotonicMs = 0;
    const fake = await startFakeServer((frame, socket) => {
      if (frame.action === "capability") {
        respond(socket, "capability", capabilityResult(frame));
        return;
      }
      if (frame.action === "execute") {
        const accepted = acceptedResult(frame, request);
        if (!isRecord(accepted) || typeof accepted["accepted_at"] !== "string") {
          throw new Error("invalid accepted fixture");
        }
        acceptedAt = accepted["accepted_at"];
        respond(socket, "execute", accepted);
        return;
      }
      if (frame.action === "poll") {
        pollCount += 1;
        monotonicMs += 4;
        if (pollCount <= 12) {
          respond(
            socket,
            "poll",
            runningResult(frame, {
              sequence: pollCount,
              phase: "executing",
              work_units: Math.max(0, pollCount - 1),
            })
          );
        } else {
          respond(
            socket,
            "poll",
            terminalResult(frame, request, acceptedAt, {
              sequence: pollCount,
              work_units: 11,
            })
          );
        }
        return;
      }
      throw new Error("productive lifecycle must not cancel");
    });

    await expect(
      new ScaServiceClient(config(fake.socketPath), {
        monotonicNow: () => monotonicMs,
      }).executeToTerminal(request)
    ).resolves.toMatchObject({ receipt: { terminal_status: "succeeded" } });
    expect(pollCount).toBe(13);
    expect(monotonicMs).toBeGreaterThan(request.limits.timeout_ms);
  });

  it("expires unchanged current progress and best-effort cancels the accepted job", async () => {
    const request = executeRequest(10);
    let monotonicMs = 0;
    let pollCount = 0;
    const fake = await startFakeServer((frame, socket) => {
      if (frame.action === "capability") {
        respond(socket, "capability", capabilityResult(frame));
        return;
      }
      if (frame.action === "execute") {
        respond(socket, "execute", acceptedResult(frame, request));
        return;
      }
      if (frame.action === "poll") {
        pollCount += 1;
        monotonicMs += 4;
        respond(socket, "poll", runningResult(frame));
        return;
      }
      respond(socket, "cancel", cancelRequestedResult(frame));
    });

    const error = await clientError(
      new ScaServiceClient(config(fake.socketPath), {
        monotonicNow: () => monotonicMs,
      }).executeToTerminal(request)
    );
    expect(error).toMatchObject({ code: "timeout", completion: "incomplete" });
    expect(pollCount).toBeGreaterThan(1);
    expect(fake.frames.at(-1)?.action).toBe("cancel");
  });

  it("bounds legacy missing-progress jobs instead of renewing them from polling", async () => {
    const request = executeRequest(10);
    let monotonicMs = 0;
    const fake = await startFakeServer((frame, socket) => {
      if (frame.action === "capability") {
        respond(socket, "capability", capabilityResult(frame));
        return;
      }
      if (frame.action === "execute") {
        respond(socket, "execute", legacyAcceptedResult(frame, request));
        return;
      }
      if (frame.action === "poll") {
        monotonicMs += 4;
        respond(socket, "poll", legacyRunningResult(frame));
        return;
      }
      respond(socket, "cancel", cancelRequestedResult(frame));
    });

    const error = await clientError(
      new ScaServiceClient(config(fake.socketPath), {
        monotonicNow: () => monotonicMs,
      }).executeToTerminal(request)
    );
    expect(error).toMatchObject({ code: "timeout", completion: "incomplete" });
    expect(fake.frames.at(-1)?.action).toBe("cancel");
  });

  it.each([
    "regressed progress",
    "misbound progress",
    "status regression",
    "missing current metadata",
  ] as const)("fails closed on %s", async (failureKind) => {
    const request = executeRequest();
    let pollCount = 0;
    const fake = await startFakeServer((frame, socket) => {
      if (frame.action === "capability") {
        respond(socket, "capability", capabilityResult(frame));
        return;
      }
      if (frame.action === "execute") {
        respond(socket, "execute", acceptedResult(frame, request));
        return;
      }
      if (frame.action === "poll") {
        pollCount += 1;
        if (failureKind === "missing current metadata") {
          respond(socket, "poll", legacyRunningResult(frame));
          return;
        }
        if (failureKind === "misbound progress") {
          const misbound = runningResult(frame);
          if (!isRecord(misbound) || !isRecord(misbound["progress"])) {
            throw new Error("invalid progress fixture");
          }
          respond(socket, "poll", {
            ...misbound,
            progress: { ...misbound["progress"], job_id: "job-other" },
          });
          return;
        }
        if (pollCount === 1) {
          respond(socket, "poll", runningResult(frame, { sequence: 2, work_units: 1 }));
          return;
        }
        if (failureKind === "regressed progress") {
          respond(socket, "poll", runningResult(frame));
          return;
        }
        const acceptedAgain = runningResult(frame);
        if (!isRecord(acceptedAgain)) throw new Error("invalid running fixture");
        respond(socket, "poll", {
          ...acceptedAgain,
          status: "accepted",
          progress: jobProgress(validateScaBrokerPollRequestV1(frame.request)),
        });
        return;
      }
      respond(socket, "cancel", cancelRequestedResult(frame));
    });

    const error = await clientError(
      new ScaServiceClient(config(fake.socketPath)).executeToTerminal(request)
    );
    expect(error).toMatchObject({
      code: failureKind === "regressed progress" ? "invalid_request" : "failed",
      completion: "incomplete",
    });
    expect(fake.frames.at(-1)?.action).toBe("cancel");
  });

  it("does not let response bytes or successful polls renew job liveness", async () => {
    const request = executeRequest(25);
    const fake = await startFakeServer((frame, socket) => {
      if (frame.action === "capability") {
        respond(socket, "capability", capabilityResult(frame));
        return;
      }
      if (frame.action === "execute") {
        respond(socket, "execute", acceptedResult(frame, request));
        return;
      }
      if (frame.action === "poll") {
        const encoded = `${JSON.stringify({
          protocol: SCA_SERVICE_IPC_PROTOCOL,
          ok: true,
          action: "poll",
          result: runningResult(frame),
        })}\n`;
        let offset = 0;
        const sendNextByte = (): void => {
          if (socket.destroyed || offset >= encoded.length) return;
          socket.write(encoded.slice(offset, offset + 1), "utf8");
          offset += 1;
          setTimeout(sendNextByte, 5);
        };
        sendNextByte();
        return;
      }
      respond(socket, "cancel", cancelRequestedResult(frame));
    });

    const error = await clientError(
      new ScaServiceClient(config(fake.socketPath, { responseTimeoutMs: 100 })).executeToTerminal(
        request
      )
    );
    expect(error).toMatchObject({ code: "timeout", completion: "incomplete" });
    expect(fake.frames.map((frame) => frame.action)).toEqual([
      "capability",
      "execute",
      "poll",
      "cancel",
    ]);
  });

  it.each([
    [
      "malformed JSON",
      (socket: Socket) => {
        socket.end("not-json\n", "utf8");
      },
      "failed",
    ],
    [
      "oversized response",
      (socket: Socket) => {
        socket.end(`${"x".repeat(2_048)}\n`, "utf8");
      },
      "quota_exceeded",
    ],
  ])("rejects %s without accepting work", async (_label, send, expectedCode) => {
    const request = executeRequest();
    const fake = await startFakeServer((_frame, socket) => send(socket));
    const error = await clientError(
      new ScaServiceClient(config(fake.socketPath, { maxResponseBytes: 1_024 })).executeToTerminal(
        request
      )
    );
    expect(error).toMatchObject({ code: expectedCode, completion: "failed" });
    expect(fake.frames.map((frame) => frame.action)).toEqual(["capability"]);
  });

  it("rejects a response for the wrong action", async () => {
    const request = executeRequest();
    const fake = await startFakeServer((frame, socket) => {
      respond(socket, "poll", capabilityResult(frame));
    });
    const error = await clientError(
      new ScaServiceClient(config(fake.socketPath)).executeToTerminal(request)
    );
    expect(error).toMatchObject({ code: "failed", completion: "failed" });
  });

  it.each(["job", "hash"] as const)(
    "rejects an accepted result with the wrong %s",
    async (kind) => {
      const request = executeRequest();
      const fake = await startFakeServer((frame, socket) => {
        if (frame.action === "capability") {
          respond(socket, "capability", capabilityResult(frame));
          return;
        }
        if (frame.action !== "execute") throw new Error("unexpected action");
        const accepted = acceptedResult(frame, request);
        if (!isRecord(accepted)) throw new Error("invalid fixture");
        respond(socket, "execute", {
          ...accepted,
          ...(kind === "job"
            ? { job_id: "wrong-job-binding" }
            : { request_sha256: "0".repeat(64) }),
        });
      });
      const error = await clientError(
        new ScaServiceClient(config(fake.socketPath)).executeToTerminal(request)
      );
      expect(error).toMatchObject({ code: "failed", completion: "failed" });
      expect(fake.frames.map((frame) => frame.action)).toEqual(["capability", "execute"]);
    }
  );

  it("rejects a terminal result that disagrees with its receipt and attempts cancellation", async () => {
    const request = executeRequest();
    let acceptedAt = "";
    const fake = await startFakeServer((frame, socket) => {
      if (frame.action === "capability") {
        respond(socket, "capability", capabilityResult(frame));
        return;
      }
      if (frame.action === "execute") {
        const accepted = acceptedResult(frame, request);
        if (!isRecord(accepted) || typeof accepted["accepted_at"] !== "string") {
          throw new Error("invalid accepted fixture");
        }
        acceptedAt = accepted["accepted_at"];
        respond(socket, "execute", accepted);
        return;
      }
      if (frame.action === "poll") {
        const terminal = terminalResult(frame, request, acceptedAt);
        if (!isRecord(terminal)) throw new Error("invalid terminal fixture");
        respond(socket, "poll", { ...terminal, result_item_count: 2 });
        return;
      }
      respond(socket, "cancel", cancelRequestedResult(frame));
    });
    const error = await clientError(
      new ScaServiceClient(config(fake.socketPath)).executeToTerminal(request)
    );
    expect(error).toMatchObject({ code: "failed", completion: "incomplete" });
    expect(fake.frames.map((frame) => frame.action)).toEqual([
      "capability",
      "execute",
      "poll",
      "cancel",
    ]);
  });

  it("best-effort cancels accepted work when a poll transport becomes inactive", async () => {
    const request = executeRequest();
    const fake = await startFakeServer((frame, socket) => {
      if (frame.action === "capability") {
        respond(socket, "capability", capabilityResult(frame));
        return;
      }
      if (frame.action === "execute") {
        respond(socket, "execute", acceptedResult(frame, request));
        return;
      }
      if (frame.action === "poll") return;
      respond(socket, "cancel", cancelRequestedResult(frame));
    });

    const error = await clientError(
      new ScaServiceClient(config(fake.socketPath, { responseTimeoutMs: 25 })).executeToTerminal(
        request
      )
    );
    expect(error).toMatchObject({ code: "timeout", completion: "incomplete" });
    expect(fake.frames.map((frame) => frame.action)).toEqual([
      "capability",
      "execute",
      "poll",
      "cancel",
    ]);
  });

  it("bounds best-effort cancellation when the service never acknowledges cleanup", async () => {
    const request = executeRequest(20);
    const fake = await startFakeServer((frame, socket) => {
      if (frame.action === "capability") {
        respond(socket, "capability", capabilityResult(frame));
        return;
      }
      if (frame.action === "execute") {
        respond(socket, "execute", acceptedResult(frame, request));
        return;
      }
      if (frame.action === "poll") {
        respond(socket, "poll", runningResult(frame));
      }
    });

    const startedAt = Date.now();
    const error = await clientError(
      new ScaServiceClient(config(fake.socketPath, { responseTimeoutMs: 25 })).executeToTerminal(
        request
      )
    );
    expect(error).toMatchObject({ code: "timeout", completion: "incomplete" });
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(fake.frames.at(-1)?.action).toBe("cancel");
  });

  it("best-effort cancels accepted work on abort and never accepts a late terminal result", async () => {
    const request = executeRequest();
    const controller = new AbortController();
    let acceptedAt = "";
    let releasePoll: () => void = () => undefined;
    const pollSeen = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const fake = await startFakeServer((frame, socket) => {
      if (frame.action === "capability") {
        respond(socket, "capability", capabilityResult(frame));
        return;
      }
      if (frame.action === "execute") {
        const accepted = acceptedResult(frame, request);
        if (!isRecord(accepted) || typeof accepted["accepted_at"] !== "string") {
          throw new Error("invalid accepted fixture");
        }
        acceptedAt = accepted["accepted_at"];
        respond(socket, "execute", accepted);
        return;
      }
      if (frame.action === "poll") {
        releasePoll();
        setTimeout(() => {
          if (!socket.destroyed)
            respond(socket, "poll", terminalResult(frame, request, acceptedAt));
        }, 50);
        return;
      }
      respond(socket, "cancel", cancelRequestedResult(frame));
    });

    const execution = new ScaServiceClient(config(fake.socketPath)).executeToTerminal(request, {
      signal: controller.signal,
    });
    await pollSeen;
    controller.abort();
    const error = await clientError(execution);
    expect(error).toMatchObject({ code: "cancelled", completion: "incomplete" });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(fake.frames.map((frame) => frame.action)).toEqual([
      "capability",
      "execute",
      "poll",
      "cancel",
    ]);
  });
});
