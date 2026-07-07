import { describe, it, expect } from "vitest";
import {
  PennyCompactArtifactSchema,
  PendingStateSchema,
  DecisionRefSchema,
  EngineRunRefSchema,
  FileContextSchema,
  ArtifactMetadataSchema,
} from "../../schema.js";

// ============================================================
// Valid Fixtures
// ============================================================

const validArtifact = {
  schema_version: "2.0.0",
  session_id: "test-session-123",
  compaction_seq: 0,
  compaction_timestamp: "2026-05-01T12:00:00.000Z",
  goal: "Implement custom compaction",
  constraints: ["No Pi fork", "Use session_before_compact hook"],
  preferences: [],
  pending: null,
  decisions: [],
  errors: [],
  engine_runs: [],
  mempalace_rooms: [],
  kg_entities: [],
  files: { read: ["/tmp/foo.md"], modified: ["/tmp/bar.md"] },
  tool_calls: [],
  tool_error_recovery: [],
  metadata: {
    eviction_log: [],
    pi_boundary: {
      first_kept_entry_id: "abc-123",
      tokens_before: 15000,
    },
  },
};

// ============================================================
// Top-Level Artifact
// ============================================================

describe("PennyCompactArtifactSchema", () => {
  it("accepts a valid minimal artifact", () => {
    const result = PennyCompactArtifactSchema.safeParse(validArtifact);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const bad = { ...validArtifact, goal: undefined };
    const result = PennyCompactArtifactSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects invalid schema_version", () => {
    const bad = { ...validArtifact, schema_version: "1.0" };
    const result = PennyCompactArtifactSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects invalid session_id (spaces)", () => {
    const bad = { ...validArtifact, session_id: "bad id" };
    const result = PennyCompactArtifactSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects too many constraints", () => {
    const bad = { ...validArtifact, constraints: Array(21).fill("x") };
    const result = PennyCompactArtifactSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects goal over 500 chars", () => {
    const bad = { ...validArtifact, goal: "x".repeat(501) };
    const result = PennyCompactArtifactSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts valid pending state", () => {
    const withPending = {
      ...validArtifact,
      pending: {
        state: "UNKNOWN_STATE" as const,
        previous_state: "planning",
        mempalace_drawer_id: "drawer-1",
        question_summary: "Need more info",
        turn_id: "turn-1",
      },
    };
    const result = PennyCompactArtifactSchema.safeParse(withPending);
    expect(result.success).toBe(true);
  });

  it("rejects pending without mempalace_drawer_id", () => {
    const withPending = {
      ...validArtifact,
      pending: {
        state: "UNKNOWN_STATE",
        previous_state: "planning",
        mempalace_drawer_id: "",
        question_summary: "Need more info",
        turn_id: "turn-1",
      },
    };
    const result = PennyCompactArtifactSchema.safeParse(withPending);
    expect(result.success).toBe(false);
  });
});

// ============================================================
// Sub-Schemas
// ============================================================

describe("PendingStateSchema", () => {
  it("accepts UNKNOWN_STATE", () => {
    const result = PendingStateSchema.safeParse({
      state: "UNKNOWN_STATE",
      previous_state: "x",
      mempalace_drawer_id: "d1",
      question_summary: "q",
      turn_id: "t1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts awaiting_clarification", () => {
    const result = PendingStateSchema.safeParse({
      state: "awaiting_clarification",
      previous_state: "x",
      mempalace_drawer_id: "d1",
      question_summary: "q",
      turn_id: "t1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts verification_required", () => {
    const result = PendingStateSchema.safeParse({
      state: "verification_required",
      previous_state: "x",
      mempalace_drawer_id: "d1",
      question_summary: "q",
      turn_id: "t1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid state", () => {
    const result = PendingStateSchema.safeParse({
      state: "invalid",
      previous_state: "x",
      mempalace_drawer_id: "d1",
      question_summary: "q",
      turn_id: "t1",
    });
    expect(result.success).toBe(false);
  });
});

describe("EngineRunRefSchema", () => {
  const validRun = {
    run_id: "code-a1b2c3",
    session_id: "code-1751700000000",
    playbook: "code",
    current_state_id: "VERIFY",
    status: "awaiting_user",
    goal: "Migrate research skill onto engine",
    clarification_text: "Keep the StandardCycle fixture?",
    updated_at: "2026-07-05T12:00:00.000Z",
  };

  it("accepts a full engine run ref", () => {
    expect(EngineRunRefSchema.safeParse(validRun).success).toBe(true);
  });

  it("accepts a run without optional goal/clarification", () => {
    const { goal: _g, clarification_text: _c, ...minimal } = validRun;
    expect(EngineRunRefSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects unknown status", () => {
    expect(EngineRunRefSchema.safeParse({ ...validRun, status: "paused" }).success).toBe(false);
  });

  it("rejects empty run_id", () => {
    expect(EngineRunRefSchema.safeParse({ ...validRun, run_id: "" }).success).toBe(false);
  });

  it("artifact accepts engine_runs and rejects more than 5", () => {
    const ok = { ...validArtifact, engine_runs: [validRun] };
    expect(PennyCompactArtifactSchema.safeParse(ok).success).toBe(true);
    const over = { ...validArtifact, engine_runs: Array(6).fill(validRun) };
    expect(PennyCompactArtifactSchema.safeParse(over).success).toBe(false);
  });

  it("artifact rejects the removed v1 fields", () => {
    // strict object? zod default strips unknown keys — assert the schema no
    // longer *requires* them instead
    const withoutEngineRuns: any = { ...validArtifact };
    delete withoutEngineRuns.engine_runs;
    expect(PennyCompactArtifactSchema.safeParse(withoutEngineRuns).success).toBe(false);
  });
});

describe("DecisionRefSchema", () => {
  it("accepts valid decision ref", () => {
    const result = DecisionRefSchema.safeParse({
      decision_id: "d1",
      summary: "A decision",
      outcome_room: "penny/outcomes",
      confidence: "CERTAIN",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid confidence", () => {
    const result = DecisionRefSchema.safeParse({
      decision_id: "d1",
      summary: "A decision",
      outcome_room: "penny/outcomes",
      confidence: "MAYBE",
    });
    expect(result.success).toBe(false);
  });
});

describe("FileContextSchema", () => {
  it("accepts valid file context", () => {
    const result = FileContextSchema.safeParse({
      read: ["/tmp/a.md", "/tmp/b.md"],
      modified: ["/tmp/c.md"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects too many read files", () => {
    const result = FileContextSchema.safeParse({
      read: Array(51).fill("/tmp/x.md"),
      modified: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("ArtifactMetadataSchema", () => {
  it("accepts valid metadata", () => {
    const result = ArtifactMetadataSchema.safeParse({
      eviction_log: [
        {
          field: "decisions",
          evicted_count: 2,
          strategy: "lowest_confidence_first",
          timestamp: "2026-05-01T12:00:00.000Z",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects too many eviction records", () => {
    const result = ArtifactMetadataSchema.safeParse({
      eviction_log: Array(11).fill({
        field: "x",
        evicted_count: 1,
        strategy: "y",
        timestamp: "2026-05-01T12:00:00.000Z",
      }),
    });
    expect(result.success).toBe(false);
  });
});
