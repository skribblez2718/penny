import { describe, it, expect } from "vitest";
import { createProseSummary, buildResumeRefs } from "../../index.js";
import type { PennyCompactArtifact } from "../../schema.js";

function baseArtifact(overrides: Partial<PennyCompactArtifact> = {}): PennyCompactArtifact {
  return {
    schema_version: "2.0.0",
    session_id: "sess-1",
    compaction_seq: 0,
    compaction_timestamp: "2026-07-05T12:00:00.000Z",
    goal: "Migrate research skill onto engine",
    constraints: [],
    preferences: [],
    pending: null,
    decisions: [],
    errors: [],
    engine_runs: [],
    mempalace_rooms: [],
    kg_entities: [],
    files: { read: [], modified: [] },
    tool_calls: [],
    tool_error_recovery: [],
    metadata: { eviction_log: [] },
    ...overrides,
  } as PennyCompactArtifact;
}

const run = {
  run_id: "code-a1b2c3",
  session_id: "code-1751700000000",
  playbook: "code",
  current_state_id: "VERIFY",
  status: "awaiting_user" as const,
  goal: "Migrate research skill onto engine",
  clarification_text: "Keep the StandardCycle fixture?",
  updated_at: "2026-07-05T12:00:00.000Z",
};

describe("buildResumeRefs", () => {
  it("renders engine runs with a concrete resume instruction", () => {
    const refs = buildResumeRefs(baseArtifact({ engine_runs: [run] }));
    expect(refs).toContain("[RESUME-REFS v2]");
    expect(refs).toContain("run_id=code-a1b2c3");
    expect(refs).toContain('resume=skill(skill_name="code", resumeFrom="code-1751700000000")');
    expect(refs).toContain("awaiting-user: Keep the StandardCycle fixture?");
  });

  it("renders mempalace room/drawer pointers and decision/kg ids", () => {
    const refs = buildResumeRefs(
      baseArtifact({
        mempalace_rooms: [
          {
            wing: "penny",
            room: "skills/code-1751700000000",
            drawer_ids: ["d-101", "d-104"],
            last_updated: "2026-07-05T12:00:00.000Z",
            dominant_for_session: true,
          },
        ],
        decisions: [
          {
            decision_id: "outcome-8842",
            summary: "Chose BasePlaybook subclass",
            outcome_room: "penny/outcomes",
            confidence: "CERTAIN",
          },
        ],
        kg_entities: [
          {
            entity_id: "Session:code-1751700000000",
            entity_type: "Session",
            relevant_predicates: ["uses"],
          },
        ],
      })
    );
    expect(refs).toContain(
      "room: penny/skills/code-1751700000000 drawers=d-101,d-104 (active session)"
    );
    expect(refs).toContain("decision: outcome-8842 (CERTAIN) Chose BasePlaybook subclass");
    expect(refs).toContain("kg: Session:code-1751700000000 [uses]");
  });

  it("skips placeholder drawer ids — a fake pointer is worse than none", () => {
    const refs = buildResumeRefs(
      baseArtifact({
        pending: {
          state: "awaiting_clarification",
          previous_state: "unknown",
          mempalace_drawer_id: "pending-diary",
          question_summary: "q",
          turn_id: "t",
        },
        mempalace_rooms: [
          {
            wing: "penny",
            room: "skills/x",
            drawer_ids: ["unknown", "pending-abc", "d-real"],
            last_updated: "2026-07-05T12:00:00.000Z",
          },
        ],
      })
    );
    expect(refs).not.toContain("pending-drawer:");
    expect(refs).toContain("drawers=d-real");
  });

  it("renders verbatim tool params, deduped by tool, successes only", () => {
    const refs = buildResumeRefs(
      baseArtifact({
        tool_calls: [
          { tool: "read", params: { path: "/a" }, successful: true },
          { tool: "read", params: { path: "/b" }, successful: true },
          { tool: "edit", params: { path: "/c" }, successful: false },
        ],
        tool_error_recovery: [
          {
            tool: "edit",
            failed_params: { path: "" },
            error_message: "Validation failed",
            corrected_params: { path: "/c" },
          },
        ],
      })
    );
    const toolOkLines = refs.split("\n").filter((l) => l.startsWith("tool-ok:"));
    expect(toolOkLines).toHaveLength(1);
    expect(toolOkLines[0]).toContain('{"path":"/a"}');
    expect(refs).toContain('tool-fix: edit failed={"path":""} error="Validation failed"');
  });

  it("returns empty string when there is nothing to point at", () => {
    expect(buildResumeRefs(baseArtifact())).toBe("");
  });
});

describe("createProseSummary", () => {
  it("puts the prose brief first and the refs appendix last", () => {
    const summary = createProseSummary(baseArtifact({ engine_runs: [run] }));
    expect(summary.indexOf("## Goal")).toBe(0);
    expect(summary).toContain("## In-Flight Orchestration Runs");
    expect(summary).toContain("Waiting on the user: Keep the StandardCycle fixture?");
    expect(summary.indexOf("[RESUME-REFS v2]")).toBeGreaterThan(summary.indexOf("## Goal"));
    expect(summary.trimEnd().endsWith("[/RESUME-REFS]")).toBe(true);
  });

  it("omits the refs block entirely on an empty session", () => {
    const summary = createProseSummary(baseArtifact());
    expect(summary).toContain("## Goal");
    expect(summary).not.toContain("[RESUME-REFS");
  });

  it("does not emit filler constraints", () => {
    const summary = createProseSummary(baseArtifact());
    expect(summary).not.toContain("No explicit constraints recorded");
    expect(summary).not.toContain("## Constraints");
  });
});
