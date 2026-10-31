import { describe, expect, it } from "vitest";

import { sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  admitScaStrongerExecutionV1,
  buildScaStrongerExecutionProposalV1,
  sealScaHumanAuthorizationDecisionV1,
} from "../../orchestration/dist/sca/human-authorization.js";
import { attachScaExecutionEvidenceV1 } from "../src/evidence-tools.js";
import {
  ScaSandboxRuntimeError,
  buildScaSandboxProfileV1,
  executeScaEvidenceV1,
  scaEvidenceActionPlanSha256,
  validateScaEvidenceExecutionReceiptV1,
  validateScaSandboxProfileV1,
  type ScaSandboxExecutionSpecV1,
} from "../src/sandbox-runtime.js";

const SNAPSHOT = "a".repeat(64);

function profile() {
  return buildScaSandboxProfileV1({
    schema_id: "penny.sca-sandbox-profile-input.v1",
    schema_version: 1,
    profile_id: "node-sandbox-v1",
    isolation_backend: "container",
    read_only_source: true,
    read_only_root_filesystem: true,
    no_new_privileges: true,
    network_policy: "none",
    fixed_network_destinations: [],
    capabilities: ["filesystem:source:read", "network:none", "process:bounded"],
    runtime_executable: "/usr/bin/container-runtime",
    runtime_executable_sha256: "b".repeat(64),
    runtime_identity_sha256: "c".repeat(64),
    command_templates: [
      {
        tool_id: "node-test",
        action_type: "test",
        fixed_arguments: ["run", "--rm", "--network=none", "qualified-node-image"],
        max_extra_arguments: 4,
        allowed_environment_names: ["CI"],
      },
    ],
    limits: {
      max_timeout_ms: 60_000,
      max_stdout_bytes: 10_000,
      max_stderr_bytes: 10_000,
      max_memory_bytes: 536_870_912,
      max_cpu_millis: 60_000,
      max_processes: 64,
    },
    qualification_suite_sha256: "d".repeat(64),
    qualification_evidence_sha256: "e".repeat(64),
    qualification_status: "passed",
  });
}

function fixture() {
  const sandbox = profile();
  const capabilities = ["filesystem:source:read", "network:none", "process:bounded"];
  const plan = {
    source_snapshot_sha256: SNAPSHOT,
    sandbox_profile_sha256: sandbox.profile_sha256,
    tool_id: "node-test",
    action_type: "test" as const,
    arguments: ["test"],
    environment: [{ name: "CI", value: "1" }],
    capabilities,
    timeout_ms: 5_000,
    max_stdout_bytes: 1_024,
    max_stderr_bytes: 1_024,
  };
  const actionPlanSha256 = scaEvidenceActionPlanSha256(plan);
  const m2ManifestSha256 = "8".repeat(64);
  const proposal = buildScaStrongerExecutionProposalV1({
    schema_id: "penny.sca-stronger-execution-proposal.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: "run-sandbox",
    source_snapshot_sha256: SNAPSHOT,
    m2_manifest_sha256: m2ManifestSha256,
    proposal_id: "proposal-sandbox",
    action_type: "test",
    action_plan_sha256: actionPlanSha256,
    requested_capabilities: capabilities,
    justification: "Collect stronger evidence for the retained finding.",
    expected_discriminator: "The qualified test command exits successfully with all tests passing.",
    expires_at: "2030-01-01T01:00:00.000Z",
  });
  const decision = sealScaHumanAuthorizationDecisionV1({
    schema_id: "penny.sca-human-authorization-decision.v1",
    schema_version: 1,
    tenant_id: proposal.tenant_id,
    project_id: proposal.project_id,
    run_id: proposal.run_id,
    source_snapshot_sha256: proposal.source_snapshot_sha256,
    m2_manifest_sha256: proposal.m2_manifest_sha256,
    proposal_id: proposal.proposal_id,
    proposal_sha256: proposal.proposal_sha256,
    decision: "approved",
    human_principal_id: "operator-a",
    authority_receipt_sha256: "9".repeat(64),
    decided_at: "2030-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T01:00:00.000Z",
    decision_reason: "Approved for bounded evidence collection.",
  });
  const strongerRequest = {
    schema_id: "penny.sca-stronger-execution-request.v1",
    schema_version: 1,
    tenant_id: proposal.tenant_id,
    project_id: proposal.project_id,
    run_id: proposal.run_id,
    source_snapshot_sha256: proposal.source_snapshot_sha256,
    m2_manifest_sha256: proposal.m2_manifest_sha256,
    proposal_id: proposal.proposal_id,
    action_type: proposal.action_type,
    action_plan_sha256: proposal.action_plan_sha256,
    requested_capabilities: capabilities,
  };
  const authorization = admitScaStrongerExecutionV1(
    proposal,
    decision,
    strongerRequest,
    new Date("2030-01-01T00:30:00.000Z")
  );
  const request = {
    schema_id: "penny.sca-evidence-execution-request.v1",
    schema_version: 1,
    execution_id: "execution-a",
    source_root: "/workspace/repository",
    source_snapshot_sha256: SNAPSHOT,
    authorization,
    sandbox_profile: sandbox,
    tool_id: plan.tool_id,
    arguments: plan.arguments,
    environment: plan.environment,
    capabilities,
    timeout_ms: plan.timeout_ms,
    max_stdout_bytes: plan.max_stdout_bytes,
    max_stderr_bytes: plan.max_stderr_bytes,
  };
  return { sandbox, authorization, request };
}

