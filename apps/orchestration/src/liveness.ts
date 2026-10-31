import { canonicalJson, sha256, type Checkpointer } from "./checkpointer.js";
import type { RunContext } from "./context.js";
import {
  ChildWorkflowProgressLeaseBindingV1Schema,
  LivenessPolicySchema,
  LivenessSnapshotV1Schema,
  type ChildWorkflowProgressLeaseBindingV1,
  type LivenessPolicy,
  type LivenessSnapshotV1,
  type JsonValue,
  type LivenessTerminalReason,
  validateContract,
} from "./contracts.js";
import {
  LIVENESS_CALIBRATION_ID,
  LIVENESS_CALIBRATION_SHA256,
  LIVENESS_LEASE_REGISTRY_ID,
  LIVENESS_LEASE_REGISTRY_SHA256,
  fallbackWorkerLeaseProfile,
  workerProgressLeaseBinding,
} from "./liveness-profiles.js";
import { decodeCurrentLivenessPolicy } from "./durable-state.js";
import type {
  AgentSessionLivenessEventV1,
  AgentSessionProtocolErrorCodeV1,
  SessionThinkingLevel,
} from "./model-client.js";
import { makeResearchBudgetPolicy } from "./skill-contracts/research.js";

const LEASE_ROUTING_REPAIR_POLICY = {
  max_invocations_per_state_branch: null,
  model_turns_per_worker: null,
  tool_calls_per_worker: null,
  // Unspecified operator allowances grant no tools; registration/YAML authority is separate.
  external_calls_per_worker: null,
} as const;

type ResearchPreset = "quick" | "standard" | "deep";
export type ResearchLivenessPreset = ResearchPreset | "bootstrap";

export const RESEARCH_THINKING_LEVEL_BY_LIVENESS_PRESET = {
  bootstrap: "high",
  quick: "low",
  standard: "high",
  deep: "xhigh",
} as const satisfies Readonly<Record<ResearchLivenessPreset, SessionThinkingLevel>>;

function isResearchLivenessPreset(preset: string): preset is ResearchLivenessPreset {
  return Object.hasOwn(RESEARCH_THINKING_LEVEL_BY_LIVENESS_PRESET, preset);
}

export function researchThinkingLevelForLivenessPreset(preset: string): SessionThinkingLevel {
  if (!isResearchLivenessPreset(preset)) {
    throw new Error(`unknown research liveness preset '${preset}'`);
  }
  return RESEARCH_THINKING_LEVEL_BY_LIVENESS_PRESET[preset];
}

type ExecutionPurpose = "phase" | "routing_repair";

/** The worker may outlive this interval while trusted progress renews its inactivity lease. */
export interface WorkerPromptBudget {
  readonly schema_version: 3;
  readonly preset: string;
  readonly purpose: ExecutionPurpose;
  readonly inactivity_lease: {
    readonly registry_id: string;
    readonly profile_id: string;
    readonly profile_sha256: string;
    readonly interval_ms: number;
    readonly remaining_ms: number;
    readonly last_progress_at_ms: number;
    readonly accepted_progress_signals: number;
  };
}

export type LivenessClock = () => number;
export type LivenessPolicyResolver = (
  context: RunContext,
  boundPolicy?: LivenessPolicy
) => LivenessPolicy | undefined;

export class LivenessExhaustedError extends Error {
  constructor(readonly reason: LivenessTerminalReason) {
    super(reason);
    this.name = "LivenessExhaustedError";
  }
}

function checkedNow(clock: LivenessClock): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("liveness clock must return a non-negative safe integer");
  }
  return value;
}

