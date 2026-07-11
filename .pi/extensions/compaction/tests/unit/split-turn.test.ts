import { describe, it, expect } from "vitest";
import {
  detectDominantSkill,
  extractSessionState,
  extractToolCalls,
  extractToolErrorRecovery,
} from "../../index.js";

// ============================================================
// Split-turn coverage: every message-derived extraction path must read the
// MERGED [messagesToSummarize, ...turnPrefixMessages] window. These tests
// exercise the merged array directly (the handler does the concatenation).
// ============================================================

function mergeWindows(messagesToSummarize: any[], turnPrefixMessages: any[]): any[] {
  return [...messagesToSummarize, ...turnPrefixMessages];
}

describe("split-turn merged-window extraction", () => {
  it("derives a non-default goal when messagesToSummarize=[] and only turnPrefixMessages is populated", () => {
    const merged = mergeWindows(
      [],
      [{ role: "user", content: "Refactor the eviction algorithm for recency weighting" }]
    );
    const state = extractSessionState(merged, null);
    expect(state.goal).toBe("Refactor the eviction algorithm for recency weighting");
    expect(state.goal).not.toContain("goal not yet extracted");
  });

  it("treats a user message in turnPrefixMessages as NEWER than one in messagesToSummarize", () => {
    // turnPrefixMessages is the (newer) start of the split turn, so its user
    // message is the latest substantive intent.
    const merged = mergeWindows(
      [{ role: "user", content: "Implement the schema 2.1.0 additive bump" }],
      [{ role: "user", content: "Actually pivot to the boundary_shift population work" }]
    );
    const state = extractSessionState(merged, null);
    expect(state.goal).toBe("Actually pivot to the boundary_shift population work");
  });

  it("detects a skill call that lives in the turnPrefix window", () => {
    const merged = mergeWindows(
      [],
      [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "skill",
              arguments: { skill_name: "code", goal: "Fix compaction goal recency" },
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "skill",
          toolCallId: "tc-1",
          content: '{"success":false,"session_id":"code-9"}',
        },
      ]
    );
    const dominant = detectDominantSkill(merged);
    expect(dominant).not.toBeNull();
    expect(dominant!.skill_name).toBe("code");
    expect(dominant!.session_id).toBe("code-9");
  });

  it("extracts tool-call examples spanning both windows", () => {
    const merged = mergeWindows(
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "a", name: "read", arguments: { path: "/a" } }],
        },
        { role: "toolResult", toolName: "read", toolCallId: "a", isError: false, content: "ok" },
      ],
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "b", name: "edit", arguments: { path: "/b" } }],
        },
        { role: "toolResult", toolName: "edit", toolCallId: "b", isError: false, content: "ok" },
      ]
    );
    const calls = extractToolCalls(merged);
    const tools = calls.map((c) => c.tool);
    expect(tools).toContain("read");
    expect(tools).toContain("edit");
  });

  it("extracts an error→correction pair spanning both windows", () => {
    const merged = mergeWindows(
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "x", name: "edit", arguments: { path: "" } }],
        },
        {
          role: "toolResult",
          toolName: "edit",
          toolCallId: "x",
          isError: true,
          content: "Validation failed",
        },
      ],
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "y", name: "edit", arguments: { path: "/fixed" } }],
        },
        { role: "toolResult", toolName: "edit", toolCallId: "y", isError: false, content: "ok" },
      ]
    );
    const pairs = extractToolErrorRecovery(merged);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].tool).toBe("edit");
    expect(pairs[0].corrected_params).toEqual({ path: "/fixed" });
  });

  it("edge: both windows empty yields an empty (default-eligible) extraction, never a crash", () => {
    const state = extractSessionState([], null);
    expect(state.goal).toBe("");
    expect(state.constraints).toEqual([]);
    expect(state.superseded).toBe(false);
  });
});
