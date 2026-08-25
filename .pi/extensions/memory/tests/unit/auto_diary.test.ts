import { describe, expect, it } from "vitest";

import { buildDiaryFromSessionEntries } from "../../index.js";

describe("direct Pi session diary metadata", () => {
  it("counts lifecycle and tool-result entries without a service query", () => {
    const entry = buildDiaryFromSessionEntries("session", "quit", [
      {
        type: "custom",
        customType: "penny.observability.agent-lifecycle",
        data: { phase: "start" },
      },
      { type: "message", message: { role: "toolResult", toolName: "read" } },
      { type: "message", message: { role: "toolResult", toolName: "read" } },
      { type: "message", message: { role: "toolResult", toolName: "bash" } },
    ]);
    expect(entry).toContain("Agents:1");
    expect(entry).toContain("read(2)+bash(1)");
    expect(entry).toContain("Reason:quit");
  });

  it("ignores message content and malformed metadata", () => {
    const marker = "PRIVATE_DIARY_MARKER";
    const entry = buildDiaryFromSessionEntries("session", "quit", [
      { type: "message", message: { role: "user", content: marker } },
      { type: "custom", customType: "other", data: { phase: "start" } },
      { type: "message", message: null },
      { type: "message", message: [] },
      { type: "custom", customType: "penny.observability.agent-lifecycle", data: [] },
    ]);
    expect(entry).not.toContain(marker);
    expect(entry).toContain("Agents:0");
    expect(entry).toContain("Tools:none");
  });

  it("accepts host-entry extras while reading only the named projection", () => {
    const entries = [
      {
        type: "custom",
        customType: "penny.observability.agent-lifecycle",
        data: { phase: "start", hostExtra: true },
        ignoredEntryField: "accepted",
      },
      {
        type: "message",
        message: { role: "toolResult", toolName: "read", hostExtra: true },
        ignoredEntryField: "accepted",
      },
    ];
    const entry = buildDiaryFromSessionEntries("session", "quit", entries);
    expect(entry).toContain("Agents:1");
    expect(entry).toContain("Tools:read(1)");
  });
});
