/** Ordinary SCA model identity and host-owned, whole-request disclosure/cost fence.
 * This is not a candidate activation, credential store, or authorization workflow.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { AgentInvocation } from "../model-client.js";
import { assertResolvedModelIdentity, type RequiredModelIdentityV1 } from "../required-model.js";
import {
  SCA_MODEL_ALIAS,
  SCA_MODEL_ID,
  SCA_MODEL_OVERRIDE,
  SCA_MODEL_PROVIDER,
} from "./model-identity.js";

export const SCA_REQUIRED_MODEL: RequiredModelIdentityV1 = Object.freeze({
  schema_version: 1,
  alias: SCA_MODEL_ALIAS,
  provider: SCA_MODEL_PROVIDER,
  model: SCA_MODEL_ID,
  override: SCA_MODEL_OVERRIDE,
});

/** Ollama reports the concrete model without its request-only cloud routing suffix. */
export const SCA_PROVIDER_RESPONSE_MODEL_IDS = Object.freeze([SCA_MODEL_ID, "deepseek-v4.1-flash"]);

export function assertOrdinaryScaResponseIdentity(
  message: Pick<AssistantMessage, "provider" | "model" | "responseModel">
): void {
  assertResolvedModelIdentity(SCA_REQUIRED_MODEL, {
    provider: message.provider,
    model: message.model,
  });
  if (
    message.responseModel === undefined ||
    !SCA_PROVIDER_RESPONSE_MODEL_IDS.includes(message.responseModel)
  )
    throw new Error("SCA observed provider response model mismatch");
}

/** Only supplied operator limits constrain work; inactivity is a renewable lease,
 * not an allowance on productive calls, sessions or output. */
