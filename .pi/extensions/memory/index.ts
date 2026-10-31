import { registerTool } from "../../lib/pi-tool-registration.js";
import { fileURLToPath } from "node:url";

/** Exact entry-file identity for trusted host source composition, not a tool policy. */
export const memoryExtensionSource = fileURLToPath(import.meta.url);

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { createLogger, setSessionId } from "../../lib/logger/logger.js";
import { MemoryAdapter } from "./adapter.js";
import {
  AUTO_DIARY_CANDIDATE_CUSTOM_TYPE,
  AUTO_DIARY_EVALUATION_CUSTOM_TYPE,
  AUTO_DIARY_MAX_INPUT_RECEIPTS,
  AUTO_DIARY_PROCESSED_CUSTOM_TYPE,
  AutoDiaryEvaluationError,
  autoDiaryProcessedMarker,
  collectAutoDiaryActivity,
  createAutoDiaryInputReceipt,
  currentAutoDiaryCandidateEntryId,
  currentAutoDiaryProcessedMarkerMatches,
  evaluateAutoDiaryCandidateWithModel,
  latestAutoDiaryUserActivityId,
  prepareAutoDiaryEvaluation,
  resolveAutoDiaryCandidate,
  retainAutoDiaryCandidate,
  stageAutoDiaryCandidate,
  type AutoDiaryEvaluation,
  type AutoDiaryEvaluator,
  type AutoDiaryInputReceipt,
  type AutoDiarySessionReader,
} from "./auto-diary.js";
import { loadMemoryRuntimeConfig, loadWorkerReadConfig, resolveMemoryActor } from "./config.js";
import { MemoryLogstreamAdapter } from "./logstream-adapter.js";
import { MemoryLogstreamClient } from "./logstream-client.js";
import { createPrimaryLogstreamTools } from "./logstream-tools.js";
import { createPrimaryMemoryTools, createUnavailableMemoryTools } from "./tools.js";
import { MemoryError, type MemoryAdapterDependencies, type MemoryTelemetry } from "./types.js";

const logger = createLogger("memory");

interface ActiveAutoDiaryEvaluation {
  evaluation: AutoDiaryEvaluation;
  evaluationEntryId: string;
  latestActivityEntryId: string;
  consumedReceiptCount: number;
  controller: AbortController;
  cancelReason?: "primary_turn" | "shutdown";
  settled?: Promise<void>;
}

interface AutoDiaryEvaluationFailure {
  activityEntryId: string;
  reasonCode: string;
}

type AutoDiaryEvaluationCompletion =
  | { kind: "candidate"; parameters: Awaited<ReturnType<AutoDiaryEvaluator>> }
  | { kind: "error"; error: unknown }
  | { kind: "cancelled" };

function errorCodeFrom(value: unknown, fallback: string): string {
  return typeof value === "object" && value !== null && "code" in value
    ? String(value.code)
    : fallback;
}

function currentEvaluationEntryId(reader: AutoDiarySessionReader): string | null {
  const leaf = reader.getLeafEntry();
  return leaf?.type === "custom" &&
    leaf.customType === AUTO_DIARY_EVALUATION_CUSTOM_TYPE &&
    typeof leaf.id === "string" &&
    leaf.id.length > 0 &&
    leaf.id.length <= 256
    ? leaf.id
    : null;
}

async function evaluateUntilCancelled(
  evaluator: AutoDiaryEvaluator,
  active: ActiveAutoDiaryEvaluation,
  reader: AutoDiarySessionReader,
  context: ExtensionContext
): Promise<AutoDiaryEvaluationCompletion> {
  const completed = evaluator(active.evaluation, reader, context, active.controller.signal).then(
    (parameters): AutoDiaryEvaluationCompletion => ({ kind: "candidate", parameters }),
    (error: unknown): AutoDiaryEvaluationCompletion => ({ kind: "error", error })
  );
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<AutoDiaryEvaluationCompletion>((resolve) => {
    onAbort = () => resolve({ kind: "cancelled" });
    active.controller.signal.addEventListener("abort", onAbort, { once: true });
    if (active.controller.signal.aborted) onAbort();
  });

  try {
    const result = await Promise.race([completed, interrupted]);
    return active.controller.signal.aborted ? { kind: "cancelled" } : result;
  } finally {
    if (onAbort !== undefined) active.controller.signal.removeEventListener("abort", onAbort);
  }
}

