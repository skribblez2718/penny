import {
  RunIdentitySchema,
  TrustProfileSchema,
  isTerminalStatus,
  type ArtifactRef,
  type Directive,
  type JsonValue,
  type RunIdentity,
  type RunStatus,
  type TrustProfile,
  validateContract,
} from "./contracts.js";
import {
  orchestrationDurableStateCodec,
  playbookDataJson,
  type DecodedRunContextState,
  type JsonObject,
  type KnowledgeBasePlaybookData,
  type PendingBranch,
  type PlaybookDurableState,
  type ResearchData,
  type RunContextSnapshot,
} from "./durable-state.js";

export type { PendingBranch, ResearchData, RunContextSnapshot } from "./durable-state.js";

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
  private readonly playbookState: PlaybookDurableState;
  selectedArtifacts: ArtifactRef[];
  pendingDirective: Directive | null;
  pendingBranches: PendingBranch[];
  terminalDirective: Directive | null;

  private constructor(snapshot: DecodedRunContextState) {
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
    this.playbookState = clone(snapshot.playbook_state);
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
    initialArtifacts?: readonly ArtifactRef[];
  }): RunContext {
    const identity = validateContract(RunIdentitySchema, input.identity, "run identity");
    if (identity.engine_owner !== "typescript") {
      throw new Error("TypeScript orchestration only accepts engine_owner=typescript");
    }
    if (input.goal.trim().length === 0) {
      throw new Error("orchestration goal must be non-empty");
    }
    validateContract(TrustProfileSchema, input.trustProfile, "trust profile");
    return new RunContext(
      orchestrationDurableStateCodec.decodeSnapshot({
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
        selected_artifacts: clone([...(input.initialArtifacts ?? [])]),
        // playbook_data is intentionally omitted here; it materializes only when a
        // playbook writes to it, keeping research snapshots byte-identical.
        pending_directive: null,
        pending_branches: [],
        terminal_directive: null,
      })
    );
  }

  static fromSnapshot(value: unknown): RunContext {
    return new RunContext(orchestrationDurableStateCodec.decodeSnapshot(value));
  }

  static fromCheckpoint(
    value: unknown,
    options: { readonly playbook: string; readonly projectRoot?: string }
  ): RunContext {
    return new RunContext(orchestrationDurableStateCodec.decodeCheckpoint(value, options));
  }

  /** Compatibility view for callers that intentionally inspect unknown future fields. */
  get playbookData(): JsonObject {
    return playbookDataJson(this.playbookState);
  }

  /** Validated KB metadata. The discriminant check is explicit and assertion-free. */
  get knowledgeBaseData(): KnowledgeBasePlaybookData {
    if (this.playbookState.kind !== "knowledge-base") {
      throw new Error(`run '${this.identity.run_id}' is not a knowledge-base run`);
    }
    return this.playbookState.data;
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
    return orchestrationDurableStateCodec.encodeSnapshot({
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
      playbook_state: clone(this.playbookState),
      selected_artifacts: clone(this.selectedArtifacts),
      pending_directive: clone(this.pendingDirective),
      pending_branches: clone(this.pendingBranches),
      terminal_directive: clone(this.terminalDirective),
    });
  }
}

export function positiveIntegerConstraint(value: JsonValue | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
