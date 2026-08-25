import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, fn: () => unknown) => fn()),
}));

import { getFinalOutput } from "../../agent-runner.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fixture",
    model: "fixture",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 0,
  };
}

function messages(finalContent: AssistantMessage["content"]): Message[] {
  return [
    assistantMessage([{ type: "text", text: "earlier turn must not leak" }]),
    {
      role: "toolResult",
      toolCallId: "call-earlier",
      toolName: "read",
      content: [{ type: "text", text: "tool output must not leak" }],
      isError: false,
      timestamp: 0,
    },
    assistantMessage(finalContent),
  ];
}

describe("canonical finalized assistant output", () => {
  it("concatenates every final text part in order without thinking or tool calls", () => {
    const fixture = messages([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "first🙂" },
      {
        type: "toolCall",
        id: "call-final",
        name: "read",
        arguments: { path: "ignored" },
      },
      { type: "text", text: "\nsecond漢" },
      { type: "thinking", thinking: "more private reasoning" },
      { type: "text", text: '\nSUMMARY:{"complete":true}' },
    ]);

    expect(getFinalOutput(fixture)).toBe('first🙂\nsecond漢\nSUMMARY:{"complete":true}');
  });

  it("returns an empty sequence for a textless final assistant message", () => {
    const fixture = messages([
      { type: "thinking", thinking: "unfinished" },
      {
        type: "toolCall",
        id: "call-unfinished",
        name: "read",
        arguments: {},
      },
    ]);

    expect(getFinalOutput(fixture)).toBe("");
  });
});