/** Bind the immutable calibrated profile registry for one new ordinary run. */
export function ordinaryLivenessPolicy(input: {
  readonly scope: LivenessPolicy["scope"];
  readonly preset: string;
}): LivenessPolicy {
  return validateContract(
    LivenessPolicySchema,
    {
      schema_version: 3,
      ...input,
      lease_registry_id: LIVENESS_LEASE_REGISTRY_ID,
      lease_registry_sha256: LIVENESS_LEASE_REGISTRY_SHA256,
      calibration_id: LIVENESS_CALIBRATION_ID,
      calibration_sha256: LIVENESS_CALIBRATION_SHA256,
      unknown_provider_phase_inactivity_ms:
        fallbackWorkerLeaseProfile("phase").inactivity_interval_ms,
      unknown_provider_routing_repair_inactivity_ms:
        fallbackWorkerLeaseProfile("routing_repair").inactivity_interval_ms,
      renewal_policy: "trusted_host_activity_or_convergence_v1",
      malformed_results_per_state_branch: null,
      identical_malformed_digest_limit: null,
      protocol_errors_per_worker: null,
      identical_protocol_digest_limit: null,
      routing_repair: LEASE_ROUTING_REPAIR_POLICY,
    },
    "ordinary progress-lease liveness policy"
  );
}

export function researchLivenessPolicy(mode: string): LivenessPolicy {
  const preset: ResearchPreset =
    mode === "quick" || mode === "deep" || mode === "standard" ? mode : "standard";
  return ordinaryLivenessPolicy({ scope: "research", preset });
}

/** Bootstrap resolves to the selected current preset after planning. */
export function researchBootstrapLivenessPolicy(): LivenessPolicy {
  return ordinaryLivenessPolicy({ scope: "research", preset: "bootstrap" });
}

export const RESEARCH_BUDGET_POLICY = makeResearchBudgetPolicy({
  quick: researchLivenessPolicy("quick"),
  standard: researchLivenessPolicy("standard"),
  deep: researchLivenessPolicy("deep"),
});

export function kbLivenessPolicy(input: {
  readonly action: "ingest" | "save" | "query" | "promote";
  /** Caller telemetry only; it cannot grant or impose a reader-call quota. */
  readonly readerMaxCallsPerPhase?: number;
}): LivenessPolicy {
  return ordinaryLivenessPolicy({
    scope: "knowledge-base",
    preset: `kb-${input.action}`,
  });
}

export function isExternalCallTool(toolName: string): boolean {
  return (
    toolName === "web_search" ||
    toolName === "web_fetch" ||
    toolName === "youtube_transcript" ||
    toolName === "bash" ||
    toolName.startsWith("playwright_")
  );
}

export function malformedErrorDigest(input: {
  kind: string;
  stateId: string;
  branchId: string | null;
  schemaIssues: readonly string[];
}): string {
  return sha256(
    canonicalJson({
      kind: input.kind,
      state_id: input.stateId,
      branch_id: input.branchId,
      sorted_schema_issues: [...input.schemaIssues].sort(),
    })
  );
}

export function kbProtocolErrorDigest(input: {
  stateId: string;
  toolName: string;
  errorCode: AgentSessionProtocolErrorCodeV1;
}): string {
  return sha256(
    canonicalJson({
      state_id: input.stateId,
      tool_name: input.toolName,
      error_code: input.errorCode,
    })
  );
}

interface FoldedWorker {
  readonly workerId: string;
  readonly stateId: string;
  readonly branchId: string | null;
  readonly purpose: ExecutionPurpose;
  readonly startedAtMs: number;
  endedAtMs: number | undefined;
  lastProgressAtMs: number;
  acceptedProgressSignals: number;
  leaseBinding: ChildWorkflowProgressLeaseBindingV1 | undefined;
  modelTurns: number;
  toolCalls: number;
  externalCalls: number;
  protocolErrors: number;
  readonly protocolDigests: Map<string, number>;
}

interface FoldedLiveness {
  policy: LivenessPolicy | undefined;
  phaseInvocations: number;
  repairInvocations: number;
  modelTurns: number;
  toolCalls: number;
  externalCalls: number;
  malformedResults: number;
  protocolErrors: number;
  terminalReason: LivenessTerminalReason | null;
  readonly phaseAttemptsByBinding: Map<string, number>;
  readonly repairByBinding: Map<string, number>;
  readonly malformedByBinding: Map<string, number>;
  readonly malformedDigests: Map<string, number>;
  readonly workers: Map<string, FoldedWorker>;
}

