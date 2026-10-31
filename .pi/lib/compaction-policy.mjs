import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/** @type {WeakSet<import("@earendil-works/pi-coding-agent").SettingsManager>} */
const enforced = new WeakSet();

/**
 * Session-local policy on public instance methods, not a prototype/vendor patch.
 * Pi's getCompactionSettings() calls getCompactionEnabled() on this same manager.
 * Enforcing that accessor survives reload, trust changes, unrelated setters and
 * model changes without persisting worker policy into operator settings.
 * @param {import("@earendil-works/pi-coding-agent").SettingsManager} settings
 */
export function enforceNativeAutoCompaction(settings) {
  if (!enforced.has(settings)) {
    settings.getCompactionEnabled = () => true;
    settings.setCompactionEnabled = () => {
      settings.applyOverrides({ compaction: { enabled: true } });
    };
    settings.applyOverrides({ compaction: { enabled: true } });
    enforced.add(settings);
  }
  return settings;
}

/**
 * Owner-local wiring for ONE existing Penny compaction module. Discovery and
 * guarded/private resource policy remain the loader's responsibility. This
 * override never adds an extension, and never exposes a reporter on the bus/API.
 * The exact producer accepts a private observer argument, not a reporter getter.
 * This is closed provenance between trusted host components, not a JS sandbox.
 * @param {(progress: import("./compaction-policy.mjs").CompactionProgress) => void} report
 * @returns {import("./compaction-policy.mjs").CompactionProgressObserver}
 */
export function createCompactionProgressObserver(report) {
  const producerPath = fileURLToPath(new URL("../extensions/compaction/index.ts", import.meta.url));
  /** @type {import("@earendil-works/pi-coding-agent").AgentSession | undefined} */
  let currentSession;
  /** @type {AbortSignal | undefined} */
  let signal;
  let generation = 0;
  return {
    extensionsOverride(base) {
      const currentGeneration = ++generation;
      let bound = false;
      return {
        ...base,
        extensions: base.extensions.map((extension) => {
          // Inline factories, lookalike basenames and copies are not this source.
          if (extension.resolvedPath.startsWith("<")) return extension;
          if (realpathSync(extension.resolvedPath) !== realpathSync(producerPath)) return extension;
          if (bound) throw new Error("duplicate Penny compaction producer");
          bound = true;
          const handlers = extension.handlers.get("session_before_compact");
          const producer = handlers?.length === 1 ? handlers[0] : undefined;
          if (typeof producer !== "function") {
            throw new Error("Penny compaction producer must have exactly one handler");
          }
          // Pi invokes hooks with (event, context). Only this owner supplies the
          // private observer and cancellation arguments only to this producer.
          // Keep them out of shared event/context/API objects.
          const observed = async (/** @type {unknown} */ event, /** @type {unknown} */ context) =>
            producer(
              event,
              context,
              (/** @type {unknown} */ progress) => {
                if (
                  generation === currentGeneration &&
                  currentSession?.isCompacting &&
                  !signal?.aborted &&
                  isCompactionProgress(progress)
                )
                  report(progress);
              },
              signal
            );
          const nextHandlers = new Map(extension.handlers);
          nextHandlers.set("session_before_compact", [observed]);
          return { ...extension, handlers: nextHandlers };
        }),
      };
    },
    observe(session, invocationSignal) {
      if (currentSession) throw new Error("compaction observer already owns a session");
      currentSession = session;
      signal = invocationSignal;
      const release = observeNativeCompactionProgress(session, (progress) => {
        if (!signal?.aborted) report(progress);
      });
      let released = false;
      const retire = () => {
        if (released) return;
        released = true;
        currentSession = undefined;
        ++generation;
        signal?.removeEventListener("abort", retire);
        release();
      };
      if (signal?.aborted) retire();
      else signal?.addEventListener("abort", retire, { once: true });
      return retire;
    },
  };
}

/**
 * Inspect real provider deltas; never forward text, reasoning or identifiers.
 * @param {unknown} event
 * @returns {import("./compaction-policy.mjs").CompactionProgress | undefined}
 */
export function compactionDeltaProgress(event) {
  if (typeof event !== "object" || event === null) return undefined;
  if (!("type" in event) || !("delta" in event) || typeof event.delta !== "string") {
    return undefined;
  }
  const observed_units = Math.min(Buffer.byteLength(event.delta, "utf8"), 16_777_216);
  if (observed_units === 0) return undefined;
  if (event.type === "text_delta") {
    return { activity_class: "assistant_text_delta", observed_units };
  }
  if (event.type === "thinking_delta") {
    return { activity_class: "assistant_thinking_delta", observed_units };
  }
  return undefined;
}

/** @param {unknown} value @returns {value is import("./compaction-policy.mjs").CompactionProgress} */
export function isCompactionProgress(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    Object.keys(value).length === 2 &&
    "activity_class" in value &&
    (value.activity_class === "assistant_text_delta" ||
      value.activity_class === "assistant_thinking_delta") &&
    "observed_units" in value &&
    typeof value.observed_units === "number" &&
    Number.isSafeInteger(value.observed_units) &&
    value.observed_units > 0 &&
    value.observed_units <= 16_777_216
  );
}

/**
 * Observe native summary streams even when Pi consumes only result(), outside
 * assistant events. One pump forwards every original event and final message.
 * No timers, extra model calls, changed options/signals, or synthetic progress.
 * Install AFTER host stream guards so admission/response checks remain in path.
 * @param {import("@earendil-works/pi-coding-agent").AgentSession} session
 * @param {(progress: import("./compaction-policy.mjs").CompactionProgress) => void} report
 */
export function observeNativeCompactionProgress(session, report) {
  let compacting = false;
  let released = false;
  let generation = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      ++generation;
      compacting = event.type === "compaction_start";
    }
  });
  const original = session.agent.streamFunction;
  /** @type {import("@earendil-works/pi-agent-core").StreamFn} */
  const observed = async (model, context, options) => {
    const currentGeneration = generation;
    const source = await original(model, context, options);
    if (!compacting || released || currentGeneration !== generation) return source;
    const forwarded = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const event of source) {
          const progress = compactionDeltaProgress(event);
          if (
            !released &&
            compacting &&
            currentGeneration === generation &&
            !options?.signal?.aborted &&
            progress
          )
            report(progress);
          forwarded.push(event);
        }
        forwarded.end(await source.result());
      } catch (error) {
        // StreamFn failures must be represented as terminal provider messages.
        const message = {
          role: /** @type {const} */ ("assistant"),
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
          stopReason: /** @type {"error" | "aborted"} */ (
            options?.signal?.aborted ? "aborted" : "error"
          ),
          errorMessage: error instanceof Error ? error.message : "summary stream failed",
          timestamp: Date.now(),
        };
        forwarded.push({ type: "error", reason: message.stopReason, error: message });
        forwarded.end(message);
      }
    })();
    return forwarded;
  };
  session.agent.streamFunction = observed;
  return () => {
    released = true;
    unsubscribe();
    if (session.agent.streamFunction === observed) session.agent.streamFunction = original;
  };
}
