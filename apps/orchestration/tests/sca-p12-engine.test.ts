import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import { Checkpointer } from "../dist/checkpointer.js";
import type { Directive, JsonValue, StartRequest } from "../dist/contracts.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { RunContext } from "../dist/context.js";
import type { PlaybookRegistration } from "../dist/playbooks/registry.js";
import {
  SCA_P12_CANDIDATE_PLAYBOOK_NAME,
  buildExpectedInputs,
  createScaP12VerificationRegistrationV1,
} from "../dist/sca/p12-playbook.js";
import type { ScaP12CandidateStartV1 } from "../dist/sca/p12-contracts.js";
import { validateScaP12TerminalV1 } from "../dist/sca/p12-contracts.js";
import {
  asTerminalDirective,
  buildProductionBinding,
  buildScaP12Lineage,
  type ScaP12LineageV1,
} from "./sca-p12-lineage.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const NOW = "2026-10-03T00:00:00.000Z";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p12-engine-"));
  roots.push(root);
  return root;
}

function startRequest(input: {
  readonly root: string;
  readonly runId: string;
  readonly constraints: ScaP12CandidateStartV1;
}): StartRequest {
  return {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: `session-${input.runId}`,
      playbook: SCA_P12_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise the inactive P12 candidate through the real engine.",
    constraints: input.constraints,
    project_root: input.root,
    trust_profile: "hardened-untrusted",
    input_artifacts: { schema_version: 2, artifacts: buildExpectedInputs(input.constraints) },
  };
}

function p12Registration(lineage: ScaP12LineageV1): PlaybookRegistration {
  const binding = buildProductionBinding(lineage);
  if (
    binding.resolve_current_verifier_authority_ref === undefined ||
    binding.resolve_current_release_authority_ref === undefined ||
    binding.resolve_current_phase_gate_index_ref === undefined
  ) {
    throw new Error("P12 test binding is missing a current-authority resolver");
  }
  return createScaP12VerificationRegistrationV1({
    resolve_current_verifier_authority_ref: binding.resolve_current_verifier_authority_ref,
    resolve_current_release_authority_ref: binding.resolve_current_release_authority_ref,
    resolve_current_phase_gate_index_ref: binding.resolve_current_phase_gate_index_ref,
  });
}

function engineHarness(input: {
  readonly root: string;
  readonly artifacts: ArtifactStore;
  readonly registration: PlaybookRegistration;
  readonly checkpointer?: Checkpointer;
}): { readonly checkpointer: Checkpointer; readonly engine: OrchestrationEngine } {
  const checkpointer =
    input.checkpointer ?? new Checkpointer(path.join(input.root, "orchestration.db"));
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: input.root,
    maxSteps: 64,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactStore: input.artifacts,
    artifactReader: input.artifacts,
    artifactRevisions: input.artifacts,
    playbookRegistration: input.registration,
    trustedClock: () => new Date(NOW),
  });
  return { checkpointer, engine };
}

function parseTerminal(directive: Directive) {
  const { liveness: _liveness, ...body } = asTerminalDirective(directive).result;
  return validateScaP12TerminalV1(body);
}

function terminalBody(directive: Directive): Record<string, JsonValue> {
  const { liveness: _liveness, ...body } = asTerminalDirective(directive).result;
  return body;
}

describe("SCA P12 real-engine lifecycle", () => {
  it("runs permanently non-positive, then replays the exact terminal after restart with no duplicate artifacts", () => {
    const root = tempRoot();
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const runId = "run-p12-engine";
    const lineage = buildScaP12Lineage({
      store: artifacts,
      run_id: runId,
      lane: "reporting_complete",
    });
    const registration = p12Registration(lineage);
    const harness = engineHarness({ root, artifacts, registration });
    const request = startRequest({ root, runId, constraints: lineage.constraints });

    const terminal = harness.engine.handle(request);
    expect(terminal.action).toBe("incomplete");
    const body = parseTerminal(terminal);
    expect(body.status).toBe("verification_incomplete");
    expect(body.campaign_complete).toBe(false);
    expect(body.release_eligible).toBe(false);

    harness.checkpointer.close();
    const reopened = new Checkpointer(path.join(root, "orchestration.db"));
    const restart = engineHarness({ root, artifacts, registration, checkpointer: reopened });
    const recovered = restart.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: request.identity,
    });
    expect(recovered.action).toBe("incomplete");
    expect(canonicalJson(terminalBody(recovered))).toBe(canonicalJson(terminalBody(terminal)));
    expect(reopened.loadRunById(runId)?.status).toBe("incomplete");
    // The immutable terminal revision 1 exists and no second terminal revision was written.
    expect(
      artifacts.refFor(runId, "SCA-P12", null, "sca-p12-terminal", "sca-p12-terminal", 1)
    ).not.toBeNull();
    expect(
      artifacts.refFor(runId, "SCA-P12", null, "sca-p12-terminal", "sca-p12-terminal", 2)
    ).toBeNull();
    reopened.close();
  }, 60_000);

  it("leaves a settled run uncancellable, replaying its exact terminal with zero release state", () => {
    const root = tempRoot();
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const runId = "run-p12-engine-cancel";
    const lineage = buildScaP12Lineage({
      store: artifacts,
      run_id: runId,
      lane: "reporting_complete",
    });
    const registration = p12Registration(lineage);
    const harness = engineHarness({ root, artifacts, registration });
    const request = startRequest({ root, runId, constraints: lineage.constraints });
    const terminal = harness.engine.handle(request);
    // The P12 candidate reaches a durable terminal during start, so the engine refuses a later
    // cancel and replays the exact settled terminal (there is no in-flight cancel window).
    const cancelAttempt: Directive = harness.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: request.identity,
      reason: "operator cancelled",
    });
    expect(cancelAttempt.action).toBe("incomplete");
    expect(canonicalJson(terminalBody(cancelAttempt))).toBe(canonicalJson(terminalBody(terminal)));
    const body = parseTerminal(cancelAttempt);
    expect(body.status).toBe("verification_incomplete");
    expect(body.release_eligible).toBe(false);
    expect(body.campaign_complete).toBe(false);
    expect(body.release_approval_ref).toBeNull();
    harness.checkpointer.close();
  }, 60_000);

  it("declares a renewable deterministic-host liveness lease and leaves no open worker lease", () => {
    const root = tempRoot();
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const runId = "run-p12-engine-liveness";
    const lineage = buildScaP12Lineage({
      store: artifacts,
      run_id: runId,
      lane: "blocked_invalid",
    });
    const registration = p12Registration(lineage);
    const harness = engineHarness({ root, artifacts, registration });
    const livenessRun = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: "run-p12-liveness-policy",
        session_id: "session-p12-liveness-policy",
        playbook: SCA_P12_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      },
      goal: "Resolve the deterministic-host liveness policy.",
      constraints: {},
      projectRoot: root,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
      initialArtifacts: [],
    });
    const policy = registration.liveness.resolve(livenessRun);
    if (policy === undefined || policy.schema_version !== 3) {
      throw new Error("expected a v3 progress-lease policy");
    }
    expect(policy).toMatchObject({
      schema_version: 3,
      preset: "deterministic-host",
      scope: "sca-p12-candidate",
    });
    const terminal = parseTerminal(
      harness.engine.handle(startRequest({ root, runId, constraints: lineage.constraints }))
    );
    expect(terminal.status).toBe("blocked_invalid");
    expect(harness.engine.liveness.recoverOpenWorkers(runId)).toBeNull();
    harness.checkpointer.close();
  }, 60_000);
});
