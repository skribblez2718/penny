/** Fresh per-invocation catalog admission; no provider calls or retained-state mutations. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestExtensionApi, createTestToolInfos } from "../../../../lib/tests/pi-test-host.js";
import { isRecord } from "../../../../lib/tests/test-narrowers.js";

type RunSingleAgent = typeof import("../../agent-runner.js").runSingleAgent;
const { mockRunSingleAgent } = vi.hoisted(() => ({
  mockRunSingleAgent: vi.fn<RunSingleAgent>(),
}));
vi.mock("../../agent-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent-runner.js")>()),
  runSingleAgent: mockRunSingleAgent,
}));

interface RegisteredTool {
  description: string;
  parameters: { properties: Record<string, unknown> };
  execute: (...args: unknown[]) => Promise<unknown>;
}
let projectRoot: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
function writeAgent(name: string, description: string, tools = "read,grep"): void {
  fs.writeFileSync(
    path.join(projectRoot, ".pi", "agents", `${name}.md`),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      `tools: ${tools}`,
      "model: fixture-model",
      "thinking: high",
      "---",
      `# ${name}`,
      description,
    ].join("\n")
  );
}
function isRegisteredTool(value: unknown): value is RegisteredTool {
  return (
    isRecord(value) &&
    typeof value.description === "string" &&
    isRecord(value.parameters) &&
    isRecord(value.parameters.properties) &&
    typeof value.execute === "function"
  );
}
async function register(): Promise<RegisteredTool> {
  let tool: RegisteredTool | undefined;
  const extension = await import("../../index.js");
  extension.default(
    createTestExtensionApi({
      getAllTools: () => createTestToolInfos(["read", "grep", "bash"]),
      onRegisterTool(value) {
        if (!isRegisteredTool(value)) throw new Error("Invalid registered subagent tool");
        tool = value;
      },
    })
  );
  if (tool === undefined) throw new Error("Missing subagent tool");
  return tool;
}
function invoke(tool: RegisteredTool, params: Record<string, unknown>): Promise<unknown> {
  return tool.execute("fresh-catalog", params, undefined, undefined, {
    cwd: projectRoot,
    hasUI: false,
  });
}
beforeEach(() => {
  vi.resetModules();
  mockRunSingleAgent.mockReset();
  // Stop exactly at the dispatch boundary: assert fresh config without claiming model/output success.
  mockRunSingleAgent.mockRejectedValue(new Error("FRESH_DISPATCH_OBSERVED"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penny-agent-catalog-"));
  fs.mkdirSync(path.join(projectRoot, ".pi", "agents"), { recursive: true });
  writeAgent("alpha", "Initial alpha specialty");
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
});
afterEach(() => {
  cwdSpy.mockRestore();
  fs.rmSync(projectRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe("current catalog without reload blocking", () => {
  it("accepts a newly added name without re-registering a stale provider enum", async () => {
    const tool = await register();
    expect(tool.description).not.toContain("beta:");
    expect(tool.parameters.properties.agent).toMatchObject({ type: "string", minLength: 1 });
    writeAgent("beta", "New beta specialty");
    await expect(invoke(tool, { agent: "beta", task: "Use the current role" })).rejects.toThrow(
      "FRESH_DISPATCH_OBSERVED"
    );
    expect(mockRunSingleAgent.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "beta", description: "New beta specialty" }),
      ])
    );
    expect(mockRunSingleAgent.mock.calls[0]?.[2]).toBe("beta");
  });

  it.each([
    { agent: "alpha", task: "current role" },
    { tasks: [{ agent: "alpha", task: "current role" }] },
    { chain: [{ agent: "alpha", task: "current role" }] },
  ])("uses fresh prompt/model/thinking/tools in each public mode: %j", async (params) => {
    const tool = await register();
    writeAgent("alpha", "Updated role body", "read,bash");
    const file = path.join(projectRoot, ".pi", "agents", "alpha.md");
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace("fixture-model", "updated-model")
        .replace("thinking: high", "thinking: low")
    );
    await expect(invoke(tool, params)).rejects.toThrow("FRESH_DISPATCH_OBSERVED");
    expect(mockRunSingleAgent.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        name: "alpha",
        model: "updated-model",
        thinking: "low",
        tools: ["read", "bash"],
      }),
    ]);
    expect(mockRunSingleAgent.mock.calls[0]?.[1][0]?.systemPrompt).toContain("Updated role body");
  });

  it("does not block unchanged requested agents because an unrelated agent was added", async () => {
    const tool = await register();
    writeAgent("beta", "Unrelated role");
    await expect(invoke(tool, { agent: "alpha", task: "current role" })).rejects.toThrow(
      "FRESH_DISPATCH_OBSERVED"
    );
    expect(mockRunSingleAgent).toHaveBeenCalledOnce();
  });

  it("refuses removed/unknown names before dispatch, even though strings pass the provider schema", async () => {
    const tool = await register();
    fs.unlinkSync(path.join(projectRoot, ".pi", "agents", "alpha.md"));
    const result = await invoke(tool, { agent: "alpha", task: "missing role" });
    expect(result).toMatchObject({ isError: true });
    expect(result).toHaveProperty("content.0.text", expect.stringContaining("AGENT_NOT_FOUND"));
    expect(mockRunSingleAgent).not.toHaveBeenCalled();
  });

  it("still refuses an unavailable tool in freshly edited YAML before dispatch", async () => {
    const tool = await register();
    writeAgent("alpha", "Edited tools", "read,unregistered_tool");
    const result = await invoke(tool, { agent: "alpha", task: "must not dispatch" });
    expect(result).toMatchObject({ isError: true });
    expect(result).toHaveProperty(
      "content.0.text",
      expect.stringContaining("TOOL_PROVIDER_MISSING")
    );
    expect(mockRunSingleAgent).not.toHaveBeenCalled();
  });
});
