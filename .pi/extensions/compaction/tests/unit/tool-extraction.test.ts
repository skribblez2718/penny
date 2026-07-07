import { describe, it, expect } from "vitest";
import { extractToolCalls, extractToolErrorRecovery, isToolResultError } from "../../index.js";

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
    expect(isToolResultError(null)).toBe(false);
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
      content: [{ type: "toolCall", name: "grep", arguments: { pattern: "failed" } }],
    };
    const grepResult = {
      role: "toolResult",
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
      error_message: expect.stringContaining("Validation failed"),
      corrected_params: { path: "/tmp/test.md", edits: [{ oldText: "x", newText: "y" }] },
    });
  });

  it("ignores success-only sequences", () => {
    const pairs = extractToolErrorRecovery([successRead, successResult]);
    expect(pairs).toHaveLength(0);
  });

  it("does not manufacture pairs from successful calls whose output mentions errors", () => {
    const grepCall = {
      role: "assistant",
      content: [{ type: "toolCall", name: "grep", arguments: { pattern: "error" } }],
    };
    const grepResult = {
      role: "toolResult",
      content: "app.log:3: error: connection reset",
      isError: false,
    };
    const laterGrep = {
      role: "assistant",
      content: [{ type: "toolCall", name: "grep", arguments: { pattern: "error", path: "src" } }],
    };
    const pairs = extractToolErrorRecovery([grepCall, grepResult, laterGrep, successResult]);
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
