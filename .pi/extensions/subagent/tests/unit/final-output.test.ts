import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, fn: () => unknown) => fn()),
}));

import { getFinalOutput } from "../../agent-runner.js";

function messages(finalContent: Array<Record<string, unknown>>): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "text", text: "earlier turn must not leak" }],
    },
    {
      role: "toolResult",
      toolCallId: "call-earlier",
      toolName: "read",
      content: [{ type: "text", text: "tool output must not leak" }],
      isError: false,
    },
    {
      role: "assistant",
      content: finalContent,
    },
  ] as unknown as Message[];
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