interface CachedFoldedLiveness {
  readonly folded: FoldedLiveness;
  throughSequence: number;
}

function emptyFold(): FoldedLiveness {
  return {
    policy: undefined,
    phaseInvocations: 0,
    repairInvocations: 0,
    modelTurns: 0,
    toolCalls: 0,
    externalCalls: 0,
    malformedResults: 0,
    protocolErrors: 0,
    terminalReason: null,
    phaseAttemptsByBinding: new Map(),
    repairByBinding: new Map(),
    malformedByBinding: new Map(),
    malformedDigests: new Map(),
    workers: new Map(),
  };
}

function stringField(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`stored liveness event has invalid ${key}`);
  }
  return value;
}

function nullableStringField(
  payload: Readonly<Record<string, unknown>>,
  key: string
): string | null {
  const value = payload[key];
  if (value === null) return null;
  return stringField(payload, key);
}

function integerField(payload: Readonly<Record<string, unknown>>, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`stored liveness event has invalid ${key}`);
  }
  return Number(value);
}

function purposeField(payload: Readonly<Record<string, unknown>>): ExecutionPurpose {
  if (payload.purpose === "routing_repair" || payload.purpose === "phase") return payload.purpose;
  throw new Error("stored liveness event has invalid purpose");
}

function bindingKey(stateId: string, branchId: string | null): string {
  return canonicalJson({ state_id: stateId, branch_id: branchId });
}

function increment(map: Map<string, number>, key: string): number {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}

function activeIntervals(folded: FoldedLiveness, nowMs: number): Array<[number, number]> {
  return [...folded.workers.values()]
    .map((worker): [number, number] => [
      worker.startedAtMs,
      Math.max(worker.startedAtMs, worker.endedAtMs ?? nowMs),
    ])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

function unionDuration(intervals: readonly [number, number][]): number {
  let total = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const interval of intervals) {
    if (start === undefined || end === undefined) {
      [start, end] = interval;
      continue;
    }
    if (interval[0] > end) {
      total += end - start;
      [start, end] = interval;
    } else {
      end = Math.max(end, interval[1]);
    }
  }
  return start === undefined || end === undefined ? 0 : total + end - start;
}

function terminalReason(value: unknown): LivenessTerminalReason | null {
  try {
    return validateContract(
      LivenessSnapshotV1Schema.properties.terminal_reason,
      value ?? null,
      "stored liveness terminal reason"
    );
  } catch {
    throw new Error("stored liveness terminal reason is malformed");
  }
}

export class LivenessController {
  private resolver: LivenessPolicyResolver | undefined;
  /**
   * Cache the already-validated fold and consume only its indexed durable suffix. This keeps
   * high-frequency provider deltas O(n) overall while still observing engine events written
   * outside this controller and rebuilding exact state after process recovery.
   */
  private readonly foldedRuns = new Map<string, CachedFoldedLiveness>();

  constructor(
    private readonly checkpointer: Checkpointer,
    private readonly clock: LivenessClock = Date.now
  ) {}

  setPolicyResolver(resolver: LivenessPolicyResolver): void {
    this.resolver = resolver;
  }

