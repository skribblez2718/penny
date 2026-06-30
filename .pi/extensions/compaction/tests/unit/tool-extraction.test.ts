import { describe, it, expect } from "vitest";

// Re-create the extraction functions here for isolated testing
// (they are private in index.ts — testing via their public contract in hook.test.ts)

function extractToolCalls(messages: any[], maxCalls: number = 15): any[] {
  const examples: any[] = [];

  for (let i = messages.length - 1; i >= 0 && examples.length < maxCalls; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === "toolCall" && block.arguments) {
        const nextMsg = messages[i + 1];
        const isSuccess =
          nextMsg &&
          nextMsg.role === "toolResult" &&
          !nextMsg.isError &&
          !nextMsg.content?.toString().includes("failed");

        examples.push({
          tool: block.name,
          params: block.arguments,
          successful: isSuccess,
        });
        if (examples.length >= maxCalls) break;
      }
    }
  }

  return examples.reverse();
}

function extractToolErrorRecovery(messages: any[], maxPairs: number = 3): any[] {
  const pairs: any[] = [];

  for (let i = 0; i < messages.length && pairs.length < maxPairs; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== "toolCall" || !block.arguments) continue;

      const nextMsg = messages[i + 1];
      if (!nextMsg || nextMsg.role !== "toolResult" || !nextMsg.isError) {
        continue;
      }

      let foundRetry = false;
      for (let j = i + 2; j < messages.length && !foundRetry; j++) {
        const retryMsg = messages[j];
        if (retryMsg.role !== "assistant" || !Array.isArray(retryMsg.content)) continue;

        for (const retryBlock of retryMsg.content) {
          if (retryBlock.type === "toolCall" && retryBlock.name === block.name) {
            pairs.push({
              tool: block.name,
              failed_params: block.arguments,
              error_message: nextMsg.content?.toString().slice(0, 200) || "Unknown error",
              corrected_params: retryBlock.arguments,
            });
            foundRetry = true;
            break;
          }
        }
      }
    }
  }

  return pairs;
}

// ============================================================
// Fixtures
// ============================================================

const successRead = {
  role: "assistant",
  content: [
    { type: "text", text: "Reading file..." },
    { type: "toolCall", name: "read", arguments: { path: "/etc/os-release" } },
  ],
};

const successResult = {
  role: "toolResult",
  content: "NAME=Ubuntu\nVERSION=24.04",
};

const failEdit = {
  role: "assistant",
  content: [{ type: "toolCall", name: "edit", arguments: { path: "" } }],
};

const failResult = {
  role: "toolResult",
  content: "Validation failed for tool edit: edits required",
  isError: true,
};

const retryEdit = {
  role: "assistant",
  content: [
    {
      type: "toolCall",
      name: "edit",
      arguments: { path: "/tmp/test.md", edits: [{ oldText: "x", newText: "y" }] },
    },
  ],
};

const retryResult = {
  role: "toolResult",
  content: "edit ok",
};

// ============================================================
// Tests
// ============================================================

describe("extractToolCalls", () => {
  it("extracts successful tool calls", () => {
    const calls = extractToolCalls([successRead, successResult]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: "read",
      params: { path: "/etc/os-release" },
      successful: true,
    });
  });

  it("marks failed tool calls as unsuccessful", () => {
    const calls = extractToolCalls([failEdit, failResult]);
    expect(calls).toHaveLength(1);
    expect(calls[0].successful).toBe(false);
  });

  it("returns empty array when no assistant messages", () => {
    expect(extractToolCalls([])).toHaveLength(0);
    expect(extractToolCalls([{ role: "user", content: "hi" }])).toHaveLength(0);
  });

  it("respects maxCalls limit", () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({
      role: "assistant",
      content: [{ type: "toolCall", name: `tool${i}`, arguments: { i } }],
    }));
    const calls = extractToolCalls(msgs);
    expect(calls).toHaveLength(15);
  });

  it("returns calls in chronological order", () => {
    const msgs = [successRead, successResult, failEdit, failResult];
    const calls = extractToolCalls(msgs);
    expect(calls[0].tool).toBe("read");
    expect(calls[1].tool).toBe("edit");
  });
});

describe("extractToolErrorRecovery", () => {
  it("captures error → correction pair", () => {
    const pairs = extractToolErrorRecovery([failEdit, failResult, retryEdit, retryResult]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      tool: "edit",
      failed_params: { path: "" },
      error_message: expect.stringContaining("Validation failed"),
      corrected_params: { path: "/tmp/test.md", edits: [{ oldText: "x", newText: "y" }] },
    });
  });

  it("ignores success-only sequences", () => {
    const pairs = extractToolErrorRecovery([successRead, successResult]);
    expect(pairs).toHaveLength(0);
  });

  it("ignores failures without retry", () => {
    const pairs = extractToolErrorRecovery([failEdit, failResult]);
    expect(pairs).toHaveLength(0);
  });

  it("respects maxPairs limit", () => {
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(
        { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { i } }] },
        { role: "toolResult", content: "Error: failed", isError: true },
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "edit", arguments: { i, fixed: true } }],
        },
        { role: "toolResult", content: "ok" }
      );
    }
    const pairs = extractToolErrorRecovery(msgs);
    expect(pairs).toHaveLength(3);
  });
});