export interface OrdinaryScaModelLimits {
  readonly calls?: number;
  readonly callsPerSession?: number;
  readonly routingRepairSessions?: number;
  readonly inputBytesPerCall?: number;
  readonly outputTokensPerCall?: number;
  readonly totalOutputTokens?: number;
  readonly totalOutputBytes?: number;
  readonly inactivityMs: number;
}
export interface OrdinaryScaRequestReceipt {
  readonly state: string;
  readonly purpose: "phase" | "routing_repair";
  readonly ordinal: number;
  readonly destination: string;
  readonly transcriptSha256: string;
  readonly openingSha256: string;
  readonly payloadSha256: string;
  readonly inputBytes: number;
  readonly inputTokenUpperBound: number;
  readonly maxOutputTokens: number | null;
  status?: number;
}
export interface OrdinaryScaResponseReceipt {
  readonly state: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel: string | null;
  readonly stopReason: string;
  readonly input: number;
  readonly output: number;
  readonly error: string | null;
}
export interface OrdinaryScaDisclosurePolicy {
  /** Exact SDK HTTP destination, including path. No redirect or alternate endpoint. */
  readonly destination: string;
  readonly limits: OrdinaryScaModelLimits;
  /** Host checks all transcript/payload bytes, including tool results, before delegation. */
  admit(value: unknown, invocation: AgentInvocation): void;
  /** Receives metadata/errors only; never credentials or request headers. */
  redactError(error: string): string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactDestination(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error("SCA destination must be an exact credential-free HTTP(S) URL");
  return url.href;
}

/** One operator-authorized cohort. Share accounting across all its sessions. */
export class OrdinaryScaModelGuard {
  readonly requests: OrdinaryScaRequestReceipt[] = [];
  readonly responses: OrdinaryScaResponseReceipt[] = [];
  readonly denials: string[] = [];
  private reservedOutputTokens = 0;
  private outputBytes = 0;
  private repairSessions = 0;
  private readonly destination: string;
  constructor(private readonly policy: OrdinaryScaDisclosurePolicy) {
    this.destination = exactDestination(policy.destination);
    const suppliedLimits: readonly unknown[] = Object.values(policy.limits);
    for (const value of [policy.limits.inactivityMs, ...suppliedLimits]) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        throw new Error("Supplied SCA model limits must be positive safe integers");
    }
  }
  private deny(reason: string): never {
    this.denials.push(reason);
    throw new Error(`SCA model boundary denied: ${reason}`);
  }
  private admit(value: unknown, invocation: AgentInvocation): void {
    try {
      this.policy.admit(value, invocation);
    } catch (error) {
      this.deny(
        this.policy.redactError(
          error instanceof Error ? error.message : "disclosure admission failed"
        )
      );
    }
  }
  attach(session: AgentSession, invocation: AgentInvocation): () => void {
    if (invocation.registration?.playbook_name !== "sca") this.deny("not an ordinary SCA phase");
    const repair = invocation.executionPurpose === "routing_repair";
    if (repair) {
      // WorkerExecutor verifies the signed source receipt and immutable binding.
      // This boundary additionally refuses an uncorrelated/general-purpose repair.
      const source = invocation.inputArtifacts[0];
      if (
        invocation.workflowSession?.purpose !== "routing_repair" ||
        !invocation.routingRepairGuidance?.trim() ||
        invocation.inputArtifacts.length !== 1 ||
        source?.phase !== invocation.stateId ||
        source.producer !== `agent:${invocation.agent}`
      )
        this.deny("routing repair lacks exact owner source/guidance correlation");
      if (
        this.policy.limits.routingRepairSessions !== undefined &&
        this.repairSessions >= this.policy.limits.routingRepairSessions
      )
        this.deny("routing repair session cap");
    }
    if (canonicalJson(invocation.registration.required_model) !== canonicalJson(SCA_REQUIRED_MODEL))
      this.deny("ordinary registration lacks exact required_model");
    if (invocation.modelOverride !== SCA_MODEL_OVERRIDE) this.deny("model override mismatch");
    const selected = session.model;
    if (selected === undefined) this.deny("session model missing");
    assertResolvedModelIdentity(SCA_REQUIRED_MODEL, {
      provider: selected.provider,
      model: selected.id,
    });
    if (selected.api !== "openai-completions") this.deny("unsupported instrumented provider API");
    if (
      exactDestination(`${selected.baseUrl.replace(/\/$/u, "")}/chat/completions`) !==
      this.destination
    )
      this.deny("session destination mismatch");
    if (session.getActiveToolNames().join() !== "artifact_read")
      this.deny("ordinary tool surface mismatch");
    const assertDefaultCompaction = () => {
      if (
        session.extensionRunner.hasHandlers("session_before_compact") ||
        session.extensionRunner.hasHandlers("session_before_tree")
      )
        this.deny("custom summarization hooks are not admitted");
    };
    assertDefaultCompaction();
    if (repair) this.repairSessions += 1;
    const original = session.agent.streamFunction;
    const controller = new AbortController();
    const limits = this.policy.limits;
    let calls = 0;
    let responseFailure: Error | undefined;
    let openingSha256 = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new Error("SCA provider inactivity expired")),
        limits.inactivityMs
      );
      timer.unref();
    };
    const abort = () => controller.abort(invocation.signal?.reason);
    invocation.signal?.addEventListener("abort", abort, { once: true });
    if (invocation.signal?.aborted) abort();
    const fail = (error: unknown): Error => {
      const failure = error instanceof Error ? error : new Error("SCA stream admission failed");
      if (responseFailure === undefined) {
        responseFailure = failure;
        this.denials.push(failure.message);
      }
      controller.abort(failure);
      return failure;
    };
    const admitCompactionSource = () => {
      const messages = session.messages;
      // Ordinary turns may continue from host-observed SDK reader feedback, but
      // rejected/error text is not an artifact envelope authorized for flattening.
      if (messages.some((message) => message.role === "toolResult" && message.isError))
        this.deny("rejected tool output in compaction source");
      this.admit({ messages }, invocation);
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_end") renew();
      if (event.type === "compaction_start") {
        try {
          assertDefaultCompaction();
          // This synchronous SDK lifecycle event precedes summary serialization/truncation.
          // Validate the ORIGINAL projected messages, not flattened summary-prompt user text.
          admitCompactionSource();
        } catch (error) {
          fail(error);
          session.abortCompaction();
          throw error;
        }
      }
    });
    session.agent.streamFunction = async (model, context, options) => {
      controller.signal.throwIfAborted();
      assertResolvedModelIdentity(SCA_REQUIRED_MODEL, {
        provider: model.provider,
        model: model.id,
      });
      if (
        model.api !== "openai-completions" ||
        exactDestination(`${model.baseUrl.replace(/\/$/u, "")}/chat/completions`) !==
          this.destination
      )
        this.deny("stream model API/destination mismatch");
      assertDefaultCompaction();
      // Defense in depth: every actual default-summary stream also binds its original source.
      if (session.isCompacting) admitCompactionSource();
      this.admit(context, invocation);
      const transcript = canonicalJson(context);
      if (!openingSha256) openingSha256 = sha256(transcript);
      const transcriptSha256 = sha256(transcript);
      renew();
      // The adapter's fetch seam counts actual HTTP requests, not sessions or model turns.
      let serializedOutputCap: number | undefined;
      const guardedFetch: typeof fetch = async (input, init) => {
        signal.throwIfAborted();
        const request = new Request(input, init);
        if (request.url !== this.destination || request.method !== "POST")
          this.deny("HTTP destination/method mismatch");
        const body = await request.clone().text();
        if (
          limits.inputBytesPerCall !== undefined &&
          Buffer.byteLength(body) > limits.inputBytesPerCall
        )
          this.deny("per-request input byte cap");
        const payload: unknown = JSON.parse(body);
        if (!record(payload) || payload.model !== SCA_MODEL_ID || payload.stream !== true)
          this.deny("serialized provider identity/stream mismatch");
        const cap = payload.max_tokens;
        if (payload.max_completion_tokens !== undefined)
          this.deny("Ollama output limit must use its supported max_tokens field");
        if (
          (cap !== undefined &&
            (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1)) ||
          (maxTokens !== undefined && (typeof cap !== "number" || cap > maxTokens))
        )
          this.deny("serialized output cap missing or widened");
        serializedOutputCap = typeof cap === "number" ? cap : undefined;
        if (limits.totalOutputTokens !== undefined && serializedOutputCap === undefined)
          this.deny("aggregate output policy requires a serialized per-request ceiling");
        this.admit(payload, invocation);
        // UTF-8 bytes + framing reserve is deliberately conservative, not a tokenizer estimate.
        const upperBound = Buffer.byteLength(body) + 4096;
        if (
          (limits.calls !== undefined && this.requests.length >= limits.calls) ||
          (limits.callsPerSession !== undefined && calls >= limits.callsPerSession)
        )
          this.deny("actual HTTP call cap");
        if (
          limits.totalOutputTokens !== undefined &&
          serializedOutputCap !== undefined &&
          this.reservedOutputTokens + serializedOutputCap > limits.totalOutputTokens
        )
          this.deny("total reserved output tokens");
        this.reservedOutputTokens += serializedOutputCap ?? 0;
        calls += 1;
        const receipt: OrdinaryScaRequestReceipt = {
          state: invocation.stateId,
          purpose: repair ? "routing_repair" : "phase",
          ordinal: this.requests.length + 1,
          destination: this.destination,
          transcriptSha256,
          openingSha256,
          payloadSha256: sha256(body),
          inputBytes: Buffer.byteLength(body),
          inputTokenUpperBound: upperBound,
          maxOutputTokens: serializedOutputCap ?? null,
        };
        this.requests.push(receipt);
        const response = await fetch(request, {
          redirect: "error",
          signal: AbortSignal.any([signal, request.signal]),
        });
        receipt.status = response.status;
        renew();
        return response;
      };
      const signal =
        options?.signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, options.signal]);
      signal.throwIfAborted();
      const maxTokens =
        limits.outputTokensPerCall === undefined
          ? options?.maxTokens
          : Math.min(options?.maxTokens ?? limits.outputTokensPerCall, limits.outputTokensPerCall);
      const bounded: SimpleStreamOptions = {
        ...options,
        signal,
        fetch: guardedFetch,
        ...(maxTokens === undefined ? {} : { maxTokens }),
        maxRetries: 0,
        timeoutMs: 2_147_483_647,
        cacheRetention: "none",
      };
      // Ollama documents max_tokens, not max_completion_tokens. The SDK's generic
      // OpenAI default otherwise silently loses the ceiling on this exact provider.
      const source = await original(
        {
          ...model,
          compat: { ...model.compat, maxTokensField: "max_tokens" },
          // Omission means provider-default thinking, not the host's off choice.
          thinkingLevelMap: { ...model.thinkingLevelMap, off: "none" },
        },
        context,
        bounded
      );
      const observed = createAssistantMessageEventStream();
      // One upstream consumer feeds the SDK's public stream. Both .result() (summaries)
      // and async iteration (ordinary turns) share the same admission/accounting path.
      let partial: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        timestamp: Date.now(),
      };
      let streamedBytes = 0;
      const admitResponse = (message: AssistantMessage) => {
        partial = message;
        this.responses.push({
          state: invocation.stateId,
          provider: message.provider,
          model: message.model,
          responseModel: message.responseModel ?? null,
          stopReason: message.stopReason,
          input: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
          output: message.usage.output,
          error:
            message.errorMessage === undefined
              ? null
              : this.policy.redactError(message.errorMessage),
        });
        if (message.stopReason === "error" && message.responseModel === undefined) {
          // Transport/setup errors have no response identity. Preserve them so the SDK
          // can perform its native overflow recovery, without inventing a model ID.
          return;
        }
        assertOrdinaryScaResponseIdentity(message);
        if (
          !Number.isSafeInteger(message.usage.output) ||
          message.usage.output < 0 ||
          (serializedOutputCap !== undefined && message.usage.output > serializedOutputCap)
        )
          throw new Error("SCA observed response output cap mismatch");
        const contentBytes = message.content.reduce(
          (sum, part) =>
            sum +
            Buffer.byteLength(
              part.type === "text"
                ? part.text
                : part.type === "thinking"
                  ? part.thinking
                  : JSON.stringify(part.arguments)
            ),
          0
        );
        this.outputBytes += Math.max(0, contentBytes - streamedBytes);
        if (limits.totalOutputBytes !== undefined && this.outputBytes > limits.totalOutputBytes)
          throw new Error("SCA output byte budget exhausted");
        renew();
      };
      let terminal = false;
      const pump = async () => {
        try {
          for await (const event of source) {
            signal.throwIfAborted();
            if ("partial" in event) partial = event.partial;
            if (
              (event.type === "text_delta" ||
                event.type === "thinking_delta" ||
                event.type === "toolcall_delta") &&
              event.delta.length > 0
            ) {
              const bytes = Buffer.byteLength(event.delta);
              streamedBytes += bytes;
              this.outputBytes += bytes;
              if (
                limits.totalOutputBytes !== undefined &&
                this.outputBytes > limits.totalOutputBytes
              )
                throw new Error("SCA output byte budget exhausted");
              renew();
            }
            if (event.type === "done" || event.type === "error") {
              admitResponse(event.type === "done" ? event.message : event.error);
              terminal = true;
            }
            observed.push(event);
          }
          if (terminal) observed.end();
          else {
            // Public SDK streams may complete through end(result), without a terminal event.
            const message = await source.result();
            signal.throwIfAborted();
            admitResponse(message);
            observed.end(message);
          }
        } catch (error) {
          const cancelled =
            options?.signal?.aborted === true || invocation.signal?.aborted === true;
          const failure = cancelled ? new Error("SCA request cancelled") : fail(error);
          // Pi 0.87.1's summary checker rejects "error", but not "aborted".
          // A cancelled invocation must never persist an empty/partial summary.
          const reason = "error";
          const message: AssistantMessage = {
            ...partial,
            stopReason: reason,
            errorMessage: failure.message,
          };
          observed.push({ type: "error", reason, error: message });
          observed.end();
        }
      };
      void pump();
      return observed;
    };
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      unsubscribe();
      invocation.signal?.removeEventListener("abort", abort);
      session.agent.streamFunction = original;
      if (responseFailure !== undefined) throw responseFailure;
    };
  }
}
