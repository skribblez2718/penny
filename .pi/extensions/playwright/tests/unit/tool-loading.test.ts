import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  configuredPrimaryGroups,
  initialPrimaryToolNames,
  isUnmarkedPrimaryRuntime,
  PLAYWRIGHT_CORE_TOOLS,
  PLAYWRIGHT_LOADER_TOOL,
  PLAYWRIGHT_TOOL_GROUPS,
  registerPlaywrightToolLoader,
  toolsForGroups,
  type LoadToolsParams,
} from "../../tool-loading.js";
import type { PlaywrightConfig } from "../../types.js";
import { createTestExtensionApi, isRecord } from "../../../../lib/tests/test-narrowers.js";

interface RegisteredLoaderTool {
  execute(toolCallId: string, params: LoadToolsParams): Promise<{ details: { added: string[] } }>;
}

function isRegisteredLoaderTool(value: unknown): value is RegisteredLoaderTool {
  return isRecord(value) && typeof value.execute === "function";
}

function testConfig(overrides: Partial<PlaywrightConfig> = {}): PlaywrightConfig {
  return {
    headless: true,
    timeout: 30_000,
    networkAllowlist: [],
    downloadDir: "/tmp",
    outputDir: "/tmp",
    enableVision: false,
    enableDevtools: false,
    enableNetwork: false,
    enableStorage: false,
    allowUnsafe: false,
    ignoreHTTPSErrors: false,
    ...overrides,
  };
}

function sourceRegisteredTools(): string[] {
  const toolsDirectory = path.resolve(process.cwd(), "tools");
  return fs
    .readdirSync(toolsDirectory)
    .filter((name) => name.endsWith(".ts"))
    .flatMap((name) => {
      const source = fs.readFileSync(path.join(toolsDirectory, name), "utf-8");
      return [...source.matchAll(/\bname:\s*"(playwright_[a-z0-9_]+)"/g)].map((match) => match[1]);
    })
    .sort();
}

describe("Playwright dynamic tool loading", () => {
  it("covers every registered Playwright operation exactly once", () => {
    const covered = [
      ...PLAYWRIGHT_CORE_TOOLS,
      ...Object.values(PLAYWRIGHT_TOOL_GROUPS).flatMap((names) => [...names]),
    ];

    expect([...new Set(covered)].sort()).toEqual(sourceRegisteredTools());
    expect(covered).toHaveLength(new Set(covered).size);
  });

  it("keeps non-Playwright tools plus the browser core and loader active initially", () => {
    const active = [
      "read",
      PLAYWRIGHT_LOADER_TOOL,
      "playwright_navigate",
      "playwright_click",
      "playwright_run_code_unsafe",
    ];

    expect(initialPrimaryToolNames(active)).toEqual([
      "read",
      PLAYWRIGHT_LOADER_TOOL,
      "playwright_navigate",
    ]);
  });

  it("applies primary reduction only to the unmarked runtime", () => {
    expect(isUnmarkedPrimaryRuntime({})).toBe(true);
    expect(isUnmarkedPrimaryRuntime({ PENNY_RUNTIME_ROLE: "worker" })).toBe(false);
    expect(isUnmarkedPrimaryRuntime({ PENNY_RUNTIME_ROLE: "worker-read" })).toBe(false);
  });

  it("pre-enables capability groups selected by existing configuration", () => {
    const config = testConfig({
      enableNetwork: true,
      enableVision: true,
    });
    const groups = configuredPrimaryGroups(config);
    expect(groups).toEqual(["network", "vision"]);

    const active = initialPrimaryToolNames(
      ["read", PLAYWRIGHT_LOADER_TOOL, "playwright_route", "playwright_mouse_move_xy"],
      groups
    );
    expect(active).toContain("playwright_route");
    expect(active).toContain("playwright_mouse_move_xy");
  });

  it("selects narrow groups without duplicates and expands all in declaration order", () => {
    const selected = toolsForGroups(["interact", "storage", "interact"]);
    expect(selected).toContain("playwright_click");
    expect(selected).toContain("playwright_cookies");
    expect(selected).toHaveLength(new Set(selected).size);

    const all = toolsForGroups(["all"]);
    expect(all).toEqual(Object.values(PLAYWRIGHT_TOOL_GROUPS).flatMap((names) => [...names]));
    expect(all).toHaveLength(new Set(all).size);
  });

  it("loads requested groups additively", async () => {
    let active = ["read", PLAYWRIGHT_LOADER_TOOL, "playwright_navigate"];
    let registered: RegisteredLoaderTool | undefined;
    const pi = createTestExtensionApi({
      onRegisterTool(tool) {
        if (!isRegisteredLoaderTool(tool)) {
          throw new Error("Playwright registered an invalid loader tool");
        }
        registered = tool;
      },
      getActiveTools: () => [...active],
      onSetActiveTools: (names) => {
        active = names;
      },
    });

    registerPlaywrightToolLoader(pi);
    if (registered === undefined) throw new Error("Playwright loader tool was not registered");
    const result = await registered.execute("call-1", { groups: ["interact"] });

    expect(active).toContain("read");
    expect(active).toContain("playwright_navigate");
    expect(active).toContain("playwright_click");
    expect(active).not.toContain("playwright_run_code_unsafe");
    expect(result.details.added).toContain("playwright_click");
  });
});
