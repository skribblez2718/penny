import { describe, expect, it } from "vitest";

import { type CurrentArtifactRef } from "../src/contracts.js";
import { canonicalJson, sha256 } from "../src/canonical-json.js";
import {
  SCA_BROKER_CONTRACT_LIMITS_V1,
  SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1,
  SCA_BROKER_SCHEMA_MANIFEST_SHA256,
  SCA_MODEL_TOOL_ROSTER,
  SCA_TOOL_OPERATION_MAP,
  ScaBrokerExecuteRequestV1Schema,
  classifyScaBrokerIdempotency,
  scaBrokerExecuteRequestSha256,
  scaBrokerSchemaSha256,
  validateScaBrokerCancelRequestV1,
  validateScaBrokerCancelResultV1,
  validateScaBrokerCapabilityRequestV1,
  validateScaBrokerCapabilityResultV1,
  validateScaBrokerExecuteAcceptedResultV1,
  validateScaBrokerExecuteRequestV1,
  validateScaBrokerPollRequestV1,
  validateScaBrokerPollResultV1,
  validateScaBrokerReceiptV1,
  validateScaBrokerSchemaDigestManifestV1,
  validateScaBrokerTypedErrorV1,
  type ScaBrokerCancelRequestV1,
  type ScaBrokerCancelResultV1,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerPollRequestV1,
  type ScaBrokerReceiptV1,
  type ScaBrokerTerminalStatus,
  type ScaBrokerTypedErrorV1,
} from "../src/sca/broker-contracts.js";

const RUN_ID = "run-sca-broker-001";
const NOW = "2026-09-16T12:00:00.000Z";
const DEADLINE = "2026-09-16T12:05:00.000Z";
const TERMINAL_AT = "2026-09-16T12:00:01.000Z";

type BrokerOperationInput = ScaBrokerExecuteRequestV1["operation_input"];
type SourceExecuteRequest = ScaBrokerExecuteRequestV1 & {
  readonly operation_input: Extract<BrokerOperationInput, { readonly kind: "source_query" }>;
};
type GraphExecuteRequest = ScaBrokerExecuteRequestV1 & {
  readonly operation_input: Extract<BrokerOperationInput, { readonly kind: "graph_query" }>;
};
type ApplicationExecuteRequest = ScaBrokerExecuteRequestV1 & {
  readonly operation_input: Extract<BrokerOperationInput, { readonly kind: "application_test" }>;
};

