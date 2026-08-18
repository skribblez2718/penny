import path from "node:path";

import {
  ArtifactRefSchema,
  JsonValueSchema,
  RunIdentitySchema,
  RunStatusSchema,
  TrustProfileSchema,
  isTerminalStatus,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type JsonValue,
  type RunIdentity,
  type RunStatus,
  type TrustProfile,
  validateContract,
  validateDirective,
} from "./contracts.js";

export interface PendingBranch {
  readonly branch_id: string;
  readonly agent: string;
  readonly attempt: number;
  readonly completed: boolean;
  readonly confidence: Confidence | null;
  readonly result: Record<string, JsonValue> | null;
  readonly artifact: ArtifactRef | null;
}

export interface ResearchData {
  mode: string;
  max_sub_queries: number;
  max_research_rounds: number;
  critique_passes: number;
  research_round: number;
  report_format: string;
  sub_queries: string[];
  phase: string;
  plan_revision: number;
  report_revision: number;
  validation_revision: number;
  plan_revisions: number;
  report_revisions: number;
  validation_revisions: number;
  plan_critique_issues: string[];
  report_critique_issues: string[];
  validation_issues: string[];
  validation_verdict: string;
  report_written: boolean;
  report_dir: string;
  report_files: string[];
  warnings: string[];
  plan_critique_exhausted: boolean;
  report_critique_exhausted: boolean;
  validation_exhausted: boolean;
  rigor_escalated: boolean;
  echo_branches_dispatched: number;
  evidence_needed: string[];
}

export interface RunContextSnapshot {
  readonly schema_version: 2;
  readonly identity: RunIdentity;
  readonly goal: string;
  readonly constraints: Record<string, JsonValue>;
  readonly project_root: string;
  readonly trust_profile: TrustProfile;
  readonly status: RunStatus;
  readonly state_id: string;
  readonly previous_state: string | null;
  readonly step_count: number;
  readonly max_steps: number;
  readonly iteration: number;
  readonly max_iterations: number;
  readonly iteration_history: string[][];
  readonly clarification_text: string;
  readonly met: boolean;
  readonly research: ResearchData;
  readonly selected_artifacts: ArtifactRef[];
  readonly pending_directive: Directive | null;
  readonly pending_branches: PendingBranch[];
  readonly terminal_directive: Directive | null;
}

