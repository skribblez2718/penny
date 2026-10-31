import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { Checkpointer } from "../dist/checkpointer.js";
import type { ArtifactRef, Directive, RunIdentity } from "../dist/contracts.js";
import { OrchestrationEngine } from "../dist/engine.js";
import type { HostOperationDeclarationV1 } from "../dist/host-operations/contracts.js";
import {
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
} from "../dist/host-operations/owner.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import type {
  HostOperationCachedResultV1,
  HostOperationResultCacheV1,
} from "../dist/host-operations/result-cache.js";
import { HostOperationRuntimeOwner } from "../dist/host-operations/owner.js";
import type { ModelClient } from "../dist/model-client.js";
import { PLAYBOOK_REGISTRY, runtimeRegistrationSha256 } from "../dist/playbooks/registry.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import {
  scaBrokerExecuteRequestSha256,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerPollRequestV1,
  type ScaBrokerReceiptV1,
} from "../dist/sca/broker-contracts.js";
import { SCA_PHASE_REGISTRY } from "../dist/sca/phase-registry.js";
import { admitScaP07ExecutionPlan } from "../dist/sca/p07-admission.js";
import {
  validateScaP07EvidenceLedgerV1,
  validateScaP07HostRequestV1,
  validateScaP07TerminalV1,
  validateScaP07ToP08TransitionV1,
  type ScaP07EvidenceLedgerV1,
  type ScaP07TerminalV1,
} from "../dist/sca/p07-contracts.js";
import {
  SCA_P07_ACTION_STATES,
  SCA_P07_CANDIDATE_BACKEND_KEY_SHA256,
  SCA_P07_CANDIDATE_DECLARATION,
  SCA_P07_CANDIDATE_PLAYBOOK_NAME,
  SCA_P07_CANDIDATE_REGISTRATION,
  SCA_P07_FINAL_STATE,
  createScaP07CandidateRegistrationV1,
  type ScaP07CurrentAuthorityResolverV1,
} from "../dist/sca/p07-playbook.js";
import {
  createScaP07HostAdapter,
  scaP07HostDirectives,
  type ScaP07BrokerClientV1,
} from "../dist/sca/p07-operation.js";
import { ProjectCatalog } from "../dist/state/catalog.js";
import { OrchestrationRunner, WorkerExecutor } from "../dist/worker.js";
import {
  buildScaP07Lineage,
  type ScaP07LineageKind,
  type ScaP07LineageV1,
} from "./sca-p07-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p07-playbook-"));
  roots.push(root);
  return root;
}

function actionState(index: number): string {
  const state = SCA_P07_ACTION_STATES[index];
  if (state === undefined) throw new Error("P07 action state is absent");
  return state;
}

function identity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: `session-${runId}`,
    playbook: SCA_P07_CANDIDATE_PLAYBOOK_NAME,
    engine_owner: "typescript",
  };
}

function parseUnknown(text: string): unknown {
  return JSON.parse(text);
}

interface Fixture {
  readonly root: string;
  readonly runId: string;
  readonly store: ArtifactStore;
  readonly checkpointer: Checkpointer;
  readonly leases: HostOperationLeaseAuthority;
  readonly engine: OrchestrationEngine;
  readonly owner: HostOperationRuntimeOwner;
  readonly runner: OrchestrationRunner;
  readonly lineage: ScaP07LineageV1;
  readonly calls: string[];
  readonly modelCalls: { count: number };
  readonly admissionChecks: { count: number };
  close(): void;
}