  private applyEvent(
    folded: FoldedLiveness,
    eventType: string,
    payload: Readonly<Record<string, unknown>>
  ): void {
    switch (eventType) {
      case "liveness_policy_bound":
        folded.policy = decodeCurrentLivenessPolicy(payload.policy);
        break;
      case "liveness_invocation_admitted": {
        const purpose = purposeField(payload);
        const key = bindingKey(
          stringField(payload, "state_id"),
          nullableStringField(payload, "branch_id")
        );
        folded.phaseInvocations += 1;
        increment(folded.phaseAttemptsByBinding, key);
        if (purpose === "routing_repair") {
          folded.repairInvocations += 1;
          increment(folded.repairByBinding, key);
        }
        break;
      }
      case "liveness_worker_started": {
        const workerId = stringField(payload, "worker_id");
        if (folded.workers.has(workerId)) throw new Error("duplicate liveness worker start");
        const startedAtMs = integerField(payload, "at_ms");
        folded.workers.set(workerId, {
          workerId,
          stateId: stringField(payload, "state_id"),
          branchId: nullableStringField(payload, "branch_id"),
          purpose: purposeField(payload),
          startedAtMs,
          endedAtMs: undefined,
          lastProgressAtMs: startedAtMs,
          acceptedProgressSignals: 0,
          leaseBinding: undefined,
          modelTurns: 0,
          toolCalls: 0,
          externalCalls: 0,
          protocolErrors: 0,
          protocolDigests: new Map(),
        });
        break;
      }
      case "liveness_worker_lease_bound": {
        const worker = folded.workers.get(stringField(payload, "worker_id"));
        if (worker === undefined || worker.endedAtMs !== undefined || worker.leaseBinding) {
          throw new Error("liveness worker lease binding has no unique open worker");
        }
        worker.leaseBinding = validateContract(
          ChildWorkflowProgressLeaseBindingV1Schema,
          payload.binding,
          "stored worker progress lease binding"
        );
        break;
      }
      case "liveness_progress_observed": {
        const worker = folded.workers.get(stringField(payload, "worker_id"));
        if (worker === undefined || worker.endedAtMs !== undefined) {
          throw new Error("liveness progress has no open worker lease");
        }
        const atMs = integerField(payload, "at_ms");
        if (atMs < worker.lastProgressAtMs) {
          throw new Error("liveness progress time regressed");
        }
        const observedUnits = integerField(payload, "observed_units");
        if (observedUnits === 0 || observedUnits > 16_777_216) {
          throw new Error("stored liveness progress has invalid observed_units");
        }
        stringField(payload, "activity_class");
        worker.lastProgressAtMs = atMs;
        worker.acceptedProgressSignals += 1;
        break;
      }
      case "liveness_worker_ended": {
        const worker = folded.workers.get(stringField(payload, "worker_id"));
        if (worker === undefined || worker.endedAtMs !== undefined) {
          throw new Error("liveness worker end has no unique open lease");
        }
        worker.endedAtMs = integerField(payload, "at_ms");
        break;
      }
      case "liveness_model_turn_charged": {
        const worker = folded.workers.get(stringField(payload, "worker_id"));
        if (worker === undefined) throw new Error("model turn has no worker lease");
        worker.modelTurns += 1;
        folded.modelTurns += 1;
        break;
      }
      case "liveness_tool_call_charged": {
        const worker = folded.workers.get(stringField(payload, "worker_id"));
        if (worker === undefined) throw new Error("tool call has no worker lease");
        worker.toolCalls += 1;
        folded.toolCalls += 1;
        if (payload.external === true) {
          worker.externalCalls += 1;
          folded.externalCalls += 1;
        }
        break;
      }
      case "liveness_malformed_charged": {
        const stateId = stringField(payload, "state_id");
        const branchId = nullableStringField(payload, "branch_id");
        const digest = stringField(payload, "digest");
        folded.malformedResults += 1;
        increment(folded.malformedByBinding, bindingKey(stateId, branchId));
        increment(folded.malformedDigests, `${bindingKey(stateId, branchId)}:${digest}`);
        break;
      }
      case "liveness_protocol_error_charged": {
        const worker = folded.workers.get(stringField(payload, "worker_id"));
        if (worker === undefined) throw new Error("protocol error has no worker lease");
        const digest = stringField(payload, "digest");
        worker.protocolErrors += 1;
        folded.protocolErrors += 1;
        increment(worker.protocolDigests, digest);
        break;
      }
      default: {
        const reason = terminalReason(payload.terminal_reason);
        if (reason !== null) folded.terminalReason = reason;
      }
    }
  }

  private fold(runId: string): FoldedLiveness {
    let cached = this.foldedRuns.get(runId);
    if (cached === undefined) {
      cached = { folded: emptyFold(), throughSequence: 0 };
      this.foldedRuns.set(runId, cached);
    }
    for (const event of this.checkpointer.eventsAfter(runId, cached.throughSequence)) {
      this.applyEvent(cached.folded, event.eventType, event.payload);
      cached.throughSequence = event.sequence;
    }
    return cached.folded;
  }

