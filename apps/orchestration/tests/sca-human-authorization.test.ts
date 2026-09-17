import { describe, expect, it } from "vitest";

import {
  ScaHumanAuthorizationError,
  admitScaStrongerExecutionV1,
  buildScaStrongerExecutionProposalV1,
  sealScaHumanAuthorizationDecisionV1,
  validateScaHumanAuthorizationDecisionV1,
  validateScaStrongerExecutionProposalV1,
} from "../src/sca/human-authorization.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");

function proposalInput() {
  return {
    schema_id: "penny.sca-stronger-execution-proposal.v1",
    schema_version: 1,
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: "run-sca-human-gate",
    source_snapshot_sha256: "a".repeat(64),
    m2_manifest_sha256: "b".repeat(64),
    proposal_id: "proposal-a",
    action_type: "harness" as const,
    action_plan_sha256: "c".repeat(64),
    requested_capabilities: ["sandboxed-node-v1", "loopback-network-v1"],
    justification: "Static evidence cannot determine the effective sanitizer behavior.",
    expected_discriminator: "The harness distinguishes encoded from executable output.",
    expires_at: "2026-09-15T13:00:00.000Z",
  };
}

function decision(
  proposal = buildScaStrongerExecutionProposalV1(proposalInput()),
  outcome: "approved" | "denied" | "expired" | "drifted" = "approved"
) {
  return sealScaHumanAuthorizationDecisionV1({
    schema_id: "penny.sca-human-authorization-decision.v1",
    schema_version: 1,
    tenant_id: proposal.tenant_id,
    project_id: proposal.project_id,
    run_id: proposal.run_id,
    source_snapshot_sha256: proposal.source_snapshot_sha256,
    m2_manifest_sha256: proposal.m2_manifest_sha256,
    proposal_id: proposal.proposal_id,
    proposal_sha256: proposal.proposal_sha256,
    decision: outcome,
    human_principal_id: "operator-a",
    authority_receipt_sha256: "d".repeat(64),
    decided_at: "2026-09-15T12:00:00.000Z",
    expires_at: "2026-09-15T12:30:00.000Z",
    decision_reason:
      outcome === "approved" ? "Approved for the isolated fixture." : "Not approved.",
  });
}

function request() {
  const input = proposalInput();
  return {
    schema_id: "penny.sca-stronger-execution-request.v1",
    schema_version: 1,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    run_id: input.run_id,
    source_snapshot_sha256: input.source_snapshot_sha256,
    m2_manifest_sha256: input.m2_manifest_sha256,
    proposal_id: input.proposal_id,
    action_type: input.action_type,
    action_plan_sha256: input.action_plan_sha256,
    requested_capabilities: [...input.requested_capabilities].reverse(),
  };
}

function expectAuthorizationError(
  run: () => unknown,
  code: ScaHumanAuthorizationError["code"]
): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaHumanAuthorizationError);
    if (error instanceof ScaHumanAuthorizationError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SCA human authorization error '${code}'`);
}

describe("S-05-T3 human authorization gate", () => {
  it("admits only the exact approved action, capabilities, snapshot, and plan", () => {
    const proposal = buildScaStrongerExecutionProposalV1(proposalInput());
    const approved = decision(proposal);
    const authorization = admitScaStrongerExecutionV1(proposal, approved, request(), NOW);
    expect(authorization).toMatchObject({
      proposal_sha256: proposal.proposal_sha256,
      decision_sha256: approved.decision_sha256,
      action_type: "harness",
      human_principal_id: "operator-a",
      expires_at: "2026-09-15T12:30:00.000Z",
    });
    expect(authorization.authorized_capabilities).toEqual([
      "loopback-network-v1",
      "sandboxed-node-v1",
    ]);
  });

  it("keeps model analysis proposals non-executable after denial or non-approval", () => {
    const proposal = buildScaStrongerExecutionProposalV1(proposalInput());
    for (const outcome of ["denied", "expired", "drifted"] as const) {
      expectAuthorizationError(
        () => admitScaStrongerExecutionV1(proposal, decision(proposal, outcome), request(), NOW),
        "not_approved"
      );
    }
  });

  it("refuses expired approval before execution", () => {
    const proposal = buildScaStrongerExecutionProposalV1(proposalInput());
    expectAuthorizationError(
      () =>
        admitScaStrongerExecutionV1(
          proposal,
          decision(proposal),
          request(),
          new Date("2026-09-15T12:31:00.000Z")
        ),
      "expired"
    );
  });

  it("refuses snapshot, action-plan, capability, and proposal drift", () => {
    const proposal = buildScaStrongerExecutionProposalV1(proposalInput());
    const approved = decision(proposal);
    expectAuthorizationError(
      () =>
        admitScaStrongerExecutionV1(
          proposal,
          approved,
          { ...request(), source_snapshot_sha256: "f".repeat(64) },
          NOW
        ),
      "binding_mismatch"
    );
    expectAuthorizationError(
      () =>
        admitScaStrongerExecutionV1(
          proposal,
          approved,
          { ...request(), action_plan_sha256: "f".repeat(64) },
          NOW
        ),
      "request_mismatch"
    );
    expectAuthorizationError(
      () =>
        admitScaStrongerExecutionV1(
          proposal,
          approved,
          { ...request(), requested_capabilities: ["sandboxed-node-v1"] },
          NOW
        ),
      "request_mismatch"
    );
    expectAuthorizationError(
      () =>
        admitScaStrongerExecutionV1(
          { ...proposal, proposal_sha256: "0".repeat(64) },
          approved,
          request(),
          NOW
        ),
      "proposal_digest_mismatch"
    );
  });

  it("rejects duplicate capabilities and tampered decision receipts", () => {
    expectAuthorizationError(
      () =>
        buildScaStrongerExecutionProposalV1({
          ...proposalInput(),
          requested_capabilities: ["same", "same"],
        }),
      "capability_collision"
    );
    const proposal = buildScaStrongerExecutionProposalV1(proposalInput());
    const approved = decision(proposal);
    expectAuthorizationError(
      () =>
        validateScaHumanAuthorizationDecisionV1({ ...approved, decision_sha256: "0".repeat(64) }),
      "decision_digest_mismatch"
    );
    expect(validateScaStrongerExecutionProposalV1(proposal)).toEqual(proposal);
  });
});
