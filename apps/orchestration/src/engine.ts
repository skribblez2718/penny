import {
  verifyHostEffectBinding,
  verifyHostResultWrapper,
} from "./host-operations/effect-protocol.js";
import { recordVideogenGateAnswer } from "./videogen/owner-selection.js";
import path from "node:path";
import { validateSourceRoutingSummary } from "./source-routing-summary.js";

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
import { optionalCycleLimit, RunContext } from "./context.js";
import type { ChildWorkflowCallRecord } from "./child-workflows/contracts.js";
import {
  ProjectedChildResponseV1Schema,
  projectChildGate,
  validateProjectedChildResponse,
} from "./child-workflows/gates.js";
import {
  validateHostOperationReceipt,
  validateHostOperationResult,
  type HostOperationCallRecordV1,
} from "./host-operations/contracts.js";
import {
  OperationReceiptStore,
  promotionApplyOperationSourceIdentity,
  promotionDecisionOperationSourceIdentity,
  replayableResultFromRun,
} from "./kb/operation-receipts.js";
import type { OperationEventGroup } from "./kb/contracts.js";
import {
  ArtifactDispatchStateV1Schema,
  ContractValidationError,
  EvaluationResultSchema,
  FeedbackRouteEvidenceV1Schema,
  OrchestrationRequestSchema,
  artifactDispatchRecoveryV1,
  type ArtifactDispatchIneligibilityCode,
  type ArtifactDispatchPauseCode,
  type ArtifactDispatchStateV1,
  type ArtifactRef,
  type BranchDispatch,
  type CompletionAdmissionEnvelope,
  type CompletionEvidenceRef,
  type CompletionFailureCode,
  type CompletionProductEvidence,
  type Confidence,
  type Directive,
  type EvaluationResult,
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
  hasGenericGateResponseStorage,
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
  type PlaybookStepOutcome,
  type Playbook,
} from "./playbooks/playbook.js";
import {
  bindGenericChildYamlAuthority,
  DEFAULT_PLAYBOOK_NAME,
  isRegisteredPlaybook,
  PLAYBOOK_REGISTRY,
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  validateRegistrationContract,
  withOrdinaryFaultConstructor,
  type PlaybookRegistration,
  type PlaybookRegistry,
  type PreparedStartV1,
  type OrdinaryHostFaultV1,
} from "./playbooks/registry.js";
import { ReceiptAuthority, trustedInvocationDigest } from "./receipts.js";
import type { ResearchContextOwnerV2 } from "./research-context.js";
import { assertResolvedModelIdentity, validateRequiredModelIdentity } from "./required-model.js";
import type { ImagegenStartAdmissionProvidersV1 } from "./imagegen/types.js";
import { CompositionAdmissionError, validateSemanticComposition } from "./composition.js";
import { nativeStartRequest, assertAdmittedArtifactInputs } from "./contextual-artifacts.js";
import { ArtifactStore } from "./artifact-store.js";
import type { EffectEvidenceProviderV1 } from "./skill-contracts/effects.js";
import type { ScaP02ComponentValidationAuthorityV1 } from "./sca/p02-contracts.js";
import {
  LivenessController,
  malformedErrorDigest,
  type LivenessPolicyResolver,
} from "./liveness.js";

export interface EngineOptions {
  readonly projectRoot: string;
  readonly maxSteps?: number | null;
  readonly maxIterations?: number | null;
  readonly dispatchMode?: () => string | undefined;
  /** Durable hosts must inject their canonical receipt authority. */
  readonly receiptAuthority: ReceiptAuthority;
  /** Immutable artifact-manifest ledger used to resolve output revision chains. */
  readonly artifactRevisions?: ArtifactRevisionLookup;
  /** Writable host artifact plane for deterministic request/core/product artifacts. */
  readonly artifactStore?: ArtifactHostStore;
  /** Exact-byte capability used for typed import admission before run mutation. */
  readonly artifactReader?: ArtifactReader;
  /** Project binding for prospective composition assurance (the store and DB are rechecked). */
  readonly assuranceProjectId?: string;
  /** Owner-resolved, metadata-only research context seam. */
  readonly researchContext?: ResearchContextOwnerV2;
  /** Private image profile/export/storage registries used only by typed start admission. */
  readonly imagegen?: ImagegenStartAdmissionProvidersV1;
  readonly livenessController?: LivenessController;
  /** Test/private registration fallback; durable bound policy bytes always win on replay. */
  readonly livenessPolicyResolver?: LivenessPolicyResolver;
  /** Host-only ordinary-skill crash-boundary injection; not part of requests or environment. */
  readonly hostFault?: OrdinaryHostFaultV1;
  /** Legacy Research-only host injection; mutually exclusive with hostFault. */
  readonly researchHostFault?: (point: string) => void;
  /** Trusted host gate-evaluation clock; tests may inject a deterministic value. */
  readonly trustedClock?: () => Date;
  /** Host-owned P02 component admission authority; absent authority fails candidate construction. */
  readonly scaP02ComponentValidationAuthority?: ScaP02ComponentValidationAuthorityV1;
  /** Optional trusted, immutable effect-trace snapshot provider. Absence means unknown. */
  readonly effectEvidenceProvider?: EffectEvidenceProviderV1;
  /**
   * Playbook registry override. Production uses the shipped single-entry registry;
   * tests inject a double to prove multi-playbook dispatch without activating a skill.
   */
  readonly playbookRegistry?: PlaybookRegistry;
  /** Exact registration already resolved through an allowed candidate path. */
  readonly playbookRegistration?: PlaybookRegistration;
  /**
   * Which registered playbook this engine instance drives. Defaults to the sole
   * production playbook (research). The KB skill drives the engine with its own
   * registration ('knowledge-base'); each engine instance still owns exactly one
   * playbook, so the single-owner invariants (contract, state machine, receipts)
   * are unchanged.
   */
  readonly playbookName?: string;
}

export const ARTIFACT_DISPATCH_MODE_ENV = "PENNY_ARTIFACT_DISPATCH_MODE";