function emptyResearchData(): ResearchData {
  return {
    mode: "",
    max_sub_queries: 4,
    max_research_rounds: 2,
    critique_passes: 0,
    research_round: 1,
    report_format: "default",
    sub_queries: [],
    phase: "",
    plan_revision: 0,
    report_revision: 0,
    validation_revision: 0,
    plan_revisions: 0,
    report_revisions: 0,
    validation_revisions: 0,
    plan_critique_issues: [],
    report_critique_issues: [],
    validation_issues: [],
    validation_verdict: "",
    report_written: false,
    report_dir: "",
    report_files: [],
    warnings: [],
    plan_critique_exhausted: false,
    report_critique_exhausted: false,
    validation_exhausted: false,
    rigor_escalated: false,
    echo_branches_dispatched: 0,
    evidence_needed: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class RunContext {
  readonly identity: Readonly<RunIdentity>;
  readonly goal: string;
  readonly constraints: Readonly<Record<string, JsonValue>>;
  readonly projectRoot: string;
  readonly trustProfile: TrustProfile;
  status: RunStatus;
  stateId: string;
  previousState: string | null;
  stepCount: number;
  readonly maxSteps: number;
  iteration: number;
  readonly maxIterations: number;
  iterationHistory: string[][];
  clarificationText: string;
  met: boolean;
  research: ResearchData;
  selectedArtifacts: ArtifactRef[];
  pendingDirective: Directive | null;
  pendingBranches: PendingBranch[];
  terminalDirective: Directive | null;

  private constructor(snapshot: RunContextSnapshot) {
    this.identity = Object.freeze(clone(snapshot.identity));
    this.goal = snapshot.goal;
    this.constraints = Object.freeze(clone(snapshot.constraints));
    this.projectRoot = snapshot.project_root;
    this.trustProfile = snapshot.trust_profile;
    this.status = snapshot.status;
    this.stateId = snapshot.state_id;
    this.previousState = snapshot.previous_state;
    this.stepCount = snapshot.step_count;
    this.maxSteps = snapshot.max_steps;
    this.iteration = snapshot.iteration;
    this.maxIterations = snapshot.max_iterations;
    this.iterationHistory = clone(snapshot.iteration_history);
    this.clarificationText = snapshot.clarification_text;
    this.met = snapshot.met;
    this.research = clone(snapshot.research);
    this.selectedArtifacts = clone(snapshot.selected_artifacts);
    this.pendingDirective = clone(snapshot.pending_directive);
    this.pendingBranches = clone(snapshot.pending_branches);
    this.terminalDirective = clone(snapshot.terminal_directive);
  }

  static create(input: {
    identity: RunIdentity;
    goal: string;
    constraints: Record<string, JsonValue>;
    projectRoot: string;
    trustProfile: TrustProfile;
    maxSteps: number;
  }): RunContext {
    const identity = validateContract(RunIdentitySchema, input.identity, "run identity");
    if (identity.engine_owner !== "typescript") {
      throw new Error("TypeScript orchestration only accepts engine_owner=typescript");
    }
    if (input.goal.trim().length === 0) {
      throw new Error("orchestration goal must be non-empty");
    }
    validateContract(TrustProfileSchema, input.trustProfile, "trust profile");
    return new RunContext({
      schema_version: 2,
      identity,
      goal: input.goal,
      constraints: clone(input.constraints),
      project_root: input.projectRoot,
      trust_profile: input.trustProfile,
      status: "running",
      state_id: "intake",
      previous_state: null,
      step_count: 0,
      max_steps: input.maxSteps,
      iteration: 0,
      max_iterations: positiveIntegerConstraint(input.constraints.max_iterations, 3),
      iteration_history: [],
      clarification_text: "",
      met: false,
      research: emptyResearchData(),
      selected_artifacts: [],
      pending_directive: null,
      pending_branches: [],
      terminal_directive: null,
    });
  }

  static fromSnapshot(value: unknown): RunContext {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("checkpoint context must be an object");
    }
    const record = value as Record<string, unknown>;
    const expectedKeys = [
      "schema_version",
      "identity",
      "goal",
      "constraints",
      "project_root",
      "trust_profile",
      "status",
      "state_id",
      "previous_state",
      "step_count",
      "max_steps",
      "iteration",
      "max_iterations",
      "iteration_history",
      "clarification_text",
      "met",
      "research",
      "selected_artifacts",
      "pending_directive",
      "pending_branches",
      "terminal_directive",
    ];
    const unknownKeys = Object.keys(record).filter((key) => !expectedKeys.includes(key));
    const missingKeys = expectedKeys.filter((key) => !Object.hasOwn(record, key));
    if (unknownKeys.length > 0 || missingKeys.length > 0) {
      throw new Error(
        `checkpoint context fields are invalid (missing=${missingKeys.join(",")}; unknown=${unknownKeys.join(",")})`
      );
    }
    const snapshot = record as unknown as RunContextSnapshot;
    validateContract(RunIdentitySchema, snapshot.identity, "checkpoint identity");
    if (snapshot.identity.engine_owner !== "typescript") {
      throw new Error("checkpoint engine_owner must be typescript");
    }
    if (typeof snapshot.goal !== "string" || snapshot.goal.trim().length === 0) {
      throw new Error("checkpoint goal must be non-empty");
    }
    if (!path.isAbsolute(snapshot.project_root)) {
      throw new Error("checkpoint project_root must be absolute");
    }
    if (
      snapshot.constraints === null ||
      typeof snapshot.constraints !== "object" ||
      Array.isArray(snapshot.constraints)
    ) {
      throw new Error("checkpoint constraints must be an object");
    }
    validateContract(JsonValueSchema, snapshot.constraints, "checkpoint constraints");
    validateContract(RunStatusSchema, snapshot.status, "checkpoint status");
    validateContract(TrustProfileSchema, snapshot.trust_profile, "checkpoint trust profile");
    if (snapshot.schema_version !== 2) {
      throw new Error(`unsupported checkpoint schema version ${snapshot.schema_version}`);
    }
    for (const [name, numeric, minimum] of [
      ["step_count", snapshot.step_count, 0],
      ["max_steps", snapshot.max_steps, 1],
      ["iteration", snapshot.iteration, 0],
      ["max_iterations", snapshot.max_iterations, 1],
    ] as const) {
      if (!Number.isSafeInteger(numeric) || numeric < minimum) {
        throw new Error(`checkpoint ${name} is invalid`);
      }
    }
    if (!Array.isArray(snapshot.selected_artifacts)) {
      throw new Error("checkpoint selected_artifacts must be an array");
    }
    for (const artifact of snapshot.selected_artifacts) {
      validateContract(ArtifactRefSchema, artifact, "checkpoint artifact ref");
      if (artifact.run_id !== snapshot.identity.run_id) {
        throw new Error("checkpoint artifact belongs to another run");
      }
    }
    if (snapshot.pending_directive !== null) {
      const pending = validateDirective(snapshot.pending_directive);
      if (pending.identity.run_id !== snapshot.identity.run_id) {
        throw new Error("pending directive belongs to another run");
      }
    }
    if (snapshot.terminal_directive !== null) {
      const terminal = validateDirective(snapshot.terminal_directive);
      if (terminal.identity.run_id !== snapshot.identity.run_id) {
        throw new Error("terminal directive belongs to another run");
      }
    }
    return new RunContext(snapshot);
  }

  reissueCurrent(): void {
    if (isTerminalStatus(this.status)) {
      throw new Error(`cannot reissue terminal run ${this.identity.run_id}`);
    }
    if (this.stepCount >= this.maxSteps) {
      throw new Error(`run exceeded max_steps=${this.maxSteps}`);
    }
    this.previousState = this.stateId;
    this.stepCount += 1;
    this.status = "running";
    this.pendingDirective = null;
    this.pendingBranches = [];
  }

  transition(nextState: string): void {
    if (isTerminalStatus(this.status)) {
      throw new Error(`cannot transition terminal run ${this.identity.run_id}`);
    }
    if (this.stepCount >= this.maxSteps) {
      throw new Error(`run exceeded max_steps=${this.maxSteps}`);
    }
    this.previousState = this.stateId;
    this.stateId = nextState;
    this.stepCount += 1;
    this.status = "running";
    this.pendingDirective = null;
    this.pendingBranches = [];
  }

  snapshot(): RunContextSnapshot {
    return {
      schema_version: 2,
      identity: clone(this.identity),
      goal: this.goal,
      constraints: clone(this.constraints),
      project_root: this.projectRoot,
      trust_profile: this.trustProfile,
      status: this.status,
      state_id: this.stateId,
      previous_state: this.previousState,
      step_count: this.stepCount,
      max_steps: this.maxSteps,
      iteration: this.iteration,
      max_iterations: this.maxIterations,
      iteration_history: clone(this.iterationHistory),
      clarification_text: this.clarificationText,
      met: this.met,
      research: clone(this.research),
      selected_artifacts: clone(this.selectedArtifacts),
      pending_directive: clone(this.pendingDirective),
      pending_branches: clone(this.pendingBranches),
      terminal_directive: clone(this.terminalDirective),
    };
  }
}

export function positiveIntegerConstraint(value: JsonValue | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
