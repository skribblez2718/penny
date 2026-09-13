import { randomUUID } from "node:crypto";

import { ArtifactStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { SEMANTIC_PRODUCT_VALIDATORS } from "../composition.js";
import type { ArtifactRef, Directive, StartRequest } from "../contracts.js";
import { RunContext } from "../context.js";
import type { OrchestrationEngine } from "../engine.js";
import {
  bindGenericChildYamlAuthority,
  genericChildStartParts,
  isGenericChildWorkflowEligible,
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "../playbooks/registry.js";
import type {
  OrchestrationProgressEvent,
  OrchestrationRunner,
  OrchestrationWorkerActivityEvent,
} from "../worker.js";
import type {
  Checkpointer,
  ConsumeChildWorkflowCallInput,
  ReserveChildWorkflowCallInput,
  ReserveChildWorkflowCallOutcome,
  TransitionChildWorkflowCallInput,
} from "../checkpointer.js";
import {
  applyChildWorkflowProgressSignal,
  validateCanonicalChildWorkflowRequestBytes,
  validateChildWorkflowProgressLeaseState,
  validateChildWorkflowResult,
  type ChildWorkflowCallRecord,
  type ChildWorkflowCallRecordV1,
  type ChildWorkflowInvocationDirective,
  type ChildWorkflowProgressLeaseStateV1,
  type ChildWorkflowResultV1,
} from "./contracts.js";
import {
  ChildWorkflowArtifactCustody,
  createReservedChildWorkflowCallRecord,
  encodeChildWorkflowCallRecord,
} from "./storage.js";

/**
 * Storage-only cross-domain coordinator. It mints a custody capability from one concrete,
 * project-bound ArtifactStore, verifies immutable artifacts before delegating to Checkpointer, and
 * leaves Checkpointer to repeat that verification before mutation. It does not authorize,
 * dispatch, execute, accept, or consume child work.
 */
export class ChildWorkflowStateOwner {
  private readonly custody: ChildWorkflowArtifactCustody;

  constructor(
    private readonly checkpointer: Pick<
      Checkpointer,
      "reserveChildWorkflowCall" | "transitionChildWorkflowCall" | "consumeChildWorkflowCall"
    >,
    artifacts: ArtifactStore
  ) {
    this.custody = ChildWorkflowArtifactCustody.fromArtifactStore(artifacts);
  }

  reserve(input: Omit<ReserveChildWorkflowCallInput, "custody">): ReserveChildWorkflowCallOutcome {
    const record = this.custody.verify(input.record);
    return this.checkpointer.reserveChildWorkflowCall({ ...input, custody: this.custody, record });
  }

  transition(input: Omit<TransitionChildWorkflowCallInput, "custody">): ChildWorkflowCallRecord {
    const next = this.custody.verify(input.next);
    return this.checkpointer.transitionChildWorkflowCall({ ...input, custody: this.custody, next });
  }

  /** Commit a captured terminal and its parent continuation as one control-store mutation. */
  consume(input: Omit<ConsumeChildWorkflowCallInput, "custody">): ChildWorkflowCallRecord {
    const next = this.custody.verify(input.next);
    return this.checkpointer.consumeChildWorkflowCall({ ...input, custody: this.custody, next });
  }
}

/** Child engines are assembled by the service with the same project-bound durable owners. */
export interface ChildWorkflowEngineFactory {
  create(input: {
    readonly registration: PlaybookRegistrationV1;
    /** Present only when replaying a historical timing-bound V1 call. */
    readonly maxSteps?: number;
    /** Present only when replaying a historical timing-bound V1 call. */
    readonly wallClockMs?: number;
  }): {
    readonly engine: OrchestrationEngine;
    readonly runner: OrchestrationRunner;
    readonly maxSteps: number;
  };
}

export interface ChildWorkflowRuntimeOwnerOptions {
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly registry: PlaybookRegistryV1;
  readonly projectRoot: string;
  /** Explicit host-owned activation. The owner remains internal and depth-one. */
  readonly executionEnabled: true;
  readonly engines: ChildWorkflowEngineFactory;
}

function utcNow(): string {
  return new Date().toISOString();
}

function terminalAction(
  value: Directive
): Extract<Directive, { action: "complete" | "incomplete" | "error" | "cancelled" }> {
  if (
    value.action !== "complete" &&
    value.action !== "incomplete" &&
    value.action !== "error" &&
    value.action !== "cancelled"
  ) {
    throw new Error(`child workflow did not reach a terminal boundary: '${value.action}'`);
  }
  return value;
}

function exactOutput(
  terminal: ReturnType<typeof terminalAction>,
  record: ChildWorkflowCallRecord
): ArtifactRef | null {
  const matches = terminal.artifacts.filter(
    (artifact) =>
      artifact.kind === record.expected_output.artifact_kind &&
      artifact.content_schema?.schema_id === record.expected_output.schema_id &&
      artifact.content_schema.schema_version === record.expected_output.schema_version_required
  );
  if (terminal.action === "complete") {
    if (matches.length !== 1) {
      throw new Error("complete child terminal must carry exactly one contract-matching output");
    }
    const output = matches[0];
    if (output === undefined) throw new Error("missing complete child output");
    return output;
  }
  if (matches.length > 1) {
    throw new Error("non-complete child terminal has ambiguous contract-matching outputs");
  }
  return matches[0] ?? null;
}

function validateExactOutputCore(
  artifacts: ArtifactStore,
  output: ArtifactRef | null,
  expected: ChildWorkflowCallRecord["expected_output"]
): void {
  if (output === null) return;
  const validator = SEMANTIC_PRODUCT_VALIDATORS.get(expected.schema_id);
  if (
    validator === undefined ||
    validator.schema_version !== expected.schema_version_required ||
    validator.artifact_kind !== expected.artifact_kind
  ) {
    throw new Error(
      `child workflow output '${expected.schema_id}' has no exact registered semantic validator`
    );
  }
  validator.validateCanonicalBytes(artifacts.readById(output.artifact_id), output);
}

type LegacyChildBudgetVector = ChildWorkflowCallRecordV1["budget"];

function chargedLegacyBudget(record: ChildWorkflowCallRecordV1): LegacyChildBudgetVector {
  if (record.usage === null || record.usage.unknown_usage) return record.budget;
  return {
    schema_version: 1,
    model_turns: record.usage.model_turns,
    tool_calls: record.usage.tool_calls,
    external_calls: record.usage.external_calls,
    wall_clock_ms: record.usage.active_wall_clock_ms,
    max_steps: record.usage.steps,
    output_bytes: record.usage.output_bytes,
  };
}

function legacyAllocationsLeaveSealingReserve(input: {
  readonly allocations: readonly LegacyChildBudgetVector[];
  readonly reserve: LegacyChildBudgetVector;
  readonly total: LegacyChildBudgetVector;
}): boolean {
  const used = (
    key:
      | "model_turns"
      | "tool_calls"
      | "external_calls"
      | "wall_clock_ms"
      | "max_steps"
      | "output_bytes"
  ) => input.allocations.reduce((sum, allocation) => sum + allocation[key], input.reserve[key]);
  return (
    used("model_turns") <= input.total.model_turns &&
    used("tool_calls") <= input.total.tool_calls &&
    used("external_calls") <= input.total.external_calls &&
    used("wall_clock_ms") <= input.total.wall_clock_ms &&
    used("max_steps") <= input.total.max_steps &&
    used("output_bytes") <= input.total.output_bytes
  );
}

/**
 * The execution owner is deliberately separate from ChildWorkflowStateOwner: it performs
 * registration admission, creates a normal child engine, captures the terminal, and resumes the
 * parent. The state owner remains the only custody/transaction boundary.
 */
export class ChildWorkflowRuntimeOwner {
  private readonly state: ChildWorkflowStateOwner;
  /** In-process forwarding only; durable call state remains the restart source of truth. */
  private readonly activeParentCancellation = new Map<string, AbortController>();

  constructor(private readonly options: ChildWorkflowRuntimeOwnerOptions) {
    this.state = new ChildWorkflowStateOwner(options.checkpointer, options.artifacts);
  }

  private boundRegistry(): PlaybookRegistryV1 {
    return new Map(
      [...this.options.registry.entries()].map(([name, registration]) => [
        name,
        bindGenericChildYamlAuthority(registration, this.options.projectRoot),
      ])
    );
  }

  /** A reserved call is bound to its original registration bytes; resume may never silently rebind. */
  private assertFrozenRegistrationBinding(
    record: ChildWorkflowCallRecord,
    parentEngine: OrchestrationEngine,
    childEngine: OrchestrationEngine
  ): void {
    if (
      runtimeRegistrationSha256(parentEngine.registration) !== record.parent_registration_sha256
    ) {
      throw new Error("child workflow parent registration drifted after reservation");
    }
    if (runtimeRegistrationSha256(childEngine.registration) !== record.child_registration_sha256) {
      throw new Error("child workflow provider registration drifted after reservation");
    }
  }

  /** Forward a durable parent cancellation to its currently executing child, if any. */
  cancelParent(parentRunId: string): void {
    this.activeParentCancellation
      .get(parentRunId)
      ?.abort(new Error("parent child-workflow execution was cancelled"));
  }

  async dispatch(
    parentEngine: OrchestrationEngine,
    value: ChildWorkflowInvocationDirective,
    signal?: AbortSignal
  ): Promise<Directive> {
    const existing = this.activeParentCancellation.get(value.identity.run_id);
    if (existing !== undefined) {
      throw new Error("child workflow parent already has an active execution");
    }
    const forwarded = new AbortController();
    const forwardCancellation = (): void => forwarded.abort(signal?.reason);
    if (signal?.aborted) forwardCancellation();
    else signal?.addEventListener("abort", forwardCancellation, { once: true });
    this.activeParentCancellation.set(value.identity.run_id, forwarded);
    try {
      return await this.dispatchWithSignal(parentEngine, value, forwarded.signal);
    } finally {
      if (this.activeParentCancellation.get(value.identity.run_id) === forwarded) {
        this.activeParentCancellation.delete(value.identity.run_id);
      }
      signal?.removeEventListener("abort", forwardCancellation);
    }
  }

  private async dispatchWithSignal(
    parentEngine: OrchestrationEngine,
    value: ChildWorkflowInvocationDirective,
    signal: AbortSignal
  ): Promise<Directive> {
    if (!this.options.executionEnabled) {
      throw new Error("generic child execution is unavailable without an enabled owner");
    }
    const registry = this.boundRegistry();
    const parent = this.options.checkpointer.loadRun(value.identity);
    if (
      parent.pendingDirective !== null &&
      canonicalJson(parent.pendingDirective) !== canonicalJson(value)
    ) {
      throw new Error("child workflow directive is not the parent's exact pending work");
    }
    const childRegistration = registry.get(value.child_name);
    if (childRegistration === undefined) {
      throw new Error(`child workflow '${value.child_name}' is not registered`);
    }
    if (
      !isGenericChildWorkflowEligible(
        parent.identity.playbook,
        value.child_name,
        registry,
        this.options.projectRoot
      )
    ) {
      throw new Error(
        `child workflow '${parent.identity.playbook}->${value.child_name}' is not eligible`
      );
    }
    const target = parentEngine.registration.generic_child?.parent_policy.targets.find(
      (candidate) => candidate.child_name === value.child_name
    );
    if (
      target === undefined ||
      target.schema_version !== (value.schema_version === 3 ? 2 : 1) ||
      canonicalJson(target.expected_output) !== canonicalJson(value.expected_output) ||
      (value.schema_version === 2
        ? target.schema_version !== 1 ||
          canonicalJson(target.budget) !== canonicalJson(value.budget)
        : target.schema_version !== 2 ||
          canonicalJson(target.progress_lease) !== canonicalJson(value.progress_lease))
    ) {
      throw new Error("child workflow directive diverges from the registered parent target");
    }
    const policy = parentEngine.registration.generic_child?.parent_policy;
    if (
      policy === undefined ||
      policy.max_nesting_depth !== 1 ||
      policy.max_active_children !== 1 ||
      policy.max_calls < 1 ||
      policy.project_concurrency_limit < 1
    ) {
      throw new Error("parent registration has no executable depth-one child policy");
    }
    const calls = this.options.checkpointer.childWorkflowCallsForParent(parent.identity.run_id);
    if (value.schema_version === 2) {
      if (policy.schema_version !== 1) {
        throw new Error("legacy child directive requires the exact legacy parent policy");
      }
      const priorAllocations = calls
        .filter(
          (call): call is ChildWorkflowCallRecordV1 =>
            call.schema_version === 1 && call.call_key !== value.call_key
        )
        .map(chargedLegacyBudget);
      if (
        !legacyAllocationsLeaveSealingReserve({
          allocations: [...priorAllocations, value.budget],
          reserve: policy.parent_sealing_reserve,
          total: policy.aggregate_budget,
        })
      ) {
        throw new Error(
          "legacy child workflow allocation would consume the parent's replay reserve"
        );
      }
    } else if (policy.schema_version !== 2) {
      throw new Error("lease-bound child directive requires the active parent policy");
    }
    if (
      calls.length >= policy.max_calls &&
      !calls.some((call) => call.call_key === value.call_key)
    ) {
      throw new Error("child workflow parent exhausted its registered call allowance");
    }
    const activeForParent = calls.filter(
      (call) =>
        call.lifecycle === "reserved" ||
        call.lifecycle === "running" ||
        call.lifecycle === "waiting_user" ||
        call.lifecycle === "paused"
    );
    if (
      activeForParent.length >= policy.max_active_children &&
      !calls.some((call) => call.call_key === value.call_key)
    ) {
      throw new Error("child workflow parent reached its active-child capacity");
    }
    if (
      this.options.checkpointer.activeChildWorkflowCallCount() >=
        policy.project_concurrency_limit &&
      !calls.some((call) => call.call_key === value.call_key)
    ) {
      throw new Error("child workflow project capacity is exhausted");
    }
    const requestBytes = this.options.artifacts.readById(value.request_ref.artifact_id);
    const request = validateCanonicalChildWorkflowRequestBytes(requestBytes, value.request_ref);
    if (
      request.child_name !== value.child_name ||
      canonicalJson(request.policy_binding) !== canonicalJson(value.policy_binding)
    ) {
      throw new Error("child workflow request does not bind the directive identity and policy");
    }
    const start = genericChildStartParts(
      parent.identity.playbook,
      request,
      registry,
      this.options.projectRoot
    );
    if (start.child_name !== value.child_name) {
      throw new Error("child workflow start adapter selected a different provider");
    }
    const child = this.options.engines.create({
      registration: childRegistration,
      ...(value.schema_version === 2
        ? { maxSteps: value.budget.max_steps, wallClockMs: value.budget.wall_clock_ms }
        : {}),
    });
    const visit = this.options.checkpointer
      .stateVisits(parent.identity.run_id)
      .filter((candidate) => candidate.state_id === value.state_id)
      .at(-1);
    if (visit === undefined)
      throw new Error("child workflow directive lacks a durable parent state visit");
    const record = createReservedChildWorkflowCallRecord({
      directive: value,
      parent_visit_sequence: visit.event_sequence,
      parent_visit_offset: visit.offset,
      parent_registration_sha256: runtimeRegistrationSha256(parentEngine.registration),
      child_registration_sha256: runtimeRegistrationSha256(child.engine.registration),
      timestamp: utcNow(),
    });
    const childContext = RunContext.create({
      identity: record.child_identity,
      goal: start.goal,
      constraints: start.constraints,
      projectRoot: parent.projectRoot,
      trustProfile: parent.trustProfile,
      maxSteps: child.maxSteps,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: child.engine.registration.name,
        contract_sha256: skillContractSha256(child.engine.contract),
        registration_sha256: runtimeRegistrationSha256(child.engine.registration),
      },
    });
    const reservation = this.state.reserve({
      record,
      childContext,
      ...(record.schema_version === 2
        ? {
            admission: {
              max_calls: policy.max_calls,
              max_active_children: policy.max_active_children,
              project_concurrency_limit: policy.project_concurrency_limit,
            },
          }
        : {}),
    });
    let currentRecord = reservation.record;
    this.assertFrozenRegistrationBinding(currentRecord, parentEngine, child.engine);
    if (currentRecord.lifecycle === "reserved") {
      currentRecord = this.state.transition({
        call_id: currentRecord.call_id,
        from: "reserved",
        next: encodeChildWorkflowCallRecord({
          ...currentRecord,
          lifecycle: "running",
          updated_at: utcNow(),
        }).record,
      });
    }
    if (currentRecord.lifecycle === "terminal_recorded") {
      return this.consumeCapturedTerminal(parentEngine, child.engine, currentRecord);
    }
    if (currentRecord.lifecycle === "consumed") {
      return parentEngine.handle({
        schema_version: 2,
        action: "status",
        identity: value.identity,
      });
    }
    if (currentRecord.lifecycle !== "running") {
      throw new Error(
        `child workflow '${currentRecord.call_id}' cannot dispatch from '${currentRecord.lifecycle}'`
      );
    }
    const childStart: StartRequest = {
      schema_version: 2,
      action: "start",
      identity: currentRecord.child_identity,
      goal: start.goal,
      constraints: start.constraints,
      project_root: parent.projectRoot,
      trust_profile: parent.trustProfile,
      ...(value.input_artifacts.artifacts.length === 0
        ? {}
        : { input_artifacts: value.input_artifacts }),
    };
    const childContextBeforeStart = this.options.checkpointer.loadRun(currentRecord.child_identity);
    const childInitial =
      childContextBeforeStart.stateId === "intake" &&
      childContextBeforeStart.pendingDirective === null
        ? child.engine.startReservedChild(childStart)
        : child.engine.handle({
            schema_version: 2,
            action: "recover",
            identity: currentRecord.child_identity,
          });
    if (currentRecord.schema_version === 1) {
      const boundary = await child.runner.runUntilBoundary(childInitial, signal);
      return this.captureBoundary(
        parentEngine,
        child.engine,
        currentRecord,
        boundary,
        signal.aborted
      );
    }

    const executionController = new AbortController();
    const forwardParentCancellation = (): void => executionController.abort(signal.reason);
    if (signal.aborted) forwardParentCancellation();
    else signal.addEventListener("abort", forwardParentCancellation, { once: true });
    const fence = {
      schema_version: 1 as const,
      owner_epoch: 1,
      execution_attempt_id: `child-attempt-${randomUUID()}`,
      worker_session_id: currentRecord.child_identity.run_id,
      fencing_token_sha256: sha256(randomUUID()),
    };
    const startedAtMs = Date.now();
    let leaseState: ChildWorkflowProgressLeaseStateV1 = validateChildWorkflowProgressLeaseState({
      schema_version: 1,
      binding: currentRecord.progress_lease,
      fence,
      state: "active",
      lease_expires_at_ms: startedAtMs + currentRecord.progress_lease.inactivity_interval_ms,
      last_accepted_signal_sequence: 0,
      last_accepted_at_ms: startedAtMs,
      last_activity: null,
      last_convergence: null,
      convergence_epoch: 0,
    });
    let leaseTimer: NodeJS.Timeout | undefined;
    const scheduleLease = (): void => {
      if (leaseTimer !== undefined) clearTimeout(leaseTimer);
      const remaining = Math.max(0, leaseState.lease_expires_at_ms - Date.now());
      leaseTimer = setTimeout(() => {
        executionController.abort(new Error("child workflow inactivity lease expired"));
      }, remaining);
    };
    const acceptWorkerActivity = (event: OrchestrationWorkerActivityEvent): void => {
      if (executionController.signal.aborted) return;
      const observedAtMs = Date.now();
      if (observedAtMs >= leaseState.lease_expires_at_ms) {
        executionController.abort(new Error("child workflow inactivity lease expired"));
        return;
      }
      leaseState = applyChildWorkflowProgressSignal({
        state: leaseState,
        signal: {
          schema_version: 1,
          source: "trusted_host_observed",
          fence,
          signal_sequence: leaseState.last_accepted_signal_sequence + 1,
          observed_at_ms: observedAtMs,
          observed_units: event.observed_units,
          kind: "worker_activity",
          activity_class: event.activity_class,
        },
      });
      scheduleLease();
    };
    const acceptConvergence = (event: OrchestrationProgressEvent): void => {
      if (executionController.signal.aborted) return;
      const convergenceClass =
        event.event === "boundary_reached"
          ? "terminal_transition"
          : event.event === "phase_started"
            ? "state_transition"
            : undefined;
      if (convergenceClass === undefined) return;
      const observedAtMs = Date.now();
      if (observedAtMs >= leaseState.lease_expires_at_ms) {
        executionController.abort(new Error("child workflow inactivity lease expired"));
        return;
      }
      leaseState = applyChildWorkflowProgressSignal({
        state: leaseState,
        signal: {
          schema_version: 1,
          source: "trusted_host_observed",
          fence,
          signal_sequence: leaseState.last_accepted_signal_sequence + 1,
          observed_at_ms: observedAtMs,
          observed_units: 1,
          kind: "workflow_convergence",
          convergence_class: convergenceClass,
          convergence_coordinate_sha256: sha256(
            canonicalJson({
              event: event.event,
              run_id: event.run_id,
              state_id: "state_id" in event ? (event.state_id ?? null) : null,
              action: "action" in event ? event.action : null,
            })
          ),
        },
      });
      scheduleLease();
    };
    scheduleLease();
    let boundary: Directive;
    try {
      boundary = await child.runner.runUntilBoundary(
        childInitial,
        executionController.signal,
        acceptConvergence,
        acceptWorkerActivity
      );
    } finally {
      if (leaseTimer !== undefined) clearTimeout(leaseTimer);
      signal.removeEventListener("abort", forwardParentCancellation);
    }
    return this.captureBoundary(
      parentEngine,
      child.engine,
      currentRecord,
      boundary,
      signal.aborted
    );
  }

  private captureBoundary(
    parentEngine: OrchestrationEngine,
    childEngine: OrchestrationEngine,
    record: ChildWorkflowCallRecord,
    boundary: Directive,
    parentCancellationRequested: boolean
  ): Directive {
    this.assertFrozenRegistrationBinding(record, parentEngine, childEngine);
    const terminal = terminalAction(boundary);
    const childContext = this.options.checkpointer.loadRun(record.child_identity);
    if (
      childContext.terminalDirective === null ||
      canonicalJson(childContext.terminalDirective) !== canonicalJson(terminal)
    ) {
      throw new Error("child workflow terminal is not the exact durable child terminal");
    }
    const output = exactOutput(terminal, record);
    validateExactOutputCore(this.options.artifacts, output, record.expected_output);
    const observedUsage = childEngine.liveness.resourceUsage(record.child_identity.run_id);
    const observedOutputBytes = output?.byte_length ?? 0;
    if (
      record.schema_version === 1 &&
      (observedUsage.model_turns > record.budget.model_turns ||
        observedUsage.tool_calls > record.budget.tool_calls ||
        observedUsage.external_calls > record.budget.external_calls ||
        childContext.stepCount > record.budget.max_steps ||
        observedOutputBytes > record.budget.output_bytes)
    ) {
      throw new Error("legacy child workflow exceeded its replay-bound allocation");
    }
    const result = validateChildWorkflowResult({
      schema_version: 1,
      call_id: record.call_id,
      parent_run_id: record.parent_identity.run_id,
      parent_state_id: record.parent_state_id,
      call_key: record.call_key,
      child_identity: record.child_identity,
      parent_registration_sha256: record.parent_registration_sha256,
      child_registration_sha256: record.child_registration_sha256,
      terminal_action: terminal.action,
      met: terminal.met,
      parent_obligation: "unresolved",
      terminal_sha256: sha256(canonicalJson(terminal)),
      output_contract: record.expected_output,
      output_artifact: output,
      artifacts: terminal.artifacts,
      usage: {
        schema_version: 1,
        ...observedUsage,
        steps: childContext.stepCount,
        output_bytes: observedOutputBytes,
        unknown_usage: false,
      },
    });
    if (parentCancellationRequested) {
      const cancelled = encodeChildWorkflowCallRecord({
        ...record,
        lifecycle: "cancelled",
        terminal_action: result.terminal_action,
        terminal_sha256: result.terminal_sha256,
        output_artifact: result.output_artifact,
        usage: result.usage,
        updated_at: utcNow(),
      }).record;
      this.state.transition({
        call_id: record.call_id,
        from: "running",
        next: cancelled,
      });
      return parentEngine.handle({
        schema_version: 2,
        action: "cancel",
        identity: record.parent_identity,
        reason: "cancelled by caller",
      });
    }
    const resultRef = this.persistResult(record, result, output);
    const terminalRecord = encodeChildWorkflowCallRecord({
      ...record,
      lifecycle: "terminal_recorded",
      terminal_action: result.terminal_action,
      terminal_sha256: result.terminal_sha256,
      output_artifact: result.output_artifact,
      usage: result.usage,
      updated_at: utcNow(),
    }).record;
    const captured = this.state.transition({
      call_id: record.call_id,
      from: "running",
      next: terminalRecord,
    });
    return this.consumeCapturedTerminal(parentEngine, childEngine, captured, resultRef);
  }

  private consumeCapturedTerminal(
    parentEngine: OrchestrationEngine,
    childEngine: OrchestrationEngine,
    record: ChildWorkflowCallRecord,
    existingResultRef?: ArtifactRef
  ): Directive {
    this.assertFrozenRegistrationBinding(record, parentEngine, childEngine);
    const terminal = terminalAction(
      childEngine.handle({
        schema_version: 2,
        action: "status",
        identity: record.child_identity,
      })
    );
    const child = this.options.checkpointer.loadRun(record.child_identity);
    if (
      child.terminalDirective === null ||
      canonicalJson(child.terminalDirective) !== canonicalJson(terminal)
    ) {
      throw new Error("captured child call has no durable terminal directive");
    }
    const output = exactOutput(terminal, record);
    validateExactOutputCore(this.options.artifacts, output, record.expected_output);
    const result = validateChildWorkflowResult({
      schema_version: 1,
      call_id: record.call_id,
      parent_run_id: record.parent_identity.run_id,
      parent_state_id: record.parent_state_id,
      call_key: record.call_key,
      child_identity: record.child_identity,
      parent_registration_sha256: record.parent_registration_sha256,
      child_registration_sha256: record.child_registration_sha256,
      terminal_action: record.terminal_action,
      met: record.terminal_action === "complete",
      parent_obligation: "unresolved",
      terminal_sha256: record.terminal_sha256,
      output_contract: record.expected_output,
      output_artifact: output,
      artifacts: terminal.artifacts,
      usage: record.usage,
    });
    const resultRef = existingResultRef ?? this.persistResult(record, result, output);
    const prepared = parentEngine.prepareChildWorkflowContinuation({
      record,
      outputArtifact: output,
      resultArtifact: resultRef,
    });
    const consumed = encodeChildWorkflowCallRecord({
      ...record,
      lifecycle: "consumed",
      updated_at: utcNow(),
    }).record;
    this.state.consume({
      call_id: record.call_id,
      next: consumed,
      parentContext: prepared.context,
      eventType: "child_workflow_consumed",
      payload: {
        call_id: record.call_id,
        child_run_id: record.child_identity.run_id,
        terminal_sha256: result.terminal_sha256,
        result_artifact_id: resultRef.artifact_id,
        output_artifact_id: output?.artifact_id ?? "",
      },
    });
    return prepared.next;
  }

  private persistResult(
    record: ChildWorkflowCallRecord,
    result: ChildWorkflowResultV1,
    output: ArtifactRef | null
  ): ArtifactRef {
    const operationId = `child-result:${record.call_id}`;
    const content = canonicalJson(result);
    const existing = this.options.artifacts.refFor(
      record.parent_identity.run_id,
      record.parent_state_id,
      null,
      "child-result",
      operationId,
      1
    );
    const artifact =
      existing ??
      this.options.artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: record.parent_identity.run_id,
          phase: record.parent_state_id,
          branch_id: null,
          kind: "child-result",
          operation_id: operationId,
          version: 1,
          producer: "host:child-workflow-owner",
          media_type: "application/json",
          content_schema: {
            schema_id: "penny.child-workflow-result.v1",
            schema_version: 1,
          },
          parent_ref: null,
          upstream_refs: output === null ? [] : [output],
        },
        content,
      });
    if (
      this.options.artifacts.readById(artifact.artifact_id).toString("utf8") !== content ||
      artifact.content_digest !== sha256(content)
    ) {
      throw new Error("child workflow result artifact failed exact re-read");
    }
    this.options.artifacts.select(artifact);
    return artifact;
  }
}
