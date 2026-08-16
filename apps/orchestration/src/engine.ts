import path from "node:path";

import { Checkpointer, ReceiptConflictError, canonicalJson, sha256 } from "./checkpointer.js";
import { RunContext } from "./context.js";
import {
  DirectiveSchema,
  OrchestrationRequestSchema,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type JsonValue,
  type PhaseResult,
  type RunIdentity,
  validateContract,
} from "./contracts.js";
import { ResearchPlaybook } from "./playbooks/research.js";

export interface EngineOptions {
  readonly projectRoot: string;
  readonly maxSteps: number;
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  CERTAIN: 3,
  PROBABLE: 2,
  POSSIBLE: 1,
  UNCERTAIN: 0,
};

function directive(value: unknown): Directive {
  return validateContract(DirectiveSchema, value, "engine directive");
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
  private readonly playbook = new ResearchPlaybook();
  private readonly projectRoot: string;
  private readonly maxSteps: number;

  constructor(
    private readonly checkpointer: Checkpointer,
    options: EngineOptions
  ) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.maxSteps = options.maxSteps;
  }

  handle(value: unknown): Directive {
    const request = validateContract(OrchestrationRequestSchema, value, "orchestration request");
    switch (request.action) {
      case "start": {
        if (path.resolve(request.project_root) !== this.projectRoot) {
          throw new Error(
            `project_root mismatch: engine owns '${this.projectRoot}', request supplied '${request.project_root}'`
          );
        }
        const context = RunContext.create({
          identity: request.identity,
          goal: request.goal,
          constraints: request.constraints,
          projectRoot: this.projectRoot,
          trustProfile: request.trust_profile,
          maxSteps: this.maxSteps,
        });
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
      this.playbook.validateDetails(context.stateId, result.details);
      this.captureArtifact(context, result.output_artifact);
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
      const details = this.playbook.validateDetails(assignment.state_id, result.details);
      const branch = context.pendingBranches.find((candidate) => candidate.branch_id === branchId);
      if (branch === undefined) {
        throw new Error(`branch '${branchId}' is absent from checkpoint state`);
      }
      if (branch.completed) {
        throw new Error(`duplicate_branch '${branchId}'`);
      }
      const artifact = this.captureArtifact(context, result.output_artifact);
      const branchIndex = context.pendingBranches.indexOf(branch);
      context.pendingBranches[branchIndex] = {
        ...branch,
        completed: true,
        confidence: result.confidence,
        result: details,
        artifact,
      };
      if (context.pendingBranches.some((candidate) => !candidate.completed)) {
        next = pending;
      } else {
        const completed = context.pendingBranches;
        const aggregate = this.playbook.aggregateResearchBranches(
          completed.map((candidate) => candidate.result ?? {})
        );
        const confidences = completed.map((candidate) => candidate.confidence ?? "UNCERTAIN");
        next = this.playbook.acceptSummary(context, aggregate, weakestConfidence(confidences));
      }
    } else {
      throw new Error(`run '${identity.run_id}' is not awaiting an agent result`);
    }

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

  private validateReceiptEnvelope(identity: RunIdentity, result: PhaseResult): void {
    const receipt = result.worker_receipt;
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
    if (context.identity.playbook !== "research") {
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

  private currentDirective(context: RunContext): Directive {
    if (context.terminalDirective !== null) {
      return context.terminalDirective;
    }
    if (context.pendingDirective === null) {
      throw new Error(`checkpoint '${context.identity.run_id}' has no recoverable directive`);
    }
    return context.pendingDirective;
  }
}
