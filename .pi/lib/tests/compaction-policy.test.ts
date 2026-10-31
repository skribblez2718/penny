import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compactionDeltaProgress,
  createCompactionProgressObserver,
  enforceNativeAutoCompaction,
  isCompactionProgress,
} from "../compaction-policy.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const compaction = {
  enabled: false,
  reserveTokens: 1234,
  keepRecentTokens: 321,
  modelOverrides: { "test/a": { reserveTokens: 4321 }, "test/b": { keepRecentTokens: 456 } },
};

async function assertPolicy(manager: SettingsManager) {
  expect(enforceNativeAutoCompaction(manager)).toBe(manager);
  expect(enforceNativeAutoCompaction(manager)).toBe(manager);
  const check = () => {
    expect(manager.getCompactionEnabled()).toBe(true);
    expect(manager.getCompactionSettings({ provider: "test", id: "a" })).toEqual({
      enabled: true,
      reserveTokens: 4321,
      keepRecentTokens: 321,
    });
    expect(manager.getCompactionSettings({ provider: "test", id: "b" })).toEqual({
      enabled: true,
      reserveTokens: 1234,
      keepRecentTokens: 456,
    });
    expect(manager.getRetryEnabled()).toBe(false);
  };
  check();
  manager.applyOverrides({ compaction: { enabled: false } });
  check();
  manager.setCompactionEnabled(false);
  manager.setDefaultThinkingLevel("high");
  check();
  await manager.reload();
  check();
}

describe("always-enabled native compaction policy", () => {
  it("enforces the actual injected manager across overrides, setters, reload and model-specific reads", async () => {
    await assertPolicy(SettingsManager.inMemory({ compaction, retry: { enabled: false } }));
  });

  it("ignores global/project false without writing either scope or losing preferences", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-compaction-settings-"));
    roots.push(root);
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    mkdirSync(agentDir);
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    const globalPath = path.join(agentDir, "settings.json");
    const projectPath = path.join(cwd, ".pi/settings.json");
    const global = { compaction, retry: { enabled: false }, theme: "fixture-theme" };
    const project = { compaction: { enabled: false }, images: { blockImages: true } };
    writeFileSync(globalPath, JSON.stringify(global));
    writeFileSync(projectPath, JSON.stringify(project));
    const manager = enforceNativeAutoCompaction(SettingsManager.create(cwd, agentDir));
    expect(manager.getCompactionSettings({ provider: "test", id: "a" })).toEqual({
      enabled: true,
      reserveTokens: 4321,
      keepRecentTokens: 321,
    });
    manager.setCompactionEnabled(false);
    await manager.reload();
    manager.setProjectTrusted(false);
    expect(manager.getCompactionEnabled()).toBe(true);
    manager.setProjectTrusted(true);
    expect(manager.getCompactionEnabled()).toBe(true);
    expect(manager.getTheme()).toBe("fixture-theme");
    expect(manager.getBlockImages()).toBe(true);
    await manager.flush();
    expect(readFileSync(globalPath, "utf8")).toBe(JSON.stringify(global));
    expect(readFileSync(projectPath, "utf8")).toBe(JSON.stringify(project));
    await assertPolicy(manager);
  });

  it("admits only positive, bounded, content-free real text/thinking deltas", () => {
    expect(compactionDeltaProgress({ type: "text_delta", delta: "private" })).toEqual({
      activity_class: "assistant_text_delta",
      observed_units: 7,
    });
    expect(compactionDeltaProgress({ type: "thinking_delta", delta: "é" })).toEqual({
      activity_class: "assistant_thinking_delta",
      observed_units: 2,
    });
    for (const event of [
      { type: "text_delta", delta: "" },
      { type: "start" },
      { type: "toolcall_delta", delta: "x" },
      null,
    ])
      expect(compactionDeltaProgress(event)).toBeUndefined();
    expect(
      isCompactionProgress({ activity_class: "assistant_text_delta", observed_units: 1 })
    ).toBe(true);
    for (const observed_units of [0, -1, Infinity, 1.5, 16_777_217])
      expect(isCompactionProgress({ activity_class: "assistant_text_delta", observed_units })).toBe(
        false
      );
    expect(
      isCompactionProgress({
        activity_class: "assistant_text_delta",
        observed_units: 1,
        body: "secret",
      })
    ).toBe(false);
  });
  it("never injects an observer into inline or lookalike producer modules, nor adds a producer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-progress-identity-"));
    roots.push(root);
    const lookalike = path.join(root, "compaction/index.ts");
    mkdirSync(path.dirname(lookalike));
    writeFileSync(lookalike, "// Not Penny's producer");
    const producer = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          pi.on("session_before_compact", producer);
        },
      ],
    });
    await loader.reload();
    const base = loader.getExtensions();
    const extension = base.extensions[0];
    if (!extension) throw new Error("missing inline fixture");
    const observer = createCompactionProgressObserver(vi.fn());
    for (const resolvedPath of [extension.resolvedPath, lookalike]) {
      const input = { ...base, extensions: [{ ...extension, resolvedPath }] };
      const bound = observer.extensionsOverride(input);
      expect(bound.extensions).toHaveLength(1);
      expect(bound.extensions[0]).toBe(input.extensions[0]);
      const handler = bound.extensions[0]?.handlers.get("session_before_compact")?.[0];
      if (!handler) throw new Error("missing fixture handler");
      await handler({}, {});
      expect(producer.mock.calls.at(-1)).toHaveLength(2);
    }
    expect(observer.extensionsOverride({ ...base, extensions: [] }).extensions).toEqual([]);
  });
});
