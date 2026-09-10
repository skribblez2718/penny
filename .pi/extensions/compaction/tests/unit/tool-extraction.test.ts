import { describe, it, expect } from "vitest";
import { extractToolCalls, extractToolErrorRecovery, isToolResultError } from "../../index.js";
import type { SessionMessage } from "../../pi-messages.js";

// ============================================================
// Fixtures
// ============================================================

const successRead = {
  role: "assistant",
  content: [
    { type: "text", text: "Reading file..." },
    { type: "toolCall", id: "read-success", name: "read", arguments: { path: "/etc/os-release" } },
  ],
};

const successResult = {
  role: "toolResult",
  toolName: "read",
  toolCallId: "read-success",
  content: "NAME=Ubuntu\nVERSION=24.04",
};

const failEdit = {
  role: "assistant",
  content: [{ type: "toolCall", id: "edit-failed", name: "edit", arguments: { path: "" } }],
};

const failResult = {
  role: "toolResult",
  toolName: "edit",
  toolCallId: "edit-failed",
  content: "Validation failed for tool edit: edits required",
  isError: true,
};

const retryEdit = {
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: "edit-retry",
      name: "edit",
      arguments: { path: "/tmp/test.md", edits: [{ oldText: "x", newText: "y" }] },
    },
  ],
};

const retryResult = {
  role: "toolResult",
  toolName: "edit",
  toolCallId: "edit-retry",
  content: "edit ok",
};

// ============================================================
// isToolResultError — conservative error detection
// ============================================================

describe("isToolResultError", () => {
  it("trusts explicit isError=true", () => {
    expect(isToolResultError({ role: "toolResult", content: "ok", isError: true })).toBe(true);
  });

  it("trusts explicit isError=false even when content mentions errors", () => {
    // Regression: grepping a log for "error" is a SUCCESSFUL call
    expect(
      isToolResultError({
        role: "toolResult",
        content: "grep results: 14 lines matching 'error'\napp.log:5: error: timeout failed",
        isError: false,
      })
    ).toBe(false);
  });

  it("does not flag error-shaped data when isError is absent", () => {
    // Content contains 'failed'/'timeout' mid-text but is not an error report
    expect(
      isToolResultError({
        role: "toolResult",
        content: "Test summary: 3 failed, 2 timeout warnings in app.log",
      })
    ).toBe(false);
  });

  it("flags error-report-shaped content when isError is absent", () => {
    expect(isToolResultError({ role: "toolResult", content: "Error: ENOENT no such file" })).toBe(
      true
    );
    expect(
      isToolResultError({ role: "toolResult", content: "Validation failed for tool edit" })
    ).toBe(true);
  });

  it("returns false for non-toolResult messages", () => {
    expect(isToolResultError({ role: "assistant", content: "Error: nope" })).toBe(false);
    // Exercise malformed JavaScript boundary input even though typed callers cannot provide null.
    expect(Reflect.apply(isToolResultError, undefined, [null])).toBe(false);
  });
});

// ============================================================
// extractToolCalls
// ============================================================

describe("extractToolCalls", () => {
  it("extracts successful tool calls with verbatim params", () => {
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

  it("does NOT mark a call failed because its result mentions 'failed'", () => {
    // Regression: the old substring heuristic corrupted the teaching examples
    const grepCall = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "grep-failed-text",
          name: "grep",
          arguments: { pattern: "failed" },
        },
      ],
    };
    const grepResult = {
      role: "toolResult",
      toolName: "grep",
      toolCallId: "grep-failed-text",
      content: "src/a.ts:12: // retry when request failed",
      isError: false,
    };
    const calls = extractToolCalls([grepCall, grepResult]);
    expect(calls[0].successful).toBe(true);
  });

  it("returns empty array when no assistant messages", () => {
    expect(extractToolCalls([])).toHaveLength(0);
    expect(extractToolCalls([{ role: "user", content: "hi" }])).toHaveLength(0);
  });

  it("respects maxCalls limit", () => {
    const msgs: SessionMessage[] = [];
    for (let index = 0; index < 40; index++) {
      const id = `tool-call-${index}`;
      const tool = `tool${index}`;
      msgs.push(
        {
          role: "assistant",
          content: [{ type: "toolCall", id, name: tool, arguments: { index } }],
        },
        { role: "toolResult", toolName: tool, toolCallId: id, content: "ok" }
      );
    }
    const calls = extractToolCalls(msgs);
    expect(calls).toHaveLength(15);
    expect(calls[0].tool).toBe("tool25");
  });

  it("returns calls in chronological order", () => {
    const msgs = [successRead, successResult, failEdit, failResult];
    const calls = extractToolCalls(msgs);
    expect(calls[0].tool).toBe("read");
    expect(calls[1].tool).toBe("edit");
  });

  it("pairs multi-call out-of-order results by exact unique toolCallId", () => {
    const calls = extractToolCalls([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "read-a", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", id: "edit-b", name: "edit", arguments: { path: "b.ts" } },
        ],
      },
      {
        role: "toolResult",
        toolName: "edit",
        toolCallId: "edit-b",
        content: "Error: stale edit",
        isError: true,
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-a",
        content: "export const ok = true;",
        isError: false,
      },
    ]);

    expect(calls).toEqual([
      { tool: "read", params: { path: "a.ts" }, successful: true },
      { tool: "edit", params: { path: "b.ts" }, successful: false },
    ]);
  });

  it("omits unmatched and ambiguous IDs instead of borrowing nearby results", () => {
    const calls = extractToolCalls([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "unmatched", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", id: "duplicate", name: "grep", arguments: { pattern: "x" } },
        ],
      },
      { role: "toolResult", toolName: "read", toolCallId: "other", content: "nearby" },
      { role: "toolResult", toolName: "grep", toolCallId: "duplicate", content: "first" },
      { role: "toolResult", toolName: "grep", toolCallId: "duplicate", content: "second" },
    ]);

    expect(calls).toEqual([]);
  });
});

