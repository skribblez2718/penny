/**
 * Unit tests for session transcript serialization.
 *
 * Entries are plain objects shaped like pi's SessionEntry — no pi runtime.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_MAX_CHARS,
  TOOL_RESULT_MAX_CHARS,
  buildTranscript,
  contextMaxChars,
  serializeContent,
  serializeEntry,
  serializeMessage,
  transcriptFromSession,
} from "../../transcript.js";

function userEntry(text: string) {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantEntry(content: unknown[]) {
  return { type: "message", message: { role: "assistant", content } };
}

beforeEach(() => {
  delete process.env.PENNY_ENHANCE_CONTEXT_MAX_CHARS;
});

describe("serializeContent", () => {
  it("passes a plain string through", () => {
    expect(serializeContent("hello")).toBe("hello");
  });

  it("joins text parts and marks images", () => {
    expect(
      serializeContent([
        { type: "text", text: "look at this" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ])
    ).toBe("look at this\n[image omitted]");
  });

  it("drops thinking blocks (scratchpad, not conversation)", () => {
    expect(
      serializeContent([
        { type: "thinking", thinking: "secret internal reasoning" },
        { type: "text", text: "the answer" },
      ])
    ).toBe("the answer");
  });

  it("renders tool calls with name and arguments", () => {
    const out = serializeContent([
      { type: "toolCall", id: "1", name: "Read", arguments: { path: "/tmp/a.ts" } },
    ]);
    expect(out).toBe('[tool call: Read] {"path":"/tmp/a.ts"}');
  });

  it("survives unserializable tool arguments", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = serializeContent([{ type: "toolCall", id: "1", name: "X", arguments: circular }]);
    expect(out).toContain("[unserializable arguments]");
  });

  it("returns empty for null/undefined/garbage", () => {
    expect(serializeContent(null)).toBe("");
    expect(serializeContent(undefined)).toBe("");
    expect(serializeContent([null as never, 42 as never])).toBe("");
  });
});

describe("serializeMessage", () => {
  it("labels user and assistant turns", () => {
    expect(serializeMessage({ role: "user", content: "hi" })).toBe("### User\nhi");
    expect(serializeMessage({ role: "assistant", content: "yo" })).toBe("### Penny\nyo");
  });

  it("labels tool results and flags errors", () => {
    expect(serializeMessage({ role: "toolResult", toolName: "Read", content: "data" })).toBe(
      "### Tool result: Read\ndata"
    );
    expect(
      serializeMessage({ role: "toolResult", toolName: "Bash", content: "boom", isError: true })
    ).toBe("### Tool result: Bash (error)\nboom");
  });

  it("caps an oversized tool result but keeps the head", () => {
    const huge = "x".repeat(TOOL_RESULT_MAX_CHARS + 5_000);
    const out = serializeMessage({ role: "toolResult", toolName: "Read", content: huge });
    expect(out).toContain("truncated, 5000 more chars");
    expect(out?.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 200);
  });

  it("renders bash executions but honors excludeFromContext", () => {
    expect(
      serializeMessage({ role: "bashExecution", command: "ls", output: "a.ts", exitCode: 0 })
    ).toBe("### Bash: ls (exit 0)\na.ts");
    expect(
      serializeMessage({
        role: "bashExecution",
        command: "secret",
        output: "x",
        excludeFromContext: true,
      })
    ).toBeNull();
  });

  it("renders compaction and branch summaries", () => {
    expect(serializeMessage({ role: "compactionSummary", summary: "earlier stuff" })).toBe(
      "### Earlier conversation (compacted)\nearlier stuff"
    );
    expect(serializeMessage({ role: "branchSummary", summary: "a branch" })).toBe(
      "### Branch summary\na branch"
    );
  });

  it("returns null for unknown roles, empty content, and garbage", () => {
    expect(serializeMessage({ role: "mystery", content: "x" })).toBeNull();
    expect(serializeMessage({ role: "user", content: [] })).toBeNull();
    expect(serializeMessage(undefined)).toBeNull();
  });
});

describe("serializeEntry", () => {
  it("renders the four context-participating entry types", () => {
    expect(serializeEntry(userEntry("hi"))).toBe("### User\nhi");
    expect(
      serializeEntry({ type: "custom_message", customType: "memory", content: "recall" })
    ).toBe("### memory\nrecall");
    expect(serializeEntry({ type: "compaction", summary: "old" })).toBe(
      "### Earlier conversation (compacted)\nold"
    );
    expect(serializeEntry({ type: "branch_summary", summary: "br" })).toBe(
      "### Branch summary\nbr"
    );
  });

  it("skips bookkeeping entries, including the enhance audit rows", () => {
    // `custom` (not `custom_message`) never participates in LLM context.
    expect(serializeEntry({ type: "custom", customType: "enhance" })).toBeNull();
    expect(serializeEntry({ type: "label" })).toBeNull();
    expect(serializeEntry({ type: "model_change" })).toBeNull();
    expect(serializeEntry({ type: "thinking_level_change" })).toBeNull();
    expect(serializeEntry({ type: "session_info" })).toBeNull();
    expect(serializeEntry(undefined)).toBeNull();
  });
});

describe("buildTranscript", () => {
  it("returns empty for no entries", () => {
    expect(buildTranscript([])).toEqual({ text: "", entryCount: 0, truncated: false });
    expect(buildTranscript(undefined)).toEqual({ text: "", entryCount: 0, truncated: false });
  });

  it("joins entries oldest-first and counts them", () => {
    const result = buildTranscript([
      userEntry("first"),
      assistantEntry([{ type: "text", text: "reply" }]),
      userEntry("second"),
    ]);
    expect(result.entryCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("### User\nfirst\n\n### Penny\nreply\n\n### User\nsecond");
  });

  it("keeps the FULL session when under the ceiling (no turn windowing)", () => {
    const entries = Array.from({ length: 400 }, (_, i) => userEntry(`turn ${i}`));
    const result = buildTranscript(entries);
    expect(result.entryCount).toBe(400);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("turn 0");
    expect(result.text).toContain("turn 399");
  });

  it("drops OLDEST entries when the ceiling trips, keeping recent turns", () => {
    process.env.PENNY_ENHANCE_CONTEXT_MAX_CHARS = "200";
    const entries = Array.from({ length: 40 }, (_, i) => userEntry(`turn ${i}`));
    const result = buildTranscript(entries);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("older history omitted");
    expect(result.text).toContain("turn 39");
    expect(result.text).not.toContain("turn 0\n");
    expect(result.entryCount).toBeLessThan(40);
  });

  it("ignores entries that render to nothing", () => {
    const result = buildTranscript([
      { type: "custom", customType: "enhance" },
      userEntry("only real turn"),
      { type: "label" },
    ]);
    expect(result.entryCount).toBe(1);
    expect(result.text).toBe("### User\nonly real turn");
  });
});

describe("contextMaxChars", () => {
  it("defaults, and honors a valid override", () => {
    expect(contextMaxChars()).toBe(DEFAULT_CONTEXT_MAX_CHARS);
    process.env.PENNY_ENHANCE_CONTEXT_MAX_CHARS = "5000";
    expect(contextMaxChars()).toBe(5000);
  });

  it("falls back on garbage or non-positive values", () => {
    process.env.PENNY_ENHANCE_CONTEXT_MAX_CHARS = "not-a-number";
    expect(contextMaxChars()).toBe(DEFAULT_CONTEXT_MAX_CHARS);
    process.env.PENNY_ENHANCE_CONTEXT_MAX_CHARS = "-1";
    expect(contextMaxChars()).toBe(DEFAULT_CONTEXT_MAX_CHARS);
  });
});

describe("transcriptFromSession", () => {
  it("reads the compaction-aware active entry list", () => {
    const session = { buildContextEntries: () => [userEntry("hello")] };
    expect(transcriptFromSession(session).text).toBe("### User\nhello");
  });

  it("degrades to empty when the session manager is absent or unusable", () => {
    expect(transcriptFromSession(undefined)).toEqual({ text: "", entryCount: 0, truncated: false });
    expect(transcriptFromSession({})).toEqual({ text: "", entryCount: 0, truncated: false });
  });

  it("never throws when the session manager blows up", () => {
    const session = {
      buildContextEntries: () => {
        throw new Error("session file corrupt");
      },
    };
    expect(transcriptFromSession(session)).toEqual({ text: "", entryCount: 0, truncated: false });
  });
});
