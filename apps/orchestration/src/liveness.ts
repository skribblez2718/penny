import { canonicalJson, sha256, type Checkpointer } from "./checkpointer.js";
import type { RunContext } from "./context.js";
import {
  ChildWorkflowProgressLeaseBindingV1Schema,
  LivenessPolicySchema,
  LivenessPolicyV1Schema,
  LivenessPolicyV2Schema,
  LivenessPolicyV3Schema,
  LivenessSnapshotV1Schema,
  type ChildWorkflowProgressLeaseBindingV1,
  type LivenessPolicy,
  type LivenessPolicyV1,
  type LivenessPolicyV2,
  type LivenessPolicyV3,
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
import type {
  AgentSessionLivenessEventV1,
  AgentSessionProtocolErrorCodeV1,
  SessionThinkingLevel,
} from "./model-client.js";
import { makeResearchBudgetPolicy } from "./skill-contracts/research.js";

const MALFORMED_RESULT_LIMIT = 2 as const;
const IDENTICAL_MALFORMED_LIMIT = 2 as const;
const PROTOCOL_ERROR_LIMIT = 4 as const;
const IDENTICAL_PROTOCOL_LIMIT = 2 as const;
const LEGACY_ROUTING_REPAIR_POLICY = {
  max_invocations_per_state_branch: 1,
  model_turns_per_worker: 4,
  tool_calls_per_worker: 2,
  external_calls_per_worker: 0,
  worker_wall_clock_ms: 120_000,
} as const;
const LEASE_ROUTING_REPAIR_POLICY = {
  max_invocations_per_state_branch: 1,
  model_turns_per_worker: 4,
  tool_calls_per_worker: 2,
  external_calls_per_worker: 0,
} as const;

const LEGACY_RESEARCH_LIVENESS_PRESETS = {
  quick: {
    total_phase_repair_invocations: 6,
    model_turns_per_worker: 16,
    model_turns_per_run: 48,
    tool_calls_per_worker: 20,
    tool_calls_per_run: 64,
    external_calls_per_worker: 8,
    external_calls_per_run: 12,
    worker_wall_clock_ms: 5 * 60_000,
    run_wall_clock_ms: 15 * 60_000,
  },
  standard: {
    total_phase_repair_invocations: 16,
    model_turns_per_worker: 20,
    model_turns_per_run: 160,
    tool_calls_per_worker: 32,
    tool_calls_per_run: 256,
    external_calls_per_worker: 12,
    external_calls_per_run: 48,
    worker_wall_clock_ms: 10 * 60_000,
    run_wall_clock_ms: 60 * 60_000,
  },
  deep: {
    total_phase_repair_invocations: 48,
    model_turns_per_worker: 24,
    model_turns_per_run: 384,
    tool_calls_per_worker: 48,
    tool_calls_per_run: 768,
    external_calls_per_worker: 16,
    external_calls_per_run: 96,
    worker_wall_clock_ms: 15 * 60_000,
    run_wall_clock_ms: 180 * 60_000,
  },
} as const;

/** V2 retains finite active-work containment without count-based ordinary-work stops. */
export const RESEARCH_LIVENESS_PRESETS = {
  quick: { worker_active_work_budget_ms: 5 * 60_000, run_active_work_budget_ms: 15 * 60_000 },
  standard: {
    worker_active_work_budget_ms: 10 * 60_000,
    run_active_work_budget_ms: 60 * 60_000,
  },
  deep: {
    worker_active_work_budget_ms: 15 * 60_000,
    run_active_work_budget_ms: 180 * 60_000,
  },
} as const;

type ResearchPreset = keyof typeof RESEARCH_LIVENESS_PRESETS;
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

type WorkerPromptBudgetCounterV1 = {
  readonly worker_remaining: number;
  readonly run_remaining: number;
  readonly effective_remaining: number;
};

export interface WorkerPromptBudgetV1 {
  readonly schema_version: 1;
  readonly preset: string;
  readonly purpose: ExecutionPurpose;
  readonly model_turns: WorkerPromptBudgetCounterV1;
  readonly tool_calls: WorkerPromptBudgetCounterV1;
  readonly external_requests: WorkerPromptBudgetCounterV1;
}

/** New-policy prompt projection: count telemetry is not a remaining-work quota. */
export interface WorkerPromptBudgetV2 {
  readonly schema_version: 2;
  readonly preset: string;
  readonly purpose: ExecutionPurpose;
  readonly active_work: {
    readonly worker_remaining_ms: number;
    readonly run_remaining_ms: number;
    readonly effective_remaining_ms: number;
  };
}
/** New-run projection: the worker may run longer than this interval while trusted progress renews it. */
export interface WorkerPromptBudgetV3 {
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
export type WorkerPromptBudget = WorkerPromptBudgetV1 | WorkerPromptBudgetV2 | WorkerPromptBudgetV3;

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

function legacyPolicy(input: {
  scope: LivenessPolicyV1["scope"];
  preset: string;
  total_phase_repair_invocations: number;
  model_turns_per_worker: number;
  model_turns_per_run: number;
  tool_calls_per_worker: number;
  tool_calls_per_run: number;
  external_calls_per_worker: number;
  external_calls_per_run: number;
  worker_wall_clock_ms: number;
  run_wall_clock_ms: number;
}): LivenessPolicyV1 {
  return validateContract(
    LivenessPolicyV1Schema,
    {
      schema_version: 1,
      ...input,
      malformed_results_per_state_branch: MALFORMED_RESULT_LIMIT,
      identical_malformed_digest_limit: IDENTICAL_MALFORMED_LIMIT,
      protocol_errors_per_worker: PROTOCOL_ERROR_LIMIT,
      identical_protocol_digest_limit: IDENTICAL_PROTOCOL_LIMIT,
      routing_repair: LEGACY_ROUTING_REPAIR_POLICY,
    },
    "legacy liveness policy"
  );
}

export function activeWorkLivenessPolicy(input: {
  readonly scope: LivenessPolicyV2["scope"];
  readonly preset: string;
  readonly worker_active_work_budget_ms: number;
  readonly run_active_work_budget_ms: number;
}): LivenessPolicyV2 {
  return validateContract(
    LivenessPolicyV2Schema,
    {
      schema_version: 2,
      ...input,
      malformed_results_per_state_branch: MALFORMED_RESULT_LIMIT,
      identical_malformed_digest_limit: IDENTICAL_MALFORMED_LIMIT,
      protocol_errors_per_worker: PROTOCOL_ERROR_LIMIT,
      identical_protocol_digest_limit: IDENTICAL_PROTOCOL_LIMIT,
      routing_repair: LEGACY_ROUTING_REPAIR_POLICY,
    },
    "active-work liveness policy"
  );
}

/** Bind the immutable calibrated profile registry for one new ordinary run. */
export function ordinaryLivenessPolicy(input: {
  readonly scope: LivenessPolicyV3["scope"];
  readonly preset: string;
}): LivenessPolicyV3 {
  return validateContract(
    LivenessPolicyV3Schema,
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
      malformed_results_per_state_branch: MALFORMED_RESULT_LIMIT,
      identical_malformed_digest_limit: IDENTICAL_MALFORMED_LIMIT,
      protocol_errors_per_worker: PROTOCOL_ERROR_LIMIT,
      identical_protocol_digest_limit: IDENTICAL_PROTOCOL_LIMIT,
      routing_repair: LEASE_ROUTING_REPAIR_POLICY,
    },
    "ordinary progress-lease liveness policy"
  );
}

export function researchLivenessPolicy(mode: string): LivenessPolicyV3 {
  const preset: ResearchPreset =
    mode === "quick" || mode === "deep" || mode === "standard" ? mode : "standard";
  return ordinaryLivenessPolicy({ scope: "research", preset });
}

/** New-run bootstrap; upgraded to its selected V3 preset after planning. */
export function researchBootstrapLivenessPolicy(): LivenessPolicyV3 {
  return ordinaryLivenessPolicy({ scope: "research", preset: "bootstrap" });
}

/** Exact V1 resolver retained only for durable V1 Research bootstrap continuation. */
export function legacyResearchLivenessPolicy(mode: string): LivenessPolicyV1 {
  const preset: ResearchPreset =
    mode === "quick" || mode === "deep" || mode === "standard" ? mode : "standard";
  return legacyPolicy({
    scope: "research",
    preset,
    ...LEGACY_RESEARCH_LIVENESS_PRESETS[preset],
  });
}

export const RESEARCH_BUDGET_POLICY = makeResearchBudgetPolicy({
  quick: researchLivenessPolicy("quick"),
  standard: researchLivenessPolicy("standard"),
  deep: researchLivenessPolicy("deep"),
});

const KB_INVOCATION_LIMITS = {
  ingest: { invocations: 8, runWallMs: 90 * 60_000 },
  save: { invocations: 7, runWallMs: 90 * 60_000 },
  query: { invocations: 5, runWallMs: 45 * 60_000 },
  promote: { invocations: 5, runWallMs: 45 * 60_000 },
} as const;

export function kbLivenessPolicy(input: {
  readonly action: keyof typeof KB_INVOCATION_LIMITS;
  /** Legacy caller input, deliberately ignored under V2 (no reader-call quota). */
  readonly readerMaxCallsPerPhase?: number;
}): LivenessPolicyV2 {
  const action = KB_INVOCATION_LIMITS[input.action];
  return activeWorkLivenessPolicy({
    scope: "knowledge-base",
    preset: `kb-${input.action}`,
    worker_active_work_budget_ms: 15 * 60_000,
    run_active_work_budget_ms: action.runWallMs,
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
        folded.policy = validateContract(
          LivenessPolicySchema,
          payload.policy,
          "stored liveness policy"
        );
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
    // Every historical V1/V2 policy is authoritative, including a bootstrap record. Only a V3
    // bootstrap may resolve to another V3 preset within the same immutable lease registry.
    if (current !== undefined && (current.schema_version !== 3 || current.preset !== "bootstrap")) {
      return current;
    }
    const resolved = this.resolver?.(context, current);
    if (resolved === undefined) {
      throw new Error(`run '${context.identity.run_id}' has no host liveness policy`);
    }
    validateContract(LivenessPolicySchema, resolved, "resolved liveness policy");
    if (current !== undefined && canonicalJson(current) === canonicalJson(resolved)) return current;
    if (current !== undefined && current.preset !== "bootstrap") {
      throw new Error("a bound liveness policy may only replace the bootstrap policy");
    }
    if (current !== undefined && current.schema_version !== resolved.schema_version) {
      throw new Error("bootstrap liveness policy version may not change during a run");
    }
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
    this.assertWall(policy, folded, atMs);
    const attemptKey = bindingKey(input.stateId, input.branchId);
    if (
      policy.schema_version === 1 &&
      (folded.phaseInvocations >= policy.total_phase_repair_invocations ||
        (folded.phaseAttemptsByBinding.get(attemptKey) ?? 0) >=
          policy.total_phase_repair_invocations)
    ) {
      throw new LivenessExhaustedError("model_turn_budget_exhausted");
    }
    if (
      input.purpose === "routing_repair" &&
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
    this.assertWall(this.requirePolicy(folded), folded, atMs);
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
    if (policy.schema_version !== 3) {
      throw new Error("only a V3 liveness policy can bind a progress lease");
    }
    if (
      policy.lease_registry_id !== LIVENESS_LEASE_REGISTRY_ID ||
      policy.lease_registry_sha256 !== LIVENESS_LEASE_REGISTRY_SHA256 ||
      policy.calibration_id !== LIVENESS_CALIBRATION_ID ||
      policy.calibration_sha256 !== LIVENESS_CALIBRATION_SHA256
    ) {
      throw new Error("bound V3 liveness registry is unavailable for exact replay");
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
    this.assertWall(policy, folded, atMs, worker);
    const repair = worker.purpose === "routing_repair";
    if (event.kind === "activity") {
      this.recordProgress(input.runId, input.workerId, atMs, event);
      return;
    }
    if (event.kind === "model_turn") {
      const exhausted = repair
        ? worker.modelTurns >= policy.routing_repair.model_turns_per_worker
        : policy.schema_version === 1 &&
          (worker.modelTurns >= policy.model_turns_per_worker ||
            folded.modelTurns >= policy.model_turns_per_run);
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
      const toolExhausted = repair
        ? worker.toolCalls >= policy.routing_repair.tool_calls_per_worker
        : policy.schema_version === 1 &&
          (worker.toolCalls >= policy.tool_calls_per_worker ||
            folded.toolCalls >= policy.tool_calls_per_run);
      if (toolExhausted) {
        throw new LivenessExhaustedError("tool_call_budget_exhausted");
      }
      const externalExhausted =
        external &&
        (repair
          ? worker.externalCalls >= policy.routing_repair.external_calls_per_worker
          : policy.schema_version === 1 &&
            (worker.externalCalls >= policy.external_calls_per_worker ||
              folded.externalCalls >= policy.external_calls_per_run));
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
    if ((charged.protocolDigests.get(digest) ?? 0) >= policy.identical_protocol_digest_limit) {
      throw new LivenessExhaustedError("identical_error_stall");
    }
    if (charged.protocolErrors >= policy.protocol_errors_per_worker) {
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
      (after.malformedDigests.get(`${key}:${input.digest}`) ?? 0) >=
      policy.identical_malformed_digest_limit
    ) {
      return "identical_error_stall";
    }
    if ((after.malformedByBinding.get(key) ?? 0) >= policy.malformed_results_per_state_branch) {
      return "malformed_result_budget_exhausted";
    }
    return null;
  }

  /** Historical V1/V2 fixed-duration remainder. V3 has no elapsed-work gate. */
  remainingWorkerWallMs(runId: string, workerId: string): number | undefined {
    const nowMs = checkedNow(this.clock);
    const folded = this.fold(runId);
    const policy = this.requirePolicy(folded);
    if (policy.schema_version === 3) return undefined;
    const worker = folded.workers.get(workerId);
    if (worker === undefined) throw new Error("worker lease is absent");
    const workerLimit = this.workerActiveWorkBudget(policy, worker);
    const workerRemaining = workerLimit - Math.max(0, nowMs - worker.startedAtMs);
    const runRemaining =
      this.runActiveWorkBudget(policy) - unionDuration(activeIntervals(folded, nowMs));
    return Math.max(0, Math.min(workerRemaining, runRemaining));
  }

  /** Current V3 inactivity remainder. Every accepted trusted progress signal renews one interval. */
  workerInactivityLease(
    runId: string,
    workerId: string
  ):
    | {
        readonly intervalMs: number;
        readonly remainingMs: number;
        readonly lastProgressAtMs: number;
        readonly acceptedProgressSignals: number;
        readonly binding?: ChildWorkflowProgressLeaseBindingV1;
      }
    | undefined {
    const nowMs = checkedNow(this.clock);
    const folded = this.fold(runId);
    const policy = this.requirePolicy(folded);
    if (policy.schema_version !== 3) return undefined;
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
    const atMs = checkedNow(this.clock);
    const folded = this.fold(runId);
    const policy = folded.policy;
    if (policy === undefined) return null;
    if (policy.schema_version === 3) {
      // Process downtime is not trusted worker inactivity. Fence the interrupted sessions and let
      // normal recovery reissue work under fresh worker IDs and leases.
      for (const worker of folded.workers.values()) {
        if (worker.endedAtMs === undefined) this.endWorker(runId, worker.workerId, "error");
      }
      return null;
    }
    let reason: LivenessTerminalReason | null = null;
    for (const worker of folded.workers.values()) {
      if (worker.endedAtMs !== undefined) continue;
      const limit = this.workerActiveWorkBudget(policy, worker);
      if (atMs - worker.startedAtMs >= limit) reason = "worker_wall_clock_exhausted";
      this.endWorker(runId, worker.workerId, "error");
    }
    const reconciled = this.fold(runId);
    if (unionDuration(activeIntervals(reconciled, atMs)) >= this.runActiveWorkBudget(policy)) {
      return "run_wall_clock_exhausted";
    }
    return reason;
  }

  /** Read-only host projection. V2 exposes fixed time; V3 exposes renewable inactivity only. */
  workerPromptBudget(runId: string, workerId: string): WorkerPromptBudget {
    const nowMs = checkedNow(this.clock);
    const folded = this.fold(runId);
    const policy = this.requirePolicy(folded);
    const worker = folded.workers.get(workerId);
    if (worker === undefined || worker.endedAtMs !== undefined) {
      throw new Error("prompt budget requires an open worker lease");
    }
    if (policy.schema_version === 3) {
      const lease = this.workerInactivityLease(runId, workerId);
      if (lease === undefined) throw new Error("V3 worker lease projection is absent");
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
    if (policy.schema_version === 2 && worker.purpose === "phase") {
      const workerRemaining = Math.max(
        0,
        this.workerActiveWorkBudget(policy, worker) - Math.max(0, nowMs - worker.startedAtMs)
      );
      const runRemaining = Math.max(
        0,
        this.runActiveWorkBudget(policy) - unionDuration(activeIntervals(folded, nowMs))
      );
      return {
        schema_version: 2,
        preset: policy.preset,
        purpose: worker.purpose,
        active_work: {
          worker_remaining_ms: workerRemaining,
          run_remaining_ms: runRemaining,
          effective_remaining_ms: Math.min(workerRemaining, runRemaining),
        },
      };
    }
    const remaining = (
      workerLimit: number,
      workerUsed: number,
      runLimit: number,
      runUsed: number
    ): WorkerPromptBudgetCounterV1 => {
      const workerRemaining = Math.max(0, workerLimit - workerUsed);
      const runRemaining = Math.max(0, runLimit - runUsed);
      return {
        worker_remaining: workerRemaining,
        run_remaining: runRemaining,
        effective_remaining: Math.min(workerRemaining, runRemaining),
      };
    };
    if (worker.purpose === "routing_repair") {
      return {
        schema_version: 1,
        preset: policy.preset,
        purpose: worker.purpose,
        model_turns: remaining(
          policy.routing_repair.model_turns_per_worker,
          worker.modelTurns,
          policy.routing_repair.model_turns_per_worker,
          worker.modelTurns
        ),
        tool_calls: remaining(
          policy.routing_repair.tool_calls_per_worker,
          worker.toolCalls,
          policy.routing_repair.tool_calls_per_worker,
          worker.toolCalls
        ),
        external_requests: remaining(
          policy.routing_repair.external_calls_per_worker,
          worker.externalCalls,
          policy.routing_repair.external_calls_per_worker,
          worker.externalCalls
        ),
      };
    }
    if (policy.schema_version !== 1) {
      throw new Error("ordinary V2 prompt projection must carry active-work budget");
    }
    return {
      schema_version: 1,
      preset: policy.preset,
      purpose: worker.purpose,
      model_turns: remaining(
        policy.model_turns_per_worker,
        worker.modelTurns,
        policy.model_turns_per_run,
        folded.modelTurns
      ),
      tool_calls: remaining(
        policy.tool_calls_per_worker,
        worker.toolCalls,
        policy.tool_calls_per_run,
        folded.toolCalls
      ),
      external_requests: remaining(
        policy.external_calls_per_worker,
        worker.externalCalls,
        policy.external_calls_per_run,
        folded.externalCalls
      ),
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

  /** Value-preserving invocation telemetry; V2 never interprets it as an admission ceiling. */
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

  private workerInactivityInterval(policy: LivenessPolicyV3, worker: FoldedWorker): number {
    if (worker.leaseBinding !== undefined) return worker.leaseBinding.inactivity_interval_ms;
    return worker.purpose === "routing_repair"
      ? policy.unknown_provider_routing_repair_inactivity_ms
      : policy.unknown_provider_phase_inactivity_ms;
  }

  private workerActiveWorkBudget(
    policy: LivenessPolicyV1 | LivenessPolicyV2,
    worker: FoldedWorker
  ): number {
    if (worker.purpose === "routing_repair") return policy.routing_repair.worker_wall_clock_ms;
    return policy.schema_version === 1
      ? policy.worker_wall_clock_ms
      : policy.worker_active_work_budget_ms;
  }

  private runActiveWorkBudget(policy: LivenessPolicyV1 | LivenessPolicyV2): number {
    return policy.schema_version === 1
      ? policy.run_wall_clock_ms
      : policy.run_active_work_budget_ms;
  }

  private assertWall(
    policy: LivenessPolicy,
    folded: FoldedLiveness,
    atMs: number,
    worker?: FoldedWorker
  ): void {
    if (policy.schema_version === 3) {
      if (
        worker !== undefined &&
        atMs - worker.lastProgressAtMs >= this.workerInactivityInterval(policy, worker)
      ) {
        throw new LivenessExhaustedError("worker_inactivity_lease_expired");
      }
      return;
    }
    if (unionDuration(activeIntervals(folded, atMs)) >= this.runActiveWorkBudget(policy)) {
      throw new LivenessExhaustedError("run_wall_clock_exhausted");
    }
    if (
      worker !== undefined &&
      atMs - worker.startedAtMs >= this.workerActiveWorkBudget(policy, worker)
    ) {
      throw new LivenessExhaustedError("worker_wall_clock_exhausted");
    }
  }
}
