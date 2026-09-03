import { canonicalJson, sha256, type Checkpointer } from "./checkpointer.js";
import type { RunContext } from "./context.js";
import {
  LivenessPolicyV1Schema,
  LivenessSnapshotV1Schema,
  type LivenessPolicyV1,
  type LivenessSnapshotV1,
  type LivenessTerminalReason,
  validateContract,
} from "./contracts.js";
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
const ROUTING_REPAIR_POLICY = {
  max_invocations_per_state_branch: 1,
  model_turns_per_worker: 4,
  tool_calls_per_worker: 2,
  external_calls_per_worker: 0,
  worker_wall_clock_ms: 120_000,
} as const;

export const RESEARCH_LIVENESS_PRESETS = {
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

export type LivenessClock = () => number;
export type LivenessPolicyResolver = (context: RunContext) => LivenessPolicyV1 | undefined;

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

function basePolicy(input: {
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
      routing_repair: ROUTING_REPAIR_POLICY,
    },
    "liveness policy"
  );
}

export function researchLivenessPolicy(mode: string): LivenessPolicyV1 {
  const preset: ResearchPreset =
    mode === "quick" || mode === "deep" || mode === "standard" ? mode : "standard";
  return basePolicy({ scope: "research", preset, ...RESEARCH_LIVENESS_PRESETS[preset] });
}

/**
 * An unspecified research mode gets the standard planning envelope under a
 * distinct bootstrap binding. The model-declared preset replaces it durably
 * before the next worker; all bootstrap charges remain in the same event log.
 */