// ============================================================
// extractToolErrorRecovery
// ============================================================

describe("extractToolErrorRecovery", () => {
  it("captures error → correction pair", () => {
    const pairs = extractToolErrorRecovery([failEdit, failResult, retryEdit, retryResult]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      tool: "edit",
      failed_params: { path: "" },
      corrected_params: { path: "/tmp/test.md", edits: [{ oldText: "x", newText: "y" }] },
    });
    expect(pairs[0].error_message).toContain("Validation failed");
  });

  it("ignores success-only sequences", () => {
    const pairs = extractToolErrorRecovery([successRead, successResult]);
    expect(pairs).toHaveLength(0);
  });

  it("does not manufacture pairs from successful calls whose output mentions errors", () => {
    const grepCall = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "grep-first", name: "grep", arguments: { pattern: "error" } },
      ],
    };
    const grepResult = {
      role: "toolResult",
      toolName: "grep",
      toolCallId: "grep-first",
      content: "app.log:3: error: connection reset",
      isError: false,
    };
    const laterGrep = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "grep-later",
          name: "grep",
          arguments: { pattern: "error", path: "src" },
        },
      ],
    };
    const laterResult = {
      role: "toolResult",
      toolName: "grep",
      toolCallId: "grep-later",
      content: "ok",
      isError: false,
    };
    const pairs = extractToolErrorRecovery([grepCall, grepResult, laterGrep, laterResult]);
    expect(pairs).toHaveLength(0);
  });

  it("ignores failures without retry", () => {
    const pairs = extractToolErrorRecovery([failEdit, failResult]);
    expect(pairs).toHaveLength(0);
  });

  it("binds both the failed attempt and successful retry through their exact results", () => {
    const pairs = extractToolErrorRecovery([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "edit-original", name: "edit", arguments: { path: "bad" } },
          { type: "toolCall", id: "read-interleaved", name: "read", arguments: { path: "x" } },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-interleaved",
        content: "ok",
        isError: false,
      },
      {
        role: "toolResult",
        toolName: "edit",
        toolCallId: "edit-original",
        content: "Error: exact original failure",
        isError: true,
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "edit-still-bad", name: "edit", arguments: { path: "bad-2" } },
          { type: "toolCall", id: "edit-fixed", name: "edit", arguments: { path: "fixed" } },
        ],
      },
      {
        role: "toolResult",
        toolName: "edit",
        toolCallId: "edit-fixed",
        content: "saved",
        isError: false,
      },
      {
        role: "toolResult",
        toolName: "edit",
        toolCallId: "edit-still-bad",
        content: "Error: retry also failed",
        isError: true,
      },
    ]);

    expect(pairs).toEqual([
      {
        tool: "edit",
        failed_params: { path: "bad" },
        error_message: "Error: exact original failure",
        corrected_params: { path: "fixed" },
      },
    ]);
  });

  it("omits recovery when the later same-tool call has no exact successful result", () => {
    const pairs = extractToolErrorRecovery([
      failEdit,
      failResult,
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "unmatched-retry", name: "edit", arguments: { path: "fixed" } },
        ],
      },
      { role: "toolResult", toolName: "edit", toolCallId: "different", content: "ok" },
    ]);
    expect(pairs).toEqual([]);
  });

  it("respects maxPairs limit", () => {
    const msgs: SessionMessage[] = [];
    for (let i = 0; i < 10; i++) {
      const failedId = `edit-failed-${i}`;
      const retryId = `edit-retry-${i}`;
      msgs.push(
        {
          role: "assistant",
          content: [{ type: "toolCall", id: failedId, name: "edit", arguments: { i } }],
        },
        {
          role: "toolResult",
          toolName: "edit",
          toolCallId: failedId,
          content: "Error: failed",
          isError: true,
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: retryId, name: "edit", arguments: { i, fixed: true } }],
        },
        { role: "toolResult", toolName: "edit", toolCallId: retryId, content: "ok" }
      );
    }
    const pairs = extractToolErrorRecovery(msgs);
    expect(pairs).toHaveLength(3);
  });
});
