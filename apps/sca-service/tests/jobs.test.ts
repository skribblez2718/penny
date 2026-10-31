import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { CurrentArtifactRef } from "../../orchestration/dist/contracts.js";
import type {
  ScaAdapterRegistry,
  ScaAdapterTerminalResult,
  ScaOperationAdapter,
} from "../src/adapters.js";
import {
  SCA_BROKER_CONTRACT_LIMITS_V1,
  classifyScaBrokerJobProgressV1,
  scaBrokerExecuteRequestSha256,
  type ScaBrokerCancelRequestV1,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerPollRequestV1,
} from "../src/contracts.js";
import { ScaJobOwner, ScaJobProgressProducer } from "../src/jobs.js";

const RUN_ID = "run-sca-jobs-001";

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
    producer: "sca-job-fixture",
    media_type: "application/json",
    byte_length: 128,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

function executeRequest(timeoutMs: number): ScaBrokerExecuteRequestV1 {
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

function pollRequest(request: ScaBrokerExecuteRequestV1): ScaBrokerPollRequestV1 {
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

function cancelRequest(
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

function terminalSuccess(outputRef: CurrentArtifactRef): ScaAdapterTerminalResult {
  return {
    terminal_status: "succeeded",
    partial: false,
    truncated: false,
    output_refs: [outputRef],
    result_item_count: 1,
    failure: null,
  };
}

function adapterRegistry(adapter: ScaOperationAdapter): ScaAdapterRegistry {
  return {
    source_query: adapter,
    graph_query: null,
    application_test: null,
  };
}

function adapterWithRun(run: ScaOperationAdapter["run"]): ScaOperationAdapter {
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("SCA broker-owned job progress", () => {
  it("mints bound monotonic metadata only from typed server milestones", () => {
    const request = executeRequest(100);
    const producer = new ScaJobProgressProducer(request);
    const accepted = producer.snapshot();
    expect(accepted).toMatchObject({ sequence: 0, phase: "accepted", work_units: 0 });
    expect(accepted).not.toHaveProperty("observed_at");

    producer.executionStarted();
    const started = producer.snapshot();
    producer.reportWorkMilestone();
    const worked = producer.snapshot();
    producer.reportPersistedOutput(128, 1);
    const output = producer.snapshot();

    expect(classifyScaBrokerJobProgressV1(accepted, started)).toBe("advanced");
    expect(classifyScaBrokerJobProgressV1(started, worked)).toBe("advanced");
    expect(classifyScaBrokerJobProgressV1(worked, output)).toBe("advanced");
    expect(() => producer.reportPersistedOutput(128, 1)).toThrow(/advance monotonically/u);
    expect(() => producer.reportPersistedOutput(request.limits.max_output_bytes + 1, 2)).toThrow(
      /exceed/u
    );
    expect(() => producer.reportPersistedOutput(256, request.limits.max_result_items + 1)).toThrow(
      /exceed/u
    );
  });

  it("renews inactivity from broker work milestones beyond the former elapsed limit", async () => {
    const request = executeRequest(25);
    const output = artifactRef("sca-source-results", "source-output");
    const adapter = adapterWithRun(async (_request, context) => {
      for (let index = 0; index < 6; index += 1) {
        await delay(10);
        context.reportWorkMilestone();
      }
      context.reportPersistedOutput(output.byte_length, 1);
      return terminalSuccess(output);
    });
    const owner = new ScaJobOwner({ adapters: adapterRegistry(adapter) });
    const startedAt = Date.now();
    owner.execute(request);

    const sequences: number[] = [];
    let terminalStatus: string | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(5);
      const result = owner.poll(pollRequest(request));
      sequences.push(result.progress.sequence);
      if (result.status !== "accepted" && result.status !== "running") {
        terminalStatus = result.status;
        break;
      }
    }

    expect(terminalStatus).toBe("succeeded");
    expect(Date.now() - startedAt).toBeGreaterThan(request.limits.timeout_ms);
    expect(
      sequences.every((sequence, index) => {
        const previous = sequences[index - 1];
        return previous === undefined || sequence >= previous;
      })
    ).toBe(true);
    await owner.shutdown(20);
  });

  it("deduplicates exact retries and rejects idempotency collisions", async () => {
    const request = executeRequest(1_000);
    const adapter = adapterWithRun(
      async () => await new Promise<ScaAdapterTerminalResult>(() => {})
    );
    const owner = new ScaJobOwner({ adapters: adapterRegistry(adapter) });

    const first = owner.execute(request);
    expect(owner.execute(request)).toEqual(first);
    expect(() => owner.execute({ ...request, job_id: "job-collision" })).toThrow(
      /identity conflicts/u
    );
    expect(() => owner.poll({ ...pollRequest(request), job_id: "job-other" })).toThrow(
      /binding does not match/u
    );
    expect(() => owner.cancel({ ...cancelRequest(request, 10), job_id: "job-other" })).toThrow(
      /binding does not match/u
    );
    const shutdownStartedAt = Date.now();
    await owner.shutdown(10);
    expect(Date.now() - shutdownStartedAt).toBeLessThan(100);
    expect(owner.poll(pollRequest(request))).toMatchObject({
      status: "failed",
      failure: { code: "failed", message: "SCA service shutdown left containment unverified" },
    });
  });

  it("expires silent accepted work and reports a terminal timeout", async () => {
    const request = executeRequest(20);
    let abortObserved = false;
    const adapter = adapterWithRun(async (_request, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            resolve();
          },
          { once: true }
        );
      });
      return {
        terminal_status: "cancelled",
        partial: false,
        truncated: false,
        output_refs: [],
        result_item_count: 0,
        failure: { code: "cancelled", message: "adapter observed cancellation" },
      };
    });
    const owner = new ScaJobOwner({ adapters: adapterRegistry(adapter) });
    owner.execute(request);
    await delay(35);

    expect(owner.poll(pollRequest(request))).toMatchObject({
      status: "timed_out",
      failure: { code: "timeout" },
    });
    expect(abortObserved).toBe(true);
    await owner.shutdown(20);
  });

  it("preserves an adapter containment failure after cancellation", async () => {
    const request = executeRequest(1_000);
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const adapter = adapterWithRun(async (_request, context) => {
      markStarted?.();
      await new Promise<void>((resolve) =>
        context.signal.addEventListener("abort", () => resolve(), { once: true })
      );
      return {
        terminal_status: "failed",
        partial: false,
        truncated: false,
        output_refs: [],
        result_item_count: 0,
        failure: { code: "failed", message: "containment unverified" },
      };
    });
    const owner = new ScaJobOwner({ adapters: adapterRegistry(adapter) });
    owner.execute(request);
    await started;
    owner.cancel(cancelRequest(request, 100));
    await delay(10);
    expect(owner.poll(pollRequest(request))).toMatchObject({
      status: "failed",
      failure: { code: "failed", message: "containment unverified" },
    });
    await owner.shutdown(10);
  });

  it("bounds cancellation cleanup when an adapter does not settle", async () => {
    const request = executeRequest(1_000);
    const adapter = adapterWithRun(
      async () => await new Promise<ScaAdapterTerminalResult>(() => {})
    );
    const owner = new ScaJobOwner({ adapters: adapterRegistry(adapter) });
    owner.execute(request);

    expect(owner.cancel(cancelRequest(request, 15))).toMatchObject({
      outcome: "cancel_requested",
      terminal_status: null,
    });
    await delay(25);
    expect(owner.poll(pollRequest(request))).toMatchObject({
      status: "failed",
      failure: { code: "failed", message: "SCA job cancellation containment is unverified" },
    });
    await owner.shutdown(10);
  });
});