export function researchBootstrapLivenessPolicy(): LivenessPolicyV1 {
  return basePolicy({
    scope: "research",
    preset: "bootstrap",
    ...RESEARCH_LIVENESS_PRESETS.standard,
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
  action: keyof typeof KB_INVOCATION_LIMITS;
  readerMaxCallsPerPhase: number;
}): LivenessPolicyV1 {
  const boundedReaderCalls = Math.min(Math.max(1, input.readerMaxCallsPerPhase), 64);
  const toolCallsPerWorker = boundedReaderCalls + 6;
  const modelTurnsPerWorker = boundedReaderCalls + 8;
  const action = KB_INVOCATION_LIMITS[input.action];
  return basePolicy({
    scope: "knowledge-base",
    preset: `kb-${input.action}`,
    total_phase_repair_invocations: action.invocations,
    model_turns_per_worker: modelTurnsPerWorker,
    model_turns_per_run: modelTurnsPerWorker * action.invocations,
    tool_calls_per_worker: toolCallsPerWorker,
    tool_calls_per_run: toolCallsPerWorker * action.invocations,
    external_calls_per_worker: 0,
    external_calls_per_run: 0,
    worker_wall_clock_ms: 15 * 60_000,
    run_wall_clock_ms: action.runWallMs,
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
  modelTurns: number;
  toolCalls: number;
  externalCalls: number;
  protocolErrors: number;
  readonly protocolDigests: Map<string, number>;
}

interface FoldedLiveness {
  policy: LivenessPolicyV1 | undefined;
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
  return payload.purpose === "routing_repair" ? "routing_repair" : "phase";
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

  constructor(
    private readonly checkpointer: Checkpointer,
    private readonly clock: LivenessClock = Date.now
  ) {}

  setPolicyResolver(resolver: LivenessPolicyResolver): void {
    this.resolver = resolver;
  }

  private fold(runId: string): FoldedLiveness {
    const folded = emptyFold();
    for (const event of this.checkpointer.events(runId)) {
      const payload = event.payload;
      switch (event.eventType) {
        case "liveness_policy_bound":
          folded.policy = validateContract(
            LivenessPolicyV1Schema,
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
          folded.workers.set(workerId, {
            workerId,
            stateId: stringField(payload, "state_id"),
            branchId: nullableStringField(payload, "branch_id"),
            purpose: purposeField(payload),
            startedAtMs: integerField(payload, "at_ms"),
            endedAtMs: undefined,
            modelTurns: 0,
            toolCalls: 0,
            externalCalls: 0,
            protocolErrors: 0,
            protocolDigests: new Map(),
          });
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
          worker.protocolErrors += 1;
          folded.protocolErrors += 1;
          increment(worker.protocolDigests, stringField(payload, "digest"));
          break;
        }
        default: {
          const reason = terminalReason(payload.terminal_reason);
          if (reason !== null) folded.terminalReason = reason;
        }
      }
    }
    return folded;
  }

  hasPolicy(runId: string): boolean {
    return this.fold(runId).policy !== undefined;
  }

  canBindPolicy(context: RunContext): boolean {
    if (this.hasPolicy(context.identity.run_id)) return true;
    return this.resolver?.(context) !== undefined;
  }

  policy(runId: string): LivenessPolicyV1 | undefined {
    return this.fold(runId).policy;
  }

  bindPolicy(context: RunContext): LivenessPolicyV1 {
    const folded = this.fold(context.identity.run_id);
    const current = folded.policy;
    const resolved = this.resolver?.(context);
    if (resolved === undefined) {
      throw new Error(`run '${context.identity.run_id}' has no host liveness policy`);
    }
    validateContract(LivenessPolicyV1Schema, resolved, "resolved liveness policy");
    if (current !== undefined && canonicalJson(current) === canonicalJson(resolved)) return current;
    if (current !== undefined && current.preset !== "bootstrap") {
      throw new Error("a bound liveness policy may only replace the bootstrap policy");
    }
    this.checkpointer.appendLivenessEvent(context.identity.run_id, "liveness_policy_bound", {
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
    if (folded.phaseInvocations >= policy.total_phase_repair_invocations) {
      throw new LivenessExhaustedError("model_turn_budget_exhausted");
    }
    const attemptKey = bindingKey(input.stateId, input.branchId);
    if (
      (folded.phaseAttemptsByBinding.get(attemptKey) ?? 0) >= policy.total_phase_repair_invocations
    ) {
      throw new LivenessExhaustedError("model_turn_budget_exhausted");
    }
    if (
      input.purpose === "routing_repair" &&
      (folded.repairByBinding.get(bindingKey(input.stateId, input.branchId)) ?? 0) >=
        policy.routing_repair.max_invocations_per_state_branch
    ) {
      throw new LivenessExhaustedError("malformed_result_budget_exhausted");
    }
    this.checkpointer.appendLivenessEvent(input.runId, "liveness_invocation_admitted", {
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
    this.checkpointer.appendLivenessEvent(input.runId, "liveness_worker_started", {
      schema_version: 1,
      at_ms: atMs,
      worker_id: input.workerId,
      state_id: input.stateId,
      branch_id: input.branchId,
      purpose: input.purpose,
    });
  }

  endWorker(runId: string, workerId: string, outcome: "complete" | "error" | "cancelled"): void {
    const folded = this.fold(runId);
    const worker = folded.workers.get(workerId);
    if (worker === undefined || worker.endedAtMs !== undefined) return;
    this.checkpointer.appendLivenessEvent(runId, "liveness_worker_ended", {
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
    if (event.kind === "model_turn") {
      const workerLimit = repair
        ? policy.routing_repair.model_turns_per_worker
        : policy.model_turns_per_worker;
      if (worker.modelTurns >= workerLimit || folded.modelTurns >= policy.model_turns_per_run) {
        throw new LivenessExhaustedError("model_turn_budget_exhausted");
      }
      this.checkpointer.appendLivenessEvent(input.runId, "liveness_model_turn_charged", {
        schema_version: 1,
        at_ms: atMs,
        worker_id: input.workerId,
        source: event.source,
      });
      return;
    }
    if (event.kind === "tool_call") {
      const external = isExternalCallTool(event.tool_name);
      const workerToolLimit = repair
        ? policy.routing_repair.tool_calls_per_worker
        : policy.tool_calls_per_worker;
      const workerExternalLimit = repair
        ? policy.routing_repair.external_calls_per_worker
        : policy.external_calls_per_worker;
      if (worker.toolCalls >= workerToolLimit || folded.toolCalls >= policy.tool_calls_per_run) {
        throw new LivenessExhaustedError("tool_call_budget_exhausted");
      }
      if (
        external &&
        (worker.externalCalls >= workerExternalLimit ||
          folded.externalCalls >= policy.external_calls_per_run)
      ) {
        throw new LivenessExhaustedError("external_request_budget_exhausted");
      }
      this.checkpointer.appendLivenessEvent(input.runId, "liveness_tool_call_charged", {
        schema_version: 1,
        at_ms: atMs,
        worker_id: input.workerId,
        tool_name: event.tool_name,
        external,
      });
      return;
    }
    const digest = kbProtocolErrorDigest({
      stateId: input.stateId,
      toolName: event.tool_name,
      errorCode: event.error_code,
    });
    this.checkpointer.appendLivenessEvent(input.runId, "liveness_protocol_error_charged", {
      schema_version: 1,
      at_ms: atMs,
      worker_id: input.workerId,
      state_id: input.stateId,
      tool_name: event.tool_name,
      error_code: event.error_code,
      digest,
    });
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
    this.checkpointer.appendLivenessEvent(input.runId, "liveness_malformed_charged", {
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

  remainingWorkerWallMs(runId: string, workerId: string): number {
    const nowMs = checkedNow(this.clock);
    const folded = this.fold(runId);
    const policy = this.requirePolicy(folded);
    const worker = folded.workers.get(workerId);
    if (worker === undefined) throw new Error("worker lease is absent");
    const workerLimit =
      worker.purpose === "routing_repair"
        ? policy.routing_repair.worker_wall_clock_ms
        : policy.worker_wall_clock_ms;
    const workerRemaining = workerLimit - Math.max(0, nowMs - worker.startedAtMs);
    const runRemaining = policy.run_wall_clock_ms - unionDuration(activeIntervals(folded, nowMs));
    return Math.max(0, Math.min(workerRemaining, runRemaining));
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
    let reason: LivenessTerminalReason | null = null;
    for (const worker of folded.workers.values()) {
      if (worker.endedAtMs !== undefined) continue;
      const limit =
        worker.purpose === "routing_repair"
          ? policy.routing_repair.worker_wall_clock_ms
          : policy.worker_wall_clock_ms;
      if (atMs - worker.startedAtMs >= limit) reason = "worker_wall_clock_exhausted";
      this.endWorker(runId, worker.workerId, "error");
    }
    const reconciled = this.fold(runId);
    if (unionDuration(activeIntervals(reconciled, atMs)) >= policy.run_wall_clock_ms) {
      return "run_wall_clock_exhausted";
    }
    return reason;
  }

  /** Read-only host projection from the bound policy and durable worker/run counters. */
  workerPromptBudget(runId: string, workerId: string): WorkerPromptBudgetV1 {
    const folded = this.fold(runId);
    const policy = this.requirePolicy(folded);
    const worker = folded.workers.get(workerId);
    if (worker === undefined || worker.endedAtMs !== undefined) {
      throw new Error("prompt budget requires an open worker lease");
    }
    const repair = worker.purpose === "routing_repair";
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
    return {
      schema_version: 1,
      preset: policy.preset,
      purpose: worker.purpose,
      model_turns: remaining(
        repair ? policy.routing_repair.model_turns_per_worker : policy.model_turns_per_worker,
        worker.modelTurns,
        policy.model_turns_per_run,
        folded.modelTurns
      ),
      tool_calls: remaining(
        repair ? policy.routing_repair.tool_calls_per_worker : policy.tool_calls_per_worker,
        worker.toolCalls,
        policy.tool_calls_per_run,
        folded.toolCalls
      ),
      external_requests: remaining(
        repair ? policy.routing_repair.external_calls_per_worker : policy.external_calls_per_worker,
        worker.externalCalls,
        policy.external_calls_per_run,
        folded.externalCalls
      ),
    };
  }

  /** P2 value-preserving projection from existing durable invocation events. */
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

  private requirePolicy(folded: FoldedLiveness): LivenessPolicyV1 {
    if (folded.policy === undefined) throw new Error("legacy_unmetered");
    return folded.policy;
  }

  private assertWall(
    policy: LivenessPolicyV1,
    folded: FoldedLiveness,
    atMs: number,
    worker?: FoldedWorker
  ): void {
    if (unionDuration(activeIntervals(folded, atMs)) >= policy.run_wall_clock_ms) {
      throw new LivenessExhaustedError("run_wall_clock_exhausted");
    }
    if (worker !== undefined) {
      const workerLimit =
        worker.purpose === "routing_repair"
          ? policy.routing_repair.worker_wall_clock_ms
          : policy.worker_wall_clock_ms;
      if (atMs - worker.startedAtMs >= workerLimit) {
        throw new LivenessExhaustedError("worker_wall_clock_exhausted");
      }
    }
  }
}
