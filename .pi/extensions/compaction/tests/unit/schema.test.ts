import { describe, it, expect } from "vitest";
import {
  PennyCompactArtifactSchema,
  PendingStateSchema,
  DecisionRefSchema,
  FileContextSchema,
  ArtifactMetadataSchema,
} from "../../schema.js";

// ============================================================
// Valid Fixtures
// ============================================================

const validArtifact = {
  schema_version: "1.0.0",
  session_id: "test-session-123",
  compaction_seq: 0,
  compaction_timestamp: "2026-05-01T12:00:00.000Z",
  goal: "Implement custom compaction",
  constraints: ["No Pi fork", "Use session_before_compact hook"],
  preferences: ["Structured JSON", "zod validation"],
  pending: null,
  decisions: [],
  errors: [],
  agents_invoked: [],
  orchestrator_state: null,
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
