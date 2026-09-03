import path from "node:path";

import type {
  ArtifactHostStore,
  ArtifactReader,
  ArtifactRevisionLookup,
} from "./artifact-store.js";
import {
  Checkpointer,
  CheckpointIdentityError,
  ReceiptConflictError,
  canonicalJson,
  sha256,
} from "./checkpointer.js";
import { readRunInput, settleRunInput } from "./private-inputs.js";
import { RunContext } from "./context.js";
import {
  OperationReceiptStore,
  promotionApplyOperationSourceIdentity,
  promotionDecisionOperationSourceIdentity,
  replayableResultFromRun,
} from "./kb/operation-receipts.js";
import type { OperationEventGroup } from "./kb/contracts.js";
import {
  ContractValidationError,
  EvaluationResultV2Schema,
  FeedbackRouteEvidenceV1Schema,
  OrchestrationRequestSchema,
  type ArtifactRef,
  type CompletionAdmissionEnvelope,
  type CompletionEvidenceRef,
  type CompletionFailureCode,
  type CompletionProductEvidence,
  type Confidence,
  type Directive,
  type EvaluationResultV2,
  type FeedbackRouteEvidenceV1,
  type JsonValue,
  type LivenessSnapshotV1,
  type LivenessTerminalReason,
  type PhaseResult,
  type RepairRouteV1,
  type RunIdentity,
  type SkillContract,
  type StartRequest,
  validateContract,
  validateDirective,
} from "./contracts.js";
import {
  evaluateCompletionGate,
  hasApprovedPromotionCompletion,
  hasExternalStartOperationGroup,
  hasFanAggregate,
  hasGenericResponsePolicy,
  hasHostContinuation,
  hasHostReviewedGateValidation,
  hasLivenessTerminal,
  hasRepairExhaustion,
  hasReviewInvalidation,
  hasRoutingRepair,
  hasStateAwareRepair,
  isHostContinuation,
  type CompletionReceiptPredicateV1,
  type PlaybookStepOutcomeV1,
  type PlaybookV1,
} from "./playbooks/playbook.js";
import {
  DEFAULT_PLAYBOOK_NAME,
  isRegisteredPlaybook,
  PLAYBOOK_REGISTRY,
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
  type PreparedStartV1,
} from "./playbooks/registry.js";
import { ReceiptAuthority, trustedInvocationDigest } from "./receipts.js";
import type { ResearchContextOwnerV1 } from "./research-context.js";
import { validateSemanticComposition } from "./composition.js";
import {
  LivenessController,
  malformedErrorDigest,
  type LivenessPolicyResolver,
} from "./liveness.js";

export interface EngineOptions {
  readonly projectRoot: string;
  readonly maxSteps: number;
  readonly dispatchMode?: () => string | undefined;
  /** Durable hosts must inject their canonical receipt authority. */
  readonly receiptAuthority: ReceiptAuthority;
  /** Immutable artifact-manifest ledger used to resolve output revision chains. */
  readonly artifactRevisions?: ArtifactRevisionLookup;
  /** Writable host artifact plane for deterministic request/core/product artifacts. */
  readonly artifactStore?: ArtifactHostStore;
  /** Exact-byte capability used for typed import admission before run mutation. */
  readonly artifactReader?: ArtifactReader;
  /** Owner-resolved, metadata-only research context seam. */
  readonly researchContext?: ResearchContextOwnerV1;
  readonly livenessController?: LivenessController;
  readonly livenessPolicyResolver?: LivenessPolicyResolver;
  /** Deterministic crash-boundary injection used only by local host-recovery tests. */
  readonly researchHostFault?: (point: string) => void;
  /**
   * Playbook registry override. Production uses the shipped single-entry registry;
   * tests inject a double to prove multi-playbook dispatch without activating a skill.
   */
  readonly playbookRegistry?: PlaybookRegistryV1;
  /** Exact registration already resolved through an allowed candidate path. */
  readonly playbookRegistration?: PlaybookRegistrationV1;
  /**
   * Which registered playbook this engine instance drives. Defaults to the sole
   * production playbook (research). The KB skill drives the engine with its own
   * registration ('knowledge-base'); each engine instance still owns exactly one
   * playbook, so the single-owner invariants (contract, state machine, receipts)
   * are unchanged.
   */
  readonly playbookName?: string;
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  CERTAIN: 3,
  PROBABLE: 2,
  POSSIBLE: 1,
  UNCERTAIN: 0,
};

function directive(value: unknown): Directive {
  return validateDirective(value);
}

function weakestConfidence(values: readonly Confidence[]): Confidence {
  if (values.length === 0) {
    return "UNCERTAIN";
  }
  return values.reduce((weakest, current) =>
    CONFIDENCE_RANK[current] < CONFIDENCE_RANK[weakest] ? current : weakest
  );
}

function isArtifactReader(value: object | undefined): value is ArtifactReader {
  return (
    value !== undefined &&
    "refById" in value &&
    typeof value.refById === "function" &&
    "readById" in value &&
    typeof value.readById === "function"
  );
}

function isArtifactHostStore(value: object | undefined): value is ArtifactHostStore {
  return (
    isArtifactReader(value) &&
    "persist" in value &&
    typeof value.persist === "function" &&
    "select" in value &&
    typeof value.select === "function" &&
    "metadata" in value &&
    typeof value.metadata === "function" &&
    "lastVersion" in value &&
    typeof value.lastVersion === "function" &&
    "refFor" in value &&
    typeof value.refFor === "function"
  );
}

function metadata(identity: RunIdentity): Record<string, JsonValue> {
  return {
    schema_version: identity.schema_version,
    run_id: identity.run_id,
    session_id: identity.session_id,
    playbook: identity.playbook,
    engine_owner: identity.engine_owner,
  };
}

type TerminalDirective = Extract<Directive, { result: Record<string, JsonValue> }>;

interface RoutedRepairV1 {
  readonly next: PlaybookStepOutcomeV1;
  readonly evidence: FeedbackRouteEvidenceV1;
}

function terminalDirective(value: Directive): TerminalDirective | undefined {
  return "result" in value ? value : undefined;
}

function resolveLatestProduct(input: {
  gate: SkillContract["completion_gate"];
  context: RunContext;
  terminal: TerminalDirective;
}): { product?: CompletionProductEvidence; failure?: CompletionFailureCode } {
  const spec = input.gate.latest_product;
  if (spec.selector === "terminal_result") {
    const digest = sha256(canonicalJson(input.terminal.result));
    return {
      product: {
        selector: "terminal_result",
        schema_id: spec.schema_id,
        product_schema_version: spec.product_schema_version,
        product_id: `prod_${digest}`,
        sha256: digest,
      },
    };
  }
  const matches = input.terminal.artifacts.filter(
    (artifact) => artifact.kind === spec.artifact_kind && artifact.phase === spec.producing_state
  );
  if (matches.length === 0) return { failure: "LATEST_PRODUCT_MISSING" };
  if (matches.length > 1) return { failure: "LATEST_PRODUCT_AMBIGUOUS" };
  const artifact = matches[0];
  if (artifact === undefined) return { failure: "LATEST_PRODUCT_MISSING" };
  const selected = input.context.selectedArtifacts.find(
    (candidate) => candidate.artifact_id === artifact.artifact_id
  );
  const highestVersion = Math.max(
    ...input.context.selectedArtifacts
      .filter((candidate) => candidate.operation_id === artifact.operation_id)
      .map((candidate) => candidate.version)
  );
  if (
    selected === undefined ||
    canonicalJson(selected) !== canonicalJson(artifact) ||
    artifact.version !== highestVersion
  ) {
    return { failure: "LATEST_PRODUCT_MISMATCH" };
  }
  return {
    product: {
      selector: "terminal_artifact",
      schema_id: spec.schema_id,
      product_schema_version: spec.product_schema_version,
      product_id: artifact.artifact_id,
      sha256: artifact.content_digest,
    },
  };
}

function refuseCompletion(input: {
  context: RunContext;
  terminal: TerminalDirective;
  terminalDigest: string;
  gateDigest: string;
  originState: string | null;
  failures: readonly CompletionFailureCode[];
}): TerminalDirective {
  const refusal = {
    schema_version: 1 as const,
    attempted_terminal_sha256: input.terminalDigest,
    gate_digest: input.gateDigest,
    origin_state: input.originState,
    failure_codes: [...input.failures],
  };
  const blockers = input.failures.map((code) => `completion admission refused: ${code}`);
  const unresolved = [...blockers, ...input.terminal.unresolved].slice(0, 128);
  const next = terminalDirective(
    validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: input.terminal.identity,
      status: "incomplete",
      met: false,
      result: {
        ...input.terminal.result,
        met: false,
        completion_admission: {
          schema_version: 1,
          admitted: false,
          attempted_terminal_sha256: input.terminalDigest,
          failure_codes: [...input.failures],
        },
      },
      artifacts: input.terminal.artifacts,
      unresolved,
    })
  );
  if (next === undefined) throw new Error("completion refusal did not produce a terminal");
  input.context.stateId = "incomplete";
  input.context.status = "incomplete";
  input.context.met = false;
  input.context.pendingDirective = next;
  input.context.terminalDirective = next;
  input.context.stageCompletionRefusal(refusal);
  return next;
}

