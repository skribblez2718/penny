import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ArtifactRefSchema,
  EngineRunRefSchema,
  PennyCompactArtifactSchema,
  PendingStateSchema,
  RESUME_REFS_VERSION,
  ResumeRefSetSchema,
  SCHEMA_VERSION,
} from "../../schema.js";

function artifactRef() {
  const identity = {
    branch_id: null,
    kind: "agent-output",
    operation_id: "observe-1",
    phase: "observing",
    run_id: "run-1",
    version: 1,
  };
  return {
    schema_version: 1,
    artifact_id: `art_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    run_id: "run-1",
    phase: "observing",
    branch_id: null,
    kind: "agent-output",
    operation_id: "observe-1",
    version: 1,
    producer: "agent:echo",
    consumer_scope: ["state:framing"],
    media_type: "text/markdown; charset=utf-8",
    byte_length: 12,
    content_digest: "a".repeat(64),
    store_ref: `artifact://sha256/${"a".repeat(64)}`,
  };
}

const run = {
  run_id: "run-1",
  session_id: "session-1",
  playbook: "research",
  current_state_id: "framing",
  status: "awaiting_user" as const,
  goal: "Produce a report",
  clarification_text: "Proceed?",
  updated_at: "2026-08-15T12:00:00Z",
};

const validArtifact = {
  schema_version: SCHEMA_VERSION,
  session_id: "test-session-123",
  compaction_seq: 0,
  compaction_timestamp: "2026-08-15T12:00:00.000Z",
  goal: "Implement exact compaction refs",
  constraints: [],
  preferences: [],
  pending: null,
  errors: [],
  engine_runs: [run],
  artifact_refs: [artifactRef()],
  resume_refs: {
    version: RESUME_REFS_VERSION,
    refs: [
      { type: "run", run_id: "run-1" },
      { type: "artifact", artifact_id: artifactRef().artifact_id, digest: "a".repeat(64) },
    ],
  },
  files: { read: [], modified: [] },
  tool_calls: [],
  tool_error_recovery: [],
  metadata: {
    eviction_log: [],
    compaction_correlation: {
      status: "not_evaluated",
      keys: ["session:test-session-123", "run:run-1"],
    },
  },
};

describe("PennyCompactArtifactSchema v3", () => {
  it("accepts the strict current schema", () => {
    expect(SCHEMA_VERSION).toBe("3.0.0");
    expect(PennyCompactArtifactSchema.safeParse(validArtifact).success).toBe(true);
  });

  it("accepts compaction-correlation metadata without asserting a live trial", () => {
    const parsed = PennyCompactArtifactSchema.parse(validArtifact);
    expect(parsed.metadata.compaction_correlation).toEqual({
      status: "not_evaluated",
      keys: ["session:test-session-123", "run:run-1"],
    });
  });

  it("rejects unsupported versions and legacy memory fields", () => {
    expect(
      PennyCompactArtifactSchema.safeParse({ ...validArtifact, schema_version: "2.3.0" }).success
    ).toBe(false);
    expect(
      PennyCompactArtifactSchema.safeParse({ ...validArtifact, mempalace_rooms: [] }).success
    ).toBe(false);
  });

  it("rejects unknown top-level and nested fields", () => {
    expect(PennyCompactArtifactSchema.safeParse({ ...validArtifact, surprise: true }).success).toBe(
      false
    );
    expect(
      PennyCompactArtifactSchema.safeParse({
        ...validArtifact,
        metadata: {
          eviction_log: [],
          compaction_correlation: validArtifact.metadata.compaction_correlation,
          surprise: true,
        },
      }).success
    ).toBe(false);
  });

  it("rejects missing required exact-ref state", () => {
    const value = { ...validArtifact } as Record<string, unknown>;
    delete value.resume_refs;
    expect(PennyCompactArtifactSchema.safeParse(value).success).toBe(false);
  });
});

describe("strict resume and selected-ref schemas", () => {
  it("requires RESUME-REFS version 2 and canonical exact syntax values", () => {
    expect(ResumeRefSetSchema.safeParse(validArtifact.resume_refs).success).toBe(true);
    expect(ResumeRefSetSchema.safeParse({ ...validArtifact.resume_refs, version: 1 }).success).toBe(
      false
    );
    expect(
      ResumeRefSetSchema.safeParse({
        version: 2,
        refs: [{ type: "artifact", artifact_id: "art_bad", digest: "A".repeat(64) }],
      }).success
    ).toBe(false);
  });

  it("validates full selected artifact shape and digest/store consistency", () => {
    expect(ArtifactRefSchema.safeParse(artifactRef()).success).toBe(true);
    expect(
      ArtifactRefSchema.safeParse({
        ...artifactRef(),
        store_ref: `artifact://sha256/${"b".repeat(64)}`,
      }).success
    ).toBe(false);
    expect(ArtifactRefSchema.safeParse({ ...artifactRef(), unknown: true }).success).toBe(false);
    expect(
      ArtifactRefSchema.safeParse({ ...artifactRef(), artifact_id: `art_${"f".repeat(64)}` })
        .success
    ).toBe(false);
  });

  it("rejects terminal run statuses from resume state", () => {
    expect(EngineRunRefSchema.safeParse(run).success).toBe(true);
    expect(EngineRunRefSchema.safeParse({ ...run, status: "complete" }).success).toBe(false);
  });
});

describe("PendingStateSchema", () => {
  it("contains no durable-memory pointer requirement", () => {
    const pending = {
      state: "UNKNOWN_STATE",
      previous_state: "planning",
      question_summary: "Need more info",
      turn_id: "turn-1",
    };
    expect(PendingStateSchema.safeParse(pending).success).toBe(true);
    expect(
      PendingStateSchema.safeParse({ ...pending, mempalace_drawer_id: "drawer-1" }).success
    ).toBe(false);
  });
});