function fixture(input: {
  readonly runId: string;
  readonly kinds: readonly ScaP07LineageKind[];
  readonly failDispatchIndex?: number;
  readonly withOwner?: boolean;
  readonly faultPoint?: HostOperationFaultPointV1;
  /** Key the registered adapter map by a drifted id to exercise adapter-registration drift. */
  readonly adapterMapKey?: string;
  /**
   * Production-style binding overrides for declaration/backend/authority drift tests. When present
   * the playbook registration is built through `createScaP07CandidateRegistrationV1`; otherwise the
   * fixed compatibility fixture registration is used.
   */
  readonly registrationBinding?: {
    readonly declaration?: HostOperationDeclarationV1;
    readonly backend_key_sha256?: string;
    readonly resolve_current_authority_ref?: (
      lineage: ScaP07LineageV1
    ) => ScaP07CurrentAuthorityResolverV1;
  };
}): Fixture {
  const root = temporaryRoot();
  const stateRoot = path.join(root, "state");
  const catalog = new ProjectCatalog(stateRoot, { create: true });
  const project = catalog.registerProject(root);
  catalog.close();
  const checkpointer = Checkpointer.provision(path.join(root, "orchestration.db"), undefined, {
    projectId: project.projectId,
  });
  const store = ArtifactStore.provision(path.join(root, "artifacts"), {
    projectId: project.projectId,
  });
  const lineage = buildScaP07Lineage({ store, run_id: input.runId, kinds: input.kinds });
  const outputByJob = new Map<string, ArtifactRef>();
  for (const [index, item] of lineage.plan.items.entries()) {
    const output = store.persist({
      metadata: {
        schema_version: 2,
        run_id: input.runId,
        phase: "SCA-P07",
        branch_id: null,
        kind: "sca-p07-evidence-output",
        operation_id: `sca-p07-evidence-output-${index}`,
        version: 1,
        producer: "host:sca-p07-candidate",
        media_type: "application/json",
        content_schema: { schema_id: "penny.sca-p07-evidence-output.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson({ job_id: item.broker_request.job_id, index }),
    });
    outputByJob.set(item.broker_request.job_id, output);
  }
  const calls: string[] = [];
  const failedJobs = new Set<string>();
  const client: ScaP07BrokerClientV1 = {
    async execute(request: ScaBrokerExecuteRequestV1) {
      calls.push(request.job_id);
      if (input.failDispatchIndex === calls.length - 1) failedJobs.add(request.job_id);
      return {
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
        accepted_at: request.submitted_at,
      };
    },
    async poll(
      pollRequest: ScaBrokerPollRequestV1,
      _executeRequest: ScaBrokerExecuteRequestV1,
      _signal: AbortSignal
    ) {
      const output = outputByJob.get(pollRequest.job_id);
      const request = lineage.plan.items.find(
        (item) => item.broker_request.job_id === pollRequest.job_id
      )?.broker_request;
      if (output === undefined || request === undefined) {
        throw new Error("P07 test broker binding is absent");
      }
      const failed = failedJobs.has(request.job_id);
      const receipt: ScaBrokerReceiptV1 = {
        schema_id: "penny.sca-broker-receipt.v1",
        schema_version: 1,
        tenant_id: request.tenant_id,
        project_id: request.project_id,
        run_id: request.run_id,
        job_id: request.job_id,
        attempt: request.attempt,
        idempotency_key: request.idempotency_key,
        tool_name: request.tool_name,
        operation: request.operation,
        receipt_id: `receipt-${request.job_id}`,
        request_sha256: scaBrokerExecuteRequestSha256(request),
        limits: request.limits,
        terminal_status: failed ? "failed" : "succeeded",
        partial: false,
        truncated: false,
        source_snapshot_ref: request.source_snapshot_ref,
        config_ref: request.config_ref,
        input_refs: request.input_refs,
        output_refs: failed ? [] : [output],
        result_item_count: failed ? 0 : 1,
        failure: failed ? { code: "failed", message: "bounded test failure" } : null,
        accepted_at: request.submitted_at,
        terminal_at: request.submitted_at,
      };
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
        request_sha256: scaBrokerExecuteRequestSha256(request),
        status: failed ? ("failed" as const) : ("succeeded" as const),
        partial: false,
        truncated: false,
        output_refs: failed ? [] : [output],
        result_item_count: failed ? 0 : 1,
        failure: failed ? { code: "failed" as const, message: "bounded test failure" } : null,
        receipt,
        observed_at: pollRequest.requested_at,
      };
    },
    async cancel() {
      throw new Error("P07 test client has no cancellation path");
    },
  };
  const admissionChecks = { count: 0 };
  const adapter = createScaP07HostAdapter({
    client,
    backend_key_sha256: SCA_P07_CANDIDATE_BACKEND_KEY_SHA256,
    assertCurrentAdmission(admitted) {
      admissionChecks.count += 1;
      const current = admitScaP07ExecutionPlan({
        store,
        transition_ref: admitted.admission.transition_ref,
        authority_ref: admitted.admission.authority_ref,
        resolve_current_authority_ref: () => lineage.authority_ref,
        plan_ref: admitted.plan_ref,
      });
      if (canonicalJson(current) !== canonicalJson(admitted.admission)) {
        throw new Error("P07 admission is no longer current");
      }
    },
  });
  const cachedResults = new Map<string, HostOperationCachedResultV1>();
  const resultCache: HostOperationResultCacheV1 = {
    async read(requestSha256) {
      return cachedResults.get(requestSha256) ?? null;
    },
    async write(requestSha256, bytes) {
      const value: HostOperationCachedResultV1 = {
        schema_version: 1,
        request_sha256: requestSha256,
        content_sha256: sha256(bytes),
        byte_length: bytes.byteLength,
        bytes: Uint8Array.from(bytes),
      };
      cachedResults.set(requestSha256, value);
      return value;
    },
  };
  const registration =
    input.registrationBinding === undefined
      ? SCA_P07_CANDIDATE_REGISTRATION
      : createScaP07CandidateRegistrationV1({
          declaration: input.registrationBinding.declaration ?? SCA_P07_CANDIDATE_DECLARATION,
          backend_key_sha256:
            input.registrationBinding.backend_key_sha256 ?? SCA_P07_CANDIDATE_BACKEND_KEY_SHA256,
          resolve_current_authority_ref:
            input.registrationBinding.resolve_current_authority_ref?.(lineage) ??
            (() => lineage.authority_ref),
        });
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    maxSteps: 32,
    receiptAuthority: ReceiptAuthority.provision(path.join(root, "receipt.key")),
    artifactRevisions: store,
    artifactStore: store,
    artifactReader: store,
    playbookRegistration: registration,
  });
  const leases = new HostOperationLeaseAuthority(stateRoot);
  const owner = new HostOperationRuntimeOwner({
    projectId: project.projectId,
    checkpointer,
    artifacts: store,
    leaseAuthority: leases,
    adapters: new Map([[input.adapterMapKey ?? adapter.adapter_id, adapter]]),
    resultCache,
    ...(input.faultPoint === undefined
      ? {}
      : {
          fault: (point: HostOperationFaultPointV1) => {
            if (point === input.faultPoint) throw new HostOperationSimulatedCrashError(point);
          },
        }),
  });
  const modelCalls = { count: 0 };
  const model: ModelClient = {
    async runAgent() {
      modelCalls.count += 1;
      throw new Error("the deterministic P07 candidate must not reach a model client");
    },
  };
  const workers = new WorkerExecutor(model, store, {
    projectRoot: root,
    parallelConcurrency: 1,
    registration: engine.registration,
  });
  const runner =
    input.withOwner === false
      ? new OrchestrationRunner(engine, workers)
      : new OrchestrationRunner(engine, workers, undefined, owner);
  return {
    root,
    runId: input.runId,
    store,
    checkpointer,
    leases,
    engine,
    owner,
    runner,
    lineage,
    calls,
    modelCalls,
    admissionChecks,
    close() {
      leases.close();
      store.close();
      checkpointer.close();
    },
  };
}