/** The one engine-owned admission function used by every positive-terminal path. */
export function admitCompletionCandidate(input: {
  checkpointer: Checkpointer;
  contract: SkillContract;
  predicates: ReadonlyMap<string, CompletionReceiptPredicateV1>;
  context: RunContext;
  candidate: Directive;
  pendingPhaseResult?: PhaseResult;
  artifactReader?: ArtifactReader;
  projectRoot?: string;
}): Directive {
  const terminal = terminalDirective(validateDirective(input.candidate));
  if (
    terminal === undefined ||
    terminal.action !== "complete" ||
    terminal.status !== "complete" ||
    terminal.met !== true
  ) {
    return input.candidate;
  }

  const gate = input.contract.completion_gate;
  const gateDigest = sha256(canonicalJson(gate));
  const terminalDigest = sha256(canonicalJson(terminal));
  const visits = input.checkpointer.completionStateVisits(input.context);
  const originState = visits.at(-1)?.state_id ?? null;
  const failures = evaluateCompletionGate({
    gate,
    terminalStatus: terminal.status,
    met: terminal.met,
    originState,
    visitedStates: visits.map((visit) => visit.state_id),
    unresolvedCount: 0,
  });

  const latest = resolveLatestProduct({ gate, context: input.context, terminal });
  if (latest.failure !== undefined) failures.push(latest.failure);
  const evidenceRefs: CompletionEvidenceRef[] = [];
  if (latest.product !== undefined) {
    for (const predicateId of gate.required_receipt_predicates) {
      const predicate = input.predicates.get(predicateId);
      if (predicate === undefined) {
        throw new Error(`COMPLETION_PREDICATE_UNKNOWN: '${predicateId}'`);
      }
      let result;
      try {
        result = predicate({
          checkpointer: input.checkpointer,
          context: input.context,
          terminal,
          originState: originState ?? "",
          latestProduct: latest.product,
          ...(input.artifactReader !== undefined ? { artifactReader: input.artifactReader } : {}),
          projectRoot: input.projectRoot ?? input.context.projectRoot,
          ...(input.pendingPhaseResult !== undefined
            ? { pendingPhaseResult: input.pendingPhaseResult }
            : {}),
        });
      } catch {
        result = { passed: false, evidence_refs: [] };
      }
      if (!result.passed) {
        if (!failures.includes("RECEIPT_PREDICATE_FAILED")) {
          failures.push("RECEIPT_PREDICATE_FAILED");
        }
      } else {
        evidenceRefs.push(...result.evidence_refs);
      }
    }
  }
  if (
    gate.unresolved_policy.mode === "max_count" &&
    terminal.unresolved.length > gate.unresolved_policy.max_count
  ) {
    failures.push("UNRESOLVED_LIMIT_EXCEEDED");
  }

  if (failures.length > 0 || latest.product === undefined || originState === null) {
    return refuseCompletion({
      context: input.context,
      terminal,
      terminalDigest,
      gateDigest,
      originState,
      failures: failures.length > 0 ? failures : ["TERMINAL_ORIGIN_NOT_ALLOWED"],
    });
  }

  const body = {
    schema_version: 1 as const,
    run_id: input.context.identity.run_id,
    gate_digest: gateDigest,
    terminal_digest: terminalDigest,
    origin_state: originState,
    state_visit_refs: visits,
    latest_product: latest.product,
    evidence_refs: evidenceRefs,
    unresolved_count: terminal.unresolved.length,
  };
  const envelope: CompletionAdmissionEnvelope = {
    ...body,
    terminal_envelope_id: `tenv_${sha256(canonicalJson(body))}`,
  };
  input.context.stageCompletionAdmission(envelope);
  return terminal;
}

export class OrchestrationEngine {
  // Typed as the capability-probed union, never as a concrete playbook class: the engine
  // must not know which playbook it is driving. See playbooks/playbook.ts (W1).
  private readonly playbook: PlaybookV1;
  private readonly registry: PlaybookRegistryV1;
  /** The exact validated active registration used by engine and workers (W6). */
  readonly registration: PlaybookRegistrationV1;
  /** The active skill contract (W3). */
  readonly contract: SkillContract;
  private readonly completionPredicates: ReadonlyMap<string, CompletionReceiptPredicateV1>;
  private readonly registrationContractSha256: string;
  private readonly runtimeRegistrationSha256: string;
  private readonly projectRoot: string;
  private readonly maxSteps: number;
  private readonly dispatchMode: () => string | undefined;
  private readonly artifactReader: ArtifactReader | undefined;
  private readonly artifactStore: ArtifactHostStore | undefined;
  private readonly researchContext: ResearchContextOwnerV1 | undefined;
  readonly receiptAuthority: ReceiptAuthority;
  readonly liveness: LivenessController;

  constructor(
    private readonly checkpointer: Checkpointer,
    options: EngineOptions
  ) {
    this.checkpointer.bindKbRuntimeProjectRoot(options.projectRoot);
    this.registry =
      options.playbookRegistry ??
      (options.playbookRegistration === undefined
        ? PLAYBOOK_REGISTRY
        : new Map([[options.playbookRegistration.name, options.playbookRegistration]]));
    const playbookName =
      options.playbookName ?? options.playbookRegistration?.name ?? DEFAULT_PLAYBOOK_NAME;
    // Normal construction resolves only the production registry. A candidate must
    // arrive as the one exact registration resolved by an allowed caller path.
    const registration =
      options.playbookRegistration ?? resolvePlaybook(playbookName, this.registry);
    if (registration === undefined) {
      throw new Error(`playbook '${playbookName}' is not registered in the supplied registry`);
    }
    if (registration.name !== playbookName) {
      throw new Error(
        `playbook registration '${registration.name}' does not match selected '${playbookName}'`
      );
    }
    // W3: authority metadata is validated before playbook construction.
    this.contract = validateRegistrationContract(
      registration,
      options.playbookRegistration === undefined && this.registry === PLAYBOOK_REGISTRY
        ? "production"
        : registration.contract.release_status
    );
    this.registration = registration;
    this.registrationContractSha256 = skillContractSha256(this.contract);
    this.runtimeRegistrationSha256 = runtimeRegistrationSha256(this.registration);
    this.completionPredicates = registration.completionReceiptPredicates;
    this.artifactStore =
      options.artifactStore ??
      (isArtifactHostStore(options.artifactRevisions) ? options.artifactRevisions : undefined);
    this.artifactReader =
      options.artifactReader ??
      this.artifactStore ??
      (isArtifactReader(options.artifactRevisions) ? options.artifactRevisions : undefined);
    this.researchContext = options.researchContext;
    this.playbook = registration.construct({
      ...(options.artifactRevisions ? { artifactRevisions: options.artifactRevisions } : {}),
      ...(this.artifactReader ? { artifactReader: this.artifactReader } : {}),
      ...(this.artifactStore ? { artifactStore: this.artifactStore } : {}),
      ...(this.researchContext ? { researchContext: this.researchContext } : {}),
      checkpointer: this.checkpointer,
      ...(options.researchHostFault ? { researchHostFault: options.researchHostFault } : {}),
      /**
       * The private-input custody seam (§5.6), bound to THIS engine's control DB
       * and project root. Playbooks that never declare the capability (research)
       * never receive bodies through it; the engine itself does not parse them.
       */
      privateInput: {
        read: (runId: string) =>
          readRunInput({
            projectRoot: path.resolve(options.projectRoot),
            checkpointer: this.checkpointer,
            runId,
          }),
        sha256: (runId: string) => this.checkpointer.getPrivateInput(runId)?.request_sha256,
      },
    });
    this.projectRoot = path.resolve(options.projectRoot);
    this.maxSteps = options.maxSteps;
    this.dispatchMode = options.dispatchMode ?? (() => process.env.PENNY_ARTIFACT_DISPATCH_MODE);
    this.receiptAuthority = options.receiptAuthority;
    this.liveness = options.livenessController ?? new LivenessController(this.checkpointer);
    const registrationResolver = registration.liveness.resolve;
    const fallbackResolver = options.livenessPolicyResolver;
    this.liveness.setPolicyResolver(
      (context) => registrationResolver(context) ?? fallbackResolver?.(context)
    );
  }

  private prepareStart(request: StartRequest): PreparedStartV1 | undefined {
    if (this.registration.ingress !== "skill") return undefined;
    const admission = this.registration.start_admission;
    if (admission === undefined) {
      throw new Error(`skill registration '${this.registration.name}' has no start admission`);
    }
    const prepared = admission.prepare(request, {
      ...(this.artifactReader === undefined ? {} : { artifactReader: this.artifactReader }),
      ...(this.researchContext === undefined ? {} : { researchContext: this.researchContext }),
    });
    if (
      prepared.schema_id !== this.contract.io.request.schema_id ||
      prepared.schema_version !== this.contract.io.request.schema_version_required ||
      prepared.request.identity.playbook !== this.registration.name
    ) {
      throw new Error(`prepared start does not match registration '${this.registration.name}'`);
    }
    validateSemanticComposition({
      contract: this.contract,
      ...(prepared.input_artifacts === undefined
        ? {}
        : { inputArtifacts: prepared.input_artifacts }),
      ...(this.artifactReader === undefined ? {} : { artifactReader: this.artifactReader }),
    });
    return prepared;
  }

