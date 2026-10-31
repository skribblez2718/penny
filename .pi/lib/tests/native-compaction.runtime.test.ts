import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  observeNativeCompactionProgress,
  type CompactionProgress,
} from "../compaction-policy.mjs";

const COMPACTION_PROGRESS_CHANNEL = "penny:compaction-progress-v1";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(contextWindow: number, customSummary = false) {
  vi.stubGlobal("fetch", () => {
    throw new Error("network forbidden in compaction test");
  });
  const root = mkdtempSync(path.join(tmpdir(), "penny-native-compaction-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir);
  const faux = fauxProvider({
    tokensPerSecond: 0,
    models: [{ id: "compact", contextWindow, maxTokens: 1000 }],
  });
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
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "old work ".repeat(3000), timestamp: Date.now() });
  const old = fauxAssistantMessage("prior work");
  manager.appendMessage({ ...old, usage: { ...old.usage, input: 7000, totalTokens: 7004 } });
  manager.appendMessage({ role: "user", content: "recent work", timestamp: Date.now() });
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    eventBus,
    extensionFactories: customSummary
      ? [
          (pi) => {
            pi.on("session_before_compact", (event) => {
              pi.events.emit(COMPACTION_PROGRESS_CHANNEL, {
                activity_class: "assistant_thinking_delta",
                observed_units: 9,
              });
              pi.events.emit(COMPACTION_PROGRESS_CHANNEL, {
                activity_class: "assistant_text_delta",
                observed_units: 0,
              });
              pi.events.emit(COMPACTION_PROGRESS_CHANNEL, {
                activity_class: "assistant_text_delta",
                observed_units: 1,
                body: "never forward",
              });
              return {
                compaction: {
                  summary: "Custom native-hook summary",
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                },
              };
            });
          },
        ]
      : [],
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Offline compaction fixture",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    settingsManager,
    sessionManager: manager,
    tools: [],
  });
  const progress: CompactionProgress[] = [];
  const originalStream = session.agent.streamFunction;
  const release = observeNativeCompactionProgress(session, (event) => progress.push(event));
  return { session, manager, faux, progress, settingsManager, release, eventBus, originalStream };
}

describe("real SDK automatic compaction, provider-free", () => {
  it("crosses the native threshold, persists a native summary, then finishes the requested work", async () => {
    const f = await fixture(4000);
    const reasons: string[] = [];
    f.session.subscribe((event) => {
      if (event.type === "compaction_start") reasons.push(event.reason);
    });
    f.faux.setResponses([
      fauxAssistantMessage("## Goal\nNative threshold summary"),
      fauxAssistantMessage("final threshold work"),
    ]);
    try {
      await f.session.prompt("Continue the final work");
      expect(f.session.getLastAssistantText()).toBe("final threshold work");
      expect(reasons).toContain("threshold");
      const compact = f.manager.getEntries().filter((entry) => entry.type === "compaction");
      expect(compact).toHaveLength(1);
      expect(compact[0]?.summary).toContain("Native threshold summary");
      expect(compact[0]?.fromHook).not.toBe(true);
      expect(f.progress.length).toBeGreaterThan(0);
      expect(
        f.progress.every(
          (event) => Object.keys(event).sort().join(",") === "activity_class,observed_units"
        )
      ).toBe(true);
      const file = f.manager.getSessionFile();
      if (!file) throw new Error("missing durable session");
      expect(readFileSync(file, "utf8")).toContain("Native threshold summary");
      expect(f.faux.state.callCount).toBe(2);
    } finally {
      f.release();
      f.session.dispose();
    }
  });

  it("ignores valid, malformed and replayed public bus progress during a custom native hook", async () => {
    const f = await fixture(4000, true);
    try {
      f.eventBus.emit(COMPACTION_PROGRESS_CHANNEL, {
        activity_class: "assistant_text_delta",
        observed_units: 99,
      });
      expect(f.progress).toEqual([]);
      f.faux.setResponses([fauxAssistantMessage("final hook work")]);
      await f.session.prompt("Finish after the custom summary");
      expect(f.session.getLastAssistantText()).toBe("final hook work");
      expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toMatchObject([
        { summary: "Custom native-hook summary", fromHook: true },
      ]);
      expect(f.progress).toEqual([]);
      expect(f.faux.state.callCount).toBe(1);
      f.release();
      expect(f.session.agent.streamFunction).toBe(f.originalStream);
      f.eventBus.emit(COMPACTION_PROGRESS_CHANNEL, {
        activity_class: "assistant_text_delta",
        observed_units: 99,
      });
      expect(f.progress).toEqual([]);
    } finally {
      f.release();
      f.session.dispose();
    }
  });

  it("recovers from an actual SDK overflow response with native compaction and retries final work", async () => {
    const f = await fixture(128000);
    const reasons: string[] = [];
    f.session.subscribe((event) => {
      if (event.type === "compaction_start") reasons.push(event.reason);
    });
    f.faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "This model's maximum context length is 128000 tokens",
      }),
      fauxAssistantMessage("## Goal\nOverflow recovery summary"),
      fauxAssistantMessage("Recovered current turn prefix"),
      fauxAssistantMessage("final overflow work"),
    ]);
    try {
      await f.session.prompt("Finish after overflow");
      expect(reasons).toEqual(["overflow"]);
      expect(f.session.getLastAssistantText()).toBe("final overflow work");
      expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
      expect(f.manager.getEntries().some((entry) => entry.type === "context_edit")).toBe(true);
      expect(f.faux.state.callCount).toBe(4);
      expect(f.progress.length).toBeGreaterThan(0);
    } finally {
      f.release();
      f.session.dispose();
    }
  });
});