  private appendEvent(runId: string, eventType: string, payload: Record<string, JsonValue>): void {
    this.checkpointer.appendLivenessEvent(runId, eventType, payload);
  }

  hasPolicy(runId: string): boolean {
    return this.fold(runId).policy !== undefined;
  }

  canBindPolicy(context: RunContext): boolean {
    if (this.hasPolicy(context.identity.run_id)) return true;
    return this.resolver?.(context) !== undefined;
  }

  policy(runId: string): LivenessPolicy | undefined {
    return this.fold(runId).policy;
  }

  bindPolicy(context: RunContext): LivenessPolicy {
    const folded = this.fold(context.identity.run_id);
    const current = folded.policy;
    // Only a current bootstrap may resolve to another preset in the same lease registry.
    if (current !== undefined && current.preset !== "bootstrap") {
      return current;
    }
    const resolved = this.resolver?.(context, current);
    if (resolved === undefined) {
      throw new Error(`run '${context.identity.run_id}' has no host liveness policy`);
    }
    validateContract(LivenessPolicySchema, resolved, "resolved liveness policy");
    if (current !== undefined && canonicalJson(current) === canonicalJson(resolved)) return current;
    this.appendEvent(context.identity.run_id, "liveness_policy_bound", {
      schema_version: 1,
      at_ms: checkedNow(this.clock),
      policy: resolved,
    });
    return resolved;
  }

  admitInvocation(input: {
    runId: string;
    stateId: string;
    branchId: string | null;
    attempt: number;
    purpose: ExecutionPurpose;
  }): void {
    const atMs = checkedNow(this.clock);
    const folded = this.fold(input.runId);
    const policy = this.requirePolicy(folded);
    const attemptKey = bindingKey(input.stateId, input.branchId);
    if (
      input.purpose === "routing_repair" &&
      policy.routing_repair.max_invocations_per_state_branch !== null &&
      (folded.repairByBinding.get(attemptKey) ?? 0) >=
        policy.routing_repair.max_invocations_per_state_branch
    ) {
      throw new LivenessExhaustedError("malformed_result_budget_exhausted");
    }
    this.appendEvent(input.runId, "liveness_invocation_admitted", {
      schema_version: 1,
      at_ms: atMs,
      state_id: input.stateId,
      branch_id: input.branchId,
      attempt: input.attempt,
      purpose: input.purpose,
    });
  }

  startWorker(input: {
    runId: string;
    workerId: string;
    stateId: string;
    branchId: string | null;
    purpose: ExecutionPurpose;
  }): void {
    const atMs = checkedNow(this.clock);
    const folded = this.fold(input.runId);
    this.requirePolicy(folded);
    this.appendEvent(input.runId, "liveness_worker_started", {
      schema_version: 1,
      at_ms: atMs,
      worker_id: input.workerId,
      state_id: input.stateId,
      branch_id: input.branchId,
      purpose: input.purpose,
    });
  }

  bindWorkerProgressLease(input: {
    runId: string;
    workerId: string;
    providerId: string;
    modelId: string;
  }): ChildWorkflowProgressLeaseBindingV1 {
    const atMs = checkedNow(this.clock);
    const folded = this.fold(input.runId);
    const policy = this.requirePolicy(folded);
    if (
      policy.lease_registry_id !== LIVENESS_LEASE_REGISTRY_ID ||
      policy.lease_registry_sha256 !== LIVENESS_LEASE_REGISTRY_SHA256 ||
      policy.calibration_id !== LIVENESS_CALIBRATION_ID ||
      policy.calibration_sha256 !== LIVENESS_CALIBRATION_SHA256
    ) {
      throw new Error("bound liveness registry is unavailable for exact replay");
    }
    const worker = folded.workers.get(input.workerId);
    if (worker === undefined || worker.endedAtMs !== undefined) {
      throw new Error("worker progress lease binding requires an open worker");
    }
    if (worker.leaseBinding !== undefined) {
      if (
        worker.leaseBinding.provider_id !== input.providerId ||
        worker.leaseBinding.model_id !== input.modelId
      ) {
        throw new Error("worker progress lease is already bound to another model");
      }
      return worker.leaseBinding;
    }
    const binding = validateContract(
      ChildWorkflowProgressLeaseBindingV1Schema,
      workerProgressLeaseBinding({
        providerId: input.providerId,
        modelId: input.modelId,
        purpose: worker.purpose,
      }),
      "resolved worker progress lease binding"
    );
    if (atMs - worker.lastProgressAtMs >= binding.inactivity_interval_ms) {
      throw new LivenessExhaustedError("worker_inactivity_lease_expired");
    }
    this.appendEvent(input.runId, "liveness_worker_lease_bound", {
      schema_version: 1,
      at_ms: atMs,
      worker_id: input.workerId,
      binding,
    });
    return binding;
  }

