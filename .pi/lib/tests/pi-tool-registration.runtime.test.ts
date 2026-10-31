import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enforceNativeAutoCompaction } from "../compaction-policy.mjs";
import { registerTool } from "../pi-tool-registration.js";
import { isRecord } from "./test-narrowers.js";

const RuntimeParams = Type.Object({ outcome: Type.String() });

interface DiagnosticDetails {
  readonly code: string;
  readonly artifact_id?: string;
}

interface ObservedToolOutcome {
  readonly isError: boolean;
  readonly content: unknown;
  readonly details: unknown;
}

function observeToolOutcome(event: AgentSessionEvent): ObservedToolOutcome | undefined {
  if (event.type !== "tool_execution_end" || event.toolName !== "runtime_contract") {
    return undefined;
  }
  const rawResult: unknown = event.result;
  if (!isRecord(rawResult)) throw new Error("Pi emitted a malformed tool result fixture");
  return {
    isError: event.isError,
    content: rawResult.content,
    details: rawResult.details,
  };
}

describe("Pi tool registration runtime failure bridge", () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const sandbox of sandboxes.splice(0)) {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("records explicit failures authoritatively while preserving details and normal Pi throws", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "penny-pi-tool-runtime-"));
    sandboxes.push(sandbox);
    const agentDir = path.join(sandbox, "agent");
    mkdirSync(agentDir, { recursive: true });

    vi.stubGlobal("fetch", () => {
      throw new Error("network forbidden in tool runtime fixture");
    });
    const faux = fauxProvider({
      tokensPerSecond: 0,
      models: [{ id: "compact", contextWindow: 8000, maxTokens: 1000 }],
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
        compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1 },
        retry: { enabled: false },
        cacheWarming: "off",
      })
    );
    const sessionManager = SessionManager.create(sandbox, path.join(sandbox, "sessions"));
    sessionManager.appendMessage({
      role: "user",
      content: "prior tool contract work ".repeat(3000),
      timestamp: Date.now(),
    });
    const prior = fauxAssistantMessage("prior tool contract result");
    sessionManager.appendMessage({
      ...prior,
      usage: { ...prior.usage, input: 10000, totalTokens: 10004 },
    });
    sessionManager.appendMessage({ role: "user", content: "recent work", timestamp: Date.now() });
    const resourceLoader = new DefaultResourceLoader({
      cwd: sandbox,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "Runtime contract fixture",
      extensionFactories: [
        (pi) => {
          registerTool<typeof RuntimeParams, DiagnosticDetails>(pi, {
            name: "runtime_contract",
            label: "Runtime contract",
            description: "Exercise authoritative Pi tool outcomes",
            parameters: RuntimeParams,
            async execute(_toolCallId, params) {
              if (params.outcome === "throw") throw new Error("ordinary thrown diagnostic");
              if (params.outcome === "explicit_failure") {
                return {
                  content: [
                    { type: "text", text: "bounded failure diagnostic" },
                    { type: "text", text: "artifact: art_fixture_exact" },
                  ],
                  details: { code: "FIXTURE_FAILED", artifact_id: "art_fixture_exact" },
                  isError: true,
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text:
                      params.outcome === "prose_only"
                        ? "The word error is ordinary prose"
                        : "successful result",
                  },
                ],
                details: { code: "FIXTURE_OK" },
              };
            },
          });
        },
      ],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: sandbox,
      agentDir,
      modelRuntime,
      model: faux.getModel(),
      resourceLoader,
      sessionManager,
      settingsManager,
      tools: ["runtime_contract"],
    });

    expect(session.autoCompactionEnabled).toBe(true);
    const reasons: string[] = [];
    const outcomes: ObservedToolOutcome[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_start") reasons.push(event.reason);
      const outcome = observeToolOutcome(event);
      if (outcome !== undefined) outcomes.push(outcome);
    });

    try {
      for (const outcome of ["success", "prose_only", "explicit_failure", "throw"] as const) {
        faux.setResponses([
          ...(outcome === "success" ? [fauxAssistantMessage("Native tool contract summary")] : []),
          fauxAssistantMessage(
            fauxToolCall("runtime_contract", { outcome }, { id: `tool-${outcome}` }),
            { stopReason: "toolUse" }
          ),
          fauxAssistantMessage(`continued after ${outcome}`),
        ]);
        await session.prompt(`run ${outcome}`);
        expect(session.getLastAssistantText()).toBe(`continued after ${outcome}`);
      }
    } finally {
      unsubscribe();
      session.dispose();
    }

    expect(outcomes).toHaveLength(4);
    expect(outcomes.map((outcome) => outcome.isError)).toEqual([false, false, true, true]);
    expect(outcomes[2]).toEqual({
      isError: true,
      content: [
        { type: "text", text: "bounded failure diagnostic" },
        { type: "text", text: "artifact: art_fixture_exact" },
      ],
      details: { code: "FIXTURE_FAILED", artifact_id: "art_fixture_exact" },
    });
    expect(outcomes[3]).toEqual({
      isError: true,
      content: [{ type: "text", text: "ordinary thrown diagnostic" }],
      details: {},
    });
    expect(reasons).toEqual(["threshold"]);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("missing durable tool runtime session");
    const summaries = SessionManager.open(sessionFile)
      .getEntries()
      .filter((entry) => entry.type === "compaction");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ summary: "Native tool contract summary" });
    expect(summaries[0]?.fromHook).not.toBe(true);
    expect(faux.state.callCount).toBe(9);
  });
});
