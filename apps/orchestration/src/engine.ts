import path from "node:path";

import type { ArtifactRevisionLookup } from "./artifact-store.js";
import {
  Checkpointer,
  CheckpointIdentityError,
  ReceiptConflictError,
  canonicalJson,
  sha256,
  type ReserveOperationEventGroupInput,
} from "./checkpointer.js";
import { readRunInput, settleRunInput } from "./private-inputs.js";
import { RunContext } from "./context.js";
import {
  OperationReceiptStore,
  externalOperationSourceIdentity,
  promotionApplyOperationSourceIdentity,
  promotionDecisionOperationSourceIdentity,
  replayableResultFromRun,
} from "./kb/operation-receipts.js";
import type { OperationEventGroup } from "./kb/contracts.js";
import {
  ContractValidationError,
  OrchestrationRequestSchema,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type JsonValue,
  type PhaseResult,
  type EvaluationResult,
  isTerminalStatus,
  type RunIdentity,
  type SkillContract,
  validateContract,
  validateDirective,
} from "./contracts.js";
import {
  evaluateCompletionGate,
  hasFanAggregate,
  hasMalformedReissue,
  type PlaybookV1,
} from "./playbooks/playbook.js";
import {
  isRegisteredPlaybook,
  PLAYBOOK_REGISTRY,
  resolvePlaybook,
  SOLE_PRODUCTION_PLAYBOOK,
  validateRegistrationContract,
  type PlaybookRegistryV1,
} from "./playbooks/registry.js";
import { ReceiptAuthority, trustedInvocationDigest } from "./receipts.js";

interface ApprovedPromotionCompletionCapability {
  completeApprovedPromotion(
    run: RunContext,
    outcome: {
      status: "complete" | "failed" | "blocked_external_drift";
      receiptId: string;
      receiptSha256: string;
      transactionId: string;
      targetCount: number;
      postApplyVerified: boolean;
    }
  ): Directive;
}

interface ReviewInvalidationCapability {
  invalidateReview(run: RunContext, reason: string): Directive;
}

function hasApprovedPromotionCompletion(
  playbook: PlaybookV1
): playbook is PlaybookV1 & ApprovedPromotionCompletionCapability {
  return (
    "completeApprovedPromotion" in playbook &&
    typeof playbook.completeApprovedPromotion === "function"
  );
}

function hasReviewInvalidation(
  playbook: PlaybookV1
): playbook is PlaybookV1 & ReviewInvalidationCapability {
  return "invalidateReview" in playbook && typeof playbook.invalidateReview === "function";
}

function isOperationEventAction(value: string): value is ReserveOperationEventGroupInput["action"] {
  return (
    value === "init" ||
    value === "ingest" ||
    value === "query" ||
    value === "save" ||
    value === "lint" ||
    value === "promote"
  );
}

export interface EngineOptions {
  readonly projectRoot: string;
  readonly maxSteps: number;
  readonly dispatchMode?: () => string | undefined;
  readonly receiptAuthority?: ReceiptAuthority;
  readonly receiptKeyPath?: string;
  /** Immutable artifact-manifest ledger used to resolve output revision chains. */
  readonly artifactRevisions?: ArtifactRevisionLookup;
  /**
   * Playbook registry override. Production uses the shipped single-entry registry;
   * tests inject a double to prove multi-playbook dispatch without activating a skill.
   */
  readonly playbookRegistry?: PlaybookRegistryV1;
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

function metadata(identity: RunIdentity): Record<string, JsonValue> {
  return {
    schema_version: identity.schema_version,
    run_id: identity.run_id,
    session_id: identity.session_id,
    playbook: identity.playbook,
    engine_owner: identity.engine_owner,
  };
}

export class OrchestrationEngine {
  // Typed as the capability-probed union, never as a concrete playbook class: the engine
  // must not know which playbook it is driving. See playbooks/playbook.ts (W1).
  private readonly playbook: PlaybookV1;
  private readonly registry: PlaybookRegistryV1;
  /** The active skill contract (W3). Exposed for worker posture resolution (W6). */
  readonly contract: SkillContract;
  private readonly projectRoot: string;
  private readonly maxSteps: number;
  private readonly dispatchMode: () => string | undefined;
  readonly receiptAuthority: ReceiptAuthority;