export interface MemoryExtensionOptions extends MemoryAdapterDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  telemetry?: MemoryTelemetry;
  autoDiaryEvaluator?: AutoDiaryEvaluator;
}

export function createMemoryExtension(options: MemoryExtensionOptions = {}) {
  return function memoryExtension(pi: ExtensionAPI): void {
    const env = options.env ?? process.env;
    const runtimeTelemetry: MemoryTelemetry = options.telemetry ?? {
      info(event, context) {
        logger.info(event, context);
      },
      warn(event, context) {
        logger.warn(event, context);
      },
    };

    // Runtime markers are deny-only. Resolve role before any config, network,
    // tool registration, or lifecycle hook so workers cannot turn a marker into
    // a grant and do not contact the memory plane at all.
    const actor = resolveMemoryActor(env);
    if (actor === "denied") return;

    // Worker agents receive only owner-granted, bounded read tools. They never
    // receive automatic-memory tools, messages, writes, or lifecycle hooks.
    if (actor === "worker-read") {
      let workerConfig;
      try {
        workerConfig = loadWorkerReadConfig(env);
      } catch (error) {
        const errorCode = errorCodeFrom(error, "MEMPALACE_CONFIG_INVALID");
        logger.warn("Memory worker-read unavailable: invalid configuration", { errorCode });
        for (const tool of createUnavailableMemoryTools({
          writeEnabled: false,
          code: errorCode,
        })) {
          registerTool(pi, tool);
        }
        return;
      }
      if (workerConfig.mode === "disabled") {
        for (const tool of createUnavailableMemoryTools({ writeEnabled: false })) {
          registerTool(pi, tool);
        }
        return;
      }

      const workerAdapter = new MemoryAdapter(workerConfig, options);
      for (const tool of createPrimaryMemoryTools({
        adapter: workerAdapter,
        callerId: () => "worker-read",
        writeEnabled: false,
        telemetry: runtimeTelemetry,
      })) {
        registerTool(pi, tool);
      }
      return;
    }

    let config;
    try {
      config = loadMemoryRuntimeConfig(env);
    } catch (error) {
      // Durable recall is optional and authority-neutral. Invalid hub policy
      // fails closed without preventing memory-absent workflows from starting.
      logger.warn("Memory extension disabled: invalid hub configuration", {
        errorCode: errorCodeFrom(error, "MEMPALACE_CONFIG_INVALID"),
      });
      return;
    }
    if (config.mode === "disabled") return;

    const adapter = new MemoryAdapter(config, options);
    const autoDiaryEvaluator = options.autoDiaryEvaluator ?? evaluateAutoDiaryCandidateWithModel;
    let currentSessionId = "";
    let lastEvaluatedActivityEntryId: string | null = null;
    let inputReceipts: AutoDiaryInputReceipt[] = [];
    let activeEvaluation: ActiveAutoDiaryEvaluation | undefined;
    let evaluationFailure: AutoDiaryEvaluationFailure | undefined;
    let authorizedCandidate: { candidateEntryId: string; evaluationId: string } | undefined;
    let shuttingDown = false;
    let cancelAutoDiaryEvaluation:
      | ((reason: "primary_turn" | "shutdown") => Promise<void>)
      | undefined;
    const diarySessions = new Set<string>();
    const callerId = () => `primary:${currentSessionId || "unbound"}`;

    const reportTrigger = (
      level: "info" | "warn",
      disposition: "scheduled" | "skipped" | "failed",
      reasonCode: string,
      metadata: Record<string, unknown> = {}
    ): void => {
      runtimeTelemetry[level]("primary_auto_diary_trigger", {
        sessionId: currentSessionId || "unbound",
        mode: config.autoDiary.mode,
        disposition,
        reasonCode,
        ...metadata,
      });
    };

    const reportEvaluation = (
      level: "info" | "warn",
      disposition: "retain" | "skip" | "uncertain" | "failed",
      reasonCode: string,
      metadata: Record<string, unknown> = {}
    ): void => {
      runtimeTelemetry[level]("primary_auto_diary_evaluation", {
        sessionId: currentSessionId || "unbound",
        mode: config.autoDiary.mode,
        disposition,
        reasonCode,
        ...metadata,
      });
    };

    for (const tool of createPrimaryMemoryTools({
      adapter,
      callerId,
      writeEnabled: config.writeEnabled,
      telemetry: runtimeTelemetry,
    })) {
      registerTool(pi, tool);
    }

    if (config.logstream.mode === "primary-advisory") {
      const logstreamClient = new MemoryLogstreamClient(config, options);
      const logstreamAdapter = new MemoryLogstreamAdapter(config, adapter, logstreamClient);
      for (const tool of createPrimaryLogstreamTools({
        adapter: logstreamAdapter,
        callerId,
        rooms: config.logstream.rooms,
        writeEnabled: config.writeEnabled,
        telemetry: runtimeTelemetry,
      })) {
        registerTool(pi, tool);
      }
    }

    // Pi's primary active-tool set is session-global and sendMessage() is fire-and-forget.
    // Narrowing it around an automatic follow-up can capture a queued user/extension turn or
    // strand the narrowed set after an asynchronous scheduling error. Keep the evaluation off
    // the primary agent loop instead: ModelRegistry.complete receives one explicit tool schema
    // and never executes a tool or inserts its response into the primary transcript.
    const autoDiaryCanEvaluate =
      config.autoDiary.mode === "observe-only" ||
      (config.autoDiary.mode === "retain" && config.writeEnabled);

    pi.on("session_start", async (_event: SessionStartEvent, context: ExtensionContext) => {
      currentSessionId = context.sessionManager.getSessionId();
      setSessionId(currentSessionId);
      lastEvaluatedActivityEntryId = autoDiaryCanEvaluate
        ? latestAutoDiaryUserActivityId(context.sessionManager)
        : null;
      inputReceipts = [];
      activeEvaluation = undefined;
      evaluationFailure = undefined;
      authorizedCandidate = undefined;
      shuttingDown = false;
    });

    if (autoDiaryCanEvaluate) {
      cancelAutoDiaryEvaluation = async (reason: "primary_turn" | "shutdown"): Promise<void> => {
        const active = activeEvaluation;
        if (active === undefined) return;
        active.cancelReason ??= reason;
        active.controller.abort();
        if (active.settled !== undefined) await active.settled;
      };

      const runEvaluation = async (
        active: ActiveAutoDiaryEvaluation,
        context: ExtensionContext
      ): Promise<void> => {
        const fail = (reasonCode: string, error?: unknown): void => {
          evaluationFailure = {
            activityEntryId: active.latestActivityEntryId,
            reasonCode,
          };
          reportEvaluation("warn", "failed", reasonCode, {
            sourceCount: active.evaluation.sources.length,
            retentionAdmission: active.evaluation.retentionAdmission,
            ...(error === undefined
              ? {}
              : { errorCode: errorCodeFrom(error, "MEMPALACE_UNAVAILABLE") }),
          });
        };

        try {
          const completion = await evaluateUntilCancelled(
            autoDiaryEvaluator,
            active,
            context.sessionManager,
            context
          );
          if (completion.kind === "cancelled") {
            fail(
              active.cancelReason === "shutdown"
                ? "shutdown_before_model_disposition"
                : "evaluation_cancelled_for_primary_turn"
            );
            return;
          }
          if (completion.kind === "error") {
            const reasonCode =
              completion.error instanceof AutoDiaryEvaluationError
                ? completion.error.reasonCode
                : "evaluation_schedule_failed";
            fail(reasonCode, completion.error);
            if (reasonCode === "evaluation_schedule_failed") {
              reportTrigger("warn", "failed", reasonCode, {
                errorCode: errorCodeFrom(completion.error, "MEMPALACE_UNAVAILABLE"),
              });
            }
            return;
          }
          if (activeEvaluation !== active || active.controller.signal.aborted || shuttingDown) {
            fail("evaluation_cancelled_before_staging");
            return;
          }

          try {
            const candidate = stageAutoDiaryCandidate(
              completion.parameters,
              active.evaluation,
              active.evaluationEntryId,
              context.sessionManager
            );
            pi.appendEntry(AUTO_DIARY_CANDIDATE_CUSTOM_TYPE, candidate);
            const candidateEntryId = currentAutoDiaryCandidateEntryId(
              context.sessionManager,
              candidate
            );
            if (candidateEntryId === null) {
              throw new MemoryError(
                "MEMPALACE_INTEGRITY",
                "Automatic diary candidate was not retained as the current session leaf"
              );
            }
            authorizedCandidate = {
              candidateEntryId,
              evaluationId: candidate.evaluationId,
            };
            evaluationFailure = undefined;

            const coercedForPrivacy =
              completion.parameters.disposition === "retain" &&
              candidate.disposition === "uncertain";
            reportEvaluation(
              "info",
              candidate.disposition,
              coercedForPrivacy
                ? "retain_denied_privacy_ambiguity"
                : `candidate_${candidate.disposition}`,
              {
                sourceCount: candidate.sources.length,
                retentionAdmission: active.evaluation.retentionAdmission,
              }
            );
          } catch (error) {
            authorizedCandidate = undefined;
            fail("candidate_stage_failed", error);
          }
        } finally {
          lastEvaluatedActivityEntryId = active.latestActivityEntryId;
          inputReceipts = inputReceipts.slice(active.consumedReceiptCount);
          if (activeEvaluation === active) activeEvaluation = undefined;
        }
      };

      const cancelBeforePrimaryTurn = async (): Promise<void> => {
        await cancelAutoDiaryEvaluation?.("primary_turn");
      };
      pi.on("before_agent_start", cancelBeforePrimaryTurn);
      pi.on("agent_start", cancelBeforePrimaryTurn);

      pi.on("input", (event) => {
        inputReceipts.push(
          createAutoDiaryInputReceipt(event.text, event.source, (event.images?.length ?? 0) > 0)
        );
        if (inputReceipts.length > AUTO_DIARY_MAX_INPUT_RECEIPTS) {
          inputReceipts = inputReceipts.slice(-AUTO_DIARY_MAX_INPUT_RECEIPTS);
        }
      });

      pi.on("agent_settled", async (_event, context) => {
        if (
          !currentSessionId ||
          shuttingDown ||
          activeEvaluation !== undefined ||
          !context.isIdle() ||
          context.hasPendingMessages()
        ) {
          return;
        }

        const preparation = prepareAutoDiaryEvaluation(
          context.sessionManager,
          lastEvaluatedActivityEntryId,
          inputReceipts
        );
        if (preparation.status === "none") {
          lastEvaluatedActivityEntryId = preparation.latestActivityEntryId;
          inputReceipts = inputReceipts.slice(preparation.consumedReceiptCount);
          return;
        }
        if (preparation.status === "skip") {
          lastEvaluatedActivityEntryId = preparation.latestActivityEntryId;
          inputReceipts = inputReceipts.slice(preparation.consumedReceiptCount);
          authorizedCandidate = undefined;
          evaluationFailure = {
            activityEntryId: preparation.latestActivityEntryId,
            reasonCode: preparation.reasonCode,
          };
          reportTrigger("warn", "skipped", preparation.reasonCode);
          return;
        }

        authorizedCandidate = undefined;
        evaluationFailure = undefined;
        try {
          pi.appendEntry(AUTO_DIARY_EVALUATION_CUSTOM_TYPE, preparation.evaluation);
          const evaluationEntryId = currentEvaluationEntryId(context.sessionManager);
          if (evaluationEntryId === null) {
            throw new MemoryError(
              "MEMPALACE_INTEGRITY",
              "Automatic diary evaluation entry was not retained as the current session leaf"
            );
          }
          const active: ActiveAutoDiaryEvaluation = {
            evaluation: preparation.evaluation,
            evaluationEntryId,
            latestActivityEntryId: preparation.latestActivityEntryId,
            consumedReceiptCount: preparation.consumedReceiptCount,
            controller: new AbortController(),
          };
          activeEvaluation = active;
          active.settled = runEvaluation(active, context);
          reportTrigger("info", "scheduled", "new_user_activity", {
            sourceCount: preparation.evaluation.sources.length,
            retentionAdmission: preparation.evaluation.retentionAdmission,
            isolation: "one-tool-model-client",
          });
          await active.settled;
        } catch (error) {
          lastEvaluatedActivityEntryId = preparation.latestActivityEntryId;
          inputReceipts = inputReceipts.slice(preparation.consumedReceiptCount);
          activeEvaluation = undefined;
          evaluationFailure = {
            activityEntryId: preparation.latestActivityEntryId,
            reasonCode: "evaluation_schedule_failed",
          };
          reportTrigger("warn", "failed", "evaluation_schedule_failed", {
            errorCode: errorCodeFrom(error, "MEMPALACE_UNAVAILABLE"),
          });
          reportEvaluation("warn", "failed", "evaluation_not_started", {
            errorCode: errorCodeFrom(error, "MEMPALACE_UNAVAILABLE"),
          });
        }
      });
    }

    pi.on("session_shutdown", async (event: SessionShutdownEvent, context: ExtensionContext) => {
      const session = currentSessionId;
      if (!session || diarySessions.has(session)) return;
      diarySessions.add(session);
      shuttingDown = true;

      runtimeTelemetry.info("primary_session_activity", {
        sessionId: session,
        shutdownReason: event.reason,
        ...collectAutoDiaryActivity(context.sessionManager),
      });

      const reportDisposition = (
        level: "info" | "warn",
        disposition: string,
        reasonCode: string,
        metadata: Record<string, unknown> = {}
      ): void => {
        runtimeTelemetry[level]("primary_auto_diary_disposition", {
          sessionId: session,
          mode: config.autoDiary.mode,
          disposition,
          reasonCode,
          ...metadata,
        });
      };

      const interruptedEvaluation = activeEvaluation;
      if (interruptedEvaluation !== undefined) {
        await cancelAutoDiaryEvaluation?.("shutdown");
        authorizedCandidate = undefined;
        reportDisposition("warn", "uncertain", "shutdown_before_model_disposition");
        return;
      }
      if (config.autoDiary.mode === "disabled") {
        reportDisposition("info", "skip", "mode_disabled");
        return;
      }
      if (config.autoDiary.mode === "retain" && !config.writeEnabled) {
        reportDisposition("info", "skip", "writes_disabled");
        return;
      }
      const latestActivityEntryId = latestAutoDiaryUserActivityId(context.sessionManager);
      if (latestActivityEntryId !== lastEvaluatedActivityEntryId) {
        authorizedCandidate = undefined;
        reportDisposition("warn", "uncertain", "activity_not_evaluated");
        return;
      }
      if (
        evaluationFailure !== undefined &&
        evaluationFailure.activityEntryId === latestActivityEntryId
      ) {
        reportDisposition("warn", "uncertain", evaluationFailure.reasonCode);
        return;
      }

      const resolution = resolveAutoDiaryCandidate(context.sessionManager);
      if (resolution.status === "absent") {
        reportDisposition("info", "skip", resolution.reasonCode);
        return;
      }
      if (resolution.status === "invalid") {
        reportDisposition("warn", "uncertain", resolution.reasonCode);
        return;
      }

      const candidate = resolution.candidate;
      if (
        authorizedCandidate?.candidateEntryId !== resolution.candidateEntryId ||
        authorizedCandidate.evaluationId !== candidate.evaluationId
      ) {
        reportDisposition("warn", "uncertain", "candidate_not_authorized");
        return;
      }
      try {
        pi.appendEntry(
          AUTO_DIARY_PROCESSED_CUSTOM_TYPE,
          autoDiaryProcessedMarker(resolution.candidateEntryId, candidate.evaluationId)
        );
        if (
          !currentAutoDiaryProcessedMarkerMatches(
            context.sessionManager,
            resolution.candidateEntryId,
            candidate.evaluationId
          )
        ) {
          throw new MemoryError(
            "MEMPALACE_INTEGRITY",
            "Automatic diary processed marker was not retained as the current session leaf"
          );
        }
      } catch (error) {
        reportDisposition("warn", "uncertain", "candidate_state_unavailable", {
          errorCode: errorCodeFrom(error, "MEMPALACE_INTEGRITY"),
        });
        return;
      }
      if (candidate.disposition === "skip" || candidate.disposition === "uncertain") {
        reportDisposition("info", candidate.disposition, `candidate_${candidate.disposition}`);
        return;
      }

      const candidateMetadata = {
        entryBytes: Buffer.byteLength(candidate.entry, "utf8"),
        futureValueBytes: Buffer.byteLength(candidate.futureValue, "utf8"),
        automaticProvenance: candidate.provenance,
      };
      if (config.autoDiary.mode === "observe-only") {
        reportDisposition("info", "observe-only", "candidate_retain", candidateMetadata);
        return;
      }

      const outcome = await retainAutoDiaryCandidate(
        adapter,
        candidate,
        config.autoDiary.shutdownTimeoutMs
      );
      const metadata = {
        ...candidateMetadata,
        ...("requestId" in outcome && outcome.requestId !== undefined
          ? { requestId: outcome.requestId }
          : {}),
        ...("errorCode" in outcome && outcome.errorCode !== undefined
          ? { errorCode: outcome.errorCode }
          : {}),
      };
      reportDisposition(
        outcome.disposition === "failed" || outcome.disposition === "ambiguous" ? "warn" : "info",
        outcome.disposition,
        outcome.reasonCode,
        metadata
      );
    });
  };
}

