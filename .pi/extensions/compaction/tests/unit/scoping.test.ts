import { describe, it, expect } from "vitest";
import {
  collectSkillSessionIds,
  parseRefsSessionIds,
  computeScopedSessionIds,
  partitionRunsByScope,
  deriveErrorRefs,
} from "../../index.js";
import type { EngineRunRef } from "../../schema.js";

function skillResult(sessionId: string) {
  return {
    role: "toolResult",
    toolName: "skill",
    content: JSON.stringify({ success: true, session_id: sessionId }),
  };
}

describe("collectSkillSessionIds", () => {
  it("collects every skill-result session id in the window", () => {
    const ids = collectSkillSessionIds([
      { role: "user", content: "go" },
      skillResult("plan-1"),
      skillResult("code-2"),
      skillResult("plan-1"), // dup
    ]);
    expect(ids.sort()).toEqual(["code-2", "plan-1"]);
  });

  it("ignores non-skill tool results and malformed content", () => {
    const ids = collectSkillSessionIds([
      { role: "toolResult", toolName: "read", content: JSON.stringify({ session_id: "nope" }) },
      { role: "toolResult", toolName: "skill", content: "not json" },
    ]);
    expect(ids).toEqual([]);
  });
});

describe("parseRefsSessionIds", () => {
  it("extracts resumeFrom ids carried in a prior refs block", () => {
    const prev = [
      "## Goal",
      "Do the thing",
      "---",
      "[RESUME-REFS v2]",
      'run: run_id=code-a state=X status=running resume=skill(skill_name="code", resumeFrom="code-99")',
      "[/RESUME-REFS]",
    ].join("\n");
    expect(parseRefsSessionIds(prev)).toEqual(["code-99"]);
  });

  it("returns [] when there is no previous summary", () => {
    expect(parseRefsSessionIds(undefined)).toEqual([]);
  });
});

describe("computeScopedSessionIds", () => {
  it("unions skill-result ids and prior-refs ids", () => {
    const messages = [skillResult("plan-1")];
    const prev = 'resume=skill(skill_name="code", resumeFrom="code-2")';
    expect(computeScopedSessionIds(messages, prev).sort()).toEqual(["code-2", "plan-1"]);
  });
});

describe("partitionRunsByScope", () => {
  const run = (sid: string): EngineRunRef => ({
    run_id: `run-${sid}`,
    session_id: sid,
    playbook: "code",
    current_state_id: "X",
    status: "awaiting_user",
    updated_at: "2026-07-05T00:00:00.000Z",
  });

  it("splits runs into scoped vs other-session", () => {
    const { scoped, other } = partitionRunsByScope(
      [run("plan-1"), run("stale-9"), run("code-2")],
      ["plan-1", "code-2"]
    );
    expect(scoped.map((r) => r.session_id).sort()).toEqual(["code-2", "plan-1"]);
    expect(other.map((r) => r.session_id)).toEqual(["stale-9"]);
  });

  it("puts every run in 'other' when scope is empty (nothing is current)", () => {
    const { scoped, other } = partitionRunsByScope([run("a"), run("b")], []);
    expect(scoped).toEqual([]);
    expect(other).toHaveLength(2);
  });
});

describe("deriveErrorRefs", () => {
  const errResult = (tool: string, msg: string) => ({
    role: "toolResult",
    toolName: tool,
    isError: true,
    content: msg,
  });
  const okResult = (tool: string) => ({
    role: "toolResult",
    toolName: tool,
    isError: false,
    content: "ok",
  });

  it("marks an error unresolved when no later same-tool success follows", () => {
    const refs = deriveErrorRefs([errResult("bash", "command failed: boom")]);
    expect(refs).toHaveLength(1);
    expect(refs[0].error_type).toBe("bash");
    expect(refs[0].resolved).toBe(false);
    // placeholder pointers → buildResumeRefs skips them (no fake pointer).
    expect(refs[0].mempalace_drawer_id).toBe("unknown");
  });

  it("marks an error resolved when a later same-tool call succeeds", () => {
    const refs = deriveErrorRefs([errResult("edit", "validation failed"), okResult("edit")]);
    expect(refs[0].resolved).toBe(true);
  });
});
