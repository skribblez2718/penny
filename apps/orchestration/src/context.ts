import {
  RunIdentitySchema,
  TrustProfileSchema,
  isTerminalStatus,
  type ArtifactRef,
  type CompletionAdmissionEnvelope,
  type CompletionRefusalEvidence,
  type Directive,
  type JsonValue,
  type InputArtifacts,
  type RegistrationContractBindingV1,
  type RunIdentity,
  type RunStatus,
  type StateVisit,
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

import { attachContextArtifacts } from "./contextual-artifacts.js";

export type { PendingBranch, ResearchData, RunContextSnapshot } from "./durable-state.js";

function emptyResearchData(): ResearchData {
  return {
    mode: "",
    max_sub_queries: 4,
    max_research_rounds: null,
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
  readonly completionProtocolVersion: 1 | undefined;
  readonly registrationContractBinding: Readonly<RegistrationContractBindingV1> | undefined;
  readonly sealCorrectionLimit: number | null | undefined;
  readonly goal: string;
  readonly constraints: Readonly<Record<string, JsonValue>>;
  readonly projectRoot: string;
  readonly trustProfile: TrustProfile;
  status: RunStatus;
  stateId: string;
  previousState: string | null;
  stepCount: number;
  readonly maxSteps: number | null;
  iteration: number;
  readonly maxIterations: number | null;
  iterationHistory: string[][];
  clarificationText: string;
  met: boolean;
  research: ResearchData;
  private readonly playbookState: PlaybookDurableState;
  selectedArtifacts: ArtifactRef[];
  private readonly admittedInputs: InputArtifacts | undefined;

  get admittedInputArtifacts(): InputArtifacts | undefined {
    return clone(this.admittedInputs);
  }
  private pending: Directive | null = null;

  get pendingDirective(): Directive | null {
    return this.pending;
  }

  set pendingDirective(value: Directive | null) {
    // Enrich the same directive object returned by the playbook, before checkpoint/signing.
    if (value !== null) attachContextArtifacts(value, this.admittedInputArtifacts);
    this.pending = value;
  }
  pendingBranches: PendingBranch[];
  terminalDirective: Directive | null;
  private pendingVisits: StateVisit[] = [];
  private pendingAdmission: CompletionAdmissionEnvelope | null = null;
  private pendingRefusal: CompletionRefusalEvidence | null = null;

  private constructor(snapshot: DecodedRunContextState) {
    this.identity = Object.freeze(clone(snapshot.identity));
    this.completionProtocolVersion = snapshot.completion_protocol_version;
    this.registrationContractBinding =
      snapshot.registration_contract_binding === undefined
        ? undefined
        : Object.freeze(clone(snapshot.registration_contract_binding));
    this.sealCorrectionLimit = snapshot.seal_correction_limit;
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
    this.admittedInputs = clone(snapshot.admitted_input_artifacts);
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
    maxSteps?: number | null;
    maxIterations?: number | null;
    sealCorrectionLimit?: number | null | undefined;
    registrationContractBinding?: RegistrationContractBindingV1;
    initialArtifacts?: readonly ArtifactRef[];
    admittedInputArtifacts?: InputArtifacts;
  }): RunContext {
    const identity = validateContract(RunIdentitySchema, input.identity, "run identity");
    if (identity.engine_owner !== "typescript") {
      throw new Error("TypeScript orchestration only accepts engine_owner=typescript");
    }
    if (input.goal.trim().length === 0) {
      throw new Error("orchestration goal must be non-empty");
    }
    validateContract(TrustProfileSchema, input.trustProfile, "trust profile");
    const context = new RunContext(
      orchestrationDurableStateCodec.decodeSnapshot({
        schema_version: 2,
        completion_protocol_version: 1,
        ...(input.registrationContractBinding === undefined
          ? {}
          : { registration_contract_binding: clone(input.registrationContractBinding) }),
        identity,
        goal: input.goal,
        constraints: clone(input.constraints),
        project_root: input.projectRoot,
        trust_profile: input.trustProfile,
        status: "running",
        state_id: "intake",
        previous_state: null,
        step_count: 0,
        max_steps: optionalCycleLimit(input.maxSteps, "max_steps"),
        ...(input.sealCorrectionLimit === undefined
          ? {}
          : { seal_correction_limit: input.sealCorrectionLimit }),
        iteration: 0,
        max_iterations: combinedCycleLimit(input.maxIterations, input.constraints.max_iterations),
        iteration_history: [],
        clarification_text: "",
        met: false,
        research: emptyResearchData(),
        selected_artifacts: clone([...(input.initialArtifacts ?? [])]),
        ...(input.admittedInputArtifacts === undefined
          ? {}
          : { admitted_input_artifacts: clone(input.admittedInputArtifacts) }),
        // playbook_data is intentionally omitted here; it materializes only when a
        // playbook writes to it, keeping research snapshots byte-identical.
        pending_directive: null,
        pending_branches: [],
        terminal_directive: null,
      })
    );
    context.pendingVisits.push({ schema_version: 1, state_id: "intake", source: "create" });
    return context;
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
    if (this.maxSteps !== null && this.stepCount >= this.maxSteps) {
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
    if (this.maxSteps !== null && this.stepCount >= this.maxSteps) {
      throw new Error(`run exceeded max_steps=${this.maxSteps}`);
    }
    this.previousState = this.stateId;
    this.stateId = nextState;
    this.pendingVisits.push({
      schema_version: 1,
      state_id: nextState,
      source: "transition",
    });
    this.stepCount += 1;
    this.status = "running";
    this.pendingDirective = null;
    this.pendingBranches = [];
  }

  /** Pending append-only visit evidence. It is never encoded into the run snapshot. */
  pendingStateVisits(): readonly StateVisit[] {
    return clone(this.pendingVisits);
  }

  /** Mark the exact stored current state when a legacy active checkpoint lacks visit evidence. */
  restoreCurrentStateVisit(): void {
    if (isTerminalStatus(this.status)) return;
    if (this.pendingVisits.some((visit) => visit.state_id === this.stateId)) return;
    this.pendingVisits.push({
      schema_version: 1,
      state_id: this.stateId,
      source: "restored_current",
    });
  }

  stageCompletionAdmission(envelope: CompletionAdmissionEnvelope): void {
    this.pendingAdmission = clone(envelope);
    this.pendingRefusal = null;
  }

  stageCompletionRefusal(refusal: CompletionRefusalEvidence): void {
    this.pendingRefusal = clone(refusal);
    this.pendingAdmission = null;
  }

  pendingCompletionAdmission(): CompletionAdmissionEnvelope | null {
    return clone(this.pendingAdmission);
  }

  pendingCompletionRefusal(): CompletionRefusalEvidence | null {
    return clone(this.pendingRefusal);
  }

  /** Called only after the transaction containing the event has committed. */
  markCheckpointEvidencePersisted(): void {
    this.pendingVisits = [];
    this.pendingAdmission = null;
    this.pendingRefusal = null;
  }

  snapshot(): RunContextSnapshot {
    return orchestrationDurableStateCodec.encodeSnapshot({
      schema_version: 2,
      ...(this.completionProtocolVersion === undefined
        ? {}
        : { completion_protocol_version: this.completionProtocolVersion }),
      ...(this.registrationContractBinding === undefined
        ? {}
        : { registration_contract_binding: clone(this.registrationContractBinding) }),
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
      ...(this.sealCorrectionLimit === undefined
        ? {}
        : { seal_correction_limit: this.sealCorrectionLimit }),
      iteration: this.iteration,
      max_iterations: this.maxIterations,
      iteration_history: clone(this.iterationHistory),
      clarification_text: this.clarificationText,
      met: this.met,
      research: clone(this.research),
      playbook_state: clone(this.playbookState),
      selected_artifacts: clone(this.selectedArtifacts),
      ...(this.admittedInputArtifacts === undefined
        ? {}
        : { admitted_input_artifacts: clone(this.admittedInputArtifacts) }),
      pending_directive: clone(this.pendingDirective),
      pending_branches: clone(this.pendingBranches),
      terminal_directive: clone(this.terminalDirective),
    });
  }
}

/** Unspecified is unlimited; malformed explicit policy must never become a fallback. */
export function optionalCycleLimit(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer or null`);
  }
  return value;
}

function combinedCycleLimit(host: unknown, caller: unknown): number | null {
  const hostLimit = optionalCycleLimit(host, "max_iterations");
  const callerLimit = optionalCycleLimit(caller, "max_iterations");
  return hostLimit === null
    ? callerLimit
    : callerLimit === null
      ? hostLimit
      : Math.min(hostLimit, callerLimit);
}

export function positiveIntegerConstraint(value: JsonValue | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