function start(active: Fixture, runId: string): Directive {
  return active.engine.handle({
    schema_version: 2,
    action: "start",
    identity: identity(runId),
    goal: "Exercise the inactive P07 bounded evidence-gathering candidate.",
    constraints: {
      plan_ref: active.lineage.plan_ref,
      admission_ref: active.lineage.admission_ref,
    },
    project_root: active.root,
    trust_profile: "hardened-untrusted",
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "plan", ref: active.lineage.plan_ref },
        { slot: "admission", ref: active.lineage.admission_ref },
      ],
    },
  });
}

/**
 * Strict terminal read from the persisted artifact. The engine attaches a host liveness snapshot to
 * a terminal directive result, so the directive itself is only cross-checked against exact bytes.
 */
function terminalOf(active: Fixture, directive: Directive): ScaP07TerminalV1 {
  if (!("result" in directive)) throw new Error("expected a terminal directive");
  const ref = active.store.refFor(
    active.runId,
    "SCA-P07",
    null,
    "sca-p07-terminal",
    "sca-p07-terminal",
    1
  );
  if (ref === null) throw new Error("P07 terminal artifact is absent");
  const terminal = validateScaP07TerminalV1(
    parseUnknown(active.store.readById(ref.artifact_id).toString("utf8"))
  );
  expect(directive.result).toMatchObject({
    status: terminal.status,
    terminal_sha256: terminal.terminal_sha256,
  });
  return terminal;
}