  endWorker(runId: string, workerId: string, outcome: "complete" | "error" | "cancelled"): void {
    const folded = this.fold(runId);
    const worker = folded.workers.get(workerId);
    if (worker === undefined || worker.endedAtMs !== undefined) return;
    this.appendEvent(runId, "liveness_worker_ended", {
      schema_version: 1,
      at_ms: checkedNow(this.clock),
      worker_id: workerId,
      outcome,
    });
  }

  sessionSink(input: {
    runId: string;
    workerId: string;
    stateId: string;
  }): (event: AgentSessionLivenessEventV1) => void {
    return (event) => this.chargeSessionEvent(input, event);
  }

  private chargeSessionEvent(
    input: { runId: string; workerId: string; stateId: string },
    event: AgentSessionLivenessEventV1
  ): void {
    const atMs = checkedNow(this.clock);
    const folded = this.fold(input.runId);
    const policy = this.requirePolicy(folded);
    const worker = folded.workers.get(input.workerId);
    if (worker === undefined || worker.endedAtMs !== undefined) {
      throw new Error("liveness event has no open worker lease");
    }
    this.assertInactivity(policy, atMs, worker);
    const repair = worker.purpose === "routing_repair";
    if (event.kind === "activity") {
      this.recordProgress(input.runId, input.workerId, atMs, event);
      return;
    }
    if (event.kind === "model_turn") {
      const exhausted =
        repair &&
        policy.routing_repair.model_turns_per_worker !== null &&
        worker.modelTurns >= policy.routing_repair.model_turns_per_worker;
      if (exhausted) {
        throw new LivenessExhaustedError("model_turn_budget_exhausted");
      }
      this.appendEvent(input.runId, "liveness_model_turn_charged", {
        schema_version: 1,
        at_ms: atMs,
        worker_id: input.workerId,
        source: event.source,
      });
      return;
    }
    if (event.kind === "tool_call") {
      const external = isExternalCallTool(event.tool_name);
      const toolExhausted =
        repair &&
        policy.routing_repair.tool_calls_per_worker !== null &&
        worker.toolCalls >= policy.routing_repair.tool_calls_per_worker;
      if (toolExhausted) {
        throw new LivenessExhaustedError("tool_call_budget_exhausted");
      }
      const externalExhausted =
        external &&
        repair &&
        policy.routing_repair.external_calls_per_worker !== null &&
        worker.externalCalls >= policy.routing_repair.external_calls_per_worker;
      if (externalExhausted) {
        throw new LivenessExhaustedError("external_request_budget_exhausted");
      }
      this.appendEvent(input.runId, "liveness_tool_call_charged", {
        schema_version: 1,
        at_ms: atMs,
        worker_id: input.workerId,
        tool_name: event.tool_name,
        external,
      });
      if (event.progress !== undefined) {
        this.recordProgress(input.runId, input.workerId, atMs, event.progress);
      }
      return;
    }
    const digest = kbProtocolErrorDigest({
      stateId: input.stateId,
      toolName: event.tool_name,
      errorCode: event.error_code,
    });
    this.appendEvent(input.runId, "liveness_protocol_error_charged", {
      schema_version: 1,
      at_ms: atMs,
      worker_id: input.workerId,
      state_id: input.stateId,
      tool_name: event.tool_name,
      error_code: event.error_code,
      digest,
    });
    if (event.progress !== undefined) {
      this.recordProgress(input.runId, input.workerId, atMs, event.progress);
    }
    const after = this.fold(input.runId);
    const charged = after.workers.get(input.workerId);
    if (charged === undefined) throw new Error("charged protocol worker is absent");
    if (
      policy.identical_protocol_digest_limit !== null &&
      (charged.protocolDigests.get(digest) ?? 0) >= policy.identical_protocol_digest_limit
    ) {
      throw new LivenessExhaustedError("identical_error_stall");
    }
    if (
      policy.protocol_errors_per_worker !== null &&
      charged.protocolErrors >= policy.protocol_errors_per_worker
    ) {
      throw new LivenessExhaustedError("protocol_error_budget_exhausted");
    }
  }