  constructor(
    private readonly checkpointer: Checkpointer,
    options: EngineOptions
  ) {
    this.checkpointer.bindKbRuntimeProjectRoot(options.projectRoot);
    this.registry = options.playbookRegistry ?? PLAYBOOK_REGISTRY;
    const playbookName = options.playbookName ?? SOLE_PRODUCTION_PLAYBOOK;
    // Construct through the registry. The engine imports no concrete playbook class.
    const registration = resolvePlaybook(playbookName, this.registry);
    if (registration === undefined) {
      throw new Error(`playbook '${playbookName}' is not registered in the supplied registry`);
    }
    // W3: the contract is validated before the playbook is constructed. An invalid
    // contract fails closed -- it is authority metadata, not documentation.
    this.contract = validateRegistrationContract(registration);
    this.playbook = registration.construct({
      ...(options.artifactRevisions ? { artifactRevisions: options.artifactRevisions } : {}),
      checkpointer: this.checkpointer,
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
    this.receiptAuthority =
      options.receiptAuthority ??
      ReceiptAuthority.load(options.receiptKeyPath ?? `${this.checkpointer.dbPath}.receipt-key`);
  }

  handle(value: unknown): Directive {
    const request = validateContract(OrchestrationRequestSchema, value, "orchestration request");
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
          if (admitted.terminalDirective !== null) {
            return admitted.terminalDirective;
          }
          if (admitted.stateId !== "intake") {
            // Frozen run contract (research parity): a start of a run that is
            // already advancing is an identity violation — the host resumes it
            // through `step`/`recover`, never by starting it again.
            throw new CheckpointIdentityError(
              `run '${request.identity.run_id}' is in state '${admitted.stateId}'; it cannot be started again`
            );
          }
          const next = this.playbook.initialize(admitted);
          this.checkpointer.saveRun(admitted, "run_admitted", {
            ...metadata(request.identity),
            state_id: admitted.stateId,
          });
          return next;
        }
        const initialArtifacts = request.input_artifacts;
        const context = RunContext.create({
          identity: request.identity,
          goal: request.goal,
          constraints: request.constraints,
          projectRoot: this.projectRoot,
          trustProfile: request.trust_profile,
          maxSteps: this.maxSteps,
          ...(initialArtifacts
            ? { initialArtifacts: initialArtifacts.artifacts.map((binding) => binding.ref) }
            : {}),
        });
        const operationGroup = this.externalStartOperationGroup(context);
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
          const next = this.playbook.initialize(context);
          this.checkpointer.saveRun(context, "run_admitted", {
            ...metadata(request.identity),
            state_id: context.stateId,
          });
          return next;
        }
        const next = this.playbook.initialize(context);
        this.checkpointer.createRun(context, "run_started", {
          ...metadata(request.identity),
          goal_sha256: sha256(request.goal),
          goal_bytes: Buffer.byteLength(request.goal, "utf8"),
          state_id: context.stateId,
        });
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
        if (context.identity.playbook === "knowledge-base") {
          const kbAction = String(context.knowledgeBaseData.action ?? "");
          if (kbAction === "ingest" || kbAction === "save" || kbAction === "promote") {
            throw new Error(
              "KB content/promotion review is host-only through the authenticated host callback service; generic respond is decision-free for this run"
            );
          }
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
        const next = this.playbook.resume(context, request.response);
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
        if (context.terminalDirective !== null) {
          return context.terminalDirective;
        }
        const reason = request.reason ?? "cancelled by caller";
        const next = this.playbook.cancel(context, reason);
        this.checkpointer.saveRun(context, "run_cancelled", {
          ...metadata(request.identity),
          reason_sha256: sha256(reason),
        });
        return next;
      }
    }
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
    const pending = context?.pendingDirective;
    if (
      context === undefined ||
      context.identity.playbook !== "knowledge-base" ||
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
    const next = this.playbook.resume(context, review.decision_receipt.decision);
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
    const packetSha256 =
      input.packetSha256 ??
      (context?.identity.playbook === "knowledge-base"
        ? String(context.knowledgeBaseData.promotion_packet_sha256 ?? "")
        : "");
    if (
      context === undefined ||
      context.identity.playbook !== "knowledge-base" ||
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
    if (context === undefined || context.identity.playbook !== "knowledge-base") {
      throw new Error(`unknown KB promotion run '${input.runId}'`);
    }
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
      if (!hasApprovedPromotionCompletion(this.playbook)) {
        throw new Error("the active KB playbook cannot finalize an approved promotion");
      }
      next = this.playbook.completeApprovedPromotion(context, input);
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
    if (context === undefined || context.identity.playbook !== "knowledge-base") {
      throw new Error(`unknown KB content-review run '${input.runId}'`);
    }
    if (!hasReviewInvalidation(this.playbook)) {
      throw new Error("the active KB playbook cannot invalidate content review");
    }
    const next = this.playbook.invalidateReview(context, input.reason);
    this.checkpointer.invalidateContentReview({
      context,
      ...(input.receiptSha256 !== undefined ? { receiptSha256: input.receiptSha256 } : {}),
      reason: input.reason,
      state: input.state,
    });
    return next;
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
      return this.currentDirective(recovered);
    }

    const context = this.checkpointer.loadRun(identity);
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
    let next: Directive;
    let branchId = "";
    if (pending.action === "invoke_agent") {
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
        this.playbook.validateDetails(context.stateId, result.details);
      } catch (error) {
        if (error instanceof ContractValidationError) {
          return this.reissueMalformed(context, result, branchId, error);
        }
        throw error;
      }
      next = this.playbook.acceptSummary(context, result.details, result.confidence);
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
        details = this.playbook.validateDetails(assignment.state_id, result.details);
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
        next = directive({
          ...pending,
          branches: pending.branches.filter((candidate) => incomplete.has(candidate.branch_id)),
        });
        context.pendingDirective = next;
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
        next = this.playbook.acceptSummary(context, aggregate, weakestConfidence(confidences));
      }
    } else {
      throw new Error(`run '${identity.run_id}' is not awaiting an agent result`);
    }