/** Sole execution-owner parser. It is deliberately exact: no trimming or case folding. */
export function parseArtifactDispatchMode(value: unknown): ArtifactDispatchStateV1 {
  if (value === undefined) {
    return validateContract(
      ArtifactDispatchStateV1Schema,
      {
        schema_version: 1,
        mode: "active",
        configured_as: "unset",
        code: "DISPATCH_ACTIVE",
        reason: "artifact dispatch is active because the setting is unset",
        dispatch_allowed: true,
      },
      "artifact dispatch mode"
    );
  }
  if (value === "active") {
    return validateContract(
      ArtifactDispatchStateV1Schema,
      {
        schema_version: 1,
        mode: "active",
        configured_as: "active",
        code: "DISPATCH_ACTIVE",
        reason: "artifact dispatch is explicitly active",
        dispatch_allowed: true,
      },
      "artifact dispatch mode"
    );
  }
  if (value === "paused") {
    return validateContract(
      ArtifactDispatchStateV1Schema,
      {
        schema_version: 1,
        mode: "paused",
        configured_as: "paused",
        code: "DISPATCH_PAUSED",
        reason: "artifact dispatch is paused by the execution owner",
        dispatch_allowed: false,
      },
      "artifact dispatch mode"
    );
  }
  return validateContract(
    ArtifactDispatchStateV1Schema,
    {
      schema_version: 1,
      mode: "paused",
      configured_as: "invalid",
      code: "DISPATCH_MODE_INVALID",
      reason: `${ARTIFACT_DISPATCH_MODE_ENV} must be unset or exactly 'active' or 'paused'; invalid configuration fails closed`,
      dispatch_allowed: false,
    },
    "artifact dispatch mode"
  );
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

export interface PreparedHostOperationContinuationV1 {
  readonly source_snapshot_sha256: string;
  readonly context: RunContext;
  readonly next: Directive;
}

interface RoutedRepairV1 {
  readonly next: PlaybookStepOutcome;
  readonly evidence?: FeedbackRouteEvidenceV1;
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
  // A terminal evidence graph may also include an imported product of the same kind
  // and producing phase. Only this run's output can satisfy its completion gate.
  const matches = input.terminal.artifacts.filter(
    (artifact) =>
      artifact.run_id === input.context.identity.run_id &&
      artifact.kind === spec.artifact_kind &&
      artifact.phase === spec.producing_state
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
      .filter(
        (candidate) =>
          candidate.run_id === artifact.run_id && candidate.operation_id === artifact.operation_id
      )
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
  verifyExecutionReceipt?: import("./receipts.js").ExecutionReceiptVerifier;
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
          ...(input.verifyExecutionReceipt === undefined
            ? {}
            : { verifyExecutionReceipt: input.verifyExecutionReceipt }),
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
  private readonly playbook: Playbook;
  private readonly registry: PlaybookRegistry;
  /** The exact validated active registration used by engine and workers (W6). */
  readonly registration: PlaybookRegistration;
  /** The active skill contract (W3). */
  readonly contract: SkillContract;
  private readonly completionPredicates: ReadonlyMap<string, CompletionReceiptPredicateV1>;
  private readonly registrationContractSha256: string;
  private readonly runtimeRegistrationSha256: string;
  private readonly projectRoot: string;
  /** Exact caller catalog used to bind generic-child YAML maxima for this engine instance. */
  private readonly catalogAgentProjectRoot: string;
  private readonly maxSteps: number | null;
  private readonly dispatchMode: () => string | undefined;
  private readonly artifactReader: ArtifactReader | undefined;
  private readonly artifactStore: ArtifactHostStore | undefined;
  private readonly trustedClock: () => Date;
  private readonly researchContext: ResearchContextOwnerV2 | undefined;
  private readonly imagegen: ImagegenStartAdmissionProvidersV1 | undefined;
  readonly receiptAuthority: ReceiptAuthority;
  readonly liveness: LivenessController;
  readonly maxIterations: number | null;

  constructor(
    private readonly checkpointer: Checkpointer,
    options: EngineOptions
  ) {
    if (options.hostFault !== undefined && options.researchHostFault !== undefined) {
      throw new Error("ambiguous host fault hooks: choose hostFault or researchHostFault");
    }
    this.checkpointer.bindKbRuntimeProjectRoot(options.projectRoot);
    this.registry =
      options.playbookRegistry ??
      (options.playbookRegistration === undefined
        ? PLAYBOOK_REGISTRY
        : new Map([[options.playbookRegistration.name, options.playbookRegistration]]));
    const playbookName =
      options.playbookName ?? options.playbookRegistration?.name ?? DEFAULT_PLAYBOOK_NAME;
    const selectedRegistration =
      options.playbookRegistration ?? resolvePlaybook(playbookName, this.registry);
    if (selectedRegistration === undefined) {
      throw new Error(`playbook '${playbookName}' is not registered in the supplied registry`);
    }
    if (selectedRegistration.name !== playbookName) {
      throw new Error(
        `playbook registration '${selectedRegistration.name}' does not match selected '${playbookName}'`
      );
    }
    this.catalogAgentProjectRoot = path.resolve(options.projectRoot);
    const registration = bindGenericChildYamlAuthority(
      options.hostFault !== undefined || options.researchHostFault !== undefined
        ? withOrdinaryFaultConstructor(selectedRegistration)
        : selectedRegistration,
      this.catalogAgentProjectRoot
    );
    // W3: authority metadata is validated before playbook construction.
    this.contract = validateRegistrationContract(registration, this.catalogAgentProjectRoot);
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
    this.trustedClock = options.trustedClock ?? (() => new Date());
    this.researchContext = options.researchContext;
    this.imagegen = options.imagegen;
    this.playbook = registration.construct({
      ...(options.artifactRevisions ? { artifactRevisions: options.artifactRevisions } : {}),
      ...(this.artifactReader ? { artifactReader: this.artifactReader } : {}),
      ...(this.artifactStore ? { artifactStore: this.artifactStore } : {}),
      ...(this.researchContext ? { researchContext: this.researchContext } : {}),
      checkpointer: this.checkpointer,
      verifyExecutionReceipt: (receipt) => options.receiptAuthority.verify(receipt),
      ...(options.hostFault ? { hostFault: options.hostFault } : {}),
      ...(options.researchHostFault ? { researchHostFault: options.researchHostFault } : {}),
      ...(options.trustedClock ? { trustedClock: options.trustedClock } : {}),
      ...(options.scaP02ComponentValidationAuthority
        ? { scaP02ComponentValidationAuthority: options.scaP02ComponentValidationAuthority }
        : {}),
      ...(options.effectEvidenceProvider
        ? { effectEvidenceProvider: options.effectEvidenceProvider }
        : {}),
      ...(this.imagegen ? { imagegen: this.imagegen } : {}),
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
    this.assuranceProjectId = options.assuranceProjectId;
    this.maxSteps = optionalCycleLimit(options.maxSteps, "max_steps");
    this.maxIterations = optionalCycleLimit(options.maxIterations, "max_iterations");
    this.dispatchMode = options.dispatchMode ?? (() => process.env[ARTIFACT_DISPATCH_MODE_ENV]);
    this.receiptAuthority = options.receiptAuthority;
    this.liveness =
      options.livenessController ?? new LivenessController(this.checkpointer, Date.now);
    const registrationResolver = registration.liveness.resolve;
    const fallbackResolver = options.livenessPolicyResolver;
    this.liveness.setPolicyResolver(
      (context, boundPolicy) =>
        registrationResolver(context, boundPolicy) ?? fallbackResolver?.(context, boundPolicy)
    );
  }

  private readonly assuranceProjectId: string | undefined;

  private assuranceHost(
    runId: string
  ): import("./playbooks/registry.js").StartAdmissionReadOnlyHostV1["assurance"] {
    if (!(this.artifactStore instanceof ArtifactStore) || this.assuranceProjectId === undefined)
      return undefined;
    const defineRegistration = resolvePlaybook("define", PLAYBOOK_REGISTRY);
    const supportedDefineRegistrationSha256 =
      defineRegistration === undefined
        ? null
        : runtimeRegistrationSha256(
            bindGenericChildYamlAuthority(defineRegistration, this.catalogAgentProjectRoot)
          );
    return {
      artifacts: this.artifactStore,
      checkpointer: this.checkpointer,
      project_id: this.assuranceProjectId,
      project_root: this.projectRoot,
      supported_define_registration_sha256: supportedDefineRegistrationSha256,
      consumer: {
        run_id: runId,
        registration_name: this.registration.name,
        contract_sha256: this.registrationContractSha256,
        registration_sha256: this.runtimeRegistrationSha256,
      },
    };
  }

  private prepareStart(request: StartRequest): PreparedStartV1 | undefined {
    const hasContext =
      request.input_artifacts?.artifacts.some((binding) => binding.designation === "context") ??
      false;
    if (hasContext && this.registration.contextual_inputs !== "accepted_terminal_products_v1")
      throw new CompositionAdmissionError(
        "COMPOSITION_CONTEXT_UNACCEPTED",
        "registration does not admit nonbinding context"
      );
    if (this.registration.ingress !== "skill") return undefined;
    const admission = this.registration.start_admission;
    if (admission === undefined) {
      throw new Error(`skill registration '${this.registration.name}' has no start admission`);
    }
    const assurance = this.assuranceHost(request.identity.run_id);
    const contexts =
      request.input_artifacts?.artifacts.filter((binding) => binding.designation === "context") ??
      [];
    const prepared = admission.prepare(nativeStartRequest(request), {
      ...(assurance === undefined ? {} : { assurance }),
      ...(this.artifactReader === undefined ? {} : { artifactReader: this.artifactReader }),
      ...(this.researchContext === undefined ? {} : { researchContext: this.researchContext }),
      ...(this.imagegen === undefined ? {} : { imagegen: this.imagegen }),
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
      inputArtifacts: {
        schema_version: 2,
        artifacts: [...(prepared.input_artifacts?.artifacts ?? []), ...contexts],
      },
      ...(contexts.length === 0
        ? {}
        : { acceptContextProduct: (ref: ArtifactRef) => this.assertAcceptedContextProduct(ref) }),
      ...(this.artifactReader === undefined ? {} : { artifactReader: this.artifactReader }),
    });
    return prepared;
  }

  private assertAcceptedContextProduct(ref: ArtifactRef): void {
    const fail = (): never => {
      throw new CompositionAdmissionError(
        "COMPOSITION_CONTEXT_UNACCEPTED",
        "context must be the exact current accepted terminal product of a supported producer"
      );
    };
    const producer = this.checkpointer.loadRunById(ref.run_id);
    if (producer === undefined) return fail();
    const template =
      resolvePlaybook(producer.identity.playbook, this.registry) ??
      resolvePlaybook(producer.identity.playbook, PLAYBOOK_REGISTRY);
    if (template === undefined) return fail();
    const registration = bindGenericChildYamlAuthority(template, this.catalogAgentProjectRoot);
    if (registration.contextual_inputs !== "accepted_terminal_products_v1") return fail();
    validateRegistrationContract(registration, this.catalogAgentProjectRoot);
    const binding = producer.registrationContractBinding;
    if (
      binding?.registration_name !== registration.name ||
      binding.contract_sha256 !== skillContractSha256(registration.contract) ||
      binding.registration_sha256 !== runtimeRegistrationSha256(registration)
    )
      return fail();
    const terminal = producer.terminalDirective;
    if (
      producer.status !== "complete" ||
      !producer.met ||
      terminal?.action !== "complete" ||
      terminal.status !== "complete" ||
      !terminal.met ||
      canonicalJson(terminal.result.output_artifact_ref ?? null) !== canonicalJson(ref)
    )
      return fail();
    if (
      !registration.contract.io.active_output_ports.some(
        (port) =>
          port.semantic_product &&
          port.artifact_kind === ref.kind &&
          port.schema_id === ref.content_schema?.schema_id &&
          port.schema_version_required === ref.content_schema?.schema_version
      )
    )
      return fail();
    const envelope = this.checkpointer.completionAdmission(ref.run_id);
    if (
      envelope === undefined ||
      envelope.evidence_refs.some(
        (evidence) => !this.checkpointer.completionEvidenceRefExists(evidence, ref.run_id)
      )
    )
      return fail();
    // Replay the current host predicates on an isolated checkpoint clone. No owner state is changed.
    const checked = admitCompletionCandidate({
      checkpointer: this.checkpointer,
      contract: registration.contract,
      predicates: registration.completionReceiptPredicates,
      context: producer,
      candidate: terminal,
      ...(this.artifactReader === undefined ? {} : { artifactReader: this.artifactReader }),
      projectRoot: this.projectRoot,
      verifyExecutionReceipt: (receipt) => this.receiptAuthority.verify(receipt),
    });
    if (
      canonicalJson(checked) !== canonicalJson(terminal) ||
      canonicalJson(producer.pendingCompletionAdmission()) !== canonicalJson(envelope)
    )
      return fail();
  }

  private materializeStart(prepared: PreparedStartV1): readonly ArtifactRef[] {
    const admission = this.registration.start_admission;
    if (admission === undefined) return [];
    const assurance = this.assuranceHost(prepared.request.identity.run_id);
    return admission.materialize(prepared, {
      run_id: prepared.request.identity.run_id,
      ...(assurance === undefined ? {} : { assurance }),
      ...(this.artifactReader === undefined ? {} : { artifactReader: this.artifactReader }),
      ...(this.artifactStore === undefined ? {} : { artifactStore: this.artifactStore }),
      trustedClock: this.trustedClock,
      ...(this.researchContext === undefined ? {} : { researchContext: this.researchContext }),
      ...(this.imagegen === undefined ? {} : { imagegen: this.imagegen }),
    });
  }

  private catalogPhase(state: string, agent?: string) {
    const worker = this.registration.worker;
    if (worker.kind !== "catalog-agent") return undefined;
    const direct = worker.phases.get(state);
    const aliases = [...worker.phases.values()].filter(
      (phase) =>
        phase.directive_state_id === state && (agent === undefined || phase.agent === agent)
    );
    return direct !== undefined && (agent === undefined || direct.agent === agent)
      ? direct
      : aliases.length === 1
        ? aliases[0]
        : undefined;
  }

  /** Undefined policy is deliberately a no-op, including projected domain-core phases. */
  private sourceSummaryPreserved(original: PhaseResult, proposed?: PhaseResult): boolean {
    const phase = this.catalogPhase(original.state_id, original.agent);
    if (phase?.routing_repair_policy !== "preserve_source_summary_v1") return true;
    try {
      const reader = this.artifactReader;
      const ref = original.output_artifact;
      if (
        reader === undefined ||
        canonicalJson(reader.refById(ref.artifact_id)) !== canonicalJson(ref)
      )
        return false;
      const bytes = reader.readById(ref.artifact_id);
      if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest)
        return false;
      return validateSourceRoutingSummary(bytes, phase.schema, proposed) !== undefined;
    } catch {
      return false;
    }
  }

  /** Shared negative refusal, not exhaustion or a model-authored verdict. No selected
   * artifact or accepted sibling is discarded; reports are separate from partial products. */
  private repairRefusal(
    context: RunContext,
    code: string,
    reports: readonly ArtifactRef[]
  ): Directive {
    const next = directive({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: {
        reason_code: code,
        feedback_report_refs: reports,
        best_partial_artifact_refs: context.selectedArtifacts.filter(
          (ref) =>
            ref.kind !== "routing-metadata" &&
            !reports.some((report) => report.artifact_id === ref.artifact_id)
        ),
      },
      artifacts: context.selectedArtifacts,
      unresolved: [code],
    });
    context.status = "incomplete";
    context.met = false;
    context.pendingDirective = next;
    context.terminalDirective = next;
    return next;
  }

  private refuseSourceSummary(
    context: RunContext,
    original: PhaseResult,
    receipt: PhaseResult,
    branchId: string
  ): Directive {
    const next = this.repairRefusal(context, "source_summary_unpreservable", [
      original.output_artifact,
    ]);
    this.checkpointer.saveWithReceipt(context, receipt, branchId, "routing_repair_refused", {
      ...metadata(context.identity),
      state_id: original.state_id,
      branch_id: branchId,
      source_receipt_id: original.worker_receipt.receipt_id,
      reason_code: "source_summary_unpreservable",
      next_action: next.action,
    });
    return next;
  }

  private validatePhaseDetails(
    state: string,
    details: Record<string, JsonValue>,
    agent?: string
  ): Record<string, JsonValue> {
    const worker = this.registration.worker;
    if (worker.kind === "catalog-agent") {
      const phase = this.catalogPhase(state, agent);
      if (phase === undefined) {
        throw new Error(`active registration has no catalog phase '${state}'`);
      }
      validateContract(phase.schema, details, `${state} summary`);
      return details;
    }
    if (worker.kind === "none") {
      throw new Error(
        `deterministic registration '${this.registration.name}' cannot accept worker phase '${state}'`
      );
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
    const dispatch = parseArtifactDispatchMode(this.dispatchMode());
    if (!dispatch.dispatch_allowed && request.action !== "status" && request.action !== "cancel") {
      if (request.action === "start") {
        if (path.resolve(request.project_root) !== this.projectRoot) {
          throw new Error(
            `project_root mismatch: engine owns '${this.projectRoot}', request supplied '${request.project_root}'`
          );
        }
        if (!this.checkpointer.runExists(request.identity.run_id)) {
          return this.pausedDirective({
            identity: request.identity,
            status: "running",
            stateId: "intake",
            code: dispatch.code,
            reason: dispatch.reason,
            dispatch,
            recoveryKind: "start_retry",
            checkpointExists: false,
          });
        }
        const admitted = this.checkpointer.loadRun(request.identity);
        const bindingRefusal = this.registrationBindingRefusal(admitted);
        if (bindingRefusal !== undefined) return bindingRefusal;
        return this.pausedDirectiveForContext(admitted, dispatch);
      }
      const context = this.checkpointer.loadRun(request.identity);
      const bindingRefusal = this.registrationBindingRefusal(context);
      if (bindingRefusal !== undefined) return bindingRefusal;
      return this.pausedDirectiveForContext(context, dispatch);
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
          if (admitted.admittedInputArtifacts !== undefined)
            assertAdmittedArtifactInputs(admitted.admittedInputArtifacts, request.input_artifacts);
          const bindingRefusal = this.registrationBindingRefusal(admitted);
          if (bindingRefusal !== undefined) return bindingRefusal;
          if (admitted.terminalDirective !== null) {
            // A new Define/Plan start replay may not change the invocation assurance
            // policy just because the consumer has already completed. Historical
            // terminals without an assurance ref retain their existing reader path.
            if (
              preparedStart !== undefined &&
              (this.registration.name === "define" || this.registration.name === "plan") &&
              admitted.selectedArtifacts.some((ref) => ref.kind === "composition-assurance")
            )
              this.materializeStart(preparedStart);
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
            nativeStartRequest(request).input_artifacts?.artifacts.map((binding) => binding.ref) ??
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
          maxIterations: this.maxIterations,
          sealCorrectionLimit: this.registration.seal_policy?.correction_limit,
          registrationContractBinding: {
            schema_version: 1,
            registration_name: this.registration.name,
            contract_sha256: this.registrationContractSha256,
            registration_sha256: this.runtimeRegistrationSha256,
          },
          ...(uniqueInitialRefs.length === 0 ? {} : { initialArtifacts: uniqueInitialRefs }),
          ...(request.input_artifacts === undefined ||
          this.registration.contextual_inputs === undefined
            ? {}
            : { admittedInputArtifacts: request.input_artifacts }),
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
        return this.recover(request.identity, dispatch);
      case "respond":
        return this.respondUserGate(request);
      case "cancel": {
        const context = this.checkpointer.loadRun(request.identity);
        const bindingRefusal = this.registrationBindingRefusal(context);
        if (bindingRefusal !== undefined) return bindingRefusal;
        if (context.terminalDirective !== null) {
          return this.currentDirective(context);
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

  private respondUserGate(
    request: Extract<import("./contracts.js").OrchestrationRequest, { action: "respond" }>,
    mediatedCall?: ChildWorkflowCallRecord
  ): Directive {
    const context = this.checkpointer.loadRun(request.identity);
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) return bindingRefusal;
    const linkedCall = this.checkpointer.childWorkflowCallForChild(request.identity.run_id);
    if (
      linkedCall !== undefined &&
      (mediatedCall === undefined || canonicalJson(linkedCall) !== canonicalJson(mediatedCall))
    )
      throw new Error("child user replies require exact parent mediation");
    const committedGate = this.checkpointer.gateResponseBinding(
      request.identity.run_id,
      request.gate_id
    );
    if (committedGate?.status === "answered") {
      if (request.gate_id.startsWith("child-gate-"))
        throw new Error("projected child reply was already answered");
      if (
        committedGate.challenge !== request.challenge ||
        committedGate.response_digest !== sha256(canonicalJson(request.response))
      ) {
        throw new Error(`gate '${request.gate_id}' was already answered differently`);
      }
      if (context.terminalDirective !== null) return this.currentDirective(context);
      if (context.pendingDirective !== null) return context.pendingDirective;
      return this.status(request.identity);
    }
    if (
      context.pendingDirective?.action === "await_user" &&
      context.pendingDirective.child_workflow !== undefined
    ) {
      const pending = context.pendingDirective;
      if (
        pending.child_workflow?.schema_version !== 2 ||
        context.status !== "awaiting_user" ||
        pending.gate_id !== request.gate_id ||
        pending.challenge !== request.challenge
      )
        throw new Error("projected child gate challenge/version mismatch");
      const response = validateProjectedChildResponse(request.response, pending);
      const call = this.checkpointer.childWorkflowCall(response.projection.call_id);
      if (
        call === undefined ||
        call.lifecycle !== "waiting_user" ||
        call.parent_registration_sha256 !== this.runtimeRegistrationSha256
      )
        throw new Error("projected child call or registration mismatch");
      const childGate = this.checkpointer.loadRun(call.child_identity).pendingDirective;
      if (
        childGate?.action !== "await_user" ||
        canonicalJson(projectChildGate(call, childGate)) !== canonicalJson(pending)
      )
        throw new Error("projected child gate is no longer current");
      const store = this.artifactStore;
      if (store === undefined) throw new Error("projected child reply requires artifact custody");
      const artifactMetadata = {
        schema_version: 2 as const,
        run_id: context.identity.run_id,
        phase: context.stateId,
        branch_id: null,
        kind: "child-gate-response",
        operation_id: `child-response:${pending.gate_id}`,
        version: 1,
        producer: "host:child-workflow-owner",
        media_type: "application/json",
        content_schema: { schema_id: "penny.projected-child-response.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [call.request_ref],
      };
      const content = canonicalJson(response);
      const ref =
        store.refFor(
          artifactMetadata.run_id,
          artifactMetadata.phase,
          null,
          artifactMetadata.kind,
          artifactMetadata.operation_id,
          1
        ) ?? store.persist({ metadata: artifactMetadata, content });
      if (
        store.readById(ref.artifact_id).toString("utf8") !== content ||
        canonicalJson(store.metadata(ref)) !== canonicalJson(artifactMetadata)
      )
        throw new Error("projected reply artifact conflicts with exact custody");
      context.selectedArtifacts.push(ref);
      context.pendingDirective = call.directive;
      context.status = "running";
      this.checkpointer.saveGateResponse(
        context,
        request.gate_id,
        request.challenge,
        request.response,
        "child_workflow_reply_staged",
        {
          ...metadata(context.identity),
          call_id: call.call_id,
          response_artifact_id: ref.artifact_id,
        },
        "full",
        call.call_id
      );
      return call.directive;
    }
    if (hasGenericResponsePolicy(this.playbook)) {
      this.playbook.assertGenericResponseAllowed(context);
    }
    const pending = context.pendingDirective;
    if (
      context.status !== "awaiting_user" ||
      pending?.action !== "await_user" ||
      pending.gate_id !== request.gate_id
    ) {
      throw new Error(`run '${request.identity.run_id}' is not awaiting gate '${request.gate_id}'`);
    }
    if (pending.challenge !== request.challenge) {
      throw new Error(`challenge mismatch for gate '${request.gate_id}'`);
    }
    // The pending gate is the authority for this choice: resume may change state or
    // clear the directive, so resolve the storage policy before calling it.
    const responseStorage = hasGenericGateResponseStorage(this.playbook)
      ? this.playbook.genericGateResponseStorage(context)
      : "full";
    if (responseStorage !== "full" && responseStorage !== "digest-only") {
      throw new Error("invalid generic gate response storage mode");
    }
    const sourceSnapshotSha256 = sha256(canonicalJson(context.snapshot()));
    const candidate = this.playbook.resume(context, request.response);
    recordVideogenGateAnswer(context, pending, request.response, this.artifactStore);
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
      },
      responseStorage,
      undefined,
      sourceSnapshotSha256
    );
    return next;
  }

  /** Exact child gate delivery only after the parent response transaction has committed. */
  respondProjectedChildGate(record: ChildWorkflowCallRecord, responseRef: ArtifactRef): Directive {
    const parent = this.checkpointer.loadRun(record.parent_identity);
    if (
      parent.terminalDirective !== null ||
      canonicalJson(parent.pendingDirective) !== canonicalJson(record.directive) ||
      !parent.selectedArtifacts.some((ref) => canonicalJson(ref) === canonicalJson(responseRef))
    )
      throw new Error("parent-mediated child reply lost its parent fence");
    const store = this.artifactStore;
    if (
      store === undefined ||
      responseRef.kind !== "child-gate-response" ||
      responseRef.producer !== "host:child-workflow-owner"
    )
      throw new Error("child reply has no exact owner custody");
    const parsed: unknown = JSON.parse(store.readById(responseRef.artifact_id).toString("utf8"));
    // Rebuild the original gate from the durable response and exact call, never caller attributes.
    const response = validateContract(
      ProjectedChildResponseV1Schema,
      parsed,
      "ProjectedChildResponseV1"
    );
    const projection = response.projection;
    const binding = this.checkpointer.gateResponseBinding(
      record.parent_identity.run_id,
      responseRef.operation_id.slice("child-response:".length)
    );
    if (
      responseRef.run_id !== record.parent_identity.run_id ||
      responseRef.phase !== record.parent_state_id ||
      responseRef.content_schema?.schema_id !== "penny.projected-child-response.v1" ||
      responseRef.content_schema.schema_version !== 1 ||
      canonicalJson(parsed) !== store.readById(responseRef.artifact_id).toString("utf8") ||
      projection.call_id !== record.call_id ||
      projection.child_run_id !== record.child_identity.run_id ||
      projection.invocation_sha256 !== record.directive_sha256 ||
      projection.parent_registration_sha256 !== record.parent_registration_sha256 ||
      projection.child_registration_sha256 !== this.runtimeRegistrationSha256 ||
      binding?.status !== "answered" ||
      binding.response_digest !== sha256(canonicalJson(response))
    )
      throw new Error("child reply lacks a committed exact parent gate response");
    const childBinding = this.checkpointer.gateResponseBinding(
      record.child_identity.run_id,
      projection.child_gate_id
    );
    if (childBinding?.status !== "answered") {
      const childGate = this.checkpointer.loadRun(record.child_identity).pendingDirective;
      if (
        childGate?.action !== "await_user" ||
        canonicalJson(projectChildGate(record, childGate).child_workflow) !==
          canonicalJson(projection) ||
        projectChildGate(record, childGate).payload_digest !== response.payload_digest
      )
        throw new Error("projected child gate changed before committed reply delivery");
    }
    // After a child-reply commit crash, respondUserGate verifies the exact answered
    // challenge/reply receipt instead of requiring the now-consumed child gate again.
    return this.respondUserGate(
      {
        schema_version: 2,
        action: "respond",
        identity: record.child_identity,
        gate_id: projection.child_gate_id,
        challenge: projection.child_challenge,
        response: response.reply,
      },
      record
    );
  }

  /**
   * Prepare the parent mutation that consumes one exact settled host-operation result. The
   * checkpointer commits this context and the journal's consumed marker in one transaction.
   */
  prepareHostOperationContinuation(input: {
    readonly record: HostOperationCallRecordV1;
  }): PreparedHostOperationContinuationV1 {
    const record = input.record;
    if (
      record.lifecycle !== "settled" ||
      record.platform_result_ref === null ||
      record.host_receipt_ref === null ||
      record.disposition === null
    ) {
      throw new CheckpointIdentityError("host operation is not durably settled for consumption");
    }
    const context = this.checkpointer.loadRun(record.identity);
    const sourceSnapshotSha256 = sha256(canonicalJson(context.snapshot()));
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) {
      throw new CheckpointIdentityError(
        "host-operation parent registration is no longer eligible for consumption"
      );
    }
    if (
      context.status !== "running" ||
      context.stateId !== record.state_id ||
      canonicalJson(context.pendingDirective) !== canonicalJson(record.directive) ||
      record.registration_sha256 !== this.runtimeRegistrationSha256
    ) {
      throw new CheckpointIdentityError(
        "host-operation result does not match the parent's exact pending directive"
      );
    }
    const declaration = this.registration.host_operations?.declarations.find(
      (candidate) => candidate.operation_kind === record.operation_kind
    );
    if (declaration === undefined) {
      throw new CheckpointIdentityError("settled host operation is no longer registered");
    }
    const artifactReader = this.artifactReader;
    if (artifactReader === undefined) {
      throw new CheckpointIdentityError(
        "host-operation consumption requires exact artifact read custody"
      );
    }
    const exactBytes = (ref: ArtifactRef): Buffer => {
      const stored = artifactReader.refById(ref.artifact_id);
      if (stored === undefined || canonicalJson(stored) !== canonicalJson(ref)) {
        throw new CheckpointIdentityError(
          `host-operation artifact '${ref.artifact_id}' differs from exact custody`
        );
      }
      const bytes = artifactReader.readById(ref.artifact_id);
      if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
        throw new CheckpointIdentityError(
          `host-operation artifact '${ref.artifact_id}' failed exact-byte verification`
        );
      }
      return bytes;
    };
    verifyHostEffectBinding(artifactReader, record.project_id, record.directive);
    if (
      declaration.receipt_citing_result !== undefined &&
      record.operation_result_ref !== null &&
      record.result_wrapper?.ref == null
    )
      throw new CheckpointIdentityError("host operation lacks its post-receipt result wrapper");
    if (
      declaration.receipt_citing_result !== undefined &&
      record.operation_result_ref !== null &&
      record.result_wrapper?.ref == null
    )
      throw new CheckpointIdentityError("host-operation requires its receipt-citing wrapper");
    verifyHostResultWrapper(artifactReader, record);
    const resultBytes = exactBytes(record.platform_result_ref);
    const receiptBytes = exactBytes(record.host_receipt_ref);
    let resultJson: unknown;
    let receiptJson: unknown;
    try {
      resultJson = JSON.parse(resultBytes.toString("utf8"));
      receiptJson = JSON.parse(receiptBytes.toString("utf8"));
    } catch {
      throw new CheckpointIdentityError("host-operation result or receipt is not JSON");
    }
    const platformResult = validateHostOperationResult(resultJson);
    const hostReceipt = validateHostOperationReceipt(receiptJson);
    if (
      platformResult.operation_record_id !== record.operation_record_id ||
      hostReceipt.operation_record_id !== record.operation_record_id ||
      canonicalJson(platformResult.identity) !== canonicalJson(record.identity) ||
      canonicalJson(hostReceipt.identity) !== canonicalJson(record.identity) ||
      platformResult.state_id !== record.state_id ||
      hostReceipt.state_id !== record.state_id ||
      platformResult.attempt !== record.attempt ||
      hostReceipt.attempt !== record.attempt ||
      platformResult.operation_id !== record.operation_id ||
      hostReceipt.operation_id !== record.operation_id ||
      platformResult.operation_kind !== record.operation_kind ||
      hostReceipt.operation_kind !== record.operation_kind ||
      platformResult.registration_sha256 !== record.registration_sha256 ||
      hostReceipt.registration_sha256 !== record.registration_sha256 ||
      platformResult.request_sha256 !== record.request_sha256 ||
      hostReceipt.request_sha256 !== record.request_sha256 ||
      canonicalJson(platformResult.lease) !== canonicalJson(record.lease) ||
      canonicalJson(platformResult.disposition) !== canonicalJson(record.disposition) ||
      canonicalJson(hostReceipt.disposition) !== canonicalJson(record.disposition) ||
      canonicalJson(platformResult.operation_result_ref) !==
        canonicalJson(record.operation_result_ref) ||
      canonicalJson(platformResult.output_artifacts) !== canonicalJson(record.output_artifacts) ||
      hostReceipt.lease_disposition_receipt_id !== record.lease_disposition_receipt_id
    ) {
      throw new CheckpointIdentityError(
        "host-operation platform result or receipt diverges from the settled journal"
      );
    }
    if (
      record.operation_result_ref !== null &&
      (record.operation_result_ref.kind !== declaration.result.artifact_kind ||
        record.operation_result_ref.content_schema?.schema_id !== declaration.result.schema_id ||
        record.operation_result_ref.content_schema.schema_version !==
          declaration.result.schema_version_required)
    ) {
      throw new CheckpointIdentityError(
        "host-operation specific result violates the registered result contract"
      );
    }
    const registeredOutputContracts = declaration.output_contracts ?? [];
    for (const output of record.output_artifacts) {
      if (
        !registeredOutputContracts.some(
          (contract) =>
            output.kind === contract.artifact_kind &&
            output.content_schema?.schema_id === contract.schema_id &&
            output.content_schema.schema_version === contract.schema_version_required
        )
      ) {
        throw new CheckpointIdentityError(
          "host-operation output violates the registered output contracts"
        );
      }
    }
    const operationArtifacts = [
      ...(record.operation_result_ref === null ? [] : [record.operation_result_ref]),
      ...record.output_artifacts,
    ];
    const operationOutputBytes = operationArtifacts.reduce(
      (sum, artifact) => sum + exactBytes(artifact).byteLength,
      0
    );
    if (
      operationArtifacts.length > declaration.max_output_artifacts ||
      operationOutputBytes > declaration.max_output_bytes
    ) {
      throw new CheckpointIdentityError("host-operation output bounds are invalid");
    }
    const expectedReceiptId = `hop_receipt_${sha256(
      canonicalJson({
        operation_record_id: record.operation_record_id,
        disposition_receipt_id: record.lease_disposition_receipt_id,
      })
    )}`;
    if (
      hostReceipt.receipt_id !== expectedReceiptId ||
      hostReceipt.started_at !== record.started_at ||
      hostReceipt.progress_event_count !== record.progress_event_count ||
      hostReceipt.poll_count !== (record.fetched?.poll_count ?? 0) ||
      hostReceipt.request_bytes !== record.request_ref.byte_length ||
      hostReceipt.output_artifact_count !== operationArtifacts.length ||
      hostReceipt.output_bytes !== operationOutputBytes ||
      hostReceipt.result_sha256 !== (record.operation_result_ref?.content_digest ?? null) ||
      hostReceipt.remote_correlation_sha256 !== record.remote_correlation_sha256
    ) {
      throw new CheckpointIdentityError(
        "host-operation receipt counters or correlation evidence diverge from the settled journal"
      );
    }
    const add = (artifact: ArtifactRef): void => {
      const selected = context.selectedArtifacts.find(
        (candidate) => candidate.artifact_id === artifact.artifact_id
      );
      if (selected !== undefined) {
        if (canonicalJson(selected) !== canonicalJson(artifact)) {
          throw new CheckpointIdentityError(
            `host-operation artifact '${artifact.artifact_id}' conflicts with parent evidence`
          );
        }
        return;
      }
      context.selectedArtifacts.push(structuredClone(artifact));
    };
    for (const artifact of operationArtifacts) add(artifact);
    if (record.result_wrapper?.ref !== undefined && record.result_wrapper.ref !== null)
      add(record.result_wrapper.ref);
    add(record.platform_result_ref);
    add(record.host_receipt_ref);
    context.pendingDirective = null;
    context.pendingBranches = [];
    const callerCancelled =
      record.disposition.outcome === "cancelled" ||
      (record.disposition.outcome === "remote_unknown" &&
        record.disposition.reason_code.startsWith("cancelled_"));
    const candidate = callerCancelled
      ? this.playbook.cancel(context, "host operation cancelled by caller")
      : this.playbook.dispatch(context);
    if (isHostContinuation(candidate)) {
      throw new Error("host-operation continuation cannot begin an uncommitted host continuation");
    }
    return {
      source_snapshot_sha256: sourceSnapshotSha256,
      context,
      next: this.admitTerminal(context, validateDirective(candidate)),
    };
  }

  /**
   * Start an already reserved child run. Generic child calls never enter the public `start`
   * request path because reservation has already atomically created the child row and suspended
   * its parent. The supplied request is still passed through the child's ordinary start admission
   * and materialization path before any phase can execute.
   */
  startReservedChild(request: StartRequest): Directive {
    if (path.resolve(request.project_root) !== this.projectRoot) {
      throw new Error(
        `project_root mismatch: engine owns '${this.projectRoot}', request supplied '${request.project_root}'`
      );
    }
    const context = this.checkpointer.loadRun(request.identity);
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) return bindingRefusal;
    if (
      context.stateId !== "intake" ||
      context.status !== "running" ||
      context.pendingDirective !== null ||
      context.terminalDirective !== null
    ) {
      throw new CheckpointIdentityError(
        `reserved child '${request.identity.run_id}' is not an unstarted intake checkpoint`
      );
    }
    const prepared = this.prepareStart(request);
    if (prepared === undefined) {
      throw new Error(`child '${request.identity.playbook}' has no skill start admission`);
    }
    const materialized = this.materializeStart(prepared);
    for (const ref of materialized) {
      if (!context.selectedArtifacts.some((selected) => selected.artifact_id === ref.artifact_id)) {
        context.selectedArtifacts.push(ref);
      }
    }
    this.bindLivenessIfRequired(context);
    const next = this.admitTerminal(context, this.playbook.initialize(context));
    this.checkpointer.saveRun(context, "child_workflow_started", {
      ...metadata(context.identity),
      state_id: context.stateId,
    });
    return next;
  }

  /**
   * Build the parent continuation for one validated child terminal without persisting it. The
   * child owner commits this returned context together with the `consumed` call marker, so a crash
   * cannot leave a routed parent without the exact-once consumption record.
   */
  prepareChildWorkflowContinuation(input: {
    readonly record: ChildWorkflowCallRecord;
    readonly outputArtifact: ArtifactRef | null;
    readonly resultArtifact: ArtifactRef;
    readonly importedArtifacts?: readonly ArtifactRef[];
  }): {
    readonly context: RunContext;
    readonly next: Directive;
    readonly source_snapshot_sha256: string;
  } {
    const context = this.checkpointer.loadRun(input.record.parent_identity);
    const sourceSnapshotSha256 = sha256(canonicalJson(context.snapshot()));
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) {
      throw new Error(
        `parent '${input.record.parent_identity.run_id}' refuses child continuation: ${
          bindingRefusal.action
        }`
      );
    }
    const pending = context.pendingDirective;
    if (
      context.terminalDirective !== null ||
      pending?.action !== "invoke_child_workflow" ||
      canonicalJson(pending) !== canonicalJson(input.record.directive)
    ) {
      throw new CheckpointIdentityError(
        "child-workflow parent no longer names the exact reserved directive"
      );
    }
    const add = (artifact: ArtifactRef): void => {
      const existing = context.selectedArtifacts.find(
        (candidate) => candidate.artifact_id === artifact.artifact_id
      );
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(artifact)) {
          throw new CheckpointIdentityError(
            `child artifact '${artifact.artifact_id}' conflicts with selected parent evidence`
          );
        }
        return;
      }
      context.selectedArtifacts.push(structuredClone(artifact));
    };
    if (input.outputArtifact !== null) add(input.outputArtifact);
    for (const artifact of input.importedArtifacts ?? []) add(artifact);
    add(input.resultArtifact);
    context.pendingDirective = null;
    context.pendingBranches = [];
    const outcome = this.playbook.dispatch(context);
    if (isHostContinuation(outcome)) {
      throw new Error("child-workflow continuation cannot begin an uncommitted host continuation");
    }
    return {
      source_snapshot_sha256: sourceSnapshotSha256,
      context,
      next: this.admitTerminal(context, outcome),
    };
  }

  /** Fail closed when child execution was explicitly disabled or no owner was installed. */
  refuseChildWorkflowDispatch(
    directive: Extract<Directive, { action: "invoke_child_workflow" }>
  ): Directive {
    const context = this.checkpointer.loadRun(directive.identity);
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) return bindingRefusal;
    if (canonicalJson(context.pendingDirective) !== canonicalJson(directive)) {
      throw new CheckpointIdentityError(
        "child workflow refusal does not match the pending directive"
      );
    }
    const terminal = validateDirective({
      schema_version: 2,
      action: "error",
      identity: context.identity,
      status: "error",
      met: false,
      result: { code: "CHILD_WORKFLOW_OWNER_UNAVAILABLE" },
      artifacts: context.selectedArtifacts,
      unresolved: ["No child-workflow execution owner is installed for this service."],
    });
    context.status = "error";
    context.met = false;
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    this.checkpointer.saveRun(context, "child_workflow_refused", {
      ...metadata(context.identity),
      call_key: directive.call_key,
      child_name: directive.child_name,
      code: "CHILD_WORKFLOW_OWNER_UNAVAILABLE",
    });
    return terminal;
  }

  /** Fail closed when a registered host operation has no installed runtime owner. */
  refuseHostOperationDispatch(
    directive: Extract<Directive, { action: "invoke_host_operation" }>
  ): Directive {
    const context = this.checkpointer.loadRun(directive.identity);
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) return bindingRefusal;
    if (canonicalJson(context.pendingDirective) !== canonicalJson(directive)) {
      throw new CheckpointIdentityError(
        "host-operation refusal does not match the exact pending directive"
      );
    }
    const terminal = validateDirective({
      schema_version: 2,
      action: "error",
      identity: context.identity,
      status: "error",
      met: false,
      result: { code: "HOST_OPERATION_OWNER_UNAVAILABLE" },
      artifacts: context.selectedArtifacts,
      unresolved: ["No host-operation execution owner is installed for this service."],
    });
    context.status = "error";
    context.met = false;
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    this.checkpointer.saveRun(context, "host_operation_refused", {
      ...metadata(context.identity),
      operation_id: directive.operation_id,
      operation_kind: directive.operation_kind,
      code: "HOST_OPERATION_OWNER_UNAVAILABLE",
    });
    return terminal;
  }

  /**
   * Re-check the execution-owner setting at the last engine boundary before a
   * worker, fan-out branch, child workflow, or host operation can leave the engine package.
   */
  authorizeDispatch(candidate: Directive): Directive {
    if (
      candidate.action !== "invoke_agent" &&
      candidate.action !== "invoke_agents_parallel" &&
      candidate.action !== "invoke_child_workflow" &&
      candidate.action !== "invoke_host_operation"
    ) {
      return candidate;
    }
    const dispatch = parseArtifactDispatchMode(this.dispatchMode());
    if (dispatch.dispatch_allowed) return candidate;
    const context = this.checkpointer.loadRun(candidate.identity);
    const bindingRefusal = this.registrationBindingRefusal(context);
    if (bindingRefusal !== undefined) return bindingRefusal;
    return this.pausedDirectiveForContext(context, dispatch);
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
          this.validatePhaseDetails(result.state_id, result.details, result.agent);
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
    details: Record<string, JsonValue>,
    receiptOutputs: readonly ArtifactRef[],
    rejectedSchema = false
  ): RoutedRepairV1 | null {
    if (
      this.registration.repair_progress_policy === "exact_fingerprint_v1" &&
      (typeof this.playbook.evaluateRepair !== "function" ||
        typeof this.playbook.repairProgressFingerprint !== "function" ||
        typeof this.playbook.terminalizeRepairStall !== "function")
    )
      return {
        next: this.repairRefusal(context, "repair_progress_capability_missing", receiptOutputs),
      };
    if (!hasStateAwareRepair(this.playbook)) return null;
    const candidate = rejectedSchema
      ? (this.playbook.evaluateRejectedSummary?.(context, state, details) ?? null)
      : this.playbook.evaluateRepair(context, state, details);
    if (candidate === null) return null;
    const evaluation: EvaluationResult = validateContract(
      EvaluationResultSchema,
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
    let progress: FeedbackRouteEvidenceV1["repair_progress_v1"];
    let progressDisposition: "stalled" | "progress_invalid" | undefined;
    if (this.registration.repair_progress_policy === "exact_fingerprint_v1") {
      // One branch is scoped by its source ref, never by completion order or receipt ID.
      // Multiple outputs describe a fan aggregate, whose logical branch is null.
      const branchId = receiptOutputs.length === 1 ? (receiptOutputs[0]?.branch_id ?? null) : null;
      try {
        if (
          typeof this.playbook.repairProgressFingerprint !== "function" ||
          typeof this.playbook.terminalizeRepairStall !== "function"
        )
          throw new Error("missing paired repair progress capabilities");
        const fingerprint = this.playbook.repairProgressFingerprint(context, state, details);
        if (
          fingerprint !== null &&
          (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint))
        )
          throw new Error("invalid repair progress fingerprint");
        progress = { branch_id: branchId, fingerprint };
        if (
          fingerprint !== null &&
          this.checkpointer.events(context.identity.run_id).some((event) => {
            const value = event.payload.feedback_route_evidence_v1;
            if (value === undefined) return false;
            const prior = validateContract(
              FeedbackRouteEvidenceV1Schema,
              value,
              "durable repair route"
            );
            return (
              prior.disposition === "repair" &&
              prior.origin_state === state &&
              prior.repair_progress_v1?.branch_id === branchId &&
              prior.repair_progress_v1.fingerprint === fingerprint
            );
          })
        )
          progressDisposition = "stalled";
      } catch {
        progressDisposition = "progress_invalid";
      }
      if (progressDisposition !== undefined) {
        let next: Directive;
        if (
          progressDisposition === "stalled" &&
          typeof this.playbook.terminalizeRepairStall === "function"
        ) {
          const partials = [...context.selectedArtifacts];
          try {
            const candidate = validateDirective(
              this.playbook.terminalizeRepairStall(context, state, evaluation)
            );
            if (
              candidate.action !== "incomplete" ||
              candidate.status !== "incomplete" ||
              candidate.met !== false
            )
              throw new Error("repair stall terminal must be incomplete");
            next = directive({
              ...candidate,
              artifacts: [
                ...new Map(
                  [...partials, ...candidate.artifacts].map((ref) => [ref.artifact_id, ref])
                ).values(),
              ],
              result: {
                ...candidate.result,
                repair_stall: {
                  origin_state: state,
                  feedback_kind: evaluation.kind,
                  feedback_report_refs: receiptOutputs,
                },
              },
            });
            context.status = "incomplete";
            context.met = false;
            context.pendingDirective = next;
            context.terminalDirective = next;
          } catch {
            progressDisposition = "progress_invalid";
            next = this.repairRefusal(context, "repair_progress_invalid", receiptOutputs);
          }
        } else next = this.repairRefusal(context, "repair_progress_invalid", receiptOutputs);
        // Stall terminalization is not a repair charge or an exhaustion/reset route.
        context.iteration = usedBefore;
        return {
          next,
          evidence: validateContract(
            FeedbackRouteEvidenceV1Schema,
            {
              schema_version: 1,
              origin_state: state,
              feedback_kind: evaluation.kind,
              detail_sha256: sha256(evaluation.detail),
              strategy_delta_sha256: sha256(evaluation.strategy_delta),
              disposition: progressDisposition,
              target_state: state,
              ...(progress === undefined ? {} : { repair_progress_v1: progress }),
              budget: {
                counter: "iteration",
                used_before: usedBefore,
                limit,
                used_after: usedBefore,
              },
            },
            "repair stall route evidence"
          ),
        };
      }
    }
    const admitted = limit === null || usedBefore + 1 <= limit - route.budget.reserved_attempts;
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
    let next: PlaybookStepOutcome;
    if (!admitted && hasRepairExhaustion(this.playbook)) {
      next = this.playbook.terminalizeRepairExhaustion(context, state, evaluation);
      // Selected artifacts include earlier attempts. Bind only this accepted receipt's output(s).
      if ("result" in next && next.action !== "complete" && next.met === false) {
        if (
          context.pendingDirective === null ||
          context.terminalDirective === null ||
          canonicalJson(context.pendingDirective) !== canonicalJson(next) ||
          canonicalJson(context.terminalDirective) !== canonicalJson(next)
        ) {
          throw new Error(
            "repair exhaustion terminal does not match pending and terminal directives"
          );
        }
        const feedbackReports = receiptOutputs.filter(
          (ref) =>
            ref.run_id === context.identity.run_id &&
            ref.phase === state &&
            ref.kind !== "routing-metadata" &&
            context.selectedArtifacts.some(
              (selected) => canonicalJson(selected) === canonicalJson(ref)
            )
        );
        const decorated = validateDirective({
          ...next,
          result: {
            ...next.result,
            repair_diagnostics: {
              origin_state: state,
              feedback_kind: evaluation.kind,
              budget: { used: usedBefore, limit },
              feedback_report_refs: feedbackReports,
            },
          },
        });
        context.pendingDirective = decorated;
        context.terminalDirective = decorated;
        next = decorated;
      }
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
        ...(progress === undefined ? {} : { repair_progress_v1: progress }),
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
    let outcome: PlaybookStepOutcome;
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
      let rejected: RoutedRepairV1 | null = null;
      try {
        this.validatePhaseDetails(context.stateId, result.details, result.agent);
      } catch (error) {
        if (error instanceof ContractValidationError) {
          if (!this.sourceSummaryPreserved(result)) {
            return this.refuseSourceSummary(context, result, result, branchId);
          }
          rejected = this.routeTypedRepair(
            context,
            result.state_id,
            result.details,
            [result.output_artifact],
            true
          );
          if (rejected === null) return this.reissueMalformed(context, result, branchId, error);
        } else throw error;
      }
      const routed =
        rejected ??
        this.routeTypedRepair(context, result.state_id, result.details, [result.output_artifact]);
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
      if (assignment.execution_purpose === "routing_repair") {
        return this.acceptParallelRoutingRepair(context, pending, assignment, result);
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
        details = this.validatePhaseDetails(assignment.state_id, result.details, assignment.agent);
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
        const routed = this.routeTypedRepair(
          context,
          pending.state_id,
          aggregate,
          completed.flatMap((branch) => (branch.artifact ? [branch.artifact] : []))
        );
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
    if (!this.sourceSummaryPreserved(result)) {
      return this.refuseSourceSummary(context, result, result, branchId);
    }
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
        const priorPending = context.pendingDirective;
        const repair = this.playbook.routingRepair(context, result);
        next =
          branchId.length > 0 && priorPending?.action === "invoke_agents_parallel"
            ? this.replaceParallelBranchWithRepair(priorPending, branchId, repair)
            : repair;
        context.pendingDirective = next;
      } catch {
        next = this.livenessTerminal(context, "routing_repair_binding_invalid");
      }
    } else {
      next = this.livenessTerminal(context, "routing_repair_binding_invalid");
    }
    this.playbook.bindDispatch?.(context, next);
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

  private replaceParallelBranchWithRepair(
    pending: Extract<Directive, { action: "invoke_agents_parallel" }>,
    branchId: string,
    repair: Directive
  ): Extract<Directive, { action: "invoke_agents_parallel" }> {
    if (
      repair.action !== "invoke_agent" ||
      repair.execution_purpose !== "routing_repair" ||
      repair.routing_repair_binding?.source_branch_id !== branchId ||
      repair.input_artifacts.artifacts.filter((input) => input.designation !== "context").length !==
        1 ||
      canonicalJson(
        repair.input_artifacts.artifacts.find((input) => input.designation !== "context")?.ref ??
          null
      ) !== canonicalJson(repair.routing_repair_binding.source_artifact_ref)
    ) {
      throw new Error("parallel routing repair must bind one exact pending source branch");
    }
    const matches = pending.branches.filter((branch) => branch.branch_id === branchId);
    if (matches.length !== 1) {
      throw new Error("parallel routing repair source branch is not uniquely pending");
    }
    const replacement: BranchDispatch = {
      branch_id: branchId,
      state_id: repair.state_id,
      agent: repair.agent,
      attempt: repair.attempt,
      trust_profile: repair.trust_profile,
      ...(repair.model_override ? { model_override: repair.model_override } : {}),
      execution_purpose: "routing_repair",
      routing_repair_binding: repair.routing_repair_binding,
      task: repair.task,
      input_artifacts: repair.input_artifacts,
      output_artifact: {
        ...repair.output_artifact,
        branch_id: branchId,
      },
    };
    const next = directive({
      ...pending,
      branches: pending.branches.map((branch) =>
        branch.branch_id === branchId ? replacement : branch
      ),
    });
    if (next.action !== "invoke_agents_parallel") {
      throw new Error("parallel routing repair did not produce a parallel directive");
    }
    return next;
  }

  /** Retry metadata only, retaining the original semantic source and signed receipt binding. */
  private retryRoutingRepair(
    context: RunContext,
    result: PhaseResult,
    branchId: string | null
  ): Directive {
    const pending = context.pendingDirective;
    const assignment =
      pending?.action === "invoke_agent"
        ? pending
        : pending?.action === "invoke_agents_parallel"
          ? pending.branches.find((branch) => branch.branch_id === branchId)
          : undefined;
    if (
      assignment?.execution_purpose !== "routing_repair" ||
      assignment.routing_repair_binding === undefined
    ) {
      return this.livenessTerminal(context, "routing_repair_binding_invalid");
    }
    if (context.maxSteps !== null && context.stepCount >= context.maxSteps) {
      throw new Error(`run exceeded max_steps=${context.maxSteps}`);
    }
    context.previousState = context.stateId;
    context.stepCount += 1;
    const output = {
      ...assignment.output_artifact,
      version: result.output_artifact.version + 1,
      parent_ref: result.output_artifact,
    };
    const next =
      pending?.action === "invoke_agent"
        ? directive({ ...pending, attempt: context.stepCount, output_artifact: output })
        : pending?.action === "invoke_agents_parallel"
          ? directive({
              ...pending,
              branches: pending.branches.map((branch) =>
                branch.branch_id === branchId
                  ? { ...branch, attempt: context.stepCount, output_artifact: output }
                  : branch
              ),
            })
          : this.livenessTerminal(context, "routing_repair_binding_invalid");
    context.pendingDirective = next;
    this.playbook.bindDispatch?.(context, next);
    return next;
  }

  private acceptParallelRoutingRepair(
    context: RunContext,
    pending: Extract<Directive, { action: "invoke_agents_parallel" }>,
    assignment: BranchDispatch,
    repairResult: PhaseResult
  ): Directive {
    const branchId = assignment.branch_id;
    const binding = assignment.routing_repair_binding;
    if (
      binding === undefined ||
      binding.source_branch_id !== branchId ||
      repairResult.branch_id !== branchId
    ) {
      return this.persistInvalidParallelRepair(context, repairResult, branchId);
    }
    this.assertAssignment(repairResult, assignment.state_id, assignment.agent, assignment.attempt);
    this.validateOutputArtifact(
      repairResult,
      context.identity,
      assignment.output_artifact,
      assignment.input_artifacts,
      assignment.task,
      assignment.trust_profile,
      assignment.model_override ?? null,
      branchId,
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
      return this.persistInvalidParallelRepair(context, repairResult, branchId);
    }

    if (!this.sourceSummaryPreserved(original, repairResult)) {
      return this.refuseSourceSummary(context, original, repairResult, branchId);
    }
    let details: Record<string, JsonValue>;
    try {
      details = this.validatePhaseDetails(original.state_id, repairResult.details, original.agent);
    } catch (error) {
      if (!(error instanceof ContractValidationError)) throw error;
      const digest = malformedErrorDigest({
        kind: "malformed_result",
        stateId: original.state_id,
        branchId,
        schemaIssues: error.issues,
      });
      const charged = this.liveness.chargeMalformed({
        runId: context.identity.run_id,
        stateId: original.state_id,
        branchId,
        digest,
      });
      const terminal =
        charged === null
          ? this.retryRoutingRepair(context, repairResult, original.branch_id ?? null)
          : this.livenessTerminal(context, charged);
      this.checkpointer.saveWithReceipt(
        context,
        repairResult,
        branchId,
        "routing_repair_malformed",
        {
          ...metadata(context.identity),
          state_id: original.state_id,
          branch_id: branchId,
          malformed_digest: digest,
          ...(charged === null
            ? {}
            : {
                terminal_reason: charged,
                liveness: this.snapshotWithReason(context.identity.run_id, charged),
              }),
          next_action: terminal.action,
        }
      );
      return terminal;
    }

    const branch = context.pendingBranches.find((candidate) => candidate.branch_id === branchId);
    if (branch === undefined || branch.completed) {
      return this.persistInvalidParallelRepair(context, repairResult, branchId);
    }
    const branchIndex = context.pendingBranches.indexOf(branch);
    context.pendingBranches[branchIndex] = {
      ...branch,
      completed: true,
      confidence: repairResult.confidence,
      result: details,
      artifact: original.output_artifact,
    };
    const incomplete = new Set(
      context.pendingBranches
        .filter((candidate) => !candidate.completed)
        .map((candidate) => candidate.branch_id)
    );
    if (incomplete.size > 0) {
      const next = directive({
        ...pending,
        branches: pending.branches.filter((candidate) => incomplete.has(candidate.branch_id)),
      });
      context.pendingDirective = next;
      this.checkpointer.saveWithReceipt(
        context,
        repairResult,
        branchId,
        "routing_repair_branch_accepted",
        {
          ...metadata(context.identity),
          state_id: original.state_id,
          branch_id: branchId,
          source_receipt_id: original.worker_receipt.receipt_id,
          repair_receipt_id: repairResult.worker_receipt.receipt_id,
          next_action: next.action,
        }
      );
      this.bindLivenessIfRequired(context);
      return next;
    }
    if (!hasFanAggregate(this.playbook)) {
      return this.persistInvalidParallelRepair(context, repairResult, branchId);
    }

    const aggregate = this.playbook.aggregateBranches(
      context.pendingBranches.map((candidate) => candidate.result ?? {})
    );
    const routed = this.routeTypedRepair(
      context,
      pending.state_id,
      aggregate,
      context.pendingBranches.flatMap((branch) => (branch.artifact ? [branch.artifact] : []))
    );
    const outcome =
      routed === null
        ? this.playbook.acceptSummary(
            context,
            aggregate,
            weakestConfidence(
              context.pendingBranches.map((candidate) => candidate.confidence ?? "UNCERTAIN")
            )
          )
        : routed.next;
    const folded: PhaseResult = {
      ...original,
      confidence: repairResult.confidence,
      details,
    };
    const immediate = isHostContinuation(outcome)
      ? undefined
      : this.admitTerminal(context, outcome, folded);
    this.checkpointer.saveWithReceipt(context, repairResult, branchId, "routing_repair_accepted", {
      ...metadata(context.identity),
      state_id: original.state_id,
      branch_id: branchId,
      source_receipt_id: original.worker_receipt.receipt_id,
      repair_receipt_id: repairResult.worker_receipt.receipt_id,
      next_action: immediate?.action ?? "host_continuation",
      ...(routed?.evidence === undefined ? {} : { feedback_route_evidence_v1: routed.evidence }),
    });
    this.bindLivenessIfRequired(context);
    return immediate ?? this.advanceHost(context, folded);
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
    if (!this.sourceSummaryPreserved(original, repairResult)) {
      return this.refuseSourceSummary(context, original, repairResult, "");
    }
    let details: Record<string, JsonValue>;
    try {
      details = this.validatePhaseDetails(original.state_id, repairResult.details, original.agent);
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
      const terminal =
        charged === null
          ? this.retryRoutingRepair(context, repairResult, original.branch_id ?? null)
          : this.livenessTerminal(context, charged);
      this.checkpointer.saveWithReceipt(context, repairResult, "", "routing_repair_malformed", {
        ...metadata(context.identity),
        state_id: original.state_id,
        branch_id: original.branch_id ?? "",
        malformed_digest: digest,
        ...(charged === null
          ? {}
          : {
              terminal_reason: charged,
              liveness: this.snapshotWithReason(context.identity.run_id, charged),
            }),
        next_action: terminal.action,
      });
      return terminal;
    }
    const folded: PhaseResult = {
      ...original,
      confidence: repairResult.confidence,
      details,
    };
    let outcome: PlaybookStepOutcome;
    let routeEvidence: FeedbackRouteEvidenceV1 | undefined;
    if (binding.source_branch_id === null) {
      const routed = this.routeTypedRepair(context, original.state_id, details, [
        original.output_artifact,
      ]);
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
      const routed = this.routeTypedRepair(
        context,
        original.state_id,
        aggregate,
        context.pendingBranches.flatMap((branch) => (branch.artifact ? [branch.artifact] : []))
      );
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

  private persistInvalidParallelRepair(
    context: RunContext,
    repairResult: PhaseResult,
    branchId: string
  ): Directive {
    const next = this.livenessTerminal(context, "routing_repair_binding_invalid");
    this.checkpointer.saveWithReceipt(context, repairResult, branchId, "routing_repair_invalid", {
      ...metadata(context.identity),
      branch_id: branchId,
      terminal_reason: "routing_repair_binding_invalid",
      liveness: this.snapshotWithReason(context.identity.run_id, "routing_repair_binding_invalid"),
    });
    return next;
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
    const worker = this.registration.worker;
    if (worker.kind === "catalog-agent") {
      const direct = worker.phases.get(result.state_id);
      const aliases = [...worker.phases.values()].filter(
        (phase) => phase.directive_state_id === result.state_id && phase.agent === result.agent
      );
      const phase =
        direct?.agent === result.agent ? direct : aliases.length === 1 ? aliases[0] : undefined;
      const requiredModel = phase?.required_model;
      if (requiredModel !== undefined) {
        validateRequiredModelIdentity(requiredModel, "receipt required model");
        if (
          receipt.requested_model === undefined ||
          canonicalJson(receipt.requested_model) !== canonicalJson(requiredModel) ||
          receipt.observed_model === undefined
        ) {
          throw new Error(
            "worker receipt lacks exact requested and observed model identity evidence"
          );
        }
        assertResolvedModelIdentity(
          requiredModel,
          receipt.observed_model,
          "receipt observed model"
        );
      }
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
    // Completed terminals are immutable historical facts. Replay their exact stored bytes even
    // after a registration change; only active/interrupted work requires the current binding.
    if (context.terminalDirective !== null) return undefined;
    const binding = context.registrationContractBinding;
    // Runs created before immutable binding was introduced remain readable legacy state.
    // Every new run records both current contract and runtime registration digests.
    if (binding === undefined) return undefined;
    let activeContractSha256: string | undefined;
    let activeRegistrationSha256: string | undefined;
    try {
      activeContractSha256 = skillContractSha256(this.contract);
      validateRegistrationContract(this.registration, this.catalogAgentProjectRoot);
      activeRegistrationSha256 = runtimeRegistrationSha256(this.registration);
    } catch {
      // Runtime registration mutation or corruption is a closed mismatch, never an unchecked throw.
    }
    const code =
      (this.registration.seal_policy !== undefined &&
        this.registration.seal_policy.correction_limit !== null &&
        context.sealCorrectionLimit === undefined) ||
      (context.sealCorrectionLimit !== undefined &&
        context.sealCorrectionLimit !== this.registration.seal_policy?.correction_limit) ||
      binding.registration_name !== this.registration.name ||
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
        active_contract_sha256: activeContractSha256 ?? null,
        active_registration_sha256: activeRegistrationSha256 ?? null,
        checkpoint_contract_sha256: binding?.contract_sha256 ?? null,
        checkpoint_registration_sha256: binding?.registration_sha256 ?? null,
      },
      artifacts: [],
      unresolved: ["The checkpoint is bound to a different registration contract."],
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

  private recover(identity: RunIdentity, dispatch: ArtifactDispatchStateV1): Directive {
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
      const legacyReason = "active legacy run has no durable liveness policy; recovery is paused";
      return this.pausedDirective({
        identity: context.identity,
        status: context.status,
        stateId: context.stateId,
        code: dispatch.code === "DISPATCH_ACTIVE" ? "LEGACY_UNMETERED" : dispatch.code,
        reason: dispatch.dispatch_allowed ? legacyReason : dispatch.reason,
        recoveryReason: legacyReason,
        recoveryIneligibilityCode: "LEGACY_UNMETERED",
        dispatch,
        recoveryKind: "saved_but_ineligible",
        checkpointExists: true,
      });
    }
    if (
      context.pendingDirective?.action === "await_user" &&
      context.pendingDirective.child_workflow !== undefined
    )
      return this.currentDirective(context);
    const interruptionReason = this.liveness.recoverOpenWorkers(context.identity.run_id);
    if (interruptionReason !== null) return this.exhaust(identity, interruptionReason);
    this.bindLivenessIfRequired(context);
    if (hasHostContinuation(this.playbook) && this.playbook.needsHostContinuation(context)) {
      return this.advanceHost(context);
    }
    const beforeRebind = canonicalJson(context.snapshot());
    const recovered = this.currentDirective(context);
    if (context.terminalDirective !== null) {
      const terminal = this.admitTerminal(context, recovered);
      this.checkpointer.saveRun(context, "recovery_terminalized", {
        ...metadata(context.identity),
        state_id: context.stateId,
        next_action: terminal.action,
      });
      return terminal;
    }
    if (canonicalJson(context.snapshot()) !== beforeRebind) {
      this.checkpointer.saveRun(context, "recovery_rebound", {
        ...metadata(context.identity),
        state_id: context.stateId,
        next_action: recovered.action,
      });
    }
    return recovered;
  }

  private pausedDirectiveForContext(
    context: RunContext,
    dispatch: ArtifactDispatchStateV1
  ): Directive {
    if (context.terminalDirective !== null) return this.currentDirective(context);
    if (context.stateId === "intake") {
      return this.pausedDirective({
        identity: context.identity,
        status: context.status,
        stateId: context.stateId,
        code: dispatch.code === "DISPATCH_ACTIVE" ? "DISPATCH_PAUSED" : dispatch.code,
        reason: dispatch.reason,
        dispatch,
        recoveryKind: "start_retry",
        checkpointExists: true,
      });
    }
    if (this.requiresLivenessPolicy(context) && !this.liveness.hasPolicy(context.identity.run_id)) {
      const legacyReason = "active legacy run has no durable liveness policy; recovery is paused";
      return this.pausedDirective({
        identity: context.identity,
        status: context.status,
        stateId: context.stateId,
        code: dispatch.code === "DISPATCH_ACTIVE" ? "LEGACY_UNMETERED" : dispatch.code,
        reason: dispatch.dispatch_allowed ? legacyReason : dispatch.reason,
        recoveryReason: legacyReason,
        recoveryIneligibilityCode: "LEGACY_UNMETERED",
        dispatch,
        recoveryKind: "saved_but_ineligible",
        checkpointExists: true,
      });
    }
    if (
      context.pendingDirective === null &&
      !(hasHostContinuation(this.playbook) && this.playbook.needsHostContinuation(context))
    ) {
      return this.pausedDirective({
        identity: context.identity,
        status: context.status,
        stateId: context.stateId,
        code: dispatch.code === "DISPATCH_ACTIVE" ? "DISPATCH_PAUSED" : dispatch.code,
        reason: dispatch.reason,
        recoveryReason:
          "saved run has no pending or host-continuation directive; recovery is not supported",
        recoveryIneligibilityCode: "CHECKPOINT_NOT_RESUMABLE",
        dispatch,
        recoveryKind: "saved_but_ineligible",
        checkpointExists: true,
      });
    }
    return this.pausedDirective({
      identity: context.identity,
      status: context.status,
      stateId: context.stateId,
      code: dispatch.code === "DISPATCH_ACTIVE" ? "DISPATCH_PAUSED" : dispatch.code,
      reason: dispatch.reason,
      dispatch,
      recoveryKind: "recoverable_checkpoint",
      checkpointExists: true,
    });
  }

  private pausedDirective(
    input: {
      readonly identity: RunIdentity;
      readonly status: RunContext["status"];
      readonly stateId: string;
      readonly code: ArtifactDispatchPauseCode;
      readonly reason: string;
      readonly recoveryReason?: string;
      readonly dispatch: ArtifactDispatchStateV1;
      readonly checkpointExists: boolean;
    } & (
      | {
          readonly recoveryKind: "recoverable_checkpoint" | "start_retry";
          readonly recoveryIneligibilityCode?: never;
        }
      | {
          readonly recoveryKind: "saved_but_ineligible";
          readonly recoveryIneligibilityCode: ArtifactDispatchIneligibilityCode;
        }
    )
  ): Directive {
    const recovery =
      input.recoveryKind === "saved_but_ineligible"
        ? artifactDispatchRecoveryV1({
            identity: input.identity,
            stateId: input.stateId,
            reason: input.recoveryReason ?? input.reason,
            kind: input.recoveryKind,
            checkpointExists: input.checkpointExists,
            ineligibilityCode: input.recoveryIneligibilityCode,
          })
        : artifactDispatchRecoveryV1({
            identity: input.identity,
            stateId: input.stateId,
            reason: input.recoveryReason ?? input.reason,
            kind: input.recoveryKind,
            checkpointExists: input.checkpointExists,
          });
    return directive({
      schema_version: 2,
      pause_schema_version: 1,
      action: "paused",
      identity: input.identity,
      status: input.status,
      state_id: input.stateId,
      code: input.code,
      reason: input.reason,
      retryable: recovery.kind !== "saved_but_ineligible",
      dispatch: input.dispatch,
      recovery,
    });
  }

  private admitTerminal(
    context: RunContext,
    next: Directive,
    pendingPhaseResult?: PhaseResult
  ): Directive {
    if (
      this.registration.worker.kind === "none" &&
      (next.action === "invoke_agent" || next.action === "invoke_agents_parallel")
    ) {
      throw new Error(
        `deterministic registration '${this.registration.name}' cannot emit worker directives`
      );
    }
    this.playbook.bindDispatch?.(context, next);
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
      verifyExecutionReceipt: (receipt) => this.receiptAuthority.verify(receipt),
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
    // Host-owned projected gates are not playbook state and must survive rebind/restart byte-for-byte.
    if (
      context.pendingDirective.action === "await_user" &&
      context.pendingDirective.child_workflow !== undefined
    ) {
      const gate = context.pendingDirective;
      if (gate.child_workflow?.schema_version !== 2)
        throw new Error("unsupported projected child gate version");
      const record = this.checkpointer.childWorkflowCall(gate.child_workflow.call_id);
      const childGate =
        record === undefined
          ? undefined
          : this.checkpointer.loadRun(record.child_identity).pendingDirective;
      if (
        record === undefined ||
        record.lifecycle !== "waiting_user" ||
        childGate?.action !== "await_user" ||
        canonicalJson(projectChildGate(record, childGate)) !== canonicalJson(gate)
      )
        throw new Error("projected child wait lost its durable call or exact gate");
      return gate;
    }
    // Re-bind the output artifact spec to the current ledger top so a directive
    // saved across a crash window is never replayed with a stale version.
    const rebound = this.playbook.rebindPendingDirective(context);
    if (rebound === null) {
      throw new Error(`checkpoint '${context.identity.run_id}' has no recoverable directive`);
    }
    context.pendingDirective = rebound;
    this.playbook.bindDispatch?.(context, rebound);
    return rebound;
  }
}
