import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import { adaptPiJsonMessage } from "../../agent-runner.js";
import { createAgentNameSchema, readHostToolNames } from "../../index.js";

describe("subagent production-boundary interop", () => {
  it("reads the current host tool catalog and preserves the legacy absent-host fallback", () => {
    expect(readHostToolNames({ registerTool() {} })).toBeUndefined();

    const names = readHostToolNames({
      getAllTools: () => [{ name: "read" }, { name: "artifact_read" }],
    });
    expect(names).toEqual(new Set(["read", "artifact_read"]));

    expect(() => readHostToolNames({ getAllTools: () => [{ label: "missing-name" }] })).toThrow(
      /TOOL_PROVIDER_CATALOG_INVALID/
    );
  });

  it("accepts Pi JSON assistant and tool-result messages without rewriting them", () => {
    const assistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "final" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      ],
      usage: {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 17,
        cost: { total: 0.25 },
      },
      model: "fixture-model",
      stopReason: "toolUse",
      timestamp: 1_000,
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      details: { source: "fixture" },
      isError: false,
      timestamp: 1_001,
    };

    expect(adaptPiJsonMessage(assistant)).toBe(assistant);
    expect(adaptPiJsonMessage(toolResult)).toBe(toolResult);
    expect(adaptPiJsonMessage({ role: "assistant", content: "not-an-array" })).toBeUndefined();
    expect(
      adaptPiJsonMessage({ role: "toolResult", content: [], isError: "not-a-boolean" })
    ).toBeUndefined();
  });

  it("accepts nonempty names without freezing a provider enum; runtime discovery owns existence", () => {
    const schema = createAgentNameSchema();

    expect(Value.Check(schema, "echo")).toBe(true);
    expect(Value.Check(schema, "newly-added-agent")).toBe(true);
    expect(Value.Check(schema, "")).toBe(false);
    expect(Value.Check(schema, 42)).toBe(false);
  });
});
