import { describe, expect, it } from "vitest";

import {
  directSubagentActivityFromPiEvent,
  type DirectSubagentProgressStateV1,
} from "../../agent-runner.js";

function state(): DirectSubagentProgressStateV1 {
  return { toolUpdateSha256: new Map() };
}

describe("direct subagent trusted progress projection", () => {
  it("accepts non-empty assistant and thinking deltas without retaining their bodies", () => {
    const progress = state();
    expect(
      directSubagentActivityFromPiEvent(
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "secret body" },
        },
        new Set(),
        progress
      )
    ).toEqual({ activityClass: "assistant_text_delta", observedUnits: 11 });
    expect(
      directSubagentActivityFromPiEvent(
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "x" },
        },
        new Set(),
        progress
      )
    ).toEqual({ activityClass: "assistant_thinking_delta", observedUnits: 1 });
    expect(
      directSubagentActivityFromPiEvent(
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "" },
        },
        new Set(),
        progress
      )
    ).toBeUndefined();
  });

  it("renews only for admitted changed tool activity", () => {
    const progress = state();
    const tools = new Set(["read"]);
    expect(
      directSubagentActivityFromPiEvent(
        { type: "tool_execution_start", toolName: "shell" },
        tools,
        progress
      )
    ).toBeUndefined();
    expect(
      directSubagentActivityFromPiEvent(
        {
          type: "tool_execution_update",
          toolName: "read",
          toolCallId: "call-1",
          partialResult: { count: 1 },
        },
        tools,
        progress
      )
    ).toMatchObject({ activityClass: "tool_execution_updated" });
    expect(
      directSubagentActivityFromPiEvent(
        {
          type: "tool_execution_update",
          toolName: "read",
          toolCallId: "call-1",
          partialResult: { count: 1 },
        },
        tools,
        progress
      )
    ).toBeUndefined();
    expect(
      directSubagentActivityFromPiEvent(
        { type: "tool_execution_end", toolName: "read", toolCallId: "call-1" },
        tools,
        progress
      )
    ).toEqual({ activityClass: "tool_execution_completed", observedUnits: 1 });
  });

  it("accepts terminal provider and worker progress", () => {
    const progress = state();
    expect(
      directSubagentActivityFromPiEvent(
        { type: "message_end", message: { role: "assistant" } },
        new Set(),
        progress
      )
    ).toEqual({ activityClass: "provider_turn_ended", observedUnits: 1 });
    expect(directSubagentActivityFromPiEvent({ type: "agent_end" }, new Set(), progress)).toEqual({
      activityClass: "worker_completed",
      observedUnits: 1,
    });
  });
});
