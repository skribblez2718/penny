import { describe, expect, it } from "vitest";

import compactionExtension, { detectDominantSkill } from "../../index.js";
import { asArray, asRecord, asString } from "../../pi-messages.js";
import { createMockCompactionPi } from "../fixtures/compaction-pi.js";

describe("compaction host and JSON boundaries", () => {
  it("keeps record extras and degrades arrays and primitives to an empty record", () => {
    const value = { expected: "kept", extra: { nested: true } };
    expect(asRecord(value)).toBe(value);
    expect(asRecord([])).toEqual({});
    expect(asRecord(null)).toEqual({});
    expect(asRecord("not-an-object")).toEqual({});
    expect(asString(42)).toBe("");
    expect(asArray({ 0: "not-an-array" })).toEqual([]);
  });

  it("accepts open constraint-object extras without broadening non-object tool data", () => {
    const constraints = { language: "typescript", extension_owned: { exact: true } };
    const dominant = detectDominantSkill([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "skill",
            arguments: { skill_name: "plan", goal: "Close boundaries", constraints },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "skill",
        toolCallId: "call-1",
        content: JSON.stringify({ success: true, session_id: "plan-1" }),
      },
    ]);

    expect(dominant?.constraints).toEqual(constraints);
  });

  it("retains the trusted-project-root error for wrong-type host context with extras", async () => {
    const pi = createMockCompactionPi();
    compactionExtension(pi.api);
    const event = {
      preparation: {
        firstKeptEntryId: "keep-1",
        tokensBefore: 1,
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
        messagesToSummarize: [],
        turnPrefixMessages: [],
      },
      branchEntries: [],
    };

    await expect(pi.emit(event, { cwd: 42, hostExtra: true })).rejects.toThrow(
      "compaction context is missing its trusted project root"
    );
  });
});