    // W7: the engine, not the playbook, admits a met terminal.
    this.admitTerminal(context, next);

    this.checkpointer.saveWithReceipt(context, result, branchId, "phase_result_accepted", {
      ...metadata(identity),
      state_id: result.state_id,
      agent: result.agent,
      attempt: result.attempt,
      branch_id: branchId,
      receipt_id: result.worker_receipt.receipt_id,
      output_digest: result.worker_receipt.output_digest,
      next_action: next.action,
    });
    return next;
  }

  private reissueMalformed(
    context: RunContext,
    result: PhaseResult,
    branchId: string,
    error: ContractValidationError
  ): Directive {
    const pending = context.pendingDirective;
    // W5: a malformed worker result is a typed feedback kind, not an ad-hoc branch.
    // The engine records the classification and routes on it.
    const evaluation: EvaluationResult = {
      schema_version: 1,
      kind: "malformed_result",
      detail: error.message,
      ...(branchId.length > 0 ? { target_state: result.state_id } : {}),
      exhausted: false,
    };
    const reissueCurrent = (): Directive => {
      context.reissueCurrent();
      return this.playbook.dispatch(context);
    };
    const next =
      evaluation.kind === "malformed_result" &&
      pending?.action === "invoke_agents_parallel" &&
      branchId.length > 0 &&
      hasMalformedReissue(this.playbook)
        ? this.playbook.reissueMalformedBranch(context, pending, branchId)
        : // Without the capability, fall back to reissuing the current state -- the same
          // path already used for non-branch results.
          reissueCurrent();
    this.checkpointer.saveWithReceipt(context, result, branchId, "phase_result_malformed", {
      ...metadata(context.identity),
      state_id: result.state_id,
      agent: result.agent,
      attempt: result.attempt,
      branch_id: branchId,
      feedback_kind: evaluation.kind,
      receipt_id: result.worker_receipt.receipt_id,
      error_sha256: sha256(error.message),
      next_action: next.action,
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
    branchId: string | null
  ): void {
    const artifact = result.output_artifact;
    if (artifact === undefined) {
      throw new Error("phase result is missing the owner output artifact ref");
    }
    const comparisons: Array<[string, unknown, unknown]> = [
      ["run_id", expected.run_id, artifact.run_id],
      ["phase", expected.phase, artifact.phase],
      ["branch_id", branchId, artifact.branch_id],
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

  private status(identity: RunIdentity): Directive {
    const context = this.checkpointer.loadRun(identity);
    if (context.terminalDirective !== null) {
      return context.terminalDirective;
    }
    return directive({
      schema_version: 2,
      action: "status",
      identity: context.identity,
      status: context.status,
      state_id: context.stateId,
      terminal: false,
      met: context.met,
    });
  }

  private recover(identity: RunIdentity): Directive {
    const context = this.checkpointer.loadRun(identity);
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
    return this.currentDirective(context);
  }

  private externalStartOperationGroup(
    context: RunContext
  ): ReserveOperationEventGroupInput | undefined {
    if (context.identity.playbook !== "knowledge-base") return undefined;
    const raw = context.constraints.operation_event_group;
    if (raw === undefined) return undefined;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("KB operation_event_group metadata must be an object");
    }
    const record = raw;
    const keys = Object.keys(record).sort();
    if (
      canonicalJson(keys) !== canonicalJson(["invocation_id", "request_sha256", "transaction_id"])
    ) {
      throw new Error("KB operation_event_group metadata has unknown or missing fields");
    }
    const invocationId = String(record.invocation_id ?? "");
    const requestSha256 = String(record.request_sha256 ?? "");
    const transactionId = String(record.transaction_id ?? "");
    const action = String(context.constraints.action ?? "");
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(invocationId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(transactionId) ||
      !/^[a-f0-9]{64}$/.test(requestSha256) ||
      !isOperationEventAction(action)
    ) {
      throw new Error("KB operation_event_group metadata is invalid");
    }
    return {
      run_id: context.identity.run_id,
      session_id: context.identity.session_id,
      transaction_id: transactionId,
      action,
      source_kind: "external_start",
      source_identity_sha256: externalOperationSourceIdentity({
        session_id: context.identity.session_id,
        invocation_id: invocationId,
        action,
        request_sha256: requestSha256,
      }),
    };
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
    code: "DISPATCH_PAUSED" | "DISPATCH_MODE_INVALID",
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

  /**
   * W7 — evaluate the active skill's completion gate before a `met: true` terminal is
   * accepted. Non-met terminals pass through untouched: an honest incomplete or cancelled
   * outcome must stay reachable.
   */
  private admitTerminal(context: RunContext, next: Directive): void {
    if (
      next.action !== "complete" &&
      next.action !== "incomplete" &&
      next.action !== "error" &&
      next.action !== "cancelled"
    ) {
      return;
    }
    if (next.met !== true || !isTerminalStatus(next.status)) return;
    const refusal = evaluateCompletionGate({
      gate: this.contract.completion_gate,
      terminalStatus: next.status,
      met: true,
      fromState: context.previousState,
      unresolvedCount: next.unresolved.length,
    });
    if (refusal !== null) {
      throw new Error(`playbook '${context.identity.playbook}': ${refusal}`);
    }
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