  private materializeStart(prepared: PreparedStartV1): readonly ArtifactRef[] {
    const admission = this.registration.start_admission;
    if (admission === undefined) return [];
    return admission.materialize(prepared, {
      run_id: prepared.request.identity.run_id,
      ...(this.artifactReader === undefined ? {} : { artifactReader: this.artifactReader }),
      ...(this.artifactStore === undefined ? {} : { artifactStore: this.artifactStore }),
      ...(this.researchContext === undefined ? {} : { researchContext: this.researchContext }),
    });
  }

  private validatePhaseDetails(
    state: string,
    details: Record<string, JsonValue>
  ): Record<string, JsonValue> {
    const worker = this.registration.worker;
    if (worker.kind === "catalog-agent") {
      const phase = worker.phases.get(state);
      if (phase === undefined) {
        throw new Error(`active registration has no catalog phase '${state}'`);
      }
      validateContract(phase.schema, details, `${state} summary`);
      return details;
    }
    const phase = worker.phases.get(state);
    if (phase === undefined) {
      throw new Error(`active registration has no host-private phase '${state}'`);
    }
    return phase.validate(details);
  }

  handle(value: unknown): Directive {
    const request = validateContract(OrchestrationRequestSchema, value, "orchestration request");
    const preparedStart = request.action === "start" ? this.prepareStart(request) : undefined;
    const dispatch = this.dispatchState();
    if (!dispatch.active && request.action !== "status" && request.action !== "cancel") {
      if (request.action === "start") {
        if (path.resolve(request.project_root) !== this.projectRoot) {
          throw new Error(
            `project_root mismatch: engine owns '${this.projectRoot}', request supplied '${request.project_root}'`
          );
        }
        // An admitted start already owns a durable run row; pausing preserves it
        // rather than claiming it was never created.
        return this.pausedDirective(
          request.identity,
          "intake",
          dispatch.code,
          dispatch.reason,
          this.checkpointer.runExists(request.identity.run_id)
        );
      }
      const context = this.checkpointer.loadRun(request.identity);
      const bindingRefusal = this.registrationBindingRefusal(context);
      if (bindingRefusal !== undefined) return bindingRefusal;
      return this.pausedDirective(
        context.identity,
        context.stateId,
        dispatch.code,
        dispatch.reason,
        true
      );
    }
    switch (request.action) {
      case "start": {
        if (path.resolve(request.project_root) !== this.projectRoot) {
          throw new Error(
            `project_root mismatch: engine owns '${this.projectRoot}', request supplied '${request.project_root}'`
          );
        }
        // §5.6 start actions admitted before the engine: the control DB already
        // holds the durable run row, the idempotency record, and the private-input
        // index (one transaction, before any bytes). The engine now owns the
        // state transition — initialize performs the run's (deterministic or
        // agent-driven) first step and the checkpoint records the result.
        // A run that is already terminal replays its exact terminal directive
        // and performs no second side effect.
        if (this.checkpointer.runExists(request.identity.run_id)) {
          const admitted = this.checkpointer.loadRun(request.identity);
          const bindingRefusal = this.registrationBindingRefusal(admitted);
          if (bindingRefusal !== undefined) return bindingRefusal;
          if (admitted.terminalDirective !== null) {
            return this.currentDirective(admitted);
          }
          if (admitted.stateId !== "intake") {
            // Frozen run contract (research parity): a start of a run that is
            // already advancing is an identity violation — the host resumes it
            // through `step`/`recover`, never by starting it again.
            throw new CheckpointIdentityError(
              `run '${request.identity.run_id}' is in state '${admitted.stateId}'; it cannot be started again`
            );
          }
          if (preparedStart !== undefined) {
            const materialized = this.materializeStart(preparedStart);
            for (const ref of materialized) {
              if (
                !admitted.selectedArtifacts.some(
                  (selected) => selected.artifact_id === ref.artifact_id
                )
              ) {
                admitted.selectedArtifacts.push(ref);
              }
            }
          }
          this.bindLivenessIfRequired(admitted);
          const candidate = this.playbook.initialize(admitted);
          const next = this.admitTerminal(admitted, candidate);
          this.checkpointer.saveRun(admitted, "run_admitted", {
            ...metadata(request.identity),
            state_id: admitted.stateId,
          });
          return next;
        }
        const materializedRefs =
          preparedStart === undefined ? [] : [...this.materializeStart(preparedStart)];
        const initialRefs = [
          ...(preparedStart?.input_artifacts?.artifacts.map((binding) => binding.ref) ??
            request.input_artifacts?.artifacts.map((binding) => binding.ref) ??
            []),
          ...materializedRefs,
        ];
        const uniqueInitialRefs = [
          ...new Map(initialRefs.map((ref) => [ref.artifact_id, ref])).values(),
        ];
        const context = RunContext.create({
          identity: request.identity,
          goal: preparedStart?.goal ?? request.goal,
          constraints: preparedStart?.constraints ?? request.constraints,
          projectRoot: this.projectRoot,
          trustProfile: request.trust_profile,
          maxSteps: this.maxSteps,
          ...(this.contract.release_status === "candidate"
            ? {
                registrationContractBinding: {
                  schema_version: 1,
                  registration_name: this.registration.name,
                  release_status: this.contract.release_status,
                  contract_sha256: this.registrationContractSha256,
                  registration_sha256: this.runtimeRegistrationSha256,
                },
              }
            : {}),
          ...(uniqueInitialRefs.length === 0 ? {} : { initialArtifacts: uniqueInitialRefs }),
        });
        const operationGroup = hasExternalStartOperationGroup(this.playbook)
          ? this.playbook.externalStartOperationGroup(context)
          : undefined;
        if (operationGroup !== undefined) {
          // Receipt-producing KB starts reserve their run + globally unique
          // source group + sequence in one transaction BEFORE initialize may
          // claim a capability, read a body, create a child, or write a file.
          this.checkpointer.createRun(
            context,
            "run_started",
            {
              ...metadata(request.identity),
              goal_sha256: sha256(request.goal),
              goal_bytes: Buffer.byteLength(request.goal, "utf8"),
              state_id: context.stateId,
            },
            operationGroup
          );
          this.bindLivenessIfRequired(context);
          const candidate = this.playbook.initialize(context);
          const next = this.admitTerminal(context, candidate);
          this.checkpointer.saveRun(context, "run_admitted", {
            ...metadata(request.identity),
            state_id: context.stateId,
          });
          return next;
        }
        const candidate = this.playbook.initialize(context);
        const next = this.admitTerminal(context, candidate);
        this.checkpointer.createRun(context, "run_started", {
          ...metadata(request.identity),
          goal_sha256: sha256(request.goal),
          goal_bytes: Buffer.byteLength(request.goal, "utf8"),
          state_id: context.stateId,
        });
        this.bindLivenessIfRequired(context);
        return next;
      }
      case "step":
        return this.step(request.identity, request.result);
      case "status":
        return this.status(request.identity);
      case "recover":
        return this.recover(request.identity);
      case "respond": {
        const context = this.checkpointer.loadRun(request.identity);
        const bindingRefusal = this.registrationBindingRefusal(context);
        if (bindingRefusal !== undefined) return bindingRefusal;
        if (hasGenericResponsePolicy(this.playbook)) {
          this.playbook.assertGenericResponseAllowed(context);
        }
        const pending = context.pendingDirective;
        if (
          context.status !== "awaiting_user" ||
          pending?.action !== "await_user" ||
          pending.gate_id !== request.gate_id
        ) {
          throw new Error(
            `run '${request.identity.run_id}' is not awaiting gate '${request.gate_id}'`
          );
        }
        if (pending.challenge !== request.challenge) {
          throw new Error(`challenge mismatch for gate '${request.gate_id}'`);
        }
        const candidate = this.playbook.resume(context, request.response);
        const next = this.admitTerminal(context, candidate);
        this.checkpointer.saveGateResponse(
          context,
          request.gate_id,
          request.challenge,
          request.response,
          "user_gate_answered",
          {
            ...metadata(request.identity),
            gate_id: request.gate_id,
            response_sha256: sha256(canonicalJson(request.response)),
            state_id: context.stateId,
          }
        );
        return next;
      }
      case "cancel": {
        const context = this.checkpointer.loadRun(request.identity);
        const bindingRefusal = this.registrationBindingRefusal(context);
        if (bindingRefusal !== undefined) return bindingRefusal;
        if (context.terminalDirective !== null) {
          return context.terminalDirective;
        }
        const reason = request.reason ?? "cancelled by caller";
        this.liveness.cancelOpenWorkers(context.identity.run_id);
        const candidate = this.playbook.cancel(context, reason);
        const snapshot = this.liveness.snapshot(context.identity.run_id);
        const next = this.attachLiveness(context, candidate, snapshot);
        this.checkpointer.saveRun(context, "run_cancelled", {
          ...metadata(request.identity),
          reason_sha256: sha256(reason),
          liveness: snapshot,
        });
        return next;
      }
    }
  }