function readLedger(active: Fixture, terminal: ScaP07TerminalV1): ScaP07EvidenceLedgerV1 {
  return validateScaP07EvidenceLedgerV1(
    parseUnknown(active.store.readById(terminal.evidence_ledger_ref.artifact_id).toString("utf8"))
  );
}

function readHandoff(active: Fixture, terminal: ScaP07TerminalV1) {
  if (terminal.p08_transition_ref === null) throw new Error("successor handoff is absent");
  return validateScaP07ToP08TransitionV1(
    parseUnknown(active.store.readById(terminal.p08_transition_ref.artifact_id).toString("utf8"))
  );
}

function completedLifecycle(active: Fixture, runId: string): void {
  const records = active.checkpointer.hostOperationCallsForRun(runId);
  expect(records.every((record) => record.lifecycle === "consumed")).toBe(true);
}

describe("inactive P07 candidate playbook", () => {
  it("dispatches every admitted action in deterministic order and terminates incomplete", async () => {
    const runId = "p07-playbook-complete";
    const kinds = ["application_test", "graph_query", "source_query"] as const;
    const active = fixture({ runId, kinds });
    const first = start(active, runId);
    expect(first).toMatchObject({
      action: "invoke_host_operation",
      state_id: actionState(0),
    });
    const terminalDirective = await active.runner.runUntilBoundary(first);
    expect(terminalDirective).toMatchObject({
      action: "incomplete",
      status: "incomplete",
      met: false,
    });
    const terminal = terminalOf(active, terminalDirective);
    expect(terminal).toMatchObject({
      status: "candidate_complete",
      evidence_complete: true,
      p08_handoff_ready: true,
      phase_gate_passed: false,
      release_eligible: false,
      campaign_complete: false,
      execution_occurred: true,
      action_count: 3,
      completed_action_count: 3,
      blocked_action_count: 0,
      not_invoked_action_count: 0,
    });
    expect(active.calls).toEqual(
      active.lineage.plan.items.map((item) => item.broker_request.job_id)
    );
    expect(active.modelCalls.count).toBe(0);
    expect(active.admissionChecks.count).toBe(3);
    expect(active.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(3);
    completedLifecycle(active, runId);
    const ledger = readLedger(active, terminal);
    expect(ledger.rows.map((row) => row.status)).toEqual(["completed", "completed", "completed"]);
    expect(ledger.exhaustive_accounting).toBe(true);
    const handoff = readHandoff(active, terminal);
    expect(handoff).toMatchObject({
      handoff_kind: "candidate_evidence_only",
      phase_gate_passed: false,
      p08_disposition_authorized_by_this_transition: false,
      evidence_complete: true,
      release_eligible: false,
      campaign_complete: false,
    });
    expect(handoff.completed_action_result_refs).toHaveLength(3);
    expect(terminal.selected_artifact_refs.length).toBeLessThanOrEqual(128);
    const replay = active.engine.handle({
      schema_version: 2,
      action: "status",
      identity: identity(runId),
    });
    expect(canonicalJson(replay)).toBe(canonicalJson(terminalDirective));
    expect(active.calls).toHaveLength(3);
    active.close();
  });

  it("reissues the exact pending action on recovery and never duplicates a host operation", async () => {
    const runId = "p07-playbook-recovery";
    const kinds = ["source_query", "graph_query", "application_test"] as const;
    const active = fixture({ runId, kinds });
    const first = start(active, runId);
    const recovered = active.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(canonicalJson(recovered)).toBe(canonicalJson(first));
    if (first.action !== "invoke_host_operation") throw new Error("expected the first host action");
    const second = await active.owner.dispatch(active.engine, first);
    expect(second).toMatchObject({ action: "invoke_host_operation" });
    const recoveredAgain = active.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(canonicalJson(recoveredAgain)).toBe(canonicalJson(second));
    const terminal = await active.runner.runUntilBoundary(recoveredAgain);
    expect(terminalOf(active, terminal).completed_action_count).toBe(3);
    expect(active.calls).toHaveLength(3);
    completedLifecycle(active, runId);
    active.close();
  });

  it("stops honestly on a non-completed action and marks the remainder not invoked", async () => {
    const runId = "p07-playbook-blocked";
    const kinds = ["source_query", "graph_query", "application_test"] as const;
    const active = fixture({ runId, kinds, failDispatchIndex: 1 });
    const terminal = await active.runner.runUntilBoundary(start(active, runId));
    const value = terminalOf(active, terminal);
    expect(value).toMatchObject({
      status: "blocked",
      evidence_complete: false,
      phase_gate_passed: false,
      action_count: 3,
      completed_action_count: 1,
      blocked_action_count: 1,
      not_invoked_action_count: 1,
    });
    expect(value.blocker_codes.length).toBeGreaterThan(0);
    const ledger = readLedger(active, value);
    expect(ledger.rows.map((row) => row.status)).toEqual(["completed", "blocked", "not_invoked"]);
    expect(ledger.rows[1]?.disposition?.outcome).toBe("remote_unknown");
    expect(ledger.rows[1]?.blocker_codes.length).toBeGreaterThan(0);
    expect(ledger.rows[2]?.blocker_codes).toEqual(["p07_action_not_invoked"]);
    expect(active.calls).toHaveLength(2);
    expect(active.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(2);
    const handoff = readHandoff(active, value);
    expect(handoff).toMatchObject({
      evidence_complete: false,
      blocked_action_count: 1,
      not_invoked_action_count: 1,
      release_eligible: false,
    });
    active.close();
  });

  it("cancels before dispatch with no execution and after one action with exact prior evidence", async () => {
    const kinds = ["source_query", "graph_query", "application_test"] as const;
    const beforeRun = "p07-playbook-cancel-before";
    const before = fixture({ runId: beforeRun, kinds });
    start(before, beforeRun);
    const beforeTerminal = terminalOf(
      before,
      before.engine.handle({
        schema_version: 2,
        action: "cancel",
        identity: identity(beforeRun),
        reason: "cancel before the first action",
      })
    );
    expect(beforeTerminal).toMatchObject({
      status: "cancelled",
      execution_occurred: false,
      completed_action_count: 0,
      blocked_action_count: 0,
      not_invoked_action_count: 3,
      p08_handoff_ready: false,
    });
    expect(beforeTerminal.p08_transition_ref).toBeNull();
    expect(before.calls).toEqual([]);
    expect(before.checkpointer.hostOperationCallsForRun(beforeRun)).toHaveLength(0);
    expect(readLedger(before, beforeTerminal).rows.map((row) => row.status)).toEqual([
      "not_invoked",
      "not_invoked",
      "not_invoked",
    ]);
    expect(
      before.store.refFor(
        beforeRun,
        "SCA-P07",
        null,
        "sca-p07-to-p08-transition",
        "sca-p07-to-p08-transition",
        1
      )
    ).toBeNull();
    before.close();

    const afterRun = "p07-playbook-cancel-after";
    const after = fixture({ runId: afterRun, kinds });
    const first = start(after, afterRun);
    if (first.action !== "invoke_host_operation") throw new Error("expected the first host action");
    const second = await after.owner.dispatch(after.engine, first);
    expect(second).toMatchObject({ action: "invoke_host_operation" });
    const afterTerminal = terminalOf(
      after,
      after.engine.handle({
        schema_version: 2,
        action: "cancel",
        identity: identity(afterRun),
        reason: "cancel after one accepted action",
      })
    );
    expect(afterTerminal).toMatchObject({
      status: "cancelled",
      execution_occurred: true,
      completed_action_count: 1,
      blocked_action_count: 0,
      not_invoked_action_count: 2,
    });
    expect(after.calls).toEqual([after.lineage.plan.items[0]?.broker_request.job_id]);
    expect(after.checkpointer.hostOperationCallsForRun(afterRun)).toHaveLength(1);
    expect(readLedger(after, afterTerminal).rows.map((row) => row.status)).toEqual([
      "completed",
      "not_invoked",
      "not_invoked",
    ]);
    expect(after.modelCalls.count).toBe(0);
    after.close();
  });

  it("refuses host-operation dispatch with no registered owner and stays non-positive", async () => {
    const runId = "p07-playbook-no-owner";
    const kinds = ["source_query"] as const;
    const active = fixture({ runId, kinds, withOwner: false });
    const terminal = await active.runner.runUntilBoundary(start(active, runId));
    expect(terminal).toMatchObject({
      action: "error",
      status: "error",
      met: false,
      result: { code: "HOST_OPERATION_OWNER_UNAVAILABLE" },
    });
    expect(active.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(0);
    expect(active.modelCalls.count).toBe(0);
    active.close();
  });

  it("rejects a start whose exact plan input is substituted", () => {
    const runId = "p07-playbook-invalid-start";
    const kinds = ["source_query"] as const;
    const active = fixture({ runId, kinds });
    expect(() =>
      active.engine.handle({
        schema_version: 2,
        action: "start",
        identity: identity(runId),
        goal: "substituted inputs",
        constraints: {
          plan_ref: active.lineage.plan_ref,
          admission_ref: active.lineage.admission_ref,
        },
        project_root: active.root,
        trust_profile: "hardened-untrusted",
        input_artifacts: {
          schema_version: 2,
          artifacts: [
            { slot: "plan", ref: active.lineage.p06_transition_ref },
            { slot: "admission", ref: active.lineage.admission_ref },
          ],
        },
      })
    ).toThrow();
    expect(active.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(0);
    active.close();
  });

  it("accounts for an unconsumed host-operation journal entry after a simulated crash", async () => {
    const runId = "p07-playbook-journal-crash";
    const kinds = ["source_query", "graph_query", "application_test"] as const;
    const active = fixture({ runId, kinds, faultPoint: "after_submit_before_remote_checkpoint" });
    const first = start(active, runId);
    if (first.action !== "invoke_host_operation") throw new Error("expected the first host action");
    await expect(active.owner.dispatch(active.engine, first)).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    const records = active.checkpointer.hostOperationCallsForRun(runId);
    expect(records).toHaveLength(1);
    expect(records[0]?.lifecycle).toBe("submitting");
    const terminal = terminalOf(
      active,
      active.engine.handle({
        schema_version: 2,
        action: "cancel",
        identity: identity(runId),
        reason: "cancel after a simulated post-submission crash",
      })
    );
    expect(terminal).toMatchObject({
      status: "cancelled",
      execution_occurred: true,
      completed_action_count: 0,
      blocked_action_count: 1,
      not_invoked_action_count: 2,
    });
    const ledger = readLedger(active, terminal);
    expect(ledger.rows.map((row) => row.status)).toEqual(["blocked", "not_invoked", "not_invoked"]);
    expect(ledger.rows[0]?.blocker_codes).toEqual(["p07_host_operation_journal_submitting"]);
    expect(ledger.rows[0]?.disposition).toBeNull();
    active.close();
  });

  it("records caller cancellation of an unsubmitted action as an honest blocked row", async () => {
    const runId = "p07-playbook-cancel-inflight";
    const kinds = ["source_query", "graph_query"] as const;
    const active = fixture({ runId, kinds });
    const first = start(active, runId);
    if (first.action !== "invoke_host_operation") throw new Error("expected the first host action");
    const controller = new AbortController();
    controller.abort();
    const terminal = terminalOf(
      active,
      await active.owner.dispatch(active.engine, first, controller.signal)
    );
    expect(terminal).toMatchObject({
      status: "cancelled",
      execution_occurred: true,
      completed_action_count: 0,
      blocked_action_count: 1,
      not_invoked_action_count: 1,
    });
    expect(active.calls).toEqual([]);
    const ledger = readLedger(active, terminal);
    expect(ledger.rows.map((row) => row.status)).toEqual(["blocked", "not_invoked"]);
    expect(ledger.rows[0]?.disposition?.outcome).toBe("cancelled");
    active.close();
  });

  it("binds one exact host state per action without changing its projected operation identity", () => {
    const runId = "p07-playbook-projection";
    const kinds = ["source_query", "graph_query"] as const;
    const active = fixture({ runId, kinds });
    start(active, runId);
    const requests = active.lineage.plan.items.map((item, index) => {
      const ref = active.store.refFor(
        runId,
        actionState(index),
        null,
        "sca-p07-host-request",
        `sca-p07-host-request-${String(index).padStart(4, "0")}`,
        1
      );
      if (ref === null) throw new Error("P07 host request artifact is absent");
      return {
        ref,
        value: validateScaP07HostRequestV1(
          parseUnknown(active.store.readById(ref.artifact_id).toString("utf8"))
        ),
      };
    });
    const registrationSha256 = runtimeRegistrationSha256(active.engine.registration);
    const project = (stateId: string) =>
      scaP07HostDirectives({
        plan: active.lineage.plan,
        plan_ref: active.lineage.plan_ref,
        admission: active.lineage.admission,
        admission_ref: active.lineage.admission_ref,
        requests,
        identity: identity(runId),
        state_id: stateId,
        attempt: 1,
        registration_sha256: registrationSha256,
        declaration: SCA_P07_CANDIDATE_DECLARATION,
        backend_key_sha256: SCA_P07_CANDIDATE_BACKEND_KEY_SHA256,
      });
    const first = project(actionState(0));
    const second = project(actionState(1));
    expect(first.map((directive) => directive.operation_id)).toEqual(
      second.map((directive) => directive.operation_id)
    );
    expect(first.map((directive) => directive.state_id)).toEqual(first.map(() => actionState(0)));
    expect(second.map((directive) => directive.state_id)).toEqual(second.map(() => actionState(1)));
    expect(first[0]?.state_id).not.toBe(second[0]?.state_id);
    active.close();
  });

  it("remains an inactive candidate outside the public and phase registries", () => {
    expect([...PLAYBOOK_REGISTRY.keys()]).not.toContain(SCA_P07_CANDIDATE_PLAYBOOK_NAME);
    expect([...SCA_PHASE_REGISTRY.keys()]).not.toContain(SCA_P07_CANDIDATE_PLAYBOOK_NAME);
    const active = PLAYBOOK_REGISTRY.get("sca");
    if (active === undefined || active.worker.kind !== "catalog-agent") {
      throw new Error("active SCA registration is absent");
    }
    expect([...active.worker.phases.keys()]).not.toContain("p07");
    expect(SCA_P07_CANDIDATE_REGISTRATION.host_states).toEqual([
      ...SCA_P07_ACTION_STATES,
      SCA_P07_FINAL_STATE,
    ]);
  });

  it("fails closed when the injected current-authority resolver reports revocation", () => {
    const runId = "p07-playbook-authority-revoked";
    const kinds = ["source_query"] as const;
    const active = fixture({
      runId,
      kinds,
      // A resolver that no longer names the admission's authority models a revoked P07 grant.
      registrationBinding: {
        resolve_current_authority_ref: (lineage) => () => lineage.plan_ref,
      },
    });
    expect(() => start(active, runId)).toThrow(/current host authority/u);
    expect(active.calls).toEqual([]);
    expect(active.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(0);
    active.close();
  });

  it("fails closed when the candidate backend key drifts from the injected adapter", async () => {
    const runId = "p07-playbook-backend-drift";
    const kinds = ["source_query"] as const;
    const active = fixture({
      runId,
      kinds,
      registrationBinding: { backend_key_sha256: "f".repeat(64) },
    });
    const terminal = await active.runner.runUntilBoundary(start(active, runId));
    expect(terminal).toMatchObject({ met: false });
    // The adapter request binding is refused before any broker submission.
    expect(active.calls).toEqual([]);
    const records = active.checkpointer.hostOperationCallsForRun(runId);
    expect(records).toHaveLength(1);
    expect(records[0]?.disposition?.reason_code).toBe("adapter_request_binding_refused");
    active.close();
  });

  it("fails closed when the registered adapter is not keyed by the declared adapter id", async () => {
    const runId = "p07-playbook-adapter-drift";
    const kinds = ["source_query"] as const;
    const active = fixture({
      runId,
      kinds,
      adapterMapKey: "sca.p07-other-adapter.v1",
    });
    const terminal = await active.runner.runUntilBoundary(start(active, runId));
    expect(terminal).toMatchObject({ met: false });
    expect(active.calls).toEqual([]);
    const records = active.checkpointer.hostOperationCallsForRun(runId);
    expect(records).toHaveLength(1);
    expect(records[0]?.disposition?.reason_code).toBe("adapter_unavailable");
    active.close();
  });
});

describe("inactive P07 candidate registration factory", () => {
  const unavailableResolver: ScaP07CurrentAuthorityResolverV1 = () => {
    throw new Error("the current-authority resolver must not run during construction");
  };

  it("binds an injected declaration, backend key, and resolver outside the registries", () => {
    const registration = createScaP07CandidateRegistrationV1({
      declaration: SCA_P07_CANDIDATE_DECLARATION,
      backend_key_sha256: SCA_P07_CANDIDATE_BACKEND_KEY_SHA256,
      resolve_current_authority_ref: unavailableResolver,
    });
    expect(registration.name).toBe(SCA_P07_CANDIDATE_PLAYBOOK_NAME);
    expect(registration.host_operations?.declarations).toEqual([SCA_P07_CANDIDATE_DECLARATION]);
    expect([...PLAYBOOK_REGISTRY.keys()]).not.toContain(registration.name);
    expect([...SCA_PHASE_REGISTRY.keys()]).not.toContain(registration.name);
  });

  it("rejects a declaration that drifts from the registered P07 host operation", () => {
    expect(() =>
      createScaP07CandidateRegistrationV1({
        declaration: { ...SCA_P07_CANDIDATE_DECLARATION, adapter_id: "sca.p07-other-adapter.v1" },
        backend_key_sha256: SCA_P07_CANDIDATE_BACKEND_KEY_SHA256,
        resolve_current_authority_ref: unavailableResolver,
      })
    ).toThrow(/declaration/u);
    expect(() =>
      createScaP07CandidateRegistrationV1({
        declaration: { ...SCA_P07_CANDIDATE_DECLARATION, operation_kind: "sca.p07-other.v1" },
        backend_key_sha256: SCA_P07_CANDIDATE_BACKEND_KEY_SHA256,
        resolve_current_authority_ref: unavailableResolver,
      })
    ).toThrow(/declaration/u);
  });

  it("rejects a backend key that is not a SHA-256 digest", () => {
    expect(() =>
      createScaP07CandidateRegistrationV1({
        declaration: SCA_P07_CANDIDATE_DECLARATION,
        backend_key_sha256: "not-a-digest",
        resolve_current_authority_ref: unavailableResolver,
      })
    ).toThrow(/backend key/u);
  });
});