  chargeMalformed(input: {
    runId: string;
    stateId: string;
    branchId: string | null;
    digest: string;
  }): LivenessTerminalReason | null {
    const policy = this.requirePolicy(this.fold(input.runId));
    this.appendEvent(input.runId, "liveness_malformed_charged", {
      schema_version: 1,
      at_ms: checkedNow(this.clock),
      state_id: input.stateId,
      branch_id: input.branchId,
      digest: input.digest,
    });
    const after = this.fold(input.runId);
    const key = bindingKey(input.stateId, input.branchId);
    if (
      policy.identical_malformed_digest_limit !== null &&
      (after.malformedDigests.get(`${key}:${input.digest}`) ?? 0) >=
        policy.identical_malformed_digest_limit
    ) {
      return "identical_error_stall";
    }
    if (
      policy.malformed_results_per_state_branch !== null &&
      (after.malformedByBinding.get(key) ?? 0) >= policy.malformed_results_per_state_branch
    ) {
      return "malformed_result_budget_exhausted";
    }
    return null;
  }

  /** Current inactivity remainder. Every accepted trusted progress signal renews one interval. */
  workerInactivityLease(
    runId: string,
    workerId: string
  ): {
    readonly intervalMs: number;
    readonly remainingMs: number;
    readonly lastProgressAtMs: number;
    readonly acceptedProgressSignals: number;
    readonly binding?: ChildWorkflowProgressLeaseBindingV1;
  } {
    const nowMs = checkedNow(this.clock);
    const folded = this.fold(runId);
    const policy = this.requirePolicy(folded);
    const worker = folded.workers.get(workerId);
    if (worker === undefined || worker.endedAtMs !== undefined) {
      throw new Error("worker inactivity lease requires an open worker");
    }
    const intervalMs = this.workerInactivityInterval(policy, worker);
    return {
      intervalMs,
      remainingMs: Math.max(0, intervalMs - Math.max(0, nowMs - worker.lastProgressAtMs)),
      lastProgressAtMs: worker.lastProgressAtMs,
      acceptedProgressSignals: worker.acceptedProgressSignals,
      ...(worker.leaseBinding === undefined ? {} : { binding: worker.leaseBinding }),
    };
  }

  cancelOpenWorkers(runId: string): void {
    const folded = this.fold(runId);
    for (const worker of folded.workers.values()) {
      if (worker.endedAtMs === undefined) this.endWorker(runId, worker.workerId, "cancelled");
    }
  }

  recoverOpenWorkers(runId: string): LivenessTerminalReason | null {
    const folded = this.fold(runId);
    if (folded.policy === undefined) return null;
    // Process downtime is not trusted inactivity or active execution. Fence every interrupted
    // session and let normal recovery reissue work under a fresh worker ID.
    for (const worker of folded.workers.values()) {
      if (worker.endedAtMs === undefined) this.endWorker(runId, worker.workerId, "error");
    }
    return null;
  }