function artifactRef(kind: string, operationId: string, runId = RUN_ID): CurrentArtifactRef {
  const identity = {
    branch_id: null,
    kind,
    operation_id: operationId,
    phase: "application",
    run_id: runId,
    version: 1,
  };
  const contentDigest = sha256(`${runId}:${kind}:${operationId}:content`);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(canonicalJson(identity))}`,
    run_id: runId,
    phase: "application",
    branch_id: null,
    kind,
    operation_id: operationId,
    version: 1,
    producer: "sca-fixture",
    media_type: "application/json",
    byte_length: 128,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

function orderedRefs(...refs: CurrentArtifactRef[]): CurrentArtifactRef[] {
  return [...refs].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function requestBase() {
  return {
    schema_id: "penny.sca-broker-execute-request.v1" as const,
    schema_version: 1 as const,
    tenant_id: "tenant-001",
    project_id: "project-001",
    run_id: RUN_ID,
    job_id: "job-001",
    attempt: 1,
    idempotency_key: "idem-001",
    submitted_at: NOW,
    deadline_at: DEADLINE,
    limits: {
      timeout_ms: 300_000,
      max_output_bytes: 1_048_576,
      max_result_items: 1_000,
    },
    source_snapshot_ref: artifactRef("source-snapshot", "snapshot-001"),
    config_ref: artifactRef("sca-config", "config-001"),
  };
}

function sourceRequest(): SourceExecuteRequest {
  return {
    ...requestBase(),
    tool_name: "sca_source_query",
    operation: "source_query",
    input_refs: [],
    operation_input: {
      kind: "source_query",
      query_id: "source.symbol.references",
      selectors: [
        {
          path: "src/example.ts",
          line_range: { start_line: 10, end_line_exclusive: 30 },
          symbol: "ExampleService",
        },
      ],
      parameters: [
        { name: "include_tests", value: { kind: "boolean", value: false } },
        { name: "max_depth", value: { kind: "integer", value: 3 } },
      ],
    },
  };
}

function graphRequest(): GraphExecuteRequest {
  const graphRef = artifactRef("sca-graph", "graph-001");
  return {
    ...requestBase(),
    job_id: "job-graph-001",
    idempotency_key: "idem-graph-001",
    tool_name: "sca_graph_query",
    operation: "graph_query",
    input_refs: [graphRef],
    operation_input: {
      kind: "graph_query",
      graph_ref: graphRef,
      query_id: "graph.dependency.neighbors",
      selectors: [{ path: "src/example.ts", line_range: null, symbol: null }],
      parameters: [{ name: "direction", value: { kind: "identifier", value: "outgoing" } }],
    },
  };
}

function applicationRequest(): ApplicationExecuteRequest {
  const executionPlanRef = artifactRef("sca-execution-plan", "plan-001");
  const policyRef = artifactRef("sca-execution-policy", "policy-001");
  return {
    ...requestBase(),
    job_id: "job-application-001",
    idempotency_key: "idem-application-001",
    tool_name: "sca_application_test",
    operation: "application_test",
    input_refs: orderedRefs(executionPlanRef, policyRef),
    operation_input: {
      kind: "application_test",
      execution_plan_ref: executionPlanRef,
      policy_ref: policyRef,
    },
  };
}

function pollRequest(request: ScaBrokerExecuteRequestV1): ScaBrokerPollRequestV1 {
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
    requested_at: NOW,
    deadline_at: DEADLINE,
    poll_timeout_ms: 30_000,
  };
}

function typedError(code: ScaBrokerTypedErrorV1["code"]): ScaBrokerTypedErrorV1 {
  return { code, message: `fixture ${code}` };
}

function terminalReceipt(input: {
  readonly request: ScaBrokerExecuteRequestV1;
  readonly status?: ScaBrokerTerminalStatus;
  readonly outputRefs?: readonly CurrentArtifactRef[];
  readonly failure?: ScaBrokerTypedErrorV1 | null;
  readonly partial?: boolean;
  readonly truncated?: boolean;
  readonly resultItemCount?: number;
  readonly acceptedAt?: string;
  readonly terminalAt?: string;
}): ScaBrokerReceiptV1 {
  const status = input.status ?? "succeeded";
  const outputRefs = input.outputRefs ?? [artifactRef("sca-query-result", "output-001")];
  return {
    schema_id: "penny.sca-broker-receipt.v1",
    schema_version: 1,
    tenant_id: input.request.tenant_id,
    project_id: input.request.project_id,
    run_id: input.request.run_id,
    job_id: input.request.job_id,
    attempt: input.request.attempt,
    idempotency_key: input.request.idempotency_key,
    receipt_id: `receipt-${input.request.job_id}`,
    tool_name: input.request.tool_name,
    operation: input.request.operation,
    request_sha256: scaBrokerExecuteRequestSha256(input.request),
    limits: input.request.limits,
    terminal_status: status,
    partial: input.partial ?? false,
    truncated: input.truncated ?? false,
    source_snapshot_ref: input.request.source_snapshot_ref,
    config_ref: input.request.config_ref,
    input_refs: input.request.input_refs,
    output_refs: orderedRefs(...outputRefs),
    result_item_count: input.resultItemCount ?? outputRefs.length,
    failure: input.failure ?? null,
    accepted_at: input.acceptedAt ?? NOW,
    terminal_at: input.terminalAt ?? TERMINAL_AT,
  };
}

function terminalPollResult(receipt: ScaBrokerReceiptV1) {
  return {
    schema_id: "penny.sca-broker-poll-result.v1" as const,
    schema_version: 1 as const,
    tenant_id: receipt.tenant_id,
    project_id: receipt.project_id,
    run_id: receipt.run_id,
    job_id: receipt.job_id,
    attempt: receipt.attempt,
    idempotency_key: receipt.idempotency_key,
    tool_name: receipt.tool_name,
    operation: receipt.operation,
    request_sha256: receipt.request_sha256,
    status: receipt.terminal_status,
    partial: receipt.partial,
    truncated: receipt.truncated,
    output_refs: receipt.output_refs,
    result_item_count: receipt.result_item_count,
    failure: receipt.failure,
    receipt,
    observed_at: TERMINAL_AT,
  };
}

function expectConflict(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code: "conflict" });
    return;
  }
  throw new Error("expected a conflict error");
}

function cancelRequest(request: ScaBrokerExecuteRequestV1): ScaBrokerCancelRequestV1 {
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
    requested_at: NOW,
    deadline_at: DEADLINE,
    timeout_ms: 30_000,
  };
}

function terminalCancelResult(
  request: ScaBrokerCancelRequestV1,
  receipt: ScaBrokerReceiptV1
): ScaBrokerCancelResultV1 {
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
    outcome: "terminal",
    terminal_status: receipt.terminal_status,
    receipt,
    error: null,
    observed_at: TERMINAL_AT,
  };
}

function expectTerminalRoutesToReject(
  execute: ScaBrokerExecuteRequestV1,
  receipt: ScaBrokerReceiptV1,
  expected: RegExp
): void {
  const poll = pollRequest(execute);
  expect(() => validateScaBrokerPollResultV1(terminalPollResult(receipt), poll, execute)).toThrow(
    expected
  );
  const cancel = cancelRequest(execute);
  expect(() =>
    validateScaBrokerCancelResultV1(terminalCancelResult(cancel, receipt), cancel, execute)
  ).toThrow(expected);
}

describe("S-03-T1 SCA broker TypeBox v1 contract", () => {
  it("freezes exactly three model-facing tools and their operation mapping", () => {
    expect(SCA_MODEL_TOOL_ROSTER).toEqual([
      "sca_source_query",
      "sca_graph_query",
      "sca_application_test",
    ]);
    expect(SCA_TOOL_OPERATION_MAP).toEqual({
      sca_source_query: "source_query",
      sca_graph_query: "graph_query",
      sca_application_test: "application_test",
    });
    expect(Object.isFrozen(SCA_MODEL_TOOL_ROSTER)).toBe(true);
    expect(Object.isFrozen(SCA_TOOL_OPERATION_MAP)).toBe(true);
  });

  it("round-trips capability requests and available or unavailable results", () => {
    const request = {
      schema_id: "penny.sca-broker-capability-request.v1",
      schema_version: 1,
      tenant_id: "tenant-001",
      project_id: "project-001",
      run_id: RUN_ID,
      request_id: "capability-001",
      tool_name: "sca_source_query",
      operation: "source_query",
      requested_at: NOW,
      deadline_at: DEADLINE,
      timeout_ms: 30_000,
    };
    const parsedRequest = validateScaBrokerCapabilityRequestV1(request);
    expect(parsedRequest).toEqual(request);

    const available = {
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
      observed_at: NOW,
    };
    expect(validateScaBrokerCapabilityResultV1(available, parsedRequest)).toEqual(available);

    const unavailable = {
      ...available,
      status: "unavailable",
      limits: null,
      error: typedError("service_unavailable"),
    };
    expect(validateScaBrokerCapabilityResultV1(unavailable, parsedRequest)).toEqual(unavailable);
  });

  it("round-trips every execute operation and an exact accepted result", () => {
    for (const request of [sourceRequest(), graphRequest(), applicationRequest()]) {
      const parsed = validateScaBrokerExecuteRequestV1(request);
      expect(parsed).toEqual(request);
      const accepted = {
        schema_id: "penny.sca-broker-execute-accepted-result.v1",
        schema_version: 1,
        tenant_id: request.tenant_id,
        project_id: request.project_id,
        run_id: request.run_id,
        job_id: request.job_id,
        attempt: request.attempt,
        idempotency_key: request.idempotency_key,
        tool_name: request.tool_name,
        operation: request.operation,
        status: "accepted",
        request_sha256: scaBrokerExecuteRequestSha256(request),
        accepted_at: NOW,
      };
      expect(validateScaBrokerExecuteAcceptedResultV1(accepted, request)).toEqual(accepted);
    }
  });

  it("round-trips poll, receipt, and cancel families without treating cancel ack as terminal", () => {
    const execute = sourceRequest();
    const poll = pollRequest(execute);
    expect(validateScaBrokerPollRequestV1(poll)).toEqual(poll);

    const running = {
      schema_id: "penny.sca-broker-poll-result.v1",
      schema_version: 1,
      tenant_id: execute.tenant_id,
      project_id: execute.project_id,
      run_id: execute.run_id,
      job_id: execute.job_id,
      attempt: execute.attempt,
      idempotency_key: execute.idempotency_key,
      tool_name: execute.tool_name,
      operation: execute.operation,
      request_sha256: poll.request_sha256,
      status: "running",
      partial: false,
      truncated: false,
      output_refs: [],
      result_item_count: 0,
      failure: null,
      receipt: null,
      observed_at: NOW,
    };
    expect(validateScaBrokerPollResultV1(running, poll)).toEqual(running);
    expect(() => validateScaBrokerPollResultV1({ ...running, result_item_count: 1 }, poll)).toThrow(
      /nonterminal status requires zero result_item_count/u
    );
    expect(() =>
      validateScaBrokerPollResultV1({ ...running, request_sha256: "f".repeat(64) }, poll)
    ).toThrow(/request_sha256/u);

    const receipt = terminalReceipt({ request: execute });
    expect(validateScaBrokerReceiptV1(receipt, execute)).toEqual(receipt);
    const terminal = terminalPollResult(receipt);
    expect(validateScaBrokerPollResultV1(terminal, poll, execute)).toEqual(terminal);

    const cancel = cancelRequest(execute);
    expect(validateScaBrokerCancelRequestV1(cancel)).toEqual(cancel);
    const acknowledged = {
      schema_id: "penny.sca-broker-cancel-result.v1",
      schema_version: 1,
      tenant_id: cancel.tenant_id,
      project_id: cancel.project_id,
      run_id: cancel.run_id,
      job_id: cancel.job_id,
      attempt: cancel.attempt,
      idempotency_key: cancel.idempotency_key,
      tool_name: cancel.tool_name,
      operation: cancel.operation,
      request_sha256: cancel.request_sha256,
      outcome: "cancel_requested",
      terminal_status: null,
      receipt: null,
      error: null,
      observed_at: NOW,
    };
    expect(validateScaBrokerCancelResultV1(acknowledged, cancel)).toEqual(acknowledged);
    expect(() =>
      validateScaBrokerCancelResultV1({ ...acknowledged, request_sha256: "f".repeat(64) }, cancel)
    ).toThrow(/request_sha256/u);
    expect(
      validateScaBrokerCancelResultV1(
        {
          ...acknowledged,
          outcome: "terminal",
          terminal_status: receipt.terminal_status,
          receipt,
        },
        cancel,
        execute
      )
    ).toMatchObject({ outcome: "terminal", terminal_status: "succeeded" });
    expect(
      validateScaBrokerCancelResultV1(
        {
          ...acknowledged,
          outcome: "rejected",
          error: typedError("unauthorized"),
        },
        cancel
      )
    ).toMatchObject({ outcome: "rejected", error: { code: "unauthorized" } });
  });

  it("requires exact execute context and bindings for terminal poll and cancel results", () => {
    const execute = sourceRequest();
    const receipt = terminalReceipt({ request: execute });
    const poll = pollRequest(execute);
    const terminalPoll = terminalPollResult(receipt);
    const cancel = cancelRequest(execute);
    const terminalCancel = terminalCancelResult(cancel, receipt);

    expect(() => validateScaBrokerPollResultV1(terminalPoll, poll)).toThrow(
      /terminal result requires the exact execute request context/u
    );
    expect(() => validateScaBrokerCancelResultV1(terminalCancel, cancel)).toThrow(
      /terminal result requires the exact execute request context/u
    );

    const invalidExecute = { ...execute, deadline_at: execute.submitted_at };
    expect(() => validateScaBrokerPollResultV1(terminalPoll, poll, invalidExecute)).toThrow(
      /deadline must be after/u
    );

    const unboundPoll = { ...poll, request_sha256: "f".repeat(64) };
    expect(() =>
      validateScaBrokerPollResultV1(
        { ...terminalPoll, request_sha256: unboundPoll.request_sha256 },
        unboundPoll,
        execute
      )
    ).toThrow(/request_sha256 must bind the exact execute request/u);

    const foreignExecute = { ...execute, project_id: "project-other" };
    expect(() => validateScaBrokerCancelResultV1(terminalCancel, cancel, foreignExecute)).toThrow(
      /bindings must match/u
    );
  });

  it("rejects capability, poll, and cancel results observed outside their request windows", () => {
    const capabilityRequest = validateScaBrokerCapabilityRequestV1({
      schema_id: "penny.sca-broker-capability-request.v1",
      schema_version: 1,
      tenant_id: "tenant-001",
      project_id: "project-001",
      run_id: RUN_ID,
      request_id: "capability-observed-at",
      tool_name: "sca_source_query",
      operation: "source_query",
      requested_at: NOW,
      deadline_at: DEADLINE,
      timeout_ms: 30_000,
    });
    const capabilityResult = {
      schema_id: "penny.sca-broker-capability-result.v1",
      schema_version: 1,
      tenant_id: capabilityRequest.tenant_id,
      project_id: capabilityRequest.project_id,
      run_id: capabilityRequest.run_id,
      request_id: capabilityRequest.request_id,
      tool_name: capabilityRequest.tool_name,
      operation: capabilityRequest.operation,
      status: "unavailable",
      limits: null,
      error: typedError("service_unavailable"),
      observed_at: NOW,
    };

    const execute = sourceRequest();
    const poll = pollRequest(execute);
    const runningPollResult = {
      schema_id: "penny.sca-broker-poll-result.v1",
      schema_version: 1,
      tenant_id: poll.tenant_id,
      project_id: poll.project_id,
      run_id: poll.run_id,
      job_id: poll.job_id,
      attempt: poll.attempt,
      idempotency_key: poll.idempotency_key,
      tool_name: poll.tool_name,
      operation: poll.operation,
      request_sha256: poll.request_sha256,
      status: "running",
      partial: false,
      truncated: false,
      output_refs: [],
      result_item_count: 0,
      failure: null,
      receipt: null,
      observed_at: NOW,
    };

    const cancel = cancelRequest(execute);
    const acknowledgedCancelResult = {
      schema_id: "penny.sca-broker-cancel-result.v1",
      schema_version: 1,
      tenant_id: cancel.tenant_id,
      project_id: cancel.project_id,
      run_id: cancel.run_id,
      job_id: cancel.job_id,
      attempt: cancel.attempt,
      idempotency_key: cancel.idempotency_key,
      tool_name: cancel.tool_name,
      operation: cancel.operation,
      request_sha256: cancel.request_sha256,
      outcome: "cancel_requested",
      terminal_status: null,
      receipt: null,
      error: null,
      observed_at: NOW,
    };

    for (const { observedAt, expectedError } of [
      {
        observedAt: "2026-09-16T11:59:59.999999999Z",
        expectedError: /observed_at precedes the request/u,
      },
      {
        observedAt: "2026-09-16T12:05:00.000000001Z",
        expectedError: /observed_at exceeds the request deadline/u,
      },
    ]) {
      expect(() =>
        validateScaBrokerCapabilityResultV1(
          { ...capabilityResult, observed_at: observedAt },
          capabilityRequest
        )
      ).toThrow(expectedError);
      expect(() =>
        validateScaBrokerPollResultV1({ ...runningPollResult, observed_at: observedAt }, poll)
      ).toThrow(expectedError);
      expect(() =>
        validateScaBrokerCancelResultV1(
          { ...acknowledgedCancelResult, observed_at: observedAt },
          cancel
        )
      ).toThrow(expectedError);
    }
  });

  it("round-trips every typed error code", () => {
    const codes: ScaBrokerTypedErrorV1["code"][] = [
      "service_unavailable",
      "unsupported_operation",
      "invalid_request",
      "unauthorized",
      "conflict",
      "quota_exceeded",
      "timeout",
      "cancelled",
      "failed",
      "output_truncated",
    ];
    for (const code of codes) {
      expect(validateScaBrokerTypedErrorV1(typedError(code))).toEqual(typedError(code));
    }
  });

  it("rejects wrong tool/operation pairs, unknown operations, and cross-request bindings", () => {
    const execute = sourceRequest();
    expect(() =>
      validateScaBrokerExecuteRequestV1({ ...execute, operation: "graph_query" })
    ).toThrow(/cannot request operation/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({ ...execute, operation: "native_query" })
    ).toThrow(/schema validation/u);

    const accepted = {
      schema_id: "penny.sca-broker-execute-accepted-result.v1",
      schema_version: 1,
      tenant_id: execute.tenant_id,
      project_id: execute.project_id,
      run_id: execute.run_id,
      job_id: execute.job_id,
      attempt: execute.attempt,
      idempotency_key: execute.idempotency_key,
      tool_name: execute.tool_name,
      operation: execute.operation,
      status: "accepted",
      request_sha256: scaBrokerExecuteRequestSha256(execute),
      accepted_at: NOW,
    };
    expect(() =>
      validateScaBrokerExecuteAcceptedResultV1(
        { ...accepted, tenant_id: "another-tenant" },
        execute
      )
    ).toThrow(/bindings must match/u);
    expect(() =>
      validateScaBrokerExecuteAcceptedResultV1(
        { ...accepted, request_sha256: "f".repeat(64) },
        execute
      )
    ).toThrow(/exact request/u);
  });

  it("rejects unknown fields and caller-controlled execution authority", () => {
    const source = sourceRequest();
    for (const forbidden of [
      { host_path: "/tmp/source" },
      { shell: "rm -rf /" },
      { destination: "outside" },
      { image: "arbitrary:latest" },
      { mounts: ["/:/host"] },
      { network: "host" },
      { credentials: "secret" },
    ]) {
      expect(() => validateScaBrokerExecuteRequestV1({ ...source, ...forbidden })).toThrow(
        /schema validation/u
      );
    }

    const application = applicationRequest();
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...application,
        operation_input: { ...application.operation_input, command: ["bun", "test"] },
      })
    ).toThrow(/schema validation/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...application,
        operation_input: { ...application.operation_input, authorized: true },
      })
    ).toThrow(/schema validation/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...source,
        operation_input: {
          ...source.operation_input,
          selectors: [
            {
              ...source.operation_input.selectors[0],
              recursive: true,
            },
          ],
        },
      })
    ).toThrow(/schema validation/u);
  });

  it("accepts only canonical same-run exact artifact refs", () => {
    const request = sourceRequest();
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        source_snapshot_ref: {
          ...request.source_snapshot_ref,
          artifact_id: `art_${"f".repeat(64)}`,
        },
      })
    ).toThrow(/canonical identity/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        config_ref: artifactRef("sca-config", "config-other", "run-other"),
      })
    ).toThrow(/bound run/u);

    const application = applicationRequest();
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...application,
        input_refs: [application.operation_input.execution_plan_ref],
      })
    ).toThrow(/only the exact execution plan and policy refs/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...application,
        operation_input: {
          ...application.operation_input,
          execution_plan_ref: artifactRef("sca-input", "not-a-plan"),
        },
      })
    ).toThrow(/sca-execution-plan/u);

    const graph = graphRequest();
    expect(() => validateScaBrokerExecuteRequestV1({ ...graph, input_refs: [] })).toThrow(
      /exact operation artifact ref/u
    );

    const tooManyInputs = orderedRefs(
      ...Array.from({ length: SCA_BROKER_CONTRACT_LIMITS_V1.max_input_refs + 1 }, (_, index) =>
        artifactRef("sca-input", `input-${index}`)
      )
    );
    expect(() =>
      validateScaBrokerExecuteRequestV1({ ...request, input_refs: tooManyInputs })
    ).toThrow(/schema validation/u);

    const receipt = terminalReceipt({ request });
    expect(() =>
      validateScaBrokerReceiptV1({
        ...receipt,
        output_refs: [artifactRef("sca-query-result", "cross-run-output", "run-other")],
      })
    ).toThrow(/bound run/u);
  });

  it("rejects absolute, traversing, noncanonical, duplicate, and oversized selectors or parameters", () => {
    const request = sourceRequest();
    const selector = request.operation_input.selectors[0];
    for (const path of ["/etc/passwd", "../secret", "src/../secret", "C:\\secret", "src//x.ts"]) {
      expect(() =>
        validateScaBrokerExecuteRequestV1({
          ...request,
          operation_input: {
            ...request.operation_input,
            selectors: [{ ...selector, path }],
          },
        })
      ).toThrow(/repository-relative path/u);
    }
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        operation_input: {
          ...request.operation_input,
          selectors: [{ ...selector, path: "a".repeat(1_025) }],
        },
      })
    ).toThrow();
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        operation_input: {
          ...request.operation_input,
          selectors: [selector, selector],
        },
      })
    ).toThrow(/selectors must be unique/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        operation_input: {
          ...request.operation_input,
          parameters: [
            { name: "same", value: { kind: "boolean", value: true } },
            { name: "same", value: { kind: "integer", value: 1 } },
          ],
        },
      })
    ).toThrow(/parameter names must be unique/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        operation_input: {
          ...request.operation_input,
          parameters: Array.from(
            { length: SCA_BROKER_CONTRACT_LIMITS_V1.max_parameters + 1 },
            (_, index) => ({
              name: `parameter_${index}`,
              value: { kind: "boolean", value: true },
            })
          ),
        },
      })
    ).toThrow(/schema validation/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        operation_input: {
          ...request.operation_input,
          parameters: [
            {
              name: "unknown_field",
              value: { kind: "boolean", value: true },
              command: "not-data",
            },
          ],
        },
      })
    ).toThrow(/schema validation/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        operation_input: {
          ...request.operation_input,
          parameters: [
            {
              name: "oversized_literal",
              value: { kind: "literal", value: "x".repeat(1_025) },
            },
          ],
        },
      })
    ).toThrow(/schema validation/u);
  });

  it("rejects zero, negative, fractional, unsafe, oversized, and incoherent limits", () => {
    const request = sourceRequest();
    for (const timeoutMs of [0, -1, 1.5, SCA_BROKER_CONTRACT_LIMITS_V1.max_timeout_ms + 1]) {
      expect(() =>
        validateScaBrokerExecuteRequestV1({
          ...request,
          limits: { ...request.limits, timeout_ms: timeoutMs },
        })
      ).toThrow();
    }
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        limits: { ...request.limits, max_output_bytes: 0 },
      })
    ).toThrow();
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        limits: {
          ...request.limits,
          max_result_items: SCA_BROKER_CONTRACT_LIMITS_V1.max_result_items + 1,
        },
      })
    ).toThrow();
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        deadline_at: "2026-09-16T12:00:00.000Z",
      })
    ).toThrow(/deadline/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        deadline_at: "2026-09-18T12:00:00.000Z",
      })
    ).toThrow(/safe maximum/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        submitted_at: "2026-02-30T12:00:00.000Z",
      })
    ).toThrow(/invalid calendar/u);
    expect(() =>
      validateScaBrokerExecuteRequestV1({
        ...request,
        unknown_payload: "x".repeat(SCA_BROKER_CONTRACT_LIMITS_V1.max_request_bytes + 1),
      })
    ).toThrow(/byte limit/u);
  });

  it("classifies exact idempotent retries and rejects conflicting reuse", () => {
    const request = sourceRequest();
    expect(classifyScaBrokerIdempotency(request, structuredClone(request))).toBe("duplicate");
    expect(
      classifyScaBrokerIdempotency(request, {
        ...request,
        job_id: "job-distinct",
        idempotency_key: "idem-distinct",
      })
    ).toBe("distinct");

    const changedInput = structuredClone(request);
    if (changedInput.operation_input.kind !== "source_query") {
      throw new Error("fixture operation changed unexpectedly");
    }
    changedInput.operation_input.query_id = "source.symbol.definitions";
    expectConflict(() => classifyScaBrokerIdempotency(request, changedInput));
    expectConflict(() =>
      classifyScaBrokerIdempotency(request, { ...request, job_id: "job-conflict" })
    );
    expectConflict(() =>
      classifyScaBrokerIdempotency(request, { ...request, idempotency_key: "other-key" })
    );
  });

  it("rejects a receipt whose terminal_at is after the execute deadline", () => {
    const request = sourceRequest();
    const receipt = terminalReceipt({
      request,
      acceptedAt: TERMINAL_AT,
      terminalAt: "2026-09-16T12:05:00.000000001Z",
    });
    expectTerminalRoutesToReject(request, receipt, /terminal_at exceeds the execute deadline/u);
  });

  it("rejects an accepted_at-to-terminal duration beyond timeout_ms", () => {
    const request = {
      ...sourceRequest(),
      limits: {
        ...sourceRequest().limits,
        timeout_ms: 1_000,
      },
    };
    const receipt = terminalReceipt({
      request,
      terminalAt: "2026-09-16T12:00:01.000000001Z",
    });
    expectTerminalRoutesToReject(
      request,
      receipt,
      /accepted_at-to-terminal duration exceeds limits\.timeout_ms/u
    );
  });

  it("rejects total declared output_ref bytes over max_output_bytes", () => {
    const request = sourceRequest();
    const declaredBytes = Math.floor(request.limits.max_output_bytes / 2) + 1;
    const firstOutput = {
      ...artifactRef("sca-query-result", "oversized-output-001"),
      byte_length: declaredBytes,
    };
    const secondOutput = {
      ...artifactRef("sca-query-result", "oversized-output-002"),
      byte_length: declaredBytes,
    };
    const receipt = terminalReceipt({ request, outputRefs: [firstOutput, secondOutput] });
    expectTerminalRoutesToReject(
      request,
      receipt,
      /total declared output_ref byte_length exceeds limits\.max_output_bytes/u
    );
  });

  it("rejects result_item_count over max_result_items and nonzero counts without output", () => {
    const request = sourceRequest();
    const overBudget = terminalReceipt({
      request,
      resultItemCount: request.limits.max_result_items + 1,
    });
    expectTerminalRoutesToReject(
      request,
      overBudget,
      /result_item_count exceeds limits\.max_result_items/u
    );

    const withoutOutput = terminalReceipt({
      request,
      status: "failed",
      outputRefs: [],
      resultItemCount: 1,
      failure: typedError("failed"),
    });
    expect(() => validateScaBrokerReceiptV1(withoutOutput, request)).toThrow(
      /result_item_count must be zero when no output_refs are declared/u
    );
  });

  it("rejects receipt limits that do not exactly match the execute request", () => {
    const request = sourceRequest();
    const receipt = terminalReceipt({ request });
    expectTerminalRoutesToReject(
      request,
      {
        ...receipt,
        limits: {
          ...receipt.limits,
          max_output_bytes: receipt.limits.max_output_bytes - 1,
        },
      },
      /receipt limits must match the exact request limits/u
    );
  });

  it("enforces timeout and cancellation terminal truth", () => {
    const request = sourceRequest();
    const output = artifactRef("sca-query-result", "partial-output");
    const timedOut = terminalReceipt({
      request,
      status: "timed_out",
      outputRefs: [output],
      failure: typedError("timeout"),
      partial: true,
    });
    expect(validateScaBrokerReceiptV1(timedOut, request)).toEqual(timedOut);
    const cancelled = terminalReceipt({
      request,
      status: "cancelled",
      outputRefs: [],
      failure: typedError("cancelled"),
    });
    expect(validateScaBrokerReceiptV1(cancelled, request)).toEqual(cancelled);
    expect(() =>
      validateScaBrokerReceiptV1({ ...timedOut, terminal_status: "failed" }, request)
    ).toThrow(/matching terminal status/u);
    expect(() =>
      validateScaBrokerReceiptV1({ ...cancelled, failure: typedError("failed") }, request)
    ).toThrow(/requires cancelled/u);

    const cancel = cancelRequest(request);
    const acknowledged = {
      schema_id: "penny.sca-broker-cancel-result.v1",
      schema_version: 1,
      tenant_id: cancel.tenant_id,
      project_id: cancel.project_id,
      run_id: cancel.run_id,
      job_id: cancel.job_id,
      attempt: cancel.attempt,
      idempotency_key: cancel.idempotency_key,
      tool_name: cancel.tool_name,
      operation: cancel.operation,
      request_sha256: cancel.request_sha256,
      outcome: "cancel_requested",
      terminal_status: null,
      receipt: null,
      error: null,
      observed_at: NOW,
    };
    expect(() =>
      validateScaBrokerCancelResultV1({ ...acknowledged, terminal_status: "cancelled" }, cancel)
    ).toThrow(/not a terminal claim/u);
    expect(() =>
      validateScaBrokerCancelResultV1(
        { ...acknowledged, outcome: "rejected", error: typedError("cancelled") },
        cancel
      )
    ).toThrow(/reported by a receipt/u);
  });

  it("links receipts to declared outputs and reports failure, partial, and truncation truthfully", () => {
    const request = sourceRequest();
    const output = artifactRef("sca-query-result", "output-truncated");
    const truncatedReceipt = terminalReceipt({
      request,
      status: "failed",
      outputRefs: [output],
      failure: typedError("output_truncated"),
      partial: true,
      truncated: true,
    });
    expect(validateScaBrokerReceiptV1(truncatedReceipt, request)).toEqual(truncatedReceipt);
    const poll = pollRequest(request);
    expect(
      validateScaBrokerPollResultV1(terminalPollResult(truncatedReceipt), poll, request)
    ).toMatchObject({
      status: "failed",
      partial: true,
      truncated: true,
      result_item_count: 1,
    });

    expect(() =>
      validateScaBrokerReceiptV1(
        { ...truncatedReceipt, output_refs: [], result_item_count: 0, partial: false },
        request
      )
    ).toThrow(/retained partial output/u);
    expect(() =>
      validateScaBrokerReceiptV1(
        {
          ...terminalReceipt({ request }),
          partial: true,
          truncated: true,
        },
        request
      )
    ).toThrow(/succeeded requires/u);

    const otherOutput = artifactRef("sca-query-result", "other-output");
    expect(() =>
      validateScaBrokerPollResultV1(
        {
          ...terminalPollResult(truncatedReceipt),
          output_refs: [otherOutput],
        },
        poll,
        request
      )
    ).toThrow(/receipt must match/u);
    expect(() =>
      validateScaBrokerPollResultV1(
        {
          ...terminalPollResult(truncatedReceipt),
          result_item_count: truncatedReceipt.result_item_count + 1,
        },
        poll,
        request
      )
    ).toThrow(/receipt must match/u);
  });

  it("prevents service_unavailable from claiming capability success or output", () => {
    const capabilityRequest = validateScaBrokerCapabilityRequestV1({
      schema_id: "penny.sca-broker-capability-request.v1",
      schema_version: 1,
      tenant_id: "tenant-001",
      project_id: "project-001",
      run_id: RUN_ID,
      request_id: "capability-001",
      tool_name: "sca_source_query",
      operation: "source_query",
      requested_at: NOW,
      deadline_at: DEADLINE,
      timeout_ms: 30_000,
    });
    expect(() =>
      validateScaBrokerCapabilityResultV1(
        {
          schema_id: "penny.sca-broker-capability-result.v1",
          schema_version: 1,
          tenant_id: capabilityRequest.tenant_id,
          project_id: capabilityRequest.project_id,
          run_id: capabilityRequest.run_id,
          request_id: capabilityRequest.request_id,
          tool_name: capabilityRequest.tool_name,
          operation: capabilityRequest.operation,
          status: "available",
          limits: null,
          error: typedError("service_unavailable"),
          observed_at: NOW,
        },
        capabilityRequest
      )
    ).toThrow(/available requires/u);

    const request = sourceRequest();
    const unavailableReceipt = terminalReceipt({
      request,
      status: "failed",
      outputRefs: [],
      failure: typedError("service_unavailable"),
    });
    expect(validateScaBrokerReceiptV1(unavailableReceipt, request)).toEqual(unavailableReceipt);

    const output = artifactRef("sca-query-result", "unavailable-output");
    const receiptWithOutput = terminalReceipt({
      request,
      status: "failed",
      outputRefs: [output],
      failure: typedError("service_unavailable"),
      partial: true,
    });
    expect(() => validateScaBrokerReceiptV1(receiptWithOutput, request)).toThrow(
      /cannot claim output/u
    );
  });

  it("publishes one deterministic digest manifest for both future consumers", () => {
    expect(validateScaBrokerSchemaDigestManifestV1(SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1)).toEqual(
      SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1
    );
    expect(SCA_BROKER_SCHEMA_MANIFEST_SHA256).toBe(
      "a96a2e8371d0d5b123be7ef4fb725a5cf29264034030c2cef7b5bf96ea18b715"
    );
    expect(SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1.consumers).toEqual([
      expect.objectContaining({
        module_path: "apps/sca-service/src/contracts.ts",
        integration: "generated_digest_lock_v1",
      }),
      expect.objectContaining({
        module_path: ".pi/extensions/sca/src/contracts.ts",
        integration: "generated_digest_lock_v1",
      }),
    ]);
    expect(
      scaBrokerSchemaSha256({
        ...ScaBrokerExecuteRequestV1Schema,
        title: "schema mutation",
      })
    ).not.toBe(scaBrokerSchemaSha256(ScaBrokerExecuteRequestV1Schema));

    const changedManifest = {
      ...SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1,
      manifest_sha256: "f".repeat(64),
    };
    expect(() => validateScaBrokerSchemaDigestManifestV1(changedManifest)).toThrow(
      /manifest_sha256/u
    );
  });
});
