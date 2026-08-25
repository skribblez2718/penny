import type { Checkpointer } from "../checkpointer.js";
import { canonicalJson, sha256 } from "../checkpointer.js";
import type { Directive } from "../contracts.js";
import { validateDirective } from "../contracts.js";
import { RunContext } from "../context.js";
import { materializeRunInput, settleRunInput } from "../private-inputs.js";
import type {
  OperationAction,
  OperationEventGroup,
  ReplayableKnowledgeBaseResult,
} from "./contracts.js";
import {
  OperationReceiptStore,
  externalOperationSourceIdentity,
  replayableResultFromRun,
  toReplayableKnowledgeBaseResult,
  type OperationCompletion,
  type SelectorCommitEvidence,
} from "./operation-receipts.js";

type StartAction = Exclude<OperationAction, "resume">;

export interface AdmittedOperationStart {
  readonly run_id: string;
  readonly request_sha256: string;
  readonly transaction_id: string;
  readonly group: OperationEventGroup;
  readonly replay?: OperationCompletion;
  readonly recovered_result?: ReplayableKnowledgeBaseResult;
}

/**
 * Admit one external KB start without putting its request body in control state.
 *
 * The checkpointer transaction creates the run, idempotency row, private-input
 * index, and one globally de-duplicated operation group. Only after that commit
 * are the exact request bytes materialized. A duplicate committed/preparing
 * group replays stored bytes; a crash after the run advanced but before receipt
 * preparation is projected from that durable run and is never started again.
 */
export function admitOperationStart(input: {
  projectRoot: string;
  checkpointer: Checkpointer;
  context: RunContext;
  session_id: string;
  invocation_id: string;
  action: StartAction;
  profile_id: string;
  request: unknown;
}): AdmittedOperationStart {
  const requestSha256 = sha256(canonicalJson(input.request));
  const sourceIdentity = externalOperationSourceIdentity({
    session_id: input.session_id,
    invocation_id: input.invocation_id,
    action: input.action,
    request_sha256: requestSha256,
  });
  const transactionId = `tx_start_${sourceIdentity.slice(0, 24)}`;
  const admission = input.checkpointer.admitStartRun(input.context, {
    session_id: input.session_id,
    invocation_id: input.invocation_id,
    request_sha256: requestSha256,
    action: input.action,
    profile_id: input.profile_id,
    transaction_id: transactionId,
    private_input_id: `pri_${sourceIdentity.slice(0, 24)}`,
    storage_key: `${input.context.identity.run_id}/request.json`,
    temporary_storage_key: `${input.context.identity.run_id}/.${transactionId}.tmp`,
  });
  const runId = admission.run_id;
  const group = input.checkpointer.operationEventGroupBySource("external_start", sourceIdentity);
  if (group === undefined || group.run_id !== runId) {
    throw new Error("KB start admission lost its exact operation event group");
  }
  const store = new OperationReceiptStore({
    projectRoot: input.projectRoot,
    checkpointer: input.checkpointer,
  });
  if (group.state !== "reserved") {
    return {
      run_id: runId,
      request_sha256: requestSha256,
      transaction_id: group.transaction_id,
      group,
      replay: store.finish(group.request_event_group_id),
    };
  }
  const durable = input.checkpointer.loadRunById(runId);
  if (durable === undefined) throw new Error("KB start admission lost its durable run");
  if (durable.stateId !== "intake" || durable.terminalDirective !== null) {
    return {
      run_id: runId,
      request_sha256: requestSha256,
      transaction_id: group.transaction_id,
      group,
      recovered_result: replayableResultFromRun({
        action: input.action,
        run: durable,
        checkpointer: input.checkpointer,
      }),
    };
  }
  materializeRunInput({
    projectRoot: input.projectRoot,
    checkpointer: input.checkpointer,
    runId,
    request: input.request,
    requestSha256,
  });
  return {
    run_id: runId,
    request_sha256: requestSha256,
    transaction_id: group.transaction_id,
    group,
  };
}

