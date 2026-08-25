import { describe, expect, it } from "vitest";

import {
  buildResumeRefs,
  createProseSummary,
  createResumeRefSet,
  withResumeRefs,
} from "../../index.js";
import type { ArtifactRef, PennyCompactArtifact } from "../../schema.js";

const run = {
  run_id: "run-research-a1b2c3",
  session_id: "research-1751700000000",
  playbook: "research",
  current_state_id: "framing",
  status: "awaiting_user" as const,
  goal: "Produce the report",
  clarification_text: "Keep the fixture?",
  updated_at: "2026-08-15T12:00:00.000Z",
};

const selectedArtifact: ArtifactRef = {
  schema_version: 2,
  artifact_id: `art_${"a".repeat(64)}`,
  run_id: run.run_id,
  phase: "observing",
  branch_id: null,
  kind: "agent-output",
  operation_id: "observe-1",
  version: 1,
  producer: "agent:echo",
  media_type: "text/markdown; charset=utf-8",
  byte_length: 42,
  content_digest: "b".repeat(64),
  store_ref: `artifact://sha256/${"b".repeat(64)}`,
};

function baseArtifact(overrides: Partial<PennyCompactArtifact> = {}): PennyCompactArtifact {
  const engineRuns = overrides.engine_runs ?? [];
  const artifacts = overrides.artifact_refs ?? [];
  return {
    schema_version: "3.0.0",
    session_id: "sess-1",
    compaction_seq: 0,
    compaction_timestamp: "2026-08-15T12:00:00.000Z",
    goal: "Produce the report",
    constraints: [],
    preferences: [],
    pending: null,
    errors: [],
    engine_runs: engineRuns,
    artifact_refs: artifacts,
    resume_refs: createResumeRefSet(engineRuns, artifacts),
    files: { read: [], modified: [] },
    tool_calls: [],
    tool_error_recovery: [],
    metadata: { eviction_log: [] },
    ...overrides,
  };
}

describe("buildResumeRefs", () => {
  it("renders exact run and immutable artifact digest refs", () => {
    const refs = buildResumeRefs(
      baseArtifact({ engine_runs: [run], artifact_refs: [selectedArtifact] })
    );
    expect(refs).toBe(
      [
        "[RESUME-REFS v2]",
        `run:${run.run_id}`,
        `artifact:${selectedArtifact.artifact_id}@sha256:${selectedArtifact.content_digest}`,
        "[/RESUME-REFS]",
      ].join("\n")
    );
  });

  it("returns an empty string when no exact refs exist", () => {
    expect(buildResumeRefs(baseArtifact())).toBe("");
  });
});

describe("createProseSummary", () => {
  it("puts prose first and the exact refs appendix last", () => {
    const summary = createProseSummary(
      baseArtifact({ engine_runs: [run], artifact_refs: [selectedArtifact] })
    );
    expect(summary.indexOf("## Goal")).toBe(0);
    expect(summary).toContain("## In-Flight Orchestration Runs");
    expect(summary).toContain("Waiting on the user: Keep the fixture?");
    expect(summary.indexOf("[RESUME-REFS v2]")).toBeGreaterThan(summary.indexOf("## Goal"));
    expect(summary.trimEnd().endsWith("[/RESUME-REFS]")).toBe(true);
  });

  it("omits the refs block on an empty session", () => {
    const summary = createProseSummary(baseArtifact());
    expect(summary).toContain("## Goal");
    expect(summary).not.toContain("[RESUME-REFS");
  });

  it("renders current work, next steps, and supersession without filler", () => {
    const summary = createProseSummary(
      baseArtifact({
        goal: "Build the exact-ref fix",
        current_work: "Reading exact orchestration checkpoints",
        next_steps: ["Run focused tests"],
        dominant_skill: {
          skill_name: "research",
          session_id: "research-1",
          goal: "Old research task",
          completed: true,
          superseded: true,
        },
      })
    );
    expect(summary).toContain("## Current Work");
    expect(summary).toContain("## Next Steps");
    expect(summary).toContain("superseded by a newer request");
    expect(summary).not.toContain("No explicit constraints recorded");
  });

  it("lets model prose receive only the code-owned exact appendix", () => {
    const artifact = baseArtifact({ engine_runs: [run] });
    const summary = withResumeRefs("## Goal\nContinue", artifact);
    expect(summary).toContain(`run:${run.run_id}`);
    expect(summary).not.toContain("resume=skill");
  });
});