  /** Read-only host projection of the current renewable inactivity lease. */
  workerPromptBudget(runId: string, workerId: string): WorkerPromptBudget {
    const folded = this.fold(runId);
    const policy = this.requirePolicy(folded);
    const worker = folded.workers.get(workerId);
    if (worker === undefined || worker.endedAtMs !== undefined) {
      throw new Error("prompt budget requires an open worker lease");
    }
    const lease = this.workerInactivityLease(runId, workerId);
    const fallback = fallbackWorkerLeaseProfile(worker.purpose);
    return {
      schema_version: 3,
      preset: policy.preset,
      purpose: worker.purpose,
      inactivity_lease: {
        registry_id: policy.lease_registry_id,
        profile_id: lease.binding?.profile_id ?? fallback.profile_id,
        profile_sha256: lease.binding?.profile_sha256 ?? fallback.profile_sha256,
        interval_ms: lease.intervalMs,
        remaining_ms: lease.remainingMs,
        last_progress_at_ms: lease.lastProgressAtMs,
        accepted_progress_signals: lease.acceptedProgressSignals,
      },
    };
  }

  /** Durable, content-free resource usage for child allocation settlement and status. */
  resourceUsage(runId: string): {
    readonly model_turns: number;
    readonly tool_calls: number;
    readonly external_calls: number;
    readonly active_wall_clock_ms: number;
  } {
    const atMs = checkedNow(this.clock);
    const folded = this.fold(runId);
    this.requirePolicy(folded);
    return {
      model_turns: folded.modelTurns,
      tool_calls: folded.toolCalls,
      external_calls: folded.externalCalls,
      active_wall_clock_ms: unionDuration(activeIntervals(folded, atMs)),
    };
  }

  /** Invocation telemetry, never an ordinary-work admission ceiling. */
  phaseAttemptProjection(runId: string): Readonly<Record<string, number>> {
    return Object.fromEntries([...this.fold(runId).phaseAttemptsByBinding.entries()].sort());
  }

  snapshot(runId: string): LivenessSnapshotV1 {
    const atMs = checkedNow(this.clock);
    const folded = this.fold(runId);
    return validateContract(
      LivenessSnapshotV1Schema,
      {
        schema_version: 1,
        policy_state: folded.policy === undefined ? "legacy_unmetered" : "bound",
        preset: folded.policy?.preset ?? null,
        phase_invocations: folded.phaseInvocations,
        repair_invocations: folded.repairInvocations,
        model_turns: folded.modelTurns,
        tool_calls: folded.toolCalls,
        external_calls: folded.externalCalls,
        malformed_results: folded.malformedResults,
        protocol_errors: folded.protocolErrors,
        active_wall_clock_ms: unionDuration(activeIntervals(folded, atMs)),
        open_workers: [...folded.workers.values()].filter(
          (worker) => worker.endedAtMs === undefined
        ).length,
        terminal_reason: folded.terminalReason,
      },
      "liveness snapshot"
    );
  }

  private requirePolicy(folded: FoldedLiveness): LivenessPolicy {
    if (folded.policy === undefined) throw new Error("legacy_unmetered");
    return folded.policy;
  }

  private recordProgress(
    runId: string,
    workerId: string,
    atMs: number,
    progress: { readonly activity_class: string; readonly observed_units: number }
  ): void {
    if (
      !Number.isSafeInteger(progress.observed_units) ||
      progress.observed_units <= 0 ||
      progress.observed_units > 16_777_216
    ) {
      throw new Error("liveness progress observed_units must be a bounded positive integer");
    }
    this.appendEvent(runId, "liveness_progress_observed", {
      schema_version: 1,
      at_ms: atMs,
      worker_id: workerId,
      activity_class: progress.activity_class,
      observed_units: progress.observed_units,
    });
  }

  private workerInactivityInterval(policy: LivenessPolicy, worker: FoldedWorker): number {
    if (worker.leaseBinding !== undefined) return worker.leaseBinding.inactivity_interval_ms;
    return worker.purpose === "routing_repair"
      ? policy.unknown_provider_routing_repair_inactivity_ms
      : policy.unknown_provider_phase_inactivity_ms;
  }

  private assertInactivity(policy: LivenessPolicy, atMs: number, worker: FoldedWorker): void {
    if (atMs - worker.lastProgressAtMs >= this.workerInactivityInterval(policy, worker)) {
      throw new LivenessExhaustedError("worker_inactivity_lease_expired");
    }
  }
}
