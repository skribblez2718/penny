import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, ProjectTrustStore, runPrintMode } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectAgentRuntime } from "../../direct-agent-runtime.js";
import { directSubagentActivityFromPiEvent } from "../../agent-runner.js";
import type { CompactionProgress } from "../../../../lib/compaction-policy.mjs";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(reportProgress = true, tools = "read", trackShutdown = false) {
  vi.stubGlobal("fetch", () => {
    throw new Error("network forbidden");
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "penny-direct-compaction-"));
  roots.push(cwd);
  const agentDir = path.join(cwd, "agent");
  mkdirSync(agentDir);
  mkdirSync(path.join(cwd, ".pi"));
  const globalPath = path.join(agentDir, "settings.json");
  const projectPath = path.join(cwd, ".pi/settings.json");
  writeFileSync(
    globalPath,
    JSON.stringify({
      compaction: {
        enabled: false,
        reserveTokens: 500,
        keepRecentTokens: 1,
        modelOverrides: { "faux/b": { reserveTokens: 600 } },
      },
      cacheWarming: "off",
      retry: { enabled: false },
      theme: "dark",
    })
  );
  writeFileSync(
    projectPath,
    JSON.stringify({ compaction: { enabled: false }, images: { blockImages: true } })
  );
  const basePrompt = path.join(cwd, "base.md");
  const rolePrompt = path.join(cwd, "role.md");
  writeFileSync(basePrompt, "BASE FRAME SENTINEL: obey caller policy.");
  writeFileSync(rolePrompt, "ROLE AND RESULT SENTINEL: finish in the registered format.");
  const shutdownExtension = path.join(cwd, "shutdown-fixture.mjs");
  if (trackShutdown) {
    writeFileSync(
      shutdownExtension,
      [
        'import { writeFileSync } from "node:fs";',
        "export default function (pi) {",
        '  pi.on("session_shutdown", async (event) => {',
        "    await new Promise((resolve) => setImmediate(resolve));",
        `    writeFileSync(${JSON.stringify(path.join(cwd, "shutdown-marker"))}, event.reason);`,
        "  });",
        "}",
      ].join("\n")
    );
  }
  const originalGlobal = readFileSync(globalPath, "utf8");
  const originalProject = readFileSync(projectPath, "utf8");
  new ProjectTrustStore(agentDir).set(cwd, true);
  const faux = fauxProvider({
    tokensPerSecond: 0,
    models: [
      { id: "a", contextWindow: 4000 },
      { id: "b", contextWindow: 8000 },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const progress: CompactionProgress[] = [];
  const { runtime } = await createDirectAgentRuntime(
    [
      "--mode",
      "json",
      "-p",
      "--session-dir",
      path.join(cwd, "sessions"),
      "--no-extensions",
      "--system-prompt",
      basePrompt,
      "--append-system-prompt",
      rolePrompt,
      "--provider",
      "faux",
      "--model",
      "a",
      "--tools",
      tools,
      ...(trackShutdown ? ["--extension", shutdownExtension] : []),
    ],
    {
      cwd,
      agentDir,
      modelRuntime,
      ...(reportProgress
        ? { reportProgress: (event: CompactionProgress) => progress.push(event) }
        : {}),
    }
  );
  return {
    cwd,
    agentDir,
    runtime,
    faux,
    progress,
    globalPath,
    projectPath,
    originalGlobal,
    originalProject,
  };
}

describe("direct child public SDK runtime", () => {
  it("refuses silently unavailable YAML tools and awaits real extension shutdown before returning", async () => {
    await expect(fixture(true, "read,unregistered_direct_fixture", true)).rejects.toThrow(
      /tool surface mismatch before model invocation/u
    );
    const root = roots.at(-1);
    if (root === undefined) throw new Error("direct admission fixture root absent");
    expect(readFileSync(path.join(root, "shutdown-marker"), "utf8")).toBe("quit");
  });

  it("enforces actual global/project false through reload, disable controls, unrelated setters, model and session replacement", async () => {
    const f = await fixture();
    try {
      const session = f.runtime.session;
      expect(session.autoCompactionEnabled).toBe(true);
      expect(session.systemPrompt).toContain("BASE FRAME SENTINEL");
      expect(session.systemPrompt).toContain("ROLE AND RESULT SENTINEL");
      expect(f.runtime.services.settingsManager).toBe(session.settingsManager);
      session.setAutoCompactionEnabled(false);
      session.settingsManager.setDefaultThinkingLevel("low");
      await session.reload();
      expect(session.autoCompactionEnabled).toBe(true);
      await session.setModel(f.faux.getModel("b") ?? f.faux.getModel());
      expect(session.settingsManager.getCompactionSettings(session.model)).toEqual({
        enabled: true,
        reserveTokens: 600,
        keepRecentTokens: 1,
      });
      expect(session.settingsManager.getBlockImages()).toBe(true);
      await f.runtime.newSession();
      expect(f.runtime.session).not.toBe(session);
      expect(f.runtime.session.systemPrompt).toContain("ROLE AND RESULT SENTINEL");
      expect(f.runtime.services.resourceLoader.getSkills().skills).toEqual([]);
      expect(f.runtime.services.resourceLoader.getPrompts().prompts).toEqual([]);
      expect(f.runtime.services.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(f.runtime.session.autoCompactionEnabled).toBe(true);
      expect(f.runtime.services.settingsManager).toBe(f.runtime.session.settingsManager);
      expect(readFileSync(f.projectPath, "utf8")).toBe(f.originalProject);
      const global: unknown = JSON.parse(readFileSync(f.globalPath, "utf8"));
      expect(global).toMatchObject({
        compaction: { enabled: false, reserveTokens: 500, keepRecentTokens: 1 },
      });
    } finally {
      await f.runtime.dispose();
    }
  });

  it("native automatic summary streams reach the direct parser and Pi print mode continues final work", async () => {
    const f = await fixture(false);
    const stdout = vi.spyOn(process.stdout, "write");
    try {
      await f.runtime.newSession({
        setup: async (manager) => {
          manager.appendMessage({
            role: "user",
            content: "old work ".repeat(3000),
            timestamp: Date.now(),
          });
          const old = fauxAssistantMessage("old complete");
          manager.appendMessage({
            ...old,
            usage: { ...old.usage, input: 3700, totalTokens: 3700 },
          });
          manager.appendMessage({ role: "user", content: "recent work", timestamp: Date.now() });
        },
      });
      await f.runtime.session.reload();
      f.faux.setResponses([
        fauxAssistantMessage("native direct summary"),
        fauxAssistantMessage("direct final work"),
      ]);
      expect(await runPrintMode(f.runtime, { mode: "json", messages: ["Finish"] })).toBe(0);
      const wire = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(wire).toContain("direct final work");
      expect(wire).toContain('"type":"compaction_end"');
      const records = wire
        .split("\n")
        .filter((line) => line.startsWith('{"type":"penny_compaction_progress"'));
      expect(records.length).toBeGreaterThan(0);
      const parserState = { toolUpdateSha256: new Map<string, string>() };
      for (const line of records) {
        const record: unknown = JSON.parse(line);
        const activity = directSubagentActivityFromPiEvent(record, new Set(), parserState);
        expect(activity?.activityClass).toBe("assistant_text_delta");
        expect(activity?.observedUnits).toBeGreaterThan(0);
        expect(line).not.toContain("native direct summary");
      }
      expect(readFileSync(f.globalPath, "utf8")).toBe(f.originalGlobal);
      expect(readFileSync(f.projectPath, "utf8")).toBe(f.originalProject);
    } finally {
      await f.runtime.dispose();
    }
  });
});
