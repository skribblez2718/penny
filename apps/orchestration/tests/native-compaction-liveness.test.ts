import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enforceNativeAutoCompaction,
  createCompactionProgressObserver,
} from "../../../.pi/lib/compaction-policy.mjs";
import { ArtifactStore } from "../dist/artifact-store.js";
import { Checkpointer } from "../dist/checkpointer.js";
import { OrchestrationEngine } from "../dist/engine.js";
import type { ModelClient } from "../dist/model-client.js";
import { WorkerExecutor } from "../dist/worker.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(tokensPerSecond: number, customSummary = false, blackholeTelemetry = false) {
  vi.useFakeTimers({ now: 0 });
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
  const root = mkdtempSync(path.join(tmpdir(), "penny-compaction-lease-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir);
  const faux = fauxProvider({
    tokensPerSecond,
    tokenSize: { min: 1, max: 1 },
    models: [{ id: "compact", contextWindow: 4000, maxTokens: 1000 }],
  });
  faux.setResponses([
    fauxAssistantMessage("Native summary with repeated real streamed progress. ".repeat(2)),
    fauxAssistantMessage("done"),
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = enforceNativeAutoCompaction(
    SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 500, keepRecentTokens: 1 },
      retry: { enabled: false },
      cacheWarming: "off",
    })
  );
  const manager = SessionManager.inMemory(root);
  manager.appendMessage({ role: "user", content: "old work ".repeat(3000), timestamp: 0 });
  const old = fauxAssistantMessage("prior work");
  manager.appendMessage({ ...old, usage: { ...old.usage, input: 7000, totalTokens: 7004 } });
  manager.appendMessage({ role: "user", content: "recent work", timestamp: 0 });
  const activities: unknown[] = [];
  let activity:
    | ((progress: {
        kind: "activity";
        activity_class: "assistant_text_delta" | "assistant_thinking_delta";
        observed_units: number;
      }) => void)
    | undefined;
  const observer = createCompactionProgressObserver((progress) => {
    activities.push(progress);
    activity?.({ kind: "activity", ...progress });
  });
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    eventBus,
    extensionsOverride: observer.extensionsOverride,
    ...(customSummary
      ? {
          additionalExtensionPaths: [
            fileURLToPath(new URL("../../../.pi/extensions/compaction/index.ts", import.meta.url)),
          ],
        }
      : {}),
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Offline native compaction lease fixture",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    tools: [],
  });
  const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    maxSteps: 96,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactRevisions: artifacts,
  });
  let releaseStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  let releaseSettled: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    releaseSettled = resolve;
  });
  const baseStream = session.agent.streamFunction;
  let invocationSignal: AbortSignal | undefined;
  session.agent.streamFunction = async (...args) => {
    // Match the host's cancellation gate: the SDK may try an ordinary
    // continuation after aborting pre-prompt compaction; never dispatch it.
    invocationSignal?.throwIfAborted();
    const source = await baseStream(...args);
    releaseStarted?.();
    return source;
  };
  let summaryCalls = 0;
  const telemetry = { pending: 0, aborted: 0 };
  if (customSummary) {
    const model = {
      ...faux.getModel(),
      api: "openai-completions",
      provider: "openai",
      id: "offline-summary",
      baseUrl: "http://summary.invalid/v1",
    };
    const getModel = modelRuntime.getModel.bind(modelRuntime);
    vi.spyOn(modelRuntime, "getModel").mockImplementation((provider, id) =>
      provider === model.provider && id === model.id ? model : getModel(provider, id)
    );
    vi.spyOn(modelRuntime, "getAuth").mockResolvedValue({
      auth: { apiKey: "offline-fixture-only" },
    });
    vi.stubEnv("PI_COMPACTION_SUMMARY_MODEL", "openai/offline-summary");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        if (blackholeTelemetry && String(url).endsWith("/compactions")) {
          const signal = init?.signal;
          if (!signal) throw new Error("telemetry missing abort signal");
          ++telemetry.pending;
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                --telemetry.pending;
                ++telemetry.aborted;
                reject(new DOMException("telemetry aborted", "AbortError"));
              },
              { once: true }
            );
          });
        }
        if (!String(url).startsWith(model.baseUrl)) return new Response(null, { status: 204 });
        ++summaryCalls;
        const signal = init?.signal;
        if (!signal || signal.aborted) throw new Error("missing/aborted summary HTTP signal");
        releaseStarted?.();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = () => {
              if (timer) clearTimeout(timer);
              controller.error(new Error("summary HTTP aborted"));
            };
            signal.addEventListener("abort", abort, { once: true });
            let deltas = 0;
            const emit = () => {
              if (++deltas <= 20) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: { content: "productive " }, finish_reason: null }] })}\n\n`
                  )
                );
                timer = setTimeout(emit, tokensPerSecond < 1 ? 100_000 : 100);
              } else {
                controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                signal.removeEventListener("abort", abort);
                controller.close();
              }
            };
            timer = setTimeout(emit, tokensPerSecond < 1 ? 100_000 : 100);
          },
          cancel() {
            if (timer) clearTimeout(timer);
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      })
    );
    faux.setResponses([fauxAssistantMessage("done")]);
  }
  let aborted = false;
  const client: ModelClient = {
    async runAgent(invocation) {
      activity = invocation.liveness;
      invocationSignal = invocation.signal;
      const release = observer.observe(session, invocation.signal);
      if (customSummary) await session.reload();
      const abort = () => {
        aborted = true;
        void session.abort();
      };
      invocation.signal?.addEventListener("abort", abort, { once: true });
      try {
        await session.prompt("Finish the work");
        return { text: session.getLastAssistantText() ?? "" };
      } finally {
        invocation.signal?.removeEventListener("abort", abort);
        release();
        releaseSettled?.();
      }
    },
  };
  // Deliberately use the existing fallback lease, not a synthetic provider/model binding.
  const workers = new WorkerExecutor(client, artifacts, {
    projectRoot: root,
    parallelConcurrency: 1,
    fallbackInactivityLeaseMs: 500,
    registration: engine.registration,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  const directive = engine.handle({
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: "compaction-lease",
      session_id: "lease-session",
      playbook: "research",
      engine_owner: "typescript",
    },
    goal: "Native summary lease fixture",
    constraints: { mode: "quick" },
    project_root: root,
    trust_profile: "trusted-interactive",
  });
  return {
    workers,
    directive,
    session,
    started,
    settled,
    activities,
    summaryCalls: () => summaryCalls,
    telemetry,
    eventBus,
    loader,
    aborted: () => aborted,
    close: () => {
      vi.restoreAllMocks();
      session.dispose();
      artifacts.close();
      checkpointer.close();
    },
  };
}

describe("real native summary streams and the actual worker inactivity timer", () => {
  it("keeps productive automatic compaction alive beyond one complete inactivity interval", async () => {
    const f = await fixture(10);
    try {
      const execution = f.workers.execute(f.directive);
      const completed = expect(execution).resolves.toHaveLength(1);
      await f.started;
      await vi.advanceTimersByTimeAsync(4000);
      await completed;
      expect(f.activities.length).toBeGreaterThan(10);
      expect(f.session.getLastAssistantText()).toBe("done");
      expect(f.aborted()).toBe(false);
    } finally {
      f.close();
    }
  });

  it("still expires and aborts a genuinely silent automatic summary without a fabricated heartbeat", async () => {
    const f = await fixture(0.01);
    try {
      const execution = f.workers.execute(f.directive);
      const expired = expect(execution).rejects.toThrow("worker_inactivity_lease_expired");
      await f.started;
      await vi.advanceTimersByTimeAsync(500);
      await expired;
      expect(f.activities).toEqual([]);
      expect(f.aborted()).toBe(true);
      // Let the faux provider observe the already-aborted native signal, then close cleanly.
      await vi.runAllTimersAsync();
      await f.settled;
      expect(f.activities).toEqual([]);
    } finally {
      f.close();
    }
  });

  it("keeps the exact custom producer alive after reload; prompt settles before black-holed telemetry aborts", async () => {
    const f = await fixture(10, true, true);
    try {
      const execution = f.workers.execute(f.directive);
      const completed = expect(execution).resolves.toHaveLength(1);
      await f.started;
      await vi.advanceTimersByTimeAsync(2_500);
      await completed;
      expect(f.telemetry).toEqual({ pending: 1, aborted: 0 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.telemetry).toEqual({ pending: 0, aborted: 1 });

      expect(f.activities.length).toBeGreaterThan(10);
      expect(f.aborted()).toBe(false);
      expect(f.session.getLastAssistantText()).toBe("done");
      expect(
        f.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction")
      ).toMatchObject([{ fromHook: true, details: { summary_source: "model" } }]);
      expect(f.summaryCalls()).toBe(1);
      expect(
        f.activities.every(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            Object.keys(value).sort().join(",") === "activity_class,observed_units"
        )
      ).toBe(true);
    } finally {
      f.close();
    }
  });

  it("expires a silent exact custom producer despite valid, malformed and replayed bus forgeries", async () => {
    const f = await fixture(0.01, true);
    const replay = { activity_class: "assistant_text_delta", observed_units: 12 };
    try {
      const execution = f.workers.execute(f.directive);
      const expired = expect(execution).rejects.toThrow("worker_inactivity_lease_expired");
      await f.started;
      expect(f.summaryCalls()).toBe(1);
      for (let n = 0; n < 10; ++n) {
        for (const value of [replay, null, { ...replay, body: "private" }, replay]) {
          f.eventBus.emit("penny:compaction-progress-v1", value);
        }
        await vi.advanceTimersByTimeAsync(50);
      }
      await expired;
      expect(f.activities).toEqual([]);
      expect(f.aborted()).toBe(true);
      await vi.runAllTimersAsync();
      await f.settled;
      expect(f.summaryCalls()).toBe(1);
      expect(f.activities).toEqual([]);
    } finally {
      f.close();
    }
  });
});
