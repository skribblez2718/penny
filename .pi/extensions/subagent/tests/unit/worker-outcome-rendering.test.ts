import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord } from "../../../../lib/tests/test-narrowers.js";
import type { SingleResult, SubagentDetails } from "../../agent-runner.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getMarkdownTheme: () => ({}),
}));

interface Renderable {
  render(width: number): string[];
}

interface ToolWithRenderer {
  readonly name: "subagent";
  renderResult(
    result: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails },
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown
  ): Renderable;
}

function isToolWithRenderer(value: unknown): value is ToolWithRenderer {
  return isRecord(value) && value.name === "subagent" && typeof value.renderResult === "function";
}

function branch(stopReason: string, errorMessage?: string): SingleResult {
  return {
    agent: "echo",
    agentSource: "project",
    task: "render outcome",
    exitCode: 0,
    processState: "closed",
    processExitObserved: true,
    processCloseObserved: true,
    agentEndObserved: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "partial worker output" }],
        stopReason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      },
    ],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 1,
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function plainTheme() {
  return {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
    inverse: (text: string) => text,
  };
}

describe("subagent terminal outcome rendering", () => {
  const priorStateRoot = process.env.PENNY_STATE_ROOT;

  afterEach(() => {
    if (priorStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
    else process.env.PENNY_STATE_ROOT = priorStateRoot;
  });

  it("renders an exit-zero assistant error as failed in parallel and single modes", async () => {
    let tool: ToolWithRenderer | undefined;
    const extension = await import("../../index.js");
    extension.default(
      createTestExtensionApi({
        onRegisterTool(candidate) {
          if (isToolWithRenderer(candidate)) tool = candidate;
        },
      })
    );
    if (tool === undefined) throw new Error("subagent renderer was not registered");

    const failed = branch("error", "provider failed");
    const parallel = tool.renderResult(
      {
        content: [{ type: "text", text: "fallback" }],
        details: {
          mode: "parallel",
          agentScope: "project",
          projectAgentsDir: null,
          results: [failed],
        },
      },
      { expanded: false, isPartial: false },
      plainTheme()
    );
    const parallelText = parallel.render(120).join("\n");
    expect(parallelText).toContain("0 execution completed, 0 cancelled, 1 failed");
    expect(parallelText).toContain("✗");

    const single = tool.renderResult(
      {
        content: [{ type: "text", text: "fallback" }],
        details: {
          mode: "single",
          agentScope: "project",
          projectAgentsDir: null,
          results: [failed],
        },
      },
      { expanded: false, isPartial: false },
      plainTheme()
    );
    const singleText = single.render(120).join("\n");
    expect(singleText).toContain("✗ echo");
    expect(singleText).toContain("[failed; worker=failed]");
  });

  it("renders completed terminal truth distinctly from artifact delivery failure", async () => {
    let tool: ToolWithRenderer | undefined;
    const extension = await import("../../index.js");
    extension.default(
      createTestExtensionApi({
        onRegisterTool(candidate) {
          if (isToolWithRenderer(candidate)) tool = candidate;
        },
      })
    );
    if (tool === undefined) throw new Error("subagent renderer was not registered");

    const completed = branch("stop");
    completed.outputArtifactState = "failed";
    completed.outputArtifactError = "ARTIFACT_PERSIST_FAILED: synthetic";
    const rendered = tool.renderResult(
      {
        content: [{ type: "text", text: "terminal=completed; output_delivery=failed" }],
        details: {
          mode: "single",
          agentScope: "project",
          projectAgentsDir: null,
          results: [completed],
        },
      },
      { expanded: false, isPartial: false },
      plainTheme()
    );
    const text = rendered.render(120).join("\n");
    expect(text).toContain("[failed; worker=completed]");
    expect(text).toContain("terminal=completed");
    expect(text).toContain("output_delivery=failed");
    expect(text).toContain("ARTIFACT_PERSIST_FAILED");
  });

  it("renders failed parent counts for completed chain and parallel persistence failures", async () => {
    let tool: ToolWithRenderer | undefined;
    const extension = await import("../../index.js");
    extension.default(
      createTestExtensionApi({
        onRegisterTool(candidate) {
          if (isToolWithRenderer(candidate)) tool = candidate;
        },
      })
    );
    if (tool === undefined) throw new Error("subagent renderer was not registered");

    const completed = branch("stop");
    completed.outputArtifactRequired = true;
    completed.outputArtifactState = "failed";
    completed.outputArtifactError = "ARTIFACT_PERSIST_FAILED: synthetic";

    for (const mode of ["chain", "parallel"] as const) {
      const rendered = tool.renderResult(
        {
          content: [{ type: "text", text: "fallback" }],
          details: {
            mode,
            agentScope: "project",
            projectAgentsDir: null,
            results: [completed],
          },
        },
        { expanded: false, isPartial: false },
        plainTheme()
      );
      const text = rendered.render(160).join("\n");
      expect(text).toContain("0/1 successful");
      expect(text).toContain("1 execution completed");
      expect(text).toContain("aggregate=failed");
      expect(text).toContain("terminal=completed");
      expect(text).toContain("output_delivery=failed");
    }
  });

  it("renders optional streaming failure without changing completed parent success", async () => {
    let tool: ToolWithRenderer | undefined;
    const extension = await import("../../index.js");
    extension.default(
      createTestExtensionApi({
        onRegisterTool(candidate) {
          if (isToolWithRenderer(candidate)) tool = candidate;
        },
      })
    );
    if (tool === undefined) throw new Error("subagent renderer was not registered");

    const completed = branch("stop");
    completed.updateDeliveryState = "failed";
    completed.updateDeliveryError = "update queue closed";
    const rendered = tool.renderResult(
      {
        content: [{ type: "text", text: "fallback" }],
        details: {
          mode: "single",
          agentScope: "project",
          projectAgentsDir: null,
          results: [completed],
        },
      },
      { expanded: false, isPartial: false },
      plainTheme()
    );
    const text = rendered.render(120).join("\n");
    expect(text).toContain("✓ echo");
    expect(text).toContain("[succeeded; worker=completed]");
    expect(text).toContain("streaming_update=failed");
    expect(text).toContain("Optional streaming update: update queue closed");
  });
});
