/** Offline provider timing only. Reuses the real registered-owner/SDK/custody fixture. */
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { requireDefined } from "../../../../lib/tests/test-narrowers.js";
import { continuationFixture } from "./uo-continuation-fixture.js";

export type SummaryActivity = "productive" | "empty" | "silent";
export interface SummaryDelta {
  at_ms: number;
  observed_units: number;
}

export function productiveSummaryFixture(activity: SummaryActivity) {
  const base = continuationFixture("native-overflow", new AbortController());
  const deltas: SummaryDelta[] = [];
  let resolveStarted: (() => void) | undefined;
  let rejectStarted: ((error: unknown) => void) | undefined;
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  let finish: (() => void) | undefined;
  let summaryStart = 0;
  let summaryEnd: number | undefined;
  let summaries = 0;
  let summaryAborted = false;
  let summaryMessageUpdates = 0;
  const provider = base.faux.provider;
  const originalSimple = provider.streamSimple.bind(provider);
  const originalStream = provider.stream.bind(provider);

  function timedSummary(
    source: ReturnType<typeof createAssistantMessageEventStream>,
    options: Pick<SimpleStreamOptions, "signal"> | undefined
  ) {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      // Keep the existing provider's exact-task/input checks and summary bytes. Only
      // response timing/chunking changes; no session/owner events are manufactured.
      const message = await source.result();
      const block = message.content[0];
      if (
        message.stopReason !== "stop" ||
        message.content.length !== 1 ||
        block?.type !== "text" ||
        !block.text
      )
        throw new Error("Expected the existing fixture's successful nonempty native summary");
      const text = block.text;
      const signal = requireDefined(options?.signal, "native summary signal absent");
      const first = requireDefined(base.observations[0], "summary without worker");
      const interval = requireDefined(first.invocation.livenessBudget, "lease absent")
        .inactivity_lease.interval_ms;
      summaries++;
      summaryStart = Date.now();
      const unsubscribe = first.session.subscribe((event) => {
        if (event.type === "message_update" && first.session.isCompacting) summaryMessageUpdates++;
      });
      let partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let close: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      let terminal = false;
      const abort = () => {
        if (terminal) return;
        terminal = true;
        summaryEnd = Date.now();
        summaryAborted = true;
        if (timer !== undefined) clearTimeout(timer);
        const error: AssistantMessage = {
          ...partial,
          stopReason: "aborted",
          errorMessage: "Offline summary aborted by its real SDK signal",
        };
        stream.push({ type: "error", reason: "aborted", error });
        stream.end(error);
        close?.();
      };
      finish = () => {
        if (terminal) throw new Error("Cannot complete an aborted summary");
        if (activity !== "productive" || deltas.length !== 3 || accumulated !== text)
          throw new Error("Summary has not delivered all real text");
        terminal = true;
        summaryEnd = Date.now();
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        close?.();
      };
      // Three installments are this response's test data, never an owner work cap.
      const width = Math.ceil(text.length / 3);
      const pieces = [text.slice(0, width), text.slice(width, width * 2), text.slice(width * 2)];
      stream.push({ type: "start", partial });
      partial = { ...partial, content: [{ type: "text", text: "" }] };
      stream.push({ type: "text_start", contentIndex: 0, partial });
      let index = 0;
      let accumulated = "";
      const emit = () => {
        if (terminal) return;
        const delta = activity === "productive" ? requireDefined(pieces[index]) : "";
        accumulated += delta;
        partial = { ...partial, content: [{ type: "text", text: accumulated }] };
        deltas.push({ at_ms: Date.now(), observed_units: Buffer.byteLength(delta, "utf8") });
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
        index++;
        if (index < pieces.length) timer = setTimeout(emit, spacing);
      };
      const spacing = activity === "productive" ? (interval * 3) / 5 : interval / 4;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (activity !== "silent") timer = setTimeout(emit, spacing);
      resolveStarted?.();
      try {
        await closed;
      } finally {
        signal.removeEventListener("abort", abort);
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe();
      }
    })().catch((error: unknown) => {
      rejectStarted?.(error);
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: base.faux.api,
        provider: provider.id,
        model: base.faux.getModel().id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    });
    return stream;
  }
  provider.streamSimple = (model, context, options) => {
    const source = originalSimple(model, context, options);
    return getCurrentSystemPrompt(context.messages).startsWith(
      "You are a context summarization assistant."
    )
      ? timedSummary(source, options)
      : source;
  };
  provider.stream = (model, context, options) => {
    const source = originalStream(model, context, options);
    return getCurrentSystemPrompt(context.messages).startsWith(
      "You are a context summarization assistant."
    )
      ? timedSummary(source, options)
      : source;
  };
  return {
    ...base,
    started,
    deltas,
    finish: () => requireDefined(finish, "summary not started")(),
    summaryStart: () => summaryStart,
    summaryEnd: () => summaryEnd,
    summaries: () => summaries,
    summaryAborted: () => summaryAborted,
    summaryMessageUpdates: () => summaryMessageUpdates,
  };
}