export default createMemoryExtension();

export { MemoryAdapter } from "./adapter.js";
export {
  AUTO_DIARY_ACTIVITY_LOOKBACK_ENTRIES,
  AUTO_DIARY_AUTOMATIC_PROVENANCE,
  AUTO_DIARY_CANDIDATE_CUSTOM_TYPE,
  AUTO_DIARY_CANDIDATE_LOOKBACK_ENTRIES,
  AUTO_DIARY_CANDIDATE_TOOL_NAME,
  AUTO_DIARY_EVALUATION_CUSTOM_TYPE,
  AUTO_DIARY_MAX_ACTIVITY_SOURCES,
  AUTO_DIARY_MAX_COMBINED_SOURCE_BYTES,
  AUTO_DIARY_MAX_ENTRY_BYTES,
  AUTO_DIARY_MAX_EVALUATION_PROMPT_BYTES,
  AUTO_DIARY_MAX_INPUT_RECEIPTS,
  AUTO_DIARY_MAX_MODEL_INPUT_BYTES,
  AUTO_DIARY_MAX_REASON_BYTES,
  AUTO_DIARY_MAX_SHUTDOWN_TIMEOUT_MS,
  AUTO_DIARY_MAX_SOURCE_BLOCKS,
  AUTO_DIARY_MAX_SOURCE_BYTES,
  AUTO_DIARY_MIN_SHUTDOWN_TIMEOUT_MS,
  AUTO_DIARY_PROCESSED_CUSTOM_TYPE,
  AUTO_DIARY_SOURCE_LOOKBACK_ENTRIES,
  AUTO_DIARY_WRITE_TOPIC,
  AutoDiaryEvaluationError,
  autoDiaryProcessedMarker,
  buildAutoDiaryEvaluationPrompt,
  buildAutoDiaryModelInput,
  collectAutoDiaryActivity,
  createAutoDiaryInputReceipt,
  currentAutoDiaryCandidateEntryId,
  currentAutoDiaryProcessedMarkerMatches,
  evaluateAutoDiaryCandidateWithModel,
  latestAutoDiaryUserActivityId,
  prepareAutoDiaryEvaluation,
  resolveAutoDiaryCandidate,
  retainAutoDiaryCandidate,
  stageAutoDiaryCandidate,
} from "./auto-diary.js";
export type {
  AutoDiaryActivityTelemetry,
  AutoDiaryCandidate,
  AutoDiaryCandidateParameters,
  AutoDiaryCandidateResolution,
  AutoDiaryEvaluation,
  AutoDiaryEvaluationFailureReason,
  AutoDiaryEvaluationPreparation,
  AutoDiaryEvaluator,
  AutoDiaryInputOrigin,
  AutoDiaryInputReceipt,
  AutoDiaryRetentionAdmission,
  AutoDiaryRetentionAdmissionReason,
  AutoDiaryRetentionOutcome,
  AutoDiarySessionReader,
  AutoDiarySourceGrounding,
  RetainAutoDiaryCandidate,
} from "./auto-diary.js";
export { loadMemoryRuntimeConfig, loadWorkerReadConfig, resolveMemoryActor } from "./config.js";
export { CANONICAL_KG_PREDICATES, KG_PREDICATE_SCHEMA_VERSION } from "./kg-policy.js";
export {
  LOGSTREAM_MODEL_MAX_BODY_BYTES,
  LOGSTREAM_MODEL_MAX_BODY_CHARACTERS,
  LOGSTREAM_MODEL_MAX_LIST_LIMIT,
  LOGSTREAM_MODEL_MAX_WAIT_TIMEOUT_MS,
  SAFE_ADVISORY_EVENT_TYPES,
  UPSTREAM_LOGSTREAM_STATUSES,
} from "./logstream-adapter.js";
export { createPrimaryLogstreamTools, primaryLogstreamToolNames } from "./logstream-tools.js";
export { MemoryMcpClient, SAFE_READ_TOOLS } from "./mcp-client.js";
export {
  FORBIDDEN_MODEL_MEMORY_TOOLS,
  PRIMARY_MEMORY_TOOL_BUNDLES,
  primaryMemoryToolNames,
} from "./tools.js";
export { MemoryError } from "./types.js";
export type {
  LogstreamOperation,
  MemoryAutoDiaryConfig,
  MemoryAutoDiaryMode,
  MemoryErrorCode,
  MemoryExecution,
  MemoryLogstreamConfig,
  MemoryOperation,
  MemoryResultOperation,
  MemoryRuntimeConfig,
} from "./types.js";