  /**
   * Accept one worker batch with schema-valid fan siblings first, preserving
   * stable branch order. A malformed branch therefore cannot cause already
   * completed siblings to be dispatched again.
   */
  acceptWorkerResults(identity: RunIdentity, results: readonly PhaseResult[]): Directive {
    const context = this.checkpointer.loadRun(identity);
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) return bindingRefusal;
    if (results.length === 0) return this.currentDirective(context);
    const pending = context.pendingDirective;
    const branchOrder = new Map(
      pending?.action === "invoke_agents_parallel"
        ? pending.branches.map((branch, index) => [branch.branch_id, index])
        : []
    );
    const ordered = [...results].sort((left, right) => {
      const malformed = (result: PhaseResult): number => {
        try {
          this.validatePhaseDetails(result.state_id, result.details);
          return 0;
        } catch (error) {
          return error instanceof ContractValidationError ? 1 : 0;
        }
      };
      return (
        malformed(left) - malformed(right) ||
        (branchOrder.get(left.branch_id ?? "") ?? 0) - (branchOrder.get(right.branch_id ?? "") ?? 0)
      );
    });
    let next: Directive = this.currentDirective(context);
    for (const result of ordered) next = this.step(identity, result);
    return next;
  }

  /**
   * Internal host continuation after §5.1 accepted complete receipt bytes.
   * This is deliberately not part of `OrchestrationRequestSchema`: models and
   * ordinary resume/respond callers cannot reach it.
   */
  resumeContentReviewedRun(input: {
    runId: string;
    receiptSha256: string;
    transactionId: string;
  }): Directive {
    const review = this.checkpointer.claimContentReview(input);
    if (review.decision_receipt === undefined) {
      throw new Error(`content-review run '${input.runId}' has no decision receipt`);
    }
    const context = this.checkpointer.loadRunById(input.runId);
    if (context === undefined || !hasHostReviewedGateValidation(this.playbook)) {
      throw new Error(`run '${input.runId}' is not bound to a host-reviewed gate`);
    }
    this.playbook.validateHostReviewedGate(context, "content_review");
    const pending = context.pendingDirective;
    if (
      context.stateId !== "awaiting_review" ||
      pending?.action !== "await_user" ||
      pending.gate_id !== review.challenge_id ||
      String(context.knowledgeBaseData.review_receipt_sha256 ?? "") !== input.receiptSha256
    ) {
      throw new Error(
        `run '${input.runId}' is not bound to decided content-review challenge '${review.challenge_id}'`
      );
    }
    // The host callback transaction owns any approved selector commit and the
    // eventual `published` operation receipt. It is never accepted from model
    // input; the checkpointer already bound it to the exact decision receipt.
    context.knowledgeBaseData.publication_transaction_id = input.transactionId;
    const candidate = this.playbook.resume(context, review.decision_receipt.decision);
    const next = this.admitTerminal(context, candidate);
    this.checkpointer.finishContentReview({
      context,
      receiptSha256: input.receiptSha256,
      transactionId: input.transactionId,
    });
    return next;
  }

  /**
   * Approval-DB-first promotion decision reconciliation. Only the host approval
   * facade calls this method; `OrchestrationRequestSchema` has no counterpart.
   */
  recordPromotionDecision(input: {
    runId: string;
    challengeId: string;
    decision: "approve" | "refine" | "deny";
    intentSha256: string;
    packetSha256?: string;
    receiptId?: string;
    receiptSha256?: string;
  }): Directive {
    const context = this.checkpointer.loadRunById(input.runId);
    if (context === undefined || !hasHostReviewedGateValidation(this.playbook)) {
      throw new Error(
        `run '${input.runId}' is not bound to promotion challenge '${input.challengeId}'`
      );
    }
    this.playbook.validateHostReviewedGate(context, "promotion");
    const packetSha256 =
      input.packetSha256 ?? String(context.knowledgeBaseData.promotion_packet_sha256 ?? "");
    if (
      String(context.knowledgeBaseData.action ?? "") !== "promote" ||
      !/^[a-f0-9]{64}$/.test(packetSha256) ||
      !/^[a-f0-9]{64}$/.test(input.intentSha256)
    ) {
      throw new Error(
        `run '${input.runId}' is not bound to promotion challenge '${input.challengeId}'`
      );
    }
    if (
      input.decision === "approve" &&
      (input.receiptId === undefined || input.receiptSha256 === undefined)
    ) {
      throw new Error(
        "approved promotion control reconciliation requires receipt id/digest metadata"
      );
    }
    // Approval DB is already durable. Reserve the control-side callback group
    // before any gate/run transition; retry finds this exact source identity.
    const sourceIdentity = promotionDecisionOperationSourceIdentity({
      packet_sha256: packetSha256,
      decision_intent_sha256: input.intentSha256,
    });
    const operationStore = new OperationReceiptStore({
      projectRoot: this.projectRoot,
      checkpointer: this.checkpointer,
    });
    const reserved = operationStore.reserve({
      run_id: input.runId,
      session_id: context.identity.session_id,
      transaction_id: `pdec_${input.intentSha256.slice(0, 32)}`,
      action: "promote",
      source_kind: "promotion_decision",
      source_identity_sha256: sourceIdentity,
    });
    if (reserved.group.state !== "reserved") {
      operationStore.finish(reserved.group.request_event_group_id);
      return this.currentDirective(this.loadRequiredRun(input.runId));
    }
    if (String(context.knowledgeBaseData.promotion_challenge_id ?? "") !== input.challengeId) {
      throw new Error(
        `run '${input.runId}' is not bound to promotion challenge '${input.challengeId}'`
      );
    }

    const alreadyReconciled =
      String(context.knowledgeBaseData.promotion_decision_intent_sha256 ?? "") ===
        input.intentSha256 &&
      String(context.knowledgeBaseData.review_decision ?? "") === input.decision;
    let next: Directive;
    if (alreadyReconciled) {
      next = this.currentDirective(context);
    } else {
      const pending = context.pendingDirective;
      if (
        context.stateId !== "awaiting_review" ||
        pending?.action !== "await_user" ||
        pending.gate_id !== input.challengeId ||
        pending.payload_digest !== packetSha256
      ) {
        throw new Error(
          `run '${input.runId}' is not awaiting promotion challenge '${input.challengeId}'`
        );
      }
      context.knowledgeBaseData.review_decision = input.decision;
      context.knowledgeBaseData.promotion_decision_intent_sha256 = input.intentSha256;
      if (input.receiptId !== undefined)
        context.knowledgeBaseData.promotion_receipt_id = input.receiptId;
      if (input.receiptSha256 !== undefined) {
        context.knowledgeBaseData.promotion_receipt_sha256 = input.receiptSha256;
      }
      next = input.decision === "approve" ? pending : this.playbook.resume(context, input.decision);
      this.checkpointer.saveGateResponse(
        context,
        pending.gate_id,
        pending.challenge,
        {
          decision: input.decision,
          intent_sha256: input.intentSha256,
          ...(input.receiptId !== undefined ? { receipt_id: input.receiptId } : {}),
          ...(input.receiptSha256 !== undefined ? { receipt_sha256: input.receiptSha256 } : {}),
        },
        "promotion_decision_reconciled",
        {
          run_id: input.runId,
          gate_id: input.challengeId,
          decision: input.decision,
          intent_sha256: input.intentSha256,
        }
      );
    }
    const durable = this.loadRequiredRun(input.runId);
    const replay = replayableResultFromRun({
      action: "promote",
      run: durable,
      checkpointer: this.checkpointer,
    });
    operationStore.complete({
      request_event_group_id: reserved.group.request_event_group_id,
      kb_profile_id: String(durable.knowledgeBaseData.profile_id ?? ""),
      kb_id: String(durable.knowledgeBaseData.kb_id ?? ""),
      result: replay,
      input_digests: [
        packetSha256,
        input.intentSha256,
        ...(input.receiptSha256 !== undefined ? [input.receiptSha256] : []),
      ],
      output_refs: input.receiptId === undefined ? [] : [input.receiptId],
      policy_sha256: String(durable.knowledgeBaseData.admitted_policy_sha256 ?? ""),
      safe_metrics: replay.counts,
    });
    return next;
  }

  /** Reserve apply only after the signed receipt + journal transaction is durable. */
  reservePromotionApplyOperation(input: {
    runId: string;
    sessionId: string;
    receiptSha256: string;
    transactionId: string;
  }): OperationEventGroup {
    const sourceIdentity = promotionApplyOperationSourceIdentity({
      approval_receipt_sha256: input.receiptSha256,
      transaction_id: input.transactionId,
    });
    return new OperationReceiptStore({
      projectRoot: this.projectRoot,
      checkpointer: this.checkpointer,
    }).reserve({
      run_id: input.runId,
      session_id: input.sessionId,
      transaction_id: input.transactionId,
      action: "promote",
      source_kind: "promotion_apply",
      source_identity_sha256: sourceIdentity,
    }).group;
  }

  /** Final control-store commit after approval and capability stores are terminal. */
  finalizeApprovedPromotion(input: {
    runId: string;
    status: "complete" | "failed" | "blocked_external_drift";
    receiptId: string;
    receiptSha256: string;
    transactionId: string;
    targetCount: number;
    postApplyVerified: boolean;
  }): Directive {
    const context = this.checkpointer.loadRunById(input.runId);
    if (
      context === undefined ||
      !hasHostReviewedGateValidation(this.playbook) ||
      !hasApprovedPromotionCompletion(this.playbook)
    ) {
      throw new Error(`unknown KB promotion run '${input.runId}'`);
    }
    this.playbook.validateHostReviewedGate(context, "promotion");
    const group = this.reservePromotionApplyOperation({
      runId: input.runId,
      sessionId: context.identity.session_id,
      receiptSha256: input.receiptSha256,
      transactionId: input.transactionId,
    });
    const operationStore = new OperationReceiptStore({
      projectRoot: this.projectRoot,
      checkpointer: this.checkpointer,
    });
    if (group.state === "committed") {
      operationStore.finish(group.request_event_group_id);
      settleRunInput({
        projectRoot: this.projectRoot,
        checkpointer: this.checkpointer,
        runId: input.runId,
      });
      return this.currentDirective(context);
    }
    const approvalBinding = this.checkpointer.promotionApprovalBinding(input.runId);
    if (
      approvalBinding === undefined ||
      approvalBinding.receipt_id !== input.receiptId ||
      approvalBinding.receipt_sha256 !== input.receiptSha256
    ) {
      throw new Error(
        "promotion finalization requires the exact control-side approved receipt binding"
      );
    }
    let next: Directive;
    if (context.terminalDirective !== null) {
      if (
        String(context.knowledgeBaseData.promotion_apply_transaction_id ?? "") ===
          input.transactionId &&
        String(context.knowledgeBaseData.promotion_apply_status ?? "") === input.status
      ) {
        next = context.terminalDirective;
      } else {
        throw new Error("promotion run is terminal under another apply transaction");
      }
    } else {
      const candidate = this.playbook.completeApprovedPromotion(context, input);
      next = this.admitTerminal(context, candidate);
      this.checkpointer.saveRun(context, "promotion_apply_reconciled", {
        run_id: input.runId,
        receipt_id: input.receiptId,
        receipt_sha256: input.receiptSha256,
        transaction_id: input.transactionId,
        apply_status: input.status,
        target_count: input.targetCount,
        post_apply_verified: input.postApplyVerified,
      });
    }
    const durable = this.loadRequiredRun(input.runId);
    const replay = replayableResultFromRun({
      action: "promote",
      run: durable,
      checkpointer: this.checkpointer,
      status_override: input.status === "complete" ? "complete" : "error",
    });
    operationStore.complete({
      request_event_group_id: group.request_event_group_id,
      kb_profile_id: String(durable.knowledgeBaseData.profile_id ?? ""),
      kb_id: String(durable.knowledgeBaseData.kb_id ?? ""),
      result: replay,
      input_digests: [input.receiptSha256],
      output_refs: [input.receiptId],
      policy_sha256: String(durable.knowledgeBaseData.admitted_policy_sha256 ?? ""),
      safe_metrics: {
        target_count: input.targetCount,
        post_apply_verified: input.postApplyVerified ? 1 : 0,
      },
    });
    settleRunInput({
      projectRoot: this.projectRoot,
      checkpointer: this.checkpointer,
      runId: input.runId,
    });
    return next;
  }

  /** Fail-closed expiry/drift terminalization for an unpublishable challenge. */
  invalidateContentReviewedRun(input: {
    runId: string;
    receiptSha256?: string;
    reason: string;
    state: "invalidated" | "expired";
  }): Directive {
    const context = this.checkpointer.loadRunById(input.runId);
    if (
      context === undefined ||
      !hasHostReviewedGateValidation(this.playbook) ||
      !hasReviewInvalidation(this.playbook)
    ) {
      throw new Error(`unknown KB content-review run '${input.runId}'`);
    }
    this.playbook.validateHostReviewedGate(context, "content_review");
    const next = this.playbook.invalidateReview(context, input.reason);
    this.checkpointer.invalidateContentReview({
      context,
      ...(input.receiptSha256 !== undefined ? { receiptSha256: input.receiptSha256 } : {}),
      reason: input.reason,
      state: input.state,
    });
    return next;
  }

  private routeTypedRepair(
    context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): RoutedRepairV1 | null {
    if (!hasStateAwareRepair(this.playbook)) return null;
    const candidate = this.playbook.evaluateRepair(context, state, details);
    if (candidate === null) return null;
    const evaluation: EvaluationResultV2 = validateContract(
      EvaluationResultV2Schema,
      candidate,
      `repair evaluation for '${state}'`
    );
    const matches = this.contract.repair_routing.routes.filter(
      (route) => route.origin_state === state && route.feedback_kind === evaluation.kind
    );
    if (matches.length !== 1) {
      throw new Error(
        `repair route '${state}:${evaluation.kind}' must resolve exactly once; found ${matches.length}`
      );
    }
    const route: RepairRouteV1 | undefined = matches[0];
    if (route === undefined) throw new Error("resolved repair route is unavailable");
    const usedBefore =
      this.playbook.repairBudgetUsed?.(context, state, evaluation) ?? context.iteration;
    const limit = context.maxIterations;
    const admitted = usedBefore + 1 <= limit - route.budget.reserved_attempts;
    const disposition = admitted ? "repair" : "exhausted";
    const usedAfter = admitted ? usedBefore + 1 : usedBefore;
    context.iteration = usedAfter;

    const controlBefore = canonicalJson({
      state_id: context.stateId,
      previous_state: context.previousState,
      step_count: context.stepCount,
      pending_directive: context.pendingDirective,
      pending_branches: context.pendingBranches,
      terminal_directive: context.terminalDirective,
      status: context.status,
      met: context.met,
      iteration: context.iteration,
    });
    this.playbook.applyRepairBookkeeping?.(context, state, details, evaluation, disposition);
    const controlAfter = canonicalJson({
      state_id: context.stateId,
      previous_state: context.previousState,
      step_count: context.stepCount,
      pending_directive: context.pendingDirective,
      pending_branches: context.pendingBranches,
      terminal_directive: context.terminalDirective,
      status: context.status,
      met: context.met,
      iteration: context.iteration,
    });
    if (controlAfter !== controlBefore) {
      throw new Error("repair bookkeeping modified engine-owned control fields");
    }

    const targetState = admitted ? route.repair.target_state : route.on_exhaustion.target_state;
    let next: PlaybookStepOutcomeV1;
    if (!admitted && hasRepairExhaustion(this.playbook)) {
      next = this.playbook.terminalizeRepairExhaustion(context, state, evaluation);
    } else {
      if (!admitted && route.on_exhaustion.reset_counter) context.iteration = 0;
      context.transition(targetState);
      next =
        hasHostContinuation(this.playbook) && this.playbook.needsHostContinuation(context)
          ? ({ kind: "host_continuation" } as const)
          : this.playbook.dispatch(context);
    }
    const evidence = validateContract(
      FeedbackRouteEvidenceV1Schema,
      {
        schema_version: 1,
        origin_state: state,
        feedback_kind: evaluation.kind,
        detail_sha256: sha256(evaluation.detail),
        strategy_delta_sha256: sha256(evaluation.strategy_delta),
        disposition,
        target_state: targetState,
        budget: {
          counter: "iteration",
          used_before: usedBefore,
          limit,
          used_after: usedAfter,
        },
      },
      "feedback route evidence"
    );
    return { next, evidence };
  }

  private step(identity: RunIdentity, result: PhaseResult): Directive {
    const prior = this.checkpointer.receiptResult(result.worker_receipt);
    if (prior !== undefined) {
      if (canonicalJson(prior) !== canonicalJson(result)) {
        throw new ReceiptConflictError(
          `receipt_id '${result.worker_receipt.receipt_id}' has conflicting content`
        );
      }
      const recovered = this.checkpointer.loadRun(identity);
      const bindingRefusal = this.registrationBindingRefusal(recovered);
      if (bindingRefusal !== undefined) return bindingRefusal;
      return hasHostContinuation(this.playbook) && this.playbook.needsHostContinuation(recovered)
        ? this.advanceHost(recovered, prior)
        : this.currentDirective(recovered);
    }

    const context = this.checkpointer.loadRun(identity);
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) return bindingRefusal;
    if (context.terminalDirective !== null) {
      throw new Error(`run '${identity.run_id}' is already terminal`);
    }
    this.validateReceiptEnvelope(identity, result);
    if (result.worker_receipt.exit_code !== 0) {
      throw new Error(
        `worker '${result.worker_receipt.worker_id}' exited with ${result.worker_receipt.exit_code}`
      );
    }

    const pending = context.pendingDirective;
    if (pending === null) {
      throw new Error(`run '${identity.run_id}' has no pending directive`);
    }
    let outcome: PlaybookStepOutcomeV1;
    let routeEvidence: FeedbackRouteEvidenceV1 | undefined;
    let branchId = "";
    if (pending.action === "invoke_agent") {
      if (pending.execution_purpose === "routing_repair") {
        return this.acceptRoutingRepair(context, pending, result);
      }
      if (result.branch_id !== undefined) {
        throw new Error("single-agent result must not include branch_id");
      }
      this.assertAssignment(result, pending.state_id, pending.agent, pending.attempt);
      this.validateOutputArtifact(
        result,
        context.identity,
        pending.output_artifact,
        pending.input_artifacts,
        pending.task,
        pending.trust_profile,
        pending.model_override ?? null,
        null
      );
      this.captureArtifact(context, result.output_artifact);
      try {
        this.validatePhaseDetails(context.stateId, result.details);
      } catch (error) {
        if (error instanceof ContractValidationError) {
          return this.reissueMalformed(context, result, branchId, error);
        }
        throw error;
      }
      const routed = this.routeTypedRepair(context, result.state_id, result.details);
      if (routed === null) {
        outcome = this.playbook.acceptSummary(context, result.details, result.confidence);
      } else {
        outcome = routed.next;
        routeEvidence = routed.evidence;
      }
    } else if (pending.action === "invoke_agents_parallel") {
      if (result.branch_id === undefined) {
        throw new Error("parallel result requires branch_id");
      }
      branchId = result.branch_id;
      const assignment = pending.branches.find((branch) => branch.branch_id === branchId);
      if (assignment === undefined) {
        throw new Error(`wrong_branch '${branchId}' for state '${pending.state_id}'`);
      }
      this.assertAssignment(result, assignment.state_id, assignment.agent, assignment.attempt);
      this.validateOutputArtifact(
        result,
        context.identity,
        assignment.output_artifact,
        assignment.input_artifacts,
        assignment.task,
        assignment.trust_profile,
        assignment.model_override ?? null,
        branchId
      );
      this.captureArtifact(context, result.output_artifact);
      let details: Record<string, JsonValue>;
      try {
        details = this.validatePhaseDetails(assignment.state_id, result.details);
      } catch (error) {
        if (error instanceof ContractValidationError) {
          return this.reissueMalformed(context, result, branchId, error);
        }
        throw error;
      }
      const branch = context.pendingBranches.find((candidate) => candidate.branch_id === branchId);
      if (branch === undefined) {
        throw new Error(`branch '${branchId}' is absent from checkpoint state`);
      }
      if (branch.completed) {
        throw new Error(`duplicate_branch '${branchId}'`);
      }
      const artifact = result.output_artifact;
      const branchIndex = context.pendingBranches.indexOf(branch);
      context.pendingBranches[branchIndex] = {
        ...branch,
        completed: true,
        confidence: result.confidence,
        result: details,
        artifact,
      };
      if (context.pendingBranches.some((candidate) => !candidate.completed)) {
        const incomplete = new Set(
          context.pendingBranches
            .filter((candidate) => !candidate.completed)
            .map((candidate) => candidate.branch_id)
        );
        outcome = directive({
          ...pending,
          branches: pending.branches.filter((candidate) => incomplete.has(candidate.branch_id)),
        });
        context.pendingDirective = outcome;
      } else {
        const completed = context.pendingBranches;
        if (!hasFanAggregate(this.playbook)) {
          // A playbook that emits parallel branches must be able to fold them back.
          // Failing loudly here is correct: silently dropping branch results would
          // corrupt the run's evidence.
          throw new Error(
            `playbook '${identity.playbook}' produced parallel branches but does not implement the fan-aggregate capability`
          );
        }
        const aggregate = this.playbook.aggregateBranches(
          completed.map((candidate) => candidate.result ?? {})
        );
        const confidences = completed.map((candidate) => candidate.confidence ?? "UNCERTAIN");
        const routed = this.routeTypedRepair(context, pending.state_id, aggregate);
        if (routed === null) {
          outcome = this.playbook.acceptSummary(context, aggregate, weakestConfidence(confidences));
        } else {
          outcome = routed.next;
          routeEvidence = routed.evidence;
        }
      }
    } else {
      throw new Error(`run '${identity.run_id}' is not awaiting an agent result`);
    }

    // W7: the engine, not the playbook, admits a met terminal. Deterministic host
    // work starts only after this accepted worker receipt and run state commit.
    const immediate = isHostContinuation(outcome)
      ? undefined
      : this.admitTerminal(context, outcome, result);

    this.checkpointer.saveWithReceipt(context, result, branchId, "phase_result_accepted", {
      ...metadata(identity),
      state_id: result.state_id,
      agent: result.agent,
      attempt: result.attempt,
      branch_id: branchId,
      receipt_id: result.worker_receipt.receipt_id,
      output_digest: result.worker_receipt.output_digest,
      next_action: immediate?.action ?? "host_continuation",
      ...(routeEvidence === undefined ? {} : { feedback_route_evidence_v1: routeEvidence }),
    });
    this.bindLivenessIfRequired(context);
    return immediate ?? this.advanceHost(context, result);
  }

  private reissueMalformed(
    context: RunContext,
    result: PhaseResult,
    branchId: string,
    error: ContractValidationError
  ): Directive {
    const normalizedBranchId = branchId.length > 0 ? branchId : null;
    const digest = malformedErrorDigest({
      kind: "malformed_result",
      stateId: result.state_id,
      branchId: normalizedBranchId,
      schemaIssues: error.issues,
    });
    const exhausted = this.liveness.chargeMalformed({
      runId: context.identity.run_id,
      stateId: result.state_id,
      branchId: normalizedBranchId,
      digest,
    });
    let next: Directive;
    if (exhausted !== null) {
      next = this.livenessTerminal(context, exhausted);
    } else if (hasRoutingRepair(this.playbook)) {
      try {
        next = this.playbook.routingRepair(context, result);
      } catch {
        next = this.livenessTerminal(context, "routing_repair_binding_invalid");
      }
    } else {
      next = this.livenessTerminal(context, "routing_repair_binding_invalid");
    }
    this.checkpointer.saveWithReceipt(context, result, branchId, "phase_result_malformed", {
      ...metadata(context.identity),
      state_id: result.state_id,
      agent: result.agent,
      attempt: result.attempt,
      branch_id: branchId,
      feedback_kind: "malformed_result",
      receipt_id: result.worker_receipt.receipt_id,
      malformed_digest: digest,
      next_action: next.action,
      ...(exhausted === null ? {} : { terminal_reason: exhausted }),
      ...(next.action === "incomplete" && exhausted !== null
        ? { liveness: this.snapshotWithReason(context.identity.run_id, exhausted) }
        : {}),
    });
    return next;
  }

  private acceptRoutingRepair(
    context: RunContext,
    pending: Extract<Directive, { action: "invoke_agent" }>,
    repairResult: PhaseResult
  ): Directive {
    const binding = pending.routing_repair_binding;
    if (binding === undefined || repairResult.branch_id !== undefined) {
      return this.persistInvalidRepair(context, repairResult);
    }
    this.assertAssignment(repairResult, pending.state_id, pending.agent, pending.attempt);
    this.validateOutputArtifact(
      repairResult,
      context.identity,
      pending.output_artifact,
      pending.input_artifacts,
      pending.task,
      pending.trust_profile,
      pending.model_override ?? null,
      null,
      binding
    );
    const original = this.checkpointer.receiptResultById(binding.source_receipt_id);
    if (
      original === undefined ||
      binding.source_result_sha256 !== sha256(canonicalJson(original)) ||
      binding.source_state_id !== original.state_id ||
      binding.source_branch_id !== (original.branch_id ?? null) ||
      binding.source_agent !== original.agent ||
      binding.source_attempt !== original.attempt ||
      canonicalJson(binding.source_artifact_ref) !== canonicalJson(original.output_artifact)
    ) {
      return this.persistInvalidRepair(context, repairResult);
    }
    let details: Record<string, JsonValue>;
    try {
      details = this.validatePhaseDetails(original.state_id, repairResult.details);
    } catch (error) {
      if (!(error instanceof ContractValidationError)) throw error;
      const digest = malformedErrorDigest({
        kind: "malformed_result",
        stateId: original.state_id,
        branchId: original.branch_id ?? null,
        schemaIssues: error.issues,
      });
      const charged = this.liveness.chargeMalformed({
        runId: context.identity.run_id,
        stateId: original.state_id,
        branchId: original.branch_id ?? null,
        digest,
      });
      const reason = charged ?? "malformed_result_budget_exhausted";
      const terminal = this.livenessTerminal(context, reason);
      this.checkpointer.saveWithReceipt(context, repairResult, "", "routing_repair_malformed", {
        ...metadata(context.identity),
        state_id: original.state_id,
        branch_id: original.branch_id ?? "",
        malformed_digest: digest,
        terminal_reason: reason,
        liveness: this.snapshotWithReason(context.identity.run_id, reason),
      });
      return terminal;
    }
    const folded: PhaseResult = {
      ...original,
      confidence: repairResult.confidence,
      details,
    };
    let outcome: PlaybookStepOutcomeV1;
    let routeEvidence: FeedbackRouteEvidenceV1 | undefined;
    if (binding.source_branch_id === null) {
      const routed = this.routeTypedRepair(context, original.state_id, details);
      if (routed === null) {
        outcome = this.playbook.acceptSummary(context, details, repairResult.confidence);
      } else {
        outcome = routed.next;
        routeEvidence = routed.evidence;
      }
    } else {
      const branch = context.pendingBranches.find(
        (candidate) => candidate.branch_id === binding.source_branch_id
      );
      if (branch === undefined || branch.completed) {
        return this.persistInvalidRepair(context, repairResult);
      }
      const index = context.pendingBranches.indexOf(branch);
      context.pendingBranches[index] = {
        ...branch,
        completed: true,
        confidence: repairResult.confidence,
        result: details,
        artifact: original.output_artifact,
      };
      if (context.pendingBranches.some((candidate) => !candidate.completed)) {
        return this.persistInvalidRepair(context, repairResult);
      }
      if (!hasFanAggregate(this.playbook)) {
        return this.persistInvalidRepair(context, repairResult);
      }
      const aggregate = this.playbook.aggregateBranches(
        context.pendingBranches.map((candidate) => candidate.result ?? {})
      );
      const routed = this.routeTypedRepair(context, original.state_id, aggregate);
      if (routed === null) {
        outcome = this.playbook.acceptSummary(
          context,
          aggregate,
          weakestConfidence(
            context.pendingBranches.map((candidate) => candidate.confidence ?? "UNCERTAIN")
          )
        );
      } else {
        outcome = routed.next;
        routeEvidence = routed.evidence;
      }
    }
    const immediate = isHostContinuation(outcome)
      ? undefined
      : this.admitTerminal(context, outcome, folded);
    this.checkpointer.saveWithReceipt(context, repairResult, "", "routing_repair_accepted", {
      ...metadata(context.identity),
      state_id: original.state_id,
      branch_id: original.branch_id ?? "",
      source_receipt_id: original.worker_receipt.receipt_id,
      repair_receipt_id: repairResult.worker_receipt.receipt_id,
      next_action: immediate?.action ?? "host_continuation",
      ...(routeEvidence === undefined ? {} : { feedback_route_evidence_v1: routeEvidence }),
    });
    this.bindLivenessIfRequired(context);
    return immediate ?? this.advanceHost(context, folded);
  }

  private advanceHost(context: RunContext, pendingPhaseResult?: PhaseResult): Directive {
    if (!hasHostContinuation(this.playbook)) {
      throw new Error(
        `playbook '${context.identity.playbook}' requested host continuation without the capability`
      );
    }
    for (let step = 0; step < 64; step += 1) {
      if (!this.playbook.needsHostContinuation(context)) {
        return this.currentDirective(context);
      }
      const hostStep = this.playbook.continueHost(context);
      const candidate =
        hostStep.directive === undefined
          ? undefined
          : this.admitTerminal(context, hostStep.directive, pendingPhaseResult);
      this.checkpointer.saveRun(context, hostStep.event_type, hostStep.payload);
      if (hostStep.after_checkpoint_fault !== undefined) {
        this.playbook.hostCheckpointCommitted?.(context, hostStep.after_checkpoint_fault);
      }
      if (candidate !== undefined) return candidate;
    }
    throw new Error("deterministic host continuation exceeded 64 checkpointed steps");
  }

  private persistInvalidRepair(context: RunContext, repairResult: PhaseResult): Directive {
    const next = this.livenessTerminal(context, "routing_repair_binding_invalid");
    this.checkpointer.saveWithReceipt(context, repairResult, "", "routing_repair_invalid", {
      ...metadata(context.identity),
      terminal_reason: "routing_repair_binding_invalid",
      liveness: this.snapshotWithReason(context.identity.run_id, "routing_repair_binding_invalid"),
    });
    return next;
  }

  private validateReceiptEnvelope(identity: RunIdentity, result: PhaseResult): void {
    const receipt = this.receiptAuthority.verify(result.worker_receipt);
    const comparisons: Array<[string, string | number, string | number]> = [
      ["run_id", identity.run_id, result.run_id],
      ["receipt.run_id", identity.run_id, receipt.run_id],
      ["state_id", result.state_id, receipt.state_id],
      ["agent", result.agent, receipt.agent],
      ["attempt", result.attempt, receipt.attempt],
    ];
    for (const [name, expected, actual] of comparisons) {
      if (expected !== actual) {
        throw new Error(
          `phase result provenance mismatch for ${name}: expected '${expected}', found '${actual}'`
        );
      }
    }
    const started = Date.parse(receipt.started_at);
    const ended = Date.parse(receipt.ended_at);
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
      throw new Error("worker receipt timestamps are invalid");
    }
  }

  private assertAssignment(
    result: PhaseResult,
    stateId: string,
    agent: string,
    attempt: number
  ): void {
    const fields: Array<[string, string | number, string | number]> = [
      ["state_id", stateId, result.state_id],
      ["agent", agent, result.agent],
      ["attempt", attempt, result.attempt],
    ];
    for (const [name, expected, actual] of fields) {
      if (expected !== actual) {
        throw new Error(`wrong_${name}: expected '${expected}', found '${actual}'`);
      }
    }
  }

  private validateOutputArtifact(
    result: PhaseResult,
    identity: RunIdentity,
    expected: Extract<Directive, { action: "invoke_agent" }>["output_artifact"],
    inputArtifacts: Extract<Directive, { action: "invoke_agent" }>["input_artifacts"],
    task: string,
    trustProfile: Extract<Directive, { action: "invoke_agent" }>["trust_profile"],
    modelOverride: string | null,
    branchId: string | null,
    routingRepairBinding?: Extract<Directive, { action: "invoke_agent" }>["routing_repair_binding"]
  ): void {
    const artifact = result.output_artifact;
    if (artifact === undefined) {
      throw new Error("phase result is missing the owner output artifact ref");
    }
    const comparisons: Array<[string, unknown, unknown]> = [
      ["run_id", expected.run_id, artifact.run_id],
      ["phase", expected.phase, artifact.phase],
      ["branch_id", expected.branch_id, artifact.branch_id],
      ["kind", expected.kind, artifact.kind],
      ["operation_id", expected.operation_id, artifact.operation_id],
      ["version", expected.version, artifact.version],
      ["producer", expected.producer, artifact.producer],
      ["media_type", expected.media_type, artifact.media_type],
      ["output_digest", result.worker_receipt.output_digest, artifact.content_digest],
      [
        "receipt_artifact_ref",
        canonicalJson(artifact),
        canonicalJson(result.worker_receipt.output_artifact_ref),
      ],
      ["receipt_branch_id", branchId, result.worker_receipt.branch_id],
      ["receipt_trust_profile", trustProfile, result.worker_receipt.trust_profile],
      ["receipt_model", modelOverride, result.worker_receipt.model],
      [
        "receipt_command",
        canonicalJson(["pi-sdk", result.agent]),
        canonicalJson(result.worker_receipt.command),
      ],
      ["receipt_working_directory", this.projectRoot, result.worker_receipt.working_directory],
      [
        "trusted_invocation_digest",
        trustedInvocationDigest({
          identity,
          state_id: expected.phase,
          branch_id: branchId,
          agent: result.agent,
          attempt: result.attempt,
          trust_profile: trustProfile,
          model_override: modelOverride,
          ...(routingRepairBinding === undefined
            ? {}
            : {
                execution_purpose: "routing_repair" as const,
                routing_repair_binding_sha256: sha256(canonicalJson(routingRepairBinding)),
              }),
          task_sha256: sha256(task),
          input_artifacts: inputArtifacts,
          output_artifact: expected,
        }),
        result.worker_receipt.trusted_invocation_digest,
      ],
    ];
    for (const [name, wanted, actual] of comparisons) {
      if (wanted !== actual) {
        throw new Error(
          `output artifact mismatch for ${name}: expected '${String(wanted)}', found '${String(actual)}'`
        );
      }
    }
  }

  private captureArtifact(
    context: RunContext,
    artifact: ArtifactRef | undefined
  ): ArtifactRef | null {
    if (artifact === undefined) {
      return null;
    }
    if (artifact.run_id !== context.identity.run_id) {
      throw new Error("output artifact run_id does not match the run");
    }
    if (artifact.phase !== context.stateId) {
      throw new Error(
        `output artifact phase '${artifact.phase}' does not match '${context.stateId}'`
      );
    }
    const existing = context.selectedArtifacts.find(
      (candidate) => candidate.artifact_id === artifact.artifact_id
    );
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(artifact)) {
        throw new Error(`artifact_id '${artifact.artifact_id}' has conflicting metadata`);
      }
      return existing;
    }
    context.selectedArtifacts.push(structuredClone(artifact));
    return artifact;
  }

  exhaust(identity: RunIdentity, reason: LivenessTerminalReason): Directive {
    const context = this.checkpointer.loadRun(identity);
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) return bindingRefusal;
    if (context.terminalDirective !== null) return this.currentDirective(context);
    const next = this.livenessTerminal(context, reason);
    const snapshot = this.snapshotWithReason(context.identity.run_id, reason);
    this.checkpointer.saveRun(context, "liveness_terminal", {
      ...metadata(context.identity),
      terminal_reason: reason,
      liveness: snapshot,
    });
    return next;
  }

  private livenessTerminal(context: RunContext, reason: LivenessTerminalReason): Directive {
    if (!hasLivenessTerminal(this.playbook)) {
      throw new Error(
        `playbook '${context.identity.playbook}' has no liveness terminal capability`
      );
    }
    return this.playbook.terminalizeLiveness(
      context,
      reason,
      this.snapshotWithReason(context.identity.run_id, reason)
    );
  }

  private snapshotWithReason(runId: string, reason: LivenessTerminalReason): LivenessSnapshotV1 {
    return { ...this.liveness.snapshot(runId), terminal_reason: reason };
  }

  private attachLiveness(
    context: RunContext,
    candidate: Directive,
    snapshot: LivenessSnapshotV1
  ): Directive {
    if (
      candidate.action !== "complete" &&
      candidate.action !== "incomplete" &&
      candidate.action !== "error" &&
      candidate.action !== "cancelled"
    ) {
      return candidate;
    }
    const enriched = directive({
      ...candidate,
      result: { ...candidate.result, liveness: snapshot },
    });
    context.pendingDirective = enriched;
    context.terminalDirective = enriched;
    return enriched;
  }

  private requiresLivenessPolicy(context: RunContext): boolean {
    return this.liveness.canBindPolicy(context);
  }

  private bindLivenessIfRequired(context: RunContext): void {
    if (this.requiresLivenessPolicy(context)) this.liveness.bindPolicy(context);
  }

  private registrationBindingRefusal(context: RunContext): Directive | undefined {
    const binding = context.registrationContractBinding;
    const bindingRequired = binding !== undefined || this.contract.release_status === "candidate";
    if (!bindingRequired) return undefined;
    let activeContractSha256: string | undefined;
    let activeRegistrationSha256: string | undefined;
    try {
      activeContractSha256 = skillContractSha256(this.contract);
      activeRegistrationSha256 = runtimeRegistrationSha256(this.registration);
    } catch {
      // Runtime registration mutation or corruption is a closed mismatch, never an unchecked throw.
    }
    const code =
      binding === undefined
        ? "REGISTRATION_CONTRACT_BINDING_MISSING"
        : binding.registration_name !== this.registration.name ||
            binding.release_status !== this.contract.release_status ||
            binding.contract_sha256 !== activeContractSha256 ||
            binding.registration_sha256 !== activeRegistrationSha256
          ? "REGISTRATION_CONTRACT_MISMATCH"
          : undefined;
    if (code === undefined) return undefined;
    return directive({
      schema_version: 2,
      action: "error",
      identity: context.identity,
      status: "error",
      met: false,
      result: {
        code,
        checkpoint_unchanged: true,
        active_registration_name: this.registration.name,
        active_release_status: this.contract.release_status,
        active_contract_sha256: activeContractSha256 ?? null,
        active_registration_sha256: activeRegistrationSha256 ?? null,
        checkpoint_contract_sha256: binding?.contract_sha256 ?? null,
        checkpoint_registration_sha256: binding?.registration_sha256 ?? null,
      },
      artifacts: [],
      unresolved: [
        code === "REGISTRATION_CONTRACT_BINDING_MISSING"
          ? "The candidate checkpoint predates immutable registration-contract binding."
          : "The checkpoint is bound to a different registration contract or release status.",
      ],
    });
  }

  private status(identity: RunIdentity): Directive {
    const context = this.checkpointer.loadRun(identity);
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) return bindingRefusal;
    if (context.terminalDirective !== null) {
      return this.currentDirective(context);
    }
    return directive({
      schema_version: 2,
      action: "status",
      identity: context.identity,
      status: context.status,
      state_id: context.stateId,
      terminal: false,
      met: context.met,
      liveness: this.liveness.snapshot(context.identity.run_id),
    });
  }

  private recover(identity: RunIdentity): Directive {
    const context = this.checkpointer.loadRun(identity);
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) return bindingRefusal;
    // Fail closed on an unregistered playbook, with the exact refusal this engine
    // produced before the registry existed: same code, same fields, checkpoint untouched.
    if (!isRegisteredPlaybook(context.identity.playbook, this.registry)) {
      return directive({
        schema_version: 2,
        action: "error",
        identity: context.identity,
        status: "error",
        met: false,
        result: {
          code: "PLAYBOOK_UNAVAILABLE",
          playbook: context.identity.playbook,
          checkpoint_unchanged: true,
        },
        artifacts: [],
        unresolved: [
          `Playbook '${context.identity.playbook}' is unavailable in the TypeScript engine.`,
        ],
      });
    }
    if (context.terminalDirective !== null) return this.currentDirective(context);
    if (this.requiresLivenessPolicy(context) && !this.liveness.hasPolicy(context.identity.run_id)) {
      return this.pausedDirective(
        context.identity,
        context.stateId,
        "LEGACY_UNMETERED",
        "active legacy run has no durable liveness policy; recovery is paused",
        true
      );
    }
    const interruptionReason = this.liveness.recoverOpenWorkers(context.identity.run_id);
    if (interruptionReason !== null) return this.exhaust(identity, interruptionReason);
    this.bindLivenessIfRequired(context);
    if (hasHostContinuation(this.playbook) && this.playbook.needsHostContinuation(context)) {
      return this.advanceHost(context);
    }
    return this.currentDirective(context);
  }

  private dispatchState(): {
    active: boolean;
    code: "DISPATCH_PAUSED" | "DISPATCH_MODE_INVALID";
    reason: string;
  } {
    const mode = this.dispatchMode()?.trim() || "active";
    if (mode === "active") {
      return {
        active: true,
        code: "DISPATCH_PAUSED",
        reason: "artifact dispatch is active",
      };
    }
    if (mode === "paused") {
      return {
        active: false,
        code: "DISPATCH_PAUSED",
        reason: "artifact dispatch is paused by the execution owner",
      };
    }
    return {
      active: false,
      code: "DISPATCH_MODE_INVALID",
      reason: `unknown artifact dispatch mode '${mode}'`,
    };
  }

  private pausedDirective(
    identity: RunIdentity,
    stateId: string,
    code: "DISPATCH_PAUSED" | "DISPATCH_MODE_INVALID" | "LEGACY_UNMETERED",
    reason: string,
    checkpointPreserved: boolean
  ): Directive {
    return directive({
      schema_version: 2,
      action: "paused",
      identity,
      status: "running",
      state_id: stateId,
      code,
      reason,
      retryable: true,
      recovery: {
        action: "recover",
        run_id: identity.run_id,
        checkpoint_preserved: checkpointPreserved,
      },
    });
  }

  private admitTerminal(
    context: RunContext,
    next: Directive,
    pendingPhaseResult?: PhaseResult
  ): Directive {
    const candidate = this.requiresLivenessPolicy(context)
      ? this.attachLiveness(context, next, this.liveness.snapshot(context.identity.run_id))
      : next;
    return admitCompletionCandidate({
      checkpointer: this.checkpointer,
      contract: this.contract,
      predicates: this.completionPredicates,
      context,
      candidate,
      ...(this.artifactReader !== undefined ? { artifactReader: this.artifactReader } : {}),
      projectRoot: this.projectRoot,
      ...(pendingPhaseResult !== undefined ? { pendingPhaseResult } : {}),
    });
  }

  private loadRequiredRun(runId: string): RunContext {
    const context = this.checkpointer.loadRunById(runId);
    if (context === undefined) {
      throw new CheckpointIdentityError(`run '${runId}' disappeared during durable reconciliation`);
    }
    return context;
  }

  private currentDirective(context: RunContext): Directive {
    if (context.terminalDirective !== null) {
      const terminal = terminalDirective(context.terminalDirective);
      if (
        terminal?.action === "complete" &&
        terminal.status === "complete" &&
        terminal.met === true
      ) {
        const envelope = this.checkpointer.completionAdmission(context.identity.run_id);
        if (envelope === undefined) {
          // The durable run-context discriminator cannot be erased by stripping event payloads.
          // Metadata remains a compatibility signal for W7 runs created before the discriminator.
          const requiresEnvelope =
            context.completionProtocolVersion === 1 ||
            this.checkpointer.hasCompletionProtocolMetadata(context.identity.run_id);
          if (!requiresEnvelope) return context.terminalDirective;
          throw new CheckpointIdentityError(
            `checkpoint '${context.identity.run_id}' is missing completion admission evidence`
          );
        }
        const { terminal_envelope_id: envelopeId, ...body } = envelope;
        const latest = resolveLatestProduct({
          gate: this.contract.completion_gate,
          context,
          terminal,
        });
        if (
          envelopeId !== `tenv_${sha256(canonicalJson(body))}` ||
          envelope.run_id !== context.identity.run_id ||
          envelope.gate_digest !== sha256(canonicalJson(this.contract.completion_gate)) ||
          envelope.terminal_digest !== sha256(canonicalJson(terminal)) ||
          canonicalJson(envelope.state_visit_refs) !==
            canonicalJson(this.checkpointer.stateVisits(context.identity.run_id)) ||
          latest.product === undefined ||
          canonicalJson(envelope.latest_product) !== canonicalJson(latest.product) ||
          envelope.unresolved_count !== terminal.unresolved.length ||
          envelope.evidence_refs.some(
            (ref) => !this.checkpointer.completionEvidenceRefExists(ref, context.identity.run_id)
          )
        ) {
          throw new CheckpointIdentityError(
            `checkpoint '${context.identity.run_id}' has corrupt completion admission evidence`
          );
        }
      }
      return context.terminalDirective;
    }
    if (context.pendingDirective === null) {
      throw new Error(`checkpoint '${context.identity.run_id}' has no recoverable directive`);
    }
    // Re-bind the output artifact spec to the current ledger top so a directive
    // saved across a crash window is never replayed with a stale version.
    const rebound = this.playbook.rebindPendingDirective(context);
    if (rebound === null) {
      throw new Error(`checkpoint '${context.identity.run_id}' has no recoverable directive`);
    }
    return rebound;
  }
}
