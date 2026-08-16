import { describe, expect, it } from "vitest";

import {
  collectExactRunIds,
  collectExplicitRunIds,
  deriveErrorRefs,
  parsePriorMemoryIds,
  parsePriorRunIds,
  parseResumeRefs,
} from "../../index.js";

function skillResult(details: Record<string, unknown>) {
  return {
    role: "toolResult",
    toolName: "skill",
    content: JSON.stringify(details),
    details,
  };
}

describe("exact run-id collection", () => {
  it("collects only explicit run IDs from named skill-result fields", () => {
    const ids = collectExplicitRunIds([
      skillResult({ run_id: "run-one", session_id: "not-a-run" }),
      skillResult({
        result: { output_artifact_ref: { run_id: "run-two" } },
        escalation: { questions: [{ approval_run_id: "run-three" }] },
      }),
      {
        role: "toolResult",
        toolName: "read",
        content: JSON.stringify({ run_id: "untrusted-tool" }),
      },
    ]);
    expect(ids.sort()).toEqual(["run-one", "run-three", "run-two"]);
  });

  it("does not infer a run from session IDs or malformed content", () => {
    expect(
      collectExplicitRunIds([
        skillResult({ session_id: "session-only" }),
        { role: "toolResult", toolName: "skill", content: "not json" },
      ])
    ).toEqual([]);
  });

  it("carries exact run IDs through a strict v2 refs block", () => {
    const prior = [
      "## Goal",
      "Continue",
      "[RESUME-REFS v2]",
      "run:run-prior",
      `artifact:art_${"a".repeat(64)}@sha256:${"b".repeat(64)}`,
      "memory:drawer-explicit-1",
      "[/RESUME-REFS]",
    ].join("\n");
    expect(parsePriorRunIds(prior)).toEqual(["run-prior"]);
    expect(parsePriorMemoryIds(prior)).toEqual(["drawer-explicit-1"]);
    expect(collectExactRunIds([skillResult({ run_id: "run-new" })], prior).sort()).toEqual([
      "run-new",
      "run-prior",
    ]);
  });
});

describe("strict resume-ref parsing", () => {
  it("rejects unsupported versions, unknown lines, invalid refs, and duplicates", () => {
    expect(() => parseResumeRefs("[RESUME-REFS v1]\nrun:x\n[/RESUME-REFS]")).toThrow("unsupported");
    expect(() => parseResumeRefs("[RESUME-REFS v2]\nroom:x\n[/RESUME-REFS]")).toThrow("invalid");
    expect(() =>
      parseResumeRefs("[RESUME-REFS v2]\nartifact:art_bad@sha256:nope\n[/RESUME-REFS]")
    ).toThrow("invalid");
    expect(() => parseResumeRefs("[RESUME-REFS v2]\nrun:x\nrun:x\n[/RESUME-REFS]")).toThrow(
      "duplicate"
    );
  });
});

describe("deriveErrorRefs", () => {
  const errorResult = (tool: string, message: string) => ({
    role: "toolResult",
    toolName: tool,
    isError: true,
    content: message,
  });
  const okResult = (tool: string) => ({
    role: "toolResult",
    toolName: tool,
    isError: false,
    content: "ok",
  });

  it("marks an error unresolved when no later same-tool success follows", () => {
    const refs = deriveErrorRefs([errorResult("bash", "command failed: boom")]);
    expect(refs).toEqual([
      {
        error_type: "bash",
        message: "command failed: boom",
        turn_id: "unknown",
        resolved: false,
      },
    ]);
  });

  it("marks an error resolved when a later same-tool call succeeds", () => {
    const refs = deriveErrorRefs([errorResult("edit", "validation failed"), okResult("edit")]);
    expect(refs[0].resolved).toBe(true);
  });
});