/** Persist a body-free terminal directive for deterministic direct actions. */
export function checkpointDirectOperationResult(input: {
  checkpointer: Checkpointer;
  run_id: string;
  result: unknown;
  kb_id?: string;
  policy_sha256?: string;
}): ReplayableKnowledgeBaseResult {
  const replay = toReplayableKnowledgeBaseResult(input.result);
  const run = input.checkpointer.loadRunById(input.run_id);
  if (run === undefined) throw new Error(`KB direct run '${input.run_id}' is absent`);
  if (replay.action === "status") {
    throw new Error("status is a read-only projection and cannot checkpoint a direct operation");
  }
  if (run.terminalDirective !== null) {
    return replayableResultFromRun({
      action: replay.action,
      run,
      checkpointer: input.checkpointer,
    });
  }
  run.knowledgeBaseData.action = replay.action;
  run.knowledgeBaseData.profile_id = String(run.constraints.kb_profile_id ?? "");
  if (input.kb_id !== undefined) run.knowledgeBaseData.kb_id = input.kb_id;
  if (input.policy_sha256 !== undefined) {
    run.knowledgeBaseData.admitted_policy_sha256 = input.policy_sha256;
  }
  run.knowledgeBaseData.public_status = replay.status;
  const action: Directive["action"] =
    replay.status === "error"
      ? "error"
      : replay.status === "complete" && replay.met
        ? "complete"
        : "incomplete";
  run.previousState = run.stateId;
  run.stateId = action === "complete" ? "complete" : action === "error" ? "error" : "incomplete";
  run.status = action === "complete" ? "complete" : action === "error" ? "error" : "incomplete";
  run.met = replay.met;
  run.pendingDirective = null;
  run.terminalDirective = validateDirective({
    schema_version: 2,
    action,
    identity: run.identity,
    status: run.status,
    met: run.met,
    result: replay,
    // TerminalDirective.artifacts is the generic engine ArtifactRef plane.
    // Direct KB actions return path-free KB handles inside their closed result;
    // an opaque KB artifact id is not a generic ArtifactRef.
    artifacts: [],
    unresolved: replay.unresolved,
  });
  input.checkpointer.saveRun(run, "kb_direct_operation_terminal", {
    run_id: run.identity.run_id,
    action: replay.action,
    public_status: replay.status,
  });
  return replay;
}

/** Finalize one reserved external start and discard terminal request bytes. */
export function completeOperationStart(input: {
  projectRoot: string;
  checkpointer: Checkpointer;
  group_id: string;
  profile_id: string;
  result: unknown;
  input_digests: readonly string[];
  output_refs?: readonly string[];
  kb_id?: string;
  base_generation_id?: string;
  candidate_generation_id?: string;
  policy_sha256?: string;
  safe_metrics?: Readonly<Record<string, number>>;
  selector_evidence?: SelectorCommitEvidence;
}): OperationCompletion {
  const completion = new OperationReceiptStore({
    projectRoot: input.projectRoot,
    checkpointer: input.checkpointer,
  }).complete({
    request_event_group_id: input.group_id,
    kb_profile_id: input.profile_id,
    result: input.result,
    input_digests: input.input_digests,
    ...(input.output_refs !== undefined ? { output_refs: input.output_refs } : {}),
    ...(input.kb_id !== undefined ? { kb_id: input.kb_id } : {}),
    ...(input.base_generation_id !== undefined
      ? { base_generation_id: input.base_generation_id }
      : {}),
    ...(input.candidate_generation_id !== undefined
      ? { candidate_generation_id: input.candidate_generation_id }
      : {}),
    ...(input.policy_sha256 !== undefined ? { policy_sha256: input.policy_sha256 } : {}),
    ...(input.safe_metrics !== undefined ? { safe_metrics: input.safe_metrics } : {}),
    ...(input.selector_evidence !== undefined
      ? { selector_evidence: input.selector_evidence }
      : {}),
  });
  if (
    completion.replay_result.status !== "running" &&
    completion.replay_result.status !== "awaiting_user"
  ) {
    settleRunInput({
      projectRoot: input.projectRoot,
      checkpointer: input.checkpointer,
      runId: completion.group.run_id,
    });
  }
  return completion;
}