function expectRuntimeError(run: () => unknown, code: ScaSandboxRuntimeError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaSandboxRuntimeError);
    if (error instanceof ScaSandboxRuntimeError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SCA sandbox error '${code}'`);
}

describe("S-07-T1 qualified evidence sandbox runtime", () => {
  it("executes only the exact approved plan through a qualified executor", async () => {
    const source = fixture();
    let observed: ScaSandboxExecutionSpecV1 | undefined;
    const receipt = await executeScaEvidenceV1(source.request, {
      now: () => new Date("2030-01-01T00:31:00.000Z"),
      executor: {
        execute: (spec) => {
          observed = spec;
          return Promise.resolve({
            process_result: {
              schema_id: "penny.sca-process-result.v1",
              schema_version: 1,
              request_sha256: "3".repeat(64),
              status: "succeeded",
              exit_code: 0,
              signal: null,
              stdout: "12 tests passed\n",
              stderr: "",
              stdout_sha256: sha256("12 tests passed\n"),
              stderr_sha256: sha256(""),
              stdout_bytes: 16,
              stderr_bytes: 0,
              stdout_truncated: false,
              stderr_truncated: false,
              failure_code: "none",
            },
            executor_receipt_sha256: "f".repeat(64),
          });
        },
      },
    });
    expect(receipt).toMatchObject({
      status: "succeeded",
      exit_code: 0,
      stdout: "12 tests passed\n",
    });
    expect(observed).toMatchObject({
      executable: "/usr/bin/container-runtime",
      source_mount: "read_only",
      root_filesystem: "read_only",
      network_policy: "none",
      arguments: ["run", "--rm", "--network=none", "qualified-node-image", "test"],
    });
    expect(validateScaEvidenceExecutionReceiptV1(receipt)).toEqual(receipt);
    const attached = attachScaExecutionEvidenceV1({
      schema_id: "penny.sca-evidence-attachment-request.v1",
      schema_version: 1,
      tenant_id: "tenant-a",
      project_id: "project-a",
      finding_set_sha256: "6".repeat(64),
      m3_manifest_sha256: "7".repeat(64),
      authorization: source.authorization,
      execution_receipt: receipt,
      finding_ids: [`scafind_${"8".repeat(64)}`],
      gap_ids: [],
      effect: "supports_finding",
      summary: "The qualified test command completed successfully.",
    });
    expect(attached).toMatchObject({
      execution_receipt_sha256: receipt.evidence_sha256,
      authorization_sha256: source.authorization.authorization_sha256,
      execution_status: "succeeded",
      effect: "supports_finding",
    });
  });

  it("denies capability, argument, and action-plan drift before invoking an executor", async () => {
    const source = fixture();
    let calls = 0;
    const executor = {
      execute: () => {
        calls += 1;
        throw new Error("must not execute");
      },
    };
    await expect(
      executeScaEvidenceV1({ ...source.request, capabilities: ["network:none"] }, { executor })
    ).rejects.toMatchObject({ code: "capability_denied" });
    await expect(
      executeScaEvidenceV1(
        { ...source.request, arguments: ["a", "b", "c", "d", "e"] },
        { executor }
      )
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(
      executeScaEvidenceV1({ ...source.request, arguments: ["changed"] }, { executor })
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(calls).toBe(0);
  });

  it("denies expired authorization and defaults to no execution without an executor", async () => {
    const source = fixture();
    await expect(
      executeScaEvidenceV1(source.request, {
        now: () => new Date("2030-01-01T02:00:00.000Z"),
      })
    ).rejects.toMatchObject({ code: "authorization_expired" });
    const unavailable = await executeScaEvidenceV1(source.request, {
      now: () => new Date("2030-01-01T00:31:00.000Z"),
    });
    expect(unavailable).toMatchObject({
      status: "unavailable",
      failure_code: "qualified_executor_unavailable",
      executor_receipt_sha256: null,
    });
  });

  it("rejects unqualified profile shape and profile digest tamper", () => {
    expectRuntimeError(
      () =>
        buildScaSandboxProfileV1({
          schema_id: "penny.sca-sandbox-profile-input.v1",
          schema_version: 1,
          profile_id: "bad",
        }),
      "invalid_profile"
    );
    const value = profile();
    expectRuntimeError(
      () => validateScaSandboxProfileV1({ ...value, profile_sha256: "0".repeat(64) }),
      "profile_digest_mismatch"
    );
    const unsigned = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "profile_sha256")
    );
    expectRuntimeError(
      () => buildScaSandboxProfileV1({ ...unsigned, runtime_executable: "relative-runtime" }),
      "qualification_invalid"
    );
  });
});
